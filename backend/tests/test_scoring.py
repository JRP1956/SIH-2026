from app.scanners.base import RawFinding
from app.scoring import (SEVERITY_ORDER, meets_threshold, security_score,
                         vibe_debt_score)


def make(severity="high", category="security"):
    return RawFinding(tool="t", severity=severity, file="f.py", line=1,
                      message="m", category=category)


def test_clean_repo_scores_100():
    assert security_score([]) == 100
    assert vibe_debt_score([]) == 0


def test_security_score_drops_with_severity():
    assert security_score([make("critical")]) == 75
    assert security_score([make("high")]) == 85
    assert security_score([make("medium")]) == 93
    assert security_score([make("low")]) == 97
    assert security_score([make("info")]) == 99


def test_security_score_floors_at_zero():
    assert security_score([make("critical")] * 20) == 0


def test_license_findings_count_toward_security_score():
    assert security_score([make("medium", category="license")]) == 93


def test_vibe_debt_findings_do_not_touch_security_score():
    assert security_score([make("medium", category="vibe-debt")]) == 100


def test_vibe_debt_score_counts_only_vibe_debt():
    findings = [make("medium", category="vibe-debt")] * 3 + [make("high")]
    assert vibe_debt_score(findings) == 12
    assert vibe_debt_score([make("high")]) == 0


def test_severity_order_is_ascending():
    assert SEVERITY_ORDER == ["info", "low", "medium", "high", "critical"]


def test_meets_threshold():
    assert meets_threshold([make("medium")], "high")
    assert not meets_threshold([make("high")], "high")
    assert not meets_threshold([make("critical")], "high")
    assert meets_threshold([], "info")


def test_meets_threshold_ignores_drift_findings():
    """Drift asserts no defect exists, so it must not be able to fail a CI
    gate even at a low fail_on threshold."""
    drift = [make("medium", category="drift")] * 5
    assert meets_threshold(drift, "medium")


def test_drift_findings_move_neither_score():
    from app.scanners.base import RawFinding
    from app.scoring import security_score, vibe_debt_score

    drift = [
        RawFinding(tool="drift", severity="medium", category="drift",
                   file=f"m{i}.py", line=1, message="impacted")
        for i in range(5)
    ]
    assert security_score(drift) == 100
    assert vibe_debt_score(drift) == 0
