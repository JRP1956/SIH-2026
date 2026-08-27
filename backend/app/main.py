from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import routes_auth, routes_scans
from app.config import check_production_secrets, settings
from app.db import init_db, SessionLocal
from app.reaper import mark_stale_scans

@asynccontextmanager
async def lifespan(app: FastAPI):
    check_production_secrets()
    init_db()
    with SessionLocal() as session:
        mark_stale_scans(session)
    yield


app = FastAPI(title="VibeGuard", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from app.graph import github_app

app.include_router(routes_auth.router)
app.include_router(routes_scans.router)
app.include_router(github_app.router)


@app.get("/health")
def health():
    return {"status": "ok"}
