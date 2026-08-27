// Containment check for sanitizeInsideRoot: node scripts/check-path-safety.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { sanitizeInsideRoot } from "../src/utils/pathSafety.ts";

const root = path.resolve("/tmp/workspace");

assert.equal(sanitizeInsideRoot(root, "src/app.ts"), path.join(root, "src/app.ts"));
assert.equal(sanitizeInsideRoot(root, "src\\app.ts"), path.join(root, "src/app.ts"));

for (const escape of ["../secrets.env", "src/../../etc/passwd", "..", "", "a/../..", root]) {
  assert.equal(sanitizeInsideRoot(root, escape), undefined, `escaped with: ${escape}`);
}
assert.equal(sanitizeInsideRoot(root, "/etc/passwd"), undefined);
// A name that merely starts with ".." is a normal file, not traversal.
assert.equal(sanitizeInsideRoot(root, "..hidden"), path.join(root, "..hidden"));

console.log("path safety: ok");
