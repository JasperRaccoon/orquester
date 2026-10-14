/**
 * Session tools — the `secrets` toolkit: `request_secret` (design
 * `2026-10-14-agent-visuals-and-session-tools-design.md` §5 "Secrets").
 *
 * Adapted from T3 Code (MIT): `apps/server/src/mcp/toolkits/orchestrator/tools.ts`
 * (`request_secret`) and `apps/server/src/secrets/SecretRequests.ts`.
 *
 * Where the value goes — and how this differs from T3. T3 never hands the
 * value to the agent: it stores it under a one-use `secretRef` that only
 * T3's own tools accept (a webhook task's signature). Orquester has no tool
 * that consumes such a reference, and the spec asks for the value to reach
 * the requesting agent, so the safest design that still lets the agent use
 * it is:
 *
 * - the daemon keeps the typed value in memory only, in the waiting call
 *   (`agent-chat/secret-requests.ts`), and hands it to THAT call once — no
 *   file, no env, no log, no other API response;
 * - the result carries it as `value`, beside a `secretRequest` record (name,
 *   purpose, outcome); the definition's `secretResultKeys` makes the agent
 *   host remember it for the thread and mask it in everything it persists,
 *   and the `secretRequest` shape lets ingestion strip it structurally too
 *   (`@orquester/api` `secret-requests.ts`). The persisted row keeps the
 *   record only.
 *
 * What Orquester cannot reach: the provider's own transcript (Claude's
 * session file, Codex's rollout, Grok's session dir, OpenCode's store, all in
 * the thread's account home) and the model provider's API keep the result as
 * the agent saw it. The description below tells the agent to use the value
 * without repeating it.
 */

import { z } from "zod";
import {
  SECRET_REQUEST_NAME_MAX_CHARS,
  SECRET_REQUEST_PROMPT_MAX_CHARS,
  SECRET_REQUEST_PURPOSE_MAX_CHARS,
  SECRET_REQUEST_RESULT_KEY,
  SECRET_REQUEST_TOOL_NAME,
  SECRET_REQUEST_VALUE_KEY,
  type SecretRequestRecord
} from "@orquester/api/agent-chat";

import { defineSessionTool, defineSessionToolkit } from "../contract.ts";
import { jsonResult, ToolError } from "../results.ts";

/** What the agent is told once the user answered (or did not). */
const NOTES = {
  provided:
    "The user provided the value. Use it only where it is needed (an env var for one command, the config file the user asked for); never print, echo, log or commit it, and never repeat it in chat.",
  declined: "The user declined. Do not ask again unless the user asks you to; continue without it or explain what is blocked.",
  cancelled: "The request ended before the user answered (the turn was stopped or the session ended).",
  timed_out: "The user did not answer within 10 minutes; the card is closed. Ask again only if it is still needed."
} as const;

export const secretsToolkit = defineSessionToolkit({
  id: "secrets",
  instructions:
    "Never ask for a secret (API key, token, password) in chat: call `request_secret`, which asks the user privately. Use the value only where needed; never print, echo or commit it.",
  tools: [
    defineSessionTool({
      name: SECRET_REQUEST_TOOL_NAME,
      title: "Request a secret",
      description:
        "Ask the user for a secret — an API key, token, password or signing secret — through a private card in this chat thread, and wait (up to 10 minutes) for the answer. The user types the value into the card; it is never shown in the chat, and Orquester keeps it out of the thread's saved history. When the user provides it, the result's `value` is the secret: use it directly where it is needed (e.g. as an environment variable for one command, or written into the file the user asked for), and never print, echo, log or commit it, or repeat it in a message. `outcome` is `provided`, `declined` (the user chose not to; do not ask again unprompted), `cancelled` (the turn or session ended) or `timed_out` (no answer in 10 minutes; ask again only if still needed). Never ask for a secret in chat and never invent one.",
      input: {
        name: z
          .string()
          .trim()
          .min(1)
          .max(SECRET_REQUEST_NAME_MAX_CHARS)
          .describe("What you need, short — the card's title, e.g. `GITHUB_TOKEN` or `Stripe test key`."),
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(SECRET_REQUEST_PROMPT_MAX_CHARS)
          .describe("One or two sentences to the user: what to enter and where they can find or create it."),
        purpose: z
          .string()
          .trim()
          .max(SECRET_REQUEST_PURPOSE_MAX_CHARS)
          .optional()
          .describe("What you will use it for, e.g. `Push the release tag to GitHub`.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      resultKind: "json",
      secretResultKeys: [SECRET_REQUEST_VALUE_KEY],
      run: async (args, ctx) => {
        if (ctx.secretRequests === undefined) {
          throw new ToolError("UNAVAILABLE", "Secret requests are not available here.");
        }
        const purpose = args.purpose !== undefined && args.purpose.length > 0 ? args.purpose : undefined;
        const answer = await ctx.secretRequests.request(
          ctx.threadId,
          { name: args.name, prompt: args.prompt, ...(purpose !== undefined ? { purpose } : {}) },
          ctx.signal
        );
        const record: SecretRequestRecord = {
          name: args.name,
          ...(purpose !== undefined ? { purpose } : {}),
          outcome: answer.outcome
        };
        if (answer.outcome === "provided") {
          return jsonResult({
            [SECRET_REQUEST_RESULT_KEY]: record,
            [SECRET_REQUEST_VALUE_KEY]: answer.value,
            note: NOTES.provided
          });
        }
        return jsonResult({ [SECRET_REQUEST_RESULT_KEY]: record, note: NOTES[answer.outcome] });
      }
    })
  ]
});
