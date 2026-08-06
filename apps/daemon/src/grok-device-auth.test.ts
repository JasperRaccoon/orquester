import { test } from "node:test";
import assert from "node:assert/strict";
import { grokAuthJsonFromDeviceTokens } from "./grok-device-auth.ts";

const GROK_ENTRY_KEY = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

test("device tokens become a CLI-shaped auth.json with identity from the id_token", () => {
  const now = Date.parse("2026-08-06T12:00:00Z");
  const native = grokAuthJsonFromDeviceTokens(
    {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 21600,
      id_token: jwt({ email: "me@example.com", sub: "user-1" })
    },
    now
  );
  const entry = native[GROK_ENTRY_KEY] as Record<string, unknown>;
  assert.ok(entry);
  assert.equal(entry.key, "at");
  assert.equal(entry.refresh_token, "rt");
  assert.equal(entry.auth_mode, "oidc");
  assert.equal(entry.email, "me@example.com");
  assert.equal(entry.user_id, "user-1");
  assert.equal(entry.expires_at, new Date(now + 21600_000).toISOString());
  assert.equal(entry.create_time, new Date(now).toISOString());
});

test("identity is optional: no id_token still yields an importable credential", () => {
  const native = grokAuthJsonFromDeviceTokens({ access_token: "at", refresh_token: "rt" }, 0);
  const entry = native[GROK_ENTRY_KEY] as Record<string, unknown>;
  assert.equal(entry.key, "at");
  assert.equal("email" in entry, false);
  assert.equal("expires_at" in entry, false);
});
