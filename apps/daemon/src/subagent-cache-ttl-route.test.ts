/**
 * `GET /api/usage/subagent-cache-ttl` through the daemon's own router: it
 * answers for the mode stored in app.json at the time of the request, and on
 * the remote transport only to an authenticated client.
 */

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "./index.ts";
import { SubagentCacheTtlController } from "./subagent-cache-ttl.ts";
import { testAuthSessions } from "./auth/testing.ts";

type CreateServerArgs = Parameters<typeof createServer>;
const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const { authSessions: AUTH_SESSIONS, bearer: BEARER } = await testAuthSessions();
const NOW = Date.parse("2026-10-11T00:00:00Z");

test("the status route answers for the stored mode, to authenticated clients only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orq-sub-ttl-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appConfigFile = join(root, "app.json");
  const subagentCacheTtl = new SubagentCacheTtlController({
    stateFile: join(root, "subagent-cache-ttl.json"),
    now: () => NOW,
    requests: () => null
  });
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root, appConfigFile } as unknown as CreateServerArgs[1];
  const app = createServer(
    config,
    resolved,
    createDefaultClientConfig(`${root}/daemon.sock`),
    createWriteStream("/dev/null"),
    { subagentCacheTtl, authSessions: AUTH_SESSIONS } as unknown as CreateServerArgs[4],
    { authRequired: true, mode: "remote" }
  );
  const get = (headers?: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/usage/subagent-cache-ttl", headers });
  try {
    assert.equal((await get()).statusCode, 401);

    await writeFile(appConfigFile, JSON.stringify({ agents: { claudeSubagentCacheTtl: "5m" } }), "utf8");
    assert.deepEqual((await get({ authorization: BEARER })).json(), {
      mode: "5m",
      ttl: "5m",
      lastCheck: null,
      nextCheckAt: null
    });

    await writeFile(appConfigFile, JSON.stringify({ agents: { claudeSubagentCacheTtl: "1h" } }), "utf8");
    assert.deepEqual((await get({ authorization: BEARER })).json(), {
      mode: "1h", ttl: "1h", lastCheck: null, nextCheckAt: null
    });

    // No app.json group at all is the default: auto. Usage is not ready yet.
    await writeFile(appConfigFile, "{}", "utf8");
    assert.deepEqual((await get({ authorization: BEARER })).json(), {
      mode: "auto",
      ttl: "5m",
      lastCheck: null,
      nextCheckAt: null
    });
  } finally {
    await app.close();
  }
});
