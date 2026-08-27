import pytest
from fakeredis import FakeRedis
from rq import Queue
from unittest.mock import patch, MagicMock

from app.models import Scan
from app.reaper import mark_stale_scans

def dummy_task(scan_id):
    pass

def test_queue_enqueue():
    redis = FakeRedis()
    q = Queue("vibeguard-scans", connection=redis)
    job = q.enqueue(dummy_task, 1)
    
    assert job.id is not None
    assert len(q) == 1
    
    queued_job = q.jobs[0]
    assert queued_job.args == (1,)

def test_reaper_marks_stale_scans_as_failed():
    # Mock session and query
    session_mock = MagicMock()
    scan_running = Scan(id=1, status="running")
    scan_other = Scan(id=2, status="done")
    
    # Setup query mock to return only running scans
    query_mock = session_mock.query.return_value
    filter_mock = query_mock.filter.return_value
    filter_mock.all.return_value = [scan_running]
    
    count = mark_stale_scans(session_mock)
    
    assert count == 1
    assert scan_running.status == "failed"
    assert scan_running.error == "Interrupted by server restart"
    session_mock.commit.assert_called_once()
