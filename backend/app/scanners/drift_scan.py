import ast
import functools
import json
import os
import re
from collections import defaultdict, deque
from pathlib import Path, PurePosixPath

from app.scanners.base import RawFinding

TOOL = "drift"
SKIP_DIRS = {".git", "node_modules", "venv", ".venv", "__pycache__", "dist", "build"}
PY_EXT = {".py"}
JS_EXT = {".js", ".jsx", ".mjs", ".ts", ".tsx"}
MAX_DEPTH = 3
_SEVERITY_BY_DEPTH = {1: "medium", 2: "low"}
# ponytail: hard cap on drift findings per scan. A widely-imported module's
# fan-out can otherwise reach into the hundreds, and pipeline.annotate batches
# 25 at a time and drops AI explanations from the WHOLE report if any one
# batch fails — so uncapped drift output could take real security findings'
# explanations down with it. Raise this, or make annotate fault-tolerant per
# batch, if 25 starts hiding real drift.
MAX_FINDINGS = 25

_JS_IMPORT = re.compile(
    r"""(?:from|require\(|import\()\s*['"]([^'"]+)['"]"""
    r"""|import\s+['"]([^'"]+)['"]"""
)


def _module_keys(rel: PurePosixPath) -> list[str]:
    """Every dotted name by which a Python file can be imported. sys.path may
    point at any ancestor directory, so each suffix of the path is plausible."""
    parts = list(rel.parts)
    if parts[-1] == "__init__.py":
        parts = parts[:-1]
    else:
        parts[-1] = parts[-1].rsplit(".", 1)[0]
    return [".".join(parts[i:]) for i in range(len(parts)) if parts[i:]]


def _import_from_names(node: ast.ImportFrom, package: tuple[str, ...]) -> list[str]:
    """Dotted names a single `from ... import ...` statement can refer to."""
    if node.level:
        # level 1 == this package, level 2 == its parent, and so on.
        keep = len(package) - (node.level - 1)
        base = ".".join(package[:keep]) if keep > 0 else ""
    else:
        base = ""
    module = ".".join(p for p in (base, node.module or "") if p)
    if not module:
        return []
    # `from x import y` may name a submodule y, not just an attribute.
    return [module, *(f"{module}.{alias.name}" for alias in node.names)]


def _python_imports(source: str, rel: PurePosixPath) -> list[str]:
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        # ponytail: a file the parser can't handle contributes no import edges,
        # so its dependents go unreported. Under-reporting is the safe
        # direction for a "check this too" signal; revisit if unparsable
        # source turns out to be common enough to matter.
        return []
    package = rel.parent.parts
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.extend(_import_from_names(node, package))
    return names


def _js_imports(source: str) -> list[str]:
    return [a or b for a, b in _JS_IMPORT.findall(source)]


_ALIAS_CONFIG_NAMES = ("tsconfig.json", "jsconfig.json")


@functools.lru_cache(maxsize=None)
def _load_paths_config(
    workspace: Path, rel_dir: PurePosixPath
) -> tuple[str, tuple[tuple[str, tuple[str, ...]], ...]] | None:
    """Nearest tsconfig/jsconfig.json's compilerOptions.paths, walking up from
    rel_dir to the workspace root. Returns (base_dir, paths) with base_dir the
    posix dir the alias targets are relative to (baseUrl), or None if no
    config with a `paths` map is found.

    # ponytail: supports only the common `"@/*": ["./*"]` shape — a single
    # wildcard prefix per pattern, no `extends` chasing. Reach for a real
    # tsconfig resolver if a repo needs more than that.
    """
    parts = rel_dir.parts
    for i in range(len(parts), -1, -1):
        d = PurePosixPath(*parts[:i]) if i else PurePosixPath(".")
        for name in _ALIAS_CONFIG_NAMES:
            cfg_path = workspace / d / name
            if not cfg_path.is_file():
                continue
            try:
                data = json.loads(cfg_path.read_text(errors="ignore"))
            except (json.JSONDecodeError, ValueError, OSError):
                # tsconfig commonly has comments/trailing commas; degrade to
                # no-alias-support rather than raising.
                continue
            paths = (data.get("compilerOptions") or {}).get("paths")
            if not paths:
                continue
            base_url = (data.get("compilerOptions") or {}).get("baseUrl", ".")
            base_dir = os.path.normpath((d / base_url).as_posix()).replace(os.sep, "/")
            frozen = tuple((pattern, tuple(targets)) for pattern, targets in paths.items())
            return (base_dir, frozen)
    return None


def _resolve_alias(spec: str, base_dir: str, paths: tuple[tuple[str, tuple[str, ...]], ...]) -> str | None:
    for pattern, targets in paths:
        if not targets:
            continue
        if "*" not in pattern:
            if spec == pattern:
                return os.path.normpath((PurePosixPath(base_dir) / targets[0]).as_posix())
            continue
        prefix, _, suffix_pat = pattern.partition("*")
        if spec.startswith(prefix) and spec.endswith(suffix_pat):
            matched = spec[len(prefix):len(spec) - len(suffix_pat) or None]
            candidate = targets[0].replace("*", matched)
            return os.path.normpath((PurePosixPath(base_dir) / candidate).as_posix())
    return None


def _resolve_js(
    spec: str, rel: PurePosixPath, files: set[str], workspace: Path | None = None
) -> list[str]:
    if spec.startswith("."):
        target = os.path.normpath((rel.parent / spec).as_posix()).replace(os.sep, "/")
    else:
        target = None
        if workspace is not None:
            config = _load_paths_config(workspace, rel.parent)
            if config is not None:
                target = _resolve_alias(spec, *config)
        if target is None:
            return []  # bare specifier: an npm package, or an unresolvable alias
        target = target.replace(os.sep, "/")
    candidates = [target]
    candidates += [f"{target}{ext}" for ext in sorted(JS_EXT)]
    candidates += [f"{target}/index{ext}" for ext in sorted(JS_EXT)]
    return [c for c in candidates if c in files]


def _source_files(workspace: Path) -> list[str]:
    known = PY_EXT | JS_EXT
    found = []
    for path in workspace.rglob("*"):
        rel = path.relative_to(workspace)
        if not path.is_file() or path.suffix not in known:
            continue
        if SKIP_DIRS & set(rel.parts):
            continue
        found.append(rel.as_posix())
    return sorted(found)


def _dependents(workspace: Path, files: list[str]) -> dict[str, set[str]]:
    """Reverse import graph: dependents[target] = {files that import target}."""
    file_set = set(files)
    # ponytail: a module key that two files both claim maps to both, so an
    # ambiguous import adds edges to each. Over-connecting slightly widens the
    # blast radius, which is the safe direction for a "check this too" signal.
    # Resolve properly (respect sys.path / package roots) if the noise shows.
    by_key: dict[str, set[str]] = defaultdict(set)
    for rel in files:
        if PurePosixPath(rel).suffix in PY_EXT:
            for key in _module_keys(PurePosixPath(rel)):
                by_key[key].add(rel)

    dependents: dict[str, set[str]] = defaultdict(set)
    for rel in files:
        path = workspace / rel
        try:
            source = path.read_text(errors="ignore")
        except OSError:
            # ponytail: an unreadable file contributes no import edges, so its
            # dependents go unreported. Same safe-direction under-reporting as
            # the SyntaxError case in _python_imports above.
            continue
        posix = PurePosixPath(rel)
        targets: set[str] = set()
        if posix.suffix in PY_EXT:
            for name in _python_imports(source, posix):
                targets |= by_key.get(name, set())
        else:
            for spec in _js_imports(source):
                targets.update(_resolve_js(spec, posix, file_set, workspace))
        for target in targets - {rel}:
            dependents[target].add(rel)
    return dict(dependents)


def _blast_radius(
    dependents: dict[str, set[str]], seeds: list[str], max_depth: int
) -> dict[str, tuple[int, str]]:
    """Files reachable from the changed set, with hop count and originating seed."""
    seen: dict[str, tuple[int, str]] = {seed: (0, seed) for seed in seeds}
    queue = deque(seeds)
    while queue:
        node = queue.popleft()
        depth, origin = seen[node]
        if depth >= max_depth:
            continue
        for importer in dependents.get(node, ()):
            if importer not in seen:
                seen[importer] = (depth + 1, origin)
                queue.append(importer)
    return {f: v for f, v in seen.items() if v[0] > 0}


def scan(workspace: Path, files: list[str] | None = None) -> list[RawFinding]:
    """Files a diff did not touch but that depend on files it did.

    Full-tree scans have no changed set to walk out from, so they produce
    nothing — this only has something to say about a diff.
    """
    if not files:
        return []

    sources = _source_files(workspace)
    source_set = set(sources)
    seeds = [rel for rel in files if rel in source_set]
    if not seeds:
        return []

    dependents = _dependents(workspace, sources)
    radius = _blast_radius(dependents, seeds, MAX_DEPTH)

    # Closest, most relevant dependents first; ties broken by filename for
    # determinism (see MAX_FINDINGS below).
    ordered = sorted(radius.items(), key=lambda item: (item[1][0], item[0]))
    suppressed = max(0, len(ordered) - MAX_FINDINGS)
    kept = ordered[:MAX_FINDINGS]

    findings = []
    for impacted, (depth, origin) in kept:
        hops = "directly" if depth == 1 else f"{depth} hops away"
        findings.append(RawFinding(
            tool=TOOL,
            severity=_SEVERITY_BY_DEPTH.get(depth, "info"),
            category="drift",
            file=impacted,
            line=0,
            message=f"'{impacted}' imports changed code ({hops}, via '{origin}') "
                    f"but is not in this diff. Nothing here was re-reviewed — "
                    f"check the contract it relies on still holds.",
        ))
    if suppressed:
        findings[-1].message += f" ...and {suppressed} more impacted file(s) suppressed."
    return findings
