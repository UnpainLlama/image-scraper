import { describe, expect, it } from "vitest";
import { resolveTerminalTarget, validateTerminalPageLimit } from "../src/terminal";

describe("terminal target resolver", () => {
  it("defaults auto search input to Sex.com", () => {
    const target = resolveTerminalTarget("auto", "cats");
    expect(target.site).toBe("sex.com");
    expect(new URL(target.siteUrl).searchParams.get("search")).toBe("cats");
    expect(target.targetType).toBe("search");
  });

  it("converts Rule34 tag input to the expected list URL", () => {
    const target = resolveTerminalTarget("rule34", "blue hair");
    const url = new URL(target.siteUrl);
    expect(url.hostname).toBe("rule34.xxx");
    expect(url.searchParams.get("s")).toBe("list");
    expect(url.searchParams.get("tags")).toBe("blue_hair");
  });

  it("converts Realbooru tags to a list URL", () => {
    const target = resolveTerminalTarget("realbooru", "blue hair");
    expect(new URL(target.siteUrl).searchParams.get("tags")).toBe("blue_hair");
  });

  it("normalizes EliteBabes tags and preserves gallery mode choice", () => {
    const target = resolveTerminalTarget("elitebabes", "red hair", "images");
    expect(target.siteUrl).toBe("https://www.elitebabes.com/tag/red-hair/");
    expect(target.eliteBabesMode).toBe("images");
  });

  it("forces a single EliteBabes gallery URL to full-size gallery mode", () => {
    const target = resolveTerminalTarget("elitebabes", "https://www.elitebabes.com/example-gallery/");
    expect(target.targetType).toBe("gallery");
    expect(target.eliteBabesMode).toBe("galleries");
  });

  it("supports Buondua home, hot, tag, and numeric album inputs", () => {
    expect(resolveTerminalTarget("buondua", "home").siteUrl).toBe("https://buondua.com/");
    expect(resolveTerminalTarget("buondua", "hot").siteUrl).toBe("https://buondua.com/hot");
    expect(resolveTerminalTarget("buondua", "portrait").siteUrl).toBe("https://buondua.com/tag/portrait");
    expect(resolveTerminalTarget("buondua", "12345").siteUrl).toBe("https://buondua.com/12345");
  });

  it("recognizes bare host URLs with query strings and normalizes HTTP to HTTPS", () => {
    const sex = resolveTerminalTarget("auto", "sex.com?search=landscape");
    expect(new URL(sex.siteUrl).protocol).toBe("https:");
    expect(new URL(sex.siteUrl).searchParams.get("search")).toBe("landscape");

    const staticTarget = resolveTerminalTarget("static", "http://example.org/gallery");
    expect(staticTarget.siteUrl).toBe("https://example.org/gallery");
  });

  it("auto-detects supported hostnames and falls back to static HTML for other URLs", () => {
    expect(resolveTerminalTarget("auto", "https://rule34.xxx/index.php?page=post&s=list").site).toBe("rule34");
    expect(resolveTerminalTarget("auto", "https://example.org/gallery/").site).toBe("static");
  });

  it("requires a URL in static mode", () => {
    expect(() => resolveTerminalTarget("static", "image gallery")).toThrow("STATIC_MODE_REQUIRES_URL");
  });

  it("rejects site/URL mismatches and individual post URLs", () => {
    expect(() => resolveTerminalTarget("rule34", "https://realbooru.com/")).toThrow("SITE_HOST_MISMATCH");
    expect(() => resolveTerminalTarget("rule34", "https://rule34.xxx/index.php?page=post&s=view&id=123")).toThrow("SINGLE_ITEM_URL_NOT_SUPPORTED");
    expect(() => resolveTerminalTarget("sex.com", "https://www.sex.com/pin/123")).toThrow("SINGLE_ITEM_URL_NOT_SUPPORTED");
  });
});

describe("terminal page limit", () => {
  it("defaults to the Cloudflare Free job ceiling", () => {
    expect(validateTerminalPageLimit(undefined)).toBe(100);
    expect(validateTerminalPageLimit("")).toBe(100);
  });

  it("accepts an explicit value from 1 to 100", () => {
    expect(validateTerminalPageLimit("25")).toBe(25);
    expect(validateTerminalPageLimit(100)).toBe(100);
  });

  it("rejects invalid or above-limit page counts", () => {
    expect(() => validateTerminalPageLimit(0)).toThrow("FREE_TIER_PAGE_LIMIT");
    expect(() => validateTerminalPageLimit(101)).toThrow("FREE_TIER_PAGE_LIMIT");
    expect(() => validateTerminalPageLimit(1.5)).toThrow("FREE_TIER_PAGE_LIMIT");
  });
});
