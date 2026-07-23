import { strict as assert } from "node:assert";
import { createWriteStream } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "./index.js";

// Route-level coverage for the two DevTools proxies (Tasks 2 & 3). The pure
// helpers (devtools.test.ts) don't exercise the wiring these tests pin down:
// the remote-only gate, the traversal 404 short-circuit, ?token= auth, the
// pre-handshake client-message queue, and the loopback Host rewrite. A fake
// `ws` upstream stands in for Chromium so no real browser launches.

const USERNAME = "admin";
// authorizeCredential only sha256-compares the stored hash string against the
// hash half of the credential — any non-empty string works as a fixture.
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const CREDENTIAL = Buffer.from(`${USERNAME}:${PASSWORD_HASH}`).toString("base64");
const BROWSER_ID = "tab-abc";
const TARGET_ID = "TARGET-1";

type CreateServerArgs = Parameters<typeof createServer>;

interface Harness {
  port: number;
  upstream: WebSocketServer;
  upstreamPort: number;
  devtoolsPortCalls: number;
  /** Set by tests that need a listening HTTP endpoint. */
  listen: () => Promise<number>;
  inject: ReturnType<typeof createServer>["inject"];
  close: () => Promise<void>;
}

async function makeHarness(mode: "local" | "remote"): Promise<Harness> {
  // A fake loopback ws upstream stands in for the tab's Chromium debug port.
  // Tests that don't dial it (traversal / auth / absence) simply never trigger
  // a connection.
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolvePromise) => upstream.once("listening", resolvePromise));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;

  const harness: Partial<Harness> = { devtoolsPortCalls: 0, upstream, upstreamPort };

  const resolved = {
    daemonDir: "/tmp",
    workspacesDir: "/tmp",
    workspacesMetaFile: "/tmp/workspaces.json",
    fsRoot: "/tmp"
  } as unknown as CreateServerArgs[1];

  const services = {
    browsers: {
      devtoolsPort: async () => {
        harness.devtoolsPortCalls = (harness.devtoolsPortCalls ?? 0) + 1;
        return upstreamPort;
      },
      devtoolsEndpoint: async () => ({ port: upstreamPort, targetId: TARGET_ID })
    }
  } as unknown as CreateServerArgs[4];

  const app = createServer(
    config,
    resolved,
    createDefaultClientConfig("/tmp/daemon.sock"),
    createWriteStream("/dev/null"),
    services,
    { authRequired: mode === "remote", mode }
  );

  harness.inject = app.inject.bind(app);
  harness.listen = async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as AddressInfo;
    harness.port = addr.port;
    return addr.port;
  };
  harness.close = async () => {
    await app.close();
    await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
  };
  return harness as Harness;
}

/** Connect a real ws client and resolve once it opens-and-closes or errors. */
function probeWs(url: string, timeoutMs = 5000): Promise<{ opened: boolean; code?: number }> {
  return new Promise((resolvePromise) => {
    const client = new WebSocket(url);
    let opened = false;
    let done = false;
    const finish = (r: { opened: boolean; code?: number }) => {
      if (done) return;
      done = true;
      try {
        client.close();
      } catch {
        /* closing */
      }
      resolvePromise(r);
    };
    const timer = setTimeout(() => finish({ opened }), timeoutMs);
    timer.unref?.();
    client.on("open", () => {
      opened = true;
    });
    client.on("close", (code) => finish({ opened, code }));
    client.on("error", () => {
      if (!opened) finish({ opened: false });
    });
  });
}

test("asset route 404s on path traversal and never reaches upstream", async (t) => {
  const h = await makeHarness("remote");
  t.after(() => h.close());

  const res = await h.inject({
    method: "GET",
    url: `/devtools-frontend/${BROWSER_ID}/..%2fjson%2flist`
  });
  assert.equal(res.statusCode, 404);
  // devtoolsPort is only consulted after the sanitizer passes; a rejected path
  // must short-circuit before any upstream lookup.
  assert.equal(h.devtoolsPortCalls, 0);
});

test("asset + ws routes are absent on the local (unix) transport", async (t) => {
  const h = await makeHarness("local");
  t.after(() => h.close());

  const asset = await h.inject({
    method: "GET",
    url: `/devtools-frontend/${BROWSER_ID}/inspector.html`
  });
  assert.equal(asset.statusCode, 404);

  // The WS route is gated to remote too; the upgrade request finds no route and
  // is refused (never upgraded). inject routes it without a real socket.
  const ws = await h.inject({
    method: "GET",
    url: `/ws-devtools/${BROWSER_ID}`,
    headers: {
      connection: "upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13"
    }
  });
  assert.equal(ws.statusCode, 404);
});

test("ws route rejects a missing/invalid token with 1008 on the remote transport", async (t) => {
  const h = await makeHarness("remote");
  t.after(() => h.close());

  const port = await h.listen();
  const result = await probeWs(`ws://127.0.0.1:${port}/ws-devtools/${BROWSER_ID}`);
  assert.equal(result.opened, true);
  assert.equal(result.code, 1008);
});

test("ws route preserves a client message sent before the upstream handshake", async (t) => {
  const h = await makeHarness("remote");
  t.after(() => h.close());

  const received = new Promise<Buffer>((resolvePromise) => {
    h.upstream.on("connection", (ws) => {
      ws.on("message", (data) => resolvePromise(data as Buffer));
    });
  });

  const port = await h.listen();
  const client = new WebSocket(
    `ws://127.0.0.1:${port}/ws-devtools/${BROWSER_ID}?token=${encodeURIComponent(CREDENTIAL)}`
  );
  // Send synchronously on open — before the daemon's upstream handshake can
  // complete — to prove the pre-open queue delivers it.
  client.on("open", () => client.send("CDP_ENABLE"));

  const data = await received;
  assert.equal(data.toString(), "CDP_ENABLE");
  client.close();
});

test("ws route forwards the loopback Host header to upstream", async (t) => {
  const h = await makeHarness("remote");
  t.after(() => h.close());

  const host = new Promise<string | undefined>((resolvePromise) => {
    h.upstream.on("connection", (_ws, req) => resolvePromise(req.headers.host));
  });

  const port = await h.listen();
  const client = new WebSocket(
    `ws://127.0.0.1:${port}/ws-devtools/${BROWSER_ID}?token=${encodeURIComponent(CREDENTIAL)}`
  );
  t.after(() => client.close());

  assert.equal(await host, `127.0.0.1:${h.upstreamPort}`);
});
