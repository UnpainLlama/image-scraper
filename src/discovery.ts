import { parseHTML } from "linkedom";
import type { DiscoveryResult } from "./types";

const IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;
const NON_IMAGE_EXTENSIONS = /\.(?:woff2?|ttf|otf|eot|css|js|mjs|map|mp4|webm|mp3|ogg|pdf)(?:$|[?#])/i;
const MAX_IMAGES_PER_PAGE = 2000;
const MAX_LINKS_PER_PAGE = 2000;

function resolveHttpUrl(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /^(?:data:|blob:|javascript:|mailto:|tel:)/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function extractSrcset(value: string | null, add: (url: string) => void): void {
  if (!value) return;
  for (const candidate of value.split(",")) {
    const url = candidate.trim().split(/\s+/)[0];
    if (url) add(url);
  }
}

function cssUrls(css: string, add: (url: string) => void): void {
  const pattern = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*))\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    const raw = (match[1] || match[2] || match[3] || "").trim();
    if (raw) add(raw);
  }
}

function nonImageAsset(value: string): boolean {
  try { return NON_IMAGE_EXTENSIONS.test(new URL(value).pathname); }
  catch { return NON_IMAGE_EXTENSIONS.test(value); }
}

export function discoverFromHtml(html: string, baseUrl: string, imageLimit = MAX_IMAGES_PER_PAGE, linkLimit = MAX_LINKS_PER_PAGE): DiscoveryResult {
  const { document } = parseHTML(html);
  const images = new Set<string>();
  const stylesheets = new Set<string>();
  const pages = new Set<string>();
  const addImage = (raw: string | null | undefined): void => {
    const resolved = resolveHttpUrl(raw, baseUrl);
    if (resolved && !nonImageAsset(resolved) && images.size < imageLimit) images.add(resolved);
  };
  const addPage = (raw: string | null | undefined): void => {
    const resolved = resolveHttpUrl(raw, baseUrl);
    if (!resolved || pages.size >= linkLimit) return;
    try { if (new URL(resolved).origin === new URL(baseUrl).origin) pages.add(resolved); }
    catch { /* Invalid links are ignored. */ }
  };
  const addCss = (css: string): void => cssUrls(css, addImage);

  for (const element of Array.from(document.querySelectorAll("img, source"))) {
    addImage(element.getAttribute("src"));
    addImage(element.getAttribute("data-src"));
    addImage(element.getAttribute("data-original"));
    addImage(element.getAttribute("data-lazy-src"));
    extractSrcset(element.getAttribute("srcset"), addImage);
    extractSrcset(element.getAttribute("data-srcset"), addImage);
  }
  for (const element of Array.from(document.querySelectorAll("meta[property='og:image'], meta[name='twitter:image'], meta[property='og:image:url']"))) {
    addImage(element.getAttribute("content"));
  }
  for (const element of Array.from(document.querySelectorAll("link[rel='image_src'], link[rel='preload'][as='image']"))) {
    addImage(element.getAttribute("href"));
  }
  for (const element of Array.from(document.querySelectorAll("a[href]"))) {
    const href = element.getAttribute("href");
    if (href && IMAGE_EXTENSIONS.test(href)) addImage(href);
    else addPage(href);
  }
  for (const element of Array.from(document.querySelectorAll("link[rel='stylesheet'][href]"))) {
    const href = resolveHttpUrl(element.getAttribute("href"), baseUrl);
    if (href) stylesheets.add(href);
  }
  for (const element of Array.from(document.querySelectorAll("[style]"))) addCss(element.getAttribute("style") || "");
  for (const element of Array.from(document.querySelectorAll("style"))) addCss(element.textContent || "");

  return { images: Array.from(images).map(url => ({ url })), stylesheets: Array.from(stylesheets).slice(0, 20), pages: Array.from(pages) };
}

export function discoverFromCss(css: string, baseUrl: string, maximum = MAX_IMAGES_PER_PAGE): string[] {
  const results = new Set<string>();
  cssUrls(css, raw => {
    const resolved = resolveHttpUrl(raw, baseUrl);
    if (resolved && !nonImageAsset(resolved) && results.size < maximum) results.add(resolved);
  });
  return Array.from(results);
}

export function isImageFileUrl(value: string): boolean { return IMAGE_EXTENSIONS.test(value); }