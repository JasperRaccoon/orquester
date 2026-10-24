import { strict as assert } from "node:assert";
import { test } from "node:test";
import { constants as zlibConstants, gunzipSync } from "node:zlib";

import {
  NdjsonForwarder,
  acceptsGzip,
  createStreamingGzip
} from "./ndjson-forward.ts";

test("gzip is accepted by name or wildcard, never at q=0", () => {
  assert.equal(acceptsGzip(undefined), false);
  assert.equal(acceptsGzip(""), false);
  assert.equal(acceptsGzip("identity"), false);
  assert.equal(acceptsGzip("gzip, deflate, br, zstd"), true, "a browser's fetch");
  assert.equal(acceptsGzip("GZIP"), true);
  assert.equal(acceptsGzip("x-gzip"), true);
  assert.equal(acceptsGzip("br;q=1.0, gzip;q=0.5"), true);
  assert.equal(acceptsGzip("gzip;q=0"), false);
  assert.equal(acceptsGzip("gzip;q=0, *"), false, "an explicit refusal beats the wildcard");
  assert.equal(acceptsGzip("*"), true);
  assert.equal(acceptsGzip("*;q=0"), false);
  assert.equal(acceptsGzip(["deflate", "gzip"]), true);
});

function collect(forwarder: NdjsonForwarder): () => string {
  const chunks: Buffer[] = [];
  forwarder.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString("utf8");
}

test("a heartbeat goes in only between lines, and only after the idle time", () => {
  let now = 1_000;
  const forwarder = new NdjsonForwarder(() => now);
  const output = collect(forwarder);

  assert.equal(forwarder.heartbeatIfIdle(2_500), false, "not idle long enough yet");
  now += 2_500;
  assert.equal(forwarder.heartbeatIfIdle(2_500), true, "idle at a line start");

  forwarder.write('{"kind":"snap');
  now += 10_000;
  assert.equal(forwarder.heartbeatIfIdle(2_500), false, "a comment mid-line would corrupt it");
  forwarder.write('shot"}\n');
  assert.equal(forwarder.heartbeatIfIdle(2_500), false, "bytes just flowed");
  now += 2_500;
  assert.equal(forwarder.heartbeatIfIdle(2_500), true);

  assert.equal(output(), ':hb\n{"kind":"snapshot"}\n:hb\n');
  forwarder.end();
  assert.equal(forwarder.heartbeatIfIdle(0), false, "nothing after the end");
});

test("the streaming encoder flushes every write: each line decodes before the stream ends", async () => {
  const gzip = createStreamingGzip();
  const received: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => received.push(chunk));
  const first = new Promise<void>((resolve) => gzip.once("data", () => resolve()));
  gzip.write('{"kind":"synchronized","hostInstanceId":"h"}\n');
  await first;
  // A sync-flushed prefix inflates on its own: the client sees the line now.
  const decoded = gunzipSync(Buffer.concat(received), { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString("utf8");
  assert.equal(decoded, '{"kind":"synchronized","hostInstanceId":"h"}\n');
  gzip.end();
});
