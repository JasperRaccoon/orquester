import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentAccount, UsageResponse } from "@orquester/api";

import { loadEditorLayout } from "./inspector-layout.ts";
import { accountUsageRows } from "./inspector-usage.ts";

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
});

describe("the editor layout in localStorage", () => {
  it("loads persisted choices field by field and falls back on unreadable data", (t) => {
    let raw: string | null = '{"inspectorWidth": "wide", "paletteOpen": false, "minimap": "yes"}';
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (key: string) => key === "orquester.workflowEditor.layout.v1" ? raw : null }
    });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    });
    const stored = loadEditorLayout();
    assert.equal(stored.paletteOpen, false);
    assert.equal(stored.minimap, true);
    assert.ok(Number.isFinite(stored.inspectorWidth));
    for (raw of ["not json", null, "[1, 2]", '{"inspectorWidth": null}']) {
      const layout = loadEditorLayout();
      assert.equal(layout.paletteOpen, true);
      assert.equal(layout.minimap, true);
      assert.ok(Number.isFinite(layout.inspectorWidth));
    }
  });
});
