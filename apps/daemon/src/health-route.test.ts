/**
 * `/health` and `/api/info` on the remote transport: liveness stays public and
 * names only the service and the wire protocol (what a client needs to tell
 * "not an Orquester daemon" and "incompatible app" from "unreachable"); the
 * daemon's build stays behind authentication. Info also names the build of
 * the web app the transport serves, read from that dist's `build-id`.
 */

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ORQUESTER_PROTOCOL_VERSION, ORQUESTER_SERVICE } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { testAuthSessions } from "./auth/testing.ts";
import { createServer } from "./index.ts";

type CreateServerArgs = Parameters<typeof createServer>;
const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";

test("health is public and identifies the service; info carries the build to signed-in clients", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orq-health-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { authSessions, bearer } = await testAuthSessions();
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root, appConfigFile: join(root, "app.json") } as unknown as CreateServerArgs[1];
  const app = createServer(
    config,
    resolved,
    createDefaultClientConfig(`${root}/daemon.sock`),
    createWriteStream("/dev/null"),
    { buildInfo: { version: "1.2.3", commit: "0123456789abcdef0123456789abcdef01234567" }, authSessions } as unknown as CreateServerArgs[4],
    { authRequired: true, mode: "remote" }
  );
  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { ok: true, service: ORQUESTER_SERVICE, protocol: ORQUESTER_PROTOCOL_VERSION });

    assert.equal((await app.inject({ method: "GET", url: "/api/info" })).statusCode, 401);
    const info = await app.inject({ method: "GET", url: "/api/info", headers: { authorization: bearer } });
    assert.equal(info.statusCode, 200);
    const body = info.json() as { protocol: number; build: string | null; version: string; commit: string };
    assert.equal(body.protocol, ORQUESTER_PROTOCOL_VERSION);
    assert.equal(body.build, "0123456789ab");
    assert.equal(body.version, "1.2.3");
    assert.equal(body.commit, "0123456789abcdef0123456789abcdef01234567");
  } finally {
    await app.close();
  }
});

test("info reports the build-id of the web dist the transport serves, not the daemon's commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orq-health-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html><title>spa</title>");
  await writeFile(join(root, "build-id"), "0a1b2c3\n");
  const { authSessions, bearer } = await testAuthSessions();
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root, appConfigFile: join(root, "app.json") } as unknown as CreateServerArgs[1];
  const server = (serveWeb?: string) =>
    createServer(
      config,
      resolved,
      createDefaultClientConfig(`${root}/daemon.sock`),
      createWriteStream("/dev/null"),
      { buildInfo: { version: "1.2.3", commit: "0123456789abcdef0123456789abcdef01234567" }, authSessions } as unknown as CreateServerArgs[4],
      { authRequired: true, mode: "remote", serveWeb }
    );
  const info = async (app: ReturnType<typeof server>) =>
    (await app.inject({ method: "GET", url: "/api/info", headers: { authorization: bearer } })).json() as { build: string | null; webBuild: string | null };

  const web = server(root);
  const bare = server();
  try {
    const first = await info(web);
    assert.equal(first.build, "0123456789ab");
    assert.equal(first.webBuild, "0a1b2c3");
    // A dev checkout rebuilds its dist under the running daemon.
    await writeFile(join(root, "build-id"), "def5678\n");
    assert.equal((await info(web)).webBuild, "def5678");
    assert.equal((await info(bare)).webBuild, null, "a transport that serves no web app");
  } finally {
    await web.close();
    await bare.close();
  }
});
