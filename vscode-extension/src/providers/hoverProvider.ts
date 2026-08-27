import * as vscode from "vscode";
import type { Finding } from "../api/types";
import { asSeverity, SEVERITY_LABEL } from "../utils/severity";
import type { FindingDiagnostics } from "../diagnostics/findingDiagnostics";

export class FindingHoverProvider implements vscode.HoverProvider {
  constructor(private readonly diagnostics: FindingDiagnostics) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const findings = this.diagnostics.findingsAt(document.uri, position.line);
    if (findings.length === 0) {
      return undefined;
    }
    const markdown = findings.map(toHoverMarkdown);
    return new vscode.Hover(markdown);
  }
}

export function toHoverMarkdown(finding: Finding): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  md.supportHtml = false;

  const severity = SEVERITY_LABEL[asSeverity(finding.severity)];
  const lines = [
    "**VibeGuard Finding**",
    "",
    `**Severity:** ${severity}`,
    `**Category:** ${finding.category}`,
    `**Scanner:** ${finding.tool}`,
    finding.file ? `**Location:** \`${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}\`` : "",
    "",
    "**What was detected:**",
    finding.message,
  ];

  if (finding.ai_explanation) {
    lines.push("", "**AI Explanation:**", finding.ai_explanation);
  }
  if (finding.ai_fix) {
    lines.push("", "**Recommended Solution:**", finding.ai_fix);
  }
  if (finding.license_id) {
    lines.push("", `**License:** ${finding.license_id}`);
  }

  md.appendMarkdown(lines.filter((line) => line !== undefined).join("\n"));
  return md;
}
