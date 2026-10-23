/**
 * The owner a chat tab may carry: the automated workflow run, and the block in it, that started
 * the session (workflows spec §5.10), or the Knowledge Graph indexer's linking run. One validation
 * for the create route and the service, on the SAME schema `sessions.json` is read with
 * (`sessionOwnerSchema`), so an owner the route accepts always survives a restart.
 */

import type { SessionOwner } from "@orquester/api";
import { sessionOwnerSchema } from "@orquester/config";

export const INVALID_OWNER = "INVALID_OWNER";

export const INVALID_OWNER_MESSAGE =
  'owner must be {kind:"workflow", workflowId, runId, nodeId} or {kind:"knowledge-indexer", runId} with non-empty ids of at most 200 characters.';

/**
 * `undefined` → no owner (ok). Anything else must parse; unknown keys are stripped so only the
 * documented fields of its kind are ever persisted or broadcast.
 */
export function parseSessionOwner(
  value: unknown
): { ok: true; owner: SessionOwner | undefined } | { ok: false; code: typeof INVALID_OWNER; message: string } {
  if (value === undefined) return { ok: true, owner: undefined };
  const parsed = sessionOwnerSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: INVALID_OWNER, message: INVALID_OWNER_MESSAGE };
  return { ok: true, owner: parsed.data };
}
