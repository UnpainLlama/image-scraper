import { createRemoteJWKSet, jwtVerify } from "jose";
import { json } from "./http";
import type { Env } from "./types";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizeTeamDomain(value: string): string | null {
  const cleaned = value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(cleaned)) return null;
  return cleaned;
}

export async function verifyAccess(request: Request, env: Env): Promise<Response | null> {
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN || "");
  const audience = (env.ACCESS_AUD || "").trim();
  if (!teamDomain || !audience) return json({ error: "ACCESS_NOT_CONFIGURED" }, 503);
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) return json({ error: "ACCESS_REQUIRED" }, 401);

  try {
    let keySet = keySets.get(teamDomain);
    if (!keySet) {
      const issuer = "https://" + teamDomain;
      keySet = createRemoteJWKSet(new URL(issuer + "/cdn-cgi/access/certs"), {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60 * 1000
      });
      keySets.set(teamDomain, keySet);
    }
    await jwtVerify(assertion, keySet, {
      issuer: "https://" + teamDomain,
      audience
    });
    return null;
  } catch {
    return json({ error: "ACCESS_TOKEN_INVALID" }, 401);
  }
}