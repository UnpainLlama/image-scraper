import { DurableObject } from "cloudflare:workers";
import { json, readJson } from "./http";
import type { Env, JobSettings, JobSnapshot, JobStatus, QueuePayload, StoredTaskPayload } from "./types";

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
  last_activity_at: number;
  abandoned_at: number | null;
  cleanup_at: number | null;
  clear_cursor: string | null;
  clear_deleted_objects: number;
  clear_deleted_bytes: number;
}
interface TaskRow {
  task_id: string;
  kind: "page" | "image";
  payload: string;
  state: "pending" | "leased" | "done" | "failed";
  lease_until: number;
  attempt_count: number;
  enqueued: number;
  next_attempt_at: number;
}
interface TaskItem { taskId: string; url: string; depth?: number; urlHash: string; }
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_TASK_LEASE_MS = 10 * 60 * 1000;
const TASK_RETRY_LIMIT = 12;
const TASK_REPUBLISH_MS = 5 * 60 * 1000;
const ABANDON_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const ABANDON_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export class JobDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

  private readState(): StateRow | null {
    try {
      const rows = this.ctx.storage.sql.exec("SELECT * FROM state WHERE id = 1").toArray() as unknown as StateRow[];
      return rows[0] || null;
    } catch { return null; }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.ctx.storage.sql.exec("PRAGMA table_info(" + table + ")").toArray() as unknown as Array<{ name: string }>;
    if (!rows.some(row => row.name === column)) this.ctx.storage.sql.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
  }

  private createSchema(): void {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), job_id TEXT NOT NULL, config TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, pages_discovered INTEGER NOT NULL DEFAULT 0, pages_completed INTEGER NOT NULL DEFAULT 0, pending_pages INTEGER NOT NULL DEFAULT 0, images_discovered INTEGER NOT NULL DEFAULT 0, images_downloaded INTEGER NOT NULL DEFAULT 0, images_stored INTEGER NOT NULL DEFAULT 0, failed_images INTEGER NOT NULL DEFAULT 0, pending_images INTEGER NOT NULL DEFAULT 0, bytes_stored INTEGER NOT NULL DEFAULT 0, bytes_reserved INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, manifest_digest TEXT, manifest_count INTEGER NOT NULL DEFAULT 0, manifest_bytes INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0, abandoned_at INTEGER, cleanup_at INTEGER, clear_cursor TEXT, clear_deleted_objects INTEGER NOT NULL DEFAULT 0, clear_deleted_bytes INTEGER NOT NULL DEFAULT 0)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pages (hash TEXT PRIMARY KEY)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS image_urls (hash TEXT PRIMARY KEY)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS content_claims (sha256 TEXT PRIMARY KEY, state TEXT NOT NULL, task_id TEXT NOT NULL, lease_until INTEGER NOT NULL, temp_key TEXT NOT NULL, final_key TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_until INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER NOT NULL DEFAULT 0, attempt_count INTEGER NOT NULL DEFAULT 0, enqueued INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, next_publish_at INTEGER NOT NULL DEFAULT 0, error_code TEXT)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS permits (permit_id TEXT PRIMARY KEY, domain TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS reservations (permit_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS domain_limits (domain TEXT PRIMARY KEY, next_allowed_at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS error_counts (code TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS reconcile_objects (sha256 TEXT PRIMARY KEY, final_key TEXT NOT NULL, size INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS reconcile_meta (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, lease_until INTEGER NOT NULL)");
    this.ensureColumn("state", "last_activity_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("state", "abandoned_at", "INTEGER");
    this.ensureColumn("state", "cleanup_at", "INTEGER");
    this.ensureColumn("state", "clear_cursor", "TEXT");
    this.ensureColumn("state", "clear_deleted_objects", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("state", "clear_deleted_bytes", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "payload", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("tasks", "state", "TEXT NOT NULL DEFAULT 'pending'");
    this.ensureColumn("tasks", "lease_until", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "enqueued", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "next_attempt_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "next_publish_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "error_code", "TEXT");
    const row = this.readState();
    if (row && !row.last_activity_at) this.ctx.storage.sql.exec("UPDATE state SET last_activity_at = created_at WHERE id = 1");
  }

  private getSettings(row: StateRow): JobSettings { return JSON.parse(row.config) as JobSettings; }
  private touch(): void { this.ctx.storage.sql.exec("UPDATE state SET last_activity_at = ? WHERE id = 1", Date.now()); }

  private async scheduleAlarm(delayMs = 60_000): Promise<void> {
    const target = Date.now() + Math.max(1000, delayMs);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > target) await this.ctx.storage.setAlarm(target);
  }

  private async scheduleNextAlarm(): Promise<void> {
    const row = this.readState();
    if (!row) return;
    const now = Date.now();
    const targets: number[] = [];
    if (row.status === "clearing" || row.status === "clearing_failed") {
      targets.push(now + 30_000);
    } else if (row.status === "abandoned") {
      if (row.cleanup_at) targets.push(row.cleanup_at);
    } else {
      targets.push(row.last_activity_at + ABANDON_AFTER_MS);
      const lease = this.ctx.storage.sql.exec("SELECT MIN(lease_until) AS at FROM tasks WHERE state = 'leased'").toArray() as unknown as Array<{ at: number | null }>;
      if (lease[0]?.at) targets.push(Number(lease[0].at));
      const claim = this.ctx.storage.sql.exec("SELECT MIN(lease_until) AS at FROM content_claims WHERE state = 'pending' AND lease_until > ?", now).toArray() as unknown as Array<{ at: number | null }>;
      if (claim[0]?.at) targets.push(Number(claim[0].at));
      if (row.status === "running") {
        const pending = this.ctx.storage.sql.exec(
          "SELECT MIN(CASE WHEN next_attempt_at > ? THEN next_attempt_at WHEN enqueued = 1 THEN next_publish_at ELSE ? END) AS at FROM tasks WHERE state = 'pending'",
          now, now
        ).toArray() as unknown as Array<{ at: number | null }>;
        if (pending[0]?.at) targets.push(Number(pending[0].at));
      }
    }
    if (!targets.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(now + 1000, Math.min(...targets)));
  }

  private async sweepTemporaryObjects(jobId: string): Promise<void> {
    const prefix = "tmp/jobs/" + jobId + "/";
    const cutoff = Date.now() - 10 * 60 * 1000;
    let cursor: string | undefined;
    do {
      const page = await this.env.IMAGES.list({ prefix, cursor, limit: 500 });
      for (const object of page.objects) {
        if (object.uploaded.getTime() > cutoff) continue;
        const taskId = object.key.slice(prefix.length);
        const liveTask = this.ctx.storage.sql.exec(
          "SELECT COUNT(*) AS count FROM tasks WHERE task_id = ? AND state = 'leased' AND lease_until > ?",
          taskId, Date.now()
        ).toArray() as unknown as Array<{ count: number }>;
        const liveClaim = this.ctx.storage.sql.exec(
          "SELECT COUNT(*) AS count FROM content_claims WHERE temp_key = ? AND state = 'pending' AND lease_until > ?",
          object.key, Date.now()
        ).toArray() as unknown as Array<{ count: number }>;
        if (Number(liveTask[0]?.count || 0) === 0 && Number(liveClaim[0]?.count || 0) === 0) {
          await this.env.IMAGES.delete(object.key);
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  private taskCounts(): { pending: number; leased: number; done: number; failed: number } {
    const rows = this.ctx.storage.sql.exec("SELECT state, COUNT(*) AS count FROM tasks GROUP BY state").toArray() as unknown as Array<{ state: string; count: number }>;
    const result = { pending: 0, leased: 0, done: 0, failed: 0 };
    for (const row of rows) if (row.state in result) result[row.state as keyof typeof result] = Number(row.count);
    return result;
  }

  private async snapshot(row: StateRow): Promise<JobSnapshot> {
    const errors = this.ctx.storage.sql.exec("SELECT code, count FROM error_counts ORDER BY code").toArray() as unknown as Array<{ code: string; count: number }>;
    const settings = this.getSettings(row);
    return {
      jobId: row.job_id, status: row.status, createdAt: row.created_at,
      pagesDiscovered: row.pages_discovered, pagesCompleted: row.pages_completed, pendingPages: row.pending_pages,
      imagesDiscovered: row.images_discovered, imagesDownloaded: row.images_downloaded, imagesStored: row.images_stored,
      failedImages: row.failed_images, pendingImages: row.pending_images, bytesStored: row.bytes_stored,
      bytesReserved: row.bytes_reserved, budgetBytes: settings.budgetBytes, concurrency: settings.concurrency,
      verified: row.verified === 1, failedByCode: errors, lastActivityAt: row.last_activity_at,
      abandonedAt: row.abandoned_at, cleanupAt: row.cleanup_at, taskCounts: this.taskCounts()
    };
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

  private async updateCompletion(): Promise<void> {
    const row = this.readState();
    if (!row || row.status !== "running") return;
    const tasks = this.taskCounts();
    const active = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM permits WHERE expires_at > ?", Date.now()).toArray() as unknown as Array<{ count: number }>;
    if (tasks.pending === 0 && tasks.leased === 0 && Number(active[0]?.count || 0) === 0 && row.bytes_reserved === 0) {
      this.ctx.storage.sql.exec("UPDATE state SET status = 'completed', last_activity_at = ? WHERE id = 1", Date.now());
    }
  }

  private addTask(item: TaskItem, kind: "page" | "image", depth: number): "accepted" | "duplicate" | "rejected" {
    const row = this.readState();
    if (!row || row.status === "cancelled" || row.status === "clearing" || row.status === "clearing_failed") return "rejected";
    if (!HASH_PATTERN.test(item.taskId) || !HASH_PATTERN.test(item.urlHash) || !item.url || item.url.length > 8192) return "rejected";
    const settings = this.getSettings(row);
    if (kind === "page") {
      if (depth < 0 || depth > settings.maxDepth || row.pages_discovered >= settings.maxPages) return "rejected";
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pages (hash) VALUES (?)", item.urlHash);
    } else {
      const maximum = settings.maxImagesPerJob || 50_000;
      if (row.images_discovered >= maximum) return "rejected";
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO image_urls (hash) VALUES (?)", item.urlHash);
    }
    const inserted = Number((this.ctx.storage.sql.exec("SELECT changes() AS n").toArray() as unknown as Array<{ n: number }>)[0]?.n || 0);
    if (!inserted) return "duplicate";
    const payload: StoredTaskPayload = kind === "page" ? { url: item.url, depth } : { url: item.url };
    this.ctx.storage.sql.exec("INSERT INTO tasks (task_id, kind, created_at, payload, state, next_attempt_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      item.taskId, kind, Date.now(), JSON.stringify(payload), Date.now());
    if (kind === "page") this.ctx.storage.sql.exec("UPDATE state SET pages_discovered = pages_discovered + 1, pending_pages = pending_pages + 1 WHERE id = 1");
    else this.ctx.storage.sql.exec("UPDATE state SET images_discovered = images_discovered + 1, pending_images = pending_images + 1 WHERE id = 1");
    return "accepted";
  }

  private markTask(taskId: string, result: "done" | "failed", code?: string): "completed" | "already_terminal" | "not_found" {
    const rows = this.ctx.storage.sql.exec("SELECT kind, state FROM tasks WHERE task_id = ?", taskId).toArray() as unknown as Array<{ kind: "page" | "image"; state: string }>;
    const task = rows[0];
    if (!task) return "not_found";
    if (task.state === "done" || task.state === "failed") return "already_terminal";
    this.ctx.storage.sql.exec("UPDATE tasks SET state = ?, lease_until = 0, enqueued = 0, error_code = ? WHERE task_id = ?", result, code || null, taskId);
    if (task.kind === "page") {
      this.ctx.storage.sql.exec("UPDATE state SET pending_pages = MAX(0, pending_pages - ?), pages_completed = pages_completed + ? WHERE id = 1",
        1, result === "done" ? 1 : 0);
    } else {
      this.ctx.storage.sql.exec("UPDATE state SET pending_images = MAX(0, pending_images - ?), images_downloaded = images_downloaded + ?, failed_images = failed_images + ? WHERE id = 1",
        1, result === "done" ? 1 : 0, result === "failed" ? 1 : 0);
    }
    if (code) {
      const safe = /^[A-Z0-9_]{1,50}$/.test(code) ? code : "UNKNOWN_ERROR";
      this.ctx.storage.sql.exec("INSERT INTO error_counts (code, count) VALUES (?, 1) ON CONFLICT(code) DO UPDATE SET count = count + 1", safe);
    }
    this.touch();
    return "completed";
  }

  private async publishPendingTasks(): Promise<void> {
    const row = this.readState();
    if (!row || row.status !== "running") return;
    const now = Date.now();
    const tasks = this.ctx.storage.sql.exec(
      "SELECT task_id, kind FROM tasks WHERE state = 'pending' AND next_attempt_at <= ? AND (enqueued = 0 OR next_publish_at <= ?) ORDER BY created_at LIMIT 2000",
      now, now
    ).toArray() as unknown as Array<{ task_id: string; kind: "page" | "image" }>;
    for (const kind of ["page", "image"] as const) {
      const selected = tasks.filter(task => task.kind === kind);
      const producer = kind === "page" ? this.env.DISCOVERY_QUEUE : this.env.DOWNLOAD_QUEUE;
      for (let start = 0; start < selected.length; start += 100) {
        const batch = selected.slice(start, start + 100);
        if (!batch.length) continue;
        try {
          await producer.sendBatch(batch.map(task => ({ body: { jobId: row.job_id, taskId: task.task_id } as QueuePayload })));
          const next = Date.now() + TASK_REPUBLISH_MS;
          for (const task of batch) this.ctx.storage.sql.exec(
            "UPDATE tasks SET enqueued = 1, next_publish_at = ? WHERE task_id = ? AND state = 'pending'", next, task.task_id
          );
        } catch {
          const backoff = Math.min(15 * 60_000, 15_000 * Math.max(1, Math.min(60, batch.length)));
          const retryAt = Date.now() + backoff;
          for (const task of batch) this.ctx.storage.sql.exec(
            "UPDATE tasks SET enqueued = 0, next_attempt_at = ?, next_publish_at = 0 WHERE task_id = ? AND state = 'pending'",
            retryAt, task.task_id
          );
          await this.scheduleAlarm(backoff);
          return;
        }
      }
    }
    const next = this.ctx.storage.sql.exec(
      "SELECT MIN(CASE WHEN next_attempt_at > ? THEN next_attempt_at WHEN enqueued = 1 THEN next_publish_at ELSE ? END) AS at FROM tasks WHERE state = 'pending'",
      Date.now(), Date.now()
    ).toArray() as unknown as Array<{ at: number | null }>;
    if (next[0]?.at) await this.scheduleAlarm(Math.max(1000, Number(next[0].at) - Date.now()));
  }

  private async clearJob(): Promise<{ cleared: true; deletedObjects: number; deletedBytes: number; r2PrefixVerifiedEmpty: true }> {
    const row = this.readState();
    if (!row) throw new Error("JOB_NOT_FOUND");
    const jobPrefix = "jobs/" + row.job_id + "/";
    const tempPrefix = "tmp/jobs/" + row.job_id + "/";
    let phase: "jobs" | "tmp" = "jobs";
    let cursor: string | undefined;
    if (row.clear_cursor) {
      try {
        const saved = JSON.parse(row.clear_cursor) as { phase?: string; cursor?: string | null };
        if (saved.phase === "tmp" || saved.phase === "jobs") {
          phase = saved.phase;
          cursor = saved.cursor || undefined;
        } else {
          cursor = row.clear_cursor;
        }
      } catch {
        cursor = row.clear_cursor;
      }
    }
    const saveCursor = (nextPhase: "jobs" | "tmp" | null, nextCursor?: string): void => {
      const value = nextPhase ? JSON.stringify({ phase: nextPhase, cursor: nextCursor || null }) : null;
      this.ctx.storage.sql.exec("UPDATE state SET clear_cursor = ? WHERE id = 1", value);
    };
    try {
      for (const currentPhase of ["jobs", "tmp"] as const) {
        if (currentPhase < phase) continue;
        const prefix = currentPhase === "jobs" ? jobPrefix : tempPrefix;
        let pageCursor = currentPhase === phase ? cursor : undefined;
        for (;;) {
          const page = await this.env.IMAGES.list({ prefix, cursor: pageCursor, limit: 500 });
          if (page.objects.length) {
            const keys = page.objects.map(object => object.key);
            const bytes = page.objects.reduce((sum, object) => sum + object.size, 0);
            await this.env.IMAGES.delete(keys);
            this.ctx.storage.sql.exec(
              "UPDATE state SET clear_deleted_objects = clear_deleted_objects + ?, clear_deleted_bytes = clear_deleted_bytes + ? WHERE id = 1",
              keys.length, bytes
            );
          }
          if (page.truncated) {
            pageCursor = page.cursor || undefined;
            saveCursor(currentPhase, pageCursor);
          } else {
            saveCursor(currentPhase === "jobs" ? "tmp" : null);
            break;
          }
        }
      }
      const remainingJobs = await this.env.IMAGES.list({ prefix: jobPrefix, limit: 1 });
      const remainingTemp = await this.env.IMAGES.list({ prefix: tempPrefix, limit: 1 });
      if (remainingJobs.objects.length || remainingTemp.objects.length) throw new Error("R2_PREFIX_NOT_EMPTY");
      const final = this.readState();
      const deletedObjects = Number(final?.clear_deleted_objects || 0);
      const deletedBytes = Number(final?.clear_deleted_bytes || 0);
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return { cleared: true, deletedObjects, deletedBytes, r2PrefixVerifiedEmpty: true };
    } catch {
      this.ctx.storage.sql.exec(
        "UPDATE state SET status = 'clearing_failed', clear_cursor = ?, last_activity_at = ? WHERE id = 1",
        JSON.stringify({ phase, cursor: cursor || null }), Date.now()
      );
      await this.scheduleAlarm(30_000);
      throw new Error("R2_DELETE_FAILED");
    }
  }

  async alarm(): Promise<void> {
    const row = this.readState();
    if (!row) return;
    if (row.status === "clearing" || row.status === "clearing_failed") {
      try { await this.clearJob(); } catch { await this.scheduleAlarm(60_000); }
      return;
    }
    const now = Date.now();
    await this.cleanExpiredPermits();
    this.ctx.storage.sql.exec("UPDATE tasks SET state = 'pending', lease_until = 0, enqueued = 0, next_attempt_at = ?, next_publish_at = 0 WHERE state = 'leased' AND lease_until <= ?", now, now);
    const current = this.readState();
    if (!current) return;
    await this.sweepTemporaryObjects(current.job_id);
    if (current.status !== "abandoned" && now - current.last_activity_at >= ABANDON_AFTER_MS) {
      this.ctx.storage.sql.exec("UPDATE state SET status = 'abandoned', abandoned_at = ?, cleanup_at = ? WHERE id = 1", now, now + ABANDON_GRACE_MS);
    }
    const updated = this.readState();
    if (updated?.status === "abandoned" && updated.cleanup_at && now >= updated.cleanup_at) {
      await this.clearJob();
      return;
    }
    if (updated?.status === "running") {
      await this.publishPendingTasks();
      await this.updateCompletion();
    }
    await this.scheduleNextAlarm();
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
          body.budgetBytes < 1 || !/^https?:\/\/[^/]+$/.test(body.allowedOrigin)) return json({ error: "INVALID_JOB_SETTINGS" }, 400);
        this.createSchema();
        this.ctx.storage.sql.exec("INSERT INTO state (id, job_id, config, status, created_at, last_activity_at) VALUES (1, ?, ?, 'initializing', ?, ?)",
          body.jobId, JSON.stringify(body), Date.now(), Date.now());
        await this.scheduleAlarm(24 * 60 * 60 * 1000);
        return json({ initialized: true });
      }

      const row = this.readState();
      if (!row) return json({ error: "JOB_NOT_FOUND" }, 404);
      if (path === "/snapshot" && request.method === "GET") return json(await this.snapshot(row));
      if (path === "/settings" && request.method === "GET") return json(this.getSettings(row));

      if (path === "/start" && request.method === "POST") {
        if (row.status !== "initializing") return json({ error: "JOB_NOT_INITIALIZING" }, 409);
        this.ctx.storage.sql.exec("UPDATE state SET status = 'running', last_activity_at = ? WHERE id = 1", Date.now());
        await this.publishPendingTasks();
        await this.updateCompletion();
        return json({ status: this.readState()?.status || "running" });
      }

      if (path === "/register-pages" && request.method === "POST") {
        const body = await readJsonLimit<{ items: TaskItem[] }>(request, 1_500_000);
        if (!Array.isArray(body.items) || body.items.length > 500) return json({ result: "rejected", reason: "INVALID_BATCH" }, 400);
        await this.scheduleAlarm(60_000);
        const results: Array<{ taskId: string; result: string }> = [];
        this.ctx.storage.transactionSync(() => {
          for (const item of body.items) results.push({ taskId: item.taskId, result: this.addTask(item, "page", Number(item.depth || 0)) });
          this.touch();
        });
        await this.publishPendingTasks();
        return json({ result: "accepted", items: results });
      }

      if (path === "/page/complete" && request.method === "POST") {
        const body = await readJsonLimit<{ taskId: string; images: TaskItem[]; pages: TaskItem[] }>(request, 1_500_000);
        if (!HASH_PATTERN.test(body.taskId) || !Array.isArray(body.images) || !Array.isArray(body.pages) ||
          body.images.length > 2000 || body.pages.length > 2000) return json({ result: "rejected", reason: "INVALID_DISCOVERY_BATCH" }, 400);
        const results: Array<{ taskId: string; kind: string; result: string }> = [];
        let rejected = false;
        let parentResult = "done";
        await this.scheduleAlarm(60_000);
        this.ctx.storage.transactionSync(() => {
          const parentRows = this.ctx.storage.sql.exec("SELECT state FROM tasks WHERE task_id = ?", body.taskId).toArray() as unknown as Array<{ state: string }>;
          const parentState = parentRows[0]?.state;
          if (!parentState) { parentResult = "not_found"; return; }
          if (parentState === "done" || parentState === "failed") { parentResult = "already_terminal"; return; }
          if (parentState !== "leased") { parentResult = "not_leased"; return; }
          for (const item of body.images) {
            const result = this.addTask(item, "image", 0);
            results.push({ taskId: item.taskId, kind: "image", result });
            if (result === "rejected") rejected = true;
          }
          for (const item of body.pages) {
            const result = this.addTask(item, "page", Number(item.depth || 0));
            results.push({ taskId: item.taskId, kind: "page", result });
            if (result === "rejected") rejected = true;
          }
          parentResult = this.markTask(body.taskId, rejected ? "failed" : "done", rejected ? "DISCOVERY_LIMIT_REACHED" : undefined);
        });
        if (parentResult === "not_found" || parentResult === "not_leased") {
          return json({ result: "rejected", reason: parentResult === "not_found" ? "PARENT_TASK_NOT_FOUND" : "PARENT_TASK_NOT_LEASED" }, 409);
        }
        if (parentResult === "already_terminal") return json({ result: "already_terminal", parent: "done", items: [] });
        await this.publishPendingTasks();
        await this.updateCompletion();
        return json({ result: rejected ? "rejected" : "accepted", items: results, parent: rejected ? "failed" : "done" });
      }

      if (path === "/task/lease" && request.method === "POST") {
        const body = await readJson<{ taskId: string }>(request);
        if (!HASH_PATTERN.test(body.taskId)) return json({ result: "rejected", reason: "INVALID_TASK_ID" }, 400);
        const current = this.readState();
        const tasks = this.ctx.storage.sql.exec("SELECT * FROM tasks WHERE task_id = ?", body.taskId).toArray() as unknown as TaskRow[];
        const task = tasks[0];
        if (!task) return json({ result: "terminal" });
        if (task.state === "done" || task.state === "failed") return json({ result: "terminal" });
        if (!current || current.status === "cancelled" || current.status === "abandoned" || current.status === "clearing" || current.status === "clearing_failed") {
          this.markTask(body.taskId, "failed", "JOB_STOPPED");
          return json({ result: "terminal" });
        }
        if (current.status !== "running") {
          this.ctx.storage.sql.exec("UPDATE tasks SET enqueued = 0 WHERE task_id = ?", body.taskId);
          return json({ result: "paused", status: current.status });
        }
        const now = Date.now();
        if (task.state === "leased" && task.lease_until > now) return json({ result: "busy" });
        if (task.next_attempt_at > now) return json({ result: "deferred" });
        if (task.attempt_count >= TASK_RETRY_LIMIT) {
          this.markTask(body.taskId, "failed", "TASK_RETRY_LIMIT");
          await this.updateCompletion();
          return json({ result: "terminal" });
        }
        const leaseUntil = now + MAX_TASK_LEASE_MS;
        this.ctx.storage.sql.exec("UPDATE tasks SET state = 'leased', lease_until = ?, attempt_count = attempt_count + 1, enqueued = 0 WHERE task_id = ?",
          leaseUntil, body.taskId);
        await this.scheduleAlarm(MAX_TASK_LEASE_MS);
        return json({ result: "leased", kind: task.kind, payload: JSON.parse(task.payload) as StoredTaskPayload, leaseUntil });
      }

      if (path === "/task/complete" && request.method === "POST") {
        const body = await readJson<{ taskId: string; result: "success" | "failed" | "cancelled"; code?: string }>(request);
        if (!HASH_PATTERN.test(body.taskId)) return json({ result: "rejected", reason: "INVALID_TASK_ID" }, 400);
        const status = this.ctx.storage.sql.exec("SELECT state FROM tasks WHERE task_id = ?", body.taskId).toArray() as unknown as Array<{ state: string }>;
        const terminal = this.ctx.storage.sql.exec("SELECT state FROM tasks WHERE task_id = ?", body.taskId).toArray() as unknown as Array<{ state: string }>;
        if (!terminal.length) return json({ result: "rejected", reason: "TASK_NOT_FOUND" }, 404);
        const outcome = this.markTask(body.taskId, body.result === "success" ? "done" : "failed", body.code);
        await this.updateCompletion();
        return json({ result: outcome, state: status[0]?.state || "unknown" });
      }

      if (path === "/task/retry" && request.method === "POST") {
        const body = await readJson<{ taskId: string; code: string; retryable: boolean; delaySeconds?: number }>(request);
        if (!HASH_PATTERN.test(body.taskId)) return json({ result: "rejected", reason: "INVALID_TASK_ID" }, 400);
        const tasks = this.ctx.storage.sql.exec("SELECT attempt_count, state FROM tasks WHERE task_id = ?", body.taskId).toArray() as unknown as Array<{ attempt_count: number; state: string }>;
        if (!tasks.length) return json({ result: "rejected", reason: "TASK_NOT_FOUND" }, 404);
        if (tasks[0]!.state === "done" || tasks[0]!.state === "failed") return json({ result: "already_terminal" });
        const code = /^[A-Z0-9_]{1,50}$/.test(body.code) ? body.code : "UNKNOWN_ERROR";
        if (!body.retryable || Number(tasks[0]!.attempt_count) >= TASK_RETRY_LIMIT) {
          const outcome = this.markTask(body.taskId, "failed", code);
          await this.updateCompletion();
          return json({ result: outcome, state: "failed" });
        }
        const seconds = Math.min(900, Math.max(1, Number(body.delaySeconds || Math.min(300, 2 ** Number(tasks[0]!.attempt_count)))));
        const next = Date.now() + seconds * 1000;
        this.ctx.storage.sql.exec("UPDATE tasks SET state = 'pending', lease_until = 0, enqueued = 0, next_attempt_at = ?, next_publish_at = 0, error_code = ? WHERE task_id = ?",
          next, code, body.taskId);
        const existing = await this.ctx.storage.getAlarm();
        if (existing === null || existing > next) await this.ctx.storage.setAlarm(next);
        return json({ result: "accepted", state: "pending", retryAt: next });
      }

      if (path === "/permit/acquire" && request.method === "POST") {
        const body = await readJson<{ domain: string; crawlDelayMs?: number }>(request);
        const domain = String(body.domain || "").toLowerCase().slice(0, 255);
        if (!domain) return json({ error: "INVALID_DOMAIN" }, 400);
        await this.cleanExpiredPermits();
        const current = this.readState();
        if (!current || current.status !== "running") return json({ allowed: false, status: current?.status || "missing" });
        const now = Date.now();
        const activeRows = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM permits WHERE expires_at > ?", now).toArray() as unknown as Array<{ count: number }>;
        if (Number(activeRows[0]?.count || 0) >= this.getSettings(current).concurrency) return json({ allowed: false, retryAfterMs: 1500, status: current.status });
        const limits = this.ctx.storage.sql.exec("SELECT next_allowed_at FROM domain_limits WHERE domain = ?", domain).toArray() as unknown as Array<{ next_allowed_at: number }>;
        const nextAt = Number(limits[0]?.next_allowed_at || 0);
        if (nextAt > now) return json({ allowed: false, retryAfterMs: Math.min(30_000, nextAt - now), status: current.status });
        const settings = this.getSettings(current);
        const delay = Math.max(settings.perDomainDelayMs, Math.min(30_000, Math.max(0, Number(body.crawlDelayMs || 0))));
        const permitId = crypto.randomUUID();
        this.ctx.storage.sql.exec("INSERT INTO permits (permit_id, domain, expires_at) VALUES (?, ?, ?)", permitId, domain, now + MAX_TASK_LEASE_MS);
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
        if (!/^[0-9a-f-]{36}$/i.test(body.permitId) || !Number.isSafeInteger(amount) || amount < 1 || amount > 50 * 1024 * 1024) return json({ allowed: false });
        const current = this.readState();
        if (!current || current.status !== "running") return json({ allowed: false, status: current?.status || "missing" });
        const active = this.ctx.storage.sql.exec("SELECT expires_at FROM permits WHERE permit_id = ?", body.permitId).toArray() as unknown as Array<{ expires_at: number }>;
        if (!active.length || Number(active[0]?.expires_at || 0) <= Date.now()) return json({ allowed: false, status: "permit-expired" });
        const settings = this.getSettings(current);
        if (current.bytes_stored + current.bytes_reserved + amount > settings.budgetBytes) {
          this.ctx.storage.sql.exec("UPDATE state SET status = 'budget-paused' WHERE id = 1");
          return json({ allowed: false, status: "budget-paused" });
        }
        this.ctx.storage.sql.exec("INSERT INTO reservations (permit_id, bytes, expires_at) VALUES (?, ?, ?) ON CONFLICT(permit_id) DO UPDATE SET bytes = bytes + excluded.bytes, expires_at = excluded.expires_at",
          body.permitId, amount, Number(active[0]?.expires_at || 0));
        this.ctx.storage.sql.exec("UPDATE state SET bytes_reserved = bytes_reserved + ? WHERE id = 1", amount);
        return json({ allowed: true });
      }

      if (path === "/reservation/release" && request.method === "POST") {
        const body = await readJson<{ permitId: string }>(request);
        const reservation = this.ctx.storage.sql.exec("SELECT bytes FROM reservations WHERE permit_id = ?", body.permitId).toArray() as unknown as Array<{ bytes: number }>;
        const reserved = Number(reservation[0]?.bytes || 0);
        if (reserved) this.ctx.storage.sql.exec("UPDATE state SET bytes_reserved = MAX(0, bytes_reserved - ?) WHERE id = 1", reserved);
        this.ctx.storage.sql.exec("DELETE FROM reservations WHERE permit_id = ?", body.permitId);
        return json({ released: true });
      }

      if (path === "/storage/reconcile/start" && request.method === "POST") {
        const body = await readJson<{ token: string }>(request);
        if (typeof body.token !== "string" || body.token.length < 16 || body.token.length > 128) {
          return json({ result: "rejected", reason: "INVALID_RECONCILE_TOKEN" }, 400);
        }
        await this.cleanExpiredPermits();
        const current = this.readState();
        const tasks = this.taskCounts();
        const permits = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM permits WHERE expires_at > ?", Date.now()).toArray() as unknown as Array<{ count: number }>;
        if (!current || !["completed", "cancelled", "paused", "budget-paused", "verified"].includes(current.status) ||
          tasks.leased !== 0 || Number(permits[0]?.count || 0) !== 0 || current.bytes_reserved !== 0) {
          return json({ result: "rejected", reason: "JOB_NOT_QUIESCENT" }, 409);
        }
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("DELETE FROM reconcile_objects");
          this.ctx.storage.sql.exec("INSERT INTO reconcile_meta (id, token, lease_until) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token, lease_until = excluded.lease_until",
            body.token, Date.now() + 15 * 60 * 1000);
          this.touch();
        });
        return json({ result: "accepted" });
      }

      if (path === "/storage/reconcile/batch" && request.method === "POST") {
        const body = await readJsonLimit<{ token: string; items: Array<{ sha256: string; key: string; size: number }> }>(request, 128_000);
        if (!Array.isArray(body.items) || body.items.length > 250) return json({ result: "rejected", reason: "INVALID_RECONCILE_BATCH" }, 400);
        const meta = this.ctx.storage.sql.exec("SELECT token, lease_until FROM reconcile_meta WHERE id = 1").toArray() as unknown as Array<{ token: string; lease_until: number }>;
        if (!meta.length || meta[0]!.token !== body.token || Number(meta[0]!.lease_until) <= Date.now()) {
          return json({ result: "rejected", reason: "RECONCILE_SESSION_EXPIRED" }, 409);
        }
        const jobPrefix = "jobs/" + row.job_id + "/objects/";
        for (const item of body.items) {
          const expected = jobPrefix + item.sha256;
          if (!HASH_PATTERN.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 ||
            !item.key.startsWith(expected + ".") || !/\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/.test(item.key.slice(expected.length))) {
            return json({ result: "rejected", reason: "INVALID_RECONCILE_OBJECT" }, 400);
          }
        }
        this.ctx.storage.transactionSync(() => {
          for (const item of body.items) {
            this.ctx.storage.sql.exec("INSERT OR REPLACE INTO reconcile_objects (sha256, final_key, size) VALUES (?, ?, ?)",
              item.sha256, item.key, item.size);
          }
          this.ctx.storage.sql.exec("UPDATE reconcile_meta SET lease_until = ? WHERE id = 1 AND token = ?",
            Date.now() + 15 * 60 * 1000, body.token);
        });
        return json({ result: "accepted", count: body.items.length });
      }

      if (path === "/storage/reconcile/finish" && request.method === "POST") {
        const body = await readJson<{ token: string }>(request);
        const meta = this.ctx.storage.sql.exec("SELECT token, lease_until FROM reconcile_meta WHERE id = 1").toArray() as unknown as Array<{ token: string; lease_until: number }>;
        if (!meta.length || meta[0]!.token !== body.token || Number(meta[0]!.lease_until) <= Date.now()) {
          return json({ result: "rejected", reason: "RECONCILE_SESSION_EXPIRED" }, 409);
        }
        const now = Date.now();
        let objects = 0;
        let bytes = 0;
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "UPDATE content_claims SET state = 'failed', lease_until = 0, updated_at = ? WHERE state IN ('stored','pending') AND sha256 NOT IN (SELECT sha256 FROM reconcile_objects)",
            now
          );
          this.ctx.storage.sql.exec(
            "INSERT INTO content_claims (sha256, state, task_id, lease_until, temp_key, final_key, size, updated_at) SELECT sha256, 'stored', 'reconciler', 0, '', final_key, size, ? FROM reconcile_objects WHERE 1 ON CONFLICT(sha256) DO UPDATE SET state = 'stored', task_id = 'reconciler', lease_until = 0, temp_key = '', final_key = excluded.final_key, size = excluded.size, updated_at = excluded.updated_at",
            now
          );
          const totals = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM reconcile_objects").toArray() as unknown as Array<{ count: number; bytes: number }>;
          objects = Number(totals[0]?.count || 0);
          bytes = Number(totals[0]?.bytes || 0);
          this.ctx.storage.sql.exec("UPDATE state SET bytes_stored = ?, images_stored = ?, bytes_reserved = 0, last_activity_at = ? WHERE id = 1",
            bytes, objects, now);
          this.ctx.storage.sql.exec("DELETE FROM reconcile_meta WHERE id = 1 AND token = ?", body.token);
          this.touch();
        });
        return json({ result: "reconciled", objects, bytes });
      }

      if (path === "/content/claim" && request.method === "POST") {
        const body = await readJson<{ sha256: string; taskId: string; tempKey: string; finalKey: string; size: number }>(request);
        if (!HASH_PATTERN.test(body.sha256) || !HASH_PATTERN.test(body.taskId) || !body.tempKey.startsWith("tmp/jobs/") || !body.finalKey.startsWith("jobs/")) return json({ error: "INVALID_CONTENT_CLAIM" }, 400);
        const now = Date.now();
        const rows = this.ctx.storage.sql.exec("SELECT * FROM content_claims WHERE sha256 = ?", body.sha256).toArray() as unknown as Array<{ state: string; task_id: string; lease_until: number }>;
        const existing = rows[0];
        if (existing?.state === "stored") return json({ result: "stored" });
        if (existing?.state === "pending" && existing.lease_until > now && existing.task_id !== body.taskId) return json({ result: "in_progress" });
        const takeover = !!existing;
        this.ctx.storage.sql.exec("INSERT INTO content_claims (sha256, state, task_id, lease_until, temp_key, final_key, size, updated_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET state = 'pending', task_id = excluded.task_id, lease_until = excluded.lease_until, temp_key = excluded.temp_key, final_key = excluded.final_key, size = excluded.size, updated_at = excluded.updated_at",
          body.sha256, body.taskId, now + MAX_TASK_LEASE_MS, body.tempKey, body.finalKey, body.size, now);
        await this.scheduleAlarm(MAX_TASK_LEASE_MS);
        return json({ result: takeover ? "takeover" : "claimed" });
      }

      if (path === "/content/commit" && request.method === "POST") {
        const body = await readJson<{ sha256: string; taskId: string; permitId: string; size: number }>(request);
        if (!HASH_PATTERN.test(body.sha256) || !HASH_PATTERN.test(body.taskId)) return json({ error: "INVALID_CONTENT_COMMIT" }, 400);
        let committed = false;
        this.ctx.storage.transactionSync(() => {
          const rows = this.ctx.storage.sql.exec("SELECT state, task_id FROM content_claims WHERE sha256 = ?", body.sha256).toArray() as unknown as Array<{ state: string; task_id: string }>;
          const claim = rows[0];
          if (!claim) return;
          if (claim.state === "stored") { committed = true; return; }
          if (claim.task_id !== body.taskId) return;
          const reservations = this.ctx.storage.sql.exec("SELECT bytes FROM reservations WHERE permit_id = ?", body.permitId).toArray() as unknown as Array<{ bytes: number }>;
          const reserved = Number(reservations[0]?.bytes || 0);
          const size = Math.max(0, Math.floor(Number(body.size)));
          this.ctx.storage.sql.exec("UPDATE content_claims SET state = 'stored', size = ?, lease_until = 0, updated_at = ? WHERE sha256 = ?", size, Date.now(), body.sha256);
          this.ctx.storage.sql.exec("DELETE FROM reservations WHERE permit_id = ?", body.permitId);
          this.ctx.storage.sql.exec("UPDATE state SET bytes_reserved = MAX(0, bytes_reserved - ?), bytes_stored = bytes_stored + ?, images_stored = images_stored + 1, last_activity_at = ? WHERE id = 1",
            reserved, size, Date.now());
          committed = true;
        });
        if (!committed) return json({ result: "rejected", reason: "CLAIM_NOT_OWNED" }, 409);
        return json({ result: "stored" });
      }

      if (path === "/content/release" && request.method === "POST") {
        const body = await readJson<{ sha256: string; taskId?: string }>(request);
        if (HASH_PATTERN.test(body.sha256)) this.ctx.storage.sql.exec("UPDATE content_claims SET lease_until = 0, updated_at = ? WHERE sha256 = ? AND state = 'pending' AND (? IS NULL OR task_id = ?)",
          Date.now(), body.sha256, body.taskId || null, body.taskId || null);
        return json({ released: true });
      }

      if (path === "/pause" && request.method === "POST") {
        if (row.status === "running") this.ctx.storage.sql.exec("UPDATE state SET status = 'paused', verified = 0 WHERE id = 1");
        this.touch();
        return json({ status: this.readState()?.status });
      }

      if (path === "/resume" && request.method === "POST") {
        const body = await readJson<{ budgetBytes?: number }>(request);
        const current = this.readState();
        if (!current || !["paused", "budget-paused", "verified"].includes(current.status)) return json({ error: "JOB_NOT_RESUMABLE" }, 409);
        this.ctx.storage.sql.exec("DELETE FROM reconcile_meta WHERE lease_until <= ?", Date.now());
        const reconciliation = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM reconcile_meta").toArray() as unknown as Array<{ count: number }>;
        if (Number(reconciliation[0]?.count || 0) > 0) return json({ error: "STORAGE_RECONCILIATION_IN_PROGRESS" }, 409);
        const settings = this.getSettings(current);
        if (body.budgetBytes !== undefined) {
          const nextBudget = Math.floor(Number(body.budgetBytes));
          if (!Number.isSafeInteger(nextBudget) || nextBudget <= current.bytes_stored + current.bytes_reserved) return json({ error: "BUDGET_TOO_SMALL" }, 400);
          settings.budgetBytes = nextBudget;
          this.ctx.storage.sql.exec("UPDATE state SET config = ? WHERE id = 1", JSON.stringify(settings));
        }
        this.ctx.storage.sql.exec("UPDATE tasks SET enqueued = 0, next_attempt_at = 0, next_publish_at = 0 WHERE state = 'pending'");
        this.ctx.storage.sql.exec("UPDATE state SET status = 'running', verified = 0, abandoned_at = NULL, cleanup_at = NULL, last_activity_at = ? WHERE id = 1", Date.now());
        await this.publishPendingTasks();
        return json({ status: "running" });
      }

      if (path === "/cancel" && request.method === "POST") {
        if (["clearing", "clearing_failed"].includes(row.status)) return json({ error: "JOB_CLEARING" }, 409);
        this.ctx.storage.sql.exec("UPDATE state SET status = 'cancelled', verified = 0, last_activity_at = ? WHERE id = 1", Date.now());
        const pending = this.ctx.storage.sql.exec("SELECT task_id FROM tasks WHERE state IN ('pending','leased')").toArray() as unknown as Array<{ task_id: string }>;
        for (const task of pending) this.markTask(task.task_id, "failed", "JOB_CANCELLED");
        return json({ status: "cancelled" });
      }

      if (path === "/manifest" && request.method === "POST") {
        const body = await readJson<{ digest: string; count: number; bytes: number }>(request);
        if (!HASH_PATTERN.test(body.digest)) return json({ error: "INVALID_MANIFEST_DIGEST" }, 400);
        const current = this.readState();
        if (!current || !["completed", "cancelled", "paused", "budget-paused", "verified"].includes(current.status) ||
          current.bytes_reserved !== 0) return json({ error: "JOB_NOT_READY_FOR_EXPORT" }, 409);
        await this.cleanExpiredPermits();
        const activeRows = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM permits WHERE expires_at > ?", Date.now()).toArray() as unknown as Array<{ count: number }>;
        const tasks = this.taskCounts();
        if (Number(activeRows[0]?.count || 0) !== 0 || tasks.leased !== 0 ||
          ((current.status === "completed" || current.status === "cancelled") && tasks.pending !== 0)) {
          return json({ error: "ACTIVE_WORKERS_REMAIN" }, 409);
        }
        this.ctx.storage.sql.exec("UPDATE state SET manifest_digest = ?, manifest_count = ?, manifest_bytes = ?, verified = 0 WHERE id = 1",
          body.digest, Math.max(0, Math.floor(body.count)), Math.max(0, Math.floor(body.bytes)));
        return json({ result: "accepted" });
      }

      if (path === "/verify" && request.method === "POST") {
        const body = await readJson<{ manifestSha256: string; filesChecked: number; bytesChecked: number; failed: number }>(request);
        const current = this.readState();
        if (!current || !current.manifest_digest || body.manifestSha256 !== current.manifest_digest) return json({ error: "MANIFEST_MISMATCH" }, 409);
        const valid = Number(body.filesChecked) === current.manifest_count &&
          Number(body.bytesChecked) === current.manifest_bytes && Number(body.failed) === 0;
        if (!valid) return json({ error: "ATTESTATION_FAILED" }, 409);
        this.ctx.storage.sql.exec("UPDATE state SET verified = 1, status = 'verified', last_activity_at = ? WHERE id = 1", Date.now());
        return json({ verified: true, kind: "attested_by_local_script" });
      }

      if (path === "/clear" && request.method === "POST") {
        const current = this.readState();
        if (!current || !["completed", "cancelled", "verified", "abandoned", "clearing", "clearing_failed"].includes(current.status)) return json({ error: "JOB_NOT_CLEARABLE" }, 409);
        if (current.status !== "abandoned" && current.verified !== 1) return json({ error: "VERIFIED_EXPORT_REQUIRED" }, 409);
        this.ctx.storage.sql.exec("DELETE FROM reconcile_meta WHERE lease_until <= ?", Date.now());
        const reconciliation = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM reconcile_meta").toArray() as unknown as Array<{ count: number }>;
        if (Number(reconciliation[0]?.count || 0) > 0) return json({ error: "STORAGE_RECONCILIATION_IN_PROGRESS" }, 409);
        const tasks = this.taskCounts();
        if (current.status !== "abandoned" && (tasks.pending !== 0 || tasks.leased !== 0 ||
          current.pending_pages !== 0 || current.pending_images !== 0 || current.bytes_reserved !== 0)) {
          return json({ error: "JOB_WORK_NOT_DRAINED" }, 409);
        }
        await this.cleanExpiredPermits();
        const activeRows = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM permits WHERE expires_at > ?", Date.now()).toArray() as unknown as Array<{ count: number }>;
        if (Number(activeRows[0]?.count || 0) !== 0) return json({ error: "ACTIVE_WORKERS_REMAIN" }, 409);
        this.ctx.storage.sql.exec("UPDATE state SET status = 'clearing', last_activity_at = ? WHERE id = 1", Date.now());
        const receipt = await this.clearJob();
        return json({ ...receipt, deletedJobState: true });
      }

      return json({ error: "NOT_FOUND" }, 404);
    } catch (error) {
      if (path === "/clear") {
        const current = this.readState();
        if (current) {
          this.ctx.storage.sql.exec("UPDATE state SET status = 'clearing_failed' WHERE id = 1");
          await this.scheduleAlarm(30_000);
        }
        return json({ error: "R2_DELETE_FAILED" }, 503);
      }
      return json({ error: "JOB_STATE_ERROR" }, 500);
    }
  }
}

async function readJsonLimit<T>(request: Request, maximumBytes: number): Promise<T> {
  const length = Number(request.headers.get("content-length") || "0");
  if (length > maximumBytes) throw new Error("REQUEST_TOO_LARGE");
  const text = await request.text();
  if (text.length > maximumBytes) throw new Error("REQUEST_TOO_LARGE");
  return JSON.parse(text) as T;
}
