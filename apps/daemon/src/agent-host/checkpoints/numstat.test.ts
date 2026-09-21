import assert from "node:assert/strict";
import test from "node:test";

import { parseTurnDiffFilesFromNumstat } from "./numstat.ts";

test("reads NUL-delimited numstat records", () => {
  const numstat = "3\t1\tsrc/a.ts\u00000\t9\tdocs/b.md\u0000";
  assert.deepEqual(parseTurnDiffFilesFromNumstat(numstat), [
    { path: "docs/b.md", additions: 0, deletions: 9 },
    { path: "src/a.ts", additions: 3, deletions: 1 }
  ]);
});

test("a rename spends two extra records on the source and the destination", () => {
  const numstat = "1\t1\t\u0000old/name.ts\u0000new/name.ts\u00005\t0\tother.ts\u0000";
  assert.deepEqual(parseTurnDiffFilesFromNumstat(numstat), [
    { path: "new/name.ts", additions: 1, deletions: 1 },
    { path: "other.ts", additions: 5, deletions: 0 }
  ]);
});

test("a binary file reports zero counts rather than being dropped", () => {
  assert.deepEqual(parseTurnDiffFilesFromNumstat("-\t-\tassets/logo.png\u0000"), [
    { path: "assets/logo.png", additions: 0, deletions: 0 }
  ]);
});

test("empty and malformed output yields no files", () => {
  assert.deepEqual(parseTurnDiffFilesFromNumstat(""), []);
  assert.deepEqual(parseTurnDiffFilesFromNumstat("not a record\u0000"), []);
});

test("a path containing a newline survives, because records are NUL-delimited", () => {
  assert.deepEqual(parseTurnDiffFilesFromNumstat("1\t0\tweird\nname.txt\u0000"), [
    { path: "weird\nname.txt", additions: 1, deletions: 0 }
  ]);
});
