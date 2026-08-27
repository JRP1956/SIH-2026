import io
import zipfile

import httpx
import pytest
from fastapi.testclient import TestClient

from app import routes_scans
from app.main import app
from app.models import Finding, Scan


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict:
        return self._payload


def _stub_github(monkeypatch, response=None, error=None):
    """Answer the repo-visibility lookup without touching the network."""
    def fake_get(*args, **kwargs):
        if error is not None:
            raise error
        return response or _FakeResponse(200, {"private": False})
    monkeypatch.setattr(httpx, "get", fake_get)


@pytest.fixture()
def client(db, monkeypatch):
    started: list[int] = []
    monkeypatch.setattr(routes_scans, "run_scan", lambda scan_id: started.append(scan_id))
    # Every test that posts a github.com URL would otherwise call api.github.com,
    # which makes the suite fail offline and flake on rate limits.
    _stub_github(monkeypatch)
    c = TestClient(app)
    c.post("/auth/signup", json={"email": "s@b.com", "password": "hunter2!"})
    c.started = started
    return c


def _zip_upload():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("app.py", "print(1)\n")
    buf.seek(0)
    return {"zip_file": ("src.zip", buf, "application/zip")}


def test_create_scan_from_repo_url(client, db):
    r = client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo.git"})
    assert r.status_code == 201
    assert r.json()["status"] == "pending"
    scan = db.get(Scan, r.json()["id"])
    assert scan.repo_key == "acme/demo"
    assert scan.source_type == "git"
    assert scan.mode == "full"


def test_create_scan_from_zip(client, db):
    r = client.post("/scans", files=_zip_upload())
    assert r.status_code == 201
    scan = db.get(Scan, r.json()["id"])
    assert scan.source_type == "zip"
    assert scan.repo_key.startswith("zip:")


def test_create_scan_in_diff_mode(client, db):
    r = client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo.git",
                                    "base_ref": "main", "head_ref": "feature"})
    assert r.status_code == 201
    scan = db.get(Scan, r.json()["id"])
    assert scan.mode == "diff"
    assert scan.base_ref == "main"


def test_create_scan_without_source_is_400(client):
    assert client.post("/scans", data={}).status_code == 400


def test_create_scan_with_bad_url_is_400(client):
    assert client.post("/scans", data={"repo_url": "not-a-repo"}).status_code == 400


def test_create_scan_schedules_the_pipeline(client):
    scan_id = client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo"}).json()["id"]
    assert client.started == [scan_id]


def test_rejected_scan_does_not_schedule_the_pipeline(client):
    assert client.post("/scans", data={"repo_url": "not-a-repo"}).status_code == 400
    assert client.started == []


def test_create_scan_requires_auth(db):
    anon = TestClient(app)
    assert anon.post("/scans", data={"repo_url": "https://github.com/a/b"}).status_code == 401


def test_get_scan_returns_findings(client, db):
    scan_id = client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo"}).json()["id"]
    scan = db.get(Scan, scan_id)
    scan.status, scan.security_score, scan.vibe_debt_score = "done", 85, 96
    scan.findings.append(Finding(tool="semgrep", severity="high", category="security",
                                 file="app.py", line=1, message="eval",
                                 ai_explanation="Bad.", ai_fix="Remove it."))
    db.commit()

    body = client.get(f"/scans/{scan_id}").json()
    assert body["security_score"] == 85
    assert body["findings"][0]["ai_explanation"] == "Bad."


def test_cannot_read_another_users_scan(client, db):
    scan_id = client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo"}).json()["id"]
    other = TestClient(app)
    other.post("/auth/signup", json={"email": "other@b.com", "password": "hunter2!"})
    assert other.get(f"/scans/{scan_id}").status_code == 404


def test_list_scans_filtered_by_repo_key_for_trend(client, db):
    client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo"})
    client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo"})
    client.post("/scans", data={"repo_url": "https://github.com/Acme/Other"})

    assert len(client.get("/scans").json()) == 3
    assert len(client.get("/scans", params={"repo_key": "acme/demo"}).json()) == 2


def test_status_endpoint_gates_on_severity(client, db):
    scan_id = client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo"}).json()["id"]
    scan = db.get(Scan, scan_id)
    scan.status, scan.security_score, scan.vibe_debt_score = "done", 85, 96
    scan.findings.append(Finding(tool="semgrep", severity="high", category="security",
                                 file="app.py", line=1, message="eval"))
    db.commit()

    assert client.get(f"/scans/{scan_id}/status", params={"fail_on": "high"}).json()["passed"] is False
    assert client.get(f"/scans/{scan_id}/status", params={"fail_on": "critical"}).json()["passed"] is True


def test_status_endpoint_rejects_bad_severity(client, db):
    scan_id = client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo"}).json()["id"]
    r = client.get(f"/scans/{scan_id}/status", params={"fail_on": "spicy"})
    assert r.status_code == 422


@pytest.mark.parametrize("bad_url", [
    "file:///etc/passwd",
    "file:///Users/someone/private-repo",
    "/Users/someone/private-repo",
    "../../etc",
    "http://github.com/Acme/Demo",
    "https://evil.example.com/Acme/Demo",
    "git@github.com:Acme/Demo.git",
    "ssh://github.com/Acme/Demo",
    "https://github.com/Acme/Demo/../../other",
])
def test_non_https_forge_urls_are_rejected_and_create_no_scan(client, db, bad_url):
    """git clone reads file:// and local paths happily; the report would then hand
    back the secrets and findings of any directory on the server."""
    before = db.query(Scan).count()
    r = client.post("/scans", data={"repo_url": bad_url})
    assert r.status_code == 400, f"{bad_url!r} was accepted"
    assert db.query(Scan).count() == before, f"{bad_url!r} persisted a scan row"
    assert client.started == []


def test_gitlab_urls_are_accepted(client, db):
    r = client.post("/scans", data={"repo_url": "https://gitlab.com/Acme/Demo.git"})
    assert r.status_code == 201


def test_oversized_upload_is_rejected_with_413(client, db, monkeypatch):
    monkeypatch.setattr(routes_scans, "MAX_UPLOAD_BYTES", 512)
    buf = io.BytesIO(b"x" * 4096)
    before = db.query(Scan).count()
    r = client.post("/scans", files={"zip_file": ("big.zip", buf, "application/zip")})
    assert r.status_code == 413
    assert db.query(Scan).count() == before


def test_private_repo_is_rejected(client, monkeypatch):
    _stub_github(monkeypatch, _FakeResponse(200, {"private": True}))
    r = client.post("/scans", data={"repo_url": "https://github.com/Acme/Secret.git"})
    assert r.status_code == 400
    assert "public repositories" in r.json()["detail"]


def test_missing_repo_is_rejected(client, monkeypatch):
    _stub_github(monkeypatch, _FakeResponse(404))
    r = client.post("/scans", data={"repo_url": "https://github.com/Acme/Nope.git"})
    assert r.status_code == 400


def test_unreachable_github_fails_closed(client, monkeypatch):
    _stub_github(monkeypatch, error=httpx.ConnectError("boom"))
    r = client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo.git"})
    assert r.status_code == 502


def test_rate_limited_github_fails_closed(client, monkeypatch):
    _stub_github(monkeypatch, _FakeResponse(403))
    r = client.post("/scans", data={"repo_url": "https://github.com/Acme/Demo.git"})
    assert r.status_code == 502
