import * as vscode from "vscode";
import type { Finding } from "../api/types";
import { asSeverity, SEVERITY_LABEL, SEVERITY_ORDER } from "../utils/severity";
import type { AppState } from "../services/state";

export class FindingsTreeProvider implements vscode.TreeDataProvider<FindingsTreeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<FindingsTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly unsubscribe: () => void;

  constructor(private readonly state: AppState) {
    this.unsubscribe = state.subscribe(() => this.emitter.fire(undefined));
  }

  dispose(): void {
    this.unsubscribe();
    this.emitter.dispose();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: FindingsTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FindingsTreeItem): FindingsTreeItem[] {
    const findings = this.state.current.currentScan?.findings ?? [];
    if (!element) {
      if (findings.length === 0) {
        return [];
      }
      return SEVERITY_ORDER
        .map((sev) => {
          const items = findings.filter((f) => asSeverity(f.severity) === sev);
          return items.length ? new SeverityGroupItem(sev, items.length) : undefined;
        })
        .filter((item): item is SeverityGroupItem => item !== undefined);
    }
    if (element instanceof SeverityGroupItem) {
      const items = findings.filter((f) => asSeverity(f.severity) === element.severity);
      return items.map((f) => new FindingItem(f));
    }
    return [];
  }
}

export type FindingsTreeItem = SeverityGroupItem | FindingItem;

export class SeverityGroupItem extends vscode.TreeItem {
  constructor(
    readonly severity: ReturnType<typeof asSeverity>,
    count: number,
  ) {
    super(`${SEVERITY_LABEL[severity]} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "vibeguard.severity";
    this.iconPath = new vscode.ThemeIcon(
      severity === "critical" || severity === "high"
        ? "error"
        : severity === "medium"
          ? "warning"
          : "info",
    );
  }
}

export class FindingItem extends vscode.TreeItem {
  constructor(readonly finding: Finding) {
    const loc = finding.file
      ? `${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}`
      : finding.tool;
    super(finding.message, vscode.TreeItemCollapsibleState.None);
    this.description = loc;
    this.tooltip = `${finding.severity.toUpperCase()} · ${finding.category}\n${finding.message}\n${loc}`;
    this.contextValue = "vibeguard.finding";
    this.iconPath = new vscode.ThemeIcon("bug");
    this.command = {
      command: "vibeguard.openFinding",
      title: "Open Finding Details",
      arguments: [finding.id],
    };
  }
}
