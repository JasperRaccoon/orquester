// Automated workflows — the Wait block (spec §4): a duration, or the next HH:MM in a time zone; at
// most 7 days. Resumable through the `timer` WaitingOn: a restart re-arms at the same wall-clock
// instant. The output is the input, passed through.

import { nextScheduleRun, WORKFLOW_LIMITS } from "@orquester/api";

import type { NodeExecutor, NodeResult } from "../contracts.ts";
import { sleepUntil } from "../run-context.ts";

export function createWaitExecutor(): NodeExecutor<"wait"> {
  return {
    type: "wait",
    async execute(ctx): Promise<NodeResult> {
      const clock = ctx.services.clock;
      const now = clock.now();
      let until: Date;
      if (ctx.resumeFrom?.kind === "timer") {
        until = new Date(ctx.resumeFrom.until);
      } else {
        const config = ctx.node.config;
        const maxMs = WORKFLOW_LIMITS.waitMaxMinutes * 60_000;
        if (config.kind === "duration") {
          until = new Date(now.getTime() + Math.min(Math.max(0, config.minutes) * 60_000, maxMs));
        } else {
          const [hh, mm] = config.time.split(":").map((part) => Number(part));
          const timeZone = config.timezone ?? ctx.workflow.settings.timezone ?? "UTC";
          const next = nextScheduleRun(`${mm} ${hh} * * *`, timeZone, now);
          if (next === null) {
            return { status: "failed", error: { kind: "validation", message: `Cannot compute the next ${config.time} in ${timeZone}.` } };
          }
          until = new Date(next);
        }
        await ctx.setWaitingOn({ kind: "timer", until: until.toISOString(), purpose: "wait" });
      }
      ctx.update({ waitingUntil: until.toISOString() });
      const reached = await sleepUntil(clock, until, ctx.signal);
      if (!reached) return { status: "cancelled" };
      await ctx.setWaitingOn(undefined);
      return { status: "succeeded", output: ctx.expressionContext().input ?? null };
    }
  };
}
