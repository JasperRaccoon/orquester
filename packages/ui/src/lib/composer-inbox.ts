import type { AttachmentRef } from "@orquester/api";

import { attachmentPathOf } from "./agent-chat/composer.logic";

/**
 * Deliveries into a chat tab's composer **draft** (spec §7.4, §7.7).
 *
 * Two existing surfaces write *into* a session from outside it: the browser
 * element picker (`PickComposeSheet`) and a file drop/paste/attach. On a
 * terminal both of them type bytes into the PTY — a bracketed paste of the
 * uploaded paths, or a formatted design-feedback block plus `\r`. A chat tab
 * has no PTY, and a chat message is not a keystroke, so those payloads land in
 * the composer's draft as text plus structured attachments and the user still
 * decides when to send.
 * *T3: `apps/web/src/components/chat/ChatComposer.tsx:5925-5955` and
 * `apps/web/src/composerDraftStore.ts:3739-3777` — terminal selections and
 * element-picker annotations are inserted into the draft at the caret, never
 * into a pane.*
 *
 * A module-level queue rather than a prop chain, for one reason: the delivering
 * surface (a bottom sheet over the browser tab, a drop handler on the shell)
 * and the receiving composer are in different subtrees, and the composer may
 * not be mounted yet when the delivery is made — activating a chat tab takes a
 * render. Queued deliveries therefore survive until something takes them.
 *
 * In-memory only, and deliberately so: a delivery is a live intent, the same
 * rule §7.4 states for queued messages. It does not outlive a reload.
 */

export interface ComposerDelivery {
  /** Text to insert at the caret (a trailing space is the sender's business). */
  text: string;
  /** Uploaded files, already referenced by their daemon-side path. */
  attachments: AttachmentRef[];
}

type Listener = (delivery: ComposerDelivery) => void;

const pending = new Map<string, ComposerDelivery[]>();
const listeners = new Map<string, Set<Listener>>();

/**
 * Queue a delivery for a chat tab's composer. When a composer is already
 * listening it receives it immediately and nothing is queued; otherwise it
 * waits for the next {@link takeComposerDeliveries}.
 */
export function deliverToComposerDraft(sessionId: string, delivery: ComposerDelivery): void {
  const subscribers = listeners.get(sessionId);
  if (subscribers && subscribers.size > 0) {
    for (const listener of subscribers) {
      listener(delivery);
    }
    return;
  }
  const queue = pending.get(sessionId);
  if (queue) {
    queue.push(delivery);
  } else {
    pending.set(sessionId, [delivery]);
  }
}

/**
 * Subscribe a mounted composer. Returns an unsubscribe function. The caller
 * should drain {@link takeComposerDeliveries} once on mount — a delivery made
 * while the tab was still opening is waiting there.
 */
export function subscribeComposerInbox(sessionId: string, listener: Listener): () => void {
  const subscribers = listeners.get(sessionId) ?? new Set<Listener>();
  subscribers.add(listener);
  listeners.set(sessionId, subscribers);
  return () => {
    const current = listeners.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(sessionId);
    }
  };
}

/** Take and clear everything queued for a session. */
export function takeComposerDeliveries(sessionId: string): ComposerDelivery[] {
  const queue = pending.get(sessionId);
  if (!queue) {
    return [];
  }
  pending.delete(sessionId);
  return queue;
}

/** Drop anything still queued for a closed tab, so nothing leaks per session. */
export function clearComposerInbox(sessionId: string): void {
  pending.delete(sessionId);
  listeners.delete(sessionId);
}

/**
 * A delivery as composer text.
 *
 * Attachments the composer could not stage are appended one per line as their
 * **absolute host path** when the upload answered one (`AttachmentRef.path`,
 * §7.4 — the same contract the terminal path had, minus the bracketed-paste
 * escape a textarea has no use for), else as their id. An older host's reply
 * carried only the id, which is all the fallback can write then; a current
 * host's carries the path the adapters read.
 */
export function composerTextForDelivery(delivery: ComposerDelivery): string {
  const paths = delivery.attachments
    .map((attachment) => attachmentPathOf(attachment) ?? attachment.id)
    .filter((entry) => entry.length > 0);
  const parts: string[] = [];
  if (delivery.text.length > 0) {
    parts.push(delivery.text);
  }
  if (paths.length > 0) {
    parts.push(paths.join("\n"));
  }
  return parts.join("\n\n");
}

/** Merge several deliveries into one, preserving order. */
export function mergeComposerDeliveries(
  deliveries: readonly ComposerDelivery[]
): ComposerDelivery | null {
  if (deliveries.length === 0) {
    return null;
  }
  if (deliveries.length === 1) {
    return deliveries[0];
  }
  return {
    text: deliveries
      .map((d) => d.text)
      .filter((t) => t.length > 0)
      .join("\n\n"),
    attachments: deliveries.flatMap((d) => d.attachments)
  };
}
