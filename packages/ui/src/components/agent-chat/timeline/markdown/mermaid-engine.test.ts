import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import {
  detectDiagramType,
  loadedMathResolver,
  loadedPele,
  loadMathResolver,
  loadPele,
  setPeleLoader,
  type PeleEngine
} from "./mermaid-engine.ts";

const fake = (overrides: Partial<PeleEngine> = {}): PeleEngine => ({
  detectType: () => "flowchart",
  registered: () => false,
  load: () => Promise.resolve(true),
  mount: () => {
    throw new Error("not mounted in this test");
  },
  ...overrides
});

describe("loading pele", () => {
  afterEach(() => setPeleLoader(null));

  it("loads the core once, however many diagrams ask", async () => {
    let calls = 0;
    const engine = fake();
    setPeleLoader(() => {
      calls += 1;
      return Promise.resolve(engine);
    });
    assert.equal(loadedPele(), null);
    const [a, b] = await Promise.all([loadPele(), loadPele()]);
    assert.equal(a, engine);
    assert.equal(b, engine);
    assert.equal(await loadPele(), engine);
    assert.equal(loadedPele(), engine);
    assert.equal(calls, 1);
  });

  it("forgets a failed load, so the next diagram (or Retry) tries again", async () => {
    let calls = 0;
    const engine = fake();
    setPeleLoader(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("Failed to fetch")) : Promise.resolve(engine);
    });
    await assert.rejects(loadPele(), /Failed to fetch/);
    assert.equal(loadedPele(), null);
    assert.equal(await loadPele(), engine);
    assert.equal(calls, 2);
  });

  it("loads the real pele/lazy, which detects and loads types on demand", async () => {
    const pele = await loadPele();
    assert.equal(detectDiagramType(pele, "sequenceDiagram\n  A->>B: hi"), "sequence");
    assert.equal(detectDiagramType(pele, "graph TD\n  A-->B"), "flowchart");
    assert.equal(detectDiagramType(pele, "zenuml\n  A->B: hi"), null, "a type Mermaid only has as a plugin");
    assert.equal(await pele.load("pie"), true);
    assert.equal(pele.registered("pie"), true);
  });

  it("reads a detector that throws as an unknown type", () => {
    const pele = fake({
      detectType: () => {
        throw new Error("bad front matter");
      }
    });
    assert.equal(detectDiagramType(pele, "---\n: :\n---"), null);
  });
});

describe("the KaTeX resolver for $$ labels", () => {
  let dom: JSDOM;
  let savedDocument: PropertyDescriptor | undefined;

  before(() => {
    dom = new JSDOM("<!doctype html><body></body>");
    savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true, writable: true });
  });

  after(() => {
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
    else delete (globalThis as Record<string, unknown>).document;
  });

  it("typesets a label as MathML, without the annotation that repeats its TeX", async () => {
    const resolver = await loadMathResolver();
    assert.ok(resolver);
    assert.equal(loadedMathResolver(), resolver);
    const markup = resolver("\\frac{a}{b}", 16);
    assert.ok(markup && "html" in markup, JSON.stringify(markup));
    assert.ok(markup.html.startsWith("<math"), markup.html);
    assert.ok(markup.html.includes("<mfrac>"), markup.html);
    assert.ok(!markup.html.includes("annotation"), markup.html);
  });

  it("answers a repeated label from its cache, and a label KaTeX cannot parse with null", async () => {
    const resolver = await loadMathResolver();
    assert.ok(resolver);
    assert.equal(resolver("x^2", 16), resolver("x^2", 16));
    assert.equal(resolver("\\frac{1}{", 16), null);
    // trust: false: a link command is not a link.
    const link = resolver("\\href{https://evil.example/}{x}", 16);
    assert.ok(!(link && "html" in link && /href=/.test(link.html)), JSON.stringify(link));
  });
});
