import type { Severity } from "../api/types";
import * as vscode from "vscode";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#c83d3d",
  high: "#d96b35",
  medium: "#b88418",
  low: "#3e7cb1",
  info: "#6d7680",
};

export function asSeverity(value: string): Severity {
  const lower = value.toLowerCase() as Severity;
  return SEVERITY_ORDER.includes(lower) ? lower : "medium";
}

/** Critical/High are Errors so they dominate the Problems panel vs Medium/Low. */
export function toDiagnosticSeverity(severity: string): vscode.DiagnosticSeverity {
  switch (asSeverity(severity)) {
    case "critical":
    case "high":
      return vscode.DiagnosticSeverity.Error;
    case "medium":
      return vscode.DiagnosticSeverity.Warning;
    case "low":
      return vscode.DiagnosticSeverity.Information;
    case "info":
    default:
      return vscode.DiagnosticSeverity.Hint;
  }
}

export function scoreTone(score: number | null): { qualifier: string; color: string } {
  if (score === null) {
    return { qualifier: "Not available", color: "#8a938c" };
  }
  if (score >= 80) {
    return { qualifier: "Healthy", color: "#16794a" };
  }
  if (score >= 60) {
    return { qualifier: "Moderate", color: "#16794a" };
  }
  if (score >= 40) {
    return { qualifier: "At risk", color: "#b88418" };
  }
  return { qualifier: "Critical", color: "#c83d3d" };
}

export function vibeDebtTone(score: number | null): { qualifier: string; color: string } {
  if (score === null) {
    return { qualifier: "Not available", color: "#8a938c" };
  }
  if (score <= 20) {
    return { qualifier: "Low technical risk", color: "#16794a" };
  }
  if (score <= 40) {
    return { qualifier: "Moderate", color: "#3e7cb1" };
  }
  if (score <= 60) {
    return { qualifier: "Elevated", color: "#b88418" };
  }
  return { qualifier: "High technical debt", color: "#c83d3d" };
}

export function statusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "done":
      return "Complete";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}
