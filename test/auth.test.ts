import { describe, expect, it } from "vitest";
import { createSessionToken, SESSION_TTL_SECONDS, verifySessionToken } from "../src/auth";

const sessionSecret = "test-session-signing-secret-with-more-than-thirty-two-characters";

describe("password session tokens", () => {
  it("accepts a valid signed session", async () => {
    const token = await createSessionToken(sessionSecret);
    expect(await verifySessionToken(token, sessionSecret)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(sessionSecret);
    expect(await verifySessionToken(token, "another-session-secret-with-more-than-thirty-two-characters")).toBe(false);
  });

  it("rejects a modified signature", async () => {
    const token = await createSessionToken(sessionSecret);
    const [payload, signature] = token.split(".");
    const replacement = signature![0] === "A" ? "B" : "A";
    expect(await verifySessionToken(payload + "." + replacement + signature!.slice(1), sessionSecret)).toBe(false);
  });

  it("rejects expired sessions", async () => {
    const now = Date.now();
    const token = await createSessionToken(sessionSecret, now - (SESSION_TTL_SECONDS + 1) * 1000);
    expect(await verifySessionToken(token, sessionSecret, now)).toBe(false);
  });

  it("rejects malformed tokens", async () => {
    expect(await verifySessionToken("not-a-session", sessionSecret)).toBe(false);
  });
});
