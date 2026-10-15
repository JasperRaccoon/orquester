/**
 * TEMPORARY adapter (unified MCP design 2026-10-15, plan Task 2; deleted in Task 14): wraps the
 * pre-catalog tools — the external `/mcp`'s `ToolDef`s and the in-chat `SessionTool`s — as catalog
 * tools with spec §4's audience, tier, toolset and scope, so both transports run them through the
 * one executor until each Wave 3 family replaces its legacy entries.
 *
 * Behaviour is unchanged by construction:
 * - a legacy external tool is `external`-only (full trust: the gate allows it), runs its old
 *   handler with the old `ToolContext`, and claims nothing — it validates its own addresses;
 * - a legacy chat tool is `chat`-only, in the locked `core` toolset, and claims nothing either:
 *   each one already scopes itself to the caller's project and applies the turn policy itself
 *   (`session-tools/threads`), so the gate's plan rule (which refuses only `writes`) never refuses
 *   one that worked before.
 *
 * The tiers and toolsets below are the ones the replacing catalog tool has (spec §4, §9.1), so the
 * external `_meta` already reads as the final catalog will.
 */

import type { z } from "zod";
import type { AdminFamily, ToolsetId } from "@orquester/api";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ToolError } from "../errors.ts";
import type { ToolDef } from "../tool.ts";
import type { SessionTool } from "../../session-tools/contract.ts";
import type { AnyOrquesterTool, ApprovalPreview, OrquesterTool, ScopeClaim, Tier } from "./contract.ts";
import { callExtensions } from "./extensions.ts";

/** What a legacy tool claims: nothing the gate judges (it validates its own addresses). */
export const LEGACY_SCOPE: ScopeClaim = Object.freeze({
  projects: [],
  sessions: [],
  reads: "none",
  writes: false,
  causesTurnIn: []
}) as ScopeClaim;

interface LegacyMeta {
  toolset: ToolsetId;
  tier: Tier;
  adminFamily?: AdminFamily;
  planSafe?: boolean;
}

const read = (toolset: ToolsetId): LegacyMeta => ({ toolset, tier: "read" });
const act = (toolset: ToolsetId): LegacyMeta => ({ toolset, tier: "act" });
const admin = (toolset: ToolsetId, adminFamily: AdminFamily): LegacyMeta => ({ toolset, tier: "admin", adminFamily });

/** Every external `/mcp` tool of the 72-tool surface: the toolset and chat tier of the tool that replaces it. */
export const LEGACY_EXTERNAL_META: Readonly<Record<string, LegacyMeta>> = {
  list_projects: read("core"),
  list_agents: read("core"),
  list_conversations: read("chat-extras"),
  list_sessions: read("core"),
  get_session: read("core"),
  get_turn_diff: read("chat-extras"),
  create_session: act("core"),
  update_session: act("chat-extras"),
  interrupt_session: act("core"),
  stop_task: act("core"),
  stop_session: act("core"),
  close_session: act("core"),
  revert_session: act("core"),
  compact_session: act("core"),
  fork_session: act("core"),
  merge_back_session: act("core"),
  get_session_lineage: read("core"),
  resolve_merge_back: act("core"),
  search_sessions: read("core"),
  send_message: act("core"),
  implement_plan: act("core"),
  read_transcript: read("core"),
  read_tool_output: read("chat-extras"),
  answer_question: act("chat-extras"),
  dismiss_question: act("chat-extras"),
  resolve_approval: act("chat-extras"),
  wait_for_session: read("core"),
  get_usage: read("core"),
  get_cost: read("core"),
  list_files: read("files-git"),
  read_file: read("files-git"),
  list_todos: read("notes"),
  create_todo: act("notes"),
  update_todo: act("notes"),
  delete_todo: act("notes"),
  toggle_todo_item: act("notes"),
  list_workflow_block_types: read("workflow-authoring"),
  list_workflows: read("reads"),
  get_workflow: read("reads"),
  create_workflow: admin("workflow-authoring", "workflows"),
  update_workflow: admin("workflow-authoring", "workflows"),
  validate_workflow: read("workflow-authoring"),
  delete_workflow: admin("workflow-authoring", "workflows"),
  preview_expression: read("workflow-authoring"),
  run_workflow: admin("workflow-authoring", "workflows"),
  list_workflow_runs: read("reads"),
  get_workflow_run: read("reads"),
  cancel_workflow_run: act("workflow-authoring"),
  list_workflow_secrets: read("workflow-authoring"),
  set_workflow_secret: admin("workflow-authoring", "workflow-secrets"),
  list_agent_profiles: read("reads"),
  get_agent_profile: read("reads"),
  get_agent_profile_item: read("reads"),
  create_agent_profile_item: admin("agent-profile-editing", "agent-profile"),
  update_agent_profile_item: admin("agent-profile-editing", "agent-profile"),
  set_agent_profile_item_enabled: admin("agent-profile-editing", "agent-profile"),
  delete_agent_profile_item: admin("agent-profile-editing", "agent-profile"),
  copy_agent_profile_item: admin("agent-profile-editing", "agent-profile"),
  trust_agent_profile_hook: admin("agent-profile-editing", "agent-profile"),
  get_agent_instructions: read("reads"),
  write_agent_instructions: admin("agent-profile-editing", "agent-profile"),
  import_agent_profile_items: admin("agent-profile-editing", "agent-profile"),
  list_marketplace_plugins: read("reads"),
  desktops_list: read("desktops"),
  desktop_host_status: read("desktops"),
  desktop_open: admin("desktops", "desktops"),
  desktop_launch_app: admin("desktops", "desktops"),
  desktop_windows: read("desktops"),
  desktop_window_action: act("desktops"),
  desktop_app_log: read("desktops"),
  desktop_stop_app: act("desktops"),
  desktop_close: act("desktops")
};

/** Every in-chat session tool of the 16-tool surface: all `core`; tiers as spec §2.2 uses them. */
export const LEGACY_CHAT_META: Readonly<Record<string, LegacyMeta>> = {
  thread_list: read("core"),
  thread_read: read("core"),
  thread_create: act("core"),
  agent_catalog: read("core"),
  thread_send: act("core"),
  thread_wait: read("core"),
  thread_interrupt: act("core"),
  thread_fork: act("core"),
  thread_merge_back: act("core"),
  delegate_task: act("core"),
  task_status: read("core"),
  task_wait: read("core"),
  task_cancel: act("core"),
  html_preview: read("core"),
  html_render: { ...act("core"), planSafe: true },
  request_secret: { ...act("core"), planSafe: true }
};

function metaFor(table: Readonly<Record<string, LegacyMeta>>, name: string): LegacyMeta {
  const meta = Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
  if (!meta) throw new Error(`catalog/legacy: no tier/toolset for legacy tool ${name}`);
  return meta;
}

/** The card a legacy Admin tool would show a chat caller (none reaches one: they are external-only). */
async function argumentsPreview(name: string, title: string, args: unknown): Promise<ApprovalPreview> {
  return {
    title: `Run ${title}`,
    scopeLabel: name,
    sections: [{ kind: "code", title: "Arguments", language: "json", text: JSON.stringify(args, null, 2) }]
  };
}

/** The external `/mcp`'s pre-catalog tools as external-only catalog tools. */
export function legacyExternalTools(defs: readonly ToolDef<any>[]): AnyOrquesterTool[] {
  return defs.map((def) => {
    const meta = metaFor(LEGACY_EXTERNAL_META, def.name);
    const tool: OrquesterTool<z.ZodRawShape> = {
      name: def.name,
      title: def.title,
      description: def.description,
      input: def.input,
      audiences: ["external"],
      toolset: meta.toolset,
      tier: meta.tier,
      ...(meta.adminFamily ? { adminFamily: meta.adminFamily, approval: (args) => argumentsPreview(def.name, def.title, args) } : {}),
      scope: async () => LEGACY_SCOPE,
      annotations: def.annotations,
      resultKind: "json",
      run: async (args, ctx) => {
        const legacy = callExtensions(ctx).legacy;
        return def.run(args as never, {
          api: ctx.api,
          // Only the todo and file tools read these; an executor without them fails those calls closed.
          todos: legacy?.todos ?? (undefined as never),
          files: legacy?.files ?? (undefined as never),
          signal: ctx.signal,
          now: () => ctx.now()
        });
      }
    };
    return tool;
  });
}

/**
 * The in-chat session tools as chat-only catalog tools in `core`. A tool missing from
 * {@link LEGACY_CHAT_META} (a test toolkit) reads as Read when its annotations say read-only,
 * else Act.
 */
export function legacyChatTools(tools: readonly SessionTool<any>[]): AnyOrquesterTool[] {
  return tools.map((sessionTool) => {
    const meta = Object.prototype.hasOwnProperty.call(LEGACY_CHAT_META, sessionTool.name)
      ? LEGACY_CHAT_META[sessionTool.name]!
      : sessionTool.annotations.readOnlyHint === true
        ? read("core")
        : act("core");
    const tool: OrquesterTool<z.ZodRawShape> = {
      name: sessionTool.name,
      title: sessionTool.title,
      description: sessionTool.description,
      input: sessionTool.input,
      audiences: ["chat"],
      toolset: meta.toolset,
      tier: meta.tier,
      ...(meta.planSafe ? { planSafe: true } : {}),
      scope: async () => LEGACY_SCOPE,
      annotations: sessionTool.annotations,
      resultKind: sessionTool.resultKind,
      ...(sessionTool.secretResultKeys ? { secretResultKeys: sessionTool.secretResultKeys } : {}),
      run: async (args, ctx): Promise<CallToolResult> => {
        const caller = ctx.caller;
        if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", `${sessionTool.name} is a chat tool.`);
        return sessionTool.run(args as never, {
          threadId: caller.threadId,
          projectPath: caller.projectPath,
          cwd: caller.cwd,
          agentId: caller.agentId,
          callId: caller.callId,
          signal: ctx.signal,
          api: ctx.api,
          ...(ctx.secretRequests ? { secretRequests: ctx.secretRequests } : {}),
          ...(caller.delivered ? { delivered: caller.delivered } : {}),
          now: () => ctx.now()
        });
      }
    };
    return tool;
  });
}
