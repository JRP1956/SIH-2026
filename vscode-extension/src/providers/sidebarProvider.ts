import * as vscode from "vscode";
import type { Finding } from "../api/types";
import { escapeHtml, formatDateTime, getNonce, repoDisplayName } from "../utils/html";
import { asSeverity, SEVERITY_COLOR, SEVERITY_LABEL, SEVERITY_ORDER, scoreTone, statusLabel, vibeDebtTone } from "../utils/severity";
import { countBySeverity } from "../api/client";
import { toUserFacingError, sanitizeUserText } from "../utils/userFacing";
import type { AppState, AppStateSnapshot } from "../services/state";

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
    webviewView.webview.onDidReceiveMessage((message: { type?: string; id?: number }) => {
      switch (message.type) {
        case "scanProject":
          void vscode.commands.executeCommand("vibeguard.scanProject");
          break;
        case "login":
          void vscode.commands.executeCommand("vibeguard.login");
          break;
        case "logout":
          void vscode.commands.executeCommand("vibeguard.logout");
          break;
        case "showConsole":
          void vscode.commands.executeCommand("vibeguard.showScanConsole");
          break;
        case "openFinding":
          if (typeof message.id === "number") {
            void vscode.commands.executeCommand("vibeguard.openFinding", message.id);
          }
          break;
        case "loadScan":
          if (typeof message.id === "number") {
            void vscode.commands.executeCommand("vibeguard.loadScan", message.id);
          }
          break;
        default:
          break;
      }
    });
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
  const hasFolder = Boolean(state.workspaceName);
  const project = hasFolder ? escapeHtml(state.workspaceName ?? "") : "";
  const user = state.user ? escapeHtml(state.user.email) : "";
  const scanning = state.busy;
  const scanLabel = scanning ? "Scanning..." : "Scan Project";
  const alert = sidebarAlert(state);

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
    <div class="label">Project</div>
    ${hasFolder ? `<div class="value">${project}</div>` : `<p class="empty">Open a folder in VS Code to scan a project.</p>`}
    ${user ? `<div class="account">${user}</div>` : ""}
    ${alert ? `<p class="alert">${escapeHtml(alert)}</p>` : ""}
    <div class="actions stack">
      <button class="btn primary" data-cmd="scanProject" ${scanning || !hasFolder ? "disabled" : ""}>
        ${scanLabel}
      </button>
      ${state.user
        ? `<button class="btn ghost" data-cmd="logout">Sign out</button>`
        : `<button class="btn ghost" data-cmd="login">Sign in</button>`}
    </div>
  </section>

  ${renderStatus(state)}
  ${scan ? renderScores(scan) : ""}
  ${scan?.status === "done" && scan.findings.length ? renderRisk(scan.findings) : ""}
  ${scan?.status === "done" ? renderFindings(scan.findings) : ""}
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

function sidebarAlert(state: AppStateSnapshot): string {
  if (state.backendReachable === false) {
    return "VibeGuard service is temporarily unavailable. Please try again.";
  }
  if (state.error) {
    return toUserFacingError(state.error);
  }
  return "";
}

function renderStatus(state: AppStateSnapshot): string {
  const scan = state.currentScan;
  const status = scan?.status ?? (state.busy ? "running" : "idle");
  const label = scan ? statusLabel(String(scan.status)) : state.busy ? "Running" : "Idle";
  const scanError = scan?.error ? toUserFacingError(scan.error) : "";
  return `<section class="card">
    <div class="label">Scan status</div>
    <div class="status">
      <span class="dot ${status}"></span>
      <strong>${escapeHtml(label)}</strong>
    </div>
    ${scanError ? `<p class="alert">${escapeHtml(scanError)}</p>` : ""}
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
  if (findings.length === 0) {
    return `<section class="card">
      <div class="label">Findings</div>
      <p class="empty">No findings in this scan.</p>
    </section>`;
  }
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
    return `<div><span class="muted">${escapeHtml(time)}</span> ${escapeHtml(sanitizeUserText(line.message))}</div>`;
  }).join("");
  return `<section class="card">
    <div class="row">
      <div class="label">Scan activity</div>
      <button class="btn ghost small" data-cmd="showConsole">Open</button>
    </div>
    <div class="log">${body}</div>
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
