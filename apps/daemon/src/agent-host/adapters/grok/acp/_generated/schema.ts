// Generated from the pinned Agent Client Protocol release assets. Do not edit by hand.
// Source:  https://github.com/agentclientprotocol/agent-client-protocol/releases/download/v0.11.3/
// Assets:  schema.unstable.json, meta.unstable.json
// Release: v0.11.3 (the same release T3 Code's packages/effect-acp pins)
// See ./README.md for how this directory is produced.

/* eslint-disable */

// 171 type definitions, alphabetical. `Error` is emitted as `AcpError` so it
// cannot shadow the global `Error` type.

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type AgentAuthCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Whether the agent supports the logout method. */
  readonly logout?: LogoutCapabilities | null;
};

/** Capabilities supported by the agent. */
export type AgentCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly auth?: AgentAuthCapabilities;
  /** Whether the agent supports `session/load`. */
  readonly loadSession?: boolean;
  /** MCP capabilities supported by the agent. */
  readonly mcpCapabilities?: McpCapabilities;
  /** Prompt capabilities supported by the agent. */
  readonly promptCapabilities?: PromptCapabilities;
  readonly sessionCapabilities?: SessionCapabilities;
};

export type AgentNotification = {
  readonly method: string;
  readonly params?: SessionNotification | ElicitationCompleteNotification | ExtNotification | null;
};

export type AgentRequest = {
  readonly id: RequestId;
  readonly method: string;
  readonly params?: WriteTextFileRequest | ReadTextFileRequest | RequestPermissionRequest | CreateTerminalRequest | TerminalOutputRequest | ReleaseTerminalRequest | WaitForTerminalExitRequest | KillTerminalRequest | ElicitationRequest | ExtRequest | null;
};

export type AgentResponse = {
  readonly id: RequestId;
  /** All possible responses that an agent can send to a client. */
  readonly result: InitializeResponse | AuthenticateResponse | LogoutResponse | NewSessionResponse | LoadSessionResponse | ListSessionsResponse | ForkSessionResponse | ResumeSessionResponse | CloseSessionResponse | SetSessionModeResponse | SetSessionConfigOptionResponse | PromptResponse | SetSessionModelResponse | ExtResponse;
} | {
  readonly error: AcpError;
  readonly id: RequestId;
};

/** Optional annotations for the client. */
export type Annotations = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly audience?: ReadonlyArray<Role> | null;
  readonly lastModified?: string | null;
  readonly priority?: number | null;
};

/** Audio provided to or from an LLM. */
export type AudioContent = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly annotations?: Annotations | null;
  readonly data: string;
  readonly mimeType: string;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type AuthCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Whether the client supports `terminal` authentication methods. */
  readonly terminal?: boolean;
};

/** Request parameters for the authenticate method. */
export type AuthenticateRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The ID of the authentication method to use. */
  readonly methodId: string;
};

/** Response to the `authenticate` method. */
export type AuthenticateResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type AuthEnvVar = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Human-readable label for this variable, displayed in client UI. */
  readonly label?: string | null;
  /** The environment variable name (e.g. */
  readonly name: string;
  /** Whether this variable is optional. */
  readonly optional?: boolean;
  /** Whether this value is a secret (e.g. */
  readonly secret?: boolean;
};

/** Describes an available authentication method. */
export type AuthMethod = (AuthMethodEnvVar & {
  readonly type: "env_var";
}) | (AuthMethodTerminal & {
  readonly type: "terminal";
}) | AuthMethodAgent;

/** Agent handles authentication itself. */
export type AuthMethodAgent = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Optional description providing more details about this authentication method. */
  readonly description?: string | null;
  /** Unique identifier for this authentication method. */
  readonly id: string;
  /** Human-readable name of the authentication method. */
  readonly name: string;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type AuthMethodEnvVar = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Optional description providing more details about this authentication method. */
  readonly description?: string | null;
  /** Unique identifier for this authentication method. */
  readonly id: string;
  /** Optional link to a page where the user can obtain their credentials. */
  readonly link?: string | null;
  /** Human-readable name of the authentication method. */
  readonly name: string;
  /** The environment variables the client should set. */
  readonly vars: ReadonlyArray<AuthEnvVar>;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type AuthMethodTerminal = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Additional arguments to pass when running the agent binary for terminal auth. */
  readonly args?: ReadonlyArray<string>;
  /** Optional description providing more details about this authentication method. */
  readonly description?: string | null;
  /** Additional environment variables to set when running the agent binary for terminal auth. */
  readonly env?: {
    readonly [key: string]: string;
  };
  /** Unique identifier for this authentication method. */
  readonly id: string;
  /** Human-readable name of the authentication method. */
  readonly name: string;
};

/** Information about a command. */
export type AvailableCommand = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Human-readable description of what the command does. */
  readonly description: string;
  /** Input for the command if required */
  readonly input?: AvailableCommandInput | null;
  /** Command name (e.g., `create_plan`, `research_codebase`). */
  readonly name: string;
};

/** The input specification for a command. */
export type AvailableCommandInput = UnstructuredCommandInput;

/** Available commands are ready or have changed */
export type AvailableCommandsUpdate = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Commands the agent can execute */
  readonly availableCommands: ReadonlyArray<AvailableCommand>;
};

/** Binary resource contents. */
export type BlobResourceContents = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly blob: string;
  readonly mimeType?: string | null;
  readonly uri: string;
};

/** Schema for boolean properties in an elicitation form. */
export type BooleanPropertySchema = {
  /** Default value. */
  readonly default?: boolean | null;
  /** Human-readable description. */
  readonly description?: string | null;
  /** Optional title for the property. */
  readonly title?: string | null;
};

/** Notification to cancel ongoing operations for a session. */
export type CancelNotification = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The ID of the session to cancel operations for. */
  readonly sessionId: SessionId;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type CancelRequestNotification = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The ID of the request to cancel. */
  readonly requestId: RequestId;
};

/** Capabilities supported by the client. */
export type ClientCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly auth?: AuthCapabilities;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly elicitation?: ElicitationCapabilities | null;
  /** File system capabilities supported by the client. */
  readonly fs?: FileSystemCapabilities;
  /** Whether the Client support all `terminal/*` methods. */
  readonly terminal?: boolean;
};

export type ClientNotification = {
  readonly method: string;
  readonly params?: CancelNotification | ExtNotification | null;
};

export type ClientRequest = {
  readonly id: RequestId;
  readonly method: string;
  readonly params?: InitializeRequest | AuthenticateRequest | LogoutRequest | NewSessionRequest | LoadSessionRequest | ListSessionsRequest | ForkSessionRequest | ResumeSessionRequest | CloseSessionRequest | SetSessionModeRequest | SetSessionConfigOptionRequest | PromptRequest | SetSessionModelRequest | ExtRequest | null;
};

export type ClientResponse = {
  readonly id: RequestId;
  /** All possible responses that a client can send to an agent. */
  readonly result: WriteTextFileResponse | ReadTextFileResponse | RequestPermissionResponse | CreateTerminalResponse | TerminalOutputResponse | ReleaseTerminalResponse | WaitForTerminalExitResponse | KillTerminalResponse | ElicitationResponse | ExtResponse;
} | {
  readonly error: AcpError;
  readonly id: RequestId;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type CloseSessionRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The ID of the session to close. */
  readonly sessionId: SessionId;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type CloseSessionResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** Session configuration options have been updated. */
export type ConfigOptionUpdate = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The full set of configuration options and their current values. */
  readonly configOptions: ReadonlyArray<SessionConfigOption>;
};

/** Standard content block (text, images, resources). */
export type Content = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The actual content block. */
  readonly content: ContentBlock;
};

/** Content blocks represent displayable information in the Agent Client Protocol. */
export type ContentBlock = (TextContent & {
  readonly type: "text";
}) | (ImageContent & {
  readonly type: "image";
}) | (AudioContent & {
  readonly type: "audio";
}) | (ResourceLink & {
  readonly type: "resource_link";
}) | (EmbeddedResource & {
  readonly type: "resource";
});

/** A streamed item of content */
export type ContentChunk = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** A single item of content */
  readonly content: ContentBlock;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly messageId?: string | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type Cost = {
  /** Total cumulative cost for session. */
  readonly amount: number;
  /** ISO 4217 currency code (e.g., "USD", "EUR"). */
  readonly currency: string;
};

/** Request to create a new terminal and execute a command. */
export type CreateTerminalRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Array of command arguments. */
  readonly args?: ReadonlyArray<string>;
  /** The command to execute. */
  readonly command: string;
  /** Working directory for the command (absolute path). */
  readonly cwd?: string | null;
  /** Environment variables for the command. */
  readonly env?: ReadonlyArray<EnvVariable>;
  /** Maximum number of output bytes to retain. */
  readonly outputByteLimit?: number | null;
  /** The session ID for this request. */
  readonly sessionId: SessionId;
};

/** Response containing the ID of the created terminal. */
export type CreateTerminalResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The unique identifier for the created terminal. */
  readonly terminalId: string;
};

/** The current mode of the session has changed See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes) */
export type CurrentModeUpdate = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The ID of the current mode */
  readonly currentModeId: SessionModeId;
};

/** A diff representing file modifications. */
export type Diff = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The new content after modification. */
  readonly newText: string;
  /** The original content (None for new files). */
  readonly oldText?: string | null;
  /** The file path being modified. */
  readonly path: string;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationAcceptAction = {
  /** The user-provided content, if any, as an object matching the requested schema. */
  readonly content?: {
    readonly [key: string]: ElicitationContentValue;
  } | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationAction = (ElicitationAcceptAction & {
  readonly action: "accept";
}) | {
  readonly action: "decline";
} | {
  readonly action: "cancel";
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Whether the client supports form-based elicitation. */
  readonly form?: ElicitationFormCapabilities | null;
  /** Whether the client supports URL-based elicitation. */
  readonly url?: ElicitationUrlCapabilities | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationCompleteNotification = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The ID of the elicitation that completed. */
  readonly elicitationId: ElicitationId;
};

export type ElicitationContentValue = string | number | boolean | ReadonlyArray<string>;

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationFormCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationFormMode = {
  /** A JSON Schema describing the form fields to present to the user. */
  readonly requestedSchema: ElicitationSchema;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationId = string;

/** Property schema for elicitation form fields. */
export type ElicitationPropertySchema = (StringPropertySchema & {
  readonly type: "string";
}) | (NumberPropertySchema & {
  readonly type: "number";
}) | (IntegerPropertySchema & {
  readonly type: "integer";
}) | (BooleanPropertySchema & {
  readonly type: "boolean";
}) | (MultiSelectPropertySchema & {
  readonly type: "array";
});

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationRequest = (ElicitationFormMode & {
  readonly mode: "form";
}) | (ElicitationUrlMode & {
  readonly mode: "url";
});

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The user's action in response to the elicitation. */
  readonly action: ElicitationAction;
};

/** Type-safe elicitation schema for requesting structured user input. */
export type ElicitationSchema = {
  /** Optional description of what this schema represents. */
  readonly description?: string | null;
  /** Property definitions (must be primitive types). */
  readonly properties?: {
    readonly [key: string]: ElicitationPropertySchema;
  };
  /** List of required property names. */
  readonly required?: ReadonlyArray<string> | null;
  /** Optional title for the schema. */
  readonly title?: string | null;
  /** Type discriminator. */
  readonly type?: ElicitationSchemaType;
};

/** Type discriminator for elicitation schemas. */
export type ElicitationSchemaType = "object";

/** Items definition for untitled multi-select enum properties. */
export type ElicitationStringType = "string";

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationUrlCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ElicitationUrlMode = {
  /** The unique identifier for this elicitation. */
  readonly elicitationId: ElicitationId;
  /** The URL to direct the user to. */
  readonly url: string;
};

/** The contents of a resource, embedded into a prompt or tool call result. */
export type EmbeddedResource = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly annotations?: Annotations | null;
  readonly resource: EmbeddedResourceResource;
};

/** Resource content that can be embedded in a message. */
export type EmbeddedResourceResource = TextResourceContents | BlobResourceContents;

/** A titled enum option with a const value and human-readable title. */
export type EnumOption = {
  /** The constant value for this option. */
  readonly const: string;
  /** Human-readable title for this option. */
  readonly title: string;
};

/** An environment variable to set when launching an MCP server. */
export type EnvVariable = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The name of the environment variable. */
  readonly name: string;
  /** The value to set for the environment variable. */
  readonly value: string;
};

/** JSON-RPC error object. */
export type AcpError = {
  /** A number indicating the error type that occurred. */
  readonly code: ErrorCode;
  /** Optional primitive or structured value that contains additional information about the error. */
  readonly data?: unknown;
  /** A string providing a short description of the error. */
  readonly message: string;
};

/** Predefined error codes for common JSON-RPC and ACP-specific errors. */
export type ErrorCode = -32700 | -32600 | -32601 | -32602 | -32603 | -32800 | -32000 | -32002 | -32042 | number;

/** Allows the Agent to send an arbitrary notification that is not part of the ACP spec. */
export type ExtNotification = unknown;

/** Allows for sending an arbitrary request that is not part of the ACP spec. */
export type ExtRequest = unknown;

/** Allows for sending an arbitrary response to an [`ExtRequest`] that is not part of the ACP spec. */
export type ExtResponse = unknown;

/** File system capabilities that a client may support. */
export type FileSystemCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Whether the Client supports `fs/read_text_file` requests. */
  readonly readTextFile?: boolean;
  /** Whether the Client supports `fs/write_text_file` requests. */
  readonly writeTextFile?: boolean;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ForkSessionRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The working directory for this session. */
  readonly cwd: string;
  /** List of MCP servers to connect to for this session. */
  readonly mcpServers?: ReadonlyArray<McpServer>;
  /** The ID of the session to fork. */
  readonly sessionId: SessionId;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ForkSessionResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Initial session configuration options if supported by the Agent. */
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly models?: SessionModelState | null;
  /** Initial mode state if supported by the Agent See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes) */
  readonly modes?: SessionModeState | null;
  /** Unique identifier for the newly created forked session. */
  readonly sessionId: SessionId;
};

/** An HTTP header to set when making requests to the MCP server. */
export type HttpHeader = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The name of the HTTP header. */
  readonly name: string;
  /** The value to set for the HTTP header. */
  readonly value: string;
};

/** An image provided to or from an LLM. */
export type ImageContent = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly annotations?: Annotations | null;
  readonly data: string;
  readonly mimeType: string;
  readonly uri?: string | null;
};

/** Metadata about the implementation of the client or agent. */
export type Implementation = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Intended for programmatic or logical use, but can be used as a display name fallback if title isn’t present. */
  readonly name: string;
  /** Intended for UI and end-user contexts — optimized to be human-readable and easily understood. */
  readonly title?: string | null;
  /** Version of the implementation. */
  readonly version: string;
};

/** Request parameters for the initialize method. */
export type InitializeRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Capabilities supported by the client. */
  readonly clientCapabilities?: ClientCapabilities;
  /** Information about the Client name and version sent to the Agent. */
  readonly clientInfo?: Implementation | null;
  /** The latest protocol version supported by the client. */
  readonly protocolVersion: ProtocolVersion;
};

/** Response to the `initialize` method. */
export type InitializeResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Capabilities supported by the agent. */
  readonly agentCapabilities?: AgentCapabilities;
  /** Information about the Agent name and version sent to the Client. */
  readonly agentInfo?: Implementation | null;
  /** Authentication methods supported by the agent. */
  readonly authMethods?: ReadonlyArray<AuthMethod>;
  /** The protocol version the client specified if supported by the agent, or the latest protocol version supported by the agent. */
  readonly protocolVersion: ProtocolVersion;
};

/** Schema for integer properties in an elicitation form. */
export type IntegerPropertySchema = {
  /** Default value. */
  readonly default?: number | null;
  /** Human-readable description. */
  readonly description?: string | null;
  /** Maximum value (inclusive). */
  readonly maximum?: number | null;
  /** Minimum value (inclusive). */
  readonly minimum?: number | null;
  /** Optional title for the property. */
  readonly title?: string | null;
};

/** Request to kill a terminal without releasing it. */
export type KillTerminalRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The session ID for this request. */
  readonly sessionId: SessionId;
  /** The ID of the terminal to kill. */
  readonly terminalId: string;
};

/** Response to `terminal/kill` method */
export type KillTerminalResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** Request parameters for listing existing sessions. */
export type ListSessionsRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Opaque cursor token from a previous response's nextCursor field for cursor-based pagination */
  readonly cursor?: string | null;
  /** Filter sessions by working directory. */
  readonly cwd?: string | null;
};

/** Response from listing sessions. */
export type ListSessionsResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Opaque cursor token. */
  readonly nextCursor?: string | null;
  /** Array of session information objects */
  readonly sessions: ReadonlyArray<SessionInfo>;
};

/** Request parameters for loading an existing session. */
export type LoadSessionRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The working directory for this session. */
  readonly cwd: string;
  /** List of MCP servers to connect to for this session. */
  readonly mcpServers: ReadonlyArray<McpServer>;
  /** The ID of the session to load. */
  readonly sessionId: SessionId;
};

/** Response from loading an existing session. */
export type LoadSessionResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Initial session configuration options if supported by the Agent. */
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly models?: SessionModelState | null;
  /** Initial mode state if supported by the Agent See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes) */
  readonly modes?: SessionModeState | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type LogoutCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type LogoutRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type LogoutResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** MCP capabilities supported by the agent */
export type McpCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Agent supports [`McpServer::Http`]. */
  readonly http?: boolean;
  /** Agent supports [`McpServer::Sse`]. */
  readonly sse?: boolean;
};

/** Configuration for connecting to an MCP (Model Context Protocol) server. */
export type McpServer = (McpServerHttp & {
  readonly type: "http";
}) | (McpServerSse & {
  readonly type: "sse";
}) | McpServerStdio;

/** HTTP transport configuration for MCP. */
export type McpServerHttp = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** HTTP headers to set when making requests to the MCP server. */
  readonly headers: ReadonlyArray<HttpHeader>;
  /** Human-readable name identifying this MCP server. */
  readonly name: string;
  /** URL to the MCP server. */
  readonly url: string;
};

/** SSE transport configuration for MCP. */
export type McpServerSse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** HTTP headers to set when making requests to the MCP server. */
  readonly headers: ReadonlyArray<HttpHeader>;
  /** Human-readable name identifying this MCP server. */
  readonly name: string;
  /** URL to the MCP server. */
  readonly url: string;
};

/** Stdio transport configuration for MCP. */
export type McpServerStdio = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Command-line arguments to pass to the MCP server. */
  readonly args: ReadonlyArray<string>;
  /** Path to the MCP server executable. */
  readonly command: string;
  /** Environment variables to set when launching the MCP server. */
  readonly env: ReadonlyArray<EnvVariable>;
  /** Human-readable name identifying this MCP server. */
  readonly name: string;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ModelId = string;

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ModelInfo = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Optional description of the model. */
  readonly description?: string | null;
  /** Unique identifier for the model. */
  readonly modelId: ModelId;
  /** Human-readable name of the model. */
  readonly name: string;
};

/** Items for a multi-select (array) property schema. */
export type MultiSelectItems = UntitledMultiSelectItems | TitledMultiSelectItems;

/** Schema for multi-select (array) properties in an elicitation form. */
export type MultiSelectPropertySchema = {
  /** Default selected values. */
  readonly default?: ReadonlyArray<string> | null;
  /** Human-readable description. */
  readonly description?: string | null;
  /** The items definition describing allowed values. */
  readonly items: MultiSelectItems;
  /** Maximum number of items to select. */
  readonly maxItems?: number | null;
  /** Minimum number of items to select. */
  readonly minItems?: number | null;
  /** Optional title for the property. */
  readonly title?: string | null;
};

/** Request parameters for creating a new session. */
export type NewSessionRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The working directory for this session. */
  readonly cwd: string;
  /** List of MCP (Model Context Protocol) servers the agent should connect to. */
  readonly mcpServers: ReadonlyArray<McpServer>;
};

/** Response from creating a new session. */
export type NewSessionResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Initial session configuration options if supported by the Agent. */
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly models?: SessionModelState | null;
  /** Initial mode state if supported by the Agent See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes) */
  readonly modes?: SessionModeState | null;
  /** Unique identifier for the created session. */
  readonly sessionId: SessionId;
};

/** Schema for number (floating-point) properties in an elicitation form. */
export type NumberPropertySchema = {
  /** Default value. */
  readonly default?: number | null;
  /** Human-readable description. */
  readonly description?: string | null;
  /** Maximum value (inclusive). */
  readonly maximum?: number | null;
  /** Minimum value (inclusive). */
  readonly minimum?: number | null;
  /** Optional title for the property. */
  readonly title?: string | null;
};

/** An option presented to the user when requesting permission. */
export type PermissionOption = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Hint about the nature of this permission option. */
  readonly kind: PermissionOptionKind;
  /** Human-readable label to display to the user. */
  readonly name: string;
  /** Unique identifier for this permission option. */
  readonly optionId: PermissionOptionId;
};

/** Unique identifier for a permission option. */
export type PermissionOptionId = string;

/** The type of permission option being presented to the user. */
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/** An execution plan for accomplishing complex tasks. */
export type Plan = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The list of tasks to be accomplished. */
  readonly entries: ReadonlyArray<PlanEntry>;
};

/** A single entry in the execution plan. */
export type PlanEntry = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Human-readable description of what this task aims to accomplish. */
  readonly content: string;
  /** The relative importance of this task. */
  readonly priority: PlanEntryPriority;
  /** Current execution status of this task. */
  readonly status: PlanEntryStatus;
};

/** Priority levels for plan entries. */
export type PlanEntryPriority = "high" | "medium" | "low";

/** Status of a plan entry in the execution flow. */
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

/** Prompt capabilities supported by the agent in `session/prompt` requests. */
export type PromptCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Agent supports [`ContentBlock::Audio`]. */
  readonly audio?: boolean;
  /** Agent supports embedded context in `session/prompt` requests. */
  readonly embeddedContext?: boolean;
  /** Agent supports [`ContentBlock::Image`]. */
  readonly image?: boolean;
};

/** Request parameters for sending a user prompt to the agent. */
export type PromptRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly messageId?: string | null;
  /** The blocks of content that compose the user's message. */
  readonly prompt: ReadonlyArray<ContentBlock>;
  /** The ID of the session to send this user message to */
  readonly sessionId: SessionId;
};

/** Response from processing a user prompt. */
export type PromptResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Indicates why the agent stopped processing the turn. */
  readonly stopReason: StopReason;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly usage?: Usage | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly userMessageId?: string | null;
};

/** Protocol version identifier. */
export type ProtocolVersion = number;

/** Request to read content from a text file. */
export type ReadTextFileRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Maximum number of lines to read. */
  readonly limit?: number | null;
  /** Line number to start reading from (1-based). */
  readonly line?: number | null;
  /** Absolute path to the file to read. */
  readonly path: string;
  /** The session ID for this request. */
  readonly sessionId: SessionId;
};

/** Response containing the contents of a text file. */
export type ReadTextFileResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly content: string;
};

/** Request to release a terminal and free its resources. */
export type ReleaseTerminalRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The session ID for this request. */
  readonly sessionId: SessionId;
  /** The ID of the terminal to release. */
  readonly terminalId: string;
};

/** Response to terminal/release method */
export type ReleaseTerminalResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** JSON RPC Request Id An identifier established by the Client that MUST contain a String, Number, or NULL value if included. */
export type RequestId = null | number | string;

/** The outcome of a permission request. */
export type RequestPermissionOutcome = {
  readonly outcome: "cancelled";
} | (SelectedPermissionOutcome & {
  readonly outcome: "selected";
});

/** Request for user permission to execute a tool call. */
export type RequestPermissionRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Available permission options for the user to choose from. */
  readonly options: ReadonlyArray<PermissionOption>;
  /** The session ID for this request. */
  readonly sessionId: SessionId;
  /** Details about the tool call requiring permission. */
  readonly toolCall: ToolCallUpdate;
};

/** Response to a permission request. */
export type RequestPermissionResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The user's decision on the permission request. */
  readonly outcome: RequestPermissionOutcome;
};

/** A resource that the server is capable of reading, included in a prompt or tool call result. */
export type ResourceLink = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly annotations?: Annotations | null;
  readonly description?: string | null;
  readonly mimeType?: string | null;
  readonly name: string;
  readonly size?: number | null;
  readonly title?: string | null;
  readonly uri: string;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ResumeSessionRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The working directory for this session. */
  readonly cwd: string;
  /** List of MCP servers to connect to for this session. */
  readonly mcpServers?: ReadonlyArray<McpServer>;
  /** The ID of the session to resume. */
  readonly sessionId: SessionId;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type ResumeSessionResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Initial session configuration options if supported by the Agent. */
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly models?: SessionModelState | null;
  /** Initial mode state if supported by the Agent See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes) */
  readonly modes?: SessionModeState | null;
};

/** The sender or recipient of messages and data in a conversation. */
export type Role = "assistant" | "user";

/** The user selected one of the provided options. */
export type SelectedPermissionOutcome = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The ID of the option the user selected. */
  readonly optionId: PermissionOptionId;
};

/** Session capabilities supported by the agent. */
export type SessionCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly close?: SessionCloseCapabilities | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly fork?: SessionForkCapabilities | null;
  /** Whether the agent supports `session/list`. */
  readonly list?: SessionListCapabilities | null;
  /** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
  readonly resume?: SessionResumeCapabilities | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type SessionCloseCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type SessionConfigBoolean = {
  /** The current value of the boolean option. */
  readonly currentValue: boolean;
};

/** Unique identifier for a session configuration option value group. */
export type SessionConfigGroupId = string;

/** Unique identifier for a session configuration option. */
export type SessionConfigId = string;

/** A session configuration option selector and its current state. */
export type SessionConfigOption = (SessionConfigSelect & {
  readonly type: "select";
}) | (SessionConfigBoolean & {
  readonly type: "boolean";
});

/** Semantic category for a session configuration option. */
export type SessionConfigOptionCategory = "mode" | "model" | "thought_level" | string;

/** A single-value selector (dropdown) session configuration option payload. */
export type SessionConfigSelect = {
  /** The currently selected value. */
  readonly currentValue: SessionConfigValueId;
  /** The set of selectable options. */
  readonly options: SessionConfigSelectOptions;
};

/** A group of possible values for a session configuration option. */
export type SessionConfigSelectGroup = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Unique identifier for this group. */
  readonly group: SessionConfigGroupId;
  /** Human-readable label for this group. */
  readonly name: string;
  /** The set of option values in this group. */
  readonly options: ReadonlyArray<SessionConfigSelectOption>;
};

/** A possible value for a session configuration option. */
export type SessionConfigSelectOption = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Optional description for this option value. */
  readonly description?: string | null;
  /** Human-readable label for this option value. */
  readonly name: string;
  /** Unique identifier for this option value. */
  readonly value: SessionConfigValueId;
};

/** Possible values for a session configuration option. */
export type SessionConfigSelectOptions = ReadonlyArray<SessionConfigSelectOption> | ReadonlyArray<SessionConfigSelectGroup>;

/** Unique identifier for a session configuration option value. */
export type SessionConfigValueId = string;

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type SessionForkCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** A unique identifier for a conversation session between a client and agent. */
export type SessionId = string;

/** Information about a session returned by session/list */
export type SessionInfo = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The working directory for this session. */
  readonly cwd: string;
  /** Unique identifier for the session */
  readonly sessionId: SessionId;
  /** Human-readable title for the session */
  readonly title?: string | null;
  /** ISO 8601 timestamp of last activity */
  readonly updatedAt?: string | null;
};

/** Update to session metadata. */
export type SessionInfoUpdate = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Human-readable title for the session. */
  readonly title?: string | null;
  /** ISO 8601 timestamp of last activity. */
  readonly updatedAt?: string | null;
};

/** Capabilities for the `session/list` method. */
export type SessionListCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** A mode the agent can operate in. */
export type SessionMode = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly description?: string | null;
  readonly id: SessionModeId;
  readonly name: string;
};

/** Unique identifier for a Session Mode. */
export type SessionModeId = string;

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type SessionModelState = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The set of models that the Agent can use */
  readonly availableModels: ReadonlyArray<ModelInfo>;
  /** The current model the Agent is in. */
  readonly currentModelId: ModelId;
};

/** The set of modes and the one currently active. */
export type SessionModeState = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The set of modes that the Agent can operate in */
  readonly availableModes: ReadonlyArray<SessionMode>;
  /** The current mode the Agent is in. */
  readonly currentModeId: SessionModeId;
};

/** Notification containing a session update from the agent. */
export type SessionNotification = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The ID of the session this update pertains to. */
  readonly sessionId: SessionId;
  /** The actual update content. */
  readonly update: SessionUpdate;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type SessionResumeCapabilities = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** Different types of updates that can be sent during session processing. */
export type SessionUpdate = (ContentChunk & {
  readonly sessionUpdate: "user_message_chunk";
}) | (ContentChunk & {
  readonly sessionUpdate: "agent_message_chunk";
}) | (ContentChunk & {
  readonly sessionUpdate: "agent_thought_chunk";
}) | (ToolCall & {
  readonly sessionUpdate: "tool_call";
}) | (ToolCallUpdate & {
  readonly sessionUpdate: "tool_call_update";
}) | (Plan & {
  readonly sessionUpdate: "plan";
}) | (AvailableCommandsUpdate & {
  readonly sessionUpdate: "available_commands_update";
}) | (CurrentModeUpdate & {
  readonly sessionUpdate: "current_mode_update";
}) | (ConfigOptionUpdate & {
  readonly sessionUpdate: "config_option_update";
}) | (SessionInfoUpdate & {
  readonly sessionUpdate: "session_info_update";
}) | (UsageUpdate & {
  readonly sessionUpdate: "usage_update";
});

/** Request parameters for setting a session configuration option. */
export type SetSessionConfigOptionRequest = {
  readonly type: "boolean";
  /** The boolean value. */
  readonly value: boolean;
} | {
  /** The value ID. */
  readonly value: SessionConfigValueId;
};

/** Response to `session/set_config_option` method. */
export type SetSessionConfigOptionResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The full set of configuration options and their current values. */
  readonly configOptions: ReadonlyArray<SessionConfigOption>;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type SetSessionModelRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The ID of the model to set. */
  readonly modelId: ModelId;
  /** The ID of the session to set the model for. */
  readonly sessionId: SessionId;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type SetSessionModelResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** Request parameters for setting a session mode. */
export type SetSessionModeRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The ID of the mode to set. */
  readonly modeId: SessionModeId;
  /** The ID of the session to set the mode for. */
  readonly sessionId: SessionId;
};

/** Response to `session/set_mode` method. */
export type SetSessionModeResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};

/** Reasons why an agent stops processing a prompt turn. */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** String format types for string properties in elicitation schemas. */
export type StringFormat = "email" | "uri" | "date" | "date-time";

/** Schema for string properties in an elicitation form. */
export type StringPropertySchema = {
  /** Default value. */
  readonly default?: string | null;
  /** Human-readable description. */
  readonly description?: string | null;
  /** Enum values for untitled single-select enums. */
  readonly enum?: ReadonlyArray<string> | null;
  /** String format. */
  readonly format?: StringFormat | null;
  /** Maximum string length. */
  readonly maxLength?: number | null;
  /** Minimum string length. */
  readonly minLength?: number | null;
  /** Titled enum options for titled single-select enums. */
  readonly oneOf?: ReadonlyArray<EnumOption> | null;
  /** Pattern the string must match. */
  readonly pattern?: string | null;
  /** Optional title for the property. */
  readonly title?: string | null;
};

/** Embed a terminal created with `terminal/create` by its id. */
export type Terminal = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly terminalId: string;
};

/** Exit status of a terminal command. */
export type TerminalExitStatus = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The process exit code (may be null if terminated by signal). */
  readonly exitCode?: number | null;
  /** The signal that terminated the process (may be null if exited normally). */
  readonly signal?: string | null;
};

/** Request to get the current output and status of a terminal. */
export type TerminalOutputRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The session ID for this request. */
  readonly sessionId: SessionId;
  /** The ID of the terminal to get output from. */
  readonly terminalId: string;
};

/** Response containing the terminal output and exit status. */
export type TerminalOutputResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Exit status if the command has completed. */
  readonly exitStatus?: TerminalExitStatus | null;
  /** The terminal output captured so far. */
  readonly output: string;
  /** Whether the output was truncated due to byte limits. */
  readonly truncated: boolean;
};

/** Text provided to or from an LLM. */
export type TextContent = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly annotations?: Annotations | null;
  readonly text: string;
};

/** Text-based resource contents. */
export type TextResourceContents = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  readonly mimeType?: string | null;
  readonly text: string;
  readonly uri: string;
};

/** Items definition for titled multi-select enum properties. */
export type TitledMultiSelectItems = {
  /** Titled enum options. */
  readonly anyOf: ReadonlyArray<EnumOption>;
};

/** Represents a tool call that the language model has requested. */
export type ToolCall = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Content produced by the tool call. */
  readonly content?: ReadonlyArray<ToolCallContent>;
  /** The category of tool being invoked. */
  readonly kind?: ToolKind;
  /** File locations affected by this tool call. */
  readonly locations?: ReadonlyArray<ToolCallLocation>;
  /** Raw input parameters sent to the tool. */
  readonly rawInput?: unknown;
  /** Raw output returned by the tool. */
  readonly rawOutput?: unknown;
  /** Current execution status of the tool call. */
  readonly status?: ToolCallStatus;
  /** Human-readable title describing what the tool is doing. */
  readonly title: string;
  /** Unique identifier for this tool call within the session. */
  readonly toolCallId: ToolCallId;
};

/** Content produced by a tool call. */
export type ToolCallContent = (Content & {
  readonly type: "content";
}) | (Diff & {
  readonly type: "diff";
}) | (Terminal & {
  readonly type: "terminal";
});

/** Unique identifier for a tool call within a session. */
export type ToolCallId = string;

/** A file location being accessed or modified by a tool. */
export type ToolCallLocation = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Optional line number within the file. */
  readonly line?: number | null;
  /** The file path being accessed or modified. */
  readonly path: string;
};

/** Execution status of a tool call. */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** An update to an existing tool call. */
export type ToolCallUpdate = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Replace the content collection. */
  readonly content?: ReadonlyArray<ToolCallContent> | null;
  /** Update the tool kind. */
  readonly kind?: ToolKind | null;
  /** Replace the locations collection. */
  readonly locations?: ReadonlyArray<ToolCallLocation> | null;
  /** Update the raw input. */
  readonly rawInput?: unknown;
  /** Update the raw output. */
  readonly rawOutput?: unknown;
  /** Update the execution status. */
  readonly status?: ToolCallStatus | null;
  /** Update the human-readable title. */
  readonly title?: string | null;
  /** The ID of the tool call being updated. */
  readonly toolCallId: ToolCallId;
};

/** Categories of tools that can be invoked. */
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

/** All text that was typed after the command name is provided as input. */
export type UnstructuredCommandInput = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** A hint to display when the input hasn't been provided yet */
  readonly hint: string;
};

/** Items definition for untitled multi-select enum properties. */
export type UntitledMultiSelectItems = {
  /** Allowed enum values. */
  readonly enum: ReadonlyArray<string>;
  /** Item type discriminator. */
  readonly type: ElicitationStringType;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type Usage = {
  /** Total cache read tokens. */
  readonly cachedReadTokens?: number | null;
  /** Total cache write tokens. */
  readonly cachedWriteTokens?: number | null;
  /** Total input tokens across all turns. */
  readonly inputTokens: number;
  /** Total output tokens across all turns. */
  readonly outputTokens: number;
  /** Total thought/reasoning tokens */
  readonly thoughtTokens?: number | null;
  /** Sum of all token types across session. */
  readonly totalTokens: number;
};

/** **UNSTABLE** This capability is not part of the spec yet, and may be removed or changed at any point. */
export type UsageUpdate = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** Cumulative session cost (optional). */
  readonly cost?: Cost | null;
  /** Total context window size in tokens. */
  readonly size: number;
  /** Tokens currently in context. */
  readonly used: number;
};

/** Request to wait for a terminal command to exit. */
export type WaitForTerminalExitRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The session ID for this request. */
  readonly sessionId: SessionId;
  /** The ID of the terminal to wait for. */
  readonly terminalId: string;
};

/** Response containing the exit status of a terminal command. */
export type WaitForTerminalExitResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The process exit code (may be null if terminated by signal). */
  readonly exitCode?: number | null;
  /** The signal that terminated the process (may be null if exited normally). */
  readonly signal?: string | null;
};

/** Request to write content to a text file. */
export type WriteTextFileRequest = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
  /** The text content to write to the file. */
  readonly content: string;
  /** Absolute path to the file to write. */
  readonly path: string;
  /** The session ID for this request. */
  readonly sessionId: SessionId;
};

/** Response to `fs/write_text_file` */
export type WriteTextFileResponse = {
  /** The _meta property is reserved by ACP to allow clients and agents to attach additional metadata to their interactions. */
  readonly _meta?: {
    readonly [key: string]: unknown;
  } | null;
};
