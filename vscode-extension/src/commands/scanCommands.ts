import * as vscode from "vscode";
import { DEFAULT_API_URL, LOCAL_DEV_API_URL, setApiUrl } from "../utils/config";
import { toUserFacingError } from "../utils/userFacing";
import { resolveFindingUri, workspaceFolder } from "../utils/paths";
import type { AuthService } from "../services/authService";
import type { ScanService } from "../services/scanService";
import type { AppState } from "../services/state";
import { FindingDetailPanel } from "../views/findingDetailPanel";
import { ScanConsolePanel } from "../views/scanConsole";
import type { ScanLogService } from "../services/scanLogService";

export function registerCommands(
  context: vscode.ExtensionContext,
  deps: {
    auth: AuthService;
    scans: ScanService;
    state: AppState;
    logs: ScanLogService;
  },
): void {
  const { auth, scans, state, logs } = deps;

  context.subscriptions.push(
    vscode.commands.registerCommand("vibeguard.scanProject", async () => {
      if (!vscode.workspace.workspaceFolders?.length) {
        void vscode.window.showWarningMessage("Open a folder in VS Code to scan a project.");
        return;
      }
      await run("Scanning project…", () => scans.scanProject());
    }),
    vscode.commands.registerCommand("vibeguard.scanCurrentFile", async () => {
      if (!vscode.workspace.workspaceFolders?.length) {
        void vscode.window.showWarningMessage("Open a folder in VS Code to scan a file.");
        return;
      }
      await run("Scanning current file…", () => scans.scanCurrentFile());
    }),
    vscode.commands.registerCommand("vibeguard.showFindings", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.vibeguard");
      const scan = state.current.currentScan;
      if (!scan?.findings.length) {
        void vscode.window.showInformationMessage("No VibeGuard findings yet. Run a scan first.");
        return;
      }
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    }),
    vscode.commands.registerCommand("vibeguard.showScanConsole", () => {
      ScanConsolePanel.show(context, logs);
    }),
    vscode.commands.registerCommand("vibeguard.refreshScanStatus", async () => {
      await run("Refreshing scan status…", () => scans.refreshCurrentScan());
    }),
    vscode.commands.registerCommand("vibeguard.loadScan", async (id: number) => {
      await run("Loading scan…", async () => {
        await scans.loadScan(id);
      });
    }),
    vscode.commands.registerCommand("vibeguard.login", async () => {
      const creds = await promptCredentials("Sign in to VibeGuard");
      if (!creds) {
        return;
      }
      await run("Signing in…", async () => {
        await auth.login(creds.email, creds.password);
        state.patch({ user: auth.currentUser, error: null });
        await scans.refreshIdentityAndHistory();
        void vscode.window.showInformationMessage(`Signed in as ${auth.currentUser?.email}`);
      });
    }),
    vscode.commands.registerCommand("vibeguard.signup", async () => {
      const creds = await promptCredentials("Create a VibeGuard account", true);
      if (!creds) {
        return;
      }
      await run("Creating account…", async () => {
        await auth.signup(creds.email, creds.password);
        state.patch({ user: auth.currentUser, error: null });
        await scans.refreshIdentityAndHistory();
        void vscode.window.showInformationMessage(`Account created for ${auth.currentUser?.email}`);
      });
    }),
    vscode.commands.registerCommand("vibeguard.logout", async () => {
      await auth.logout();
      scans.resetSessionUi();
      state.patch({ user: null });
      void vscode.window.showInformationMessage("Signed out of VibeGuard.");
    }),
    vscode.commands.registerCommand("vibeguard.setApiUrl", async () => {
      const current = vscode.workspace.getConfiguration("vibeguard").get<string>("apiUrl", DEFAULT_API_URL);
      const value = await vscode.window.showInputBox({
        title: "VibeGuard backend URL",
        prompt: `Hosted default: ${DEFAULT_API_URL}. Optional local override: ${LOCAL_DEV_API_URL}`,
        placeHolder: DEFAULT_API_URL,
        value: current || DEFAULT_API_URL,
        validateInput: (text) => {
          try {
            const url = new URL(text.trim());
            if (url.protocol !== "http:" && url.protocol !== "https:") {
              return "Use http:// or https://";
            }
            return undefined;
          } catch {
            return `Enter a valid URL, e.g. ${DEFAULT_API_URL}`;
          }
        },
      });
      if (!value) {
        return;
      }
      await setApiUrl(value);
      state.patch({ apiUrl: value.replace(/\/+$/, "") });
      await scans.refreshIdentityAndHistory();
    }),
    vscode.commands.registerCommand("vibeguard.openFinding", async (id: number) => {
      const finding = state.findingById(id);
      if (!finding) {
        void vscode.window.showWarningMessage("Finding is no longer in the current scan.");
        return;
      }
      FindingDetailPanel.show(context, finding, state.current.currentScan ?? undefined);
    }),
    vscode.commands.registerCommand("vibeguard.openInEditor", async (file?: string, line?: number) => {
      if (!file) {
        return;
      }
      const uri = resolveFindingUri(file, workspaceFolder());
      if (!uri) {
        void vscode.window.showWarningMessage(`Could not find ${file} in the opened workspace.`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const lastLine = Math.max(0, doc.lineCount - 1);
      const requested = Number.isFinite(line) ? Number(line) : 1;
      const row = Math.min(lastLine, Math.max(0, (requested > 0 ? requested : 1) - 1));
      const pos = new vscode.Position(row, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }),
  );
}

async function promptCredentials(
  title: string,
  signup = false,
): Promise<{ email: string; password: string } | undefined> {
  const email = await vscode.window.showInputBox({
    title,
    prompt: "Email",
    placeHolder: "you@example.com",
    ignoreFocusOut: true,
    validateInput: (text) => (text.includes("@") ? undefined : "Enter a valid email"),
  });
  if (!email) {
    return undefined;
  }
  const password = await vscode.window.showInputBox({
    title,
    prompt: signup ? "Password (min 8 characters)" : "Password",
    password: true,
    ignoreFocusOut: true,
    validateInput: (text) => (text.length >= 8 ? undefined : "Password must be at least 8 characters"),
  });
  if (!password) {
    return undefined;
  }
  return { email, password };
}

async function run(title: string, task: () => Promise<void>): Promise<void> {
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
  } catch (err) {
    const message = toUserFacingError(err);
    void vscode.window.showErrorMessage(message.startsWith("VibeGuard") ? message : `VibeGuard: ${message}`);
  }
}
