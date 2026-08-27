import logging
from redis import Redis
from rq import Worker, Queue

from app.config import settings
from app.db import SessionLocal
from app.reaper import mark_stale_scans

logger = logging.getLogger(__name__)

def run_worker():
    logging.basicConfig(level=logging.INFO)
    logger.info("Starting RQ worker...")

    # Reap stale scans on startup
    try:
        with SessionLocal() as session:
            mark_stale_scans(session)
    except Exception as e:
        logger.warning(f"Skipping startup reap: DB not ready ({e})")

    redis_conn = Redis.from_url(settings.redis_url)
    
    worker = Worker(["vibeguard-scans"], connection=redis_conn)
    worker.work()

if __name__ == "__main__":
    run_worker()
