import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IMAGE_ATTACHMENT_MAX_EDGE,
  PHOTO_JPEG_QUALITY,
  downscalableImageMimeType,
  downscaledFileName,
  fitImageAttachmentSize,
  isAnimatedPng,
  prepareImageForUpload,
  type DecodedImage,
  type ImageCodec
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

/** A codec that "decodes" to fixed dimensions and records what it was asked. */
function fakeCodec(width: number, height: number, encodedBytes: number | null, encodedType?: string) {
  const calls: { encode: Array<{ size: { width: number; height: number }; mimeType: string; quality: number }>; closed: number } = {
    encode: [],
    closed: 0
  };
  const codec: ImageCodec = {
    async decode() {
      const image: DecodedImage = { width, height, close: () => (calls.closed += 1) };
      return image;
    },
    async encode(_image, size, mimeType, quality) {
      calls.encode.push({ size, mimeType, quality });
      return encodedBytes === null ? null : new Blob([new Uint8Array(encodedBytes)], { type: encodedType ?? mimeType });
    }
  };
  return { codec, calls };
}

function file(name: string, type: string, bytes: number | Uint8Array<ArrayBuffer>): File {
  const body = typeof bytes === "number" ? new Uint8Array(bytes) : bytes;
  return new File([body], name, { type, lastModified: 1234 });
}

describe("fitImageAttachmentSize", () => {
  it("leaves an image whose long edge is at most the cap", () => {
    assert.equal(fitImageAttachmentSize({ width: 2000, height: 1500 }), null);
    assert.equal(fitImageAttachmentSize({ width: 800, height: 2000 }), null);
  });

  it("scales the long edge to the cap and keeps the aspect ratio", () => {
    assert.deepEqual(fitImageAttachmentSize({ width: 4032, height: 3024 }), { width: 2000, height: 1500 });
    assert.deepEqual(fitImageAttachmentSize({ width: 3024, height: 4032 }), { width: 1500, height: 2000 });
    assert.deepEqual(fitImageAttachmentSize({ width: 4000, height: 4000 }), { width: 2000, height: 2000 });
  });

  it("never rounds a thin edge to zero", () => {
    assert.deepEqual(fitImageAttachmentSize({ width: 100_000, height: 10 }), { width: IMAGE_ATTACHMENT_MAX_EDGE, height: 1 });
  });
});

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

describe("isAnimatedPng", () => {
  it("finds acTL before the first IDAT", () => {
    assert.equal(isAnimatedPng(png("acTL", "IDAT", "IEND")), true);
    assert.equal(isAnimatedPng(png("pHYs", "IDAT", "IEND")), false);
    assert.equal(isAnimatedPng(png("IDAT", "acTL", "IEND")), false);
  });

  it("treats bytes that are not a readable PNG as animated", () => {
    assert.equal(isAnimatedPng(new Uint8Array([1, 2, 3])), true);
    assert.equal(isAnimatedPng(Uint8Array.from([...SIGNATURE, ...chunk("IHDR", 13)])), true);
  });
});

describe("downscaledFileName", () => {
  it("keeps a name whose extension already matches", () => {
    assert.equal(downscaledFileName("IMG_0001.JPG", "image/jpeg"), "IMG_0001.JPG");
    assert.equal(downscaledFileName("scan.jpeg", "image/jpeg"), "scan.jpeg");
    assert.equal(downscaledFileName("shot.png", "image/png"), "shot.png");
  });

  it("swaps or adds the extension otherwise", () => {
    assert.equal(downscaledFileName("photo.heic", "image/jpeg"), "photo.jpg");
    assert.equal(downscaledFileName("photo", "image/jpeg"), "photo.jpg");
    assert.equal(downscaledFileName("", "image/png"), "image.png");
    assert.equal(downscaledFileName(".hidden", "image/png"), ".hidden.png");
  });
});

describe("prepareImageForUpload", () => {
  it("re-encodes a large JPEG at the cap with quality 0.85", async () => {
    const { codec, calls } = fakeCodec(4032, 3024, 1000);
    const original = file("IMG_1.jpg", "image/jpeg", 5000);
    const out = await prepareImageForUpload(original, codec);
    assert.notEqual(out, original);
    assert.equal(out.name, "IMG_1.jpg");
    assert.equal(out.type, "image/jpeg");
    assert.equal(out.size, 1000);
    assert.equal(out.lastModified, 1234);
    assert.deepEqual(calls.encode, [{ size: { width: 2000, height: 1500 }, mimeType: "image/jpeg", quality: PHOTO_JPEG_QUALITY }]);
    assert.equal(calls.closed, 1);
  });

  it("uses the decoded (EXIF-upright) dimensions for the target", async () => {
    // A portrait photo stored landscape with an orientation tag decodes portrait.
    const { codec, calls } = fakeCodec(3024, 4032, 1000);
    await prepareImageForUpload(file("p.jpg", "image/jpeg", 5000), codec);
    assert.deepEqual(calls.encode[0]?.size, { width: 1500, height: 2000 });
  });

  it("keeps a still PNG as PNG so transparency survives", async () => {
    const { codec, calls } = fakeCodec(3000, 3000, 10);
    const out = await prepareImageForUpload(file("shot", "image/png", png("IDAT", "IEND")), codec);
    assert.equal(out.type, "image/png");
    assert.equal(out.name, "shot.png");
    assert.equal(calls.encode[0]?.mimeType, "image/png");
  });

  it("keeps the original for an animated PNG, GIF, WebP and SVG", async () => {
    const { codec, calls } = fakeCodec(4000, 4000, 1);
    const apng = file("a.png", "image/png", png("acTL", "IDAT", "IEND"));
    assert.equal(await prepareImageForUpload(apng, codec), apng);
    for (const [name, type] of [["a.gif", "image/gif"], ["a.webp", "image/webp"], ["a.svg", "image/svg+xml"]] as const) {
      const original = file(name, type, 5000);
      assert.equal(await prepareImageForUpload(original, codec), original);
    }
    assert.equal(calls.encode.length, 0);
  });

  it("keeps the original when it already fits", async () => {
    const { codec, calls } = fakeCodec(1920, 1080, 10);
    const original = file("small.jpg", "image/jpeg", 5000);
    assert.equal(await prepareImageForUpload(original, codec), original);
    assert.equal(calls.encode.length, 0);
    assert.equal(calls.closed, 1);
  });

  it("keeps the original when the re-encode is not smaller, empty, retyped or missing", async () => {
    const original = file("big.jpg", "image/jpeg", 5000);
    for (const [bytes, type] of [[5000, undefined], [9000, undefined], [0, undefined], [10, "image/png"], [null, undefined]] as const) {
      const { codec } = fakeCodec(4000, 3000, bytes, type);
      assert.equal(await prepareImageForUpload(original, codec), original, `${bytes} ${type}`);
    }
  });

  it("keeps the original when decoding or encoding fails, or there is no codec", async () => {
    const original = file("big.jpg", "image/jpeg", 5000);
    const failingDecode: ImageCodec = {
      decode: () => Promise.reject(new Error("unsupported")),
      encode: () => Promise.resolve(null)
    };
    assert.equal(await prepareImageForUpload(original, failingDecode), original);
    let closed = 0;
    const failingEncode: ImageCodec = {
      decode: async () => ({ width: 4000, height: 3000, close: () => (closed += 1) }),
      encode: () => Promise.reject(new Error("canvas too large"))
    };
    assert.equal(await prepareImageForUpload(original, failingEncode), original);
    assert.equal(closed, 1);
    assert.equal(await prepareImageForUpload(original, null), original);
  });
});
