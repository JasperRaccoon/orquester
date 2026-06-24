/**
 * Classify a file by extension for the file-preview dispatcher, and carry the
 * per-kind size policy. Extension-based (like CodeMirror's matchFilename) — no
 * magic-byte sniffing; predictable and synchronous.
 */

export type FileKind = "text" | "html" | "image" | "pdf" | "audio" | "video" | "archive" | "binary";

export interface FileKindInfo {
  kind: FileKind;
  /** MIME used to wrap bytes in a typed Blob (image/audio/video/pdf). */
  mime: string;
}

/** Mirror of the daemon's RAW_MAX_BYTES: the in-app download limit and absolute
 *  read cap. Files larger than this are neither previewed nor downloaded in-app. */
export const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** Per-kind inline-preview cap. Video gets the full ceiling; everything else is
 *  capped lower to bound renderer memory. A renderable file above its cap (but
 *  <= DOWNLOAD_MAX_BYTES) falls back to the download card. */
export const PREVIEW_CAP_BY_KIND: Record<FileKind, number> = {
  video: 50 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  binary: 25 * 1024 * 1024,
  archive: DOWNLOAD_MAX_BYTES, // listed server-side, not byte-fetched
  text: DOWNLOAD_MAX_BYTES, // text uses the separate 1 MB /api/fs/read route
  html: DOWNLOAD_MAX_BYTES // html also uses the text route (rendered in a sandboxed iframe)
};

// extension (no dot, lowercased) -> [kind, mime]
const BY_EXT: Record<string, [FileKind, string]> = {
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  svg: ["image", "image/svg+xml"],
  bmp: ["image", "image/bmp"],
  ico: ["image", "image/x-icon"],
  avif: ["image", "image/avif"],
  pdf: ["pdf", "application/pdf"],
  html: ["html", "text/html"],
  htm: ["html", "text/html"],
  mp3: ["audio", "audio/mpeg"],
  wav: ["audio", "audio/wav"],
  ogg: ["audio", "audio/ogg"],
  m4a: ["audio", "audio/mp4"],
  flac: ["audio", "audio/flac"],
  aac: ["audio", "audio/aac"],
  mp4: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  mov: ["video", "video/quicktime"],
  mkv: ["video", "video/x-matroska"],
  m4v: ["video", "video/mp4"],
  zip: ["archive", "application/zip"],
  rar: ["archive", "application/vnd.rar"],
  "7z": ["archive", "application/x-7z-compressed"],
  tar: ["archive", "application/x-tar"],
  gz: ["archive", "application/gzip"],
  tgz: ["archive", "application/gzip"],
  bz2: ["archive", "application/x-bzip2"],
  xz: ["archive", "application/x-xz"]
};

/** Lowercased extension, collapsing `.tar.*` compound names to a known key. */
function extOf(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz")) return "tgz";
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tar.xz")) return "tar";
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : "";
}

export function detectFileKind(filename: string): FileKindInfo {
  const hit = BY_EXT[extOf(filename)];
  return hit ? { kind: hit[0], mime: hit[1] } : { kind: "text", mime: "text/plain" };
}
