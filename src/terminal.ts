import { ScrapeError } from "./http";

export type TerminalSite = "auto" | "sex.com" | "rule34" | "realbooru" | "elitebabes" | "buondua" | "static";
export type EliteBabesMode = "images" | "galleries";

export interface TerminalTarget {
  site: Exclude<TerminalSite, "auto">;
  siteUrl: string;
  label: string;
  targetType: "search" | "list" | "album" | "gallery" | "page";
  eliteBabesMode: EliteBabesMode;
}

const SITE_HOSTS: Record<Exclude<TerminalSite, "auto" | "static">, string> = {
  "sex.com": "sex.com",
  rule34: "rule34.xxx",
  realbooru: "realbooru.com",
  elitebabes: "elitebabes.com",
  buondua: "buondua.com"
};

function isHost(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  return host === domain || host.endsWith("." + domain);
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) ||
    /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value);
}

function parseInputUrl(value: string): URL {
  try { const url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value); url.protocol = "https:"; return url; }
  catch { throw new ScrapeError("INVALID_URL"); }
}

function slug(value: string): string {
  return value.trim().replace(/\s+/g, "-").replace(/^\/+|\/+$/g, "").toLowerCase();
}

function hostSite(host: string): Exclude<TerminalSite, "auto"> | null {
  for (const [site, domain] of Object.entries(SITE_HOSTS)) {
    if (isHost(host, domain)) return site as Exclude<TerminalSite, "auto">;
  }
  return null;
}

export function resolveTerminalTarget(
  requestedSite: TerminalSite | string,
  rawInput: string,
  requestedEliteMode: EliteBabesMode = "galleries"
): TerminalTarget {
  const siteChoice = requestedSite as TerminalSite;
  if (!["auto", "sex.com", "rule34", "realbooru", "elitebabes", "buondua", "static"].includes(siteChoice)) {
    throw new ScrapeError("INVALID_SITE");
  }

  const input = String(rawInput || "").trim();
  if (!input) throw new ScrapeError("TARGET_REQUIRED");
  const inputIsUrl = looksLikeUrl(input);
  let url: URL | null = inputIsUrl ? parseInputUrl(input) : null;
  let site: Exclude<TerminalSite, "auto">;

  if (siteChoice === "auto") {
    site = url ? hostSite(url.hostname) || "static" : "sex.com";
  } else {
    site = siteChoice;
  }

  if (site === "static") {
    if (!url) throw new ScrapeError("STATIC_MODE_REQUIRES_URL");
    return {
      site,
      siteUrl: url.toString(),
      label: "Static HTML",
      targetType: "page",
      eliteBabesMode: requestedEliteMode
    };
  }

  const requiredDomain = SITE_HOSTS[site];
  if (url && !isHost(url.hostname, requiredDomain)) throw new ScrapeError("SITE_HOST_MISMATCH");

  if (site === "sex.com") {
    if (url) {
      if (/\/(?:pin|gifs)\/\d+\/?$/i.test(url.pathname)) throw new ScrapeError("SINGLE_ITEM_URL_NOT_SUPPORTED");
      if (url.hostname === "sex.com") url.hostname = "www.sex.com";
      return { site, siteUrl: url.toString(), label: "Sex.com", targetType: url.searchParams.has("search") || /\/search\//i.test(url.pathname) ? "search" : "list", eliteBabesMode: requestedEliteMode };
    }
    const target = new URL("https://www.sex.com/en/gifs");
    target.searchParams.set("search", input);
    return { site, siteUrl: target.toString(), label: "Sex.com", targetType: "search", eliteBabesMode: requestedEliteMode };
  }

  if (site === "rule34" || site === "realbooru") {
    if (url) {
      if (url.searchParams.get("s") === "view" && url.searchParams.has("id")) {
        throw new ScrapeError("SINGLE_ITEM_URL_NOT_SUPPORTED");
      }
      if (!url.search && url.pathname === "/") {
        url.pathname = "/index.php";
        url.searchParams.set("page", "post");
        url.searchParams.set("s", "list");
      }
      return { site, siteUrl: url.toString(), label: site === "rule34" ? "Rule34" : "Realbooru", targetType: "list", eliteBabesMode: requestedEliteMode };
    }
    const target = new URL("https://" + requiredDomain + "/index.php");
    target.searchParams.set("page", "post");
    target.searchParams.set("s", "list");
    target.searchParams.set("tags", input.replace(/\s+/g, "_"));
    return { site, siteUrl: target.toString(), label: site === "rule34" ? "Rule34" : "Realbooru", targetType: "search", eliteBabesMode: requestedEliteMode };
  }

  if (site === "elitebabes") {
    const mode = requestedEliteMode === "images" ? "images" : "galleries";
    if (url) {
      const path = url.pathname.replace(/\/+$/, "");
      const parts = path.split("/").filter(Boolean);
      const isListing = !parts.length || /^tag$/i.test(parts[0] || "") || /^page$/i.test(parts[0] || "");
      const isSingleGallery = parts.length === 1 && !["photos", "videos", "models", "tags", "feed", "home"].includes((parts[0] || "").toLowerCase());
      if (isSingleGallery) return { site, siteUrl: new URL(path + "/", url.origin).toString(), label: "EliteBabes", targetType: "gallery", eliteBabesMode: "galleries" };
      return { site, siteUrl: url.toString(), label: "EliteBabes", targetType: isListing ? "list" : "search", eliteBabesMode: mode };
    }
    const normalized = slug(input);
    const target = ["", "home", "index", "all", "latest"].includes(normalized)
      ? new URL("https://www.elitebabes.com/")
      : new URL("https://www.elitebabes.com/tag/" + normalized + "/");
    return { site, siteUrl: target.toString(), label: "EliteBabes", targetType: normalized ? "search" : "list", eliteBabesMode: mode };
  }

  if (site === "buondua") {
    if (url) {
      const targetType = /(?:^|\/)(?:\d+)(?:\/)?$/.test(url.pathname) ? "album"
        : /-(\d+)\/?$/.test(url.pathname) ? "album" : "list";
      return { site, siteUrl: url.toString(), label: "Buondua", targetType, eliteBabesMode: requestedEliteMode };
    }
    const normalized = slug(input);
    if (["home", "index", "all", "latest"].includes(normalized)) {
      return { site, siteUrl: "https://buondua.com/", label: "Buondua", targetType: "list", eliteBabesMode: requestedEliteMode };
    }
    if (normalized === "hot") {
      return { site, siteUrl: "https://buondua.com/hot", label: "Buondua", targetType: "list", eliteBabesMode: requestedEliteMode };
    }
    if (/^\d+$/.test(input)) {
      return { site, siteUrl: "https://buondua.com/" + input, label: "Buondua", targetType: "album", eliteBabesMode: requestedEliteMode };
    }
    return { site, siteUrl: "https://buondua.com/tag/" + normalized, label: "Buondua", targetType: "search", eliteBabesMode: requestedEliteMode };
  }

  throw new ScrapeError("INVALID_SITE");
}

export function validateTerminalPageLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 100;
  const pages = Number(value);
  if (!Number.isInteger(pages) || pages < 1 || pages > 100) throw new ScrapeError("FREE_TIER_PAGE_LIMIT");
  return pages;
}
