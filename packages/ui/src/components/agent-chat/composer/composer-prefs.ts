/**
 * Per-device composer preferences (spec §7.4, §4.6.8).
 *
 * Three settings, all client-local, all per device rather than per thread:
 * which chord sends, what a plain send does while a turn is running, and
 * whether skills show up under `/` as well as `$`.
 *
 * Loaded **field-wise with a fallback**, never as raw `JSON.parse` output:
 * an old bundle's payload outlives a deploy, and a persisted blob reaching
 * typed code unchecked is how the web client once died on load (AGENTS.md).
 */

import type { FollowUpBehavior, SendShortcut } from "./composer-submission";

export interface ComposerPreferences {
  sendShortcut: SendShortcut;
  /** §7.4: one setting, inverted per message by the mod key. */
  followUpBehavior: FollowUpBehavior;
  /** §4.6.8: default on; `$` lists skills regardless. */
  showSkillsInSlashMenu: boolean;
}

export const DEFAULT_COMPOSER_PREFERENCES: ComposerPreferences = {
  sendShortcut: "enter",
  followUpBehavior: "queue",
  showSkillsInSlashMenu: true
};

const STORAGE_KEY = "orquester:agent-chat:composer-prefs";

function isSendShortcut(value: unknown): value is SendShortcut {
  return value === "enter" || value === "mod-enter" || value === "mod-enter-multiline";
}

function isFollowUpBehavior(value: unknown): value is FollowUpBehavior {
  return value === "steer" || value === "queue";
}

/** Every field is validated on its own: one bad field never loses the others. */
export function parseComposerPreferences(raw: unknown): ComposerPreferences {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_COMPOSER_PREFERENCES };
  const record = raw as Record<string, unknown>;
  return {
    sendShortcut: isSendShortcut(record.sendShortcut)
      ? record.sendShortcut
      : DEFAULT_COMPOSER_PREFERENCES.sendShortcut,
    followUpBehavior: isFollowUpBehavior(record.followUpBehavior)
      ? record.followUpBehavior
      : DEFAULT_COMPOSER_PREFERENCES.followUpBehavior,
    showSkillsInSlashMenu:
      typeof record.showSkillsInSlashMenu === "boolean"
        ? record.showSkillsInSlashMenu
        : DEFAULT_COMPOSER_PREFERENCES.showSkillsInSlashMenu
  };
}

export function loadComposerPreferences(): ComposerPreferences {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_COMPOSER_PREFERENCES };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COMPOSER_PREFERENCES };
    return parseComposerPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_COMPOSER_PREFERENCES };
  }
}

export function saveComposerPreferences(preferences: ComposerPreferences): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    /* quota or availability — the preference stays in memory for this session */
  }
}
