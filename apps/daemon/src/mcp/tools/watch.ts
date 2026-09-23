import { z } from "zod";
import type { SessionSummary } from "@orquester/api";
import { resolveProject } from "../addressing.ts";
import { ToolError } from "../errors.ts";
import { findSession } from "../reads.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";
import { buildViewContext, sessionView } from "../views.ts";
import { waitForAttention } from "../wait.ts";

const waitForSession = defineTool({
  name: "wait_for_session",
  title: "Wait for a session to need you",
  description: "Block until a session (or any session of a project, or any at all) needs attention — a question, an approval, a plan to review, a finished turn, an error — after `after`. Pass the returned `cursor` as the next call's `after` so nothing is missed or repeated. Never poll: call this instead.",
  input: {
    sessionId: z.string().optional().describe("Watch one session."),
    project: z.string().optional().describe("Watch every session of this project (path or \"workspace/project\")."),
    after: z.string().optional().describe("ISO timestamp; only attention raised after it counts. Default: now. Use the previous result's cursor."),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000).describe("How long to wait (ms, max 600000).")
  },
  annotations: READ_ONLY,
  async run(args, { api, signal, now }) {
    if (args.sessionId && args.project) throw new ToolError("INVALID_ARGUMENT", "Pass sessionId or project, not both.");
    let select: (s: SessionSummary) => boolean = () => true;
    if (args.sessionId) { const id = (await findSession(api, args.sessionId)).id; select = (s) => s.id === id; }
    else if (args.project) { const path = (await resolveProject(api, args.project)).path; select = (s) => s.projectPath === path; }
    const after = args.after ?? new Date(now()).toISOString();
    if (Number.isNaN(Date.parse(after))) throw new ToolError("INVALID_ARGUMENT", "`after` must be an ISO-8601 timestamp.");
    const r = await waitForAttention(api, { select, after, timeoutMs: args.timeoutMs, signal, now });
    const ctx = await buildViewContext(api);
    const stamp = (s: SessionSummary) => s.activity?.needsAttentionAt ?? s.createdAt;
    const sessions = [...r.sessions].sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : a.createdAt < b.createdAt ? 1 : -1)).map((s) => sessionView(s, ctx));
    return { sessions, cursor: r.cursor, timedOut: r.timedOut };
  }
});

export const watchTools: ToolDef[] = [waitForSession] as ToolDef[];
