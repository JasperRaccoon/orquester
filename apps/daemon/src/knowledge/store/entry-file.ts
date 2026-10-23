import type { KnowledgeEntryMeta, KnowledgeEntrySource } from "@orquester/api";
import { KNOWLEDGE_ENTRY_FRONTMATTER_KEYS, knowledgeEntryFrontmatterSchema } from "@orquester/config";
import { parseDocument, stringify } from "yaml";

/**
 * `entries/<entryId>.md`: `---`, the YAML frontmatter, `---`, then the verbatim body. The
 * frontmatter is a flat mapping (spec "Storage"); unknown keys are returned in `extra` and written
 * back after the known ones.
 */
export interface ParsedEntryFile {
  meta: KnowledgeEntryMeta;
  /**
   * What this build cannot carry in `meta`, verbatim: the frontmatter keys it does not know and,
   * under `savedFrom`, the `savedFrom` mapping as found when it holds keys this build does not
   * know or a `by` it does not know (a newer build's). Both are written back on every rewrite.
   */
  extra: Record<string, unknown>;
  body: string;
}

const SAVED_BY: readonly string[] = ["agent", "user"] satisfies readonly KnowledgeEntrySource["by"][];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `meta.savedFrom` over the stored mapping (if kept in `extra`): its unknown keys and an unknown `by` survive. */
function savedFromFrontmatter(source: KnowledgeEntrySource, stored: unknown): Record<string, unknown> {
  const known: Record<string, unknown> = source.sessionId ? { by: source.by, sessionId: source.sessionId } : { by: source.by };
  if (!isPlainRecord(stored)) return known;
  const by = typeof stored.by === "string" && !SAVED_BY.includes(stored.by) ? stored.by : source.by;
  return { ...stored, ...known, by };
}

const OPEN = "---\n";
const CLOSE = "\n---\n";

export function serializeEntryFile(meta: KnowledgeEntryMeta, extra: Record<string, unknown>, body: string): string {
  const front: Record<string, unknown> = {
    id: meta.id,
    title: meta.title,
    kind: meta.kind,
    author: meta.author,
    handle: meta.handle,
    url: meta.url,
    postedAt: meta.postedAt,
    savedAt: meta.savedAt,
    updatedAt: meta.updatedAt,
    savedFrom: savedFromFrontmatter(meta.savedFrom, extra.savedFrom),
    collections: [...meta.collections],
    contentHash: meta.contentHash,
    linkState: meta.linkState
  };
  for (const [key, value] of Object.entries(extra)) {
    if (!(KNOWLEDGE_ENTRY_FRONTMATTER_KEYS as readonly string[]).includes(key)) front[key] = value;
  }
  return `${OPEN}${stringify(front, { lineWidth: 0 })}---\n${body}`;
}

/**
 * Strict: the file must open with a frontmatter block that is one YAML mapping the schema
 * accepts, and whose `id` is `expectedId` (the file stem). Throws with a short reason otherwise.
 */
export function parseEntryFile(text: string, expectedId: string): ParsedEntryFile {
  const normalized = text.startsWith("﻿") ? text.slice(1) : text;
  if (!normalized.startsWith(OPEN)) throw new Error("no frontmatter");
  const end = normalized.indexOf(CLOSE, OPEN.length - 1);
  if (end < 0) throw new Error("unterminated frontmatter");
  const yamlText = normalized.slice(OPEN.length, end + 1);
  const body = normalized.slice(end + CLOSE.length);
  const doc = parseDocument(yamlText, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) throw new Error(`frontmatter is not valid YAML (${doc.errors[0]!.message.split("\n")[0]})`);
  const raw: unknown = doc.toJS();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("frontmatter is not a mapping");
  const parsed = knowledgeEntryFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`frontmatter ${issue?.path.join(".") || "shape"}: ${issue?.message ?? "invalid"}`);
  }
  const front = parsed.data;
  if (front.id !== expectedId) throw new Error("frontmatter id does not match the file name");
  const savedFrom = front.savedFrom as { by: string; sessionId?: string };
  // An unknown `by` (a newer build's) reads as what the entry shows it is: saved by a chat when it
  // names one, by the user otherwise. The stored value stays in `extra` for the rewrite.
  const by: KnowledgeEntrySource["by"] = SAVED_BY.includes(savedFrom.by)
    ? (savedFrom.by as KnowledgeEntrySource["by"])
    : savedFrom.sessionId
      ? "agent"
      : "user";
  const meta: KnowledgeEntryMeta = {
    id: front.id,
    title: front.title,
    kind: front.kind,
    author: front.author,
    handle: front.handle,
    url: front.url,
    postedAt: front.postedAt,
    savedAt: front.savedAt,
    updatedAt: front.updatedAt ?? front.savedAt,
    savedFrom: savedFrom.sessionId ? { by, sessionId: savedFrom.sessionId } : { by },
    collections: [...new Set(front.collections)],
    contentHash: front.contentHash,
    linkState: front.linkState
  };
  const extra: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([key]) => !(KNOWLEDGE_ENTRY_FRONTMATTER_KEYS as readonly string[]).includes(key)
    )
  );
  const storedSavedFrom = (raw as Record<string, unknown>).savedFrom;
  if (
    isPlainRecord(storedSavedFrom) &&
    (by !== savedFrom.by || Object.keys(storedSavedFrom).some((key) => key !== "by" && key !== "sessionId"))
  ) {
    extra.savedFrom = storedSavedFrom;
  }
  return { meta, extra, body };
}

/** The myKG input copy: a plain header line, the title, the verbatim body. No collections, no frontmatter. */
export function renderMykgInput(meta: Pick<KnowledgeEntryMeta, "author" | "handle" | "kind" | "postedAt" | "title">, body: string): string {
  const parts: string[] = [];
  const author = meta.author?.trim() || null;
  const handle = meta.handle?.trim() || null;
  if (author && handle) parts.push(`Author: ${author} (@${handle})`);
  else if (author) parts.push(`Author: ${author}`);
  else if (handle) parts.push(`Author: @${handle}`);
  if (meta.kind.trim()) parts.push(meta.kind.trim());
  if (meta.postedAt?.trim()) parts.push(meta.postedAt.trim());
  const header = parts.join(" · ");
  const title = meta.title.replace(/\s+/g, " ").trim();
  const sections = [header, title ? `# ${title}` : "", body.replace(/\s+$/, "")].filter((part) => part.length > 0);
  return `${sections.join("\n\n")}\n`;
}
