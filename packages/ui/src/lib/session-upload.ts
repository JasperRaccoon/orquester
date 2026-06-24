import type { ApiClient } from "./api-client";
import { fileToBase64 } from "./files";

// Largest file we'll upload from the client. Mirrors the daemon's decoded cap
// (see the upload route's MAX_UPLOAD_BYTES) so we fail fast before encoding.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Transient status for a session file upload. A discriminated union (rather than
 * a bare `error` flag) so each surface can treat the cases differently — e.g. the
 * mobile key bar dismisses a hard `error` and a benign `skipped` on different
 * timers, while the desktop terminal colors both the same.
 */
export type UploadStatus =
  | { kind: "uploading"; text: string }
  | { kind: "skipped"; text: string } // some files were over the size cap
  | { kind: "error"; text: string }; // an upload threw

/**
 * Build the terminal input that places uploaded file paths into the agent's
 * prompt. We do NOT append a newline/Enter — the path is only inserted, never
 * submitted; the user types their prompt and hits Enter themselves.
 *
 * Default is BRACKETED PASTE (format A): the space-joined paths wrapped in the
 * bracketed-paste escapes (`\x1b[200~`…`\x1b[201~`), with NO trailing space —
 * agents' TUIs enable bracketed-paste mode and run their attach/path detection
 * on pasted text, mimicking a native drag. To switch to RAW (format B) — paths
 * + a trailing space, no escape wrapper — replace the single returned expression
 * with `return joined + " ";` (the format is locked in via runtime verification
 * against real agents).
 */
export function injectionForPaths(paths: string[]): string {
  const joined = paths.join(" ");
  // Format A (bracketed paste). Switch to format B by returning `joined + " "`.
  return `\x1b[200~${joined}\x1b[201~`;
}

/**
 * Upload files to a session, then inject every returned daemon-side path into the
 * session's prompt in a single input write. Shared by the desktop drag/paste
 * handler (`TerminalView`) and the mobile attach button (`MobileKeyBar`); each
 * passes an `onStatus` sink and renders feedback (and dismiss timing) its own way.
 *
 * - Skips empty (0-byte) and oversized (> MAX_UPLOAD_BYTES) files; an oversized
 *   batch reports a `skipped` status but the remaining files still upload.
 * - Uploads sequentially to preserve the picked/dropped order so the injected
 *   paths line up with the files.
 */
export async function uploadFilesToSession(
  api: ApiClient,
  sessionId: string,
  files: File[],
  { onStatus }: { onStatus: (status: UploadStatus | null) => void }
): Promise<void> {
  const usable = files.filter((file) => file.size > 0);
  if (usable.length === 0) {
    return;
  }
  const oversized = usable.filter((file) => file.size > MAX_UPLOAD_BYTES);
  const toUpload = usable.filter((file) => file.size <= MAX_UPLOAD_BYTES);
  if (oversized.length > 0) {
    const cap = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
    onStatus({ kind: "skipped", text: `Skipped ${oversized.length} file(s) over ${cap} MB` });
  }
  if (toUpload.length === 0) {
    return;
  }

  onStatus({ kind: "uploading", text: `Uploading ${toUpload.length} file(s)…` });
  try {
    const paths: string[] = [];
    // Preserve order: upload sequentially so paths line up with the files.
    for (const file of toUpload) {
      const dataBase64 = await fileToBase64(file);
      const result = await api.uploadSessionFile(sessionId, {
        name: file.name,
        type: file.type || undefined,
        dataBase64
      });
      paths.push(result.path);
    }
    // Inject every path in a single input write (no Enter — see helper).
    await api.sendSessionInput(sessionId, injectionForPaths(paths));
    onStatus(null);
  } catch {
    onStatus({ kind: "error", text: "Upload failed" });
  }
}
