/**
 * Test support: fold one recorded capture through the REAL normaliser, with
 * turns opened and settled the way the session does it (`session.ts`) — so a
 * replay test sees every row on the turn the adapter would put it on.
 *
 * - A `session/prompt` the harness sent opens a turn; its RPC result settles
 *   it (the richest source, as the session's `trackPrompt` does).
 * - A prompt the CLI started on its own — a wake — is told apart by the
 *   session's own rule (`prompt-queue.ts`, `GrokPromptQueue`), opens a turn
 *   of its own once no other is open, re-arms the monitors it carries lines
 *   of, and replays the frames that named it while it waited; that prompt's
 *   `turn_completed` settles it (fixtures README observation 40).
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
import { framePromptId, GrokPromptQueue, type CliPrompt } from "../prompt-queue.ts";
import { parseXaiUsage } from "../usage.ts";

/** Every private-channel method a session routes to `handleXaiNotification`. */
export const XAI_ROUTED_METHODS: ReadonlySet<string> = new Set<string>([
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.session_notification),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.session_update),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.task_backgrounded),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.task_completed),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.monitor_event)
]);

/**
 * Events are stamped at the capture's own recorded times (`t`, ms since the
 * CLI was spawned) from this origin, so a clock that follows `createdAt` — the
 * liveness registry's in `fold-seam.test.ts` — sees the real gaps: a monitor's
 * line before the wake it caused, ten seconds between heartbeats.
 */
export const CAPTURE_EPOCH_MS = Date.UTC(2026, 8, 25, 12, 0, 0);

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
  /** The recorded time of the frame being folded: every event it produces is stamped with it. */
  let now = 0;
  const turn: TurnCursor = { current: undefined };
  const grok = new GrokNormalizer(
    {
      threadId: "thread-1",
      stamp: () => {
        counter += 1;
        return { eventId: `e${counter}`, createdAt: new Date(CAPTURE_EPOCH_MS + now).toISOString() };
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
  const queue = new GrokPromptQueue();
  const held = new Map<string, JsonRpcFrame[]>();
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
    const next = queue.takePending();
    if (next !== undefined) {
      openWake(next);
    }
  };
  const openWake = (prompt: CliPrompt): void => {
    wakes += 1;
    wakePromptId = prompt.promptId;
    open(`wake-${wakes}`);
    events.push(...grok.rearmMonitors(prompt.monitorTaskIds));
    const frames = held.get(prompt.promptId) ?? [];
    held.delete(prompt.promptId);
    for (const frame of frames) {
      fold(frame);
    }
  };
  const control: DriverControl = {
    grok,
    turn,
    interrupt: () => {
      const before = events.length;
      // As the session's `interrupt`: the cancel ends the CLI prompt already
      // running, which opens no turn (`dropWakeTheCancelEnds`).
      const running = queue.newestPending();
      if (running !== undefined) {
        queue.dropPending(running.promptId);
        held.delete(running.promptId);
      }
      settle({ stopReason: "cancelled", cancellationCategory: "MidTurnAbort" });
      return events.splice(before);
    }
  };

  for (const entry of readCapture(file)) {
    now = Math.max(now, entry.t);
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
    fold(frame);
  }
  return { events, grok, turns, sessionId };

  /** One agent frame: held while it names a wake waiting for its turn, as the session holds it. */
  function fold(frame: JsonRpcFrame): void {
    const method = frame.method;
    if (typeof method !== "string") {
      return;
    }
    const params = frame.params as { sessionId?: string; update?: Record<string, unknown> } | undefined;
    const holdable = method === "session/update" || method === "_x.ai/session_notification";
    const named = holdable && params?.sessionId === sessionId ? framePromptId(params) : undefined;
    if (named !== undefined && queue.isPending(named)) {
      held.set(named, [...(held.get(named) ?? []), frame]);
      return;
    }
    if (method === "session/update") {
      events.push(...grok.handleSessionUpdate(frame.params as SessionNotification));
      return;
    }
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
      return;
    }
    if (method === "_x.ai/queue/changed" && params?.sessionId === sessionId) {
      const seen = queue.observe(frame.params);
      if (seen.kind === "cli") {
        if (turn.current === undefined) {
          openWake(seen.prompt);
        } else {
          queue.pend(seen.prompt);
        }
      }
    }
  }

}
