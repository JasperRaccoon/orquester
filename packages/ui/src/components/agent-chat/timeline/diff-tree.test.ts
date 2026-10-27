import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckpointFile } from "@orquester/api/agent-chat";
import { buildDiffTree, summarizeDiffStats } from "./diff-tree";
import { countDiffLines, splitUnifiedDiff } from "./unified-diff";

function file(path: string, additions = 1, deletions = 0): CheckpointFile {
  return { path, additions, deletions };
}

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

test("buildDiffTree rolls stats up through every ancestor", () => {
  const tree = buildDiffTree([file("a/b/one.ts", 3, 1), file("a/c/two.ts", 2, 5)]);
  const root = tree[0];
  assert.ok(root && root.kind === "directory");
  assert.deepEqual(root.stat, { additions: 5, deletions: 6 });
});

test("summarizeDiffStats totals changed lines", () => {
  assert.deepEqual(summarizeDiffStats([file("a", 1, 2), file("b", 3, 4)]), {
    additions: 4,
    deletions: 6
  });
  assert.deepEqual(summarizeDiffStats([]), { additions: 0, deletions: 0 });
});

test("splitUnifiedDiff yields one entry per file with its own patch text", () => {
  const files = splitUnifiedDiff(TWO_FILE_DIFF);
  assert.equal(files.length, 2);
  assert.equal(files[0]?.path, "src/a.ts");
  assert.ok(files[0]?.patch.includes("+const b = 2;"));
  assert.ok(!files[0]?.patch.includes("was here"));
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
  const files = splitUnifiedDiff(diff);
  assert.equal(files[0]?.path, "src/a.ts");
  assert.ok(files[0]?.patch.includes("+a"));
});

test("a CRLF patch splits with clean paths, binary flags and counts", () => {
  const crlf = (text: string) => text.replaceAll("\n", "\r\n");
  const files = splitUnifiedDiff(
    crlf(`${TWO_FILE_DIFF}\ndiff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n`)
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.oldPath, f.newPath, f.binary]),
    [
      ["src/a.ts", "src/a.ts", "src/a.ts", false],
      ["src/gone.ts", "src/gone.ts", null, false],
      ["logo.png", "logo.png", "logo.png", true]
    ]
  );
  assert.deepEqual(countDiffLines(files[0]?.patch ?? ""), { additions: 1, deletions: 0 });
  assert.deepEqual(countDiffLines(files[1]?.patch ?? ""), { additions: 0, deletions: 1 });
});
