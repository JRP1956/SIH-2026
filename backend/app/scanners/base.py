import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


class ScannerUnavailable(Exception):
    """The tool's CLI is not installed on this machine."""


@dataclass
class RawFinding:
    tool: str
    severity: str
    file: str
    line: int
    message: str
    category: str = "security"
    license_id: str | None = None
    extra: dict | None = None


_SEVERITY_MAP = {
    "critical": "critical",
    "error": "high", "high": "high",
    "warning": "medium", "medium": "medium", "moderate": "medium",
    "low": "low", "minor": "low",
    "info": "info", "note": "info", "informational": "info",
}


def normalize_severity(raw: str) -> str:
    """Map a tool's severity vocabulary onto ours; unknown values are medium."""
    return _SEVERITY_MAP.get((raw or "").strip().lower(), "medium")


def _resolve_executable(name: str) -> str:
    """Find a tool on PATH, or alongside the interpreter running us (venv bin)."""
    found = shutil.which(name)
    if found:
        return found
    local = Path(sys.executable).parent / name
    return str(local) if local.exists() else name


def run_tool(cmd: list[str], cwd: Path, timeout: int = 600) -> subprocess.CompletedProcess:
    resolved = [_resolve_executable(cmd[0]), *cmd[1:]]
    try:
        return subprocess.run(
            resolved, cwd=str(cwd), capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as exc:
        raise ScannerUnavailable(f"{cmd[0]} is not installed") from exc
