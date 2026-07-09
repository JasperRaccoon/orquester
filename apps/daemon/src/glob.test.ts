import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GlobError,
  matchesGlobList,
  mergeGlobLists,
  parseGlobList,
} from "@orquester/config/glob";

/** Convenience: parse an include field and test one path. */
function matchesInclude(field: string, path: string): boolean {
  return matchesGlobList(parseGlobList(field, "include"), path);
}

/** Convenience: parse an exclude field and test one path. */
function matchesExclude(field: string, path: string): boolean {
  return matchesGlobList(parseGlobList(field, "exclude"), path);
}

test("empty field matches everything", () => {
  const list = parseGlobList("", "include");
  assert.equal(matchesGlobList(list, "any/file.ts"), true);
  assert.equal(matchesGlobList(list, "deep/nested/path.md"), true);
});

test("* matches within a segment but not across /", () => {
  assert.equal(matchesInclude("*.ts", "index.ts"), true);
  assert.equal(matchesInclude("*.ts", "src/index.ts"), true, "prepended **/");
  assert.equal(matchesInclude("*.ts", "index.tsx"), false);
  // A single-segment `*.ts` (via **/) must not span a slash inside one segment match.
  assert.equal(matchesInclude("src/*.ts", "src/a.ts"), true);
  assert.equal(matchesInclude("src/*.ts", "src/nested/a.ts"), false);
});

test("? matches exactly one non-slash char", () => {
  assert.equal(matchesInclude("/a?c.ts", "abc.ts"), true);
  assert.equal(matchesInclude("/a?c.ts", "ac.ts"), false);
  assert.equal(matchesInclude("/a?c.ts", "abbc.ts"), false);
});

test("** matches any run of segments including zero", () => {
  assert.equal(matchesInclude("/src/**/*.ts", "src/a.ts"), true, "zero segments");
  assert.equal(matchesInclude("/src/**/*.ts", "src/x/y/a.ts"), true, "many segments");
  assert.equal(matchesInclude("/src/**/*.ts", "other/a.ts"), false);
});

test("leading / anchors to the root (no **/ wrap)", () => {
  assert.equal(matchesInclude("/src/a.ts", "src/a.ts"), true);
  assert.equal(matchesInclude("/src/a.ts", "pkg/src/a.ts"), false);
  // Without a leading slash the term is floated with **/.
  assert.equal(matchesInclude("src/a.ts", "pkg/src/a.ts"), true);
});

test("leading ./ is stripped", () => {
  assert.equal(matchesInclude("./*.ts", "a.ts"), true);
  assert.equal(matchesInclude("./src/a.ts", "x/src/a.ts"), true);
});

test("folder shorthand matches the dir and everything under it", () => {
  // `src` has no metachar and its last segment has no dot → also matches src/**.
  assert.equal(matchesInclude("src", "src"), true, "the entry itself");
  assert.equal(matchesInclude("src", "src/a.ts"), true, "contents");
  assert.equal(matchesInclude("src", "pkg/src/deep/a.ts"), true, "floated + contents");
  assert.equal(matchesInclude("src", "source/a.ts"), false, "not a prefix match");
});

test("folder shorthand does NOT apply to terms with a dot or metachar", () => {
  // `a.ts` last segment has a dot → treated as a file, no /** variant.
  assert.equal(matchesInclude("a.ts", "a.ts"), true);
  assert.equal(matchesInclude("a.ts", "a.ts/inner"), false);
  // `foo*` has a metachar → no folder-shorthand /** variant.
  assert.equal(matchesInclude("foo*", "foobar"), true);
  assert.equal(matchesInclude("foo*", "foobar/deep.ts"), false);
});

test("anchored folder shorthand", () => {
  assert.equal(matchesInclude("/dist", "dist/gen.ts"), true);
  assert.equal(matchesInclude("/dist", "pkg/dist/gen.ts"), false);
});

test("brace expansion, one level", () => {
  assert.equal(matchesInclude("*.{ts,tsx}", "a.ts"), true);
  assert.equal(matchesInclude("*.{ts,tsx}", "a.tsx"), true);
  assert.equal(matchesInclude("*.{ts,tsx}", "a.js"), false);
});

test("multiple brace groups expand as a cartesian product", () => {
  const list = parseGlobList("{src,test}/*.{ts,js}", "include");
  assert.equal(matchesGlobList(list, "src/a.ts"), true);
  assert.equal(matchesGlobList(list, "test/a.js"), true);
  assert.equal(matchesGlobList(list, "src/a.md"), false);
  assert.equal(matchesGlobList(list, "lib/a.ts"), false);
});

test("comma splitting happens at brace-depth 0 only", () => {
  // The comma inside {ts,tsx} must NOT split the field into extra terms.
  const list = parseGlobList("*.{ts,tsx}, *.md", "include");
  assert.equal(matchesGlobList(list, "a.tsx"), true);
  assert.equal(matchesGlobList(list, "a.md"), true);
  assert.equal(matchesGlobList(list, "a.js"), false);
});

test("empty terms are dropped", () => {
  const list = parseGlobList("  , *.ts ,, ", "include");
  assert.equal(matchesGlobList(list, "a.ts"), true);
  assert.equal(matchesGlobList(list, "a.js"), false);
});

test("include vs exclude combine: pass iff any include and no exclude", () => {
  const list = mergeGlobLists(
    parseGlobList("*.ts", "include"),
    parseGlobList("*.test.ts", "exclude"),
  );
  assert.equal(matchesGlobList(list, "a.ts"), true);
  assert.equal(matchesGlobList(list, "a.test.ts"), false, "exclude wins");
  assert.equal(matchesGlobList(list, "a.js"), false, "not in include");
});

test("! in an include field moves the term to the exclude bucket", () => {
  const list = parseGlobList("!*.test.ts", "include");
  // With no positive includes, everything except the negated term passes.
  assert.equal(matchesGlobList(list, "a.ts"), true);
  assert.equal(matchesGlobList(list, "a.test.ts"), false);
});

test("! mixed with positives in one include field", () => {
  const list = parseGlobList("*.ts, !*.test.ts", "include");
  assert.equal(matchesGlobList(list, "a.ts"), true);
  assert.equal(matchesGlobList(list, "a.test.ts"), false);
  assert.equal(matchesGlobList(list, "a.js"), false);
});

test("! in an exclude field is stripped (still excludes)", () => {
  assert.equal(matchesExclude("!node_modules", "node_modules/x.js"), false);
  assert.equal(matchesExclude("node_modules", "node_modules/x.js"), false);
  assert.equal(matchesExclude("!node_modules", "src/x.js"), true);
});

test("glob matching is case-sensitive", () => {
  assert.equal(matchesInclude("*.TS", "a.ts"), false);
  assert.equal(matchesInclude("*.TS", "a.TS"), true);
});

test("relPath with leading ./ or . segments is tolerated", () => {
  const list = parseGlobList("*.ts", "include");
  assert.equal(matchesGlobList(list, "./a.ts"), true);
  assert.equal(matchesGlobList(list, "src/./a.ts"), true);
});

// --- caps / GlobError cases -------------------------------------------------

test("NUL byte is rejected", () => {
  assert.throws(() => parseGlobList("a\0b", "include"), GlobError);
});

test("field over 1024 chars is rejected", () => {
  const raw = "a".repeat(1025);
  assert.throws(() => parseGlobList(raw, "include"), GlobError);
});

test("term over 256 chars is rejected", () => {
  const raw = "a".repeat(257);
  assert.throws(() => parseGlobList(raw, "include"), GlobError);
});

test("more than 64 terms is rejected", () => {
  const raw = Array.from({ length: 65 }, (_, i) => `f${i}.ts`).join(",");
  assert.throws(() => parseGlobList(raw, "include"), GlobError);
});

test("too many brace expansions is rejected", () => {
  // 8 groups of 3 → 3^8 = 6561 > 128.
  const raw = "{a,b,c}".repeat(8);
  assert.throws(() => parseGlobList(raw, "include"), GlobError);
});

test("unbalanced braces are rejected", () => {
  assert.throws(() => parseGlobList("*.{ts,tsx", "include"), GlobError);
  assert.throws(() => parseGlobList("*.ts}", "include"), GlobError);
});

test("nested braces are rejected", () => {
  assert.throws(() => parseGlobList("{a,{b,c}}", "include"), GlobError);
});

test("** inside a segment is rejected", () => {
  assert.throws(() => parseGlobList("/a**b", "include"), GlobError);
  assert.throws(() => parseGlobList("/**b", "include"), GlobError);
  assert.throws(() => parseGlobList("/a**", "include"), GlobError);
  assert.throws(() => parseGlobList("/***", "include"), GlobError);
});

test("GlobError carries the offending pattern", () => {
  try {
    parseGlobList("/a**b", "include");
    assert.fail("expected GlobError");
  } catch (err) {
    assert.ok(err instanceof GlobError);
    assert.equal(err.pattern, "/a**b");
  }
});

test("a bare ** term matches everything", () => {
  assert.equal(matchesInclude("**", "a"), true);
  assert.equal(matchesInclude("**", "deep/nested/a.ts"), true);
});

test("consecutive ** segments collapse and still match", () => {
  // `**/**/a.ts` normalizes through the compiler; must behave like `**/a.ts`.
  assert.equal(matchesInclude("/**/**/a.ts", "a.ts"), true);
  assert.equal(matchesInclude("/**/**/a.ts", "x/y/a.ts"), true);
});

// --- linearity guard --------------------------------------------------------

test("pathological many-star pattern stays linear (<100ms)", () => {
  // A pattern that would blow up exponentially under a naive recursive matcher.
  const field = `/${"*a".repeat(50)}x`;
  const list = parseGlobList(field, "include");
  const path = `${"a".repeat(4000)}b`; // long single segment, no trailing x → no match
  const start = performance.now();
  for (let i = 0; i < 200; i++) {
    assert.equal(matchesGlobList(list, path), false);
  }
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 100, `expected <100ms, took ${elapsed.toFixed(1)}ms`);
});
