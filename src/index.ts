import { json, readJson, safeErrorCode, sha256Text, ScrapeError, parseRetryAfter } from "./http";
import { verifyAccess } from "./access";
import { discoverFromHtml, discoverFromCss } from "./discovery";
import { fetchForJob, validatePublicUrl } from "./security";
import { putStreamAndHash, R2StorageAdapter, sniffImageFormat } from "./storage";
import type { Env, JobMode, JobSettings, JobSnapshot, QueuePayload, StoredTaskPayload } from "./types";
export { JobDurableObject } from "./job";

const DEFAULT_BUDGET = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE = 50 * 1024 * 1024;
const MANIFEST_LIMIT = 50_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface CreateJobBody { siteUrl: string; pages?: string[]; mode: JobMode; concurrency?: number; maxDepth?: number; }
interface VerifyReport { manifestSha256: string; filesChecked: number; bytesChecked: number; failed: number; }
interface TaskRegistration { taskId: string; url: string; urlHash: string; depth?: number; }

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

async function clearOrphanedPrefixes(env: Env, jobId: string): Promise<{ cleared: true; deletedObjects: number; deletedBytes: number; r2PrefixVerifiedEmpty: true; deletedJobState: true }> {
  let deletedObjects = 0;
  let deletedBytes = 0;
  for (const prefix of ["jobs/" + jobId + "/", "tmp/jobs/" + jobId + "/"]) {
    let cursor: string | undefined;
    do {
      const page = await env.IMAGES.list({ prefix, cursor, limit: 500 });
      if (page.objects.length) {
        await env.IMAGES.delete(page.objects.map(object => object.key));
        deletedObjects += page.objects.length;
        deletedBytes += page.objects.reduce((total, object) => total + object.size, 0);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const remaining = await env.IMAGES.list({ prefix, limit: 1 });
    if (remaining.objects.length) throw new ScrapeError("R2_PREFIX_NOT_EMPTY", true, 3);
  }
  return { cleared: true, deletedObjects, deletedBytes, r2PrefixVerifiedEmpty: true, deletedJobState: true };
}

async function reconcileStorage(env: Env, jobId: string): Promise<void> {
  const token = crypto.randomUUID();
  const start = await jobRequest(env, jobId, "/storage/reconcile/start", { token });
  if (!start.ok) throw new ScrapeError("STORAGE_RECONCILE_UNAVAILABLE", true, 3);
  const startResult = await start.json() as { result: string };
  if (startResult.result !== "accepted") throw new ScrapeError("STORAGE_RECONCILE_REJECTED");
  const prefix = "jobs/" + jobId + "/objects/";
  let cursor: string | undefined;
  let batch: Array<{ sha256: string; key: string; size: number }> = [];
  const publish = async (): Promise<void> => {
    if (!batch.length) return;
    const response = await jobRequest(env, jobId, "/storage/reconcile/batch", { token, items: batch });
    if (!response.ok) throw new ScrapeError("STORAGE_RECONCILE_BATCH_FAILED", true, 3);
    const result = await response.json() as { result: string };
    if (result.result !== "accepted") throw new ScrapeError("STORAGE_RECONCILE_BATCH_REJECTED");
    batch = [];
  };
  do {
    const page = await env.IMAGES.list({ prefix, cursor, limit: 1000, include: ["customMetadata"] });
    for (const object of page.objects) {
      const sha256 = object.customMetadata?.sha256 || "";
      if (!HASH_PATTERN.test(sha256)) throw new ScrapeError("OBJECT_METADATA_INCOMPLETE");
      batch.push({ sha256, key: object.key, size: object.size });
      if (batch.length >= 250) await publish();
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await publish();
  const finish = await jobRequest(env, jobId, "/storage/reconcile/finish", { token });
  if (!finish.ok) throw new ScrapeError("STORAGE_RECONCILE_FINISH_FAILED", true, 3);
  const finished = await finish.json() as { result: string };
  if (finished.result !== "reconciled") throw new ScrapeError("STORAGE_RECONCILE_UNCONFIRMED");
}

async function registerPages(env: Env, jobId: string, pages: TaskRegistration[]): Promise<void> {
  if (!pages.length) return;
  for (let start = 0; start < pages.length; start += 500) {
    const response = await jobRequest(env, jobId, "/register-pages", { items: pages.slice(start, start + 500) });
    if (!response.ok) throw new ScrapeError("TASK_REGISTRATION_FAILED", true, 3);
    const result = await response.json() as { result: string; items: Array<{ taskId: string; result: string }> };
    if (result.result !== "accepted" || !Array.isArray(result.items) ||
      result.items.some(item => !["accepted", "duplicate"].includes(item.result))) {
      throw new ScrapeError("TASK_REGISTRATION_REJECTED");
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
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

function looksJavaScriptRendered(html: string): boolean {
  if (!/<script[\s>]/i.test(html)) return false;
  const hasAppRoot = /id=["'](?:root|app|__next|__nuxt)["']/i.test(html);
  if (!hasAppRoot) return false;
  const visibleApproximation = html.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, "").length;
  return visibleApproximation < 160;
}

function escapeRegex(value: string): string {
  return value.split("").map(character => ".*+?^$()|[]{}\\/".includes(character) ? "\\" + character : character).join("");
}

async function fetchRenderedHtml(env: Env, jobId: string, pageUrl: string, allowedOrigin: string): Promise<string | null> {
  const guard = await fetchForJob(env, jobId, pageUrl, { accept: "text/html,application/xhtml+xml" }, allowedOrigin);
  try {
    await guard.response.body?.cancel();
    if (guard.finalUrl.origin !== allowedOrigin) throw new ScrapeError("CROSS_ORIGIN_REDIRECT_BLOCKED");
    const originPattern = escapeRegex(new URL(allowedOrigin).origin);
    const response = await env.BROWSER.quickAction("content", {
      url: guard.finalUrl.toString(),
      allowRequestPattern: ["/^" + originPattern + "(?:\\/|$)/i"],
      rejectRequestPattern: ["/^(?!" + originPattern + "(?:\\/|$)).*/i"],
      gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 }
    });
    if (!response.ok) return null;
    return await readLimitedText(response, 2_500_000);
  } finally { await guard.release(); }
}

async function fetchStylesheet(env: Env, jobId: string, url: string): Promise<string | null> {
  const result = await fetchForJob(env, jobId, url, { accept: "text/css,*/*;q=0.1" });
  try {
    if (!result.response.ok) return null;
    const type = result.response.headers.get("content-type") || "";
    if (type && !type.includes("text/css") && !type.includes("text/plain")) return null;
    return await readLimitedText(result.response, 512_000);
  } finally { await result.release(); }
}

async function checkTaskResponse(response: Response, accepted: string[]): Promise<Record<string, unknown>> {
  if (!response.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.result !== "string" || !accepted.includes(body.result)) {
    throw new ScrapeError("UNKNOWN_TASK_RESULT", true, 3);
  }
  return body;
}

async function completeTask(env: Env, jobId: string, taskId: string, result: "success" | "failed" | "cancelled", code?: string): Promise<void> {
  const response = await jobRequest(env, jobId, "/task/complete", { taskId, result, code });
  await checkTaskResponse(response, ["completed", "already_terminal"]);
}

async function processPage(jobId: string, taskId: string, payload: StoredTaskPayload, env: Env): Promise<void> {
  const settingsResponse = await jobRequest(env, jobId, "/settings");
  if (!settingsResponse.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
  const settings = await settingsResponse.json() as JobSettings;
  const pageUrl = validatePublicUrl(payload.url, settings.allowedOrigin).toString();
  const fetched = await fetchForJob(env, jobId, pageUrl, { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.2" }, settings.allowedOrigin);
  let html = "";
  try {
    if (fetched.response.status === 429 || fetched.response.status >= 500) {
      throw new ScrapeError("PAGE_HTTP_" + fetched.response.status, true, parseRetryAfter(fetched.response.headers.get("retry-after")));
    }
    if (!fetched.response.ok) throw new ScrapeError("PAGE_HTTP_" + fetched.response.status);
    const contentType = fetched.response.headers.get("content-type") || "";
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) throw new ScrapeError("PAGE_NOT_HTML");
    html = await readLimitedText(fetched.response, 2_500_000);
  } finally { await fetched.release(); }

  if (looksJavaScriptRendered(html)) {
    const rendered = await fetchRenderedHtml(env, jobId, fetched.finalUrl.toString(), settings.allowedOrigin);
    if (rendered) html = rendered;
  }

  const discovered = discoverFromHtml(html, fetched.finalUrl.toString(), settings.maxImagesPerPage || 2000, 2000);
  const allImages = [...discovered.images];
  for (const stylesheetUrl of discovered.stylesheets.slice(0, 20)) {
    const css = await fetchStylesheet(env, jobId, stylesheetUrl);
    if (!css) continue;
    for (const imageUrl of discoverFromCss(css, stylesheetUrl, settings.maxImagesPerPage || 2000)) allImages.push({ url: imageUrl });
  }

  const uniqueImages = Array.from(new Set(allImages.map(item => item.url))).slice(0, settings.maxImagesPerPage || 2000);
  const imageItems: TaskRegistration[] = await Promise.all(uniqueImages.map(async url => ({
    taskId: await sha256Text("image|" + url), url, urlHash: await sha256Text(url)
  })));
  const pageItems: TaskRegistration[] = [];
  if (settings.mode === "crawl" && Number(payload.depth || 0) < settings.maxDepth) {
    const uniquePages = Array.from(new Set(discovered.pages)).slice(0, 2000);
    for (const url of uniquePages) {
      try {
        if (new URL(url).origin !== settings.allowedOrigin) continue;
        pageItems.push({ taskId: await sha256Text("page|" + url), url, urlHash: await sha256Text(url), depth: Number(payload.depth || 0) + 1 });
      } catch { /* Invalid discovered links are ignored, never sent to the DO. */ }
    }
  }
  const response = await jobRequest(env, jobId, "/page/complete", { taskId, images: imageItems, pages: pageItems });
  const result = await checkTaskResponse(response, ["accepted", "rejected"]);
  if (result.parent !== "done" && result.parent !== "failed") throw new ScrapeError("PAGE_COMPLETION_UNCONFIRMED", true, 3);
}

async function reserveBytes(env: Env, jobId: string, permitId: string, bytes: number): Promise<boolean> {
  const response = await jobRequest(env, jobId, "/reserve", { permitId, bytes });
  if (!response.ok) throw new ScrapeError("BUDGET_RESERVATION_UNAVAILABLE", true, 3);
  const result = await response.json() as { allowed: boolean; status?: string };
  if (result.allowed) return true;
  if (result.status === "paused" || result.status === "initializing" || result.status === "budget-paused") throw new ScrapeError("JOB_PAUSED", true, 30);
  if (result.status === "cancelled") throw new ScrapeError("JOB_CANCELLED");
  if (result.status === "permit-expired") throw new ScrapeError("PERMIT_EXPIRED", true, 3);
  throw new ScrapeError("BUDGET_RESERVATION_UNAVAILABLE", true, 3);
}

async function processImage(jobId: string, taskId: string, payload: StoredTaskPayload, env: Env): Promise<void> {
  const settingsResponse = await jobRequest(env, jobId, "/settings");
  if (!settingsResponse.ok) throw new ScrapeError("JOB_STATE_UNAVAILABLE", true, 3);
  const settings = await settingsResponse.json() as JobSettings;
  const fetched = await fetchForJob(env, jobId, payload.url);
  const permitId = fetched.permitId;
  const temporaryKey = "tmp/jobs/" + jobId + "/" + taskId;
  let claimOwned = false;

  try {
    if (fetched.response.status === 429 || fetched.response.status >= 500) {
      throw new ScrapeError("IMAGE_HTTP_" + fetched.response.status, true, parseRetryAfter(fetched.response.headers.get("retry-after")));
    }
    if (!fetched.response.ok) throw new ScrapeError("IMAGE_HTTP_" + fetched.response.status);
    const lengthHeader = Number(fetched.response.headers.get("content-length") || "0");
    if (lengthHeader > settings.maxFileBytes) throw new ScrapeError("FILE_TOO_LARGE");
    if (!fetched.response.body) throw new ScrapeError("EMPTY_IMAGE_RESPONSE");
    const streamResult = await putStreamAndHash(env.IMAGES, temporaryKey, fetched.response.body as ReadableStream<Uint8Array>,
      settings.maxFileBytes, bytes => reserveBytes(env, jobId, permitId, bytes),
      fetched.response.headers.get("content-type") || "application/octet-stream");
    const format = sniffImageFormat(streamResult.prefix);
    if (!format || streamResult.size < 1) throw new ScrapeError("NOT_AN_IMAGE");

    const finalKey = "jobs/" + jobId + "/objects/" + streamResult.sha256 + "." + format.extension;
    const claimResponse = await jobRequest(env, jobId, "/content/claim", {
      sha256: streamResult.sha256, taskId, tempKey: temporaryKey, finalKey, size: streamResult.size
    });
    if (!claimResponse.ok) throw new ScrapeError("CONTENT_CLAIM_UNAVAILABLE", true, 3);
    const claim = await claimResponse.json() as { result: string };
    if (claim.result === "stored") {
      await env.IMAGES.delete(temporaryKey);
      const releaseResponse = await jobRequest(env, jobId, "/reservation/release", { permitId });
      if (!releaseResponse.ok) throw new ScrapeError("RESERVATION_RELEASE_FAILED", true, 3);
      return;
    }
    if (claim.result === "in_progress") {
      await env.IMAGES.delete(temporaryKey);
      const releaseResponse = await jobRequest(env, jobId, "/reservation/release", { permitId });
      if (!releaseResponse.ok) throw new ScrapeError("RESERVATION_RELEASE_FAILED", true, 3);
      throw new ScrapeError("CONTENT_CLAIM_BUSY", true, 30);
    }
    if (claim.result !== "claimed" && claim.result !== "takeover") throw new ScrapeError("UNKNOWN_CONTENT_CLAIM", true, 3);
    claimOwned = true;

    const current = await env.IMAGES.head(finalKey);
    if (!current || current.size !== streamResult.size) {
      if (current) await env.IMAGES.delete(finalKey);
      const temporaryObject = await env.IMAGES.get(temporaryKey);
      if (!temporaryObject || temporaryObject.size !== streamResult.size) throw new ScrapeError("TEMP_OBJECT_MISSING", true, 3);
      await env.IMAGES.put(finalKey, temporaryObject.body, {
        httpMetadata: { contentType: format.contentType },
        customMetadata: { sha256: streamResult.sha256 }
      });
    }
    const verified = await env.IMAGES.head(finalKey);
    if (!verified || verified.size !== streamResult.size) throw new ScrapeError("FINAL_OBJECT_SIZE_MISMATCH", true, 3);
    await env.IMAGES.delete(temporaryKey);
    const commit = await jobRequest(env, jobId, "/content/commit", { sha256: streamResult.sha256, taskId, permitId, size: streamResult.size });
    if (!commit.ok) throw new ScrapeError("CONTENT_COMMIT_FAILED", true, 3);
    const commitResult = await commit.json() as { result: string };
    if (commitResult.result !== "stored") throw new ScrapeError("CONTENT_COMMIT_UNCONFIRMED", true, 3);
    claimOwned = false;
  } finally {
    if (claimOwned) await jobRequest(env, jobId, "/content/release", { taskId }).catch(() => undefined);
    await fetched.release();
  }
}

async function processQueueMessage(message: { body: QueuePayload; attempts: number; ack: () => void; retry: (options?: { delaySeconds?: number }) => void }, env: Env): Promise<void> {
  const hint = message.body;
  if (!hint || typeof hint.jobId !== "string" || typeof hint.taskId !== "string" || !HASH_PATTERN.test(hint.taskId)) {
    message.ack();
    return;
  }
  const leaseResponse = await jobRequest(env, hint.jobId, "/task/lease", { taskId: hint.taskId });
  const leased = await checkTaskResponse(leaseResponse, ["leased", "paused", "busy", "deferred", "terminal"]);
  if (leased.result !== "leased") { message.ack(); return; }
  const kind = leased.kind;
  const payload = leased.payload as StoredTaskPayload;
  if ((kind !== "page" && kind !== "image") || !payload || typeof payload.url !== "string") {
    const response = await jobRequest(env, hint.jobId, "/task/retry", { taskId: hint.taskId, code: "INVALID_TASK_PAYLOAD", retryable: false });
    await checkTaskResponse(response, ["completed", "already_terminal"]);
    message.ack();
    return;
  }
  try {
    if (kind === "page") await processPage(hint.jobId, hint.taskId, payload, env);
    else {
      await processImage(hint.jobId, hint.taskId, payload, env);
      await completeTask(env, hint.jobId, hint.taskId, "success");
    }
    message.ack();
  } catch (error) {
    const code = safeErrorCode(error);
    const retryable = error instanceof ScrapeError && error.retryable;
    const delay = error instanceof ScrapeError && error.retryAfterSeconds ? error.retryAfterSeconds : 2;
    const response = await jobRequest(env, hint.jobId, "/task/retry", { taskId: hint.taskId, code, retryable, delaySeconds: delay });
    await checkTaskResponse(response, ["accepted", "completed", "already_terminal"]);
    message.ack();
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
    allowedOrigin: site.origin, mode: body.mode,
    concurrency: Math.min(20, Math.max(1, Math.floor(Number(body.concurrency || 5)))),
    maxDepth: body.mode === "crawl" ? Math.min(10, Math.max(0, Math.floor(Number(body.maxDepth ?? 3)))) : 0,
    maxPages: 500, maxFileBytes: DEFAULT_MAX_FILE, budgetBytes: DEFAULT_BUDGET,
    perDomainDelayMs: 1000, maxImagesPerPage: 2000, maxImagesPerJob: 50_000
  };
  const init = await jobRequest(env, jobId, "/init", { jobId, ...settings });
  if (!init.ok) throw new ScrapeError("JOB_INITIALIZATION_FAILED");
  const items: TaskRegistration[] = await Promise.all(Array.from(normalizedPages).map(async url => ({
    taskId: await sha256Text("page|" + url), url, urlHash: await sha256Text(url), depth: 0
  })));
  await registerPages(env, jobId, items);
  const started = await jobRequest(env, jobId, "/start", {});
  if (!started.ok) throw new ScrapeError("JOB_START_FAILED");
  const snapshot = await jobSnapshot(env, jobId);
  return json({ jobId, snapshot }, 201);
}

async function buildManifest(env: Env, jobId: string): Promise<Response> {
  const snapshot = await jobSnapshot(env, jobId);
  if (!snapshot) return json({ error: "JOB_NOT_FOUND" }, 404);
  if (!["completed", "cancelled", "paused", "budget-paused", "verified"].includes(snapshot.status) ||
    snapshot.bytesReserved !== 0 || (snapshot.taskCounts?.leased || 0) !== 0 ||
    ((snapshot.status === "completed" || snapshot.status === "cancelled") &&
      ((snapshot.taskCounts?.pending || 0) !== 0 || snapshot.pendingPages !== 0 || snapshot.pendingImages !== 0))) {
    return json({ error: "JOB_NOT_READY_FOR_EXPORT" }, 409);
  }
  await reconcileStorage(env, jobId);
  const store = new R2StorageAdapter(env.IMAGES);
  const prefix = "jobs/" + jobId + "/";
  const files: Array<{ key: string; size: number; sha256: string; contentType: string }> = [];
  let cursor: string | undefined;
  let bytes = 0;
  do {
    const page = await store.list({ prefix, cursor, limit: 1000, include: ["customMetadata", "httpMetadata"] });
    for (const object of page.objects) {
      const sha = object.customMetadata?.sha256 || "";
      if (!HASH_PATTERN.test(sha)) return json({ error: "OBJECT_METADATA_INCOMPLETE" }, 409);
      files.push({ key: object.key, size: object.size, sha256: sha, contentType: object.httpMetadata?.contentType || "application/octet-stream" });
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
  return new Response(body, { headers: {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": 'attachment; filename="manifest-' + jobId + '.json"',
    "cache-control": "no-store", "x-manifest-sha256": digest
  }});
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
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
    const result = await response.json().catch(() => ({}));
    return json(result, response.status);
  }
  if (action === "clear" && request.method === "POST") {
    const snapshot = await jobSnapshot(env, jobId);
    if (!snapshot) {
      const receipt = await clearOrphanedPrefixes(env, jobId);
      return json(receipt);
    }
    if (!["abandoned", "clearing", "clearing_failed"].includes(snapshot.status)) {
      await reconcileStorage(env, jobId);
    }
    const response = await jobRequest(env, jobId, "/clear", {});
    const result = await response.json().catch(() => ({}));
    return json(result, response.status);
  }
  if (["pause", "resume", "cancel"].includes(action) && request.method === "POST") {
    const body = action === "resume" ? await readJson<{ budgetBytes?: number }>(request) : {};
    const response = await jobRequest(env, jobId, "/" + action, body);
    const result = await response.json().catch(() => ({}));
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
      try { return await routeApi(request, env); }
      catch (error) {
        const code = safeErrorCode(error);
        const status = error instanceof ScrapeError && [
          "INVALID_JSON", "REQUEST_TOO_LARGE", "INVALID_URL", "INVALID_SCRAPE_MODE",
          "SEED_PAGE_OUTSIDE_WEBSITE", "TOO_MANY_SEED_PAGES", "PRIVATE_OR_LOCAL_HOST_BLOCKED", "UNSUPPORTED_PROTOCOL"
        ].includes(code) ? 400 : 500;
        return json({ error: code }, status);
      }
    }
    return env.ASSETS.fetch(request);
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body;
      if (!body || typeof body !== "object" || !("jobId" in body) || !("taskId" in body)) {
        message.ack();
        continue;
      }
      await processQueueMessage({ ...message, body: body as QueuePayload }, env);
    }
  }
} satisfies ExportedHandler<Env>;
