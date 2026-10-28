import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GMAIL_PASSAGE, LONG_GUIDE, SHORT_GUIDE, SHORT_GUIDE_CONCEPTS } from "../linking/fixtures/tiktok-guides.ts";
import { EXCERPT_GAP, EXCERPT_OPENING_CHARS, PASSAGE_MAX_CHARS, PASSAGE_MIN_CHARS, relevantExcerpt, splitPassages } from "./excerpts.ts";

const query = { text: `${SHORT_GUIDE.title}\n${SHORT_GUIDE.body}`, concepts: SHORT_GUIDE_CONCEPTS.map((c) => ({ name: c.name, weight: 1 })) };
/** The excerpt's parts without the separators. */
const parts = (text: string): string[] => text.split(`\n${EXCERPT_GAP}`).map((part) => part.trim()).filter((part) => part !== "");

describe("splitPassages", () => {
  it("cuts at lines, joins short ones with the next, cuts a long line at sentence ends; the passages cover the body in order", () => {
    const steps = ["Step 1: Reset", "Wipe the phone and take the SIM out. ".repeat(8).trim(), "Step 2: Region", "Short.", "x ".repeat(120).trim()].join("\n\n");
    const spans = splitPassages(steps);
    // "Step 1: Reset" joins the paragraph after it; "Step 2: Region" joins "Short." and the last line.
    assert.equal(spans.length, 2);
    assert.ok(steps.slice(spans[0]!.start, spans[0]!.end).startsWith("Step 1: Reset\n\nWipe the phone"));
    assert.ok(steps.slice(spans[1]!.start, spans[1]!.end).startsWith("Step 2: Region\n\nShort."));

    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something about proxies.`).join(" ");
    const cut = splitPassages(long);
    assert.ok(cut.length > 1);
    for (const span of cut) {
      assert.ok(span.end - span.start <= PASSAGE_MAX_CHARS, "at most the max");
      assert.ok(long.slice(span.start, span.end).endsWith("."), "cut after a sentence end");
    }
    for (const body of [steps, long, LONG_GUIDE.body]) {
      const spans = splitPassages(body);
      let at = 0;
      for (const span of spans) {
        assert.ok(span.start >= at && span.end > span.start, "in order, not overlapping");
        assert.equal(body.slice(at, span.start).trim(), "", "only whitespace between passages");
        at = span.end;
      }
      assert.equal(body.slice(at).trim(), "");
    }
    // Short lines (step headings) never stand alone.
    const passages = splitPassages(LONG_GUIDE.body);
    assert.ok(passages.every((span) => span.end - span.start >= PASSAGE_MIN_CHARS), "no passage under the minimum");
  });
});

describe("relevantExcerpt", () => {
  it("leaves a body within the budget as it is", () => {
    const excerpt = relevantExcerpt(`  ${SHORT_GUIDE.body}\n`, query, 3_000);
    assert.deepEqual(excerpt, { text: SHORT_GUIDE.body, excerpted: false, chars: SHORT_GUIDE.body.length });
  });

  it("a long body: the opening, then the passages most relevant to the other entry (the Gmail passage deep inside), in document order, within the budget", () => {
    const budget = 3_000;
    assert.ok(LONG_GUIDE.body.indexOf(GMAIL_PASSAGE) > 4_000, "the key passage is deep inside");
    const excerpt = relevantExcerpt(LONG_GUIDE.body, query, budget);
    assert.equal(excerpt.excerpted, true);
    assert.equal(excerpt.chars, LONG_GUIDE.body.length);
    assert.ok(excerpt.text.includes(GMAIL_PASSAGE), excerpt.text);
    assert.ok(excerpt.text.startsWith("Step-by-step phone setup for TikTok"), "the opening first");
    assert.ok(excerpt.text.includes(`\n${EXCERPT_GAP}\n`), "gaps are marked");
    assert.ok(excerpt.text.endsWith(EXCERPT_GAP), "it stops before the body does");
    const pieces = parts(excerpt.text);
    assert.ok(pieces.reduce((sum, part) => sum + part.length, 0) <= budget, "within the budget");
    let at = -1;
    for (const part of pieces) {
      const found = LONG_GUIDE.body.indexOf(part);
      assert.ok(found > at, "verbatim, in document order");
      at = found;
    }
    // Filler that shares nothing particular with the other entry is left out.
    assert.ok(!excerpt.text.includes("Daily routine, part 6"));
    assert.deepEqual(relevantExcerpt(LONG_GUIDE.body, query, budget), excerpt, "deterministic");
  });

  it("nothing in common with the other entry: only the opening, about its length", () => {
    const excerpt = relevantExcerpt(LONG_GUIDE.body, { text: "zzz qqq" }, 3_000);
    assert.equal(parts(excerpt.text).length, 1);
    assert.ok(parts(excerpt.text)[0]!.length <= EXCERPT_OPENING_CHARS, excerpt.text);
    assert.ok(excerpt.text.startsWith("Step-by-step phone setup") && excerpt.text.endsWith(EXCERPT_GAP));
  });

  it("passages naming a focus concept come first, even when other passages share more words", () => {
    const body = [
      "Opening line of a long note.",
      ...Array.from({ length: 30 }, (_, i) => `Proxy settings ${i}: socks5 address port user password iproyal shadowrocket fraud score low risk, all the steps again.`),
      "Late remark: keep location services off on every device you own."
    ].join("\n");
    const other = "set up socks5 proxy address port user password at iproyal in shadowrocket, check the fraud score reads low risk";
    const plain = relevantExcerpt(body, { text: other }, 600);
    assert.ok(!plain.text.includes("Late remark"));
    const focused = relevantExcerpt(body, { text: other, focus: ["Location services off"] }, 600);
    assert.ok(focused.text.includes("Late remark: keep location services off"), focused.text);
    assert.ok(focused.text.startsWith("Opening line"));
  });

  it("a word or concept already shown counts less again: the excerpts cover different points", () => {
    const pad = (line: string): string => `${line} ${"Nothing in this sentence is about the other guide at all, it only fills the line to length.".repeat(2)}`;
    const proxy = (i: number) => pad(`Proxy note ${"abc"[i]}: an isp proxy from iproyal over socks5, with its fraud score read on ipqualityscore and scamalytics.`);
    const lines = [
      pad("Opening line of a long note."),
      ...Array.from({ length: 8 }, (_, i) => pad(`Filler ${i}.`)),
      proxy(0),
      ...Array.from({ length: 4 }, (_, i) => pad(`Filler ${8 + i}.`)),
      proxy(1),
      pad("Email note: pick Gmail, an outlook email gets flagged."),
      proxy(2),
      ...Array.from({ length: 6 }, (_, i) => pad(`Filler ${12 + i}.`))
    ];
    const body = lines.join("\n");
    // The opening and two passages fit: one proxy note (the most words in common), then the email
    // note rather than a second proxy note saying the same again.
    const budget = lines[0]!.length + 2 * proxy(0).length + 10;
    const excerpt = relevantExcerpt(body, { text: SHORT_GUIDE.body }, budget);
    assert.equal((excerpt.text.match(/Proxy note/g) ?? []).length, 1, excerpt.text);
    assert.ok(excerpt.text.includes("Email note: pick Gmail"), excerpt.text);
  });
});
