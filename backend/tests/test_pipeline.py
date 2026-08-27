import pytest

from app import pipeline
from app.models import Scan, User
from app.scanners.base import RawFinding, ScannerUnavailable


@pytest.fixture()
def scan_row(db, tmp_path):
    user = User(email="p@b.com", password_hash="x")
    db.add(user)
    db.flush()
    (tmp_path / "app.py").write_text("print(1)\n")
    scan = Scan(user_id=user.id, repo_key="acme/demo", mode="full",
                status="pending", source_type="local", source_ref=str(tmp_path))
    db.add(scan)
    db.commit()
    return scan


def fake_scanner(findings=None, error=None):
    def scan(workspace, files=None):
        if error:
            raise error
        return findings or []
    return type("FakeScanner", (), {"scan": staticmethod(scan)})


def test_successful_scan_persists_findings_and_scores(db, scan_row, monkeypatch):
    monkeypatch.setattr(pipeline, "SCANNERS", [
        fake_scanner([RawFinding("semgrep", "high", "app.py", 1, "eval used")]),
        fake_scanner([RawFinding("lizard", "low", "dup.py", 2, "dup", "vibe-debt")]),
    ])
    monkeypatch.setattr(pipeline, "annotate", lambda f: [
        {"explanation": "Bad.", "fix": "Remove it."} for _ in f
    ])

    pipeline.run_scan(scan_row.id)

    db.expire_all()
    scan = db.get(Scan, scan_row.id)
    assert scan.status == "done"
    assert scan.security_score == 85
    assert scan.vibe_debt_score == 4
    assert scan.ai_available is True
    assert len(scan.findings) == 2
    assert scan.findings[0].ai_explanation == "Bad."


def test_scan_completes_when_one_scanner_fails(db, scan_row, monkeypatch):
    monkeypatch.setattr(pipeline, "SCANNERS", [
        fake_scanner([RawFinding("semgrep", "high", "app.py", 1, "eval used")]),
        fake_scanner(error=ScannerUnavailable("gitleaks missing")),
    ])
    monkeypatch.setattr(pipeline, "annotate", lambda f: None)

    pipeline.run_scan(scan_row.id)

    db.expire_all()
    scan = db.get(Scan, scan_row.id)
    assert scan.status == "done"
    assert len(scan.findings) == 1
    assert "gitleaks" in (scan.error or "")


def test_missing_scanner_recorded_not_silently_ignored(db, scan_row, monkeypatch):
    """A scanner that raises ScannerUnavailable must be recorded, not treated as a clean run."""
    monkeypatch.setattr(pipeline, "SCANNERS", [
        fake_scanner([RawFinding("semgrep", "high", "app.py", 1, "eval used")]),
        fake_scanner(error=ScannerUnavailable("gitleaks is not installed")),
    ])
    monkeypatch.setattr(pipeline, "annotate", lambda f: None)

    pipeline.run_scan(scan_row.id)

    db.expire_all()
    scan = db.get(Scan, scan_row.id)
    assert scan.status == "done"
    assert len(scan.findings) == 1
    assert scan.findings[0].tool == "semgrep"
    # The failed tool must be named in scan.error — a user reading this must be able
    # to tell which scanner never ran, not just that "something" went wrong.
    assert scan.error is not None
    assert "gitleaks" in scan.error


def test_scan_fails_only_when_every_scanner_fails(db, scan_row, monkeypatch):
    monkeypatch.setattr(pipeline, "SCANNERS", [
        fake_scanner(error=ScannerUnavailable("semgrep missing")),
        fake_scanner(error=ScannerUnavailable("gitleaks missing")),
    ])
    monkeypatch.setattr(pipeline, "annotate", lambda f: None)

    pipeline.run_scan(scan_row.id)

    db.expire_all()
    scan = db.get(Scan, scan_row.id)
    assert scan.status == "failed"
    assert scan.findings == []


def test_ai_failure_still_produces_a_report(db, scan_row, monkeypatch):
    monkeypatch.setattr(pipeline, "SCANNERS", [
        fake_scanner([RawFinding("semgrep", "high", "app.py", 1, "eval used")]),
    ])
    monkeypatch.setattr(pipeline, "annotate", lambda f: None)

    pipeline.run_scan(scan_row.id)

    db.expire_all()
    scan = db.get(Scan, scan_row.id)
    assert scan.status == "done"
    assert scan.ai_available is False
    assert scan.findings[0].ai_explanation is None
    assert scan.security_score == 85


def test_bad_source_marks_scan_failed(db, scan_row, monkeypatch):
    scan_row.source_type = "git"
    scan_row.source_ref = "https://github.com/does-not/exist-xyz.git"
    db.commit()
    monkeypatch.setattr(pipeline, "SCANNERS", [fake_scanner([])])

    pipeline.run_scan(scan_row.id)

    db.expire_all()
    scan = db.get(Scan, scan_row.id)
    assert scan.status == "failed"
    assert scan.error


def test_zip_source_temp_file_deleted_after_successful_scan(db, tmp_path, monkeypatch):
    import zipfile

    user = User(email="z@b.com", password_hash="x")
    db.add(user)
    db.flush()
    zip_path = tmp_path / "upload.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("app.py", "print(1)\n")
    scan = Scan(user_id=user.id, repo_key="zip:demo", mode="full",
                status="pending", source_type="zip", source_ref=str(zip_path))
    db.add(scan)
    db.commit()

    monkeypatch.setattr(pipeline, "SCANNERS", [fake_scanner([])])
    monkeypatch.setattr(pipeline, "annotate", lambda f: None)

    pipeline.run_scan(scan.id)

    assert not zip_path.exists()


def test_scan_error_is_truncated_to_fit_the_column(db, scan_row, monkeypatch):
    """scan.error must fit String(500) even when SQLite (unlike Postgres) won't enforce it.

    Uses a PARTIAL failure (one scanner survives) so this exercises the success-path
    `scan.error = "; ".join(failures)` assignment, not `_fail`'s already-truncated one.
    """
    long_message = "x" * 300
    monkeypatch.setattr(pipeline, "SCANNERS", [
        fake_scanner([RawFinding("semgrep", "high", "app.py", 1, "eval used")]),
        fake_scanner(error=ScannerUnavailable(long_message)),
        fake_scanner(error=ScannerUnavailable(long_message)),
    ])
    monkeypatch.setattr(pipeline, "annotate", lambda f: None)

    pipeline.run_scan(scan_row.id)

    db.expire_all()
    scan = db.get(Scan, scan_row.id)
    assert scan.status == "done"
    assert scan.error is not None
    assert len(scan.error) <= 500


def test_crash_after_intake_still_ends_in_failed_not_stuck_running(db, scan_row, monkeypatch):
    """An exception from anywhere past intake (e.g. annotate) must not escape run_scan
    and must not leave the scan stranded at status='running'."""
    monkeypatch.setattr(pipeline, "SCANNERS", [
        fake_scanner([RawFinding("semgrep", "high", "app.py", 1, "eval used")]),
    ])

    def boom(findings):
        raise RuntimeError("annotate blew up")

    monkeypatch.setattr(pipeline, "annotate", boom)

    pipeline.run_scan(scan_row.id)  # must not raise

    db.expire_all()
    scan = db.get(Scan, scan_row.id)
    assert scan.status == "failed"
    assert scan.error
    assert "annotate blew up" in scan.error


def test_zip_source_temp_file_deleted_after_failed_scan(db, tmp_path, monkeypatch):
    user = User(email="z2@b.com", password_hash="x")
    db.add(user)
    db.flush()
    zip_path = tmp_path / "bad-upload.zip"
    zip_path.write_text("not a real zip")
    scan = Scan(user_id=user.id, repo_key="zip:demo2", mode="full",
                status="pending", source_type="zip", source_ref=str(zip_path))
    db.add(scan)
    db.commit()

    monkeypatch.setattr(pipeline, "SCANNERS", [fake_scanner([])])

    pipeline.run_scan(scan.id)

    db.expire_all()
    scan = db.get(Scan, scan.id)
    assert scan.status == "failed"
    assert not zip_path.exists()


# --- The end-to-end guarantee: a tool that ran and failed is never a clean scan. ---
#
# These drive the REAL scanner modules (not fakes) with run_tool stubbed to look
# like a crashed CLI, so they catch a regression in any single scanner's parse
# guard — which per-module tests can only catch one module at a time.

def _break_tool(monkeypatch, module, stderr="network unreachable"):
    monkeypatch.setattr(module, "run_tool", lambda cmd, cwd, timeout=600: type(
        "R", (), {"returncode": 2, "stdout": "not json", "stderr": stderr})())


def _empty_report(monkeypatch, module, flag, filename=None):
    def fake_run(cmd, cwd, timeout=600):
        target = cmd[cmd.index(flag) + 1]
        path = f"{target}/{filename}" if filename else target
        with open(path, "w") as handle:
            handle.write("[]" if filename is None else '{"dependencies": []}')
        return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr(module, "run_tool", fake_run)


def _empty_stdout(monkeypatch, module, stdout):
    monkeypatch.setattr(module, "run_tool", lambda cmd, cwd, timeout=600: type(
        "R", (), {"returncode": 0, "stdout": stdout, "stderr": ""})())


def test_all_scanners_crashing_marks_the_scan_failed(db, scan_row, monkeypatch):
    from app.scanners import deps_scan, gitleaks_scan, semgrep_scan

    monkeypatch.setattr(pipeline, "SCANNERS", [semgrep_scan, gitleaks_scan, deps_scan])
    for module in (semgrep_scan, gitleaks_scan, deps_scan):
        _break_tool(monkeypatch, module)
    monkeypatch.setattr(pipeline, "annotate", lambda f: None)

    pipeline.run_scan(scan_row.id)

    db.expire_all()
    scan = db.get(Scan, scan_row.id)
    assert scan.status == "failed", "crashed scanners were reported as a clean scan"
    assert scan.security_score is None


def test_only_semgrep_crashing_still_names_it_in_the_error(db, scan_row, monkeypatch):
    from app.scanners import deps_scan, gitleaks_scan, semgrep_scan

    monkeypatch.setattr(pipeline, "SCANNERS", [semgrep_scan, gitleaks_scan, deps_scan])
    _break_tool(monkeypatch, semgrep_scan)
    _empty_report(monkeypatch, gitleaks_scan, "--report-path")
    _empty_stdout(monkeypatch, deps_scan, '{"results": null}')
    monkeypatch.setattr(pipeline, "annotate", lambda f: None)

    pipeline.run_scan(scan_row.id)

    db.expire_all()
    scan = db.get(Scan, scan_row.id)
    assert scan.status == "done"
    assert "semgrep" in (scan.error or ""), "a broken semgrep must be named, not hidden"
