import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { forgeLinksInText, isUrlText, splitForgeLinks, trimUrlCandidate } from "./text-links";

describe("trimUrlCandidate", () => {
  it("drops sentence punctuation and unbalanced closers, keeps balanced ones", () => {
    assert.equal(trimUrlCandidate("https://github.com/a/b/pull/1."), "https://github.com/a/b/pull/1");
    assert.equal(trimUrlCandidate("https://github.com/a/b/pull/1),"), "https://github.com/a/b/pull/1");
    assert.equal(trimUrlCandidate("https://github.com/a/b/pull/1!?"), "https://github.com/a/b/pull/1");
    assert.equal(trimUrlCandidate("https://en.wikipedia.org/wiki/Foo_(bar)"), "https://en.wikipedia.org/wiki/Foo_(bar)");
    assert.equal(trimUrlCandidate("https://en.wikipedia.org/wiki/Foo_(bar))."), "https://en.wikipedia.org/wiki/Foo_(bar)");
    assert.equal(trimUrlCandidate("https://github.com/a/b/blob/main/x.ts#L1-L2]"), "https://github.com/a/b/blob/main/x.ts#L1-L2");
  });
});

describe("splitForgeLinks", () => {
  it("leaves text without forge links as one run", () => {
    assert.deepEqual(splitForgeLinks("no links here"), [{ text: "no links here" }]);
    assert.deepEqual(splitForgeLinks("see https://example.com/a/b/pull/1"), [{ text: "see https://example.com/a/b/pull/1" }]);
  });

  it("cuts each forge URL out as its own run, keeping the text around it", () => {
    const runs = splitForgeLinks("Fixes https://github.com/acme/app/issues/4, see (https://github.com/acme/app/pull/9).");
    assert.deepEqual(
      runs.map((run) => [run.text, run.link?.kind ?? null]),
      [
        ["Fixes ", null],
        ["https://github.com/acme/app/issues/4", "issue"],
        [", see (", null],
        ["https://github.com/acme/app/pull/9", "pull"],
        [").", null]
      ]
    );
    assert.equal(runs.map((run) => run.text).join(""), "Fixes https://github.com/acme/app/issues/4, see (https://github.com/acme/app/pull/9).");
  });

  it("does not take look-alike hosts", () => {
    assert.deepEqual(splitForgeLinks("https://github.com.evil.example/a/b/pull/1"), [{ text: "https://github.com.evil.example/a/b/pull/1" }]);
  });
});

describe("forgeLinksInText", () => {
  it("lists distinct links in order, capped", () => {
    const text = [
      "https://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/1",
      "https://gitlab.com/g/p/-/merge_requests/2",
      "https://example.com/nope",
      "https://github.com/a/b/commit/abcdef1"
    ].join(" and ");
    assert.deepEqual(
      forgeLinksInText(text).map((link) => link.url),
      ["https://github.com/a/b/pull/1", "https://gitlab.com/g/p/-/merge_requests/2", "https://github.com/a/b/commit/abcdef1"]
    );
    const many = Array.from({ length: 12 }, (_, index) => `https://github.com/a/b/issues/${index + 1}`).join("\n");
    assert.equal(forgeLinksInText(many).length, 8);
    assert.equal(forgeLinksInText(many, 3).length, 3);
    assert.deepEqual(forgeLinksInText(""), []);
  });
});

describe("isUrlText", () => {
  it("is true for autolinks and false for the author's words", () => {
    assert.equal(isUrlText("https://github.com/a/b/pull/1", "https://github.com/a/b/pull/1"), true);
    assert.equal(isUrlText("github.com/a/b/pull/1", "https://github.com/a/b/pull/1"), true);
    assert.equal(isUrlText("www.github.com/a/b/pull/1", "http://www.github.com/a/b/pull/1"), true);
    assert.equal(isUrlText("https://github.com/a/b/", "https://github.com/a/b"), true);
    assert.equal(isUrlText("https://github.com/a/b/blob/main/My File.md", "https://github.com/a/b/blob/main/My%20File.md"), true);
    assert.equal(isUrlText("the fix", "https://github.com/a/b/pull/1"), false);
    assert.equal(isUrlText("#1", "https://github.com/a/b/pull/1"), false);
    assert.equal(isUrlText("", "https://github.com/a/b/pull/1"), false);
  });
});
