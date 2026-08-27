import * as vscode from "vscode";
import type { Finding } from "../api/types";
import { asSeverity, toDiagnosticSeverity } from "../utils/severity";
import { resolveFindingUri, workspaceFolder } from "../utils/paths";

const COLLECTION_NAME = "VibeGuard";

export class FindingDiagnostics {
  private readonly collection: vscode.DiagnosticCollection;
  private findings: Finding[] = [];

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
  }

  dispose(): void {
    this.collection.dispose();
  }

  clear(): void {
    this.findings = [];
    this.collection.clear();
  }

  apply(findings: Finding[]): { mapped: number; skipped: number } {
    this.findings = findings;
    this.collection.clear();

    const byFile = new Map<string, vscode.Diagnostic[]>();
    let mapped = 0;
    let skipped = 0;
    const folder = workspaceFolder();

    for (const finding of findings) {
      const uri = resolveFindingUri(finding.file, folder);
      if (!uri) {
        skipped += 1;
        continue;
      }
      const diagnostic = toDiagnostic(finding);
      const list = byFile.get(uri.toString()) ?? [];
      list.push(diagnostic);
      byFile.set(uri.toString(), list);
      mapped += 1;
    }

    for (const [uriString, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.parse(uriString), diagnostics);
    }
    return { mapped, skipped };
  }

  findingsAt(uri: vscode.Uri, line: number): Finding[] {
    const folder = workspaceFolder();
    return this.findings.filter((finding) => {
      const found = resolveFindingUri(finding.file, folder);
      if (!found || found.toString() !== uri.toString()) {
        return false;
      }
      const target = Math.max(0, (finding.line || 1) - 1);
      return target === line;
    });
  }
}

function toDiagnostic(finding: Finding): vscode.Diagnostic {
  const line = Math.max(0, (finding.line || 1) - 1);
  const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
  const severityLabel = asSeverity(finding.severity).toUpperCase();
  const message = `[${severityLabel} · ${finding.category}] ${finding.message}`;
  const diagnostic = new vscode.Diagnostic(range, message, toDiagnosticSeverity(finding.severity));
  diagnostic.source = COLLECTION_NAME;
  diagnostic.code = finding.tool;
  return diagnostic;
}
