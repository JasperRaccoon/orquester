/**
 * Claude adapter — a resumed thread's `Workflow` runs, read back from what the
 * CLI left on disk (spec §4.1 `readThread`, fixtures README observation 24).
 *
 * A resume replays nothing onto the stream, and the transcript holds only the
 * `Workflow` call and its launch text: the run's roster and its agents'
 * conversations live beside it — the run snapshot the CLI writes when the run
 * ends (`<session>/workflows/<runId>.json`) and the run's transcript
 * directory (`<session>/subagents/workflows/<runId>/`). This module reads
 * them into one {@link WorkflowHistoryRun} per call, which rides the turn's
 * items into `projectClaudeHistory`.
 *
 * The paths are rebuilt from the session's own transcript location, never
 * taken from the launch text: that names the home of the account that ran it,
 * which may be gone (a thread moved to another account).
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import * as nodePath from "node:path";

import type { RuntimeTaskStatus, TaskRunHandles, TaskWorkflowPhase } from "@orquester/api/agent-chat";

import {
  parseWorkflowProgress,
  workflowAgentPromptOf,
  workflowAgentStatus,
  type WorkflowAgentEntry
} from "./workflow.ts";

/** The `type` of the synthetic turn item that carries one run. */
export const WORKFLOW_HISTORY_ITEM_TYPE = "orquester.workflow_run";

/** Bounds on what one resume reads, so a huge fleet cannot stall the host. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_RUN_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/** One agent slot of a finished (or abandoned) run. */
interface WorkflowHistoryAgent {
  index: number;
  label: string;
  status: RuntimeTaskStatus;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  attempt?: number;
  prompt?: string;
  result?: string;
  error?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  /** The last attempt's `user`/`assistant` transcript records, in order. */
  records: unknown[];
}

export interface WorkflowHistoryRun {
  type: typeof WORKFLOW_HISTORY_ITEM_TYPE;
  taskId: string;
  toolUseId: string;
  workflowName?: string;
  description?: string;
  script?: string;
  runHandles: TaskRunHandles;
  status: "completed" | "failed" | "stopped";
  phases: TaskWorkflowPhase[];
  agents: WorkflowHistoryAgent[];
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
}

/** What the `Workflow` tool's result text says about its launch. */
interface WorkflowLaunchText {
  taskId: string;
  runId: string;
  summary?: string;
}

/**
 * The launch text the model reads — `Workflow launched in background. Task
 * ID: …\nSummary: …\nTranscript dir: …\nScript file: …\nRun ID: …` (fixture
 * 17). The transcript keeps this text; `getSessionMessages` drops the
 * structured `toolUseResult`.
 */
function parseWorkflowLaunchText(text: string): WorkflowLaunchText | undefined {
  if (!text.startsWith("Workflow launched")) {
    return undefined;
  }
  const field = (name: string): string | undefined =>
    new RegExp(`(?:^|\\s)${name}:[ \\t]*([^\\n]+)`).exec(text)?.[1]?.trim() || undefined;
  const taskId = field("Task ID");
  const runId = field("Run ID");
  if (taskId === undefined || runId === undefined || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    return undefined;
  }
  const summary = field("Summary");
  return { taskId, runId, ...(summary !== undefined ? { summary } : {}) };
}

async function readBounded(path: string, maxBytes: number, sessionDir: string, projectsDir: string): Promise<string | undefined> {
  try {
    const [projectsRoot, root, target] = await Promise.all([
      fs.realpath(projectsDir), fs.realpath(sessionDir), fs.realpath(path)
    ]);
    const isContained = (parent: string, child: string): boolean => {
      const relative = nodePath.relative(parent, child);
      return relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative);
    };
    if (!isContained(projectsRoot, root) || !isContained(root, target)) {
      return undefined;
    }
    // Read the verified target through one handle. O_NOFOLLOW rejects a final
    // component swapped for a link between realpath and open where supported.
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await fs.open(target, fsConstants.O_RDONLY | noFollow);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) {
        return undefined;
      }
      // A transcript can grow after fstat. Read at most one byte past the cap
      // from this handle so concurrent appends cannot allocate unbounded data.
      const chunks: Buffer[] = [];
      let length = 0;
      while (length <= maxBytes) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        length += bytesRead;
      }
      return length > maxBytes ? undefined : Buffer.concat(chunks, length).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function parseJsonLines(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn last line from a crash: the rest is still good.
    }
  }
  return records;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/**
 * The journal's view of a run the CLI never finished writing a snapshot for
 * (it crashed, or its session was killed): each agent that started, keyed by
 * its cache key — a retry keeps the key and gets a new id — with its label,
 * phase and whether it returned or failed.
 */
function agentsFromJournal(journal: unknown[]): WorkflowAgentEntry[] {
  const byKey = new Map<string, WorkflowAgentEntry>();
  const phaseIndex = new Map<string, number>();
  for (const value of journal) {
    const entry = asRecord(value);
    const key = asText(entry?.key);
    const agentId = asText(entry?.agentId);
    // It becomes a file name, as on the live path (`parseWorkflowProgress`).
    if (entry === undefined || key === undefined || agentId === undefined || !/^[A-Za-z0-9_-]+$/.test(agentId)) {
      continue;
    }
    if (entry.type === "started") {
      const previous = byKey.get(key);
      const phaseTitle = asText(entry.phase) ?? previous?.phaseTitle;
      if (phaseTitle !== undefined && !phaseIndex.has(phaseTitle)) {
        phaseIndex.set(phaseTitle, phaseIndex.size + 1);
      }
      byKey.set(key, {
        index: previous?.index ?? byKey.size + 1,
        label: asText(entry.label) ?? previous?.label ?? `agent ${byKey.size + 1}`,
        state: "progress",
        startedAt: 0,
        agentId,
        attempt: (previous?.attempt ?? 0) + 1,
        ...(phaseTitle !== undefined
          ? { phaseTitle, phaseIndex: phaseIndex.get(phaseTitle)! }
          : {})
      });
    } else if (entry.type === "result" || entry.type === "failed") {
      const known = byKey.get(key);
      if (known === undefined || known.agentId !== agentId) continue;
      known.state = entry.type === "result" ? "done" : "error";
      if (entry.type === "result") {
        const result = entry.result;
        const text = typeof result === "string" ? result : JSON.stringify(result);
        if (text !== undefined) known.resultPreview = text.slice(0, 2000);
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Read one run. `sessionDir` is `<projects>/<project>/<sessionId>`; neither the
 * session nor anything read beneath it may resolve outside `projectsDir`.
 * A run with neither a snapshot nor a journal yields
 * only its coordinator.
 */
export async function readWorkflowHistoryRun(input: {
  projectsDir: string;
  sessionDir: string;
  toolUseId: string;
  launch: WorkflowLaunchText;
}): Promise<WorkflowHistoryRun> {
  const { sessionDir, launch } = input;
  const transcriptDir = nodePath.join(sessionDir, "subagents", "workflows", launch.runId);
  const snapshotText = await readBounded(
    nodePath.join(sessionDir, "workflows", `${launch.runId}.json`),
    MAX_SNAPSHOT_BYTES,
    sessionDir,
    input.projectsDir
  );
  let snapshot: Record<string, unknown> | undefined;
  try {
    snapshot = snapshotText !== undefined ? asRecord(JSON.parse(snapshotText)) : undefined;
  } catch {
    snapshot = undefined;
  }
  // The CLI writes the snapshot of one run; a resumed run reuses the id, so
  // only a snapshot of THIS launch's task describes it.
  if (snapshot !== undefined && asText(snapshot.taskId) !== undefined && snapshot.taskId !== launch.taskId) {
    snapshot = undefined;
  }

  const progress = snapshot !== undefined ? parseWorkflowProgress({ workflow_progress: snapshot.workflowProgress }) : undefined;
  let entries = progress?.agents ?? [];
  let phases = progress?.phases ?? [];
  if (entries.length === 0) {
    const journal = await readBounded(nodePath.join(transcriptDir, "journal.jsonl"), MAX_SNAPSHOT_BYTES, sessionDir, input.projectsDir);
    entries = journal !== undefined ? agentsFromJournal(parseJsonLines(journal)) : [];
    const titles = new Map<number, string>();
    for (const entry of entries) {
      if (entry.phaseIndex !== undefined && entry.phaseTitle !== undefined) {
        titles.set(entry.phaseIndex, entry.phaseTitle);
      }
    }
    phases = [...titles.entries()].map(([index, title]) => ({ index, title })).sort((a, b) => a.index - b.index);
  }

  const status = snapshot?.status === "completed" ? "completed" : snapshot?.status === "failed" ? "failed" : "stopped";
  let budget = MAX_RUN_TRANSCRIPT_BYTES;
  const agents: WorkflowHistoryAgent[] = [];
  for (const entry of entries) {
    let records: unknown[] = [];
    if (entry.agentId !== undefined && budget > 0) {
      const text = await readBounded(
        nodePath.join(transcriptDir, `agent-${entry.agentId}.jsonl`),
        Math.min(MAX_AGENT_TRANSCRIPT_BYTES, budget),
        sessionDir,
        input.projectsDir
      );
      if (text !== undefined) {
        budget -= Buffer.byteLength(text);
        records = parseJsonLines(text).filter((record) => {
          const type = asRecord(record)?.type;
          return type === "user" || type === "assistant";
        });
      }
    }
    const prompt = records.length > 0 ? workflowAgentPromptOf(records[0]) : undefined;
    let agentStatus = workflowAgentStatus(entry);
    // Nothing runs after its run: an agent the run left open ended with it.
    if (agentStatus === "running" || agentStatus === "pending") {
      agentStatus = status === "completed" ? "completed" : "interrupted";
    }
    agents.push({
      index: entry.index,
      label: entry.label,
      status: agentStatus,
      ...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
      ...(entry.phaseTitle !== undefined ? { phaseTitle: entry.phaseTitle } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
      ...((prompt ?? entry.promptPreview) !== undefined ? { prompt: prompt ?? entry.promptPreview } : {}),
      ...(entry.resultPreview !== undefined ? { result: entry.resultPreview } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(entry.tokens !== undefined ? { tokens: entry.tokens } : {}),
      ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      records
    });
  }

  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  const workflowName = asText(snapshot?.workflowName);
  const description = asText(snapshot?.summary) ?? launch.summary;
  const script = asText(snapshot?.script);
  const tokens = count(snapshot?.totalTokens);
  const toolCalls = count(snapshot?.totalToolCalls);
  const durationMs = count(snapshot?.durationMs);
  return {
    type: WORKFLOW_HISTORY_ITEM_TYPE,
    taskId: launch.taskId,
    toolUseId: input.toolUseId,
    ...(workflowName !== undefined ? { workflowName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(script !== undefined ? { script } : {}),
    runHandles: { runId: launch.runId, transcriptDir },
    status,
    phases,
    agents,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(durationMs !== undefined ? { durationMs } : {})
  };
}

/**
 * Every `Workflow` launch in a resumed session's messages, as the call id and
 * its launch text — the tool's `tool_use` names it, its `tool_result` text
 * says which run it started.
 */
export function workflowLaunchesIn(
  messages: readonly unknown[]
): Array<{ toolUseId: string; launch: WorkflowLaunchText }> {
  const calls = new Set<string>();
  const launches: Array<{ toolUseId: string; launch: WorkflowLaunchText }> = [];
  for (const value of messages) {
    const content = asRecord(asRecord(value)?.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const blockValue of content) {
      const block = asRecord(blockValue);
      if (block?.type === "tool_use" && block.name === "Workflow" && typeof block.id === "string") {
        calls.add(block.id);
      } else if (
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        calls.has(block.tool_use_id) &&
        block.is_error !== true
      ) {
        const text =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((part) => (asRecord(part)?.type === "text" ? String(asRecord(part)?.text ?? "") : ""))
                  .join("")
              : "";
        const launch = parseWorkflowLaunchText(text);
        if (launch !== undefined) launches.push({ toolUseId: block.tool_use_id, launch });
      }
    }
  }
  return launches;
}
