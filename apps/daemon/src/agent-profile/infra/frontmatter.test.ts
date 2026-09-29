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
  assert.throws(() => parseMarkdownDocument("---\nname: [unclosed\n---\nbody"), /Invalid YAML frontmatter/);
  assert.throws(() => parseMarkdownDocument("---\nname: a\nname: b\n---\n"), /Invalid YAML frontmatter/);
  assert.throws(() => parseMarkdownDocument("---\n- a\n- b\n---\n"), /must be a mapping/);
  assert.throws(() => parseMarkdownDocument("---\njust a string\n---\n"), /must be a mapping/);
});

test("serialize omits an empty block, except to protect a body that starts with a fence", () => {
  assert.equal(serializeMarkdownDocument({}, "# Title\n"), "# Title\n");
  assert.equal(serializeMarkdownDocument({ gone: undefined }, "x"), "x");
  const tricky = "---\nnot: frontmatter\n---\nbody";
  const text = serializeMarkdownDocument({}, tricky);
  assert.deepEqual(parseMarkdownDocument(text), { frontmatter: {}, body: tricky, hadFrontmatter: true });
});

test("yaml 1.1 (js-yaml 3, OpenCode's reader): quotes what 1.1 would retype, and reads it back the way that reader does", () => {
  const risky = ["2024-01-01", "1:30", "0b101", "1_000", "0x1F", "2001-12-14 21:59:43.10 -5", ".5", "yes", "~"];
  for (const value of risky) {
    const text = serializeMarkdownDocument({ description: value }, "Body\n", { yaml: "1.1" });
    assert.match(text, /^---\ndescription: "/, `${value} is quoted: ${text}`);
    assert.equal(parseMarkdownDocument(text, { yaml: "1.1" }).frontmatter.description, value);
  }
  // Unquoted, a 1.1 reader takes these for other types; only true/false are booleans for js-yaml 3.
  const read = (line: string): unknown => parseMarkdownDocument(`---\n${line}\n---\n`, { yaml: "1.1" }).frontmatter.v;
  assert.ok(read("v: 2024-01-01") instanceof Date);
  assert.equal(read("v: 1:30"), 90);
  assert.equal(read("v: 1_000"), 1000);
  assert.equal(read("v: yes"), "yes");
  assert.equal(read("v: true"), true);
  // The default stays YAML 1.2.
  assert.equal(parseMarkdownDocument("---\nv: 1_000\n---\n").frontmatter.v, "1_000");
});
