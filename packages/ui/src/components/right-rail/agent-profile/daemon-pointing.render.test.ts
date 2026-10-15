/**
 * The agent-profile panel's "Disabled inside Orquester chats" chip (unified MCP design 2026-10-15
 * §12.1): the panel's view asks `daemonPointingFor` per row and the MCP row whose server reaches
 * this Orquester's own /mcp carries the red chip — rendered, not mounted. Shared by the desktop
 * and web clients (one `packages/ui` panel).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentProfileSnapshot, ProfileItem, ProfileItemKind } from "@orquester/api";

import { AgentProfilePanelView, type ProfileItemActions } from "./AgentProfilePanelView";
import { daemonPointingReasonFor, parseDaemonMcpServers } from "./daemon-pointing.logic";

function item(kind: ProfileItemKind, name: string): ProfileItem {
  return { id: `${kind}:${name}`, kind, name, enabled: true, toggleable: true, editable: true, deletable: true, locked: false,
    source: { type: "user", label: "User" }, revision: "r", warnings: [] };
}

const noop = () => undefined;
const actions: ProfileItemActions = {
  toggle: noop, edit: noop, copyTo: noop, copyPath: noop, remove: noop, trust: noop, manageIn: noop,
  confirmRemove: noop, resolveConflict: noop, cancelConfirm: noop
};

function render(items: ProfileItem[], daemonPointingFor?: (item: ProfileItem) => "bearer" | "url" | "name" | null): string {
  const snapshot: AgentProfileSnapshot = {
    agent: "claude", installed: true, revision: "s1", items, fileErrors: [], readAt: "2026-10-15T00:00:00Z",
    instructions: { path: "/h/.claude/CLAUDE.md", exists: true, bytes: 1, lines: 1, revision: "i", warnings: [] }
  };
  return renderToStaticMarkup(createElement(AgentProfilePanelView, {
    variant: "docked", agent: "claude", agents: [{ id: "claude", label: "Claude", installed: true }], onAgentChange: noop,
    query: "", onQueryChange: noop, kind: "mcp", onKindChange: noop, tabs: [{ id: "mcp", label: "MCP", count: items.length }],
    snapshot, groups: [{ kind: "mcp", label: "MCP servers", items }], empty: null, loadError: null, onRetry: noop,
    notice: null, onDismissNotice: noop, now: 0, pendingIds: new Set<string>(), highlightId: null, confirming: null,
    copyTargetsFor: () => [], actions, onOpenInstructions: noop, creatableKinds: ["mcp"], onAdd: noop,
    ...(daemonPointingFor ? { daemonPointingFor } : {})
  }));
}

test("the panel flags only the row whose server reaches this Orquester, from the detection route's answer", () => {
  const servers = parseDaemonMcpServers({ servers: [
    { agent: "claude", home: "system", scope: "user", name: "orquester_remote", reason: "bearer" },
    { agent: "claude", home: "acc1", scope: "user", name: "jira", reason: "url" },
    { bogus: true }
  ] });
  assert.equal(servers?.length, 2, "malformed rows are dropped");
  const html = render([item("mcp", "orquester_remote"), item("mcp", "jira")], (row) => daemonPointingReasonFor(row, "claude", servers));
  const rows = html.split('data-profile-item="').slice(1);
  const flagged = rows.find((row) => row.startsWith("mcp:orquester_remote"))!;
  const plain = rows.find((row) => row.startsWith("mcp:jira"))!;
  assert.match(flagged, /data-daemon-pointing="bearer"/);
  assert.match(flagged, /Disabled inside Orquester chats/);
  assert.match(flagged, /this Orquester&#x27;s own credential/);
  assert.doesNotMatch(plain, /data-daemon-pointing/);
});

test("without the route's answer (an older daemon, a failed read) no row is flagged", () => {
  assert.equal(parseDaemonMcpServers({ error: { code: "NOT_FOUND" } }), null);
  const html = render([item("mcp", "orquester")], (row) => daemonPointingReasonFor(row, "claude", null));
  assert.doesNotMatch(html, /Disabled inside Orquester chats/);
  assert.doesNotMatch(render([item("mcp", "orquester")]), /Disabled inside Orquester chats/);
});
