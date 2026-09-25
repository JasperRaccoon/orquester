/**
 * Test support: fold one recorded capture through the REAL normaliser, with
 * turns opened and settled the way the session does it (`session.ts`) — so a
 * replay test sees every row on the turn the adapter would put it on.
 *
 * - A `session/prompt` the harness sent opens a turn; its RPC result settles
 *   it (the richest source, as the session's `trackPrompt` does).
 * - A `runningPromptId` the parent's `_x.ai/queue/changed` never listed in
 *   `entries` is a prompt the CLI started on its own — a wake — and opens a
 *   turn of its own once no other is open; that prompt's `turn_completed`
 *   settles it (fixtures README observation 40).
 * - A harness `note` is handed to `atNote`, which is how a test plays the
 *   user's part at the recorded moment (a Stop, say).
 *
 * Test-only code, kept beside the mock peer: nothing under `src/` imports it
 * but tests.
 */

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { SessionNotification } from "../acp/_generated/schema.ts";
import { XAI_EXTENSION_NOTIFICATIONS, xaiMethodSpellings } from "../acp/_generated/xai.ts";
import { readCapture, type JsonRpcFrame } from "../fixtures.ts";
import { GrokNormalizer, type GrokTurnOutcome } from "../normalize.ts";
import { parseXaiUsage } from "../usage.ts";

/** Every private-channel method a session routes to `handleXaiNotification`. */
export const XAI_ROUTED_METHODS: ReadonlySet<string> = new Set<string>([
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.session_notification),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.session_update),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.task_backgrounded),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.task_completed),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.monitor_event)
]);

export interface TurnCursor {
  current: string | undefined;
}

/** What a test can do at a recorded harness note. */
export interface DriverControl {
  readonly grok: GrokNormalizer;
  readonly turn: TurnCursor;
  /** Settle the open turn as the session's `interrupt` does (a Stop). */
  interrupt(): RuntimeEvent[];
}

export interface DrivenCapture {
  readonly events: RuntimeEvent[];
  readonly grok: GrokNormalizer;
  /** Every turn the drive opened, in order: `turn-N` for a prompt, `wake-N` for the CLI's own. */
  readonly turns: string[];
  /** The parent ACP session the capture's `session/new` answered. */
  readonly sessionId: string;
}

export function driveCapture(
  file: string,
  options: {
    atNote?: (note: string, control: DriverControl) => RuntimeEvent[];
    contextWindow?: number;
  } = {}
): DrivenCapture {
  let counter = 0;
  const turn: TurnCursor = { current: undefined };
  const grok = new GrokNormalizer(
    {
      threadId: "thread-1",
      stamp: () => {
        counter += 1;
        return { eventId: `e${counter}`, createdAt: new Date(Date.UTC(2026, 8, 25, 12, 0, 0, counter)).toISOString() };
      },
      uuid: () => {
        counter += 1;
        return `u${counter}`;
      },
      activeTurnId: () => turn.current,
      planHost: {
        platform: "linux",
        env: { GROK_HOME: "~/daemon/agent-accounts/grok/b9682f5c-425a-4c53-be6e-28de477be6c7/home" }
      }
    },
    "pending"
  );
  grok.setContextWindow(options.contextWindow);

  const events: RuntimeEvent[] = [];
  const turns: string[] = [];
  const promptTurns = new Map<unknown, string>();
  const listed = new Set<string>();
  const pendingWakes: string[] = [];
  let wakePromptId: string | undefined;
  let sessionId = "";
  let wakes = 0;
  let prompts = 0;

  const open = (id: string): void => {
    turn.current = id;
    turns.push(id);
    grok.beginTurn();
    events.push(grok.event("turn.started", {}, id));
  };
  const settle = (outcome: GrokTurnOutcome): void => {
    const id = turn.current;
    if (id === undefined) {
      return;
    }
    events.push(...grok.endTurn());
    events.push(grok.turnCompleted(id, outcome));
    turn.current = undefined;
    wakePromptId = undefined;
    const next = pendingWakes.shift();
    if (next !== undefined) {
      openWake(next);
    }
  };
  const openWake = (promptId: string): void => {
    wakes += 1;
    wakePromptId = promptId;
    open(`wake-${wakes}`);
  };
  const control: DriverControl = {
    grok,
    turn,
    interrupt: () => {
      const before = events.length;
      settle({ stopReason: "cancelled", cancellationCategory: "MidTurnAbort" });
      return events.splice(before);
    }
  };

  for (const entry of readCapture(file)) {
    if (entry.dir === "note") {
      events.push(...(options.atNote?.(String(entry.frame), control) ?? []));
      continue;
    }
    const frame = entry.frame as JsonRpcFrame;
    if (entry.dir === "send") {
      if (frame.method === "session/prompt") {
        if (turn.current === undefined) {
          prompts += 1;
          open(`turn-${prompts}`);
        }
        promptTurns.set(frame.id, turn.current!);
      }
      continue;
    }
    if (entry.dir !== "recv" || frame === null || typeof frame !== "object") {
      continue;
    }
    const result = frame.result as { sessionId?: unknown; stopReason?: unknown } | undefined;
    if (typeof result?.sessionId === "string" && sessionId === "") {
      sessionId = result.sessionId;
      grok.bindSession(sessionId);
    }
    if (typeof result?.stopReason === "string") {
      const owner = promptTurns.get(frame.id);
      if (owner !== undefined && owner === turn.current) {
        settle({ stopReason: result.stopReason, usage: grok.turnUsage() });
      }
      continue;
    }
    const method = frame.method;
    if (method === "session/update") {
      events.push(...grok.handleSessionUpdate(frame.params as SessionNotification));
      continue;
    }
    if (typeof method !== "string") {
      continue;
    }
    const params = frame.params as { sessionId?: string; update?: Record<string, unknown> } | undefined;
    if (XAI_ROUTED_METHODS.has(method)) {
      events.push(...grok.handleXaiNotification(method, frame.params));
      const update = params?.update;
      if (
        params?.sessionId === sessionId &&
        update?.["sessionUpdate"] === "turn_completed" &&
        wakePromptId !== undefined &&
        update["prompt_id"] === wakePromptId
      ) {
        settle({
          stopReason: typeof update["stop_reason"] === "string" ? update["stop_reason"] : null,
          usage: parseXaiUsage(update["usage"])
        });
      }
      continue;
    }
    if (method === "_x.ai/queue/changed" && params?.sessionId === sessionId) {
      const queue = frame.params as { entries?: Array<{ id?: unknown }>; runningPromptId?: unknown };
      for (const queued of queue.entries ?? []) {
        if (typeof queued.id === "string") {
          listed.add(queued.id);
        }
      }
      const running = queue.runningPromptId;
      if (typeof running === "string" && !listed.has(running) && running !== wakePromptId) {
        if (turn.current === undefined) {
          openWake(running);
        } else if (!pendingWakes.includes(running)) {
          pendingWakes.push(running);
        }
      }
    }
  }
  return { events, grok, turns, sessionId };
}
