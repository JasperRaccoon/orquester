// GENERATED — do not edit by hand. See ./README.md for the regeneration commands.
// Source: `codex app-server generate-ts --experimental` from codex-cli 0.154.0.
//
// The equivalent of T3 Code's `packages/effect-codex-app-server/src/_generated/meta.gen.ts`:
// the full method catalogue of the app-server protocol, with the params/result type of every
// client->server request, server->client request and server notification.
//
// Every value here is derived mechanically from ./protocol, so the "every method in a capture
// routes somewhere" assertion of spec §9 can be written against it.

import type { ApplyPatchApprovalParams } from "./protocol/ApplyPatchApprovalParams";
import type { ApplyPatchApprovalResponse } from "./protocol/ApplyPatchApprovalResponse";
import type { ExecCommandApprovalParams } from "./protocol/ExecCommandApprovalParams";
import type { ExecCommandApprovalResponse } from "./protocol/ExecCommandApprovalResponse";
import type { FuzzyFileSearchParams } from "./protocol/FuzzyFileSearchParams";
import type { FuzzyFileSearchResponse } from "./protocol/FuzzyFileSearchResponse";
import type { FuzzyFileSearchSessionCompletedNotification } from "./protocol/FuzzyFileSearchSessionCompletedNotification";
import type { FuzzyFileSearchSessionStartParams } from "./protocol/FuzzyFileSearchSessionStartParams";
import type { FuzzyFileSearchSessionStartResponse } from "./protocol/FuzzyFileSearchSessionStartResponse";
import type { FuzzyFileSearchSessionStopParams } from "./protocol/FuzzyFileSearchSessionStopParams";
import type { FuzzyFileSearchSessionStopResponse } from "./protocol/FuzzyFileSearchSessionStopResponse";
import type { FuzzyFileSearchSessionUpdatedNotification } from "./protocol/FuzzyFileSearchSessionUpdatedNotification";
import type { FuzzyFileSearchSessionUpdateParams } from "./protocol/FuzzyFileSearchSessionUpdateParams";
import type { FuzzyFileSearchSessionUpdateResponse } from "./protocol/FuzzyFileSearchSessionUpdateResponse";
import type { GetAuthStatusParams } from "./protocol/GetAuthStatusParams";
import type { GetAuthStatusResponse } from "./protocol/GetAuthStatusResponse";
import type { GetConversationSummaryParams } from "./protocol/GetConversationSummaryParams";
import type { GetConversationSummaryResponse } from "./protocol/GetConversationSummaryResponse";
import type { GitDiffToRemoteParams } from "./protocol/GitDiffToRemoteParams";
import type { GitDiffToRemoteResponse } from "./protocol/GitDiffToRemoteResponse";
import type { InitializeParams } from "./protocol/InitializeParams";
import type { InitializeResponse } from "./protocol/InitializeResponse";
import type { AccountLoginCompletedNotification as V2AccountLoginCompletedNotification } from "./protocol/v2/AccountLoginCompletedNotification";
import type { AccountRateLimitsUpdatedNotification as V2AccountRateLimitsUpdatedNotification } from "./protocol/v2/AccountRateLimitsUpdatedNotification";
import type { AccountUpdatedNotification as V2AccountUpdatedNotification } from "./protocol/v2/AccountUpdatedNotification";
import type { AgentMessageDeltaNotification as V2AgentMessageDeltaNotification } from "./protocol/v2/AgentMessageDeltaNotification";
import type { AppListUpdatedNotification as V2AppListUpdatedNotification } from "./protocol/v2/AppListUpdatedNotification";
import type { AppsInstalledParams as V2AppsInstalledParams } from "./protocol/v2/AppsInstalledParams";
import type { AppsInstalledResponse as V2AppsInstalledResponse } from "./protocol/v2/AppsInstalledResponse";
import type { AppsListParams as V2AppsListParams } from "./protocol/v2/AppsListParams";
import type { AppsListResponse as V2AppsListResponse } from "./protocol/v2/AppsListResponse";
import type { AppsReadParams as V2AppsReadParams } from "./protocol/v2/AppsReadParams";
import type { AppsReadResponse as V2AppsReadResponse } from "./protocol/v2/AppsReadResponse";
import type { AttestationGenerateParams as V2AttestationGenerateParams } from "./protocol/v2/AttestationGenerateParams";
import type { AttestationGenerateResponse as V2AttestationGenerateResponse } from "./protocol/v2/AttestationGenerateResponse";
import type { AuthRecoveryNotification as V2AuthRecoveryNotification } from "./protocol/v2/AuthRecoveryNotification";
import type { BedrockDiscoverParams as V2BedrockDiscoverParams } from "./protocol/v2/BedrockDiscoverParams";
import type { BedrockDiscoverResponse as V2BedrockDiscoverResponse } from "./protocol/v2/BedrockDiscoverResponse";
import type { BedrockSetupParams as V2BedrockSetupParams } from "./protocol/v2/BedrockSetupParams";
import type { BedrockSetupResponse as V2BedrockSetupResponse } from "./protocol/v2/BedrockSetupResponse";
import type { CancelLoginAccountParams as V2CancelLoginAccountParams } from "./protocol/v2/CancelLoginAccountParams";
import type { CancelLoginAccountResponse as V2CancelLoginAccountResponse } from "./protocol/v2/CancelLoginAccountResponse";
import type { ChatgptAuthTokensRefreshParams as V2ChatgptAuthTokensRefreshParams } from "./protocol/v2/ChatgptAuthTokensRefreshParams";
import type { ChatgptAuthTokensRefreshResponse as V2ChatgptAuthTokensRefreshResponse } from "./protocol/v2/ChatgptAuthTokensRefreshResponse";
import type { CollaborationModeListParams as V2CollaborationModeListParams } from "./protocol/v2/CollaborationModeListParams";
import type { CollaborationModeListResponse as V2CollaborationModeListResponse } from "./protocol/v2/CollaborationModeListResponse";
import type { CommandExecOutputDeltaNotification as V2CommandExecOutputDeltaNotification } from "./protocol/v2/CommandExecOutputDeltaNotification";
import type { CommandExecParams as V2CommandExecParams } from "./protocol/v2/CommandExecParams";
import type { CommandExecResizeParams as V2CommandExecResizeParams } from "./protocol/v2/CommandExecResizeParams";
import type { CommandExecResizeResponse as V2CommandExecResizeResponse } from "./protocol/v2/CommandExecResizeResponse";
import type { CommandExecResponse as V2CommandExecResponse } from "./protocol/v2/CommandExecResponse";
import type { CommandExecTerminateParams as V2CommandExecTerminateParams } from "./protocol/v2/CommandExecTerminateParams";
import type { CommandExecTerminateResponse as V2CommandExecTerminateResponse } from "./protocol/v2/CommandExecTerminateResponse";
import type { CommandExecutionOutputDeltaNotification as V2CommandExecutionOutputDeltaNotification } from "./protocol/v2/CommandExecutionOutputDeltaNotification";
import type { CommandExecutionRequestApprovalParams as V2CommandExecutionRequestApprovalParams } from "./protocol/v2/CommandExecutionRequestApprovalParams";
import type { CommandExecutionRequestApprovalResponse as V2CommandExecutionRequestApprovalResponse } from "./protocol/v2/CommandExecutionRequestApprovalResponse";
import type { CommandExecWriteParams as V2CommandExecWriteParams } from "./protocol/v2/CommandExecWriteParams";
import type { CommandExecWriteResponse as V2CommandExecWriteResponse } from "./protocol/v2/CommandExecWriteResponse";
import type { ConfigBatchWriteParams as V2ConfigBatchWriteParams } from "./protocol/v2/ConfigBatchWriteParams";
import type { ConfigReadParams as V2ConfigReadParams } from "./protocol/v2/ConfigReadParams";
import type { ConfigReadResponse as V2ConfigReadResponse } from "./protocol/v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse as V2ConfigRequirementsReadResponse } from "./protocol/v2/ConfigRequirementsReadResponse";
import type { ConfigValueWriteParams as V2ConfigValueWriteParams } from "./protocol/v2/ConfigValueWriteParams";
import type { ConfigWarningNotification as V2ConfigWarningNotification } from "./protocol/v2/ConfigWarningNotification";
import type { ConfigWriteResponse as V2ConfigWriteResponse } from "./protocol/v2/ConfigWriteResponse";
import type { ConsumeAccountRateLimitResetCreditParams as V2ConsumeAccountRateLimitResetCreditParams } from "./protocol/v2/ConsumeAccountRateLimitResetCreditParams";
import type { ConsumeAccountRateLimitResetCreditResponse as V2ConsumeAccountRateLimitResetCreditResponse } from "./protocol/v2/ConsumeAccountRateLimitResetCreditResponse";
import type { ContextCompactedNotification as V2ContextCompactedNotification } from "./protocol/v2/ContextCompactedNotification";
import type { CurrentTimeReadParams as V2CurrentTimeReadParams } from "./protocol/v2/CurrentTimeReadParams";
import type { CurrentTimeReadResponse as V2CurrentTimeReadResponse } from "./protocol/v2/CurrentTimeReadResponse";
import type { DeprecationNoticeNotification as V2DeprecationNoticeNotification } from "./protocol/v2/DeprecationNoticeNotification";
import type { DynamicToolCallParams as V2DynamicToolCallParams } from "./protocol/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse as V2DynamicToolCallResponse } from "./protocol/v2/DynamicToolCallResponse";
import type { EnvironmentAddParams as V2EnvironmentAddParams } from "./protocol/v2/EnvironmentAddParams";
import type { EnvironmentAddResponse as V2EnvironmentAddResponse } from "./protocol/v2/EnvironmentAddResponse";
import type { EnvironmentConnectionNotification as V2EnvironmentConnectionNotification } from "./protocol/v2/EnvironmentConnectionNotification";
import type { EnvironmentInfoParams as V2EnvironmentInfoParams } from "./protocol/v2/EnvironmentInfoParams";
import type { EnvironmentInfoResponse as V2EnvironmentInfoResponse } from "./protocol/v2/EnvironmentInfoResponse";
import type { EnvironmentStatusParams as V2EnvironmentStatusParams } from "./protocol/v2/EnvironmentStatusParams";
import type { EnvironmentStatusResponse as V2EnvironmentStatusResponse } from "./protocol/v2/EnvironmentStatusResponse";
import type { ErrorNotification as V2ErrorNotification } from "./protocol/v2/ErrorNotification";
import type { ExperimentalFeatureEnablementSetParams as V2ExperimentalFeatureEnablementSetParams } from "./protocol/v2/ExperimentalFeatureEnablementSetParams";
import type { ExperimentalFeatureEnablementSetResponse as V2ExperimentalFeatureEnablementSetResponse } from "./protocol/v2/ExperimentalFeatureEnablementSetResponse";
import type { ExperimentalFeatureListParams as V2ExperimentalFeatureListParams } from "./protocol/v2/ExperimentalFeatureListParams";
import type { ExperimentalFeatureListResponse as V2ExperimentalFeatureListResponse } from "./protocol/v2/ExperimentalFeatureListResponse";
import type { ExternalAgentConfigDetectParams as V2ExternalAgentConfigDetectParams } from "./protocol/v2/ExternalAgentConfigDetectParams";
import type { ExternalAgentConfigDetectResponse as V2ExternalAgentConfigDetectResponse } from "./protocol/v2/ExternalAgentConfigDetectResponse";
import type { ExternalAgentConfigImportCompletedNotification as V2ExternalAgentConfigImportCompletedNotification } from "./protocol/v2/ExternalAgentConfigImportCompletedNotification";
import type { ExternalAgentConfigImportHistoriesReadResponse as V2ExternalAgentConfigImportHistoriesReadResponse } from "./protocol/v2/ExternalAgentConfigImportHistoriesReadResponse";
import type { ExternalAgentConfigImportHistoryRecordParams as V2ExternalAgentConfigImportHistoryRecordParams } from "./protocol/v2/ExternalAgentConfigImportHistoryRecordParams";
import type { ExternalAgentConfigImportHistoryRecordResponse as V2ExternalAgentConfigImportHistoryRecordResponse } from "./protocol/v2/ExternalAgentConfigImportHistoryRecordResponse";
import type { ExternalAgentConfigImportParams as V2ExternalAgentConfigImportParams } from "./protocol/v2/ExternalAgentConfigImportParams";
import type { ExternalAgentConfigImportProgressNotification as V2ExternalAgentConfigImportProgressNotification } from "./protocol/v2/ExternalAgentConfigImportProgressNotification";
import type { ExternalAgentConfigImportResponse as V2ExternalAgentConfigImportResponse } from "./protocol/v2/ExternalAgentConfigImportResponse";
import type { FeedbackUploadParams as V2FeedbackUploadParams } from "./protocol/v2/FeedbackUploadParams";
import type { FeedbackUploadResponse as V2FeedbackUploadResponse } from "./protocol/v2/FeedbackUploadResponse";
import type { FileChangeOutputDeltaNotification as V2FileChangeOutputDeltaNotification } from "./protocol/v2/FileChangeOutputDeltaNotification";
import type { FileChangePatchUpdatedNotification as V2FileChangePatchUpdatedNotification } from "./protocol/v2/FileChangePatchUpdatedNotification";
import type { FileChangeRequestApprovalParams as V2FileChangeRequestApprovalParams } from "./protocol/v2/FileChangeRequestApprovalParams";
import type { FileChangeRequestApprovalResponse as V2FileChangeRequestApprovalResponse } from "./protocol/v2/FileChangeRequestApprovalResponse";
import type { FsChangedNotification as V2FsChangedNotification } from "./protocol/v2/FsChangedNotification";
import type { FsCopyParams as V2FsCopyParams } from "./protocol/v2/FsCopyParams";
import type { FsCopyResponse as V2FsCopyResponse } from "./protocol/v2/FsCopyResponse";
import type { FsCreateDirectoryParams as V2FsCreateDirectoryParams } from "./protocol/v2/FsCreateDirectoryParams";
import type { FsCreateDirectoryResponse as V2FsCreateDirectoryResponse } from "./protocol/v2/FsCreateDirectoryResponse";
import type { FsGetMetadataParams as V2FsGetMetadataParams } from "./protocol/v2/FsGetMetadataParams";
import type { FsGetMetadataResponse as V2FsGetMetadataResponse } from "./protocol/v2/FsGetMetadataResponse";
import type { FsReadDirectoryParams as V2FsReadDirectoryParams } from "./protocol/v2/FsReadDirectoryParams";
import type { FsReadDirectoryResponse as V2FsReadDirectoryResponse } from "./protocol/v2/FsReadDirectoryResponse";
import type { FsReadFileParams as V2FsReadFileParams } from "./protocol/v2/FsReadFileParams";
import type { FsReadFileResponse as V2FsReadFileResponse } from "./protocol/v2/FsReadFileResponse";
import type { FsRemoveParams as V2FsRemoveParams } from "./protocol/v2/FsRemoveParams";
import type { FsRemoveResponse as V2FsRemoveResponse } from "./protocol/v2/FsRemoveResponse";
import type { FsUnwatchParams as V2FsUnwatchParams } from "./protocol/v2/FsUnwatchParams";
import type { FsUnwatchResponse as V2FsUnwatchResponse } from "./protocol/v2/FsUnwatchResponse";
import type { FsWatchParams as V2FsWatchParams } from "./protocol/v2/FsWatchParams";
import type { FsWatchResponse as V2FsWatchResponse } from "./protocol/v2/FsWatchResponse";
import type { FsWriteFileParams as V2FsWriteFileParams } from "./protocol/v2/FsWriteFileParams";
import type { FsWriteFileResponse as V2FsWriteFileResponse } from "./protocol/v2/FsWriteFileResponse";
import type { GetAccountParams as V2GetAccountParams } from "./protocol/v2/GetAccountParams";
import type { GetAccountRateLimitsParams as V2GetAccountRateLimitsParams } from "./protocol/v2/GetAccountRateLimitsParams";
import type { GetAccountRateLimitsResponse as V2GetAccountRateLimitsResponse } from "./protocol/v2/GetAccountRateLimitsResponse";
import type { GetAccountResponse as V2GetAccountResponse } from "./protocol/v2/GetAccountResponse";
import type { GetAccountTokenUsageParams as V2GetAccountTokenUsageParams } from "./protocol/v2/GetAccountTokenUsageParams";
import type { GetAccountTokenUsageResponse as V2GetAccountTokenUsageResponse } from "./protocol/v2/GetAccountTokenUsageResponse";
import type { GetWorkspaceMessagesResponse as V2GetWorkspaceMessagesResponse } from "./protocol/v2/GetWorkspaceMessagesResponse";
import type { GuardianWarningNotification as V2GuardianWarningNotification } from "./protocol/v2/GuardianWarningNotification";
import type { HookCompletedNotification as V2HookCompletedNotification } from "./protocol/v2/HookCompletedNotification";
import type { HooksListParams as V2HooksListParams } from "./protocol/v2/HooksListParams";
import type { HooksListResponse as V2HooksListResponse } from "./protocol/v2/HooksListResponse";
import type { HookStartedNotification as V2HookStartedNotification } from "./protocol/v2/HookStartedNotification";
import type { ItemCompletedNotification as V2ItemCompletedNotification } from "./protocol/v2/ItemCompletedNotification";
import type { ItemGuardianApprovalReviewCompletedNotification as V2ItemGuardianApprovalReviewCompletedNotification } from "./protocol/v2/ItemGuardianApprovalReviewCompletedNotification";
import type { ItemGuardianApprovalReviewStartedNotification as V2ItemGuardianApprovalReviewStartedNotification } from "./protocol/v2/ItemGuardianApprovalReviewStartedNotification";
import type { ItemStartedNotification as V2ItemStartedNotification } from "./protocol/v2/ItemStartedNotification";
import type { ListMcpServerStatusParams as V2ListMcpServerStatusParams } from "./protocol/v2/ListMcpServerStatusParams";
import type { ListMcpServerStatusResponse as V2ListMcpServerStatusResponse } from "./protocol/v2/ListMcpServerStatusResponse";
import type { LoginAccountParams as V2LoginAccountParams } from "./protocol/v2/LoginAccountParams";
import type { LoginAccountResponse as V2LoginAccountResponse } from "./protocol/v2/LoginAccountResponse";
import type { LogoutAccountResponse as V2LogoutAccountResponse } from "./protocol/v2/LogoutAccountResponse";
import type { MarketplaceAddParams as V2MarketplaceAddParams } from "./protocol/v2/MarketplaceAddParams";
import type { MarketplaceAddResponse as V2MarketplaceAddResponse } from "./protocol/v2/MarketplaceAddResponse";
import type { MarketplaceRemoveParams as V2MarketplaceRemoveParams } from "./protocol/v2/MarketplaceRemoveParams";
import type { MarketplaceRemoveResponse as V2MarketplaceRemoveResponse } from "./protocol/v2/MarketplaceRemoveResponse";
import type { MarketplaceUpgradeParams as V2MarketplaceUpgradeParams } from "./protocol/v2/MarketplaceUpgradeParams";
import type { MarketplaceUpgradeResponse as V2MarketplaceUpgradeResponse } from "./protocol/v2/MarketplaceUpgradeResponse";
import type { McpResourceReadParams as V2McpResourceReadParams } from "./protocol/v2/McpResourceReadParams";
import type { McpResourceReadResponse as V2McpResourceReadResponse } from "./protocol/v2/McpResourceReadResponse";
import type { McpServerElicitationRequestParams as V2McpServerElicitationRequestParams } from "./protocol/v2/McpServerElicitationRequestParams";
import type { McpServerElicitationRequestResponse as V2McpServerElicitationRequestResponse } from "./protocol/v2/McpServerElicitationRequestResponse";
import type { McpServerEventStreamNotification as V2McpServerEventStreamNotification } from "./protocol/v2/McpServerEventStreamNotification";
import type { McpServerEventStreamStartParams as V2McpServerEventStreamStartParams } from "./protocol/v2/McpServerEventStreamStartParams";
import type { McpServerEventStreamStartResponse as V2McpServerEventStreamStartResponse } from "./protocol/v2/McpServerEventStreamStartResponse";
import type { McpServerEventStreamStopParams as V2McpServerEventStreamStopParams } from "./protocol/v2/McpServerEventStreamStopParams";
import type { McpServerEventStreamStopResponse as V2McpServerEventStreamStopResponse } from "./protocol/v2/McpServerEventStreamStopResponse";
import type { McpServerOauthLoginCompletedNotification as V2McpServerOauthLoginCompletedNotification } from "./protocol/v2/McpServerOauthLoginCompletedNotification";
import type { McpServerOauthLoginParams as V2McpServerOauthLoginParams } from "./protocol/v2/McpServerOauthLoginParams";
import type { McpServerOauthLoginResponse as V2McpServerOauthLoginResponse } from "./protocol/v2/McpServerOauthLoginResponse";
import type { McpServerRefreshResponse as V2McpServerRefreshResponse } from "./protocol/v2/McpServerRefreshResponse";
import type { McpServerStatusUpdatedNotification as V2McpServerStatusUpdatedNotification } from "./protocol/v2/McpServerStatusUpdatedNotification";
import type { McpServerToolCallParams as V2McpServerToolCallParams } from "./protocol/v2/McpServerToolCallParams";
import type { McpServerToolCallResponse as V2McpServerToolCallResponse } from "./protocol/v2/McpServerToolCallResponse";
import type { McpToolCallProgressNotification as V2McpToolCallProgressNotification } from "./protocol/v2/McpToolCallProgressNotification";
import type { MemoryResetResponse as V2MemoryResetResponse } from "./protocol/v2/MemoryResetResponse";
import type { MockExperimentalMethodParams as V2MockExperimentalMethodParams } from "./protocol/v2/MockExperimentalMethodParams";
import type { MockExperimentalMethodResponse as V2MockExperimentalMethodResponse } from "./protocol/v2/MockExperimentalMethodResponse";
import type { ModelListParams as V2ModelListParams } from "./protocol/v2/ModelListParams";
import type { ModelListResponse as V2ModelListResponse } from "./protocol/v2/ModelListResponse";
import type { ModelProviderCapabilitiesReadParams as V2ModelProviderCapabilitiesReadParams } from "./protocol/v2/ModelProviderCapabilitiesReadParams";
import type { ModelProviderCapabilitiesReadResponse as V2ModelProviderCapabilitiesReadResponse } from "./protocol/v2/ModelProviderCapabilitiesReadResponse";
import type { ModelReroutedNotification as V2ModelReroutedNotification } from "./protocol/v2/ModelReroutedNotification";
import type { ModelSafetyBufferingUpdatedNotification as V2ModelSafetyBufferingUpdatedNotification } from "./protocol/v2/ModelSafetyBufferingUpdatedNotification";
import type { ModelVerificationNotification as V2ModelVerificationNotification } from "./protocol/v2/ModelVerificationNotification";
import type { PermissionProfileListParams as V2PermissionProfileListParams } from "./protocol/v2/PermissionProfileListParams";
import type { PermissionProfileListResponse as V2PermissionProfileListResponse } from "./protocol/v2/PermissionProfileListResponse";
import type { PermissionsRequestApprovalParams as V2PermissionsRequestApprovalParams } from "./protocol/v2/PermissionsRequestApprovalParams";
import type { PermissionsRequestApprovalResponse as V2PermissionsRequestApprovalResponse } from "./protocol/v2/PermissionsRequestApprovalResponse";
import type { PlanDeltaNotification as V2PlanDeltaNotification } from "./protocol/v2/PlanDeltaNotification";
import type { PluginInstalledParams as V2PluginInstalledParams } from "./protocol/v2/PluginInstalledParams";
import type { PluginInstalledResponse as V2PluginInstalledResponse } from "./protocol/v2/PluginInstalledResponse";
import type { PluginInstallParams as V2PluginInstallParams } from "./protocol/v2/PluginInstallParams";
import type { PluginInstallResponse as V2PluginInstallResponse } from "./protocol/v2/PluginInstallResponse";
import type { PluginListParams as V2PluginListParams } from "./protocol/v2/PluginListParams";
import type { PluginListResponse as V2PluginListResponse } from "./protocol/v2/PluginListResponse";
import type { PluginReadParams as V2PluginReadParams } from "./protocol/v2/PluginReadParams";
import type { PluginReadResponse as V2PluginReadResponse } from "./protocol/v2/PluginReadResponse";
import type { PluginReconcileParams as V2PluginReconcileParams } from "./protocol/v2/PluginReconcileParams";
import type { PluginReconcileResponse as V2PluginReconcileResponse } from "./protocol/v2/PluginReconcileResponse";
import type { PluginSearchParams as V2PluginSearchParams } from "./protocol/v2/PluginSearchParams";
import type { PluginSearchResponse as V2PluginSearchResponse } from "./protocol/v2/PluginSearchResponse";
import type { PluginShareCheckoutParams as V2PluginShareCheckoutParams } from "./protocol/v2/PluginShareCheckoutParams";
import type { PluginShareCheckoutResponse as V2PluginShareCheckoutResponse } from "./protocol/v2/PluginShareCheckoutResponse";
import type { PluginShareDeleteParams as V2PluginShareDeleteParams } from "./protocol/v2/PluginShareDeleteParams";
import type { PluginShareDeleteResponse as V2PluginShareDeleteResponse } from "./protocol/v2/PluginShareDeleteResponse";
import type { PluginShareListParams as V2PluginShareListParams } from "./protocol/v2/PluginShareListParams";
import type { PluginShareListResponse as V2PluginShareListResponse } from "./protocol/v2/PluginShareListResponse";
import type { PluginShareSaveParams as V2PluginShareSaveParams } from "./protocol/v2/PluginShareSaveParams";
import type { PluginShareSaveResponse as V2PluginShareSaveResponse } from "./protocol/v2/PluginShareSaveResponse";
import type { PluginShareUpdateTargetsParams as V2PluginShareUpdateTargetsParams } from "./protocol/v2/PluginShareUpdateTargetsParams";
import type { PluginShareUpdateTargetsResponse as V2PluginShareUpdateTargetsResponse } from "./protocol/v2/PluginShareUpdateTargetsResponse";
import type { PluginSkillReadParams as V2PluginSkillReadParams } from "./protocol/v2/PluginSkillReadParams";
import type { PluginSkillReadResponse as V2PluginSkillReadResponse } from "./protocol/v2/PluginSkillReadResponse";
import type { PluginUninstallParams as V2PluginUninstallParams } from "./protocol/v2/PluginUninstallParams";
import type { PluginUninstallResponse as V2PluginUninstallResponse } from "./protocol/v2/PluginUninstallResponse";
import type { ProcessExitedNotification as V2ProcessExitedNotification } from "./protocol/v2/ProcessExitedNotification";
import type { ProcessKillParams as V2ProcessKillParams } from "./protocol/v2/ProcessKillParams";
import type { ProcessKillResponse as V2ProcessKillResponse } from "./protocol/v2/ProcessKillResponse";
import type { ProcessOutputDeltaNotification as V2ProcessOutputDeltaNotification } from "./protocol/v2/ProcessOutputDeltaNotification";
import type { ProcessResizePtyParams as V2ProcessResizePtyParams } from "./protocol/v2/ProcessResizePtyParams";
import type { ProcessResizePtyResponse as V2ProcessResizePtyResponse } from "./protocol/v2/ProcessResizePtyResponse";
import type { ProcessSpawnParams as V2ProcessSpawnParams } from "./protocol/v2/ProcessSpawnParams";
import type { ProcessSpawnResponse as V2ProcessSpawnResponse } from "./protocol/v2/ProcessSpawnResponse";
import type { ProcessWriteStdinParams as V2ProcessWriteStdinParams } from "./protocol/v2/ProcessWriteStdinParams";
import type { ProcessWriteStdinResponse as V2ProcessWriteStdinResponse } from "./protocol/v2/ProcessWriteStdinResponse";
import type { ProjectChangedNotification as V2ProjectChangedNotification } from "./protocol/v2/ProjectChangedNotification";
import type { ProjectCreateParams as V2ProjectCreateParams } from "./protocol/v2/ProjectCreateParams";
import type { ProjectCreateResponse as V2ProjectCreateResponse } from "./protocol/v2/ProjectCreateResponse";
import type { ProjectDeleteParams as V2ProjectDeleteParams } from "./protocol/v2/ProjectDeleteParams";
import type { ProjectDeleteResponse as V2ProjectDeleteResponse } from "./protocol/v2/ProjectDeleteResponse";
import type { ProjectImportParams as V2ProjectImportParams } from "./protocol/v2/ProjectImportParams";
import type { ProjectImportResponse as V2ProjectImportResponse } from "./protocol/v2/ProjectImportResponse";
import type { ProjectListParams as V2ProjectListParams } from "./protocol/v2/ProjectListParams";
import type { ProjectListResponse as V2ProjectListResponse } from "./protocol/v2/ProjectListResponse";
import type { ProjectMoveParams as V2ProjectMoveParams } from "./protocol/v2/ProjectMoveParams";
import type { ProjectMoveResponse as V2ProjectMoveResponse } from "./protocol/v2/ProjectMoveResponse";
import type { ProjectReadParams as V2ProjectReadParams } from "./protocol/v2/ProjectReadParams";
import type { ProjectReadResponse as V2ProjectReadResponse } from "./protocol/v2/ProjectReadResponse";
import type { ProjectUpdateParams as V2ProjectUpdateParams } from "./protocol/v2/ProjectUpdateParams";
import type { ProjectUpdateResponse as V2ProjectUpdateResponse } from "./protocol/v2/ProjectUpdateResponse";
import type { RawResponseCompletedNotification as V2RawResponseCompletedNotification } from "./protocol/v2/RawResponseCompletedNotification";
import type { RawResponseItemCompletedNotification as V2RawResponseItemCompletedNotification } from "./protocol/v2/RawResponseItemCompletedNotification";
import type { ReasoningSummaryPartAddedNotification as V2ReasoningSummaryPartAddedNotification } from "./protocol/v2/ReasoningSummaryPartAddedNotification";
import type { ReasoningSummaryTextDeltaNotification as V2ReasoningSummaryTextDeltaNotification } from "./protocol/v2/ReasoningSummaryTextDeltaNotification";
import type { ReasoningTextDeltaNotification as V2ReasoningTextDeltaNotification } from "./protocol/v2/ReasoningTextDeltaNotification";
import type { RemoteControlClientsListParams as V2RemoteControlClientsListParams } from "./protocol/v2/RemoteControlClientsListParams";
import type { RemoteControlClientsListResponse as V2RemoteControlClientsListResponse } from "./protocol/v2/RemoteControlClientsListResponse";
import type { RemoteControlClientsRevokeParams as V2RemoteControlClientsRevokeParams } from "./protocol/v2/RemoteControlClientsRevokeParams";
import type { RemoteControlClientsRevokeResponse as V2RemoteControlClientsRevokeResponse } from "./protocol/v2/RemoteControlClientsRevokeResponse";
import type { RemoteControlPairingStartParams as V2RemoteControlPairingStartParams } from "./protocol/v2/RemoteControlPairingStartParams";
import type { RemoteControlPairingStartResponse as V2RemoteControlPairingStartResponse } from "./protocol/v2/RemoteControlPairingStartResponse";
import type { RemoteControlPairingStatusParams as V2RemoteControlPairingStatusParams } from "./protocol/v2/RemoteControlPairingStatusParams";
import type { RemoteControlPairingStatusResponse as V2RemoteControlPairingStatusResponse } from "./protocol/v2/RemoteControlPairingStatusResponse";
import type { RemoteControlStatusChangedNotification as V2RemoteControlStatusChangedNotification } from "./protocol/v2/RemoteControlStatusChangedNotification";
import type { RemoteControlStatusReadResponse as V2RemoteControlStatusReadResponse } from "./protocol/v2/RemoteControlStatusReadResponse";
import type { ReviewStartParams as V2ReviewStartParams } from "./protocol/v2/ReviewStartParams";
import type { ReviewStartResponse as V2ReviewStartResponse } from "./protocol/v2/ReviewStartResponse";
import type { SendAddCreditsNudgeEmailParams as V2SendAddCreditsNudgeEmailParams } from "./protocol/v2/SendAddCreditsNudgeEmailParams";
import type { SendAddCreditsNudgeEmailResponse as V2SendAddCreditsNudgeEmailResponse } from "./protocol/v2/SendAddCreditsNudgeEmailResponse";
import type { ServerDiagnosticsParams as V2ServerDiagnosticsParams } from "./protocol/v2/ServerDiagnosticsParams";
import type { ServerDiagnosticsResponse as V2ServerDiagnosticsResponse } from "./protocol/v2/ServerDiagnosticsResponse";
import type { ServerRequestResolvedNotification as V2ServerRequestResolvedNotification } from "./protocol/v2/ServerRequestResolvedNotification";
import type { SkillsChangedNotification as V2SkillsChangedNotification } from "./protocol/v2/SkillsChangedNotification";
import type { SkillsConfigWriteParams as V2SkillsConfigWriteParams } from "./protocol/v2/SkillsConfigWriteParams";
import type { SkillsConfigWriteResponse as V2SkillsConfigWriteResponse } from "./protocol/v2/SkillsConfigWriteResponse";
import type { SkillsExtraRootsSetParams as V2SkillsExtraRootsSetParams } from "./protocol/v2/SkillsExtraRootsSetParams";
import type { SkillsExtraRootsSetResponse as V2SkillsExtraRootsSetResponse } from "./protocol/v2/SkillsExtraRootsSetResponse";
import type { SkillsListParams as V2SkillsListParams } from "./protocol/v2/SkillsListParams";
import type { SkillsListResponse as V2SkillsListResponse } from "./protocol/v2/SkillsListResponse";
import type { StrictReviewRequiredNotification as V2StrictReviewRequiredNotification } from "./protocol/v2/StrictReviewRequiredNotification";
import type { TerminalInteractionNotification as V2TerminalInteractionNotification } from "./protocol/v2/TerminalInteractionNotification";
import type { ThreadApproveGuardianDeniedActionParams as V2ThreadApproveGuardianDeniedActionParams } from "./protocol/v2/ThreadApproveGuardianDeniedActionParams";
import type { ThreadApproveGuardianDeniedActionResponse as V2ThreadApproveGuardianDeniedActionResponse } from "./protocol/v2/ThreadApproveGuardianDeniedActionResponse";
import type { ThreadArchivedNotification as V2ThreadArchivedNotification } from "./protocol/v2/ThreadArchivedNotification";
import type { ThreadArchiveParams as V2ThreadArchiveParams } from "./protocol/v2/ThreadArchiveParams";
import type { ThreadArchiveResponse as V2ThreadArchiveResponse } from "./protocol/v2/ThreadArchiveResponse";
import type { ThreadBackgroundTerminalsCleanParams as V2ThreadBackgroundTerminalsCleanParams } from "./protocol/v2/ThreadBackgroundTerminalsCleanParams";
import type { ThreadBackgroundTerminalsCleanResponse as V2ThreadBackgroundTerminalsCleanResponse } from "./protocol/v2/ThreadBackgroundTerminalsCleanResponse";
import type { ThreadBackgroundTerminalsListParams as V2ThreadBackgroundTerminalsListParams } from "./protocol/v2/ThreadBackgroundTerminalsListParams";
import type { ThreadBackgroundTerminalsListResponse as V2ThreadBackgroundTerminalsListResponse } from "./protocol/v2/ThreadBackgroundTerminalsListResponse";
import type { ThreadBackgroundTerminalsTerminateParams as V2ThreadBackgroundTerminalsTerminateParams } from "./protocol/v2/ThreadBackgroundTerminalsTerminateParams";
import type { ThreadBackgroundTerminalsTerminateResponse as V2ThreadBackgroundTerminalsTerminateResponse } from "./protocol/v2/ThreadBackgroundTerminalsTerminateResponse";
import type { ThreadClosedNotification as V2ThreadClosedNotification } from "./protocol/v2/ThreadClosedNotification";
import type { ThreadCompactStartParams as V2ThreadCompactStartParams } from "./protocol/v2/ThreadCompactStartParams";
import type { ThreadCompactStartResponse as V2ThreadCompactStartResponse } from "./protocol/v2/ThreadCompactStartResponse";
import type { ThreadDecrementElicitationParams as V2ThreadDecrementElicitationParams } from "./protocol/v2/ThreadDecrementElicitationParams";
import type { ThreadDecrementElicitationResponse as V2ThreadDecrementElicitationResponse } from "./protocol/v2/ThreadDecrementElicitationResponse";
import type { ThreadDeletedNotification as V2ThreadDeletedNotification } from "./protocol/v2/ThreadDeletedNotification";
import type { ThreadDeleteParams as V2ThreadDeleteParams } from "./protocol/v2/ThreadDeleteParams";
import type { ThreadDeleteResponse as V2ThreadDeleteResponse } from "./protocol/v2/ThreadDeleteResponse";
import type { ThreadForkParams as V2ThreadForkParams } from "./protocol/v2/ThreadForkParams";
import type { ThreadForkResponse as V2ThreadForkResponse } from "./protocol/v2/ThreadForkResponse";
import type { ThreadGoalClearedNotification as V2ThreadGoalClearedNotification } from "./protocol/v2/ThreadGoalClearedNotification";
import type { ThreadGoalClearParams as V2ThreadGoalClearParams } from "./protocol/v2/ThreadGoalClearParams";
import type { ThreadGoalClearResponse as V2ThreadGoalClearResponse } from "./protocol/v2/ThreadGoalClearResponse";
import type { ThreadGoalGetParams as V2ThreadGoalGetParams } from "./protocol/v2/ThreadGoalGetParams";
import type { ThreadGoalGetResponse as V2ThreadGoalGetResponse } from "./protocol/v2/ThreadGoalGetResponse";
import type { ThreadGoalSetParams as V2ThreadGoalSetParams } from "./protocol/v2/ThreadGoalSetParams";
import type { ThreadGoalSetResponse as V2ThreadGoalSetResponse } from "./protocol/v2/ThreadGoalSetResponse";
import type { ThreadGoalUpdatedNotification as V2ThreadGoalUpdatedNotification } from "./protocol/v2/ThreadGoalUpdatedNotification";
import type { ThreadIncrementElicitationParams as V2ThreadIncrementElicitationParams } from "./protocol/v2/ThreadIncrementElicitationParams";
import type { ThreadIncrementElicitationResponse as V2ThreadIncrementElicitationResponse } from "./protocol/v2/ThreadIncrementElicitationResponse";
import type { ThreadInjectItemsParams as V2ThreadInjectItemsParams } from "./protocol/v2/ThreadInjectItemsParams";
import type { ThreadInjectItemsResponse as V2ThreadInjectItemsResponse } from "./protocol/v2/ThreadInjectItemsResponse";
import type { ThreadItemsListParams as V2ThreadItemsListParams } from "./protocol/v2/ThreadItemsListParams";
import type { ThreadItemsListResponse as V2ThreadItemsListResponse } from "./protocol/v2/ThreadItemsListResponse";
import type { ThreadListParams as V2ThreadListParams } from "./protocol/v2/ThreadListParams";
import type { ThreadListResponse as V2ThreadListResponse } from "./protocol/v2/ThreadListResponse";
import type { ThreadLoadedListParams as V2ThreadLoadedListParams } from "./protocol/v2/ThreadLoadedListParams";
import type { ThreadLoadedListResponse as V2ThreadLoadedListResponse } from "./protocol/v2/ThreadLoadedListResponse";
import type { ThreadMemoryModeSetParams as V2ThreadMemoryModeSetParams } from "./protocol/v2/ThreadMemoryModeSetParams";
import type { ThreadMemoryModeSetResponse as V2ThreadMemoryModeSetResponse } from "./protocol/v2/ThreadMemoryModeSetResponse";
import type { ThreadMetadataUpdateParams as V2ThreadMetadataUpdateParams } from "./protocol/v2/ThreadMetadataUpdateParams";
import type { ThreadMetadataUpdateResponse as V2ThreadMetadataUpdateResponse } from "./protocol/v2/ThreadMetadataUpdateResponse";
import type { ThreadNameUpdatedNotification as V2ThreadNameUpdatedNotification } from "./protocol/v2/ThreadNameUpdatedNotification";
import type { ThreadProjectUpdatedNotification as V2ThreadProjectUpdatedNotification } from "./protocol/v2/ThreadProjectUpdatedNotification";
import type { ThreadQueueAddParams as V2ThreadQueueAddParams } from "./protocol/v2/ThreadQueueAddParams";
import type { ThreadQueueAddResponse as V2ThreadQueueAddResponse } from "./protocol/v2/ThreadQueueAddResponse";
import type { ThreadQueueChangedNotification as V2ThreadQueueChangedNotification } from "./protocol/v2/ThreadQueueChangedNotification";
import type { ThreadQueueDeleteParams as V2ThreadQueueDeleteParams } from "./protocol/v2/ThreadQueueDeleteParams";
import type { ThreadQueueDeleteResponse as V2ThreadQueueDeleteResponse } from "./protocol/v2/ThreadQueueDeleteResponse";
import type { ThreadQueueListParams as V2ThreadQueueListParams } from "./protocol/v2/ThreadQueueListParams";
import type { ThreadQueueListResponse as V2ThreadQueueListResponse } from "./protocol/v2/ThreadQueueListResponse";
import type { ThreadQueueReorderParams as V2ThreadQueueReorderParams } from "./protocol/v2/ThreadQueueReorderParams";
import type { ThreadQueueReorderResponse as V2ThreadQueueReorderResponse } from "./protocol/v2/ThreadQueueReorderResponse";
import type { ThreadQueueStartParams as V2ThreadQueueStartParams } from "./protocol/v2/ThreadQueueStartParams";
import type { ThreadQueueStartResponse as V2ThreadQueueStartResponse } from "./protocol/v2/ThreadQueueStartResponse";
import type { ThreadQueueUpdateParams as V2ThreadQueueUpdateParams } from "./protocol/v2/ThreadQueueUpdateParams";
import type { ThreadQueueUpdateResponse as V2ThreadQueueUpdateResponse } from "./protocol/v2/ThreadQueueUpdateResponse";
import type { ThreadReadParams as V2ThreadReadParams } from "./protocol/v2/ThreadReadParams";
import type { ThreadReadResponse as V2ThreadReadResponse } from "./protocol/v2/ThreadReadResponse";
import type { ThreadRealtimeAppendAudioParams as V2ThreadRealtimeAppendAudioParams } from "./protocol/v2/ThreadRealtimeAppendAudioParams";
import type { ThreadRealtimeAppendAudioResponse as V2ThreadRealtimeAppendAudioResponse } from "./protocol/v2/ThreadRealtimeAppendAudioResponse";
import type { ThreadRealtimeAppendSpeechParams as V2ThreadRealtimeAppendSpeechParams } from "./protocol/v2/ThreadRealtimeAppendSpeechParams";
import type { ThreadRealtimeAppendSpeechResponse as V2ThreadRealtimeAppendSpeechResponse } from "./protocol/v2/ThreadRealtimeAppendSpeechResponse";
import type { ThreadRealtimeAppendTextParams as V2ThreadRealtimeAppendTextParams } from "./protocol/v2/ThreadRealtimeAppendTextParams";
import type { ThreadRealtimeAppendTextResponse as V2ThreadRealtimeAppendTextResponse } from "./protocol/v2/ThreadRealtimeAppendTextResponse";
import type { ThreadRealtimeClosedNotification as V2ThreadRealtimeClosedNotification } from "./protocol/v2/ThreadRealtimeClosedNotification";
import type { ThreadRealtimeErrorNotification as V2ThreadRealtimeErrorNotification } from "./protocol/v2/ThreadRealtimeErrorNotification";
import type { ThreadRealtimeItemAddedNotification as V2ThreadRealtimeItemAddedNotification } from "./protocol/v2/ThreadRealtimeItemAddedNotification";
import type { ThreadRealtimeItemCompletedNotification as V2ThreadRealtimeItemCompletedNotification } from "./protocol/v2/ThreadRealtimeItemCompletedNotification";
import type { ThreadRealtimeItemStartedNotification as V2ThreadRealtimeItemStartedNotification } from "./protocol/v2/ThreadRealtimeItemStartedNotification";
import type { ThreadRealtimeItemTranscriptDeltaNotification as V2ThreadRealtimeItemTranscriptDeltaNotification } from "./protocol/v2/ThreadRealtimeItemTranscriptDeltaNotification";
import type { ThreadRealtimeListVoicesParams as V2ThreadRealtimeListVoicesParams } from "./protocol/v2/ThreadRealtimeListVoicesParams";
import type { ThreadRealtimeListVoicesResponse as V2ThreadRealtimeListVoicesResponse } from "./protocol/v2/ThreadRealtimeListVoicesResponse";
import type { ThreadRealtimeOutputAudioDeltaNotification as V2ThreadRealtimeOutputAudioDeltaNotification } from "./protocol/v2/ThreadRealtimeOutputAudioDeltaNotification";
import type { ThreadRealtimeSdpNotification as V2ThreadRealtimeSdpNotification } from "./protocol/v2/ThreadRealtimeSdpNotification";
import type { ThreadRealtimeStartedNotification as V2ThreadRealtimeStartedNotification } from "./protocol/v2/ThreadRealtimeStartedNotification";
import type { ThreadRealtimeStartParams as V2ThreadRealtimeStartParams } from "./protocol/v2/ThreadRealtimeStartParams";
import type { ThreadRealtimeStartResponse as V2ThreadRealtimeStartResponse } from "./protocol/v2/ThreadRealtimeStartResponse";
import type { ThreadRealtimeStopParams as V2ThreadRealtimeStopParams } from "./protocol/v2/ThreadRealtimeStopParams";
import type { ThreadRealtimeStopResponse as V2ThreadRealtimeStopResponse } from "./protocol/v2/ThreadRealtimeStopResponse";
import type { ThreadRealtimeTranscriptDeltaNotification as V2ThreadRealtimeTranscriptDeltaNotification } from "./protocol/v2/ThreadRealtimeTranscriptDeltaNotification";
import type { ThreadRealtimeTranscriptDoneNotification as V2ThreadRealtimeTranscriptDoneNotification } from "./protocol/v2/ThreadRealtimeTranscriptDoneNotification";
import type { ThreadResumeParams as V2ThreadResumeParams } from "./protocol/v2/ThreadResumeParams";
import type { ThreadResumeResponse as V2ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse";
import type { ThreadRevertedNotification as V2ThreadRevertedNotification } from "./protocol/v2/ThreadRevertedNotification";
import type { ThreadRevertParams as V2ThreadRevertParams } from "./protocol/v2/ThreadRevertParams";
import type { ThreadRevertResponse as V2ThreadRevertResponse } from "./protocol/v2/ThreadRevertResponse";
import type { ThreadRollbackParams as V2ThreadRollbackParams } from "./protocol/v2/ThreadRollbackParams";
import type { ThreadRollbackResponse as V2ThreadRollbackResponse } from "./protocol/v2/ThreadRollbackResponse";
import type { ThreadSearchOccurrencesParams as V2ThreadSearchOccurrencesParams } from "./protocol/v2/ThreadSearchOccurrencesParams";
import type { ThreadSearchOccurrencesResponse as V2ThreadSearchOccurrencesResponse } from "./protocol/v2/ThreadSearchOccurrencesResponse";
import type { ThreadSearchParams as V2ThreadSearchParams } from "./protocol/v2/ThreadSearchParams";
import type { ThreadSearchResponse as V2ThreadSearchResponse } from "./protocol/v2/ThreadSearchResponse";
import type { ThreadSectionCreateParams as V2ThreadSectionCreateParams } from "./protocol/v2/ThreadSectionCreateParams";
import type { ThreadSectionCreateResponse as V2ThreadSectionCreateResponse } from "./protocol/v2/ThreadSectionCreateResponse";
import type { ThreadSectionDeleteParams as V2ThreadSectionDeleteParams } from "./protocol/v2/ThreadSectionDeleteParams";
import type { ThreadSectionDeleteResponse as V2ThreadSectionDeleteResponse } from "./protocol/v2/ThreadSectionDeleteResponse";
import type { ThreadSectionListParams as V2ThreadSectionListParams } from "./protocol/v2/ThreadSectionListParams";
import type { ThreadSectionListResponse as V2ThreadSectionListResponse } from "./protocol/v2/ThreadSectionListResponse";
import type { ThreadSectionMoveParams as V2ThreadSectionMoveParams } from "./protocol/v2/ThreadSectionMoveParams";
import type { ThreadSectionMoveResponse as V2ThreadSectionMoveResponse } from "./protocol/v2/ThreadSectionMoveResponse";
import type { ThreadSectionUpdateParams as V2ThreadSectionUpdateParams } from "./protocol/v2/ThreadSectionUpdateParams";
import type { ThreadSectionUpdateResponse as V2ThreadSectionUpdateResponse } from "./protocol/v2/ThreadSectionUpdateResponse";
import type { ThreadSetNameParams as V2ThreadSetNameParams } from "./protocol/v2/ThreadSetNameParams";
import type { ThreadSetNameResponse as V2ThreadSetNameResponse } from "./protocol/v2/ThreadSetNameResponse";
import type { ThreadSettingsUpdatedNotification as V2ThreadSettingsUpdatedNotification } from "./protocol/v2/ThreadSettingsUpdatedNotification";
import type { ThreadSettingsUpdateParams as V2ThreadSettingsUpdateParams } from "./protocol/v2/ThreadSettingsUpdateParams";
import type { ThreadSettingsUpdateResponse as V2ThreadSettingsUpdateResponse } from "./protocol/v2/ThreadSettingsUpdateResponse";
import type { ThreadShellCommandParams as V2ThreadShellCommandParams } from "./protocol/v2/ThreadShellCommandParams";
import type { ThreadShellCommandResponse as V2ThreadShellCommandResponse } from "./protocol/v2/ThreadShellCommandResponse";
import type { ThreadStartedNotification as V2ThreadStartedNotification } from "./protocol/v2/ThreadStartedNotification";
import type { ThreadStartParams as V2ThreadStartParams } from "./protocol/v2/ThreadStartParams";
import type { ThreadStartResponse as V2ThreadStartResponse } from "./protocol/v2/ThreadStartResponse";
import type { ThreadStatusChangedNotification as V2ThreadStatusChangedNotification } from "./protocol/v2/ThreadStatusChangedNotification";
import type { ThreadTimelineListParams as V2ThreadTimelineListParams } from "./protocol/v2/ThreadTimelineListParams";
import type { ThreadTimelineListResponse as V2ThreadTimelineListResponse } from "./protocol/v2/ThreadTimelineListResponse";
import type { ThreadTokenUsageUpdatedNotification as V2ThreadTokenUsageUpdatedNotification } from "./protocol/v2/ThreadTokenUsageUpdatedNotification";
import type { ThreadTurnsListParams as V2ThreadTurnsListParams } from "./protocol/v2/ThreadTurnsListParams";
import type { ThreadTurnsListResponse as V2ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse";
import type { ThreadUnarchivedNotification as V2ThreadUnarchivedNotification } from "./protocol/v2/ThreadUnarchivedNotification";
import type { ThreadUnarchiveParams as V2ThreadUnarchiveParams } from "./protocol/v2/ThreadUnarchiveParams";
import type { ThreadUnarchiveResponse as V2ThreadUnarchiveResponse } from "./protocol/v2/ThreadUnarchiveResponse";
import type { ThreadUnsubscribeParams as V2ThreadUnsubscribeParams } from "./protocol/v2/ThreadUnsubscribeParams";
import type { ThreadUnsubscribeResponse as V2ThreadUnsubscribeResponse } from "./protocol/v2/ThreadUnsubscribeResponse";
import type { ToolRequestUserInputParams as V2ToolRequestUserInputParams } from "./protocol/v2/ToolRequestUserInputParams";
import type { ToolRequestUserInputResponse as V2ToolRequestUserInputResponse } from "./protocol/v2/ToolRequestUserInputResponse";
import type { TurnCompletedNotification as V2TurnCompletedNotification } from "./protocol/v2/TurnCompletedNotification";
import type { TurnDiffUpdatedNotification as V2TurnDiffUpdatedNotification } from "./protocol/v2/TurnDiffUpdatedNotification";
import type { TurnInterruptParams as V2TurnInterruptParams } from "./protocol/v2/TurnInterruptParams";
import type { TurnInterruptResponse as V2TurnInterruptResponse } from "./protocol/v2/TurnInterruptResponse";
import type { TurnModerationMetadataNotification as V2TurnModerationMetadataNotification } from "./protocol/v2/TurnModerationMetadataNotification";
import type { TurnPlanUpdatedNotification as V2TurnPlanUpdatedNotification } from "./protocol/v2/TurnPlanUpdatedNotification";
import type { TurnSettingsUpdateParams as V2TurnSettingsUpdateParams } from "./protocol/v2/TurnSettingsUpdateParams";
import type { TurnSettingsUpdateResponse as V2TurnSettingsUpdateResponse } from "./protocol/v2/TurnSettingsUpdateResponse";
import type { TurnStartedNotification as V2TurnStartedNotification } from "./protocol/v2/TurnStartedNotification";
import type { TurnStartParams as V2TurnStartParams } from "./protocol/v2/TurnStartParams";
import type { TurnStartResponse as V2TurnStartResponse } from "./protocol/v2/TurnStartResponse";
import type { TurnSteerParams as V2TurnSteerParams } from "./protocol/v2/TurnSteerParams";
import type { TurnSteerResponse as V2TurnSteerResponse } from "./protocol/v2/TurnSteerResponse";
import type { UserVerificationDeleteParams as V2UserVerificationDeleteParams } from "./protocol/v2/UserVerificationDeleteParams";
import type { UserVerificationDeleteResponse as V2UserVerificationDeleteResponse } from "./protocol/v2/UserVerificationDeleteResponse";
import type { UserVerificationEnrollParams as V2UserVerificationEnrollParams } from "./protocol/v2/UserVerificationEnrollParams";
import type { UserVerificationEnrollResponse as V2UserVerificationEnrollResponse } from "./protocol/v2/UserVerificationEnrollResponse";
import type { UserVerificationStatusParams as V2UserVerificationStatusParams } from "./protocol/v2/UserVerificationStatusParams";
import type { UserVerificationStatusResponse as V2UserVerificationStatusResponse } from "./protocol/v2/UserVerificationStatusResponse";
import type { UserVerificationVerifyParams as V2UserVerificationVerifyParams } from "./protocol/v2/UserVerificationVerifyParams";
import type { UserVerificationVerifyResponse as V2UserVerificationVerifyResponse } from "./protocol/v2/UserVerificationVerifyResponse";
import type { WarningNotification as V2WarningNotification } from "./protocol/v2/WarningNotification";
import type { WindowsSandboxReadinessResponse as V2WindowsSandboxReadinessResponse } from "./protocol/v2/WindowsSandboxReadinessResponse";
import type { WindowsSandboxSetupCompletedNotification as V2WindowsSandboxSetupCompletedNotification } from "./protocol/v2/WindowsSandboxSetupCompletedNotification";
import type { WindowsSandboxSetupStartParams as V2WindowsSandboxSetupStartParams } from "./protocol/v2/WindowsSandboxSetupStartParams";
import type { WindowsSandboxSetupStartResponse as V2WindowsSandboxSetupStartResponse } from "./protocol/v2/WindowsSandboxSetupStartResponse";
import type { WindowsWorldWritableWarningNotification as V2WindowsWorldWritableWarningNotification } from "./protocol/v2/WindowsWorldWritableWarningNotification";

/** Every client->server request method. */
export const CLIENT_REQUEST_METHODS = {
  initialize: "initialize",
  "server/diagnostics": "server/diagnostics",
  "userVerification/status": "userVerification/status",
  "userVerification/enroll": "userVerification/enroll",
  "userVerification/delete": "userVerification/delete",
  "userVerification/verify": "userVerification/verify",
  "thread/start": "thread/start",
  "thread/resume": "thread/resume",
  "thread/fork": "thread/fork",
  "thread/archive": "thread/archive",
  "thread/delete": "thread/delete",
  "thread/unsubscribe": "thread/unsubscribe",
  "thread/increment_elicitation": "thread/increment_elicitation",
  "thread/decrement_elicitation": "thread/decrement_elicitation",
  "thread/name/set": "thread/name/set",
  "thread/goal/set": "thread/goal/set",
  "thread/goal/get": "thread/goal/get",
  "thread/goal/clear": "thread/goal/clear",
  "thread/queue/add": "thread/queue/add",
  "thread/queue/list": "thread/queue/list",
  "thread/queue/update": "thread/queue/update",
  "thread/queue/delete": "thread/queue/delete",
  "thread/queue/reorder": "thread/queue/reorder",
  "thread/queue/start": "thread/queue/start",
  "thread/metadata/update": "thread/metadata/update",
  "thread/section/move": "thread/section/move",
  "thread/settings/update": "thread/settings/update",
  "thread/memoryMode/set": "thread/memoryMode/set",
  "memory/reset": "memory/reset",
  "thread/unarchive": "thread/unarchive",
  "thread/compact/start": "thread/compact/start",
  "thread/shellCommand": "thread/shellCommand",
  "thread/approveGuardianDeniedAction": "thread/approveGuardianDeniedAction",
  "thread/backgroundTerminals/clean": "thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/list": "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate": "thread/backgroundTerminals/terminate",
  "thread/rollback": "thread/rollback",
  "thread/revert": "thread/revert",
  "thread/list": "thread/list",
  "project/list": "project/list",
  "project/read": "project/read",
  "project/create": "project/create",
  "project/import": "project/import",
  "project/update": "project/update",
  "project/move": "project/move",
  "project/delete": "project/delete",
  "threadSection/list": "threadSection/list",
  "threadSection/create": "threadSection/create",
  "threadSection/update": "threadSection/update",
  "threadSection/delete": "threadSection/delete",
  "thread/search": "thread/search",
  "thread/searchOccurrences": "thread/searchOccurrences",
  "thread/loaded/list": "thread/loaded/list",
  "thread/read": "thread/read",
  "thread/turns/list": "thread/turns/list",
  "thread/items/list": "thread/items/list",
  "thread/inject_items": "thread/inject_items",
  "skills/list": "skills/list",
  "skills/extraRoots/set": "skills/extraRoots/set",
  "hooks/list": "hooks/list",
  "marketplace/add": "marketplace/add",
  "marketplace/remove": "marketplace/remove",
  "marketplace/upgrade": "marketplace/upgrade",
  "plugin/list": "plugin/list",
  "plugin/search": "plugin/search",
  "plugin/installed": "plugin/installed",
  "plugin/reconcile": "plugin/reconcile",
  "plugin/read": "plugin/read",
  "plugin/skill/read": "plugin/skill/read",
  "plugin/share/save": "plugin/share/save",
  "plugin/share/updateTargets": "plugin/share/updateTargets",
  "plugin/share/list": "plugin/share/list",
  "plugin/share/checkout": "plugin/share/checkout",
  "plugin/share/delete": "plugin/share/delete",
  "app/read": "app/read",
  "app/list": "app/list",
  "app/installed": "app/installed",
  "fs/readFile": "fs/readFile",
  "fs/writeFile": "fs/writeFile",
  "fs/createDirectory": "fs/createDirectory",
  "fs/getMetadata": "fs/getMetadata",
  "fs/readDirectory": "fs/readDirectory",
  "fs/remove": "fs/remove",
  "fs/copy": "fs/copy",
  "fs/watch": "fs/watch",
  "fs/unwatch": "fs/unwatch",
  "skills/config/write": "skills/config/write",
  "plugin/install": "plugin/install",
  "plugin/uninstall": "plugin/uninstall",
  "turn/start": "turn/start",
  "turn/settings/update": "turn/settings/update",
  "turn/steer": "turn/steer",
  "turn/interrupt": "turn/interrupt",
  "thread/realtime/start": "thread/realtime/start",
  "thread/realtime/appendAudio": "thread/realtime/appendAudio",
  "thread/realtime/appendText": "thread/realtime/appendText",
  "thread/realtime/appendSpeech": "thread/realtime/appendSpeech",
  "thread/realtime/stop": "thread/realtime/stop",
  "thread/timeline/list": "thread/timeline/list",
  "thread/realtime/listVoices": "thread/realtime/listVoices",
  "review/start": "review/start",
  "model/list": "model/list",
  "modelProvider/capabilities/read": "modelProvider/capabilities/read",
  "experimentalFeature/list": "experimentalFeature/list",
  "permissionProfile/list": "permissionProfile/list",
  "experimentalFeature/enablement/set": "experimentalFeature/enablement/set",
  "remoteControl/status/read": "remoteControl/status/read",
  "remoteControl/pairing/start": "remoteControl/pairing/start",
  "remoteControl/pairing/status": "remoteControl/pairing/status",
  "remoteControl/client/list": "remoteControl/client/list",
  "remoteControl/client/revoke": "remoteControl/client/revoke",
  "collaborationMode/list": "collaborationMode/list",
  "mock/experimentalMethod": "mock/experimentalMethod",
  "environment/add": "environment/add",
  "environment/info": "environment/info",
  "environment/status": "environment/status",
  "mcpServer/oauth/login": "mcpServer/oauth/login",
  "config/mcpServer/reload": "config/mcpServer/reload",
  "mcpServerStatus/list": "mcpServerStatus/list",
  "mcpServer/resource/read": "mcpServer/resource/read",
  "mcpServer/event/stream/start": "mcpServer/event/stream/start",
  "mcpServer/event/stream/stop": "mcpServer/event/stream/stop",
  "mcpServer/tool/call": "mcpServer/tool/call",
  "windowsSandbox/setupStart": "windowsSandbox/setupStart",
  "windowsSandbox/readiness": "windowsSandbox/readiness",
  "account/login/start": "account/login/start",
  "account/bedrock/discover": "account/bedrock/discover",
  "account/bedrock/setup": "account/bedrock/setup",
  "account/login/cancel": "account/login/cancel",
  "account/logout": "account/logout",
  "account/rateLimits/read": "account/rateLimits/read",
  "account/rateLimitResetCredit/consume": "account/rateLimitResetCredit/consume",
  "account/usage/read": "account/usage/read",
  "account/workspaceMessages/read": "account/workspaceMessages/read",
  "account/sendAddCreditsNudgeEmail": "account/sendAddCreditsNudgeEmail",
  "feedback/upload": "feedback/upload",
  "command/exec": "command/exec",
  "command/exec/write": "command/exec/write",
  "command/exec/terminate": "command/exec/terminate",
  "command/exec/resize": "command/exec/resize",
  "process/spawn": "process/spawn",
  "process/writeStdin": "process/writeStdin",
  "process/kill": "process/kill",
  "process/resizePty": "process/resizePty",
  "config/read": "config/read",
  "externalAgentConfig/detect": "externalAgentConfig/detect",
  "externalAgentConfig/import": "externalAgentConfig/import",
  "externalAgentConfig/import/recordHistory": "externalAgentConfig/import/recordHistory",
  "externalAgentConfig/import/readHistories": "externalAgentConfig/import/readHistories",
  "config/value/write": "config/value/write",
  "config/batchWrite": "config/batchWrite",
  "configRequirements/read": "configRequirements/read",
  "account/read": "account/read",
  getConversationSummary: "getConversationSummary",
  gitDiffToRemote: "gitDiffToRemote",
  getAuthStatus: "getAuthStatus",
  fuzzyFileSearch: "fuzzyFileSearch",
  "fuzzyFileSearch/sessionStart": "fuzzyFileSearch/sessionStart",
  "fuzzyFileSearch/sessionUpdate": "fuzzyFileSearch/sessionUpdate",
  "fuzzyFileSearch/sessionStop": "fuzzyFileSearch/sessionStop",
} as const;

/** Every client->server notification method. */
export const CLIENT_NOTIFICATION_METHODS = {
  initialized: "initialized",
} as const;

/** Every server->client request method. Each one MUST be answered or the turn wedges. */
export const SERVER_REQUEST_METHODS = {
  "item/commandExecution/requestApproval": "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval": "item/fileChange/requestApproval",
  "item/tool/requestUserInput": "item/tool/requestUserInput",
  "mcpServer/elicitation/request": "mcpServer/elicitation/request",
  "item/permissions/requestApproval": "item/permissions/requestApproval",
  "item/tool/call": "item/tool/call",
  "account/chatgptAuthTokens/refresh": "account/chatgptAuthTokens/refresh",
  "attestation/generate": "attestation/generate",
  "currentTime/read": "currentTime/read",
  applyPatchApproval: "applyPatchApproval",
  execCommandApproval: "execCommandApproval",
} as const;

/** Every server->client notification method. */
export const SERVER_NOTIFICATION_METHODS = {
  error: "error",
  "thread/started": "thread/started",
  "thread/status/changed": "thread/status/changed",
  "thread/archived": "thread/archived",
  "thread/deleted": "thread/deleted",
  "thread/unarchived": "thread/unarchived",
  "thread/closed": "thread/closed",
  "thread/reverted": "thread/reverted",
  "skills/changed": "skills/changed",
  "thread/name/updated": "thread/name/updated",
  "thread/goal/updated": "thread/goal/updated",
  "thread/goal/cleared": "thread/goal/cleared",
  "thread/queue/changed": "thread/queue/changed",
  "project/changed": "project/changed",
  "thread/project/updated": "thread/project/updated",
  "thread/environment/connected": "thread/environment/connected",
  "thread/environment/disconnected": "thread/environment/disconnected",
  "thread/settings/updated": "thread/settings/updated",
  "thread/tokenUsage/updated": "thread/tokenUsage/updated",
  "turn/started": "turn/started",
  "hook/started": "hook/started",
  "turn/completed": "turn/completed",
  "hook/completed": "hook/completed",
  "turn/diff/updated": "turn/diff/updated",
  "turn/plan/updated": "turn/plan/updated",
  "item/started": "item/started",
  "item/autoApprovalReview/started": "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed": "item/autoApprovalReview/completed",
  "autoApprovalReview/strictReviewRequired": "autoApprovalReview/strictReviewRequired",
  "item/completed": "item/completed",
  "rawResponseItem/completed": "rawResponseItem/completed",
  "rawResponse/completed": "rawResponse/completed",
  "item/agentMessage/delta": "item/agentMessage/delta",
  "item/plan/delta": "item/plan/delta",
  "command/exec/outputDelta": "command/exec/outputDelta",
  "process/outputDelta": "process/outputDelta",
  "process/exited": "process/exited",
  "item/commandExecution/outputDelta": "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction": "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta": "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated": "item/fileChange/patchUpdated",
  "serverRequest/resolved": "serverRequest/resolved",
  "item/mcpToolCall/progress": "item/mcpToolCall/progress",
  "mcpServer/oauthLogin/completed": "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated": "mcpServer/startupStatus/updated",
  "mcpServer/event/stream/notification": "mcpServer/event/stream/notification",
  "account/updated": "account/updated",
  "account/rateLimits/updated": "account/rateLimits/updated",
  "app/list/updated": "app/list/updated",
  "remoteControl/status/changed": "remoteControl/status/changed",
  "externalAgentConfig/import/progress": "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed": "externalAgentConfig/import/completed",
  "fs/changed": "fs/changed",
  "item/reasoning/summaryTextDelta": "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded": "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta": "item/reasoning/textDelta",
  "thread/compacted": "thread/compacted",
  "model/rerouted": "model/rerouted",
  "model/verification": "model/verification",
  "modelProvider/authRecoveryStarted": "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted": "modelProvider/authRecoveryCompleted",
  "turn/moderationMetadata": "turn/moderationMetadata",
  "model/safetyBuffering/updated": "model/safetyBuffering/updated",
  warning: "warning",
  guardianWarning: "guardianWarning",
  deprecationNotice: "deprecationNotice",
  configWarning: "configWarning",
  "fuzzyFileSearch/sessionUpdated": "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted": "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started": "thread/realtime/started",
  "thread/realtime/itemAdded": "thread/realtime/itemAdded",
  "thread/realtime/item/started": "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta": "thread/realtime/item/transcript/delta",
  "thread/realtime/item/completed": "thread/realtime/item/completed",
  "thread/realtime/transcript/delta": "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done": "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta": "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp": "thread/realtime/sdp",
  "thread/realtime/error": "thread/realtime/error",
  "thread/realtime/closed": "thread/realtime/closed",
  "windows/worldWritableWarning": "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted": "windowsSandbox/setupCompleted",
  "account/login/completed": "account/login/completed",
} as const;

/** method -> params type name (as it is spelled in ./protocol). */
export const CLIENT_REQUEST_PARAM_TYPES = {
  initialize: "InitializeParams",
  "server/diagnostics": "v2/ServerDiagnosticsParams",
  "userVerification/status": "v2/UserVerificationStatusParams",
  "userVerification/enroll": "v2/UserVerificationEnrollParams",
  "userVerification/delete": "v2/UserVerificationDeleteParams",
  "userVerification/verify": "v2/UserVerificationVerifyParams",
  "thread/start": "v2/ThreadStartParams",
  "thread/resume": "v2/ThreadResumeParams",
  "thread/fork": "v2/ThreadForkParams",
  "thread/archive": "v2/ThreadArchiveParams",
  "thread/delete": "v2/ThreadDeleteParams",
  "thread/unsubscribe": "v2/ThreadUnsubscribeParams",
  "thread/increment_elicitation": "v2/ThreadIncrementElicitationParams",
  "thread/decrement_elicitation": "v2/ThreadDecrementElicitationParams",
  "thread/name/set": "v2/ThreadSetNameParams",
  "thread/goal/set": "v2/ThreadGoalSetParams",
  "thread/goal/get": "v2/ThreadGoalGetParams",
  "thread/goal/clear": "v2/ThreadGoalClearParams",
  "thread/queue/add": "v2/ThreadQueueAddParams",
  "thread/queue/list": "v2/ThreadQueueListParams",
  "thread/queue/update": "v2/ThreadQueueUpdateParams",
  "thread/queue/delete": "v2/ThreadQueueDeleteParams",
  "thread/queue/reorder": "v2/ThreadQueueReorderParams",
  "thread/queue/start": "v2/ThreadQueueStartParams",
  "thread/metadata/update": "v2/ThreadMetadataUpdateParams",
  "thread/section/move": "v2/ThreadSectionMoveParams",
  "thread/settings/update": "v2/ThreadSettingsUpdateParams",
  "thread/memoryMode/set": "v2/ThreadMemoryModeSetParams",
  "memory/reset": null,
  "thread/unarchive": "v2/ThreadUnarchiveParams",
  "thread/compact/start": "v2/ThreadCompactStartParams",
  "thread/shellCommand": "v2/ThreadShellCommandParams",
  "thread/approveGuardianDeniedAction": "v2/ThreadApproveGuardianDeniedActionParams",
  "thread/backgroundTerminals/clean": "v2/ThreadBackgroundTerminalsCleanParams",
  "thread/backgroundTerminals/list": "v2/ThreadBackgroundTerminalsListParams",
  "thread/backgroundTerminals/terminate": "v2/ThreadBackgroundTerminalsTerminateParams",
  "thread/rollback": "v2/ThreadRollbackParams",
  "thread/revert": "v2/ThreadRevertParams",
  "thread/list": "v2/ThreadListParams",
  "project/list": "v2/ProjectListParams",
  "project/read": "v2/ProjectReadParams",
  "project/create": "v2/ProjectCreateParams",
  "project/import": "v2/ProjectImportParams",
  "project/update": "v2/ProjectUpdateParams",
  "project/move": "v2/ProjectMoveParams",
  "project/delete": "v2/ProjectDeleteParams",
  "threadSection/list": "v2/ThreadSectionListParams",
  "threadSection/create": "v2/ThreadSectionCreateParams",
  "threadSection/update": "v2/ThreadSectionUpdateParams",
  "threadSection/delete": "v2/ThreadSectionDeleteParams",
  "thread/search": "v2/ThreadSearchParams",
  "thread/searchOccurrences": "v2/ThreadSearchOccurrencesParams",
  "thread/loaded/list": "v2/ThreadLoadedListParams",
  "thread/read": "v2/ThreadReadParams",
  "thread/turns/list": "v2/ThreadTurnsListParams",
  "thread/items/list": "v2/ThreadItemsListParams",
  "thread/inject_items": "v2/ThreadInjectItemsParams",
  "skills/list": "v2/SkillsListParams",
  "skills/extraRoots/set": "v2/SkillsExtraRootsSetParams",
  "hooks/list": "v2/HooksListParams",
  "marketplace/add": "v2/MarketplaceAddParams",
  "marketplace/remove": "v2/MarketplaceRemoveParams",
  "marketplace/upgrade": "v2/MarketplaceUpgradeParams",
  "plugin/list": "v2/PluginListParams",
  "plugin/search": "v2/PluginSearchParams",
  "plugin/installed": "v2/PluginInstalledParams",
  "plugin/reconcile": "v2/PluginReconcileParams",
  "plugin/read": "v2/PluginReadParams",
  "plugin/skill/read": "v2/PluginSkillReadParams",
  "plugin/share/save": "v2/PluginShareSaveParams",
  "plugin/share/updateTargets": "v2/PluginShareUpdateTargetsParams",
  "plugin/share/list": "v2/PluginShareListParams",
  "plugin/share/checkout": "v2/PluginShareCheckoutParams",
  "plugin/share/delete": "v2/PluginShareDeleteParams",
  "app/read": "v2/AppsReadParams",
  "app/list": "v2/AppsListParams",
  "app/installed": "v2/AppsInstalledParams",
  "fs/readFile": "v2/FsReadFileParams",
  "fs/writeFile": "v2/FsWriteFileParams",
  "fs/createDirectory": "v2/FsCreateDirectoryParams",
  "fs/getMetadata": "v2/FsGetMetadataParams",
  "fs/readDirectory": "v2/FsReadDirectoryParams",
  "fs/remove": "v2/FsRemoveParams",
  "fs/copy": "v2/FsCopyParams",
  "fs/watch": "v2/FsWatchParams",
  "fs/unwatch": "v2/FsUnwatchParams",
  "skills/config/write": "v2/SkillsConfigWriteParams",
  "plugin/install": "v2/PluginInstallParams",
  "plugin/uninstall": "v2/PluginUninstallParams",
  "turn/start": "v2/TurnStartParams",
  "turn/settings/update": "v2/TurnSettingsUpdateParams",
  "turn/steer": "v2/TurnSteerParams",
  "turn/interrupt": "v2/TurnInterruptParams",
  "thread/realtime/start": "v2/ThreadRealtimeStartParams",
  "thread/realtime/appendAudio": "v2/ThreadRealtimeAppendAudioParams",
  "thread/realtime/appendText": "v2/ThreadRealtimeAppendTextParams",
  "thread/realtime/appendSpeech": "v2/ThreadRealtimeAppendSpeechParams",
  "thread/realtime/stop": "v2/ThreadRealtimeStopParams",
  "thread/timeline/list": "v2/ThreadTimelineListParams",
  "thread/realtime/listVoices": "v2/ThreadRealtimeListVoicesParams",
  "review/start": "v2/ReviewStartParams",
  "model/list": "v2/ModelListParams",
  "modelProvider/capabilities/read": "v2/ModelProviderCapabilitiesReadParams",
  "experimentalFeature/list": "v2/ExperimentalFeatureListParams",
  "permissionProfile/list": "v2/PermissionProfileListParams",
  "experimentalFeature/enablement/set": "v2/ExperimentalFeatureEnablementSetParams",
  "remoteControl/status/read": null,
  "remoteControl/pairing/start": "v2/RemoteControlPairingStartParams",
  "remoteControl/pairing/status": "v2/RemoteControlPairingStatusParams",
  "remoteControl/client/list": "v2/RemoteControlClientsListParams",
  "remoteControl/client/revoke": "v2/RemoteControlClientsRevokeParams",
  "collaborationMode/list": "v2/CollaborationModeListParams",
  "mock/experimentalMethod": "v2/MockExperimentalMethodParams",
  "environment/add": "v2/EnvironmentAddParams",
  "environment/info": "v2/EnvironmentInfoParams",
  "environment/status": "v2/EnvironmentStatusParams",
  "mcpServer/oauth/login": "v2/McpServerOauthLoginParams",
  "config/mcpServer/reload": null,
  "mcpServerStatus/list": "v2/ListMcpServerStatusParams",
  "mcpServer/resource/read": "v2/McpResourceReadParams",
  "mcpServer/event/stream/start": "v2/McpServerEventStreamStartParams",
  "mcpServer/event/stream/stop": "v2/McpServerEventStreamStopParams",
  "mcpServer/tool/call": "v2/McpServerToolCallParams",
  "windowsSandbox/setupStart": "v2/WindowsSandboxSetupStartParams",
  "windowsSandbox/readiness": null,
  "account/login/start": "v2/LoginAccountParams",
  "account/bedrock/discover": "v2/BedrockDiscoverParams",
  "account/bedrock/setup": "v2/BedrockSetupParams",
  "account/login/cancel": "v2/CancelLoginAccountParams",
  "account/logout": null,
  "account/rateLimits/read": "v2/GetAccountRateLimitsParams",
  "account/rateLimitResetCredit/consume": "v2/ConsumeAccountRateLimitResetCreditParams",
  "account/usage/read": "v2/GetAccountTokenUsageParams",
  "account/workspaceMessages/read": null,
  "account/sendAddCreditsNudgeEmail": "v2/SendAddCreditsNudgeEmailParams",
  "feedback/upload": "v2/FeedbackUploadParams",
  "command/exec": "v2/CommandExecParams",
  "command/exec/write": "v2/CommandExecWriteParams",
  "command/exec/terminate": "v2/CommandExecTerminateParams",
  "command/exec/resize": "v2/CommandExecResizeParams",
  "process/spawn": "v2/ProcessSpawnParams",
  "process/writeStdin": "v2/ProcessWriteStdinParams",
  "process/kill": "v2/ProcessKillParams",
  "process/resizePty": "v2/ProcessResizePtyParams",
  "config/read": "v2/ConfigReadParams",
  "externalAgentConfig/detect": "v2/ExternalAgentConfigDetectParams",
  "externalAgentConfig/import": "v2/ExternalAgentConfigImportParams",
  "externalAgentConfig/import/recordHistory": "v2/ExternalAgentConfigImportHistoryRecordParams",
  "externalAgentConfig/import/readHistories": null,
  "config/value/write": "v2/ConfigValueWriteParams",
  "config/batchWrite": "v2/ConfigBatchWriteParams",
  "configRequirements/read": null,
  "account/read": "v2/GetAccountParams",
  getConversationSummary: "GetConversationSummaryParams",
  gitDiffToRemote: "GitDiffToRemoteParams",
  getAuthStatus: "GetAuthStatusParams",
  fuzzyFileSearch: "FuzzyFileSearchParams",
  "fuzzyFileSearch/sessionStart": "FuzzyFileSearchSessionStartParams",
  "fuzzyFileSearch/sessionUpdate": "FuzzyFileSearchSessionUpdateParams",
  "fuzzyFileSearch/sessionStop": "FuzzyFileSearchSessionStopParams",
} as const;

/** method -> result type name. */
export const CLIENT_REQUEST_RESULT_TYPES = {
  initialize: "InitializeResponse",
  "server/diagnostics": "v2/ServerDiagnosticsResponse",
  "userVerification/status": "v2/UserVerificationStatusResponse",
  "userVerification/enroll": "v2/UserVerificationEnrollResponse",
  "userVerification/delete": "v2/UserVerificationDeleteResponse",
  "userVerification/verify": "v2/UserVerificationVerifyResponse",
  "thread/start": "v2/ThreadStartResponse",
  "thread/resume": "v2/ThreadResumeResponse",
  "thread/fork": "v2/ThreadForkResponse",
  "thread/archive": "v2/ThreadArchiveResponse",
  "thread/delete": "v2/ThreadDeleteResponse",
  "thread/unsubscribe": "v2/ThreadUnsubscribeResponse",
  "thread/increment_elicitation": "v2/ThreadIncrementElicitationResponse",
  "thread/decrement_elicitation": "v2/ThreadDecrementElicitationResponse",
  "thread/name/set": "v2/ThreadSetNameResponse",
  "thread/goal/set": "v2/ThreadGoalSetResponse",
  "thread/goal/get": "v2/ThreadGoalGetResponse",
  "thread/goal/clear": "v2/ThreadGoalClearResponse",
  "thread/queue/add": "v2/ThreadQueueAddResponse",
  "thread/queue/list": "v2/ThreadQueueListResponse",
  "thread/queue/update": "v2/ThreadQueueUpdateResponse",
  "thread/queue/delete": "v2/ThreadQueueDeleteResponse",
  "thread/queue/reorder": "v2/ThreadQueueReorderResponse",
  "thread/queue/start": "v2/ThreadQueueStartResponse",
  "thread/metadata/update": "v2/ThreadMetadataUpdateResponse",
  "thread/section/move": "v2/ThreadSectionMoveResponse",
  "thread/settings/update": "v2/ThreadSettingsUpdateResponse",
  "thread/memoryMode/set": "v2/ThreadMemoryModeSetResponse",
  "memory/reset": "v2/MemoryResetResponse",
  "thread/unarchive": "v2/ThreadUnarchiveResponse",
  "thread/compact/start": "v2/ThreadCompactStartResponse",
  "thread/shellCommand": "v2/ThreadShellCommandResponse",
  "thread/approveGuardianDeniedAction": "v2/ThreadApproveGuardianDeniedActionResponse",
  "thread/backgroundTerminals/clean": "v2/ThreadBackgroundTerminalsCleanResponse",
  "thread/backgroundTerminals/list": "v2/ThreadBackgroundTerminalsListResponse",
  "thread/backgroundTerminals/terminate": "v2/ThreadBackgroundTerminalsTerminateResponse",
  "thread/rollback": "v2/ThreadRollbackResponse",
  "thread/revert": "v2/ThreadRevertResponse",
  "thread/list": "v2/ThreadListResponse",
  "project/list": "v2/ProjectListResponse",
  "project/read": "v2/ProjectReadResponse",
  "project/create": "v2/ProjectCreateResponse",
  "project/import": "v2/ProjectImportResponse",
  "project/update": "v2/ProjectUpdateResponse",
  "project/move": "v2/ProjectMoveResponse",
  "project/delete": "v2/ProjectDeleteResponse",
  "threadSection/list": "v2/ThreadSectionListResponse",
  "threadSection/create": "v2/ThreadSectionCreateResponse",
  "threadSection/update": "v2/ThreadSectionUpdateResponse",
  "threadSection/delete": "v2/ThreadSectionDeleteResponse",
  "thread/search": "v2/ThreadSearchResponse",
  "thread/searchOccurrences": "v2/ThreadSearchOccurrencesResponse",
  "thread/loaded/list": "v2/ThreadLoadedListResponse",
  "thread/read": "v2/ThreadReadResponse",
  "thread/turns/list": "v2/ThreadTurnsListResponse",
  "thread/items/list": "v2/ThreadItemsListResponse",
  "thread/inject_items": "v2/ThreadInjectItemsResponse",
  "skills/list": "v2/SkillsListResponse",
  "skills/extraRoots/set": "v2/SkillsExtraRootsSetResponse",
  "hooks/list": "v2/HooksListResponse",
  "marketplace/add": "v2/MarketplaceAddResponse",
  "marketplace/remove": "v2/MarketplaceRemoveResponse",
  "marketplace/upgrade": "v2/MarketplaceUpgradeResponse",
  "plugin/list": "v2/PluginListResponse",
  "plugin/search": "v2/PluginSearchResponse",
  "plugin/installed": "v2/PluginInstalledResponse",
  "plugin/reconcile": "v2/PluginReconcileResponse",
  "plugin/read": "v2/PluginReadResponse",
  "plugin/skill/read": "v2/PluginSkillReadResponse",
  "plugin/share/save": "v2/PluginShareSaveResponse",
  "plugin/share/updateTargets": "v2/PluginShareUpdateTargetsResponse",
  "plugin/share/list": "v2/PluginShareListResponse",
  "plugin/share/checkout": "v2/PluginShareCheckoutResponse",
  "plugin/share/delete": "v2/PluginShareDeleteResponse",
  "app/read": "v2/AppsReadResponse",
  "app/list": "v2/AppsListResponse",
  "app/installed": "v2/AppsInstalledResponse",
  "fs/readFile": "v2/FsReadFileResponse",
  "fs/writeFile": "v2/FsWriteFileResponse",
  "fs/createDirectory": "v2/FsCreateDirectoryResponse",
  "fs/getMetadata": "v2/FsGetMetadataResponse",
  "fs/readDirectory": "v2/FsReadDirectoryResponse",
  "fs/remove": "v2/FsRemoveResponse",
  "fs/copy": "v2/FsCopyResponse",
  "fs/watch": "v2/FsWatchResponse",
  "fs/unwatch": "v2/FsUnwatchResponse",
  "skills/config/write": "v2/SkillsConfigWriteResponse",
  "plugin/install": "v2/PluginInstallResponse",
  "plugin/uninstall": "v2/PluginUninstallResponse",
  "turn/start": "v2/TurnStartResponse",
  "turn/settings/update": "v2/TurnSettingsUpdateResponse",
  "turn/steer": "v2/TurnSteerResponse",
  "turn/interrupt": "v2/TurnInterruptResponse",
  "thread/realtime/start": "v2/ThreadRealtimeStartResponse",
  "thread/realtime/appendAudio": "v2/ThreadRealtimeAppendAudioResponse",
  "thread/realtime/appendText": "v2/ThreadRealtimeAppendTextResponse",
  "thread/realtime/appendSpeech": "v2/ThreadRealtimeAppendSpeechResponse",
  "thread/realtime/stop": "v2/ThreadRealtimeStopResponse",
  "thread/timeline/list": "v2/ThreadTimelineListResponse",
  "thread/realtime/listVoices": "v2/ThreadRealtimeListVoicesResponse",
  "review/start": "v2/ReviewStartResponse",
  "model/list": "v2/ModelListResponse",
  "modelProvider/capabilities/read": "v2/ModelProviderCapabilitiesReadResponse",
  "experimentalFeature/list": "v2/ExperimentalFeatureListResponse",
  "permissionProfile/list": "v2/PermissionProfileListResponse",
  "experimentalFeature/enablement/set": "v2/ExperimentalFeatureEnablementSetResponse",
  "remoteControl/status/read": "v2/RemoteControlStatusReadResponse",
  "remoteControl/pairing/start": "v2/RemoteControlPairingStartResponse",
  "remoteControl/pairing/status": "v2/RemoteControlPairingStatusResponse",
  "remoteControl/client/list": "v2/RemoteControlClientsListResponse",
  "remoteControl/client/revoke": "v2/RemoteControlClientsRevokeResponse",
  "collaborationMode/list": "v2/CollaborationModeListResponse",
  "mock/experimentalMethod": "v2/MockExperimentalMethodResponse",
  "environment/add": "v2/EnvironmentAddResponse",
  "environment/info": "v2/EnvironmentInfoResponse",
  "environment/status": "v2/EnvironmentStatusResponse",
  "mcpServer/oauth/login": "v2/McpServerOauthLoginResponse",
  "config/mcpServer/reload": "v2/McpServerRefreshResponse",
  "mcpServerStatus/list": "v2/ListMcpServerStatusResponse",
  "mcpServer/resource/read": "v2/McpResourceReadResponse",
  "mcpServer/event/stream/start": "v2/McpServerEventStreamStartResponse",
  "mcpServer/event/stream/stop": "v2/McpServerEventStreamStopResponse",
  "mcpServer/tool/call": "v2/McpServerToolCallResponse",
  "windowsSandbox/setupStart": "v2/WindowsSandboxSetupStartResponse",
  "windowsSandbox/readiness": "v2/WindowsSandboxReadinessResponse",
  "account/login/start": "v2/LoginAccountResponse",
  "account/bedrock/discover": "v2/BedrockDiscoverResponse",
  "account/bedrock/setup": "v2/BedrockSetupResponse",
  "account/login/cancel": "v2/CancelLoginAccountResponse",
  "account/logout": "v2/LogoutAccountResponse",
  "account/rateLimits/read": "v2/GetAccountRateLimitsResponse",
  "account/rateLimitResetCredit/consume": "v2/ConsumeAccountRateLimitResetCreditResponse",
  "account/usage/read": "v2/GetAccountTokenUsageResponse",
  "account/workspaceMessages/read": "v2/GetWorkspaceMessagesResponse",
  "account/sendAddCreditsNudgeEmail": "v2/SendAddCreditsNudgeEmailResponse",
  "feedback/upload": "v2/FeedbackUploadResponse",
  "command/exec": "v2/CommandExecResponse",
  "command/exec/write": "v2/CommandExecWriteResponse",
  "command/exec/terminate": "v2/CommandExecTerminateResponse",
  "command/exec/resize": "v2/CommandExecResizeResponse",
  "process/spawn": "v2/ProcessSpawnResponse",
  "process/writeStdin": "v2/ProcessWriteStdinResponse",
  "process/kill": "v2/ProcessKillResponse",
  "process/resizePty": "v2/ProcessResizePtyResponse",
  "config/read": "v2/ConfigReadResponse",
  "externalAgentConfig/detect": "v2/ExternalAgentConfigDetectResponse",
  "externalAgentConfig/import": "v2/ExternalAgentConfigImportResponse",
  "externalAgentConfig/import/recordHistory": "v2/ExternalAgentConfigImportHistoryRecordResponse",
  "externalAgentConfig/import/readHistories": "v2/ExternalAgentConfigImportHistoriesReadResponse",
  "config/value/write": "v2/ConfigWriteResponse",
  "config/batchWrite": "v2/ConfigWriteResponse",
  "configRequirements/read": "v2/ConfigRequirementsReadResponse",
  "account/read": "v2/GetAccountResponse",
  getConversationSummary: "GetConversationSummaryResponse",
  gitDiffToRemote: "GitDiffToRemoteResponse",
  getAuthStatus: "GetAuthStatusResponse",
  fuzzyFileSearch: "FuzzyFileSearchResponse",
  "fuzzyFileSearch/sessionStart": "FuzzyFileSearchSessionStartResponse",
  "fuzzyFileSearch/sessionUpdate": "FuzzyFileSearchSessionUpdateResponse",
  "fuzzyFileSearch/sessionStop": "FuzzyFileSearchSessionStopResponse",
} as const;

/** method -> params type name. */
export const SERVER_REQUEST_PARAM_TYPES = {
  "item/commandExecution/requestApproval": "v2/CommandExecutionRequestApprovalParams",
  "item/fileChange/requestApproval": "v2/FileChangeRequestApprovalParams",
  "item/tool/requestUserInput": "v2/ToolRequestUserInputParams",
  "mcpServer/elicitation/request": "v2/McpServerElicitationRequestParams",
  "item/permissions/requestApproval": "v2/PermissionsRequestApprovalParams",
  "item/tool/call": "v2/DynamicToolCallParams",
  "account/chatgptAuthTokens/refresh": "v2/ChatgptAuthTokensRefreshParams",
  "attestation/generate": "v2/AttestationGenerateParams",
  "currentTime/read": "v2/CurrentTimeReadParams",
  applyPatchApproval: "ApplyPatchApprovalParams",
  execCommandApproval: "ExecCommandApprovalParams",
} as const;

/** method -> result type name; this is the shape WE must send back. */
export const SERVER_REQUEST_RESULT_TYPES = {
  "item/commandExecution/requestApproval": "v2/CommandExecutionRequestApprovalResponse",
  "item/fileChange/requestApproval": "v2/FileChangeRequestApprovalResponse",
  "item/tool/requestUserInput": "v2/ToolRequestUserInputResponse",
  "mcpServer/elicitation/request": "v2/McpServerElicitationRequestResponse",
  "item/permissions/requestApproval": "v2/PermissionsRequestApprovalResponse",
  "item/tool/call": "v2/DynamicToolCallResponse",
  "account/chatgptAuthTokens/refresh": "v2/ChatgptAuthTokensRefreshResponse",
  "attestation/generate": "v2/AttestationGenerateResponse",
  "currentTime/read": "v2/CurrentTimeReadResponse",
  applyPatchApproval: "ApplyPatchApprovalResponse",
  execCommandApproval: "ExecCommandApprovalResponse",
} as const;

/** method -> params type name. */
export const SERVER_NOTIFICATION_PARAM_TYPES = {
  error: "v2/ErrorNotification",
  "thread/started": "v2/ThreadStartedNotification",
  "thread/status/changed": "v2/ThreadStatusChangedNotification",
  "thread/archived": "v2/ThreadArchivedNotification",
  "thread/deleted": "v2/ThreadDeletedNotification",
  "thread/unarchived": "v2/ThreadUnarchivedNotification",
  "thread/closed": "v2/ThreadClosedNotification",
  "thread/reverted": "v2/ThreadRevertedNotification",
  "skills/changed": "v2/SkillsChangedNotification",
  "thread/name/updated": "v2/ThreadNameUpdatedNotification",
  "thread/goal/updated": "v2/ThreadGoalUpdatedNotification",
  "thread/goal/cleared": "v2/ThreadGoalClearedNotification",
  "thread/queue/changed": "v2/ThreadQueueChangedNotification",
  "project/changed": "v2/ProjectChangedNotification",
  "thread/project/updated": "v2/ThreadProjectUpdatedNotification",
  "thread/environment/connected": "v2/EnvironmentConnectionNotification",
  "thread/environment/disconnected": "v2/EnvironmentConnectionNotification",
  "thread/settings/updated": "v2/ThreadSettingsUpdatedNotification",
  "thread/tokenUsage/updated": "v2/ThreadTokenUsageUpdatedNotification",
  "turn/started": "v2/TurnStartedNotification",
  "hook/started": "v2/HookStartedNotification",
  "turn/completed": "v2/TurnCompletedNotification",
  "hook/completed": "v2/HookCompletedNotification",
  "turn/diff/updated": "v2/TurnDiffUpdatedNotification",
  "turn/plan/updated": "v2/TurnPlanUpdatedNotification",
  "item/started": "v2/ItemStartedNotification",
  "item/autoApprovalReview/started": "v2/ItemGuardianApprovalReviewStartedNotification",
  "item/autoApprovalReview/completed": "v2/ItemGuardianApprovalReviewCompletedNotification",
  "autoApprovalReview/strictReviewRequired": "v2/StrictReviewRequiredNotification",
  "item/completed": "v2/ItemCompletedNotification",
  "rawResponseItem/completed": "v2/RawResponseItemCompletedNotification",
  "rawResponse/completed": "v2/RawResponseCompletedNotification",
  "item/agentMessage/delta": "v2/AgentMessageDeltaNotification",
  "item/plan/delta": "v2/PlanDeltaNotification",
  "command/exec/outputDelta": "v2/CommandExecOutputDeltaNotification",
  "process/outputDelta": "v2/ProcessOutputDeltaNotification",
  "process/exited": "v2/ProcessExitedNotification",
  "item/commandExecution/outputDelta": "v2/CommandExecutionOutputDeltaNotification",
  "item/commandExecution/terminalInteraction": "v2/TerminalInteractionNotification",
  "item/fileChange/outputDelta": "v2/FileChangeOutputDeltaNotification",
  "item/fileChange/patchUpdated": "v2/FileChangePatchUpdatedNotification",
  "serverRequest/resolved": "v2/ServerRequestResolvedNotification",
  "item/mcpToolCall/progress": "v2/McpToolCallProgressNotification",
  "mcpServer/oauthLogin/completed": "v2/McpServerOauthLoginCompletedNotification",
  "mcpServer/startupStatus/updated": "v2/McpServerStatusUpdatedNotification",
  "mcpServer/event/stream/notification": "v2/McpServerEventStreamNotification",
  "account/updated": "v2/AccountUpdatedNotification",
  "account/rateLimits/updated": "v2/AccountRateLimitsUpdatedNotification",
  "app/list/updated": "v2/AppListUpdatedNotification",
  "remoteControl/status/changed": "v2/RemoteControlStatusChangedNotification",
  "externalAgentConfig/import/progress": "v2/ExternalAgentConfigImportProgressNotification",
  "externalAgentConfig/import/completed": "v2/ExternalAgentConfigImportCompletedNotification",
  "fs/changed": "v2/FsChangedNotification",
  "item/reasoning/summaryTextDelta": "v2/ReasoningSummaryTextDeltaNotification",
  "item/reasoning/summaryPartAdded": "v2/ReasoningSummaryPartAddedNotification",
  "item/reasoning/textDelta": "v2/ReasoningTextDeltaNotification",
  "thread/compacted": "v2/ContextCompactedNotification",
  "model/rerouted": "v2/ModelReroutedNotification",
  "model/verification": "v2/ModelVerificationNotification",
  "modelProvider/authRecoveryStarted": "v2/AuthRecoveryNotification",
  "modelProvider/authRecoveryCompleted": "v2/AuthRecoveryNotification",
  "turn/moderationMetadata": "v2/TurnModerationMetadataNotification",
  "model/safetyBuffering/updated": "v2/ModelSafetyBufferingUpdatedNotification",
  warning: "v2/WarningNotification",
  guardianWarning: "v2/GuardianWarningNotification",
  deprecationNotice: "v2/DeprecationNoticeNotification",
  configWarning: "v2/ConfigWarningNotification",
  "fuzzyFileSearch/sessionUpdated": "FuzzyFileSearchSessionUpdatedNotification",
  "fuzzyFileSearch/sessionCompleted": "FuzzyFileSearchSessionCompletedNotification",
  "thread/realtime/started": "v2/ThreadRealtimeStartedNotification",
  "thread/realtime/itemAdded": "v2/ThreadRealtimeItemAddedNotification",
  "thread/realtime/item/started": "v2/ThreadRealtimeItemStartedNotification",
  "thread/realtime/item/transcript/delta": "v2/ThreadRealtimeItemTranscriptDeltaNotification",
  "thread/realtime/item/completed": "v2/ThreadRealtimeItemCompletedNotification",
  "thread/realtime/transcript/delta": "v2/ThreadRealtimeTranscriptDeltaNotification",
  "thread/realtime/transcript/done": "v2/ThreadRealtimeTranscriptDoneNotification",
  "thread/realtime/outputAudio/delta": "v2/ThreadRealtimeOutputAudioDeltaNotification",
  "thread/realtime/sdp": "v2/ThreadRealtimeSdpNotification",
  "thread/realtime/error": "v2/ThreadRealtimeErrorNotification",
  "thread/realtime/closed": "v2/ThreadRealtimeClosedNotification",
  "windows/worldWritableWarning": "v2/WindowsWorldWritableWarningNotification",
  "windowsSandbox/setupCompleted": "v2/WindowsSandboxSetupCompletedNotification",
  "account/login/completed": "v2/AccountLoginCompletedNotification",
} as const;

/** Typed params map for client->server requests. */
export interface ClientRequestParamsByMethod {
  readonly initialize: InitializeParams;
  readonly "server/diagnostics": V2ServerDiagnosticsParams;
  readonly "userVerification/status": V2UserVerificationStatusParams;
  readonly "userVerification/enroll": V2UserVerificationEnrollParams;
  readonly "userVerification/delete": V2UserVerificationDeleteParams;
  readonly "userVerification/verify": V2UserVerificationVerifyParams;
  readonly "thread/start": V2ThreadStartParams;
  readonly "thread/resume": V2ThreadResumeParams;
  readonly "thread/fork": V2ThreadForkParams;
  readonly "thread/archive": V2ThreadArchiveParams;
  readonly "thread/delete": V2ThreadDeleteParams;
  readonly "thread/unsubscribe": V2ThreadUnsubscribeParams;
  readonly "thread/increment_elicitation": V2ThreadIncrementElicitationParams;
  readonly "thread/decrement_elicitation": V2ThreadDecrementElicitationParams;
  readonly "thread/name/set": V2ThreadSetNameParams;
  readonly "thread/goal/set": V2ThreadGoalSetParams;
  readonly "thread/goal/get": V2ThreadGoalGetParams;
  readonly "thread/goal/clear": V2ThreadGoalClearParams;
  readonly "thread/queue/add": V2ThreadQueueAddParams;
  readonly "thread/queue/list": V2ThreadQueueListParams;
  readonly "thread/queue/update": V2ThreadQueueUpdateParams;
  readonly "thread/queue/delete": V2ThreadQueueDeleteParams;
  readonly "thread/queue/reorder": V2ThreadQueueReorderParams;
  readonly "thread/queue/start": V2ThreadQueueStartParams;
  readonly "thread/metadata/update": V2ThreadMetadataUpdateParams;
  readonly "thread/section/move": V2ThreadSectionMoveParams;
  readonly "thread/settings/update": V2ThreadSettingsUpdateParams;
  readonly "thread/memoryMode/set": V2ThreadMemoryModeSetParams;
  readonly "memory/reset": undefined;
  readonly "thread/unarchive": V2ThreadUnarchiveParams;
  readonly "thread/compact/start": V2ThreadCompactStartParams;
  readonly "thread/shellCommand": V2ThreadShellCommandParams;
  readonly "thread/approveGuardianDeniedAction": V2ThreadApproveGuardianDeniedActionParams;
  readonly "thread/backgroundTerminals/clean": V2ThreadBackgroundTerminalsCleanParams;
  readonly "thread/backgroundTerminals/list": V2ThreadBackgroundTerminalsListParams;
  readonly "thread/backgroundTerminals/terminate": V2ThreadBackgroundTerminalsTerminateParams;
  readonly "thread/rollback": V2ThreadRollbackParams;
  readonly "thread/revert": V2ThreadRevertParams;
  readonly "thread/list": V2ThreadListParams;
  readonly "project/list": V2ProjectListParams;
  readonly "project/read": V2ProjectReadParams;
  readonly "project/create": V2ProjectCreateParams;
  readonly "project/import": V2ProjectImportParams;
  readonly "project/update": V2ProjectUpdateParams;
  readonly "project/move": V2ProjectMoveParams;
  readonly "project/delete": V2ProjectDeleteParams;
  readonly "threadSection/list": V2ThreadSectionListParams;
  readonly "threadSection/create": V2ThreadSectionCreateParams;
  readonly "threadSection/update": V2ThreadSectionUpdateParams;
  readonly "threadSection/delete": V2ThreadSectionDeleteParams;
  readonly "thread/search": V2ThreadSearchParams;
  readonly "thread/searchOccurrences": V2ThreadSearchOccurrencesParams;
  readonly "thread/loaded/list": V2ThreadLoadedListParams;
  readonly "thread/read": V2ThreadReadParams;
  readonly "thread/turns/list": V2ThreadTurnsListParams;
  readonly "thread/items/list": V2ThreadItemsListParams;
  readonly "thread/inject_items": V2ThreadInjectItemsParams;
  readonly "skills/list": V2SkillsListParams;
  readonly "skills/extraRoots/set": V2SkillsExtraRootsSetParams;
  readonly "hooks/list": V2HooksListParams;
  readonly "marketplace/add": V2MarketplaceAddParams;
  readonly "marketplace/remove": V2MarketplaceRemoveParams;
  readonly "marketplace/upgrade": V2MarketplaceUpgradeParams;
  readonly "plugin/list": V2PluginListParams;
  readonly "plugin/search": V2PluginSearchParams;
  readonly "plugin/installed": V2PluginInstalledParams;
  readonly "plugin/reconcile": V2PluginReconcileParams;
  readonly "plugin/read": V2PluginReadParams;
  readonly "plugin/skill/read": V2PluginSkillReadParams;
  readonly "plugin/share/save": V2PluginShareSaveParams;
  readonly "plugin/share/updateTargets": V2PluginShareUpdateTargetsParams;
  readonly "plugin/share/list": V2PluginShareListParams;
  readonly "plugin/share/checkout": V2PluginShareCheckoutParams;
  readonly "plugin/share/delete": V2PluginShareDeleteParams;
  readonly "app/read": V2AppsReadParams;
  readonly "app/list": V2AppsListParams;
  readonly "app/installed": V2AppsInstalledParams;
  readonly "fs/readFile": V2FsReadFileParams;
  readonly "fs/writeFile": V2FsWriteFileParams;
  readonly "fs/createDirectory": V2FsCreateDirectoryParams;
  readonly "fs/getMetadata": V2FsGetMetadataParams;
  readonly "fs/readDirectory": V2FsReadDirectoryParams;
  readonly "fs/remove": V2FsRemoveParams;
  readonly "fs/copy": V2FsCopyParams;
  readonly "fs/watch": V2FsWatchParams;
  readonly "fs/unwatch": V2FsUnwatchParams;
  readonly "skills/config/write": V2SkillsConfigWriteParams;
  readonly "plugin/install": V2PluginInstallParams;
  readonly "plugin/uninstall": V2PluginUninstallParams;
  readonly "turn/start": V2TurnStartParams;
  readonly "turn/settings/update": V2TurnSettingsUpdateParams;
  readonly "turn/steer": V2TurnSteerParams;
  readonly "turn/interrupt": V2TurnInterruptParams;
  readonly "thread/realtime/start": V2ThreadRealtimeStartParams;
  readonly "thread/realtime/appendAudio": V2ThreadRealtimeAppendAudioParams;
  readonly "thread/realtime/appendText": V2ThreadRealtimeAppendTextParams;
  readonly "thread/realtime/appendSpeech": V2ThreadRealtimeAppendSpeechParams;
  readonly "thread/realtime/stop": V2ThreadRealtimeStopParams;
  readonly "thread/timeline/list": V2ThreadTimelineListParams;
  readonly "thread/realtime/listVoices": V2ThreadRealtimeListVoicesParams;
  readonly "review/start": V2ReviewStartParams;
  readonly "model/list": V2ModelListParams;
  readonly "modelProvider/capabilities/read": V2ModelProviderCapabilitiesReadParams;
  readonly "experimentalFeature/list": V2ExperimentalFeatureListParams;
  readonly "permissionProfile/list": V2PermissionProfileListParams;
  readonly "experimentalFeature/enablement/set": V2ExperimentalFeatureEnablementSetParams;
  readonly "remoteControl/status/read": undefined;
  readonly "remoteControl/pairing/start": V2RemoteControlPairingStartParams;
  readonly "remoteControl/pairing/status": V2RemoteControlPairingStatusParams;
  readonly "remoteControl/client/list": V2RemoteControlClientsListParams;
  readonly "remoteControl/client/revoke": V2RemoteControlClientsRevokeParams;
  readonly "collaborationMode/list": V2CollaborationModeListParams;
  readonly "mock/experimentalMethod": V2MockExperimentalMethodParams;
  readonly "environment/add": V2EnvironmentAddParams;
  readonly "environment/info": V2EnvironmentInfoParams;
  readonly "environment/status": V2EnvironmentStatusParams;
  readonly "mcpServer/oauth/login": V2McpServerOauthLoginParams;
  readonly "config/mcpServer/reload": undefined;
  readonly "mcpServerStatus/list": V2ListMcpServerStatusParams;
  readonly "mcpServer/resource/read": V2McpResourceReadParams;
  readonly "mcpServer/event/stream/start": V2McpServerEventStreamStartParams;
  readonly "mcpServer/event/stream/stop": V2McpServerEventStreamStopParams;
  readonly "mcpServer/tool/call": V2McpServerToolCallParams;
  readonly "windowsSandbox/setupStart": V2WindowsSandboxSetupStartParams;
  readonly "windowsSandbox/readiness": undefined;
  readonly "account/login/start": V2LoginAccountParams;
  readonly "account/bedrock/discover": V2BedrockDiscoverParams;
  readonly "account/bedrock/setup": V2BedrockSetupParams;
  readonly "account/login/cancel": V2CancelLoginAccountParams;
  readonly "account/logout": undefined;
  readonly "account/rateLimits/read": V2GetAccountRateLimitsParams;
  readonly "account/rateLimitResetCredit/consume": V2ConsumeAccountRateLimitResetCreditParams;
  readonly "account/usage/read": V2GetAccountTokenUsageParams;
  readonly "account/workspaceMessages/read": undefined;
  readonly "account/sendAddCreditsNudgeEmail": V2SendAddCreditsNudgeEmailParams;
  readonly "feedback/upload": V2FeedbackUploadParams;
  readonly "command/exec": V2CommandExecParams;
  readonly "command/exec/write": V2CommandExecWriteParams;
  readonly "command/exec/terminate": V2CommandExecTerminateParams;
  readonly "command/exec/resize": V2CommandExecResizeParams;
  readonly "process/spawn": V2ProcessSpawnParams;
  readonly "process/writeStdin": V2ProcessWriteStdinParams;
  readonly "process/kill": V2ProcessKillParams;
  readonly "process/resizePty": V2ProcessResizePtyParams;
  readonly "config/read": V2ConfigReadParams;
  readonly "externalAgentConfig/detect": V2ExternalAgentConfigDetectParams;
  readonly "externalAgentConfig/import": V2ExternalAgentConfigImportParams;
  readonly "externalAgentConfig/import/recordHistory": V2ExternalAgentConfigImportHistoryRecordParams;
  readonly "externalAgentConfig/import/readHistories": undefined;
  readonly "config/value/write": V2ConfigValueWriteParams;
  readonly "config/batchWrite": V2ConfigBatchWriteParams;
  readonly "configRequirements/read": undefined;
  readonly "account/read": V2GetAccountParams;
  readonly getConversationSummary: GetConversationSummaryParams;
  readonly gitDiffToRemote: GitDiffToRemoteParams;
  readonly getAuthStatus: GetAuthStatusParams;
  readonly fuzzyFileSearch: FuzzyFileSearchParams;
  readonly "fuzzyFileSearch/sessionStart": FuzzyFileSearchSessionStartParams;
  readonly "fuzzyFileSearch/sessionUpdate": FuzzyFileSearchSessionUpdateParams;
  readonly "fuzzyFileSearch/sessionStop": FuzzyFileSearchSessionStopParams;
}

/** Typed result map for client->server requests. */
export interface ClientRequestResultsByMethod {
  readonly initialize: InitializeResponse;
  readonly "server/diagnostics": V2ServerDiagnosticsResponse;
  readonly "userVerification/status": V2UserVerificationStatusResponse;
  readonly "userVerification/enroll": V2UserVerificationEnrollResponse;
  readonly "userVerification/delete": V2UserVerificationDeleteResponse;
  readonly "userVerification/verify": V2UserVerificationVerifyResponse;
  readonly "thread/start": V2ThreadStartResponse;
  readonly "thread/resume": V2ThreadResumeResponse;
  readonly "thread/fork": V2ThreadForkResponse;
  readonly "thread/archive": V2ThreadArchiveResponse;
  readonly "thread/delete": V2ThreadDeleteResponse;
  readonly "thread/unsubscribe": V2ThreadUnsubscribeResponse;
  readonly "thread/increment_elicitation": V2ThreadIncrementElicitationResponse;
  readonly "thread/decrement_elicitation": V2ThreadDecrementElicitationResponse;
  readonly "thread/name/set": V2ThreadSetNameResponse;
  readonly "thread/goal/set": V2ThreadGoalSetResponse;
  readonly "thread/goal/get": V2ThreadGoalGetResponse;
  readonly "thread/goal/clear": V2ThreadGoalClearResponse;
  readonly "thread/queue/add": V2ThreadQueueAddResponse;
  readonly "thread/queue/list": V2ThreadQueueListResponse;
  readonly "thread/queue/update": V2ThreadQueueUpdateResponse;
  readonly "thread/queue/delete": V2ThreadQueueDeleteResponse;
  readonly "thread/queue/reorder": V2ThreadQueueReorderResponse;
  readonly "thread/queue/start": V2ThreadQueueStartResponse;
  readonly "thread/metadata/update": V2ThreadMetadataUpdateResponse;
  readonly "thread/section/move": V2ThreadSectionMoveResponse;
  readonly "thread/settings/update": V2ThreadSettingsUpdateResponse;
  readonly "thread/memoryMode/set": V2ThreadMemoryModeSetResponse;
  readonly "memory/reset": V2MemoryResetResponse;
  readonly "thread/unarchive": V2ThreadUnarchiveResponse;
  readonly "thread/compact/start": V2ThreadCompactStartResponse;
  readonly "thread/shellCommand": V2ThreadShellCommandResponse;
  readonly "thread/approveGuardianDeniedAction": V2ThreadApproveGuardianDeniedActionResponse;
  readonly "thread/backgroundTerminals/clean": V2ThreadBackgroundTerminalsCleanResponse;
  readonly "thread/backgroundTerminals/list": V2ThreadBackgroundTerminalsListResponse;
  readonly "thread/backgroundTerminals/terminate": V2ThreadBackgroundTerminalsTerminateResponse;
  readonly "thread/rollback": V2ThreadRollbackResponse;
  readonly "thread/revert": V2ThreadRevertResponse;
  readonly "thread/list": V2ThreadListResponse;
  readonly "project/list": V2ProjectListResponse;
  readonly "project/read": V2ProjectReadResponse;
  readonly "project/create": V2ProjectCreateResponse;
  readonly "project/import": V2ProjectImportResponse;
  readonly "project/update": V2ProjectUpdateResponse;
  readonly "project/move": V2ProjectMoveResponse;
  readonly "project/delete": V2ProjectDeleteResponse;
  readonly "threadSection/list": V2ThreadSectionListResponse;
  readonly "threadSection/create": V2ThreadSectionCreateResponse;
  readonly "threadSection/update": V2ThreadSectionUpdateResponse;
  readonly "threadSection/delete": V2ThreadSectionDeleteResponse;
  readonly "thread/search": V2ThreadSearchResponse;
  readonly "thread/searchOccurrences": V2ThreadSearchOccurrencesResponse;
  readonly "thread/loaded/list": V2ThreadLoadedListResponse;
  readonly "thread/read": V2ThreadReadResponse;
  readonly "thread/turns/list": V2ThreadTurnsListResponse;
  readonly "thread/items/list": V2ThreadItemsListResponse;
  readonly "thread/inject_items": V2ThreadInjectItemsResponse;
  readonly "skills/list": V2SkillsListResponse;
  readonly "skills/extraRoots/set": V2SkillsExtraRootsSetResponse;
  readonly "hooks/list": V2HooksListResponse;
  readonly "marketplace/add": V2MarketplaceAddResponse;
  readonly "marketplace/remove": V2MarketplaceRemoveResponse;
  readonly "marketplace/upgrade": V2MarketplaceUpgradeResponse;
  readonly "plugin/list": V2PluginListResponse;
  readonly "plugin/search": V2PluginSearchResponse;
  readonly "plugin/installed": V2PluginInstalledResponse;
  readonly "plugin/reconcile": V2PluginReconcileResponse;
  readonly "plugin/read": V2PluginReadResponse;
  readonly "plugin/skill/read": V2PluginSkillReadResponse;
  readonly "plugin/share/save": V2PluginShareSaveResponse;
  readonly "plugin/share/updateTargets": V2PluginShareUpdateTargetsResponse;
  readonly "plugin/share/list": V2PluginShareListResponse;
  readonly "plugin/share/checkout": V2PluginShareCheckoutResponse;
  readonly "plugin/share/delete": V2PluginShareDeleteResponse;
  readonly "app/read": V2AppsReadResponse;
  readonly "app/list": V2AppsListResponse;
  readonly "app/installed": V2AppsInstalledResponse;
  readonly "fs/readFile": V2FsReadFileResponse;
  readonly "fs/writeFile": V2FsWriteFileResponse;
  readonly "fs/createDirectory": V2FsCreateDirectoryResponse;
  readonly "fs/getMetadata": V2FsGetMetadataResponse;
  readonly "fs/readDirectory": V2FsReadDirectoryResponse;
  readonly "fs/remove": V2FsRemoveResponse;
  readonly "fs/copy": V2FsCopyResponse;
  readonly "fs/watch": V2FsWatchResponse;
  readonly "fs/unwatch": V2FsUnwatchResponse;
  readonly "skills/config/write": V2SkillsConfigWriteResponse;
  readonly "plugin/install": V2PluginInstallResponse;
  readonly "plugin/uninstall": V2PluginUninstallResponse;
  readonly "turn/start": V2TurnStartResponse;
  readonly "turn/settings/update": V2TurnSettingsUpdateResponse;
  readonly "turn/steer": V2TurnSteerResponse;
  readonly "turn/interrupt": V2TurnInterruptResponse;
  readonly "thread/realtime/start": V2ThreadRealtimeStartResponse;
  readonly "thread/realtime/appendAudio": V2ThreadRealtimeAppendAudioResponse;
  readonly "thread/realtime/appendText": V2ThreadRealtimeAppendTextResponse;
  readonly "thread/realtime/appendSpeech": V2ThreadRealtimeAppendSpeechResponse;
  readonly "thread/realtime/stop": V2ThreadRealtimeStopResponse;
  readonly "thread/timeline/list": V2ThreadTimelineListResponse;
  readonly "thread/realtime/listVoices": V2ThreadRealtimeListVoicesResponse;
  readonly "review/start": V2ReviewStartResponse;
  readonly "model/list": V2ModelListResponse;
  readonly "modelProvider/capabilities/read": V2ModelProviderCapabilitiesReadResponse;
  readonly "experimentalFeature/list": V2ExperimentalFeatureListResponse;
  readonly "permissionProfile/list": V2PermissionProfileListResponse;
  readonly "experimentalFeature/enablement/set": V2ExperimentalFeatureEnablementSetResponse;
  readonly "remoteControl/status/read": V2RemoteControlStatusReadResponse;
  readonly "remoteControl/pairing/start": V2RemoteControlPairingStartResponse;
  readonly "remoteControl/pairing/status": V2RemoteControlPairingStatusResponse;
  readonly "remoteControl/client/list": V2RemoteControlClientsListResponse;
  readonly "remoteControl/client/revoke": V2RemoteControlClientsRevokeResponse;
  readonly "collaborationMode/list": V2CollaborationModeListResponse;
  readonly "mock/experimentalMethod": V2MockExperimentalMethodResponse;
  readonly "environment/add": V2EnvironmentAddResponse;
  readonly "environment/info": V2EnvironmentInfoResponse;
  readonly "environment/status": V2EnvironmentStatusResponse;
  readonly "mcpServer/oauth/login": V2McpServerOauthLoginResponse;
  readonly "config/mcpServer/reload": V2McpServerRefreshResponse;
  readonly "mcpServerStatus/list": V2ListMcpServerStatusResponse;
  readonly "mcpServer/resource/read": V2McpResourceReadResponse;
  readonly "mcpServer/event/stream/start": V2McpServerEventStreamStartResponse;
  readonly "mcpServer/event/stream/stop": V2McpServerEventStreamStopResponse;
  readonly "mcpServer/tool/call": V2McpServerToolCallResponse;
  readonly "windowsSandbox/setupStart": V2WindowsSandboxSetupStartResponse;
  readonly "windowsSandbox/readiness": V2WindowsSandboxReadinessResponse;
  readonly "account/login/start": V2LoginAccountResponse;
  readonly "account/bedrock/discover": V2BedrockDiscoverResponse;
  readonly "account/bedrock/setup": V2BedrockSetupResponse;
  readonly "account/login/cancel": V2CancelLoginAccountResponse;
  readonly "account/logout": V2LogoutAccountResponse;
  readonly "account/rateLimits/read": V2GetAccountRateLimitsResponse;
  readonly "account/rateLimitResetCredit/consume": V2ConsumeAccountRateLimitResetCreditResponse;
  readonly "account/usage/read": V2GetAccountTokenUsageResponse;
  readonly "account/workspaceMessages/read": V2GetWorkspaceMessagesResponse;
  readonly "account/sendAddCreditsNudgeEmail": V2SendAddCreditsNudgeEmailResponse;
  readonly "feedback/upload": V2FeedbackUploadResponse;
  readonly "command/exec": V2CommandExecResponse;
  readonly "command/exec/write": V2CommandExecWriteResponse;
  readonly "command/exec/terminate": V2CommandExecTerminateResponse;
  readonly "command/exec/resize": V2CommandExecResizeResponse;
  readonly "process/spawn": V2ProcessSpawnResponse;
  readonly "process/writeStdin": V2ProcessWriteStdinResponse;
  readonly "process/kill": V2ProcessKillResponse;
  readonly "process/resizePty": V2ProcessResizePtyResponse;
  readonly "config/read": V2ConfigReadResponse;
  readonly "externalAgentConfig/detect": V2ExternalAgentConfigDetectResponse;
  readonly "externalAgentConfig/import": V2ExternalAgentConfigImportResponse;
  readonly "externalAgentConfig/import/recordHistory": V2ExternalAgentConfigImportHistoryRecordResponse;
  readonly "externalAgentConfig/import/readHistories": V2ExternalAgentConfigImportHistoriesReadResponse;
  readonly "config/value/write": V2ConfigWriteResponse;
  readonly "config/batchWrite": V2ConfigWriteResponse;
  readonly "configRequirements/read": V2ConfigRequirementsReadResponse;
  readonly "account/read": V2GetAccountResponse;
  readonly getConversationSummary: GetConversationSummaryResponse;
  readonly gitDiffToRemote: GitDiffToRemoteResponse;
  readonly getAuthStatus: GetAuthStatusResponse;
  readonly fuzzyFileSearch: FuzzyFileSearchResponse;
  readonly "fuzzyFileSearch/sessionStart": FuzzyFileSearchSessionStartResponse;
  readonly "fuzzyFileSearch/sessionUpdate": FuzzyFileSearchSessionUpdateResponse;
  readonly "fuzzyFileSearch/sessionStop": FuzzyFileSearchSessionStopResponse;
}

/** Typed params map for server->client requests. */
export interface ServerRequestParamsByMethod {
  readonly "item/commandExecution/requestApproval": V2CommandExecutionRequestApprovalParams;
  readonly "item/fileChange/requestApproval": V2FileChangeRequestApprovalParams;
  readonly "item/tool/requestUserInput": V2ToolRequestUserInputParams;
  readonly "mcpServer/elicitation/request": V2McpServerElicitationRequestParams;
  readonly "item/permissions/requestApproval": V2PermissionsRequestApprovalParams;
  readonly "item/tool/call": V2DynamicToolCallParams;
  readonly "account/chatgptAuthTokens/refresh": V2ChatgptAuthTokensRefreshParams;
  readonly "attestation/generate": V2AttestationGenerateParams;
  readonly "currentTime/read": V2CurrentTimeReadParams;
  readonly applyPatchApproval: ApplyPatchApprovalParams;
  readonly execCommandApproval: ExecCommandApprovalParams;
}

/** Typed result map for server->client requests. */
export interface ServerRequestResultsByMethod {
  readonly "item/commandExecution/requestApproval": V2CommandExecutionRequestApprovalResponse;
  readonly "item/fileChange/requestApproval": V2FileChangeRequestApprovalResponse;
  readonly "item/tool/requestUserInput": V2ToolRequestUserInputResponse;
  readonly "mcpServer/elicitation/request": V2McpServerElicitationRequestResponse;
  readonly "item/permissions/requestApproval": V2PermissionsRequestApprovalResponse;
  readonly "item/tool/call": V2DynamicToolCallResponse;
  readonly "account/chatgptAuthTokens/refresh": V2ChatgptAuthTokensRefreshResponse;
  readonly "attestation/generate": V2AttestationGenerateResponse;
  readonly "currentTime/read": V2CurrentTimeReadResponse;
  readonly applyPatchApproval: ApplyPatchApprovalResponse;
  readonly execCommandApproval: ExecCommandApprovalResponse;
}

/** Typed params map for server notifications. */
export interface ServerNotificationParamsByMethod {
  readonly error: V2ErrorNotification;
  readonly "thread/started": V2ThreadStartedNotification;
  readonly "thread/status/changed": V2ThreadStatusChangedNotification;
  readonly "thread/archived": V2ThreadArchivedNotification;
  readonly "thread/deleted": V2ThreadDeletedNotification;
  readonly "thread/unarchived": V2ThreadUnarchivedNotification;
  readonly "thread/closed": V2ThreadClosedNotification;
  readonly "thread/reverted": V2ThreadRevertedNotification;
  readonly "skills/changed": V2SkillsChangedNotification;
  readonly "thread/name/updated": V2ThreadNameUpdatedNotification;
  readonly "thread/goal/updated": V2ThreadGoalUpdatedNotification;
  readonly "thread/goal/cleared": V2ThreadGoalClearedNotification;
  readonly "thread/queue/changed": V2ThreadQueueChangedNotification;
  readonly "project/changed": V2ProjectChangedNotification;
  readonly "thread/project/updated": V2ThreadProjectUpdatedNotification;
  readonly "thread/environment/connected": V2EnvironmentConnectionNotification;
  readonly "thread/environment/disconnected": V2EnvironmentConnectionNotification;
  readonly "thread/settings/updated": V2ThreadSettingsUpdatedNotification;
  readonly "thread/tokenUsage/updated": V2ThreadTokenUsageUpdatedNotification;
  readonly "turn/started": V2TurnStartedNotification;
  readonly "hook/started": V2HookStartedNotification;
  readonly "turn/completed": V2TurnCompletedNotification;
  readonly "hook/completed": V2HookCompletedNotification;
  readonly "turn/diff/updated": V2TurnDiffUpdatedNotification;
  readonly "turn/plan/updated": V2TurnPlanUpdatedNotification;
  readonly "item/started": V2ItemStartedNotification;
  readonly "item/autoApprovalReview/started": V2ItemGuardianApprovalReviewStartedNotification;
  readonly "item/autoApprovalReview/completed": V2ItemGuardianApprovalReviewCompletedNotification;
  readonly "autoApprovalReview/strictReviewRequired": V2StrictReviewRequiredNotification;
  readonly "item/completed": V2ItemCompletedNotification;
  readonly "rawResponseItem/completed": V2RawResponseItemCompletedNotification;
  readonly "rawResponse/completed": V2RawResponseCompletedNotification;
  readonly "item/agentMessage/delta": V2AgentMessageDeltaNotification;
  readonly "item/plan/delta": V2PlanDeltaNotification;
  readonly "command/exec/outputDelta": V2CommandExecOutputDeltaNotification;
  readonly "process/outputDelta": V2ProcessOutputDeltaNotification;
  readonly "process/exited": V2ProcessExitedNotification;
  readonly "item/commandExecution/outputDelta": V2CommandExecutionOutputDeltaNotification;
  readonly "item/commandExecution/terminalInteraction": V2TerminalInteractionNotification;
  readonly "item/fileChange/outputDelta": V2FileChangeOutputDeltaNotification;
  readonly "item/fileChange/patchUpdated": V2FileChangePatchUpdatedNotification;
  readonly "serverRequest/resolved": V2ServerRequestResolvedNotification;
  readonly "item/mcpToolCall/progress": V2McpToolCallProgressNotification;
  readonly "mcpServer/oauthLogin/completed": V2McpServerOauthLoginCompletedNotification;
  readonly "mcpServer/startupStatus/updated": V2McpServerStatusUpdatedNotification;
  readonly "mcpServer/event/stream/notification": V2McpServerEventStreamNotification;
  readonly "account/updated": V2AccountUpdatedNotification;
  readonly "account/rateLimits/updated": V2AccountRateLimitsUpdatedNotification;
  readonly "app/list/updated": V2AppListUpdatedNotification;
  readonly "remoteControl/status/changed": V2RemoteControlStatusChangedNotification;
  readonly "externalAgentConfig/import/progress": V2ExternalAgentConfigImportProgressNotification;
  readonly "externalAgentConfig/import/completed": V2ExternalAgentConfigImportCompletedNotification;
  readonly "fs/changed": V2FsChangedNotification;
  readonly "item/reasoning/summaryTextDelta": V2ReasoningSummaryTextDeltaNotification;
  readonly "item/reasoning/summaryPartAdded": V2ReasoningSummaryPartAddedNotification;
  readonly "item/reasoning/textDelta": V2ReasoningTextDeltaNotification;
  readonly "thread/compacted": V2ContextCompactedNotification;
  readonly "model/rerouted": V2ModelReroutedNotification;
  readonly "model/verification": V2ModelVerificationNotification;
  readonly "modelProvider/authRecoveryStarted": V2AuthRecoveryNotification;
  readonly "modelProvider/authRecoveryCompleted": V2AuthRecoveryNotification;
  readonly "turn/moderationMetadata": V2TurnModerationMetadataNotification;
  readonly "model/safetyBuffering/updated": V2ModelSafetyBufferingUpdatedNotification;
  readonly warning: V2WarningNotification;
  readonly guardianWarning: V2GuardianWarningNotification;
  readonly deprecationNotice: V2DeprecationNoticeNotification;
  readonly configWarning: V2ConfigWarningNotification;
  readonly "fuzzyFileSearch/sessionUpdated": FuzzyFileSearchSessionUpdatedNotification;
  readonly "fuzzyFileSearch/sessionCompleted": FuzzyFileSearchSessionCompletedNotification;
  readonly "thread/realtime/started": V2ThreadRealtimeStartedNotification;
  readonly "thread/realtime/itemAdded": V2ThreadRealtimeItemAddedNotification;
  readonly "thread/realtime/item/started": V2ThreadRealtimeItemStartedNotification;
  readonly "thread/realtime/item/transcript/delta": V2ThreadRealtimeItemTranscriptDeltaNotification;
  readonly "thread/realtime/item/completed": V2ThreadRealtimeItemCompletedNotification;
  readonly "thread/realtime/transcript/delta": V2ThreadRealtimeTranscriptDeltaNotification;
  readonly "thread/realtime/transcript/done": V2ThreadRealtimeTranscriptDoneNotification;
  readonly "thread/realtime/outputAudio/delta": V2ThreadRealtimeOutputAudioDeltaNotification;
  readonly "thread/realtime/sdp": V2ThreadRealtimeSdpNotification;
  readonly "thread/realtime/error": V2ThreadRealtimeErrorNotification;
  readonly "thread/realtime/closed": V2ThreadRealtimeClosedNotification;
  readonly "windows/worldWritableWarning": V2WindowsWorldWritableWarningNotification;
  readonly "windowsSandbox/setupCompleted": V2WindowsSandboxSetupCompletedNotification;
  readonly "account/login/completed": V2AccountLoginCompletedNotification;
}

export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_METHODS;
export type ClientNotificationMethod = keyof typeof CLIENT_NOTIFICATION_METHODS;
export type ServerRequestMethod = keyof typeof SERVER_REQUEST_METHODS;
export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_METHODS;

/**
 * Methods and notifications that `generate-ts` emits ONLY with `--experimental`.
 * The stable generator output omits them, but the shipped server answers several of them
 * (see ./README.md, "Stable vs --experimental"), so the bindings are generated with
 * `--experimental` and the gap is recorded here instead of being silently lost.
 */
export const EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS = [
  "server/diagnostics",
  "userVerification/status",
  "userVerification/enroll",
  "userVerification/delete",
  "userVerification/verify",
  "thread/increment_elicitation",
  "thread/decrement_elicitation",
  "thread/queue/add",
  "thread/queue/list",
  "thread/queue/update",
  "thread/queue/delete",
  "thread/queue/reorder",
  "thread/queue/start",
  "thread/settings/update",
  "thread/memoryMode/set",
  "memory/reset",
  "thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "project/list",
  "project/read",
  "project/create",
  "project/import",
  "project/update",
  "project/move",
  "project/delete",
  "thread/search",
  "thread/searchOccurrences",
  "plugin/search",
  "turn/settings/update",
  "thread/realtime/start",
  "thread/realtime/appendAudio",
  "thread/realtime/appendText",
  "thread/realtime/appendSpeech",
  "thread/realtime/stop",
  "thread/timeline/list",
  "thread/realtime/listVoices",
  "remoteControl/status/read",
  "remoteControl/pairing/start",
  "remoteControl/pairing/status",
  "remoteControl/client/list",
  "remoteControl/client/revoke",
  "collaborationMode/list",
  "mock/experimentalMethod",
  "environment/add",
  "environment/info",
  "environment/status",
  "mcpServer/event/stream/start",
  "mcpServer/event/stream/stop",
  "account/bedrock/discover",
  "account/bedrock/setup",
  "process/spawn",
  "process/writeStdin",
  "process/kill",
  "process/resizePty",
  "fuzzyFileSearch/sessionStart",
  "fuzzyFileSearch/sessionUpdate",
  "fuzzyFileSearch/sessionStop"
] as const;
export const EXPERIMENTAL_ONLY_SERVER_REQUEST_METHODS = [
  "currentTime/read"
] as const;
export const EXPERIMENTAL_ONLY_SERVER_NOTIFICATION_METHODS = [] as const;

/** The codex-cli release these bindings were generated from. */
export const CODEX_PROTOCOL_CLI_VERSION = "0.154.0";
