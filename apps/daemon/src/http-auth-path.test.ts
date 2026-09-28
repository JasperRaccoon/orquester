/**
 * The remote HTTP transport's bearer hook gates every `/api`, `/events` and
 * `/mcp` route whatever spelling of the path reaches the router: the router
 * percent-decodes a path before matching it, so the hook must not decide on the
 * raw request line alone (`/%61pi/...` is routed to `/api/...`).
 */

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { test } from "node:test";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "./index.ts";

type CreateServerArgs = Parameters<typeof createServer>;
const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const BEARER = `Bearer ${Buffer.from(`${USERNAME}:${PASSWORD_HASH}`).toString("base64")}`;

function remoteApp(services: Record<string, unknown>) {
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const root = "/nonexistent-orquester-auth-path-test";
  const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root } as unknown as CreateServerArgs[1];
  return createServer(
    config,
    resolved,
    createDefaultClientConfig(`${root}/daemon.sock`),
    createWriteStream("/dev/null"),
    services as unknown as CreateServerArgs[4],
    { authRequired: true, mode: "remote" }
  );
}

test("the bearer hook refuses percent-encoded spellings of a gated path", async () => {
  let reads = 0;
  const app = remoteApp({
    agentProfile: {
      overview: async () => {
        reads += 1;
        return { agents: [] };
      }
    }
  });
  try {
    for (const url of [
      "/api/agent-profile",
      "/%61pi/agent-profile",
      "/%61%70%69/agent-profile",
      "/%41pi/agent-profile",
      "/api/agent-profil%65",
      "/%65vents",
      "/%6dcp"
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.ok(res.statusCode === 401 || res.statusCode === 404, `${url} answered ${res.statusCode}`);
    }
    assert.equal(reads, 0);
    const authorized = await app.inject({ method: "GET", url: "/%61pi/agent-profile", headers: { authorization: BEARER } });
    assert.equal(authorized.statusCode, 200);
    assert.equal(reads, 1);
    // The public auth-info endpoint stays public.
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/info" })).statusCode, 200);
  } finally {
    await app.close();
  }
});
