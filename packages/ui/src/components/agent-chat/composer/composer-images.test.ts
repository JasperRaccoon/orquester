import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imageOrdinal, imagePlaceholder, removeImagePlaceholder } from "./composer-images.ts";

describe("image placeholders", () => {
  it("numbers images by position among images only", () => {
    const staged = [
      { key: "a", mimeType: "image/png" },
      { key: "f", mimeType: "text/plain" },
      { key: "b", mimeType: "image/jpeg" }
    ];
    assert.equal(imageOrdinal(staged, "a"), 1);
    assert.equal(imageOrdinal(staged, "b"), 2);
    assert.equal(imageOrdinal(staged, "f"), null);
    assert.equal(imagePlaceholder(2), "[Image #2]");
  });

  it("removing an image drops its placeholder and renumbers the later ones", () => {
    const text = "this is x: [Image #1] this is y: [Image #2] and z: [Image #3]";
    assert.equal(
      removeImagePlaceholder(text, 2),
      "this is x: [Image #1] this is y: and z: [Image #2]"
    );
    assert.equal(removeImagePlaceholder("[Image #1]", 1), "");
    assert.equal(removeImagePlaceholder("no images here", 1), "no images here");
  });
});
