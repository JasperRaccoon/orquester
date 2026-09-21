/**
 * Agent host — the server package (spec §6).
 *
 * `http-server.ts` is the unix-socket HTTP API the daemon proxies;
 * `stream.ts` is the §6.3 long-lived NDJSON response; `extra-routes.ts` holds
 * the two host↔daemon internals the shared route table does not carry.
 */

export {
  createAgentHostServer,
  type AgentHostServer,
  type AgentHostServerOptions
} from "./http-server.ts";
export {
  coalesceToolUpdates,
  createThreadStream,
  serializedSize,
  COALESCE_WINDOW_MS,
  MAX_PENDING_UPDATES,
  type ThreadStream,
  type ThreadStreamOptions
} from "./stream.ts";
export {
  agentHostExtraRoutes,
  type AgentHostPendingRequest,
  type AgentHostThreadSummary,
  type AttachmentPathResponse
} from "./extra-routes.ts";
