import { nodeRequest, readSetCookie, type NodeResponse } from "./nodeRequest";
import { SESSION_COOKIE, type Finding, type ScanCreated, type ScanReport, type ScanSummary, type User } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type TokenProvider = () => Promise<string | undefined>;

/**
 * HTTP client for the existing VibeGuard FastAPI backend.
 * Base URL comes from `vibeguard.apiUrl` (hosted production by default).
 * Auth is cookie-based (`vibeguard_session`). Requests use Node http/https,
 * not the extension-host global fetch (Electron/Chromium), which enforces CORS
 * and fails GET /health against a backend that only allows FRONTEND_URL.
 */
export class ApiClient {
  constructor(
    private readonly getBaseUrl: () => string,
    private readonly getToken: TokenProvider,
  ) {}

  async health(): Promise<{ status: string }> {
    return this.withNetworkRetry(() => this.json("/health", { method: "GET", skipAuth: true }));
  }

  async signup(email: string, password: string): Promise<{ user: User; token: string }> {
    return this.authRequest("/auth/signup", email, password);
  }

  async login(email: string, password: string): Promise<{ user: User; token: string }> {
    return this.authRequest("/auth/login", email, password);
  }

  async logout(): Promise<void> {
    await this.request("/auth/logout", { method: "POST" });
  }

  async me(): Promise<User> {
    return this.json("/auth/me");
  }

  async createScan(form: FormData): Promise<ScanCreated> {
    return this.json("/scans", { method: "POST", body: form });
  }

  async listScans(repoKey?: string): Promise<ScanSummary[]> {
    const query = repoKey ? `?repo_key=${encodeURIComponent(repoKey)}` : "";
    return this.json(`/scans${query}`);
  }

  async getScan(id: number): Promise<ScanReport> {
    return this.json(`/scans/${id}`);
  }

  private async withNetworkRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        if (err instanceof ApiError && err.status !== 0) {
          throw err;
        }
        if (i < attempts - 1) {
          await sleep(1500 * (i + 1));
        }
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private async authRequest(path: string, email: string, password: string): Promise<{ user: User; token: string }> {
    const res = await this.request(path, {
      method: "POST",
      skipAuth: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const token = parseSessionCookie(readSetCookie(res.headers));
    if (!token) {
      throw new ApiError(res.status, "Backend did not set a vibeguard_session cookie");
    }
    const user = (await res.json()) as User;
    return { user, token };
  }

  private async json<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, init);
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  private async request(path: string, init: RequestOptions = {}): Promise<NodeResponse> {
    const { skipAuth, headers: initHeaders = {}, ...rest } = init;
    const base = this.getBaseUrl().replace(/\/+$/, "");
    const headers: Record<string, string> = { ...initHeaders };

    if (!skipAuth) {
      const token = await this.getToken();
      if (token) {
        headers.Cookie = `${SESSION_COOKIE}=${token}`;
      }
    }

    let res: NodeResponse;
    try {
      res = await nodeRequest(`${base}${path}`, { ...rest, headers });
    } catch {
      throw new ApiError(0, "VibeGuard service is temporarily unavailable. Please try again.");
    }

    if (!res.ok) {
      throw new ApiError(res.status, await readErrorMessage(res));
    }
    return res;
  }
}

type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | FormData;
  skipAuth?: boolean;
};

export function parseSessionCookie(setCookieHeaders: string[]): string | undefined {
  for (const header of setCookieHeaders) {
    for (const part of header.split(/,(?=\s*[\w-]+=)/)) {
      const pair = part.split(";")[0]?.trim() ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const name = pair.slice(0, eq).trim();
      if (name === SESSION_COOKIE) {
        return pair.slice(eq + 1).trim();
      }
    }
  }
  return undefined;
}

async function readErrorMessage(res: NodeResponse): Promise<string> {
  const body = await res.json().catch(() => ({})) as { detail?: unknown };
  const detail = body.detail;
  if (Array.isArray(detail)) {
    const joined = detail.map((item) => (item as { msg?: string })?.msg).filter(Boolean).join("; ");
    if (joined) {
      return joined;
    }
  } else if (typeof detail === "string" && detail) {
    return detail;
  }
    if (res.status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  return `HTTP ${res.status}`;
}

export function countBySeverity(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) {
    const key = finding.severity.toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function summarizeFindings(findings: Finding[]): string {
  const counts = countBySeverity(findings);
  const parts: string[] = [];
  for (const sev of ["critical", "high", "medium", "low", "info"] as const) {
    if (counts[sev]) {
      parts.push(`${counts[sev]} ${capitalize(sev)}`);
    }
  }
  if (parts.length === 0) {
    return "no findings";
  }
  return `${parts.join(", ")} findings detected`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
