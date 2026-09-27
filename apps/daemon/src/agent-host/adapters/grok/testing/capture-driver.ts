/**
 * Test support: fold one recorded capture through the REAL normaliser, with
 * turns opened and settled the way the session does it (`session.ts`) — so a
 * replay test sees every row on the turn the adapter would put it on.
 *
 * - A `session/prompt` the harness sent opens a turn; its RPC result settles
 *   it (the richest source, as the session's `trackPrompt` does).
 * - A prompt the CLI started on its own — a wake — runs through the session's
 *   OWN coordinator (`prompt-queue.ts`, `GrokWakes`): the same rule tells it
 *   apart, the same gate holds the frames that wait for its turn (every frame
 *   after the first one naming it, in order, bounded, never dropped), and the
 *   same code opens its turn, re-arms the monitors it carries lines of and
 *   hands the frames back; that prompt's `turn_completed` settles it
 *   (fixtures README observation 40). A Stop is the session's cancel rule,
 *   and the capture's end is its exit: whatever still waits joins the open
 *   turn.
 * - A harness `note` is handed to `atNote`, which is how a test plays the
 *   user's part at the recorded moment (a Stop, say); `endAtNote` ends the
 *   drive there, when the recorded rest answered a move the test did not
 *   make.
 *
 * Test-only code, kept beside the mock peer: nothing under `src/` imports it
 * but tests.
 */

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { SessionNotification } from "../acp/_generated/schema.ts";
import { XAI_EXTENSION_NOTIFICATIONS, xaiMethodSpellings } from "../acp/_generated/xai.ts";
import { readCapture, type JsonRpcFrame } from "../fixtures.ts";
import { GrokNormalizer, type GrokTurnOutcome } from "../normalize.ts";
import { GrokWakes, isParentSessionId } from "../prompt-queue.ts";
import { parseXaiUsage } from "../usage.ts";

/** Every private-channel method a session routes to `handleXaiNotification`. */
export const XAI_ROUTED_METHODS: ReadonlySet<string> = new Set<string>([
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.session_notification),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.session_update),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.task_backgrounded),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.task_completed),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.monitor_event),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.scheduled_task_created),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.scheduled_task_fired),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.scheduled_task_deleted)
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
    /**
     * End the drive at the first harness note this accepts, once `atNote`
     * handled it: what the capture recorded after it is what the CLI did
     * after the HARNESS's move, not after the test's own (a Stop in place of
     * an answer, say). The capture's end follows, as ever.
     */
    endAtNote?: (note: string) => boolean;
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
  let wakePromptId: string | undefined;
  let sessionId = "";
  let wakeCount = 0;
  let prompts = 0;

  const open = (id: string): void => {
    turn.current = id;
    turns.push(id);
    grok.beginTurn();
    events.push(grok.event("turn.started", {}, id));
  };
  const isParent = (id: unknown): boolean => isParentSessionId(sessionId, id);
  const wakes = new GrokWakes(
    grok,
    {
      turnOpen: () => turn.current !== undefined,
      openTurn: (prompt) => {
        wakeCount += 1;
        wakePromptId = prompt.promptId;
        open(`wake-${wakeCount}`);
      },
      emit: (rows) => {
        events.push(...rows);
      },
      notePrompt: () => {},
      debug: () => {}
    },
    { parentSessionId: () => sessionId }
  );
  const settle = (outcome: GrokTurnOutcome): void => {
    const id = turn.current;
    if (id === undefined) {
      return;
    }
    events.push(...grok.endTurn());
    events.push(grok.turnCompleted(id, outcome));
    turn.current = undefined;
    wakePromptId = undefined;
    wakes.turnSettled();
  };
  const control: DriverControl = {
    grok,
    turn,
    interrupt: () => {
      const before = events.length;
      // As the session's `interrupt`: the cancel ends the CLI prompt still
      // running, which opens no turn; what it streamed joins this one; the
      // calls it cut close on the turn before it settles.
      wakes.cancelEnds();
      events.push(...grok.cutTurnCalls("Stopped."));
      settle({ stopReason: "cancelled", cancellationCategory: "MidTurnAbort" });
      return events.splice(before);
    }
  };

  for (const entry of readCapture(file)) {
    now = Math.max(now, entry.t);
    if (entry.dir === "note") {
      events.push(...(options.atNote?.(String(entry.frame), control) ?? []));
      if (options.endAtNote?.(String(entry.frame)) === true) {
        break;
      }
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
  // The capture's end is the process's: what still waits joins the open turn.
  wakes.drop("the capture ended");
  return { events, grok, turns, sessionId };

  /** One agent frame, through the session's own gate. */
  function fold(frame: JsonRpcFrame): void {
    const method = frame.method;
    if (typeof method !== "string") {
      return;
    }
    const params = frame.params as { sessionId?: string; update?: Record<string, unknown> } | undefined;
    if (method === "_x.ai/queue/changed") {
      if (isParent(params?.sessionId)) {
        wakes.queueChanged(frame.params);
      }
      return;
    }
    if (method !== "session/update" && !XAI_ROUTED_METHODS.has(method)) {
      return;
    }
    if (wakes.offer(frame.params, () => fold(frame))) {
      return;
    }
    if (method === "session/update") {
      events.push(...grok.handleSessionUpdate(frame.params as SessionNotification));
      return;
    }
    events.push(...grok.handleXaiNotification(method, frame.params));
    const update = params?.update;
    if (
      isParent(params?.sessionId) &&
      update?.["sessionUpdate"] === "turn_completed" &&
      wakePromptId !== undefined &&
      update["prompt_id"] === wakePromptId
    ) {
      settle({
        stopReason: typeof update["stop_reason"] === "string" ? update["stop_reason"] : null,
        usage: parseXaiUsage(update["usage"])
      });
    }
  }
}
