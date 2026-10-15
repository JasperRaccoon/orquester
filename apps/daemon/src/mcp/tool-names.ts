/**
 * The external `/mcp` server's tool names (`server.ts` `ALL_TOOLS`), as a
 * dependency-free list: the session-tool registry refuses these names
 * (`../session-tools/registry.ts`), and the agent host loads that registry,
 * so it must not pull the whole external catalogue in. A test keeps the two
 * equal (`../session-tools/registry.test.ts`).
 *
 * Why refuse them: `docs/orquester-mcp.md` installs the external server under
 * the same name, `orquester`, so a session tool sharing one of these names
 * would read — to a model, an approval rule, a timeline label — as that
 * server's tool, and vice versa.
 */
export const EXTERNAL_MCP_TOOL_NAMES: readonly string[] = [
  "list_projects",
  "list_agents",
  "list_conversations",
  "list_sessions",
  "get_session",
  "get_turn_diff",
  "create_session",
  "update_session",
  "control_session",
  "fork_session",
  "merge_back_session",
  "search_sessions",
  "send_message",
  "read_transcript",
  "read_tool_output",
  "respond_to_request",
  "wait_for_session",
  "get_usage",
  "notify_user",
  "read_file",
  "get_git_state",
  "list_todos",
  "update_todos",
  "list_saved_prompts",
  "update_saved_prompts",
  "list_workflow_block_types",
  "list_workflows",
  "get_workflow",
  "create_workflow",
  "update_workflow",
  "delete_workflow",
  "preview_expression",
  "run_workflow",
  "get_workflow_runs",
  "cancel_workflow_run",
  "list_workflow_secrets",
  "set_workflow_secret",
  "get_agent_profile",
  "edit_agent_profile",
  "get_desktops",
  "control_desktop"
];
