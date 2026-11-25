import { json, readJson } from "./http";
import type { Env } from "./types";

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const COOKIE_NAME = "__Host-image_scraper_session";
const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function importSessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createSessionToken(secret: string, now = Date.now()): Promise<string> {
  const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const issuedAt = Math.floor(now / 1000);
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    v: 1,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
    nonce
  })));
  const key = await importSessionKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return payload + "." + encodeBase64Url(signature);
}

export async function verifySessionToken(token: string, secret: string, now = Date.now()): Promise<boolean> {
  if (!token || token.length > 2048 || !secret || secret.length < 32) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const signature = decodeBase64Url(parts[1]!);
    const key = await importSessionKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(parts[0]!));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]!))) as {
      v?: number;
      iat?: number;
      exp?: number;
      nonce?: string;
    };
    const current = Math.floor(now / 1000);
    return payload.v === 1 &&
      Number.isInteger(payload.iat) &&
      Number.isInteger(payload.exp) &&
      typeof payload.nonce === "string" &&
      payload.nonce.length >= 16 &&
      Number(payload.iat) <= current + 60 &&
      Number(payload.exp) > current &&
      Number(payload.exp) - Number(payload.iat) <= SESSION_TTL_SECONDS;
  } catch {
    return false;
  }
}

async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const left = new Uint8Array(candidateHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function isConfigured(env: Env): boolean {
  return typeof env.APP_PASSWORD === "string" &&
    env.APP_PASSWORD.length >= 8 &&
    typeof env.SESSION_SECRET === "string" &&
    env.SESSION_SECRET.length >= 32;
}

function readSessionCookie(request: Request): string {
  const cookieHeader = request.headers.get("cookie") || "";
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === COOKIE_NAME) return item.slice(separator + 1).trim();
  }
  return "";
}

function sessionCookie(token: string): string {
  return COOKIE_NAME + "=" + token + "; Path=/; Max-Age=" + SESSION_TTL_SECONDS + "; HttpOnly; Secure; SameSite=Strict";
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (!isConfigured(env)) return false;
  return verifySessionToken(readSessionCookie(request), env.SESSION_SECRET!, Date.now());
}

async function recordLoginAttempt(env: Env): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const limiter = env.JOBS.get(env.JOBS.idFromName("image-scraper-auth-rate-limit"));
  const response = await limiter.fetch("https://auth.internal/auth/attempt", { method: "POST" });
  const result = await response.json() as { allowed?: boolean; retryAfterSeconds?: number };
  if (response.status === 429) return { allowed: false, retryAfterSeconds: result.retryAfterSeconds };
  if (!response.ok) throw new Error("LOGIN_RATE_LIMIT_UNAVAILABLE");
  return { allowed: result.allowed === true, retryAfterSeconds: result.retryAfterSeconds };
}

async function resetLoginAttempts(env: Env): Promise<void> {
  const limiter = env.JOBS.get(env.JOBS.idFromName("image-scraper-auth-rate-limit"));
  await limiter.fetch("https://auth.internal/auth/reset", { method: "POST" });
}

export async function handleAuthRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && origin && origin !== new URL(request.url).origin) {
    return json({ error: "CROSS_ORIGIN_REQUEST" }, 403);
  }
  if (path === "/api/auth/status" && request.method === "GET") {
    const configured = isConfigured(env);
    return json({ configured, authenticated: configured && await isAuthenticated(request, env) });
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    return json({ authenticated: false }, 200, {
      "set-cookie": COOKIE_NAME + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"
    });
  }

  if (path !== "/api/auth/login" || request.method !== "POST") return null;
  if (!isConfigured(env)) return json({ error: "PASSWORD_AUTH_NOT_CONFIGURED" }, 503);

  const limit = await recordLoginAttempt(env);
  if (!limit.allowed) {
    const retryAfter = Math.max(1, limit.retryAfterSeconds || 900);
    return json({ error: "LOGIN_RATE_LIMITED" }, 429, { "retry-after": String(retryAfter) });
  }

  const body = await readJson<{ password?: unknown }>(request);
  if (typeof body.password !== "string" || body.password.length > 256 ||
    !await passwordMatches(body.password, env.APP_PASSWORD!)) {
    return json({ error: "INVALID_PASSWORD" }, 401);
  }

  await resetLoginAttempts(env);
  const token = await createSessionToken(env.SESSION_SECRET!);
  return json({ authenticated: true }, 200, { "set-cookie": sessionCookie(token) });
}
