import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

export type NodeRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | FormData;
  timeoutMs?: number;
};

export type NodeResponse = {
  status: number;
  ok: boolean;
  headers: http.IncomingHttpHeaders;
  url: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

/**
 * Node http/https request. Do not use the extension-host global `fetch`:
 * Cursor/VS Code expose Electron's Chromium fetch, which enforces CORS.
 * The FastAPI backend only allows FRONTEND_URL, so Chromium fetch throws
 * "Failed to fetch" on GET /health even when the server returned 200.
 */
export async function nodeRequest(url: string, init: NodeRequestInit = {}, redirects = 0): Promise<NodeResponse> {
  const method = (init.method ?? "GET").toUpperCase();
  const { headers, payload } = await prepareRequest(init);
  const { status, headers: resHeaders, buffer, finalUrl } =
    await rawRequest(url, method, headers, payload, init.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const next = redirectTarget(status, resHeaders, finalUrl, redirects);
  if (next) {
    // 307/308 keep the original method and body; everything else degrades to GET.
    const redirectMethod = status === 307 || status === 308 ? method : "GET";
    const redirectBody = redirectMethod === "GET" ? undefined : payload;
    return nodeRequest(next, { ...init, method: redirectMethod, body: redirectBody }, redirects + 1);
  }

  return buildResponse(status, resHeaders, buffer, finalUrl);
}

/** Normalize headers and body into what rawRequest needs. */
async function prepareRequest(
  init: NodeRequestInit,
): Promise<{ headers: Record<string, string>; payload: Buffer | undefined }> {
  const headers: Record<string, string> = {
    "User-Agent": "VibeGuard-VSCode/1.0.0",
    Accept: "application/json, */*",
    ...init.headers,
  };

  let body = init.body;
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const encoded = await encodeFormData(body);
    body = encoded.body;
    headers["Content-Type"] = encoded.contentType;
  } else if (typeof body === "string" && !headerHas(headers, "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  const payload = typeof body === "string" ? Buffer.from(body) : toBuffer(body);
  if (payload) {
    headers["Content-Length"] = String(payload.byteLength);
  }
  return { headers, payload };
}

function toBuffer(body: unknown): Buffer | undefined {
  return Buffer.isBuffer(body) ? body : undefined;
}

function redirectTarget(
  status: number,
  headers: http.IncomingHttpHeaders,
  finalUrl: string,
  redirects: number,
): string | undefined {
  const redirecting = status >= 300 && status < 400 && Boolean(headers.location);
  if (!redirecting || redirects >= MAX_REDIRECTS) {
    return undefined;
  }
  return new URL(String(headers.location), finalUrl).toString();
}

function buildResponse(
  status: number,
  headers: http.IncomingHttpHeaders,
  buffer: Buffer,
  finalUrl: string,
): NodeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    url: finalUrl,
    async text() {
      return buffer.toString("utf8");
    },
    async json() {
      const text = buffer.toString("utf8");
      return text ? JSON.parse(text) : {};
    },
  };
}

function rawRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  timeoutMs: number,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; buffer: Buffer; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            buffer: Buffer.concat(chunks),
            finalUrl: url,
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${method} ${url}`));
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

export function readSetCookie(headers: http.IncomingHttpHeaders): string[] {
  const raw = headers["set-cookie"];
  if (!raw) {
    return [];
  }
  return Array.isArray(raw) ? raw : [raw];
}

function headerHas(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

async function encodeFormData(form: FormData): Promise<{ body: Buffer; contentType: string }> {
  const boundary = `----VibeGuardForm${Date.now().toString(16)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ));
      continue;
    }
    const filename = "name" in value && value.name ? value.name : "upload.bin";
    const type = value.type || "application/octet-stream";
    const data = Buffer.from(await value.arrayBuffer());
    parts.push(Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      data,
      Buffer.from("\r\n"),
    ]));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
