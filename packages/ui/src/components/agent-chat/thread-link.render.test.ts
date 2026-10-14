/**
 * A thread or delegation session tool's row links to the thread it acted on (design 2026-10-14
 * §5): the link names the thread's live tab title and says "closed" once the tab is gone —
 * rendered, not mounted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ProjectSummary, SessionSummary } from "@orquester/api";

import type { AgentChatTimelineRow, WorkLogEntry } from "../../lib/agent-chat/contracts";
import { useAppStore } from "../../store/app";
import { TimelineRowContext, type TimelineRowContextValue } from "./timeline/context";
import { ThreadLink, WorkRow } from "./timeline/rows/ActivityRows";

const P = "/w/ws/app";
const link = { threadId: "c7", title: "stale title from the result", relation: "delegate" as const };

const entry = {
  id: "a1",
  createdAt: "2026-10-14T00:00:01.000Z",
  label: "MCP tool call",
  tone: "tool",
  itemType: "mcp_tool_call",
  sourceActivityKind: "tool.completed",
  toolLifecycleStatus: "completed",
  sessionTool: "delegate_task",
  threadLink: link
} as WorkLogEntry;

test("the link names the thread by its live tab title, never the result's", () => {
  const html = renderToStaticMarkup(createElement(ThreadLink, { link, title: "Task: audit auth", onOpen: () => undefined }));
  assert.match(html, /<button[^>]*data-thread-link="c7"/);
  assert.match(html, /Task: audit auth/);
  assert.match(html, /Open “Task: audit auth”/);
  assert.doesNotMatch(html, /stale title/);
});

test("a closed thread's link says so and is no button", () => {
  const html = renderToStaticMarkup(createElement(ThreadLink, { link, title: undefined, onOpen: () => undefined }));
  assert.match(html, /data-thread-link="closed"/);
  assert.doesNotMatch(html, /<button/);
});

test("the tool row carries the link beside its label", () => {
  const row = { kind: "work", id: "w1", createdAt: entry.createdAt, groupedEntries: [entry], isExpandedToolGroup: false } as unknown as AgentChatTimelineRow;
  const context = { isExpanded: () => false, setExpanded: () => undefined, workspaceRoot: P, readOnly: false, backgroundShell: false } as unknown as TimelineRowContextValue;
  const html = renderToStaticMarkup(createElement(TimelineRowContext.Provider, { value: context }, createElement(WorkRow, { row: row as never })));
  assert.match(html, /Delegated a task/);
  // Server rendering reads the store's initial state, which holds no tabs: the link says closed.
  assert.match(html, /data-thread-link="closed"/);
});

test("opening a link activates the thread's tab in the project", () => {
  const tab = (id: string): SessionSummary =>
    ({ id, kind: "agent-chat", refId: "claude", title: id, projectPath: P, cwd: P, cols: 0, rows: 0, status: "running", order: 0, createdAt: "2026-10-14T00:00:00.000Z" }) as SessionSummary;
  useAppStore.setState({ currentProject: { path: P, name: "app" } as ProjectSummary, sessions: [tab("me"), tab("c7")], activeTabByProject: { [P]: "me" } });
  useAppStore.getState().activateTab("c7");
  assert.equal(useAppStore.getState().activeTabByProject[P], "c7");
});
