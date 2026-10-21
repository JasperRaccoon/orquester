import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AgentAccount, EventMessage, UsageResponse } from "@orquester/api";
import { USAGE_LIMIT_CONTINUE_MESSAGE, USAGE_LIMIT_RESUME_MARGIN_MS, type ThreadUsageLimitNotice } from "@orquester/api/agent-chat";
import { agentPrefsSchema, type AccountCooldown } from "@orquester/config";

import type { DaemonApi, DaemonMethod, DaemonRequestOptions, DaemonResponse } from "../mcp/daemon-api.ts";
import type { Clock, CooldownStore } from "../workflows/contracts.ts";
import { continueMessage } from "../workflows/agent/prompt.ts";
import { ChatSessionManager } from "./chat-sessions.ts";
import { ChatLimitRecovery, STALE_LIMIT_MS, limitCommandId, type LimitRecoveryPrefs } from "./limit-recovery.ts";
import { sanitizeUsageLimitNotice } from "./summary.ts";

const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const HOUR = 60 * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Manual timers: `advance` runs what came due, in order. Never a real sleep. */
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

function memoryCooldowns(clock: FakeClock): CooldownStore & { data: Record<string, AccountCooldown> } {
  const data: Record<string, AccountCooldown> = {};
  return {
    data,
    get: (family, account) => data[`${family}:${account}`] ?? null,
    set: async (family, account, cooldown) => {
      data[`${family}:${account}`] = cooldown;
    },
    list: () => Object.fromEntries(Object.entries(data).filter(([, c]) => Date.parse(c.until) > clock.t))
  };
}

interface Posted {
  path: string;
  body: Record<string, unknown>;
}

/** The daemon's own routes, faked: the head read, the turn / interrupt / account commands, the bus. */
class FakeApi implements DaemonApi {
  readonly fsRoot = "/w";
  readonly workspacesDir = "/w";
  posts: Posted[] = [];
  listeners = new Set<(event: EventMessage) => void>();
  turnAnswer: DaemonResponse = { status: 200, body: { seq: 7 } };
  accountAnswer: DaemonResponse = { status: 200, body: { seq: 8 } };
  /** Commands the host already received, by id (its receipts). */
  receipts = new Map<string, number>();
  interactionMode = "default";
  onAccount?: (accountId: string) => void;
  onInterrupt?: () => void;

  async request(method: DaemonMethod, path: string, opts?: DaemonRequestOptions): Promise<DaemonResponse> {
    if (method === "GET" && path.endsWith("/head")) {
      return {
        status: 200,
        body: {
          head: { session: { status: "ready", activeTurnId: null }, modelSelection: { model: "claude-opus" } },
          seq: 1,
          pending: { approvals: [], userInputs: [] },
          goal: null,
          interactionMode: this.interactionMode,
          startedTurnCount: 1,
          recentTurns: [],
          olderTurnCount: 0,
          runningTurn: null,
          lastSettledTurn: null
        }
      };
    }
    const body = (opts?.body ?? {}) as Record<string, unknown>;
    this.posts.push({ path, body });
    const commandId = String(body.commandId ?? "");
    if (this.receipts.has(commandId)) return { status: 200, body: { seq: this.receipts.get(commandId) } };
    if (path.endsWith("/account")) {
      if (this.accountAnswer.status < 400) {
        this.receipts.set(commandId, 8);
        this.onAccount?.(String(body.accountId));
      }
      return this.accountAnswer;
    }
    if (path.endsWith("/interrupt")) {
      this.receipts.set(commandId, 6);
      this.onInterrupt?.();
      return { status: 200, body: { seq: 6 } };
    }
    if (this.turnAnswer.status < 400) this.receipts.set(commandId, 7);
    return this.turnAnswer;
  }
  async uploadAttachment(): Promise<{ status: number; value: unknown }> {
    return { status: 500, value: null };
  }
  subscribe(listener: (event: EventMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(id: string): void {
    for (const listener of [...this.listeners]) listener({ id: "e", channel: "sessions", type: "session.updated", createdAt: iso(T0), payload: { id } });
  }
  async publishHtmlRender(): Promise<never> {
    throw new Error("unused");
  }
  async previewHtmlRender(): Promise<never> {
    throw new Error("unused");
  }
  turns(): Posted[] {
    return this.posts.filter((post) => post.path.endsWith("/turn"));
  }
}

function account(id: string, agent: AgentAccount["agent"] = "claude"): AgentAccount {
  return { id, agent, label: id.toUpperCase(), email: null, plan: null, needsReauth: false, createdAt: iso(T0), importedAt: iso(T0) };
}

interface Harness {
  clock: FakeClock;
  chat: ChatSessionManager;
  api: FakeApi;
  cooldowns: ReturnType<typeof memoryCooldowns>;
  prefs: LimitRecoveryPrefs;
  recovery: ChatLimitRecovery;
  usage: { value: UsageResponse };
  accounts: AgentAccount[];
}

function harness(opts: { refId?: string; accountId?: string; prefs?: Partial<LimitRecoveryPrefs>; attach?: boolean; chat?: ChatSessionManager; clock?: FakeClock; cooldowns?: ReturnType<typeof memoryCooldowns> } = {}): Harness {
  const clock = opts.clock ?? new FakeClock();
  const chat = opts.chat ?? new ChatSessionManager();
  if (!opts.chat) {
    chat.create({
      id: "s1",
      refId: opts.refId ?? "claude",
      title: "chat",
      projectPath: "/w/p",
      cwd: "/w/p",
      order: 0,
      accountId: opts.accountId ?? "acc1",
      home: opts.accountId === "" ? "system" : "account"
    });
  }
  const api = new FakeApi();
  const cooldowns = opts.cooldowns ?? memoryCooldowns(clock);
  const prefs: LimitRecoveryPrefs = { autoResume: true, switchAccount: false, ...opts.prefs };
  const usage = { value: { agents: [] } as UsageResponse };
  const accounts = [account("acc1"), account("acc2")];
  const recovery = new ChatLimitRecovery({
    chat,
    cooldowns,
    usage: { snapshot: () => usage.value },
    accounts: { list: () => ({ accounts, defaults: { claude: null, codex: null, grok: null } }) },
    prefs: async () => prefs,
    adapterOf: (refId) => (refId === "opencode" ? "opencode" : refId === "codex" ? "codex" : "claude"),
    clock,
    retryMs: 30_000,
    settleTimeoutMs: 10_000
  });
  recovery.start();
  if (opts.attach !== false) recovery.attachApi(api);
  return { clock, chat, api, cooldowns, prefs, recovery, usage, accounts };
}

function notice(extra: Partial<ThreadUsageLimitNotice> = {}): ThreadUsageLimitNotice {
  return { activityId: "a1", turnId: "turn-1", resetsAt: iso(T0 + HOUR), message: "Usage limit reached", at: iso(T0), parked: false, ...extra };
}

async function report(h: Harness, n: ThreadUsageLimitNotice | null): Promise<void> {
  h.recovery.onNotice("s1", n);
  await h.recovery.idle();
}

async function advance(h: Harness, ms: number): Promise<void> {
  h.clock.advance(ms);
  await h.recovery.idle();
}

test("settings: automatic resume is on and account failover is off by default", () => {
  const prefs = agentPrefsSchema.parse({});
  assert.equal(prefs.autoResumeLimitedChats, true);
  assert.equal(prefs.switchAccountOnUsageLimit, false);
});

test("a limit with a provider reset is recorded, armed and cools the account down", async () => {
  const h = harness();
  await report(h, notice());
  const state = h.chat.get("s1")?.usageLimit;
  assert.equal(state?.resetAt, iso(T0 + HOUR));
  assert.equal(state?.accountId, "acc1");
  assert.equal(state?.turnId, "turn-1");
  assert.equal(state?.autoResume, "armed");
  assert.equal(state?.resumeAt, iso(T0 + HOUR + USAGE_LIMIT_RESUME_MARGIN_MS));
  assert.equal(h.cooldowns.data["claude:acc1"]?.until, iso(T0 + HOUR));
  assert.equal(h.cooldowns.data["claude:acc1"]?.reason, "usage_limit");
  // Persisted on the tab record, so a restart rebuilds it.
  assert.equal(h.chat.records()[0]?.chat?.usageLimit?.autoResume, "armed");
  assert.equal(h.clock.pending(), 1);
});

test("at the reset plus the margin the continue message goes out, under the idempotent command id", async () => {
  const h = harness();
  h.api.interactionMode = "plan";
  await report(h, notice());
  await advance(h, HOUR);
  assert.equal(h.api.turns().length, 0, "not before the margin");
  await advance(h, USAGE_LIMIT_RESUME_MARGIN_MS);
  const [turn] = h.api.turns();
  assert.ok(turn);
  assert.equal(turn.body.input, USAGE_LIMIT_CONTINUE_MESSAGE);
  assert.equal(turn.body.commandId, `limit-resume:s1:turn-1:${T0 + HOUR}`);
  assert.equal(turn.body.ifIdle, true);
  assert.equal(turn.body.interactionMode, "plan", "the chat keeps its mode");
  assert.equal(h.chat.get("s1")?.usageLimit?.autoResume, "resuming");
  // The resume's own message clears the limit.
  await report(h, null);
  assert.equal(h.chat.get("s1")?.usageLimit, null);
});

test("a resume that hits the limit again re-arms with the new reset", async () => {
  const h = harness();
  await report(h, notice());
  await advance(h, HOUR + USAGE_LIMIT_RESUME_MARGIN_MS);
  assert.equal(h.api.turns().length, 1);
  await report(h, null);
  await report(h, notice({ activityId: "a2", turnId: "turn-2", resetsAt: iso(T0 + 3 * HOUR), at: iso(h.clock.t) }));
  const state = h.chat.get("s1")?.usageLimit;
  assert.equal(state?.autoResume, "armed");
  assert.equal(state?.resumeAt, iso(T0 + 3 * HOUR + USAGE_LIMIT_RESUME_MARGIN_MS));
  await advance(h, 2 * HOUR);
  assert.equal(h.api.turns().length, 2);
  assert.equal(h.api.turns()[1]?.body.commandId, `limit-resume:s1:turn-2:${T0 + 3 * HOUR}`);
});

test("the same limit seen again (a later row of the same turn) keeps the user's choice", async () => {
  const h = harness();
  await report(h, notice({ parked: true }));
  await h.recovery.setAutoResume("s1", false);
  await report(h, notice({ activityId: "a9", parked: false }));
  const state = h.chat.get("s1")?.usageLimit;
  assert.equal(state?.autoResume, "off");
  assert.equal(state?.userCancelled, true);
  assert.equal(state?.noticeId, "a9");
  assert.equal(state?.parked, false);
});

test("no reset from the provider: the usage reading's reset of the burnt window is used", async () => {
  const h = harness();
  h.usage.value = {
    agents: [
      {
        id: "claude",
        available: true,
        stale: false,
        session: null,
        weekly: null,
        accounts: [{ id: "acc1", available: true, stale: false, asOf: iso(T0), session: { percent: 100, resetsAt: iso(T0 + 2 * HOUR) }, weekly: { percent: 40 } }]
      }
    ]
  } as UsageResponse;
  await report(h, notice({ resetsAt: undefined }));
  assert.equal(h.chat.get("s1")?.usageLimit?.resetAt, iso(T0 + 2 * HOUR));
  assert.equal(h.chat.get("s1")?.usageLimit?.autoResume, "armed");
});

test("no reset known at all: limited, never scheduled; an old one or a past reset is history", async () => {
  const h = harness();
  await report(h, notice({ resetsAt: undefined }));
  assert.equal(h.chat.get("s1")?.usageLimit?.autoResume, "unscheduled");
  assert.equal(h.chat.get("s1")?.usageLimit?.resumeAt, null);
  assert.equal(h.clock.pending(), 0);
  await advance(h, 10 * HOUR);
  assert.equal(h.api.turns().length, 0);

  const old = harness();
  await report(old, notice({ resetsAt: undefined, at: iso(T0 - STALE_LIMIT_MS - 1) }));
  assert.equal(old.chat.get("s1")?.usageLimit, undefined);
  const past = harness();
  await report(past, notice({ resetsAt: iso(T0 - 60_000), at: iso(T0 - 8 * HOUR) }));
  assert.equal(past.chat.get("s1")?.usageLimit, undefined, "a reset already past at detection never resumes");
  const fresh = harness();
  await report(fresh, notice({ resetsAt: iso(T0 - 60_000) }));
  assert.equal(fresh.chat.get("s1")?.usageLimit?.autoResume, "off", "a fresh limit with an expired reset is shown, not resumed");
  assert.equal(fresh.chat.get("s1")?.usageLimit?.resetAt, iso(T0 - 60_000));
  assert.equal(fresh.clock.pending(), 0);
});

test("skip rules: the user writing, a pending approval, a cancelled resume, a closed chat, a busy chat", async () => {
  const wrote = harness();
  await report(wrote, notice());
  await report(wrote, null);
  await advance(wrote, 2 * HOUR);
  assert.equal(wrote.api.turns().length, 0);
  assert.equal(wrote.chat.get("s1")?.usageLimit, null);

  const approval = harness();
  await report(approval, notice());
  approval.chat.applyFields("s1", { hasPendingApprovals: true });
  await advance(approval, 2 * HOUR);
  assert.equal(approval.api.turns().length, 0);
  assert.equal(approval.chat.get("s1")?.usageLimit?.autoResume, "off", "disarmed");

  const cancelled = harness();
  await report(cancelled, notice());
  await cancelled.recovery.setAutoResume("s1", false);
  await advance(cancelled, 2 * HOUR);
  assert.equal(cancelled.api.turns().length, 0);

  const closed = harness();
  await report(closed, notice());
  closed.chat.close("s1");
  await advance(closed, 2 * HOUR);
  assert.equal(closed.api.turns().length, 0);
  assert.equal(closed.clock.pending(), 0);

  const busy = harness();
  await report(busy, notice());
  busy.api.turnAnswer = { status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "busy" } } };
  await advance(busy, 2 * HOUR);
  assert.equal(busy.api.turns().length, 1);
  assert.equal(busy.chat.get("s1")?.usageLimit?.autoResume, "off", "a busy chat is not resumed and not retried");
  assert.equal(busy.clock.pending(), 0);
});

test("the host restarting at the resume retries it later, under the same command id", async () => {
  const h = harness();
  await report(h, notice());
  h.api.turnAnswer = { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } };
  await advance(h, HOUR + USAGE_LIMIT_RESUME_MARGIN_MS);
  assert.equal(h.chat.get("s1")?.usageLimit?.autoResume, "armed");
  h.api.turnAnswer = { status: 200, body: { seq: 9 } };
  await advance(h, 30_000);
  const turns = h.api.turns();
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.body.commandId, turns[1]?.body.commandId);
});

test("re-arm after cancelling, and the setting turning off disarms every armed chat", async () => {
  const h = harness();
  await report(h, notice());
  await h.recovery.setAutoResume("s1", false);
  assert.equal(h.clock.pending(), 0);
  await h.recovery.setAutoResume("s1", true);
  assert.equal(h.chat.get("s1")?.usageLimit?.autoResume, "armed");
  assert.equal(h.chat.get("s1")?.usageLimit?.userCancelled, undefined);
  h.recovery.prefsChanged({ autoResume: false, switchAccount: false });
  await h.recovery.idle();
  assert.equal(h.chat.get("s1")?.usageLimit?.autoResume, "off");
  h.recovery.prefsChanged({ autoResume: true, switchAccount: false });
  await h.recovery.idle();
  assert.equal(h.chat.get("s1")?.usageLimit?.autoResume, "armed", "the setting re-arms what it disarmed");
  await assert.rejects(
    (async () => {
      const unknown = harness();
      await report(unknown, notice({ resetsAt: undefined }));
      await unknown.recovery.setAutoResume("s1", true);
    })(),
    /reset time is unknown/
  );
});

test("boot: a persisted schedule is rebuilt, and a reset that passed while the daemon was down resumes at once", async () => {
  const first = harness();
  await report(first, notice());
  first.recovery.stop();
  // The daemon is down past the reset; the next boot adopts the same records.
  const records = first.chat.records();
  const chat = new ChatSessionManager();
  chat.adopt(records);
  const clock = new FakeClock();
  clock.t = T0 + 3 * HOUR;
  const next = harness({ chat, clock, attach: false });
  assert.equal(next.api.turns().length, 0, "nothing goes out before the daemon's API is bound");
  next.recovery.attachApi(next.api);
  await advance(next, 0);
  assert.equal(next.api.turns().length, 1);
  assert.equal(next.api.turns()[0]?.body.commandId, `limit-resume:s1:turn-1:${T0 + HOUR}`);
});

test("boot: an action cut short by a restart runs again under its own command id (receipts dedupe it)", async () => {
  const first = harness();
  await report(first, notice());
  first.api.turnAnswer = { status: 200, body: { seq: 7 } };
  await advance(first, HOUR + USAGE_LIMIT_RESUME_MARGIN_MS);
  assert.equal(first.chat.get("s1")?.usageLimit?.autoResume, "resuming");
  const chat = new ChatSessionManager();
  chat.adopt(first.chat.records());
  const next = harness({ chat, attach: false });
  next.api.receipts = first.api.receipts;
  next.recovery.attachApi(next.api);
  await next.recovery.idle();
  assert.equal(next.api.turns().length, 1);
  assert.equal(next.api.turns()[0]?.body.commandId, first.api.turns()[0]?.body.commandId);
});

test("failover (opt-in): moves to the least-used other account and continues with the workflows' message", async () => {
  const h = harness({ prefs: { switchAccount: true } });
  h.api.onAccount = (accountId) => h.chat.setAccount("s1", { accountId, home: "account" });
  await report(h, notice());
  const account = h.api.posts.find((post) => post.path.endsWith("/account"));
  assert.equal(account?.body.accountId, "acc2");
  const [turn] = h.api.turns();
  assert.equal(turn?.body.input, continueMessage(false, "usage_limit"));
  assert.deepEqual(h.chat.get("s1")?.limitFailover, { fromAccountId: "acc1", toAccountId: "acc2", at: iso(T0), automatic: true });
  await h.recovery.dismissFailover("s1");
  assert.equal(h.chat.get("s1")?.limitFailover, null);
});

test("failover with every other account cooling down falls back to the resume at the earliest reset", async () => {
  const h = harness({ prefs: { switchAccount: true } });
  await h.cooldowns.set("claude", "acc2", { until: iso(T0 + 30 * 60_000), reason: "usage_limit", setAt: iso(T0) });
  await report(h, notice());
  assert.equal(h.api.posts.filter((post) => post.path.endsWith("/account")).length, 0);
  assert.equal(h.chat.get("s1")?.usageLimit?.autoResume, "armed");
  assert.equal(h.chat.get("s1")?.usageLimit?.resumeAt, iso(T0 + 30 * 60_000 + USAGE_LIMIT_RESUME_MARGIN_MS));
  // At acc2's reset the chat moves to it.
  h.api.onAccount = (accountId) => h.chat.setAccount("s1", { accountId, home: "account" });
  await advance(h, 30 * 60_000 + USAGE_LIMIT_RESUME_MARGIN_MS);
  assert.equal(h.api.posts.find((post) => post.path.endsWith("/account"))?.body.accountId, "acc2");
  assert.equal(h.api.turns().length, 1);
});

test("never fails over for OpenCode: it only resumes", async () => {
  const h = harness({ refId: "opencode", accountId: "", prefs: { switchAccount: true } });
  await report(h, notice());
  assert.equal(h.api.posts.filter((post) => post.path.endsWith("/account")).length, 0);
  assert.equal(h.chat.get("s1")?.usageLimit?.autoResume, "armed");
  await assert.rejects(h.recovery.switchAndContinue("s1", { commandId: "c1" }), /cannot be switched/);
});

test("manual switch and resume now: idempotent by the client's command id, refused when nothing is limited", async () => {
  const h = harness();
  await assert.rejects(h.recovery.resumeNow("s1", "c0"), /not stopped on a usage limit/);
  await report(h, notice());
  h.api.onAccount = (accountId) => h.chat.setAccount("s1", { accountId, home: "account" });
  const answer = await h.recovery.switchAndContinue("s1", { commandId: "c1" });
  assert.equal(answer.limitFailover?.toAccountId, "acc2");
  assert.equal(answer.limitFailover?.automatic, false);
  assert.equal(h.api.turns()[0]?.body.commandId, "c1:turn");

  const now = harness();
  await report(now, notice());
  await now.recovery.resumeNow("s1", "c2");
  assert.equal(now.api.turns()[0]?.body.commandId, "c2");
  assert.equal(now.api.turns()[0]?.body.input, USAGE_LIMIT_CONTINUE_MESSAGE);
  assert.equal(now.clock.pending(), 0, "the schedule is gone once resumed");
});

test("a parked turn is interrupted, and the resume waits for it to settle on the bus", async () => {
  const h = harness();
  h.chat.applyFields("s1", { latestTurn: { turnId: "turn-1", state: "running", startedAt: iso(T0), completedAt: null }, chatSessionStatus: "running" });
  h.api.onInterrupt = () => {
    queueMicrotask(() => {
      h.chat.applyFields("s1", { latestTurn: { turnId: "turn-1", state: "interrupted", startedAt: iso(T0), completedAt: iso(T0) }, chatSessionStatus: "ready" });
      h.api.emit("s1");
    });
  };
  await report(h, notice({ parked: true }));
  await h.recovery.resumeNow("s1", "c3");
  const interrupt = h.api.posts.find((post) => post.path.endsWith("/interrupt"));
  assert.equal(interrupt?.body.commandId, "c3:interrupt");
  assert.equal(interrupt?.body.turnId, "turn-1");
  assert.equal(h.api.turns()[0]?.body.commandId, "c3");
});

test("workflow-owned chats are left to the workflow engine", async () => {
  const chat = new ChatSessionManager();
  chat.create({
    id: "s1",
    refId: "claude",
    title: "wf",
    projectPath: "/w/p",
    cwd: "/w/p",
    order: 0,
    accountId: "acc1",
    home: "account",
    owner: { kind: "workflow", workflowId: "w", runId: "r", nodeId: "n" }
  });
  const h = harness({ chat });
  await report(h, notice());
  assert.equal(h.chat.get("s1")?.usageLimit, undefined);
});

test("command ids stay within the route's bound", () => {
  const id = limitCommandId("limit-resume", "s".repeat(40), "t".repeat(400), "123");
  assert.ok(id.length <= 160);
  assert.ok(id.startsWith("limit-resume:"));
  assert.equal(limitCommandId("limit-resume", "s1", "turn-1", "5"), "limit-resume:s1:turn-1:5");
});

test("the summary's usageLimit is read tolerantly", () => {
  assert.equal(sanitizeUsageLimitNotice({}), undefined, "an older host sends no field");
  assert.equal(sanitizeUsageLimitNotice({ usageLimit: null }), null);
  assert.equal(sanitizeUsageLimitNotice({ usageLimit: { activityId: 3 } }), null, "malformed is none");
  assert.deepEqual(sanitizeUsageLimitNotice({ usageLimit: { activityId: "a", turnId: null, at: iso(T0), resetsAt: "soon", parked: "yes" } }), {
    activityId: "a",
    turnId: null,
    message: "",
    at: iso(T0),
    parked: false
  });
});
