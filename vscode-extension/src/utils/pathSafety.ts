import * as path from "path";

/**
 * Join a relative path onto a trusted root, refusing anything that escapes it.
 * Returns undefined for absolute paths, `..` segments, or any result that lands
 * outside `root` — the one place path containment is decided.
 */
export function sanitizeInsideRoot(root: string, relative: string): string | undefined {
  const cleaned = relative.replace(/\\/g, "/");
  if (!cleaned || path.isAbsolute(cleaned) || cleaned.split("/").indexOf("..") >= 0) {
    return undefined;
  }
  const candidate = path.join(root, cleaned);
  const back = path.relative(root, candidate);
  if (back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    return undefined;
  }
  return candidate;
}
