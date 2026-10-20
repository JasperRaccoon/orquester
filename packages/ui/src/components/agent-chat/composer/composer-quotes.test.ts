import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addComposerQuote,
  blockquote,
  composeQuotedPrompt,
  isCodeQuote,
  MAX_COMPOSER_QUOTE_CHARS,
  MAX_COMPOSER_QUOTES,
  mergeQuotes,
  newQuoteId,
  normalizeQuoteText,
  quoteExcerpt,
  quotesEqual,
  splitLeadingQuotes,
  type ComposerQuote
} from "./composer-quotes";

const q = (id: string, text: string): ComposerQuote => ({ id, text });

describe("a passage as a blockquote", () => {
  it("quotes every line, a blank one as a bare `>` so the quote stays one block", () => {
    assert.equal(blockquote("first line\n\nsecond paragraph"), "> first line\n>\n> second paragraph");
  });

  it("nests a line that was already a quote, and keeps indentation", () => {
    assert.equal(blockquote("> they said\n    indented"), "> > they said\n>     indented");
  });

  it("drops blank lines at either end and unifies line endings", () => {
    assert.equal(blockquote("\n\n  \r\nbody\r\nmore\n\n"), "> body\n> more");
  });

  it("quotes a fenced code block line by line, its blank lines included", () => {
    assert.equal(
      blockquote("```ts\nconst a = 1;\n\nconst b = 2;\n```"),
      "> ```ts\n> const a = 1;\n>\n> const b = 2;\n> ```"
    );
  });

  it("closes a fence the passage opened and never closed", () => {
    assert.equal(normalizeQuoteText("see\n```py\nprint(1)"), "see\n```py\nprint(1)\n```");
    assert.equal(normalizeQuoteText("~~~~\nx\n~~~"), "~~~~\nx\n~~~\n~~~~", "a shorter fence does not close it");
    assert.equal(normalizeQuoteText("````\na\n````"), "````\na\n````", "a closed fence is left alone");
    assert.equal(normalizeQuoteText("``` not `a` fence\ntext"), "``` not `a` fence\ntext", "a backtick in the info string is no fence");
  });
});

describe("the prompt a quoted send carries", () => {
  it("puts the quote ahead of the user's text, a blank line between", () => {
    assert.equal(
      composeQuotedPrompt([q("1", "The cache is per tab.")], "Why per tab?"),
      "> The cache is per tab.\n\nWhy per tab?"
    );
  });

  it("keeps several quotes several blocks, in order", () => {
    assert.equal(
      composeQuotedPrompt([q("1", "one\ntwo"), q("2", "three")], "  both wrong  "),
      "> one\n> two\n\n> three\n\nboth wrong"
    );
  });

  it("sends the quotes alone when there is no text", () => {
    assert.equal(composeQuotedPrompt([q("1", "only this")], "   \n "), "> only this");
  });

  it("leaves the text exactly as it is when there are no quotes", () => {
    assert.equal(composeQuotedPrompt([], "  as typed \n"), "  as typed \n");
    assert.equal(composeQuotedPrompt([q("1", "  \n ")], "hi"), "hi", "an empty quote is no quote");
  });

  it("keeps a quoted code block closed, so the user's text never lands inside it", () => {
    const prompt = composeQuotedPrompt([q("1", "```js\nlet x;")], "rename x");
    assert.equal(prompt, "> ```js\n> let x;\n> ```\n\nrename x");
  });
});

describe("a user message split into its quotes and its body", () => {
  it("reads back what a quoted send composed", () => {
    const quotes = [q("1", "para one\n\npara two"), q("2", "```ts\nconst a = 1;\n\nconst b = 2;\n```"), q("3", "> nested")];
    const text = "my comment\n\nover two paragraphs";
    const split = splitLeadingQuotes(composeQuotedPrompt(quotes, text));
    assert.deepEqual(split.quotes, quotes.map((quote) => quote.text));
    assert.equal(split.body, text);
  });

  it("has no body when the quotes were sent alone", () => {
    assert.deepEqual(splitLeadingQuotes("> a\n\n> b"), { quotes: ["a", "b"], body: "" });
  });

  it("is all body when the message does not open with a quote", () => {
    assert.deepEqual(splitLeadingQuotes("hello\n> later"), { quotes: [], body: "hello\n> later" });
  });

  it("is all body when a line continues a quote (markdown would fold it in)", () => {
    assert.deepEqual(splitLeadingQuotes("> quoted\nlazy line"), { quotes: [], body: "> quoted\nlazy line" });
  });

  it("takes off one level of `>` and an optional space", () => {
    assert.deepEqual(splitLeadingQuotes(">tight\n>  two spaces\n\nbody").quotes, ["tight\n two spaces"]);
  });
});

describe("a quote's chip", () => {
  it("previews prose on one line, markers stripped", () => {
    assert.equal(quoteExcerpt("## Heading\n- item one\n1. item two\n> nested"), "Heading item one item two nested");
  });

  it("previews code without its fences, and bounds the length", () => {
    assert.equal(quoteExcerpt("```ts\nconst a = 1;\n```"), "const a = 1;");
    const long = quoteExcerpt("x".repeat(500), 20);
    assert.equal(long.length, 20);
    assert.ok(long.endsWith("…"));
  });

  it("knows a quote that is one code block and nothing else", () => {
    assert.equal(isCodeQuote("```ts\na\n```"), true);
    assert.equal(isCodeQuote("````\n```\n````"), true, "an inner shorter fence is code");
    assert.equal(isCodeQuote("```\na\n```\ntext\n```\nb\n```"), false, "two blocks with prose between");
    assert.equal(isCodeQuote("prose"), false);
    assert.equal(isCodeQuote("`inline`"), false);
  });
});

describe("the draft's list of quotes", () => {
  it("adds a passage at the end, normalised", () => {
    const result = addComposerQuote([q("a", "first")], "\nsecond\n", "b");
    assert.ok(result.ok);
    assert.deepEqual(result.quotes, [q("a", "first"), q("b", "second")]);
  });

  it("refuses an empty passage, one too long, and one past the bound", () => {
    const empty = addComposerQuote([], "  \n ");
    assert.equal(empty.ok, false);
    const long = addComposerQuote([], "x".repeat(MAX_COMPOSER_QUOTE_CHARS + 1));
    assert.equal(long.ok, false);
    const full = Array.from({ length: MAX_COMPOSER_QUOTES }, (_, index) => q(String(index), "t"));
    const over = addComposerQuote(full, "one more");
    assert.equal(over.ok, false);
    if (!over.ok) assert.match(over.reason, new RegExp(String(MAX_COMPOSER_QUOTES)));
  });

  it("puts a failed send's quotes back ahead of the ones quoted meanwhile, each once", () => {
    assert.deepEqual(
      mergeQuotes([q("a", "sent"), q("b", "sent too")], [q("c", "meanwhile"), q("a", "sent")]),
      [q("a", "sent"), q("b", "sent too"), q("c", "meanwhile")]
    );
  });

  it("compares lists by value, absent as empty", () => {
    assert.equal(quotesEqual(undefined, []), true);
    assert.equal(quotesEqual([q("a", "x")], [q("a", "x")]), true);
    assert.equal(quotesEqual([q("a", "x")], [q("a", "y")]), false);
    assert.equal(quotesEqual([q("a", "x"), q("b", "y")], [q("b", "y"), q("a", "x")]), false);
  });

  it("mints ids that do not repeat", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newQuoteId()));
    assert.equal(ids.size, 200);
  });
});
