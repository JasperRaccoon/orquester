import assert from "node:assert/strict";
import test from "node:test";
import { type TextSpan, chunkBody, embeddingHeader } from "./text.ts";

// The chunker (retrieval spec P0.3): word windows with overlap, capped by an estimate of
// multilingual-e5-small tokens so token-dense text is never truncated by the model; spans are
// body offsets that cover the whole body. (The real tokenizer's counts are checked in
// embedder.model.test.ts when the model is installed.)

const words = (text: string): string[] => text.match(/\S+/g) ?? [];

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

test("a short body is one span over the whole body, as before", () => {
  assert.deepEqual(chunkBody("  Annual billing with a discount lifts cash flow.  "), [{ start: 0, end: 51 }]);
  assert.deepEqual(chunkBody(""), [{ start: 0, end: 0 }]);
});

test("overlapping prose windows cover the whole body in order", () => {
  const vocabulary = "paywalls convert better when the annual plan shows its saving; las páginas de destino convierten mejor con pruebas sociales".split(" ");
  const body = Array.from({ length: 500 }, (_, i) => `${vocabulary[(i * 7) % vocabulary.length]}${i % 25 === 24 ? "\n\n" : " "}`).join("");
  const spans = chunkBody(body);
  assertSpans(body, spans);
  assert.ok(spans.length > 1);
  assert.equal(spans[0]!.start, 0);
  assert.equal(words(body.slice(spans.at(-1)!.start, spans.at(-1)!.end)).at(-1), words(body).at(-1));
  for (let i = 1; i < spans.length; i += 1) assert.ok(spans[i]!.start < spans[i - 1]!.end, "adjacent windows share body text");
});

test("token-dense JSON, code and URLs are split without losing body text", () => {
  const json = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: `ke_${i.toString(36)}`, score: i / 7, tags: ["seo", "ads"] })), null, 1);
  const code = Array.from({ length: 30 }, (_, i) => `const value${i} = items.filter((x) => x.id !== ${i}).map((x) => ({ ...x, rank: x.rank * 2 }));`).join("\n");
  const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/blog/${i}/post?utm_source=tiktok&utm_campaign=q${i % 4}#h${i}`).join(" ");
  for (const body of [json, code, urls]) {
    const spans = chunkBody(body);
    assert.ok(spans.length > 1);
    assertSpans(body, spans);
  }
});

test("spaceless text, mixed prose and emoji are split without gaps or broken surrogate pairs", () => {
  const minified = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i, v: `x${i}` })));
  const base64 = Buffer.from(Array.from({ length: 3_000 }, (_, i) => (i * 2_654_435_761) % 256)).toString("base64");
  const cjk = "付费墙测试显示年度订阅的转化率更高。我们在抖音上投放广告，并优化了落地页。".repeat(20);
  const emoji = "🚀🔥💯🎉👉🙏✨😂".repeat(70);
  for (const body of [minified, `Intro sentence about paywalls. ${base64} And a closing sentence about landing pages.`, cjk, emoji]) {
    const spans = chunkBody(body);
    assert.ok(spans.length > 1, `${body.slice(0, 20)}…: ${spans.length} span(s)`);
    assertSpans(body, spans);
  }
});

test("context headers retain title, byline and kind without splitting Unicode", () => {
  const plain = embeddingHeader({ title: "Cloudflare case study", author: "Kevin", handle: "@kev", kind: "note" });
  for (const context of ["Cloudflare case study", "Kevin", "@kev", "note"]) assert.ok(plain.includes(context), context);
  assert.ok(!plain.includes("@@"));
  const title = "付费墙测试显示年度订阅的转化率更高我们在抖音上投放广告并优化了落地页".repeat(7);
  const author = "María José Fernández de la Cruz y Montenegro, Growth Lead at Example Corporation International ".repeat(2);
  const header = embeddingHeader({ title, author, handle: "mariajose_growth", kind: "article" });
  assert.ok(header.startsWith(title.slice(0, 20)), "long titles retain their opening");
  assert.ok(header.includes("María José Fernández"), "long bylines retain identifying context");
  assert.ok(header.includes("article"));
  assert.ok(header.length < title.length + author.length, "long context is bounded");
  const emoji = embeddingHeader({ title: "🚀".repeat(400), author: null, handle: null, kind: "note" });
  assert.ok(emoji.startsWith("🚀") && emoji.includes("note"));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji));
});
