/**
 * The inline image row's actions (design 2026-11-10 §9.1), over the image's
 * loaded object URL so no action reads the image from the host twice:
 *
 * - Copy image: the Async Clipboard API, as PNG (the one image type every
 *   clipboard takes), converted through a canvas when it is not one.
 * - Save to project…: the file browser's own upload (`POST /api/fs/upload`, a
 *   raw binary body), never overwriting (`writeWithoutOverwrite`).
 * - Use as reference: the composer's own upload (`POST /api/sessions/:id/upload`)
 *   staged as a chip through the composer bridge, as a browser pick is.
 */

import type { ApiClient } from "../../../lib/api-client";
import { sniffImageMimeType, writeWithoutOverwrite } from "../../../lib/agent-chat/chat-images.logic";
import { updateThreadDraft } from "../../../lib/agent-chat/store";
import { composerTextForDelivery } from "../../../lib/composer-inbox";
import {
  COMPOSER_NOT_MOUNTED_REASON,
  composerHandle,
  insertComposerText,
  stageComposerAttachment
} from "../composer/composer-bridge";
import { persistedDraftAfterReturn } from "../composer/composer-draft";

/** The bytes behind an object URL, typed by what they are. */
export async function readImageBlob(url: string): Promise<Blob> {
  const blob = await (await fetch(url)).blob();
  const sniffed = sniffImageMimeType(await blob.slice(0, 16).arrayBuffer());
  return sniffed !== null && sniffed !== blob.type ? new Blob([blob], { type: sniffed }) : blob;
}

async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This image could not be converted for the clipboard.");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("This image could not be converted for the clipboard."))),
        "image/png"
      )
    );
  } finally {
    bitmap.close();
  }
}

/**
 * Copy the image as PNG. The write starts within the click (WebKit refuses a
 * clipboard write that starts after an `await`) with the bytes still on
 * their way, as `copy-produced.ts` does for text. Rejects with a sentence the
 * user can read when nothing was copied — an insecure origin (the daemon over
 * plain http) has no async clipboard at all.
 */
export function copyImageToClipboard(url: string): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.write !== "function" || typeof ClipboardItem === "undefined") {
    return Promise.reject(
      new Error("Copying images needs a secure (https) connection or the desktop app.")
    );
  }
  const png = readImageBlob(url).then(asPng);
  // Observed apart: an engine that refuses the write without reading the item
  // must not leave the conversion's failure unhandled.
  void png.catch(() => undefined);
  return clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/**
 * Save the image into the project at `relativePath` — or at `-v2`, `-v3`, …
 * when a file already holds the name; anything else in the way rejects at
 * once. Answers the host path it landed at.
 */
export async function saveImageToProject(input: {
  api: ApiClient;
  projectRoot: string;
  relativePath: string;
  url: string;
}): Promise<string> {
  const blob = await readImageBlob(input.url);
  return writeWithoutOverwrite(input.relativePath, (relativePath) =>
    input.api.uploadFsEntry({ destDir: input.projectRoot, relativePath, onConflict: "error" }, blob)
  );
}

/**
 * Attach the image to the chat's composer for the next message: uploaded as
 * a new attachment of the chat, as a pasted image is, and staged as a chip.
 * Rejects, before anything is uploaded, when no composer shows the chat.
 * Once uploaded the image is never dropped: where the composer refuses the
 * chip (its attachment bound) its path goes into the draft, as the bridge
 * asks, and where the composer went away during the upload it goes into the
 * chat's saved draft, which the composer's next mount stages
 * (`persistedDraftAfterReturn`, as a message returned to an unmounted
 * composer does).
 */
export async function attachImageAsReference(input: {
  api: ApiClient;
  sessionId: string;
  url: string;
  name: string;
}): Promise<void> {
  if (composerHandle(input.sessionId) === null) throw new Error(COMPOSER_NOT_MOUNTED_REASON);
  const blob = await readImageBlob(input.url);
  const ref = await input.api.agentChat.upload(input.sessionId, blob, { name: input.name, type: blob.type });
  if (stageComposerAttachment(input.sessionId, ref)) return;
  if (composerHandle(input.sessionId) !== null) {
    insertComposerText(input.sessionId, composerTextForDelivery({ text: "", attachments: [ref] }), "append");
    return;
  }
  const message = { text: "", attachments: [ref], context: [] };
  updateThreadDraft(input.sessionId, (draft) => persistedDraftAfterReturn({ persisted: draft, message }));
}
