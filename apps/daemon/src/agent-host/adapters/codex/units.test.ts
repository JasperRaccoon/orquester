/**
 * Codex adapter — pure-logic unit tests (spec §9 "Pure logic gets unit tests").
 *
 * The item classifier, the usage accumulator, the probe's shaping and the
 * event queue's drop rule.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { ProviderSnapshot, RuntimeEvent } from "@orquester/api/agent-chat";

import { AsyncEventQueue } from "./event-queue.ts";
import { createCodexAdapter } from "./index.ts";
import { createFakeContext, writeMockCodexServer, type MockConfig } from "./testing.ts";
import { classifyItem, type CodexThreadItem } from "./items.ts";
import { normaliseSkillMentions } from "./modes.ts";
import { CodexUsageTracker, usageWindowsFromRateLimits } from "./usage.ts";

describe("item classification — typed on the generated discriminants", () => {
  const cases: { item: CodexThreadItem; itemType: string }[] = [
    {
      item: { type: "dynamicToolCall", id: "i", namespace: null, tool: "t", arguments: {}, status: "completed", contentItems: null, success: true, durationMs: 1 },
      itemType: "dynamic_tool_call"
    },
    {
      item: { type: "collabAgentToolCall", id: "i", tool: "spawnAgent", status: "inProgress", senderThreadId: "a", receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {} },
      itemType: "collab_agent_tool_call"
    },
    { item: { type: "webSearch", id: "i", query: "q", action: null, results: null }, itemType: "web_search" },
    { item: { type: "imageView", id: "i", path: "/a.png" }, itemType: "image_view" },
    { item: { type: "sleep", id: "i", durationMs: 1000 }, itemType: "unknown" }
  ];

  for (const testCase of cases) {
    it(`${testCase.item.type} → ${testCase.itemType}`, () => {
      const classified = classifyItem(testCase.item);
      assert.equal(classified.itemType, testCase.itemType);
      assert.equal(classified.unknownType, undefined);
    });
  }

  it("collabAgentToolCall's `interrupted` has no RuntimeItemStatus, so it settles failed", () => {
    const classified = classifyItem({
      type: "collabAgentToolCall",
      id: "i",
      tool: "spawnAgent",
      status: "interrupted",
      senderThreadId: "a",
      receiverThreadIds: [],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {}
    });
    assert.equal(classified.status, "failed");
  });

  it("the answer carries its phase the same way, and no phase means no marker", () => {
    const agentMessage = (phase: "final_answer" | null): CodexThreadItem => ({
      type: "agentMessage",
      id: "i",
      text: "It listens on port 8080.",
      phase,
      memoryCitation: null,
      delivery: null,
      questions: null
    });
    const answer = classifyItem(agentMessage("final_answer"));
    assert.equal((answer.data as { phase?: unknown } | undefined)?.phase, "final_answer");
    assert.equal(answer.detail, "final_answer");
    const unphased = classifyItem(agentMessage(null));
    assert.equal((unphased.data as { phase?: unknown } | undefined)?.phase, null);
    assert.equal(unphased.detail, undefined);
  });

  it("an item type from a newer protocol is reported, never silently mis-bucketed", () => {
    const classified = classifyItem({ type: "somethingNew", id: "i" } as unknown as CodexThreadItem);
    assert.equal(classified.itemType, "unknown");
    assert.equal(classified.unknownType, "somethingNew");
  });

});

describe("token usage — the delta is two reported totals, not a sum of `last`", () => {
  const usageNotification = (
    turnId: string,
    total: number,
    input: number,
    output: number,
    last?: { totalTokens: number; reasoningOutputTokens?: number }
  ) => ({
    threadId: "t",
    turnId,
    tokenUsage: {
      total: {
        totalTokens: total,
        inputTokens: input,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: 0
      },
      last: {
        totalTokens: last?.totalTokens ?? 1,
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: last?.reasoningOutputTokens ?? 0
      },
      modelContextWindow: 258_400
    }
  });

  it("measures the window against the LAST model call, not the thread total", () => {
    const usage = new CodexUsageTracker();
    // `total` is the whole thread's spend and grows without bound; the context
    // is what the most recent call actually carried, minus the reasoning it
    // emitted (which the server drops from the next request) — the same
    // arithmetic Codex's own TUI does.
    const snapshot = usage.observe(
      usageNotification("turn-1", 1_000_000, 900_000, 100_000, {
        totalTokens: 120_000,
        reasoningOutputTokens: 4_000
      })
    );
    assert.equal(snapshot.usedTokens, 116_000);
    assert.equal(snapshot.maxTokens, 258_400);
    assert.equal(snapshot.totalProcessedTokens, 1_000_000, "the thread total is the processed figure");
    assert.equal(snapshot.compactsAutomatically, true);
  });

  it("never reports a negative window and drops a processed total below the used one", () => {
    const usage = new CodexUsageTracker();
    const snapshot = usage.observe(
      usageNotification("turn-1", 500, 400, 100, { totalTokens: 500, reasoningOutputTokens: 900 })
    );
    assert.equal(snapshot.usedTokens, 0);
    assert.equal(snapshot.totalProcessedTokens, 500);

    const equal = usage.observe(
      usageNotification("turn-2", 500, 400, 100, { totalTokens: 500, reasoningOutputTokens: 0 })
    );
    assert.equal(equal.usedTokens, 500);
    assert.equal(
      equal.totalProcessedTokens,
      undefined,
      "a processed total that is not more than the used one says nothing"
    );
  });

  it("the turn delta is the last observed total minus the one at turn start", () => {
    const usage = new CodexUsageTracker();
    usage.beginTurn("turn-1");
    // Several notifications per turn — three to five in the real captures.
    usage.observe(usageNotification("turn-1", 500, 450, 50));
    usage.observe(usageNotification("turn-1", 900, 800, 100));
    const first = usage.completeTurn("turn-1");
    assert.equal(first.usageStatus, "complete");
    assert.equal(first.inputTokens, 800);
    assert.equal(first.outputTokens, 100);

    usage.beginTurn("turn-2");
    usage.observe(usageNotification("turn-2", 1500, 1300, 200));
    const second = usage.completeTurn("turn-2");
    assert.equal(second.usageStatus, "complete");
    assert.equal(second.inputTokens, 500, "the second turn does not re-count the first");
    assert.equal(second.outputTokens, 100);
  });

  it("a turn with no observation settles unavailable", () => {
    const usage = new CodexUsageTracker();
    usage.beginTurn("turn-1");
    const settled = usage.completeTurn("turn-1");
    assert.equal(settled.usageStatus, "unavailable");
    assert.equal(settled.hasSubagents, false);
  });

  it("an interrupted turn settles partial", () => {
    const usage = new CodexUsageTracker();
    usage.beginTurn("turn-1");
    usage.observe(usageNotification("turn-1", 100, 90, 10));
    assert.equal(usage.completeTurn("turn-1", { interrupted: true }).usageStatus, "partial");
  });

  it("clamps the cache subsets into inputTokens and reasoning into outputTokens", () => {
    const usage = new CodexUsageTracker();
    usage.beginTurn("turn-1");
    usage.observe({
      threadId: "t",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 120,
          inputTokens: 10,
          cachedInputTokens: 500,
          cacheWriteInputTokens: 500,
          outputTokens: 5,
          reasoningOutputTokens: 900
        },
        last: {
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0
        },
        modelContextWindow: null
      }
    });
    const settled = usage.completeTurn("turn-1");
    assert.equal(settled.cachedInputTokens, 10);
    assert.equal(settled.cacheCreationTokens, 10);
    assert.equal(settled.reasoningTokens, 5);
  });

  it("a usage row for a turn that was never begun does not attribute the whole thread to it", () => {
    const usage = new CodexUsageTracker();
    usage.observe(usageNotification("earlier", 5000, 4500, 500));
    // A compaction turn the server started on its own, so `beginTurn` never
    // ran for it. The baseline is the thread total as it stood a moment
    // before — NOT zero, which would charge this turn the whole thread
    // (Q1 finding 18; the previous assertion locked that bug in).
    usage.observe(usageNotification("compaction", 5500, 4500, 1000));
    const settled = usage.completeTurn("compaction");
    assert.equal(settled.usageStatus, "complete");
    assert.equal(settled.inputTokens, 0, "the 4500 input tokens were the EARLIER turn's");
    assert.equal(settled.outputTokens, 500, "only the 500 this turn added");
  });

  it("falls back to `total - last` when a turn is the very first observation", () => {
    // A resume that missed `turn/started`: no previous observation exists, so
    // the server's own per-call delta is the only honest baseline.
    const usage = new CodexUsageTracker();
    usage.observe({
      threadId: "t",
      turnId: "resumed",
      tokenUsage: {
        total: {
          totalTokens: 5000,
          inputTokens: 4000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1000,
          reasoningOutputTokens: 0
        },
        last: {
          totalTokens: 300,
          inputTokens: 200,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 100,
          reasoningOutputTokens: 0
        },
        modelContextWindow: 258_400
      }
    });
    const settled = usage.completeTurn("resumed");
    assert.equal(settled.inputTokens, 200, "this model call's input, not the thread's 4000");
    assert.equal(settled.outputTokens, 100);
  });

  it("never reports a negative count when the provider resets after a compaction", () => {
    const usage = new CodexUsageTracker();
    usage.beginTurn("turn-1");
    usage.observe(usageNotification("turn-1", 5000, 4500, 500));
    usage.beginTurn("turn-2");
    usage.observe(usageNotification("turn-2", 100, 90, 10));
    const settled = usage.completeTurn("turn-2");
    assert.equal(settled.inputTokens, 0);
    assert.equal(settled.outputTokens, 0);
  });
});

describe("rate limits", () => {
  const snapshot = (primaryMins: number | null, secondary = false) => ({
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 30, windowDurationMins: primaryMins, resetsAt: 1_790_220_221 },
    secondary: secondary
      ? { usedPercent: 12, windowDurationMins: 300, resetsAt: null }
      : null,
    credits: null,
    individualLimit: null,
    spendControlReached: false,
    planType: "pro" as const,
    rateLimitReachedType: null
  });

  it("gives every window a stable id derived from limitId so a sparse update merges", () => {
    const windows = usageWindowsFromRateLimits(snapshot(10_080, true));
    assert.deepEqual(
      windows.map((window) => window.id),
      ["codex:primary", "codex:secondary"]
    );
  });

  it("classifies 10080 minutes as weekly and 300 as a session window", () => {
    const windows = usageWindowsFromRateLimits(snapshot(10_080, true));
    assert.equal(windows[0]!.kind, "weekly");
    assert.equal(windows[1]!.kind, "session");
    assert.equal(windows[1]!.label, "5h limit");
  });

  it("converts the epoch-second reset into an ISO stamp, and omits an absent one", () => {
    const windows = usageWindowsFromRateLimits(snapshot(10_080, true));
    assert.equal(windows[0]!.resetsAt, new Date(1_790_220_221 * 1000).toISOString());
    assert.equal(windows[1]!.resetsAt, undefined);
  });

  it("falls back to `codex` when limitId is null", () => {
    const windows = usageWindowsFromRateLimits({ ...snapshot(10_080), limitId: null });
    assert.equal(windows[0]!.id, "codex:primary");
  });

  it("clamps a percentage outside 0–100", () => {
    const windows = usageWindowsFromRateLimits({
      ...snapshot(10_080),
      primary: { usedPercent: 140, windowDurationMins: 10_080, resetsAt: null }
    });
    assert.equal(windows[0]!.usedPercent, 100);
  });
});

describe("§4.6.8 skill mentions are normalised to `$name`", () => {
  it("rewrites any currency symbol, because that is where $ sits on other layouts", () => {
    assert.equal(normaliseSkillMentions("run €review please"), "run $review please");
    assert.equal(normaliseSkillMentions("£deep-dive"), "$deep-dive");
    assert.equal(normaliseSkillMentions("¥a:b_c"), "$a:b_c");
  });

  it("leaves a currency AMOUNT as prose", () => {
    for (const text of ["it costs €50", "about $1.5k", "£20", "¥300", "$4e5"]) {
      assert.equal(normaliseSkillMentions(text), text);
    }
  });

  it("leaves an already-correct mention and a mid-token symbol alone", () => {
    assert.equal(normaliseSkillMentions("$review"), "$review");
    assert.equal(normaliseSkillMentions("a€b"), "a€b");
  });

  it("does not touch a slash command, which must stay the first character", () => {
    assert.equal(normaliseSkillMentions("/compact"), "/compact");
    assert.equal(normaliseSkillMentions("/feedback it is broken"), "/feedback it is broken");
  });
});

function adapterRig(t: TestContext) {
  const server = writeMockCodexServer({});
  const extraDirs: string[] = [];
  const fake = createFakeContext({
    resolveBin: () => Promise.resolve(server.bin),
    buildEnv: ({ home }) => ({ PATH: process.env.PATH ?? "", HOME: homedir(), CODEX_HOME: home.path })
  });
  const adapter = createCodexAdapter(fake.context);
  t.after(async () => {
    await (await adapter).stopAll();
    for (const dir of [server.dir, ...extraDirs]) rmSync(dir, { recursive: true, force: true });
  });
  return {
    adapter, rawFrames: fake.rawFrames, dir: server.dir,
    nextProbe(config: Omit<MockConfig, "logPath">) {
      const replacement = writeMockCodexServer(config);
      extraDirs.push(replacement.dir);
      writeFileSync(server.bin, readFileSync(replacement.bin));
    }
  };
}

describe("§4.5 CODEX_HOME reaches the provider as an absolute path", () => {
  it("expands tilde homes and preserves an absolute account home on session start", async (t) => {
    const r = adapterRig(t);
    const adapter = await r.adapter;
    await adapter.refreshSnapshot({ cwd: process.cwd() });
    for (const [path, expected] of [["~", homedir()], ["~/.codex_work", join(homedir(), ".codex_work")], ["/var/lib/x/.codex", "/var/lib/x/.codex"]]) {
      await adapter.startSession({
        threadId: "home-test", cwd: process.cwd(), home: { kind: "system", path },
        modelSelection: { model: "gpt-5.5" }, runtimeMode: "approval-required"
      });
      const initialized = r.rawFrames.map(({ frame }) =>
        (frame as { frame?: { result?: { codexHome?: string } } }).frame?.result
      ).filter((result) => result?.codexHome !== undefined).at(-1);
      assert.equal(initialized?.codexHome, expected);
    }
  });
});

describe("§4.6.4 public provider snapshots", () => {
  it("an empty probe preserves the cached model and skills, including its cwd overlay", async (t) => {
    const r = adapterRig(t);
    const adapter = await r.adapter;
    const cwd = process.cwd();
    await adapter.refreshSnapshot({ cwd });
    r.nextProbe({ emptyCatalog: true });
    const snapshot = await adapter.refreshSnapshot({ cwd });
    assert.deepEqual(snapshot.models.map((model) => model.slug), ["gpt-5.5"]);
    assert.deepEqual(snapshot.skills.map((skill) => skill.name), ["demo"]);
    assert.deepEqual(snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.skills.map((skill) => skill.name), ["demo"]);
  });

  it("re-probing a cwd replaces its skills without duplicating its overlay", async (t) => {
    const r = adapterRig(t);
    const adapter = await r.adapter;
    const cwd = process.cwd();
    await adapter.refreshSnapshot({ cwd });
    r.nextProbe({ skillName: "updated" });
    const snapshot = await adapter.refreshSnapshot({ cwd });
    assert.deepEqual(snapshot.workspaceSnapshots?.map((entry) => [entry.cwd, entry.skills.map((skill) => skill.name)]), [[cwd, ["updated"]]]);
  });

  it("retains the most recent 16 cwd overlays and evicts the oldest", async (t) => {
    const r = adapterRig(t);
    const adapter = await r.adapter;
    let snapshot: ProviderSnapshot | undefined;
    for (let index = 0; index < 20; index += 1) {
      const cwd = join(r.dir, String(index));
      mkdirSync(cwd);
      snapshot = await adapter.refreshSnapshot({ cwd });
    }
    assert.deepEqual(snapshot?.workspaceSnapshots?.map((entry) => entry.cwd),
      Array.from({ length: 16 }, (_, index) => join(r.dir, String(index + 4))));
  });
});

describe("the adapter event queue", () => {
  const event = (id: string): RuntimeEvent =>
    ({
      type: "runtime.warning",
      eventId: id,
      threadId: "t",
      createdAt: "x",
      payload: { message: id }
    }) as RuntimeEvent;

  it("delivers buffered values in order, then live ones", async () => {
    const queue = new AsyncEventQueue<RuntimeEvent>();
    queue.push(event("a"));
    queue.push(event("b"));
    const iterator = queue[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.eventId, "a");
    assert.equal((await iterator.next()).value?.eventId, "b");
    const pending = iterator.next();
    queue.push(event("c"));
    assert.equal((await pending).value?.eventId, "c");
    queue.close();
  });

  it("drops the OLDEST past the cap and reports it", async () => {
    let dropped = 0;
    const queue = new AsyncEventQueue<RuntimeEvent>({
      maxBuffered: 2,
      onDrop: (count) => {
        dropped += count;
      }
    });
    queue.push(event("a"));
    queue.push(event("b"));
    queue.push(event("c"));
    assert.equal(dropped, 1);
    const iterator = queue[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.eventId, "b", "the newest events survive");
    queue.close();
  });

  it("close releases a parked consumer and is idempotent", async () => {
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.close();
    queue.close();
    assert.equal((await pending).done, true);
    assert.equal((await iterator.next()).done, true);
  });

  it("ignores a push after close", async () => {
    const queue = new AsyncEventQueue<RuntimeEvent>();
    queue.close();
    queue.push(event("a"));
    assert.deepEqual(await queue[Symbol.asyncIterator]().next(), { value: undefined, done: true });
  });
});
