/**
 * What every save the editor makes tells the rest of the app: the daemon's
 * answer, sanitized field by field, puts the agent's fresh snapshot in the
 * store (`applyAgentProfileSnapshot` — for a copy, the target agent's), and
 * the panel hears which items changed and the notes worth saying
 * (`notifyAgentProfileEditorSaved`).
 */

import type { AgentProfileAgentId } from "@orquester/api";

import { applyAgentProfileSnapshot, sanitizeMutationResponse } from "../../../../lib/agent-profile/store";
import { notifyAgentProfileEditorSaved } from "../editor-bridge";

export function publishSaved(agent: AgentProfileAgentId, response: unknown): void {
  const answer = sanitizeMutationResponse(response);
  if (answer.snapshot !== null) applyAgentProfileSnapshot(answer.snapshot);
  notifyAgentProfileEditorSaved({ agent, itemIds: answer.itemIds, notes: answer.notes });
}
