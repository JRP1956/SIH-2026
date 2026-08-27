import * as vscode from "vscode";
import { escapeHtml, formatClock } from "../utils/html";
import { sanitizeUserText } from "../utils/userFacing";
import type { ScanLogEvent, ScanLogService } from "../services/scanLogService";

export class ScanConsolePanel {
  public static current: ScanConsolePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, logs: ScanLogService): void {
    logs.show();
    if (ScanConsolePanel.current) {
      ScanConsolePanel.current.panel.reveal(vscode.ViewColumn.Beside);
      ScanConsolePanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "vibeguard.scanConsole",
      "VibeGuard Scan Console",
      vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] },
    );
    ScanConsolePanel.current = new ScanConsolePanel(context, panel, logs);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    private readonly logs: ScanLogService,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.disposables.push(logs.onDidAppend(() => this.render()));
    this.render();
  }

  private render(): void {
    const cssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css"));
    const lines = this.logs.history.map((event) => renderLine(event)).join("");
    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource};" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>VibeGuard Scan Console</title>
</head>
<body class="panel">
  <header class="brand">
    <div class="brand-mark"></div>
    <div>
      <div class="brand-name">Scan console</div>
      <div class="muted">Live scan progress</div>
    </div>
  </header>
  <section class="card">
    <p class="hint">Status updates appear here while a scan is running.</p>
    <div class="log tall">${lines || `<div class="muted">No scan activity yet. Run VibeGuard: Scan Project.</div>`}</div>
  </section>
</body>
</html>`;
  }

  private dispose(): void {
    ScanConsolePanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function renderLine(event: ScanLogEvent): string {
  return `<div><span class="muted">${escapeHtml(formatClock(event.timestamp))}</span> ${escapeHtml(sanitizeUserText(event.message))}</div>`;
}
