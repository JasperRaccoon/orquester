import { strict as assert } from "node:assert";
import { createWriteStream } from "node:fs";
import { test } from "node:test";

import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";

import { testAuthSessions } from "./auth/testing.ts";
import { createServer } from "./index.js";

type CreateServerArgs = Parameters<typeof createServer>;

// @fastify/websocket's preClose hook closes its WebSocketServer. Fastify copies a hook added after
// child contexts exist onto each of them, so a plugin registered late closed the server once per
// child (`wss.close(cb)` → one `close` listener each): past ten, Node's MaxListenersExceededWarning
// at every daemon shutdown. Registered before any child context, it closes it once.
for (const mode of ["local", "remote"] as const) {
  test(`${mode}: shutting the app down closes the WebSocket server once (close listeners stay bounded)`, async () => {
    const { authSessions } = await testAuthSessions();
    const services = { authSessions } as unknown as CreateServerArgs[4];
    const resolved = { daemonDir: "/tmp", workspacesDir: "/tmp", workspacesMetaFile: "/tmp/workspaces.json", fsRoot: "/tmp" } as unknown as CreateServerArgs[1];
    const app = createServer(createDefaultDaemonConfig({ env: {} }), resolved, createDefaultClientConfig("/tmp/daemon.sock"), createWriteStream("/dev/null"), services, {
      authRequired: mode === "remote",
      mode
    });
    await app.ready();
    const wss = app.websocketServer;
    const close = wss.close.bind(wss);
    let calls = 0;
    let most = 0;
    wss.close = ((cb?: (error?: Error) => void) => {
      calls += 1;
      close(cb);
      most = Math.max(most, wss.listenerCount("close"));
    }) as typeof wss.close;
    const warnings: string[] = [];
    const onWarning = (warning: Error) => void warnings.push(warning.message);
    process.on("warning", onWarning);
    try {
      await app.close();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }
    assert.equal(calls, 1, "the WebSocket server is closed once");
    assert.ok(most <= 1, `close listeners: ${most}`);
    assert.deepEqual(warnings.filter((message) => /WebSocketServer/.test(message)), []);
  });
}
