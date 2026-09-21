import { DEFAULT_RUNTIME_MODE, RUNTIME_MODES, type AgentRuntimeMode } from "@orquester/api";

import type { FollowUpBehavior } from "./agent-chat/queue.logic";

/**
 * Client-local agent-chat preferences (spec §7.4, §4.6.7).
 *
 * Per **device**, not per daemon: "Enter sends / Enter queues" and "list skills
 * under `/`" are how one person likes the composer to behave, and the
 * continuation-after-restart setting — the one that IS daemon state, because
 * the host resolves it per project at boot — lives in `appConfig.agents`
 * instead.
 *
 * Loaded field-wise with a fallback, per the repo rule that raw `JSON.parse`
 * output never reaches typed code: a blob written by an older bundle outlives
 * every deploy (see `lib/app-config.ts`, `lib/view-mode.ts`).
 */

/**
 * Which of send/queue a plain Enter performs while a turn is running (§7.4).
 *
 * Re-exported, not re-declared: the queue logic owns the union because it is
 * the module that acts on it, and the composer re-exports the same one. Three
 * structurally-identical copies is how they silently diverge.
 */
export type { FollowUpBehavior } from "./agent-chat/queue.logic";

export interface ChatPrefs {
  /**
   * A plain send follows this; holding the mod key with Enter does the opposite
   * for that one message. `"steer"` interrupts nothing — it hands the text to
   * the running turn — while `"queue"` parks it until the next tool boundary.
   */
  followUpBehavior: FollowUpBehavior;
  /**
   * List skills in the `/` menu. `$` always lists them, so turning this off
   * makes `/` a pure command menu rather than hiding anything.
   * *T3: `packages/contracts/src/settings.ts:448` — `showSkillsInSlashMenu`, default `true`.*
   */
  showSkillsInSlashMenu: boolean;
  /** Last picked permission mode per registry agent id (the launcher's chips). */
  runtimeModeByAgent: Record<string, AgentRuntimeMode>;
}

export const DEFAULT_CHAT_PREFS: ChatPrefs = {
  // T3's default is "steer"; a message typed while the agent works is nearly
  // always a correction, and queueing one silently is the surprising half.
  followUpBehavior: "steer",
  showSkillsInSlashMenu: true,
  runtimeModeByAgent: {}
};

const KEY = "orquester.chat-prefs";

function isRuntimeMode(value: unknown): value is AgentRuntimeMode {
  return typeof value === "string" && (RUNTIME_MODES as readonly string[]).includes(value);
}

/** Field-wise validation with a per-field fallback; never throws. */
export function sanitizeChatPrefs(raw: unknown): ChatPrefs {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_CHAT_PREFS;
  }
  const rec = raw as Record<string, unknown>;
  const out: ChatPrefs = { ...DEFAULT_CHAT_PREFS, runtimeModeByAgent: {} };
  if (rec.followUpBehavior === "steer" || rec.followUpBehavior === "queue") {
    out.followUpBehavior = rec.followUpBehavior;
  }
  if (typeof rec.showSkillsInSlashMenu === "boolean") {
    out.showSkillsInSlashMenu = rec.showSkillsInSlashMenu;
  }
  const modes = rec.runtimeModeByAgent;
  if (typeof modes === "object" && modes !== null && !Array.isArray(modes)) {
    for (const [agentId, mode] of Object.entries(modes as Record<string, unknown>)) {
      if (agentId.length > 0 && isRuntimeMode(mode)) {
        out.runtimeModeByAgent[agentId] = mode;
      }
    }
  }
  return out;
}

export function loadChatPrefs(): ChatPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sanitizeChatPrefs(JSON.parse(raw)) : DEFAULT_CHAT_PREFS;
  } catch {
    return DEFAULT_CHAT_PREFS;
  }
}

export function saveChatPrefs(prefs: ChatPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable (private window, blocked site data) */
  }
}

/** The mode a launcher row starts an agent in: the remembered pick, else §4.4's default. */
export function runtimeModeForAgent(prefs: ChatPrefs, agentId: string): AgentRuntimeMode {
  return prefs.runtimeModeByAgent[agentId] ?? DEFAULT_RUNTIME_MODE;
}

/** Short chip labels for the four permission modes (§4.4's own column headings). */
export const RUNTIME_MODE_LABELS: Record<AgentRuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Accept edits",
  auto: "Auto",
  "full-access": "Full access"
};

/** One-line explanation shown as the chip's title. */
export const RUNTIME_MODE_HINTS: Record<AgentRuntimeMode, string> = {
  "approval-required": "Every tool call asks you first.",
  "auto-accept-edits": "File edits apply without asking; commands still ask.",
  auto: "The agent reviews its own work where the provider supports it; otherwise supervised.",
  "full-access": "Nothing asks. The agent may run any command in this project."
};
