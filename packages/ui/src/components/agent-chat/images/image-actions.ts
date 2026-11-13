/**
 * The inline image row's actions (design 2026-11-10 §9.1), over the image's
 * loaded object URL so no action reads the image from the host twice:
 *
 * - Copy image: the Async Clipboard API, as PNG (the one image type every
 *   clipboard takes), converted through a canvas when it is not one.
 * - Save to project…: the file browser's own upload (`POST /api/fs/upload`, a
 *   raw binary body), never overwriting (`writeWithoutOverwrite`).
 * - Use as reference: `image-reference.ts`, the app's alone (it needs the
 *   composer), offered through the chat host.
 */

import type { ApiClient } from "../../../lib/api-client";
import { sniffImageMimeType, writeWithoutOverwrite } from "../../../lib/agent-chat/chat-images.logic";

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
