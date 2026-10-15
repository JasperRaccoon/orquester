// Catalog family module `notify` (notify_user) — plan Task 9 (unified MCP design 2026-10-15 §4 row 19, §4.1, §5.6).
import { z } from "zod";
import { PUSH_NOTIFY_BODY_MAX_CHARS, PUSH_NOTIFY_TITLE_MAX_CHARS, type PushNotifyResponse } from "@orquester/api";
import { defineTool, MUTATING, type AnyOrquesterTool } from "../catalog/contract.ts";
import { daemonError } from "../errors.ts";

const notifyUser = defineTool({
  name: "notify_user",
  title: "Notify the user",
  description: "A Web Push to the user's devices, for what they must see while away (done, blocked); never progress. `sent`: devices reached.",
  chatNote: "Opens this chat; one per 5 min.",
  externalNote: "One per minute.",
  input: {
    title: z.string().trim().min(1).max(PUSH_NOTIFY_TITLE_MAX_CHARS),
    body: z.string().trim().min(1).max(PUSH_NOTIFY_BODY_MAX_CHARS).optional()
  },
  audiences: ["external", "chat"],
  toolset: "chat-extras",
  tier: "act",
  // A push changes no Orquester state and works while planning; the daemon keys its rate limit on the caller.
  planSafe: true,
  scope: async () => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }),
  annotations: MUTATING,
  resultKind: "json",
  async run(args, { api, caller }) {
    // A chat's push deep-links to that chat; the route forces it from the principal anyway.
    const res = await api.request("POST", "/api/push/notify", { body: { title: args.title, ...(args.body ? { body: args.body } : {}), ...(caller.kind === "thread" ? { sessionId: caller.threadId } : {}) } });
    if (res.status >= 400) throw daemonError(res);
    return { sent: (res.body as PushNotifyResponse).sent };
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const notifyFamily: readonly AnyOrquesterTool[] = [notifyUser];
