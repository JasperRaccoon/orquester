import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMermaidRenderer,
  isMermaidFence,
  mermaidConfig,
  mermaidRenderKey,
  type MermaidEngine,
  type MermaidRendererDeps
} from "./mermaid-render.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An engine whose renders finish only when the test says so. */
function controlledEngine() {
  const log: string[] = [];
  const pending: Array<{ source: string; theme: unknown; gate: Deferred<{ svg: string }> }> = [];
  let activeRenders = 0;
  let maxActive = 0;
  let currentTheme: unknown;
  const engine: MermaidEngine = {
    initialize(config) {
      currentTheme = config.theme;
      log.push(`init:${String(config.theme)}`);
    },
    async render(_id, source) {
      activeRenders += 1;
      maxActive = Math.max(maxActive, activeRenders);
      log.push(`render:${source}`);
      const gate = deferred<{ svg: string }>();
      pending.push({ source, theme: currentTheme, gate });
      try {
        return await gate.promise;
      } finally {
        activeRenders -= 1;
      }
    }
  };
  return { engine, log, pending, maxActive: () => maxActive };
}

function renderer(engine: MermaidEngine, overrides: Partial<MermaidRendererDeps> = {}) {
  return createMermaidRenderer({
    loadMermaid: () => Promise.resolve(engine),
    sanitize: (svg) => `clean(${svg})`,
    fontFamily: () => "Inter",
    ...overrides
  });
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("fence detection", () => {
  it("recognises the mermaid language regardless of case", () => {
    assert.equal(isMermaidFence("mermaid"), true);
    assert.equal(isMermaidFence("Mermaid"), true);
    assert.equal(isMermaidFence("mermaid-js"), false);
    assert.equal(isMermaidFence("text"), false);
    assert.equal(isMermaidFence(""), false);
  });
});

describe("render key", () => {
  it("separates themes and ignores surrounding whitespace only", () => {
    assert.notEqual(mermaidRenderKey("graph TD", "dark"), mermaidRenderKey("graph TD", "light"));
    assert.equal(mermaidRenderKey("  graph TD\n", "dark"), mermaidRenderKey("graph TD", "dark"));
    assert.notEqual(mermaidRenderKey("graph TD\nA-->B", "dark"), mermaidRenderKey("graph TD\nA-->C", "dark"));
  });
});

describe("hardened configuration", () => {
  it("is strict, label-free of HTML, and locks the directives that would undo it", () => {
    const config = mermaidConfig("dark", "Inter");
    assert.equal(config.securityLevel, "strict");
    assert.equal(config.htmlLabels, false);
    assert.deepEqual(config.flowchart, { htmlLabels: false });
    assert.equal(config.startOnLoad, false);
    assert.equal(config.theme, "dark");
    assert.equal(config.fontFamily, "Inter");
    for (const key of ["securityLevel", "htmlLabels", "themeCSS", "secure", "maxTextSize"]) {
      assert.ok((config.secure as string[]).includes(key), `${key} is locked`);
    }
    assert.equal(mermaidConfig("light", "x").theme, "default");
  });
});

describe("render queue", () => {
  it("renders one diagram at a time, each under its own theme configuration", async () => {
    const { engine, log, pending, maxActive } = controlledEngine();
    const queue = renderer(engine);
    const first = queue.start("graph A", "dark");
    const second = queue.start("graph B", "light");
    await tick();
    // Only the first is in the engine; the second has not even initialised.
    assert.deepEqual(log, ["init:dark", "render:graph A"]);
    pending[0]!.gate.resolve({ svg: "<svg>A</svg>" });
    assert.deepEqual(await first, { status: "rendered", svg: "clean(<svg>A</svg>)" });
    await tick();
    assert.deepEqual(log, ["init:dark", "render:graph A", "init:default", "render:graph B"]);
    pending[1]!.gate.resolve({ svg: "<svg>B</svg>" });
    await second;
    assert.equal(maxActive(), 1);
  });

  it("keeps draining after a render fails", async () => {
    const { engine, pending } = controlledEngine();
    const queue = renderer(engine);
    const bad = queue.start("not a diagram", "dark");
    const good = queue.start("graph ok", "dark");
    await tick();
    pending[0]!.gate.reject(new Error("Parse error on line 1"));
    assert.deepEqual(await bad, { status: "error", message: "Parse error on line 1", retryable: false });
    await tick();
    pending[1]!.gate.resolve({ svg: "<svg/>" });
    assert.equal((await good).status, "rendered");
  });
});

describe("cache", () => {
  it("renders a diagram once per theme and source", async () => {
    const { engine, log, pending } = controlledEngine();
    const queue = renderer(engine);
    const a = queue.start("graph A", "dark");
    const again = queue.start("  graph A\n", "dark");
    assert.equal(a, again);
    await tick();
    pending[0]!.gate.resolve({ svg: "<svg/>" });
    await a;
    assert.equal(log.filter((entry) => entry.startsWith("render:")).length, 1);
    queue.start("graph A", "light");
    await tick();
    assert.equal(log.filter((entry) => entry.startsWith("render:")).length, 2);
  });

  it("evicts the least recently used settled entry past the limit, never a pending one", async () => {
    const { engine, pending } = controlledEngine();
    const queue = renderer(engine, { maxCached: 2 });
    const a = queue.start("A", "dark");
    const b = queue.start("B", "dark");
    queue.start("C", "dark");
    // Nothing has settled, so nothing may be evicted yet.
    assert.equal(queue.size, 3);
    await tick();
    pending[0]!.gate.resolve({ svg: "a" });
    await a;
    // A settled and the cache is over its limit: A (oldest settled) goes.
    assert.equal(queue.size, 2);
    assert.notEqual(queue.start("A", "dark"), a, "A was evicted, so it renders again");
    // B and C are still pending and were never candidates.
    assert.equal(queue.start("B", "dark"), b);
  });

  it("promotes a hit so the entry used most recently survives", async () => {
    const { engine, pending } = controlledEngine();
    const queue = renderer(engine, { maxCached: 2 });
    const first = queue.start("A", "dark");
    await tick();
    pending[0]!.gate.resolve({ svg: "a" });
    await first;
    const second = queue.start("B", "dark");
    await tick();
    pending[1]!.gate.resolve({ svg: "b" });
    await second;
    assert.equal(queue.start("A", "dark"), first); // touch A
    const third = queue.start("C", "dark");
    await tick();
    pending[2]!.gate.resolve({ svg: "c" });
    await third;
    assert.equal(queue.size, 2);
    assert.equal(queue.start("A", "dark"), first, "A survived");
    assert.notEqual(queue.start("B", "dark"), second, "B was the least recently used");
  });

  it("invalidate makes the next read render again", async () => {
    const { engine, pending } = controlledEngine();
    const queue = renderer(engine);
    const first = queue.start("A", "dark");
    await tick();
    pending[0]!.gate.resolve({ svg: "a" });
    await first;
    queue.invalidate("A", "dark");
    assert.notEqual(queue.start("A", "dark"), first);
  });
});

describe("read (Suspense protocol)", () => {
  it("throws the pending promise, then returns the settled result", async () => {
    const { engine, pending } = controlledEngine();
    const queue = renderer(engine);
    let thrown: unknown;
    try {
      queue.read("A", "dark");
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Promise);
    await tick();
    pending[0]!.gate.resolve({ svg: "<svg/>" });
    await thrown;
    assert.deepEqual(queue.read("A", "dark"), { status: "rendered", svg: "clean(<svg/>)" });
  });
});

describe("failures", () => {
  it("reports a load failure as retryable", async () => {
    const queue = createMermaidRenderer({
      loadMermaid: () => Promise.reject(new Error("offline")),
      sanitize: (svg) => svg,
      fontFamily: () => ""
    });
    assert.deepEqual(await queue.start("A", "dark"), {
      status: "error",
      message: "Mermaid failed to load.",
      retryable: true
    });
  });

  it("treats a lost diagram chunk as retryable and a syntax error as final", async () => {
    const outcomes = [
      new Error("Failed to fetch dynamically imported module: /assets/flowDiagram.js"),
      new Error("Parse error on line 2")
    ];
    const queue = renderer({
      initialize() {},
      render: () => Promise.reject(outcomes.shift())
    });
    const chunk = await queue.start("A", "dark");
    const syntax = await queue.start("B", "dark");
    assert.equal(chunk.status === "error" && chunk.retryable, true);
    assert.equal(syntax.status === "error" && syntax.retryable, false);
  });

  it("cleans up the scratch node whether the render succeeded or threw", async () => {
    const cleaned: string[] = [];
    const queue = renderer(
      {
        initialize() {},
        render: (_id, source) => (source === "bad" ? Promise.reject(new Error("x")) : Promise.resolve({ svg: "s" }))
      },
      { cleanup: (id) => cleaned.push(id) }
    );
    await queue.start("good", "dark");
    await queue.start("bad", "dark");
    assert.equal(cleaned.length, 2);
    assert.notEqual(cleaned[0], cleaned[1]);
  });

  it("runs the sanitiser over every rendered SVG before returning it", async () => {
    const queue = renderer(
      { initialize() {}, render: () => Promise.resolve({ svg: "<svg><script>alert(1)</script></svg>" }) },
      { sanitize: () => "<svg/>" }
    );
    assert.deepEqual(await queue.start("A", "dark"), { status: "rendered", svg: "<svg/>" });
  });
});
