// Generated from the pinned Agent Client Protocol release assets. Do not edit by hand.
// Source:  https://github.com/agentclientprotocol/agent-client-protocol/releases/download/v0.11.3/
// Assets:  schema.unstable.json, meta.unstable.json
// Release: v0.11.3 (the same release T3 Code's packages/effect-acp pins)
// See ./README.md for how this directory is produced.

import type {
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  CancelRequestNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  ElicitationCompleteNotification,
  ElicitationRequest,
  ElicitationResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  LogoutRequest,
  LogoutResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "./schema.js";

/**
 * Every ACP method, which side receives it, whether it expects a result, and the
 * names of its params/result types in `./schema.ts`. `kind: "notification"` means
 * the protocol defines no response type for it.
 */
export const ACP_METHOD_CATALOG = {
  "authenticate": { side: "agent", kind: "request", params: "AuthenticateRequest", result: "AuthenticateResponse" },
  "initialize": { side: "agent", kind: "request", params: "InitializeRequest", result: "InitializeResponse" },
  "logout": { side: "agent", kind: "request", params: "LogoutRequest", result: "LogoutResponse" },
  "session/cancel": { side: "agent", kind: "notification", params: "CancelNotification", result: null },
  "session/close": { side: "agent", kind: "request", params: "CloseSessionRequest", result: "CloseSessionResponse" },
  "session/fork": { side: "agent", kind: "request", params: "ForkSessionRequest", result: "ForkSessionResponse" },
  "session/list": { side: "agent", kind: "request", params: "ListSessionsRequest", result: "ListSessionsResponse" },
  "session/load": { side: "agent", kind: "request", params: "LoadSessionRequest", result: "LoadSessionResponse" },
  "session/new": { side: "agent", kind: "request", params: "NewSessionRequest", result: "NewSessionResponse" },
  "session/prompt": { side: "agent", kind: "request", params: "PromptRequest", result: "PromptResponse" },
  "session/resume": { side: "agent", kind: "request", params: "ResumeSessionRequest", result: "ResumeSessionResponse" },
  "session/set_config_option": { side: "agent", kind: "request", params: "SetSessionConfigOptionRequest", result: "SetSessionConfigOptionResponse" },
  "session/set_mode": { side: "agent", kind: "request", params: "SetSessionModeRequest", result: "SetSessionModeResponse" },
  "session/set_model": { side: "agent", kind: "request", params: "SetSessionModelRequest", result: "SetSessionModelResponse" },
  "fs/read_text_file": { side: "client", kind: "request", params: "ReadTextFileRequest", result: "ReadTextFileResponse" },
  "fs/write_text_file": { side: "client", kind: "request", params: "WriteTextFileRequest", result: "WriteTextFileResponse" },
  "session/elicitation": { side: "client", kind: "request", params: "ElicitationRequest", result: "ElicitationResponse" },
  "session/elicitation/complete": { side: "client", kind: "notification", params: "ElicitationCompleteNotification", result: null },
  "session/request_permission": { side: "client", kind: "request", params: "RequestPermissionRequest", result: "RequestPermissionResponse" },
  "session/update": { side: "client", kind: "notification", params: "SessionNotification", result: null },
  "terminal/create": { side: "client", kind: "request", params: "CreateTerminalRequest", result: "CreateTerminalResponse" },
  "terminal/kill": { side: "client", kind: "request", params: "KillTerminalRequest", result: "KillTerminalResponse" },
  "terminal/output": { side: "client", kind: "request", params: "TerminalOutputRequest", result: "TerminalOutputResponse" },
  "terminal/release": { side: "client", kind: "request", params: "ReleaseTerminalRequest", result: "ReleaseTerminalResponse" },
  "terminal/wait_for_exit": { side: "client", kind: "request", params: "WaitForTerminalExitRequest", result: "WaitForTerminalExitResponse" },
  "$/cancel_request": { side: "protocol", kind: "notification", params: "CancelRequestNotification", result: null },
} as const;

export type AcpMethodDescriptor = (typeof ACP_METHOD_CATALOG)[keyof typeof ACP_METHOD_CATALOG];

/** method name -> params type. */
export interface AcpMethodParams {
  "authenticate": AuthenticateRequest;
  "initialize": InitializeRequest;
  "logout": LogoutRequest;
  "session/cancel": CancelNotification;
  "session/close": CloseSessionRequest;
  "session/fork": ForkSessionRequest;
  "session/list": ListSessionsRequest;
  "session/load": LoadSessionRequest;
  "session/new": NewSessionRequest;
  "session/prompt": PromptRequest;
  "session/resume": ResumeSessionRequest;
  "session/set_config_option": SetSessionConfigOptionRequest;
  "session/set_mode": SetSessionModeRequest;
  "session/set_model": SetSessionModelRequest;
  "fs/read_text_file": ReadTextFileRequest;
  "fs/write_text_file": WriteTextFileRequest;
  "session/elicitation": ElicitationRequest;
  "session/elicitation/complete": ElicitationCompleteNotification;
  "session/request_permission": RequestPermissionRequest;
  "session/update": SessionNotification;
  "terminal/create": CreateTerminalRequest;
  "terminal/kill": KillTerminalRequest;
  "terminal/output": TerminalOutputRequest;
  "terminal/release": ReleaseTerminalRequest;
  "terminal/wait_for_exit": WaitForTerminalExitRequest;
  "$/cancel_request": CancelRequestNotification;
}

/** method name -> result type (`never` for notifications). */
export interface AcpMethodResult {
  "authenticate": AuthenticateResponse;
  "initialize": InitializeResponse;
  "logout": LogoutResponse;
  "session/cancel": never;
  "session/close": CloseSessionResponse;
  "session/fork": ForkSessionResponse;
  "session/list": ListSessionsResponse;
  "session/load": LoadSessionResponse;
  "session/new": NewSessionResponse;
  "session/prompt": PromptResponse;
  "session/resume": ResumeSessionResponse;
  "session/set_config_option": SetSessionConfigOptionResponse;
  "session/set_mode": SetSessionModeResponse;
  "session/set_model": SetSessionModelResponse;
  "fs/read_text_file": ReadTextFileResponse;
  "fs/write_text_file": WriteTextFileResponse;
  "session/elicitation": ElicitationResponse;
  "session/elicitation/complete": never;
  "session/request_permission": RequestPermissionResponse;
  "session/update": never;
  "terminal/create": CreateTerminalResponse;
  "terminal/kill": KillTerminalResponse;
  "terminal/output": TerminalOutputResponse;
  "terminal/release": ReleaseTerminalResponse;
  "terminal/wait_for_exit": WaitForTerminalExitResponse;
  "$/cancel_request": never;
}

export type AcpMethodWithParams = keyof AcpMethodParams;

/** Method names the AGENT may call on us; everything else must take the unknown-method fallback. */
export const CLIENT_HANDLED_METHODS: ReadonlyArray<AcpMethodWithParams> = [
  "fs/read_text_file",
  "fs/write_text_file",
  "session/elicitation",
  "session/elicitation/complete",
  "session/request_permission",
  "session/update",
  "terminal/create",
  "terminal/kill",
  "terminal/output",
  "terminal/release",
  "terminal/wait_for_exit",
];

/** Method names WE may call on the agent. */
export const AGENT_CALLABLE_METHODS: ReadonlyArray<AcpMethodWithParams> = [
  "authenticate",
  "initialize",
  "logout",
  "session/cancel",
  "session/close",
  "session/fork",
  "session/list",
  "session/load",
  "session/new",
  "session/prompt",
  "session/resume",
  "session/set_config_option",
  "session/set_mode",
  "session/set_model",
];
