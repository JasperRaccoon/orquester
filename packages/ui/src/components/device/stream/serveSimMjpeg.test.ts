import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { ServeSimMjpegSession } from "./serveSimMjpeg.ts";
import { fakeCanvas, fakeImageBitmaps, fakeStreamingFetch, settle, testDeps } from "./testing/fakes.ts";

const URL = "http://hub.test/vendor/serve-sim/helper/UDID/stream.mjpeg";
const enc = new TextEncoder();
const part = (n: number) => {
  const body = Uint8Array.from([0xff, 0xd8, n, 0xff, 0xd9]);
  const head = enc.encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(head.length + body.length + 2);
  out.set(head);
  out.set(body, head.length);
  out.set([13, 10], head.length + body.length);
  return out;
};

const sessions: ServeSimMjpegSession[] = [];
beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  mock.timers.reset();
});

function setup(contentType = "multipart/x-mixed-replace; boundary=frame") {
  const http = fakeStreamingFetch();
  http.respondWith(200, contentType);
  const bitmaps = fakeImageBitmaps((bytes) => ({ width: 400 + bytes[2]!, height: 874 }));
  const canvas = fakeCanvas();
  const painted: number[] = [];
  const session = new ServeSimMjpegSession({
    url: URL,
    headers: { Authorization: "Bearer t" },
    canvas,
    deps: testDeps({ fetch: http.fetch, createImageBitmap: bitmaps.createImageBitmap }),
    onFrame: () => painted.push(canvas.width - 400)
  });
  sessions.push(session);
  return { session, http, bitmaps, painted, request: () => http.requests.at(-1)! };
}

describe("ServeSimMjpegSession", () => {
  it("paints each part and reports live with the mjpeg decoder", async () => {
    const t = setup();
    await settle();
    assert.equal(t.request().url, URL);
    assert.equal(new Headers(t.request().init?.headers).get("authorization"), "Bearer t", "the bearer rides as a header");
    t.request().push(part(1));
    await settle();
    t.request().push(part(2));
    await settle();
    assert.deepEqual(t.painted, [1, 2]);
    assert.equal(t.session.state, "live");
    assert.equal(t.session.stats().decoder, "mjpeg");
  });

  it("keeps only the newest frame while a decode is running", async () => {
    const t = setup();
    await settle();
    const release = t.bitmaps.hold();
    t.request().push(part(1));
    await settle();
    t.request().push(part(2));
    t.request().push(part(3));
    t.request().push(part(4));
    await settle();
    release();
    await settle();
    assert.deepEqual(t.painted, [1, 4]);
  });

  it("paints only the last of several parts that arrive in one read", async () => {
    const t = setup();
    await settle();
    const bytes = new Uint8Array([...part(5), ...part(6), ...part(7)]);
    t.request().push(bytes);
    await settle();
    assert.deepEqual(t.painted, [7]);
  });

  it("retries a response that is not multipart", async () => {
    const t = setup("image/jpeg");
    await settle();
    assert.equal(t.session.error?.code, "protocol");
    mock.timers.tick(500);
    await settle();
    assert.equal(t.http.requests.length, 2);
  });
});
