/**
 * Agent chat — the client-seeded thread title (spec §7.7).
 *
 * Ported from T3 Code (MIT):
 * `apps/web/src/components/ChatView.tsx:8271-8287` (the seed chain) and
 * `packages/shared/src/String.ts:1-8` (the 50-character truncate).
 *
 * **A thread's title is client-seeded and host-owned thereafter.** There is no
 * title-generation service and none is introduced: the client seeds the title
 * at creation from the first message — plain text, context references
 * stripped, truncated — falling back to the first attachment's name and then
 * to a literal default, and writes it through the §6.1 `PUT`.
 *
 * *differs from T3:* T3 then generates a better title with a separate
 * `TextGeneration` model call; we have no such service, so the seed is the
 * title until a provider offers a better one through `thread.metadata.updated`
 * — and the host only replaces it while the current title is still exactly the
 * default or exactly the seed, so a manual rename is never clobbered.
 *
 * No React import.
 */

import type { AttachmentRef, ComposerContextRecord } from "@orquester/api/agent-chat";

/** The literal default the host also uses when nothing better exists. */
export const DEFAULT_THREAD_TITLE = "New thread";

export const THREAD_TITLE_MAX_LENGTH = 50;

/** *T3: `packages/shared/src/String.ts:1-8`.* */
export function truncateTitle(text: string, maxLength = THREAD_TITLE_MAX_LENGTH): string {
  const trimmed = text.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}...`;
}

/**
 * Strip the composer's inline references so the seed is prose, not markup:
 * `$skill` chips, `@path` mentions and fenced code become their plain reading.
 */
export function stripComposerReferences(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(^|\s)\p{Sc}([\w.-]+)/gu, "$1$2")
    .replace(/(^|\s)@(\S+)/gu, (_match, lead: string, path: string) => {
      const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
      return `${lead}${segments.at(-1) ?? path}`;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The seed chain: message text → first image → first file → first context chip
 * → the literal default.
 */
export function deriveThreadTitleSeed(input: {
  text: string;
  attachments?: readonly AttachmentRef[];
  context?: readonly ComposerContextRecord[];
}): string {
  const fromText = stripComposerReferences(input.text);
  if (fromText.length > 0) {
    return truncateTitle(fromText);
  }
  const attachments = input.attachments ?? [];
  const firstImage = attachments.find((attachment) => attachment.type === "image");
  if (firstImage) {
    return truncateTitle(`Image: ${firstImage.name}`);
  }
  const firstFile = attachments[0];
  if (firstFile) {
    return truncateTitle(`File: ${firstFile.name}`);
  }
  const firstContext = input.context?.[0];
  if (firstContext) {
    return truncateTitle(firstContext.label);
  }
  return DEFAULT_THREAD_TITLE;
}

/**
 * The host may replace the seed later, but **only while the current title is
 * still exactly the default or exactly the seed**, so a manual rename is never
 * clobbered. Mirrored client-side so a rename dialog can say whether the
 * provider may still improve the name.
 *
 * *T3: `apps/server/src/orchestration/threadTitles.ts:1-13`.*
 */
export function canReplaceThreadTitle(currentTitle: string, seed: string | null): boolean {
  const current = currentTitle.trim();
  return current.length === 0 || current === DEFAULT_THREAD_TITLE || current === seed?.trim();
}
