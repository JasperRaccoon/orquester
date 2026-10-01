/**
 * `openTab` for a resumed conversation: the launch owns the screen while it is
 * in flight (`openingChat`), a second click on the same conversation is not a
 * second launch, and a conversation already open in this project switches to
 * its tab instead of failing.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ProjectSummary, SessionSummary } from "@orquester/api";

import { ApiError, type ApiClient } from "../lib/api-client.ts";
import { useAppStore } from "./app.ts";

const P = "/w/acme/app";
const store = () => useAppStore.getState();

const RESUME = {
  kind: "agent-chat" as const,
  refId: "claude",
  title: "Old conversation",
  chat: {
    modelSelection: { model: "sonnet" },
    resume: { home: "system" as const, conversationId: "conv-1" }
  }
};

function session(id: string): SessionSummary {
  return { id, kind: "agent-chat", refId: "claude", title: "t", projectPath: P } as SessionSummary;
}

function withCreate(createSession: () => Promise<SessionSummary>): void {
  useAppStore.setState({ api: { createSession } as unknown as ApiClient });
}

beforeEach(() => {
  useAppStore.setState({
    currentProject: { path: P, name: "app" } as ProjectSummary,
    sessions: [],
    activeTabByProject: {},
    openingChat: null,
    resumeError: null,
    agentConversationsByProject: {}
  });
});

describe("openTab — resuming a conversation", () => {
  it("shows the opening screen until the tab exists, and ignores a second click meanwhile", async () => {
    let release!: (value: SessionSummary) => void;
    let creates = 0;
    withCreate(() => {
      creates += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    });

    const first = store().openTab(RESUME);
    assert.deepEqual(store().openingChat, {
      projectPath: P,
      conversationId: "conv-1",
      title: "Old conversation",
      refId: "claude"
    });
    assert.equal(await store().openTab(RESUME), undefined, "the second click launches nothing");
    assert.equal(creates, 1);

    release(session("s1"));
    assert.equal((await first)?.id, "s1");
    assert.equal(store().openingChat, null);
    assert.equal(store().activeTabByProject[P], "s1");
  });

  it("clears the opening screen when the launch fails", async () => {
    withCreate(() => Promise.reject(new Error("daemon down")));
    await assert.rejects(() => store().openTab(RESUME), /daemon down/);
    assert.equal(store().openingChat, null);
  });

  it("switches to the tab that already holds the conversation instead of failing", async () => {
    useAppStore.setState({ sessions: [session("owner")] });
    withCreate(() =>
      Promise.reject(
        new ApiError(400, "POST", "/api/sessions", undefined, {
          code: "CONVERSATION_ALREADY_OPEN",
          message: 'That conversation is already open in "Old conversation".',
          ownerSessionId: "owner"
        })
      )
    );
    const opened = await store().openTab(RESUME);
    assert.equal(opened?.id, "owner");
    assert.equal(store().activeTabByProject[P], "owner");
    assert.equal(store().resumeError, null, "no error toast: the user got their conversation");
  });

  it("still refuses when the owning tab is not in this project", async () => {
    withCreate(() =>
      Promise.reject(
        new ApiError(400, "POST", "/api/sessions", undefined, {
          code: "CONVERSATION_ALREADY_OPEN",
          message: "already open elsewhere",
          ownerSessionId: "elsewhere"
        })
      )
    );
    assert.equal(await store().openTab(RESUME), undefined);
    assert.equal(store().resumeError?.message, "already open elsewhere");
  });
});
