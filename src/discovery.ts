import { parseHTML } from "linkedom";
import type { DiscoveryResult } from "./types";

const IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i;
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
  } catch {
    return null;
  }
}

function extractSrcset(value: string | null, baseUrl: string, add: (url: string) => void): void {
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

export function discoverFromHtml(html: string, baseUrl: string): DiscoveryResult {
  const { document } = parseHTML(html);
  const images = new Set<string>();
  const stylesheets = new Set<string>();
  const pages = new Set<string>();

  const addImage = (raw: string | null | undefined): void => {
    const resolved = resolveHttpUrl(raw, baseUrl);
    if (resolved && images.size < MAX_IMAGES_PER_PAGE) images.add(resolved);
  };
  const addPage = (raw: string | null | undefined): void => {
    const resolved = resolveHttpUrl(raw, baseUrl);
    if (!resolved || pages.size >= MAX_LINKS_PER_PAGE) return;
    try {
      if (new URL(resolved).origin === new URL(baseUrl).origin) pages.add(resolved);
    } catch {
      return;
    }
  };
  const addCss = (css: string): void => cssUrls(css, addImage);

  for (const element of Array.from(document.querySelectorAll("img, source"))) {
    addImage(element.getAttribute("src"));
    addImage(element.getAttribute("data-src"));
    addImage(element.getAttribute("data-original"));
    addImage(element.getAttribute("data-lazy-src"));
    extractSrcset(element.getAttribute("srcset"), baseUrl, addImage);
    extractSrcset(element.getAttribute("data-srcset"), baseUrl, addImage);
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

  return {
    images: Array.from(images).map(url => ({ url })),
    stylesheets: Array.from(stylesheets).slice(0, 50),
    pages: Array.from(pages)
  };
}

export function discoverFromCss(css: string, baseUrl: string): string[] {
  const results = new Set<string>();
  cssUrls(css, raw => {
    const resolved = resolveHttpUrl(raw, baseUrl);
    if (resolved) results.add(resolved);
  });
  return Array.from(results);
}

export function isImageFileUrl(value: string): boolean {
  return IMAGE_EXTENSIONS.test(value);
}