import * as vscode from "vscode";
import { formatClock } from "../utils/html";

export type LogSource = "status" | "stream";

export type ScanLogEvent = {
  timestamp: Date;
  source: LogSource;
  message: string;
  status?: string;
};

/**
 * Scan console events.
 *
 * Today the backend only exposes status via GET /scans/{id} and GET /scans/{id}/status.
 * There is no WebSocket/SSE log stream. This service records real status transitions
 * from polling. `source: "stream"` is reserved if a backend log stream is added later.
 */
export class ScanLogService implements vscode.Disposable {
  private events: ScanLogEvent[] = [];
  private readonly emitter = new vscode.EventEmitter<ScanLogEvent>();
  readonly onDidAppend = this.emitter.event;
  readonly channel: vscode.OutputChannel;

  constructor(channel: vscode.OutputChannel) {
    this.channel = channel;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  get history(): ScanLogEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
    this.channel.clear();
  }

  show(): void {
    this.channel.show(true);
  }

  append(message: string, source: LogSource = "status", status?: string): ScanLogEvent {
    const event: ScanLogEvent = { timestamp: new Date(), source, message, status };
    this.events.push(event);
    const prefix = source === "stream" ? "stream" : "status";
    this.channel.appendLine(`[${formatClock(event.timestamp)}] [${prefix}] ${message}`);
    this.emitter.fire(event);
    return event;
  }

  notePollingOnly(): void {
    this.append(
      "Backend does not stream scanner logs. Showing status from GET /scans/{id}.",
      "status",
    );
  }
}
