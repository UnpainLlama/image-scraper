import { parseHTML } from "linkedom";
import type { DiscoveryResult } from "./types";

const NON_IMAGE = /\.(?:mp4|webm|mov|m4v|mp3|ogg|pdf|css|js|woff2?|ttf|otf)(?:$|[?#])/i;
const IMAGE_FILE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;
const MAX_IMAGES = 2000;
const MAX_PAGES = 2000;
const MAX_API_PAGES = 500;
const SEXCOM_MEDIA_BASE = "https://imagex1.sx.cdn.live";
const SEXCOM_PAGE_SIZE = 40;
const RULE34_PAGE_SIZE = 42;
const REALBOORU_PAGE_SIZE = 42;
const BUONDUA_LIST_STEP = 20;

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
  // These continuations are bounded, site-specific pagination and album/post
  // links. Generic page links remain restricted to explicit Crawl mode.
  return { images: [], stylesheets: [], pages: [], followPages: true };
}

function addPage(output: DiscoveryResult, raw: string | null, base: string): void {
  const url = absolute(raw, base);
  if (!url || output.pages.length >= MAX_PAGES) return;
  try {
    if (new URL(url).origin === new URL(base).origin && !output.pages.includes(url)) output.pages.push(url);
  } catch { /* Ignore malformed links. */ }
}

function addImage(output: DiscoveryResult, raw: string | null | undefined, base: string): void {
  const url = absolute(raw, base);
  if (!url || NON_IMAGE.test(new URL(url).pathname) || output.images.length >= MAX_IMAGES) return;
  if (!output.images.some(item => item.url === url)) output.images.push({ url });
}

function nextOffsetPage(base: string, parameter: string, step: number): string {
  const next = new URL(base);
  const current = Number(next.searchParams.get(parameter) || 0);
  next.searchParams.set(parameter, String((Number.isFinite(current) ? Math.max(0, current) : 0) + step));
  return next.toString();
}

function parseRule34(document: Document, base: string): DiscoveryResult {
  const output = result();
  const pageUrl = new URL(base);
  const isPost = pageUrl.searchParams.get("s") === "view" && pageUrl.searchParams.has("id");

  if (isPost) {
    const image = document.querySelector("#image");
    addImage(output, image?.getAttribute("src") || image?.getAttribute("data-src"), base);
    return output;
  }

  let found = 0;
  for (const anchor of Array.from(document.querySelectorAll("span.thumb a[href]"))) {
    const image = anchor.querySelector("img");
    const thumb = image?.getAttribute("src") || image?.getAttribute("data-src") || "";
    if (!thumb) continue;
    found += 1;

    // The Python adapter removes query strings before converting thumbnails
    // to /samples/ URLs. Preserve that behavior for signed/cache-busted URLs.
    const cleanThumb = thumb.split("#", 1)[0]!.split("?", 1)[0]!;
    const sample = cleanThumb.replace("/thumbnails/", "/samples/").replace("thumbnail_", "sample_");
    addImage(output, sample || cleanThumb, base);
  }

  // The CLI advances Rule34's offset by 42 until it receives an empty page.
  // Synthesize the next offset instead of depending on pagination markup.
  if (found > 0) addPage(output, nextOffsetPage(base, "pid", RULE34_PAGE_SIZE), base);
  return output;
}

function parseRealbooru(document: Document, base: string): DiscoveryResult {
  const output = result();
  const pageUrl = new URL(base);
  const isPost = pageUrl.searchParams.get("s") === "view" && pageUrl.searchParams.has("id");

  if (isPost) {
    const primary = document.querySelector("#image");
    addImage(output, primary?.getAttribute("src") || primary?.getAttribute("data-src"), base);

    // The original adapter falls back to scanning the post page for a
    // non-thumbnail /images/ asset if #image is missing or unusable.
    if (output.images.length === 0) {
      for (const element of Array.from(document.querySelectorAll("img[src], source[src], a[href]"))) {
        const raw = element.getAttribute("src") || element.getAttribute("href") || "";
        const url = absolute(raw, base);
        if (!url) continue;
        const parsed = new URL(url);
        if (!parsed.pathname.includes("/images/") || parsed.pathname.toLowerCase().includes("thumbnail")) continue;
        if (!IMAGE_FILE.test(parsed.pathname)) continue;
        addImage(output, url, base);
      }
    }
    return output;
  }

  let foundPosts = 0;
  const seen = new Set<string>();
  for (const anchor of Array.from(document.querySelectorAll('a[href*="s=view"][href*="id="]'))) {
    const href = anchor.getAttribute("href") || "";
    const match = href.match(/[?&]id=(\d+)/);
    const postId = match?.[1] || href;
    if (seen.has(postId)) continue;
    const image = anchor.querySelector("img");
    const thumb = image?.getAttribute("src") || image?.getAttribute("data-src") || "";
    if (!thumb || (!thumb.includes("thumbnail") && !thumb.includes("/thumbnails/"))) continue;
    seen.add(postId);
    foundPosts += 1;
    addPage(output, href, base);
  }

  // The original Realbooru adapter increments pid by 42 and stops at the
  // first empty page. This keeps list pagination independent of page markup.
  if (foundPosts > 0) addPage(output, nextOffsetPage(base, "pid", REALBOORU_PAGE_SIZE), base);
  return output;
}

function nextEliteBabesListPage(base: string): string {
  const current = new URL(base);
  const path = current.pathname.replace(/\/+$/, "");
  const match = path.match(/^(.*)\/page\/(\d+)$/i);
  const root = match ? match[1]! : path;
  const page = match ? Number(match[2]) : 1;
  current.pathname = (root || "") + "/page/" + (Number.isFinite(page) ? page + 1 : 2) + "/";
  current.search = "";
  current.hash = "";
  return current.toString();
}

function parseElitebabes(document: Document, base: string): DiscoveryResult {
  const output = result();
  const contentImage = (raw: string | null): void => {
    const url = absolute(raw, "https://cdn.elitebabes.com/");
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
    for (const anchor of Array.from(document.querySelectorAll('a[href*="/page/"]'))) {
      addPage(output, anchor.getAttribute("href"), base);
    }
    // EliteBabes uses /page/N/ for home lists and /tag/name/page/N/ for tags.
    addPage(output, nextEliteBabesListPage(base), base);
    return output;
  }

  // Gallery pages expose full-size CDN images in links or image attributes.
  // Thumbnail variants remain excluded to preserve the original galleries mode.
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) contentImage(anchor.getAttribute("href"));
  for (const image of Array.from(document.querySelectorAll("img"))) {
    for (const attr of ["src", "data-src", "data-original"]) contentImage(image.getAttribute(attr));
  }
  return output;
}

function albumIdFromPath(path: string): string {
  const match = path.match(/-(\d+)\/?$/) || path.match(/\/(\d+)\/?$/);
  return match?.[1] || "";
}

function parseBuondua(document: Document, base: string): DiscoveryResult {
  const output = result();
  const pageUrl = new URL(base);
  const albumId = albumIdFromPath(pageUrl.pathname);

  if (albumId) {
    for (const image of Array.from(document.querySelectorAll("img"))) {
      for (const attr of ["src", "data-src", "data-original", "data-lazy-src"]) {
        const raw = image.getAttribute(attr);
        const url = absolute(raw, base);
        if (!url) continue;
        const parsed = new URL(url);
        if (!hostMatches(parsed.hostname, "buondua.com") || !parsed.pathname.includes("/" + albumId + "/")) continue;
        if (!/\.(?:jpe?g|png|webp)$/i.test(parsed.pathname)) continue;
        addImage(output, url, base);
      }
    }

    const listedPages = Array.from(document.querySelectorAll('a[href*="page="]')).map(anchor => {
      try { return Number(new URL(anchor.getAttribute("href") || "", base).searchParams.get("page") || 1); }
      catch { return 1; }
    }).filter(page => Number.isFinite(page) && page > 0);
    const maxPage = Math.max(1, ...listedPages);
    const currentPage = Math.max(1, Number(pageUrl.searchParams.get("page") || 1));
    if (maxPage > currentPage) {
      const next = new URL(pageUrl);
      next.searchParams.set("page", String(currentPage + 1));
      addPage(output, next.toString(), base);
    }
    return output;
  }

  let albumCount = 0;
  for (const anchor of Array.from(document.querySelectorAll("a.item-link[href], a.popunder[href], a[href]"))) {
    const url = absolute(anchor.getAttribute("href"), base);
    if (!url) continue;
    const parsed = new URL(url);
    if (!hostMatches(parsed.hostname, "buondua.com")) continue;
    if (/^\/(?:tag\/|hot|collection|search)/i.test(parsed.pathname) || parsed.pathname === "/") continue;
    if (albumIdFromPath(parsed.pathname)) {
      albumCount += 1;
      addPage(output, url, base);
    }
  }

  for (const anchor of Array.from(document.querySelectorAll('a[href*="start="]'))) {
    addPage(output, anchor.getAttribute("href"), base);
  }

  // The original adapter walks listing offsets in steps of 20 until no albums
  // remain; do not rely on the page exposing an explicit "next" anchor.
  if (albumCount > 0) addPage(output, nextOffsetPage(base, "start", BUONDUA_LIST_STEP), base);
  return output;
}

export function isSexComUrl(input: string): boolean {
  try { return hostMatches(new URL(input).hostname.toLowerCase(), "sex.com"); } catch { return false; }
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
  const rawPage = Number(searchParams.get("_image_scraper_page") || searchParams.get("page") || 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.min(MAX_API_PAGES, Math.floor(rawPage))) : 1;
  const tag = current.pathname.match(/\/tags?\/(\d+)/i)?.[1];
  const pathSearch = current.pathname.match(/\/search\/([^/]+)/i)?.[1];
  let pathQuery = "";
  if (pathSearch) {
    try { pathQuery = decodeURIComponent(pathSearch); } catch { pathQuery = pathSearch; }
  }
  const query = searchParams.get("search") || searchParams.get("q") || pathQuery;
  const endpoint = tag ? "/portal/api/tags/" + encodeURIComponent(tag) + "/gifs"
    : query ? "/portal/api/gifs/search" : "/portal/api/gifs";
  const apiOrigin = current.hostname.toLowerCase() === "sex.com" ? "https://www.sex.com" : current.origin;
  const apiUrl = new URL(endpoint, apiOrigin);
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
    // Absolute API media URIs may use a different CDN. Relative URIs use the
    // known Sex.com media host unless the URI already specifies a host.
    addImage(output, raw, SEXCOM_MEDIA_BASE + "/");
  }
  if (rows.length === SEXCOM_PAGE_SIZE && page < MAX_API_PAGES) {
    const next = new URL(pageUrl);
    next.searchParams.set("_image_scraper_page", String(page + 1));
    next.searchParams.delete("page");
    addPage(output, next.toString(), pageUrl);
  }
  return output;
}
