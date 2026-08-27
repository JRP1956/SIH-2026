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
  let body = init.body;
  const headers: Record<string, string> = {
    "User-Agent": "VibeGuard-VSCode/1.0.0",
    Accept: "application/json, */*",
    ...init.headers,
  };

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const encoded = await encodeFormData(body);
    body = encoded.body;
    headers["Content-Type"] = encoded.contentType;
  } else if (typeof body === "string" && !headerHas(headers, "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  if (Buffer.isBuffer(body) || typeof body === "string") {
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }

  const payload = typeof body === "string" ? Buffer.from(body) : body instanceof Buffer ? body : undefined;
  const { status, headers: resHeaders, buffer, finalUrl } = await rawRequest(url, method, headers, payload, init.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (status >= 300 && status < 400 && resHeaders.location && redirects < MAX_REDIRECTS) {
    const next = new URL(String(resHeaders.location), finalUrl).toString();
    const redirectMethod = status === 307 || status === 308 ? method : "GET";
    const redirectBody = redirectMethod === "GET" ? undefined : payload;
    return nodeRequest(next, { ...init, method: redirectMethod, body: redirectBody }, redirects + 1);
  }

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: resHeaders,
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
