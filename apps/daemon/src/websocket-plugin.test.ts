import { strict as assert } from "node:assert";
import { Writable } from "node:stream";
import { test } from "node:test";

import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";

import { testAuthSessions } from "./auth/testing.ts";
import { createServer } from "./index.js";

type CreateServerArgs = Parameters<typeof createServer>;

// @fastify/websocket's preClose hook closes its WebSocketServer. Fastify copies a hook added after
// child contexts exist onto each of them, so a plugin registered late closed the server once per
// child (`wss.close(cb)` → one `close` listener each): past ten, Node's MaxListenersExceededWarning
// at every daemon shutdown. Registered before any child context, it closes it once.
test("shutting the app down leaves no WebSocketServer listener warning", async (t) => {
  const { authSessions } = await testAuthSessions();
  const services = { authSessions } as unknown as CreateServerArgs[4];
  const resolved = { daemonDir: "/tmp", workspacesDir: "/tmp", workspacesMetaFile: "/tmp/workspaces.json", fsRoot: "/tmp" } as unknown as CreateServerArgs[1];
  const log = new Writable({ write: (_chunk, _encoding, done) => done() });
  const app = createServer(createDefaultDaemonConfig({ env: {} }), resolved, createDefaultClientConfig("/tmp/daemon.sock"), log, services, {
    authRequired: true,
    mode: "remote"
  });
  t.after(() => app.close());
  await app.ready();
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await app.close();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", onWarning);
  }
  assert.deepEqual(warnings.filter((name) => name === "MaxListenersExceededWarning"), []);
});
