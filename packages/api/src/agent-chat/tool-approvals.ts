/**
 * Agent chat — Orquester approval cards (unified MCP design 2026-10-15 §7).
 *
 * A chat agent's Admin tool call, a call that crosses a project boundary its permission mode does
 * not cover each raise a CARD in the chat's banner dock: provider-agnostic,
 * composed by the daemon from the call's structured arguments, with a complete preview of what
 * will run. The daemon holds pending cards in memory only (`apps/daemon/src/agent-chat/
 * tool-approvals.ts`); they are answered ONLY on their own route
 * ({@link agentChatRoutes.toolApproval}) — never through `respond_to_request` or a provider request
 * route.
 *
 * Secrets a card asks for (MCP `{ask: true}` values, workflow secrets) go from the answer body to
 * the waiting call and nowhere else: never into a summary, an event, a preview, a log or a tool
 * row ({@link stripToolApprovalSecrets}).
 *
 * Every string an agent wrote is rendered as plain text: titles and labels go through
 * {@link sanitizeApprovalLabel} (one line, bidi/control/zero-width characters stripped), prose
 * through {@link sanitizeApprovalProse}, and code/diff text through {@link escapeApprovalCodeText}
 * (those characters shown as visible escapes). Daemon and UI share these.
 *
 * Pure and dependency-free (besides sibling contracts): the daemon writes, the UI reads.
 */

import { SECRET_REDACTED_TEXT, SECRET_VALUE_MAX_CHARS } from "./secret-requests.ts";
import { sessionToolNameOfData, sessionToolReferences } from "./session-tools.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * What raised the card: an Admin call or a project boundary. `toolset` is LEGACY: older builds'
 * `request_toolset` raised it, and their cards and tool-row references still read; no current
 * build raises one. `spend` (boxes): a call that spends the owner's money — a card in EVERY
 * permission mode, workflow-owned and agent-to-agent chats included, never grantable.
 */
export type ApprovalKind = "admin" | "boundary" | "toolset" | "spend";
export const APPROVAL_KINDS: readonly ApprovalKind[] = ["admin", "boundary", "toolset", "spend"];

/** The Admin families (spec §3.2, §6): what an Admin call changes. Grants are per family (§7.6). */
export const ADMIN_FAMILIES = ["workflows", "workflow-secrets", "agent-profile", "desktops", "saved-prompts", "secret-files"] as const;
export type AdminFamily = (typeof ADMIN_FAMILIES)[number];

/**
 * Boundary families (spec §5.2): `cross-project` — an Act in another project the caller's mode
 * does not cover; `cross-project-read` — a content read of another project of the same workspace
 * below `auto`; `cross-workspace-read` — a read in another workspace below `full-access`.
 */
export const BOUNDARY_FAMILIES = ["cross-project", "cross-project-read", "cross-workspace-read"] as const;
export type BoundaryFamily = (typeof BOUNDARY_FAMILIES)[number];

// boxes: the `spend` kind's families (Ephemeral AI VMs spec §13.2) — `boxes`: renting a temporary box (`create_box`).
export const SPEND_FAMILIES = ["boxes"] as const;
export type SpendFamily = (typeof SPEND_FAMILIES)[number];

export function isSpendFamily(value: unknown): value is SpendFamily {
  return typeof value === "string" && (SPEND_FAMILIES as readonly string[]).includes(value);
}

/** Every card family (`toolset`: legacy, see {@link ApprovalKind}). */
export type ApprovalFamily = AdminFamily | BoundaryFamily | "toolset" | SpendFamily;
export const APPROVAL_FAMILIES: readonly ApprovalFamily[] = [...ADMIN_FAMILIES, ...BOUNDARY_FAMILIES, "toolset", ...SPEND_FAMILIES];

export function isAdminFamily(value: unknown): value is AdminFamily {
  return typeof value === "string" && (ADMIN_FAMILIES as readonly string[]).includes(value);
}

export function isApprovalFamily(value: unknown): value is ApprovalFamily {
  return typeof value === "string" && (APPROVAL_FAMILIES as readonly string[]).includes(value);
}

/** A grant's reach (§7.6): this chat, or every chat of the caller's project. */
export type ToolApprovalGrantScope = "chat" | "project";

// ---------------------------------------------------------------------------
// Limits and timing
// ---------------------------------------------------------------------------

/** How long every card kind waits for the user (D-17); then the call ends `APPROVAL_TIMEOUT`. */
export const ADMIN_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
/** The preview a summary (list answer, bus event) carries, at most: UTF-8 bytes of its sections' JSON. */
export const TOOL_APPROVAL_SUMMARY_MAX_BYTES = 64 * 1024;
/** The whole preview, at most; a bigger one is refused before any card (`PREVIEW_TOO_LARGE`). */
export const TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES = 1024 * 1024;
/** The agent's `reason` on an Admin call. */
export const TOOL_APPROVAL_REASON_MAX_CHARS = 300;
/** The user's deny reason, returned to the agent as the user's words. */
export const TOOL_APPROVAL_DENY_REASON_MAX_CHARS = 500;
/** A title or label after sanitising. */
export const TOOL_APPROVAL_LABEL_MAX_CHARS = 300;
/** Keyboard approval (⌘/Ctrl+Enter) is ignored this long after a card appears or changes (§7.1). */
export const TOOL_APPROVAL_KEYBOARD_GUARD_MS = 1_500;
/** A card secret value, at most (as `request_secret`'s). */
export const TOOL_APPROVAL_SECRET_MAX_CHARS = SECRET_VALUE_MAX_CHARS;
/**
 * At most this many cards wait in one chat at once; one more is refused before any card with the
 * tool error {@link TOOL_APPROVAL_LIMIT} (other chats are not affected; an answered card frees a slot).
 */
export const MAX_PENDING_TOOL_APPROVALS_PER_THREAD = 5;
/** The tool error code of a card refused by {@link MAX_PENDING_TOOL_APPROVALS_PER_THREAD}: wait for answers, batch changes. */
export const TOOL_APPROVAL_LIMIT = "APPROVAL_LIMIT";

// ---------------------------------------------------------------------------
// The card (§7.3)
// ---------------------------------------------------------------------------

/** One section of a preview. `partial`: this copy is cut; the full preview has the rest. */
export type ApprovalPreviewSection =
  | { kind: "text"; title?: string; text: string; partial?: boolean }
  | { kind: "code"; title: string; language?: string; text: string; partial?: boolean; sha256?: string }
  | { kind: "diff"; title: string; unifiedDiff: string; partial?: boolean }
  | { kind: "fields"; title?: string; rows: ApprovalPreviewFieldRow[] }
  | { kind: "changes"; title: string; items: ApprovalPreviewChange[] }
  /** A file shown by identity only: binary, executable, or listed beside its text. */
  | { kind: "file"; path: string; size: number; sha256: string; flag?: "binary" | "executable" }
  /** A flag the user must see (`danger`: red — e.g. a server pointing at this daemon's `/mcp`). */
  | { kind: "warning"; level: "caution" | "danger"; text: string };

export type ApprovalPreviewSectionKind = ApprovalPreviewSection["kind"];
export const APPROVAL_PREVIEW_SECTION_KINDS: readonly ApprovalPreviewSectionKind[] = ["text", "code", "diff", "fields", "changes", "file", "warning"];

/** A `fields` row: `set` — a value is configured; `asked` — typed in this card; `flagged` — a plain value that looks secret. */
export interface ApprovalPreviewFieldRow {
  label: string;
  value: string;
  state?: "set" | "asked" | "flagged";
}

export interface ApprovalPreviewChange {
  label: string;
  change: "added" | "removed" | "changed";
  detail?: string;
}

/** A project the card's call reaches, with the workspace git identity a session there would use. */
export interface ToolApprovalScopeProject {
  path: string;
  workspace: string;
  gitAccountLabel?: string;
}

/** A pending card as every client sees it — never a secret value. */
export interface ToolApprovalSummary {
  approvalId: string;
  /** The chat (= session id) whose call waits. */
  threadId: string;
  /** The tool's bare name. */
  tool: string;
  kind: ApprovalKind;
  family: ApprovalFamily;
  /** Composed by the daemon ("Claude wants to add the skill `release-notes` to Claude Code"); one line. */
  title: string;
  /** The scope badge ("Global — every Claude Code chat", "Project jaspersito/orquester-3") and the projects reached. */
  scope: { label: string; projects?: ToolApprovalScopeProject[] };
  /** The agent's reason, plain text. */
  reason?: string;
  sections: ApprovalPreviewSection[];
  /**
   * True when `sections` are cut to fit {@link TOOL_APPROVAL_SUMMARY_MAX_BYTES}: the whole preview
   * is fetched from `GET agentChatRoutes.toolApproval(sessionId, approvalId)`.
   */
  fullPreview: boolean;
  /** Masked inputs the user fills before approving (`{ask: true}` values, workflow secrets). */
  secretFields: { key: string; label: string }[];
  /** Grant choices for the Approve menu; empty unless the caller is `full-access` and the family allows one (§7.6). */
  grantOptions: ToolApprovalGrantScope[];
  requestedAt: string;
  expiresAt: string;
}

/** How a card ended. `not_delivered`: approved, but the call's result never left the daemon. */
export type ToolApprovalOutcome = "approved" | "denied" | "timed_out" | "cancelled" | "not_delivered";
export const TOOL_APPROVAL_OUTCOMES: readonly ToolApprovalOutcome[] = ["approved", "denied", "timed_out", "cancelled", "not_delivered"];

/** `POST agentChatRoutes.toolApproval(sessionId, approvalId)` — the only way to answer a card. */
export interface ToolApprovalAnswer {
  decision: "approve" | "deny";
  /** Approve and also grant (must be one of the card's `grantOptions`; 400 otherwise). */
  grant?: ToolApprovalGrantScope;
  /** Deny: the user's words to the agent (≤ {@link TOOL_APPROVAL_DENY_REASON_MAX_CHARS}). */
  reason?: string;
  /** Approve: one value per `secretFields` key. Never stored, logged, broadcast or returned. */
  secrets?: Record<string, string>;
}

/** The answer's response — the outcome only, never a secret. */
export interface ToolApprovalAnswerResponse {
  ok: true;
  outcome: "approved" | "denied";
  /** The grant the answer created. */
  grantId?: string;
}

/** `GET agentChatRoutes.toolApprovals(sessionId)` — the chat's pending cards, oldest first. */
export interface ToolApprovalListResponse {
  approvals: ToolApprovalSummary[];
}

/** `GET agentChatRoutes.toolApproval(sessionId, approvalId)` — one pending card with its WHOLE preview. */
export interface ToolApprovalDetailResponse {
  approval: ToolApprovalSummary;
}

/** The card routes' refusals (agent-chat error envelope). */
export type ToolApprovalErrorCode =
  | "THREAD_NOT_FOUND"
  /** 404: no such card (answered, expired, or dropped by a daemon restart). */
  | "APPROVAL_NOT_FOUND"
  /** 409: the card is no longer pending — answered by another client, or the agent stopped waiting. */
  | "APPROVAL_NOT_PENDING"
  /** 400: a malformed answer, a grant outside `grantOptions`, a missing or unknown secret field. */
  | "INVALID_ARGUMENT"
  /** 403: the answer came from an agent or external principal — only a person answers a card. */
  | "PERMISSION_DENIED"
  /**
   * 503: the approval needs a write (a grant) the read-only agent-tools store refuses; the card
   * stays pending (approve without a grant, or deny).
   */
  | "AGENT_TOOLS_UNAVAILABLE";

export interface ToolApprovalErrorEnvelope {
  error: { code: ToolApprovalErrorCode; message: string };
}

/** The bus event a card opening or closing publishes on the `sessions` channel. */
export const TOOL_APPROVAL_EVENT_TYPE = "agentChat.toolApproval";

/** Exactly one of `opened` / `closed`. Never a value. */
export interface AgentChatToolApprovalEventPayload {
  threadId: string;
  opened?: ToolApprovalSummary;
  closed?: { approvalId: string; outcome: ToolApprovalOutcome };
}

// ---------------------------------------------------------------------------
// The tool row's reference (`toolApproval`)
// ---------------------------------------------------------------------------

/** The result field the reference travels in; listed in `SESSION_TOOL_REFERENCE_KEYS`. */
export const TOOL_APPROVAL_REFERENCE_KEY = "toolApproval";

/**
 * What a gated call's row keeps: "Approved by you", "Allowed by a chat grant · Revoke" (`granted`,
 * with `grantId` and `grantScope`), "Denied: <reason>", "Expired", "Cancelled". No arguments, no
 * secrets.
 */
export interface ToolApprovalReference {
  /** Absent when an existing grant allowed the call without a card (`outcome: "granted"`). */
  approvalId?: string;
  kind: ApprovalKind;
  family: ApprovalFamily;
  title: string;
  outcome: ToolApprovalOutcome | "granted";
  /** The grant that allowed the call, or the one its approval created. */
  grantId?: string;
  /** That grant's reach ("Allowed by a chat grant" / "a project grant"); with `grantId` only. */
  grantScope?: ToolApprovalGrantScope;
  /** `denied`: the user's words (sanitised prose, ≤ {@link TOOL_APPROVAL_DENY_REASON_MAX_CHARS}). */
  reason?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const SHORT_ID = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

/** `value` as a reference, or undefined (never trusted as is: it came through a provider). */
export function readToolApprovalReference(value: unknown): ToolApprovalReference | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { approvalId, kind, family, title, outcome, grantId, grantScope, reason } = record;
  if (typeof kind !== "string" || !(APPROVAL_KINDS as readonly string[]).includes(kind)) return undefined;
  if (!isApprovalFamily(family)) return undefined;
  if (typeof outcome !== "string" || !([...TOOL_APPROVAL_OUTCOMES, "granted"] as string[]).includes(outcome)) return undefined;
  if (approvalId !== undefined && !SHORT_ID(approvalId)) return undefined;
  if (approvalId === undefined && outcome !== "granted") return undefined;
  const denyReason =
    outcome === "denied" && typeof reason === "string" ? sanitizeApprovalProse(reason, TOOL_APPROVAL_DENY_REASON_MAX_CHARS).trim() : "";
  return {
    ...(approvalId !== undefined ? { approvalId } : {}),
    kind: kind as ApprovalKind,
    family,
    title: typeof title === "string" ? sanitizeApprovalLabel(title) : "",
    outcome: outcome as ToolApprovalReference["outcome"],
    ...(SHORT_ID(grantId) ? { grantId } : {}),
    ...(SHORT_ID(grantId) && (grantScope === "chat" || grantScope === "project") ? { grantScope } : {}),
    ...(denyReason ? { reason: denyReason } : {})
  };
}

/** The card a session-tool row went through, or undefined. Only a row the host marked as its own session tool's is read. */
export function toolApprovalReferenceOfActivityData(data: unknown): ToolApprovalReference | undefined {
  const record = asRecord(data);
  if (!record || sessionToolNameOfData(record) === null) return undefined;
  return readToolApprovalReference(sessionToolReferences(record, [TOOL_APPROVAL_REFERENCE_KEY])?.[TOOL_APPROVAL_REFERENCE_KEY]);
}

// ---------------------------------------------------------------------------
// Text safety (§7.1, ruling S7)
// ---------------------------------------------------------------------------

/**
 * Characters never rendered as they are: every control (`\p{Cc}`: C0, DEL, C1) and every format
 * character (`\p{Cf}`: bidi embeddings, overrides, isolates and marks U+202A–202E, U+2066–2069,
 * U+200E/F, U+061C; zero-width U+200B–200D, U+2060–2064, U+FEFF, U+00AD, U+180E; interlinear
 * annotation U+FFF9–FFFB; tag characters U+E0000–E007F; …), the combining grapheme joiner U+034F,
 * the Hangul fillers U+115F, U+1160, U+3164, U+FFA0, and lone surrogates. `\n` and `\t` are
 * matched too; the callers decide what they become.
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\u034f\u115f\u1160\u3164\uffa0]/gu;

/** `<U+XXXX>` for one character (code point, so a tag character reads `<U+E0041>`). */
function visibleEscape(char: string): string {
  return `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`;
}

function cut(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Never inside a surrogate pair.
  let end = maxChars - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * A title or label as a card shows it: newlines and tabs become spaces, every other unsafe
 * character is removed, whitespace runs collapse, and the result is trimmed and cut to `maxChars`.
 */
export function sanitizeApprovalLabel(text: string, maxChars: number = TOOL_APPROVAL_LABEL_MAX_CHARS): string {
  const flat = text.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim();
  return cut(flat, maxChars);
}

/**
 * Agent prose (a reason, a `text` section) as plain multi-line text: line breaks are kept (`\r\n`
 * and `\r` read as `\n`), tabs kept, every other unsafe character removed.
 */
export function sanitizeApprovalProse(text: string, maxChars?: number): string {
  const clean = text.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(UNSAFE_CHARS, (char) => (char === "\n" || char === "\t" ? char : ""));
  return maxChars === undefined ? clean : cut(clean, maxChars);
}

/**
 * Code or diff text as a card shows it: line breaks and tabs kept (`\r\n` read as `\n`); every
 * other unsafe character shown as a visible escape `<U+202E>` so a hidden override or zero-width
 * character in a script cannot disguise what runs.
 */
export function escapeApprovalCodeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(UNSAFE_CHARS, (char) =>
    char === "\n" || char === "\t" ? char : visibleEscape(char)
  );
}

// ---------------------------------------------------------------------------
// Preview sizes
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** UTF-8 bytes of `value`'s JSON. */
function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "").length;
}

/** The preview's size as both caps measure it: UTF-8 bytes of its sections' JSON. */
export function approvalPreviewBytes(sections: readonly ApprovalPreviewSection[]): number {
  return jsonBytes(sections);
}

/** `text` cut to at most `maxBytes` UTF-8 bytes, never inside a character. */
function cutToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Room kept for the closing "view all" note whenever something is cut. */
const SUMMARY_NOTE_RESERVE_BYTES = 512;

/** A `text` / `code` / `diff` / `warning` section cut to fit `budget` bytes (`partial: true`), or null when even its shell does not fit. */
function cutSection(section: ApprovalPreviewSection, budget: number): ApprovalPreviewSection | null {
  if (section.kind !== "text" && section.kind !== "code" && section.kind !== "diff" && section.kind !== "warning") return null;
  const text = section.kind === "diff" ? section.unifiedDiff : section.text;
  const shell: ApprovalPreviewSection =
    section.kind === "diff"
      ? { ...section, unifiedDiff: "", partial: true }
      : section.kind === "warning"
        ? { ...section, text: "" }
        : { ...section, text: "", partial: true };
  // JSON escaping can grow a character up to 6 bytes; leave room for it.
  const room = Math.floor((budget - jsonBytes(shell) - 1) / 6);
  if (room <= 0) return null;
  const kept = cutToBytes(text, room) + (section.kind === "warning" ? " … (view all)" : "");
  const next: ApprovalPreviewSection = section.kind === "diff" ? { ...(shell as typeof section), unifiedDiff: kept } : ({ ...shell, text: kept } as ApprovalPreviewSection);
  return jsonBytes(next) + 1 <= budget ? next : null;
}

/**
 * The sections a summary carries — NEVER more than `maxBytes` (`approvalPreviewBytes`). When the
 * whole preview fits, all of it (`fullPreview: false`). Otherwise budget goes first to the flags
 * (`warning`, then `file` sections, in order; a warning's text is cut rather than dropped), then to
 * the other sections in order: long `text` / `code` / `diff` text is cut (`partial: true`) and a
 * section that cannot fit is left out. Whatever was cut or left out, the summary ends with a
 * `danger` note pointing at "View all" (`fullPreview: true`: the whole preview is fetched from the
 * card route). Sections keep their original order.
 */
export function summarizeApprovalPreview(
  sections: readonly ApprovalPreviewSection[],
  maxBytes: number = TOOL_APPROVAL_SUMMARY_MAX_BYTES
): { sections: ApprovalPreviewSection[]; fullPreview: boolean } {
  if (approvalPreviewBytes(sections) <= maxBytes) return { sections: [...sections], fullPreview: false };
  // `[]` is 2 bytes; each section adds its JSON and a comma.
  let budget = maxBytes - 2 - SUMMARY_NOTE_RESERVE_BYTES;
  const kept = new Map<number, ApprovalPreviewSection>();
  let omitted = 0;
  const place = (index: number, section: ApprovalPreviewSection): void => {
    const whole = jsonBytes(section) + 1;
    if (whole <= budget) {
      kept.set(index, section);
      budget -= whole;
      return;
    }
    const cut = cutSection(section, budget);
    if (cut) {
      kept.set(index, cut);
      budget -= jsonBytes(cut) + 1;
      return;
    }
    omitted += 1;
  };
  const order = (kinds: readonly ApprovalPreviewSectionKind[]): void =>
    sections.forEach((section, index) => {
      if (kinds.includes(section.kind)) place(index, section);
    });
  order(["warning"]);
  order(["file"]);
  order(["text", "code", "diff", "fields", "changes"]);
  const out = sections.flatMap((_, index) => (kept.has(index) ? [kept.get(index)!] : []));
  out.push({
    kind: "warning",
    level: "danger",
    text: `This preview is longer than the card shows${omitted > 0 ? ` (${omitted} section${omitted === 1 ? "" : "s"} left out)` : ""}: open "View all" to read every part before approving.`
  });
  return { sections: out, fullPreview: true };
}

// ---------------------------------------------------------------------------
// The answer (validated server-side, S7)
// ---------------------------------------------------------------------------

export type ToolApprovalAnswerCheck = { ok: true; answer: ToolApprovalAnswer } | { ok: false; message: string };

const ANSWER_KEYS = new Set(["decision", "grant", "reason", "secrets"]);

/**
 * Validate an answer body against its card. Refused: anything but an object of the known keys; a
 * `decision` other than approve/deny; a `grant` on a deny or outside the card's `grantOptions`; a
 * reason that is not a string; on approve, a secret key the card did not ask for, a missing or
 * empty one, or one over {@link TOOL_APPROVAL_SECRET_MAX_CHARS}. A deny drops any secrets sent
 * (never kept). The reason is sanitised ({@link sanitizeApprovalProse}) and cut to
 * {@link TOOL_APPROVAL_DENY_REASON_MAX_CHARS}. Error messages never quote a value.
 */
export function validateToolApprovalAnswer(
  body: unknown,
  card: Pick<ToolApprovalSummary, "grantOptions" | "secretFields">
): ToolApprovalAnswerCheck {
  const record = asRecord(body);
  if (!record) return { ok: false, message: "The answer must be an object." };
  for (const key of Object.keys(record)) {
    if (!ANSWER_KEYS.has(key)) return { ok: false, message: `Unknown answer field "${sanitizeApprovalLabel(key, 40)}".` };
  }
  const { decision, grant, reason, secrets } = record;
  if (decision !== "approve" && decision !== "deny") return { ok: false, message: 'decision must be "approve" or "deny".' };
  if (reason !== undefined && typeof reason !== "string") return { ok: false, message: "reason must be a string." };
  const cleanReason = typeof reason === "string" ? sanitizeApprovalProse(reason, TOOL_APPROVAL_DENY_REASON_MAX_CHARS).trim() : "";
  if (decision === "deny") {
    if (grant !== undefined) return { ok: false, message: "A grant can only come with an approval." };
    return { ok: true, answer: { decision, ...(cleanReason ? { reason: cleanReason } : {}) } };
  }
  if (grant !== undefined && (typeof grant !== "string" || !(card.grantOptions as readonly string[]).includes(grant))) {
    return { ok: false, message: "That grant is not offered on this card." };
  }
  const asked = new Set(card.secretFields.map((field) => field.key));
  const values: Record<string, string> = {};
  if (secrets !== undefined) {
    const given = asRecord(secrets);
    if (!given) return { ok: false, message: "secrets must be an object." };
    for (const [key, value] of Object.entries(given)) {
      if (!asked.has(key)) return { ok: false, message: "A secret was sent for a field this card does not ask for." };
      if (typeof value !== "string" || value.length === 0) return { ok: false, message: "Every secret field needs a value." };
      if (value.length > TOOL_APPROVAL_SECRET_MAX_CHARS) return { ok: false, message: `A secret value is longer than ${TOOL_APPROVAL_SECRET_MAX_CHARS} characters.` };
      values[key] = value;
    }
  }
  for (const key of asked) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return { ok: false, message: "Every secret field needs a value." };
  }
  return {
    ok: true,
    answer: {
      decision,
      ...(grant !== undefined ? { grant: grant as ToolApprovalGrantScope } : {}),
      ...(cleanReason ? { reason: cleanReason } : {}),
      ...(asked.size > 0 ? { secrets: values } : {})
    }
  };
}

// ---------------------------------------------------------------------------
// Secret stripping
// ---------------------------------------------------------------------------

/** Values shorter than this are removed by shape only: masking them everywhere would wreck unrelated text. */
export const TOOL_APPROVAL_SECRET_MASK_MIN_CHARS = 4;

const STRIP_MAX_DEPTH = 64;

/**
 * Whether `record` is an approval answer or approval context that carries card secrets: a
 * `secrets` key whose value is an object (`{key: value}`), beside `decision` (a
 * {@link ToolApprovalAnswer}) or `outcome` / `approvalId` / `grantId` (`CallContext.approval`, an
 * `ApprovalOutcome`). A `secrets` LIST — e.g. `list_workflow_secrets`' secret names — or a
 * `secrets` key anywhere else is data and is never touched.
 */
function carriesCardSecrets(record: Record<string, unknown>): boolean {
  const secrets = record.secrets;
  if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) return false;
  return "decision" in record || "outcome" in record || "approvalId" in record || "grantId" in record;
}

/**
 * `value` without card secrets, for anything that leaves the waiting call — a summary, an event, a
 * log line, a tool result, a row:
 * - **by shape**: the `secrets` object of an approval answer or approval context is removed
 *   (only those records — see `carriesCardSecrets`; secret NAMES elsewhere stay);
 * - **by value**: every occurrence of one of `secretValues` (at least
 *   {@link TOOL_APPROVAL_SECRET_MASK_MIN_CHARS} characters) in any string is replaced by
 *   `[secret redacted]`. Pass the values the card collected.
 * Fails closed past the depth bound (the value is replaced). Returns `value` itself when nothing
 * changed.
 */
export function stripToolApprovalSecrets<T>(value: T, secretValues: Iterable<string> = []): T {
  const masks = [...new Set([...secretValues].filter((secret) => typeof secret === "string" && secret.length >= TOOL_APPROVAL_SECRET_MASK_MIN_CHARS))].sort(
    (a, b) => b.length - a.length
  );
  return stripApproval(value, masks, 0) as T;
}

function stripApproval(value: unknown, masks: readonly string[], depth: number): unknown {
  if (depth > STRIP_MAX_DEPTH) {
    return typeof value === "string" || (value !== null && typeof value === "object") ? SECRET_REDACTED_TEXT : value;
  }
  if (typeof value === "string") {
    let out = value;
    for (const mask of masks) if (out.includes(mask)) out = out.split(mask).join(SECRET_REDACTED_TEXT);
    return out;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    value.forEach((entry: unknown, index) => {
      const next = stripApproval(entry, masks, depth + 1);
      if (next !== entry) {
        copy ??= value.slice();
        copy[index] = next;
      }
    });
    return copy ?? value;
  }
  const record = value as Record<string, unknown>;
  let copy: Record<string, unknown> | null = null;
  if (carriesCardSecrets(record)) {
    copy = { ...record };
    delete copy.secrets;
  }
  for (const [key, entry] of Object.entries(copy ?? record)) {
    const next = stripApproval(entry, masks, depth + 1);
    if (next !== entry) {
      copy ??= { ...record };
      copy[key] = next;
    }
  }
  return copy ?? value;
}

// ---------------------------------------------------------------------------
// Reading untrusted card JSON (a bus payload, a list answer) into UI state
// ---------------------------------------------------------------------------

const str = (value: unknown): value is string => typeof value === "string";

function parseSection(value: unknown): ApprovalPreviewSection | null {
  const s = asRecord(value);
  if (!s) return null;
  const partial = s.partial === true ? { partial: true as const } : {};
  switch (s.kind) {
    case "text":
      return str(s.text) ? { kind: "text", ...(str(s.title) ? { title: sanitizeApprovalLabel(s.title) } : {}), text: sanitizeApprovalProse(s.text), ...partial } : null;
    case "code":
      return str(s.title) && str(s.text)
        ? {
            kind: "code",
            title: sanitizeApprovalLabel(s.title),
            ...(str(s.language) ? { language: sanitizeApprovalLabel(s.language, 40) } : {}),
            text: escapeApprovalCodeText(s.text),
            ...partial,
            ...(str(s.sha256) ? { sha256: sanitizeApprovalLabel(s.sha256, 128) } : {})
          }
        : null;
    case "diff":
      return str(s.title) && str(s.unifiedDiff) ? { kind: "diff", title: sanitizeApprovalLabel(s.title), unifiedDiff: escapeApprovalCodeText(s.unifiedDiff), ...partial } : null;
    case "fields": {
      if (!Array.isArray(s.rows)) return null;
      const rows = s.rows.flatMap((row): ApprovalPreviewFieldRow[] => {
        const r = asRecord(row);
        if (!r || !str(r.label) || !str(r.value)) return [];
        const state = r.state === "set" || r.state === "asked" || r.state === "flagged" ? { state: r.state as ApprovalPreviewFieldRow["state"] } : {};
        return [{ label: sanitizeApprovalLabel(r.label), value: escapeApprovalCodeText(r.value), ...state }];
      });
      return { kind: "fields", ...(str(s.title) ? { title: sanitizeApprovalLabel(s.title) } : {}), rows };
    }
    case "changes": {
      if (!str(s.title) || !Array.isArray(s.items)) return null;
      const items = s.items.flatMap((item): ApprovalPreviewChange[] => {
        const i = asRecord(item);
        if (!i || !str(i.label) || (i.change !== "added" && i.change !== "removed" && i.change !== "changed")) return [];
        return [{ label: sanitizeApprovalLabel(i.label), change: i.change, ...(str(i.detail) ? { detail: sanitizeApprovalProse(i.detail) } : {}) }];
      });
      return { kind: "changes", title: sanitizeApprovalLabel(s.title), items };
    }
    case "file":
      return str(s.path) && typeof s.size === "number" && Number.isFinite(s.size) && s.size >= 0 && str(s.sha256)
        ? {
            kind: "file",
            path: sanitizeApprovalLabel(s.path, 4096),
            size: s.size,
            sha256: sanitizeApprovalLabel(s.sha256, 128),
            ...(s.flag === "binary" || s.flag === "executable" ? { flag: s.flag } : {})
          }
        : null;
    case "warning":
      return (s.level === "caution" || s.level === "danger") && str(s.text) ? { kind: "warning", level: s.level, text: sanitizeApprovalProse(s.text) } : null;
    default:
      // A section kind this build does not know: shown as a note, never silently dropped.
      return { kind: "warning", level: "caution", text: "Part of this preview needs a newer Orquester to show; open the card on an updated client before approving." };
  }
}

/**
 * A card as a client renders it: {@link ToolApprovalSummary}, except that a kind or family this
 * build does not know (a newer daemon's) reads `"unknown"` — rendered as a generic card with a
 * caution, never dropped (the agent is waiting on it).
 */
export interface ParsedToolApprovalSummary extends Omit<ToolApprovalSummary, "kind" | "family"> {
  kind: ApprovalKind | "unknown";
  family: ApprovalFamily | "unknown";
}

const NEWER_CARD_CAUTION: ApprovalPreviewSection = {
  kind: "warning",
  level: "caution",
  text: "This approval comes from a newer Orquester than this client knows; check it on an updated client before approving."
};

/**
 * A card from untrusted JSON (a bus payload, a list answer), sanitised for rendering, or null when
 * it is not a card at all (no ids, title, times, scope or sections). An unknown kind or family
 * reads `"unknown"` with a caution first and no grant options; a section that does not read is
 * replaced by a caution, never dropped silently.
 */
export function parseToolApprovalSummary(value: unknown): ParsedToolApprovalSummary | null {
  const r = asRecord(value);
  if (!r) return null;
  const { approvalId, threadId, tool, kind, family, title, requestedAt, expiresAt } = r;
  if (!SHORT_ID(approvalId) || !SHORT_ID(threadId) || !str(tool) || !str(title) || !str(requestedAt) || !str(expiresAt)) return null;
  const knownKind = typeof kind === "string" && (APPROVAL_KINDS as readonly string[]).includes(kind);
  const knownFamily = isApprovalFamily(family);
  const scope = asRecord(r.scope);
  if (!scope || !str(scope.label) || !Array.isArray(r.sections)) return null;
  const projects = Array.isArray(scope.projects)
    ? scope.projects.flatMap((p): ToolApprovalScopeProject[] => {
        const project = asRecord(p);
        if (!project || !str(project.path) || !str(project.workspace)) return [];
        return [{ path: project.path, workspace: sanitizeApprovalLabel(project.workspace), ...(str(project.gitAccountLabel) ? { gitAccountLabel: sanitizeApprovalLabel(project.gitAccountLabel) } : {}) }];
      })
    : undefined;
  const sections = r.sections.map(
    (section) => parseSection(section) ?? ({ kind: "warning", level: "caution", text: "Part of this preview could not be read; open the card on an updated client before approving." } as const)
  );
  const secretFields = Array.isArray(r.secretFields)
    ? r.secretFields.flatMap((f): { key: string; label: string }[] => {
        const field = asRecord(f);
        return field && str(field.key) && field.key.length > 0 && str(field.label) ? [{ key: field.key, label: sanitizeApprovalLabel(field.label) }] : [];
      })
    : [];
  const grantOptions =
    knownKind && knownFamily && Array.isArray(r.grantOptions)
      ? [...new Set(r.grantOptions.filter((g): g is ToolApprovalGrantScope => g === "chat" || g === "project"))]
      : [];
  if (!knownKind || !knownFamily) sections.unshift(NEWER_CARD_CAUTION);
  return {
    approvalId,
    threadId,
    tool: sanitizeApprovalLabel(tool, 64),
    kind: knownKind ? (kind as ApprovalKind) : "unknown",
    family: knownFamily ? family : "unknown",
    title: sanitizeApprovalLabel(title),
    scope: { label: sanitizeApprovalLabel(scope.label), ...(projects ? { projects } : {}) },
    ...(str(r.reason) && r.reason.trim() ? { reason: sanitizeApprovalProse(r.reason, TOOL_APPROVAL_REASON_MAX_CHARS) } : {}),
    sections,
    fullPreview: r.fullPreview === true,
    secretFields,
    grantOptions,
    requestedAt,
    expiresAt
  };
}
