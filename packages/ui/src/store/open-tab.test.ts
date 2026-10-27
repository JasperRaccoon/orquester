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
import { loadSessionProfiles, resetSessionProfiles } from "../lib/session-profiles/store.ts";
import { useAppStore } from "./app.ts";

const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key)
};

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
    agentConversationsByProject: {},
    preferredProfileByAgent: {},
    notice: null
  });
  resetSessionProfiles();
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

describe("openTab — the agent's remembered Agent Profile (agent profiles §5.3)", () => {
  function recordCreates(): Record<string, unknown>[] {
    const requests: Record<string, unknown>[] = [];
    useAppStore.setState({
      api: {
        createSession: async (request: Record<string, unknown>) => {
          requests.push(request);
          return session(`s${requests.length}`);
        }
      } as unknown as ApiClient
    });
    return requests;
  }
  const NEW_CHAT = { kind: "agent-chat" as const, refId: "claude", title: "Claude", chat: { modelSelection: { model: "sonnet" } } };

  it("a new chat and a resumed conversation launch with the agent's remembered profile", async () => {
    const requests = recordCreates();
    store().setPreferredProfile("claude", "p-dev");
    await store().openTab(NEW_CHAT);
    await store().openTab(RESUME);
    for (const request of requests) {
      assert.equal(request.profileId, "p-dev");
      assert.equal((request.chat as { profileId?: string }).profileId, "p-dev");
    }
    assert.equal(
      (requests[1]!.chat as { resume?: { conversationId: string } }).resume?.conversationId,
      "conv-1",
      "the resume keeps its cursor"
    );
  });

  it("Global (nothing remembered, or another agent's pick) sends no profile", async () => {
    const requests = recordCreates();
    store().setPreferredProfile("codex", "p-dev");
    await store().openTab(NEW_CHAT);
    assert.equal("profileId" in requests[0]!, false);
    assert.equal("profileId" in (requests[0]!.chat as object), false);

    store().setPreferredProfile("claude", "p-dev");
    store().setPreferredProfile("claude", null);
    await store().openTab({ ...NEW_CHAT });
    assert.equal("profileId" in requests[1]!, false, "picking Global forgets the profile");
  });

  it("a deleted profile is no agent's pick any more", () => {
    store().setPreferredProfile("claude", "p-dev");
    store().applyEvent({ channel: "session-profiles", type: "sessionProfile.deleted", payload: { profileId: "p-dev" } } as never);
    assert.deepEqual(store().preferredProfileByAgent, {});
  });

  const refuse = (code: string, message: string) => {
    useAppStore.setState({
      api: { createSession: async () => Promise.reject(new ApiError(400, "POST", "/api/sessions", undefined, { code, message })) } as unknown as ApiClient,
      registry: { shells: [], agents: [{ id: "claude", name: "Claude Code" }], ides: [], fileExplorers: [], browsers: [] } as never
    });
  };

  it("a remembered profile the daemon no longer has: the pick is forgotten and the notice says so — nothing launches as Global", async () => {
    store().setPreferredProfile("claude", "p-gone");
    refuse("PROFILE_NOT_FOUND", 'No Agent Profile "p-gone".');
    assert.equal(await store().openTab(NEW_CHAT), undefined);
    assert.deepEqual(store().preferredProfileByAgent, {}, "new chats of that agent are Global again");
    assert.ok(store().notice?.message, "the missing profile is reported");
    assert.equal(store().sessions.length, 0, "no automatic Global relaunch");
  });

  it("a remembered profile that is not ready keeps the pick and reports the failure", async () => {
    store().setPreferredProfile("claude", "p-dev");
    refuse("PROFILE_NOT_READY", "Preparing Claude failed: the MCP file does not parse.");
    assert.equal(await store().openTab(NEW_CHAT), undefined);
    assert.deepEqual(store().preferredProfileByAgent, { claude: "p-dev" });
    const message = store().notice?.message ?? "";
    assert.match(message, /the MCP file does not parse/);
  });

  it("another refusal of a launch that named its own profile still throws", async () => {
    refuse("PROFILE_NOT_FOUND", 'No Agent Profile "p-x".');
    await assert.rejects(() => store().openTab({ ...NEW_CHAT, chat: { ...NEW_CHAT.chat, profileId: "p-x" } }), /p-x/);
  });

  it("the daemon's profile list prunes remembered picks it does not have (an unreadable one is kept)", async () => {
    store().setPreferredProfile("claude", "p-gone");
    store().setPreferredProfile("codex", "p-dev");
    store().setPreferredProfile("grok", "p-broken");
    await loadSessionProfiles({
      connection: { id: "c1" },
      listSessionProfiles: async () => ({
        profiles: [
          {
            id: "p-dev",
            name: "Dev",
            description: "",
            revision: "1",
            createdAt: "t",
            updatedAt: "t",
            counts: {},
            hasInstructions: false,
            preparation: []
          }
        ],
        errors: [{ profileId: "p-broken", message: "unreadable" }]
      })
    } as never);
    assert.deepEqual(store().preferredProfileByAgent, { codex: "p-dev", grok: "p-broken" });
  });

  it("picks are kept per daemon connection", () => {
    useAppStore.setState({ activeConnectionId: "remote-1" });
    store().setPreferredProfile("claude", "p-remote");
    assert.deepEqual(JSON.parse(localStorage.getItem("orquester:preferred-profile-by-connection") ?? "{}")["remote-1"], { claude: "p-remote" });
  });

  it("a terminal launch never carries one", async () => {
    const requests = recordCreates();
    store().setPreferredProfile("bash", "p-dev");
    await store().openTab({ kind: "shell" as never, refId: "bash", title: "bash" });
    assert.equal("profileId" in requests[0]!, false);
  });
});
