// Automated workflows — gates (spec 2026-11-10 §6.3): the launcher's queued message. The message is
// posted as a NEW turn only (`ifIdle`: refused, unrecorded, while the chat works or waits for its
// user — never a steer), under a command id the gate persisted before the first post, so a re-post
// after a restart is deduped by the host's receipt. While the chat is busy it waits for idle
// (event-driven, `waitForIdle`), then posts again under the same id.

import { TURN_NOT_IDLE } from "@orquester/api/agent-chat";

import { sendCommand, ToolError, type DaemonApi } from "../../chat-client/index.ts";
import type { Clock, WorkflowLogger } from "../contracts.ts";
import { waitForIdle } from "../agent/watch.ts";
import { sleepUntil } from "../run-context.ts";

/** How long to wait before posting again after the daemon answered HOST_UNAVAILABLE. */
const RETRY_MS = 5_000;

export type LauncherDelivery =
  | { kind: "delivered" }
  | { kind: "closed" }
  | { kind: "refused"; message: string }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export async function deliverToLauncher(input: {
  api: DaemonApi;
  sessionId: string;
  commandId: string;
  text: string;
  clock: Clock;
  signal: AbortSignal;
  /** Give up then (the agent phase's deadline). */
  until: Date;
  log?: WorkflowLogger;
}): Promise<LauncherDelivery> {
  for (;;) {
    if (input.signal.aborted) return { kind: "cancelled" };
    if (input.clock.now().getTime() >= input.until.getTime()) return { kind: "timeout" };
    try {
      await sendCommand(input.api, input.sessionId, "turn", { input: input.text, interactionMode: "default", ifIdle: true }, { commandId: input.commandId, retryDelayMs: () => 0 });
      return { kind: "delivered" };
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      if (error.code === TURN_NOT_IDLE) {
        const waited = await waitForIdle({ api: input.api, sessionId: input.sessionId, clock: input.clock, signal: input.signal, until: input.until, ...(input.log ? { logger: input.log } : {}) });
        if (waited === "cancelled") return { kind: "cancelled" };
        if (waited === "closed") return { kind: "closed" };
        if (waited === "timeout") return { kind: "timeout" };
        continue;
      }
      if (error.code === "HOST_UNAVAILABLE" || error.code === "INTERNAL") {
        input.log?.debug("gate launcher message: daemon unavailable, retrying", { code: error.code });
        const reached = await sleepUntil(input.clock, new Date(input.clock.now().getTime() + RETRY_MS), input.signal);
        if (!reached) return { kind: "cancelled" };
        continue;
      }
      if (error.code.endsWith("NOT_FOUND")) return { kind: "closed" };
      return { kind: "refused", message: error.message };
    }
  }
}
