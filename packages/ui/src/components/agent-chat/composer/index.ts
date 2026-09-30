/**
 * The composer (spec §7.4, §4.6.5–§4.6.8, §7.8).
 *
 * `ChatComposer` is the only component the integration layer mounts. The
 * bridge is how every other surface reaches the draft: the timeline's "return
 * this queued message", a browser-pick payload and a session upload targeting
 * a chat tab all go through {@link insertComposerText}, never through a pane.
 */

export { ChatComposer, type ChatComposerExtraProps } from "./ChatComposer";
export { ComposerPrimaryActions, type ComposerPrimaryActionsProps } from "./ComposerPrimaryActions";
export { ComposerAttachments, type StagedAttachment } from "./ComposerAttachments";
export { ComposerTokenMenu, type ComposerTokenMenuProps } from "./ComposerTokenMenu";
export {
  AccountChip,
  ModelChip,
  OptionChip,
  PlanChip,
  RuntimeModeChip,
  type ModelChipProps,
  type OptionChipProps,
  type PlanChipProps,
  type RuntimeModeChipProps
} from "./ComposerChips";
export {
  ComposerPopover,
  ComposerMenuRow,
  type ComposerPopoverProps,
  type ComposerMenuRowProps
} from "./ComposerPopover";
export {
  RewindConfirmPanel,
  RewindControl,
  REWIND_BUSY_TITLE,
  REWIND_DISABLED_EXPLAINS_ITSELF,
  REWIND_ESCAPE_HINT,
  REWIND_ESCAPE_HINT_MS,
  rewindDroppedTurnCount,
  rewindPickerEnabled,
  type RewindConfirmPanelProps,
  type RewindControlProps
} from "./RewindControl";

export {
  COMPOSER_NOT_MOUNTED_REASON,
  composerHandle,
  focusComposer,
  insertComposerText,
  openComposerControl,
  registerComposerHandle,
  restoreComposerFailedSend,
  returnComposerMessage,
  stageComposerAttachment,
  submitComposerText,
  type ComposerHandle,
  type ComposerSubmitResult
} from "./composer-bridge";

export {
  beginComposerSend,
  isComposerSending,
  subscribeComposerSends
} from "./composer-sends";
export { useComposerSending } from "./use-composer-sending";

export {
  detectComposerTrigger,
  extendReplacementRangeForTrailingSpace,
  isTriggerAtPromptStart,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
  type ComposerTrigger,
  type ComposerTriggerKind
} from "./composer-trigger";

export {
  buildSkillMenuItems,
  buildSlashMenuItems,
  compactCommandAvailable,
  formatSkillDisplayName,
  menuItemAction,
  menuItemReplacement,
  skillMentionsInText,
  type ComposerMenuItem,
  type HostComposerCommand,
  type SlashMenuItem
} from "./composer-menu";

export {
  attachmentCountBlockSend,
  attachmentRejectionReason,
  composerPromptLengthValidationMessage,
  composerSubmissionIntentForEnter,
  composerSubmissionValidationMessage,
  decideStagedAttachmentForRef,
  hasSendableContent,
  isPasteAsTextShortcut,
  isSupportedAttachmentImage,
  mergeMessageIntoDraft,
  nextPastedTextFileName,
  pastedTextDisposition,
  proposedPlanTitle,
  resolveFollowUpDisposition,
  resolvePlanFollowUpSubmission,
  submitIsNoOp,
  swallowsStandalonePlanCommand,
  uploadsBlockSend,
  type ComposerSubmissionIntent,
  type FollowUpBehavior,
  type PastedTextDisposition,
  type SendShortcut,
  type StagedAttachmentLike,
  type StageRefDecision
} from "./composer-submission";

export {
  composerDraftToPersist,
  createDraftPersistScheduler,
  draftAfterReturn,
  EMPTY_PERSISTED_DRAFT,
  loadComposerDraft,
  persistedDraftAfterReturn,
  persistedDraftAfterSend,
  persistedDraftsEqual,
  type DraftPersistScheduler,
  type LoadedComposerDraft,
  type PersistableAttachment
} from "./composer-draft";

export {
  isComposerCollapsedMobile,
  resolveComposerTimelineInset
} from "./composer-inset";

export {
  findComposerShortcutTarget,
  resolveChatShortcut,
  shortcutLabelFor,
  type ChatShortcutCommand,
  type ChatShortcutEventLike,
  type ComposerShortcutCommand
} from "./composer-shortcuts";

export {
  composerOwnsEscape,
  isChatTabListenerActive,
} from "./tab-visibility";

export {
  applyEffortArgument,
  applyModelSelection,
  applyOptionSelection,
  currentOptionValue,
  findReasoningDescriptor,
  modelChipLabel,
  optionChoiceLabel,
  optionDescriptors,
  REASONING_OPTION_IDS,
  resolveSelectedModel
} from "./composer-model";


export { useComposerPathSearch, type ComposerPathSearch } from "./use-composer-path-search";
