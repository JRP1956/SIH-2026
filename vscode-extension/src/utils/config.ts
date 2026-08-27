import * as vscode from "vscode";

/** Hosted production API. This is the default for `vibeguard.apiUrl`. */
export const DEFAULT_API_URL = "https://sih-2026-production-63e7.up.railway.app";

/** Optional local-development override. Used only if the user sets `vibeguard.apiUrl`. */
export const LOCAL_DEV_API_URL = "http://localhost:8000";

export function getPollIntervalMs(): number {
  const value = vscode.workspace.getConfiguration("vibeguard").get<number>("pollIntervalMs", 3000);
  return Number.isFinite(value) && value >= 1000 ? value : 3000;
}

export function getApiUrl(): string {
  const raw = vscode.workspace.getConfiguration("vibeguard").get<string>("apiUrl", DEFAULT_API_URL);
  return (raw || DEFAULT_API_URL).replace(/\/+$/, "");
}

export async function setApiUrl(url: string): Promise<void> {
  const cleaned = url.trim().replace(/\/+$/, "");
  await vscode.workspace.getConfiguration("vibeguard").update(
    "apiUrl",
    cleaned,
    vscode.ConfigurationTarget.Global,
  );
}
