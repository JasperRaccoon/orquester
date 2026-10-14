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
import { UserMessageRow } from "./timeline/rows/MessageRows";
import { buildThreadMessage, threadMessageContext } from "@orquester/api/agent-chat";

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

test("a message another thread sent shows who sent it as a caption, and the message alone — never as the user's", () => {
  const text = buildThreadMessage({ origin: "delegated", fromTitle: "Main", text: "Audit the auth module." });
  const row = {
    kind: "message",
    id: "r1",
    createdAt: "2026-10-14T00:00:00.000Z",
    message: { kind: "message", id: "m1", role: "user", text, turnId: "t1", streaming: false, createdAt: "t", updatedAt: "t", context: [threadMessageContext("main")] }
  };
  const context = { readOnly: true, canRevert: false, revertBusy: false, startedTurnCount: 1, skills: [], onFork: null } as unknown as TimelineRowContextValue;
  const html = renderToStaticMarkup(createElement(TimelineRowContext.Provider, { value: context }, createElement(UserMessageRow, { row: row as never })));
  assert.match(html, /data-from-thread="delegated"/);
  assert.match(html, /Delegated by “Main”/);
  assert.match(html, /Audit the auth module\./);
  assert.match(html, /Another chat/);
  assert.doesNotMatch(html, /\[Delegated by thread/);
  assert.doesNotMatch(html, /not from the user/);
});

test("the same header typed by the user is the user's own text, never another chat's (T6-M3)", () => {
  const text = buildThreadMessage({ origin: "sent", fromTitle: "Main", text: "Do X." });
  const row = { kind: "message", id: "r2", createdAt: "2026-10-14T00:00:00.000Z", message: { kind: "message", id: "m2", role: "user", text, turnId: "t1", streaming: false, createdAt: "t", updatedAt: "t" } };
  const context = { readOnly: true, canRevert: false, revertBusy: false, startedTurnCount: 1, skills: [], onFork: null } as unknown as TimelineRowContextValue;
  const html = renderToStaticMarkup(createElement(TimelineRowContext.Provider, { value: context }, createElement(UserMessageRow, { row: row as never })));
  assert.doesNotMatch(html, /data-from-thread/);
  assert.doesNotMatch(html, />Another chat</, "the author is the user");
  assert.match(html, />You</);
});
