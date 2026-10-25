import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { changeKindRows, shouldShowChangeKindSplit } from "./change-kinds";

describe("changeKindRows", () => {
  it("lists only the kinds a change touches, in display order", () => {
    const rows = changeKindRows([
      { path: "README.md", additions: 2, deletions: 0 },
      { path: "src/a.test.ts", additions: 5, deletions: 1 },
      { path: "src/a.ts", additions: 7, deletions: 3 },
      { path: "src/b.ts", additions: 1, deletions: 0 }
    ]);
    assert.deepEqual(rows, [
      { kind: "code", label: "Code", files: 2, additions: 8, deletions: 3 },
      { kind: "tests", label: "Tests", files: 1, additions: 5, deletions: 1 },
      { kind: "docs", label: "Docs", files: 1, additions: 2, deletions: 0 }
    ]);
  });

  it("counts files without line counts (a working-tree status list)", () => {
    const rows = changeKindRows([{ path: "src/a.ts" }, { path: "yarn.lock" }]);
    assert.deepEqual(
      rows.map((r) => [r.kind, r.files, r.additions]),
      [
        ["code", 1, 0],
        ["generated", 1, 0]
      ]
    );
  });
});

describe("shouldShowChangeKindSplit", () => {
  it("stays quiet when the change is all code or empty", () => {
    assert.equal(shouldShowChangeKindSplit(changeKindRows([])), false);
    assert.equal(shouldShowChangeKindSplit(changeKindRows([{ path: "a.ts" }, { path: "b.ts" }])), false);
  });

  it("shows a mix, or a change that is all one non-code kind", () => {
    assert.equal(shouldShowChangeKindSplit(changeKindRows([{ path: "a.ts" }, { path: "a.test.ts" }])), true);
    assert.equal(shouldShowChangeKindSplit(changeKindRows([{ path: "docs/a.md" }])), true);
  });
});
