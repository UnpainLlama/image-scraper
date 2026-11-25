import { json, readJson, safeErrorCode, sha256Text, ScrapeError, parseRetryAfter } from "./http";
import { verifyAccess } from "./access";
import { discoverFromHtml, discoverFromCss } from "./discovery";
import { fetchForJob, validatePublicUrl } from "./security";
import { imageObjectKey, putStreamAndHash, R2StorageAdapter, sniffImageFormat } from "./storage";
import type { Env, JobMode, JobSettings, JobSnapshot, DiscoveryMessage, DownloadMessage, QueuePayload } from "./types";

const DEFAULT_BUDGET = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE = 50 * 1024 * 1024;
const MANIFEST_LIMIT = 50_000;
const JOB_ID_PATTERN = /^[a-z0-9-]{16,64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface CreateJobBody {
  siteUrl: string;
  pages?: string[];
  mode: JobMode;
  concurrency?: number;
  maxDepth?: number;
}

interface VerifyReport {
  manifestSha256: string;
  filesChecked: number;
  bytesChecked: number;
  failed: number;
}

interface TaskClaim {
  found: boolean;
  claimed: boolean;
}

async function jobRequest(env: Env, jobId: string, path: string, body?: unknown): Promise<Response> {
  const stub = env.JOBS.get(env.JOBS.idFromName(jobId));
  return stub.fetch("https://job.internal" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function jobSnapshot(env: Env, jobId: string): Promise<JobSnapshot | null> {
  const response = await jobRequest(env, jobId, "/snapshot");
  if (response.status === 404) return null;
  if (!response.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
  return await response.json() as JobSnapshot;
}

async function registerPage(env: Env, jobId: string, pageUrl: string, depth: number): Promise<boolean> {
  const pageHash = await sha256Text(pageUrl);
  const taskId = await sha256Text("page|" + pageUrl);
  const result = await jobRequest(env, jobId, "/enqueue-page", { pageHash, taskId, depth });
  if (!result.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
  const accepted = await result.json() as { accepted: boolean };
  if (!accepted.accepted) return false;
  const message: DiscoveryMessage = { jobId, pageUrl, depth, taskId };
  try {
    await env.DISCOVERY_QUEUE.send(message);
    return true;
  } catch {
    await jobRequest(env, jobId, "/task/complete", { taskId, result: "failed", code: "QUEUE_SEND_FAILED" });
    throw new ScrapeError("QUEUE_SEND_FAILED", true, 5);
  }
}

async function registerImages(env: Env, jobId: string, candidates: Array<{ url: string; source: string }>): Promise<void> {
  const unique = new Map<string, { url: string; source: string }>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
  }
  const items = Array.from(unique.values());
  for (let start = 0; start < items.length; start += 50) {
    const batch = items.slice(start, start + 50);
    const messages: DownloadMessage[] = [];
    for (const candidate of batch) {
      const urlHash = await sha256Text(candidate.url);
      const taskId = await sha256Text("image|" + candidate.url);
      const response = await jobRequest(env, jobId, "/enqueue-image", { urlHash, taskId });
      if (!response.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
      const data = await response.json() as { accepted: boolean };
      if (data.accepted) messages.push({ jobId, imageUrl: candidate.url, sourcePage: candidate.source, taskId });
    }
    if (!messages.length) continue;
    try {
      await env.DOWNLOAD_QUEUE.sendBatch(messages.map(body => ({ body })));
    } catch {
      for (const message of messages) {
        await jobRequest(env, jobId, "/task/complete", {
          taskId: message.taskId,
          result: "failed",
          code: "QUEUE_SEND_FAILED"
        });
      }
    }
  }
}

async function readLimitedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ScrapeError("PAGE_TOO_LARGE");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function looksJavaScriptRendered(html: string): boolean {
  if (!/<script[\s>]/i.test(html)) return false;
  const hasAppRoot = /id=["'](?:root|app|__next|__nuxt)["']/i.test(html);
  if (!hasAppRoot) return false;
  const visibleApproximation = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, "")
    .length;
  return visibleApproximation < 160;
}

async function fetchRenderedHtml(env: Env, jobId: string, pageUrl: string, allowedOrigin: string): Promise<string | null> {
  const guard = await fetchForJob(env, jobId, pageUrl, { accept: "text/html,application/xhtml+xml" }, allowedOrigin);
  try {
    await guard.response.body?.cancel();
    if (guard.finalUrl.origin !== allowedOrigin) throw new ScrapeError("CROSS_ORIGIN_REDIRECT_BLOCKED");
    const response = await env.BROWSER.quickAction("content", { url: guard.finalUrl.toString() });
    if (!response.ok) return null;
    return await readLimitedText(response, 2_500_000);
  } finally {
    await guard.release();
  }
}

async function fetchStylesheet(env: Env, jobId: string, url: string): Promise<string | null> {
  const result = await fetchForJob(env, jobId, url, { accept: "text/css,*/*;q=0.1" });
  try {
    if (!result.response.ok) return null;
    const type = result.response.headers.get("content-type") || "";
    if (type && !type.includes("text/css") && !type.includes("text/plain")) return null;
    return await readLimitedText(result.response, 512_000);
  } finally {
    await result.release();
  }
}

async function completeTask(env: Env, jobId: string, taskId: string, result: "success" | "failed" | "cancelled", code?: string, stored?: boolean): Promise<void> {
  await jobRequest(env, jobId, "/task/complete", { taskId, result, code, stored });
}

async function processPage(message: DiscoveryMessage, env: Env): Promise<void> {
  const settingsResponse = await jobRequest(env, message.jobId, "/settings");
  if (!settingsResponse.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
  const settings = await settingsResponse.json() as JobSettings;
  const fetched = await fetchForJob(
    env,
    message.jobId,
    message.pageUrl,
    { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.2" },
    settings.allowedOrigin
  );
  let html = "";
  try {
    if (fetched.response.status === 429 || fetched.response.status >= 500) {
      throw new ScrapeError("PAGE_HTTP_" + fetched.response.status, true, parseRetryAfter(fetched.response.headers.get("retry-after")));
    }
    if (!fetched.response.ok) throw new ScrapeError("PAGE_HTTP_" + fetched.response.status);
    const contentType = fetched.response.headers.get("content-type") || "";
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new ScrapeError("PAGE_NOT_HTML");
    }
    html = await readLimitedText(fetched.response, 2_500_000);
  } finally {
    await fetched.release();
  }

  if (looksJavaScriptRendered(html)) {
    const rendered = await fetchRenderedHtml(env, message.jobId, fetched.finalUrl.toString(), settings.allowedOrigin);
    if (rendered) html = rendered;
  }

  const discovered = discoverFromHtml(html, fetched.finalUrl.toString());
  const allImages = [...discovered.images];
  for (const stylesheetUrl of discovered.stylesheets.slice(0, 20)) {
    const css = await fetchStylesheet(env, message.jobId, stylesheetUrl);
    if (!css) continue;
    for (const imageUrl of discoverFromCss(css, stylesheetUrl)) {
      allImages.push({ url: imageUrl, source: fetched.finalUrl.toString() });
    }
  }
  await registerImages(env, message.jobId, allImages);

  if (settings.mode === "crawl" && message.depth < settings.maxDepth) {
    for (const pageUrl of discovered.pages) {
      try {
        if (new URL(pageUrl).origin !== settings.allowedOrigin) continue;
        await registerPage(env, message.jobId, pageUrl, message.depth + 1);
      } catch {
        continue;
      }
    }
  }
}

async function reserveBytes(env: Env, jobId: string, permitId: string, bytes: number): Promise<boolean> {
  const response = await jobRequest(env, jobId, "/reserve", { permitId, bytes });
  if (!response.ok) throw new ScrapeError("BUDGET_RESERVATION_UNAVAILABLE", true, 3);
  const result = await response.json() as { allowed: boolean; status?: string };
  if (result.allowed) return true;
  if (result.status === "paused" || result.status === "initializing") throw new ScrapeError("JOB_PAUSED", true, 60);
  if (result.status === "cancelled") throw new ScrapeError("JOB_CANCELLED");
  if (result.status === "budget-paused") throw new ScrapeError("STORAGE_BUDGET_REACHED");
  if (result.status === "permit-expired") throw new ScrapeError("PERMIT_EXPIRED", true, 3);
  throw new ScrapeError("BUDGET_RESERVATION_UNAVAILABLE", true, 3);
}

async function processImage(message: DownloadMessage, env: Env): Promise<boolean> {
  const settingsResponse = await jobRequest(env, message.jobId, "/settings");
  if (!settingsResponse.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
  const settings = await settingsResponse.json() as JobSettings;
  const fetched = await fetchForJob(env, message.jobId, message.imageUrl);
  const permitId = fetched.permitId;
  const temporaryKey = "jobs/" + message.jobId + "/.tmp/" + message.taskId + "-" + crypto.randomUUID();
  let claimedHash = "";
  let finalKey = "";
  let stored = false;

  try {
    if (fetched.response.status === 429 || fetched.response.status >= 500) {
      throw new ScrapeError("IMAGE_HTTP_" + fetched.response.status, true, parseRetryAfter(fetched.response.headers.get("retry-after")));
    }
    if (!fetched.response.ok) throw new ScrapeError("IMAGE_HTTP_" + fetched.response.status);
    const lengthHeader = Number(fetched.response.headers.get("content-length") || "0");
    if (lengthHeader > settings.maxFileBytes) throw new ScrapeError("FILE_TOO_LARGE");
    if (!fetched.response.body) throw new ScrapeError("EMPTY_IMAGE_RESPONSE");

    const streamResult = await putStreamAndHash(
      env.IMAGES,
      temporaryKey,
      fetched.response.body as ReadableStream<Uint8Array>,
      settings.maxFileBytes,
      bytes => reserveBytes(env, message.jobId, permitId, bytes),
      fetched.response.headers.get("content-type") || "application/octet-stream"
    );
    const format = sniffImageFormat(streamResult.prefix);
    if (!format || streamResult.size < 1) throw new ScrapeError("NOT_AN_IMAGE");

    const claimResponse = await jobRequest(env, message.jobId, "/content/claim", { sha256: streamResult.sha256 });
    if (!claimResponse.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
    const claim = await claimResponse.json() as { claimed: boolean };
    if (!claim.claimed) {
      await env.IMAGES.delete(temporaryKey);
      const releaseResponse = await jobRequest(env, message.jobId, "/reservation/release", { permitId });
      if (!releaseResponse.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
      return false;
    }
    claimedHash = streamResult.sha256;

    finalKey = imageObjectKey(message.jobId, fetched.finalUrl, format, streamResult.sha256);
    const temporaryObject = await env.IMAGES.get(temporaryKey);
    if (!temporaryObject) throw new ScrapeError("TEMP_OBJECT_MISSING", true, 3);
    await env.IMAGES.put(finalKey, temporaryObject.body, {
      httpMetadata: { contentType: format.contentType },
      customMetadata: {
        sha256: streamResult.sha256,
        sourceDomain: fetched.finalUrl.hostname
      }
    });
    stored = true;
    await env.IMAGES.delete(temporaryKey);

    const commitResponse = await jobRequest(env, message.jobId, "/reservation/commit", {
      permitId,
      size: streamResult.size
    });
    if (!commitResponse.ok) throw new ScrapeError("RESERVATION_COMMIT_FAILED", true, 3);
    claimedHash = "";
    return true;
  } catch (error) {
    await env.IMAGES.delete(temporaryKey).catch(() => undefined);
    if (stored && finalKey) await env.IMAGES.delete(finalKey).catch(() => undefined);
    if (claimedHash) await jobRequest(env, message.jobId, "/content/release", { sha256: claimedHash }).catch(() => undefined);
    throw error;
  } finally {
    await fetched.release();
  }
}

async function claimTask(env: Env, jobId: string, taskId: string): Promise<TaskClaim> {
  const response = await jobRequest(env, jobId, "/task/claim", { taskId });
  if (!response.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
  return await response.json() as TaskClaim;
}

async function retryOrFail(
  message: { attempts: number; ack: () => void; retry: (options?: { delaySeconds?: number }) => void },
  env: Env,
  jobId: string,
  taskId: string,
  error: unknown
): Promise<void> {
  const code = safeErrorCode(error);
  const retryable = error instanceof ScrapeError && error.retryable;
  if (retryable && message.attempts < 95) {
    await jobRequest(env, jobId, "/task/unclaim", { taskId });
    const delay = error instanceof ScrapeError && error.retryAfterSeconds ? error.retryAfterSeconds : 2;
    message.retry({ delaySeconds: Math.min(120, Math.max(1, delay)) });
    return;
  }
  await completeTask(env, jobId, taskId, code === "JOB_CANCELLED" ? "cancelled" : "failed", code);
  message.ack();
}

async function processQueueMessage(
  message: { body: QueuePayload; attempts: number; ack: () => void; retry: (options?: { delaySeconds?: number }) => void },
  env: Env
): Promise<void> {
  const task = message.body;
  const snapshot = await jobSnapshot(env, task.jobId);
  if (!snapshot) {
    message.ack();
    return;
  }
  if (snapshot.status === "cancelled") {
    await completeTask(env, task.jobId, task.taskId, "cancelled");
    message.ack();
    return;
  }
  if (snapshot.status === "completed" || snapshot.status === "clearing") {
    message.ack();
    return;
  }
  if (snapshot.status !== "running") {
    message.retry({ delaySeconds: snapshot.status === "initializing" ? 1 : 900 });
    return;
  }

  const claim = await claimTask(env, task.jobId, task.taskId);
  if (!claim.found) {
    message.ack();
    return;
  }
  if (!claim.claimed) {
    message.retry({ delaySeconds: 5 });
    return;
  }

  try {
    if ("pageUrl" in task) {
      await processPage(task, env);
      await completeTask(env, task.jobId, task.taskId, "success");
    } else {
      const stored = await processImage(task, env);
      await completeTask(env, task.jobId, task.taskId, "success", undefined, stored);
    }
    message.ack();
  } catch (error) {
    await retryOrFail(message, env, task.jobId, task.taskId, error);
  }
}

async function createJob(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CreateJobBody>(request);
  const site = validatePublicUrl(body.siteUrl);
  if (body.mode !== "exact" && body.mode !== "crawl") throw new ScrapeError("INVALID_SCRAPE_MODE");
  const supplied = Array.isArray(body.pages) ? body.pages : [];
  const rawPages = supplied.map(value => String(value).trim()).filter(Boolean);
  const pages = rawPages.length ? rawPages : [site.toString()];
  if (pages.length > 50) throw new ScrapeError("TOO_MANY_SEED_PAGES");

  const normalizedPages = new Set<string>();
  for (const page of pages) {
    const url = validatePublicUrl(page, site.toString());
    if (url.origin !== site.origin) throw new ScrapeError("SEED_PAGE_OUTSIDE_WEBSITE");
    normalizedPages.add(url.toString());
  }

  const jobId = crypto.randomUUID().replace(/-/g, "");
  const settings: JobSettings = {
    allowedOrigin: site.origin,
    mode: body.mode,
    concurrency: Math.min(20, Math.max(1, Math.floor(Number(body.concurrency || 5)))),
    maxDepth: body.mode === "crawl" ? Math.min(10, Math.max(0, Math.floor(Number(body.maxDepth ?? 3)))) : 0,
    maxPages: 500,
    maxFileBytes: DEFAULT_MAX_FILE,
    budgetBytes: DEFAULT_BUDGET,
    perDomainDelayMs: 1000
  };

  const init = await jobRequest(env, jobId, "/init", { jobId, ...settings });
  if (!init.ok) throw new ScrapeError("JOB_INITIALIZATION_FAILED");
  for (const pageUrl of normalizedPages) {
    await registerPage(env, jobId, pageUrl, 0);
  }
  const started = await jobRequest(env, jobId, "/start", {});
  if (!started.ok) throw new ScrapeError("JOB_START_FAILED");
  const snapshot = await jobSnapshot(env, jobId);
  return json({ jobId, snapshot }, 201);
}

async function buildManifest(env: Env, jobId: string): Promise<Response> {
  const snapshot = await jobSnapshot(env, jobId);
  if (!snapshot) return json({ error: "JOB_NOT_FOUND" }, 404);
  if ((snapshot.status !== "completed" && snapshot.status !== "cancelled") ||
      snapshot.pendingPages !== 0 || snapshot.pendingImages !== 0 || snapshot.bytesReserved !== 0) {
    return json({ error: "JOB_NOT_READY_FOR_EXPORT" }, 409);
  }

  const store = new R2StorageAdapter(env.IMAGES);
  const prefix = "jobs/" + jobId + "/";
  const files: Array<{ key: string; size: number; sha256: string; contentType: string }> = [];
  let cursor: string | undefined;
  let bytes = 0;
  do {
    const page = await store.list({ prefix, cursor, limit: 1000, include: ["customMetadata", "httpMetadata"] });
    for (const object of page.objects) {
      if (object.key.includes("/.tmp/")) continue;
      const sha = object.customMetadata?.sha256 || "";
      if (!HASH_PATTERN.test(sha)) return json({ error: "OBJECT_METADATA_INCOMPLETE" }, 409);
      files.push({
        key: object.key,
        size: object.size,
        sha256: sha,
        contentType: object.httpMetadata?.contentType || "application/octet-stream"
      });
      bytes += object.size;
      if (files.length > MANIFEST_LIMIT) return json({ error: "MANIFEST_LIMIT_EXCEEDED" }, 413);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const manifest = { schemaVersion: 1, jobId, prefix, files };
  const body = JSON.stringify(manifest);
  const digest = await sha256Text(body);
  const recorded = await jobRequest(env, jobId, "/manifest", { digest, count: files.length, bytes });
  if (!recorded.ok) return json({ error: "MANIFEST_RECORD_FAILED" }, 409);
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="manifest-' + jobId + '.json"',
      "cache-control": "no-store",
      "x-manifest-sha256": digest
    }
  });
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/jobs" && request.method === "POST") return createJob(request, env);

  const match = path.match(/^\/api\/jobs\/([a-z0-9-]{16,64})(?:\/(pause|resume|cancel|manifest|verify|clear))?$/);
  if (!match) return json({ error: "NOT_FOUND" }, 404);
  const jobId = match[1]!;
  const action = match[2] || "";

  if (action === "" && request.method === "GET") {
    const snapshot = await jobSnapshot(env, jobId);
    return snapshot ? json(snapshot) : json({ error: "JOB_NOT_FOUND" }, 404);
  }
  if (action === "manifest" && request.method === "GET") return buildManifest(env, jobId);

  if (action === "verify" && request.method === "POST") {
    const report = await readJson<VerifyReport>(request);
    const response = await jobRequest(env, jobId, "/verify", report);
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    return json(result, response.status);
  }

  if (action === "clear" && request.method === "POST") {
    const response = await jobRequest(env, jobId, "/clear", {});
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    return json(result, response.status);
  }

  if (["pause", "resume", "cancel"].includes(action) && request.method === "POST") {
    const response = await jobRequest(env, jobId, "/" + action, {});
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    return json(result, response.status);
  }

  return json({ error: "METHOD_NOT_ALLOWED" }, 405);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const denied = await verifyAccess(request, env);
    if (denied) return denied;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env);
      } catch (error) {
        const code = safeErrorCode(error);
        const status = error instanceof ScrapeError && ["INVALID_JSON", "REQUEST_TOO_LARGE", "INVALID_URL", "INVALID_SCRAPE_MODE", "SEED_PAGE_OUTSIDE_WEBSITE", "TOO_MANY_SEED_PAGES", "PRIVATE_OR_LOCAL_HOST_BLOCKED", "UNSUPPORTED_PROTOCOL"].includes(code) ? 400 : 500;
        return json({ error: code }, status);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<QueuePayload>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processQueueMessage(message, env);
    }
  }
} satisfies ExportedHandler<Env>;
