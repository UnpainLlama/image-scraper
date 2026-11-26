import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";

const bindings = env as unknown as Env;
const hash = (character: string) => character.repeat(64);

function newJobId(): string {
  return "test-" + crypto.randomUUID().replace(/-/g, "");
}

function task(taskId: string, urlHash: string, url: string, depth = 0) {
  return { taskId, urlHash, url, depth };
}

async function request(stub: DurableObjectStub, path: string, body?: unknown): Promise<Response> {
  return stub.fetch("https://job.internal" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function createJob() {
  const jobId = newJobId();
  const stub = bindings.JOBS.get(bindings.JOBS.idFromName(jobId));
  const init = await request(stub, "/init", {
    jobId,
    allowedOrigin: "https://example.com",
    mode: "crawl",
    concurrency: 5,
    maxDepth: 3,
    maxPages: 500,
    maxFileBytes: 50 * 1024 * 1024,
    budgetBytes: 8 * 1024 * 1024 * 1024,
    perDomainDelayMs: 0,
    maxImagesPerPage: 2000,
    maxImagesPerJob: 50000
  });
  expect(init.status).toBe(200);
  return { jobId, stub };
}

async function snapshot(stub: DurableObjectStub) {
  const response = await request(stub, "/snapshot");
  expect(response.ok).toBe(true);
  return await response.json() as {
    status: string;
    pendingPages: number;
    pendingImages: number;
    imagesStored: number;
    failedImages: number;
    bytesStored: number;
    taskCounts: { pending: number; leased: number; done: number; failed: number };
  };
}

describe("Durable Object task and storage lifecycle", () => {
  it("keeps discoveries registered when a page completes during pause", async () => {
    const { stub } = await createJob();
    const parentId = hash("a");
    const parent = task(parentId, hash("b"), "https://example.com/", 0);

    const registered = await request(stub, "/register-pages", { items: [parent] });
    expect((await registered.json() as { items: Array<{ result: string }> }).items[0]?.result).toBe("accepted");
    await request(stub, "/start", {});

    const lease = await request(stub, "/task/lease", { taskId: parentId });
    expect((await lease.json() as { result: string }).result).toBe("leased");
    await request(stub, "/pause", {});

    const image = task(hash("c"), hash("d"), "https://example.com/image.png");
    const child = task(hash("e"), hash("f"), "https://example.com/gallery", 1);
    const completed = await request(stub, "/page/complete", { taskId: parentId, images: [image], pages: [child] });
    const result = await completed.json() as { result: string; parent: string };
    expect(result.result).toBe("accepted");
    expect(result.parent).toBe("done");

    const pausedSnapshot = await snapshot(stub);
    expect(pausedSnapshot.pendingPages).toBe(1);
    expect(pausedSnapshot.pendingImages).toBe(1);
    expect(pausedSnapshot.taskCounts.done).toBe(1);
    expect(pausedSnapshot.taskCounts.pending).toBe(2);

    const pausedLease = await request(stub, "/task/lease", { taskId: child.taskId });
    expect((await pausedLease.json() as { result: string }).result).toBe("paused");

    await request(stub, "/resume", {});
    const resumed = await snapshot(stub);
    expect(resumed.status).toBe("running");
    expect(resumed.taskCounts.pending).toBe(2);
  });

  it("does not consume retry attempts for scheduler rate-limit deferrals", async () => {
    const { stub } = await createJob();
    const parentId = hash("a");
    const imageId = hash("b");
    await request(stub, "/register-pages", {
      items: [task(parentId, hash("c"), "https://example.com/")]
    });
    await request(stub, "/start", {});
    expect((await request(stub, "/task/lease", { taskId: parentId }).then(response => response.json()) as { result: string }).result)
      .toBe("leased");
    const discovered = await request(stub, "/page/complete", {
      taskId: parentId,
      images: [task(imageId, hash("d"), "https://example.com/animated.gif")],
      pages: []
    });
    expect((await discovered.json() as { parent: string }).parent).toBe("done");

    // More scheduler deferrals than the normal retry limit must leave the
    // queued GIF download pending rather than mark it as failed.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const lease = await request(stub, "/task/lease", { taskId: imageId });
      expect((await lease.json() as { result: string }).result).toBe("leased");
      const deferred = await request(stub, "/task/retry", {
        taskId: imageId,
        code: "RATE_LIMITED",
        retryable: true,
        delaySeconds: 1
      });
      expect((await deferred.json() as { result: string }).result).toBe("accepted");
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("UPDATE tasks SET next_attempt_at = 0 WHERE task_id = ?", imageId);
      });
    }

    const taskState = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.sql.exec(
        "SELECT state, attempt_count FROM tasks WHERE task_id = ?", imageId
      ).toArray() as unknown as Array<{ state: string; attempt_count: number }>;
    });
    expect(taskState[0]).toMatchObject({ state: "pending", attempt_count: 0 });
    const current = await snapshot(stub);
    expect(current.pendingImages).toBe(1);
    expect(current.failedImages).toBe(0);
  });

  it("keeps real HTTP 429 failures within the normal retry budget", async () => {
    const { stub } = await createJob();
    const taskId = hash("e");
    await request(stub, "/register-pages", {
      items: [task(taskId, hash("f"), "https://example.com/")]
    });
    await request(stub, "/start", {});
    const lease = await request(stub, "/task/lease", { taskId });
    expect((await lease.json() as { result: string }).result).toBe("leased");
    const retry = await request(stub, "/task/retry", {
      taskId,
      code: "IMAGE_HTTP_429",
      retryable: true,
      delaySeconds: 5
    });
    expect((await retry.json() as { result: string }).result).toBe("accepted");
    const taskState = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.sql.exec(
        "SELECT state, attempt_count FROM tasks WHERE task_id = ?", taskId
      ).toArray() as unknown as Array<{ state: string; attempt_count: number }>;
    });
    expect(taskState[0]).toMatchObject({ state: "pending", attempt_count: 1 });
  });

  it("requeues a task after its worker lease expires", async () => {
    const { stub } = await createJob();
    const taskId = hash("1");
    await request(stub, "/register-pages", {
      items: [task(taskId, hash("2"), "https://example.com/lease")]
    });
    await request(stub, "/start", {});
    const lease = await request(stub, "/task/lease", { taskId });
    expect((await lease.json() as { result: string }).result).toBe("leased");

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE tasks SET lease_until = ? WHERE task_id = ?", Date.now() - 1, taskId);
      await state.storage.setAlarm(Date.now() + 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const state = await runInDurableObject(stub, async (_instance, durableState) => {
      return durableState.storage.sql.exec(
        "SELECT state, enqueued FROM tasks WHERE task_id = ?", taskId
      ).toArray() as unknown as Array<{ state: string; enqueued: number }>;
    });
    expect(state[0]?.state).toBe("pending");
    expect(state[0]?.enqueued).toBe(1);
  });

  it("recovers an image claim after a crash between final copy and commit", async () => {
    const { jobId, stub } = await createJob();
    await request(stub, "/start", {});
    const sha = hash("3");
    const firstTask = hash("4");
    const secondTask = hash("5");
    const finalKey = "jobs/" + jobId + "/objects/" + sha + ".png";

    const first = await request(stub, "/content/claim", {
      sha256: sha,
      taskId: firstTask,
      tempKey: "tmp/jobs/" + jobId + "/" + firstTask,
      finalKey,
      size: 3
    });
    expect((await first.json() as { result: string }).result).toBe("claimed");

    await bindings.IMAGES.put(finalKey, new Uint8Array([1, 2, 3]), {
      customMetadata: { sha256: sha },
      httpMetadata: { contentType: "image/png" }
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE content_claims SET lease_until = 0 WHERE sha256 = ?", sha);
    });
    const takeover = await request(stub, "/content/claim", {
      sha256: sha,
      taskId: secondTask,
      tempKey: "tmp/jobs/" + jobId + "/" + secondTask,
      finalKey,
      size: 3
    });
    expect((await takeover.json() as { result: string }).result).toBe("takeover");

    const commit = await request(stub, "/content/commit", {
      sha256: sha,
      taskId: secondTask,
      permitId: crypto.randomUUID(),
      size: 3
    });
    expect((await commit.json() as { result: string }).result).toBe("stored");
    const duplicate = await request(stub, "/content/claim", {
      sha256: sha,
      taskId: hash("6"),
      tempKey: "tmp/jobs/" + jobId + "/" + hash("6"),
      finalKey,
      size: 3
    });
    expect((await duplicate.json() as { result: string }).result).toBe("stored");

    const current = await snapshot(stub);
    expect(current.imagesStored).toBe(1);
    expect(current.bytesStored).toBe(3);
  });

  it("reconciles R2 objects and clears the job and Durable Object state", async () => {
    const { jobId, stub } = await createJob();
    await request(stub, "/start", {});

    const sha = hash("7");
    const finalKey = "jobs/" + jobId + "/objects/" + sha + ".png";
    await bindings.IMAGES.put(finalKey, new Uint8Array([4, 5, 6, 7]), {
      customMetadata: { sha256: sha },
      httpMetadata: { contentType: "image/png" }
    });
    await bindings.IMAGES.put("tmp/jobs/" + jobId + "/" + hash("9"), new Uint8Array([8, 9]));

    const token = crypto.randomUUID();
    expect((await request(stub, "/storage/reconcile/start", { token })).ok).toBe(true);
    const batch = await request(stub, "/storage/reconcile/batch", {
      token,
      items: [{ sha256: sha, key: finalKey, size: 4 }]
    });
    expect((await batch.json() as { result: string }).result).toBe("accepted");
    const finish = await request(stub, "/storage/reconcile/finish", { token });
    expect(await finish.json()).toMatchObject({ result: "reconciled", objects: 1, bytes: 4 });

    const digest = hash("8");
    const manifest = await request(stub, "/manifest", { digest, count: 1, bytes: 4 });
    expect(manifest.status).toBe(200);
    const verified = await request(stub, "/verify", {
      manifestSha256: digest,
      filesChecked: 1,
      bytesChecked: 4,
      failed: 0
    });
    expect((await verified.json() as { verified: boolean }).verified).toBe(true);

    const cleared = await request(stub, "/clear", {});
    expect(cleared.status).toBe(200);
    expect((await cleared.json() as { r2PrefixVerifiedEmpty: boolean }).r2PrefixVerifiedEmpty).toBe(true);
    const objects = await bindings.IMAGES.list({ prefix: "jobs/" + jobId + "/" });
    expect(objects.objects).toHaveLength(0);
    const temporary = await bindings.IMAGES.list({ prefix: "tmp/jobs/" + jobId + "/" });
    expect(temporary.objects).toHaveLength(0);
    expect((await request(stub, "/snapshot")).status).toBe(404);
  });
});
