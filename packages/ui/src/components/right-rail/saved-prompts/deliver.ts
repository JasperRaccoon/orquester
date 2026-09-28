/**
 * Insert / Send of a saved prompt, as a function of what it talks to: render
 * the prompt's variables for the chat that was on screen at the click, check
 * that chat is still the one on screen, deliver, and count the use.
 *
 * The panel binds it to the real resolver, chat and store
 * (`SavedPromptsPanel`); the tests bind fakes (`deliver.test.ts`).
 */

import type { SavedPrompt } from "@orquester/api";

import { savedPromptErrorText } from "../../../lib/saved-prompts/errors";
import type { ResolveSavedPromptResult } from "../../../lib/saved-prompts/variables";
import { NO_CHAT_TARGET_REASON, type ChatDelivery } from "../chat-target";

export type SavedPromptDeliveryAction = "insert" | "send";

/** Why a prompt rendered for one chat is not delivered to another. */
const CHAT_CHANGED_REASON = "The chat changed while the prompt was being prepared — try again.";

export type SavedPromptDeliveryOutcome =
  /** A newer click took over, or the panel went away: nothing to show. */
  | { status: "superseded" }
  | { status: "refused"; reason: string }
  | { status: "delivered"; delivery: Extract<ChatDelivery, { ok: true }> };

export interface SavedPromptDelivererDeps {
  /** Render `body` for the chat `target` (its variables; the git reads stop with `signal`). */
  resolve(body: string, target: string, signal: AbortSignal): Promise<ResolveSavedPromptResult>;
  /** The chat on screen now (`activeChatTab`). */
  activeTarget(): string | null;
  insert(target: string, text: string): ChatDelivery;
  send(target: string, text: string): ChatDelivery;
  /** Delivered: count the use (fire and forget). */
  markUsed(promptId: string): void;
}

export interface SavedPromptDeliverer {
  /** `target` is the chat on screen at the click — captured there, never re-read before the render. */
  deliver(
    prompt: Pick<SavedPrompt, "id" | "body">,
    action: SavedPromptDeliveryAction,
    target: string | null
  ): Promise<SavedPromptDeliveryOutcome>;
  /** Stop the delivery in flight (the panel is going away): it lands nowhere. */
  dispose(): void;
}

export function createSavedPromptDeliverer(deps: SavedPromptDelivererDeps): SavedPromptDeliverer {
  let current: AbortController | null = null;
  return {
    async deliver(prompt, action, target) {
      // One delivery at a time: a newer click supersedes whatever still resolves.
      current?.abort();
      current = null;
      if (target === null) return { status: "refused", reason: NO_CHAT_TARGET_REASON };
      const controller = new AbortController();
      current = controller;
      let resolved: ResolveSavedPromptResult;
      try {
        resolved = await deps.resolve(prompt.body, target, controller.signal);
      } catch (error) {
        resolved = { ok: false, reason: savedPromptErrorText(error, "Couldn't prepare the prompt.") };
      }
      if (controller.signal.aborted) return { status: "superseded" };
      if (current === controller) current = null;
      if (!resolved.ok) return { status: "refused", reason: resolved.reason };
      // Rendered for the chat on screen at the click ({agent}, {model}); if
      // another is on screen now, delivering would land it out of sight.
      if (deps.activeTarget() !== target) return { status: "refused", reason: CHAT_CHANGED_REASON };
      let delivery: ChatDelivery;
      try {
        delivery = action === "insert" ? deps.insert(target, resolved.text) : deps.send(target, resolved.text);
      } catch (error) {
        delivery = { ok: false, reason: savedPromptErrorText(error, "The chat did not take the prompt.") };
      }
      if (!delivery.ok) return { status: "refused", reason: delivery.reason };
      deps.markUsed(prompt.id);
      return { status: "delivered", delivery };
    },
    dispose() {
      current?.abort();
      current = null;
    }
  };
}
