import json
import shutil

import pytest

from app.scanners import semgrep_scan
from app.scanners.base import ScannerUnavailable, _resolve_executable

SAMPLE_OUTPUT = json.dumps({
    "results": [
        {
            "check_id": "python.lang.security.audit.eval-detected",
            "path": "app.py",
            "start": {"line": 11},
            "extra": {"severity": "ERROR", "message": "Detected eval on user input"},
        },
        {
            "check_id": "python.flask.debug-enabled",
            "path": "app.py",
            "start": {"line": 22},
            "extra": {"severity": "WARNING", "message": "Flask debug mode enabled"},
        },
    ]
})


def test_parses_results_into_findings(tmp_path, monkeypatch):
    monkeypatch.setattr(
        semgrep_scan, "run_tool",
        lambda cmd, cwd, timeout=600: type(
            "R", (), {"returncode": 0, "stdout": SAMPLE_OUTPUT, "stderr": ""}
        )(),
    )
    findings = semgrep_scan.scan(tmp_path)
    assert len(findings) == 2
    assert findings[0].tool == "semgrep"
    assert findings[0].severity == "high"
    assert findings[0].category == "security"
    assert findings[0].file == "app.py"
    assert findings[0].line == 11
    assert "eval" in findings[0].message
    assert findings[1].severity == "medium"


def test_unparseable_output_raises_rather_than_reporting_clean(tmp_path, monkeypatch):
    """A tool that ran and failed must raise, never return [] — [] means "clean"."""
    monkeypatch.setattr(
        semgrep_scan, "run_tool",
        lambda cmd, cwd, timeout=600: type(
            "R", (), {"returncode": 2, "stdout": "not json", "stderr": "boom"}
        )(),
    )
    with pytest.raises(ScannerUnavailable, match="boom"):
        semgrep_scan.scan(tmp_path)


def test_errors_array_with_no_results_raises(tmp_path, monkeypatch):
    """Valid JSON can still carry a failure: partial rule-download leaves errors[] set."""
    payload = json.dumps({"results": [], "errors": [{"message": "rule download failed"}]})
    monkeypatch.setattr(
        semgrep_scan, "run_tool",
        lambda cmd, cwd, timeout=600: type(
            "R", (), {"returncode": 0, "stdout": payload, "stderr": ""}
        )(),
    )
    with pytest.raises(ScannerUnavailable, match="rule download failed"):
        semgrep_scan.scan(tmp_path)


def test_clean_run_still_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(
        semgrep_scan, "run_tool",
        lambda cmd, cwd, timeout=600: type(
            "R", (), {"returncode": 0, "stdout": '{"results": [], "errors": []}', "stderr": ""}
        )(),
    )
    assert semgrep_scan.scan(tmp_path) == []


def test_missing_binary_propagates_rather_than_reporting_clean(tmp_path, monkeypatch):
    def fake_run(cmd, cwd, timeout=600):
        raise ScannerUnavailable("semgrep is not installed")

    monkeypatch.setattr(semgrep_scan, "run_tool", fake_run)
    with pytest.raises(ScannerUnavailable):
        semgrep_scan.scan(tmp_path)


def test_diff_mode_passes_only_changed_files(tmp_path, monkeypatch):
    captured = {}

    def fake_run(cmd, cwd, timeout=600):
        captured["cmd"] = cmd
        return type("R", (), {"returncode": 0, "stdout": '{"results": []}', "stderr": ""})()

    monkeypatch.setattr(semgrep_scan, "run_tool", fake_run)
    semgrep_scan.scan(tmp_path, files=["app.py"])
    assert captured["cmd"][-1] == "app.py"


@pytest.mark.skipif(_resolve_executable("semgrep") == "semgrep", reason="semgrep not installed")
def test_real_semgrep_finds_injection(fixture_repo, tmp_path):
    # Copied to its own root because semgrep resolves .semgrepignore against the
    # scan root; run in place, the repo's own root would decide what gets skipped.
    workspace = tmp_path / "repo"
    shutil.copytree(fixture_repo, workspace)
    findings = semgrep_scan.scan(workspace)
    assert any("eval" in f.message.lower() or "eval" in f.file for f in findings)


@pytest.mark.skipif(_resolve_executable("semgrep") == "semgrep", reason="semgrep not installed")
def test_real_semgrep_scans_paths_its_defaults_would_skip(fixture_repo, tmp_path):
    # semgrep's built-in ignore list drops tests/ and fixtures/; nesting the code
    # under both is exactly the layout that silently returned zero findings.
    workspace = tmp_path / "repo"
    (workspace / "tests" / "fixtures").mkdir(parents=True)
    shutil.copytree(fixture_repo, workspace / "tests" / "fixtures" / "vulnerable")
    assert semgrep_scan.scan(workspace), "semgrep skipped tests/fixtures entirely"


def test_repo_owned_semgrepignore_is_not_overwritten(tmp_path, monkeypatch):
    (tmp_path / ".semgrepignore").write_text("secret/\n")
    monkeypatch.setattr(semgrep_scan, "run_tool", lambda cmd, cwd, timeout=600: type(
        "R", (), {"returncode": 0, "stdout": '{"results": []}', "stderr": ""})())
    semgrep_scan.scan(tmp_path)
    assert (tmp_path / ".semgrepignore").read_text() == "secret/\n"
