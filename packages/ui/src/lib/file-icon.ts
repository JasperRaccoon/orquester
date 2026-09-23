/**
 * File-type icons for attachment chips (spec §7.4 Built note).
 *
 * A closed set of icon ids, each backed by one vendored Material Icon Theme
 * SVG in `icons/files/` (MIT; version pinned in `icons/files/README.md`).
 * Resolution is extension first — the user's own spelling of the file — then
 * the exact mime, then the mime family, then the generic file. Extension-based
 * like `file-kind.ts`: no sniffing, synchronous, never throws.
 */

import { extOf } from "./file-kind";

export const FILE_ICON_IDS = [
  "table", "word", "powerpoint", "pdf", "json", "yaml", "toml", "xml", "database", "jupyter",
  "zip", "typescript", "react_ts", "javascript", "react", "python", "rust", "go", "java", "c",
  "cpp", "csharp", "ruby", "php", "swift", "console", "powershell", "html", "css", "sass",
  "markdown", "document", "log", "image", "svg", "audio", "video", "lock", "font", "file"
] as const;

export type FileIconId = (typeof FILE_ICON_IDS)[number];

// extension (no dot, lowercased; `extOf` collapses `.tar.*`) -> icon
const BY_EXTENSION: Record<string, FileIconId> = {
  xlsx: "table", xls: "table", xlsm: "table", ods: "table", csv: "table", tsv: "table",
  docx: "word", doc: "word", odt: "word", rtf: "word",
  pptx: "powerpoint", ppt: "powerpoint", odp: "powerpoint",
  pdf: "pdf",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  xml: "xml", plist: "xml",
  sql: "database", db: "database", sqlite: "database", sqlite3: "database", parquet: "database",
  ipynb: "jupyter",
  zip: "zip", tar: "zip", gz: "zip", tgz: "zip", bz2: "zip", xz: "zip", "7z": "zip", rar: "zip",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "react_ts",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "react",
  py: "python", rs: "rust", go: "go", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  rb: "ruby", php: "php", swift: "swift",
  sh: "console", bash: "console", zsh: "console", fish: "console", ps1: "powershell",
  html: "html", htm: "html", css: "css", scss: "sass", sass: "sass",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  txt: "document", log: "log",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image",
  avif: "image", ico: "image", svg: "svg",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", aac: "audio", ogg: "audio",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video", m4v: "video",
  lock: "lock", ttf: "font", otf: "font", woff: "font", woff2: "font"
};

// exact mime (lowercased, parameters stripped) -> icon
const BY_MIME: Record<string, FileIconId> = {
  "text/csv": "table",
  "text/tab-separated-values": "table",
  "application/vnd.ms-excel": "table",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "table",
  "application/vnd.oasis.opendocument.spreadsheet": "table",
  "application/msword": "word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word",
  "application/vnd.oasis.opendocument.text": "word",
  "application/rtf": "word",
  "application/vnd.ms-powerpoint": "powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "powerpoint",
  "application/vnd.oasis.opendocument.presentation": "powerpoint",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-7z-compressed": "zip",
  "application/x-tar": "zip",
  "application/gzip": "zip",
  "application/vnd.rar": "zip",
  "application/x-rar-compressed": "zip",
  "text/markdown": "markdown",
  "text/html": "html",
  "text/css": "css",
  "text/javascript": "javascript",
  "application/javascript": "javascript",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/yaml": "yaml",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/x-sh": "console",
  "text/x-python": "python",
  "application/vnd.apache.parquet": "database",
  "application/x-sqlite3": "database",
  "image/svg+xml": "svg",
  "application/x-ipynb+json": "jupyter"
};

/**
 * Own keys only. The tables are plain object literals and both keys are user
 * text, so a bare index lets `notes.constructor` answer `Object` — not an id,
 * and `FileTypeIcon` would then render `undefined` and throw.
 */
function lookup(table: Record<string, FileIconId>, key: string): FileIconId | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function fileIconIdFor(input: { name?: string; mimeType?: string }): FileIconId {
  const extension = input.name ? extOf(input.name) : "";
  const byExtension = extension ? lookup(BY_EXTENSION, extension) : undefined;
  if (byExtension) return byExtension;
  const mime = (input.mimeType ?? "").trim().toLowerCase().split(";")[0]?.trim() ?? "";
  if (mime.length === 0) return "file";
  const byMime = lookup(BY_MIME, mime);
  if (byMime) return byMime;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/")) return "document";
  return "file";
}
