# VibeGuard Backend

## Setup

Requires **Python 3.11** specifically (not 3.12+, not 3.14). Semgrep cannot
even be imported on Python 3.14 — pin the venv to 3.11 or scans will fail
before they start.

**Windows works as of `semgrep==1.112.0`** — the pin was bumped from 1.101.0,
which had no `win_amd64` wheel and forced a source build that failed on
semgrep's OCaml core. The benchmark below was re-run against 1.112.0 and
scored identically (10 TP, 5 FP, 0 FN), so the bump didn't change which
rules fire. All five scanners now install and run natively on Windows;
macOS/Linux contributors are unaffected.

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.lock.txt
cp .env.example .env   # then fill in OPENAI_API_KEY and the GitHub OAuth pair
```

`requirements.txt` holds the direct dependencies; `requirements.lock.txt` is the
full resolved set and is what installs and Docker builds actually use. After
editing `requirements.txt`, regenerate it:

```bash
uv pip compile requirements.txt -o requirements.lock.txt
```

Postgres — the default `DATABASE_URL` connects as the role `vibeguard`, so
create the role as well as the database. `createdb` alone leaves the backend
unable to connect, and it fails at startup rather than serving errors:

```bash
createuser -s vibeguard 2>/dev/null || true
psql -d postgres -c "ALTER ROLE vibeguard WITH PASSWORD 'vibeguard'"
createdb -O vibeguard vibeguard
```

## Scanner setup

Five scanners run per scan. Each covers a different capability. A tool that
**ran and found nothing** contributes zero findings; a tool that **could not
run** — missing binary, crash, unreadable output, semgrep unable to reach
its ruleset — raises, and is named in `scan.error` (e.g. `"deps_scan:
osv-scanner is not installed"`). A partial failure still produces a
report with `status="done"`; only an all-scanner failure marks the scan
`failed`. A clean repo and a broken scanner are never reported the same way.

| Tool | Capability | Install |
|---|---|---|
| **Semgrep** | static analysis / code injection, hardcoded secrets in source | `pip install -r requirements.txt` (already listed) |
| **Lizard** | vibe debt: cyclomatic complexity, duplicated logic | `pip install -r requirements.txt` (already listed) |
| **Gitleaks** | secret scanning (API keys, tokens in git history/files) | `brew install gitleaks`, or a release from https://github.com/gitleaks/gitleaks/releases |
| **osv-scanner** | vulnerable dependencies, copyleft license flags | `brew install osv-scanner`, or a release from https://github.com/google/osv-scanner/releases. No database step — it's a single binary that queries the OSV API (or bundled offline data) on each run. |
| **Drift** | integration drift: files importing what the diff changed but left unreviewed | nothing to install — stdlib only. Diff scans only; a full-tree scan has no changed set to walk out from, so it reports nothing |

### Semgrep telemetry

Semgrep's `--config auto` (used here to pull the default community ruleset)
requires Semgrep metrics to be enabled — it hard-errors if you set
`--metrics off`. That means every scan sends pseudonymous usage data to
semgrep.dev. This is a deployment decision, not a bug: if that's not
acceptable for your environment, you'd need to switch to a pinned local
ruleset instead of `auto`.

### OPENAI_API_KEY is optional

Without it, scans still complete and reports still ship — findings just
carry only the raw scanner output, with no AI-generated explanation or fix.
`scan.ai_available` is `false` in that case so the frontend can show that the
explanations are missing rather than pretending they don't exist.

## Deploying off localhost

Two settings only matter once the app leaves your laptop, and both fail in
ways that look like something else:

**`JWT_SECRET`** — the built-in default is a known literal, so any instance
running on it has forgeable sessions for an arbitrary `user_id`. The app
refuses to start if `JWT_SECRET` is still the default and `FRONTEND_URL` is
not localhost. Generate one with:

```bash
python -c 'import secrets; print(secrets.token_urlsafe(32))'
```

**`COOKIE_CROSS_SITE`** — leave it `false` when frontend and backend share a
host (localhost counts: ports don't affect SameSite). Set it `true` when they
are on different hosts, which switches the session cookie from
`SameSite=Lax` to `SameSite=None; Secure`. Get this wrong and the browser
silently drops the cookie on every `credentials: "include"` fetch: login
appears to succeed and every request after it 401s, which reads as an auth
bug rather than a cookie-policy one. `SameSite=None` requires `Secure`, so
cross-site deployments must be served over https.

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

## Test

```bash
python -m pytest -v
```

Most per-scanner tests that need a missing binary skip themselves rather
than fail. `tests/test_scan_pipeline.py` is different: it never skips — it
always runs the real pipeline and narrows which assertions it makes
depending on which binaries are present, so it stays the one test that
fails outright if the pipeline itself breaks, even with tools missing. It
runs against a fixture repo with a planted secret, a vulnerable dependency,
and duplicated code, and it's slower than the rest of the suite (semgrep
alone takes several seconds and reaches the network for its ruleset) — it's
the strongest signal that the whole pipeline actually works, not just its
pieces in isolation.

## Using the status endpoint as a CI gate

```bash
curl -s "http://localhost:8000/scans/$SCAN_ID/status?fail_on=high" | jq -e '.passed'
```

## Measuring the false-positive rate

The AI reasoning layer cannot invent findings — it annotates the exact index
list it is given, and out-of-range indexes are dropped
(`tests/test_reasoning.py::test_extra_annotations_are_discarded`). That is a
property of the architecture, not a rate.

The *scanners* do produce false positives, and that rate is measured:

```bash
python -m benchmark.run --json benchmark/results.json
```

The runner scans each repo in `benchmark/labels.json`, matches findings against
hand-labeled true positives (same file, line within 2, tool if the label names
one), and reports precision, recall, and the false-positive rate. "False-positive
rate" here means the false *discovery* rate — the share of reported findings
that turned out wrong, `FP / (TP + FP)` — not `FP / (FP + TN)`; the printed
line spells this out since the number is meant to be quoted on its own. One
label absorbs one finding, so a scanner that repeats itself books the repeats
as false positives; the runner additionally splits that FP count into
*duplicates* (repeat reports of a real, labeled issue — noise, not error)
and *spurious* (findings that match no labeled issue at all — a real wrong
finding), printed alongside the strict rate so neither number has to be
inferred from the other. That duplicate/spurious split is decided purely by
line proximity to a label, not by matching the finding's tool or message —
so a genuinely wrong finding that happens to land within tolerance of an
unrelated real label is counted as a duplicate, not spurious. Only `security`
and `license` findings are scored — vibe-debt and drift are threshold and
impact signals, not defect claims.

It exits non-zero above the target rate in `labels.json`, so it works in CI.
A scanner that is not installed aborts the run rather than being skipped: a
partial run would silently drop that tool's false positives and report a
flattering number for a tool set that never ran.
