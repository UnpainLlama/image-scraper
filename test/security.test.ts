import { describe, expect, it } from "vitest";
import { isRobotsAllowed, parseRobots, readRobotsResponse, validatePublicUrl } from "../src/security";

describe("URL safety", () => {
  it("accepts public HTTP and HTTPS URLs", () => {
    expect(validatePublicUrl("https://example.com/gallery").hostname).toBe("example.com");
  });

  it("rejects local hosts, IP literals and unusual protocols", () => {
    expect(() => validatePublicUrl("http://localhost/admin")).toThrow();
    expect(() => validatePublicUrl("http://127.0.0.1/")).toThrow();
    expect(() => validatePublicUrl("http://192.168.1.10/")).toThrow();
    expect(() => validatePublicUrl("file:///etc/passwd")).toThrow();
    expect(() => validatePublicUrl("https://example.com:8443/")).toThrow();
  });
});

describe("robots policy", () => {
  it("applies the most specific rule and prefers Allow on a tie", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/public");
    expect(isRobotsAllowed("/private/public/image.jpg", policy)).toBe(true);
    expect(isRobotsAllowed("/private/account", policy)).toBe(false);
    expect(isRobotsAllowed("/gallery", policy)).toBe(true);
  });

  it("reads crawl-delay", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 2").crawlDelayMs).toBe(2000);
  });

  it("cancels a non-success robots response without consuming it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; }
    });
    expect(await readRobotsResponse(new Response(body, { status: 404 }))).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("enforces the Content-Length robots cap and cancels the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      cancel() { cancelled = true; }
    });
    await expect(readRobotsResponse(new Response(body, {
      status: 200,
      headers: { "content-length": "100" }
    }), 10)).rejects.toThrow("ROBOTS_TOO_LARGE");
    expect(cancelled).toBe(true);
  });

  it("enforces the streamed robots cap when Content-Length is absent", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6])); },
      cancel() { cancelled = true; }
    });
    await expect(readRobotsResponse(new Response(body), 5)).rejects.toThrow("ROBOTS_TOO_LARGE");
    expect(cancelled).toBe(true);
  });
});
