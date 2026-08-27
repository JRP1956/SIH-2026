import * as fs from "fs/promises";
import * as path from "path";
import ignore from "ignore";
import JSZip from "jszip";

import { sanitizeInsideRoot } from "../utils/pathSafety";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const DEFAULT_IGNORE = [
  ".git/",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  "coverage/",
  ".turbo/",
  ".cache/",
  ".vscode-test/",
  "*.vsix",
  "*.pyc",
  "*.pyo",
  "*.egg-info/",
  ".DS_Store",
  "*.log",
  ".env",
  ".env.*",
  "!.env.example",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_rsa.pub",
  "credentials.json",
  "secrets.json",
  "*.p12",
  "*.pfx",
];

export class ZipTooLargeError extends Error {
  constructor(public bytes: number) {
    super(
      `Workspace archive is ${(bytes / (1024 * 1024)).toFixed(1)} MB, over the backend 50 MB upload limit. ` +
        "Check .gitignore or scan a smaller subset.",
    );
    this.name = "ZipTooLargeError";
  }
}

export async function zipWorkspace(root: string): Promise<Buffer> {
  const files = await collectFiles(root);
  return zipFiles(root, files);
}

export async function zipSingleFile(root: string, absFile: string): Promise<Buffer> {
  const rel = path.relative(root, absFile).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("The current file is not inside the opened workspace.");
  }
  const ig = await loadIgnore(root);
  if (ig.ignores(rel)) {
    throw new Error("The current file is ignored (.gitignore or a secret/build path) and will not be uploaded.");
  }
  return zipFiles(root, [rel]);
}

async function zipFiles(root: string, relPaths: string[]): Promise<Buffer> {
  const zip = new JSZip();
  let total = 0;

  for (const rel of relPaths) {
    const abs = sanitizeInsideRoot(root, rel);
    if (!abs) {
      continue;
    }
    const stat = await fs.stat(abs).catch(() => undefined);
    if (!stat?.isFile()) {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      continue;
    }
    total += stat.size;
    if (total > MAX_ARCHIVE_BYTES) {
      throw new ZipTooLargeError(total);
    }
    const data = await fs.readFile(abs);
    zip.file(rel.split(path.sep).join("/"), data);
  }

  if (Object.keys(zip.files).length === 0) {
    throw new Error("Nothing to scan: no eligible source files were found.");
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new ZipTooLargeError(buffer.byteLength);
  }
  return buffer;
}

async function collectFiles(root: string): Promise<string[]> {
  const ig = await loadIgnore(root);
  const files: string[] = [];
  await walk(root, root, ig, files);
  return files;
}

async function loadIgnore(root: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore().add(DEFAULT_IGNORE);
  const gitignore = await readText(sanitizeInsideRoot(root, ".gitignore"));
  if (gitignore) {
    ig.add(gitignore);
  }
  const extra = await readText(sanitizeInsideRoot(root, ".git/info/exclude"));
  if (extra) {
    ig.add(extra);
  }
  return ig;
}

async function walk(
  dir: string,
  root: string,
  ig: ReturnType<typeof ignore>,
  acc: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const abs = sanitizeInsideRoot(dir, entry.name);
    if (!abs) {
      continue;
    }
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const ignorePath = entry.isDirectory() ? `${rel}/` : rel;
    if (ig.ignores(ignorePath) || ig.ignores(rel)) {
      continue;
    }
    if (entry.isDirectory()) {
      await walk(abs, root, ig, acc);
    } else if (entry.isFile()) {
      acc.push(rel);
    }
  }
}

async function readText(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}
