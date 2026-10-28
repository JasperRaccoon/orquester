/**
 * Knowledge Graph linking — the managed, hidden "Knowledge indexer" Agent Profile every worker
 * chat launches with (spec "Indexing on the subscription"), and the worker's first message.
 *
 * The profile has no items (no skills, no MCP servers beyond Orquester's own, no hooks, no
 * commands, no plugins), hides the built-in skills of every agent, turns the Workflow tool off and
 * — Claude only, `claudeBuiltinTools: false` — starts Claude Code with NO built-in tools (SDK
 * `tools: []`): the chat can only call MCP tools, of which it needs the two worker tools. Its
 * short instruction text is the worker protocol; it rides the system prompt, so it is prompt-cached
 * and paid once per chat. A profile chat also drops the account's user CLAUDE.md, and the chat's
 * cwd is the plugin's empty workers dir, so no project instructions load either.
 *
 * `ensureKnowledgeIndexerProfile` is idempotent (`SessionProfileService.ensureManaged`): call it
 * when the plugin is enabled and before each run; an unchanged profile is not rewritten.
 */

import type { ManagedProfileSpec } from "../../session-profiles/store.ts";

export const KNOWLEDGE_INDEXER_PROFILE_ID = "orquester-knowledge-indexer";
export const KNOWLEDGE_INDEXER_MANAGED = "knowledge-indexer";

export const KNOWLEDGE_WORKER_NEXT_TOOL = "knowledge_worker_next_task";
export const KNOWLEDGE_WORKER_SUBMIT_TOOL = "knowledge_worker_submit";

const KNOWLEDGE_INDEXER_INSTRUCTIONS = `You are a Knowledge Graph indexing worker. You answer extraction tasks, one after another, and nothing else.

Protocol:
1. Call ${KNOWLEDGE_WORKER_NEXT_TOOL}.
2. When it returns a task, do exactly what the task's instructions say to its input. When "instructions" is null, the instructions are the ones you received with the task named in "sameInstructionsAs".
   A long task comes in parts ("This task is in N parts. Part 1 of N"): call ${KNOWLEDGE_WORKER_NEXT_TOOL} with {"taskId": "<its id>", "part": 2}, then part 3, and so on until you have all N parts. The parts follow on from each other; only then answer the whole task, once.
3. Call ${KNOWLEDGE_WORKER_SUBMIT_TOOL} with the taskId and, as the answer, ONLY the JSON the instructions ask for: no prose, no explanation, no code fence.
4. The submit result carries your next task: go back to step 2. If the answer is refused, fix it and submit the same task again.
5. When you are told "done", stop and end your turn with one short line.

Never use any other tool, never read or write files, never ask questions, and never add commentary between tasks.`;

/** The worker chat's one user message: the protocol itself is in the profile's instructions. */
export const KNOWLEDGE_WORKER_PROMPT = `Start: call ${KNOWLEDGE_WORKER_NEXT_TOOL} and work through the tasks until you are told "done".`;

export const KNOWLEDGE_INDEXER_PROFILE: ManagedProfileSpec = {
  id: KNOWLEDGE_INDEXER_PROFILE_ID,
  managed: KNOWLEDGE_INDEXER_MANAGED,
  name: "Knowledge indexer",
  description: "Orquester's Knowledge Graph indexing chats (managed; not editable).",
  settings: {
    hideBuiltinSkills: { claude: true, codex: true, grok: true, opencode: true },
    claudeWorkflowTool: false,
    claudeBuiltinTools: false
  },
  instructions: KNOWLEDGE_INDEXER_INSTRUCTIONS
};

/** What `ensureKnowledgeIndexerProfile` needs of the profile service. */
export interface ManagedProfiles {
  ensureManaged(spec: ManagedProfileSpec): Promise<{ profileId: string; revision: string; changed: boolean }>;
}

/** Creates or re-aligns the managed profile; answers its id. */
export async function ensureKnowledgeIndexerProfile(profiles: ManagedProfiles): Promise<string> {
  const { profileId } = await profiles.ensureManaged(KNOWLEDGE_INDEXER_PROFILE);
  return profileId;
}
