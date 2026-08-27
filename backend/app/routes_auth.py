import secrets
from datetime import UTC, datetime, timedelta

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.auth import (COOKIE_NAME, cookie_policy, create_token, current_user,
                      hash_password, set_auth_cookie, verify_password)
from app.config import settings
from app.db import get_db
from app.models import User
from fastapi.responses import RedirectResponse

router = APIRouter(prefix="/auth", tags=["auth"])


class Credentials(BaseModel):
    email: EmailStr
    # The 8-char minimum existed only as an HTML attribute; curl accepted "".
    password: str = Field(min_length=8)


class UserOut(BaseModel):
    id: int
    email: str


@router.post("/signup", status_code=201, response_model=UserOut)
def signup(body: Credentials, response: Response, db: Session = Depends(get_db)):
    # Normalize case so A@b.com and a@b.com are one account, not two.
    email = body.email.lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="Email already registered")
    user = User(email=email, password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    set_auth_cookie(response, create_token(user.id))
    return UserOut(id=user.id, email=user.email)


@router.post("/login", response_model=UserOut)
def login(body: Credentials, response: Response, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email.lower()).first()
    if user is None or not user.password_hash or not verify_password(
        body.password, user.password_hash
    ):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    set_auth_cookie(response, create_token(user.id))
    return UserOut(id=user.id, email=user.email)


@router.post("/logout", status_code=204)
def logout(response: Response):
    # Attributes must match the ones it was set with or the browser keeps it.
    response.delete_cookie(COOKIE_NAME, path="/", **cookie_policy())


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return UserOut(id=user.id, email=user.email)


GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN = "https://github.com/login/oauth/access_token"
GITHUB_API = "https://api.github.com"


def exchange_code(code: str) -> dict:
    """Trade an OAuth code for the GitHub account's id and email."""
    with httpx.Client(timeout=15) as http:
        token_resp = http.post(
            GITHUB_TOKEN,
            headers={"Accept": "application/json"},
            data={
                "client_id": settings.github_client_id,
                "client_secret": settings.github_client_secret,
                "code": code,
            },
        )
        token_resp.raise_for_status()
        access_token = token_resp.json().get("access_token")
        if not access_token:
            raise HTTPException(status_code=401, detail="GitHub rejected the code")

        headers = {"Authorization": f"Bearer {access_token}",
                   "Accept": "application/vnd.github+json"}
        # Unchecked, a GitHub hiccup returns an error body that fails on the next
        # subscript and surfaces as a raw 500 traceback.
        try:
            profile_resp = http.get(f"{GITHUB_API}/user", headers=headers)
            profile_resp.raise_for_status()
            emails_resp = http.get(f"{GITHUB_API}/user/emails", headers=headers)
            emails_resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502, detail=f"GitHub is not responding correctly: {exc}"
            ) from exc
        profile = profile_resp.json()

        # Only use verified primary email from /user/emails endpoint
        emails = emails_resp.json()
        verified_primary = next(
            (e for e in emails if e.get("primary") and e.get("verified")),
            None
        )
        email = verified_primary["email"] if verified_primary else f"{profile['id']}@users.noreply.github.com"
        return {"github_id": str(profile["id"]), "email": email}


STATE_COOKIE = "vibeguard_oauth_state"
STATE_TTL = timedelta(minutes=10)


@router.get("/github/login")
def github_login():
    redirect_uri = f"{settings.backend_url}/auth/github/callback"
    # Without state, an attacker can force a victim's browser through a callback
    # carrying the attacker's code, logging the victim into the attacker's account.
    state = secrets.token_urlsafe(24)
    signed = jwt.encode(
        {"state": state, "exp": datetime.now(UTC) + STATE_TTL},
        settings.jwt_secret, algorithm="HS256",
    )
    response = RedirectResponse(
        f"{GITHUB_AUTHORIZE}?client_id={settings.github_client_id}"
        f"&redirect_uri={redirect_uri}&scope=read:user%20user:email&state={state}"
    )
    # Lax, not None: the callback is a top-level GET navigation back to this origin.
    response.set_cookie(
        STATE_COOKIE, signed, httponly=True, samesite="lax",
        secure=settings.cookie_cross_site,
        max_age=int(STATE_TTL.total_seconds()), path="/",
    )
    return response


def _verify_state(request: Request, state: str | None) -> None:
    signed = request.cookies.get(STATE_COOKIE)
    if not signed or not state:
        raise HTTPException(status_code=400, detail="Missing OAuth state")
    try:
        expected = jwt.decode(signed, settings.jwt_secret, algorithms=["HS256"])["state"]
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=400, detail="Invalid OAuth state") from exc
    if not secrets.compare_digest(expected, state):
        raise HTTPException(status_code=400, detail="Invalid OAuth state")


@router.get("/github/callback", name="github_callback")
def github_callback(
    request: Request,
    code: str,
    state: str | None = None,
    db: Session = Depends(get_db),
):
    _verify_state(request, state)
    account = exchange_code(code)
    user = db.query(User).filter(User.github_id == account["github_id"]).first()
    if user is None:
        # An existing email/password account with the same address gets linked.
        user = db.query(User).filter(User.email == account["email"]).first()
        if user is None:
            user = User(email=account["email"])
            db.add(user)
        user.github_id = account["github_id"]
        db.commit()
    response = RedirectResponse(settings.frontend_url)
    set_auth_cookie(response, create_token(user.id))
    response.delete_cookie(STATE_COOKIE, path="/")  # single use
    return response
