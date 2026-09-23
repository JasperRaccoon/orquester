/**
 * Codex adapter — pure-logic unit tests (spec §9 "Pure logic gets unit tests").
 *
 * The item classifier, the usage accumulator, the probe's shaping and the
 * event queue's drop rule.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ProviderSnapshot, RuntimeEvent } from "@orquester/api/agent-chat";

import { AsyncEventQueue } from "./event-queue.ts";
import { MAX_WORKSPACE_SNAPSHOTS, mergeSnapshot, resolveCodexHome } from "./index.ts";
import { classifyItem, isKnownCodexItemType, type CodexThreadItem } from "./items.ts";
import {
  CODEX_COMMAND_CATALOG_NOTE,
  CODEX_SLASH_COMMANDS,
  codexSlashCommands
} from "./probe.ts";
import { normaliseSkillMentions } from "./modes.ts";
import { CodexUsageTracker, usageWindowsFromRateLimits } from "./usage.ts";

describe("item classification — typed on the generated discriminants", () => {
  const cases: { item: CodexThreadItem; itemType: string; bypass: boolean }[] = [
    { item: { type: "userMessage", id: "i", clientId: null, content: [] }, itemType: "user_message", bypass: true },
    {
      item: { type: "agentMessage", id: "i", text: "t", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
      itemType: "assistant_message",
      bypass: true
    },
    { item: { type: "reasoning", id: "i", summary: [], content: [] }, itemType: "reasoning", bypass: true },
    { item: { type: "plan", id: "i", text: "p" }, itemType: "plan", bypass: true },
    {
      item: { type: "commandExecution", id: "i", pluginId: null, scriptPath: null, command: "ls", cwd: "/", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null },
      itemType: "command_execution",
      bypass: false
    },
    {
      item: { type: "fileChange", id: "i", changes: [{ path: "/a", kind: { type: "add" }, diff: "d" }], status: "completed" },
      itemType: "file_change",
      bypass: false
    },
    {
      item: { type: "mcpToolCall", id: "i", server: "s", tool: "t", status: "completed", arguments: {}, appContext: null, pluginId: null, readOnlyHint: true, result: null, error: null, durationMs: 1 },
      itemType: "mcp_tool_call",
      bypass: false
    },
    {
      item: { type: "dynamicToolCall", id: "i", namespace: null, tool: "t", arguments: {}, status: "completed", contentItems: null, success: true, durationMs: 1 },
      itemType: "dynamic_tool_call",
      bypass: false
    },
    {
      item: { type: "collabAgentToolCall", id: "i", tool: "spawnAgent", status: "inProgress", senderThreadId: "a", receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {} },
      itemType: "collab_agent_tool_call",
      bypass: false
    },
    { item: { type: "webSearch", id: "i", query: "q", action: null, results: null }, itemType: "web_search", bypass: false },
    { item: { type: "imageView", id: "i", path: "/a.png" }, itemType: "image_view", bypass: false },
    { item: { type: "enteredReviewMode", id: "i", review: "r" }, itemType: "review_entered", bypass: true },
    { item: { type: "exitedReviewMode", id: "i", review: "r" }, itemType: "review_exited", bypass: true },
    { item: { type: "contextCompaction", id: "i" }, itemType: "context_compaction", bypass: true },
    { item: { type: "subAgentActivity", id: "i", kind: "started", agentThreadId: "a", agentPath: "/root/marlow" }, itemType: "unknown", bypass: true },
    { item: { type: "hookPrompt", id: "i", fragments: [] }, itemType: "unknown", bypass: true },
    { item: { type: "sleep", id: "i", durationMs: 1000 }, itemType: "unknown", bypass: true }
  ];

  for (const testCase of cases) {
    it(`${testCase.item.type} → ${testCase.itemType}`, () => {
      const classified = classifyItem(testCase.item);
      assert.equal(classified.itemType, testCase.itemType);
      assert.equal(classified.timelineBypass, testCase.bypass);
      assert.equal(classified.unknownType, undefined);
    });
  }

  it("the two review types are classified and then never rendered", () => {
    for (const type of ["enteredReviewMode", "exitedReviewMode"] as const) {
      const classified = classifyItem({ type, id: "i", review: "r" });
      assert.ok(classified.timelineBypass, "classified, then dropped — nothing starts a review");
    }
  });

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

  it("a commentary agentMessage is reported with its phase so §7.3 can demote it", () => {
    const classified = classifyItem({
      type: "agentMessage",
      id: "i",
      text: "I'll do X next",
      phase: "commentary",
      memoryCitation: null,
      delivery: null,
      questions: null
    });
    // Ingestion reads the phase from `data.phase` (`assistantPhase`,
    // `ingestion/index.ts`); `detail` is its mirror, a marker only because
    // the two agree.
    assert.equal((classified.data as { phase?: unknown } | undefined)?.phase, "commentary");
    assert.equal(classified.detail, "commentary");
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

  it("a file change names its path, and names the extras when there are several", () => {
    assert.equal(
      classifyItem({
        type: "fileChange",
        id: "i",
        changes: [
          { path: "/a", kind: { type: "add" }, diff: "" },
          { path: "/b", kind: { type: "add" }, diff: "" }
        ],
        status: "completed"
      }).title,
      "/a +1 more"
    );
  });

  it("an item type from a newer protocol is reported, never silently mis-bucketed", () => {
    const classified = classifyItem({ type: "somethingNew", id: "i" } as unknown as CodexThreadItem);
    assert.equal(classified.itemType, "unknown");
    assert.equal(classified.unknownType, "somethingNew");
  });

  it("knows exactly the 19 types the bindings declare", () => {
    assert.equal(isKnownCodexItemType("commandExecution"), true);
    assert.equal(isKnownCodexItemType("somethingNew"), false);
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

describe("§4.6.2 / §4.6.3 the Codex command catalogue", () => {
  it("is exactly two entries — Codex has no command-catalog RPC", () => {
    assert.deepEqual(
      CODEX_SLASH_COMMANDS.map((command) => command.name),
      ["compact", "feedback"]
    );
  });

  it("names the gap so an empty list never reads as a failed probe", () => {
    assert.equal(CODEX_COMMAND_CATALOG_NOTE, "Codex reports no commands");
  });

  it("NEVER synthesises a provider /effort — it is client-only (§4.6.5(a))", () => {
    // R2 finding 2 / fix-wave arbitration: a provider `/effort` row put two
    // entries in the menu, and picking the provider one inserted the literal
    // `/effort ` and forwarded it to a CLI that does not implement it.
    const withReasoning = [
      {
        slug: "m",
        name: "M",
        capabilities: {
          optionDescriptors: [{ id: "effort", label: "Reasoning", type: "select" as const, options: [] }]
        }
      }
    ];
    for (const models of [[], [{ slug: "m", name: "M", capabilities: null }], withReasoning]) {
      assert.deepEqual(
        codexSlashCommands(models).map((c) => c.name),
        ["compact", "feedback"],
        "only /compact is synthesised by an adapter"
      );
    }
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

describe("§4.5 CODEX_HOME is tilde-expanded in the adapter", () => {
  it("expands ~ and ~/ because spawn does NOT shell-expand an env value", () => {
    // `CODEX_HOME=~/.codex_work` otherwise reaches codex verbatim and it errors
    // that the path does not exist.
    assert.equal(resolveCodexHome("~"), homedir());
    assert.equal(resolveCodexHome("~/.codex_work"), join(homedir(), ".codex_work"));
  });

  it("passes an absolute path verbatim and refuses a relative one", () => {
    assert.equal(resolveCodexHome("/var/lib/x/.codex"), "/var/lib/x/.codex");
    assert.equal(resolveCodexHome("relative/.codex"), null);
    assert.equal(resolveCodexHome(undefined), null);
    assert.equal(resolveCodexHome(""), null);
  });
});

describe("§4.6.4 snapshot merging", () => {
  const base = (overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot => ({
    id: "codex",
    refIds: ["codex"],
    installed: true,
    version: "0.154.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-21T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    capabilities: {
      sessionModelSwitch: "in-session",
      showPlanModeToggle: true,
      reportsContextWindow: true,
      compaction: { type: "native" }
    },
    ...overrides
  });

  it("a probe that comes back empty NEVER blanks a non-empty cached list", () => {
    const previous = base({
      models: [{ slug: "gpt-5.5", name: "GPT-5.5", capabilities: null }],
      skills: [{ name: "s", path: "/s", enabled: true }]
    });
    const merged = mergeSnapshot(previous, base(), []);
    assert.equal(merged.models.length, 1);
    assert.equal(merged.skills.length, 1);
  });

  it("keeps at most 16 cwd overlays, oldest evicted", () => {
    const probed: string[] = [];
    let snapshot: ProviderSnapshot | null = null;
    for (let index = 0; index < MAX_WORKSPACE_SNAPSHOTS + 4; index += 1) {
      snapshot = mergeSnapshot(
        snapshot,
        base({
          workspaceSnapshots: [
            {
              cwd: `/p/${index}`,
              checkedAt: "2026-09-21T00:00:00.000Z",
              slashCommands: [],
              skills: [{ name: `s${index}`, path: "/s", enabled: true }]
            }
          ]
        }),
        probed
      );
    }
    assert.equal(snapshot!.workspaceSnapshots?.length, MAX_WORKSPACE_SNAPSHOTS);
    assert.equal(snapshot!.workspaceSnapshots?.[0]?.cwd, "/p/4", "the four oldest were evicted");
  });

  it("re-probing a cwd refreshes it in place rather than duplicating it", () => {
    const probed: string[] = [];
    const overlay = (skill: string) =>
      base({
        workspaceSnapshots: [
          {
            cwd: "/p",
            checkedAt: "2026-09-21T00:00:00.000Z",
            slashCommands: [],
            skills: [{ name: skill, path: "/s", enabled: true }]
          }
        ]
      });
    const merged = mergeSnapshot(mergeSnapshot(null, overlay("a"), probed), overlay("b"), probed);
    assert.equal(merged.workspaceSnapshots?.length, 1);
    assert.equal(merged.workspaceSnapshots?.[0]?.skills[0]?.name, "b");
  });

  it("an empty overlay keeps the previous one for that cwd", () => {
    const probed: string[] = [];
    const first = mergeSnapshot(
      null,
      base({
        workspaceSnapshots: [
          {
            cwd: "/p",
            checkedAt: "x",
            slashCommands: [],
            skills: [{ name: "a", path: "/s", enabled: true }]
          }
        ]
      }),
      probed
    );
    const second = mergeSnapshot(
      first,
      base({ workspaceSnapshots: [{ cwd: "/p", checkedAt: "y", slashCommands: [], skills: [] }] }),
      probed
    );
    assert.equal(second.workspaceSnapshots?.[0]?.skills[0]?.name, "a");
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

  it("ignores a push after close", () => {
    const queue = new AsyncEventQueue<RuntimeEvent>();
    queue.close();
    queue.push(event("a"));
    assert.equal(queue.size, 0);
  });
});
