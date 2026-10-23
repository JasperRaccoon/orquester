import {
  KNOWLEDGE_COLLECTION_DESCRIPTION_MAX,
  KNOWLEDGE_COLLECTION_NAME_MAX,
  KNOWLEDGE_ENTRY_MAX_BYTES,
  KNOWLEDGE_TITLE_MAX
} from "@orquester/api";
import { KnowledgeError } from "./errors.ts";

export const KNOWLEDGE_KIND_MAX = 40;
export const KNOWLEDGE_AUTHOR_MAX = 120;
export const KNOWLEDGE_HANDLE_MAX = 64;
export const KNOWLEDGE_URL_MAX = 2_048;
/** A derived title (no title given) is the body's first line, cut to this. */
const DERIVED_TITLE_MAX = 80;

const invalid = (message: string): KnowledgeError => new KnowledgeError("KNOWLEDGE_INVALID", message);

function oneLine(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The body as stored: verbatim except a BOM and trailing whitespace; refuses empty and oversized. */
export function checkBody(body: string, where: string): string {
  const stored = body.replace(/^﻿/, "").replace(/\s+$/, "");
  if (stored.trim().length === 0) throw invalid(`${where}: the body is empty.`);
  const bytes = Buffer.byteLength(stored, "utf8");
  if (bytes > KNOWLEDGE_ENTRY_MAX_BYTES) {
    throw new KnowledgeError(
      "KNOWLEDGE_TOO_LARGE",
      `${where}: the body is ${bytes} bytes; the limit is ${KNOWLEDGE_ENTRY_MAX_BYTES}. Split it into several entries.`
    );
  }
  return stored;
}

export function checkTitle(title: string, where: string): string {
  const clean = oneLine(title);
  if (clean.length === 0) throw invalid(`${where}: the title is empty.`);
  if (clean.length > KNOWLEDGE_TITLE_MAX) throw invalid(`${where}: the title is longer than ${KNOWLEDGE_TITLE_MAX} characters.`);
  return clean;
}

/** A title from the body's first meaningful line (Markdown markers dropped). */
export function deriveTitle(body: string): string {
  for (const line of body.split("\n")) {
    const text = oneLine(line.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, "").replace(/[*_`]+/g, ""));
    if (text.length === 0) continue;
    return text.length > DERIVED_TITLE_MAX ? `${text.slice(0, DERIVED_TITLE_MAX - 1).trimEnd()}…` : text;
  }
  return "Untitled";
}

export function checkKind(kind: string | undefined, where: string): string {
  if (kind === undefined) return "note";
  const clean = oneLine(kind);
  if (clean.length === 0) return "note";
  if (clean.length > KNOWLEDGE_KIND_MAX) throw invalid(`${where}: the kind is longer than ${KNOWLEDGE_KIND_MAX} characters.`);
  return clean;
}

export function checkAuthor(author: string | null | undefined, where: string): string | null {
  if (author === undefined || author === null) return null;
  const clean = oneLine(author);
  if (clean.length === 0) return null;
  if (clean.length > KNOWLEDGE_AUTHOR_MAX) throw invalid(`${where}: the author is longer than ${KNOWLEDGE_AUTHOR_MAX} characters.`);
  return clean;
}

/** Without the "@"; no whitespace. */
export function checkHandle(handle: string | null | undefined, where: string): string | null {
  if (handle === undefined || handle === null) return null;
  const clean = oneLine(handle).replace(/^@+/, "");
  if (clean.length === 0) return null;
  if (clean.length > KNOWLEDGE_HANDLE_MAX || /\s/.test(clean)) throw invalid(`${where}: "${clean.slice(0, 80)}" is not a handle.`);
  return clean;
}

export function checkUrl(url: string | null | undefined, where: string): string | null {
  if (url === undefined || url === null) return null;
  const clean = url.trim();
  if (clean.length === 0) return null;
  if (clean.length > KNOWLEDGE_URL_MAX) throw invalid(`${where}: the URL is too long.`);
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    throw invalid(`${where}: "${clean.slice(0, 80)}" is not a URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid(`${where}: only http(s) URLs are kept.`);
  return clean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** An ISO date (`2026-10-11`) or date-time. */
export function checkPostedAt(postedAt: string | null | undefined, where: string): string | null {
  if (postedAt === undefined || postedAt === null) return null;
  const clean = postedAt.trim();
  if (clean.length === 0) return null;
  if (!(DATE.test(clean) || DATE_TIME.test(clean)) || Number.isNaN(Date.parse(DATE.test(clean) ? `${clean}T00:00:00Z` : clean))) {
    throw invalid(`${where}: postedAt must be an ISO date (2026-10-11) or date-time.`);
  }
  return clean;
}

export function checkCollectionName(name: string): string {
  const clean = oneLine(name);
  if (clean.length === 0) throw invalid("A collection needs a name.");
  if (clean.length > KNOWLEDGE_COLLECTION_NAME_MAX) {
    throw invalid(`A collection name is at most ${KNOWLEDGE_COLLECTION_NAME_MAX} characters.`);
  }
  if (clean.toLowerCase() === "unfiled" || clean.toLowerCase() === "all") throw invalid(`"${clean}" is reserved.`);
  return clean;
}

export function checkCollectionDescription(description: string | undefined): string {
  const clean = oneLine(description ?? "");
  if (clean.length > KNOWLEDGE_COLLECTION_DESCRIPTION_MAX) {
    throw invalid(`A collection description is one line of at most ${KNOWLEDGE_COLLECTION_DESCRIPTION_MAX} characters.`);
  }
  return clean;
}
