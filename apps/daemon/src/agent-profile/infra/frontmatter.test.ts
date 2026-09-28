import assert from "node:assert/strict";
import test from "node:test";
import { mergeFrontmatter, parseMarkdownDocument, serializeMarkdownDocument } from "./frontmatter.ts";

test("parses a frontmatter block and keeps the body as it is", () => {
  const doc = parseMarkdownDocument("---\nname: review\ndescription: Review the diff\ntags: [a, b]\n---\n\n# Review\n");
  assert.deepEqual(doc, {
    frontmatter: { name: "review", description: "Review the diff", tags: ["a", "b"] },
    body: "\n# Review\n",
    hadFrontmatter: true
  });
});

test("handles CRLF, a BOM, trailing spaces on the fences and a block at end of text", () => {
  assert.deepEqual(parseMarkdownDocument("﻿---\r\nname: x\r\n---\r\nbody\r\n"), {
    frontmatter: { name: "x" },
    body: "body\r\n",
    hadFrontmatter: true
  });
  assert.deepEqual(parseMarkdownDocument("--- \nname: x\n---  "), {
    frontmatter: { name: "x" },
    body: "",
    hadFrontmatter: true
  });
});

test("no frontmatter, an empty one, and an unclosed fence", () => {
  assert.deepEqual(parseMarkdownDocument("# Just a body\n---\n"), {
    frontmatter: {},
    body: "# Just a body\n---\n",
    hadFrontmatter: false
  });
  assert.deepEqual(parseMarkdownDocument("---\n---\nbody"), { frontmatter: {}, body: "body", hadFrontmatter: true });
  assert.deepEqual(parseMarkdownDocument("---\n# comment only\n---\nbody"), {
    frontmatter: {},
    body: "body",
    hadFrontmatter: true
  });
  assert.deepEqual(parseMarkdownDocument("---\nname: x\nno closing fence"), {
    frontmatter: {},
    body: "---\nname: x\nno closing fence",
    hadFrontmatter: false
  });
  assert.deepEqual(parseMarkdownDocument(""), { frontmatter: {}, body: "", hadFrontmatter: false });
  // `----` is not a fence.
  assert.equal(parseMarkdownDocument("----\nx\n----\n").hadFrontmatter, false);
});

test("malformed YAML and a non-mapping block throw clear errors", () => {
  assert.throws(() => parseMarkdownDocument("---\nname: [unclosed\n---\nbody"), /Invalid YAML frontmatter/);
  assert.throws(() => parseMarkdownDocument("---\nname: a\nname: b\n---\n"), /Invalid YAML frontmatter/);
  assert.throws(() => parseMarkdownDocument("---\n- a\n- b\n---\n"), /must be a mapping/);
  assert.throws(() => parseMarkdownDocument("---\njust a string\n---\n"), /must be a mapping/);
});

test("serialize writes the keys in order, quotes what needs it, and round trips", () => {
  const frontmatter = {
    name: "review",
    description: "Review: the diff, #1 — 'quoted' \"too\"",
    "allowed-tools": "Read, Grep",
    "disable-model-invocation": true,
    long: "word ".repeat(40).trim(),
    multi: "line one\nline two"
  };
  const text = serializeMarkdownDocument(frontmatter, "Body\n");
  assert.ok(text.startsWith("---\nname: review\ndescription: "));
  assert.ok(text.endsWith("---\nBody\n"));
  const long = text.split("\n").find((line) => line.startsWith("long:"));
  assert.ok(long !== undefined && long.length > 150, "long strings are not folded");
  assert.deepEqual(parseMarkdownDocument(text), { frontmatter, body: "Body\n", hadFrontmatter: true });
  assert.deepEqual(Object.keys(parseMarkdownDocument(text).frontmatter), Object.keys(frontmatter));
});

test("serialize omits an empty block, except to protect a body that starts with a fence", () => {
  assert.equal(serializeMarkdownDocument({}, "# Title\n"), "# Title\n");
  assert.equal(serializeMarkdownDocument({ gone: undefined }, "x"), "x");
  const tricky = "---\nnot: frontmatter\n---\nbody";
  const text = serializeMarkdownDocument({}, tricky);
  assert.deepEqual(parseMarkdownDocument(text), { frontmatter: {}, body: tricky, hadFrontmatter: true });
});

test("mergeFrontmatter: draft overrides in place, null removes, unmentioned keys survive", () => {
  const existing = { name: "x", description: "old", custom: { keep: true }, license: "MIT" };
  const merged = mergeFrontmatter(existing, { description: "new", license: null, model: "opus", other: undefined });
  assert.deepEqual(merged, { name: "x", description: "new", custom: { keep: true }, model: "opus" });
  assert.deepEqual(Object.keys(merged), ["name", "description", "custom", "model"]);
  assert.deepEqual(existing.license, "MIT", "the input is not mutated");
});
