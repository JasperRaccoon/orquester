import type { ApiClient } from "./api-client";
import { downloadBlob, downloadUrl } from "./files";

/** A file-tree entry to download. */
export interface DownloadTarget {
  path: string;
  name: string;
  kind: "dir" | "file";
}

/**
 * Download a file (as-is) or a folder (zipped server-side) to the user's disk.
 * HTTP transports (web, desktop→remote) use a native <a download> so the browser
 * streams to disk with no size cap and a progress bar; the desktop unix socket
 * has no reachable URL, so it falls back to a buffered bytes fetch + blob save.
 * A folder downloads as "<name>.zip".
 */
export async function downloadPath(api: ApiClient, target: DownloadTarget): Promise<void> {
  const filename = target.kind === "dir" ? `${target.name}.zip` : target.name;
  const url = api.buildDownloadUrl(target.path);
  if (url) {
    downloadUrl(url, filename);
    return;
  }
  const bytes = await api.downloadBytes(target.path);
  const type = target.kind === "dir" ? "application/zip" : "application/octet-stream";
  downloadBlob(filename, new Blob([bytes], { type }));
}
