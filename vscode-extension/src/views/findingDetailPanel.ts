import * as vscode from "vscode";
import type { Finding, ScanReport } from "../api/types";
import { escapeHtml, getNonce } from "../utils/html";
import { asSeverity, SEVERITY_COLOR, SEVERITY_LABEL } from "../utils/severity";
import { resolveFindingUri, workspaceFolder } from "../utils/paths";

export class FindingDetailPanel {
  public static current: FindingDetailPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, finding: Finding, scan?: ScanReport): void {
    if (FindingDetailPanel.current) {
      FindingDetailPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      FindingDetailPanel.current.render(finding, scan);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "vibeguard.findingDetail",
      "VibeGuard Finding",
      vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] },
    );
    FindingDetailPanel.current = new FindingDetailPanel(context, panel, finding, scan);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    finding: Finding,
    scan?: ScanReport,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: { type?: string; file?: string; line?: number }) => {
      if (message.type === "openInEditor") {
        void vscode.commands.executeCommand("vibeguard.openInEditor", message.file, message.line);
      }
    }, null, this.disposables);
    this.render(finding, scan);
  }

  private render(finding: Finding, scan?: ScanReport): void {
    this.panel.title = finding.message.slice(0, 48) || "VibeGuard Finding";
    const nonce = getNonce();
    const cssUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css"));
    const severity = asSeverity(finding.severity);
    const loc = finding.file ? `${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}` : "—";
    const uri = resolveFindingUri(finding.file, workspaceFolder());
    const missing = finding.file && !uri;

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>VibeGuard Finding</title>
</head>
<body class="panel">
  <header class="brand">
    <div class="brand-mark"></div>
    <div>
      <div class="brand-name">VibeGuard Finding</div>
      <div class="muted">${scan ? `Scan #${scan.id}` : "Current scan"}</div>
    </div>
  </header>
  <section class="card">
    <div class="pill" style="color:${SEVERITY_COLOR[severity]};border-color:${SEVERITY_COLOR[severity]}">${escapeHtml(SEVERITY_LABEL[severity])}</div>
    <h1>${escapeHtml(finding.message)}</h1>
    <dl class="meta-grid">
      <dt>Category</dt><dd>${escapeHtml(finding.category)}</dd>
      <dt>File</dt><dd class="mono">${escapeHtml(loc)}</dd>
      <dt>Line</dt><dd class="mono">${finding.line > 0 ? finding.line : "—"}</dd>
      <dt>Scanner</dt><dd class="mono">${escapeHtml(finding.tool)}</dd>
      ${finding.license_id ? `<dt>License</dt><dd class="mono">${escapeHtml(finding.license_id)}</dd>` : ""}
    </dl>
    ${missing ? `<p class="alert">This file is not in the opened workspace, so it cannot be highlighted in the editor.</p>` : ""}
    <button class="btn primary" data-open ${!finding.file || missing ? "disabled" : ""}>Open in Editor</button>
  </section>
  <section class="card">
    <div class="label">What was detected</div>
    <p>${escapeHtml(finding.message)}</p>
  </section>
  ${finding.ai_explanation ? `<section class="card"><div class="label">AI explanation</div><p>${escapeHtml(finding.ai_explanation)}</p></section>` : `<section class="card"><div class="label">AI explanation</div><p class="muted">Unavailable for this finding — showing scanner output only.</p></section>`}
  ${finding.ai_fix ? `<section class="card"><div class="label">Recommended solution</div><pre>${escapeHtml(finding.ai_fix)}</pre></section>` : `<section class="card"><div class="label">Recommended solution</div><p class="muted">No suggested fix was returned by the backend.</p></section>`}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const btn = document.querySelector("[data-open]");
    btn?.addEventListener("click", () => {
      vscode.postMessage({ type: "openInEditor", file: ${JSON.stringify(finding.file)}, line: ${JSON.stringify(finding.line)} });
    });
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    FindingDetailPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
