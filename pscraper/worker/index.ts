import { DurableObject } from "cloudflare:workers";

declare global {
  interface Env {
    APP_PASSWORD?: string;
    SESSION_SECRET?: string;
    R2_ACCOUNT_ID?: string;
    R2_BUCKET_NAME: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    ASSETS: Fetcher;
    AUTH_LIMITER: DurableObjectNamespace<AuthRateLimiter>;
    PSCRAPER: DurableObjectNamespace<PscraperContainer>;
  }
}

const COOKIE = "__Host-pscraper_session";
const SESSION_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      ...headers,
    },
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createSession(secret: string): Promise<string> {
  const issued = Math.floor(Date.now() / 1000);
  const payload = base64Url(encoder.encode(JSON.stringify({
    v: 1,
    iat: issued,
    exp: issued + SESSION_SECONDS,
    nonce: crypto.randomUUID(),
  })));
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(payload),
  ));
  return payload + "." + base64Url(signature);
}

async function verifySession(token: string, secret: string): Promise<boolean> {
  if (!token || token.length > 2048 || secret.length < 32) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const signature = fromBase64Url(parts[1]!);
    const signatureBuffer = new Uint8Array(signature).buffer;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      signatureBuffer,
      encoder.encode(parts[0]!),
    );
    if (!valid) return false;

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]!))) as {
      v?: number;
      iat?: number;
      exp?: number;
      nonce?: string;
    };
    const now = Math.floor(Date.now() / 1000);
    return payload.v === 1 &&
      Number.isInteger(payload.iat) &&
      Number.isInteger(payload.exp) &&
      typeof payload.nonce === "string" &&
      payload.nonce.length >= 16 &&
      Number(payload.iat) <= now + 60 &&
      Number(payload.exp) > now &&
      Number(payload.exp) - Number(payload.iat) <= SESSION_SECONDS;
  } catch {
    return false;
  }
}

function cookieValue(request: Request): string {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === COOKIE) {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
}

function configured(env: Env): boolean {
  return typeof env.APP_PASSWORD === "string" &&
    env.APP_PASSWORD.length >= 15 &&
    typeof env.SESSION_SECRET === "string" &&
    env.SESSION_SECRET.length >= 32;
}

async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(candidateHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

async function authenticated(request: Request, env: Env): Promise<boolean> {
  if (!configured(env)) return false;
  return verifySession(cookieValue(request), env.SESSION_SECRET!);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !!origin && origin === new URL(request.url).origin;
}

async function authRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/auth/status" && request.method === "GET") {
    const ready = configured(env);
    return json({
      configured: ready,
      authenticated: ready && await authenticated(request, env),
    });
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    if (!sameOrigin(request)) return json({ error: "ORIGIN_REJECTED" }, 403);
    if (!configured(env)) return json({ error: "PASSWORD_AUTH_NOT_CONFIGURED" }, 503);

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const limiter = env.AUTH_LIMITER.get(env.AUTH_LIMITER.idFromName("login:" + ip));
    const limitResponse = await limiter.fetch("https://auth-limiter/check", { method: "POST" });
    if (!limitResponse.ok) {
      return json({ error: "LOGIN_RATE_LIMITED" }, 429, { "retry-after": "900" });
    }

    let body: { password?: unknown };
    try {
      body = await request.json() as { password?: unknown };
    } catch {
      return json({ error: "INVALID_PASSWORD" }, 400);
    }

    if (typeof body.password !== "string" ||
      body.password.length > 256 ||
      !await passwordMatches(body.password, env.APP_PASSWORD!)) {
      return json({ error: "INVALID_PASSWORD" }, 401);
    }

    await limiter.fetch("https://auth-limiter/reset", { method: "POST" });
    const token = await createSession(env.SESSION_SECRET!);
    return json({ authenticated: true }, 200, {
      "set-cookie": COOKIE + "=" + token + "; Path=/; Max-Age=" + SESSION_SECONDS + "; HttpOnly; Secure; SameSite=Strict",
    });
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    if (!sameOrigin(request)) return json({ error: "ORIGIN_REJECTED" }, 403);
    return json({ authenticated: false }, 200, {
      "set-cookie": COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
    });
  }
  return null;
}

export class AuthRateLimiter extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/reset") {
      await this.ctx.storage.delete("attempts");
      return json({ reset: true });
    }
    if (url.pathname !== "/check") return json({ error: "NOT_FOUND" }, 404);

    const now = Date.now();
    const previous = await this.ctx.storage.get<{ startedAt: number; count: number }>("attempts");
    const state = !previous || now - previous.startedAt >= 15 * 60 * 1000
      ? { startedAt: now, count: 0 }
      : previous;
    if (state.count >= 5) return json({ allowed: false }, 429);
    state.count += 1;
    await this.ctx.storage.put("attempts", state);
    return json({ allowed: true });
  }
}

export class PscraperContainer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container && container.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(10 * 60 * 1000));
    }
  }

  private async startAndWait(): Promise<void> {
    this.starting ??= this.startContainer().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private async startContainer(): Promise<void> {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("Cloudflare Container binding is not available in this Durable Object");
    }
    if (!container.running) {
      const required: Array<keyof Env> = [
        "R2_ACCOUNT_ID",
        "R2_BUCKET_NAME",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
      ];
      const missing = required.filter((key) => !this.env[key]);
      if (missing.length) {
        throw new Error("Missing container settings: " + missing.join(", "));
      }

      await container.start({
        image: container.images.base,
        instance: "basic",
        enableInternet: true,
        env: {
          R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID!,
          R2_BUCKET_NAME: this.env.R2_BUCKET_NAME,
          AWS_ACCESS_KEY_ID: this.env.AWS_ACCESS_KEY_ID!,
          AWS_SECRET_ACCESS_KEY: this.env.AWS_SECRET_ACCESS_KEY!,
        },
      });
    }

    // Let the container wind down ten minutes after its Durable Object becomes idle.
    await container.setInactivityTimeout(10 * 60 * 1000);
    const port = container.getTcpPort(8080);
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await port.fetch("http://container/health", {
          signal: AbortSignal.timeout(1500),
        });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // Container is still booting or mounting R2.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("pscraper container did not become ready on port 8080");
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WEBSOCKET_REQUIRED" }, 426);
    }

    await this.startAndWait();
    const target = new URL("http://container:8080/terminal");
    const forwarded = new Request(target, request);
    forwarded.headers.delete("host");
    const container = this.ctx.container;
    if (!container) return json({ error: "CONTAINER_UNAVAILABLE" }, 503);
    return container.getTcpPort(8080).fetch(forwarded);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = await authRoute(request, env, url);
    if (auth) return auth;

    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/terminal") return json({ error: "NOT_FOUND" }, 404);
      if (request.method !== "GET" ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "WEBSOCKET_REQUIRED" }, 426);
      }
      if (!sameOrigin(request)) return json({ error: "ORIGIN_REJECTED" }, 403);
      if (!await authenticated(request, env)) {
        return json({ error: "UNAUTHENTICATED" }, 401);
      }
      return env.PSCRAPER.getByName("main").fetch(request);
    }

    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
    );
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-frame-options", "DENY");
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (url.protocol === "https:") {
      headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers,
    });
  },
};
