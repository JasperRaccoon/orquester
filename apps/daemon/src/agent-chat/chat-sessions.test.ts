import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CreateSessionRequest, SessionSummary } from "@orquester/api";
import { parseSessionsConfig, type SessionRecord } from "@orquester/config";
import { ChatSessionManager } from "./chat-sessions.ts";
import { ChatAwareSessionManager, type ChatSessionLifecycle } from "./session-router.ts";
import { EventEmitter } from "node:events";
import type { ISessionManager } from "../sessions.ts";

// §5.2 tab records: the tolerant parse, the legacy `agent` migration, and the
// one per-project order that spans both kinds.

function chatManager(onPersist: () => void = () => undefined): ChatSessionManager {
  return new ChatSessionManager({ requestPersist: onPersist });
}

function seed(chat: ChatSessionManager, id: string, order: number, projectPath = "/w/p"): SessionSummary {
  return chat.create({
    id,
    refId: "claude",
    title: `chat ${id}`,
    projectPath,
    cwd: projectPath,
    order,
    accountId: "acc-1",
    home: "account"
  });
}

test("a created chat tab round-trips through its sessions.json record", () => {
  const chat = chatManager();
  seed(chat, "t1", 0);
  const records = chat.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "agent-chat");
  assert.deepEqual(records[0].chat, {
    threadId: "t1",
    accountId: "acc-1",
    home: "account",
    lastSeq: 0
  });

  const reloaded = chatManager();
  reloaded.adopt(records);
  const summary = reloaded.get("t1");
  assert.equal(summary?.kind, "agent-chat");
  assert.equal(summary?.order, 0);
  assert.equal(summary?.accountId, "acc-1");
  assert.equal(reloaded.lastSeq("t1"), 0);
});

test("one bad chat record never poisons the index", () => {
  // The outer shape still throws (sessions.ts reads that as "skip orphan
  // reaping"), but a record whose chat block is malformed drops that ONE row.
  const parsed = parseSessionsConfig({
    version: 1,
    sessions: [
      {
        id: "good",
        title: "t",
        order: 0,
        projectPath: "/w/p",
        refId: "claude",
        kind: "agent-chat",
        cwd: "/w/p",
        createdAt: "2026-09-21T00:00:00.000Z",
        chat: { threadId: "good", accountId: "", home: "system", lastSeq: 3 }
      },
      {
        id: "bad",
        title: "t",
        order: 1,
        projectPath: "/w/p",
        refId: "claude",
        kind: "agent-chat",
        cwd: "/w/p",
        createdAt: "2026-09-21T00:00:00.000Z",
        chat: { threadId: "bad", accountId: "", home: "nowhere", lastSeq: 0 }
      },
      {
        id: "terminal",
        title: "bash",
        order: 2,
        projectPath: "/w/p",
        refId: "bash",
        kind: "shell",
        cwd: "/w/p",
        createdAt: "2026-09-21T00:00:00.000Z"
      }
    ]
  });
  assert.deepEqual(
    parsed.sessions.map((s) => s.id),
    ["good", "terminal"],
    "the terminal beside a bad chat record survives"
  );

  const chat = chatManager();
  chat.adopt(parsed.sessions);
  assert.equal(chat.get("good")?.id, "good");
  assert.equal(chat.get("bad"), undefined);
  assert.equal(chat.get("terminal"), undefined, "a shell record is not a chat tab");
  assert.equal(chat.lastSeq("good"), 3);
});

test("a chat record without a chat block is skipped, not resurrected as a half-thread", () => {
  const chat = chatManager();
  chat.adopt([
    {
      id: "x",
      title: "t",
      order: 0,
      projectPath: "/w/p",
      refId: "claude",
      kind: "agent-chat",
      cwd: "/w/p",
      createdAt: "2026-09-21T00:00:00.000Z"
    } as SessionRecord
  ]);
  assert.equal(chat.get("x"), undefined);
});

test("closing a tab queues a DURABLE host-side delete", () => {
  // Regression: the cascade was fire-and-forget over the host socket. With the
  // host down at close time no `thread.deleted` is ever written, and §3.3's
  // reconcile then finds an orphan with a cursor and a continuation marker and
  // RESUMES it — a provider child and tokens spent for a tab nobody has.
  let persists = 0;
  const chat = chatManager(() => {
    persists++;
  });
  seed(chat, "t1", 0);
  chat.close("t1");
  assert.deepEqual(chat.pendingThreadDeletes(), ["t1"]);
  // It rides the index, so it survives the daemon restart in between.
  const reloaded = chatManager();
  reloaded.adoptPendingDeletes(chat.pendingThreadDeletes());
  assert.deepEqual(reloaded.pendingThreadDeletes(), ["t1"]);
  // …and is cleared only once the host answers.
  const before = persists;
  chat.resolveThreadDelete("t1");
  assert.deepEqual(chat.pendingThreadDeletes(), []);
  assert.equal(persists, before + 1, "the cleared queue is made durable too");
  chat.resolveThreadDelete("t1");
  assert.equal(persists, before + 1, "resolving twice does not churn the index");
});

test("a malformed queued id is dropped, never the whole queue", () => {
  const chat = chatManager();
  chat.adoptPendingDeletes(["good", "", "also-good"] as string[]);
  assert.deepEqual(chat.pendingThreadDeletes(), ["good", "also-good"]);
});

test("lastSeq is monotonic — a stale frame cannot rewind a tab's cursor", () => {
  let persists = 0;
  const chat = chatManager(() => {
    persists++;
  });
  seed(chat, "t1", 0);
  const base = persists;
  chat.noteSeq("t1", 10);
  assert.equal(chat.lastSeq("t1"), 10);
  chat.noteSeq("t1", 4);
  assert.equal(chat.lastSeq("t1"), 10);
  assert.equal(persists, base + 1, "only the advancing write persists");
});

test("the derived §6.4 fields publish only when one actually moved", () => {
  const chat = chatManager();
  seed(chat, "t1", 0);
  const updates: SessionSummary[] = [];
  chat.lifecycle.on("updated", (s: SessionSummary) => updates.push(s));
  assert.ok(chat.applyFields("t1", { chatSessionStatus: "running" }));
  assert.equal(chat.applyFields("t1", { chatSessionStatus: "running" }), null, "no churn");
  assert.ok(chat.applyFields("t1", { chatSessionStatus: "running", hasPendingApprovals: true }));
  assert.equal(updates.length, 2);
  assert.equal(updates[1].hasPendingApprovals, true);
});

test("the goal rides the tab and republishes only when it moves (goals §4.7)", () => {
  const chat = chatManager();
  seed(chat, "t1", 0);
  const updates: SessionSummary[] = [];
  chat.lifecycle.on("updated", (s: SessionSummary) => updates.push(s));
  const goal = { objective: "ship it", status: "active" as const, continuing: true };

  assert.ok(chat.applyFields("t1", { chatSessionStatus: "ready", goal }));
  assert.deepEqual(chat.get("t1")?.goal, goal);
  assert.equal(
    chat.applyFields("t1", { chatSessionStatus: "ready", goal: { ...goal } }),
    null,
    "an equal goal from the next poll is no churn"
  );
  for (const next of [
    { ...goal, continuing: false },
    { ...goal, continuing: false, status: "paused" as const },
    { ...goal, continuing: false, status: "paused" as const, objective: "ship v2" },
    null
  ]) {
    assert.ok(chat.applyFields("t1", { chatSessionStatus: "ready", goal: next }), JSON.stringify(next));
    assert.deepEqual(chat.get("t1")?.goal, next);
  }
  assert.equal(updates.length, 5);
  // An older host that does not report the field says "no goal" too.
  assert.equal(chat.applyFields("t1", { chatSessionStatus: "ready" }), null, "null and absent are one fact");
  assert.equal(chat.get("t1")?.goal ?? null, null);
});

// --- the router: one list, one order, across both kinds ---------------------

class FakePty implements ISessionManager {
  readonly lifecycle = new EventEmitter();
  readonly sessions = new Map<string, SessionSummary>();
  persisted = 0;
  add(id: string, order: number, projectPath = "/w/p"): void {
    this.sessions.set(id, {
      id,
      kind: "shell",
      refId: "bash",
      title: id,
      projectPath,
      cwd: projectPath,
      cols: 80,
      rows: 24,
      status: "running",
      order,
      createdAt: "2026-09-21T00:00:00.000Z"
    });
  }
  async create(): Promise<SessionSummary> {
    throw new Error("not used");
  }
  list(projectPath?: string): SessionSummary[] {
    return [...this.sessions.values()].filter(
      (s) => projectPath === undefined || s.projectPath === projectPath
    );
  }
  get(id: string): SessionSummary | undefined {
    return this.sessions.get(id);
  }
  async scrollback(): Promise<string> {
    return "pty";
  }
  buffer(): string {
    return "pty";
  }
  activity(): undefined {
    return undefined;
  }
  agentEvent(): boolean {
    return false;
  }
  input(): void {}
  resize(): void {}
  rename(): SessionSummary | undefined {
    return undefined;
  }
  reorder(projectPath: string, ids: string[]): void {
    ids.forEach((id, index) => {
      const s = this.sessions.get(id);
      if (s && s.projectPath === projectPath) s.order = index;
    });
  }
  close(id: string): boolean {
    return this.sessions.delete(id);
  }
  closeByProjectPrefix(): void {}
  subscribe(): () => void {
    return () => undefined;
  }
  shutdown(): void {}
  closeAll(): void {}
  async reattach(): Promise<void> {}
  liveAccountIds(): Set<string> {
    return new Set();
  }
  persistIndexNow(): void {
    this.persisted++;
  }
}

function makeRouter(): {
  router: ChatAwareSessionManager;
  pty: FakePty;
  chat: ChatSessionManager;
  closed: string[];
  renamed: Array<[string, string]>;
} {
  const pty = new FakePty();
  const chat = chatManager();
  const closed: string[] = [];
  const renamed: Array<[string, string]> = [];
  const hooks: ChatSessionLifecycle = {
    create: async () => {
      throw new Error("not used");
    },
    onClose: (id) => closed.push(id),
    onRename: (id, title) => renamed.push([id, title])
  };
  return { router: new ChatAwareSessionManager(pty, chat, hooks), pty, chat, closed, renamed };
}

test("the tab strip is one list over both kinds, sorted by the shared order", () => {
  const { router, pty, chat } = makeRouter();
  pty.add("bash-1", 0);
  seed(chat, "chat-1", 1);
  pty.add("bash-2", 2);
  assert.deepEqual(
    router.list("/w/p").map((s) => s.id),
    ["bash-1", "chat-1", "bash-2"]
  );
  assert.equal(router.nextOrder("/w/p"), 3);
});

test("reorder spans both kinds: a chat tab dragged between terminals lands there", () => {
  const { router, pty, chat } = makeRouter();
  pty.add("bash-1", 0);
  pty.add("bash-2", 1);
  seed(chat, "chat-1", 2);
  router.reorder("/w/p", ["bash-1", "chat-1", "bash-2"]);
  assert.deepEqual(
    router.list("/w/p").map((s) => s.id),
    ["bash-1", "chat-1", "bash-2"]
  );
  assert.equal(pty.persisted, 1, "the moved chat order is made durable");
});

test("closing a chat tab cascades the host thread delete BEFORE forgetting it", () => {
  const { router, chat, closed } = makeRouter();
  seed(chat, "chat-1", 0);
  assert.equal(router.close("chat-1"), true);
  assert.deepEqual(closed, ["chat-1"]);
  assert.equal(router.get("chat-1"), undefined);
});

test("renaming a chat tab appends the host's thread.meta-updated", () => {
  const { router, chat, renamed } = makeRouter();
  seed(chat, "chat-1", 0);
  const summary = router.rename("chat-1", "  Refactor  ");
  assert.equal(summary?.title, "Refactor");
  assert.deepEqual(renamed, [["chat-1", "Refactor"]]);
});

test("a managed-hook agent-event for a CHAT session is accepted and ignored, never 404", () => {
  // The account home's user-level settings.json carries the managed terminal
  // hooks and a chat launch sets ORQUESTER_SESSION_ID too, so those hooks fire
  // with a chat session id. Answering 404 would make the hook look broken.
  const { router, chat } = makeRouter();
  seed(chat, "chat-1", 0);
  assert.equal(router.agentEvent("chat-1", { source: "claude", event: "Stop" }), true);
  assert.equal(router.agentEvent("nope", { source: "claude", event: "Stop" }), false);
});

test("the PTY-only surface is inert for a chat tab", async () => {
  const { router, chat } = makeRouter();
  seed(chat, "chat-1", 0);
  assert.equal(await router.scrollback("chat-1"), "");
  assert.equal(router.buffer("chat-1"), "");
  assert.equal(router.subscribe("chat-1", () => undefined, () => undefined)(), undefined);
  // …and untouched for a terminal.
  assert.equal(router.buffer("bash-1"), "pty");
});

test("liveAccountIds unions both kinds (the idle-account refresher reads it)", () => {
  const { router, chat } = makeRouter();
  seed(chat, "chat-1", 0);
  assert.deepEqual([...router.liveAccountIds()], ["acc-1"]);
});

test("create dispatches on the kind", async () => {
  const pty = new FakePty();
  const chat = chatManager();
  let chatCreates = 0;
  const router = new ChatAwareSessionManager(pty, chat, {
    create: async () => {
      chatCreates++;
      return seed(chat, "chat-1", 0);
    },
    onClose: () => undefined,
    onRename: () => undefined
  });
  await router.create({ kind: "agent-chat", refId: "claude" } as CreateSessionRequest);
  assert.equal(chatCreates, 1);
  await assert.rejects(() => router.create({ kind: "shell", refId: "bash" } as CreateSessionRequest));
});

// --- §3.4 account switch ---------------------------------------------------

test("setAccount moves the summary AND the persisted chat block together", () => {
  let persists = 0;
  const chat = chatManager(() => {
    persists += 1;
  });
  seed(chat, "t1", 0);
  const updates: SessionSummary[] = [];
  chat.lifecycle.on("updated", (summary: SessionSummary) => updates.push(summary));
  persists = 0;

  const next = chat.setAccount("t1", { accountId: "acc-2", home: "account" });
  assert.equal(next?.accountId, "acc-2");
  assert.equal(updates.length, 1, "one `updated` broadcast, so every client reconciles");
  assert.equal(updates[0].accountId, "acc-2");
  assert.equal(persists, 1, "sessions.json is rewritten");

  assert.deepEqual(chat.records()[0].chat, {
    threadId: "t1",
    accountId: "acc-2",
    home: "account",
    lastSeq: 0
  });
  // The tab badge and the idle-account refresher both read `summary.accountId`.
  assert.deepEqual([...chat.liveAccountIds()], ["acc-2"]);
});

test("switching to the system identity drops the summary's account id", () => {
  const chat = chatManager();
  seed(chat, "t1", 0);
  const next = chat.setAccount("t1", { accountId: "", home: "system" });
  assert.equal(next?.accountId, undefined, "absent, never an empty string");
  assert.deepEqual([...chat.liveAccountIds()], []);
  assert.equal(chat.records()[0].chat?.home, "system");
});

test("setAccount is a no-op for an unchanged identity and for an unknown tab", () => {
  let persists = 0;
  const chat = chatManager(() => {
    persists += 1;
  });
  seed(chat, "t1", 0);
  persists = 0;
  let updates = 0;
  chat.lifecycle.on("updated", () => {
    updates += 1;
  });
  assert.equal(chat.setAccount("t1", { accountId: "acc-1", home: "account" }), null);
  assert.equal(chat.setAccount("nope", { accountId: "acc-2", home: "account" }), null);
  assert.equal(updates, 0);
  assert.equal(persists, 0);
});
