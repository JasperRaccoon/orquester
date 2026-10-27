import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addComposerQuote,
  composeQuotedPrompt,
  isCodeQuote,
  mergeQuotes,
  quoteExcerpt,
  quotesFromText,
  splitLeadingQuotes,
  type ComposerQuote
} from "./composer-quotes";
import { MAX_COMPOSER_QUOTE_CHARS, MAX_COMPOSER_QUOTES } from "../../../lib/agent-chat/composer.logic";

const q = (id: string, text: string): ComposerQuote => ({ id, text });

describe("a passage as a blockquote", () => {

  it("closes a fence the passage opened and never closed", () => {
    const prompt = (text: string) => composeQuotedPrompt([q("1", text)], "");
    assert.equal(prompt("see\n```py\nprint(1)"), "> see\n> ```py\n> print(1)\n> ```");
    assert.equal(prompt("~~~~\nx\n~~~"), "> ~~~~\n> x\n> ~~~\n> ~~~~", "a shorter fence does not close it");
    assert.equal(prompt("````\na\n````"), "> ````\n> a\n> ````", "a closed fence is left alone");
    assert.equal(prompt("``` not `a` fence\ntext"), "> ``` not `a` fence\n> text", "a backtick in the info string is no fence");
  });
});

describe("the prompt a quoted send carries", () => {
  it("puts the quote ahead of the user's text, a blank line between", () => {
    assert.equal(
      composeQuotedPrompt([q("1", "\n\n  \r\nThe cache is per tab.\r\n\r\n> nested\n    indented\n\n")], "Why per tab?"),
      "> The cache is per tab.\n>\n> > nested\n>     indented\n\nWhy per tab?"
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
    const prompt = composeQuotedPrompt([q("1", "```js\nlet x;\n\nnext();")], "rename x");
    assert.equal(prompt, "> ```js\n> let x;\n>\n> next();\n> ```\n\nrename x");
  });
});

describe("a user message split into its quotes and its body", () => {
  it("reads back what a quoted send composed", () => {
    const quotes = [q("1", "para one\n\npara two"), q("2", "```ts\nconst a = 1;\n\nconst b = 2;\n```"), q("3", "> nested")];
    const text = "my comment\n\nover two paragraphs";
    const split = splitLeadingQuotes("> para one\n>\n> para two\n\n> ```ts\n> const a = 1;\n>\n> const b = 2;\n> ```\n\n> > nested\n\nmy comment\n\nover two paragraphs");
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

describe("a message coming back into a draft", () => {
  it("returns as it was composed: its quotes as quotes, its words as the text", () => {
    const back = quotesFromText("> one\n\n> two\n\nwhy?");
    assert.deepEqual(back.quotes.map((quote) => quote.text), ["one", "two"]);
    assert.equal(back.text, "why?");
    assert.notEqual(back.quotes[0]!.id, back.quotes[1]!.id);
  });

  it("is left as it is without quotes, or with one too long to hold", () => {
    assert.deepEqual(quotesFromText("plain [Image #1]"), { text: "plain [Image #1]", quotes: [] });
    const long = `> ${"x".repeat(MAX_COMPOSER_QUOTE_CHARS + 1)}\n\nbody`;
    assert.deepEqual(quotesFromText(long), { text: long, quotes: [] });
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
});
