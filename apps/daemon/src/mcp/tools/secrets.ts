/**
 * Catalog family `secrets` (unified MCP design 2026-10-15 §4 row 44, §12.5): `request_secret`,
 * chat-only, in the locked `core` toolset. Ported from the session toolkit `session-tools/secrets/`
 * (design 2026-10-14 §5 "Secrets"; adapted from T3 Code, MIT) with behaviour unchanged and the
 * description trimmed to the §9.5 target.
 *
 * Where the value goes:
 * - the daemon keeps the typed value in memory only, in the waiting call
 *   (`agent-chat/secret-requests.ts`, reached through `ctx.secretRequests`), and hands it to THAT
 *   call once — no file, no env, no log, no other API response;
 * - the result carries it as `value`, beside a `secretRequest` record (name, purpose, outcome);
 *   `secretResultKeys` makes the agent host remember it for the thread and mask it in everything
 *   it persists, and the `secretRequest` shape lets ingestion strip it structurally too
 *   (`@orquester/api` `secret-requests.ts`). The persisted row keeps the record only.
 *
 * What Orquester cannot reach: the provider's own transcript (in the thread's account home) and
 * the model provider's API keep the result as the agent saw it. The description tells the agent to
 * use the value without repeating it.
 */

import { z } from "zod";
import {
  SECRET_REQUEST_NAME_MAX_CHARS,
  SECRET_REQUEST_PROMPT_MAX_CHARS,
  SECRET_REQUEST_PURPOSE_MAX_CHARS,
  SECRET_REQUEST_RESULT_KEY,
  SECRET_REQUEST_TIMEOUT_MS,
  SECRET_REQUEST_TOOL_NAME,
  SECRET_REQUEST_VALUE_KEY,
  type SecretRequestRecord
} from "@orquester/api/agent-chat";

import { defineTool, type AnyOrquesterTool } from "../catalog/contract.ts";
import { ToolError } from "../errors.ts";

/** "10 minutes": the wait, in the words the agent reads. */
const WAIT = `${SECRET_REQUEST_TIMEOUT_MS / 60_000} minutes`;

/** What the agent is told once the user answered (or did not). */
export const SECRET_REQUEST_NOTES = {
  provided:
    "The user provided the value. Use it only where it is needed (an env var for one command, the config file the user asked for); never print, echo, log or commit it, and never repeat it in chat.",
  declined: "The user declined; nothing was received. Do not ask again unless the user asks you to; continue without it or explain what is blocked.",
  cancelled:
    "The request ended before the user answered (the turn was stopped, the session ended, or this call was cancelled); nothing was received.",
  timed_out: `No answer within ${WAIT}: the card was closed and nothing was received. Tell the user what this blocks; call ${SECRET_REQUEST_TOOL_NAME} again only if they still want to provide it.`
} as const;

export const secretsFamily: readonly AnyOrquesterTool[] = [
  defineTool({
    name: SECRET_REQUEST_TOOL_NAME,
    title: "Request a secret",
    description: `Ask the user for a secret (API key, token, password, signing secret) through a private card in this chat, and wait up to ${WAIT} for the answer (Orquester's own deadline; the call ends with an outcome, not a transport error). The value is never shown in the chat and is kept out of its saved history. When provided, the result's \`value\` is the secret: use it directly where needed (an env var for one command, the file the user asked for); never print, echo, log or commit it, or repeat it in a message. \`secretRequest.outcome\`: \`provided\`, \`declined\` (don't ask again unprompted), \`cancelled\` (the turn or session ended) or \`timed_out\` (ask again only if still needed). Never ask for a secret in chat and never invent one.`,
    input: {
      name: z
        .string()
        .trim()
        .min(1)
        .max(SECRET_REQUEST_NAME_MAX_CHARS)
        .describe("The card's short title, e.g. `GITHUB_TOKEN`."),
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(SECRET_REQUEST_PROMPT_MAX_CHARS)
        .describe("To the user: what to enter and where to find or create it."),
      purpose: z
        .string()
        .trim()
        .max(SECRET_REQUEST_PURPOSE_MAX_CHARS)
        .optional()
        .describe("What you will use it for.")
    },
    audiences: ["chat"],
    toolset: "core",
    tier: "act",
    // Asking for a credential is part of planning work that needs one (§4 row 44).
    planSafe: true,
    // It changes nothing Orquester keeps: the card and the value live only as long as this call.
    scope: async (_args, ctx) => ({
      projects: [],
      sessions: ctx.caller.kind === "thread" ? [ctx.caller.threadId] : [],
      self: "allow",
      reads: "none",
      writes: false,
      causesTurnIn: []
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    resultKind: "json",
    secretResultKeys: [SECRET_REQUEST_VALUE_KEY],
    run: async (args, ctx) => {
      const caller = ctx.caller;
      if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", `${SECRET_REQUEST_TOOL_NAME} is a chat tool.`);
      if (ctx.secretRequests === undefined) throw new ToolError("UNAVAILABLE", "Secret requests are not available here.");
      const purpose = args.purpose !== undefined && args.purpose.length > 0 ? args.purpose : undefined;
      const answer = await ctx.secretRequests.request(
        caller.threadId,
        { name: args.name, prompt: args.prompt, ...(purpose !== undefined ? { purpose } : {}) },
        ctx.signal,
        caller.delivered
      );
      const record: SecretRequestRecord = { name: args.name, ...(purpose !== undefined ? { purpose } : {}), outcome: answer.outcome };
      if (answer.outcome === "provided") {
        return { [SECRET_REQUEST_RESULT_KEY]: record, [SECRET_REQUEST_VALUE_KEY]: answer.value, note: SECRET_REQUEST_NOTES.provided };
      }
      return { [SECRET_REQUEST_RESULT_KEY]: record, note: SECRET_REQUEST_NOTES[answer.outcome] };
    }
  })
];
