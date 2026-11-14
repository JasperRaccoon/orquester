import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AgentChatSessionSummaryFields, EventMessage, SessionSummary } from "@orquester/api";
import {
  BUSY_SWITCH_CONTINUE_MESSAGE,
  BUSY_SWITCH_CONTINUE_MESSAGE_PLAIN,
  type ChatBusySwitchState
} from "@orquester/api/agent-chat";

import type { DaemonApi, DaemonMethod, DaemonRequestOptions, DaemonResponse } from "../mcp/daemon-api.ts";
import type { Clock } from "../workflows/contracts.ts";
import { ChatSessionManager } from "./chat-sessions.ts";
import { BUSY_SWITCH_FENCE_MESSAGE, ChatBusySwitch, busySwitchCommandId, busySwitchTurnRefusal } from "./busy-switch.ts";

const T0 = Date.parse("2026-11-14T06:00:00.000Z");
const SETTLE_MS = 10_000;

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

/** The daemon's own routes, faked: the head read, the interrupt and turn commands, the bus. */
class FakeApi implements DaemonApi {
  readonly fsRoot = "/w";
  readonly workspacesDir = "/w";
  posts: { path: string; body: Record<string, unknown> }[] = [];
  listeners = new Set<(event: EventMessage) => void>();
  receipts = new Map<string, number>();
  onInterrupt?: (body: Record<string, unknown>) => void;
  turnAnswer: DaemonResponse = { status: 200, body: { seq: 9 } };
  /** What the host's live head read adds (`compacting`, `goal`, `goalContinuesAcrossTurns`). */
  head: Record<string, unknown> = {};

  async request(method: DaemonMethod, path: string, opts?: DaemonRequestOptions): Promise<DaemonResponse> {
    if (method === "GET" && path.endsWith("/head")) {
      return { status: 200, body: { head: { session: { status: "ready", activeTurnId: null } }, interactionMode: "default", goal: null, ...this.head } };
    }
    const body = (opts?.body ?? {}) as Record<string, unknown>;
    this.posts.push({ path, body });
    const commandId = String(body.commandId ?? "");
    if (this.receipts.has(commandId)) return { status: 200, body: { seq: this.receipts.get(commandId) } };
    if (path.endsWith("/interrupt")) {
      this.receipts.set(commandId, 6);
      this.onInterrupt?.(body);
      return { status: 200, body: { seq: 6 } };
    }
    if (this.turnAnswer.status < 400) this.receipts.set(commandId, 9);
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
    for (const listener of [...this.listeners]) listener({ id: "e", channel: "sessions", type: "session.updated", createdAt: new Date(T0).toISOString(), payload: { id } });
  }
  async publishHtmlRender(): Promise<never> {
    throw new Error("unused");
  }
  async previewHtmlRender(): Promise<never> {
    throw new Error("unused");
  }
  interrupts(): Record<string, unknown>[] {
    return this.posts.filter((post) => post.path.endsWith("/interrupt")).map((post) => post.body);
  }
  turns(): Record<string, unknown>[] {
    return this.posts.filter((post) => post.path.endsWith("/turn")).map((post) => post.body);
  }
}

const IDLE: AgentChatSessionSummaryFields = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  backgroundLiveness: null,
  latestTurn: { turnId: "turn-1", state: "completed", startedAt: null, completedAt: null },
  chatSessionStatus: "ready",
  goal: null
};
const RUNNING: AgentChatSessionSummaryFields = {
  ...IDLE,
  latestTurn: { turnId: "turn-1", state: "running", startedAt: null, completedAt: null },
  chatSessionStatus: "running"
};

interface Harness {
  clock: FakeClock;
  chat: ChatSessionManager;
  api: FakeApi;
  busy: ChatBusySwitch;
  /** What happened, in order: each persisted step, each side effect. */
  log: string[];
  switches: { commandId: string; accountId: string; busySwitch?: true }[];
  notices: { commandId: string; summary: string; detail: string }[];
  /** The next switch fails with this. */
  refuseSwitch: Error | null;
  fields(fields: AgentChatSessionSummaryFields): void;
}

function harness(opts: { refId?: string; fields?: AgentChatSessionSummaryFields; chat?: ChatSessionManager; clock?: FakeClock; attach?: boolean } = {}): Harness {
  const clock = opts.clock ?? new FakeClock();
  const chat = opts.chat ?? new ChatSessionManager();
  if (!opts.chat) {
    chat.create({ id: "s1", refId: opts.refId ?? "claude", title: "chat", projectPath: "/w/p", cwd: "/w/p", order: 0, accountId: "acc1", home: "account" });
  }
  const api = new FakeApi();
  const log: string[] = [];
  let lastStep: string | null | undefined = chat.get("s1")?.accountSwitch?.step;
  // The broadcaster's part: a tab record's change reaches the bus.
  chat.lifecycle.on("updated", (summary: SessionSummary) => {
    const step = summary.accountSwitch === undefined ? undefined : (summary.accountSwitch?.step ?? null);
    if (step !== undefined && step !== lastStep) log.push(`persist:${step}`);
    lastStep = step;
    api.emit(summary.id);
  });
  const h: Harness = {
    clock,
    chat,
    api,
    log,
    switches: [],
    notices: [],
    refuseSwitch: null,
    fields: (fields) => {
      chat.applyFields("s1", fields);
    },
    busy: undefined as unknown as ChatBusySwitch
  };
  api.onInterrupt = (body) => log.push(`interrupt cascade=${String(body.cascade)}`);
  h.busy = new ChatBusySwitch({
    chat,
    switchAccount: async (id, input) => {
      h.switches.push(input);
      log.push(`switch busySwitch=${String(input.busySwitch === true)}`);
      const failure = h.refuseSwitch;
      h.refuseSwitch = null;
      if (failure) throw failure;
      chat.setAccount(id, { accountId: input.accountId === "system" ? "" : input.accountId, home: "account" });
      return { seq: 8 };
    },
    appendNotice: async (_id, input) => {
      h.notices.push(input);
      log.push("notice");
    },
    adapterOf: (refId) => (refId === "codex" ? "codex" : refId === "grok" ? "grok" : "claude"),
    clock,
    settleTimeoutMs: SETTLE_MS,
    retryMs: 5_000
  });
  const turnPost = api.request.bind(api);
  api.request = async (method, path, requestOpts) => {
    if (method === "POST" && path.endsWith("/turn")) log.push(`turn ${String((requestOpts?.body as { input?: unknown } | undefined)?.input).slice(0, 24)}`);
    return turnPost(method, path, requestOpts);
  };
  if (opts.fields) h.fields(opts.fields);
  h.busy.start();
  if (opts.attach !== false) h.busy.attachApi(api);
  return h;
}

/** The stopped work settles a macrotask after the interrupt, while the switch waits on the bus. */
function settlesAfterInterrupt(h: Harness, after: AgentChatSessionSummaryFields = IDLE): void {
  const previous = h.api.onInterrupt;
  h.api.onInterrupt = (body) => {
    previous?.(body);
    setImmediate(() => h.fields(after));
  };
}

test("a busy switch stops with cascade off, waits for idle on the bus, switches, then continues — each step persisted first", async () => {
  const h = harness({ fields: RUNNING });
  settlesAfterInterrupt(h);
  const answer = await h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" });

  assert.deepEqual(answer, { seq: 8 });
  assert.deepEqual(h.log, [
    "persist:stopping",
    "interrupt cascade=false",
    "persist:settling",
    "persist:switching",
    "switch busySwitch=true",
    "persist:continuing",
    `turn ${BUSY_SWITCH_CONTINUE_MESSAGE.slice(0, 24)}`,
    "persist:null"
  ]);
  assert.equal(h.api.interrupts()[0]?.turnId, undefined, "session-scoped: no turn named");
  assert.equal(h.api.interrupts()[0]?.commandId, busySwitchCommandId("s1", "sw-1", "interrupt"));
  assert.equal(h.switches[0]?.accountId, "acc2");
  assert.deepEqual(h.api.turns()[0], {
    input: BUSY_SWITCH_CONTINUE_MESSAGE,
    interactionMode: "default",
    ifIdle: true,
    commandId: busySwitchCommandId("s1", "sw-1", "continue")
  });
  assert.equal(h.chat.get("s1")?.accountSwitch, null);
  assert.equal(h.chat.get("s1")?.accountId, "acc2");
  assert.deepEqual(h.notices, []);
});

test("a repeat of the same command joins the switch in flight and answers the same after it; another command is refused meanwhile", async () => {
  const h = harness({ fields: RUNNING });
  settlesAfterInterrupt(h);
  const first = h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" });
  const repeat = h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" });
  await assert.rejects(h.busy.run("s1", { commandId: "sw-2", accountId: "acc2" }), /already in progress/);
  assert.deepEqual(await first, { seq: 8 });
  assert.deepEqual(await repeat, { seq: 8 });
  assert.deepEqual(await h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" }), { seq: 8 });
  assert.equal(h.api.interrupts().length, 1);
  assert.equal(h.switches.length, 1);
  assert.equal(h.api.turns().length, 1);
});

test("an idle chat, or the account it runs on, switches as without whileBusy: nothing stopped, nothing sent", async () => {
  const h = harness({ fields: IDLE });
  assert.deepEqual(await h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" }), { seq: 8 });
  const busy = harness({ fields: RUNNING });
  assert.deepEqual(await busy.busy.run("s1", { commandId: "sw-2", accountId: "acc1" }), { seq: 8 });
  for (const each of [h, busy]) {
    assert.deepEqual(each.switches.map((s) => s.busySwitch), [undefined], "the ordinary switch, the host's refusals all standing");
    assert.deepEqual(each.api.interrupts(), []);
    assert.deepEqual(each.api.turns(), []);
    assert.deepEqual(each.log.filter((line) => line.startsWith("persist")), []);
  }
  assert.deepEqual(h.switches[0], { commandId: "sw-1", accountId: "acc2" });
});

test("a continuing Codex goal is paused by the stop and resumed with /goal resume; work left after the turn gets a second session-scoped stop", async () => {
  const h = harness({ refId: "codex", fields: { ...RUNNING, goal: { objective: "ship it", status: "active", continuing: true } } });
  let interrupts = 0;
  h.api.onInterrupt = (body) => {
    h.log.push(`interrupt cascade=${String(body.cascade)}`);
    interrupts += 1;
    // The turn's interrupt settles the turn and pauses the goal; a subagent still reports until
    // the second, session-scoped stop with nothing running ends it.
    const after: AgentChatSessionSummaryFields = { ...IDLE, goal: { objective: "ship it", status: "paused", continuing: false } };
    setImmediate(() => h.fields(interrupts === 1 ? { ...after, backgroundLiveness: "working" } : after));
  };
  await h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" });

  assert.deepEqual(h.log, [
    "persist:stopping",
    "interrupt cascade=false",
    "persist:settling",
    "interrupt cascade=false",
    "persist:switching",
    "switch busySwitch=true",
    "persist:continuing",
    "turn /goal resume",
    "persist:null"
  ]);
  assert.equal(h.api.interrupts()[1]?.commandId, busySwitchCommandId("s1", "sw-1", "interrupt-background"));
  assert.equal(h.api.turns()[0]?.input, "/goal resume");
});

test("an active Codex goal past the summary's grace is still resumed: the stop pauses it whatever the grace says", async () => {
  const h = harness({ refId: "codex", fields: { ...RUNNING, goal: { objective: "ship it", status: "active", continuing: false } } });
  h.api.head = { goal: { objective: "ship it", status: "active" }, goalContinuesAcrossTurns: true };
  settlesAfterInterrupt(h, { ...IDLE, goal: { objective: "ship it", status: "paused", continuing: false } });
  await h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" });
  assert.deepEqual(h.api.turns().map((turn) => turn.input), ["/goal resume"]);
});

test("a running compaction refuses the switch before anything is stopped or persisted", async () => {
  const h = harness({ fields: RUNNING });
  h.api.head = { compacting: true };
  await assert.rejects(h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" }), {
    message: "Wait for the context compaction to finish before switching accounts.",
    code: "COMMAND_REJECTED"
  });
  assert.deepEqual(h.api.interrupts(), []);
  assert.deepEqual(h.switches, []);
  assert.equal(h.chat.get("s1")?.accountSwitch, undefined, "no fence was ever set");
  assert.deepEqual(h.notices, []);
});

test("a goal held for an update is not stopped: the switch applies at once and nothing is sent", async () => {
  const h = harness({ refId: "codex", fields: { ...IDLE, goal: { objective: "ship it", status: "paused", continuing: true } } });
  await h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" });
  assert.deepEqual(h.log, ["persist:settling", "persist:switching", "switch busySwitch=true", "persist:continuing", "persist:null"]);
  assert.deepEqual(h.api.interrupts(), []);
  assert.deepEqual(h.api.turns(), []);
  assert.equal(h.chat.get("s1")?.accountId, "acc2");
});

test("the fence refuses every other turn while the switch stands, but lets its own continue turn through", async () => {
  const h = harness({ fields: RUNNING });
  let fenced: { other: string | null; own: string | null } | null = null;
  h.api.onInterrupt = () => {
    const state = h.chat.accountSwitchOf("s1");
    fenced = {
      other: busySwitchTurnRefusal("s1", state, { commandId: "user-turn", input: "hi" }),
      own: busySwitchTurnRefusal("s1", state, { commandId: busySwitchCommandId("s1", "sw-1", "continue") })
    };
    setImmediate(() => h.fields(IDLE));
  };
  await h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" });
  assert.deepEqual(fenced, { other: BUSY_SWITCH_FENCE_MESSAGE, own: null });
  assert.equal(busySwitchTurnRefusal("s1", h.chat.accountSwitchOf("s1"), { commandId: "user-turn" }), null, "lifted once done");
});

test("work that never settles fails the switch: the fence lifts, the chat stays put, nothing is sent and the timeline says so", async () => {
  const h = harness({ refId: "codex", fields: { ...RUNNING, goal: { objective: "ship it", status: "active", continuing: true } } });
  const answer = h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" });
  await new Promise((resolve) => setImmediate(resolve));
  h.clock.advance(SETTLE_MS);
  await assert.rejects(answer, /not switched after stopping the work: The stopped work did not settle/);
  assert.equal(h.chat.get("s1")?.accountSwitch, null);
  assert.equal(h.chat.get("s1")?.accountId, "acc1");
  assert.deepEqual(h.switches, []);
  assert.deepEqual(h.api.turns(), []);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0]?.summary, "Account switch failed after stopping the work");
  assert.match(h.notices[0]!.detail, /did not settle.*Switch accounts again, or tell the agent to continue\. The goal stays paused; send \/goal resume/);
});

test("a host that refuses the switch after the stop fails it the same way", async () => {
  const h = harness({ refId: "grok", fields: RUNNING });
  settlesAfterInterrupt(h);
  h.refuseSwitch = new Error("Wait for the context compaction to finish before switching accounts.");
  await assert.rejects(h.busy.run("s1", { commandId: "sw-1", accountId: "acc2" }), /compaction/);
  assert.equal(h.chat.get("s1")?.accountSwitch, null);
  assert.deepEqual(h.api.turns(), []);
  assert.match(h.notices[0]!.detail, /refused the switch: Wait for the context compaction/);
});

test("a restart finishes a persisted switch from its step under the same command ids", async () => {
  const clock = new FakeClock();
  const chat = new ChatSessionManager();
  chat.create({ id: "s1", refId: "grok", title: "chat", projectPath: "/w/p", cwd: "/w/p", order: 0, accountId: "acc1", home: "account" });
  const persisted: ChatBusySwitchState = {
    commandId: "sw-1",
    fromAccountId: "acc1",
    toAccountId: "acc2",
    startedAt: new Date(T0 - 2_000).toISOString(),
    step: "switching",
    goal: null
  };
  chat.setAccountSwitch("s1", persisted);
  chat.applyFields("s1", IDLE);
  const h = harness({ chat, clock });
  await h.busy.idle();
  assert.deepEqual(h.log, ["switch busySwitch=true", "persist:continuing", `turn ${BUSY_SWITCH_CONTINUE_MESSAGE_PLAIN.slice(0, 24)}`, "persist:null"]);
  assert.equal(h.switches[0]?.commandId, busySwitchCommandId("s1", "sw-1", "account"));
  assert.equal(h.api.turns()[0]?.commandId, busySwitchCommandId("s1", "sw-1", "continue"));
  assert.deepEqual(h.api.interrupts(), [], "the stop it had already made is not made again");
});

test("a restart abandons a switch still stopping past the settle bound, with the warning row", async () => {
  const clock = new FakeClock();
  const chat = new ChatSessionManager();
  chat.create({ id: "s1", refId: "claude", title: "chat", projectPath: "/w/p", cwd: "/w/p", order: 0, accountId: "acc1", home: "account" });
  chat.setAccountSwitch("s1", {
    commandId: "sw-1",
    fromAccountId: "acc1",
    toAccountId: "acc2",
    startedAt: new Date(T0 - SETTLE_MS - 1).toISOString(),
    step: "settling",
    goal: null
  });
  const h = harness({ chat, clock });
  await h.busy.idle();
  assert.equal(h.chat.get("s1")?.accountSwitch, null);
  assert.deepEqual(h.switches, []);
  assert.deepEqual(h.api.interrupts(), []);
  assert.deepEqual(h.api.turns(), []);
  assert.equal(h.notices[0]?.commandId, busySwitchCommandId("s1", "sw-1", "notice"));
  assert.match(h.notices[0]!.detail, /Orquester restarted while it was switching the account/);
});
