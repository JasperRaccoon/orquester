/**
 * Agent chat — the client-side barrel (spec §6.3 client side, §7.2–§7.7).
 *
 * Every chat surface imports from here. The split behind it:
 * - `contracts` — F's types (additive-only);
 * - `hooks` — the only React module;
 * - `*.logic.ts` — pure, React-free, each with a `*.test.ts` beside it;
 * - `transport` / `store` / `providers` — the stream, the per-thread slice and
 *   the provider-snapshot cache.
 */

export * from "./contracts";
export * from "./hooks";

export {
  AgentChatCommandError,
  attachmentRefFromUpload,
  createAgentChatTransport,
  resolveAgentChatTransport,
  type AgentChatStreamHandle,
  type AgentChatStreamHandlers,
  type AgentChatStreamOptions,
  type AgentChatTransport,
  type AgentChatUploadMeta
} from "./transport";
export {
  NdjsonLineBuffer,
  parseStreamLine,
  reconnectDelayMs,
  resumeCursorFor,
  shouldApplyFrame,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  STREAM_STALL_TIMEOUT_MS,
  type StreamLine
} from "./stream.logic";

export {
  applyFrame,
  applyFrames,
  createReducerState,
  emptySlice,
  foldStateFromSnapshot,
  latestTurnSettled,
  needsResync,
  patchSlice,
  projectSlice,
  withConnection,
  type AgentChatReducerState,
  type FoldOps
} from "./reducer.logic";

export {
  createThreadStore,
  ensureThreadStore,
  peekThreadStore,
  releaseThreadStore,
  resetDismissedErrorBanners,
  resetThreadStores,
  retainThreadStore,
  THREAD_STORE_DISPOSE_GRACE_MS,
  type AgentChatThreadState,
  type ThreadStore,
  type ThreadStoreDeps
} from "./store";

export {
  loadProviders,
  notifyProvidersChanged,
  providerForRefId,
  providersStore,
  refreshProvider,
  resetProvidersStore,
  setProviderSideEffects,
  type ProvidersState,
  type ProvidersStore,
  type ProviderSideEffects
} from "./providers";

export * from "./entries.logic";
export * from "./presentation.logic";
export * from "./rows.logic";
export * from "./queue.logic";
export * from "./questions.logic";
export * from "./composer.logic";
export * from "./plan.logic";
export * from "./status.logic";
export * from "./roster.logic";
export * from "./title.logic";
export * from "./timeline-position";
export * from "./keybindings.logic";
