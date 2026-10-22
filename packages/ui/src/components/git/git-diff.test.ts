import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDiffFiles, parseUnifiedDiff } from "./git-diff";

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

const MODIFIED = lines(
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " export {};"
);

const ADDED = lines(
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+body"
);

const DELETED = lines(
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-was here"
);

const BINARY = lines(
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 5555555..6666666 100644",
  "Binary files a/assets/logo.png and b/assets/logo.png differ"
);

describe("parseDiffFiles", () => {
  it("splits a multi-file patch into one section per file, with names and counts", () => {
    const files = parseDiffFiles(MODIFIED + ADDED + DELETED);
    assert.deepEqual(
      files.map((f) => [f.path, f.change, f.additions, f.deletions]),
      [
        ["src/a.ts", "modified", 1, 1],
        ["docs/new.md", "added", 2, 0],
        ["src/gone.ts", "deleted", 0, 1]
      ]
    );
    // No hunk from one file leaks into another.
    assert.equal(files[0]?.hunks.length, 1);
    assert.deepEqual(
      files[0]?.hunks[0]?.rows.map((r) => [r.type, r.oldNo, r.newNo, r.text]),
      [
        ["hunk", null, null, "@@ -1,3 +1,3 @@"],
        ["context", 1, 1, "const a = 1;"],
        ["del", 2, null, "const b = 2;"],
        ["add", null, 2, "const b = 3;"],
        ["context", 3, 3, "export {};"]
      ]
    );
    assert.equal(files[1]?.oldPath, null);
    assert.equal(files[1]?.newMode, "100644");
    assert.equal(files[2]?.newPath, null);
    assert.equal(files[2]?.oldPath, "src/gone.ts");
  });

  it("reads a rename's old and new paths and similarity, with or without content changes", () => {
    const pure = lines(
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 100%",
      "rename from old/name.ts",
      "rename to new/name.ts"
    );
    const edited = lines(
      "diff --git a/lib/x.ts b/lib/y.ts",
      "similarity index 87%",
      "rename from lib/x.ts",
      "rename to lib/y.ts",
      "index 1..2 100644",
      "--- a/lib/x.ts",
      "+++ b/lib/y.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b"
    );
    const [first, second] = parseDiffFiles(pure + edited);
    assert.equal(first?.change, "renamed");
    assert.equal(first?.oldPath, "old/name.ts");
    assert.equal(first?.newPath, "new/name.ts");
    assert.equal(first?.path, "new/name.ts");
    assert.equal(first?.similarity, 100);
    assert.equal(first?.hunks.length, 0);
    assert.equal(second?.change, "renamed");
    assert.equal(second?.oldPath, "lib/x.ts");
    assert.equal(second?.path, "lib/y.ts");
    assert.equal(second?.similarity, 87);
    assert.deepEqual([second?.additions, second?.deletions], [1, 1]);
  });

  it("flags a binary file on its own and keeps the text files beside it", () => {
    const files = parseDiffFiles(MODIFIED + BINARY + ADDED);
    assert.deepEqual(
      files.map((f) => [f.path, f.binary]),
      [
        ["src/a.ts", false],
        ["assets/logo.png", true],
        ["docs/new.md", false]
      ]
    );
    assert.equal(files[1]?.hunks.length, 0);
    assert.equal(files[0]?.hunks.length, 1);
  });

  it("treats a GIT binary patch body as one binary file, not as hunks", () => {
    const files = parseDiffFiles(
      lines(
        "diff --git a/a.bin b/a.bin",
        "new file mode 100644",
        "index 0000000..7777777",
        "GIT binary patch",
        "literal 4",
        "LcmZQzWMT#Y01f~L",
        "",
        "literal 0",
        "HcmV?d00001",
        ""
      ) + MODIFIED
    );
    assert.deepEqual(
      files.map((f) => [f.path, f.binary, f.change, f.hunks.length]),
      [
        ["a.bin", true, "added", 0],
        ["src/a.ts", false, "modified", 1]
      ]
    );
  });

  it("marks the row a 'No newline at end of file' follows and counts nothing for it", () => {
    const [file] = parseDiffFiles(
      lines(
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file"
      )
    );
    const rows = file?.hunks[0]?.rows ?? [];
    assert.deepEqual(
      rows.map((r) => [r.type, r.text, r.noNewline ?? false]),
      [
        ["hunk", "@@ -1,2 +1,2 @@", false],
        ["context", "keep", false],
        ["del", "old", true],
        ["add", "new", true]
      ]
    );
    assert.deepEqual([file?.additions, file?.deletions], [1, 1]);
  });

  it("reads a mode-only change as a file with modes and no hunks", () => {
    const [file] = parseDiffFiles(lines("diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"));
    assert.equal(file?.path, "run.sh");
    assert.equal(file?.change, "modified");
    assert.equal(file?.oldMode, "100644");
    assert.equal(file?.newMode, "100755");
    assert.equal(file?.hunks.length, 0);
    assert.equal(file?.binary, false);
  });

  it("reads an empty added file", () => {
    const [file] = parseDiffFiles(lines("diff --git a/empty b/empty", "new file mode 100644", "index 0000000..e69de29"));
    assert.equal(file?.change, "added");
    assert.equal(file?.path, "empty");
    assert.equal(file?.hunks.length, 0);
  });

  it("is no files for an empty or whitespace diff", () => {
    assert.deepEqual(parseDiffFiles(""), []);
    assert.deepEqual(parseDiffFiles("\n\n"), []);
  });

  it("reads a removed line that starts with '-- ' as a deletion, not a file header", () => {
    const [file] = parseDiffFiles(
      lines(
        "diff --git a/q.sql b/q.sql",
        "--- a/q.sql",
        "+++ b/q.sql",
        "@@ -1,2 +1,1 @@",
        "--- a comment",
        "+++ not a header",
        " select 1;"
      )
    );
    assert.equal(file?.path, "q.sql");
    assert.deepEqual(
      file?.hunks[0]?.rows.slice(1).map((r) => [r.type, r.text]),
      [
        ["del", "-- a comment"],
        ["add", "++ not a header"],
        ["context", "select 1;"]
      ]
    );
  });

  it("decodes quoted, tab-terminated and non-ASCII paths", () => {
    const spaced = lines(
      "diff --git a/my dir/a b.ts b/my dir/a b.ts",
      "--- a/my dir/a b.ts\t",
      "+++ b/my dir/a b.ts\t",
      "@@ -1 +1 @@",
      "-a",
      "+b"
    );
    const quoted = lines(
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/caf\\303\\251.txt"',
      "@@ -0,0 +1 @@",
      "+x"
    );
    const files = parseDiffFiles(spaced + quoted);
    assert.deepEqual(
      files.map((f) => f.path),
      ["my dir/a b.ts", "café.txt"]
    );
  });

  it("names a binary file whose header has spaces from the symmetric header", () => {
    const [file] = parseDiffFiles(
      lines("diff --git a/my img.png b/my img.png", "Binary files a/my img.png and b/my img.png differ")
    );
    assert.equal(file?.path, "my img.png");
    assert.equal(file?.binary, true);
  });

  it("reads a bare patch with no `diff --git` preamble, and skips a `git show` header", () => {
    const files = parseDiffFiles(
      lines("commit abc", "Author: A <a@example.com>", "", "    subject", "", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b")
    );
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, "x.ts");
    assert.deepEqual([files[0]?.additions, files[0]?.deletions], [1, 1]);
  });

  it("keeps what a truncated patch got through", () => {
    const files = parseDiffFiles("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,9 +1,9 @@\n+a");
    assert.equal(files.length, 1);
    assert.equal(files[0]?.additions, 1);
  });
});

describe("parseUnifiedDiff", () => {
  it("is binary only when every file is", () => {
    assert.equal(parseUnifiedDiff(BINARY).binary, true);
    const mixed = parseUnifiedDiff(MODIFIED + BINARY);
    assert.equal(mixed.binary, false);
    assert.equal(mixed.hunks.length, 1);
  });

  it("does not read a text line mentioning the marker as binary", () => {
    const parsed = parseUnifiedDiff(
      lines("diff --git a/a.md b/a.md", "--- a/a.md", "+++ b/a.md", "@@ -0,0 +1 @@", "+Binary files a and b differ")
    );
    assert.equal(parsed.binary, false);
    assert.equal(parsed.hunks[0]?.rows[1]?.text, "Binary files a and b differ");
  });

  it("is no hunks for an empty diff", () => {
    assert.deepEqual(parseUnifiedDiff(""), { hunks: [], binary: false });
  });
});
