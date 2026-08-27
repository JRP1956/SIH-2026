from pathlib import Path

from app.pipeline import _ignore_patterns, _is_ignored
from app.scanners.deps_scan import _manifest_path

MISSING = Path("/nonexistent")
QUALITY = _ignore_patterns(MISSING, "lizard")
SECRETS = _ignore_patterns(MISSING, "gitleaks")


def test_fixture_and_vendor_paths_are_ignored_for_quality_tools():
    for path in [
        "backend/tests/fixtures/vulnerable_repo/requirements.txt",
        "tests/fixtures/vulnerable_repo/dup.py",
        "frontend/node_modules/left-pad/index.js",
        "node_modules/x.js",
        "backend/build/out.py",
        "frontend/.next/dev/server/chunks/runtime.js",
    ]:
        assert _is_ignored(path, QUALITY), path


def test_real_source_is_not_ignored():
    for path in [
        "backend/requirements.txt",
        "backend/app/pipeline.py",
        "frontend/app/page.tsx",
        "backend/tests/test_pipeline.py",  # real tests, only fixtures are excluded
        "",
    ]:
        assert not _is_ignored(path, QUALITY), path


def test_secrets_are_still_reported_inside_noisy_source_dirs():
    # A committed credential is a real leak wherever it sits. Hiding a whole
    # directory from the secret scanner would make a genuine leak invisible.
    for path in [
        "backend/tests/fixtures/vulnerable_repo/config.py",
        "vendor/somelib/settings.py",
        "third_party/sdk/keys.py",
    ]:
        assert _is_ignored(path, QUALITY), path
        assert not _is_ignored(path, SECRETS), path


def test_secrets_still_skip_generated_output():
    # Generated files are not authored, and a secret reaching them came from
    # source that gets scanned anyway.
    for path in ["frontend/.next/cache/.rscinfo", "node_modules/pkg/dist.js"]:
        assert _is_ignored(path, SECRETS), path


def test_vibeguardignore_adds_patterns_for_every_tool(tmp_path):
    (tmp_path / ".vibeguardignore").write_text("# comment\ndocs\n\n*.min.js\n")
    for tool in ("lizard", "gitleaks"):
        patterns = _ignore_patterns(tmp_path, tool)
        assert _is_ignored("docs/intro.md", patterns), tool
        assert _is_ignored("frontend/static/app.min.js", patterns), tool
        assert not _is_ignored("backend/app/pipeline.py", patterns), tool


def test_manifest_path_keeps_full_path():
    ws = Path("/ws")
    assert _manifest_path("/ws/tests/fixtures/requirements.txt", ws) == \
        "tests/fixtures/requirements.txt"
    assert _manifest_path("backend/requirements.txt", ws) == "backend/requirements.txt"
