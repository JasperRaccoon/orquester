/**
 * A case's `priorTurns` as a Claude Code session transcript, so a sample resumes a chat the model
 * reads as its own: its earlier text, tool calls and their results, in the CLI's own format. The
 * file goes where the CLI looks for it — `<config dir>/projects/<cwd slug>/<session id>.jsonl` —
 * and the run removes that project dir afterwards.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { PriorTurn } from "./case.ts";

/** Claude Code's project dir name for a cwd: every character but [A-Za-z0-9] becomes `-`. */
export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export const claudeTranscriptPath = (configDir: string, cwd: string, sessionId: string): string =>
  join(configDir, "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`);

/** How a case names a tool → how Claude names it: Orquester tools gain their server prefix. */
export const claudeToolName = (tool: string, orquesterTools: ReadonlySet<string>): string =>
  orquesterTools.has(tool) ? `mcp__orquester__${tool}` : tool;

const resultText = (result: unknown): string => (typeof result === "string" ? result : JSON.stringify(result));

export interface TranscriptInput {
  turns: readonly PriorTurn[];
  sessionId: string;
  cwd: string;
  model: string;
  version: string;
  orquesterTools: ReadonlySet<string>;
  /** Start of the fake history; each line is a second later. */
  start?: Date;
}

/** The transcript's lines (one JSON object each), parent-linked in order. */
export function buildTranscript(input: TranscriptInput): string[] {
  const lines: string[] = [];
  let parentUuid: string | null = null;
  let clock = (input.start ?? new Date(Date.now() - 3_600_000)).getTime();
  const base = { isSidechain: false, userType: "external", cwd: input.cwd, sessionId: input.sessionId, version: input.version };
  const push = (entry: Record<string, unknown>) => {
    const uuid = randomUUID();
    lines.push(JSON.stringify({ ...base, ...entry, parentUuid, uuid, timestamp: new Date(clock).toISOString() }));
    parentUuid = uuid;
    clock += 1_000;
  };
  for (const turn of input.turns) {
    if ("user" in turn) {
      push({ type: "user", message: { role: "user", content: turn.user } });
      continue;
    }
    const uses = turn.calls.map((call) => ({ id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`, call }));
    const content = [
      ...(turn.assistant.length > 0 ? [{ type: "text", text: turn.assistant }] : []),
      ...uses.map(({ id, call }) => ({ type: "tool_use", id, name: claudeToolName(call.tool, input.orquesterTools), input: call.input }))
    ];
    push({
      type: "assistant",
      message: {
        id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "message",
        role: "assistant",
        model: input.model,
        content,
        stop_reason: uses.length > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
    for (const { id, call } of uses) {
      push({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: resultText(call.result), ...(call.isError === true ? { is_error: true } : {}) }] }
      });
    }
  }
  return lines;
}
