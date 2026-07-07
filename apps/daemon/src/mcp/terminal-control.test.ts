import { EventEmitter } from "node:events";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { CreateSessionRequest, SessionSummary } from "@orquester/api";
import type { ISessionManager } from "../sessions.ts";
import {
  ACTIVITY_WORKING_MS,
  TerminalControl,
  TabNotFound,
  AmbiguousTab,
  ToolError,
  type TerminalControlDeps,
} from "./terminal-control.ts";

// A drivable fake ISessionManager: in-memory sessions + a per-id output/exit emitter.
export class FakeManager implements Partial<ISessionManager> {
  lifecycle = new EventEmitter();
  tabs: SessionSummary[] = [];
  inputs: { id: string; data: string }[] = [];
  closed: string[] = [];
  created: CreateSessionRequest[] = [];
  create?: ISessionManager["create"];
  texts = new Map<string, string>();
  activityMap = new Map<string, { lastOutputAt: number | null; attention: boolean }>();
  private subs = new Map<string, { out: (d: string) => void; exit: (c: number) => void }[]>();

  add(s: Partial<SessionSummary> & { id: string; title: string; projectPath: string }): SessionSummary {
    const full: SessionSummary = {
      kind: "shell", refId: "bash", cwd: "", cols: 80, rows: 24, status: "running",
      order: this.tabs.length, createdAt: new Date(2026, 0, 1).toISOString(), ...s,
    } as SessionSummary;
    this.tabs.push(full);
    return full;
  }
  list(projectPath?: string) {
    return projectPath === undefined ? [...this.tabs] : this.tabs.filter((t) => t.projectPath === projectPath);
  }
  get(id: string) { return this.tabs.find((t) => t.id === id); }
  input(id: string, data: string) { this.inputs.push({ id, data }); }
  close(id: string) { this.closed.push(id); return true; }
  async captureText(id: string) { return this.texts.get(id) ?? ""; }
  activity(id: string) { return this.activityMap.get(id); }
  subscribe(id: string, out: (d: string) => void, exit: (c: number) => void) {
    const arr = this.subs.get(id) ?? [];
    arr.push({ out, exit });
    this.subs.set(id, arr);
    return () => { this.subs.set(id, (this.subs.get(id) ?? []).filter((s) => s.out !== out)); };
  }
  emitOutput(id: string, data: string) { (this.subs.get(id) ?? []).forEach((s) => s.out(data)); }
  emitExit(id: string, code = 0) { (this.subs.get(id) ?? []).forEach((s) => s.exit(code)); }
  ringBell(id: string) {
    this.activityMap.set(id, { lastOutputAt: Date.now(), attention: true });
    this.lifecycle.emit("activity", { id, type: "bell" });
  }
  lifecycleExit(id: string) {
    const tab = this.get(id);
    if (!tab) return;
    tab.status = "exited";
    tab.exitCode ??= 0;
    this.lifecycle.emit("exited", { ...tab });
  }
  subscriberCount(id: string) { return (this.subs.get(id) ?? []).length; }
}

function make(fake: FakeManager, extra?: Partial<TerminalControlDeps>) {
  const deps: TerminalControlDeps = {
    sessions: fake as unknown as ISessionManager,
    registry: { get: () => undefined, list: () => ({ shells: [], agents: [], ides: [], fileExplorers: [], browsers: [] }) } as any,
    workspacesDir: "/ws",
    fsRoot: "/ws",
    listWorkspaces: async () => [],
    listProjects: async () => [],
    ...extra,
  };
  return new TerminalControl(deps);
}

test("resolveTab: by tabId", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  assert.equal(make(f).resolveTab({ tabId: "a" }).id, "a");
  assert.throws(() => make(f).resolveTab({ tabId: "nope" }), TabNotFound);
});

test("resolveTab: name match is case-insensitive", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  assert.equal(make(f).resolveTab({ workspace: "w", project: "p", tab: "claude" }).id, "a");
});

test("resolveTab: missing selector pieces → ToolError", () => {
  assert.throws(() => make(new FakeManager()).resolveTab({ workspace: "w" }), ToolError);
});

test("resolveTab: invalid names → TabNotFound", () => {
  assert.throws(() => make(new FakeManager()).resolveTab({ workspace: "..", project: "p", tab: "x" }), TabNotFound);
});

test("resolveTab: no match lists open tabs", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "bash", projectPath: "/ws/w/p" });
  assert.throws(() => make(f).resolveTab({ workspace: "w", project: "p", tab: "zsh" }), /Open tabs: bash/);
});

test("resolveTab: prefers the single running tab over exited duplicates", () => {
  const f = new FakeManager();
  f.add({ id: "old", title: "bash", projectPath: "/ws/w/p", status: "exited" });
  f.add({ id: "live", title: "bash", projectPath: "/ws/w/p", status: "running" });
  assert.equal(make(f).resolveTab({ workspace: "w", project: "p", tab: "bash" }).id, "live");
});

test("resolveTab: ambiguous among running → AmbiguousTab with ids", () => {
  const f = new FakeManager();
  f.add({ id: "r1", title: "bash", projectPath: "/ws/w/p", status: "running" });
  f.add({ id: "r2", title: "bash", projectPath: "/ws/w/p", status: "running" });
  assert.throws(() => make(f).resolveTab({ workspace: "w", project: "p", tab: "bash" }), AmbiguousTab);
});

test("readTerminal returns clean text + status", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  f.texts.set("a", "hello");
  const r = await make(f).readTerminal({ tabId: "a" });
  assert.equal(r.text, "hello");
  assert.equal(r.status, "running");
});

test("listTabs projects activity fields for running tabs and omits them for exited tabs", () => {
  const f = new FakeManager();
  const recent = Date.now();
  const active = f.add({ id: "active", title: "Claude", projectPath: "/ws/w/p", status: "running" });
  const old = f.add({ id: "old", title: "Done", projectPath: "/ws/w/p", status: "exited", exitCode: 0 });
  f.activityMap.set(active.id, { lastOutputAt: recent, attention: true });
  f.activityMap.set(old.id, { lastOutputAt: recent, attention: true });

  const out = make(f).listTabs({ workspace: "w", project: "p" });

  assert.equal(out[0].activity, "working");
  assert.equal(out[0].attention, true);
  assert.equal(out[0].lastOutputAt, new Date(recent).toISOString());
  assert.equal("activity" in out[1], false);
  assert.equal("attention" in out[1], false);
  assert.equal("lastOutputAt" in out[1], false);
});

test("readTerminal reports idle activity when output is older than the working window", async () => {
  const f = new FakeManager();
  const old = Date.now() - ACTIVITY_WORKING_MS - 1;
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p", status: "running" });
  f.activityMap.set("a", { lastOutputAt: old, attention: false });
  f.texts.set("a", "quiet");

  const r = await make(f).readTerminal({ tabId: "a" });

  assert.equal(r.text, "quiet");
  assert.equal(r.activity, "idle");
  assert.equal(r.attention, false);
  assert.equal(r.lastOutputAt, new Date(old).toISOString());
});

test("writeInput: no submit writes just the text (no CR)", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  await make(f).writeInput({ tabId: "a" }, "ls");
  assert.deepEqual(f.inputs, [{ id: "a", data: "ls" }]);
});

// #1 fix: submit must NOT be `${data}\r` in one write (a TUI paste-eats the trailing
// newline and never submits). Text first, then Enter as a SEPARATE, later keystroke.
test("writeInput: submit sends the text, then a separate Enter", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  const tc = make(f);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = tc.writeInput({ tabId: "a" }, "a long message", { submit: true });
    assert.deepEqual(f.inputs.at(-1), { id: "a", data: "a long message" }); // text only, no CR yet
    mock.timers.tick(1000);
    await p;
    assert.deepEqual(f.inputs.at(-1), { id: "a", data: "\r" }); // Enter arrives on its own
  } finally {
    mock.timers.reset();
  }
});

test("sendKeys encodes; unknown key → ToolError", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  const tc = make(f);
  tc.sendKeys({ tabId: "a" }, ["C-c", "Enter"]);
  assert.deepEqual(f.inputs.at(-1), { id: "a", data: "\x03\r" });
  assert.throws(() => tc.sendKeys({ tabId: "a" }, ["Nope"]), ToolError);
});

test("listLaunchers returns only enabled shells+agents", () => {
  const f = new FakeManager();
  const registry = { get: () => undefined, list: () => ({
    shells: [{ id: "bash", name: "bash", kind: "shell", enabled: true }],
    agents: [{ id: "claude", name: "Claude", kind: "agent", enabled: true, version: "1.2.3" },
             { id: "off", name: "Off", kind: "agent", enabled: false }],
    ides: [{ id: "code", name: "VS Code", kind: "ide", enabled: true }],
    fileExplorers: [], browsers: [],
  }) } as any;
  const out = make(f, { registry }).listLaunchers();
  assert.deepEqual(out.map((l) => l.id), ["bash", "claude"]);
});

test("waitForIdle settles after idleMs of quiet, returns captured text", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  f.texts.set("a", "done");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).waitForIdle({ tabId: "a" }, { idleMs: 1000, timeoutMs: 5000 });
    f.emitOutput("a", "working...");
    mock.timers.tick(500);
    f.emitOutput("a", "more");      // re-arms the idle timer
    mock.timers.tick(1000);          // 1000ms quiet → settle
    const r = await p;
    assert.equal(r.settled, true);
    assert.equal(r.text, "done");
    assert.equal(r.status, "running");
    assert.equal(f.subscriberCount("a"), 0); // unsubscribed
  } finally {
    mock.timers.reset();
  }
});

test("waitForIdle: exit settles immediately with status exited", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "bash", projectPath: "/ws/w/p" });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).waitForIdle({ tabId: "a" }, { idleMs: 1000 });
    f.tabs[0].status = "exited";
    f.tabs[0].exitCode = 0;
    f.emitExit("a", 0);
    const r = await p;
    assert.equal(r.settled, true);
    assert.equal(r.status, "exited");
  } finally {
    mock.timers.reset();
  }
});

test("waitForIdle: hard cap → settled:false", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).waitForIdle({ tabId: "a" }, { idleMs: 10_000, timeoutMs: 2000 });
    f.emitOutput("a", "still going");
    mock.timers.tick(2000);          // cap fires before idle
    const r = await p;
    assert.equal(r.settled, false);
  } finally {
    mock.timers.reset();
  }
});

test("waitForIdle: abort returns aborted, skips capture, cleans up", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  const ac = new AbortController();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).waitForIdle({ tabId: "a" }, { idleMs: 10_000, signal: ac.signal });
    ac.abort();
    const r = await p;
    assert.equal(r.aborted, true);
    assert.equal(r.settled, false);
    assert.equal(r.text, "");
    assert.equal(f.subscriberCount("a"), 0);
  } finally {
    mock.timers.reset();
  }
});

test("waitForAttention returns immediately for already attention-flagged tabs", async () => {
  const f = new FakeManager();
  const recent = Date.now();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p", status: "running" });
  f.add({ id: "b", title: "Shell", projectPath: "/ws/w/p", status: "running" });
  f.activityMap.set("a", { lastOutputAt: recent, attention: true });
  f.activityMap.set("b", { lastOutputAt: recent, attention: false });

  const r = await make(f).waitForAttention({ workspace: "w", project: "p" });

  assert.equal(r.settled, true);
  assert.deepEqual(r.tabs, [{
    id: "a",
    title: "Claude",
    status: "running",
    activity: "working",
    attention: true,
    lastOutputAt: new Date(recent).toISOString(),
  }]);
});

test("waitForAttention waits for a watched bell and ignores other project and new tabs", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p", status: "running" });
  f.add({ id: "b", title: "Shell", projectPath: "/ws/w/p", status: "running" });
  f.add({ id: "c", title: "Other", projectPath: "/ws/w/other", status: "running" });
  const tc = make(f);
  let resolved = false;

  const p = tc.waitForAttention({ workspace: "w", project: "p" }, { timeoutMs: 5000 });
  p.then(() => { resolved = true; });

  f.ringBell("c");
  await Promise.resolve();
  assert.equal(resolved, false);

  f.add({ id: "d", title: "Late", projectPath: "/ws/w/p", status: "running" });
  f.ringBell("d");
  await Promise.resolve();
  assert.equal(resolved, false);

  f.ringBell("b");
  const r = await p;

  assert.equal(r.settled, true);
  assert.equal(r.tabs.length, 1);
  assert.equal(r.tabs[0].id, "b");
  assert.equal(r.tabs[0].title, "Shell");
  assert.equal(r.tabs[0].status, "running");
  assert.equal(r.tabs[0].activity, "working");
  assert.equal(r.tabs[0].attention, true);
  assert.equal(typeof r.tabs[0].lastOutputAt, "string");
});

test("waitForAttention resolves when a watched tab exits", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p", status: "running" });
  const p = make(f).waitForAttention({ tabId: "a" }, { timeoutMs: 5000 });

  f.lifecycleExit("a");
  const r = await p;

  assert.equal(r.settled, true);
  assert.deepEqual(r.tabs, [{ id: "a", title: "Claude", status: "exited" }]);
});

test("waitForAttention timeout returns unsettled and removes lifecycle listeners", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p", status: "running" });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).waitForAttention({ workspace: "w", project: "p" }, { timeoutMs: 2000 });
    assert.equal(f.lifecycle.listenerCount("activity"), 1);
    assert.equal(f.lifecycle.listenerCount("exited"), 1);
    mock.timers.tick(2000);
    const r = await p;
    assert.deepEqual(r, { tabs: [], settled: false });
    assert.equal(f.lifecycle.listenerCount("activity"), 0);
    assert.equal(f.lifecycle.listenerCount("exited"), 0);
  } finally {
    mock.timers.reset();
  }
});

test("waitForAttention abort returns aborted and unsettled", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p", status: "running" });
  const ac = new AbortController();
  const p = make(f).waitForAttention({ workspace: "w", project: "p" }, { signal: ac.signal });

  ac.abort();
  const r = await p;

  assert.deepEqual(r, { tabs: [], settled: false, aborted: true });
  assert.equal(f.lifecycle.listenerCount("activity"), 0);
  assert.equal(f.lifecycle.listenerCount("exited"), 0);
});

test("waitForAttention rejects projects with no running tabs but returns an explicit exited tab", async () => {
  const f = new FakeManager();
  f.add({ id: "old", title: "Done", projectPath: "/ws/w/p", status: "exited", exitCode: 0 });
  const tc = make(f);

  await assert.rejects(() => tc.waitForAttention({ workspace: "w", project: "p" }), ToolError);

  const r = await tc.waitForAttention({ tabId: "old" });
  assert.deepEqual(r, { tabs: [{ id: "old", title: "Done", status: "exited" }], settled: true });
});

test("sendAndWait writes the text before waiting, then a separate Enter on submit", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  f.texts.set("a", "4");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).sendAndWait({ tabId: "a" }, "2+2", { submit: true, idleMs: 500 });
    assert.deepEqual(f.inputs.at(-1), { id: "a", data: "2+2" }); // text written before waiting, no CR yet
    mock.timers.tick(200);                                        // past the submit delay → CR on its own
    assert.deepEqual(f.inputs.at(-1), { id: "a", data: "\r" });
    mock.timers.tick(500);                                        // 500ms quiet → settle
    const r = await p;
    assert.equal(r.text, "4");
    assert.equal(r.settled, true);
  } finally {
    mock.timers.reset();
  }
});

import { tmpdir } from "node:os";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FsSandboxError } from "@orquester/config/fs";

function registryWith(entries: Record<string, { kind: string; enabled: boolean }>) {
  return {
    get: (id: string) => (entries[id] ? { id, name: id, ...entries[id] } : undefined),
    list: () => ({ shells: [], agents: [], ides: [], fileExplorers: [], browsers: [] }),
  } as any;
}

test("createTab: launches a shell/agent in the project dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const f = new FakeManager();
  f.create = (req) => { f.created.push(req); return f.add({ id: "new", title: req.title ?? "bash", projectPath: req.projectPath ?? "" }); };
  const tc = make(f, { workspacesDir: root, fsRoot: root, registry: registryWith({ bash: { kind: "shell", enabled: true } }) });
  const s = await tc.createTab({ workspace: "w", project: "p" }, { refId: "bash" });
  assert.equal(s.id, "new");
  assert.equal(f.created[0].projectPath, join(root, "w", "p"));
  assert.equal(f.created[0].cwd, join(root, "w", "p"));
});

test("createTab: rejects a non-existent project (no ghost tab)", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-"));
  const f = new FakeManager();
  f.create = () => { throw new Error("should not be called"); };
  const tc = make(f, { workspacesDir: root, fsRoot: root, registry: registryWith({ bash: { kind: "shell", enabled: true } }) });
  await assert.rejects(() => tc.createTab({ workspace: "w", project: "missing" }, { refId: "bash" }), TabNotFound);
});

test("createTab: rejects a cwd outside fsRoot", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const f = new FakeManager();
  f.create = () => { throw new Error("should not be called"); };
  const tc = make(f, { workspacesDir: root, fsRoot: root, registry: registryWith({ bash: { kind: "shell", enabled: true } }) });
  await assert.rejects(() => tc.createTab({ workspace: "w", project: "p" }, { refId: "bash", cwd: "/etc" }), FsSandboxError);
});

test("createTab: rejects a non-shell/agent refId", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const f = new FakeManager();
  const tc = make(f, { workspacesDir: root, fsRoot: root, registry: registryWith({ code: { kind: "ide", enabled: true } }) });
  await assert.rejects(() => tc.createTab({ workspace: "w", project: "p" }, { refId: "code" }), ToolError);
});

test("createTab: rejects past the per-project cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const f = new FakeManager();
  for (let i = 0; i < 24; i++) f.add({ id: `t${i}`, title: "bash", projectPath: join(root, "w", "p"), status: "running" });
  const tc = make(f, { workspacesDir: root, fsRoot: root, registry: registryWith({ bash: { kind: "shell", enabled: true } }) });
  await assert.rejects(() => tc.createTab({ workspace: "w", project: "p" }, { refId: "bash" }), ToolError);
});

test("closeTab: closes the resolved tab", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  make(f).closeTab({ tabId: "a" });
  assert.deepEqual(f.closed, ["a"]);
});
