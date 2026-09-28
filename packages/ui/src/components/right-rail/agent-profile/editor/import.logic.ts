/**
 * The skill and command editor's other sources (agent profile spec §6):
 * Git URL and Upload scan into a checklist of candidates; Copy from agent
 * lists another agent's own items of the same kind.
 */

import {
  AGENT_PROFILE_AGENTS,
  PROFILE_COPYABLE_KINDS,
  type AgentProfileAgentId,
  type AgentProfileSnapshot,
  type ProfileImportCandidate,
  type ProfileItem,
  type ProfileItemKind
} from "@orquester/api";

export type MarkdownSource = "write" | "git" | "upload" | "copy";

export const MARKDOWN_SOURCES: readonly { id: MarkdownSource; label: string }[] = [
  { id: "write", label: "Write" },
  { id: "git", label: "Git URL" },
  { id: "upload", label: "Upload" },
  { id: "copy", label: "Copy from agent" }
];

/** What a new scan starts with ticked: every candidate that would not collide. */
export function defaultPicks(candidates: readonly ProfileImportCandidate[]): string[] {
  return candidates.filter((candidate) => !candidate.exists).map((candidate) => candidate.ref);
}

export function togglePick(picks: readonly string[], ref: string): string[] {
  return picks.includes(ref) ? picks.filter((entry) => entry !== ref) : [...picks, ref];
}

/** Picked candidates that already exist: importing them needs Replace or Keep both. */
export function pickedCollisions(candidates: readonly ProfileImportCandidate[], picks: readonly string[]): ProfileImportCandidate[] {
  return candidates.filter((candidate) => candidate.exists && picks.includes(candidate.ref));
}

/** Tick all, or untick all when every one is ticked. */
export function toggleAllPicks(candidates: readonly ProfileImportCandidate[], picks: readonly string[]): string[] {
  const all = candidates.map((candidate) => candidate.ref);
  return all.every((ref) => picks.includes(ref)) ? [] : all;
}

const GIT_URL = /^(https?|ssh|git):\/\/\S+$|^[\w.-]+@[\w.-]+:\S+$/;

export function gitUrlError(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === "") return "Enter a repository URL";
  if (!GIT_URL.test(trimmed)) return "Use an https://, ssh:// or git@host:path URL";
  return undefined;
}

export const UPLOAD_ACCEPT = ".zip,.md";

export function uploadFileError(name: string): string | undefined {
  return /\.(zip|md)$/i.test(name) ? undefined : "Choose a .zip or a .md file";
}

/** The agents "Copy from agent" can copy from: every other one. */
export function copySourceAgents(agent: AgentProfileAgentId): AgentProfileAgentId[] {
  return AGENT_PROFILE_AGENTS.filter((other) => other !== agent);
}

/** The other agent's own items of this kind — the only ones a copy takes. */
export function copyableItems(snapshot: AgentProfileSnapshot | null, kind: ProfileItemKind): ProfileItem[] {
  if (!snapshot || !PROFILE_COPYABLE_KINDS.includes(kind)) return [];
  return snapshot.items
    .filter((item) => item.kind === kind && item.source.type === "user")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The upload's progress as a whole percentage (0 while the size is unknown). */
export function uploadPercent(sent: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((sent / total) * 100)));
}
