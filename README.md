# VibeGuard

VibeGuard is an AI-assisted security and code-quality scanner for
"vibe-coded" applications — repos written fast, often with AI help, where
nobody's had time to audit them. Submit a GitHub repo URL or a zip; get back
a scored report of security issues, leaked secrets, vulnerable dependencies,
and code-quality debt, each with an AI-generated explanation and suggested
fix where possible.

## What it catches

Five scanners run per scan, each covering a different capability:

| Tool | Catches |
|---|---|
| **Semgrep** | Static analysis findings — injection, unsafe patterns, hardcoded secrets in source, across languages via its default `auto` ruleset |
| **Gitleaks** | Committed secrets — API keys, tokens, credentials in files (and git history, if present) |
| **osv-scanner** | Known-vulnerable dependencies (CVE/OSV advisories) and copyleft license flags (AGPL/GPL) read off each dependency's manifest |
| **Lizard** | "Vibe debt" — cyclomatic complexity and duplicated code, the kind of mess that accumulates when code ships faster than it's reviewed |
| **Drift** | Integration drift — files that import code the diff changed but were not themselves reviewed. Diff scans only; a full-tree scan has no changed set to walk out from, so it reports nothing |

A tool that ran and found nothing contributes zero findings. A tool that
*could not run* (missing binary, crash, unparseable output) raises instead
of silently reporting a clean scan, and is named in `scan.error` on the
report. A scan only fails outright if every scanner fails; a partial
failure still produces a report.

An AI reasoning layer (OpenAI API) then annotates each raw finding with an
explanation and a suggested fix. It never invents findings — it only
reasons over what the deterministic scanners already reported — and if the
call fails or no API key is configured, the report still ships with the raw
findings intact. That is a property of the architecture rather than a claim
about the model: the layer annotates the exact index list it is handed, and
an out-of-range index is dropped, so the annotated set can never grow.
`backend/tests/test_reasoning.py::test_extra_annotations_are_discarded`
locks it.

The scanners themselves do produce false positives, and that rate is
measured rather than asserted — see "Measuring the false-positive rate" in
`backend/README.md`. On the current two-repo corpus: 100% recall, 0 spurious
findings, and a 33.3% strict false-positive rate, every one of which is a
real issue reported twice by overlapping rules rather than a wrong finding.

## Architecture

```
Next.js frontend     ──▶  FastAPI backend  ──▶  Postgres
VS Code extension    ──▶  (same APIs)         (users, scans, findings)
```

The VS Code extension lives in `vscode-extension/` and reuses the existing
scan and auth APIs. See `vscode-extension/README.md` for how to run it.

A scan submission clones the repo (or extracts the zip, or checks out a
diff range) into a temp workspace, runs the five scanners against it,
sends the combined findings to the AI reasoning layer, scores the result,
and persists everything. The frontend polls the scan until it's `done` or
`failed`.

## Quickstart

**Backend** (Python 3.11 — see `backend/README.md` for why the pin matters):

```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in OPENAI_API_KEY (optional) and GitHub OAuth

# The default DATABASE_URL connects as the role `vibeguard`, so create the
# role as well as the database — `createdb` alone leaves the backend unable
# to connect, and it fails at startup rather than serving errors.
createuser -s vibeguard 2>/dev/null || true
psql -d postgres -c "ALTER ROLE vibeguard WITH PASSWORD 'vibeguard'"
createdb -O vibeguard vibeguard

uvicorn app.main:app --reload --port 8000
```

Postgres must be running first (`brew services start postgresql@15`, or your
platform's equivalent).

**Frontend:**

```bash
cd frontend
npm install
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL, defaults to localhost:8000
npm run dev
```

### "Failed to fetch" on the sign-in page

That is the browser failing to reach the API at all, not a rejected
password — a wrong password returns "Invalid credentials" from the backend.
It means the backend is not answering on `NEXT_PUBLIC_API_URL`. In order of
likelihood:

1. **The backend is not running.** Check with `curl localhost:8000/health` —
   it should return `{"status":"ok"}`.
2. **The backend crashed at startup on the database.** It calls `init_db()`
   in its lifespan, so a bad `DATABASE_URL`, a missing `vibeguard` role, or a
   stopped Postgres means it never binds the port. Read the uvicorn output.
3. **CORS.** The backend only allows the origin in its `FRONTEND_URL`
   (default `http://localhost:3000`). Serving the frontend on another port or
   host without updating `FRONTEND_URL` fails the preflight, which also
   surfaces as "Failed to fetch".

See `backend/README.md` for scanner installs (Semgrep and Lizard come from
`requirements.txt`; Gitleaks and osv-scanner are separate binaries) and
deployment notes (`JWT_SECRET`, `COOKIE_CROSS_SITE`).

## Docs

- Design spec: `docs/superpowers/specs/2026-08-19-vibeguard-mvp-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-19-vibeguard-mvp.md`

## Current limitations

Being upfront about what this MVP doesn't handle yet:

- **The security score floors at 0.** A repo with a handful of high-severity
  findings and a repo riddled with critical ones can both read `0` — the
  score can't distinguish "bad" from "catastrophic" once it bottoms out.
- **Drift resolves imports heuristically.** A module name two files both
  claim maps to both, so an ambiguous import widens the blast radius rather
  than narrowing it — the safe direction for a "check this too" signal, but
  it does over-report. TypeScript path aliases are read from `tsconfig.json`
  only in the common `"@/*": ["./*"]` shape, and a file the parser can't
  handle contributes no import edges at all, so its dependents go unflagged.
- **Drift caps at 25 findings per scan.** A change to a widely-imported
  module can reach hundreds of files; the report keeps the closest 25 and
  says how many more were suppressed.
- **The benchmark number is not perfectly reproducible.** Semgrep's
  `--config auto` fetches rules at scan time and osv.dev keeps adding
  advisories, so the measured rate moves. Both drift it upward, never
  flattering.
- **A killed backend process strands a scan at `running`.** There's no
  reaper: if the process running a scan dies mid-scan, that scan's status
  never advances and nothing reclaims it.
- **Semgrep's `--config auto` requires telemetry.** It hard-errors on
  `--metrics off`, so every scan sends pseudonymous usage data to
  semgrep.dev. Fine for a demo; a deployment that can't accept that needs to
  switch to a pinned local ruleset instead of `auto`.
- **No `OPENAI_API_KEY` means no AI annotations.** Reports still ship, but
  findings carry only the raw scanner output — no generated explanation or
  fix suggestion. `scan.ai_available` reflects this so the frontend can show
  it rather than pretend the fields were never there.
