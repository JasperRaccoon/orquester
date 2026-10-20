import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { test } from "node:test";

import { MCP_BRIDGE_ENTRY_VERSION, writeMcpBridgeEntry, type McpBridgeEntry } from "../../agent-host/boxes/mcp-bridge-registry.ts";
import type { BoxChannelHandler, BoxRequestContext } from "../contracts.ts";
import { registerMcpBridge } from "./mcp-bridge.ts";

/** Both ends of an `mcp-bridge` channel: what the box writes, and what it reads back. */
function channel(): { stream: Duplex; toHost: PassThrough; fromHost: PassThrough; closed: Promise<void> } {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  let closedResolve!: () => void;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const stream = new Duplex({
    read() {
      // Pushed from `toHost` below.
    },
    write(chunk, _encoding, callback) {
      fromHost.write(chunk);
      callback();
    },
    final(callback) {
      fromHost.end();
      callback();
    }
  });
  toHost.on("data", (chunk: Buffer) => stream.push(chunk));
  toHost.on("end", () => stream.push(null));
  stream.on("close", closedResolve);
  return { stream, toHost, fromHost, closed };
}

function lines(stream: PassThrough): { next: () => Promise<Record<string, unknown>> } {
  let buffer = "";
  const queue: Record<string, unknown>[] = [];
  const waiters: ((value: Record<string, unknown>) => void)[] = [];
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const value = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else queue.push(value);
    }
  });
  return { next: () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve))) };
}

function hubCapture(): { hub: { handleChannel: (kind: string, handler: BoxChannelHandler) => void }; handler: () => BoxChannelHandler } {
  let registered: BoxChannelHandler | undefined;
  return {
    hub: {
      handleChannel: (kind, handler) => {
        assert.equal(kind, "mcp-bridge");
        registered = handler;
      }
    },
    handler: () => registered!
  };
}

const context = (boxId: string): BoxRequestContext => ({ boxId, record: { id: boxId } as BoxRequestContext["record"] });

function entry(appdir: string, overrides: Partial<McpBridgeEntry>): McpBridgeEntry {
  return {
    version: MCP_BRIDGE_ENTRY_VERSION,
    boxId: "box-1",
    serverId: "server-id-aaaaaaaaaaaaaaaaaaaaaaaa",
    name: "fake",
    threadId: "t1",
    target: { transport: "stdio", command: process.execPath, args: [], env: {} },
    createdAt: "2026-10-20T00:00:00.000Z",
    ...overrides
  };
}

test("a bridged stdio server runs on the host with its own env, piped to the box, and dies with the channel", async () => {
  const appdir = await mkdtemp(join(tmpdir(), "mcp-bridge-"));
  const server = join(appdir, "fake-mcp.mjs");
  // A stand-in stdio MCP server: answers each request with its method and the secret it sees.
  await writeFile(
    server,
    `let b = ""; process.stdin.on("data", (c) => { b += c; let i; while ((i = b.indexOf("\\n")) !== -1) { const m = JSON.parse(b.slice(0, i)); b = b.slice(i + 1);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { method: m.method, secret: process.env.FAKE_SECRET } }) + "\\n"); } });
     process.on("SIGTERM", () => process.exit(0));`,
    "utf8"
  );
  await writeMcpBridgeEntry(
    appdir,
    entry(appdir, { target: { transport: "stdio", command: process.execPath, args: [server], env: { FAKE_SECRET: "host-only" } } })
  );
  const capture = hubCapture();
  let exited!: (detail: Record<string, unknown> | undefined) => void;
  const serverExit = new Promise<Record<string, unknown> | undefined>((resolve) => {
    exited = resolve;
  });
  registerMcpBridge(capture.hub, {
    appdir,
    baseEnv: () => ({ PATH: process.env.PATH ?? "" }),
    logger: {
      info: (message, detail) => {
        if (message.includes("exited")) exited(detail);
      }
    }
  });
  const link = channel();
  capture.handler()(context("box-1"), { kind: "mcp-bridge", serverId: "server-id-aaaaaaaaaaaaaaaaaaaaaaaa" }, link.stream);
  const replies = lines(link.fromHost);
  link.toHost.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  assert.deepEqual(await replies.next(), { jsonrpc: "2.0", id: 1, result: { method: "initialize", secret: "host-only" } });
  link.toHost.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  assert.deepEqual(await replies.next(), { jsonrpc: "2.0", id: 2, result: { method: "tools/list", secret: "host-only" } });
  // The box closing the channel ends the server (SIGTERM; this one exits 0 on it).
  link.stream.destroy();
  const detail = await serverExit;
  assert.equal(detail?.code, 0);
  assert.equal(detail?.server, "fake");
});

test("an id the box's directory does not hold is refused: the channel closes, nothing runs", async () => {
  const appdir = await mkdtemp(join(tmpdir(), "mcp-bridge-"));
  await writeMcpBridgeEntry(appdir, entry(appdir, { boxId: "box-1" }));
  const capture = hubCapture();
  registerMcpBridge(capture.hub, { appdir });
  const link = channel();
  // Another box naming box-1's server id.
  capture.handler()(context("box-2"), { kind: "mcp-bridge", serverId: "server-id-aaaaaaaaaaaaaaaaaaaaaaaa" }, link.stream);
  await link.closed;
});

test("a bridged HTTP server is reached from the host with its headers; the box never sees them", async () => {
  const appdir = await mkdtemp(join(tmpdir(), "mcp-bridge-"));
  const seen: { authorization: string | undefined; body: unknown }[] = [];
  const http = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(body) as { id?: number; method: string };
      seen.push({ authorization: request.headers.authorization, body: message });
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", echoed: message.method } }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  try {
    await writeMcpBridgeEntry(
      appdir,
      entry(appdir, {
        name: "orquester",
        target: { transport: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer session-credential" } }
      })
    );
    const capture = hubCapture();
    registerMcpBridge(capture.hub, { appdir });
    const link = channel();
    capture.handler()(context("box-1"), { kind: "mcp-bridge", serverId: "server-id-aaaaaaaaaaaaaaaaaaaaaaaa" }, link.stream);
    const replies = lines(link.fromHost);
    link.toHost.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "box", version: "1" } } })}\n`);
    assert.deepEqual(await replies.next(), { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", echoed: "initialize" } });
    link.toHost.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    link.toHost.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    assert.deepEqual(await replies.next(), { jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18", echoed: "tools/list" } });
    assert.equal(seen.length, 3);
    assert.ok(seen.every((request) => request.authorization === "Bearer session-credential"));
    link.stream.destroy();
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
