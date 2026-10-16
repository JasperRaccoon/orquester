/**
 * Legacy chat-tool aliases (unified MCP design 2026-10-15 §14.1, D-9): an agent host that booted
 * before the unified catalog still advertises the 16 old session-tool names, and its chats call
 * them until its drain-restart. Once the catalog no longer serves such a name, the daemon maps the
 * call onto the tool that replaced it — with the OLD semantics:
 *
 * - `thread_send` without `wait` → `send_message {reply: "none"}` (a working target is steered, as
 *   before); with `wait` → `send_message {reply: "wait"}` and `ctx.legacyAlias`, which tells
 *   `send_message` to skip the queue rule's notify conversion (a timeout just returns);
 * - `thread_create` → `create_session {reply: "none"}`; `delegate_task` → `create_session
 *   {delegate: true, reply: "none"}` (the old tool never delivered results);
 * - `task_status` → `get_session`; `thread_wait` / `task_wait` → `wait_for_session`;
 *   `thread_interrupt` / `task_cancel` → `control_session {action: "interrupt"}`;
 * - `thread_list` → `list_sessions`, `thread_read` → `read_transcript`, `thread_fork` →
 *   `fork_session`, `thread_merge_back` → `merge_back_session`, `agent_catalog` → `list_agents`
 *   (its chat view).
 *
 * A name the catalog still serves is never aliased (the catalog's own tool answers it), and an
 * alias whose target the catalog does not serve yet is no alias: the name is then unknown. The
 * input shapes below are a frozen copy of the old tools' FIELD NAMES — the target's own schema
 * validates the mapped arguments, so its refusal text is the one every caller meets.
 *
 * Removed with the frozen legacy host definitions by the criterion in `./README.md` ("Legacy names and
 * definitions").
 * Daemon-only: the route (`./route.ts`) resolves names through {@link chatToolByName}.
 */

import { z } from "zod";

import type { AnyOrquesterTool, CallContext, ScopeClaim, ScopeContext, Tier } from "../mcp/catalog/contract.ts";
import { toolByName } from "../mcp/catalog/index.ts";
import { ToolError } from "../mcp/errors.ts";
import { audienceSchema } from "../mcp/executor.ts";
import { argumentProblems } from "../mcp/result.ts";

type Args = Record<string, unknown>;

/** One legacy name: the tool that replaced it, its old input fields, and the mapping. */
export interface LegacyChatToolAlias {
  /** The catalog tool that replaced it. */
  target: string;
  /** The old tool's input fields (loose: the target's schema validates the mapped call). */
  input: z.ZodRawShape;
  map(args: Args): Args;
  /** Set `ctx.legacyAlias` on the target's call (old semantics no argument can carry). */
  legacySemantics?: (args: Args) => boolean;
}

const id = z.string();
const text = z.string();
const seconds = z.number().optional();
const settings = {
  agent: z.string().optional(),
  model: z.string().optional(),
  options: z.record(z.union([z.string(), z.boolean()])).optional(),
  accountId: z.string().optional(),
  runtimeMode: z.string().optional(),
  title: z.string().optional()
};

/** `args` without its undefined values (an omitted field stays omitted for the target). */
function defined(args: Args): Args {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

const pick = (args: Args, keys: readonly string[]): Args => defined(Object.fromEntries(keys.map((key) => [key, args[key]])));
const SETTINGS_KEYS = ["agent", "model", "options", "accountId", "runtimeMode", "title"] as const;

/** Spec §14.1's table. */
export const LEGACY_CHAT_TOOL_ALIASES: Readonly<Record<string, LegacyChatToolAlias>> = {
  thread_list: {
    target: "list_sessions",
    input: { limit: z.number().optional() },
    map: (args) => pick(args, ["limit"])
  },
  thread_read: {
    target: "read_transcript",
    input: { threadId: id, turns: z.number().optional(), beforeTurn: z.number().optional(), include: z.array(z.string()).optional(), maxChars: z.number().optional() },
    map: (args) => defined({ sessionId: args.threadId, ...pick(args, ["turns", "beforeTurn", "include", "maxChars"]) })
  },
  thread_create: {
    target: "create_session",
    input: { prompt: text, ...settings },
    map: (args) => defined({ prompt: args.prompt, ...pick(args, SETTINGS_KEYS), reply: "none" })
  },
  delegate_task: {
    target: "create_session",
    input: { prompt: text, ...settings },
    map: (args) => defined({ prompt: args.prompt, ...pick(args, SETTINGS_KEYS), delegate: true, reply: "none" })
  },
  agent_catalog: {
    target: "list_agents",
    input: { agent: z.string().optional(), model: z.string().optional() },
    map: (args) => pick(args, ["agent", "model"])
  },
  thread_send: {
    target: "send_message",
    input: { threadId: id, text, wait: z.boolean().optional(), timeoutSeconds: seconds },
    map: (args) => defined({ sessionId: args.threadId, text: args.text, reply: args.wait === true ? "wait" : "none", timeoutSeconds: args.wait === true ? args.timeoutSeconds : undefined }),
    legacySemantics: (args) => args.wait === true
  },
  thread_wait: {
    target: "wait_for_session",
    input: { threadId: id, timeoutSeconds: seconds },
    map: (args) => defined({ sessionId: args.threadId, timeoutSeconds: args.timeoutSeconds })
  },
  thread_interrupt: {
    target: "control_session",
    input: { threadId: id },
    map: (args) => ({ sessionId: args.threadId, action: "interrupt" })
  },
  thread_fork: {
    target: "fork_session",
    input: { throughTurn: z.number().optional(), messageId: z.string().optional(), title: z.string().optional() },
    map: (args) => pick(args, ["throughTurn", "messageId", "title"])
  },
  thread_merge_back: {
    target: "merge_back_session",
    input: { text },
    map: (args) => ({ text: args.text })
  },
  task_status: {
    target: "get_session",
    input: { taskId: id },
    map: (args) => ({ sessionId: args.taskId })
  },
  task_wait: {
    target: "wait_for_session",
    input: { taskId: id, timeoutSeconds: seconds },
    map: (args) => defined({ sessionId: args.taskId, timeoutSeconds: args.timeoutSeconds })
  },
  task_cancel: {
    target: "control_session",
    input: { taskId: id },
    map: (args) => ({ sessionId: args.taskId, action: "interrupt" })
  }
};

/** The legacy names the daemon aliases. */
export const LEGACY_CHAT_TOOL_NAMES: readonly string[] = Object.keys(LEGACY_CHAT_TOOL_ALIASES);

/**
 * The legacy name as a catalog tool running `target` with the mapped arguments: tier, family,
 * scope, preview and run are the target's — so the gate, cards, turn policy and toolset check judge
 * the call exactly as they judge the target.
 */
export function aliasTool(name: string, alias: LegacyChatToolAlias, target: AnyOrquesterTool): AnyOrquesterTool {
  const schema = audienceSchema(target, "chat");
  // The same arguments always map to the same call; computed once per arguments object.
  const memo = new WeakMap<object, Args>();
  const mapped = (args: Args): Args => {
    const hit = memo.get(args);
    if (hit) return hit;
    const parsed = schema.safeParse(alias.map(args));
    if (!parsed.success) throw new ToolError("INVALID_ARGUMENT", argumentProblems(name, parsed.error));
    const value = parsed.data as Args;
    memo.set(args, value);
    return value;
  };
  const targetTier = target.tier;
  const targetFamily = target.adminFamily;
  const approval = target.approval;
  return {
    name,
    title: target.title,
    description: target.description,
    input: alias.input,
    audiences: ["chat"],
    toolset: target.toolset,
    tier: typeof targetTier === "function" ? (args: Args, scope: ScopeClaim): Tier => targetTier(mapped(args), scope) : targetTier,
    ...(targetFamily !== undefined
      ? { adminFamily: typeof targetFamily === "function" ? (args: Args, scope: ScopeClaim) => targetFamily(mapped(args), scope) : targetFamily }
      : {}),
    ...(target.planSafe ? { planSafe: true } : {}),
    scope: (args: Args, ctx: ScopeContext) => target.scope(mapped(args), ctx),
    ...(approval ? { approval: (args: Args, ctx: ScopeContext) => approval(mapped(args), ctx) } : {}),
    annotations: target.annotations,
    resultKind: target.resultKind,
    ...(target.secretResultKeys ? { secretResultKeys: target.secretResultKeys } : {}),
    run: (args: Args, ctx: CallContext) =>
      target.run(mapped(args), alias.legacySemantics?.(args) === true ? { ...ctx, legacyAlias: name } : ctx)
  };
}

const aliasCache = new Map<string, AnyOrquesterTool>();

/**
 * A chat tool by name: the catalog's own, else the alias of a legacy name whose target the catalog
 * serves (old semantics), else undefined.
 */
export function chatToolByName(name: string, lookup?: (name: string) => AnyOrquesterTool | undefined): AnyOrquesterTool | undefined {
  const find = lookup ?? ((n: string) => toolByName(n, "chat"));
  const own = find(name);
  if (own) return own;
  if (!Object.prototype.hasOwnProperty.call(LEGACY_CHAT_TOOL_ALIASES, name)) return undefined;
  const alias = LEGACY_CHAT_TOOL_ALIASES[name]!;
  const target = find(alias.target);
  if (!target) return undefined;
  // The production catalog is static: cache per name (a test passing its own lookup is not cached).
  if (lookup !== undefined) return aliasTool(name, alias, target);
  let cached = aliasCache.get(name);
  if (cached === undefined) {
    cached = aliasTool(name, alias, target);
    aliasCache.set(name, cached);
  }
  return cached;
}
