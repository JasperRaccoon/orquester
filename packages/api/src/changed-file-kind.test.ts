import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyChangedFile, summarizeChangedFileKinds } from "./changed-file-kind.ts";

describe("classifyChangedFile", () => {
  // Adapted from T3 Code (MIT): packages/shared/src/changedFileKind.test.ts
  for (const [path, kind] of [
    ["src/contest.py", "code"],
    ["test/fixtures/pr.json", "mocks"],
    ["pnpm-lock.yaml", "generated"],
    ["README.md", "docs"],
    ["tests/README.md", "tests"]
  ] as const) {
    it(`${path} is ${kind}`, () => {
      assert.equal(classifyChangedFile(path), kind);
    });
  }

  it("reads lockfiles, build output and generated directories as generated", () => {
    assert.equal(classifyChangedFile("apps/web/package-lock.json"), "generated");
    assert.equal(classifyChangedFile("Cargo.lock"), "generated");
    assert.equal(classifyChangedFile("dist/app.min.js"), "generated");
    assert.equal(classifyChangedFile("src/api.pb.go"), "generated");
    assert.equal(classifyChangedFile("src/__generated__/schema.ts"), "generated");
    assert.equal(classifyChangedFile("apps/daemon/src/agent-host/adapters/codex/_generated/Generated/x.ts"), "generated");
  });

  it("keeps test support apart from the tests themselves", () => {
    assert.equal(classifyChangedFile("src/__snapshots__/view.test.ts.snap"), "mocks");
    assert.equal(classifyChangedFile("src/__mocks__/fs.ts"), "mocks");
    assert.equal(classifyChangedFile("src/api.fixture.json"), "mocks");
    assert.equal(classifyChangedFile("pkg/testdata/input.txt"), "mocks");
  });

  it("finds tests by name and by directory", () => {
    assert.equal(classifyChangedFile("src/git-diff.test.ts"), "tests");
    assert.equal(classifyChangedFile("pkg/server_test.go"), "tests");
    assert.equal(classifyChangedFile("tests/test_api.py"), "tests");
    assert.equal(classifyChangedFile("src/FooTest.java"), "tests");
    assert.equal(classifyChangedFile("src/Latest.java"), "code", "the class-name rule is case-sensitive");
    assert.equal(classifyChangedFile("e2e/login.ts"), "tests");
  });

  it("reads prose as docs, but not plain-text config", () => {
    assert.equal(classifyChangedFile("docs/guide.mdx"), "docs");
    assert.equal(classifyChangedFile("NOTES.txt"), "docs");
    assert.equal(classifyChangedFile("requirements-dev.txt"), "code");
    assert.equal(classifyChangedFile("CMakeLists.txt"), "code");
  });

  it("accepts Windows separators", () => {
    assert.equal(classifyChangedFile("src\\__tests__\\a.ts"), "tests");
  });
});

describe("summarizeChangedFileKinds", () => {
  it("totals files and lines per kind", () => {
    const breakdown = summarizeChangedFileKinds([
      { path: "src/a.ts", additions: 10, deletions: 2 },
      { path: "src/b.ts", additions: 1, deletions: 1 },
      { path: "src/a.test.ts", additions: 30, deletions: 0 },
      { path: "pnpm-lock.yaml", additions: 400, deletions: 380 },
      { path: "README.md", additions: 3, deletions: 0 }
    ]);
    assert.deepEqual(breakdown, {
      code: { files: 2, additions: 11, deletions: 3 },
      tests: { files: 1, additions: 30, deletions: 0 },
      mocks: { files: 0, additions: 0, deletions: 0 },
      generated: { files: 1, additions: 400, deletions: 380 },
      docs: { files: 1, additions: 3, deletions: 0 }
    });
  });

  it("counts a file without line counts under its kind and adds no lines", () => {
    const breakdown = summarizeChangedFileKinds([{ path: "docs/a.md" }, { path: "logo.png", additions: null }]);
    assert.deepEqual(breakdown.docs, { files: 1, additions: 0, deletions: 0 });
    assert.deepEqual(breakdown.code, { files: 1, additions: 0, deletions: 0 });
  });

  it("is all zeroes for no files", () => {
    const breakdown = summarizeChangedFileKinds([]);
    assert.ok(Object.values(breakdown).every((t) => t.files === 0 && t.additions === 0 && t.deletions === 0));
  });
});
