import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionRecord } from "@orquester/config";
import { SessionManager, drainSessionIndexWrites } from "../sessions.ts";
import type { RegistryService } from "../registry.ts";
import type { Tmux } from "../tmux.ts";
import { ChatSessionManager } from "./chat-sessions.ts";

// `sessions.json` is shared by two owners (chat spec §5.2). These pin the three
// rules that makes safe: the PTY manager is the only WRITER, a chat record is
// routed to its contributor instead of being reattached or reaped, and a legacy
// `kind: "agent"` record is migrated per §5.2.

const REGISTRY = { get: () => undefined } as unknown as RegistryService;

/**
 * A tmux stub. `attachArgs` points at `tmux -V`, which prints a version and
 * exits immediately — the attach PTY is a real node-pty spawn and must not be
 * allowed to touch a real tmux server.
 */
function fakeTmux(live: string[]): Tmux {
  return {
    listSessions: async () => live,
    windowSizes: async () => new Map(),
    setWindowSizeLatest: async () => undefined,
    scrubGlobalSecrets: async () => undefined,
    killSession: async () => undefined,
    // The harmless attach client exits; the fixture pane remains live independently.
    hasSession: async (id: string) => live.includes(id),
    attachArgs: () => ["-V"]
  } as unknown as Tmux;
}

const chatRecord = (id: string, order: number): SessionRecord => ({
  id,
  title: `chat ${id}`,
  order,
  projectPath: "/w/p",
  refId: "claude",
  kind: "agent-chat",
  cwd: "/w/p",
  createdAt: "2026-09-21T00:00:00.000Z",
  chat: { threadId: id, accountId: "acc-1", home: "account", lastSeq: 7 }
});

const terminalRecord = (id: string, kind: "shell" | "agent", order: number): SessionRecord => ({
  id,
  title: id,
  order,
  projectPath: "/w/p",
  refId: kind === "shell" ? "bash" : "claude",
  kind,
  cwd: "/w/p",
  createdAt: "2026-09-21T00:00:00.000Z",
  cols: 100,
  rows: 30
});

async function harness(
  records: SessionRecord[],
  live: string[]
): Promise<{ manager: SessionManager; chat: ChatSessionManager; indexPath: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "orq-session-index-"));
  const indexPath = join(dir, "sessions.json");
  await writeFile(indexPath, JSON.stringify({ version: 1, sessions: records }), "utf8");
  const chat = new ChatSessionManager({ requestPersist: () => undefined });
  const manager = new SessionManager(REGISTRY, fakeTmux(live), indexPath, {
    indexContributor: {
      records: () => chat.records(),
      adopt: (rows) => chat.adopt(rows),
      owns: (record) => record.kind === "agent-chat"
    }
  });
  return {
    manager,
    chat,
    indexPath,
    // `persistIndexNow()` is fire-and-forget: drain it before the teardown, or
    // a temp file can appear after the rmdir listed the directory.
    cleanup: async () => {
      await drainSessionIndexWrites(indexPath);
      await rm(dir, { recursive: true, force: true });
    }
  };
}

test("reattach routes chat records to their contributor and never attaches a PTY to them", async () => {
  const h = await harness([chatRecord("chat-1", 0), terminalRecord("bash-1", "shell", 1)], ["bash-1"]);
  await h.manager.reattach();
  assert.equal(h.chat.get("chat-1")?.kind, "agent-chat");
  assert.equal(h.chat.lastSeq("chat-1"), 7, "the render cursor survives a daemon restart");
  assert.equal(h.manager.get("chat-1"), undefined, "the PTY manager never holds a chat tab");
  assert.equal(h.manager.get("bash-1")?.id, "bash-1");
  h.manager.closeAll();
  await h.cleanup();
});

test("a chat record is never reaped as an orphan tmux session", async () => {
  const killed: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "orq-session-index-"));
  const indexPath = join(dir, "sessions.json");
  await writeFile(
    indexPath,
    JSON.stringify({ version: 1, sessions: [chatRecord("chat-1", 0)] }),
    "utf8"
  );
  const chat = new ChatSessionManager({ requestPersist: () => undefined });
  const tmux = {
    ...fakeTmux(["chat-1", "orphan-1"]),
    killSession: async (id: string) => {
      killed.push(id);
    }
  } as unknown as Tmux;
  const manager = new SessionManager(REGISTRY, tmux, indexPath, {
    indexContributor: {
      records: () => chat.records(),
      adopt: (rows) => chat.adopt(rows),
      owns: (record) => record.kind === "agent-chat"
    }
  });
  await manager.reattach();
  assert.deepEqual(killed, ["orphan-1"], "a genuine orphan is still reaped");
  manager.closeAll();
  await drainSessionIndexWrites(indexPath);
  await rm(dir, { recursive: true, force: true });
});

test("§5.2 migration: a legacy `agent` record with a live pane stays a terminal, flagged", async () => {
  const h = await harness([terminalRecord("legacy-1", "agent", 0)], ["legacy-1"]);
  await h.manager.reattach();
  const summary = h.manager.get("legacy-1");
  assert.equal(summary?.kind, "agent");
  assert.equal(summary?.legacyAgentTerminal, true, "the UI tags it 'legacy terminal'");
  h.manager.closeAll();
  await h.cleanup();
});

test("§5.2 migration: a legacy `agent` record with NO live pane is forgotten", async () => {
  const h = await harness([terminalRecord("legacy-1", "agent", 0)], []);
  await h.manager.reattach();
  assert.equal(h.manager.get("legacy-1"), undefined);
  h.manager.closeAll();
  await h.cleanup();
});

test("a shell record carries no legacy flag", async () => {
  const h = await harness([terminalRecord("bash-1", "shell", 0)], ["bash-1"]);
  await h.manager.reattach();
  assert.equal(h.manager.get("bash-1")?.legacyAgentTerminal, undefined);
  h.manager.closeAll();
  await h.cleanup();
});

test("one persisted index holds updated chat and terminal records", async () => {
  const h = await harness([chatRecord("chat-1", 1), terminalRecord("bash-1", "shell", 0)], ["bash-1"]);
  try {
    await h.manager.reattach();
    h.chat.noteSeq("chat-1", 11);
    h.manager.persistIndexNow();
    await drainSessionIndexWrites(h.indexPath);
    const raw = JSON.parse(await readFile(h.indexPath, "utf8")) as { sessions: SessionRecord[] };
    assert.deepEqual(raw.sessions.map((row) => row.id).sort(), ["bash-1", "chat-1"]);
    assert.equal(raw.sessions.find((row) => row.id === "chat-1")?.chat?.lastSeq, 11);
  } finally {
    h.manager.closeAll();
    await h.cleanup();
  }
});

test("concurrent writes retain the latest complete session index", async () => {
  const h = await harness([], []);
  try {
    await h.manager.reattach();
    for (let round = 0; round < 40; round++) {
      for (const session of h.chat.list()) h.chat.close(session.id);
      if (round % 2 === 0) {
        for (let i = 0; i < 12; i++) h.chat.adopt([chatRecord(`long-${round}-${i}`, i)]);
      } else {
        h.chat.adopt([chatRecord("short", 0)]);
      }
      h.manager.persistIndexNow();
    }
    await drainSessionIndexWrites(h.indexPath);
    const saved = JSON.parse(await readFile(h.indexPath, "utf8")) as { sessions: SessionRecord[] };
    assert.deepEqual(saved.sessions.map((row) => row.id), ["short"]);
    assert.equal(saved.sessions[0]?.chat?.lastSeq, 7);
  } finally {
    h.manager.closeAll();
    await h.cleanup();
  }
});
