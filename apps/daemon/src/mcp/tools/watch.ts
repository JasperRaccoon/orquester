import { z } from "zod";
import type { SessionSummary } from "@orquester/api";
import { resolveProject } from "../addressing.ts";
import { ToolError } from "../errors.ts";
import { findSession } from "../reads.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";
import { buildViewContext, sessionView } from "../views.ts";
import { waitForAttention, type WatchScope } from "../wait.ts";

const instant = (stamp: string | null | undefined): number => Date.parse(stamp ?? "");
const createdAt = (s: SessionSummary): number => { const t = instant(s.createdAt); return Number.isNaN(t) ? 0 : t; };
/** When a session called for attention; one with no parseable stamp counts from its tab's creation, as the GUI's `flaggedAt`. */
const flaggedAt = (s: SessionSummary): number => { const t = instant(s.activity?.needsAttentionAt); return Number.isNaN(t) ? createdAt(s) : t; };

/**
 * THE Attention Center order, for every tool that lists flagged sessions (wait_for_session, list_sessions
 * `attention: true`): newest attention first, by the instant — never by the string, which puts an offset stamp out of
 * place — and a tie to the newer tab.
 */
export function byAttention(a: SessionSummary, b: SessionSummary): number {
  return flaggedAt(b) - flaggedAt(a) || createdAt(b) - createdAt(a);
}

const waitForSession = defineTool({
  name: "wait_for_session",
  title: "Wait for a session to need you",
  description: "Block until a session (or any session of a project, or any at all) needs attention — a question, an approval, a plan to review, a finished turn, an error — after `after`. Pass the returned `cursor` as the next call's `after` so nothing is missed or repeated. Never poll: call this instead.",
  input: {
    sessionId: z.string().min(1).optional().describe("Watch one session."),
    project: z.string().optional().describe("Watch every session of this project (path or \"workspace/project\")."),
    after: z.string().optional().describe("ISO timestamp; only attention raised after it counts. Default: now. Use the previous result's cursor."),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000).describe("How long to wait (ms, max 600000).")
  },
  annotations: READ_ONLY,
  async run(args, { api, signal, now }) {
    if (args.sessionId !== undefined && args.project !== undefined) throw new ToolError("INVALID_ARGUMENT", "Pass sessionId or project, not both.");
    // Before any await, so a bare call waits for what happens after the call itself.
    const after = args.after ?? new Date(now()).toISOString();
    if (Number.isNaN(Date.parse(after))) throw new ToolError("INVALID_ARGUMENT", "`after` must be an ISO-8601 timestamp.");
    // One session: its close ends the wait (SESSION_NOT_FOUND). A wider wait just stops watching a closed one.
    let scope: WatchScope = { select: () => true };
    if (args.sessionId !== undefined) scope = { sessionId: (await findSession(api, args.sessionId)).id };
    else if (args.project !== undefined) { const path = (await resolveProject(api, args.project)).path; scope = { select: (s) => s.projectPath === path }; }
    const r = await waitForAttention(api, { ...scope, after, timeoutMs: args.timeoutMs, signal, now });
    if (r.sessions.length === 0) return { sessions: [], cursor: r.cursor, timedOut: r.timedOut };
    const ctx = await buildViewContext(api);
    // Newest attention first, as the Attention Center lists its flagged rows (attentionQualifies guarantees each a stamp).
    const sessions = [...r.sessions].sort(byAttention).map((s) => sessionView(s, ctx));
    return { sessions, cursor: r.cursor, timedOut: r.timedOut };
  }
});

export const watchTools: ToolDef[] = [waitForSession] as ToolDef[];
