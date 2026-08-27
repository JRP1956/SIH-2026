import * as vscode from "vscode";
import type { Finding } from "../api/types";
import { escapeHtml, formatDateTime, getNonce, repoDisplayName } from "../utils/html";
import { asSeverity, SEVERITY_COLOR, SEVERITY_LABEL, SEVERITY_ORDER, scoreTone, statusLabel, vibeDebtTone } from "../utils/severity";
import { countBySeverity } from "../api/client";
import type { AppState, AppStateSnapshot } from "../services/state";

// Webview message type -> command. A Map, not an object, so a message type like
// "constructor" cannot reach anything on Object.prototype. Anything not listed
// here is ignored: the webview cannot invoke arbitrary commands.
const WEBVIEW_COMMANDS = new Map<string, string>([
  ["scanProject", "vibeguard.scanProject"],
  ["refresh", "vibeguard.refreshScanStatus"],
  ["login", "vibeguard.login"],
  ["logout", "vibeguard.logout"],
  ["setApiUrl", "vibeguard.setApiUrl"],
  ["showConsole", "vibeguard.showScanConsole"],
]);

// Same, for the messages that carry a numeric id argument.
const WEBVIEW_ID_COMMANDS = new Map<string, string>([
  ["openFinding", "vibeguard.openFinding"],
  ["loadScan", "vibeguard.loadScan"],
]);

function handleWebviewMessage(message: { type?: string; id?: number }): void {
  const type = message.type ?? "";
  const command = WEBVIEW_COMMANDS.get(type);
  if (command) {
    void vscode.commands.executeCommand(command);
    return;
  }
  const idCommand = WEBVIEW_ID_COMMANDS.get(type);
  if (idCommand && typeof message.id === "number") {
    void vscode.commands.executeCommand(idCommand, message.id);
  }
}

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "vibeguard.sidebar";
  private view?: vscode.WebviewView;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: AppState,
  ) {
    this.unsubscribe = state.subscribe(() => this.render());
  }

  dispose(): void {
    this.unsubscribe();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.onDidReceiveMessage(handleWebviewMessage);
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = renderSidebarHtml(this.view.webview, this.context.extensionUri, this.state.current);
  }
}

function renderSidebarHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  state: AppStateSnapshot,
): string {
  const nonce = getNonce();
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.css"));
  const scan = state.currentScan;
  const project = escapeHtml(state.workspaceName ?? "No folder opened");
  const user = state.user ? escapeHtml(state.user.email) : "Not signed in";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>VibeGuard</title>
</head>
<body>
  <header class="brand">
    <div class="brand-mark" aria-hidden="true"></div>
    <div>
      <div class="brand-name">VibeGuard</div>
      <div class="muted">Security analysis</div>
    </div>
  </header>

  <section class="card">
    <div class="row">
      <div>
        <div class="label">Project</div>
        <div class="value">${project}</div>
      </div>
    </div>
    <div class="row meta">
      <span>${user}</span>
      <span class="mono">${escapeHtml(state.apiUrl)}</span>
    </div>
    ${state.backendReachable === false ? `<p class="alert">Cannot reach the VibeGuard API at ${escapeHtml(state.apiUrl)}${state.error ? `: ${escapeHtml(state.error)}` : "."}</p>` : state.error ? `<p class="alert">${escapeHtml(state.error)}</p>` : ""}
    <div class="actions">
      <button class="btn primary" data-cmd="scanProject" ${state.busy || !state.workspaceName ? "disabled" : ""}>
        ${state.busy ? "Scanning…" : "Scan Project"}
      </button>
      <button class="btn" data-cmd="refresh">Refresh</button>
    </div>
    <div class="actions">
      ${state.user
        ? `<button class="btn ghost" data-cmd="logout">Sign out</button>`
        : `<button class="btn ghost" data-cmd="login">Sign in</button>`}
      <button class="btn ghost" data-cmd="setApiUrl">Backend URL</button>
    </div>
  </section>

  ${renderStatus(state)}
  ${scan ? renderScores(scan) : ""}
  ${scan?.status === "done" ? renderRisk(scan.findings) : ""}
  ${scan?.findings?.length ? renderFindings(scan.findings) : ""}
  ${renderLogs(state)}
  ${renderHistory(state)}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.body.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-cmd]");
      if (!btn) return;
      const type = btn.getAttribute("data-cmd");
      const id = btn.getAttribute("data-id");
      vscode.postMessage(id ? { type, id: Number(id) } : { type });
    });
  </script>
</body>
</html>`;
}

function renderStatus(state: AppStateSnapshot): string {
  const scan = state.currentScan;
  const status = scan?.status ?? (state.busy ? "running" : "idle");
  const label = scan ? statusLabel(String(scan.status)) : state.busy ? "Running" : "Idle";
  return `<section class="card">
    <div class="label">Scan status</div>
    <div class="status">
      <span class="dot ${status}"></span>
      <strong>${escapeHtml(label)}</strong>
      ${scan ? `<span class="mono muted">#${scan.id} · ${escapeHtml(String(scan.mode))}</span>` : ""}
    </div>
    ${scan?.error ? `<p class="alert">${escapeHtml(scan.error)}</p>` : ""}
  </section>`;
}

function renderScores(scan: NonNullable<AppStateSnapshot["currentScan"]>): string {
  const sec = scoreTone(scan.security_score);
  const vibe = vibeDebtTone(scan.vibe_debt_score);
  return `<section class="card scores">
    <div>
      <div class="label">Security score</div>
      <div class="score" style="color:${sec.color}">${scan.security_score ?? "—"}</div>
      <div class="muted">${escapeHtml(sec.qualifier)}</div>
      <div class="meter"><span style="width:${scan.security_score ?? 0}%;background:${sec.color}"></span></div>
    </div>
    <div>
      <div class="label">Vibe debt score</div>
      <div class="score" style="color:${vibe.color}">${scan.vibe_debt_score ?? "—"}</div>
      <div class="muted">${escapeHtml(vibe.qualifier)}</div>
      <div class="meter"><span style="width:${scan.vibe_debt_score ?? 0}%;background:${vibe.color}"></span></div>
    </div>
  </section>`;
}

function renderRisk(findings: Finding[]): string {
  const list = findings;
  const counts = countBySeverity(list);
  const total = list.length || 1;
  const rows = SEVERITY_ORDER.map((sev) => {
    const count = counts[sev] ?? 0;
    const pct = (count / total) * 100;
    return `<div class="risk-row">
      <span><i style="background:${SEVERITY_COLOR[sev]}"></i>${SEVERITY_LABEL[sev]}</span>
      <span class="bar"><i style="width:${pct}%;background:${SEVERITY_COLOR[sev]}"></i></span>
      <span class="mono">${count}</span>
    </div>`;
  }).join("");
  return `<section class="card">
    <div class="row">
      <div class="label">Risk distribution</div>
      <div class="mono muted">${list.length} findings</div>
    </div>
    ${rows}
  </section>`;
}

function renderFindings(findings: { id: number; severity: string; message: string; file: string; line: number }[]): string {
  const recent = [...findings]
    .sort((a, b) => SEVERITY_ORDER.indexOf(asSeverity(a.severity)) - SEVERITY_ORDER.indexOf(asSeverity(b.severity)))
    .slice(0, 12);
  const items = recent.map((f) => {
    const loc = f.file ? `${f.file}${f.line > 0 ? `:${f.line}` : ""}` : "";
    return `<button class="finding" data-cmd="openFinding" data-id="${f.id}">
      <i style="background:${SEVERITY_COLOR[asSeverity(f.severity)]}"></i>
      <span>
        <strong>${escapeHtml(f.message)}</strong>
        <span class="muted mono">${escapeHtml(asSeverity(f.severity).toUpperCase())}${loc ? ` · ${escapeHtml(loc)}` : ""}</span>
      </span>
    </button>`;
  }).join("");
  return `<section class="card">
    <div class="row">
      <div class="label">Recent findings</div>
      <div class="mono muted">${findings.length}</div>
    </div>
    <div class="finding-list">${items}</div>
  </section>`;
}

function renderLogs(state: AppStateSnapshot): string {
  const lines = state.logs.slice(-8);
  if (lines.length === 0) {
    return "";
  }
  const body = lines.map((line) => {
    const time = line.timestamp.toLocaleTimeString(undefined, { hour12: false });
    return `<div><span class="muted">${escapeHtml(time)}</span> ${escapeHtml(line.message)}</div>`;
  }).join("");
  return `<section class="card">
    <div class="row">
      <div class="label">Scan console</div>
      <button class="btn ghost small" data-cmd="showConsole">Open</button>
    </div>
    <div class="log">${body}</div>
    <p class="hint">Status polling — not a scanner log stream.</p>
  </section>`;
}

function renderHistory(state: AppStateSnapshot): string {
  if (state.history.length === 0) {
    return "";
  }
  const rows = state.history.slice(0, 8).map((scan) => {
    const name = repoDisplayName(scan.repo_key);
    const when = formatDateTime(scan.created_at);
    return `<button class="history" data-cmd="loadScan" data-id="${scan.id}">
      <span>
        <strong>${escapeHtml(name)}</strong>
        <span class="muted">${escapeHtml(statusLabel(String(scan.status)))} · ${escapeHtml(when)}</span>
      </span>
      <span class="mono">${scan.security_score ?? "—"}</span>
    </button>`;
  }).join("");
  return `<section class="card">
    <div class="label">Scan history</div>
    <div class="history-list">${rows}</div>
  </section>`;
}
