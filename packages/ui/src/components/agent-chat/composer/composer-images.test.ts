import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  imageOrdinal,
  imagePlaceholder,
  removeImagePlaceholder,
  revokeImagePreviews,
  withoutPreviews
} from "./composer-images.ts";

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

  it("releases every staged preview without revoking an unrelated image", async (t) => {
    const previews = ["first", "second"].map((text) => URL.createObjectURL(new Blob([text])));
    const other = URL.createObjectURL(new Blob(["still visible"]));
    t.after(() => {
      for (const url of [...previews, other]) URL.revokeObjectURL(url);
    });
    for (const url of previews) assert.equal((await fetch(url)).ok, true);
    revokeImagePreviews([{ previewUrl: previews[0] }, {}, { previewUrl: previews[1] }]);
    for (const url of previews) await assert.rejects(fetch(url));
    assert.equal(await (await fetch(other)).text(), "still visible");
  });

  it("hands chips back without their revoked preview URLs, and the rest untouched", () => {
    type Chip = { key: string; mimeType: string; previewUrl?: string };
    const image: Chip = { key: "a", mimeType: "image/png", previewUrl: "blob:a" };
    const file: Chip = { key: "f", mimeType: "text/plain" };
    const back = withoutPreviews([image, file]);
    assert.deepEqual(back, [{ key: "a", mimeType: "image/png" }, file]);
    assert.equal("previewUrl" in back[0]!, false, "the lazy resolve only runs for a chip with no URL");
    assert.equal(image.previewUrl, "blob:a", "the sent chip itself is not mutated");
  });
});
