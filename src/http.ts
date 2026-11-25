export class ScrapeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(code: string, retryable = false, retryAfterSeconds?: number) {
    super(code);
    this.name = "ScrapeError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export async function readJson<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") || "0");
  if (length > 128_000) throw new ScrapeError("REQUEST_TOO_LARGE");
  const text = await request.text();
  if (text.length > 128_000) throw new ScrapeError("REQUEST_TOO_LARGE");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ScrapeError("INVALID_JSON");
  }
}

export function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof ScrapeError) return error.code;
  return "WORKER_ERROR";
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(120, Math.max(1, Math.ceil(seconds)));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(120, Math.max(1, Math.ceil((date - Date.now()) / 1000)));
}