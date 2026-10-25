import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LARGE_DIFF_FILE_ROWS,
  collapsedByDefault,
  diffFileBadges,
  diffFileKey,
  splitTruncationMarker
} from "./diff-files";
import { parseDiffFiles } from "./git-diff";

const one = (...rows: string[]) => {
  const [file] = parseDiffFiles(`${rows.join("\n")}\n`);
  assert.ok(file);
  return file;
};

describe("diffFileBadges", () => {
  it("marks added, deleted, renamed and copied files", () => {
    const added = one("diff --git a/a b/a", "new file mode 100644", "--- /dev/null", "+++ b/a", "@@ -0,0 +1 @@", "+x");
    const deleted = one("diff --git a/a b/a", "deleted file mode 100644", "--- a/a", "+++ /dev/null", "@@ -1 +0,0 @@", "-x");
    const renamed = one("diff --git a/a b/b", "similarity index 100%", "rename from a", "rename to b");
    const copied = one("diff --git a/a b/b", "similarity index 100%", "copy from a", "copy to b");
    assert.deepEqual(diffFileBadges(added), [{ label: "Added", tone: "added" }]);
    assert.deepEqual(diffFileBadges(deleted), [{ label: "Deleted", tone: "deleted" }]);
    assert.deepEqual(diffFileBadges(renamed), [{ label: "Renamed", tone: "renamed" }]);
    assert.deepEqual(diffFileBadges(copied), [{ label: "Copied", tone: "renamed" }]);
  });

  it("marks a mode change and a binary file, and nothing for a plain edit", () => {
    const mode = one("diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755");
    const binary = one("diff --git a/x.png b/x.png", "Binary files a/x.png and b/x.png differ");
    const plain = one("diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@", "-x", "+y");
    assert.deepEqual(diffFileBadges(mode), [{ label: "Mode 100644 → 100755", tone: "neutral" }]);
    assert.deepEqual(diffFileBadges(binary), [{ label: "Binary", tone: "neutral" }]);
    assert.deepEqual(diffFileBadges(plain), []);
  });
});

describe("collapsedByDefault", () => {
  it("collapses generated files and very long files, and opens the rest", () => {
    const lock = one("diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml", "--- a/pnpm-lock.yaml", "+++ b/pnpm-lock.yaml", "@@ -1 +1 @@", "-a", "+b");
    const small = one("diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b");
    const added = Array.from({ length: LARGE_DIFF_FILE_ROWS + 1 }, (_, i) => `+line ${i}`);
    const long = one(
      "diff --git a/big.ts b/big.ts",
      "--- /dev/null",
      "+++ b/big.ts",
      `@@ -0,0 +1,${added.length} @@`,
      ...added
    );
    assert.equal(collapsedByDefault(lock), true);
    assert.equal(collapsedByDefault(small), false);
    assert.equal(collapsedByDefault(long), true);
  });
});

describe("splitTruncationMarker", () => {
  it("strips the daemon's cut marker and says so", () => {
    assert.deepEqual(splitTruncationMarker("+a\n\n[truncated]"), { text: "+a", truncated: true });
    assert.deepEqual(splitTruncationMarker("+a\n"), { text: "+a\n", truncated: false });
  });
});

describe("diffFileKey", () => {
  it("tells apart two sections for the same path", () => {
    const files = parseDiffFiles(
      ["diff --git a/a b/b", "copy from a", "copy to b", "diff --git a/a b/b", "rename from a", "rename to b"].join("\n")
    );
    assert.equal(files.length, 2);
    assert.notEqual(diffFileKey(files[0]!, 0), diffFileKey(files[1]!, 1));
  });
});
