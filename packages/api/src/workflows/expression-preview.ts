// Automated workflows — the expression preview's request contract (`POST …/expression-preview`).
//
// Pure: the daemon route and its callers share one reading of the body, so a refusal names the
// same field wherever it is judged.

import { MAX_TEMPLATE_LENGTH } from "./expressions.ts";
import type { PreviewWorkflowExpressionRequest } from "./types.ts";

export const EXPRESSION_PREVIEW_LIMITS = {
  /** Templates per request. */
  maxTemplates: 20,
  /** A template longer than this is refused: the renderer would not read its expressions either. */
  maxTemplateLength: MAX_TEMPLATE_LENGTH,
  /** A rendered text (or a value's JSON) is cut past this many UTF-8 bytes. */
  maxRenderedBytes: 256 * 1024
} as const;

export type ExpressionPreviewRequestParse =
  | { ok: true; request: PreviewWorkflowExpressionRequest }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read a preview request body; unknown keys are ignored (a newer client may send more). */
export function parseExpressionPreviewRequest(body: unknown): ExpressionPreviewRequestParse {
  if (!isRecord(body)) return { ok: false, error: "The body must be {templates, node?, runId?, usePinned?, mode?}." };
  const { templates, node, runId, usePinned, mode } = body;
  const { maxTemplates, maxTemplateLength } = EXPRESSION_PREVIEW_LIMITS;
  if (!Array.isArray(templates) || templates.length === 0) {
    return { ok: false, error: "templates must be a list of 1 to 20 texts." };
  }
  if (templates.length > maxTemplates) {
    return { ok: false, error: `templates holds ${templates.length} texts; at most ${maxTemplates} are previewed at once.` };
  }
  for (const [index, template] of templates.entries()) {
    if (typeof template !== "string") return { ok: false, error: `templates[${index}] must be a text.` };
    if (template.length > maxTemplateLength) {
      return { ok: false, error: `templates[${index}] is longer than ${maxTemplateLength} characters; its {{ … }} expressions would not be read.` };
    }
  }
  if (node !== undefined && (typeof node !== "string" || node.length === 0)) return { ok: false, error: "node must be a block id or name." };
  if (runId !== undefined && (typeof runId !== "string" || runId.length === 0)) return { ok: false, error: "runId must be a run id." };
  if (usePinned !== undefined && typeof usePinned !== "boolean") return { ok: false, error: "usePinned must be true or false." };
  if (mode !== undefined && mode !== "text" && mode !== "value") return { ok: false, error: 'mode must be "text" or "value".' };
  const request: PreviewWorkflowExpressionRequest = { templates: [...(templates as string[])] };
  if (node !== undefined) request.node = node as string;
  if (runId !== undefined) request.runId = runId as string;
  if (usePinned !== undefined) request.usePinned = usePinned as boolean;
  if (mode !== undefined) request.mode = mode as "text" | "value";
  return { ok: true, request };
}
