import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  downscalableImageMimeType,
  prepareImageForUpload
} from "./composer-image-fit.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, length = 0): number[] {
  const bytes = [(length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
  for (const ch of type) bytes.push(ch.charCodeAt(0));
  for (let i = 0; i < length; i += 1) bytes.push(0);
  return [...bytes, 0, 0, 0, 0];
}

function png(...chunks: string[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([...SIGNATURE, ...chunk("IHDR", 13), ...chunks.flatMap((type) => chunk(type, 4))]);
}

/** The browser's codec boundary, without adding an injection argument to production. */
const browserGlobals = ["OffscreenCanvas", "createImageBitmap", "Image"] as const;
const saved = new Map(browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
function browserGlobal(name: (typeof browserGlobals)[number], value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

function browserCodec(width: number, height: number, encodedBytes: number | null, encodedType?: string) {
  const calls = { decode: [] as unknown[], encode: [] as Array<{ size: { width: number; height: number }; mimeType: string; quality: number }>, closed: 0 };
  browserGlobal("createImageBitmap", async (_file: Blob, options: unknown) => {
    calls.decode.push(options);
    return { width, height, close: () => { calls.closed += 1; } };
  });
  browserGlobal("OffscreenCanvas", class {
    constructor(readonly width: number, readonly height: number) {}
    getContext() { return encodedBytes === null ? null : { drawImage() {} }; }
    async convertToBlob({ type, quality }: { type: string; quality: number }) {
      calls.encode.push({ size: { width: this.width, height: this.height }, mimeType: type, quality });
      return new Blob([new Uint8Array(encodedBytes!)], { type: encodedType ?? type });
    }
  });
  return calls;
}

function file(name: string, type: string, bytes: number | Uint8Array<ArrayBuffer>): File {
  const body = typeof bytes === "number" ? new Uint8Array(bytes) : bytes;
  return new File([body], name, { type, lastModified: 1234 });
}

describe("downscalableImageMimeType", () => {
  it("accepts PNG and JPEG only", () => {
    assert.equal(downscalableImageMimeType("image/png"), "image/png");
    assert.equal(downscalableImageMimeType("image/JPEG"), "image/jpeg");
    assert.equal(downscalableImageMimeType("image/jpg"), "image/jpeg");
    for (const type of ["image/gif", "image/webp", "image/svg+xml", "image/heic", "text/plain", ""]) {
      assert.equal(downscalableImageMimeType(type), null, type);
    }
  });
});

describe("prepareImageForUpload", () => {
  it("re-encodes a large JPEG at the cap with quality 0.85", async () => {
    const calls = browserCodec(4032, 3024, 1000);
    const original = file("IMG_1.jpg", "image/jpeg", 5000);
    const out = await prepareImageForUpload(original);
    assert.notEqual(out, original);
    assert.equal(out.name, "IMG_1.jpg");
    assert.equal(out.type, "image/jpeg");
    assert.equal(out.size, 1000);
    assert.equal(out.lastModified, 1234);
    assert.deepEqual(calls.encode, [{ size: { width: 2000, height: 1500 }, mimeType: "image/jpeg", quality: 0.85 }]);
    assert.equal(calls.closed, 1);
  });

  it("uses the decoded (EXIF-upright) dimensions for the target", async () => {
    // A portrait photo stored landscape with an orientation tag decodes portrait.
    const calls = browserCodec(3024, 4032, 1000);
    await prepareImageForUpload(file("p.jpg", "image/jpeg", 5000));
    assert.deepEqual(calls.decode, [{ imageOrientation: "from-image" }]);
    assert.deepEqual(calls.encode[0]?.size, { width: 1500, height: 2000 });
  });

  it("keeps a still PNG as PNG so transparency survives", async () => {
    const calls = browserCodec(3000, 3000, 10);
    const out = await prepareImageForUpload(file("shot", "image/png", png("IDAT", "IEND")));
    assert.equal(out.type, "image/png");
    assert.equal(out.name, "shot.png");
    assert.equal(calls.encode[0]?.mimeType, "image/png");
  });

  it("keeps the original for an animated PNG, GIF, WebP and SVG", async () => {
    const calls = browserCodec(4000, 4000, 1);
    for (const bytes of [png("acTL", "IDAT", "IEND"), new Uint8Array([1, 2, 3])]) {
      const apng = file("a.png", "image/png", bytes);
      assert.equal(await prepareImageForUpload(apng), apng);
    }
    for (const [name, type] of [["a.gif", "image/gif"], ["a.webp", "image/webp"], ["a.svg", "image/svg+xml"]] as const) {
      const original = file(name, type, 5000);
      assert.equal(await prepareImageForUpload(original), original);
    }
    assert.equal(calls.encode.length, 0);
  });

  it("keeps the original when it already fits", async () => {
    const calls = browserCodec(1920, 1080, 10);
    const original = file("small.jpg", "image/jpeg", 5000);
    assert.equal(await prepareImageForUpload(original), original);
    assert.equal(calls.encode.length, 0);
    assert.equal(calls.closed, 1);
  });

  it("keeps the original when the re-encode is not smaller, empty, retyped or missing", async () => {
    const original = file("big.jpg", "image/jpeg", 5000);
    for (const [bytes, type] of [[5000, undefined], [9000, undefined], [0, undefined], [10, "image/png"], [null, undefined]] as const) {
      browserCodec(4000, 3000, bytes, type);
      assert.equal(await prepareImageForUpload(original), original, `${bytes} ${type}`);
    }
  });

  it("keeps the original when decoding or encoding fails, or there is no codec", async () => {
    const original = file("big.jpg", "image/jpeg", 5000);
    const calls = browserCodec(4000, 3000, 10);
    browserGlobal("createImageBitmap", async () => { throw new Error("unsupported"); });
    browserGlobal("Image", class {
      async decode() { throw new Error("unsupported"); }
    });
    assert.equal(await prepareImageForUpload(original), original);

    const failedEncode = browserCodec(4000, 3000, 10);
    browserGlobal("OffscreenCanvas", class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { throw new Error("canvas too large"); }
    });
    assert.equal(await prepareImageForUpload(original), original);
    assert.equal(calls.closed, 0, "failed decoding produces no bitmap to close");
    assert.equal(failedEncode.closed, 1, "an encoding failure still releases the decoded bitmap");
    browserGlobal("OffscreenCanvas", undefined);
    assert.equal(await prepareImageForUpload(original), original);
  });
});
