import json
import re
from pathlib import Path

from app.scanners.base import RawFinding, ScannerUnavailable, run_tool

TOOL = "osv-scanner"
# \bGPL deliberately does not match LGPL — a word boundary needs a non-word char before it.
_COPYLEFT = [("AGPL", re.compile(r"AGPL", re.I)), ("GPL", re.compile(r"\bGPL", re.I))]


def is_copyleft(license_text: str) -> str | None:
    """Return the copyleft family (AGPL/GPL) this license belongs to, if any."""
    for name, pattern in _COPYLEFT:
        if pattern.search(license_text or ""):
            return name
    return None


def _manifest_path(source: str, workspace: Path) -> str:
    """Repo-relative path of the manifest a finding came from.

    osv-scanner usually reports paths relative to its cwd but can emit absolute
    ones. Keep the whole path either way: flattening to the basename made every
    manifest in the tree look like the same file, so a vulnerable pin inside a
    test fixture was indistinguishable from the real one.
    """
    path = Path(source)
    try:
        return str(path.relative_to(workspace))
    except ValueError:
        return str(path)


def _severity_from_score(score: str | None) -> str:
    """Map a CVSS numeric string (osv-scanner's max_severity) onto our vocabulary."""
    try:
        value = float(score)
    except (TypeError, ValueError):
        return "medium"
    if value >= 9.0:
        return "critical"
    if value >= 7.0:
        return "high"
    if value >= 4.0:
        return "medium"
    if value > 0:
        return "low"
    return "medium"


def _run_osv(workspace: Path) -> dict:
    """Run osv-scanner and return its parsed report, or raise if it did not run."""
    # osv-scanner reads manifests, not individual source files, so diff mode is
    # ignored — a changed lockfile affects every dependency in it.
    cmd = ["osv-scanner", "scan", "source", "--format", "json", "--recursive",
           "--allow-no-lockfiles", "--licenses=MIT", "."]
    result = run_tool(cmd, cwd=workspace)
    # osv-scanner exits 0 for a clean run and 1 merely because it found
    # vulnerabilities — both are successful runs and print valid JSON. Any other
    # exit code (bad flags, a path it couldn't resolve, a crash) is a real failure
    # and must raise even when stdout happens to parse: a network failure reaching
    # OSV.dev exits 127 while still printing well-formed JSON with empty results,
    # which would otherwise read as "clean, nothing to flag" instead of "couldn't
    # check anything." Exit code and parseability are both checked; either failing
    # must raise — never return [] for a run that didn't actually complete.
    if result.returncode not in (0, 1):
        raise ScannerUnavailable(
            f"osv-scanner exited {result.returncode}: {result.stderr.strip()[:200]}"
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        raise ScannerUnavailable(
            f"osv-scanner exited {result.returncode} without JSON: {result.stderr.strip()[:200]}"
        )


def _vulnerability_findings(manifest: str, name: str, version: str,
                            pkg: dict) -> list[RawFinding]:
    return [
        RawFinding(
            tool=TOOL,
            severity=_severity_from_score(group.get("max_severity")),
            file=manifest,
            line=0,
            message=f"{name} {version}: "
                    f"{', '.join(group.get('aliases') or group.get('ids') or []) or 'known vulnerability'}",
            category="security",
        )
        for group in pkg.get("groups", [])
    ]


def _license_findings(manifest: str, name: str, version: str,
                      pkg: dict) -> list[RawFinding]:
    findings = []
    for license_id in pkg.get("licenses") or []:
        family = is_copyleft(license_id)
        if family:
            findings.append(
                RawFinding(
                    tool=TOOL,
                    severity="medium",
                    file=manifest,
                    line=0,
                    message=f"{name} {version} is licensed {license_id}, a copyleft "
                            f"license that can require you to publish your source.",
                    category="license",
                    license_id=family,
                )
            )
    return findings


def scan(workspace: Path, files: list[str] | None = None) -> list[RawFinding]:
    payload = _run_osv(workspace)

    findings: list[RawFinding] = []
    for entry in payload.get("results") or []:
        manifest = _manifest_path(entry.get("source", {}).get("path", ""), workspace)
        for pkg in entry.get("packages", []):
            package = pkg.get("package", {})
            name = package.get("name", "unknown package")
            version = package.get("version", "")
            findings += _vulnerability_findings(manifest, name, version, pkg)
            findings += _license_findings(manifest, name, version, pkg)
    return findings
