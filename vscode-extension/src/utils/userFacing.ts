const SERVICE_UNAVAILABLE = "VibeGuard service is temporarily unavailable. Please try again.";
const SESSION_EXPIRED = "Your session has expired. Please sign in again.";

/**
 * Map internal/network errors to copy that is safe for the Marketplace UI.
 * Never includes API hosts, localhost, or raw HTTP URLs.
 */
export function toUserFacingError(err: unknown): string {
  const status = errorStatus(err);
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const lower = raw.toLowerCase();

  if (status === 401 || /session expired|not authenticated|invalid session|http 401/.test(lower)) {
    return SESSION_EXPIRED;
  }

  if (
    status === 0 ||
    (status !== undefined && status >= 500) ||
    /could not reach|econnrefused|enotfound|etimedout|timed out|failed to fetch|temporarily unavailable|railway\.app|localhost|127\.0\.0\.1/.test(
      lower,
    ) ||
    /https?:\/\//i.test(raw)
  ) {
    return SERVICE_UNAVAILABLE;
  }

  const stripped = raw.replace(/https?:\/\/[^\s]+/gi, "").replace(/\s{2,}/g, " ").trim();
  return stripped || SERVICE_UNAVAILABLE;
}

/** Keep ordinary status text; rewrite lines that leak hosts or URLs. */
export function sanitizeUserText(message: string): string {
  if (/could not reach|localhost|railway\.app|127\.0\.0\.1|https?:\/\//i.test(message)) {
    return toUserFacingError(message);
  }
  return message;
}

function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const value = (err as { status: unknown }).status;
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}
