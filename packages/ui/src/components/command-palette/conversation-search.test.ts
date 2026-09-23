/**
 * The command palette's "Search conversations" mode (design 2026-09-23 §C
 * "Search", "Client") — its pure half: entering the mode, what is sent,
 * how a snippet's «marks» split, and what the list says when it has no rows.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ThreadSearchHit, ThreadSearchResponse } from "@orquester/api/agent-chat";

import { AgentChatCommandError } from "../../lib/agent-chat/transport";
import {
  conversationSearchFailure,
  conversationSearchNotice,
  conversationSearchQuery,
  paletteInputChange,
  searchHitKindLabel,
  shownSearchResponse,
  snippetSegments,
  type ConversationSearchState
} from "./conversation-search";

const hit = (overrides: Partial<ThreadSearchHit> = {}): ThreadSearchHit => ({
  threadId: "s1",
  projectPath: "/w/p",
  title: "Rename the helper",
  turnId: "t1",
  ordinal: 1,
  kind: "message",
  id: "m1",
  role: "user",
  activityKind: null,
  snippet: "rename «formatBytes»",
  at: "2026-09-22T10:00:00.000Z",
  seq: 4,
  ...overrides
});

const response = (overrides: Partial<ThreadSearchResponse> = {}): ThreadSearchResponse => ({
  query: "formatBytes",
  hits: [hit()],
  truncated: false,
  indexed: true,
  ...overrides
});

describe("entering the mode", () => {
  it("switches to search when `?` is typed first, and keeps the rest as the query", () => {
    assert.deepEqual(paletteInputChange("go", "?format"), { mode: "search", query: "format" });
    assert.deepEqual(paletteInputChange("go", "?"), { mode: "search", query: "" });
  });

  it("leaves an ordinary query alone", () => {
    assert.deepEqual(paletteInputChange("go", "orq"), { mode: "go", query: "orq" });
    assert.deepEqual(paletteInputChange("go", "a?b"), { mode: "go", query: "a?b" });
  });

  it("treats a `?` typed inside the mode as text", () => {
    assert.deepEqual(paletteInputChange("search", "?why"), { mode: "search", query: "?why" });
  });
});

describe("conversationSearchQuery", () => {
  it("trims, and sends nothing for blank input", () => {
    assert.equal(conversationSearchQuery("  format bytes  "), "format bytes");
    assert.equal(conversationSearchQuery("   "), "");
  });

  it("never sends more than the host would read", () => {
    assert.equal(conversationSearchQuery("x".repeat(260)).length, 200);
  });
});

describe("snippetSegments", () => {
  it("splits a snippet on its «marks»", () => {
    assert.deepEqual(snippetSegments("rename «formatBytes» here"), [
      { text: "rename ", match: false },
      { text: "formatBytes", match: true },
      { text: " here", match: false }
    ]);
    assert.deepEqual(snippetSegments("«a» and «b»"), [
      { text: "a", match: true },
      { text: " and ", match: false },
      { text: "b", match: true }
    ]);
  });

  it("keeps a snippet without marks, or with an unclosed one, as plain text", () => {
    assert.deepEqual(snippetSegments("no marks here"), [{ text: "no marks here", match: false }]);
    assert.deepEqual(snippetSegments("open « only"), [{ text: "open « only", match: false }]);
  });

  it("drops empty segments", () => {
    assert.deepEqual(snippetSegments("x «» y"), [
      { text: "x ", match: false },
      { text: " y", match: false }
    ]);
  });
});

describe("searchHitKindLabel", () => {
  it("names who spoke on a message hit", () => {
    assert.equal(searchHitKindLabel(hit({ role: "user" })), "You");
    assert.equal(searchHitKindLabel(hit({ role: "assistant" })), "Assistant");
    assert.equal(searchHitKindLabel(hit({ role: "reasoning" })), "Thinking");
  });

  it("names an activity hit by its kind's family", () => {
    const activity = (activityKind: string | null) =>
      searchHitKindLabel(hit({ kind: "activity", role: null, activityKind }));
    assert.equal(activity("tool.completed"), "Tool");
    assert.equal(activity("user-input.resolved"), "User input");
    assert.equal(activity("context-compaction"), "Context compaction");
    assert.equal(activity(null), "Activity");
  });
});

describe("what the list shows", () => {
  const notice = (state: ConversationSearchState, visible = 0) =>
    conversationSearchNotice(state, visible)?.text ?? null;

  it("says the index is unavailable only when the host answers `indexed: false`", () => {
    assert.equal(
      notice({ status: "done", query: "x", response: response({ indexed: false, hits: [] }) }),
      "Search is unavailable on this host"
    );
  });

  it("never reads an HTTP error as an unavailable index — it is a failure worth retrying", () => {
    for (const error of [
      new AgentChatCommandError(0, "HOST_UNAVAILABLE", "fetch failed"),
      new AgentChatCommandError(503, "HOST_UNAVAILABLE", "the host is restarting"),
      new AgentChatCommandError(503, "INDEX_UNAVAILABLE", "index is rebuilding")
    ]) {
      const shown = conversationSearchNotice(conversationSearchFailure("x", error), 0);
      assert.equal(shown?.kind, "error", error.message);
      assert.notEqual(shown?.text, "Search is unavailable on this host", error.message);
    }
  });

  it("tells a host it could not reach apart from a host that answered badly", () => {
    const unreachable = conversationSearchNotice(
      conversationSearchFailure("x", new AgentChatCommandError(0, "HOST_UNAVAILABLE", "fetch failed")),
      0
    );
    assert.match(unreachable?.text ?? "", /try again/i);
    assert.doesNotMatch(unreachable?.text ?? "", /fetch failed/, "no raw transport message");
  });

  it("says there are no matches, rather than showing nothing", () => {
    assert.equal(notice({ status: "done", query: "x", response: response({ hits: [] }) }), "No matches");
    assert.equal(
      notice({ status: "done", query: "x", response: response() }, 0),
      "No matches",
      "hits this client may not show (an archived project) are no matches here"
    );
    assert.equal(notice({ status: "done", query: "x", response: response() }, 1), null);
  });

  it("shows the previous results while the next search runs", () => {
    const previous = response();
    const loading: ConversationSearchState = { status: "loading", query: "fo", previous };
    assert.equal(shownSearchResponse(loading), previous);
    assert.equal(notice(loading, 1), null);
    assert.equal(notice({ status: "loading", query: "fo", previous: null }), "Searching…");
  });

  it("surfaces any other failure in words", () => {
    const failed = conversationSearchFailure(
      "x",
      new AgentChatCommandError(502, "UNKNOWN", "the host answered garbage")
    );
    assert.match(notice(failed) ?? "", /the host answered garbage/);
  });

  it("invites a query before there is one", () => {
    assert.ok((notice({ status: "idle" }) ?? "").length > 0);
  });

  it("says when more matched than it shows", () => {
    const truncated: ConversationSearchState = {
      status: "done",
      query: "x",
      response: response({ truncated: true })
    };
    assert.equal(conversationSearchNotice(truncated, 1)?.kind, "truncated");
  });
});
