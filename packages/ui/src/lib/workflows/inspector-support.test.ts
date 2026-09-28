import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentAccount, UsageResponse, WorkflowBlockRun } from "@orquester/api";

import { blockInputOf, parsePinnedText } from "./inspector-data.ts";
import { clampInspectorWidth, DEFAULT_EDITOR_LAYOUT, parseEditorLayout } from "./inspector-layout.ts";
import { accountFamily, accountUsageRows, formatResetIn, scopedWindowLabels } from "./inspector-usage.ts";
import { edge, node, workflow } from "./testing.ts";

const NOW = Date.parse("2026-09-28T10:00:00.000Z");
const account = (id: string, agent: AgentAccount["agent"], extra: Partial<AgentAccount> = {}): AgentAccount => ({
  id,
  agent,
  label: id,
  email: null,
  plan: null,
  needsReauth: false,
  createdAt: "",
  importedAt: "",
  ...extra
});

const usage: UsageResponse = {
  agents: [
    {
      id: "claude",
      available: true,
      stale: false,
      session: { percent: 40 },
      weekly: { percent: 70 },
      accounts: [
        {
          id: "jasper",
          available: true,
          stale: false,
          session: { percent: 12, resetsAt: "2026-09-28T12:30:00.000Z" },
          weekly: { percent: 63, resetsAt: "2026-10-02T12:00:00.000Z" },
          scopedWindows: [{ label: "Fable", percent: 30 }]
        },
        { id: "eduard", available: true, stale: false, session: null, weekly: { percent: 90, resetsAt: "2026-09-27T00:00:00.000Z" } }
      ],
      system: { id: "system", available: true, stale: true, session: { percent: 5 }, weekly: null }
    }
  ]
};

describe("account usage rows", () => {
  it("joins managed accounts to their windows by id; an expired window says nothing", () => {
    const rows = accountUsageRows({
      family: "claude",
      accounts: [account("jasper", "claude"), account("eduard", "claude", { needsReauth: true }), account("x", "codex")],
      usage,
      includeSystem: true,
      now: NOW
    });
    assert.deepEqual(rows.map((row) => row.id), ["jasper", "eduard", "system"]);
    assert.equal(rows[0]!.weekly?.percent, 63);
    assert.deepEqual(rows[0]!.scoped.map((bar) => bar.label), ["Fable"]);
    assert.equal(rows[1]!.weekly, null, "its weekly window reset already");
    assert.equal(rows[1]!.unknown, true);
    assert.equal(rows[1]!.needsReauth, true);
    assert.equal(rows[2]!.isSystem, true);
    assert.equal(rows[2]!.unknown, true, "a stale reading is unknown");
  });

  it("families: an agent's own; OpenCode and agents this build does not offer have none", () => {
    assert.equal(accountFamily("claude"), "claude");
    assert.equal(accountFamily("codex"), "codex");
    assert.equal(accountFamily("grok"), "grok");
    assert.equal(accountFamily("opencode"), null);
    assert.equal(accountFamily("claudex"), null, "a removed launcher a stored chain may still name");
    assert.deepEqual(scopedWindowLabels(usage, "claude"), ["Fable"]);
  });

  it("reset countdowns", () => {
    assert.equal(formatResetIn("2026-09-28T12:30:00.000Z", NOW), "2h 30m");
    assert.equal(formatResetIn("2026-10-02T12:00:00.000Z", NOW), "4d 2h");
    assert.equal(formatResetIn("2026-09-28T09:00:00.000Z", NOW), "now");
    assert.equal(formatResetIn(undefined, NOW), "");
  });
});

describe("the editor layout in localStorage", () => {
  it("reads field by field, clamping the inspector width, and falls back on anything unreadable", () => {
    assert.deepEqual(parseEditorLayout('{"inspectorWidth": 900, "paletteOpen": false, "minimap": "yes"}'), {
      inspectorWidth: 640,
      paletteOpen: false,
      minimap: true
    });
    assert.deepEqual(parseEditorLayout("not json"), DEFAULT_EDITOR_LAYOUT);
    assert.deepEqual(parseEditorLayout(null), DEFAULT_EDITOR_LAYOUT);
    assert.deepEqual(parseEditorLayout([1, 2]), DEFAULT_EDITOR_LAYOUT);
    assert.equal(clampInspectorWidth(100), 320);
    assert.equal(clampInspectorWidth(Number.NaN), 380);
  });
});

describe("the Data tab", () => {
  const def = workflow(
    [node("t", "trigger.manual", {}, { name: "Start" }), node("a", "agent", {}, { name: "A" }), node("b", "code", {}, { name: "B" }), node("m", "merge", {}, { name: "M" })],
    [edge("t", "a"), edge("a", "m"), edge("b", "m"), edge("t", "b")]
  );
  const run = (nodeId: string, status: WorkflowBlockRun["status"], output: unknown): WorkflowBlockRun => ({ nodeId, name: nodeId, type: "code", status, attempt: 1, output });

  it("a block's input is its one live upstream's output, or the merge object", () => {
    const blocks = { t: run("t", "succeeded", { kind: "manual" }), a: run("a", "succeeded", { text: "hi" }), b: run("b", "succeeded", 2) };
    assert.deepEqual(blockInputOf(blocks, def, "a"), { kind: "single", from: "Start", value: { kind: "manual" } });
    assert.deepEqual(blockInputOf(blocks, def, "m"), { kind: "merged", value: { A: { text: "hi" }, B: 2 } });
    assert.deepEqual(blockInputOf({ ...blocks, b: run("b", "skipped", undefined) }, def, "m"), { kind: "single", from: "A", value: { text: "hi" } });
    assert.deepEqual(blockInputOf(blocks, def, "t"), { kind: "none" });
  });

  it("a pinned output is JSON, or an error that says why", () => {
    assert.deepEqual(parsePinnedText('{"a": 1}'), { ok: true, value: { a: 1 } });
    assert.equal(parsePinnedText("{a:").ok, false);
    assert.equal(parsePinnedText("  ").ok, false);
  });
});
