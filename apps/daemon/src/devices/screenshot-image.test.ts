import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decode } from "jpeg-js";

import { fitScreenshot, thumbnailJpeg } from "./screenshot-image.ts";

const fixture = (filter: number): Buffer => readFileSync(new URL(`./fixtures/image-codec/filter-${filter}.png`, import.meta.url));

test("PNG filters preserve known colors through public thumbnail JPEG output", () => {
  // Authored source colors, independently encoded by libpng; see the fixture README.
  const colors = [[220, 30, 20], [20, 200, 40], [30, 40, 210], [160, 160, 160]];
  for (const filter of [0, 1, 2, 3, 4]) {
    const image = decode(thumbnailJpeg(fixture(filter), 32), { formatAsRGBA: false, tolerantDecoding: false });
    assert.ok(image.width > 0 && image.width <= 32);
    assert.equal(image.width, image.height * 2);
    for (const [bar, expected] of colors.entries()) {
      const x = Math.floor((bar + 0.5) * image.width / 4);
      const offset = (Math.floor(image.height / 2) * image.width + x) * 3;
      for (const [channel, value] of expected.entries()) {
        assert.ok(Math.abs(image.data[offset + channel]! - value) <= 8, `filter ${filter}, bar ${bar}, channel ${channel}: expected ${value}, got ${image.data[offset + channel]}`);
      }
    }
  }
});

test("fitting preserves an exact-cap PNG and returns a decodable JPEG within a smaller cap", () => {
  const png = fixture(0);
  const small = fitScreenshot(png, png.toString("base64").length);
  assert.equal(small.mimeType, "image/png");
  assert.equal(small.data, png);
  const capped = fitScreenshot(png, 900);
  assert.equal(capped.mimeType, "image/jpeg");
  assert.ok(capped.data.toString("base64").length <= 900);
  const image = decode(capped.data, { tolerantDecoding: false });
  assert.deepEqual([image.width, image.height], [capped.width, capped.height]);
  assert.ok(image.width < 64 && image.width === image.height * 2);
});
