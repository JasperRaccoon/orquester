import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pipeHttpStream } from "./http-stream";

/** A local server answering every GET with `handle`; the stream under test reads from it. */
async function serve(handle: (res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => handle(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/events`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

/** Open the stream; `ended` resolves with every end call once the first arrives (plus a turn). */
function open(target: string | http.RequestOptions): { chunks: string[]; ends: Array<number | undefined>; ended: Promise<void>; firstData: Promise<void> } {
  const chunks: string[] = [];
  let gotData!: () => void;
  const firstData = new Promise<void>((resolve) => (gotData = resolve));
  const ends: Array<number | undefined> = [];
  let signal!: () => void;
  const ended = new Promise<void>((resolve) => (signal = resolve));
  const req = typeof target === "string" ? http.request(target, { method: "GET" }) : http.request({ ...target, method: "GET" });
  pipeHttpStream(req, {
    data: (chunk) => {
      chunks.push(chunk);
      gotData();
    },
    end: (status) => {
      ends.push(status);
      // Let any further (wrong) end calls land before the test looks.
      setImmediate(signal);
    }
  });
  req.end();
  return { chunks, ends, ended, firstData };
}

test("a clean end ends the stream once", async (t) => {
  const server = await serve((res) => {
    res.writeHead(200);
    res.end("all\n");
  });
  t.after(server.close);
  const stream = open(server.url);
  await stream.ended;
  assert.deepEqual(stream.chunks, ["all\n"]);
  assert.deepEqual(stream.ends, [undefined]);
});

test("an error answer reports its status once and never its body", async (t) => {
  const server = await serve((res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "UNAUTHORIZED" }));
  });
  t.after(server.close);
  const stream = open(server.url);
  await stream.ended;
  assert.deepEqual(stream.chunks, []);
  assert.deepEqual(stream.ends, [401]);
});

test("a request that cannot connect ends the stream once", async () => {
  const server = await serve(() => undefined);
  const { url } = server;
  await server.close();
  const stream = open(url);
  await stream.ended;
  assert.deepEqual(stream.ends, [undefined]);
});

/** The embedded daemon's transport: HTTP over a unix socket. */
async function serveSocket(handle: (res: http.ServerResponse) => void): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "orq-desktop-stream-"));
  const socketPath = join(dir, "daemon.sock");
  const server = http.createServer((_req, res) => handle(res));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  };
}

test("over the unix socket: a daemon restart cutting the stream ends it once", async (t) => {
  let cut!: () => void;
  const server = await serveSocket((res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write("event\n");
    cut = () => res.destroy();
  });
  t.after(server.close);
  const stream = open({ socketPath: server.socketPath, path: "/events" });
  await stream.firstData;
  cut();
  await stream.ended;
  assert.deepEqual(stream.chunks, ["event\n"]);
  assert.deepEqual(stream.ends, [undefined]);
});
