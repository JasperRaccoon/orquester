/**
 * Scheduled prompts (`@orquester/api` `agent-chat/scheduled-prompts.ts`): composer messages the
 * daemon sends into their chat at a set time, so the user need not be there.
 *
 * Each prompt lives on its chat's tab record (`ChatSessionManager.setScheduledPrompts`, persisted
 * in `sessions.json`) before a timer is armed, and every step it takes is persisted before it is
 * taken, so a restart, a deploy or a crash loses none: {@link start} re-arms every one, and one
 * that came due while the daemon was down goes out as soon as the daemon's API is bound.
 *
 * At its time a prompt is posted through the chat's own `/turn` route (through `DaemonApi`, so it
 * is gated, receipted and broadcast as the GUI's send) with `ifIdle`, under the command id
 * `scheduled:<promptId>:<attempts>`. A daemon that died mid-post re-posts under the same id, and
 * the host's receipt answers it without a second send. Then:
 * - sent: the prompt leaves the list — it is the chat's message now;
 * - the chat is busy (a turn, an approval, a question): `waiting`, sent once the chat is idle
 *   (woken by the tab's "updated" lifecycle event, never a poll);
 * - the host is unavailable (restarting, the thread not created yet): tried again shortly;
 * - the chat refused it: `failed`, with the reason, kept until the user retries or cancels it.
 *
 * Every decision about a chat runs in that chat's lane, one after another.
 */

import {
  agentChatCommandPath,
  MAX_SCHEDULE_AHEAD_MS,
  MAX_SCHEDULED_PROMPTS_PER_CHAT,
  MAX_TURN_ATTACHMENTS,
  MAX_TURN_INPUT_CHARS,
  scheduledPromptView,
  TURN_NOT_IDLE,
  type AgentChatErrorCode,
  type ScheduledPrompt,
  type ScheduledPromptCancelResponse,
  type ScheduledPromptsResponse,
  type ScheduledPromptTurn
} from "@orquester/api/agent-chat";
import type { SessionSummary } from "@orquester/api";
import type { EventEmitter } from "node:events";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import { readThreadHead } from "../mcp/reads.ts";
import type { Clock } from "../workflows/contracts.ts";
import { acceptsMessage } from "./lineage.ts";

/** A post the host could not take (restarting, the thread not created yet) is tried again after this. */
const DEFAULT_RETRY_MS = 30_000;
/** Prompt ids are client-minted: short, and safe inside a command id. */
const PROMPT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_CONTEXT_CHIPS = 50;
const MAX_MODEL_SELECTION_JSON = 8_000;
const MAX_REFS_JSON = 64_000;

/** A refusal the routes map onto the §6.2 envelope. */
export class ScheduledPromptError extends Error {
  constructor(
    message: string,
    readonly code: AgentChatErrorCode
  ) {
    super(message);
    this.name = "ScheduledPromptError";
  }
}

/** The tab records the service reads and writes (`ChatSessionManager`). */
export interface ScheduledPromptsChat {
  get(id: string): SessionSummary | undefined;
  list(): SessionSummary[];
  scheduledPromptsOf(id: string): ScheduledPrompt[];
  setScheduledPrompts(id: string, prompts: readonly ScheduledPrompt[]): unknown;
  readonly lifecycle: Pick<EventEmitter, "on" | "off">;
}

export interface ScheduledPromptsOptions {
  chat: ScheduledPromptsChat;
  clock: Clock;
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  retryMs?: number;
}

/** What one attempt to post a prompt came to. */
type PostOutcome = { kind: "sent" } | { kind: "busy" } | { kind: "unavailable" } | { kind: "refused"; message: string };

/** The command id a prompt's attempt posts under: the same across a re-post, new for each retry. */
export function scheduledPromptCommandId(prompt: Pick<ScheduledPrompt, "id" | "attempts">): string {
  return `scheduled:${prompt.id}:${prompt.attempts}`;
}

function isBusy(tab: SessionSummary): boolean {
  const turn = tab.latestTurn?.state;
  return (
    turn === "running" ||
    turn === "pending" ||
    tab.chatSessionStatus === "running" ||
    tab.chatSessionStatus === "starting" ||
    tab.hasPendingApprovals === true ||
    tab.hasPendingUserInput === true ||
    tab.goal?.continuing === true
  );
}

export class ChatScheduledPrompts {
  private api: DaemonApi | null = null;
  /** One timer per prompt, keyed `<sessionId>\n<promptId>`. */
  private readonly timers = new Map<string, { cancel(): void }>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  /** Per chat, whether its last summary read busy: a prompt waits for the busy → idle edge. */
  private readonly busy = new Map<string, boolean>();
  private started = false;
  private stopped = false;
  private readonly onClosed = ({ id }: { id: string }): void => {
    this.forgetChat(id);
    this.busy.delete(id);
  };
  /** A chat that went idle sends the prompts that were waiting for it. */
  private readonly onUpdated = (summary: SessionSummary): void => {
    const busy = isBusy(summary);
    const was = this.busy.get(summary.id);
    this.busy.set(summary.id, busy);
    if (this.stopped || !this.api || busy || was !== true) return;
    if (!this.opts.chat.scheduledPromptsOf(summary.id).some((p) => p.state === "waiting")) return;
    this.wake(summary.id);
  };

  constructor(private readonly opts: ScheduledPromptsOptions) {}

  private get retryMs(): number {
    return this.opts.retryMs ?? DEFAULT_RETRY_MS;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Boot, once the tab records are loaded: a prompt caught `sending` by the restart goes back to
   * `waiting` (it re-posts under the same command id, which the host's receipt dedupes), and every
   * prompt is armed again — one already due fires once the API is bound ({@link attachApi}).
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.opts.chat.lifecycle.on("closed", this.onClosed);
    this.opts.chat.lifecycle.on("updated", this.onUpdated);
    for (const tab of this.opts.chat.list()) {
      const prompts = this.opts.chat.scheduledPromptsOf(tab.id);
      if (prompts.some((p) => p.state === "sending")) {
        this.opts.chat.setScheduledPrompts(
          tab.id,
          prompts.map((p) => (p.state === "sending" ? { ...p, state: "waiting" as const } : p))
        );
      }
      this.armChat(tab.id);
    }
  }

  /** Bind the daemon's own API: every prompt that came due before it existed goes out now. */
  attachApi(api: DaemonApi): void {
    this.api = api;
    if (!this.started) return;
    for (const tab of this.opts.chat.list()) this.armChat(tab.id);
  }

  stop(): void {
    this.stopped = true;
    this.opts.chat.lifecycle.off("closed", this.onClosed);
    this.opts.chat.lifecycle.off("updated", this.onUpdated);
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
  }

  /** Resolves once every decision queued so far has run (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.lanes.size > 0) await Promise.allSettled([...this.lanes.values()]);
  }

  private lane<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    this.lanes.set(id, tail);
    void tail.then(() => {
      if (this.lanes.get(id) === tail) this.lanes.delete(id);
    });
    return run;
  }

  private forgetChat(sessionId: string): void {
    for (const [key, timer] of this.timers) {
      if (key.startsWith(`${sessionId}\n`)) {
        timer.cancel();
        this.timers.delete(key);
      }
    }
  }

  private forget(sessionId: string, promptId: string): void {
    const key = `${sessionId}\n${promptId}`;
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
  }

  /** Arm every `scheduled` prompt of the chat at its time, and wake the `waiting` ones. */
  private armChat(sessionId: string): void {
    const prompts = this.opts.chat.scheduledPromptsOf(sessionId);
    for (const prompt of prompts) {
      if (prompt.state === "scheduled") this.arm(sessionId, prompt.id, Date.parse(prompt.sendAt));
    }
    if (prompts.some((p) => p.state === "waiting")) this.wake(sessionId);
  }

  /** The prompt's timer, at `at` (at once when that passed). */
  private arm(sessionId: string, promptId: string, at: number): void {
    this.forget(sessionId, promptId);
    if (this.stopped) return;
    const key = `${sessionId}\n${promptId}`;
    const delay = Number.isFinite(at) ? Math.max(0, at - this.opts.clock.now().getTime()) : 0;
    const timer = this.opts.clock.setTimeout(() => {
      if (this.timers.get(key) === timer) this.timers.delete(key);
      this.wake(sessionId);
    }, delay);
    this.timers.set(key, timer);
  }

  /** Send what is due in the chat, in its lane. Never throws. */
  private wake(sessionId: string): void {
    if (this.stopped) return;
    void this.lane(sessionId, () => this.sendDue(sessionId)).catch((error: unknown) =>
      this.opts.logger?.error?.("[scheduled-prompts] a scheduled prompt could not be sent", { sessionId, error: String(error) })
    );
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /** Post every due prompt of the chat, oldest time first, until one cannot go out. */
  private async sendDue(sessionId: string): Promise<void> {
    for (;;) {
      const now = this.opts.clock.now().getTime();
      const due = this.opts.chat
        .scheduledPromptsOf(sessionId)
        .filter((p) => p.state === "waiting" || (p.state === "scheduled" && Date.parse(p.sendAt) <= now))
        .sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt))[0];
      if (!due) return;
      // A timer clamped by the platform (or fired a little early) waits on.
      if (due.state === "scheduled" && Date.parse(due.sendAt) - now > 1_000) {
        this.arm(sessionId, due.id, Date.parse(due.sendAt));
        return;
      }
      if (!(await this.send(sessionId, due))) return;
    }
  }

  /** One attempt at `prompt`. True when it went out (the next due one may follow). */
  private async send(sessionId: string, prompt: ScheduledPrompt): Promise<boolean> {
    const api = this.api;
    if (!api) {
      // `attachApi` wakes it; until then it is due and waits.
      this.update(sessionId, prompt.id, (p) => ({ ...p, state: "waiting" }));
      return false;
    }
    this.forget(sessionId, prompt.id);
    const outcome = await this.post(api, sessionId, prompt);
    switch (outcome.kind) {
      case "sent":
        this.remove(sessionId, prompt.id);
        return true;
      case "busy": {
        this.update(sessionId, prompt.id, (p) => ({ ...p, state: "waiting" }));
        const tab = this.opts.chat.get(sessionId);
        if (tab && isBusy(tab)) {
          // The summary's busy → idle edge wakes it (`onUpdated`).
          this.busy.set(sessionId, true);
        } else {
          // Busy only by the thread's own head, which the summary may never mark: look again shortly.
          this.arm(sessionId, prompt.id, this.opts.clock.now().getTime() + this.retryMs);
        }
        return false;
      }
      case "unavailable":
        this.update(sessionId, prompt.id, (p) => ({ ...p, state: "scheduled" }));
        this.arm(sessionId, prompt.id, this.opts.clock.now().getTime() + this.retryMs);
        return false;
      case "refused":
        this.opts.logger?.warn?.("[scheduled-prompts] the chat refused a scheduled prompt", { sessionId, message: outcome.message });
        this.update(sessionId, prompt.id, (p) => ({ ...p, state: "failed", error: outcome.message, attempts: p.attempts + 1 }));
        // The others still go out: this one waits for the user.
        return true;
    }
  }

  /** Post the prompt's turn under its command id, only into a chat that can take it. */
  private async post(api: DaemonApi, sessionId: string, prompt: ScheduledPrompt): Promise<PostOutcome> {
    const tab = this.opts.chat.get(sessionId);
    if (!tab) return { kind: "refused", message: "The chat was closed." };
    try {
      const head = await readThreadHead(api, sessionId);
      if (!acceptsMessage(tab, head)) return { kind: "busy" };
    } catch {
      return { kind: "unavailable" };
    }
    // Persisted before the post: a restart from here re-posts under the same command id.
    this.update(sessionId, prompt.id, (p) => ({ ...p, state: "sending" }));
    try {
      const res = await api.request("POST", agentChatCommandPath(sessionId, "turn"), {
        body: {
          commandId: scheduledPromptCommandId(prompt),
          input: prompt.input,
          ...(prompt.attachments && prompt.attachments.length > 0 ? { attachments: prompt.attachments } : {}),
          ...(prompt.context && prompt.context.length > 0 ? { context: prompt.context } : {}),
          ...(prompt.interactionMode ? { interactionMode: prompt.interactionMode } : {}),
          ...(prompt.modelSelection ? { modelSelection: prompt.modelSelection } : {}),
          ifIdle: true
        }
      });
      if (res.status < 400) return { kind: "sent" };
      const error = (res.body as { error?: { code?: string; message?: string } } | null)?.error;
      if (res.status === 503 || error?.code === "HOST_UNAVAILABLE") return { kind: "unavailable" };
      if (res.status === 409 && error?.code === TURN_NOT_IDLE) return { kind: "busy" };
      return { kind: "refused", message: error?.message ?? `The chat refused the message (${res.status}).` };
    } catch {
      return { kind: "unavailable" };
    }
  }

  private update(sessionId: string, promptId: string, change: (prompt: ScheduledPrompt) => ScheduledPrompt): void {
    const prompts = this.opts.chat.scheduledPromptsOf(sessionId);
    this.opts.chat.setScheduledPrompts(
      sessionId,
      prompts.map((p) => (p.id === promptId ? change(p) : p))
    );
  }

  private remove(sessionId: string, promptId: string): void {
    this.forget(sessionId, promptId);
    this.opts.chat.setScheduledPrompts(
      sessionId,
      this.opts.chat.scheduledPromptsOf(sessionId).filter((p) => p.id !== promptId)
    );
  }

  // -------------------------------------------------------------------------
  // The user's actions (routes)
  // -------------------------------------------------------------------------

  private requireChat(sessionId: string): void {
    if (!this.opts.chat.get(sessionId)) throw new ScheduledPromptError("No chat session with that id.", "THREAD_NOT_FOUND");
  }

  private requirePrompt(sessionId: string, promptId: string): ScheduledPrompt {
    this.requireChat(sessionId);
    const prompt = this.opts.chat.scheduledPromptsOf(sessionId).find((p) => p.id === promptId);
    if (!prompt) throw new ScheduledPromptError("That scheduled prompt was already sent or cancelled.", "ITEM_NOT_FOUND");
    return prompt;
  }

  private view(sessionId: string): ScheduledPromptsResponse {
    return { scheduledPrompts: this.opts.chat.scheduledPromptsOf(sessionId).map(scheduledPromptView) };
  }

  /** Schedule a prompt. A repeat of the same id answers the list as it is (a retried request). */
  create(sessionId: string, body: unknown): Promise<ScheduledPromptsResponse> {
    return this.lane(sessionId, async () => {
      this.requireChat(sessionId);
      const input = parseCreate(body, this.opts.clock.now().getTime());
      const prompts = this.opts.chat.scheduledPromptsOf(sessionId);
      if (prompts.some((p) => p.id === input.id)) return this.view(sessionId);
      if (prompts.length >= MAX_SCHEDULED_PROMPTS_PER_CHAT) {
        throw new ScheduledPromptError(
          `This chat already has ${MAX_SCHEDULED_PROMPTS_PER_CHAT} scheduled prompts. Cancel one first.`,
          "COMMAND_REJECTED"
        );
      }
      const prompt: ScheduledPrompt = {
        ...input,
        createdAt: this.opts.clock.now().toISOString(),
        state: "scheduled",
        attempts: 0
      };
      const next = [...prompts, prompt].sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
      // Persisted first: a crash after this line still sends it.
      this.opts.chat.setScheduledPrompts(sessionId, next);
      this.arm(sessionId, prompt.id, Date.parse(prompt.sendAt));
      return this.view(sessionId);
    });
  }

  /** Cancel a prompt that has not gone out; answers it whole, so the composer can take it back. */
  cancel(sessionId: string, promptId: string): Promise<ScheduledPromptCancelResponse> {
    return this.lane(sessionId, async () => {
      const prompt = this.requirePrompt(sessionId, promptId);
      // In the lane, a prompt is never mid-post here: `sending` is only a restart's leftover.
      this.remove(sessionId, promptId);
      return { ...this.view(sessionId), cancelled: prompt };
    });
  }

  /** Send a prompt now, whatever its time — also the retry of a failed one. A busy chat gets it once idle. */
  sendNow(sessionId: string, promptId: string): Promise<ScheduledPromptsResponse> {
    return this.lane(sessionId, async () => {
      if (!this.api) throw new ScheduledPromptError("The daemon is still starting. Try again in a moment.", "HOST_UNAVAILABLE");
      const prompt = this.requirePrompt(sessionId, promptId);
      const ready: ScheduledPrompt = { ...prompt, state: "waiting" };
      delete ready.error;
      this.update(sessionId, promptId, () => ready);
      await this.send(sessionId, ready);
      return this.view(sessionId);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A create body, checked; the turn's own parts are the host's to judge when it is posted. */
function parseCreate(body: unknown, now: number): ScheduledPromptTurn & { id: string; sendAt: string } {
  const invalid = (message: string): never => {
    throw new ScheduledPromptError(message, "INVALID_COMMAND");
  };
  if (!isRecord(body)) return invalid("A scheduled prompt is required.");
  const id = typeof body.id === "string" ? body.id : "";
  if (!PROMPT_ID.test(id)) invalid("id must be 1-100 letters, digits, - or _.");
  const at = typeof body.sendAt === "string" ? Date.parse(body.sendAt) : Number.NaN;
  if (!Number.isFinite(at)) invalid("sendAt must be a time.");
  if (at - now > MAX_SCHEDULE_AHEAD_MS) invalid("A prompt can be scheduled at most 30 days ahead.");
  const input = typeof body.input === "string" ? body.input.trim() : "";
  const attachments = body.attachments === undefined ? [] : body.attachments;
  if (!Array.isArray(attachments) || attachments.length > MAX_TURN_ATTACHMENTS || !attachments.every(isAttachmentRef)) {
    invalid(`attachments must be at most ${MAX_TURN_ATTACHMENTS} uploaded attachments.`);
  }
  if (input.length === 0 && (attachments as unknown[]).length === 0) invalid("The prompt is empty.");
  if (input.length > MAX_TURN_INPUT_CHARS) invalid(`The prompt is over ${MAX_TURN_INPUT_CHARS} characters.`);
  const context = body.context === undefined ? [] : body.context;
  if (
    !Array.isArray(context) ||
    context.length > MAX_CONTEXT_CHIPS ||
    !context.every((c) => isRecord(c) && typeof c.kind === "string" && typeof c.label === "string")
  ) {
    invalid("context must be composer chips.");
  }
  if (JSON.stringify([attachments, context]).length > MAX_REFS_JSON) invalid("attachments and context are too large.");
  const mode = body.interactionMode;
  if (mode !== undefined && mode !== "default" && mode !== "plan") invalid("interactionMode must be default or plan.");
  const model = body.modelSelection;
  if (
    model !== undefined &&
    (!isRecord(model) || typeof model.model !== "string" || JSON.stringify(model).length > MAX_MODEL_SELECTION_JSON)
  ) {
    invalid("modelSelection must name a model.");
  }
  return {
    id,
    // Never in the past: one asked for "now" (or a clock a little behind) goes out at once.
    sendAt: new Date(Math.max(at, now)).toISOString(),
    input,
    ...((attachments as unknown[]).length > 0 ? { attachments: attachments as ScheduledPromptTurn["attachments"] } : {}),
    ...((context as unknown[]).length > 0 ? { context: context as ScheduledPromptTurn["context"] } : {}),
    ...(mode !== undefined ? { interactionMode: mode as "default" | "plan" } : {}),
    ...(model !== undefined ? { modelSelection: model as unknown as NonNullable<ScheduledPromptTurn["modelSelection"]> } : {})
  };
}

function isAttachmentRef(value: unknown): boolean {
  return isRecord(value) && typeof value.type === "string" && typeof value.id === "string" && typeof value.name === "string";
}
