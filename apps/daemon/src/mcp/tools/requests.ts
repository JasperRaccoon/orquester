import { z } from "zod";
import type { ApprovalDecision, AttachmentRef } from "@orquester/api/agent-chat";
import { attachmentInputSchema, MAX_ATTACHMENTS, uploadInlineAttachments, type AttachmentInput } from "../attachments.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError } from "../errors.ts";
import { readThread, requireChatSession, sendCommand } from "../reads.ts";
import { defineTool, MUTATING, type ToolDef } from "../tool.ts";
import { chatDetail, pendingApprovalViews, pendingQuestionViews, type PendingQuestionView } from "../views.ts";

const sessionIdField = z.string().min(1).describe("The session id from list_sessions.");
const requestIdField = z.string().optional().describe("The request id from get_session; may be omitted when exactly one is pending.");
const DECISIONS = ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"] as const satisfies readonly ApprovalDecision[];

function pick<T extends { requestId: string }>(rows: T[], requestId: string | undefined, noun: string): T {
  if (requestId) {
    const hit = rows.find((r) => r.requestId === requestId);
    if (!hit) throw new ToolError("INVALID_ARGUMENT", `No pending ${noun} with requestId "${requestId}". Pending: ${rows.map((r) => r.requestId).join(", ") || "none"}.`);
    return hit;
  }
  if (rows.length === 1) return rows[0]!;
  if (!rows.length) throw new ToolError("INVALID_ARGUMENT", `No pending ${noun} on this session.`);
  throw new ToolError("INVALID_ARGUMENT", `Several ${noun}s are pending; pass requestId (${rows.map((r) => r.requestId).join(", ")}).`);
}

type Q = PendingQuestionView["questions"][number];
type Answer = string | string[];

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
  const notAnOption = (text: string, hint = "") => ({ error: `"${text}" is not an option of "${nameOf(q)}". Options: ${q.options.map((o) => o.label).join(", ")}.${hint}` });
  if (q.multiSelect) {
    if (Array.isArray(raw) || optionValue(q, raw) !== undefined) {
      const values: string[] = [];
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        const value = optionValue(q, item);
        if (value === undefined) return notAnOption(item, q.allowCustomAnswer ? " Pass a string for a custom answer." : "");
        if (!values.includes(value)) values.push(value);
      }
      return { value: values };
    }
    return q.allowCustomAnswer ? { value: raw.trim() } : notAnOption(raw);
  }
  if (Array.isArray(raw) && raw.length !== 1) return { error: `"${nameOf(q)}" takes one answer.` };
  const text = Array.isArray(raw) ? raw[0]! : raw;
  const value = optionValue(q, text);
  if (value !== undefined) return { value };
  return q.allowCustomAnswer ? { value: text.trim() } : notAnOption(text);
}

/** One question's files, uploaded in order; a failure names the question it belongs to. */
async function uploadFor(api: DaemonApi, sessionId: string, q: Q, files: readonly AttachmentInput[]): Promise<AttachmentRef[]> {
  try {
    return await uploadInlineAttachments(api, sessionId, files);
  } catch (error) {
    if (error instanceof ToolError) throw new ToolError(error.code, `Attachments for "${nameOf(q)}": ${error.message}`, error.detail);
    throw error;
  }
}

const answerQuestion = defineTool({
  name: "answer_question",
  title: "Answer the agent's question",
  description: "Answer a pending AskUserQuestion-style request, every question at once. Keys are question ids from get_session, or their 1-based indexes (an exact id wins). A string picks an option (label or value) or, where allowCustomAnswer, is a custom answer; an array picks several on a multiSelect question. Attachments per question are optional (not on secret or options-only questions); files alone answer a question. Works for Codex's async questions too.",
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
    const files = byQuestion(args.attachments, req.questions, unknown, errors);
    if (unknown.size) errors.push(`${[...unknown].map((k) => `"${k}"`).join(", ")} ${unknown.size === 1 ? "is not a question" : "are not questions"} of this request. Questions: ${req.questions.map((q) => `${q.index}: ${q.id}`).join(" | ")}.`);
    const answers: Record<string, Answer> = {};
    const missing: string[] = [];
    for (const q of req.questions) {
      const raw = given.get(q.index);
      const attached = (files.get(q.index)?.length ?? 0) > 0;
      // The GUI offers files only beside a custom answer, and never on a secret (`allowsAnswerAttachments`).
      if (attached && q.isSecret) errors.push(`"${nameOf(q)}" is a secret field and takes no attachments.`);
      else if (attached && !q.allowCustomAnswer) errors.push(`"${nameOf(q)}" takes only its listed options, so no attachments.`);
      if (raw === undefined || isBlank(raw)) {
        if (attached) answers[q.id] = "";
        else missing.push(nameOf(q));
        continue;
      }
      const encoded = encodeAnswer(q, raw);
      if ("error" in encoded) errors.push(encoded.error);
      else answers[q.id] = encoded.value;
    }
    if (missing.length) errors.push(`Every question must be answered. Missing: ${missing.join(", ")}.`);
    if (errors.length) throw new ToolError("INVALID_ARGUMENT", errors.join(" "));
    // Pass 2 uploads each question's files in question order, before the command (§8.3).
    const attachmentsByQuestionId: Record<string, AttachmentRef[]> = {};
    for (const q of req.questions) {
      const list = files.get(q.index);
      if (list?.length) attachmentsByQuestionId[q.id] = await uploadFor(api, args.sessionId, q, list);
    }
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
