import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Resolve a backend finding path against the opened workspace folder. */
export function resolveFindingUri(file: string, folder?: vscode.WorkspaceFolder): vscode.Uri | undefined {
  const cleaned = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned) {
    return undefined;
  }

  if (path.isAbsolute(file) && fs.existsSync(file)) {
    return vscode.Uri.file(file);
  }

  const folders = folder ? [folder] : vscode.workspace.workspaceFolders ?? [];
  for (const root of folders) {
    const candidate = path.join(root.uri.fsPath, cleaned);
    if (fs.existsSync(candidate)) {
      return vscode.Uri.file(candidate);
    }

    const base = path.basename(cleaned);
    if (base && base !== cleaned) {
      const nested = path.join(root.uri.fsPath, base);
      if (fs.existsSync(nested)) {
        return vscode.Uri.file(nested);
      }
    }
  }
  return undefined;
}

export function workspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

export function workspaceName(): string | undefined {
  const folder = workspaceFolder();
  return folder?.name ?? vscode.workspace.name;
}
