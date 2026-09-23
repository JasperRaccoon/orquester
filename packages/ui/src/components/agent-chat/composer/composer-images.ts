/**
 * `[Image #N]` placeholders (spec §7.4 addendum, owner request 2026-09-22).
 *
 * The Claude Code CLI writes `[Image #N]` into the prompt where an image was
 * pasted, so the user can say "this one is x: [Image #1], this one is y:
 * [Image #2]". The chat composer showed images only as chips, with no way to
 * name one in the text. Images are numbered by their position among the
 * staged image attachments (1-based, the order the adapters send them), the
 * placeholder is inserted at the caret when an image is staged, and removing
 * an image drops its placeholder and renumbers the later ones — the CLI
 * leaves stale numbers behind; we do not.
 */

const PLACEHOLDER = /\[Image #(\d+)\]/g;

export function imagePlaceholder(n: number): string {
  return `[Image #${n}]`;
}

/** 1-based index of the image among the staged images, or null for a file. */
export function imageOrdinal(
  attachments: readonly { key: string; mimeType: string }[],
  key: string
): number | null {
  let ordinal = 0;
  for (const attachment of attachments) {
    if (!attachment.mimeType.startsWith("image/")) continue;
    ordinal += 1;
    if (attachment.key === key) return ordinal;
  }
  return null;
}

/**
 * Remove every `[Image #n]` and renumber the placeholders above it. One space
 * beside a removed placeholder goes with it so "a [Image #1] b" reads "a b".
 */
export function removeImagePlaceholder(text: string, n: number): string {
  const dropped = text.replace(new RegExp(`\\s?\\[Image #${n}\\](?=\\s|$)|\\[Image #${n}\\]`, "g"), "");
  return dropped.replace(PLACEHOLDER, (match, digits: string) => {
    const index = Number(digits);
    return index > n ? imagePlaceholder(index - 1) : match;
  });
}

/**
 * Release the object URLs behind image chips (§7.4 thumbnail + hover preview).
 * Called when a chip is removed, when the draft is sent, on a thread swap and
 * on unmount — a URL that outlives its chip pins the whole file in memory.
 */
export function revokeImagePreviews(
  attachments: readonly { previewUrl?: string }[],
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url)
): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) revoke(attachment.previewUrl);
  }
}

/**
 * The chips a failed send hands back to the draft. `submit` revoked their
 * preview URLs when it emptied the tray, so each one drops its dead URL and an
 * image chip resolves its preview again lazily, through the read-back route,
 * exactly as a reloaded chip does.
 */
export function withoutPreviews<A extends { previewUrl?: string }>(attachments: readonly A[]): A[] {
  return attachments.map((attachment) => {
    if (attachment.previewUrl === undefined) return attachment;
    const { previewUrl: _revoked, ...chip } = attachment;
    return chip as A;
  });
}
