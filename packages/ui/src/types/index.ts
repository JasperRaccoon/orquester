import type {
  AccountSummary,
  AccountTestResult,
  AgentSummary,
  CreateProjectRequest,
  EventMessage,
  OpenTargetSummary,
  ProjectSummary,
  RegistryEntry,
  RegistryKind,
  RegistryResponse,
  RepoSummary,
  SessionStatus,
  SessionSummary,
  WorkspaceSummary
} from "@orquester/api";

export type Runtime = "desktop" | "web";

export type ConnectionKind = "local" | "remote";

export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

/**
 * A daemon connection as the UI understands it. The `endpoint` is transport
 * agnostic: `unix:///path/to/daemon.sock` for a local socket or
 * `http(s)://host:port` for a remote daemon.
 */
export interface UiConnection {
  id: string;
  name: string;
  kind: ConnectionKind;
  endpoint: string;
  status: ConnectionStatus;
  /** Bearer token for authenticated (remote/http) daemons. */
  password?: string;
}

export type {
  AccountSummary,
  AccountTestResult,
  AgentSummary,
  CreateProjectRequest,
  EventMessage,
  OpenTargetSummary,
  ProjectSummary,
  RegistryEntry,
  RegistryKind,
  RegistryResponse,
  RepoSummary,
  SessionStatus,
  SessionSummary,
  WorkspaceSummary
};
