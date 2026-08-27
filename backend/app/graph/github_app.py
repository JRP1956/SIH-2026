import secrets
import time
from datetime import UTC, datetime, timedelta

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.auth import current_user
from app.config import settings
from app.db import get_db
from app.graph.models import GithubInstallation, GithubInstallationRepo
from app.models import Scan, User

router = APIRouter(prefix="/auth/github-app", tags=["github-app"])

STATE_COOKIE = "vibeguard_github_app_state"
STATE_TTL = timedelta(minutes=10)


def _generate_jwt() -> str:
    """Generate a JWT for authenticating as the GitHub App to fetch an installation token."""
    now = int(time.time())
    payload = {
        "iat": now - 60,
        "exp": now + (10 * 60),
        "iss": settings.github_app_id
    }
    # github_app_private_key is an RSA private key in PEM format
    return jwt.encode(payload, settings.github_app_private_key, algorithm="RS256")


def get_installation_token(session: Session, repo_key: str) -> str:
    """Fetch an installation token for a given repo. Raises ValueError if not found."""
    # Find the installation ID linked to this repo
    mapping = session.query(GithubInstallationRepo).filter(GithubInstallationRepo.repo_key == repo_key).first()
    if not mapping:
        raise ValueError("No GitHub App installation found for this repository")
        
    install = session.query(GithubInstallation).filter(GithubInstallation.installation_id == mapping.installation_id).first()
    if not install:
        raise ValueError("Installation record is missing")
        
    # Check if token is still valid (add 1 minute buffer)
    if install.access_token and install.token_expires_at:
        if install.token_expires_at > datetime.now(UTC) + timedelta(minutes=1):
            return install.access_token

    # Need to fetch a new token
    app_jwt = _generate_jwt()
    with httpx.Client(timeout=15) as http:
        resp = http.post(
            f"https://api.github.com/app/installations/{install.installation_id}/access_tokens",
            headers={
                "Authorization": f"Bearer {app_jwt}",
                "Accept": "application/vnd.github+json"
            }
        )
        if resp.status_code == 404:
            # Installation is dead / uninstalled
            session.delete(install)
            session.commit()
            raise ValueError("GitHub App installation has been removed")
        resp.raise_for_status()
        
        data = resp.json()
        install.access_token = data["token"]
        install.token_expires_at = datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00"))
        session.commit()
        
        return install.access_token


@router.get("/install")
def install_app(request: Request, repo_key: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Start the GitHub App installation flow for a specific repository."""
    # Verify the user has scanned this repo at least once
    scan = db.query(Scan).filter(Scan.user_id == user.id, Scan.repo_key == repo_key).first()
    if not scan:
        raise HTTPException(status_code=403, detail="You must scan this repository before installing the app")
        
    state = secrets.token_urlsafe(24)
    signed = jwt.encode(
        {"state": state, "repo_key": repo_key, "exp": datetime.now(UTC) + STATE_TTL},
        settings.jwt_secret, algorithm="HS256"
    )
    
    app_jwt = _generate_jwt()
    with httpx.Client(timeout=15) as http:
        resp = http.get("https://api.github.com/app", headers={"Authorization": f"Bearer {app_jwt}", "Accept": "application/vnd.github+json"})
        resp.raise_for_status()
        app_slug = resp.json()["html_url"]
        
    response = RedirectResponse(f"{app_slug}/installations/new?state={state}")
    
    response.set_cookie(
        STATE_COOKIE, signed, httponly=True, samesite="lax",
        secure=settings.cookie_cross_site,
        max_age=int(STATE_TTL.total_seconds()), path="/",
    )
    return response


@router.get("/callback")
def install_callback(
    request: Request,
    installation_id: int,
    setup_action: str,
    state: str | None = None,
    db: Session = Depends(get_db)
):
    """Handle the redirect back from GitHub after app installation."""
    signed = request.cookies.get(STATE_COOKIE)
    if not signed or not state:
        raise HTTPException(status_code=400, detail="Missing state cookie")
        
    try:
        payload = jwt.decode(signed, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=400, detail="Invalid state signature")
        
    if not secrets.compare_digest(payload["state"], state):
        raise HTTPException(status_code=400, detail="State mismatch")
        
    target_repo_key = payload["repo_key"]
    
    # 1. Fetch installation details using app JWT
    app_jwt = _generate_jwt()
    headers = {"Authorization": f"Bearer {app_jwt}", "Accept": "application/vnd.github+json"}
    with httpx.Client(timeout=15) as http:
        inst_resp = http.get(f"https://api.github.com/app/installations/{installation_id}", headers=headers)
        inst_resp.raise_for_status()
        inst_data = inst_resp.json()
        account_login = inst_data["account"]["login"]
        
        # 2. Upsert installation
        install = db.query(GithubInstallation).filter(GithubInstallation.installation_id == installation_id).first()
        if not install:
            install = GithubInstallation(installation_id=installation_id, account_login=account_login)
            db.add(install)
            db.commit()
            
        # 3. Fetch installation token to list repos
        token_resp = http.post(f"https://api.github.com/app/installations/{installation_id}/access_tokens", headers=headers)
        token_resp.raise_for_status()
        access_token = token_resp.json()["token"]
        
        # 4. List repositories to verify binding and upsert repos
        repos_resp = http.get("https://api.github.com/installation/repositories", headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/vnd.github+json"
        })
        repos_resp.raise_for_status()
        
        covered_repos = [repo["full_name"].lower() for repo in repos_resp.json().get("repositories", [])]
        
        if target_repo_key not in covered_repos:
            raise HTTPException(status_code=400, detail=f"Installation did not grant access to {target_repo_key}")
            
        # 5. Upsert repo bindings
        for repo in covered_repos:
            mapping = db.query(GithubInstallationRepo).filter(GithubInstallationRepo.repo_key == repo).first()
            if not mapping:
                mapping = GithubInstallationRepo(installation_id=installation_id, repo_key=repo)
                db.add(mapping)
            else:
                mapping.installation_id = installation_id
        db.commit()
        
    response = RedirectResponse(f"{settings.frontend_url}/dashboard")
    response.delete_cookie(STATE_COOKIE, path="/")
    return response
