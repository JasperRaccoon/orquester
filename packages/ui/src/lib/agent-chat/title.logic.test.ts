import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canReplaceThreadTitle,
  DEFAULT_THREAD_TITLE,
  deriveThreadTitleSeed,
  stripComposerReferences,
  THREAD_TITLE_MAX_LENGTH,
  truncateTitle
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
    assert.equal(seed.length, THREAD_TITLE_MAX_LENGTH + 3);
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

  it("falls back to the literal default", () => {
    assert.equal(deriveThreadTitleSeed({ text: "" }), DEFAULT_THREAD_TITLE);
  });

  it("collapses fenced code and whitespace rather than seeding a wall of code", () => {
    assert.equal(
      deriveThreadTitleSeed({ text: "Why does\n\n```\nconst a = 1\n```\n\nthis fail?" }),
      "Why does this fail?"
    );
  });
});

describe("stripComposerReferences", () => {
  it("keeps the last path segment of an @mention", () => {
    assert.equal(stripComposerReferences("look at @a/b/c.ts"), "look at c.ts");
  });

  it("unwraps inline code", () => {
    assert.equal(stripComposerReferences("run `pnpm test` now"), "run pnpm test now");
  });
});

describe("canReplaceThreadTitle", () => {
  it("lets the host improve the default and the seed, but never a manual rename", () => {
    assert.equal(canReplaceThreadTitle(DEFAULT_THREAD_TITLE, "Seed"), true);
    assert.equal(canReplaceThreadTitle("Seed", "Seed"), true);
    assert.equal(canReplaceThreadTitle("", "Seed"), true);
    assert.equal(canReplaceThreadTitle("My own name", "Seed"), false);
  });
});

describe("truncateTitle", () => {
  it("trims before measuring", () => {
    assert.equal(truncateTitle("  hi  "), "hi");
    assert.equal(truncateTitle("abcdef", 3), "abc...");
  });
});
