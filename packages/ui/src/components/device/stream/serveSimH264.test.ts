import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { ServeSimH264Session } from "./serveSimH264.ts";
import {
  encodeAvccEnvelope,
  fakeCanvas,
  fakeImageBitmaps,
  fakeStreamingFetch,
  fakeVideoDecoderClass,
  settle,
  browserApis,
  restoreBrowserApis
} from "./testing/fakes.ts";

const URL = "http://hub.test/vendor/serve-sim/helper/UDID/stream.avcc";
// serve-sim's fallback-encoder description (no VUI), from T3 Code's avcConfig fixtures.
const description = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 12, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 164, 1, 0, 4, 40, 238, 60, 176
]);
const seed = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const keyframe = Uint8Array.from([0, 0, 0, 3, 0x65, 0x88, 0x84]);
const delta = Uint8Array.from([0, 0, 0, 2, 0x41, 0x9a]);

const sessions: ServeSimH264Session[] = [];
beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  restoreBrowserApis();
  mock.timers.reset();
});

function setup(decoderOptions: Parameters<typeof fakeVideoDecoderClass>[0] = { size: { width: 1206, height: 2622 } }) {
  const http = fakeStreamingFetch();
  const decoders = fakeVideoDecoderClass(decoderOptions);
  const bitmaps = fakeImageBitmaps(() => ({ width: 603, height: 1311 }));
  const canvas = fakeCanvas();
  const frames: string[] = [];
  browserApis({ fetch: http.fetch, createImageBitmap: bitmaps.createImageBitmap, VideoDecoder: decoders.VideoDecoder, EncodedVideoChunk: decoders.EncodedVideoChunk });
  const session = new ServeSimH264Session({
    url: URL,
    headers: { Authorization: "Bearer t" },
    canvas,
    onFrame: () => frames.push(`${canvas.width}x${canvas.height}`)
  });
  sessions.push(session);
  return { session, http, decoders, bitmaps, canvas, frames, request: () => http.requests.at(-1)! };
}

const stream = (...envelopes: Uint8Array[]) => {
  const out = new Uint8Array(envelopes.reduce((n, e) => n + e.length, 0));
  let offset = 0;
  for (const e of envelopes) {
    out.set(e, offset);
    offset += e.length;
  }
  return out;
};

describe("ServeSimH264Session", () => {
  it("paints the seed, then decodes video configured from the repaired avcC", async () => {
    const t = setup();
    await settle();
    assert.equal(t.request().url, URL);
    // The bearer rides as a header, never as `?token=` in the fetched URL.
    assert.equal(new Headers(t.request().init?.headers).get("authorization"), "Bearer t");
    const bytes = stream(
      encodeAvccEnvelope(4, seed),
      encodeAvccEnvelope(1, description),
      encodeAvccEnvelope(2, keyframe),
      encodeAvccEnvelope(3, delta)
    );
    // Split across reads in the middle of envelopes.
    t.request().push(bytes.subarray(0, 7));
    t.request().push(bytes.subarray(7, 30));
    await settle();
    assert.deepEqual(t.frames, ["603x1311"], "the seed bridges the wait for video");
    t.request().push(bytes.subarray(30));
    await settle();
    const [config] = t.decoders.log.configs;
    assert.equal(config!.codec, "avc1.640033");
    assert.equal(config!.optimizeForLatency, true);
    assert.deepEqual(config!.description, Uint8Array.from([
      1, 100, 0, 51, 255, 225, 0, 17, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 168, 6, 208, 68, 35,
      80, 1, 0, 4, 40, 238, 60, 176
    ]), "the known zero-reorder configuration reaches WebCodecs");
    assert.deepEqual(t.decoders.log.chunks.map((c) => [c.type, [...c.data]]), [
      ["key", [...keyframe]],
      ["delta", [...delta]]
    ]);
    assert.deepEqual(t.frames, ["603x1311", "1206x2622", "1206x2622"]);
    assert.equal(t.session.state, "live");
    assert.equal(t.session.stats().decoder, "avc1.640033");
  });

  it("never paints a late seed over decoded video, and gates deltas until a keyframe", async () => {
    const t = setup();
    await settle();
    t.request().push(stream(encodeAvccEnvelope(1, description), encodeAvccEnvelope(3, delta)));
    await settle();
    assert.equal(t.decoders.log.chunks.length, 0);
    t.request().push(stream(encodeAvccEnvelope(2, keyframe), encodeAvccEnvelope(4, seed)));
    await settle();
    assert.deepEqual(t.frames, ["1206x2622"]);
    assert.equal(t.bitmaps.decoded.length, 0);
  });

  it("ends with a fatal no-video error when the host only ever sends the seed (no H.264 encoder)", async () => {
    const t = setup();
    await settle();
    t.request().push(encodeAvccEnvelope(4, seed));
    await settle();
    assert.equal(t.session.state, "live");
    mock.timers.tick(2_000);
    assert.equal(t.session.state, "stalled");
    mock.timers.tick(6_000);
    assert.equal(t.session.state, "error");
    assert.equal(t.session.error?.code, "no-video");
    assert.equal(t.session.error?.fatal, true);
    assert.equal(t.request().init?.signal?.aborted, true);
  });

  it("fails fatally when the browser can't decode the profile", async () => {
    const t = setup({ supported: () => false });
    await settle();
    t.request().push(encodeAvccEnvelope(1, description));
    await settle();
    assert.equal(t.session.error?.code, "unsupported");
    assert.equal(t.session.state, "error");
  });

  it("reconnects after the body ends or a decoder error, and stops on 401", async () => {
    const t = setup();
    await settle();
    t.request().push(stream(encodeAvccEnvelope(1, description), encodeAvccEnvelope(2, keyframe)));
    t.request().end();
    await settle();
    assert.equal(t.session.state, "connecting");
    mock.timers.tick(500);
    await settle();
    assert.equal(t.http.requests.length, 2);
    t.request().push(stream(encodeAvccEnvelope(1, description), encodeAvccEnvelope(2, keyframe)));
    await settle();
    t.decoders.log.instances.at(-1)!.fail(new Error("decode failed"));
    assert.equal(t.session.error?.code, "decode");
    assert.equal(t.request().init?.signal?.aborted, true);
    t.http.respondWith(401);
    mock.timers.tick(500);
    await settle();
    assert.equal(t.http.requests.length, 3);
    assert.equal(t.session.state, "error");
    assert.equal(t.session.error?.code, "unauthorized");
  });

  it("close() aborts the request", async () => {
    const t = setup();
    await settle();
    t.session.close();
    assert.equal(t.request().init?.signal?.aborted, true);
    assert.equal(t.session.state, "closed");
  });
});
