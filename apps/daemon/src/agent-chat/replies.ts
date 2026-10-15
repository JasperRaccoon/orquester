/**
 * Reply subscriptions — the agent conversation protocol's reply half (unified MCP design
 * 2026-10-15 §8.3, §8.4, §13 d–e).
 *
 * `send_message` / `create_session` with `reply: "wait" | "notify"` reach {@link ReplyRouter.subscribe}
 * through the socket-only route `agentChatRoutes.replySubscriptions(target)`. The subscription is
 * written to `agent-reply-outbox.json` BEFORE the message goes anywhere; the message then enters
 * the target's delivery queue (`lineage.ts`, entry kind `message`) — persisted, posted at once to
 * an idle target, else as its next turn, never a steer — under the subscription's fixed
 * `commandId`. When the queue posts it, the router learns the post's receipt `seq` before the entry
 * leaves the queue, reads the events at that seq and binds the subscription to the user message the
 * command opened (`Turn.userMessageId`) — so the reply is that turn's final reply and nobody
 * else's.
 *
 * Exactly one consumer takes a settled reply (compare-and-set, every transition persisted before
 * its effect; JavaScript runs each CAS in one synchronous step):
 * - the router, on the bound turn settling: `waiting → claimed-by-waiter` when a waiter is
 *   attached (it is handed the result), else `waiting | notify → claimed-by-router` and the result
 *   becomes a delivery to the requester (the queue again, kind `reply`, a fixed command id);
 * - the waiter, on its timeout or the bound turn needing the target's user: `waiting → notify`; if
 *   the router won, the waiter returns what it is handed.
 * A wait that returns on needs-input leaves the subscription `notify`: the reply still comes.
 *
 * Restart (§13 e): `waiting` (no waiter survives) and `claimed-by-waiter` (its answer died with the
 * process) load as `notify`; once the daemon's API is bound and BEFORE a new subscription is
 * accepted, every open subscription is re-read: a bound turn that settled while the daemon was down
 * is claimed and delivered once; a `claimed-by-router` one is not claimed again — its persisted
 * delivery is resumed (deliveries post under fixed command ids, so the host's receipts dedupe a
 * re-post). A message never saved to the queue (the request died first) is dropped.
 *
 * Closures: a target closed before replying delivers "closed before replying"; a requester closed
 * first drops its subscriptions and pending deliveries (logged). Notices: an empty final reply
 * (§13 d), a failed or interrupted bound turn, a message discarded from the target's queue. A
 * delivery past {@link MAX_EXCHANGE_HOPS} (`hop + 1` of the replying turn) is delivered with the
 * exchange-limit notice and outcome `exchange-limit`; its turn's hop is past the cap, so no tool
 * call from it can cause another turn.
 *
 * Two additive fields ride a subscription record (the config schema is `passthrough`): `posted`
 * `{commandId, seq, messageId?}` — the post that landed and the user message it opened — and
 * `ended` (`delivered | waiter | closed | dropped | refused | discarded`), how a `done` one ended.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import {
  agentChatRoutes,
  buildThreadMessage,
  exceedsExchangeLimit,
  MAX_EXCHANGE_HOPS,
  MAX_PENDING_REPLY_SUBSCRIPTIONS,
  MAX_TURN_INPUT_CHARS,
  parseCausedBy,
  replyDeliveryContext,
  replyNoticeText,
  SETTLED_TURN_STATES,
  THREAD_MESSAGE_OVERHEAD_CHARS,
  threadMessageContext,
  type CallerPrincipal,
  type CausedBy,
  type ComposerContextRecord,
  REPLY_SUBSCRIPTION_LIMIT,
  TARGET_BUSY,
  WAIT_CYCLE,
  type ReplySubscriptionResponse,
  type ReplyWaitResponse,
  THREAD_HISTORY_MAX_TURNS,
  type ThreadHistoryPage,
  type ThreadReadResponse,
  type ThreadSnapshotPayload,
  type Turn
} from "@orquester/api/agent-chat";
import {
  createDefaultReplyOutbox,
  parseReplyOutbox,
  serializeReplyOutbox,
  type MergeOutboxEntry,
  type ReplyDeliveryOutcome,
  type ReplyDeliveryRecord,
  type ReplyOutbox,
  type ReplySubscriptionRecord
} from "@orquester/config";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import { ToolError } from "../mcp/errors.ts";
import { assistantTextForTurn } from "../mcp/views.ts";
import { LineageError, type DeliveryListener, type LineageSessions } from "./lineage.ts";
import { registerWait, waitCycleError, waitsOn } from "./waits.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReplyErrorCode =
  | "THREAD_NOT_FOUND"
  | "INVALID_COMMAND"
  | "COMMAND_REJECTED"
  | "HOST_UNAVAILABLE"
  | "EXCHANGE_LIMIT"
  | typeof REPLY_SUBSCRIPTION_LIMIT
  | "PERMISSION_DENIED"
  | typeof WAIT_CYCLE
  | typeof TARGET_BUSY;

/** HTTP status per refusal (the routes answer `{error: {code, message}}`). */
export const REPLY_ERROR_STATUS: Record<ReplyErrorCode, number> = {
  THREAD_NOT_FOUND: 404,
  INVALID_COMMAND: 400,
  COMMAND_REJECTED: 409,
  HOST_UNAVAILABLE: 503,
  EXCHANGE_LIMIT: 409,
  REPLY_SUBSCRIPTION_LIMIT: 429,
  PERMISSION_DENIED: 403,
  WAIT_CYCLE: 409,
  TARGET_BUSY: 409
};

export class ReplyError extends Error {
  constructor(
    message: string,
    readonly code: ReplyErrorCode
  ) {
    super(message);
    this.name = "ReplyError";
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The delivery queue as the router uses it (`LineageService`). */
export interface DeliveryQueue {
  enqueue(entry: MergeOutboxEntry): Promise<{ delivery: "sent"; seq: number } | { delivery: "queued" }>;
  has(mergeId: string): boolean;
  drop(mergeId: string): Promise<void>;
  /** Take a queued entry back if no post of it started; true when it is gone now. */
  retract(mergeId: string): Promise<boolean>;
}

export interface ReplyRouterOptions {
  outboxFile: string;
  sessions: LineageSessions;
  queue: DeliveryQueue;
  logger?: { warn?: (...args: unknown[]) => void };
  now?: () => Date;
  newId?: () => string;
  /** The safety re-check while anything is open; 0 disables it (tests). */
  recheckMs?: number;
  /** Whether the tab records loaded: until then a missing tab is not taken for a closed one. */
  sessionsLoaded?: () => boolean;
  /** A waiter's timer (tests pass a fake clock's). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** How a `done` subscription ended (persisted as `ended`). */
type Ended = "delivered" | "waiter" | "closed" | "dropped" | "refused" | "discarded";

/**
 * The post that landed: its command id, the receipt's seq, when, the user message it opened, a
 * hash of the message text (the fallback match, never a `reply: "none"` turn), and `steered` when
 * an older host ignored `ifIdle` and the message joined a running turn.
 */
interface Posted {
  commandId: string;
  seq: number;
  at?: string;
  messageId?: string;
  inputHash?: string;
  steered?: true;
}

/**
 * `released`: the release tombstone (passthrough, persisted). The requester's waiting call went away
 * (cancelled, or its result never reached the provider): no waiter may take this reply any more —
 * a later wait answers `notify` at once — and its reply goes out as a message.
 */
type Sub = ReplySubscriptionRecord & {
  posted?: Posted;
  ended?: Ended;
  toTitle?: string;
  answeredNotice?: string;
  released?: true;
  /**
   * How many calls a reply was handed to (the first waiter, a late waiter's take-back, a re-sent
   * call answered again) and how many of those calls went away without it (`release` after the
   * hand-out). The reply is re-delivered as a message only once every call that was handed it is
   * gone — so a host re-sending the call after a restart and the first call's undelivered result
   * never both deliver it. Passthrough, persisted.
   */
  handOuts?: number;
  lostHandOuts?: number;
  /** A reply a waiter took could not be read again when its call went away: no message follows. */
  unreadable?: true;
  /**
   * Failed reads of a released reply so far (transient ones are retried by the safety re-check).
   * Only reads that ran count: a look skipped while the history lookup backs off is no attempt.
   */
  rereads?: number;
};

/** What a bound turn (or its absence) produced. */
export type ReplyResult =
  | {
      kind: "turn";
      turnId: string | null;
      state: "completed" | "failed" | "interrupted";
      /** The final assistant text, trimmed ("" for none). */
      reply: string;
      error?: string;
      /** The replying turn's own exchange, when the host recorded it. */
      causedBy?: CausedBy;
    }
  /**
   * The target is closed. `afterReply`: it had replied (a waiter took the reply), but the reply
   * can no longer be read for a re-delivery — said truthfully, never "closed before replying".
   */
  | { kind: "closed"; afterReply?: true }
  /**
   * No reply will come, said in `text` (a whole sentence for the requester): the message was
   * discarded from the target's queue, joined a running turn (an older host), its turn was rewound
   * or could not be identified, or the subscription outlived {@link MAX_SUBSCRIPTION_AGE_MS}.
   */
  | { kind: "notice"; text: string };

/**
 * One attached wait. `live` is the liveness token: false once its caller is gone (released,
 * timed out, aborted) — the router hands a result only to a live waiter, else delivers it.
 */
interface Waiter {
  live: boolean;
  resolve(result: ReplyResult): void;
  needsInput(): void;
  /** The caller is gone: settle the wait as `notify` (the reply comes as a message). */
  release(): void;
}

const DEFAULT_RECHECK_MS = 30_000;
/** Reads of a released reply before it is given up as unreadable (the first, then the safety re-checks). */
export const MAX_REDELIVERY_READS = 5;
/** Replies handed to waiters kept in memory, newest last, so a target closing afterwards does not lose them. */
const HANDED_OUT_MEMORY = 32;
/** Events a `/turn` command appends at most (meta, message, turn start): read back from its receipt seq. */
const TURN_COMMAND_EVENTS = 3;
/** `done` subscriptions and final deliveries kept for repeats and late waits; older ones are pruned. */
const DONE_MEMORY = 200;
const MAX_IDEMPOTENCY_KEY_CHARS = 180;
const MAX_WAIT_SECONDS = 600;
/** History pages read looking for a bound turn below the snapshot's window. */
const HISTORY_PAGES = 5;
/** After an inconclusive history lookup, the next one waits this long, doubling up to the max. */
export const HISTORY_RETRY_MIN_MS = 60_000;
export const HISTORY_RETRY_MAX_MS = 60 * 60 * 1000;
/** A subscription open this long ends with a notice and frees its slot (no reply came). */
export const MAX_SUBSCRIPTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A posted message whose turn could not be identified (no readable receipt events, no fallback match) for this long ends with a notice. */
export const UNBOUND_GRACE_MS = 60 * 60 * 1000;
/** Room the exchange-limit line and the cut marker need below the turn cap. */
const DELIVERY_SLACK_CHARS = 512;
export const REPLY_DELIVERY_MAX_TEXT_CHARS = MAX_TURN_INPUT_CHARS - THREAD_MESSAGE_OVERHEAD_CHARS - DELIVERY_SLACK_CHARS;

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export class ReplyRouter implements DeliveryListener {
  private api: DaemonApi | null = null;
  private outbox: ReplyOutbox = createDefaultReplyOutbox();
  private readOnly: string | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** Outbox writes queued and not yet landed ({@link hasWorkInFlight}). */
  private pendingWrites = 0;
  private unsubscribe: (() => void) | null = null;
  private recheck: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Resolved once the boot reconciliation ran; new subscriptions wait for it (§13 e). */
  private ready: Promise<void> | null = null;
  private readonly waiters = new Map<string, Waiter>();
  /** Per target: the evaluation chain, and whether one more pass is already queued on it. */
  private readonly evalTail = new Map<string, Promise<void>>();
  private readonly evalQueued = new Set<string>();
  /** Deliveries being handed to the queue right now: never twice at once. */
  private readonly handing = new Set<string>();
  /** Released replies being re-delivered right now. */
  private readonly redelivering = new Set<string>();
  /** `claimed-by-router` subscriptions being resumed right now. */
  private readonly resuming = new Set<string>();
  /** Per subscription, when an inconclusive history lookup may run again (and its current delay). */
  private readonly historyBackoff = new Map<string, { nextAt: number; delayMs: number }>();
  /** Per target, the summary fields last evaluated on: an event that changes none of them reads nothing. */
  private readonly seen = new Map<string, string>();
  /**
   * The reply each recent waiter was handed, by subscription: a closed target's thread can no
   * longer be read, so a re-delivery after it closed takes the reply from here (this process only).
   */
  private readonly handedOut = new Map<string, ReplyResult>();
  /** Steps started without a caller awaiting them (deliveries, a wait attaching): {@link whenIdle} waits for them. */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly opts: ReplyRouterOptions) {}

  // --- lifecycle ------------------------------------------------------------

  /**
   * Read the outbox (missing → empty; unreadable → empty and read-only for this run; not a
   * version-1 outbox → moved aside, empty), then turn every `waiting` and `claimed-by-waiter`
   * subscription into `notify`: no waiter survives a restart (§8.3).
   */
  async load(): Promise<void> {
    this.outbox = createDefaultReplyOutbox();
    this.readOnly = null;
    let text: string;
    try {
      text = await readFile(this.opts.outboxFile, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.readOnly = `the reply outbox could not be read (${code ?? "unknown error"})`;
        this.opts.logger?.warn?.(`[replies] ${this.readOnly}; reply subscriptions are off until the next restart`);
      }
      return;
    }
    try {
      this.outbox = parseReplyOutbox(JSON.parse(text) as unknown);
    } catch (error) {
      const aside = `${this.opts.outboxFile}.corrupt-${this.now().toISOString().replace(/[:.]/g, "-")}`;
      try {
        await rename(this.opts.outboxFile, aside);
        this.opts.logger?.warn?.(`[replies] the reply outbox is not readable (${(error as Error).message}); moved it to ${aside}`);
      } catch {
        this.readOnly = "the reply outbox is corrupt and could not be moved aside";
        this.opts.logger?.warn?.(`[replies] ${this.readOnly}; reply subscriptions are off until the next restart`);
      }
      return;
    }
    let changed = false;
    for (const sub of this.subs()) {
      // The calls a reply was handed to died with the previous process: their releases never come.
      // Holders are counted afresh, so a re-sent call is the only one and its lost result delivers.
      if (sub.state === "done" && sub.ended === "waiter" && !sub.released && ((sub.handOuts ?? 1) !== 0 || (sub.lostHandOuts ?? 0) !== 0)) {
        sub.handOuts = 0;
        sub.lostHandOuts = 0;
        changed = true;
      }
      if (sub.state === "waiting" || sub.state === "claimed-by-waiter") {
        sub.state = "notify";
        sub.updatedAt = this.stamp();
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  /** Bound by the delivery queue's own `attachApi`: listen on the bus, then reconcile (§13 e). */
  attachApi(api: DaemonApi): void {
    this.api = api;
    this.unsubscribe?.();
    this.unsubscribe = api.subscribe((event) => {
      if (event.channel !== "sessions") return;
      const id = (event.payload as { id?: unknown } | null)?.id;
      if (typeof id !== "string") return;
      if (this.openSubs().some((sub) => sub.toThreadId === id) && this.summaryMoved(id)) void this.evaluate(id);
      if (this.isClosed(id)) this.track(this.requesterClosed(id));
    });
    this.ready = this.track(
      this.reconcile().catch((error: unknown) => {
        this.opts.logger?.warn?.("[replies] the boot reconciliation failed", error);
      })
    );
    this.armRecheck();
  }

  /** Resolves once the boot reconciliation finished (tests, and every new subscription). */
  whenReady(): Promise<void> {
    return this.ready ?? Promise.resolve();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.recheck) clearInterval(this.recheck);
    this.recheck = null;
    await this.writes;
  }

  /** Every readable subscription (tests, views). */
  subscriptions(): readonly ReplySubscriptionRecord[] {
    return this.outbox.subscriptions;
  }

  /** Every readable delivery (tests, views). */
  deliveries(): readonly ReplyDeliveryRecord[] {
    return this.outbox.deliveries;
  }

  // --- subscribe ------------------------------------------------------------

  /**
   * `POST agentChatRoutes.replySubscriptions(targetId)` (socket-only; every field socket-trusted;
   * an agent principal must be `fromThreadId`). Persists the subscription, then hands the message
   * to the delivery queue under the subscription's `commandId`.
   */
  async subscribe(targetId: string, raw: unknown, principal?: CallerPrincipal): Promise<ReplySubscriptionResponse> {
    if (!this.api || !this.ready) throw new ReplyError("Orquester is still starting. Try again in a moment.", "HOST_UNAVAILABLE");
    await this.ready;
    if (this.readOnly !== null) {
      throw new ReplyError("Orquester cannot save reply subscriptions right now; send without a reply, or try again after a restart.", "HOST_UNAVAILABLE");
    }
    const body = record(raw);
    const fromThreadId = body.fromThreadId;
    if (typeof fromThreadId !== "string" || fromThreadId.length === 0 || fromThreadId.length > 200) {
      throw new ReplyError("fromThreadId must name the requesting chat.", "INVALID_COMMAND");
    }
    if (principal?.kind === "agent" && principal.threadId !== fromThreadId) {
      throw new ReplyError("A chat may only ask for replies to itself.", "PERMISSION_DENIED");
    }
    const target = this.opts.sessions.get(targetId);
    if (!target) throw new ReplyError("No chat session with that id.", "THREAD_NOT_FOUND");
    if (!this.opts.sessions.get(fromThreadId)) throw new ReplyError("The requesting chat is not open.", "THREAD_NOT_FOUND");
    if (fromThreadId === targetId) throw new ReplyError("A chat cannot ask itself for a reply.", "INVALID_COMMAND");
    if (body.reply !== "wait" && body.reply !== "notify") throw new ReplyError('reply must be "wait" or "notify".', "INVALID_COMMAND");
    if (typeof body.input !== "string" || body.input.trim().length === 0) throw new ReplyError("input must be a non-empty string.", "INVALID_COMMAND");
    if (body.input.length > MAX_TURN_INPUT_CHARS) {
      throw new ReplyError(`input is ${body.input.length} characters; at most ${MAX_TURN_INPUT_CHARS} fit in a message.`, "INVALID_COMMAND");
    }
    const mode = body.interactionMode;
    if (mode !== undefined && mode !== null && mode !== "default" && mode !== "plan") {
      throw new ReplyError('interactionMode must be "default" or "plan".', "INVALID_COMMAND");
    }
    const origin = body.origin;
    if (origin !== undefined && origin !== null && origin !== "sent" && origin !== "opened" && origin !== "delegated") {
      throw new ReplyError('origin must be "sent", "opened" or "delegated".', "INVALID_COMMAND");
    }
    const causedBy = parseCausedBy(body.causedBy);
    if (!causedBy || causedBy.threadId !== fromThreadId) {
      throw new ReplyError("causedBy must be {threadId: fromThreadId, exchangeId, hop}.", "INVALID_COMMAND");
    }
    if (exceedsExchangeLimit(causedBy)) {
      throw new ReplyError(
        `This exchange reached its limit of ${MAX_EXCHANGE_HOPS} agent-caused turns; summarise for your user instead.`,
        "EXCHANGE_LIMIT"
      );
    }
    const key = body.idempotencyKey;
    if (
      key !== undefined &&
      key !== null &&
      (typeof key !== "string" || key.trim().length === 0 || key.length > MAX_IDEMPOTENCY_KEY_CHARS || key.includes(":"))
    ) {
      throw new ReplyError(`idempotencyKey must be 1 to ${MAX_IDEMPOTENCY_KEY_CHARS} characters, without ":".`, "INVALID_COMMAND");
    }
    if (typeof key === "string") {
      const known = this.subs().find((sub) => sub.fromThreadId === fromThreadId && sub.idempotencyKey === key);
      if (known) {
        if (known.toThreadId !== targetId) throw new ReplyError("That idempotencyKey names a subscription to another chat.", "COMMAND_REJECTED");
        return this.responseOf(known);
      }
    }
    if (body.attachments !== undefined && body.attachments !== null && !Array.isArray(body.attachments)) {
      throw new ReplyError("attachments must be a list.", "INVALID_COMMAND");
    }
    if (body.context !== undefined && body.context !== null && !Array.isArray(body.context)) {
      throw new ReplyError("context must be a list.", "INVALID_COMMAND");
    }
    // A wait that would close a cycle is refused before anything is saved or queued (§8.6).
    if (body.reply === "wait" && waitsOn(targetId, fromThreadId)) {
      throw new ReplyError(waitCycleError(targetId).message, WAIT_CYCLE);
    }
    const pending = this.subs().filter((sub) => sub.fromThreadId === fromThreadId && sub.state !== "done").length;
    if (pending >= MAX_PENDING_REPLY_SUBSCRIPTIONS) {
      throw new ReplyError(
        `This chat already waits for ${pending} replies (limit ${MAX_PENDING_REPLY_SUBSCRIPTIONS}). Wait for some to arrive first.`,
        REPLY_SUBSCRIPTION_LIMIT
      );
    }

    const createdAt = this.stamp();
    const id = this.newId();
    const commandId = this.newId();
    const sub: Sub = {
      id,
      fromThreadId,
      toThreadId: targetId,
      commandId,
      state: body.reply === "wait" ? "waiting" : "notify",
      interactionMode: mode === "plan" ? "plan" : "default",
      exchange: { id: causedBy.exchangeId, hop: causedBy.hop },
      ...(origin === "opened" || origin === "delegated" ? { origin } : {}),
      ...(typeof key === "string" ? { idempotencyKey: key } : {}),
      // The queue entry is the subscription's command id: its first post is `commandId`, a retry
      // `<commandId>:<n>` (`attemptCommandId`); the binding follows the post that landed.
      queueEntryId: commandId,
      createdAt,
      toTitle: target.title
    };
    this.outbox.subscriptions.push(sub);
    // Persisted BEFORE the message goes anywhere (§8.3).
    if (!(await this.persist())) {
      this.outbox.subscriptions = this.outbox.subscriptions.filter((other) => other !== sub);
      throw new ReplyError("Orquester could not save the reply subscription; try again in a moment.", "HOST_UNAVAILABLE");
    }
    const entry: MergeOutboxEntry = {
      mergeId: commandId,
      parentSessionId: targetId,
      childSessionId: fromThreadId,
      input: body.input,
      queuedAt: createdAt,
      state: "queued",
      attempts: 0,
      kind: "message",
      causedBy,
      subscriptionId: id,
      context: queueContext(Array.isArray(body.context) ? (body.context as ComposerContextRecord[]) : [threadMessageContext(fromThreadId)]),
      ...(mode === "plan" ? { interactionMode: "plan" as const } : {}),
      ...(Array.isArray(body.attachments) && body.attachments.length > 0 ? { attachments: body.attachments } : {})
    };
    let result: Awaited<ReturnType<DeliveryQueue["enqueue"]>>;
    try {
      result = await this.opts.queue.enqueue(entry);
    } catch (error) {
      // Nothing was queued or posted: the subscription ends here, and the caller hears why.
      this.finish(sub, "refused");
      this.waiters.delete(sub.id);
      await this.persist();
      if (error instanceof LineageError) {
        throw new ReplyError(error.message, error.code);
      }
      throw new ReplyError("The message could not be sent; try again in a moment.", "HOST_UNAVAILABLE");
    }
    void this.evaluate(targetId);
    return result.delivery === "sent"
      ? { subscriptionId: id, commandId, delivery: "sent", seq: result.seq }
      : { subscriptionId: id, commandId, queueEntryId: commandId, delivery: "queued" };
  }

  private responseOf(sub: Sub): ReplySubscriptionResponse {
    if (sub.posted) return { subscriptionId: sub.id, commandId: sub.commandId, delivery: "sent", seq: sub.posted.seq };
    return { subscriptionId: sub.id, commandId: sub.commandId, queueEntryId: sub.queueEntryId ?? sub.commandId, delivery: "queued" };
  }

  // --- wait -----------------------------------------------------------------

  /**
   * `POST agentChatRoutes.replySubscriptionWait(targetId, subscriptionId)`: attach the requester's
   * waiter until the bound turn's reply, the timeout, or the bound turn needing the target's user.
   * `signal` (the request going away) ends it like the timeout.
   */
  wait(
    targetId: string,
    subscriptionId: string,
    raw: unknown,
    opts: { principal?: CallerPrincipal; signal?: AbortSignal } = {}
  ): Promise<ReplyWaitResponse> {
    // In flight (whenIdle) until the waiter is attached or the wait answered at once — never
    // while it is attached: that lasts until a reply, a release or its timer.
    let attached!: () => void;
    this.track(new Promise<void>((resolve) => (attached = resolve)));
    const answer = this.waitNow(targetId, subscriptionId, raw, opts, attached);
    void answer.then(attached, attached);
    return answer;
  }

  private async waitNow(
    targetId: string,
    subscriptionId: string,
    raw: unknown,
    opts: { principal?: CallerPrincipal; signal?: AbortSignal },
    attached: () => void
  ): Promise<ReplyWaitResponse> {
    if (!this.api || !this.ready) throw new ReplyError("Orquester is still starting. Try again in a moment.", "HOST_UNAVAILABLE");
    await this.ready;
    const sub = this.subs().find((candidate) => candidate.id === subscriptionId && candidate.toThreadId === targetId);
    if (!sub) throw new ReplyError("No reply subscription with that id for this session.", "THREAD_NOT_FOUND");
    if (opts.principal?.kind === "agent" && opts.principal.threadId !== sub.fromThreadId) {
      throw new ReplyError("Only the chat that asked may wait for this reply.", "PERMISSION_DENIED");
    }
    const timeoutSeconds = record(raw).timeoutSeconds;
    if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_WAIT_SECONDS) {
      throw new ReplyError(`timeoutSeconds must be a whole number from 1 to ${MAX_WAIT_SECONDS}.`, "INVALID_COMMAND");
    }
    if (sub.state === "notify") return { outcome: "notify", reason: "timeout", willNotify: true };
    if (sub.released) {
      // Tombstoned: never attached, never taken back — the reply is (or will be) a message.
      if (sub.unreadable) {
        return { outcome: "replied", turnId: sub.turnId ?? null, state: "failed", error: `The reply could not be read again after the call that took it went away; no message will follow. Read it with read_transcript {sessionId: "${sub.toThreadId}"}.` };
      }
      if (sub.state === "done" && sub.ended !== "delivered" && sub.ended !== "waiter" && sub.ended !== undefined) return this.answerForEnded(sub);
      return { outcome: "notify", reason: "timeout", willNotify: true };
    }
    if (sub.state === "done" && sub.ended !== "delivered" && sub.ended !== undefined) {
      return this.answerForEnded(sub);
    }
    if (sub.state === "claimed-by-router" || sub.state === "done") {
      if (sub.ended === "closed") return { outcome: "closed" };
      // The turn settled before this waiter attached: the reply was queued for the requester —
      // which is busy in this very tool call, so it has not landed. Taken back, it is returned here.
      const taken = await this.takeBack(sub);
      if (taken) return waitResponseOf(taken);
      return { outcome: "notify", reason: "timeout", willNotify: true };
    }
    if (sub.state === "claimed-by-waiter" || this.waiters.has(sub.id)) {
      throw new ReplyError("Another wait already holds this reply.", "COMMAND_REJECTED");
    }
    let unregister: () => void;
    try {
      unregister = registerWait(sub.fromThreadId, sub.toThreadId);
    } catch (error) {
      if (error instanceof ToolError) throw new ReplyError(error.message, WAIT_CYCLE);
      throw error;
    }
    const setTimer = this.opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = this.opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    return new Promise<ReplyWaitResponse>((resolve) => {
      let settled = false;
      let timer: unknown = null;
      const onAbort = (): void => giveUp("timeout");
      const finishWith = (response: ReplyWaitResponse): void => {
        if (settled) return;
        settled = true;
        waiter.live = false;
        if (this.waiters.get(sub.id) === waiter) this.waiters.delete(sub.id);
        if (timer !== null) clearTimer(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        unregister();
        resolve(response);
      };
      // The waiter's CAS: `waiting → notify`. Lost to the router (it set `claimed-by-waiter`
      // first), the router's result is on its way to `waiter.resolve` — while this waiter is live.
      const giveUp = (reason: "timeout" | "needs-input"): void => {
        if (settled || sub.state !== "waiting" || this.waiters.get(sub.id) !== waiter) return;
        waiter.live = false;
        this.waiters.delete(sub.id);
        sub.state = "notify";
        sub.updatedAt = this.stamp();
        void this.persist().then(() => finishWith({ outcome: "notify", reason, willNotify: true }));
        // Persisted `notify` can now be claimed by the router: look again (the turn may have settled).
        void this.evaluate(sub.toThreadId);
      };
      const waiter: Waiter = {
        live: true,
        resolve: (result) => finishWith(waitResponseOf(result)),
        needsInput: () => giveUp("needs-input"),
        release: () => finishWith({ outcome: "notify", reason: "timeout", willNotify: true })
      };
      this.waiters.set(sub.id, waiter);
      timer = setTimer(() => giveUp("timeout"), timeoutSeconds * 1000);
      if (opts.signal?.aborted) giveUp("timeout");
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
      void this.evaluate(sub.toThreadId);
      attached();
    });
  }

  /**
   * What a wait on a subscription that already ended answers, truthfully: the reply again when a
   * wait already took it (it is never delivered as a message too); `closed`; or, for one that
   * ended without a reply (dropped, refused, discarded), a `failed` answer saying no reply comes.
   */
  private async answerForEnded(sub: Sub): Promise<ReplyWaitResponse> {
    if (sub.ended === "closed") return { outcome: "closed" };
    if (sub.ended === "waiter" && sub.answeredNotice !== undefined) {
      return { outcome: "replied", turnId: null, state: "failed", error: sub.answeredNotice };
    }
    if (sub.ended === "waiter" && !sub.posted?.steered) {
      const result = await this.handedOutResult(sub);
      // Released while the reply was read (every holder gone): it is a message now.
      if (sub.released) return { outcome: "notify", reason: "timeout", willNotify: true };
      // A re-sent call (same idempotency key) is handed the reply again: one more holder.
      if (result && sub.state === "done") {
        sub.handOuts = (sub.handOuts ?? 1) + 1;
        this.rememberHandedOut(sub, result);
        await this.persist();
        return waitResponseOf(result);
      }
      return { outcome: "replied", turnId: sub.turnId ?? null, state: "failed", error: "This reply was already returned to an earlier wait; no message will follow." };
    }
    return { outcome: "replied", turnId: null, state: "failed", error: "This exchange ended without a reply; no message will follow." };
  }

  /**
   * `POST …/reply-subscriptions/:subscriptionId/release` (socket-only): the requester's waiting
   * call went away — cancelled (`DaemonApi.request` cannot abort its inject, so the caller says so)
   * or its result never reached the provider. Deterministic in every order, by a persisted tombstone
   * (`released`):
   * - a waiter attached: marked dead at once (the router never hands it a result) and `waiting →
   *   notify` (CAS, persisted) — the reply comes as a message;
   * - none attached yet: `waiting → notify` all the same, and a wait that attaches later answers
   *   `notify` at once — it can never become `claimed-by-waiter`;
   * - a waiter already took the reply (`done`, ended `waiter`, or taken back from the queue): the
   *   reply is re-delivered as a message, once (one delivery record per subscription).
   */
  async release(
    targetId: string,
    subscriptionId: string,
    principal?: CallerPrincipal
  ): Promise<{ released: boolean; state: ReplySubscriptionRecord["state"] }> {
    if (!this.api || !this.ready) throw new ReplyError("Orquester is still starting. Try again in a moment.", "HOST_UNAVAILABLE");
    const sub = this.subs().find((candidate) => candidate.id === subscriptionId && candidate.toThreadId === targetId);
    if (!sub) throw new ReplyError("No reply subscription with that id for this session.", "THREAD_NOT_FOUND");
    if (principal?.kind === "agent" && principal.threadId !== sub.fromThreadId) {
      throw new ReplyError("Only the chat that asked may release this wait.", "PERMISSION_DENIED");
    }
    const waiter = this.waiters.get(sub.id);
    if (sub.state === "done" && sub.ended === "waiter" && !waiter) {
      return this.releaseHandedOut(sub);
    }
    sub.released = true;
    if (waiter) {
      waiter.live = false;
      this.waiters.delete(sub.id);
    }
    if (sub.state === "waiting") {
      sub.state = "notify";
      sub.updatedAt = this.stamp();
    }
    await this.persist();
    if (waiter) {
      waiter.release();
      void this.evaluate(sub.toThreadId);
      return { released: true, state: sub.state };
    }
    void this.evaluate(sub.toThreadId);
    return { released: false, state: sub.state };
  }

  /**
   * A release after a waiter took the reply: one holder fewer. Once every call it was handed to is
   * gone, the reply is re-delivered as a message — the tombstone and the delivery in ONE persisted
   * write (no crash leaves a released record without its delivery). A reply that cannot be read
   * again is recorded as such (`unreadable`), so no wait promises a message that never comes.
   */
  private async releaseHandedOut(sub: Sub): Promise<{ released: boolean; state: ReplySubscriptionRecord["state"] }> {
    sub.lostHandOuts = (sub.lostHandOuts ?? 0) + 1;
    if (sub.lostHandOuts < (sub.handOuts ?? 1) || sub.released) {
      // Another call still holds it (a re-sent call answered again), or it was already re-delivered.
      await this.persist();
      return { released: false, state: sub.state };
    }
    const existing = this.outbox.deliveries.find((d) => d.subscriptionId === sub.id);
    if (existing) {
      // Taken back from the queue for a waiter (D-4): put back, with the tombstone, in one write.
      sub.released = true;
      if (existing.state === "dropped") existing.state = "pending";
      await this.persist();
      await this.hand(existing);
      return { released: true, state: sub.state };
    }
    if (sub.released || this.outbox.deliveries.some((d) => d.subscriptionId === sub.id)) return { released: false, state: sub.state };
    sub.released = true;
    return (await this.redeliver(sub)) ? { released: true, state: sub.state } : { released: false, state: sub.state };
  }

  /**
   * Re-deliver a released reply a waiter took: read it again and claim it for the router — the
   * delivery and the tombstone in one write. A target closed since is no reason to lose the reply:
   * the requester still gets its text (the reply this process handed out); only a reply that can
   * no longer be read at all becomes a notice that the target closed after replying. A read that
   * fails is retried by the safety re-check (`recheckNow`), up to {@link MAX_REDELIVERY_READS}
   * reads that actually ran; only then is the reply `unreadable` (a later wait says no message
   * follows). True once the delivery is recorded.
   */
  private async redeliver(sub: Sub): Promise<boolean> {
    if (this.redelivering.has(sub.id)) return false;
    this.redelivering.add(sub.id);
    try {
      let result: ReplyResult | null;
      let read = true;
      if (sub.answeredNotice !== undefined) result = { kind: "notice", text: sub.answeredNotice };
      else ({ result, read } = await this.readHandedOut(sub));
      if (this.outbox.deliveries.some((d) => d.subscriptionId === sub.id) || sub.state !== "done" || sub.ended !== "waiter") return false;
      if (!result) {
        // A look that read nothing (the history lookup is backing off) is not a failed read.
        if (!read) return false;
        sub.rereads = (sub.rereads ?? 0) + 1;
        if (sub.rereads >= MAX_REDELIVERY_READS) {
          sub.unreadable = true;
          this.opts.logger?.warn?.("[replies] a released reply could not be read again; not re-delivered", { subscriptionId: sub.id });
        }
        await this.persist();
        return false;
      }
      // claimForRouter persists the claim, the delivery and the tombstone together.
      const deliver = await this.claimForRouter(sub, result);
      if (this.outbox.deliveries.some((d) => d.subscriptionId === sub.id)) {
        this.handedOut.delete(sub.id);
        await deliver();
        return true;
      }
      // No delivery: the requester closed (claimForRouter recorded the drop — and with it the
      // tombstone and the counts, which memory keeps as written), or the write failed and nothing
      // was recorded: the re-check tries again.
      return false;
    } finally {
      this.redelivering.delete(sub.id);
    }
  }

  /** Released replies still to be re-delivered (a read failed): the safety re-check retries them. */
  private pendingRedeliveries(): Sub[] {
    return this.subs().filter(
      (sub) => sub.released && sub.state === "done" && sub.ended === "waiter" && !sub.unreadable && !this.outbox.deliveries.some((d) => d.subscriptionId === sub.id)
    );
  }

  /**
   * D-4: a reply the router queued for a requester whose waiter attached only afterwards. Taken
   * back (CAS on the delivery: a `pending` one is marked `dropped` before it is handed; a `queued`
   * one is retracted from the queue in the requester's lane) and returned to the waiter — or null
   * once a post of it may have started, or for a notice.
   */
  private async takeBack(sub: Sub): Promise<ReplyResult | null> {
    const delivery = this.outbox.deliveries.find((d) => d.subscriptionId === sub.id);
    if (!delivery || (delivery as { notice?: unknown }).notice === true || this.handing.has(delivery.id)) return null;
    if (delivery.state !== "pending" && delivery.state !== "queued") return null;
    const result = await this.resultFor(sub);
    // The waiting call may have been released meanwhile: a cancelled waiter never receives the reply.
    if (!result || result.kind !== "turn" || sub.released) return null;
    if (delivery.state === "queued") {
      if (this.handing.has(delivery.id) || !(await this.opts.queue.retract(delivery.queueEntryId ?? delivery.id))) return null;
      if (sub.released) {
        // Released while the entry came out of the queue: it goes back in, as a message.
        delivery.state = "pending";
        await this.persist();
        await this.hand(delivery);
        return null;
      }
    } else if (this.handing.has(delivery.id)) {
      return null;
    }
    if (delivery.state !== "pending" && delivery.state !== "queued") return null;
    delivery.state = "dropped";
    this.finish(sub, "waiter");
    sub.handOuts = 1;
    this.rememberHandedOut(sub, result);
    await this.persist();
    return result;
  }

  // --- the delivery queue's hooks (DeliveryListener) -----------------------------

  /** A queued entry's turn landed: bind a message's subscription, or mark a reply delivered. */
  async posted(entry: MergeOutboxEntry, commandId: string, seq: number): Promise<void> {
    if (entry.kind === "reply") {
      const delivery = this.outbox.deliveries.find((d) => (d.queueEntryId ?? d.id) === entry.mergeId);
      if (delivery && delivery.state !== "delivered") {
        delivery.state = "delivered";
        delivery.deliveredAt = this.stamp();
        await this.persist();
      }
      return;
    }
    if (entry.kind !== "message" || entry.subscriptionId === undefined) return;
    const sub = this.subs().find((candidate) => candidate.id === entry.subscriptionId);
    if (!sub || sub.posted) return;
    const binding = await this.bindingOf(entry.parentSessionId, commandId, seq);
    sub.posted = {
      commandId,
      seq,
      at: this.stamp(),
      // The host stores the text trimmed (`parseTurnInput`): hashed as it will be read back.
      inputHash: hashText(entry.input.trim()),
      ...(binding.messageId !== undefined ? { messageId: binding.messageId } : {}),
      ...(binding.steeredTurnId !== undefined ? { steered: true as const } : {})
    };
    if (binding.steeredTurnId !== undefined) sub.turnId = binding.steeredTurnId;
    sub.updatedAt = this.stamp();
    await this.persist();
    if (sub.posted.steered) {
      // An older host ignored `ifIdle`: the message joined a running turn, whose reply is not an
      // answer to it (§8.3). The requester hears that instead — never that turn's reply.
      const deliver = await this.claim(sub, { kind: "notice", text: this.noticeText("steered", sub) });
      this.track(deliver());
      return;
    }
    void this.evaluate(entry.parentSessionId);
  }

  /** A pending entry was discarded (Deliver now / Discard): a reply dropped, or a message that never ran. */
  async discarded(entry: MergeOutboxEntry, bySessionId: string): Promise<void> {
    if (entry.kind === "reply") {
      const delivery = this.outbox.deliveries.find((d) => (d.queueEntryId ?? d.id) === entry.mergeId);
      if (delivery && delivery.state !== "dropped" && delivery.state !== "delivered") {
        delivery.state = "dropped";
        await this.persist();
      }
      return;
    }
    if (entry.kind !== "message" || entry.subscriptionId === undefined) return;
    const sub = this.subs().find((candidate) => candidate.id === entry.subscriptionId);
    if (!sub || (sub.state !== "waiting" && sub.state !== "notify")) return;
    if (bySessionId === sub.fromThreadId) {
      // The requester took its own message back: nothing to tell it, a waiter hears it at once.
      const waiter = this.waiters.get(sub.id);
      this.finish(sub, "discarded");
      await this.persist();
      waiter?.resolve({ kind: "notice", text: "You discarded the message before it ran, so no reply will come." });
      return;
    }
    // The claim is recorded before the queue lets the entry go; its delivery follows outside the
    // target's lane (it goes into the requester's).
    const deliver = await this.claim(sub, { kind: "notice", text: this.noticeText("discarded", sub) });
    this.track(deliver());
  }

  // --- reconciliation and evaluation ------------------------------------------------

  /** §13 e, once the API is bound: every open subscription and every pending delivery, re-read. */
  private async reconcile(): Promise<void> {
    for (const sub of this.openSubs()) {
      if (sub.state === "claimed-by-router") {
        await this.resumeClaimed(sub);
        continue;
      }
      if (!sub.posted && !this.opts.queue.has(sub.queueEntryId ?? sub.commandId)) {
        // Never posted and not in the queue: the request died before its message was saved
        // (a post or a discard is recorded here before the entry leaves the queue).
        this.opts.logger?.warn?.("[replies] a subscription whose message was never saved was dropped", { subscriptionId: sub.id });
        this.finish(sub, "dropped");
        await this.persist();
      }
    }
    for (const delivery of this.outbox.deliveries) {
      if (delivery.state === "pending") await this.hand(delivery);
      else if (delivery.state === "queued" && !this.opts.queue.has(delivery.queueEntryId ?? delivery.id)) {
        // Every post and discard is recorded here first, so this is a queue write that did not
        // land: hand it again under the same id (the host's receipt dedupes a re-post).
        this.opts.logger?.warn?.("[replies] a queued reply missing from the delivery queue is queued again", { deliveryId: delivery.id });
        delivery.state = "pending";
        await this.hand(delivery);
      }
    }
    // A released reply whose re-delivery was not recorded yet (its read failed): tried again.
    for (const sub of this.pendingRedeliveries()) await this.redeliver(sub);
    for (const requester of new Set(this.openSubs().map((sub) => sub.fromThreadId))) {
      if (this.isClosed(requester)) await this.requesterClosed(requester);
    }
    await Promise.all([...new Set(this.openSubs().map((sub) => sub.toThreadId))].map((id) => this.evaluate(id)));
  }

  /**
   * A `claimed-by-router` subscription: its persisted delivery resumes, never a second claim. One
   * without a delivery record (written by a build before claim and record were one write) has its
   * result read again — at boot and on every safety re-check, so it is never stranded.
   */
  private async resumeClaimed(sub: Sub): Promise<void> {
    if (this.resuming.has(sub.id)) return;
    this.resuming.add(sub.id);
    try {
      await this.resumeClaimedNow(sub);
    } finally {
      this.resuming.delete(sub.id);
    }
  }

  private async resumeClaimedNow(sub: Sub): Promise<void> {
    const delivery = this.outbox.deliveries.find((d) => d.subscriptionId === sub.id);
    if (delivery) {
      if (delivery.state === "pending") await this.hand(delivery);
      else if (sub.state !== "done") {
        this.finish(sub, sub.ended === "closed" ? "closed" : "delivered");
        await this.persist();
      }
      return;
    }
    const result = await this.resultFor(sub);
    if (!result) return;
    const deliver = await this.claimForRouter(sub, result);
    await deliver();
  }

  /** The bound turn's result now, for a subscription already claimed; null while it cannot be read. */
  private async resultFor(sub: Sub): Promise<ReplyResult | null> {
    return (await this.readResult(sub)).result;
  }

  /**
   * {@link resultFor}, saying whether a read actually ran: `read` is false when nothing was read
   * (no API yet, or the history lookup is backing off) — such a miss is no failed read.
   */
  private async readResult(sub: Sub): Promise<{ result: ReplyResult | null; read: boolean }> {
    if (this.isClosed(sub.toThreadId)) return { result: { kind: "closed" }, read: true };
    const api = this.api;
    if (!api) return { result: null, read: false };
    let snap: ThreadSnapshotPayload;
    try {
      snap = await readThread(api, sub.toThreadId);
    } catch {
      return { result: null, read: true };
    }
    const turn = this.boundTurn(sub, snap);
    if (turn) return { result: SETTLED_TURN_STATES.has(turn.state) ? resultOf(snap, turn) : null, read: true };
    const outside = await this.lookOutsideWindow(api, sub, snap);
    if (outside.kind === "found") return { result: outside.result, read: true };
    return { result: null, read: !(outside.kind === "unknown" && outside.deferred === true) };
  }

  /**
   * The reply a waiter already took, for handing it out again: read afresh while the target is
   * open; once it closed (its thread can no longer be read), the reply this process handed out —
   * or, without one, the target closed after replying.
   */
  private async readHandedOut(sub: Sub): Promise<{ result: ReplyResult | null; read: boolean }> {
    if (!this.isClosed(sub.toThreadId)) return this.readResult(sub);
    return { result: this.handedOut.get(sub.id) ?? { kind: "closed", afterReply: true }, read: true };
  }

  private async handedOutResult(sub: Sub): Promise<ReplyResult | null> {
    return (await this.readHandedOut(sub)).result;
  }

  /** Keep the reply a waiter was handed (the newest {@link HANDED_OUT_MEMORY}). */
  private rememberHandedOut(sub: Sub, result: ReplyResult): void {
    if (result.kind !== "turn") return;
    this.handedOut.delete(sub.id);
    this.handedOut.set(sub.id, result);
    for (const id of this.handedOut.keys()) {
      if (this.handedOut.size <= HANDED_OUT_MEMORY) break;
      this.handedOut.delete(id);
    }
  }

  /**
   * A bound turn missing from the snapshot may only have left its retained window (lazy boot,
   * retention): looked up in the indexed history (`GET …/history`, a few pages) before anything is
   * concluded. `found` (with its result once it settled — the index records completion, not the
   * end state, so a settled one reads `completed`), `absent` (the thread holds no such turn: no
   * older history, or every page read), or `unknown` (no usable index, or not reached; `deferred`
   * when no lookup ran because an earlier inconclusive one is backing off).
   */
  private async lookOutsideWindow(
    api: DaemonApi,
    sub: Sub,
    snap: ThreadSnapshotPayload
  ): Promise<{ kind: "found"; result: ReplyResult | null } | { kind: "absent" } | { kind: "unknown"; deferred?: true }> {
    const messageId = sub.posted?.messageId;
    if (messageId === undefined && sub.turnId === undefined) return { kind: "unknown" };
    const bounds = snap.history;
    if (!bounds || !bounds.hasOlder) return { kind: "absent" };
    // Recency: the message was posted after the oldest turn the window still holds, so its turn
    // would be in the window — its absence there is conclusive (a rewind), no history read.
    const oldest = snap.turns[0]?.requestedAt;
    const postedAt = sub.posted?.at;
    if (oldest !== undefined && postedAt !== undefined && Date.parse(postedAt) >= Date.parse(oldest)) return { kind: "absent" };
    // An inconclusive lookup is not repeated on every look: it backs off (1 min, doubling to 1 h).
    const backoff = this.historyBackoff.get(sub.id);
    const nowMs = this.now().getTime();
    if (backoff && nowMs < backoff.nextAt) return { kind: "unknown", deferred: true };
    const outcome = await this.readHistoryFor(api, sub, bounds.indexed ? bounds.beforeCursor : null, bounds.indexed);
    if (outcome.kind === "unknown") {
      const delayMs = Math.min(backoff ? backoff.delayMs * 2 : HISTORY_RETRY_MIN_MS, HISTORY_RETRY_MAX_MS);
      this.historyBackoff.set(sub.id, { nextAt: nowMs + delayMs, delayMs });
    } else {
      this.historyBackoff.delete(sub.id);
    }
    return outcome;
  }

  /** The history pages below the window, read for one bound turn (see {@link lookOutsideWindow}). */
  private async readHistoryFor(
    api: DaemonApi,
    sub: Sub,
    firstCursor: string | null,
    indexed: boolean
  ): Promise<{ kind: "found"; result: ReplyResult | null } | { kind: "absent" } | { kind: "unknown" }> {
    if (!indexed) return { kind: "unknown" };
    const messageId = sub.posted?.messageId;
    let cursor = firstCursor;
    for (let page = 0; cursor !== null && page < HISTORY_PAGES; page += 1) {
      let body: ThreadHistoryPage;
      try {
        const res = await api.request("GET", agentChatRoutes.history(sub.toThreadId), {
          query: { before: cursor, turns: String(THREAD_HISTORY_MAX_TURNS) }
        });
        if (res.status >= 400) return { kind: "unknown" };
        body = res.body as ThreadHistoryPage;
      } catch {
        return { kind: "unknown" };
      }
      const turn = body.turns.find(
        (candidate) => (sub.turnId !== undefined && candidate.turnId === sub.turnId) || (messageId !== undefined && candidate.userMessageId === messageId)
      );
      if (turn) {
        return {
          kind: "found",
          result:
            turn.completedAt === null
              ? null
              : { kind: "turn", turnId: turn.turnId, state: "completed", reply: assistantTextForTurn(body.items, turn.turnId).trim() }
        };
      }
      cursor = body.page.beforeCursor;
    }
    return cursor === null ? { kind: "absent" } : { kind: "unknown" };
  }

  /**
   * Whether a target's summary moved since its last evaluation (latest turn, its state, open
   * requests, session status): a bus event that changes none of them needs no thread read.
   */
  private summaryMoved(targetId: string): boolean {
    const summary = this.opts.sessions.get(targetId);
    const key = summary
      ? JSON.stringify([
          summary.latestTurn?.turnId ?? null,
          summary.latestTurn?.state ?? null,
          summary.hasPendingApprovals === true,
          summary.hasPendingUserInput === true,
          summary.chatSessionStatus ?? null
        ])
      : "closed";
    if (this.seen.get(targetId) === key) return false;
    this.seen.set(targetId, key);
    return true;
  }

  /**
   * Resolves once nothing is in flight: every target's evaluation has finished, every step started
   * without an awaiting caller (a delivery, a requester's closure, a wait still attaching) is done,
   * and the queued outbox writes have landed. It loops while work keeps arriving, so work those
   * steps start meanwhile is waited for too (tests wait on it instead of counting event-loop
   * turns). It waits for in-flight work only, never for timers: an attached waiter, its timeout
   * and the safety re-check's next tick are not work in flight. What the delivery queue does with
   * a handed delivery afterwards is the queue's (`LineageService.whenIdle`).
   */
  async whenIdle(): Promise<void> {
    while (this.hasWorkInFlight()) await Promise.all([...this.evalTail.values(), ...this.inFlight, this.writes]);
  }

  /** True while a step is in flight (see {@link whenIdle}). */
  hasWorkInFlight(): boolean {
    return this.evalTail.size > 0 || this.inFlight.size > 0 || this.pendingWrites > 0;
  }

  /** Count a step nobody awaits as in flight until it settles ({@link whenIdle}); never rejects. */
  private track<T>(step: Promise<T>): Promise<T | void> {
    const tracked = step.catch((error: unknown) => {
      this.opts.logger?.warn?.("[replies] a background step failed", error);
    });
    this.inFlight.add(tracked);
    void tracked.then(() => this.inFlight.delete(tracked));
    return tracked;
  }

  /** Look at a target's thread for its open subscriptions: serialized per target, one pass queued at most. */
  private evaluate(targetId: string): Promise<void> {
    if (this.evalQueued.has(targetId)) return this.evalTail.get(targetId) ?? Promise.resolve();
    this.evalQueued.add(targetId);
    const before = this.evalTail.get(targetId) ?? Promise.resolve();
    const run = before.then(async () => {
      this.evalQueued.delete(targetId);
      await this.evaluateNow(targetId);
    }).catch((error: unknown) => {
      this.opts.logger?.warn?.("[replies] could not look at a target's reply", error);
    });
    this.evalTail.set(targetId, run);
    void run.then(() => {
      if (this.evalTail.get(targetId) === run) this.evalTail.delete(targetId);
    });
    return run;
  }

  private async evaluateNow(targetId: string): Promise<void> {
    const api = this.api;
    if (!api || this.stopped) return;
    const open = (sub: Sub): boolean => sub.toThreadId === targetId && (sub.state === "waiting" || sub.state === "notify");
    // Past the maximum age (§12.7): no reply came; the requester hears so and its slot is freed.
    for (const sub of this.openSubs().filter(open)) {
      if (this.ageMs(sub.createdAt) > MAX_SUBSCRIPTION_AGE_MS) {
        // Its message, if still queued, never runs: the requester is told no reply will come.
        if (!sub.posted) await this.opts.queue.drop(sub.queueEntryId ?? sub.commandId);
        const deliver = await this.claim(sub, { kind: "notice", text: this.noticeText("expired", sub) });
        await deliver();
      }
    }
    const subs = this.openSubs().filter(open);
    if (subs.length === 0) return;
    if (this.isClosed(targetId)) {
      for (const sub of subs) {
        if (!sub.posted) await this.opts.queue.drop(sub.queueEntryId ?? sub.commandId);
        const deliver = await this.claim(sub, { kind: "closed" });
        await deliver();
      }
      return;
    }
    let snap: ThreadSnapshotPayload;
    try {
      snap = await readThread(api, targetId);
    } catch {
      return;
    }
    const asking = snap.pending.approvals.length + snap.pending.userInputs.length > 0;
    let dirty = false;
    for (const sub of subs) {
      if (!sub.posted || sub.posted.steered || (sub.state !== "waiting" && sub.state !== "notify")) continue;
      const turn = this.boundTurn(sub, snap);
      if (!turn) {
        if (sub.posted.messageId !== undefined || sub.turnId !== undefined) {
          const outside = await this.lookOutsideWindow(api, sub, snap);
          if (outside.kind === "found") {
            if (outside.result) {
              const deliver = await this.claim(sub, outside.result);
              await deliver();
            }
            continue;
          }
          if (outside.kind === "unknown") continue;
        }
        if (this.bindingLost(sub, snap)) {
          // Rewound away, or never identifiable: no reply will come for it.
          const deliver = await this.claim(sub, { kind: "notice", text: this.noticeText("lost", sub) });
          await deliver();
        }
        continue;
      }
      if (turn.turnId !== null && sub.turnId !== turn.turnId) {
        sub.turnId = turn.turnId;
        dirty = true;
      }
      if (SETTLED_TURN_STATES.has(turn.state)) {
        const deliver = await this.claim(sub, resultOf(snap, turn));
        await deliver();
      } else if (asking) {
        // The turn this message caused asks the target's user something: the waiter returns,
        // the subscription stays `notify` (§8.1).
        this.waiters.get(sub.id)?.needsInput();
      }
    }
    if (dirty) await this.persist();
  }

  /**
   * The turn a posted message opened: by its recorded turn id, else by the user message the
   * command appended (`Turn.userMessageId`). Without a recorded message (the receipt's events
   * could not be read back): the requester's turn at this exchange hop whose own user message is
   * this very text (by hash — never a `reply: "none"` message's turn, whose header differs) and
   * that no other subscription holds, oldest first.
   */
  private boundTurn(sub: Sub, snap: ThreadSnapshotPayload): Turn | undefined {
    if (sub.turnId !== undefined) {
      const byId = snap.turns.find((turn) => turn.turnId === sub.turnId);
      if (byId) return byId;
    }
    const messageId = sub.posted?.messageId;
    if (messageId !== undefined) return snap.turns.find((turn) => turn.userMessageId === messageId);
    const inputHash = sub.posted?.inputHash;
    if (sub.turnId !== undefined || inputHash === undefined) return undefined;
    const held = new Set(
      this.subs()
        .filter((other) => other !== sub && other.toThreadId === sub.toThreadId && other.turnId !== undefined)
        .map((other) => other.turnId!)
    );
    const textOf = (id: string | undefined): string | undefined => {
      const item = id === undefined ? undefined : snap.items.find((candidate) => candidate.kind === "message" && candidate.id === id);
      return item?.kind === "message" ? item.text : undefined;
    };
    return snap.turns.find((turn) => {
      if (turn.causedBy?.threadId !== sub.fromThreadId || turn.causedBy.exchangeId !== sub.exchange.id || turn.causedBy.hop !== sub.exchange.hop) return false;
      if (turn.turnId !== null && held.has(turn.turnId)) return false;
      const text = textOf(turn.userMessageId);
      return text !== undefined && hashText(text.trim()) === inputHash;
    });
  }

  /**
   * A posted message's turn is gone for good: its user message and its turn are both absent from
   * the thread (a rewind), or it could not be identified at all for {@link UNBOUND_GRACE_MS}.
   */
  private bindingLost(sub: Sub, snap: ThreadSnapshotPayload): boolean {
    const messageId = sub.posted?.messageId;
    if (messageId !== undefined) {
      return !snap.turns.some((turn) => turn.userMessageId === messageId) && !snap.items.some((item) => item.id === messageId);
    }
    if (sub.turnId !== undefined) return !snap.turns.some((turn) => turn.turnId === sub.turnId);
    return this.ageMs(sub.posted?.at ?? sub.createdAt) > UNBOUND_GRACE_MS;
  }

  /**
   * What the command `commandId` opened, from its receipt's events: the user message of a new turn,
   * or — no turn start: an older host ignored `ifIdle` and the message steered — the running turn.
   */
  private async bindingOf(targetId: string, commandId: string, seq: number): Promise<{ messageId?: string; steeredTurnId?: string }> {
    const api = this.api;
    if (!api) return {};
    try {
      const res = await api.request("GET", agentChatRoutes.thread(targetId), {
        query: { after: String(Math.max(0, seq - TURN_COMMAND_EVENTS)) }
      });
      const body = res.body as ThreadReadResponse | null;
      if (res.status >= 400 || body?.kind !== "events") return {};
      const own = body.events.filter((event) => event.commandId === commandId);
      const start = own.find((event) => event.type === "thread.turn-start-requested");
      if (start?.type === "thread.turn-start-requested") return { messageId: start.payload.messageId };
      const message = own.find((event) => event.type === "thread.message-sent" && event.payload.role === "user");
      if (message?.type === "thread.message-sent") {
        return message.payload.turnId !== null ? { steeredTurnId: message.payload.turnId } : { messageId: message.payload.messageId };
      }
      return {};
    } catch {
      return {};
    }
  }

  // --- claiming and delivering ------------------------------------------------------

  /**
   * The router's CAS on a settled (or ended) bound turn, persisted before any effect — a failed
   * write aborts it (state restored; the next look tries again). A LIVE waiter is handed the
   * result; a waiter released meanwhile is not, and the result is delivered instead. Returns the
   * delivery step of a router claim (a no-op otherwise): the caller runs it now or, inside another
   * chat's lane, outside it.
   */
  private async claim(sub: Sub, result: ReplyResult): Promise<() => Promise<void>> {
    const nothing = async (): Promise<void> => undefined;
    if (sub.state !== "waiting" && sub.state !== "notify") return nothing;
    const waiter = sub.state === "waiting" && !sub.released ? this.waiters.get(sub.id) : undefined;
    if (waiter?.live) {
      sub.state = "claimed-by-waiter";
      sub.updatedAt = this.stamp();
      if (!(await this.persist())) {
        sub.state = "waiting";
        return nothing;
      }
      if (waiter.live) {
        waiter.resolve(result);
        this.finish(sub, result.kind === "closed" ? "closed" : "waiter");
        sub.handOuts = 1;
        this.rememberHandedOut(sub, result);
        if (result.kind === "notice") sub.answeredNotice = result.text;
        await this.persist();
        return nothing;
      }
      // Released while the claim was written: nobody reads that answer, so it is delivered.
      sub.state = "notify";
    }
    return this.claimForRouter(sub, result);
  }

  /**
   * `waiting | notify → claimed-by-router` and the delivery record in ONE persisted write, so no
   * crash leaves a claim without its delivery. A requester already closed drops it instead.
   */
  private async claimForRouter(sub: Sub, result: ReplyResult): Promise<() => Promise<void>> {
    const nothing = async (): Promise<void> => undefined;
    // One delivery per subscription, whoever claims (a boot reconciliation and a re-check may
    // resume the same claim at once): an existing record is handed, never a second one made.
    const existing = this.outbox.deliveries.find((d) => d.subscriptionId === sub.id);
    if (existing) return () => this.hand(existing);
    const prior = sub.state;
    if (this.isClosed(sub.fromThreadId)) {
      this.opts.logger?.warn?.("[replies] the requester closed before its reply arrived; dropped", { subscriptionId: sub.id });
      this.finish(sub, "dropped");
      await this.persist();
      return nothing;
    }
    const delivery = this.makeDelivery(sub, result);
    sub.state = "claimed-by-router";
    sub.updatedAt = this.stamp();
    if (result.kind === "closed") sub.ended = "closed";
    this.outbox.deliveries.push(delivery);
    if (!(await this.persist())) {
      sub.state = prior;
      this.outbox.deliveries = this.outbox.deliveries.filter((other) => other !== delivery);
      return nothing;
    }
    return () => this.hand(delivery);
  }

  private makeDelivery(sub: Sub, result: ReplyResult): ReplyDeliveryRecord & { notice?: true } {
    const id = this.newId();
    const title = this.titleOf(sub);
    const project = this.opts.sessions.get(sub.toThreadId)?.projectPath ?? "";
    // A delivery is the hop after the turn whose reply it carries (§8.4).
    const replying = result.kind === "turn" && result.causedBy ? result.causedBy.hop : sub.exchange.hop;
    const hop = replying + 1;
    const over = exceedsExchangeLimit({ hop });
    const causedBy: CausedBy = { threadId: sub.toThreadId, exchangeId: sub.exchange.id, hop: Math.min(hop, MAX_EXCHANGE_HOPS + 1) };
    let outcome: ReplyDeliveryOutcome;
    let text: string;
    const notice = { title, sessionId: sub.toThreadId };
    if (result.kind === "closed") {
      outcome = "closed";
      text = result.afterReply
        ? `"${oneLine(title) || "Untitled"}" replied, but it was closed before its reply could be delivered again, and the reply can no longer be read.`
        : replyNoticeText("closed", notice);
    } else if (result.kind === "notice") {
      outcome = "failed";
      text = result.text;
    } else if (result.state !== "completed") {
      outcome = result.state;
      text = replyNoticeText(result.state, { ...notice, ...(result.error ? { error: result.error } : {}) });
    } else if (result.reply.length === 0) {
      outcome = "empty";
      text = replyNoticeText("empty", notice);
    } else {
      outcome = "reply";
      text = cutReply(result.reply, sub.toThreadId);
    }
    if (over) {
      outcome = "exchange-limit";
      text = `${text}\n\n${replyNoticeText("exchange-limit", notice)}`;
    }
    const input = buildThreadMessage({
      origin: "reply",
      fromTitle: title,
      fromSessionId: sub.toThreadId,
      ...(project ? { fromProject: projectLabel(project) } : {}),
      text
    });
    return {
      id,
      subscriptionId: sub.id,
      toThreadId: sub.fromThreadId,
      fromThreadId: sub.toThreadId,
      commandId: id,
      queueEntryId: id,
      ...(result.kind === "turn" && result.turnId !== null ? { turnId: result.turnId } : {}),
      outcome,
      input,
      interactionMode: sub.interactionMode,
      causedBy,
      state: "pending",
      createdAt: this.stamp(),
      // A notice is never taken back by a late waiter (D-4): it carries no reply.
      ...(result.kind === "notice" || result.kind === "closed" ? { notice: true as const } : {})
    };
  }

  /**
   * Into the requester's delivery queue (kind `reply`, a fixed id): queued until it is idle, oldest
   * first. Only a `pending` delivery, and never twice at once (`handing`).
   */
  private async hand(delivery: ReplyDeliveryRecord): Promise<void> {
    if (delivery.state !== "pending" || this.handing.has(delivery.id)) return;
    this.handing.add(delivery.id);
    try {
      await this.handNow(delivery);
    } finally {
      this.handing.delete(delivery.id);
    }
  }

  private async handNow(delivery: ReplyDeliveryRecord): Promise<void> {
    const sub = this.subs().find((candidate) => candidate.id === delivery.subscriptionId);
    if (this.isClosed(delivery.toThreadId)) {
      delivery.state = "dropped";
      if (sub && sub.state !== "done") this.finish(sub, "dropped");
      this.opts.logger?.warn?.("[replies] the requester closed before its reply arrived; dropped", { deliveryId: delivery.id });
      await this.persist();
      return;
    }
    const entry: MergeOutboxEntry = {
      mergeId: delivery.queueEntryId ?? delivery.id,
      parentSessionId: delivery.toThreadId,
      childSessionId: delivery.fromThreadId,
      input: delivery.input,
      queuedAt: delivery.createdAt,
      state: "queued",
      attempts: 0,
      kind: "reply",
      causedBy: delivery.causedBy,
      subscriptionId: delivery.subscriptionId,
      context: queueContext([replyDeliveryContext(delivery.fromThreadId)]),
      ...(delivery.interactionMode === "plan" ? { interactionMode: "plan" as const } : {})
    };
    try {
      const result = await this.opts.queue.enqueue(entry);
      // An immediate post already marked it delivered (`posted`).
      if (delivery.state === "pending") delivery.state = result.delivery === "sent" ? "delivered" : "queued";
    } catch (error) {
      // Stays `pending`: the safety re-check (or the next boot) hands it again under the same id.
      this.opts.logger?.warn?.("[replies] a reply could not be queued yet", { deliveryId: delivery.id, error: (error as Error)?.message });
      await this.persist();
      return;
    }
    if (sub && sub.state !== "done") this.finish(sub, sub.ended === "closed" ? "closed" : "delivered");
    await this.persist();
  }

  /** A requester closed: its open subscriptions (and their waiters) and undelivered replies are dropped (logged). */
  private async requesterClosed(requesterId: string): Promise<void> {
    if (!this.isClosed(requesterId)) return;
    let changed = false;
    for (const sub of this.openSubs()) {
      if (sub.fromThreadId !== requesterId || sub.state === "claimed-by-router") continue;
      const waiter = this.waiters.get(sub.id);
      this.finish(sub, "dropped");
      // Its wait ends now, its registration released (the chat that waited is gone).
      waiter?.resolve({ kind: "closed" });
      changed = true;
    }
    for (const delivery of this.outbox.deliveries) {
      if (delivery.toThreadId !== requesterId || (delivery.state !== "pending" && delivery.state !== "queued")) continue;
      if (delivery.state === "queued") await this.opts.queue.drop(delivery.queueEntryId ?? delivery.id);
      delivery.state = "dropped";
      changed = true;
    }
    if (changed) {
      this.opts.logger?.warn?.("[replies] a requester closed: its pending replies were dropped", { requesterId });
      await this.persist();
    }
  }

  // --- helpers ----------------------------------------------------------------

  private subs(): Sub[] {
    return this.outbox.subscriptions as Sub[];
  }

  private openSubs(): Sub[] {
    return this.subs().filter((sub) => sub.state !== "done");
  }

  /** A tab missing from the records, once they are known to have loaded. */
  private isClosed(sessionId: string): boolean {
    return (this.opts.sessionsLoaded?.() ?? true) && this.opts.sessions.get(sessionId) === undefined;
  }

  private finish(sub: Sub, ended: Ended): void {
    this.historyBackoff.delete(sub.id);
    sub.state = "done";
    sub.ended = ended;
    sub.updatedAt = this.stamp();
  }

  private titleOf(sub: Sub): string {
    return this.opts.sessions.get(sub.toThreadId)?.title ?? sub.toTitle ?? sub.toThreadId;
  }

  /** The sentence a requester reads when no reply will come (`ReplyResult` kind `notice`). */
  private noticeText(kind: "discarded" | "steered" | "lost" | "expired", sub: Sub): string {
    const title = oneLine(this.titleOf(sub)) || "Untitled";
    const look = `Read what it did with read_transcript {sessionId: "${sub.toThreadId}"}.`;
    switch (kind) {
      case "discarded":
        return `Your message to "${title}" was discarded from its queue before it ran, so no reply will come.`;
      case "steered":
        return `"${title}" was already working, so your message joined its running turn instead of starting its own; no reply of its own will come. ${look}`;
      case "lost":
        return `Orquester lost track of the turn your message to "${title}" started (it was rewound, or could not be identified), so no reply will come. ${look}`;
      case "expired":
        return `No reply from "${title}" came within ${Math.round(MAX_SUBSCRIPTION_AGE_MS / 86_400_000)} days; Orquester stopped waiting for it. ${look}`;
    }
  }

  private ageMs(iso: string): number {
    const at = Date.parse(iso);
    return Number.isNaN(at) ? 0 : this.now().getTime() - at;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private newId(): string {
    return (this.opts.newId ?? randomUUID)();
  }

  private armRecheck(): void {
    const ms = this.opts.recheckMs ?? DEFAULT_RECHECK_MS;
    if (ms <= 0 || this.stopped || this.recheck) return;
    this.recheck = setInterval(() => this.track(this.recheckNow()), ms);
    this.recheck.unref?.();
  }

  /** The safety re-check's pass (run by its timer; tests call it directly instead of waiting). */
  async recheckNow(): Promise<void> {
    if (this.stopped) return;
    const work: Promise<unknown>[] = [];
    for (const delivery of this.outbox.deliveries) if (delivery.state === "pending") work.push(this.hand(delivery));
    for (const sub of this.openSubs()) if (sub.state === "claimed-by-router") work.push(this.resumeClaimed(sub));
    for (const sub of this.pendingRedeliveries()) work.push(this.redeliver(sub));
    // Closures no bus event reported (tabs closed before the records loaded) are found here too.
    for (const id of new Set(this.openSubs().map((sub) => sub.fromThreadId))) work.push(this.requesterClosed(id));
    for (const id of new Set(this.openSubs().map((sub) => sub.toThreadId))) work.push(this.evaluate(id));
    await Promise.all(work.map((p) => p.catch(() => undefined)));
  }

  /** Done records beyond {@link DONE_MEMORY} leave the file, oldest first; open ones never do. */
  private prune(): void {
    const done = this.subs().filter((sub) => sub.state === "done");
    if (done.length > DONE_MEMORY) {
      const drop = new Set(done.slice(0, done.length - DONE_MEMORY));
      this.outbox.subscriptions = this.outbox.subscriptions.filter((sub) => !drop.has(sub as Sub));
    }
    const final = this.outbox.deliveries.filter((d) => d.state === "delivered" || d.state === "dropped");
    if (final.length > DONE_MEMORY) {
      const drop = new Set(final.slice(0, final.length - DONE_MEMORY));
      this.outbox.deliveries = this.outbox.deliveries.filter((d) => !drop.has(d));
    }
  }

  /**
   * Written in order, the latest state each time; unreadable entries and unknown top-level keys go
   * back as they came. Resolves false when the write failed (or the outbox is read-only this run).
   */
  private persist(): Promise<boolean> {
    if (this.readOnly !== null) return Promise.resolve(false);
    this.prune();
    const snapshot = serializeReplyOutbox(this.outbox);
    const attempt = this.writes.then(() =>
      writeAtomic(this.opts.outboxFile, snapshot).then(
        () => true,
        (error: unknown) => {
          this.opts.logger?.warn?.("[replies] could not write the reply outbox", error);
          return false;
        }
      )
    );
    this.pendingWrites += 1;
    this.writes = attempt.then(() => {
      this.pendingWrites -= 1;
    });
    return attempt;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A short, stable hash of a message text (the binding fallback compares texts by it). */
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Context chips as the queue entry stores them (its schema keeps unknown chip fields). */
function queueContext(chips: ComposerContextRecord[]): NonNullable<MergeOutboxEntry["context"]> {
  return chips as unknown as NonNullable<MergeOutboxEntry["context"]>;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `workspace/project` of a project path, as a header names it. */
export function projectLabel(projectPath: string): string {
  const project = basename(projectPath);
  const workspace = basename(dirname(projectPath));
  return workspace && workspace !== project ? `${workspace}/${project}` : project;
}

/** A reply that fits a turn, cut with a pointer to the rest. */
function cutReply(reply: string, sessionId: string): string {
  if (reply.length <= REPLY_DELIVERY_MAX_TEXT_CHARS) return reply;
  return `${reply.slice(0, REPLY_DELIVERY_MAX_TEXT_CHARS)}\n\n[… cut here: read the whole reply with read_transcript {sessionId: "${sessionId}"}.]`;
}

/** A settled bound turn's result. */
export function resultOf(snap: ThreadSnapshotPayload, turn: Turn): ReplyResult {
  const state = turn.state === "completed" ? "completed" : turn.state === "failed" ? "failed" : "interrupted";
  const reply = turn.turnId === null ? "" : assistantTextForTurn(snap.items, turn.turnId).trim();
  const error = turn.errorMessage ?? (state === "failed" ? (snap.head.session.lastError ?? undefined) : undefined);
  return {
    kind: "turn",
    turnId: turn.turnId,
    state,
    reply,
    ...(error ? { error } : {}),
    ...(turn.causedBy ? { causedBy: turn.causedBy } : {})
  };
}

/** What a waiter answers for a result (§13 d: an empty reply is `emptyReply`, no `reply`). */
export function waitResponseOf(result: ReplyResult): ReplyWaitResponse {
  if (result.kind === "closed") return { outcome: "closed" };
  if (result.kind === "notice") return { outcome: "replied", turnId: null, state: "failed", error: result.text };
  return {
    outcome: "replied",
    turnId: result.turnId,
    state: result.state,
    ...(result.reply.length > 0 ? { reply: result.reply } : result.state === "completed" ? { emptyReply: true as const } : {}),
    ...(result.error ? { error: result.error } : {})
  };
}

async function readThread(api: DaemonApi, sessionId: string): Promise<ThreadSnapshotPayload> {
  const res = await api.request("GET", agentChatRoutes.thread(sessionId));
  const body = res.body as ThreadReadResponse | null;
  if (res.status >= 400 || body?.kind !== "snapshot") throw new Error("thread unreadable");
  return body.thread;
}

/** 0600, tmp + rename: a crash leaves the old outbox or the new one, never half of one. */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
