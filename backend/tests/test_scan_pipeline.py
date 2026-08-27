"""End-to-end check from the spec: a repo with a planted secret, a vulnerable
dependency, and duplicated code must produce all three finding kinds.

This is the one test in the suite that runs the REAL scanners against the REAL
fixture repo. Everything else mocks at the boundary; this test is the backstop
that catches wiring breaks unit tests can't see."""

import shutil

import pytest

from app import pipeline
from app.models import Scan, User
from app.scanners.base import _resolve_executable


@pytest.fixture()
def scan_of_fixture(db, fixture_repo, tmp_path):
    workspace = tmp_path / "repo"
    shutil.copytree(fixture_repo, workspace)
    user = User(email="e2e@b.com", password_hash="x")
    db.add(user)
    db.flush()
    scan = Scan(user_id=user.id, repo_key="acme/vulnerable", mode="full",
                status="pending", source_type="local", source_ref=str(workspace))
    db.add(scan)
    db.commit()
    return scan


def test_pipeline_reports_secrets_vulns_and_vibe_debt(db, scan_of_fixture, monkeypatch):
    # No API key in tests: the AI layer degrades, the report still ships.
    monkeypatch.setattr(pipeline, "annotate", lambda findings: None)

    pipeline.run_scan(scan_of_fixture.id)

    db.expire_all()
    scan = db.get(Scan, scan_of_fixture.id)
    assert scan.status == "done", f"scan failed: {scan.error}"

    tools = {f.tool for f in scan.findings}
    categories = {f.category for f in scan.findings}

    assert "lizard" in tools, "vibe debt scanner produced nothing"
    assert "vibe-debt" in categories
    assert any("duplicate" in f.message.lower() for f in scan.findings)

    assert "semgrep" in tools, "semgrep produced nothing"
    assert any(
        f.tool == "semgrep" and f.file == "app.py" and "eval" in f.message.lower()
        for f in scan.findings
    ), "semgrep missed the eval() injection in app.py"

    if _resolve_executable("gitleaks") != "gitleaks":
        assert any(f.tool == "gitleaks" for f in scan.findings), "planted secret missed"

    assert "osv-scanner" in tools, "osv-scanner produced nothing"
    assert any("flask" in f.message.lower() for f in scan.findings), \
        "vulnerable flask dependency missed"

    # All five scanners run for real on this machine now: no scanner should fail,
    # so scan.error must be None — a future silent scanner failure trips this.
    assert scan.error is None
    assert scan.status == "done"

    assert scan.security_score is not None
    assert scan.vibe_debt_score is not None
    assert scan.security_score < 100, "real findings exist; a perfect score means scoring isn't wired up"
    assert scan.vibe_debt_score > 0, "duplicated code should cost vibe debt points"
    assert scan.ai_available is False
