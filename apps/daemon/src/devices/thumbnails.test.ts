import assert from "node:assert/strict";
import test from "node:test";

import { ImagePoolBusyError } from "./image-pool.ts";
import { solidPng } from "./testing.ts";
import { DeviceThumbnails, THUMBNAIL_CACHE_MS, ThumbnailError, thumbnailJpeg } from "./thumbnails.ts";

/** A JPEG's SOF0 width and height. */
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  for (let i = 2; i < jpeg.length - 9; i += 1) {
    if (jpeg[i] === 0xff && jpeg[i + 1] === 0xc0) return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
  }
  throw new Error("no SOF0");
}

test("a hub PNG becomes a JPEG at most the asked width (never upscaled); a JPEG passes through", () => {
  const big = thumbnailJpeg(solidPng(720, 1280), 320);
  assert.equal(big[0], 0xff);
  assert.equal(big[1], 0xd8);
  const size = jpegSize(big);
  assert.ok(size.width <= 320 && size.width >= 160, `width ${size.width}`);
  assert.equal(size.height, Math.floor(1280 / Math.ceil(720 / 320)));
  assert.deepEqual(jpegSize(thumbnailJpeg(solidPng(100, 50), 320)), { width: 100, height: 50 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(thumbnailJpeg(jpeg, 320), jpeg);
  assert.throws(() => thumbnailJpeg(Buffer.from("nope"), 320));
});

test("captures go to the stream's hub screenshot route with the hub token; one per lease per second", async () => {
  let clock = 1_000;
  const calls: { url: string; init: RequestInit }[] = [];
  const png = solidPng(64, 64);
  const thumbnails = new DeviceThumbnails({
    now: () => clock,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } });
    }) as typeof fetch
  });
  const source = { origin: "http://127.0.0.1:9/", token: "hub-secret", streamKind: "serve-emu" as const, deviceParam: "emulator 5554" };
  const [a, b] = await Promise.all([thumbnails.get("l1", source, 320), thumbnails.get("l1", source, 320)]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://127.0.0.1:9/vendor/serve-emu/api/screenshot?device=emulator%205554");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer hub-secret");
  clock += THUMBNAIL_CACHE_MS - 1;
  await thumbnails.get("l1", source, 320);
  assert.equal(calls.length, 1);
  // Another width, an older frame, or a forgotten lease: a new capture.
  await thumbnails.get("l1", source, 160);
  assert.equal(calls.length, 2);
  clock += THUMBNAIL_CACHE_MS;
  await thumbnails.get("l1", source, 160);
  assert.equal(calls.length, 3);
  thumbnails.forget("l1");
  await thumbnails.get("l1", { ...source, streamKind: "serve-sim", token: null }, 160);
  assert.equal(calls.length, 4);
  assert.match(calls[3]!.url, /\/vendor\/serve-sim\/api\/screenshot\?device=/);
  assert.equal((calls[3]!.init.headers as Record<string, string>).authorization, undefined);
});

test("a hub that fails or answers no image is a ThumbnailError, and is not cached", async () => {
  let answer: () => Response = () => new Response("busy", { status: 503 });
  let count = 0;
  const thumbnails = new DeviceThumbnails({
    now: () => 0,
    fetch: (async () => {
      count += 1;
      return answer();
    }) as unknown as typeof fetch
  });
  const source = { origin: "http://127.0.0.1:9", token: null, streamKind: "serve-sim" as const, deviceParam: "U" };
  await assert.rejects(thumbnails.get("l1", source, 320), (error) => error instanceof ThumbnailError && /503/.test(error.message));
  answer = () => new Response("not an image", { status: 200 });
  await assert.rejects(thumbnails.get("l1", source, 320), ThumbnailError);
  answer = () => new Response(new Uint8Array(solidPng(8, 8)), { status: 200 });
  await thumbnails.get("l1", source, 320);
  assert.equal(count, 3);
});

test("frames are encoded by the image workers, keyed by lease; a busy pool reads as a ThumbnailError", async () => {
  const png = solidPng(64, 64);
  const keys: string[] = [];
  let busy = false;
  const thumbnails = new DeviceThumbnails({
    now: () => 0,
    cacheMs: 0,
    fetch: (async () => new Response(new Uint8Array(png), { status: 200 })) as unknown as typeof fetch,
    images: {
      async thumbnail(key: string, _image: Buffer, width: number) {
        keys.push(`${key}@${width}`);
        if (busy) throw new ImagePoolBusyError();
        return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      }
    }
  });
  const source = { origin: "http://127.0.0.1:9", token: null, streamKind: "serve-sim" as const, deviceParam: "UDID" };
  await thumbnails.get("lease-a", source, 200);
  busy = true;
  await assert.rejects(thumbnails.get("lease-b", source, 120), (error) => error instanceof ThumbnailError && /Too many thumbnails/.test(error.message));
  assert.deepEqual(keys, ["lease-a@200", "lease-b@120"]);
});
