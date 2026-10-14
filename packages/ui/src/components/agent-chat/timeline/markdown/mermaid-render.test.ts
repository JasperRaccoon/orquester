import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMermaidRenderer,
  isMermaidFence,
  mermaidConfig,
  mermaidRenderKey,
  type MermaidEngine,
  type MermaidRendererDeps,
  type MermaidRenderResult
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

  /** What `Suspense` does: read, wait on a thrown promise, read again. */
  async function readLikeSuspense(
    queue: ReturnType<typeof renderer>,
    source: string,
    theme: "light" | "dark" = "dark"
  ): Promise<{ result: MermaidRenderResult; attempts: number }> {
    for (let attempts = 1; attempts <= 20; attempts += 1) {
      try {
        return { result: queue.read(source, theme), attempts };
      } catch (thrown) {
        await thrown;
      }
    }
    throw new Error(`"${source}" never resolved: the cache keeps discarding its result`);
  }

  const instantEngine = (log: string[] = []): MermaidEngine => ({
    initialize() {},
    render(_id, source) {
      log.push(source);
      return Promise.resolve({ svg: `<svg>${source}</svg>` });
    }
  });

  it("lets every reader finish when there are more simultaneous readers than the cap", async () => {
    const log: string[] = [];
    const queue = renderer(instantEngine(log), { maxCached: 2 });
    const sources = ["A", "B", "C", "D", "E"];
    const outcomes = await Promise.all(sources.map((source) => readLikeSuspense(queue, source)));
    for (const [index, outcome] of outcomes.entries()) {
      assert.deepEqual(outcome.result, { status: "rendered", svg: `clean(<svg>${sources[index]}</svg>)` });
      assert.equal(outcome.attempts, 2, "one suspend, one read");
    }
    // Each diagram was rendered exactly once: nothing was thrown away unread.
    assert.deepEqual(log.slice().sort(), sources);
  });

  it("keeps readers finishing when a new diagram is admitted while others are catching up", async () => {
    const log: string[] = [];
    const queue = renderer(instantEngine(log), { maxCached: 2 });
    const first = ["A", "B", "C"].map((source) => readLikeSuspense(queue, source));
    // Admitted while A, B and C are settled-but-unread or pending.
    const late = readLikeSuspense(queue, "D");
    const outcomes = await Promise.all([...first, late]);
    assert.ok(outcomes.every((outcome) => outcome.result.status === "rendered"));
    assert.deepEqual(log.slice().sort(), ["A", "B", "C", "D"]);
  });

  it("trims settled entries that were read once the next diagram is admitted", async () => {
    const queue = renderer(instantEngine(), { maxCached: 2 });
    for (const source of ["A", "B", "C"]) await readLikeSuspense(queue, source);
    // Over the cap while no one was admitting; nothing was thrown away.
    assert.equal(queue.size, 3);
    await readLikeSuspense(queue, "D");
    // D's admission trimmed the read, settled entries down to the cap.
    assert.equal(queue.size, 3, "two settled (the newest) plus D");
  });

  it("never evicts a pending render", async () => {
    const { engine, pending } = controlledEngine();
    const queue = renderer(engine, { maxCached: 1 });
    const first = queue.start("A", "dark");
    const second = queue.start("B", "dark");
    const third = queue.start("C", "dark");
    assert.equal(queue.size, 3);
    assert.equal(queue.start("A", "dark"), first);
    assert.equal(queue.start("B", "dark"), second);
    assert.equal(queue.start("C", "dark"), third);
    await tick();
    assert.equal(pending.length, 1);
  });

  it("promotes a hit so the entry read most recently survives the trim", async () => {
    const queue = renderer(instantEngine(), { maxCached: 2 });
    const a = queue.start("A", "dark");
    const b = queue.start("B", "dark");
    await readLikeSuspense(queue, "A");
    await readLikeSuspense(queue, "B");
    queue.read("A", "dark"); // touch A: B is now the oldest
    await readLikeSuspense(queue, "C");
    await readLikeSuspense(queue, "D"); // admission trims settled entries to two
    assert.equal(queue.start("A", "dark"), a, "A (touched) survived");
    assert.notEqual(queue.start("B", "dark"), b, "B was the least recently used");
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
