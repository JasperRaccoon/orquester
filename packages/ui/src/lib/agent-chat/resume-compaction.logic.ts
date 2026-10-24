/**
 * Idle compaction's "When you return" (T3 Code's default): a Claude chat over 200,000 tokens whose
 * prompt cache has expired offers to compact before the next message, so the user does not pay a
 * full uncached read of the whole conversation for it. The composer shows a **Compact** chip with
 * the context's size; while it is on, sending compacts first and then sends the message. Clicking
 * it switches to **Full** for that message.
 *
 * Never with "Never" (`off`), which keeps the full history; "Before the cache expires" offers it
 * too, for a chat the daemon could not compact in time (it was busy, or the daemon was down).
 */

import type { IdleCompactionMode } from "@orquester/config";
import { IDLE_COMPACTION_MIN_TOKENS } from "@orquester/api/agent-chat";

export interface ResumeCompactionInput {
  /** The chat's agent (`ProviderSnapshot.id`). Only Claude reports a cache expiry. */
  adapter: string | null | undefined;
  mode: IdleCompactionMode;
  usedTokens: number | null | undefined;
  /** `ThreadTokenUsage.promptCacheExpiresAt` of the newest reading. */
  promptCacheExpiresAt: string | null | undefined;
  /** A turn running, a request open, messages queued or a send in flight: compacting would wait. */
  busy: boolean;
  nowMs: number;
}

/**
 * The context size to offer compacting, or null when no offer stands.
 * *T3: `ContextWindowMeter.logic.ts` `shouldOfferResumeCompaction`.*
 */
// Adapted from T3 Code (MIT): apps/web/src/components/chat/ContextWindowMeter.logic.ts
export function resumeCompactionOffer(input: ResumeCompactionInput): number | null {
  if (input.adapter !== "claude" || input.mode === "off" || input.busy) return null;
  const usedTokens = input.usedTokens ?? 0;
  if (usedTokens < IDLE_COMPACTION_MIN_TOKENS) return null;
  const expiresAt = Date.parse(input.promptCacheExpiresAt ?? "");
  // An unknown expiry (a request served whole from the cache, a log from before the field) offers
  // nothing: the cache may well still be warm.
  if (!Number.isFinite(expiresAt) || input.nowMs < expiresAt) return null;
  return usedTokens;
}

// A typed `/compact`, with or without instructions, is already the compaction: a bare one ahead of
// it would run an uninstructed compaction first and charge for two.
const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s|$)/i;

/**
 * Whether a send compacts first: the offer stands, the user did not switch it to Full, and the
 * message is not itself a `/compact` (bare or with focus instructions). Every other message,
 * slash commands included, compacts first, as T3 Code's does.
 * *T3: `ChatView.logic.ts` `planComposerTurn` (#24008).*
 */
// Adapted from T3 Code (MIT): apps/web/src/components/ChatView.logic.ts
export function compactsBeforeSend(input: { offered: boolean; keepFullHistory: boolean; text: string }): boolean {
  return input.offered && !input.keepFullHistory && !COMPACT_COMMAND_PATTERN.test(input.text.trim());
}

/** When the offer can next appear by itself (the cache expiring), for a re-render; null for never. */
export function resumeCompactionWakeAt(promptCacheExpiresAt: string | null | undefined, nowMs: number): number | null {
  const expiresAt = Date.parse(promptCacheExpiresAt ?? "");
  return Number.isFinite(expiresAt) && expiresAt > nowMs ? expiresAt : null;
}

/**
 * A send under the offer: compact first, then send. The compaction is awaited — the host queues a
 * message that arrives while it runs and sends it into the compacted conversation — and one it
 * refuses (the chat got busy meanwhile) does not hold the message back.
 */
export async function sendAfterCompaction(
  compactFirst: boolean,
  compact: () => Promise<unknown>,
  send: () => Promise<void>
): Promise<void> {
  if (compactFirst) await compact().catch(() => undefined);
  await send();
}
