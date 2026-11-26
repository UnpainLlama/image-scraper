import { afterEach, describe, expect, it, vi } from "vitest";
import { probePublicUrl, validatePublicUrl } from "../src/security";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("target probe", () => {
  it("probes the selected page directly without requesting robots.txt", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response("<html></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    }));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const result = await probePublicUrl("https://example.com/gallery?page=2");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.com/gallery?page=2");
  });

  it("returns the target HTTP status rather than a robots-policy error", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response("Forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const result = await probePublicUrl("https://example.com/gallery");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
