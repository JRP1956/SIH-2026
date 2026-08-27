import * as vscode from "vscode";
import { ApiClient } from "./api/client";
import { registerCommands } from "./commands/scanCommands";
import { FindingDiagnostics } from "./diagnostics/findingDiagnostics";
import { FindingHoverProvider } from "./providers/hoverProvider";
import { FindingsTreeProvider } from "./providers/findingsProvider";
import { SidebarProvider } from "./providers/sidebarProvider";
import { AuthService } from "./services/authService";
import { ScanLogService } from "./services/scanLogService";
import { ScanService } from "./services/scanService";
import { AppState } from "./services/state";
import { getApiUrl } from "./utils/config";
import { workspaceName } from "./utils/paths";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("VibeGuard Scan Console");
  const logs = new ScanLogService(output);
  const state = new AppState();
  state.patch({ apiUrl: getApiUrl(), workspaceName: workspaceName() ?? null });

  let auth: AuthService;
  const api = new ApiClient(getApiUrl, () => auth.getToken());
  auth = new AuthService(context, api);
  const diagnostics = new FindingDiagnostics();
  const scans = new ScanService(api, auth, logs, state, diagnostics);
  const sidebar = new SidebarProvider(context, state);
  const findingsTree = new FindingsTreeProvider(state);

  context.subscriptions.push(
    output,
    logs,
    auth,
    diagnostics,
    scans,
    sidebar,
    findingsTree,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar),
    vscode.window.registerTreeDataProvider("vibeguard.findings", findingsTree),
    vscode.languages.registerHoverProvider({ scheme: "file" }, new FindingHoverProvider(diagnostics)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vibeguard.apiUrl")) {
        state.patch({ apiUrl: getApiUrl() });
        void scans.refreshIdentityAndHistory();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      state.patch({ workspaceName: workspaceName() ?? null });
    }),
  );

  context.subscriptions.push(logs.onDidAppend(() => state.patch({ logs: logs.history })));
  registerCommands(context, { auth, scans, state, logs });
  context.subscriptions.push(auth.onDidChange((user) => state.patch({ user })));
  void scans.refreshIdentityAndHistory();
}

export function deactivate(): void {
  // Disposables registered on the extension context are cleaned up automatically.
}
