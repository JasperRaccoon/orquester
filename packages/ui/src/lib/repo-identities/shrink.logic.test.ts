import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REPO_ICON_MAX_BYTES } from "@orquester/api";

import {
  canSendUnchanged,
  encodedFormat,
  initialShrinkSize,
  nextShrinkStep,
  type ShrinkAttempt
} from "./shrink.logic.ts";

const OVER = REPO_ICON_MAX_BYTES + 1;

describe("which files are sent unchanged", () => {
  it("an upload type within the cap", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]) {
      assert.equal(canSendUnchanged(type, 1000), true, type);
      assert.equal(canSendUnchanged(type, REPO_ICON_MAX_BYTES), true, type);
    }
  });

  it("re-encodes on size", () => {
    assert.equal(canSendUnchanged("image/png", OVER), false);
    assert.equal(canSendUnchanged("image/svg+xml", OVER), false);
  });

  it("re-encodes on type", () => {
    for (const type of ["image/gif", "image/bmp", "image/avif", "image/heic", "image/x-icon", ""]) {
      assert.equal(canSendUnchanged(type, 100), false, type);
    }
  });
});

describe("the first canvas size", () => {
  it("fits the longest side into 512 and keeps the aspect", () => {
    assert.deepEqual(initialShrinkSize(4000, 3000), { width: 512, height: 384 });
    assert.deepEqual(initialShrinkSize(1000, 4000), { width: 128, height: 512 });
  });

  it("never upscales", () => {
    assert.deepEqual(initialShrinkSize(100, 50), { width: 100, height: 50 });
    assert.deepEqual(initialShrinkSize(512, 512), { width: 512, height: 512 });
  });

  it("keeps a sliver at least one pixel wide", () => {
    assert.deepEqual(initialShrinkSize(10000, 2), { width: 512, height: 1 });
  });
});

describe("the step-down", () => {
  const webp: ShrinkAttempt = { width: 512, height: 512, format: "image/webp", quality: 0.9 };

  it("is done once the result fits", () => {
    assert.deepEqual(nextShrinkStep(webp, REPO_ICON_MAX_BYTES), { kind: "done" });
  });

  it("lowers WebP quality in steps to 0.6, then halves the dimensions", () => {
    const qualities: number[] = [];
    let attempt = webp;
    for (;;) {
      const step = nextShrinkStep(attempt, OVER);
      assert.equal(step.kind, "encode");
      if (step.kind !== "encode") break;
      if (step.attempt.width !== attempt.width) {
        assert.deepEqual(step.attempt, { ...attempt, width: 256, height: 256 });
        break;
      }
      qualities.push(step.attempt.quality);
      attempt = step.attempt;
    }
    assert.deepEqual(qualities, [0.8, 0.7, 0.6]);
  });

  it("PNG has no quality to lower: it halves at once", () => {
    const png: ShrinkAttempt = { width: 400, height: 300, format: "image/png", quality: 0.9 };
    assert.deepEqual(nextShrinkStep(png, OVER), { kind: "encode", attempt: { ...png, width: 200, height: 150 } });
  });

  it("halves down to 64px and gives up below it", () => {
    const at128: ShrinkAttempt = { width: 128, height: 100, format: "image/webp", quality: 0.6 };
    assert.deepEqual(nextShrinkStep(at128, OVER), { kind: "encode", attempt: { ...at128, width: 64, height: 50 } });
    const at64: ShrinkAttempt = { ...at128, width: 64, height: 50 };
    assert.deepEqual(nextShrinkStep(at64, OVER), { kind: "give-up", reason: "That image is too large to use" });
  });
});

describe("helpers", () => {
  it("encodedFormat accepts what the browser may produce for WebP", () => {
    assert.equal(encodedFormat("image/webp"), "image/webp");
    assert.equal(encodedFormat("image/png"), "image/png");
    assert.equal(encodedFormat("image/jpeg"), null);
    assert.equal(encodedFormat(""), null);
  });
});
