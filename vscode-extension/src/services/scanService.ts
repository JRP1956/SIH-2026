import * as vscode from "vscode";
import { ApiClient, ApiError, summarizeFindings } from "../api/client";
import type { ScanReport } from "../api/types";
import { getApiUrl, getPollIntervalMs } from "../utils/config";
import { toUserFacingError } from "../utils/userFacing";
import { workspaceFolder, workspaceName } from "../utils/paths";
import type { FindingDiagnostics } from "../diagnostics/findingDiagnostics";
import type { AuthService } from "./authService";
import type { ScanLogService } from "./scanLogService";
import type { AppState } from "./state";
import { zipSingleFile, zipWorkspace, ZipTooLargeError } from "./workspaceZip";

export class ScanService implements vscode.Disposable {
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelled = false;
  private pollGeneration = 0;
  private scanInFlight = false;
  private readonly statusBar: vscode.StatusBarItem;

  constructor(
    private readonly api: ApiClient,
    private readonly auth: AuthService,
    private readonly logs: ScanLogService,
    private readonly state: AppState,
    private readonly diagnostics: FindingDiagnostics,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
    this.statusBar.command = "vibeguard.showFindings";
    this.statusBar.text = "$(shield) VibeGuard";
    this.statusBar.tooltip = "VibeGuard";
    this.statusBar.show();
  }

  dispose(): void {
    this.stopPolling();
    this.setScanRunning(false);
    this.statusBar.dispose();
  }

  resetSessionUi(): void {
    this.stopPolling();
    this.setScanRunning(false);
    this.diagnostics.clear();
    this.logs.clear();
    this.state.patch({ currentScan: null, history: [], logs: [], busy: false, error: null });
    this.syncStatusBar();
  }

  async refreshIdentityAndHistory(): Promise<void> {
    this.state.patch({
      apiUrl: getApiUrl(),
      workspaceName: workspaceName() ?? null,
    });
    try {
      await this.api.health();
      this.state.patch({ backendReachable: true, error: null });
    } catch (err) {
      this.state.patch({ backendReachable: false, error: toUserFacingError(err) });
      this.syncStatusBar();
      return;
    }

    try {
      const user = await this.auth.restore();
      this.state.patch({ user, error: null });
      if (user) {
        const history = await this.api.listScans();
        this.state.patch({ history });
      }
    } catch (err) {
      this.state.patch({ error: toUserFacingError(err) });
    }
    this.syncStatusBar();
  }

  async scanProject(): Promise<void> {
    const folder = requireWorkspace();
    await this.runScan(async () => {
      this.logs.append(`Packaging workspace "${folder.name}" (respecting .gitignore)…`);
      return zipWorkspace(folder.uri.fsPath);
    }, `workspace ${folder.name}`);
  }

  async scanCurrentFile(): Promise<void> {
    const folder = requireWorkspace();
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("Open a file in the editor to scan it.");
    }
    const filePath = editor.document.uri.fsPath;
    await this.runScan(async () => {
      this.logs.append(`Packaging current file for upload…`);
      return zipSingleFile(folder.uri.fsPath, filePath);
    }, `file ${vscode.workspace.asRelativePath(editor.document.uri)}`);
  }

  async refreshCurrentScan(): Promise<void> {
    const scan = this.state.current.currentScan;
    if (!scan) {
      const history = this.state.current.history;
      if (history.length === 0) {
        await this.refreshIdentityAndHistory();
        return;
      }
      await this.loadScan(history[0].id);
      return;
    }
    await this.loadScan(scan.id);
  }

  async loadScan(id: number, opts: { watch?: boolean } = {}): Promise<ScanReport> {
    const report = await this.api.getScan(id);
    this.applyReport(report);
    if (opts.watch !== false && (report.status === "pending" || report.status === "running")) {
      this.startPolling(id, report.status);
    } else {
      this.stopPolling();
    }
    return report;
  }

  private async runScan(buildZip: () => Promise<Buffer>, label: string): Promise<void> {
    if (this.scanInFlight || this.state.current.busy) {
      throw new Error("A VibeGuard scan is already running.");
    }
    await this.ensureAuthenticated();
    this.setScanRunning(true);
    this.stopPolling();
    this.logs.clear();
    this.diagnostics.clear();
    this.state.patch({ busy: true, error: null, currentScan: null, logs: [] });
    this.logs.append(`Scan started (${label})`);
    this.logs.notePollingOnly();
    this.syncStatusBar();

    try {
      const zip = await buildZip();
      this.logs.append("Uploading project…");
      const form = new FormData();
      const copy = new ArrayBuffer(zip.byteLength);
      new Uint8Array(copy).set(zip);
      form.append("zip_file", new Blob([copy], { type: "application/zip" }), "workspace.zip");
      const created = await this.api.createScan(form);
      this.logs.append(`Scan #${created.id} created — status: ${created.status}`);
      const report = await this.loadScan(created.id, { watch: true });
      if (report.status === "done" || report.status === "failed") {
        this.onTerminal(report);
      }
    } catch (err) {
      this.setScanRunning(false);
      const message = toUserFacingError(err);
      this.logs.append(`Scan failed to start: ${message}`);
      this.state.patch({ busy: false, error: message });
      this.syncStatusBar();
      if (err instanceof ApiError && err.status === 401) {
        await this.auth.clear();
        this.state.patch({ user: null });
        throw new Error("Your session has expired. Please sign in again.");
      }
      throw err instanceof ZipTooLargeError ? err : new Error(message);
    }
  }

  private startPolling(scanId: number, lastStatus: string): void {
    this.stopPolling();
    const generation = ++this.pollGeneration;
    this.cancelled = false;
    this.setScanRunning(true);
    const poll = async () => {
      if (this.cancelled || generation !== this.pollGeneration) {
        return;
      }
      try {
        const report = await this.api.getScan(scanId);
        if (report.status !== lastStatus) {
          this.logs.append(`Status: ${report.status}`, "status", report.status);
          lastStatus = report.status;
        }
        this.applyReport(report);
        if (report.status === "done" || report.status === "failed") {
          this.stopPolling();
          this.onTerminal(report);
          return;
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          this.stopPolling();
          this.setScanRunning(false);
          await this.auth.clear();
          this.state.patch({ user: null, busy: false, error: "Your session has expired. Please sign in again." });
          this.syncStatusBar();
          void vscode.window.showErrorMessage("Your session has expired. Please sign in again.");
          return;
        }
        this.logs.append(`Status poll failed: ${toUserFacingError(err)}`);
      }
      this.pollTimer = setTimeout(poll, getPollIntervalMs());
    };
    this.pollTimer = setTimeout(poll, getPollIntervalMs());
  }

  private stopPolling(): void {
    this.cancelled = true;
    this.pollGeneration += 1;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private applyReport(report: ScanReport): void {
    const mapped = report.status === "done" ? this.diagnostics.apply(report.findings) : { mapped: 0, skipped: 0 };
    this.state.patch({
      currentScan: report,
      logs: this.logs.history,
      busy: report.status === "pending" || report.status === "running",
      error: report.status === "failed" ? toUserFacingError(report.error ?? "Scan failed.") : this.state.current.error,
    });
    if (report.status === "done" && mapped.skipped > 0) {
      this.logs.append(
        `${mapped.mapped} findings mapped to workspace files; ${mapped.skipped} skipped (path not in this workspace).`,
      );
    }
    this.syncStatusBar();
  }

  private onTerminal(report: ScanReport): void {
    this.setScanRunning(false);
    this.state.patch({ busy: false });
    void this.api.listScans().then((history) => this.state.patch({ history })).catch(() => undefined);

    if (report.status === "failed") {
      const detail = toUserFacingError(report.error ?? "Scan failed.");
      this.logs.append(`Scan failed: ${detail}`);
      this.syncStatusBar();
      void vscode.window.showErrorMessage(detail.startsWith("VibeGuard") ? detail : `VibeGuard scan failed: ${detail}`);
      return;
    }

    const summary = summarizeFindings(report.findings);
    this.logs.append(`Scan #${report.id} complete: ${summary}`);
    if (report.error) {
      this.logs.append(`Partial scanner failure: ${report.error}`);
    }
    this.syncStatusBar();

    const counts = report.findings.reduce(
      (acc, f) => {
        const key = f.severity.toLowerCase();
        if (key === "high") acc.high += 1;
        else if (key === "medium") acc.medium += 1;
        else if (key === "critical") acc.critical += 1;
        return acc;
      },
      { critical: 0, high: 0, medium: 0 },
    );
    const headline =
      counts.critical || counts.high || counts.medium
        ? `VibeGuard scan complete: ${[
            counts.critical ? `${counts.critical} Critical` : "",
            counts.high ? `${counts.high} High` : "",
            counts.medium ? `${counts.medium} Medium` : "",
          ]
            .filter(Boolean)
            .join(", ")} findings detected.`
        : `VibeGuard scan complete: ${summary}.`;

    void vscode.window
      .showInformationMessage(headline, "Show Findings", "Problems")
      .then((choice) => {
        if (choice === "Show Findings") {
          void vscode.commands.executeCommand("vibeguard.showFindings");
        } else if (choice === "Problems") {
          void vscode.commands.executeCommand("workbench.actions.view.problems");
        }
      });
  }

  private setScanRunning(running: boolean): void {
    this.scanInFlight = running;
    void vscode.commands.executeCommand("setContext", "vibeguard.scanRunning", running);
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.auth.currentUser) {
      return;
    }
    const restored = await this.auth.restore();
    if (restored) {
      this.state.patch({ user: restored });
      return;
    }
    const go = await vscode.window.showWarningMessage(
      "Sign in to VibeGuard to start a scan.",
      "Sign In",
    );
    if (go === "Sign In") {
      await vscode.commands.executeCommand("vibeguard.login");
    }
    if (!this.auth.currentUser) {
      throw new Error("Sign in is required to create a scan.");
    }
  }

  private syncStatusBar(): void {
    const scan = this.state.current.currentScan;
    if (!this.state.current.user) {
      this.statusBar.text = "$(shield) VibeGuard: Sign in";
      this.statusBar.tooltip = "VibeGuard: Sign In";
      this.statusBar.command = "vibeguard.login";
      return;
    }
    this.statusBar.command = "vibeguard.showFindings";
    if (!scan) {
      this.statusBar.text = "$(shield) VibeGuard";
      this.statusBar.tooltip = "Scan the current project with VibeGuard";
      return;
    }
    if (scan.status === "pending" || scan.status === "running") {
      this.statusBar.text = `$(sync~spin) VibeGuard: ${scan.status}`;
      this.statusBar.tooltip = `Scan #${scan.id} is ${scan.status}`;
      return;
    }
    if (scan.status === "failed") {
      this.statusBar.text = "$(error) VibeGuard: failed";
      this.statusBar.tooltip = scan.error ?? "Scan failed";
      return;
    }
    const n = scan.findings.length;
    this.statusBar.text = `$(shield) VibeGuard: ${n} finding${n === 1 ? "" : "s"}`;
    this.statusBar.tooltip = `Security ${scan.security_score ?? "—"} · Vibe debt ${scan.vibe_debt_score ?? "—"}`;
  }
}

function requireWorkspace(): vscode.WorkspaceFolder {
  const folder = workspaceFolder();
  if (!folder) {
    throw new Error("Open a folder in VS Code to scan a project.");
  }
  return folder;
}
