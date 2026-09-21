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
  composerHandle,
  focusComposer,
  insertComposerText,
  openComposerControl,
  registerComposerHandle,
  type ComposerHandle
} from "./composer-bridge";

export {
  detectComposerTrigger,
  extendReplacementRangeForTrailingSpace,
  isStandaloneCompactCommand,
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
  isProviderSkillUserInvocable,
  menuItemReplacement,
  providerCommandDescription,
  providerCommandsForSlashMenu,
  searchSkills,
  searchSlashMenuItems,
  skillsForSkillMenu,
  skillsForSlashMenu,
  slashMenuItemsForPromptPosition,
  type ComposerMenuItem,
  type HostComposerCommand,
  type SlashMenuItem
} from "./composer-menu";

export {
  attachmentRejectionReason,
  buildPlanImplementationPrompt,
  composerPromptLengthValidationMessage,
  composerSubmissionIntentForEnter,
  composerSubmissionValidationMessage,
  hasSendableContent,
  isPasteAsTextShortcut,
  isSupportedAttachmentImage,
  nextPastedTextFileName,
  pastedTextDisposition,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
  proposedPlanTitle,
  resolveFollowUpDisposition,
  resolvePlanFollowUpSubmission,
  uploadsBlockSend,
  type ComposerSubmissionIntent,
  type FollowUpBehavior,
  type PastedTextDisposition,
  type SendShortcut
} from "./composer-submission";

export {
  COMPOSER_RESTING_EXPANSION_MIN_PX,
  isComposerCollapsedMobile,
  resolveComposerTimelineInset
} from "./composer-inset";

export {
  COMPOSER_KEYBINDINGS,
  COMPOSER_SHORTCUT_COMMANDS,
  findComposerShortcutTarget,
  matchComposerKeybinding,
  shortcutComboFor,
  type ComposerKeybinding,
  type ComposerShortcutCommand
} from "./composer-shortcuts";

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

export {
  DEFAULT_COMPOSER_PREFERENCES,
  loadComposerPreferences,
  parseComposerPreferences,
  saveComposerPreferences,
  type ComposerPreferences
} from "./composer-prefs";

export { useComposerPathSearch, type ComposerPathSearch } from "./use-composer-path-search";
