/**
 * `/health` and `/api/info` on the remote transport: liveness stays public and
 * names only the service and the wire protocol (what a client needs to tell
 * "not an Orquester daemon" and "incompatible app" from "unreachable"); the
 * daemon's build stays behind authentication.
 */

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ORQUESTER_PROTOCOL_VERSION, ORQUESTER_SERVICE } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "./index.ts";

type CreateServerArgs = Parameters<typeof createServer>;
const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const BEARER = `Bearer ${Buffer.from(`${USERNAME}:${PASSWORD_HASH}`).toString("base64")}`;

test("health is public and identifies the service; info carries the build to signed-in clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "orq-health-route-"));
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root, appConfigFile: join(root, "app.json") } as unknown as CreateServerArgs[1];
  const app = createServer(
    config,
    resolved,
    createDefaultClientConfig(`${root}/daemon.sock`),
    createWriteStream("/dev/null"),
    {} as unknown as CreateServerArgs[4],
    { authRequired: true, mode: "remote" }
  );
  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { ok: true, service: ORQUESTER_SERVICE, protocol: ORQUESTER_PROTOCOL_VERSION });

    assert.equal((await app.inject({ method: "GET", url: "/api/info" })).statusCode, 401);
    const info = await app.inject({ method: "GET", url: "/api/info", headers: { authorization: BEARER } });
    assert.equal(info.statusCode, 200);
    const body = info.json() as { protocol: number; build: string | null };
    assert.equal(body.protocol, ORQUESTER_PROTOCOL_VERSION);
    assert.ok(body.build === null || /^[0-9a-f]{4,40}$/.test(body.build), `build: ${body.build}`);
  } finally {
    await app.close();
  }
});
