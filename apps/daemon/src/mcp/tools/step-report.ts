// Catalog family module `step-report` (report_step_result) — spec 2026-11-10 §5.2, §8.
//
// Chat audience only. Every chat sees it (there is no per-chat tool switch), but it succeeds only
// for the current session of a running pass of an agent block that declared outcomes/outputs: the
// daemon finds that pass from the calling chat (the request's agent principal), never from an
// argument. Act tier with nothing for the gate to classify, so it never opens a card — a
// workflow-owned chat has no Admin tier at all.
import { z } from "zod";
import { WORKFLOW_LIMITS, workflowRoutes, type ReportWorkflowStepResponse } from "@orquester/api";
import { defineTool, MUTATING, type AnyOrquesterTool } from "../catalog/contract.ts";
import { ToolError } from "../errors.ts";
import { expectWorkflowOk } from "./workflow-preview.ts";

/** What the agent reads back on success (§5.2): the tool does not end the turn itself. */
export const STEP_REPORT_RECORDED = "Recorded. End your turn now.";

const reportStepResult = defineTool({
  name: "report_step_result",
  title: "Report a workflow step's result",
  description:
    "A workflow step's result, when its prompt asks for it, as your last action. A wrong call is refused with what is allowed: call again to fix it.",
  chatNote: "Then end your turn.",
  input: {
    outcome: z.string().max(40).optional().describe("One of the step's outcome ids."),
    summary: z.string().max(WORKFLOW_LIMITS.reportSummaryChars).describe("What you did and found."),
    outputs: z.record(z.string(), z.unknown()).optional().describe("The step's declared outputs.")
  },
  audiences: ["chat"],
  toolset: "chat-extras",
  tier: "act",
  // No project, session or turn: nothing for the gate to card (never an approval card, §5.2).
  scope: async () => ({ projects: [], sessions: [], reads: "none", writes: true, causesTurnIn: [] }),
  annotations: { ...MUTATING, idempotentHint: true, openWorldHint: false },
  resultKind: "text",
  async run(args, { api, caller }) {
    if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", "report_step_result is a chat tool.");
    const body = {
      ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
      summary: args.summary,
      ...(args.outputs !== undefined ? { outputs: args.outputs } : {})
    };
    // The executor binds the caller's agent principal: the route finds the step from it.
    expectWorkflowOk<ReportWorkflowStepResponse>(await api.request("POST", workflowRoutes.stepReport, { body }));
    return { content: [{ type: "text", text: STEP_REPORT_RECORDED }] };
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const stepReportFamily: readonly AnyOrquesterTool[] = [reportStepResult];
