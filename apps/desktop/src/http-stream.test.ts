import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
function open(url: string): { chunks: string[]; ends: Array<number | undefined>; ended: Promise<void>; firstData: Promise<void> } {
  const chunks: string[] = [];
  let gotData!: () => void;
  const firstData = new Promise<void>((resolve) => (gotData = resolve));
  const ends: Array<number | undefined> = [];
  let signal!: () => void;
  const ended = new Promise<void>((resolve) => (signal = resolve));
  const req = http.request(url, { method: "GET" });
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

test("a response the server cuts mid-body ends the stream once", async (t) => {
  let cut!: () => void;
  const server = await serve((res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write("first\n");
    cut = () => res.destroy();
  });
  t.after(server.close);
  const stream = open(server.url);
  await stream.firstData;
  cut();
  await stream.ended;
  assert.deepEqual(stream.chunks, ["first\n"]);
  assert.deepEqual(stream.ends, [undefined]);
});

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
