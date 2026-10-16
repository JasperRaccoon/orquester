/**
 * The chat's Tools chip (unified MCP §9.2): resolution as the daemon reports it (chat override →
 * agent default, `core` locked), what a choice sends, the declined window, and the rendered chip.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadAgentToolsResponse } from "@orquester/api";

import { deriveToolsChip, toolsetChoiceUpdate } from "./tools-chip";
import { ToolsChipView } from "./ToolsChip";

const NOW = Date.parse("2026-10-15T10:00:00.000Z");

const data = (extra: Partial<ThreadAgentToolsResponse> = {}): ThreadAgentToolsResponse => ({
  threadId: "t1",
  agent: "claude",
  overrides: {},
  resolved: ["core", "reads"],
  workflowOwned: false,
  appliesAtNextIdle: false,
  declines: {},
  grants: [],
  ...extra
});

test("the default chat: core + reads = 22 tools; core is locked", () => {
  const model = deriveToolsChip(data(), NOW);
  assert.equal(model.label, "Tools 22");
  assert.equal(model.toolCount, 22);
  const core = model.rows.find((row) => row.id === "core")!;
  assert.equal(core.locked, true);
  assert.equal(core.on, true);
  assert.equal(model.rows.find((row) => row.id === "notes")!.on, false);
  assert.match(model.title, /Chats & delegation, Workflows, profiles & prompts \(read\)$/);
});

test("a chat override shows as the chat's choice; inheriting rows know their default", () => {
  const model = deriveToolsChip(
    data({ overrides: { "workflow-authoring": true, reads: false }, resolved: ["core", "workflow-authoring"] }),
    NOW
  );
  const authoring = model.rows.find((row) => row.id === "workflow-authoring")!;
  assert.equal(authoring.choice, "on");
  assert.equal(authoring.on, true);
  assert.equal(authoring.inheritedOn, null);
  const reads = model.rows.find((row) => row.id === "reads")!;
  assert.equal(reads.choice, "off");
  assert.equal(reads.on, false);
  const notes = model.rows.find((row) => row.id === "notes")!;
  assert.equal(notes.choice, "inherit");
  assert.equal(notes.inheritedOn, false);
  assert.equal(model.toolCount, 17 + 9);
});

test("core is on even when the daemon's list forgot it; locked rows send nothing", () => {
  const model = deriveToolsChip(data({ resolved: [] }), NOW);
  assert.equal(model.rows.find((row) => row.id === "core")!.on, true);
  assert.equal(toolsetChoiceUpdate({ id: "core", locked: true }, "off"), null);
  assert.deepEqual(toolsetChoiceUpdate({ id: "notes", locked: false }, "inherit"), { toolsets: { notes: null } });
  assert.deepEqual(toolsetChoiceUpdate({ id: "notes", locked: false }, "off"), { toolsets: { notes: false } });
  assert.deepEqual(toolsetChoiceUpdate({ id: "desktops", locked: false }, "on"), { toolsets: { desktops: true } });
});

test("a denial blocks re-asking only until its time; pending changes and workflow-owned chats say so", () => {
  const model = deriveToolsChip(
    data({
      declines: { desktops: "2026-10-15T10:20:00.000Z", notes: "2026-10-15T09:00:00.000Z" },
      appliesAtNextIdle: true,
      workflowOwned: true
    }),
    NOW
  );
  assert.equal(model.rows.find((row) => row.id === "desktops")!.declinedUntil, "2026-10-15T10:20:00.000Z");
  assert.equal(model.rows.find((row) => row.id === "notes")!.declinedUntil, null);
  assert.equal(model.pending, true);
  assert.match(model.ariaLabel, /next idle point/);
  assert.match(model.note ?? "", /no Admin tools/);
});

test("the chip renders its count and never its panel until clicked", () => {
  const html = renderToStaticMarkup(createElement(ToolsChipView, { sessionId: "t1", data: data(), now: NOW }));
  assert.match(html, /data-tools-chip="t1"/);
  assert.match(html, /Tools 22/);
  assert.doesNotMatch(html, /data-tools-panel/);
  assert.doesNotMatch(html, /autofocus/i);
});
