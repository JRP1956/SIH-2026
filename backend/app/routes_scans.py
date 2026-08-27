import re
import tempfile
from datetime import datetime

import httpx
from fastapi import (APIRouter, BackgroundTasks, Depends, File, Form,
                     HTTPException, Query, UploadFile)
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import current_user
from app.db import get_db
from app.intake import IntakeError, repo_key_from_bytes, repo_key_from_url
from app.models import Finding, Scan, User
from app.pipeline import run_scan
from app.scanners.base import RawFinding
from app.scoring import SEVERITY_ORDER, meets_threshold

router = APIRouter(prefix="/scans", tags=["scans"])

# An allowlist, not a denylist: anything else — file://, http://, ssh, a bare local
# path — is rejected before a row is written. Without this, `git clone` will happily
# read a server-local path or a file:// URL and the report hands back that code's
# secrets and findings, with clone stderr echoed into scan.error as an SSRF oracle.
_REPO_URL = re.compile(r"^https://(github\.com|gitlab\.com)/[\w.-]+/[\w.-]+(\.git)?/?$")

# The upload is buffered in memory before it is written to a temp file.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def _ensure_public_github_repo(repo_url: str, repo_key: str) -> None:
    """Reject private or nonexistent GitHub repos before we ever try to clone them."""
    if "github.com" not in repo_url:
        return  # GitLab visibility needs a different API call — out of scope for now
    try:
        resp = httpx.get(
            f"https://api.github.com/repos/{repo_key}",
            headers={"Accept": "application/vnd.github+json"},
            timeout=10,
        )
    except httpx.HTTPError:
        raise HTTPException(
            status_code=502, detail="Could not reach GitHub to verify the repository"
        )
    if resp.status_code == 404:
        raise HTTPException(
            status_code=400,
            detail="VibeGuard only scans public repositories. Make this repo public and try again.",
        )
    if resp.status_code == 200:
        if resp.json().get("private"):
            raise HTTPException(
                status_code=400,
                detail="VibeGuard only scans public repositories. Make this repo public and try again.",
            )
        return
    # Anything else (rate limited, GitHub outage, unexpected status) — fail closed
    # rather than silently letting an unverified repo through.
    raise HTTPException(
        status_code=502,
        detail="Could not verify repository visibility with GitHub. Please try again shortly.",
    )


class ScanCreated(BaseModel):
    id: int
    status: str


class ScanSummary(BaseModel):
    id: int
    repo_key: str
    mode: str
    status: str
    security_score: int | None
    vibe_debt_score: int | None
    created_at: datetime

    model_config = {"from_attributes": True}


class FindingOut(BaseModel):
    id: int
    tool: str
    severity: str
    category: str
    file: str
    line: int
    message: str
    license_id: str | None
    ai_explanation: str | None
    ai_fix: str | None

    model_config = {"from_attributes": True}


class ScanReport(ScanSummary):
    ai_available: bool
    error: str | None
    findings: list[FindingOut]

    model_config = {"from_attributes": True}


def _owned_scan(scan_id: int, user: User, db: Session) -> Scan:
    scan = db.get(Scan, scan_id)
    if scan is None or scan.user_id != user.id:
        raise HTTPException(status_code=404, detail="Scan not found")
    return scan


@router.post("", status_code=201, response_model=ScanCreated)
def create_scan(
    background: BackgroundTasks,
    repo_url: str | None = Form(None),
    zip_file: UploadFile | None = File(None),
    base_ref: str | None = Form(None),
    head_ref: str | None = Form(None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    if repo_url:
        if not _REPO_URL.match(repo_url.strip()):
            raise HTTPException(
                status_code=400,
                detail="Provide an https GitHub or GitLab repository URL",
            )
        try:
            repo_key = repo_key_from_url(repo_url)
        except IntakeError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        _ensure_public_github_repo(repo_url, repo_key)
        source_type, source_ref = "git", repo_url
    elif zip_file is not None:
        # Read one byte past the cap: enough to know it's oversized, without
        # pulling an arbitrarily large upload into memory to find out.
        data = zip_file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Upload exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)}MB limit",
            )
        if not data:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        repo_key = repo_key_from_bytes(data)
        # The pipeline reads this back, then intake deletes its own workspace.
        handle = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
        handle.write(data)
        handle.close()
        source_type, source_ref = "zip", handle.name
    else:
        raise HTTPException(status_code=400, detail="Provide a repo_url or a zip_file")

    scan = Scan(
        user_id=user.id, repo_key=repo_key, status="pending",
        mode="diff" if (base_ref and head_ref) else "full",
        source_type=source_type, source_ref=source_ref,
        base_ref=base_ref, head_ref=head_ref,
    )
    db.add(scan)
    db.commit()

    background.add_task(run_scan, scan.id)
    return ScanCreated(id=scan.id, status=scan.status)


@router.get("", response_model=list[ScanSummary])
def list_scans(
    repo_key: str | None = Query(None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    query = db.query(Scan).filter(Scan.user_id == user.id)
    if repo_key:
        query = query.filter(Scan.repo_key == repo_key)
    return query.order_by(Scan.id.desc()).limit(50).all()


@router.get("/{scan_id}", response_model=ScanReport)
def get_scan(scan_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    scan = _owned_scan(scan_id, user, db)
    order = {name: i for i, name in enumerate(reversed(SEVERITY_ORDER))}
    scan.findings.sort(key=lambda f: order.get(f.severity, 99))
    return scan


@router.get("/{scan_id}/status")
def scan_status(
    scan_id: int,
    fail_on: str = Query("high"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    if fail_on not in SEVERITY_ORDER:
        raise HTTPException(
            status_code=422, detail=f"fail_on must be one of {SEVERITY_ORDER}"
        )
    scan = _owned_scan(scan_id, user, db)
    raw = [
        RawFinding(tool=f.tool, severity=f.severity, file=f.file, line=f.line,
                   message=f.message, category=f.category)
        for f in scan.findings
    ]
    return {
        "scan_id": scan.id,
        "status": scan.status,
        "passed": scan.status == "done" and meets_threshold(raw, fail_on),
        "security_score": scan.security_score,
        "vibe_debt_score": scan.vibe_debt_score,
    }
