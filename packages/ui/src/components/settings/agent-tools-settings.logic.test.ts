/**
 * Settings › Agent tools (unified MCP §9.2, §7.6): the matrix, what a cell sends, reset, grant
 * wording, and the rendered page (master switch, locked core, measured bytes, tier badges, grants).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TOOLSETS, type AgentToolsetView } from "@orquester/api";

import { agentToolsStore, resetAgentTools } from "../../lib/agent-tools/store";
import { AgentToolsSettings } from "./AgentToolsSettings";
import {
  agentToolsMatrix,
  describeGrant,
  formatToolsetBytes,
  matrixCellUpdate,
  matrixResetUpdate,
  tierCounts
} from "./agent-tools-settings.logic";

function views(): AgentToolsetView[] {
  return TOOLSETS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    locked: spec.locked,
    tools: [...spec.tools],
    bytes: 1000 + spec.tools.length * 100,
    catalogDefaults: { ...spec.defaults },
    defaults: { ...spec.defaults }
  }));
}

test("the matrix: one row per toolset, one cell per agent; core locked; changed cells marked", () => {
  const toolsets = views();
  toolsets.find((view) => view.id === "notes")!.defaults.codex = true;
  const rows = agentToolsMatrix(toolsets);
  assert.deepEqual(rows.map((row) => row.id), TOOLSETS.map((spec) => spec.id));
  const core = rows[0]!;
  assert.equal(core.locked, true);
  assert.ok(core.cells.every((cell) => cell.on && cell.locked && !cell.customised));
  assert.deepEqual(core.cells.map((cell) => cell.agent), ["claude", "codex", "grok", "opencode"]);
  const notes = rows.find((row) => row.id === "notes")!;
  assert.deepEqual(notes.cells.map((cell) => [cell.agent, cell.on, cell.customised]), [
    ["claude", false, false],
    ["codex", true, true],
    ["grok", false, false],
    ["opencode", false, false]
  ]);
  assert.deepEqual(rows.find((row) => row.id === "workflow-authoring")!.tiers, { read: 3, act: 1, admin: 5 });
  assert.equal(notes.bytes, "1.3 KB");
});

test("a cell sends its value, or null when it lands back on the catalogue default; locked sends nothing", () => {
  const toolsets = views();
  const notes = toolsets.find((view) => view.id === "notes")!;
  assert.deepEqual(matrixCellUpdate(notes, "codex", true, 4), { revision: 4, defaults: { notes: { codex: true } } });
  assert.deepEqual(matrixCellUpdate(notes, "codex", false, 4), { revision: 4, defaults: { notes: { codex: null } } });
  assert.equal(matrixCellUpdate(toolsets[0]!, "claude", false, 4), null);
});

test("reset clears exactly the customised cells", () => {
  const toolsets = views();
  assert.equal(matrixResetUpdate(toolsets, 2), null);
  toolsets.find((view) => view.id === "reads")!.defaults.opencode = false;
  toolsets.find((view) => view.id === "desktops")!.defaults.claude = true;
  assert.deepEqual(matrixResetUpdate(toolsets, 2), { revision: 2, defaults: { reads: { opencode: null }, desktops: { claude: null } } });
});

test("tier counts and byte formatting", () => {
  assert.deepEqual(tierCounts({ tools: [{ name: "a", tier: "read" }, { name: "b", tier: "admin" }] }), { read: 1, act: 0, admin: 1 });
  assert.equal(formatToolsetBytes(undefined), null);
  assert.equal(formatToolsetBytes(999), "999 B");
  assert.equal(formatToolsetBytes(25_150), "25.1 KB");
});

test("grants read as what, where and how far", () => {
  const titleOf = (id: string) => (id === "t1" ? "Plan the API" : null);
  const chat = { id: "g1", family: "workflows", scope: "chat", projectPath: "/w/acme/web", threadId: "t1", workflowIds: ["a", "b"], createdAt: "c" };
  assert.deepEqual(describeGrant(chat, titleOf), { id: "g1", what: "Workflow changes", where: "Chat “Plan the API”", detail: "2 workflows", scope: "chat" });
  assert.equal(describeGrant(chat, titleOf, "t1").where, "This chat");
  assert.equal(describeGrant({ ...chat, threadId: "gone" }, titleOf).where, "A chat");
  const project = { id: "g2", family: "desktops", scope: "project", projectPath: "/w/acme/web", createdAt: "c" };
  assert.equal(describeGrant(project, titleOf).where, "Project acme/web");
  const cross = { id: "g3", family: "cross-project", scope: "chat", projectPath: "/w/a/b", threadId: "t1", targetProjectPath: "/w/other/api", createdAt: "c" };
  assert.equal(describeGrant(cross, titleOf).detail, "in other/api");
  assert.equal(describeGrant({ ...project, family: "future-thing" }, titleOf).what, "future-thing");
});

test("the page renders the switch, the locked core, bytes, tier badges and the grants", () => {
  resetAgentTools();
  agentToolsStore.setState({
    settings: {
      revision: 1,
      enabled: true,
      toolsets: views(),
      grants: [{ id: "g1", family: "desktops", scope: "project", projectPath: "/w/acme/web", createdAt: "2026-10-15T09:00:00.000Z" }]
    }
  });
  const html = renderToStaticMarkup(createElement(AgentToolsSettings));
  assert.match(html, /Extra toolsets for agent chats/);
  assert.match(html, /always has the core Chats &amp; delegation tools/, "the switch says the core tools stay");
  assert.match(html, /role="switch"[^>]*aria-checked="true"/);
  assert.match(html, /data-agent-tools-matrix=""/);
  for (const label of ["Claude Code", "Codex", "Grok", "OpenCode"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /data-cell="core:claude"[^>]*>.*?Always on/);
  assert.doesNotMatch(html, /aria-label="Chats &amp; delegation for/);
  assert.match(html, /aria-label="Todos &amp; saved-prompt editing for Codex"/);
  assert.match(html, /17 tools · 2\.7 KB/);
  assert.match(html, /Admin 5/);
  assert.match(html, /next idle point/);
  assert.match(html, /data-grant-id="g1"/);
  assert.match(html, /Project acme\/web/);
  assert.match(html, />Revoke all</);
  resetAgentTools();
});

test("an older daemon without the routes says so", () => {
  resetAgentTools();
  agentToolsStore.setState({ settingsUnsupported: true });
  assert.match(renderToStaticMarkup(createElement(AgentToolsSettings)), /predates agent tool settings/);
  resetAgentTools();
});
