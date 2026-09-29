import "./styles/globals.css";

// Root
export { OrquesterApp, type OrquesterAppProps } from "./OrquesterApp";

// Context
export {
  OrquesterProvider,
  useOrquester,
  useApi,
  type OrquesterContextValue,
  type WindowControls
} from "./context/orquester-context";

// Connection layer
export { ApiClient, ApiError, WorkflowApiError, type ApiRequestOptions } from "./lib/api-client";
export {
  type Transporter,
  type TransportRequest,
  type TransportResponse,
  type TransportMethod,
  type BinaryBody,
  type StreamHandle,
  type StreamHandlers,
  buildQueryString
} from "./lib/transporter";
export {
  FetchHttpClient,
  type HttpClient,
  type HttpClientRequest,
  type HttpClientResponse,
  type HttpClientBytesResponse,
  type HttpClientStreamHandlers,
  type HttpClientStreamHandle
} from "./lib/http-client";
export {
  createTransporter,
  HttpTransporter,
  type HttpTransporterOptions,
  type CreateTransporterOptions
} from "./lib/transporters";
export { toUiConnection, toRemoteConfig } from "./lib/connections";
export {
  createLocalStorageAppConfigAdapter,
  type AppConfigAdapter
} from "./lib/app-config";
export type { RemoteConnectionConfig, AppConfig, DaemonConfig } from "@orquester/config";

// State & data
export {
  useAppStore,
  useProjectTabs,
  useActiveTabId,
  type AppState,
  type FileTab,
  type ProjectTab,
  type WorkflowTab
} from "./store/app";
// Automated workflows (the rail's module store, its hooks, the editor tab)
export {
  applyWorkflowsEvent,
  loadWorkflowRun,
  loadWorkflowRuns,
  loadWorkflows,
  loadWorkflowSecrets,
  markWorkflowsStale,
  resetWorkflows,
  workflowsStore,
  type WorkflowRunEntry,
  type WorkflowRunsList,
  type WorkflowsApi,
  type WorkflowsState
} from "./lib/workflows/store";
export {
  useWorkflowRun,
  useWorkflowRuns,
  useWorkflows,
  useWorkflowSecrets,
  useWorkflowsState
} from "./lib/workflows/hooks";
export * from "./components/workflows";
// Automated workflows — seeing runs: the run view's components, its pure helpers, the notifications
export * from "./components/workflows/runs";
export * from "./lib/workflows/run-view";
export * from "./lib/workflows/json-tree";
export {
  attentionEntryFor,
  dismissWorkflowAttention,
  dismissWorkflowToasts,
  finishedRunNotice,
  markWorkflowRunViewed,
  notifyPrefsOf,
  notifyWorkflowRunFinished,
  observeWorkflowRunEvent,
  resetWorkflowNotifications,
  runOutcomeKind,
  workflowNotificationsStore,
  type WorkflowAttentionEntry,
  type WorkflowNotificationsState,
  type WorkflowNotifyPrefs,
  type WorkflowRunNotice
} from "./lib/workflows/notifications";
// The workflow editor's state and pure helpers (the run view and the phone Steps view reuse them)
export {
  WorkflowEditor,
  workflowEditorFor,
  retainWorkflowEditor,
  type WorkflowEditorState,
  type EditorSelection,
  type ChangeOptions
} from "./lib/workflows/editor-store";
export { deriveRunOverlay, type RunOverlay, type OverlayNodeState, type OverlayEdgeState } from "./lib/workflows/overlay";
export {
  nodeSummary,
  BLOCK_ICONS,
  accentClass,
  blockAccent,
  filterPalette,
  PALETTE_GROUPS,
  type NodeSummaryContext
} from "./lib/workflows/catalog-ui";
export {
  serializeWorkflowSelection,
  parseWorkflowClipboard,
  pasteWorkflowClipboard,
  duplicateWorkflowNodes
} from "./lib/workflows/clipboard";
// Automated workflows — a notification's run (the web host hands its link / message here)
export {
  parseWorkflowDeepLink,
  parseWorkflowRunMessage,
  requestWorkflowDeepLink,
  stripWorkflowDeepLink,
  WORKFLOW_RUN_MESSAGE,
  type WorkflowDeepLink
} from "./lib/workflows/deep-link";
export { pickRunId, pickBlockId, type PhoneRunPane } from "./lib/workflows/runs-mode";
export { canvasFitOptions, type CanvasFitOptions } from "./lib/workflows/canvas-fit";
export * from "./hooks";

// Components
export * from "./components/ui";
export * from "./components/layout";
export * from "./components/sidebar";
export * from "./components/topbar";
export * from "./components/main";
export * from "./components/terminal";
export * from "./components/servers";
export * from "./components/files";
export * from "./components/settings";
export * from "./components/auth";
export * from "./components/status";
// Narrow (not `export *`): the system module also exports generic helper names
// like formatBytes/formatPercent that would collide in this barrel.
export { SystemStatusChip, SystemSettings } from "./components/system";
export * from "./components/command-palette";

// Icons
export { getRegistryIcon, RegistryIcon } from "./icons";

// Types
export type {
  Runtime,
  UiConnection,
  ConnectionKind,
  ConnectionStatus,
  RegistryEntry,
  RegistryKind,
  RegistryResponse,
  SessionStatus,
  SessionSummary,
  ProjectSummary,
  WorkspaceSummary
} from "./types";
