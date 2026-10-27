import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { SessionSummary } from "@orquester/api";
import { IDLE_COMPACTION_LEAD_MS, type IdleCompactionCandidate } from "@orquester/api/agent-chat";
import { agentPrefsSchema } from "@orquester/config";

import type { DaemonApi, DaemonMethod, DaemonRequestOptions, DaemonResponse } from "../mcp/daemon-api.ts";
import type { Clock } from "../workflows/contracts.ts";
import { ChatIdleCompaction, type IdleCompactionPrefs } from "./idle-compaction.ts";
import { sanitizeIdleCompactionCandidate } from "./summary.ts";

const T0 = Date.parse("2026-10-22T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Manual timers: `advance` runs what came due, in order. Never a real sleep. The service decides
 * asynchronously after a wake, at the clock's time once `advance` returned: advance to a window's
 * start, not past its end.
 */
class FakeClock implements Clock {
  t = T0;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  now(): Date {
    return new Date(this.t);
  }
  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const timer = { at: this.t + Math.max(0, ms), fn, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => void (timer.cancelled = true) };
  }
  pending(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
  nextAt(): number | null {
    const live = this.timers.filter((timer) => !timer.cancelled).map((timer) => timer.at);
    return live.length === 0 ? null : Math.min(...live);
  }
  advance(ms: number): void {
    this.t += ms;
    for (;;) {
      const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.t).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      due.cancelled = true;
      due.fn();
    }
  }
}

/** The host behind the daemon's compact route, faked: receipts by command id, one compaction each. */
class FakeHost implements DaemonApi {
  readonly fsRoot = "/w";
  readonly workspacesDir = "/w";
  posts: { path: string; body: Record<string, unknown> }[] = [];
  /** Compactions the host actually ran (a repeated command id answers its receipt instead). */
  compactions: string[] = [];
  receipts = new Map<string, number>();
  answer: DaemonResponse | null = null;
  async request(_method: DaemonMethod, path: string, opts?: DaemonRequestOptions): Promise<DaemonResponse> {
    const body = (opts?.body ?? {}) as Record<string, unknown>;
    this.posts.push({ path, body });
    if (this.answer) return this.answer;
    const commandId = String(body.commandId);
    const seen = this.receipts.get(commandId);
    if (seen !== undefined) return { status: 200, body: { seq: seen } };
    this.compactions.push(commandId);
    this.receipts.set(commandId, this.receipts.size + 10);
    return { status: 200, body: { seq: this.receipts.get(commandId) } };
  }
  async uploadAttachment(): Promise<{ status: number; value: unknown }> {
    throw new Error("not used");
  }
  subscribe(): () => void {
    return () => undefined;
  }
  async publishHtmlRender(): Promise<never> {
    throw new Error("not used");
  }
  async previewHtmlRender(): Promise<never> {
    throw new Error("not used");
  }
}

class FakeChat {
  readonly lifecycle = new EventEmitter();
  tabs = new Map<string, SessionSummary>();
  get(id: string): SessionSummary | undefined {
    return this.tabs.get(id);
  }
  list(): SessionSummary[] {
    return [...this.tabs.values()];
  }
  close(id: string): void {
    this.tabs.delete(id);
    this.lifecycle.emit("closed", { id });
  }
}

function chatTab(extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s1",
    kind: "agent-chat",
    refId: "claude",
    accountId: "acc1",
    title: "chat",
    projectPath: "/w/p",
    cwd: "/w/p",
    cols: 80,
    rows: 24,
    status: "running",
    order: 0,
    createdAt: iso(T0 - HOUR),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    latestTurn: { turnId: "t1", state: "completed", startedAt: iso(T0 - MINUTE), completedAt: iso(T0) },
    chatSessionStatus: "ready",
    goal: null,
    ...extra
  } as SessionSummary;
}

/** The host's candidate after turn `turnId`, its cache written `writtenAgo` before T0 with `ttl`. */
function candidate(turnId = "t1", ttl = HOUR, usedTokens = 250_000, writtenAt = T0): IdleCompactionCandidate {
  return { turnId, usedTokens, promptCacheExpiresAt: iso(writtenAt + ttl), promptCacheTtlMs: ttl };
}

interface Harness {
  clock: FakeClock;
  chat: FakeChat;
  host: FakeHost;
  prefs: IdleCompactionPrefs;
  service: ChatIdleCompaction;
}

function harness(opts: { prefs?: Partial<IdleCompactionPrefs>; clock?: FakeClock; chat?: FakeChat; host?: FakeHost; attach?: boolean } = {}): Harness {
  const clock = opts.clock ?? new FakeClock();
  const chat = opts.chat ?? new FakeChat();
  if (!opts.chat) chat.tabs.set("s1", chatTab());
  const host = opts.host ?? new FakeHost();
  const prefs: IdleCompactionPrefs = {
    ...agentPrefsSchema.parse({ claudeIdleCompaction: "beforeCacheExpires" }),
    ...opts.prefs
  };
  const service = new ChatIdleCompaction({
    chat,
    prefs: async () => prefs,
    adapterOf: (refId) => (refId === "claude" ? "claude" : refId === "codex" ? "codex" : null),
    clock,
    retryMs: 15_000
  });
  service.start();
  if (opts.attach !== false) service.attachApi(host);
  return { clock, chat, host, prefs, service };
}

async function settle(h: Harness): Promise<void> {
  await h.service.idle();
}

async function advance(h: Harness, ms: number): Promise<void> {
  h.clock.advance(ms);
  await settle(h);
}

test("a 1h cache is compacted two minutes before it expires, once, under the turn's command id", async () => {
  const h = harness();
  h.service.onCandidate("s1", candidate("t1", HOUR));
  await settle(h);
  assert.equal(h.clock.nextAt(), T0 + HOUR - IDLE_COMPACTION_LEAD_MS);
  await advance(h, HOUR - IDLE_COMPACTION_LEAD_MS - 1);
  assert.equal(h.host.posts.length, 0);
  await advance(h, 1);
  assert.deepEqual(h.host.posts, [
    {
      path: "/api/sessions/s1/compact",
      body: { commandId: "idle-compact:s1:t1", idle: { turnId: "t1" } }
    }
  ]);
  // Polls that report the same thing again never post again.
  h.service.onCandidate("s1", candidate("t1", HOUR));
  h.service.prefsChanged();
  await advance(h, MINUTE);
  assert.equal(h.host.posts.length, 1);
});

test("a 5m cache is compacted at minute 3", async () => {
  const h = harness();
  h.service.onCandidate("s1", candidate("t1", 5 * MINUTE));
  await settle(h);
  assert.equal(h.clock.nextAt(), T0 + 3 * MINUTE);
  await advance(h, 3 * MINUTE);
  assert.equal(h.host.compactions.length, 1);
});

test("only 'before the cache expires' compacts; an account's override wins over the default", async () => {
  for (const mode of ["onReturn", "off"] as const) {
    const h = harness({ prefs: { claudeIdleCompaction: mode } });
    h.service.onCandidate("s1", candidate());
    await advance(h, HOUR - IDLE_COMPACTION_LEAD_MS);
    assert.equal(h.host.posts.length, 0, mode);
  }
  const overridden = harness({ prefs: { claudeIdleCompaction: "beforeCacheExpires", claudeIdleCompactionByAccount: { acc1: "off" } } });
  overridden.service.onCandidate("s1", candidate());
  await advance(overridden, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.equal(overridden.host.posts.length, 0);
  const optedIn = harness({ prefs: { claudeIdleCompaction: "off", claudeIdleCompactionByAccount: { system: "beforeCacheExpires" } } });
  optedIn.chat.tabs.set("s1", chatTab({ accountId: "" }));
  optedIn.service.onCandidate("s1", candidate());
  await advance(optedIn, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.equal(optedIn.host.compactions.length, 1, "the system login's override");
});

test("never another agent's chat", async () => {
  const h = harness();
  h.chat.tabs.set("s1", chatTab({ refId: "codex" }));
  h.service.onCandidate("s1", candidate());
  await advance(h, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.equal(h.host.posts.length, 0);
});

test("each guard on the tab keeps it from compacting", async () => {
  const guards: Partial<SessionSummary>[] = [
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { hasActionableProposedPlan: true },
    { backgroundLiveness: "working" },
    { chatSessionStatus: "running" },
    { goal: { objective: "ship", status: "active", continuing: true } },
    { lineage: { parentThreadId: "p", relation: "delegate", createdAt: iso(T0) } },
    { owner: { kind: "workflow", workflowId: "w", runId: "r", nodeId: "n" } },
    { latestTurn: { turnId: "t1", state: "interrupted", startedAt: null, completedAt: iso(T0) } }
  ];
  for (const guard of guards) {
    const h = harness();
    h.chat.tabs.set("s1", chatTab(guard));
    h.service.onCandidate("s1", candidate());
    await advance(h, HOUR - IDLE_COMPACTION_LEAD_MS);
    assert.equal(h.host.posts.length, 0, JSON.stringify(guard));
  }
  const small = harness();
  small.service.onCandidate("s1", candidate("t1", HOUR, 199_999));
  await advance(small, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.equal(small.host.posts.length, 0, "under 200k tokens");
});

test("a guard that clears inside the window lets it go out; one that appears cancels it", async () => {
  const h = harness();
  h.chat.tabs.set("s1", chatTab({ backgroundLiveness: "working" }));
  h.service.onCandidate("s1", candidate());
  await advance(h, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.equal(h.host.posts.length, 0);
  // The background work ends inside the window: the next poll moves the inputs.
  h.chat.tabs.set("s1", chatTab());
  h.service.onCandidate("s1", candidate());
  await settle(h);
  assert.equal(h.host.compactions.length, 1);

  const later = harness();
  later.service.onCandidate("s1", candidate());
  await settle(later);
  assert.equal(later.clock.pending(), 1);
  later.chat.tabs.set("s1", chatTab({ hasPendingUserInput: true }));
  later.service.onCandidate("s1", candidate());
  await settle(later);
  assert.equal(later.clock.pending(), 0);
  await advance(later, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.equal(later.host.posts.length, 0);
});

test("the user sending (a new turn) cancels the timer, and the next turn's own window replaces it", async () => {
  const h = harness();
  h.service.onCandidate("s1", candidate("t1"));
  await settle(h);
  // The message went out: the turn runs, the host reports no candidate.
  h.chat.tabs.set("s1", chatTab({ latestTurn: { turnId: "t2", state: "running", startedAt: iso(T0), completedAt: null }, chatSessionStatus: "running" }));
  h.service.onCandidate("s1", null);
  await settle(h);
  assert.equal(h.clock.pending(), 0);
  // The new turn completes ten minutes in: its cache expires an hour after its own request.
  await advance(h, 10 * MINUTE);
  h.chat.tabs.set("s1", chatTab({ latestTurn: { turnId: "t2", state: "completed", startedAt: null, completedAt: iso(h.clock.t) } }));
  h.service.onCandidate("s1", candidate("t2", HOUR, 250_000, h.clock.t));
  await settle(h);
  assert.equal(h.clock.nextAt(), T0 + 10 * MINUTE + HOUR - IDLE_COMPACTION_LEAD_MS);
  await advance(h, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.deepEqual(h.host.compactions, ["idle-compact:s1:t2"]);
});

test("closing the tab or turning the setting off cancels it", async () => {
  const closed = harness();
  closed.service.onCandidate("s1", candidate());
  await settle(closed);
  closed.chat.close("s1");
  assert.equal(closed.clock.pending(), 0);
  await advance(closed, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.equal(closed.host.posts.length, 0);

  const switched = harness();
  switched.service.onCandidate("s1", candidate());
  await settle(switched);
  switched.prefs.claudeIdleCompaction = "onReturn";
  switched.service.prefsChanged();
  await settle(switched);
  assert.equal(switched.clock.pending(), 0);
  await advance(switched, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.equal(switched.host.posts.length, 0);
  // And back on: armed again, from the same log-derived window.
  switched.clock.t = T0;
  switched.prefs.claudeIdleCompaction = "beforeCacheExpires";
  switched.service.prefsChanged();
  await settle(switched);
  assert.equal(switched.clock.pending(), 1);
});

test("a restart re-arms from the host's candidate alone; one inside the window fires at once, one past it never", async () => {
  // Before the window: the new process arms the same timer.
  const clock = new FakeClock();
  const host = new FakeHost();
  const first = harness({ clock, host });
  first.service.onCandidate("s1", candidate());
  await settle(first);
  first.service.stop();
  assert.equal(clock.pending(), 0);
  clock.t = T0 + 30 * MINUTE;
  const second = harness({ clock, host });
  second.service.onCandidate("s1", candidate());
  await settle(second);
  assert.equal(clock.nextAt(), T0 + HOUR - IDLE_COMPACTION_LEAD_MS);

  // Down across the window's start: compacts the moment the first poll reports it.
  const late = harness({ clock: Object.assign(new FakeClock(), { t: T0 + HOUR - MINUTE }) });
  late.service.onCandidate("s1", candidate());
  await settle(late);
  assert.deepEqual(late.host.compactions, ["idle-compact:s1:t1"]);

  // Down past the expiry: the cache is gone, nothing is sent.
  const gone = harness({ clock: Object.assign(new FakeClock(), { t: T0 + HOUR }) });
  gone.service.onCandidate("s1", candidate());
  await advance(gone, HOUR);
  assert.equal(gone.host.posts.length, 0);
});

test("no double compaction: a restart in the window re-posts the same command id, which the host answers from its receipt", async () => {
  const clock = Object.assign(new FakeClock(), { t: T0 + HOUR - MINUTE });
  const host = new FakeHost();
  const first = harness({ clock, host });
  first.service.onCandidate("s1", candidate());
  await settle(first);
  first.service.stop();
  // A restart before the host's next summary moved on (the compaction still starting).
  const second = harness({ clock, host });
  second.service.onCandidate("s1", candidate());
  await settle(second);
  assert.equal(host.posts.length, 2);
  assert.equal(host.posts[0]?.body.commandId, host.posts[1]?.body.commandId);
  assert.deepEqual(host.compactions, ["idle-compact:s1:t1"]);
});

test("an unavailable host is tried again until the window closes; a refusal waits for the chat to change", async () => {
  const h = harness();
  h.host.answer = { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } };
  h.service.onCandidate("s1", candidate());
  await advance(h, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.equal(h.host.posts.length, 1);
  await advance(h, 15_000);
  assert.equal(h.host.posts.length, 2);
  h.host.answer = null;
  await advance(h, 15_000);
  assert.deepEqual(h.host.compactions, ["idle-compact:s1:t1"]);

  const refused = harness();
  refused.host.answer = { status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "moved on" } } };
  refused.service.onCandidate("s1", candidate());
  await advance(refused, HOUR - IDLE_COMPACTION_LEAD_MS);
  await advance(refused, IDLE_COMPACTION_LEAD_MS);
  assert.equal(refused.host.posts.length, 1);
});

test("before the daemon's API is bound it waits; binding it sends a compaction that came due", async () => {
  const h = harness({ attach: false });
  h.service.onCandidate("s1", candidate());
  await advance(h, HOUR - IDLE_COMPACTION_LEAD_MS);
  assert.equal(h.host.posts.length, 0);
  h.service.attachApi(h.host);
  await settle(h);
  assert.deepEqual(h.host.compactions, ["idle-compact:s1:t1"]);
});

test("the summary's candidate is validated field-wise", () => {
  assert.equal(sanitizeIdleCompactionCandidate({ pendingRequests: [] }), undefined);
  assert.equal(sanitizeIdleCompactionCandidate({ idleCompaction: null }), null);
  assert.equal(sanitizeIdleCompactionCandidate({ idleCompaction: { turnId: "t1", usedTokens: "lots", promptCacheExpiresAt: iso(T0) } }), null);
  assert.equal(sanitizeIdleCompactionCandidate({ idleCompaction: { turnId: "t1", usedTokens: 5, promptCacheExpiresAt: "later" } }), null);
  assert.deepEqual(
    sanitizeIdleCompactionCandidate({ idleCompaction: { turnId: "t1", usedTokens: 5, promptCacheExpiresAt: iso(T0), promptCacheTtlMs: -1, extra: true } }),
    { turnId: "t1", usedTokens: 5, promptCacheExpiresAt: iso(T0) }
  );
});
