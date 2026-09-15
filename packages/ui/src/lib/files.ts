/**
 * Decode a bare base64 string (no data-URL prefix) into a Blob for a raw-body
 * upload. Uploads are never base64'd on the way UP (a `File` streams as-is);
 * this only serves payloads the daemon already handed us encoded, e.g. the
 * browser tab's element-pick screenshot (≤ 2 MB).
 */
export function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

/** One file to upload, tagged with its path relative to the dropped/picked root. */
export interface UploadItem {
  /** e.g. "folder 1/folder 2/file_c.txt" (POSIX separators). */
  relativePath: string;
  file: File;
}

/**
 * Flatten an <input type="file"> selection into UploadItems. A folder picked
 * via `webkitdirectory` carries `webkitRelativePath` (e.g. "folder 1/a.txt");
 * a plain multi-file pick has none, so fall back to the bare name.
 */
export function gatherFromInput(files: FileList): UploadItem[] {
  return Array.from(files).map((file) => ({
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    file
  }));
}

/**
 * Recurse a drag-drop DataTransfer via the webkitGetAsEntry / *Entry API into a
 * flat UploadItem list, preserving nested paths. Falls back to the plain
 * `.files` list when the entries API is unavailable. Empty directories are
 * walked but contribute no items (file-only upload model).
 */
export async function gatherFromDataTransfer(dt: DataTransfer): Promise<UploadItem[]> {
  // Snapshot the roots SYNCHRONOUSLY: the DataTransferItemList is emptied once
  // the drop handler returns, so we must call webkitGetAsEntry before any await.
  const roots: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file") {
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        roots.push(entry);
      }
    }
  }
  if (roots.length === 0) {
    // No entries API (older runtime) — fall back to flat files.
    return Array.from(dt.files).map((file) => ({ relativePath: file.name, file }));
  }
  const items: UploadItem[] = [];
  for (const entry of roots) {
    await walkEntry(entry, "", items);
  }
  return items;
}

/**
 * Depth-first walk of a FileSystemEntry, appending files to `out`. Per-entry
 * errors are swallowed (skip that file/dir) so one unreadable item can't abort
 * gathering — and reject the whole dropped batch — the way a single throw would.
 */
async function walkEntry(entry: FileSystemEntry, prefix: string, out: UploadItem[]): Promise<void> {
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    try {
      out.push({ relativePath, file: await fileFromEntry(entry as FileSystemFileEntry) });
    } catch {
      /* skip a single unreadable file rather than failing the whole drop */
    }
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries yields at most ~100 per call — loop until it returns empty.
  for (;;) {
    let batch: FileSystemEntry[];
    try {
      batch = await readEntries(reader);
    } catch {
      break; // unreadable directory — keep what we have, skip the rest of it
    }
    if (batch.length === 0) {
      break;
    }
    for (const child of batch) {
      await walkEntry(child, relativePath, out);
    }
  }
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** Trigger a browser "Save as" for an in-memory blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Trigger a browser download from a URL (the server sets the real filename via
 * Content-Disposition; `filename` is only a fallback hint). Unlike downloadBlob
 * there's no object URL to revoke — this is a real URL the browser streams to
 * disk via its own download manager.
 */
export function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
