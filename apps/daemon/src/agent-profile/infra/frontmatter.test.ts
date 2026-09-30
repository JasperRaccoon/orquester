import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownDocument, serializeMarkdownDocument } from "./frontmatter.ts";

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
  assert.throws(() => parseMarkdownDocument("---\nname: [unclosed\n---\nbody"));
  assert.throws(() => parseMarkdownDocument("---\nname: a\nname: b\n---\n"));
  assert.throws(() => parseMarkdownDocument("---\n- a\n- b\n---\n"));
  assert.throws(() => parseMarkdownDocument("---\njust a string\n---\n"));
});

test("serialize omits an empty block, except to protect a body that starts with a fence", () => {
  assert.equal(serializeMarkdownDocument({}, "# Title\n"), "# Title\n");
  assert.equal(serializeMarkdownDocument({ gone: undefined }, "x"), "x");
  const tricky = "---\nnot: frontmatter\n---\nbody";
  const text = serializeMarkdownDocument({}, tricky);
  assert.deepEqual(parseMarkdownDocument(text), { frontmatter: {}, body: tricky, hadFrontmatter: true });
});
