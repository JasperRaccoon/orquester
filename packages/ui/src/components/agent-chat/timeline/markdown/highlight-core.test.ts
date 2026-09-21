import assert from "node:assert/strict";
import { test } from "node:test";

import { NodeSet, NodeType, Tree, type Parser } from "@lezer/common";
import { styleTags, tags } from "@lezer/highlight";

import {
  estimateHighlightSize,
  extractFenceLanguage,
  fenceLanguageLabel,
  fnv1a32,
  highlightCacheKey,
  highlightCode,
  createIncrementalTreeHighlighter,
  MAX_HIGHLIGHT_CHARS,
  pickTokenClass,
  plainLines,
  resolveLanguageEntry,
  SizedLruCache,
  treeToLines,
  type HighlightedLine
} from "./highlight-core";

// ---------------------------------------------------------------------------
// A hand-built Lezer tree — no language package needed, so this stays DOM-free
// and does not depend on a grammar that is only a transitive dependency.
// ---------------------------------------------------------------------------

const TYPES = [
  NodeType.define({ id: 0, name: "Document", top: true }),
  NodeType.define({ id: 1, name: "Keyword" }),
  NodeType.define({ id: 2, name: "StringLiteral" })
];

const NODE_SET = new NodeSet(TYPES).extend(
  styleTags({ Keyword: tags.keyword, StringLiteral: tags.string })
);

/** Builds a flat tree from `[typeId, from, to]` triples. */
function buildTree(code: string, spans: ReadonlyArray<[number, number, number]>): Tree {
  const buffer: number[] = [];
  for (const [id, from, to] of spans) buffer.push(id, from, to, 4);
  return Tree.build({ buffer, nodeSet: NODE_SET, topID: 0, length: code.length });
}

function text(lines: readonly HighlightedLine[]): string {
  return lines.map((line) => line.map((token) => token.text).join("")).join("\n");
}

// ---------------------------------------------------------------------------

test("plainLines splits on newlines and keeps empty lines empty", () => {
  assert.deepEqual(plainLines("a\n\nb"), [[{ text: "a", cls: null }], [], [{ text: "b", cls: null }]]);
  assert.deepEqual(plainLines(""), [[]]);
});

test("treeToLines round-trips the source exactly", () => {
  const code = "const x = \"hi\"\nconst y = 2\n";
  const lines = treeToLines(code, buildTree(code, [[1, 0, 5], [2, 10, 14], [1, 15, 20]]));
  assert.equal(text(lines), code);
});

test("treeToLines assigns our token classes and leaves the rest unstyled", () => {
  const code = 'const x = "hi"';
  const lines = treeToLines(code, buildTree(code, [[1, 0, 5], [2, 10, 14]]));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], [
    { text: "const", cls: "keyword" },
    { text: ' x = ', cls: null },
    { text: '"hi"', cls: "string" }
  ]);
});

test("treeToLines cuts a styled run that spans a newline into per-line runs", () => {
  const code = 'a = "one\ntwo"\nb';
  const lines = treeToLines(code, buildTree(code, [[2, 4, 13]]));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], [
    { text: "a = ", cls: null },
    { text: '"one', cls: "string" }
  ]);
  assert.deepEqual(lines[1], [{ text: 'two"', cls: "string" }]);
  assert.deepEqual(lines[2], [{ text: "b", cls: null }]);
  assert.equal(text(lines), code);
});

test("an empty line inside a block stays an empty line", () => {
  const code = "a\n\nb";
  const lines = treeToLines(code, buildTree(code, []));
  assert.deepEqual(lines[1], []);
  assert.equal(text(lines), code);
});

test("pickTokenClass takes the first known class and tolerates unknown lists", () => {
  assert.equal(pickTokenClass("keyword"), "keyword");
  assert.equal(pickTokenClass("tok-foo string"), "string");
  assert.equal(pickTokenClass("tok-foo tok-bar"), null);
  assert.equal(pickTokenClass(""), null);
});

// ---------------------------------------------------------------------------
// Incremental parsing
// ---------------------------------------------------------------------------

function fakeParser(record: Array<{ code: string; incremental: boolean }>): Parser {
  const parse = (code: string, fragments?: unknown): Tree => {
    record.push({ code, incremental: Array.isArray(fragments) && fragments.length > 0 });
    return buildTree(code, []);
  };
  return { parse } as unknown as Parser;
}

test("an append reuses the previous tree as a fragment set", () => {
  const record: Array<{ code: string; incremental: boolean }> = [];
  const highlight = createIncrementalTreeHighlighter(fakeParser(record));
  // Lezer's `applyChanges` drops a fragment that leaves less than its 128-char
  // minimum gap before the edit, so a reusable prefix has to be a real one.
  const prefix = "const a = 1;\n".repeat(20);
  highlight(prefix);
  highlight(`${prefix}const b = 2;\n`);
  assert.deepEqual(
    record.map((call) => call.incremental),
    [false, true]
  );
});

test("a block too short for a fragment gap simply re-parses in full", () => {
  const record: Array<{ code: string; incremental: boolean }> = [];
  const highlight = createIncrementalTreeHighlighter(fakeParser(record));
  highlight("const a = 1;\n");
  highlight("const a = 1;\nconst b = 2;\n");
  assert.deepEqual(
    record.map((call) => call.incremental),
    [false, false]
  );
});

test("a text that stops sharing the prefix drops the cache", () => {
  const record: Array<{ code: string; incremental: boolean }> = [];
  const highlight = createIncrementalTreeHighlighter(fakeParser(record));
  highlight("const a = 1;");
  highlight("let a = 1;");
  assert.deepEqual(
    record.map((call) => call.incremental),
    [false, false]
  );
});

test("an oversized block renders plain and never reaches the parser", () => {
  const record: Array<{ code: string; incremental: boolean }> = [];
  const highlight = createIncrementalTreeHighlighter(fakeParser(record));
  const huge = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
  assert.deepEqual(highlight(huge), plainLines(huge));
  assert.equal(record.length, 0);
});

test("a grammar that throws shrinks the output instead of killing the row", () => {
  const thrower = {
    parse: () => {
      throw new Error("boom");
    }
  } as unknown as Parser;
  assert.deepEqual(createIncrementalTreeHighlighter(thrower)("a\nb"), plainLines("a\nb"));
  assert.deepEqual(highlightCode("a\nb", thrower), plainLines("a\nb"));
});

test("highlightCode with no parser is the plain renderer", () => {
  assert.deepEqual(highlightCode("a\nb", null), plainLines("a\nb"));
});

// ---------------------------------------------------------------------------
// The LRU
// ---------------------------------------------------------------------------

test("the LRU evicts the least recently used entry past its entry cap", () => {
  const cache = new SizedLruCache<string>(2, 1000);
  cache.set("a", "A", 1);
  cache.set("b", "B", 1);
  assert.equal(cache.get("a"), "A"); // promotes a
  cache.set("c", "C", 1);
  assert.equal(cache.get("b"), null);
  assert.equal(cache.get("a"), "A");
  assert.equal(cache.get("c"), "C");
  assert.equal(cache.size, 2);
});

test("the LRU evicts on the byte budget too", () => {
  const cache = new SizedLruCache<string>(100, 10);
  cache.set("a", "A", 6);
  cache.set("b", "B", 6);
  assert.equal(cache.get("a"), null);
  assert.equal(cache.get("b"), "B");
  assert.equal(cache.bytes, 6);
});

test("an oversized value is not stored and evicts nothing", () => {
  const cache = new SizedLruCache<string>(100, 10);
  cache.set("a", "A", 5);
  cache.set("huge", "H", 11);
  assert.equal(cache.get("huge"), null);
  assert.equal(cache.get("a"), "A");
});

test("re-setting a key replaces its size rather than double-counting it", () => {
  const cache = new SizedLruCache<string>(100, 100);
  cache.set("a", "A", 10);
  cache.set("a", "AA", 20);
  assert.equal(cache.bytes, 20);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("a"), "AA");
});

test("clear empties the cache and its accounting", () => {
  const cache = new SizedLruCache<string>(100, 100);
  cache.set("a", "A", 10);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

test("the cache key separates mode, language, length and content", () => {
  assert.notEqual(highlightCacheKey("a", "ts", "dark"), highlightCacheKey("a", "ts", "light"));
  assert.notEqual(highlightCacheKey("a", "ts", "dark"), highlightCacheKey("a", "js", "dark"));
  assert.notEqual(highlightCacheKey("a", "ts", "dark"), highlightCacheKey("b", "ts", "dark"));
  assert.equal(highlightCacheKey("a", "ts", "dark"), highlightCacheKey("a", "ts", "dark"));
});

test("fnv1a32 is stable and unsigned", () => {
  assert.equal(fnv1a32(""), 0x811c9dc5);
  assert.ok(fnv1a32("hello") >= 0);
  assert.equal(fnv1a32("hello"), fnv1a32("hello"));
  assert.notEqual(fnv1a32("hello"), fnv1a32("hellp"));
});

test("estimateHighlightSize grows with both the source and the run count", () => {
  const small = estimateHighlightSize("ab", [[{ text: "ab", cls: null }]]);
  const more = estimateHighlightSize("ab", [
    [
      { text: "a", cls: "keyword" },
      { text: "b", cls: null }
    ]
  ]);
  assert.ok(more > small);
});

// ---------------------------------------------------------------------------
// Fence-name resolution
// ---------------------------------------------------------------------------

const ENTRIES = [
  { name: "TypeScript", alias: ["ts"], extensions: ["ts"] },
  { name: "JavaScript", alias: ["ecmascript", "js"], extensions: ["js", "mjs"] },
  { name: "Python", alias: ["py"], extensions: ["py"] },
  { name: "Shell", alias: ["bash", "sh", "zsh"], extensions: ["sh"] },
  { name: "YAML", alias: ["yml"], extensions: ["yaml", "yml"] },
  { name: "C++", alias: ["cpp"], extensions: ["cpp", "h"] }
];

test("resolveLanguageEntry matches a name, an alias and an extension", () => {
  assert.equal(resolveLanguageEntry("typescript", ENTRIES)?.name, "TypeScript");
  assert.equal(resolveLanguageEntry("TypeScript", ENTRIES)?.name, "TypeScript");
  assert.equal(resolveLanguageEntry("ecmascript", ENTRIES)?.name, "JavaScript");
  assert.equal(resolveLanguageEntry("mjs", ENTRIES)?.name, "JavaScript");
});

test("resolveLanguageEntry maps the fence spellings agent CLIs actually emit", () => {
  assert.equal(resolveLanguageEntry("sh", ENTRIES)?.name, "Shell");
  assert.equal(resolveLanguageEntry("bash", ENTRIES)?.name, "Shell");
  assert.equal(resolveLanguageEntry("console", ENTRIES)?.name, "Shell");
  assert.equal(resolveLanguageEntry("ts", ENTRIES)?.name, "TypeScript");
  assert.equal(resolveLanguageEntry("py", ENTRIES)?.name, "Python");
  assert.equal(resolveLanguageEntry("yml", ENTRIES)?.name, "YAML");
  assert.equal(resolveLanguageEntry("h", ENTRIES)?.name, "C++");
});

test("resolveLanguageEntry reads only the first word of the info string", () => {
  assert.equal(resolveLanguageEntry('ts title="a.ts"', ENTRIES)?.name, "TypeScript");
  assert.equal(resolveLanguageEntry("  python  ", ENTRIES)?.name, "Python");
});

test("an unknown or absent fence name resolves to null, which renders unhighlighted", () => {
  assert.equal(resolveLanguageEntry("brainfuck", ENTRIES), null);
  assert.equal(resolveLanguageEntry("", ENTRIES), null);
  assert.equal(resolveLanguageEntry(undefined, ENTRIES), null);
  assert.equal(resolveLanguageEntry("   ", ENTRIES), null);
});

test("fenceLanguageLabel and extractFenceLanguage", () => {
  assert.equal(fenceLanguageLabel('ts title="a.ts"'), "ts");
  assert.equal(fenceLanguageLabel(undefined), "");
  assert.equal(extractFenceLanguage("language-python"), "python");
  assert.equal(extractFenceLanguage("hljs language-go foo"), "go");
  assert.equal(extractFenceLanguage(undefined), "");
  assert.equal(extractFenceLanguage("no-language-here"), "");
});
