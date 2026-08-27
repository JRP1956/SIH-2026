import type { User } from "@/lib/api";

/**
 * User type has only `{ id, email }` today. We defensively accept the possibility
 * of extra fields (name, github_login, avatar_url) so this helper doesn't need to
 * change if the backend contract grows later — but we do NOT rely on them existing.
 */
type ExtendedUser = User & {
  name?: string | null;
  full_name?: string | null;
  display_name?: string | null;
  github_login?: string | null;
  github_name?: string | null;
  avatar_url?: string | null;
};

function titleCase(part: string): string {
  if (!part) return part;
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

/**
 * Turn "neel.parikh" / "neel-parikh" / "neel_parikh42" into "Neel".
 * Returns null if we cannot derive anything sensible.
 */
function nameFromLocalPart(local: string): string | null {
  const cleaned = local.replace(/\d+$/, "");
  const first = cleaned.split(/[._-]/)[0];
  if (!first) return null;
  const stripped = first.replace(/[^a-zA-Z]/g, "");
  if (!stripped) return null;
  return titleCase(stripped);
}

/** First whitespace-separated word of a value, or null if there is none. */
function firstWord(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.split(/\s+/)[0] : null;
}

function explicitName(u: ExtendedUser): string | null {
  return firstWord(u.display_name ?? u.full_name ?? u.name);
}

function githubName(u: ExtendedUser): string | null {
  const word = firstWord(u.github_name ?? u.github_login);
  return word ? titleCase(word) : null;
}

function emailName(u: ExtendedUser): string | null {
  const email = u.email ?? "";
  const at = email.indexOf("@");
  return nameFromLocalPart(at > 0 ? email.slice(0, at) : email);
}

/**
 * Resolve a friendly display name for the authenticated user, in priority order:
 *   1. explicit display_name / full_name / name
 *   2. github_name / github_login
 *   3. derived from the local part of the email
 *   4. "there" as a final fallback so greetings never break
 */
export function displayName(user: User | null | undefined): string {
  if (!user) return "there";
  const u = user as ExtendedUser;
  return explicitName(u) ?? githubName(u) ?? emailName(u) ?? "there";
}

/** One or two-letter avatar initials derived from the resolved display name. */
export function initials(user: User | null | undefined): string {
  const name = displayName(user);
  if (name === "there") return "·";
  const parts = name.split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2
      ? parts[0][0] + parts[1][0]
      : parts[0].slice(0, 1);
  return letters.toUpperCase();
}

/** Optional avatar URL if the backend already provides one. */
export function avatarUrl(user: User | null | undefined): string | null {
  if (!user) return null;
  const u = user as ExtendedUser;
  return u.avatar_url && u.avatar_url.trim() ? u.avatar_url : null;
}

/** Time-aware greeting using the browser's local time. */
export function timeGreeting(date: Date = new Date()): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  return "Good evening";
}
