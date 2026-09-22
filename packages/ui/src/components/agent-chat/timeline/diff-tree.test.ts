import assert from "node:assert/strict";
import { test } from "node:test";

import type { CheckpointFile } from "@orquester/api/agent-chat";

import {
  buildDiffTree,
  collectDirectoryPaths,
  hasNonZeroStat,
  summarizeDiffStats,
  type DiffTreeNode
} from "./diff-tree";
import {
  countDiffLines,
  splitUnifiedDiff,
  unifiedDiffForPath
} from "./unified-diff";
import {
  distanceFromEnd,
  isWithinFollowBand,
  nextFollowState,
  shouldAnimateFollow,
  TIMELINE_FOLLOW_REARM_THRESHOLD_PX
} from "./follow";

function file(path: string, additions = 1, deletions = 0): CheckpointFile {
  return { path, additions, deletions };
}

function shape(nodes: readonly DiffTreeNode[]): unknown {
  return nodes.map((node) =>
    node.kind === "directory" ? { dir: node.name, children: shape(node.children) } : { file: node.name }
  );
}

// ---------------------------------------------------------------------------
// diff-tree
// ---------------------------------------------------------------------------

test("buildDiffTree nests files under their directories, directories first", () => {
  const tree = buildDiffTree([file("README.md"), file("src/b.ts"), file("src/a.ts")]);
  assert.deepEqual(shape(tree), [
    { dir: "src", children: [{ file: "a.ts" }, { file: "b.ts" }] },
    { file: "README.md" }
  ]);
});

test("buildDiffTree collapses a single-child directory chain onto one row", () => {
  const tree = buildDiffTree([file("apps/daemon/src/index.ts")]);
  assert.deepEqual(shape(tree), [
    { dir: "apps/daemon/src", children: [{ file: "index.ts" }] }
  ]);
  assert.equal((tree[0] as { path: string }).path, "apps/daemon/src");
});

test("buildDiffTree rolls stats up through every ancestor", () => {
  const tree = buildDiffTree([file("a/b/one.ts", 3, 1), file("a/c/two.ts", 2, 5)]);
  const root = tree[0];
  assert.ok(root && root.kind === "directory");
  assert.deepEqual(root.stat, { additions: 5, deletions: 6 });
});

test("buildDiffTree normalises separators and ignores empty paths", () => {
  const tree = buildDiffTree([file("src\\a.ts"), file(""), file("./b.ts")]);
  assert.deepEqual(shape(tree), [{ dir: "src", children: [{ file: "a.ts" }] }, { file: "b.ts" }]);
});

test("buildDiffTree sorts numerically, not lexically", () => {
  const tree = buildDiffTree([file("f10.ts"), file("f2.ts")]);
  assert.deepEqual(shape(tree), [{ file: "f2.ts" }, { file: "f10.ts" }]);
});

test("summarizeDiffStats and hasNonZeroStat", () => {
  assert.deepEqual(summarizeDiffStats([file("a", 1, 2), file("b", 3, 4)]), {
    additions: 4,
    deletions: 6
  });
  assert.deepEqual(summarizeDiffStats([]), { additions: 0, deletions: 0 });
  assert.ok(hasNonZeroStat({ additions: 0, deletions: 1 }));
  assert.ok(!hasNonZeroStat({ additions: 0, deletions: 0 }));
  assert.ok(!hasNonZeroStat(null));
});

test("collectDirectoryPaths walks the whole tree", () => {
  const tree = buildDiffTree([file("a/one.ts"), file("b/c/two.ts")]);
  assert.deepEqual(collectDirectoryPaths(tree).sort(), ["a", "b/c"]);
});

// ---------------------------------------------------------------------------
// unified-diff
// ---------------------------------------------------------------------------

const TWO_FILE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "+const b = 2;",
  " export {};",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-was here"
].join("\n");

test("splitUnifiedDiff yields one entry per file with its own patch text", () => {
  const files = splitUnifiedDiff(TWO_FILE_DIFF);
  assert.equal(files.length, 2);
  assert.equal(files[0]?.path, "src/a.ts");
  assert.ok(files[0]?.patch.includes("+const b = 2;"));
  assert.ok(!files[0]?.patch.includes("was here"));
});

test("a deletion keeps the old path when the new one is /dev/null", () => {
  const files = splitUnifiedDiff(TWO_FILE_DIFF);
  assert.equal(files[1]?.path, "src/gone.ts");
  assert.equal(files[1]?.newPath, null);
  assert.equal(files[1]?.oldPath, "src/gone.ts");
});

test("a binary file is flagged rather than dropped", () => {
  const diff = [
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/logo.png and b/logo.png differ"
  ].join("\n");
  const files = splitUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.binary, true);
});

test("a bare patch with no `diff --git` preamble is still one file", () => {
  const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n");
  const files = splitUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "src/a.ts");
});

test("a quoted path with spaces is unquoted", () => {
  const diff = [
    'diff --git "a/my dir/a.ts" "b/my dir/a.ts"',
    '--- "a/my dir/a.ts"',
    '+++ "b/my dir/a.ts"',
    "@@ -1 +1 @@",
    "-a",
    "+b"
  ].join("\n");
  assert.equal(splitUnifiedDiff(diff)[0]?.path, "my dir/a.ts");
});

test("an empty or whitespace diff is no files, not a throw", () => {
  assert.deepEqual(splitUnifiedDiff(""), []);
  assert.deepEqual(splitUnifiedDiff("   \n  "), []);
});

test("a truncated patch still yields the file it started", () => {
  const diff = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,9 +1,9 @@", "+a"].join(
    "\n"
  );
  assert.equal(splitUnifiedDiff(diff).length, 1);
});

test("unifiedDiffForPath matches exactly and then by suffix", () => {
  assert.equal(unifiedDiffForPath(TWO_FILE_DIFF, "src/a.ts")?.path, "src/a.ts");
  assert.equal(unifiedDiffForPath(TWO_FILE_DIFF, "/abs/repo/src/a.ts")?.path, "src/a.ts");
  assert.equal(unifiedDiffForPath(TWO_FILE_DIFF, "src\\a.ts")?.path, "src/a.ts");
  assert.equal(unifiedDiffForPath(TWO_FILE_DIFF, "nope.ts"), null);
});

test("countDiffLines ignores the file headers", () => {
  const patch = splitUnifiedDiff(TWO_FILE_DIFF)[0]?.patch ?? "";
  assert.deepEqual(countDiffLines(patch), { additions: 1, deletions: 0 });
});

// ---------------------------------------------------------------------------
// follow
// ---------------------------------------------------------------------------

test("the follow band is 40px measured as content - scroll - viewport", () => {
  assert.equal(TIMELINE_FOLLOW_REARM_THRESHOLD_PX, 40);
  assert.equal(distanceFromEnd({ contentLength: 1000, scroll: 700, scrollLength: 300 }), 0);
  assert.equal(distanceFromEnd({ contentLength: 1000, scroll: 660, scrollLength: 300 }), 40);
  assert.equal(distanceFromEnd({ contentLength: 1000, scroll: 900, scrollLength: 300 }), 0);
});

test("follow re-arms inside the band and disarms outside it", () => {
  assert.ok(isWithinFollowBand({ contentLength: 1000, scroll: 660, scrollLength: 300 }));
  assert.ok(!isWithinFollowBand({ contentLength: 1000, scroll: 659, scrollLength: 300 }));
  assert.equal(nextFollowState({ contentLength: 1000, scroll: 700, scrollLength: 300 }), true);
  assert.equal(nextFollowState({ contentLength: 1000, scroll: 0, scrollLength: 300 }), false);
});

test("a half-viewport gap does NOT re-arm follow", () => {
  // The bug this band exists to prevent: reading history, then yanked back.
  assert.ok(!isWithinFollowBand({ contentLength: 2000, scroll: 1550, scrollLength: 300 }));
});

test("the follow scroll is animated only while working and motion is allowed", () => {
  // `settling` is exercised on its own in `follow.test.ts`.
  const base = { working: true, reducedMotion: false, firstPaint: false, settling: false };
  assert.ok(shouldAnimateFollow(base));
  assert.ok(!shouldAnimateFollow({ ...base, working: false }));
  assert.ok(!shouldAnimateFollow({ ...base, reducedMotion: true }));
  assert.ok(!shouldAnimateFollow({ ...base, firstPaint: true }));
});
