/**
 * The right rail's one door into a chat: which chat it acts on, and how text
 * reaches that chat — into its composer at the caret (Insert), or out as the
 * user's message exactly as Enter would send it (Send). Both panels (Saved
 * prompts, History) go through here and nowhere else.
 */

import React from "react";

import { activeChatTab, subscribeActiveChatTab } from "../../lib/agent-chat-active-tab";
import {
  COMPOSER_NOT_MOUNTED_REASON,
  composerHandle,
  insertComposerText,
  submitComposerText
} from "../agent-chat/composer/composer-bridge";

/** Why Insert/Send have nowhere to go: no chat tab is the visible one. */
export const NO_CHAT_TARGET_REASON = "Open a chat tab to insert or send.";

export type ChatDelivery =
  | { ok: true; disposition: "inserted" | "sent" | "queued" }
  /** A bare `/plan` or `/default` switched the chat's mode, as Enter does. */
  | { ok: true; disposition: "mode"; mode: "plan" | "default" }
  | { ok: false; reason: string };

/** What an Insert or a Send that landed says on the card that sent it — one wording for both panels. */
export function deliveredText(delivery: Extract<ChatDelivery, { ok: true }>): string {
  switch (delivery.disposition) {
    case "inserted":
      return "Inserted";
    case "sent":
      return "Sent";
    case "queued":
      return "Queued — sends when the current turn finishes";
    case "mode":
      return delivery.mode === "plan" ? "Plan mode on" : "Plan mode off";
  }
}

/** Why an Insert or a Send had nothing to deliver. */
export const NOTHING_TO_DELIVER_REASON = "Nothing to insert: the prompt is empty.";

/**
 * The chat the rail acts on — the visible chat tab, the focused cell in the
 * grid — or `null` while a terminal, Files, Git or nothing is showing. The
 * shell publishes it (`setActiveChatTab`), so this follows every tab switch.
 */
export function useActiveChatTarget(): string | null {
  return React.useSyncExternalStore(subscribeActiveChatTab, activeChatTab, activeChatTab);
}

/**
 * Insert: `text` goes into the chat's composer at its caret, and the composer
 * takes focus with the caret right after it, so the user can keep typing.
 */
export function insertIntoChat(sessionId: string | null, text: string): ChatDelivery {
  if (sessionId === null) return { ok: false, reason: NO_CHAT_TARGET_REASON };
  if (text.trim().length === 0) return { ok: false, reason: NOTHING_TO_DELIVER_REASON };
  if (composerHandle(sessionId) === null) return { ok: false, reason: COMPOSER_NOT_MOUNTED_REASON };
  insertComposerText(sessionId, text, "cursor", { focus: true });
  return { ok: true, disposition: "inserted" };
}

/**
 * Send: `text` leaves as the user's message through the chat's own send path
 * — its guards, mode, model and follow-up preference (`queued` behind a
 * running turn when the user queues follow-ups). The draft is untouched.
 */
export function sendToChat(sessionId: string | null, text: string): ChatDelivery {
  if (sessionId === null) return { ok: false, reason: NO_CHAT_TARGET_REASON };
  return submitComposerText(sessionId, text);
}
