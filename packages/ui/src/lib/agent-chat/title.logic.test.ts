import assert from "node:assert/strict";
import { describe,it } from "node:test";

import {
deriveThreadTitleSeed
} from "./title.logic";

describe("deriveThreadTitleSeed", () => {
  it("uses the first message, stripped of context references", () => {
    assert.equal(
      deriveThreadTitleSeed({ text: "Fix @src/lib/a.ts with $review please" }),
      "Fix a.ts with review please"
    );
  });

  it("truncates at 50 characters", () => {
    const long = "x".repeat(80);
    const seed = deriveThreadTitleSeed({ text: long });
    assert.equal(seed.length, 53);
    assert.ok(seed.endsWith("..."));
  });

  it("falls back to the first image, then the first file, then a chip", () => {
    assert.equal(
      deriveThreadTitleSeed({
        text: "   ",
        attachments: [
          { type: "file", id: "f", name: "notes.txt", sizeBytes: 1 },
          { type: "image", id: "i", name: "shot.png", mimeType: "image/png", sizeBytes: 1 }
        ]
      }),
      "Image: shot.png"
    );
    assert.equal(
      deriveThreadTitleSeed({
        text: "",
        attachments: [{ type: "file", id: "f", name: "notes.txt", sizeBytes: 1 }]
      }),
      "File: notes.txt"
    );
    assert.equal(
      deriveThreadTitleSeed({ text: "", context: [{ kind: "file", label: "src/a.ts" }] }),
      "src/a.ts"
    );
  });

  it("collapses fenced code and whitespace rather than seeding a wall of code", () => {
    assert.equal(
      deriveThreadTitleSeed({ text: "Why does\n\n```\nconst a = 1\n```\n\nthis fail?" }),
      "Why does this fail?"
    );
  });
});
