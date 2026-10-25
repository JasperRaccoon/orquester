import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { loadMathResolver } from "./mermaid-engine.ts";

test("leaves invalid math labels unresolved and refuses links in labels", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  try {
    const resolver = await loadMathResolver();
    assert.ok(resolver);
    const valid = resolver("x^2", 16);
    assert.ok(valid && "html" in valid && valid.html.includes("<msup>"));
    assert.doesNotMatch(valid.html, /annotation/);
    assert.equal(resolver("\\frac{1}{", 16), null);
    const link = resolver("\\href{https://evil.example/}{x}", 16);
    assert.ok(!(link && "html" in link && /href=/.test(link.html)), JSON.stringify(link));
  } finally {
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
    else delete (globalThis as Record<string, unknown>).document;
    dom.window.close();
  }
});
