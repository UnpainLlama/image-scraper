import { afterEach, describe, expect, it, vi } from "vitest";
import { browserRequestPatterns, probePublicUrl, validatePublicUrl } from "../src/security";

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

describe("Browser Run request allowlist", () => {
  function matcher(value: string): RegExp {
    const end = value.lastIndexOf("/");
    return new RegExp(value.slice(1, end), value.slice(end + 1));
  }

  it("allows the Sex.com site and its image CDN but rejects unrelated hosts", () => {
    const patterns = browserRequestPatterns("https://www.sex.com");
    const allow = matcher(patterns.allowRequestPattern[0]!);
    expect(allow.test("https://www.sex.com/en/gifs")).toBe(true);
    expect(allow.test("https://imagex1.sx.cdn.live/media/example.gif")).toBe(true);
    expect(allow.test("https://unrelated.example/image.js")).toBe(false);
  });

  it("keeps arbitrary static targets restricted to their exact origin", () => {
    const patterns = browserRequestPatterns("https://gallery.example.org");
    const allow = matcher(patterns.allowRequestPattern[0]!);
    expect(allow.test("https://gallery.example.org/page")).toBe(true);
    expect(allow.test("https://cdn.gallery.example.org/script.js")).toBe(false);
    expect(allow.test("https://unrelated.example/script.js")).toBe(false);
  });
});
