/**
 * The instruction file editor's rules (agent profile spec §7.4): save against
 * the revision it read; on a 409 the owner picks Reload (take the disk's text)
 * or Overwrite (re-read for the fresh revision, then write theirs).
 */

import type {
  AgentProfileAgentId,
  ProfileInstructionsInfo,
  ProfileInstructionsResponse,
  ProfileMutationResponse,
  WriteProfileInstructionsRequest
} from "@orquester/api";

interface InstructionsIo {
  read(agent: AgentProfileAgentId): Promise<ProfileInstructionsResponse>;
  write(agent: AgentProfileAgentId, request: WriteProfileInstructionsRequest): Promise<ProfileMutationResponse>;
}

/** Overwrite: whatever is on disk now is replaced by `text`. */
export async function overwriteInstructions(
  io: InstructionsIo,
  agent: AgentProfileAgentId,
  text: string
): Promise<ProfileMutationResponse> {
  const fresh = await io.read(agent);
  return io.write(agent, { text, revision: fresh.info.revision });
}

/** The file's own name, from its path ("CLAUDE.md"). */
export function instructionsFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

export function legacyFileName(info: ProfileInstructionsInfo): string | null {
  return info.legacyPath ? instructionsFileName(info.legacyPath) : null;
}

/** "42 lines · 1.2 KB" — or "New file" when it does not exist yet. */
export function instructionsSummary(text: string, exists: boolean): string {
  if (!exists && text.length === 0) return "New file";
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  const bytes = new TextEncoder().encode(text).length;
  const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  return `${lines} ${lines === 1 ? "line" : "lines"} · ${size}`;
}
