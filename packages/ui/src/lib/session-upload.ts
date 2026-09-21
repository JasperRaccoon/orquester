import {
  MAX_UPLOAD_BYTES,
  SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES,
  type AttachmentRef,
  type SessionUploadResponse
} from "@orquester/api";
import type { ApiClient } from "./api-client";
import { deliverToComposerDraft } from "./composer-inbox";
import { BatchProgress, type UploadProgress } from "./upload-progress";

// Largest file we'll upload from the client: the daemon's own decoded cap, so we
// fail fast before encoding instead of round-tripping a 413.
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

/**
 * The chat counterpart of {@link uploadFilesToSession} (agent chat spec §7.4).
 *
 * Same uploads, same caps, same ordering — only the last step differs: a chat
 * tab has no PTY, so instead of a bracketed paste the uploaded files land in
 * that thread's **composer draft** as structured attachments, and the user
 * still decides when to send. The upload route's returned path is the
 * attachment reference (§6.1).
 */
export async function uploadFilesToChatDraft(
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
    const attachments: AttachmentRef[] = [];
    for (const [i, file] of toUpload.entries()) {
      batch.begin(i, file.name);
      const result = await api.uploadSessionFile(
        sessionId,
        { name: file.name, type: file.type || undefined },
        file,
        batch.onBytes
      );
      batch.finish();
      attachments.push(attachmentRefFor(result, file.type));
    }
    // One delivery for the batch, so the draft gets a single insert.
    deliverToComposerDraft(sessionId, { text: "", attachments });
    onStatus(null);
  } catch {
    onStatus({ kind: "error", text: "Upload failed" });
  }
}

/**
 * Classify an uploaded file for the composer. Only the four image types the
 * providers actually accept become `image` attachments (§4.1); everything else
 * — including an image format none of them decode — is a plain `file`, which
 * every adapter can still read from disk.
 */
function attachmentRefFor(result: SessionUploadResponse, mimeType?: string): AttachmentRef {
  const type = mimeType && mimeType.length > 0 ? mimeType : undefined;
  if (type && (SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(type)) {
    return { type: "image", id: result.path, name: result.name, mimeType: type, sizeBytes: result.size };
  }
  return { type: "file", id: result.path, name: result.name, mimeType: type, sizeBytes: result.size };
}
