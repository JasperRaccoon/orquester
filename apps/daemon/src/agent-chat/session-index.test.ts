import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionRecord } from "@orquester/config";
import { SessionManager } from "../sessions.ts";
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
    // The attach PTY exits immediately (`tmux -V`); the exit path then asks
    // whether the pane is still alive, which it is not.
    hasSession: async () => false,
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
  return { manager, chat, indexPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
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
    ...fakeTmux(["orphan-1"]),
    listSessions: async () => ["orphan-1"],
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

test("the PTY manager is the only writer: one file holds both kinds", async () => {
  const h = await harness([chatRecord("chat-1", 1), terminalRecord("bash-1", "shell", 0)], ["bash-1"]);
  await h.manager.reattach();
  h.manager.persistIndexNow();
  // persistIndexNow is fire-and-forget; wait for the atomic rename to land.
  for (let i = 0; i < 50; i++) {
    const raw = JSON.parse(await readFile(h.indexPath, "utf8")) as { sessions: SessionRecord[] };
    if (raw.sessions.some((s) => s.kind === "agent-chat")) {
      const chatRow = raw.sessions.find((s) => s.kind === "agent-chat");
      assert.equal(chatRow?.id, "chat-1", "the contributor's record is in the one file");
      assert.equal(chatRow?.chat?.lastSeq, 7);
      assert.equal(chatRow?.chat?.home, "account");
      h.manager.closeAll();
      await h.cleanup();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the contributor's records never reached sessions.json");
});
