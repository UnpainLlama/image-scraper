import { ScrapeError } from "./http";
import type { Env, FetchResult } from "./types";

const USER_AGENT = "ImageScraperBot/1.0 (+https://github.com/UnpainLlama/image-scraper)";

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home") ||
      host.endsWith(".test") || !host.includes(".")) return true;
  if (host.includes(":")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

export function validatePublicUrl(input: string, base?: string): URL {
  let url: URL;
  try { url = base ? new URL(input, base) : new URL(input); }
  catch { throw new ScrapeError("INVALID_URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ScrapeError("UNSUPPORTED_PROTOCOL");
  if (url.username || url.password) throw new ScrapeError("URL_CREDENTIALS_NOT_ALLOWED");
  if (blockedHostname(url.hostname)) throw new ScrapeError("PRIVATE_OR_LOCAL_HOST_BLOCKED");
  if (url.port && url.port !== "80" && url.port !== "443") throw new ScrapeError("NONSTANDARD_PORT_BLOCKED");
  url.hash = "";
  return url;
}

async function fetchRawSafe(input: URL, headers?: HeadersInit): Promise<{ response: Response; finalUrl: URL }> {
  let current = validatePublicUrl(input.toString());
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(current.toString(), {
      method: "GET", redirect: "manual",
      headers: { "user-agent": USER_AGENT, "accept": "text/html,application/xhtml+xml,text/css,*/*;q=0.5", ...(headers || {}) },
      signal: AbortSignal.timeout(25_000)
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new ScrapeError("REDIRECT_WITHOUT_LOCATION");
      current = validatePublicUrl(location, current.toString());
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new ScrapeError("TOO_MANY_REDIRECTS");
}

function escapeBrowserPattern(value: string): string {
  return value.split("").map(character => "\\/.^$*+?()[]{}|".includes(character) ? "\\" + character : character).join("");
}

export function browserRequestPatterns(allowedOrigin: string): { allowRequestPattern: string[]; rejectRequestPattern: string[] } {
  const origin = escapeBrowserPattern(new URL(allowedOrigin).origin);
  const ownSite = origin + "(?:\\/|$)";
  return {
    allowRequestPattern: ["/^" + ownSite + "/i"],
    rejectRequestPattern: ["/^(?!" + ownSite + ").*/i"]
  };
}

async function acquire(env: Env, jobId: string, domain: string, crawlDelayMs: number): Promise<string> {
  const stub = env.JOBS.get(env.JOBS.idFromName(jobId));
  const response = await stub.fetch("https://job.internal/permit/acquire", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain, crawlDelayMs })
  });
  if (!response.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
  const result = await response.json() as { allowed: boolean; permitId?: string; retryAfterMs?: number; status?: string };
  if (!result.allowed || !result.permitId) {
    if (result.status === "paused" || result.status === "budget-paused" || result.status === "initializing") throw new ScrapeError("JOB_PAUSED", true, 10);
    if (result.status === "cancelled") throw new ScrapeError("JOB_CANCELLED");
    throw new ScrapeError("RATE_LIMITED", true, Math.max(1, Math.ceil((result.retryAfterMs || 1000) / 1000)));
  }
  return result.permitId;
}

async function release(env: Env, jobId: string, permitId: string): Promise<void> {
  const stub = env.JOBS.get(env.JOBS.idFromName(jobId));
  const response = await stub.fetch("https://job.internal/permit/release", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permitId })
  });
  if (!response.ok) throw new ScrapeError("PERMIT_RELEASE_FAILED", true, 3);
}

export async function acquireBrowserPagePermit(
  env: Env,
  jobId: string,
  input: string,
  allowedOrigin: string
): Promise<() => Promise<void>> {
  const target = validatePublicUrl(input);
  if (target.origin !== allowedOrigin) throw new ScrapeError("CROSS_ORIGIN_REDIRECT_BLOCKED");
  const permitId = await acquire(env, jobId, target.hostname, 0);
  return async () => release(env, jobId, permitId);
}

export async function fetchForJob(env: Env, jobId: string, input: string, headers?: HeadersInit, allowedOrigin?: string): Promise<FetchResult> {
  let current = validatePublicUrl(input);
  const permits: string[] = [];
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (allowedOrigin && current.origin !== allowedOrigin) throw new ScrapeError("CROSS_ORIGIN_REDIRECT_BLOCKED");
      const permitId = await acquire(env, jobId, current.hostname, 0);
      permits.push(permitId);
      const response = await fetch(current.toString(), {
        method: "GET", redirect: "manual",
        headers: { "user-agent": USER_AGENT, "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", ...(headers || {}) },
        signal: AbortSignal.timeout(30_000)
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        await release(env, jobId, permitId);
        permits.pop();
        if (!location) throw new ScrapeError("REDIRECT_WITHOUT_LOCATION");
        current = validatePublicUrl(location, current.toString());
        continue;
      }
      let released = false;
      return {
        response, finalUrl: current, permitId,
        release: async () => {
          if (released) return;
          released = true;
          await Promise.all(permits.map(id => release(env, jobId, id)));
          permits.length = 0;
        }
      };
    }
    throw new ScrapeError("TOO_MANY_REDIRECTS");
  } catch (error) {
    await Promise.all(permits.map(id => release(env, jobId, id)));
    throw error;
  }
}

export const IMAGE_SCRAPER_USER_AGENT = USER_AGENT;

export interface PublicUrlProbe {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
}

export async function probePublicUrl(input: string): Promise<PublicUrlProbe> {
  const target = validatePublicUrl(input);
  const result = await fetchRawSafe(target, {
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5"
  });
  const contentType = result.response.headers.get("content-type") || "";
  const status = result.response.status;
  await result.response.body?.cancel();

  return {
    ok: status >= 200 && status < 400,
    status,
    finalUrl: result.finalUrl.toString(),
    contentType
  };
}
