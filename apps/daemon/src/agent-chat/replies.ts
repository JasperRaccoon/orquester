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

import { randomUUID } from "node:crypto";
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
  type ReplySubscriptionResponse,
  type ReplyWaitResponse,
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
import { registerWait } from "./waits.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReplyErrorCode =
  | "THREAD_NOT_FOUND"
  | "INVALID_COMMAND"
  | "COMMAND_REJECTED"
  | "HOST_UNAVAILABLE"
  | "EXCHANGE_LIMIT"
  | "REPLY_SUBSCRIPTION_LIMIT"
  | "PERMISSION_DENIED"
  | "WAIT_CYCLE";

/** HTTP status per refusal (the routes answer `{error: {code, message}}`). */
export const REPLY_ERROR_STATUS: Record<ReplyErrorCode, number> = {
  THREAD_NOT_FOUND: 404,
  INVALID_COMMAND: 400,
  COMMAND_REJECTED: 409,
  HOST_UNAVAILABLE: 503,
  EXCHANGE_LIMIT: 409,
  REPLY_SUBSCRIPTION_LIMIT: 429,
  PERMISSION_DENIED: 403,
  WAIT_CYCLE: 409
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

/** The post that landed: its command id, the receipt's seq, and the user message it opened. */
interface Posted {
  commandId: string;
  seq: number;
  messageId?: string;
}

type Sub = ReplySubscriptionRecord & { posted?: Posted; ended?: Ended; toTitle?: string };

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
  | { kind: "closed" }
  | { kind: "discarded"; error: string };

interface Waiter {
  resolve(result: ReplyResult): void;
  needsInput(): void;
}

const DEFAULT_RECHECK_MS = 30_000;
/** Events a `/turn` command appends at most (meta, message, turn start): read back from its receipt seq. */
const TURN_COMMAND_EVENTS = 3;
/** `done` subscriptions and final deliveries kept for repeats and late waits; older ones are pruned. */
const DONE_MEMORY = 200;
const MAX_IDEMPOTENCY_KEY_CHARS = 180;
const MAX_WAIT_SECONDS = 600;
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
  private unsubscribe: (() => void) | null = null;
  private recheck: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Resolved once the boot reconciliation ran; new subscriptions wait for it (§13 e). */
  private ready: Promise<void> | null = null;
  private readonly waiters = new Map<string, Waiter>();
  /** Per target: the evaluation chain, and whether one more pass is already queued on it. */
  private readonly evalTail = new Map<string, Promise<void>>();
  private readonly evalQueued = new Set<string>();

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
      if (this.openSubs().some((sub) => sub.toThreadId === id)) void this.evaluate(id);
      if (this.isClosed(id)) void this.requesterClosed(id);
    });
    this.ready = this.reconcile().catch((error: unknown) => {
      this.opts.logger?.warn?.("[replies] the boot reconciliation failed", error);
    });
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
    const pending = this.subs().filter((sub) => sub.fromThreadId === fromThreadId && sub.state !== "done").length;
    if (pending >= MAX_PENDING_REPLY_SUBSCRIPTIONS) {
      throw new ReplyError(
        `This chat already waits for ${pending} replies (limit ${MAX_PENDING_REPLY_SUBSCRIPTIONS}). Wait for some to arrive first.`,
        "REPLY_SUBSCRIPTION_LIMIT"
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
  async wait(
    targetId: string,
    subscriptionId: string,
    raw: unknown,
    opts: { principal?: CallerPrincipal; signal?: AbortSignal } = {}
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
    if (sub.state === "claimed-by-router" || sub.state === "done") {
      return sub.ended === "closed" ? { outcome: "closed" } : { outcome: "notify", reason: "timeout", willNotify: true };
    }
    if (sub.state === "claimed-by-waiter" || this.waiters.has(sub.id)) {
      throw new ReplyError("Another wait already holds this reply.", "COMMAND_REJECTED");
    }
    let release: () => void;
    try {
      release = registerWait(sub.fromThreadId, sub.toThreadId);
    } catch (error) {
      if (error instanceof ToolError) throw new ReplyError(error.message, "WAIT_CYCLE");
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
        if (timer !== null) clearTimer(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        release();
        resolve(response);
      };
      const waiter: Waiter = {
        resolve: (result) => finishWith(waitResponseOf(result)),
        needsInput: () => giveUp("needs-input")
      };
      // The waiter's CAS: `waiting → notify`. Lost to the router (it set `claimed-by-waiter` and
      // took the waiter out first), the router's result is on its way to `waiter.resolve`.
      const giveUp = (reason: "timeout" | "needs-input"): void => {
        if (settled || sub.state !== "waiting" || this.waiters.get(sub.id) !== waiter) return;
        this.waiters.delete(sub.id);
        sub.state = "notify";
        sub.updatedAt = this.stamp();
        void this.persist().then(() => finishWith({ outcome: "notify", reason, willNotify: true }));
        // Persisted `notify` can now be claimed by the router: look again (the turn may have settled).
        void this.evaluate(sub.toThreadId);
      };
      this.waiters.set(sub.id, waiter);
      timer = setTimer(() => giveUp("timeout"), timeoutSeconds * 1000);
      if (opts.signal?.aborted) giveUp("timeout");
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
      void this.evaluate(sub.toThreadId);
    });
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
    sub.posted = { commandId, seq, ...(binding.messageId !== undefined ? { messageId: binding.messageId } : {}) };
    if (binding.turnId !== undefined) sub.turnId = binding.turnId;
    sub.updatedAt = this.stamp();
    await this.persist();
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
      this.waiters.delete(sub.id);
      this.finish(sub, "discarded");
      await this.persist();
      waiter?.resolve({ kind: "discarded", error: "You discarded the message before it ran." });
      return;
    }
    const title = sub.toTitle ?? this.opts.sessions.get(sub.toThreadId)?.title ?? sub.toThreadId;
    // The claim is recorded before the queue lets the entry go; its delivery follows outside the
    // target's lane (it goes into the requester's).
    const deliver = await this.claim(sub, {
      kind: "discarded",
      error: `the message was discarded from "${oneLine(title)}"'s queue before it ran`
    });
    void deliver();
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
    for (const requester of new Set(this.openSubs().map((sub) => sub.fromThreadId))) {
      if (this.isClosed(requester)) await this.requesterClosed(requester);
    }
    await Promise.all([...new Set(this.openSubs().map((sub) => sub.toThreadId))].map((id) => this.evaluate(id)));
  }

  /** A `claimed-by-router` subscription after a restart: its persisted delivery resumes, never a second claim. */
  private async resumeClaimed(sub: Sub): Promise<void> {
    const delivery = this.outbox.deliveries.find((d) => d.subscriptionId === sub.id);
    if (delivery) {
      if (delivery.state === "pending") await this.hand(delivery);
      else {
        this.finish(sub, "delivered");
        await this.persist();
      }
      return;
    }
    // Claimed, but the crash came before its delivery was written: read the result again.
    const result = await this.resultFor(sub);
    if (result) await this.deliverResult(sub, result);
  }

  /** The bound turn's result now, for a subscription already claimed; null while it cannot be read. */
  private async resultFor(sub: Sub): Promise<ReplyResult | null> {
    if (this.isClosed(sub.toThreadId)) return { kind: "closed" };
    const api = this.api;
    if (!api) return null;
    let snap: ThreadSnapshotPayload;
    try {
      snap = await readThread(api, sub.toThreadId);
    } catch {
      return null;
    }
    const turn = this.boundTurn(sub, snap);
    return turn && SETTLED_TURN_STATES.has(turn.state) ? resultOf(snap, turn) : null;
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
    const subs = this.openSubs().filter((sub) => sub.toThreadId === targetId && (sub.state === "waiting" || sub.state === "notify"));
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
      if (!sub.posted || (sub.state !== "waiting" && sub.state !== "notify")) continue;
      const turn = this.boundTurn(sub, snap);
      if (!turn) continue;
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
   * could not be read back): the requester's turn at this exchange hop that no other subscription
   * holds, oldest first — the queue posts one sender's messages to one target in order.
   */
  private boundTurn(sub: Sub, snap: ThreadSnapshotPayload): Turn | undefined {
    if (sub.turnId !== undefined) {
      const byId = snap.turns.find((turn) => turn.turnId === sub.turnId);
      if (byId) return byId;
    }
    const messageId = sub.posted?.messageId;
    if (messageId !== undefined) return snap.turns.find((turn) => turn.userMessageId === messageId);
    if (sub.turnId !== undefined) return undefined;
    const held = new Set(
      this.subs()
        .filter((other) => other !== sub && other.toThreadId === sub.toThreadId && other.turnId !== undefined)
        .map((other) => other.turnId!)
    );
    return snap.turns.find(
      (turn) =>
        turn.causedBy?.threadId === sub.fromThreadId &&
        turn.causedBy.exchangeId === sub.exchange.id &&
        turn.causedBy.hop === sub.exchange.hop &&
        !(turn.turnId !== null && held.has(turn.turnId))
    );
  }

  /** The user message (or, for a steer, the running turn) the command `commandId` opened, from its receipt's events. */
  private async bindingOf(targetId: string, commandId: string, seq: number): Promise<{ messageId?: string; turnId?: string }> {
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
        // No turn start: the target was working after all and the message steered its turn.
        return message.payload.turnId !== null ? { turnId: message.payload.turnId } : { messageId: message.payload.messageId };
      }
      return {};
    } catch {
      return {};
    }
  }

  // --- claiming and delivering ------------------------------------------------------

  /**
   * The router's CAS on a settled (or ended) bound turn. Persists the claim, hands a waiter its
   * result, and returns the delivery step for a router claim (a no-op otherwise) — the caller runs
   * it now or, inside another chat's lane, outside it.
   */
  private async claim(sub: Sub, result: ReplyResult): Promise<() => Promise<void>> {
    const nothing = async (): Promise<void> => undefined;
    if (sub.state !== "waiting" && sub.state !== "notify") return nothing;
    const waiter = sub.state === "waiting" ? this.waiters.get(sub.id) : undefined;
    if (waiter) {
      this.waiters.delete(sub.id);
      sub.state = "claimed-by-waiter";
      sub.updatedAt = this.stamp();
      await this.persist();
      waiter.resolve(result);
      this.finish(sub, result.kind === "closed" ? "closed" : "waiter");
      await this.persist();
      return nothing;
    }
    sub.state = "claimed-by-router";
    sub.updatedAt = this.stamp();
    await this.persist();
    return () => this.deliverResult(sub, result);
  }

  /** A claimed result becomes a delivery to the requester — persisted, then handed to the queue. */
  private async deliverResult(sub: Sub, result: ReplyResult): Promise<void> {
    if (this.isClosed(sub.fromThreadId)) {
      this.opts.logger?.warn?.("[replies] the requester closed before its reply arrived; dropped", { subscriptionId: sub.id });
      this.finish(sub, "dropped");
      await this.persist();
      return;
    }
    const delivery = this.makeDelivery(sub, result);
    this.outbox.deliveries.push(delivery);
    if (result.kind === "closed") sub.ended = "closed";
    await this.persist();
    await this.hand(delivery);
  }

  private makeDelivery(sub: Sub, result: ReplyResult): ReplyDeliveryRecord {
    const id = this.newId();
    const title = this.opts.sessions.get(sub.toThreadId)?.title ?? sub.toTitle ?? sub.toThreadId;
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
      text = replyNoticeText("closed", notice);
    } else if (result.kind === "discarded") {
      outcome = "failed";
      text = replyNoticeText("failed", { ...notice, error: result.error });
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
      createdAt: this.stamp()
    };
  }

  /** Into the requester's delivery queue (kind `reply`, a fixed id): queued until it is idle, oldest first. */
  private async hand(delivery: ReplyDeliveryRecord): Promise<void> {
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

  /** A requester closed: its open subscriptions and undelivered replies are dropped (logged). */
  private async requesterClosed(requesterId: string): Promise<void> {
    if (!this.isClosed(requesterId)) return;
    let changed = false;
    for (const sub of this.openSubs()) {
      if (sub.fromThreadId !== requesterId || sub.state === "claimed-by-router") continue;
      this.waiters.delete(sub.id);
      this.finish(sub, "dropped");
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
    sub.state = "done";
    sub.ended = ended;
    sub.updatedAt = this.stamp();
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
    this.recheck = setInterval(() => {
      for (const delivery of this.outbox.deliveries) if (delivery.state === "pending") void this.hand(delivery);
      // Closures no bus event reported (tabs closed before the records loaded) are found here too.
      for (const id of new Set(this.openSubs().map((sub) => sub.fromThreadId))) void this.requesterClosed(id);
      for (const id of new Set(this.openSubs().map((sub) => sub.toThreadId))) void this.evaluate(id);
    }, ms);
    this.recheck.unref?.();
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
    this.writes = attempt.then(() => undefined);
    return attempt;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
  if (result.kind === "discarded") return { outcome: "replied", turnId: null, state: "failed", error: result.error };
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
