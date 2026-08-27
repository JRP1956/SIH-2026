import type { Finding, ScanReport, ScanSummary, User } from "../api/types";
import { DEFAULT_API_URL } from "../utils/config";
import type { ScanLogEvent } from "./scanLogService";

export type AppStateSnapshot = {
  user: User | null;
  workspaceName: string | null;
  apiUrl: string;
  currentScan: ScanReport | null;
  history: ScanSummary[];
  logs: ScanLogEvent[];
  busy: boolean;
  error: string | null;
  backendReachable: boolean | null;
};

type Listener = () => void;

export class AppState {
  private snapshot: AppStateSnapshot = {
    user: null,
    workspaceName: null,
    apiUrl: DEFAULT_API_URL,
    currentScan: null,
    history: [],
    logs: [],
    busy: false,
    error: null,
    backendReachable: null,
  };

  private readonly listeners = new Set<Listener>();

  get current(): AppStateSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  patch(partial: Partial<AppStateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) {
      listener();
    }
  }

  findingById(id: number): Finding | undefined {
    return this.snapshot.currentScan?.findings.find((f) => f.id === id);
  }
}
