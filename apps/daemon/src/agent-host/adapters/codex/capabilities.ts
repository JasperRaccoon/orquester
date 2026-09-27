/**
 * Codex adapter — static capabilities and identity (spec §4.1).
 *
 * Kept in its own module so the probe, the session and the factory share one
 * copy and a test can assert the row of §4.1's table without constructing an
 * adapter.
 */

import type { AdapterCapabilities } from "@orquester/api/agent-chat";

/** Registry ids this adapter serves. Codex has no launcher variants. */
export const CODEX_REF_IDS: readonly string[] = ["codex"] as const;

/**
 * §4.1's Codex row.
 *
 * - `sessionModelSwitch: "in-session"` — `model`, `effort` and `serviceTier`
 *   on `turn/start` override "for this turn **and subsequent turns**", which
 *   is confirmed sticky on 0.154.0 (fixtures README observation 10), so
 *   switching models needs no RPC of its own and never restarts the session.
 * - `promptlessTurnContinuation: true` — Codex is the one provider that can
 *   start a turn with no user text (§4.1).
 * - `supportsConversationRollback: true` — via `thread/turns/list` →
 *   `thread/revert`; `thread/rollback` itself is dead on every thread this CLI
 *   creates (fixtures README observation 7).
 * - `compaction: {type:"native"}` — `thread/compact/start`.
 * - `goals` (goals §4.5) — the host parses `/goal` and this adapter maps it
 *   onto `thread/goal/*` (`goalCommand`), because the app-server has no slash
 *   commands of its own; the chip offers pause, resume and clear; and the
 *   app-server starts the goal's turns by itself (`continuesAcrossTurns`).
 */
export const CODEX_ADAPTER_CAPABILITIES: AdapterCapabilities = {
  sessionModelSwitch: "in-session",
  promptlessTurnContinuation: true,
  supportsConversationRollback: true,
  showPlanModeToggle: true,
  reportsContextWindow: true,
  compaction: { type: "native" },
  goals: { command: "host", actions: ["pause", "resume", "clear"], continuesAcrossTurns: true }
};
