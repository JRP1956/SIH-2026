from sqlalchemy.orm import Session
import logging

from app.models import Scan

logger = logging.getLogger(__name__)

def mark_stale_scans(session: Session) -> int:
    """
    Mark any scans left in the 'running' state as failed.
    This acts as a reaper for scans that were interrupted by a server restart.
    Returns the number of reaped scans.
    """
    stale_scans = session.query(Scan).filter(Scan.status == "running").all()
    count = len(stale_scans)
    if count > 0:
        for scan in stale_scans:
            scan.status = "failed"
            scan.error = "Interrupted by server restart"
        session.commit()
        logger.info(f"Reaped {count} stale scans.")
    return count
