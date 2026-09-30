import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type AgentProfileAgentId,
  type AgentProfileChangedPayload,
  type ProfileItemDraft
} from "@orquester/api";
import type { ProfileAdapter } from "./adapters/types.ts";
import { AgentProfileError, profileErrors } from "./errors.ts";
import { resolveAgentHomes } from "./homes.ts";
import type { ProfileImports } from "./import.ts";
import {
  AgentProfileService,
  publishAgentProfileEvents,
  type AgentProfileServiceOptions,
  type ProfileWatchFn
} from "./service.ts";
import { FakeProfileAdapter, fakeItem } from "./testing.ts";

const quiet = { warn: () => undefined, error: () => undefined };
const NOW = new Date("2026-09-28T12:00:00.000Z");

interface Harness {
  service: AgentProfileService;
  adapters: Record<AgentProfileAgentId, FakeProfileAdapter>;
  installed: Set<AgentProfileAgentId>;
  events: AgentProfileChangedPayload[];
  warnings: string[];
}

function harness(overrides: Partial<AgentProfileServiceOptions> = {}): Harness {
  const adapters = {
    claude: new FakeProfileAdapter("claude"),
    codex: new FakeProfileAdapter("codex"),
    grok: new FakeProfileAdapter("grok"),
    opencode: new FakeProfileAdapter("opencode")
  };
  const installed = new Set<AgentProfileAgentId>(["claude", "codex", "grok", "opencode"]);
  const warnings: string[] = [];
  const service = new AgentProfileService({
    adapters,
    converter: (item) => ({ item, notes: [] }),
    agentInfo: (agent) => (installed.has(agent) ? { installed: true, version: `${agent} 1.0` } : { installed: false }),
    homes: resolveAgentHomes({}, "/home/daemon"),
    logger: { warn: (message) => warnings.push(message), error: (message) => warnings.push(message) },
    now: () => NOW,
    ...overrides
  });
  const events: AgentProfileChangedPayload[] = [];
  service.lifecycle.on("changed", (payload: AgentProfileChangedPayload) => events.push(payload));
  return { service, adapters, installed, events, warnings };
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<AgentProfileError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AgentProfileError, `expected an AgentProfileError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    assert.equal(error.status, status);
    return error;
  }
  assert.fail(`expected ${code}`);
}

/** Lets every pending promise chain (fake realpaths, snapshot reads) run to completion. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

const mcpDraft = (name: string, transport: "stdio" | "http" | "sse" = "stdio"): ProfileItemDraft => ({
  kind: "mcp",
  mcp: transport === "stdio" ? { name, transport, command: "srv" } : { name, transport, url: "https://x" }
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

test("snapshot: a not-installed agent (or one with no adapter) answers an empty snapshot, not an error", async () => {
  const h = harness();
  h.installed.delete("grok");
  const grok = await h.service.snapshot("grok");
  assert.equal(grok.installed, false);
  assert.equal(grok.version, undefined);
  assert.deepEqual(grok.items, []);
  assert.deepEqual(grok.instructions, {
    path: join("/home/daemon", ".grok", "AGENTS.md"),
    exists: false,
    bytes: 0,
    lines: 0,
    revision: "",
    warnings: []
  });
  assert.deepEqual(h.adapters.grok.calls, [], "the adapter of a missing CLI is never asked");

  const partial = new AgentProfileService({
    adapters: {},
    converter: (item) => ({ item, notes: [] }),
    agentInfo: () => ({ installed: true }),
    logger: quiet
  });
  const claude = await partial.snapshot("claude");
  assert.equal(claude.installed, false);
  assert.equal(claude.instructions.path, "");
});

test("overview: counts per kind per agent; one failing adapter reads as counts {} and is logged", async () => {
  const h = harness();
  h.adapters.claude.items = [fakeItem("mcp", "a"), fakeItem("mcp", "b"), fakeItem("skill", "c")];
  h.adapters.codex.failNext("snapshot", new Error("codex config broke"));
  h.installed.delete("opencode");
  const overview = await h.service.overview();
  assert.deepEqual(overview.agents, [
    { agent: "claude", installed: true, version: "claude 1.0", counts: { mcp: 2, skill: 1 } },
    { agent: "codex", installed: true, version: "codex 1.0", counts: {} },
    { agent: "grok", installed: true, version: "grok 1.0", counts: {} },
    { agent: "opencode", installed: false, counts: {} }
  ]);
  assert.ok(h.warnings.some((line) => line.includes("codex config broke")));
});

// ---------------------------------------------------------------------------
// The per-agent queue
// ---------------------------------------------------------------------------

test("mutations to one agent run one at a time, in order; a failure does not break the chain", async () => {
  const h = harness();
  h.adapters.claude.items = [fakeItem("mcp", "a")];
  const firstGate = h.adapters.claude.hold("create");
  h.adapters.claude.failNext("setEnabled", profileErrors.conflict());

  const first = h.service.create("claude", mcpDraft("one"));
  const second = h.service.setEnabled("claude", "mcp:a", "rev-a", false);
  const third = h.service.remove("claude", "mcp:a", "rev-a");

  // Another agent's queue is independent.
  await h.service.create("codex", mcpDraft("other"));

  firstGate.resolve();
  const one = await first;
  assert.deepEqual(one.itemIds, ["mcp:one"]);
  assert.deepEqual(one.snapshot.items.map((item) => item.id), ["mcp:a", "mcp:one"]);
  await rejectsWith(second, 409, "PROFILE_CONFLICT");
  const removed = await third;
  assert.deepEqual(removed.itemIds, ["mcp:a"]);
  assert.deepEqual(
    removed.snapshot.items.map((item) => item.id),
    ["mcp:one"],
    "the answer is the snapshot read right after this write"
  );
});

test("reads do not queue behind a held mutation", async () => {
  const h = harness();
  const gate = h.adapters.claude.hold("create");
  const pending = h.service.create("claude", mcpDraft("one"));
  const snapshot = await h.service.snapshot("claude");
  assert.deepEqual(snapshot.items, []);
  const instructions = await h.service.readInstructions("claude");
  assert.equal(instructions.text, "");
  gate.resolve();
  await pending;
});

// ---------------------------------------------------------------------------
// Checks before the adapter
// ---------------------------------------------------------------------------

test("a mutation or detail read on a not-installed agent is 404 AGENT_NOT_INSTALLED and never reaches the adapter", async () => {
  const h = harness();
  h.installed.delete("codex");
  await rejectsWith(h.service.create("codex", mcpDraft("x")), 404, "AGENT_NOT_INSTALLED");
  await rejectsWith(h.service.setEnabled("codex", "mcp:x", "r", true), 404, "AGENT_NOT_INSTALLED");
  await rejectsWith(h.service.readItem("codex", "mcp:x"), 404, "AGENT_NOT_INSTALLED");
  await rejectsWith(h.service.readInstructions("codex"), 404, "AGENT_NOT_INSTALLED");
  await rejectsWith(h.service.copy("claude", "skill:x", "codex"), 404, "AGENT_NOT_INSTALLED");
  assert.deepEqual(h.adapters.codex.calls, []);
  assert.deepEqual(h.adapters.claude.calls, [], "the source is not exported when the target cannot receive");
});

test("create: kinds the agent does not have or cannot create are 400 KIND_NOT_SUPPORTED", async () => {
  const h = harness();
  await rejectsWith(
    h.service.create("opencode", { kind: "hook", hook: { event: "Stop", command: "true" } }),
    400,
    "KIND_NOT_SUPPORTED"
  );
  await rejectsWith(
    h.service.create("codex", { kind: "command", document: { name: "x", frontmatter: {}, body: "" } }),
    400,
    "KIND_NOT_SUPPORTED"
  );
  assert.deepEqual(h.adapters.opencode.calls, []);
  assert.deepEqual(h.adapters.codex.calls, []);
});

test("create/update: names follow the shared rules and MCP transports the agent's own", async () => {
  const h = harness();
  await rejectsWith(h.service.create("claude", mcpDraft("bad name")), 400, "INVALID_NAME");
  await rejectsWith(h.service.create("claude", mcpDraft("ends_")), 400, "INVALID_NAME");
  await rejectsWith(
    h.service.create("claude", { kind: "skill", document: { name: "Bad_Skill", frontmatter: {}, body: "" } }),
    400,
    "INVALID_NAME"
  );
  await rejectsWith(
    h.service.create("claude", { kind: "command", document: { name: "a/b/c", frontmatter: {}, body: "" } }),
    400,
    "INVALID_NAME"
  );
  await rejectsWith(h.service.create("codex", mcpDraft("remote", "sse")), 400, "INVALID_ITEM");
  h.adapters.claude.items = [fakeItem("mcp", "jira")];
  await rejectsWith(h.service.update("claude", "mcp:jira", "rev-jira", mcpDraft("no way")), 400, "INVALID_NAME");
  assert.deepEqual(h.adapters.claude.calls, []);
  assert.deepEqual(h.adapters.codex.calls, []);
  // A valid one goes through.
  const ok = await h.service.create("claude", {
    kind: "command",
    document: { name: "git/pr", frontmatter: {}, body: "" }
  });
  assert.deepEqual(ok.itemIds, ["command:git/pr"]);
});

test("update: plugins and marketplaces are not editable; the draft kind must match the item", async () => {
  const h = harness();
  await rejectsWith(
    h.service.update("claude", "plugin:p@m", "r", { kind: "plugin", plugin: { plugin: "p", marketplace: "m" } }),
    400,
    "KIND_NOT_SUPPORTED"
  );
  await rejectsWith(h.service.update("claude", "skill:x", "r", mcpDraft("x")), 400, "INVALID_REQUEST");
  await rejectsWith(
    h.service.update("opencode", "hook:Stop:abc", "r", { kind: "hook", hook: { event: "Stop", command: "true" } }),
    400,
    "KIND_NOT_SUPPORTED"
  );
  assert.deepEqual(h.adapters.claude.calls, []);
});

test("trust, legacy migration and marketplace plugins answer KIND_NOT_SUPPORTED where the adapter has none", async () => {
  const h = harness();
  await rejectsWith(h.service.trust("claude", "hook:Stop:abc", "r"), 400, "KIND_NOT_SUPPORTED");
  await rejectsWith(h.service.migrateLegacyInstructions("grok", ""), 400, "KIND_NOT_SUPPORTED");
  await rejectsWith(h.service.listMarketplacePlugins("opencode", "m"), 400, "KIND_NOT_SUPPORTED");
});

// ---------------------------------------------------------------------------
// Revisions and events
// ---------------------------------------------------------------------------

test("a mutation emits changed once with the fresh revision; a no-op write and plain reads emit nothing", async () => {
  const h = harness();
  h.adapters.claude.items = [fakeItem("mcp", "a"), fakeItem("skill", "b")];
  const before = await h.service.snapshot("claude");
  const response = await h.service.setEnabled("claude", "mcp:a", "rev-a", false);
  assert.notEqual(response.snapshot.revision, before.revision);
  assert.deepEqual(h.events, [{ agent: "claude", revision: response.snapshot.revision }]);

  // Reordering the same items and turning it off again changes nothing: no event.
  h.adapters.claude.items.reverse();
  await h.service.setEnabled("claude", "mcp:a", "rev-a", false);
  await h.service.snapshot("claude");
  assert.equal(h.events.length, 1);

  // A change made outside Orquester and noticed by a read is announced (clients holding the old revision refetch).
  h.adapters.claude.items.push(fakeItem("skill", "outside"));
  const after = await h.service.snapshot("claude");
  assert.deepEqual(h.events.at(-1), { agent: "claude", revision: after.revision });
  assert.equal(h.events.length, 2);
});

test("the first mutation on an agent is announced even with no baseline", async () => {
  const h = harness();
  const response = await h.service.create("grok", mcpDraft("x"));
  assert.deepEqual(h.events, [{ agent: "grok", revision: response.snapshot.revision }]);
});

test("a revision from a read that began before a newer one is dropped, never announced", async () => {
  const h = harness();
  h.adapters.claude.items = [fakeItem("mcp", "a")];
  await h.service.snapshot("claude"); // baseline
  const gate = h.adapters.claude.hold("snapshot");
  const slow = h.service.snapshot("claude"); // starts first, sees the old state… once released
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.adapters.claude.items = [fakeItem("mcp", "b")];
  const fast = await h.service.snapshot("claude");
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.revision, fast.revision);
  h.adapters.claude.items = [fakeItem("mcp", "a")]; // what the slow read will see
  gate.resolve();
  await slow;
  assert.equal(h.events.length, 1, "the slow read's older revision is not announced");
});

test("publishAgentProfileEvents puts every change on the agent-profile channel", async () => {
  const h = harness();
  const published: Array<{ channel: string; type: string; payload: unknown }> = [];
  publishAgentProfileEvents(h.service, { publish: (channel, type, payload) => published.push({ channel, type, payload }) });
  const response = await h.service.create("claude", mcpDraft("x"));
  assert.deepEqual(published, [
    { channel: "agent-profile", type: "agentProfile.changed", payload: { agent: "claude", revision: response.snapshot.revision } }
  ]);
});

// ---------------------------------------------------------------------------
// afterWrite
// ---------------------------------------------------------------------------

test("afterWrite runs after each successful write only, and its failures never fail the write", async () => {
  const seen: AgentProfileAgentId[] = [];
  let mode: "ok" | "throw" | "reject" = "ok";
  const h = harness({
    afterWrite: (agent) => {
      seen.push(agent);
      if (mode === "throw") throw new Error("recycle threw");
      if (mode === "reject") return Promise.reject(new Error("recycle rejected"));
      return undefined;
    }
  });
  await h.service.create("opencode", mcpDraft("a"));
  assert.deepEqual(seen, ["opencode"]);

  h.adapters.opencode.failNext("create", profileErrors.exists("b"));
  await rejectsWith(h.service.create("opencode", mcpDraft("b")), 409, "ITEM_EXISTS");
  assert.deepEqual(seen, ["opencode"], "not after a failed write");

  mode = "throw";
  await h.service.create("opencode", mcpDraft("c"));
  mode = "reject";
  await h.service.create("opencode", mcpDraft("d"));
  await drain();
  assert.deepEqual(seen, ["opencode", "opencode", "opencode"]);
  assert.ok(h.warnings.some((line) => line.includes("recycle threw")));
  assert.ok(h.warnings.some((line) => line.includes("recycle rejected")));
});

test("a mutation that fails after writing part of its work still announces the change and runs afterWrite", async () => {
  const seen: AgentProfileAgentId[] = [];
  const imports: ProfileImports = {
    scanGit: async () => assert.fail("not scanned"),
    scanUpload: async () => assert.fail("not scanned"),
    take: async (_agent, _importId, picks) => ({
      items: picks.map((name) => ({ kind: "command" as const, name, frontmatter: {}, body: "" })),
      notes: [],
      release: async () => undefined
    })
  };
  const h = harness({ imports, afterWrite: (agent) => void seen.push(agent) });
  h.adapters.opencode.items = [fakeItem("command", "two")];
  const baseline = await h.service.snapshot("opencode");

  // "one" lands, then "two" collides: the import fails with the first item already written.
  await rejectsWith(h.service.createFromImport("opencode", "imp", ["one", "two"]), 409, "ITEM_EXISTS");
  assert.deepEqual(h.adapters.opencode.items.map((item) => item.id), ["command:two", "command:one"]);
  const after = await h.service.snapshot("opencode");
  assert.notEqual(after.revision, baseline.revision);
  assert.deepEqual(h.events, [{ agent: "opencode", revision: after.revision }], "the partial write is announced");
  assert.deepEqual(seen, ["opencode"], "OpenCode servers are recycled for the partial write");

  // A failure that wrote nothing announces nothing and recycles nothing.
  await rejectsWith(h.service.createFromImport("opencode", "imp", ["two"]), 409, "ITEM_EXISTS");
  assert.equal(h.events.length, 1);
  assert.deepEqual(seen, ["opencode"]);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

test("copy: exports from the source, imports into the target, answers the TARGET's snapshot and removes the temp dir", async () => {
  const h = harness();
  h.adapters.claude.items = [fakeItem("skill", "review")];
  const response = await h.service.copy("claude", "skill:review", "grok", "keep-both");
  assert.equal(response.snapshot.agent, "grok");
  assert.deepEqual(response.itemIds, ["skill:review"]);
  const [dir] = h.adapters.claude.exportedDirs;
  assert.ok(dir);
  assert.equal(await exists(dir), false, "the exported skill dir is gone");
  assert.deepEqual(h.events.map((event) => event.agent), ["grok"]);
});

test("copy: the temp dir is removed when the import fails too", async () => {
  const h = harness();
  h.adapters.claude.items = [fakeItem("skill", "review")];
  h.adapters.codex.failNext("importItem", profileErrors.exists("review"));
  await rejectsWith(h.service.copy("claude", "skill:review", "codex"), 409, "ITEM_EXISTS");
  const [dir] = h.adapters.claude.exportedDirs;
  assert.ok(dir);
  assert.equal(await exists(dir), false);
});

test("copy: refused onto the same agent, for non-copyable kinds, and where the target cannot create the kind", async () => {
  const h = harness();
  h.adapters.claude.items = [fakeItem("command", "deploy"), fakeItem("hook", "x", { id: "hook:Stop:abc" })];
  await rejectsWith(h.service.copy("claude", "command:deploy", "claude"), 400, "INVALID_REQUEST");
  await rejectsWith(h.service.copy("claude", "hook:Stop:abc", "grok"), 400, "KIND_NOT_SUPPORTED");
  assert.deepEqual(h.adapters.claude.calls, [], "refused before any export");
  // A converter must produce a kind that the target can create.
  await rejectsWith(h.service.copy("claude", "command:deploy", "codex"), 400, "KIND_NOT_SUPPORTED");
  assert.deepEqual(h.adapters.codex.calls, []);
});

test("copy with a converter: imports the converted item and removes its temp dir", async () => {
  const converted = await mkdtemp(join(tmpdir(), "orq-profile-converted-"));
  const h = harness({
    converter: () => {
      return { item: { kind: "skill", name: "deploy", dir: converted }, notes: [] };
    }
  });
  h.adapters.claude.items = [fakeItem("command", "deploy")];
  const response = await h.service.copy("claude", "command:deploy", "codex");
  assert.deepEqual(response.itemIds, ["skill:deploy"]);
  assert.equal(await exists(converted), false);
});

test("copy: opposite copies between two agents do not deadlock", async () => {
  const h = harness();
  h.adapters.claude.items = [fakeItem("command", "a")];
  h.adapters.grok.items = [fakeItem("command", "b")];
  const [one, two] = await Promise.all([
    h.service.copy("claude", "command:a", "grok"),
    h.service.copy("grok", "command:b", "claude")
  ]);
  assert.deepEqual(one.itemIds, ["command:a"]);
  assert.deepEqual(two.itemIds, ["command:b"]);
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

test("imports: take → importItem for each pick in the agent's queue → release, whatever happens", async () => {
  const released: string[] = [];
  const imports: ProfileImports = {
    scanGit: async () => assert.fail("not scanned"),
    scanUpload: async () => assert.fail("not scanned"),
    take: async (_agent, importId, picks) => {
      if (importId === "gone") throw profileErrors.importNotFound(importId);
      return {
        items: picks.map((name) => ({ kind: "command" as const, name, frontmatter: {}, body: "" })),
        notes: [],
        release: async () => {
          released.push(importId);
        }
      };
    }
  };
  const h = harness({ imports });

  const response = await h.service.createFromImport("grok", "imp-1", ["one", "two"], "replace");
  assert.deepEqual(response.itemIds, ["command:one", "command:two"]);
  assert.deepEqual(released, ["imp-1"]);

  // A pick the agent cannot receive refuses the whole import before anything is written.
  await rejectsWith(h.service.createFromImport("grok", "imp-2", ["ok", "Not Valid"]), 400, "INVALID_NAME");
  assert.deepEqual(released, ["imp-1", "imp-2"]);
  assert.equal(h.adapters.grok.imported.length, 2);
  // Codex cannot create commands.
  await rejectsWith(h.service.createFromImport("codex", "imp-3", ["x"]), 400, "KIND_NOT_SUPPORTED");
  assert.deepEqual(released, ["imp-1", "imp-2", "imp-3"]);
  await rejectsWith(h.service.createFromImport("grok", "gone", ["x"]), 404, "IMPORT_NOT_FOUND");
  await rejectsWith(h.service.createFromImport("grok", "empty", []), 400, "IMPORT_FAILED");
});

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

interface FakeWatch {
  path: string;
  closed: boolean;
  change(): void;
  fail(error: Error): void;
}

function fakeWatching(existing: Set<string>): { watch: ProfileWatchFn; realpath: (path: string) => Promise<string>; watches: FakeWatch[] } {
  const watches: FakeWatch[] = [];
  return {
    watches,
    realpath: async (path) => {
      if (!existing.has(path)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return `/real${path}`;
    },
    watch: (path, onChange, onError) => {
      const entry: FakeWatch = {
        path,
        closed: false,
        change: () => {
          if (!entry.closed) onChange();
        },
        fail: (error) => {
          if (!entry.closed) onError(error);
        }
      };
      watches.push(entry);
      return {
        close: () => {
          entry.closed = true;
        }
      };
    }
  };
}

const live = (watches: FakeWatch[]) => watches.filter((entry) => !entry.closed).map((entry) => entry.path).sort();

test("watching: changes are debounced for 500 ms and unchanged snapshots are not announced", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const existing = new Set(["/fake/claude/config", "/fake/codex/config"]);
  const fake = fakeWatching(existing);
  const h = harness({ watch: fake.watch, realpath: fake.realpath });
  h.installed.delete("grok");
  h.installed.delete("opencode");

  h.service.start();
  await drain();

  const claudeWatch = fake.watches.find((entry) => entry.path === "/real/fake/claude/config")!;
  // A burst of events → one re-read, 500 ms after the last one.
  claudeWatch.change();
  t.mock.timers.tick(300);
  claudeWatch.change();
  t.mock.timers.tick(499);
  await drain();
  assert.equal(h.events.length, 0, "still inside the debounce window");
  h.adapters.claude.items = [fakeItem("mcp", "edited-by-hand")];
  const read = h.adapters.claude.nextSnapshot();
  t.mock.timers.tick(1);
  await read;
  await drain();
  assert.equal(h.events.length, 1, "a watcher-seen change is announced even with no baseline");
  assert.equal(h.events[0]!.agent, "claude");

  // An event that changed nothing: re-read, no announcement.
  fake.watches.filter((entry) => !entry.closed && entry.path === "/real/fake/claude/config")[0]!.change();
  const again = h.adapters.claude.nextSnapshot();
  t.mock.timers.tick(500);
  await again;
  await drain();
  assert.equal(h.events.length, 1);

  await h.service.stop();
});

test("watching: an error closes the agent's watchers; the next snapshot re-arms them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeWatching(new Set(["/fake/claude/config"]));
  const h = harness({ watch: fake.watch, realpath: fake.realpath });
  for (const agent of ["codex", "grok", "opencode"] as const) h.installed.delete(agent);

  h.service.start();
  await drain();
  assert.deepEqual(live(fake.watches), ["/real/fake/claude/config"]);
  fake.watches[0]!.fail(new Error("EMFILE"));
  assert.deepEqual(live(fake.watches), []);
  assert.ok(h.warnings.some((line) => line.includes("EMFILE")));

  await h.service.snapshot("claude");
  await drain();
  assert.deepEqual(live(fake.watches), ["/real/fake/claude/config"]);
  h.adapters.claude.items = [fakeItem("mcp", "recovered")];
  const read = h.adapters.claude.nextSnapshot();
  fake.watches.find((entry) => !entry.closed)!.change();
  t.mock.timers.tick(500);
  await read;
  await drain();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.agent, "claude");
  await h.service.stop();
});

test("watching: a watch that throws while arming leaves the agent unarmed (retried on the next read)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeWatching(new Set(["/fake/claude/config"]));
  let failures = 1;
  const h = harness({
    realpath: fake.realpath,
    watch: (path, onChange, onError) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("ENOSPC");
      }
      return fake.watch(path, onChange, onError);
    }
  });
  for (const agent of ["codex", "grok", "opencode"] as const) h.installed.delete(agent);
  h.service.start();
  await drain();
  assert.deepEqual(live(fake.watches), []);
  await h.service.snapshot("claude");
  await drain();
  h.adapters.claude.items = [fakeItem("mcp", "recovered")];
  const read = h.adapters.claude.nextSnapshot();
  fake.watches.find((entry) => !entry.closed)!.change();
  t.mock.timers.tick(500);
  await read;
  await drain();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.agent, "claude");
  await h.service.stop();
});

test("stop: closes every watcher and pending timer, closes the adapters, and nothing runs afterwards", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeWatching(new Set(["/fake/claude/config", "/fake/codex/config", "/fake/grok/config", "/fake/opencode/config"]));
  const h = harness({ watch: fake.watch, realpath: fake.realpath });
  h.service.start();
  await drain();
  assert.equal(live(fake.watches).length, 4);
  fake.watches[0]!.change(); // a debounce timer is pending
  await h.service.stop();
  assert.deepEqual(live(fake.watches), []);
  for (const adapter of Object.values(h.adapters)) assert.equal(adapter.closed, 1);
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(h.events.length, 0);
  // A read after stop does not re-arm.
  await h.service.snapshot("claude");
  await drain();
  assert.deepEqual(live(fake.watches), []);
  // start() after stop() is a no-op.
  h.service.start();
  await drain();
  assert.deepEqual(live(fake.watches), []);
  await h.service.stop(); // idempotent
  assert.equal(h.adapters.claude.closed, 1);
});

test("stop during arming closes the watchers that arming opens", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeWatching(new Set(["/fake/claude/config"]));
  let releaseRealpath!: () => void;
  const gate = new Promise<void>((resolve) => (releaseRealpath = resolve));
  const h = harness({
    watch: fake.watch,
    realpath: async (path) => {
      await gate;
      return fake.realpath(path);
    }
  });
  for (const agent of ["codex", "grok", "opencode"] as const) h.installed.delete(agent);
  h.service.start();
  await h.service.stop();
  releaseRealpath();
  await drain();
  assert.deepEqual(live(fake.watches), []);
});

test("the default watcher: a real fs.watch on the nearest existing directory announces a file created in it", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orq-profile-watch-")));
  const adapter = new FakeProfileAdapter("claude", { paths: [join(dir, "settings.json")] });
  const resolvedPaths: string[] = [];
  let armed!: () => void;
  const resolvedOnce = new Promise<void>((resolve) => (armed = resolve));
  const service = new AgentProfileService({
    adapters: { claude: adapter as ProfileAdapter },
    converter: (item) => ({ item, notes: [] }),
    agentInfo: () => ({ installed: true }),
    logger: quiet,
    debounceMs: 0,
    // The real realpath, observed: once it answered, the real fs.watch is opened right after.
    realpath: async (path) => {
      const real = await realpath(path);
      resolvedPaths.push(real);
      armed();
      return real;
    }
  });
  // The watch is not persistent and the debounce timer is unref'd (neither keeps the daemon alive),
  // so hold the event loop open while this test waits for the event.
  const keepAlive = setInterval(() => undefined, 60_000);
  try {
    service.start();
    await resolvedOnce;
    await drain();
    assert.deepEqual(resolvedPaths, [dir], "settings.json does not exist yet: its directory is watched");
    adapter.items = [fakeItem("mcp", "written")];
    const changed = once(service.lifecycle, "changed");
    await writeFile(join(dir, "settings.json"), "{}");
    const [payload] = (await changed) as [AgentProfileChangedPayload];
    assert.equal(payload.agent, "claude");
  } finally {
    clearInterval(keepAlive);
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(adapter.closed, 1);
});
