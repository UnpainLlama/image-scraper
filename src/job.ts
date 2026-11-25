import { DurableObject } from "cloudflare:workers";
import { json, readJson } from "./http";
import type { Env, JobSettings, JobSnapshot, JobStatus } from "./types";

interface StateRow {
  id: number;
  job_id: string;
  config: string;
  status: JobStatus;
  created_at: number;
  pages_discovered: number;
  pages_completed: number;
  pending_pages: number;
  images_discovered: number;
  images_downloaded: number;
  images_stored: number;
  failed_images: number;
  pending_images: number;
  bytes_stored: number;
  bytes_reserved: number;
  verified: number;
  manifest_digest: string | null;
  manifest_count: number;
  manifest_bytes: number;
}
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_IMAGES_PER_JOB = 50_000;
const MAX_PERMIT_MS = 15 * 60 * 1000;

export class JobDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private readState(): StateRow | null {
    try {
      const rows = this.ctx.storage.sql.exec("SELECT * FROM state WHERE id = 1").toArray() as unknown as StateRow[];
      return rows[0] || null;
    } catch {
      return null;
    }
  }

  private createSchema(): void {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), job_id TEXT NOT NULL, config TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, pages_discovered INTEGER NOT NULL DEFAULT 0, pages_completed INTEGER NOT NULL DEFAULT 0, pending_pages INTEGER NOT NULL DEFAULT 0, images_discovered INTEGER NOT NULL DEFAULT 0, images_downloaded INTEGER NOT NULL DEFAULT 0, images_stored INTEGER NOT NULL DEFAULT 0, failed_images INTEGER NOT NULL DEFAULT 0, pending_images INTEGER NOT NULL DEFAULT 0, bytes_stored INTEGER NOT NULL DEFAULT 0, bytes_reserved INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, manifest_digest TEXT, manifest_count INTEGER NOT NULL DEFAULT 0, manifest_bytes INTEGER NOT NULL DEFAULT 0)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pages (hash TEXT PRIMARY KEY)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS image_urls (hash TEXT PRIMARY KEY)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS content_hashes (sha256 TEXT PRIMARY KEY)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_until INTEGER NOT NULL DEFAULT 0)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS permits (permit_id TEXT PRIMARY KEY, domain TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS reservations (permit_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS domain_limits (domain TEXT PRIMARY KEY, next_allowed_at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS error_counts (code TEXT PRIMARY KEY, count INTEGER NOT NULL)");
  }

  private getSettings(row: StateRow): JobSettings {
    return JSON.parse(row.config) as JobSettings;
  }

  private async snapshot(row: StateRow): Promise<JobSnapshot> {
    const errors = this.ctx.storage.sql.exec("SELECT code, count FROM error_counts ORDER BY code").toArray() as unknown as Array<{ code: string; count: number }>;
    const settings = this.getSettings(row);
    return {
      jobId: row.job_id,
      status: row.status,
      createdAt: row.created_at,
      pagesDiscovered: row.pages_discovered,
      pagesCompleted: row.pages_completed,
      pendingPages: row.pending_pages,
      imagesDiscovered: row.images_discovered,
      imagesDownloaded: row.images_downloaded,
      imagesStored: row.images_stored,
      failedImages: row.failed_images,
      pendingImages: row.pending_images,
      bytesStored: row.bytes_stored,
      bytesReserved: row.bytes_reserved,
      budgetBytes: settings.budgetBytes,
      concurrency: settings.concurrency,
      verified: row.verified === 1,
      failedByCode: errors
    };
  }

  private async updateCompletion(): Promise<void> {
    const row = this.readState();
    if (!row || row.status !== "running") return;
    const active = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM permits WHERE expires_at > ?", Date.now()).toArray() as unknown as Array<{ count: number }>;
    if (row.pending_pages === 0 && row.pending_images === 0 && Number(active[0]?.count || 0) === 0) {
      this.ctx.storage.sql.exec("UPDATE state SET status = 'completed' WHERE id = 1");
    }
  }

  private async cleanExpiredPermits(): Promise<void> {
    const now = Date.now();
    const expired = this.ctx.storage.sql.exec("SELECT permit_id FROM permits WHERE expires_at <= ?", now).toArray() as unknown as Array<{ permit_id: string }>;
    for (const item of expired) {
      const reservation = this.ctx.storage.sql.exec("SELECT bytes FROM reservations WHERE permit_id = ?", item.permit_id).toArray() as unknown as Array<{ bytes: number }>;
      const reserved = Number(reservation[0]?.bytes || 0);
      if (reserved) this.ctx.storage.sql.exec("UPDATE state SET bytes_reserved = MAX(0, bytes_reserved - ?) WHERE id = 1", reserved);
      this.ctx.storage.sql.exec("DELETE FROM reservations WHERE permit_id = ?", item.permit_id);
      this.ctx.storage.sql.exec("DELETE FROM permits WHERE permit_id = ?", item.permit_id);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/init" && request.method === "POST") {
        if (this.readState()) return json({ error: "JOB_ALREADY_INITIALIZED" }, 409);
        const body = await readJson<JobSettings & { jobId: string }>(request);
        if (!/^[a-z0-9-]{16,64}$/.test(body.jobId) || !["exact", "crawl"].includes(body.mode) ||
            !Number.isInteger(body.concurrency) || body.concurrency < 1 || body.concurrency > 20 ||
            !Number.isInteger(body.maxPages) || body.maxPages < 1 || body.maxPages > 500 ||
            body.maxFileBytes < 1 || body.maxFileBytes > 50 * 1024 * 1024 ||
            body.budgetBytes < 1 || !/^https?:\/\/[^/]+$/.test(body.allowedOrigin)) {
          return json({ error: "INVALID_JOB_SETTINGS" }, 400);
        }
        const settings: JobSettings = {
          allowedOrigin: body.allowedOrigin,
          mode: body.mode,
          concurrency: body.concurrency,
          maxDepth: body.maxDepth,
          maxPages: body.maxPages,
          maxFileBytes: body.maxFileBytes,
          budgetBytes: body.budgetBytes,
          perDomainDelayMs: body.perDomainDelayMs
        };
        this.createSchema();
        this.ctx.storage.sql.exec(
          "INSERT INTO state (id, job_id, config, status, created_at) VALUES (1, ?, ?, 'initializing', ?)",
          body.jobId,
          JSON.stringify(settings),
          Date.now()
        );
        return json({ initialized: true });
      }

      const row = this.readState();
      if (!row) return json({ error: "JOB_NOT_FOUND" }, 404);

      if (path === "/snapshot" && request.method === "GET") return json(await this.snapshot(row));
      if (path === "/settings" && request.method === "GET") return json(this.getSettings(row));

      if (path === "/start" && request.method === "POST") {
        if (row.status !== "initializing") return json({ error: "JOB_NOT_INITIALIZING" }, 409);
        this.ctx.storage.sql.exec("UPDATE state SET status = 'running' WHERE id = 1");
        await this.updateCompletion();
        return json({ status: this.readState()?.status || "running" });
      }

      if (path === "/enqueue-page" && request.method === "POST") {
        const body = await readJson<{ pageHash: string; taskId: string; depth: number }>(request);
        if (!HASH_PATTERN.test(body.pageHash) || !HASH_PATTERN.test(body.taskId)) return json({ error: "INVALID_TASK" }, 400);
        const settings = this.getSettings(row);
        if ((row.status !== "running" && row.status !== "initializing") ||
            body.depth < 0 || body.depth > settings.maxDepth || row.pages_discovered >= settings.maxPages) {
          return json({ accepted: false });
        }
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pages (hash) VALUES (?)", body.pageHash);
        const inserted = Number((this.ctx.storage.sql.exec("SELECT changes() AS n").toArray() as unknown as Array<{ n: number }>)[0]?.n || 0);
        if (!inserted) return json({ accepted: false, duplicate: true });
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO tasks (task_id, kind, created_at) VALUES (?, 'page', ?)", body.taskId, Date.now());
        this.ctx.storage.sql.exec("UPDATE state SET pages_discovered = pages_discovered + 1, pending_pages = pending_pages + 1 WHERE id = 1");
        return json({ accepted: true });
      }

      if (path === "/enqueue-images" && request.method === "POST") {
        const body = await readJson<{ items: Array<{ urlHash: string; taskId: string }> }>(request);
        if (!Array.isArray(body.items) || body.items.length > 50 ||
            body.items.some(item => !HASH_PATTERN.test(item.urlHash) || !HASH_PATTERN.test(item.taskId))) {
          return json({ error: "INVALID_TASK_BATCH" }, 400);
        }
        const current = this.readState();
        if (!current || current.status !== "running") return json({ acceptedTaskIds: [] });
        const acceptedTaskIds: string[] = [];
        for (const item of body.items) {
          if (current.images_discovered + acceptedTaskIds.length >= MAX_IMAGES_PER_JOB) break;
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO image_urls (hash) VALUES (?)", item.urlHash);
          const inserted = Number((this.ctx.storage.sql.exec("SELECT changes() AS n").toArray() as unknown as Array<{ n: number }>)[0]?.n || 0);
          if (!inserted) continue;
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO tasks (task_id, kind, created_at) VALUES (?, 'image', ?)", item.taskId, Date.now());
          this.ctx.storage.sql.exec("UPDATE state SET images_discovered = images_discovered + 1, pending_images = pending_images + 1 WHERE id = 1");
          acceptedTaskIds.push(item.taskId);
        }
        return json({ acceptedTaskIds });
      }

      if (path === "/task/claim" && request.method === "POST") {
        const body = await readJson<{ taskId: string }>(request);
        if (!HASH_PATTERN.test(body.taskId)) return json({ found: false, claimed: false }, 400);
        const task = this.ctx.storage.sql.exec("SELECT claimed_until FROM tasks WHERE task_id = ?", body.taskId).toArray() as unknown as Array<{ claimed_until: number }>;
        if (!task.length) return json({ found: false, claimed: false });
        if (Number(task[0]?.claimed_until || 0) > Date.now()) return json({ found: true, claimed: false });
        this.ctx.storage.sql.exec("UPDATE tasks SET claimed_until = ? WHERE task_id = ?", Date.now() + MAX_PERMIT_MS, body.taskId);
        return json({ found: true, claimed: true });
      }

      if (path === "/task/unclaim" && request.method === "POST") {
        const body = await readJson<{ taskId: string }>(request);
        this.ctx.storage.sql.exec("UPDATE tasks SET claimed_until = 0 WHERE task_id = ?", body.taskId);
        return json({ unclaimed: true });
      }

      if (path === "/task/complete" && request.method === "POST") {
        const body = await readJson<{ taskId: string; result: "success" | "failed" | "cancelled"; code?: string; stored?: boolean }>(request);
        if (!HASH_PATTERN.test(body.taskId)) return json({ error: "INVALID_TASK" }, 400);
        const tasks = this.ctx.storage.sql.exec("SELECT kind FROM tasks WHERE task_id = ?", body.taskId).toArray() as unknown as Array<{ kind: string }>;
        const kind = tasks[0]?.kind;
        if (!kind) return json({ completed: false });
        this.ctx.storage.sql.exec("DELETE FROM tasks WHERE task_id = ?", body.taskId);
        if (kind === "page") {
          this.ctx.storage.sql.exec("UPDATE state SET pending_pages = MAX(0, pending_pages - 1), pages_completed = pages_completed + 1 WHERE id = 1");
        } else if (body.result === "success") {
          this.ctx.storage.sql.exec(
            "UPDATE state SET pending_images = MAX(0, pending_images - 1), images_downloaded = images_downloaded + 1, images_stored = images_stored + ? WHERE id = 1",
            body.stored ? 1 : 0
          );
        } else {
          this.ctx.storage.sql.exec("UPDATE state SET pending_images = MAX(0, pending_images - 1) WHERE id = 1");
          if (body.result === "failed") this.ctx.storage.sql.exec("UPDATE state SET failed_images = failed_images + 1 WHERE id = 1");
        }
        if (body.result === "failed" && body.code) {
          const code = /^[A-Z0-9_]{1,50}$/.test(body.code) ? body.code : "UNKNOWN_ERROR";
          this.ctx.storage.sql.exec("INSERT INTO error_counts (code, count) VALUES (?, 1) ON CONFLICT(code) DO UPDATE SET count = count + 1", code);
        }
        await this.updateCompletion();
        return json({ completed: true });
      }

      if (path === "/permit/acquire" && request.method === "POST") {
        const body = await readJson<{ domain: string; crawlDelayMs?: number }>(request);
        const domain = String(body.domain || "").toLowerCase().slice(0, 255);
        if (!domain) return json({ error: "INVALID_DOMAIN" }, 400);
        await this.cleanExpiredPermits();
        const current = this.readState();
        if (!current || current.status !== "running") return json({ allowed: false, status: current?.status || "missing" });
        const now = Date.now();
        const activeRows = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM permits").toArray() as unknown as Array<{ count: number }>;
        if (Number(activeRows[0]?.count || 0) >= this.getSettings(current).concurrency) return json({ allowed: false, retryAfterMs: 1500, status: current.status });
        const limits = this.ctx.storage.sql.exec("SELECT next_allowed_at FROM domain_limits WHERE domain = ?", domain).toArray() as unknown as Array<{ next_allowed_at: number }>;
        const nextAt = Number(limits[0]?.next_allowed_at || 0);
        if (nextAt > now) return json({ allowed: false, retryAfterMs: Math.min(30_000, nextAt - now), status: current.status });
        const settings = this.getSettings(current);
        const delay = Math.max(settings.perDomainDelayMs, Math.min(30_000, Math.max(0, Number(body.crawlDelayMs || 0))));
        const permitId = crypto.randomUUID();
        this.ctx.storage.sql.exec("INSERT INTO permits (permit_id, domain, expires_at) VALUES (?, ?, ?)", permitId, domain, now + MAX_PERMIT_MS);
        this.ctx.storage.sql.exec("INSERT INTO domain_limits (domain, next_allowed_at) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET next_allowed_at = excluded.next_allowed_at", domain, now + delay);
        return json({ allowed: true, permitId });
      }

      if (path === "/permit/release" && request.method === "POST") {
        const body = await readJson<{ permitId: string }>(request);
        const reservations = this.ctx.storage.sql.exec("SELECT bytes FROM reservations WHERE permit_id = ?", body.permitId).toArray() as unknown as Array<{ bytes: number }>;
        const reserved = Number(reservations[0]?.bytes || 0);
        if (reserved) this.ctx.storage.sql.exec("UPDATE state SET bytes_reserved = MAX(0, bytes_reserved - ?) WHERE id = 1", reserved);
        this.ctx.storage.sql.exec("DELETE FROM reservations WHERE permit_id = ?", body.permitId);
        this.ctx.storage.sql.exec("DELETE FROM permits WHERE permit_id = ?", body.permitId);
        await this.updateCompletion();
        return json({ released: true });
      }

      if (path === "/reserve" && request.method === "POST") {
        const body = await readJson<{ permitId: string; bytes: number }>(request);
        const amount = Math.floor(Number(body.bytes));
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.permitId) || !Number.isSafeInteger(amount) || amount < 1 || amount > 50 * 1024 * 1024) return json({ allowed: false });
        const current = this.readState();
        if (!current || current.status !== "running") return json({ allowed: false, status: current?.status || "missing" });
        const active = this.ctx.storage.sql.exec("SELECT expires_at FROM permits WHERE permit_id = ?", body.permitId).toArray() as unknown as Array<{ expires_at: number }>;
        if (!active.length || Number(active[0]?.expires_at || 0) <= Date.now()) return json({ allowed: false, status: "permit-expired" });
        const settings = this.getSettings(current);
        if (current.bytes_stored + current.bytes_reserved + amount > settings.budgetBytes) {
          this.ctx.storage.sql.exec("UPDATE state SET status = 'budget-paused' WHERE id = 1");
          return json({ allowed: false, status: "budget-paused" });
        }
        this.ctx.storage.sql.exec("INSERT INTO reservations (permit_id, bytes, expires_at) VALUES (?, ?, ?) ON CONFLICT(permit_id) DO UPDATE SET bytes = bytes + excluded.bytes, expires_at = excluded.expires_at", body.permitId, amount, Number(active[0]?.expires_at || 0));
        this.ctx.storage.sql.exec("UPDATE state SET bytes_reserved = bytes_reserved + ? WHERE id = 1", amount);
        return json({ allowed: true });
      }

      if (path === "/reservation/commit" && request.method === "POST") {
        const body = await readJson<{ permitId: string; size: number }>(request);
        const reservation = this.ctx.storage.sql.exec("SELECT bytes FROM reservations WHERE permit_id = ?", body.permitId).toArray() as unknown as Array<{ bytes: number }>;
        const reserved = Number(reservation[0]?.bytes || 0);
        const size = Math.max(0, Math.floor(Number(body.size)));
        if (!reservation.length || size > reserved) return json({ error: "INVALID_RESERVATION" }, 409);
        this.ctx.storage.sql.exec("DELETE FROM reservations WHERE permit_id = ?", body.permitId);
        this.ctx.storage.sql.exec("UPDATE state SET bytes_reserved = MAX(0, bytes_reserved - ?), bytes_stored = bytes_stored + ? WHERE id = 1", reserved, size);
        return json({ committed: true });
      }

      if (path === "/reservation/release" && request.method === "POST") {
        const body = await readJson<{ permitId: string }>(request);
        const reservation = this.ctx.storage.sql.exec("SELECT bytes FROM reservations WHERE permit_id = ?", body.permitId).toArray() as unknown as Array<{ bytes: number }>;
        const reserved = Number(reservation[0]?.bytes || 0);
        if (reserved) this.ctx.storage.sql.exec("UPDATE state SET bytes_reserved = MAX(0, bytes_reserved - ?) WHERE id = 1", reserved);
        this.ctx.storage.sql.exec("DELETE FROM reservations WHERE permit_id = ?", body.permitId);
        return json({ released: true });
      }

      if (path === "/content/claim" && request.method === "POST") {
        const body = await readJson<{ sha256: string }>(request);
        if (!HASH_PATTERN.test(body.sha256)) return json({ error: "INVALID_HASH" }, 400);
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO content_hashes (sha256) VALUES (?)", body.sha256);
        const inserted = Number((this.ctx.storage.sql.exec("SELECT changes() AS n").toArray() as unknown as Array<{ n: number }>)[0]?.n || 0);
        return json({ claimed: inserted === 1, duplicate: inserted === 0 });
      }

      if (path === "/content/release" && request.method === "POST") {
        const body = await readJson<{ sha256: string }>(request);
        if (HASH_PATTERN.test(body.sha256)) this.ctx.storage.sql.exec("DELETE FROM content_hashes WHERE sha256 = ?", body.sha256);
        return json({ released: true });
      }

      if (path === "/pause" && request.method === "POST") {
        if (row.status === "running") this.ctx.storage.sql.exec("UPDATE state SET status = 'paused' WHERE id = 1");
        return json({ status: "paused" });
      }

      if (path === "/resume" && request.method === "POST") {
        if (row.status !== "paused") return json({ error: "JOB_NOT_RESUMABLE" }, 409);
        this.ctx.storage.sql.exec("UPDATE state SET status = 'running' WHERE id = 1");
        await this.updateCompletion();
        return json({ status: "running" });
      }

      if (path === "/cancel" && request.method === "POST") {
        if (row.status === "clearing") return json({ error: "JOB_CLEARING" }, 409);
        this.ctx.storage.sql.exec("UPDATE state SET status = 'cancelled' WHERE id = 1");
        return json({ status: "cancelled" });
      }

      if (path === "/manifest" && request.method === "POST") {
        const body = await readJson<{ digest: string; count: number; bytes: number }>(request);
        if (!HASH_PATTERN.test(body.digest)) return json({ error: "INVALID_MANIFEST_DIGEST" }, 400);
        const current = this.readState();
        if (!current || (current.status !== "completed" && current.status !== "cancelled") ||
            current.pending_pages !== 0 || current.pending_images !== 0 || current.bytes_reserved !== 0) {
          return json({ error: "JOB_NOT_READY_FOR_EXPORT" }, 409);
        }
        await this.cleanExpiredPermits();
        const activeRows = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM permits WHERE expires_at > ?", Date.now()).toArray() as unknown as Array<{ count: number }>;
        if (Number(activeRows[0]?.count || 0) !== 0) return json({ error: "ACTIVE_WORKERS_REMAIN" }, 409);
        this.ctx.storage.sql.exec("UPDATE state SET manifest_digest = ?, manifest_count = ?, manifest_bytes = ?, verified = 0 WHERE id = 1", body.digest, Math.max(0, Math.floor(body.count)), Math.max(0, Math.floor(body.bytes)));
        return json({ manifestRecorded: true });
      }

      if (path === "/verify" && request.method === "POST") {
        const body = await readJson<{ manifestSha256: string; filesChecked: number; bytesChecked: number; failed: number }>(request);
        const current = this.readState();
        if (!current || !current.manifest_digest || body.manifestSha256 !== current.manifest_digest) return json({ error: "MANIFEST_MISMATCH" }, 409);
        const valid = Number(body.filesChecked) === current.manifest_count &&
          Number(body.bytesChecked) === current.manifest_bytes && Number(body.failed) === 0;
        if (!valid) return json({ error: "VERIFICATION_FAILED" }, 409);
        this.ctx.storage.sql.exec("UPDATE state SET verified = 1 WHERE id = 1");
        return json({ verified: true });
      }

      if (path === "/clear" && request.method === "POST") {
        const current = this.readState();
        if (!current || current.verified !== 1 || (current.status !== "completed" && current.status !== "cancelled") ||
            current.pending_pages !== 0 || current.pending_images !== 0 || current.bytes_reserved !== 0) {
          return json({ error: "VERIFIED_EXPORT_REQUIRED" }, 409);
        }
        await this.cleanExpiredPermits();
        const activeRows = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM permits WHERE expires_at > ?", Date.now()).toArray() as unknown as Array<{ count: number }>;
        if (Number(activeRows[0]?.count || 0) !== 0) return json({ error: "ACTIVE_WORKERS_REMAIN" }, 409);
        this.ctx.storage.sql.exec("UPDATE state SET status = 'clearing' WHERE id = 1");
        const prefix = "jobs/" + current.job_id + "/";
        let deletedObjects = 0;
        for (;;) {
          const page = await this.env.IMAGES.list({ prefix, limit: 1000 });
          if (page.objects.length === 0) break;
          await this.env.IMAGES.delete(page.objects.map(object => object.key));
          deletedObjects += page.objects.length;
        }
        const remaining = await this.env.IMAGES.list({ prefix, limit: 1 });
        if (remaining.objects.length > 0) return json({ error: "R2_PREFIX_NOT_EMPTY" }, 503);
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        return json({ cleared: true, deletedObjects, deletedJobState: true, r2PrefixVerifiedEmpty: true });
      }

      return json({ error: "NOT_FOUND" }, 404);
    } catch {
      return json({ error: "JOB_STATE_ERROR" }, 500);
    }
  }
}