import { useCallback, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api-client";
import { fileToBase64, type UploadItem } from "../../lib/files";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // mirror the daemon cap
const MAX_UPLOAD_FILES = 500; // big-folder confirm threshold
const MAX_UPLOAD_TOTAL_BYTES = 200 * 1024 * 1024; // big-folder confirm threshold

export type ConflictChoice = "replace" | "skip" | "keepBoth";

export interface ConflictPrompt {
  /** The relative path that already exists. */
  relativePath: string;
  /** What's already there — "dir" hides Replace (would delete a subtree). */
  kind: "file" | "dir";
  /** Conflicts left after this one (for the "apply to all" copy). */
  remaining: number;
  /** Called by the modal with the user's choice. */
  resolve: (choice: ConflictChoice, applyToAll: boolean) => void;
}

export interface UploadStatus {
  text: string;
  error?: boolean;
}

export interface UseFileUpload {
  status: UploadStatus | null;
  conflict: ConflictPrompt | null;
  bigFolder: { count: number; bytes: number } | null;
  confirmBigFolder: () => void;
  cancelBigFolder: () => void;
  /** Upload items into destDir; refreshes destDir as files land. */
  start: (destDir: string, items: UploadItem[]) => Promise<void>;
}

/**
 * Drives an upload (Approach B): pass 1 writes every file exclusively
 * (onConflict:"error") so clean files land immediately and existing targets
 * come back tagged; then a single prompt (with apply-to-all) resolves conflicts
 * and pass 2 re-sends them as overwrite/rename. A big-folder confirmation gates
 * accidental node_modules-sized drops. The two interactive pauses (big-folder
 * confirm, per-conflict prompt) are modal awaits via captured promise resolvers.
 */
export function useFileUpload(api: ApiClient, onUploaded: (destDir: string) => void): UseFileUpload {
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [bigFolder, setBigFolder] = useState<{ count: number; bytes: number } | null>(null);
  const bigFolderResolve = useRef<((ok: boolean) => void) | null>(null);
  // The interactive pauses (big-folder confirm, per-conflict prompt) share a
  // single resolver/state slot, so a second concurrent run would orphan the
  // first's awaited promise (hangs forever) and clobber its conflict decisions.
  // Serialize: drop overlapping invocations while one is mid-flight.
  const isRunning = useRef(false);

  const confirmBigFolder = useCallback(() => bigFolderResolve.current?.(true), []);
  const cancelBigFolder = useCallback(() => bigFolderResolve.current?.(false), []);

  const start = useCallback(
    async (destDir: string, items: UploadItem[]) => {
      // Drop overlapping runs — the shared modal-await slots (bigFolderResolve /
      // the conflict prompt) can't serve two at once; a second run would orphan
      // the first's awaited promise. Serialize on a single in-flight upload.
      if (isRunning.current) return;
      isRunning.current = true;
      try {
        const usable = items.filter((it) => it.file.size > 0);
        const oversized = usable.filter((it) => it.file.size > MAX_UPLOAD_BYTES);
        const toUpload = usable.filter((it) => it.file.size <= MAX_UPLOAD_BYTES);
        if (toUpload.length === 0) {
          setStatus(
            oversized.length > 0 ? { text: `Skipped ${oversized.length} file(s) over 25 MB`, error: true } : null
          );
          return;
        }

        // Big-folder guard — await the confirm modal.
        const totalBytes = toUpload.reduce((sum, it) => sum + it.file.size, 0);
        if (toUpload.length > MAX_UPLOAD_FILES || totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
          const ok = await new Promise<boolean>((res) => {
            bigFolderResolve.current = res;
            setBigFolder({ count: toUpload.length, bytes: totalBytes });
          });
          setBigFolder(null);
          bigFolderResolve.current = null;
          if (!ok) {
            setStatus(null);
            return;
          }
        }

        // Pass 1 — exclusive write; collect conflicts and failures.
        const conflicts: { item: UploadItem; kind: "file" | "dir" }[] = [];
        let failed = 0;
        let done = 0;
        for (const item of toUpload) {
          setStatus({ text: `Uploading ${++done}/${toUpload.length}…` });
          try {
            const dataBase64 = await fileToBase64(item.file);
            const res = await api.uploadFsEntry({ destDir, relativePath: item.relativePath, dataBase64, onConflict: "error" });
            if (res.conflict) {
              conflicts.push({ item, kind: res.conflictKind ?? "file" });
            }
          } catch {
            failed++;
          }
        }
        onUploaded(destDir);

        // Resolve conflicts — one prompt at a time, with apply-to-all.
        let replaced = 0;
        let kept = 0;
        let skipped = 0;
        let bulk: ConflictChoice | null = null;
        if (conflicts.length > 0) {
          setStatus({ text: `Resolving ${conflicts.length} conflict(s)…` });
        }
        for (let i = 0; i < conflicts.length; i++) {
          const c = conflicts[i];
          let choice = bulk;
          if (!choice) {
            const decision = await new Promise<{ choice: ConflictChoice; all: boolean }>((res) => {
              setConflict({
                relativePath: c.item.relativePath,
                kind: c.kind,
                remaining: conflicts.length - i - 1,
                resolve: (ch, all) => res({ choice: ch, all })
              });
            });
            setConflict(null);
            choice = decision.choice;
            if (decision.all) {
              bulk = decision.choice;
            }
          }
          if (choice === "skip") {
            skipped++;
            continue;
          }
          // A dir clash can't be replaced — coerce defensively to rename.
          const policy = choice === "replace" && c.kind !== "dir" ? "overwrite" : "rename";
          try {
            const dataBase64 = await fileToBase64(c.item.file);
            const res = await api.uploadFsEntry({ destDir, relativePath: c.item.relativePath, dataBase64, onConflict: policy });
            // An intermediate path segment that is itself a FILE makes mkdir fail
            // (ENOTDIR/EEXIST) regardless of onConflict, so the daemon re-reports a
            // conflict and writes nothing. Re-sending the same path can't resolve
            // it — count it as failed, never as a phantom Replaced/Kept-both.
            if (res.conflict) {
              failed++;
            } else if (policy === "overwrite") {
              replaced++;
            } else {
              kept++;
            }
          } catch {
            failed++;
          }
        }
        if (conflicts.length > 0) {
          onUploaded(destDir);
        }

        const parts: string[] = [];
        if (replaced) parts.push(`Replaced ${replaced}`);
        if (kept) parts.push(`Kept both ${kept}`);
        if (skipped) parts.push(`Skipped ${skipped}`);
        if (oversized.length) parts.push(`Skipped ${oversized.length} over 25 MB`);
        if (failed) parts.push(`${failed} failed`);
        setStatus(parts.length ? { text: parts.join(" · "), error: oversized.length > 0 || failed > 0 } : null);
      } finally {
        isRunning.current = false;
      }
    },
    [api, onUploaded]
  );

  return { status, conflict, bigFolder, confirmBigFolder, cancelBigFolder, start };
}
