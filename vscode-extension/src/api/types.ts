/** Types matching backend ScanSummary / FindingOut / ScanReport and auth UserOut. */

export type User = { id: number; email: string };

export type ScanStatus = "pending" | "running" | "done" | "failed";
export type ScanMode = "full" | "diff";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "security" | "vibe-debt" | "license" | "drift";

export type ScanSummary = {
  id: number;
  repo_key: string;
  mode: ScanMode | string;
  status: ScanStatus | string;
  security_score: number | null;
  vibe_debt_score: number | null;
  created_at: string;
};

export type Finding = {
  id: number;
  tool: string;
  severity: Severity | string;
  category: Category | string;
  file: string;
  line: number;
  message: string;
  license_id: string | null;
  ai_explanation: string | null;
  ai_fix: string | null;
};

export type ScanReport = ScanSummary & {
  ai_available: boolean;
  error: string | null;
  findings: Finding[];
};

export type ScanCreated = {
  id: number;
  status: string;
};

export const SESSION_COOKIE = "vibeguard_session";
