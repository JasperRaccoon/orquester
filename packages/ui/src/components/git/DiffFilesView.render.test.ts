/**
 * The multi-file diff view and the change-kind split, rendered, not mounted:
 * every file gets its own named section, and one binary file blanks only itself.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DiffFilesView } from "./DiffFilesView";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-const a = 1;",
  "+const a = 2;",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "new file mode 100644",
  "Binary files /dev/null and b/assets/logo.png differ",
  "diff --git a/old/name.md b/docs/name.md",
  "similarity index 100%",
  "rename from old/name.md",
  "rename to docs/name.md",
  "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
  "--- a/pnpm-lock.yaml",
  "+++ b/pnpm-lock.yaml",
  "@@ -1 +1 @@",
  "-lockfileVersion: 8",
  "+lockfileVersion: 9",
  ""
].join("\n");

test("each file is its own section, named, with its markers and counts", () => {
  const html = renderToStaticMarkup(createElement(DiffFilesView, { diff: PATCH }));
  assert.match(html, /4 changed files/);
  assert.match(html, /aria-label="src\/a.ts"/);
  assert.match(html, /aria-label="old\/name.md → docs\/name.md"/);
  assert.match(html, /const a = 2;/, "the text file beside the binary one is shown");
  assert.match(html, /Binary file not shown/);
  assert.match(html, /Renamed without content changes/);
  assert.match(html, />Added</);
  assert.match(html, />Renamed</);
  // The lockfile starts collapsed: its section is there, its rows are not.
  assert.match(html, /aria-label="pnpm-lock.yaml"/);
  assert.doesNotMatch(html, /lockfileVersion: 9/);
  // The split names what kinds the turn touched.
  assert.match(html, /Code: 2 files, \+1 −1; Generated: 1 file, \+1 −1; Docs: 1 file/);
});

test("a whole binary turn still lists its files, and an empty one says so", () => {
  const binaryOnly = renderToStaticMarkup(
    createElement(DiffFilesView, {
      diff: "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n"
    })
  );
  assert.match(binaryOnly, /aria-label="a.png"/);
  const empty = renderToStaticMarkup(createElement(DiffFilesView, { diff: "", emptyLabel: "Nothing here." }));
  assert.match(empty, /Nothing here\./);
});

test("a cut patch keeps what arrived and says it was cut", () => {
  const html = renderToStaticMarkup(
    createElement(DiffFilesView, { diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,5 +1,5 @@\n+kept\n\n[truncated]" })
  );
  assert.match(html, /kept/);
  assert.match(html, /cut at its size limit/);
});
