import assert from "node:assert/strict";
import test from "node:test";
import { CHUNKER_VERSION, CHUNK_TOKEN_BUDGET, type TextSpan, chunkBody, estimateTokens } from "./text.ts";

// The chunker (retrieval spec P0.3): word windows with overlap, capped by an estimate of
// multilingual-e5-small tokens so token-dense text is never truncated by the model; spans are
// body offsets that cover the whole body. (The real tokenizer's counts are checked in
// embedder.model.test.ts when the model is installed.)

const words = (text: string): string[] => text.match(/\S+/g) ?? [];
const spanCost = (body: string, span: TextSpan): number => words(body.slice(span.start, span.end)).reduce((sum, w) => sum + estimateTokens(w), 0);

/** Every span is a non-empty, in-order slice that starts and ends on a non-space; together they cover every non-space character. */
function assertSpans(body: string, spans: readonly TextSpan[]): void {
  assert.ok(spans.length > 0);
  const covered = new Uint8Array(body.length);
  let previous: TextSpan | null = null;
  for (const span of spans) {
    assert.ok(span.start >= 0 && span.end <= body.length && span.start < span.end, JSON.stringify(span));
    assert.ok(/\S/.test(body[span.start]!) && /\S/.test(body[span.end - 1]!), `span ${JSON.stringify(span)} starts or ends on a space`);
    // A span never starts or ends inside a surrogate pair.
    assert.ok(!/[\uDC00-\uDFFF]/.test(body[span.start]!) && !/[\uD800-\uDBFF]/.test(body[span.end - 1]!), JSON.stringify(span));
    if (previous) {
      assert.ok(span.start > previous.start, "spans move forward");
      assert.ok(span.start <= previous.end + (body.slice(previous.end).match(/^\s*/)?.[0].length ?? 0), "no gap between spans");
    }
    covered.fill(1, span.start, span.end);
    previous = span;
  }
  for (let i = 0; i < body.length; i += 1) {
    if (/\S/.test(body[i]!)) assert.equal(covered[i], 1, `character ${i} is in no span`);
  }
}

test("the chunker has a new version (vectors from the old chunks are recomputed)", () => {
  assert.notEqual(CHUNKER_VERSION, "words-180-40-v1");
});

test("a short body is one span over the whole body, as before", () => {
  assert.deepEqual(chunkBody("  Annual billing with a discount lifts cash flow.  "), [{ start: 0, end: 51 }]);
  assert.deepEqual(chunkBody(""), [{ start: 0, end: 0 }]);
});

test("prose keeps 180-word windows sharing 40 words", () => {
  const vocabulary = "paywalls convert better when the annual plan shows its saving; las páginas de destino convierten mejor con pruebas sociales".split(" ");
  const body = Array.from({ length: 1_000 }, (_, i) => `${vocabulary[(i * 7) % vocabulary.length]}${i % 25 === 24 ? "\n\n" : " "}`).join("");
  const all = words(body);
  const spans = chunkBody(body);
  assertSpans(body, spans);
  const windows = spans.map((span) => words(body.slice(span.start, span.end)));
  for (const window of windows.slice(0, -1)) assert.equal(window.length, 180);
  assert.deepEqual(windows[0], all.slice(0, 180));
  assert.deepEqual(windows[1], all.slice(140, 320));
  assert.deepEqual(windows.at(-1)!.at(-1), all.at(-1));
  for (const span of spans) assert.ok(spanCost(body, span) <= CHUNK_TOKEN_BUDGET);
});

test("token-dense text gets shorter windows, each within the budget", () => {
  const json = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: `ke_${i.toString(36)}`, score: i / 7, tags: ["seo", "ads"] })), null, 1);
  const code = Array.from({ length: 200 }, (_, i) => `const value${i} = items.filter((x) => x.id !== ${i}).map((x) => ({ ...x, rank: x.rank * 2 }));`).join("\n");
  const urls = Array.from({ length: 120 }, (_, i) => `https://example.com/blog/${i}/post?utm_source=tiktok&utm_campaign=q${i % 4}#h${i}`).join(" ");
  for (const body of [json, code, urls]) {
    const spans = chunkBody(body);
    assert.ok(spans.length > 1);
    assertSpans(body, spans);
    for (const span of spans) assert.ok(spanCost(body, span) <= CHUNK_TOKEN_BUDGET, `${spanCost(body, span)}`);
  }
});

test("a run without spaces longer than a window is cut inside (minified JSON, base64, CJK)", () => {
  const minified = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, v: `x${i}` })));
  const base64 = Buffer.from(Array.from({ length: 30_000 }, (_, i) => (i * 2_654_435_761) % 256)).toString("base64");
  const cjk = "付费墙测试显示年度订阅的转化率更高。我们在抖音上投放广告，并优化了落地页。".repeat(80);
  const emoji = "🚀🔥💯🎉👉🙏✨😂".repeat(300);
  for (const body of [minified, base64, cjk, emoji]) {
    const spans = chunkBody(body);
    assert.ok(spans.length > 1, `${body.slice(0, 20)}…: ${spans.length} span(s)`);
    assertSpans(body, spans);
    for (const span of spans) assert.ok(spanCost(body, span) <= CHUNK_TOKEN_BUDGET, `${spanCost(body, span)}`);
  }
  // CJK is estimated at a token a character, so a window holds at most the budget's worth.
  for (const span of chunkBody(cjk)) assert.ok(span.end - span.start <= CHUNK_TOKEN_BUDGET);
});

test("one long word among prose: the prose around it keeps its words whole", () => {
  const long = "a1".repeat(2_000);
  const body = `Intro sentence about paywalls. ${long} And a closing sentence about landing pages.`;
  const spans = chunkBody(body);
  assertSpans(body, spans);
  assert.equal(spans[0]!.start, 0);
  assert.equal(spans.at(-1)!.end, body.length);
  for (const span of spans) assert.ok(spanCost(body, span) <= CHUNK_TOKEN_BUDGET);
});

test("token estimates: prose is cheap, ids and symbols cost more, CJK a token a character", () => {
  assert.ok(estimateTokens("the") < 2);
  assert.ok(estimateTokens("páginas,") < 4);
  assert.ok(estimateTokens("conversion") < 4);
  assert.ok(estimateTokens("f80102d3f2a1229f387d3c81909990d8") >= 0.66 * 32, "hex");
  assert.ok(estimateTokens("tlrmnbvc") > estimateTokens("together"), "no vowels: spelled out");
  assert.ok(estimateTokens("getUserByIdOrThrow") > estimateTokens("getuserbyidorthrow") - 1, "camelCase is dense");
  assert.equal(estimateTokens("付费墙测试"), 1 + 5);
  assert.ok(estimateTokens("∑∫∂√∞") >= 5);
  assert.ok(estimateTokens("Тест") < 3.5);
});
