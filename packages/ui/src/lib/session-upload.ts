import { MAX_UPLOAD_BYTES } from "@orquester/api";
import type { ApiClient } from "./api-client";
import { BatchProgress, type UploadProgress } from "./upload-progress";

// Match the daemon's upload cap and reject oversized files before sending them.
export { MAX_UPLOAD_BYTES };

/**
 * Transient status for a session file upload. A discriminated union (rather than
 * a bare `error` flag) so each surface can treat the cases differently — e.g. the
 * mobile key bar dismisses a hard `error` and a benign `skipped` on different
 * timers, while the desktop terminal colors both the same.
 */
export type UploadStatus =
  | { kind: "uploading"; text: string; progress: UploadProgress }
  | { kind: "skipped"; text: string } // some files were over the size cap
  | { kind: "error"; text: string }; // an upload threw

/** Insert paths using bracketed paste, without submitting the terminal prompt. */
export function injectionForPaths(paths: string[]): string {
  const joined = paths.join(" ");
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

  const text = `Uploading ${toUpload.length} file(s)…`;
  const batch = new BatchProgress(
    toUpload.map((file) => file.size),
    (progress) => onStatus({ kind: "uploading", text, progress })
  );
  try {
    const paths: string[] = [];
    // Preserve order: upload sequentially so paths line up with the files.
    for (const [i, file] of toUpload.entries()) {
      batch.begin(i, file.name);
      // The File goes as a raw body — the browser streams it from disk, nothing
      // is encoded or held in memory.
      const result = await api.uploadSessionFile(
        sessionId,
        { name: file.name, type: file.type || undefined },
        file,
        batch.onBytes
      );
      batch.finish();
      paths.push(result.path);
    }
    // Inject every path in a single input write (no Enter — see helper).
    await api.sendSessionInput(sessionId, injectionForPaths(paths));
    onStatus(null);
  } catch {
    onStatus({ kind: "error", text: "Upload failed" });
  }
}
