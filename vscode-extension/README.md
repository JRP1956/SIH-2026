# VibeGuard for VS Code

VibeGuard scans your workspace for security issues, leaked secrets, vulnerable dependencies, and code-quality (“vibe-debt”) problems — then shows scores and findings inside VS Code.

The extension talks to the same VibeGuard backend as the web app. **No local server is required.**

## Install

1. Open VS Code (1.85+) or Cursor
2. Go to Extensions
3. Search for **VibeGuard** (publisher: **NeelParikh**)
4. Click Install

Or from a terminal:

```bash
code --install-extension NeelParikh.vibeguard
```

## Hosted backend

```
https://sih-2026-production-63e7.up.railway.app
```

**Default extension behavior:** connects to this hosted API automatically.

## How to use

1. Open a project folder in VS Code
2. Click the VibeGuard icon in the Activity Bar
3. **VibeGuard: Sign In** (or **Sign Up** if you do not have an account)
4. Click **Scan Project**
5. Watch status in the sidebar and **VibeGuard: Show Scan Console**
6. When the scan finishes, review scores and findings
7. Open a finding for details, or click **Open in Editor** / a Problems panel entry to jump to the file

**Scan Current File** uploads only the active editor file through the same API.

## Local development override

To point at a backend on your machine, set `vibeguard.apiUrl` to:

```
http://localhost:8000
```

Use **VibeGuard: Set Backend URL**, or VS Code Settings. This is optional. The production default remains the hosted Railway API.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `vibeguard.apiUrl` | `https://sih-2026-production-63e7.up.railway.app` | Backend base URL. Optional local override: `http://localhost:8000`. |
| `vibeguard.pollIntervalMs` | `3000` | How often to poll scan status. The backend does not stream scanner logs. |

## Commands

- **VibeGuard: Scan Project**
- **VibeGuard: Scan Current File**
- **VibeGuard: Show Findings**
- **VibeGuard: Show Scan Console**
- **VibeGuard: Refresh Scan Status**
- **VibeGuard: Sign In** / **Sign Up** / **Sign Out**
- **VibeGuard: Set Backend URL**

## Scan console

The backend does **not** stream scanner stdout (no WebSocket or SSE). The Scan Console shows **status polling** events from `GET /scans/{id}` (queued → running → complete/failed), labeled `[status]`. That is not a live scanner log.

## Authentication

Sign-in uses email and password against `POST /auth/login`. The session cookie (`vibeguard_session`) is stored in VS Code Secret Storage and sent as a `Cookie` header on later requests. Passwords and session tokens are not written to the Scan Console or source control.

GitHub OAuth is web-only and is not used in the extension.

## Privacy

A scan uploads a zip of the opened workspace (or current file). The zip honors `.gitignore` and skips `.git`, `node_modules`, virtualenvs, build output, `.env*` files, and common secret filenames. Maximum upload size is 50 MB (backend limit). Analysis runs on the VibeGuard backend, not inside the editor.

## Requirements

- Visual Studio Code 1.85 or later (or a compatible editor such as Cursor)
- Network access to the hosted VibeGuard API
- A VibeGuard account

## Run from source

```bash
cd vscode-extension
npm install
npm run compile
```

Press **F5** in the `vscode-extension` folder, or:

```bash
code --extensionDevelopmentPath="./vscode-extension"
```

## Package

```bash
cd vscode-extension
npx vsce package --no-dependencies
```

## License

MIT
