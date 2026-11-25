import { describe, expect, it } from "vitest";
import { isRobotsAllowed, parseRobots, validatePublicUrl } from "../src/security";

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
});