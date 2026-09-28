/**
 * The owner a chat tab may carry (workflows spec §5.10): the automated workflow run, and the
 * block in it, that started the session. One validation for the create route and the service, on
 * the SAME schema `sessions.json` is read with (`workflowSessionOwnerSchema`), so an owner the
 * route accepts always survives a restart.
 */

import type { WorkflowSessionOwner } from "@orquester/api";
import { workflowSessionOwnerSchema } from "@orquester/config";

export const INVALID_OWNER = "INVALID_OWNER";

export const INVALID_OWNER_MESSAGE =
  'owner must be {kind:"workflow", workflowId, runId, nodeId} with non-empty ids of at most 200 characters.';

/**
 * `undefined` → no owner (ok). Anything else must parse; unknown keys are stripped so only the
 * four documented fields are ever persisted or broadcast.
 */
export function parseSessionOwner(
  value: unknown
): { ok: true; owner: WorkflowSessionOwner | undefined } | { ok: false; code: typeof INVALID_OWNER; message: string } {
  if (value === undefined) return { ok: true, owner: undefined };
  const parsed = workflowSessionOwnerSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: INVALID_OWNER, message: INVALID_OWNER_MESSAGE };
  const { kind, workflowId, runId, nodeId } = parsed.data;
  return { ok: true, owner: { kind, workflowId, runId, nodeId } };
}
