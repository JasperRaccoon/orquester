// Generated from the pinned Agent Client Protocol release assets. Do not edit by hand.
// Source:  https://github.com/agentclientprotocol/agent-client-protocol/releases/download/v0.11.3/
// Assets:  schema.unstable.json, meta.unstable.json
// Release: v0.11.3 (the same release T3 Code's packages/effect-acp pins)
// See ./README.md for how this directory is produced.

/** Methods the CLIENT calls on the AGENT. */
export const AGENT_METHODS = {
  authenticate: "authenticate",
  initialize: "initialize",
  logout: "logout",
  session_cancel: "session/cancel",
  session_close: "session/close",
  session_fork: "session/fork",
  session_list: "session/list",
  session_load: "session/load",
  session_new: "session/new",
  session_prompt: "session/prompt",
  session_resume: "session/resume",
  session_set_config_option: "session/set_config_option",
  session_set_mode: "session/set_mode",
  session_set_model: "session/set_model",
} as const;

/** Methods the AGENT calls back into the CLIENT. */
export const CLIENT_METHODS = {
  fs_read_text_file: "fs/read_text_file",
  fs_write_text_file: "fs/write_text_file",
  session_elicitation: "session/elicitation",
  session_elicitation_complete: "session/elicitation/complete",
  session_request_permission: "session/request_permission",
  session_update: "session/update",
  terminal_create: "terminal/create",
  terminal_kill: "terminal/kill",
  terminal_output: "terminal/output",
  terminal_release: "terminal/release",
  terminal_wait_for_exit: "terminal/wait_for_exit",
} as const;

/** Transport-level methods either side may send. */
export const PROTOCOL_METHODS = {
  cancel_request: "$/cancel_request",
} as const;

/** The ACP major version negotiated in `initialize`. */
export const ACP_PROTOCOL_VERSION = 1 as const;

/** The upstream release these tables were generated from. */
export const ACP_SCHEMA_RELEASE = "v0.11.3" as const;

export type AgentMethodName = (typeof AGENT_METHODS)[keyof typeof AGENT_METHODS];
export type ClientMethodName = (typeof CLIENT_METHODS)[keyof typeof CLIENT_METHODS];
export type ProtocolMethodName = (typeof PROTOCOL_METHODS)[keyof typeof PROTOCOL_METHODS];
export type AcpMethodName = AgentMethodName | ClientMethodName | ProtocolMethodName;
