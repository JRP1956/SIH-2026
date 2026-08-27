import logging
from fnmatch import fnmatch
from pathlib import Path

from app.db import SessionLocal
from app.intake import IntakeError, prepare
from app.models import Finding, Scan
from app.reasoning import annotate
from app.scanners import deps_scan, drift_scan, gitleaks_scan, lizard_scan, semgrep_scan
from app.scanners.base import RawFinding
from app.scoring import security_score, vibe_debt_score

log = logging.getLogger(__name__)

SCANNERS = [semgrep_scan, gitleaks_scan, deps_scan, lizard_scan, drift_scan]

_ERROR_MAX = 500

IGNORE_FILE = ".vibeguardignore"

# Tools whose findings survive the source-noise list below. A committed
# credential is still leaked when it sits in a vendored library or a test
# fixture, so a directory exclusion must not be what hides it.
SECRET_TOOLS = {"gitleaks"}

# Generated output. Nobody wrote this by hand, and a secret that reaches it came
# from source that gets scanned anyway — so every tool skips it, secrets
# included. A git clone has none of this; a zip upload carries all of it, and
# one .next cache alone contributes thousands of findings.
GENERATED_DIRS = [
    "node_modules", ".venv", "venv", ".git", "__pycache__", "dist", "build",
    ".next", ".turbo", ".nuxt", "out", "target", "coverage",
    ".pytest_cache", ".mypy_cache", ".ruff_cache",
]

# Checked-in source that is noise for quality tools but not for secret scanning:
# security fixtures are *meant* to be vulnerable, and vendored code is nobody
# here's to refactor — but a real credential in either is a real leak. Suppress
# an individual secret false positive with gitleaks' own .gitleaksignore, which
# records the reviewed value, instead of blinding the scan to a directory.
NOISY_SOURCE_DIRS = [
    "vendor", "third_party", "tests/fixtures", "test/fixtures", "testdata",
]


def _ignore_patterns(root: Path, tool: str) -> list[str]:
    """Ignore globs for one tool: generated output, source noise, and the repo's
    own .vibeguardignore. Secret scanners skip the source-noise list."""
    patterns = list(GENERATED_DIRS)
    if tool not in SECRET_TOOLS:
        patterns += NOISY_SOURCE_DIRS
    try:
        text = (root / IGNORE_FILE).read_text(errors="ignore")
    except OSError:
        return patterns
    return patterns + [line.strip() for line in text.splitlines()
                       if line.strip() and not line.lstrip().startswith("#")]


def _is_ignored(file: str, patterns: list[str]) -> bool:
    """True if a finding's path matches an ignore glob.

    fnmatch's '*' spans '/', so each pattern is tried four ways: as written, at
    any depth ('*/p'), as a directory prefix ('p/*'), and both. That makes a bare
    'node_modules' exclude its whole subtree wherever it sits, which is what
    anyone writing that line means.
    """
    path = (file or "").replace("\\", "/")
    return any(
        fnmatch(path, candidate)
        for pattern in patterns
        for candidate in (pattern, f"*/{pattern}", f"{pattern}/*", f"*/{pattern}/*")
    )


def _error_text(message: str) -> str | None:
    """Single choke point for scan.error so it always fits the String(500) column."""
    return message[:_ERROR_MAX] or None


def _record_findings(session, scan: Scan, findings: list[RawFinding]) -> None:
    """Persist findings (with AI notes when available) and the scan's scores."""
    annotations = annotate(findings)
    scan.ai_available = annotations is not None

    for index, raw in enumerate(findings):
        note = annotations[index] if annotations else {}
        session.add(Finding(
            scan_id=scan.id, tool=raw.tool, severity=raw.severity,
            category=raw.category, file=raw.file, line=raw.line,
            message=raw.message, license_id=raw.license_id,
            ai_explanation=note.get("explanation") or None,
            ai_fix=note.get("fix") or None,
        ))

    scan.security_score = security_score(findings)
    scan.vibe_debt_score = vibe_debt_score(findings)


def _execute(session, scan: Scan) -> None:
    """The scan itself. Raises; run_scan turns that into a failed status."""
    scan.status = "running"
    session.commit()

    with prepare(scan.source_type, scan.source_ref,
                 scan.base_ref, scan.head_ref) as workspace:
        findings, failures = _run_scanners(workspace)

    if len(failures) == len(SCANNERS):
        _fail(session, scan, "; ".join(failures) or "All scanners failed")
        return

    _record_findings(session, scan, findings)
    scan.error = _error_text("; ".join(failures))
    scan.status = "done"
    session.commit()


def _cleanup_upload(scan: Scan | None, scan_id: int) -> None:
    """Uploaded zips are written to a NamedTemporaryFile(delete=False) by the API
    layer; intake.prepare only cleans up its own extraction workspace, so the
    source file itself would otherwise leak for the process lifetime."""
    if scan is None or scan.source_type != "zip":
        return
    try:
        Path(scan.source_ref).unlink(missing_ok=True)
    except OSError:
        log.warning("could not delete temp upload for scan %s", scan_id)


def run_scan(scan_id: int) -> None:
    """Run one scan end to end. Never raises — failures land in scan.status."""
    session = SessionLocal()
    scan: Scan | None = None
    try:
        scan = session.get(Scan, scan_id)
        if scan is None:
            log.warning("scan %s not found", scan_id)
            return
        try:
            _execute(session, scan)
        except IntakeError as exc:
            _fail(session, scan, str(exc))
        except Exception as exc:  # noqa: BLE001 - run_scan must never raise into the background thread
            log.exception("scan %s crashed", scan_id)
            _fail(session, scan, f"Scan failed unexpectedly: {exc}")
    finally:
        _cleanup_upload(scan, scan_id)
        session.close()


def _dedupe(findings: list[RawFinding]) -> list[RawFinding]:
    """Collapse repeats of the same (tool, file, line, message).

    Semgrep's registry ships near-identical JS and TS rules, so one `path.join`
    can come back twice with the same text at the same line. Reporting it twice
    inflates the finding count and the score penalty for a single problem.
    """
    seen: set[tuple[str, str, int, str]] = set()
    unique = []
    for finding in findings:
        key = (finding.tool, finding.file, finding.line, finding.message)
        if key in seen:
            continue
        seen.add(key)
        unique.append(finding)
    return unique


def _run_scanners(workspace) -> tuple[list[RawFinding], list[str]]:
    findings: list[RawFinding] = []
    failures: list[str] = []
    # Filtering here rather than in each scanner: every finding funnels through
    # this loop, so one filter covers all five tools and any tool added later.
    for scanner in SCANNERS:
        # Unnamed scanner -> the stricter list; only declared secret tools opt out.
        patterns = _ignore_patterns(workspace.path, getattr(scanner, "TOOL", ""))
        try:
            findings.extend(
                finding for finding in scanner.scan(workspace.path, workspace.files)
                if not _is_ignored(finding.file, patterns)
            )
        except Exception as exc:  # noqa: BLE001 - one bad tool must not sink the scan
            log.warning("scanner %s failed: %s", scanner.__name__, exc)
            failures.append(f"{scanner.__name__.split('.')[-1]}: {exc}")
    return _dedupe(findings), failures


def _fail(session, scan: Scan, message: str) -> None:
    scan.status = "failed"
    scan.error = _error_text(message)
    try:
        session.commit()
    except Exception:  # noqa: BLE001 - recording the failure must not itself raise
        log.exception("could not record failure for scan %s", scan.id)
        session.rollback()
