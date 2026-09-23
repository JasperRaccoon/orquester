import { z } from "zod";
import type { ApprovalDecision, AttachmentRef } from "@orquester/api/agent-chat";
import { attachmentInputSchema, MAX_ATTACHMENTS, uploadInlineAttachments, type AttachmentInput } from "../attachments.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError } from "../errors.ts";
import { readThread, requireChatSession, sendCommand } from "../reads.ts";
import { clipText, MAX_ECHO_CHARS } from "../result.ts";
import { defineTool, MUTATING, type ToolDef } from "../tool.ts";
import { chatDetail, pendingApprovalViews, pendingQuestionViews, type PendingQuestionView } from "../views.ts";

const sessionIdField = z.string().min(1).describe("The session id from list_sessions.");
// min(1): an empty requestId is not an omitted one — read as omitted, it would act on the one request pending.
const requestIdField = z.string().min(1).optional().describe("The request id from get_session; may be omitted when exactly one is pending.");
const DECISIONS = ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"] as const satisfies readonly ApprovalDecision[];

/** How many of the caller's values one refusal quotes; the rest are counted. */
const MAX_QUOTED_VALUES = 5;

/**
 * The caller's values as a refusal quotes them: each cut to MAX_ECHO_CHARS, at most MAX_QUOTED_VALUES of them, then how
 * many more. A caller's text is of any length, and quoted whole it pushed a refusal past the 4 000-character backstop,
 * which then cut the part that helps — the options, the questions, the pending ids.
 */
function quoteValues(values: readonly string[]): string {
  const quoted = values.slice(0, MAX_QUOTED_VALUES).map((v) => `"${clipText(v, MAX_ECHO_CHARS)}"`).join(", ");
  return values.length > MAX_QUOTED_VALUES ? `${quoted} and ${values.length - MAX_QUOTED_VALUES} more` : quoted;
}

function pick<T extends { requestId: string }>(rows: T[], requestId: string | undefined, noun: string): T {
  if (requestId !== undefined) {
    const hit = rows.find((r) => r.requestId === requestId);
    if (!hit) throw new ToolError("INVALID_ARGUMENT", `No pending ${noun} with requestId ${quoteValues([requestId])}. Pending: ${rows.map((r) => r.requestId).join(", ") || "none"}.`);
    return hit;
  }
  if (rows.length === 1) return rows[0]!;
  if (!rows.length) throw new ToolError("INVALID_ARGUMENT", `No pending ${noun} on this session.`);
  throw new ToolError("INVALID_ARGUMENT", `Several ${noun}s are pending; pass requestId (${rows.map((r) => r.requestId).join(", ")}).`);
}

type Q = PendingQuestionView["questions"][number];
type Answer = string | string[];
interface Batch { q: Q; files: readonly AttachmentInput[] }

const nameOf = (q: Q): string => q.header || q.question;

/** Resolve each key to its question, by index: an exact id wins over a 1-based index (spec §7.5); unknown keys and a question named twice are reported, never guessed. */
function byQuestion<T>(map: Record<string, T> | undefined, questions: readonly Q[], unknown: Set<string>, errors: string[]): Map<number, T> {
  const out = new Map<number, T>();
  for (const [key, value] of Object.entries(map ?? {})) {
    const q = questions.find((x) => x.id === key) ?? questions.find((x) => String(x.index) === key);
    if (!q) unknown.add(key);
    else if (out.has(q.index)) errors.push(`"${nameOf(q)}" is named twice, by its id and by its index ${q.index}.`);
    else out.set(q.index, value);
  }
  return out;
}

function optionValue(q: Q, text: string): string | undefined {
  const norm = (s: string) => s.trim().toLowerCase();
  const exact = q.options.find((o) => o.value === text || o.label === text);
  const loose = exact ?? q.options.find((o) => norm(o.label) === norm(text) || (o.value !== undefined && norm(o.value) === norm(text)));
  return loose ? (loose.value ?? loose.label) : undefined;
}

/** "", whitespace or [] is the GUI's unanswered state; files alone then answer the question, as "". */
const isBlank = (raw: Answer): boolean => (Array.isArray(raw) ? raw : [raw]).every((s) => !s.trim());

/** Encode one non-blank answer exactly as the GUI card does (spec §7.5): an option's value ?? label, several on multiSelect, else the custom text. */
function encodeAnswer(q: Q, raw: Answer): { value: Answer } | { error: string } {
  const notOptions = (texts: readonly string[], hint = "") => ({ error: `${quoteValues(texts)} ${texts.length === 1 ? "is not an option" : "are not options"} of "${nameOf(q)}". Options: ${q.options.map((o) => o.label).join(", ")}.${hint}` });
  if (q.multiSelect) {
    if (Array.isArray(raw) || optionValue(q, raw) !== undefined) {
      const values: string[] = [];
      const bad: string[] = [];
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        const value = optionValue(q, item);
        if (value === undefined) bad.push(item);
        else if (!values.includes(value)) values.push(value);
      }
      return bad.length ? notOptions(bad, q.allowCustomAnswer ? " Pass a string for a custom answer." : "") : { value: values };
    }
    return q.allowCustomAnswer ? { value: raw.trim() } : notOptions([raw]);
  }
  if (Array.isArray(raw) && raw.length !== 1) return { error: `"${nameOf(q)}" takes one answer.` };
  const text = Array.isArray(raw) ? raw[0]! : raw;
  const value = optionValue(q, text);
  if (value !== undefined) return { value };
  return q.allowCustomAnswer ? { value: text.trim() } : notOptions([text]);
}

/**
 * Every question's files in ONE upload call, which validates them all before sending any (§8), so a bad file anywhere
 * leaves nothing uploaded. The refs come back in input order and are sliced back per question.
 */
async function uploadAll(api: DaemonApi, sessionId: string, batches: readonly Batch[]): Promise<Record<string, AttachmentRef[]>> {
  const flat = batches.flatMap((b) => b.files);
  if (!flat.length) return {};
  let refs: AttachmentRef[];
  try {
    refs = await uploadInlineAttachments(api, sessionId, flat, { max: flat.length }); // the per-question cap is pass 1's
  } catch (error) {
    throw error instanceof ToolError ? pointAtQuestion(error, batches) : error;
  }
  const out: Record<string, AttachmentRef[]> = {};
  let offset = 0;
  for (const { q, files } of batches) {
    out[q.id] = refs.slice(offset, offset + files.length);
    offset += files.length;
  }
  return out;
}

/** Point a refusal's flat `attachments[i]` back at the question it belongs to and that question's own index. */
function pointAtQuestion(error: ToolError, batches: readonly Batch[]): ToolError {
  const match = /^attachments\[(\d+)\]/.exec(error.message);
  if (!match) return error;
  let index = Number(match[1]);
  for (const { q, files } of batches) {
    if (index < files.length) return new ToolError(error.code, `Attachments for "${nameOf(q)}": attachments[${index}]${error.message.slice(match[0].length)}`, error.detail);
    index -= files.length;
  }
  return error;
}

const answerQuestion = defineTool({
  name: "answer_question",
  title: "Answer the agent's question",
  description: "Answer a pending question request, every question at once. Keys: question ids from get_session, or 1-based indexes (an exact id wins). A string picks an option (label or value) or, where allowCustomAnswer, is a custom answer; an array picks several on a multiSelect question. Attachments per question are optional (not on secret or options-only questions); files alone answer a question.",
  input: {
    sessionId: sessionIdField,
    requestId: requestIdField,
    answers: z.record(z.union([z.string(), z.array(z.string())])).describe("questionId (or index) → answer."),
    attachments: z.record(z.array(attachmentInputSchema).max(MAX_ATTACHMENTS)).optional().describe("questionId (or index) → attachments.")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const req = pick(pendingQuestionViews(snap), args.requestId, "question");
    // Pass 1 validates the whole request and reports every problem at once: nothing is uploaded unless it all passes.
    const errors: string[] = [];
    const unknown = new Set<string>();
    const given = byQuestion(args.answers, req.questions, unknown, errors);
    const attached = byQuestion(args.attachments, req.questions, unknown, errors);
    if (unknown.size) errors.push(`${quoteValues([...unknown])} ${unknown.size === 1 ? "is not a question" : "are not questions"} of this request. Questions: ${req.questions.map((q) => `${q.index}: ${q.id}`).join(" | ")}.`);
    const answers: Record<string, Answer> = {};
    const batches: Batch[] = [];
    const missing: string[] = [];
    for (const q of req.questions) {
      const raw = given.get(q.index);
      const files = attached.get(q.index) ?? [];
      // The GUI offers files only beside a custom answer, and never on a secret (`allowsAnswerAttachments`); refused
      // files never stand in for the answer.
      const filesAllowed = q.allowCustomAnswer && !q.isSecret;
      if (files.length && !filesAllowed) errors.push(q.isSecret ? `"${nameOf(q)}" is a secret field and takes no attachments.` : `"${nameOf(q)}" takes only its listed options, so no attachments.`);
      else if (files.length > MAX_ATTACHMENTS) errors.push(`"${nameOf(q)}" takes at most ${MAX_ATTACHMENTS} attachments.`);
      else if (files.length) batches.push({ q, files });
      if (raw === undefined || isBlank(raw)) {
        if (files.length && filesAllowed) answers[q.id] = "";
        else missing.push(nameOf(q));
        continue;
      }
      const encoded = encodeAnswer(q, raw);
      if ("error" in encoded) errors.push(encoded.error);
      else answers[q.id] = encoded.value;
    }
    if (missing.length) errors.push(`Every question must be answered. Missing: ${missing.join(", ")}.`);
    if (errors.length) throw new ToolError("INVALID_ARGUMENT", errors.join(" "));
    // Pass 2 uploads every file in question order, in one call that validates them all first, before the command (§8.3).
    const attachmentsByQuestionId = await uploadAll(api, args.sessionId, batches);
    const { seq } = await sendCommand(api, args.sessionId, "answer", { requestId: req.requestId, answers, ...(Object.keys(attachmentsByQuestionId).length ? { attachmentsByQuestionId } : {}) });
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

const dismissQuestion = defineTool({
  name: "dismiss_question",
  title: "Dismiss a question",
  description: "Close a dismissible (message-mode / async) question without answering it. A blocking question cannot be dismissed — answer it or interrupt_session.",
  input: { sessionId: sessionIdField, requestId: requestIdField },
  annotations: MUTATING,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const req = pick(pendingQuestionViews(snap), args.requestId, "question");
    if (!req.dismissible) throw new ToolError("INVALID_ARGUMENT", `Question "${req.requestId}" blocks the agent and cannot be dismissed; answer it with answer_question or stop the turn with interrupt_session.`);
    const { seq } = await sendCommand(api, args.sessionId, "dismiss", { requestId: req.requestId });
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

const resolveApproval = defineTool({
  name: "resolve_approval",
  title: "Resolve a tool approval",
  description: "Answer a pending tool-permission request with one of its offered decisions (get_session lists them). Quirks: on Claude acceptAlways denies; on OpenCode acceptForSession/acceptAlways both mean 'always' for the whole directory.",
  input: { sessionId: sessionIdField, requestId: requestIdField, decision: z.enum(DECISIONS).describe("The decision.") },
  annotations: MUTATING,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const req = pick(pendingApprovalViews(snap), args.requestId, "approval");
    if (!req.decisions.some((d) => d.decision === args.decision)) {
      throw new ToolError("INVALID_ARGUMENT", `"${args.decision}" is not offered for this request. Offered: ${req.decisions.map((d) => d.decision).join(", ")}.`);
    }
    const { seq } = await sendCommand(api, args.sessionId, "approval", { requestId: req.requestId, decision: args.decision });
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

export const requestTools: ToolDef[] = [answerQuestion, dismissQuestion, resolveApproval] as ToolDef[];
