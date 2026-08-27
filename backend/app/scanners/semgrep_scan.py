import json
from pathlib import Path

from app.scanners.base import RawFinding, ScannerUnavailable, normalize_severity, run_tool

TOOL = "semgrep"


def _disable_default_semgrepignore(workspace: Path) -> None:
    """Stop semgrep from silently dropping whole directories.

    With no .semgrepignore at the scan root, semgrep applies a built-in list that
    skips tests/, fixtures/, vendor/, scripts/ and more — so those paths were
    never scanned and never reported as skipped. An empty file at the root
    replaces that list entirely, leaving app.pipeline's ignore rules as the one
    place exclusions are decided. A .semgrepignore the repo already ships is the
    author's own choice and is left alone.
    """
    ignore_file = workspace / ".semgrepignore"
    if ignore_file.exists():
        return
    try:
        ignore_file.write_text("")
    except OSError:
        # Not worth failing the whole scan over: semgrep still runs, just with
        # its built-in skip list, which is the behaviour we had before.
        pass


def scan(workspace: Path, files: list[str] | None = None) -> list[RawFinding]:
    _disable_default_semgrepignore(workspace)
    targets = files if files else ["."]
    cmd = ["semgrep", "scan", "--config", "auto", "--json", "--quiet",
           "--no-git-ignore", *targets]
    result = run_tool(cmd, cwd=workspace)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        # Semgrep failed hard (bad config, network, crash). A tool that could not run
        # must raise: returning [] here would report a broken scanner as a clean scan.
        raise ScannerUnavailable(
            f"semgrep exited {result.returncode} without JSON: {result.stderr.strip()[:200]}"
        )
    # Valid JSON can still carry a failure: a partial rule download leaves results
    # empty and errors populated, which is indistinguishable from "clean" downstream.
    if not payload.get("results") and payload.get("errors"):
        raise ScannerUnavailable(
            f"semgrep errored: {payload['errors'][0].get('message', '')[:200]}"
        )

    findings = []
    for item in payload.get("results", []):
        extra = item.get("extra", {})
        findings.append(
            RawFinding(
                tool=TOOL,
                severity=normalize_severity(extra.get("severity", "")),
                file=item.get("path", ""),
                line=item.get("start", {}).get("line", 0),
                message=extra.get("message", item.get("check_id", "Semgrep finding")),
                category="security",
            )
        )
    return findings
