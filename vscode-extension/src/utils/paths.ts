import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { sanitizeInsideRoot } from "./pathSafety";

function firstExisting(root: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const abs = sanitizeInsideRoot(root, candidate);
    if (abs && fs.existsSync(abs)) {
      return abs;
    }
  }
  return undefined;
}

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
    // Exact path first, then the bare filename: findings from a zip upload can
    // carry a prefix the local checkout does not have.
    const hit = firstExisting(root.uri.fsPath, [cleaned, path.basename(cleaned)]);
    if (hit) {
      return vscode.Uri.file(hit);
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
