import { parseHTML } from "linkedom";
import type { DiscoveryResult } from "./types";

const NON_IMAGE = /\.(?:mp4|webm|mov|m4v|mp3|ogg|pdf|css|js|woff2?|ttf|otf)(?:$|[?#])/i;
const MAX_IMAGES = 2000;
const MAX_API_PAGES = 500;
const SEXCOM_MEDIA_BASE = "https://imagex1.sx.cdn.live";
const SEXCOM_PAGE_SIZE = 40;

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

function absolute(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || /^(?:data:|blob:|javascript:|mailto:|tel:)/i.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function result(): DiscoveryResult {
  return { images: [], stylesheets: [], pages: [] };
}

function addPage(output: DiscoveryResult, raw: string | null, base: string): void {
  const url = absolute(raw, base);
  if (!url || output.pages.length >= MAX_PAGES) return;
  try {
    if (new URL(url).origin === new URL(base).origin && !output.pages.includes(url)) output.pages.push(url);
  } catch { /* Ignore malformed links. */ }
}

function addImage(output: DiscoveryResult, raw: string | null, base: string): void {
  const url = absolute(raw, base);
  if (!url || NON_IMAGE.test(new URL(url).pathname) || output.images.length >= MAX_IMAGES) return;
  if (!output.images.some(item => item.url === url)) output.images.push({ url });
}

function parseRule34(document: Document, base: string): DiscoveryResult {
  const output = result();
  for (const anchor of Array.from(document.querySelectorAll("span.thumb a[href]"))) {
    const href = anchor.getAttribute("href");
    addPage(output, href, base);
    const image = anchor.querySelector("img");
    const thumb = image?.getAttribute("src") || image?.getAttribute("data-src") || "";
    if (!thumb) continue;
    const sample = thumb.replace("/thumbnails/", "/samples/").replace("thumbnail_", "sample_");
    addImage(output, sample, base);
  }
  return output;
}

function parseRealbooru(document: Document, base: string): DiscoveryResult {
  const output = result();
  const pageUrl = new URL(base);
  const isPost = pageUrl.searchParams.get("s") === "view" && pageUrl.searchParams.has("id");
  if (isPost) {
    const image = document.querySelector("#image");
    addImage(output, image?.getAttribute("src") || image?.getAttribute("data-src"), base);
  } else {
    for (const anchor of Array.from(document.querySelectorAll('a[href*="s=view"][href*="id="]'))) {
      addPage(output, anchor.getAttribute("href"), base);
    }
  }
  return output;
}

function parseElitebabes(document: Document, base: string): DiscoveryResult {
  const output = result();
  const contentImage = (raw: string | null): void => {
    const url = absolute(raw, base);
    if (!url) return;
    const parsed = new URL(url);
    if (!hostMatches(parsed.hostname, "cdn.elitebabes.com") || !parsed.pathname.includes("/content/")) return;
    if (/(?:_w400|masonry_400|favicon|\.svg)(?:\.|$)/i.test(parsed.pathname)) return;
    if (!/\.(?:jpe?g|png|webp)$/i.test(parsed.pathname)) return;
    addImage(output, url, base);
  };
  const listItems = Array.from(document.querySelectorAll("ul.list-gallery li"));
  if (listItems.length) {
    for (const item of listItems) {
      const anchor = item.querySelector("a[href]");
      addPage(output, anchor?.getAttribute("href") || null, base);
    }
    return output;
  }
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) contentImage(anchor.getAttribute("href"));
  for (const image of Array.from(document.querySelectorAll("img"))) {
    for (const attr of ["src", "data-src", "data-original"]) contentImage(image.getAttribute(attr));
  }
  return output;
}

function parseBuondua(document: Document, base: string): DiscoveryResult {
  const output = result();
  const path = new URL(base).pathname;
  const albumMatch = path.match(/-(\d+)\/?$/) || path.match(/\/(\d+)\/?$/);
  if (albumMatch) {
    const albumId = albumMatch[1];
    for (const image of Array.from(document.querySelectorAll("img"))) {
      for (const attr of ["src", "data-src", "data-original", "data-lazy-src"]) {
        const raw = image.getAttribute(attr);
        const url = absolute(raw, base);
        if (!url) continue;
        const parsed = new URL(url);
        if (!hostMatches(parsed.hostname, "buondua.com") || !new RegExp("/" + albumId + "/").test(parsed.pathname)) continue;
        if (!/\.(?:jpe?g|png|webp)$/i.test(parsed.pathname)) continue;
        addImage(output, url, base);
      }
    }
    for (const anchor of Array.from(document.querySelectorAll('a[href*="page="]'))) {
      addPage(output, anchor.getAttribute("href"), base);
    }
    const maxPage = Math.max(1, ...Array.from(document.querySelectorAll('a[href*="page="]')).map(anchor => {
      try { return Number(new URL(anchor.getAttribute("href") || "", base).searchParams.get("page") || 1); }
      catch { return 1; }
    }));
    const current = new URL(base);
    const currentPage = Number(current.searchParams.get("page") || 1);
    if (maxPage > currentPage) {
      const next = new URL(current);
      next.searchParams.set("page", String(currentPage + 1));
      addPage(output, next.toString(), base);
    }
    return output;
  }
  for (const anchor of Array.from(document.querySelectorAll("a.item-link[href], a.popunder[href], a[href]"))) {
    const url = absolute(anchor.getAttribute("href"), base);
    if (!url) continue;
    const parsed = new URL(url);
    if (!hostMatches(parsed.hostname, "buondua.com")) continue;
    if (/^\/(?:tag\/|hot|collection|search)/i.test(parsed.pathname) || parsed.pathname === "/") continue;
    if (/-\d+\/?$/.test(parsed.pathname) || /^\/\d+\/?$/.test(parsed.pathname)) addPage(output, url, base);
  }
  for (const anchor of Array.from(document.querySelectorAll('a[href*="start="]'))) addPage(output, anchor.getAttribute("href"), base);
  return output;
}

export function isSexComUrl(input: string): boolean {
  try { return hostMatches(new URL(input).hostname, "sex.com"); } catch { return false; }
}

export function discoverSiteSpecificHtml(html: string, baseUrl: string): DiscoveryResult | null {
  let host: string;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return null; }
  const { document } = parseHTML(html);
  if (hostMatches(host, "rule34.xxx")) return parseRule34(document, baseUrl);
  if (hostMatches(host, "realbooru.com")) return parseRealbooru(document, baseUrl);
  if (hostMatches(host, "elitebabes.com")) return parseElitebabes(document, baseUrl);
  if (hostMatches(host, "buondua.com")) return parseBuondua(document, baseUrl);
  return null;
}

export async function discoverSexComApiPage(
  pageUrl: string,
  fetchText: (url: string) => Promise<string>
): Promise<DiscoveryResult> {
  const current = new URL(pageUrl);
  const searchParams = current.searchParams;
  const page = Math.max(1, Math.min(MAX_API_PAGES, Number(searchParams.get("_image_scraper_page") || searchParams.get("page") || 1)));
  const tag = current.pathname.match(/\/tags?\/(\d+)/i)?.[1];
  const pathSearch = current.pathname.match(/\/search\/([^/]+)/i)?.[1];
  const query = searchParams.get("search") || searchParams.get("q") || (pathSearch ? decodeURIComponent(pathSearch) : "");
  const endpoint = tag ? "/portal/api/tags/" + encodeURIComponent(tag) + "/gifs"
    : query ? "/portal/api/gifs/search" : "/portal/api/gifs";
  const apiUrl = new URL(endpoint, "https://www.sex.com");
  apiUrl.searchParams.set("page", String(page));
  apiUrl.searchParams.set("limit", String(SEXCOM_PAGE_SIZE));
  if (query) apiUrl.searchParams.set("search", query);
  if (!tag) {
    apiUrl.searchParams.set("sexual-orientation", "straight");
    if (!query) apiUrl.searchParams.set("order", "likeCount");
  }
  const payloadText = await fetchText(apiUrl.toString());
  let payload: unknown;
  try { payload = JSON.parse(payloadText); } catch { throw new Error("SEXCOM_API_INVALID_JSON"); }
  const rows = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: Array<Record<string, unknown>> }).data : [];
  const output = result();
  for (const row of rows) {
    const raw = typeof row.uri === "string" ? row.uri : "";
    if (!raw) continue;
    const url = absolute(raw, SEXCOM_MEDIA_BASE + "/");
    if (url) addImage(output, url, pageUrl);
  }
  if (rows.length === SEXCOM_PAGE_SIZE && page < MAX_API_PAGES) {
    const next = new URL(pageUrl);
    next.searchParams.set("_image_scraper_page", String(page + 1));
    next.searchParams.delete("page");
    addPage(output, next.toString(), pageUrl);
  }
  return output;
}
