import { strict as assert } from "node:assert";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { SessionRecord } from "@orquester/config";
import { LocalSessionManager, SessionManager, SessionsIndexUnreadableError, drainSessionIndexWrites } from "../sessions.ts";
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
  assert.equal(h.manager.get("bash-1")?.legacyAgentTerminal, undefined);
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

test("an unreadable sessions index fails reattach, so nothing takes a missing tab for a deleted thread (D-M2)", async () => {
  const h = await harness([], []);
  await writeFile(h.indexPath, "{ torn", "utf8");
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await assert.rejects(h.manager.reattach(), (error: unknown) => error instanceof SessionsIndexUnreadableError);
  } finally {
    console.error = original;
  }
  assert.ok(errors.length > 0, "logged");
  h.manager.closeAll();
  await h.cleanup();
});

test("the direct-PTY backend's reattach also fails on an unreadable index, and not on a missing one (D-M2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-session-index-local-"));
  const indexPath = join(dir, "sessions.json");
  const chat = new ChatSessionManager({ requestPersist: () => undefined });
  const contributor = { records: () => chat.records(), adopt: (rows: SessionRecord[]) => chat.adopt(rows), owns: (record: SessionRecord) => record.kind === "agent-chat" };
  const missing = new LocalSessionManager(REGISTRY, { indexContributor: contributor }, indexPath);
  await missing.reattach();
  await writeFile(indexPath, "{ torn", "utf8");
  const torn = new LocalSessionManager(REGISTRY, { indexContributor: contributor }, indexPath);
  const original = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(torn.reattach(), (error: unknown) => error instanceof SessionsIndexUnreadableError);
  } finally {
    console.error = original;
  }
  await rm(dir, { recursive: true, force: true });
});

// --- a reattach never rewrites what it could not read (both backends) -----------------------

const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
  const original = { error: console.error, warn: console.warn };
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    return await run();
  } finally {
    console.error = original.error;
    console.warn = original.warn;
  }
};

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("tmux: an unreadable index is never written over — the chat tabs in it survive the run", { skip: asRoot ? "root reads any file" : false }, async () => {
  const h = await harness([chatRecord("chat-1", 0)], []);
  const before = await readFile(h.indexPath, "utf8");
  await chmod(h.indexPath, 0o000);
  try {
    await quietly(() => assert.rejects(h.manager.reattach(), SessionsIndexUnreadableError));
    h.manager.persistIndexNow();
    await drainSessionIndexWrites(h.indexPath);
  } finally {
    await chmod(h.indexPath, 0o600);
  }
  assert.equal(await readFile(h.indexPath, "utf8"), before, "the file is as it was");
  h.manager.closeAll();
  await h.cleanup();
});

test("tmux: a corrupt index is moved aside, kept whole, before anything new is written", async () => {
  const h = await harness([], []);
  await writeFile(h.indexPath, '{"version":1,"sessions":[{"id":"chat-1"', "utf8");
  await quietly(() => assert.rejects(h.manager.reattach(), SessionsIndexUnreadableError));
  await drainSessionIndexWrites(h.indexPath);
  const dir = dirname(h.indexPath);
  const aside = (await readdir(dir)).find((name) => name.startsWith("sessions.json.corrupt-"));
  assert.ok(aside, "moved aside");
  assert.equal(await readFile(join(dir, aside), "utf8"), '{"version":1,"sessions":[{"id":"chat-1"');
  h.manager.closeAll();
  await h.cleanup();
});

test("tmux: records and top-level keys this build cannot read are written back as found", async () => {
  const future = { id: "future-1", kind: "hologram", title: "from a newer build" };
  const h = await harness([chatRecord("chat-1", 0)], []);
  const index = JSON.parse(await readFile(h.indexPath, "utf8")) as Record<string, unknown> & { sessions: unknown[] };
  await writeFile(h.indexPath, JSON.stringify({ ...index, sessions: [...index.sessions, future], newerKey: { keep: true } }), "utf8");
  await quietly(() => h.manager.reattach());
  h.manager.persistIndexNow();
  await drainSessionIndexWrites(h.indexPath);
  const written = JSON.parse(await readFile(h.indexPath, "utf8")) as { sessions: Array<{ id: string }>; newerKey?: unknown };
  assert.deepEqual(written.newerKey, { keep: true });
  assert.deepEqual(written.sessions.find((record) => record.id === "future-1"), future);
  assert.ok(written.sessions.some((record) => record.id === "chat-1"), "the chat tab too");
  h.manager.closeAll();
  await h.cleanup();
});

test("direct PTY: the same — never written over when unreadable, unknown records kept", { skip: asRoot ? "root reads any file" : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-session-index-local-"));
  const indexPath = join(dir, "sessions.json");
  const future = { id: "future-1", kind: "hologram" };
  await writeFile(indexPath, JSON.stringify({ version: 1, sessions: [chatRecord("chat-1", 0), future], newerKey: 1 }), "utf8");
  const before = await readFile(indexPath, "utf8");
  const make = () => {
    const chat = new ChatSessionManager({ requestPersist: () => undefined });
    const manager = new LocalSessionManager(
      REGISTRY,
      { indexContributor: { records: () => chat.records(), adopt: (rows: SessionRecord[]) => chat.adopt(rows), owns: (record: SessionRecord) => record.kind === "agent-chat" } },
      indexPath
    );
    return { chat, manager };
  };

  const blocked = make();
  await chmod(indexPath, 0o000);
  try {
    await quietly(() => assert.rejects(blocked.manager.reattach(), SessionsIndexUnreadableError));
    blocked.manager.persistIndexNow();
    await drainSessionIndexWrites(indexPath);
  } finally {
    await chmod(indexPath, 0o600);
  }
  assert.equal(await readFile(indexPath, "utf8"), before, "not written over");

  const readable = make();
  await quietly(() => readable.manager.reattach());
  assert.equal(readable.chat.get("chat-1")?.kind, "agent-chat");
  readable.manager.persistIndexNow();
  await drainSessionIndexWrites(indexPath);
  const written = JSON.parse(await readFile(indexPath, "utf8")) as { sessions: Array<{ id: string }>; newerKey?: unknown };
  assert.equal(written.newerKey, 1);
  assert.deepEqual(written.sessions.find((record) => record.id === "future-1"), future);
  await rm(dir, { recursive: true, force: true });
});

test("tmux: panes that survived a corrupt index are kept known, never reaped by a later boot, until they end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-session-index-unclaimed-"));
  const indexPath = join(dir, "sessions.json");
  await writeFile(indexPath, '{"version":1,"sessions":[{"id":"bash-1"', "utf8");
  const killed: string[] = [];
  const boot = (live: string[]) =>
    new SessionManager(REGISTRY, { ...fakeTmux(live), killSession: async (id: string) => void killed.push(id) } as unknown as Tmux, indexPath, {});
  // The corrupt index is moved aside; the surviving pane has no record, so it is written as unclaimed.
  const first = boot(["bash-1"]);
  await quietly(() => assert.rejects(first.reattach(), SessionsIndexUnreadableError));
  await drainSessionIndexWrites(indexPath);
  assert.deepEqual((JSON.parse(await readFile(indexPath, "utf8")) as { unclaimedPanes?: string[] }).unclaimedPanes, ["bash-1"]);
  first.closeAll();
  // The next boot reads the fresh index: the pane is not reaped, and stays listed while it lives.
  const second = boot(["bash-1", "orphan-2"]);
  await second.reattach();
  assert.deepEqual(killed, ["orphan-2"], "only a genuine orphan is reaped");
  await drainSessionIndexWrites(indexPath);
  assert.deepEqual((JSON.parse(await readFile(indexPath, "utf8")) as { unclaimedPanes?: string[] }).unclaimedPanes, ["bash-1"]);
  second.closeAll();
  // Once it has ended, it leaves the list.
  const third = boot([]);
  await third.reattach();
  await drainSessionIndexWrites(indexPath);
  assert.equal((JSON.parse(await readFile(indexPath, "utf8")) as { unclaimedPanes?: string[] }).unclaimedPanes, undefined);
  third.closeAll();
  await rm(dir, { recursive: true, force: true });
});
