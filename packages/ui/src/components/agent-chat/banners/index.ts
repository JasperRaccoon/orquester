/**
 * The docked banners (spec §7.5, the banner half of §7.6).
 *
 * `ChatBannerDock` is the only component the integration layer mounts; the
 * cards are exported for tests and for anything that needs one in isolation.
 */

export { ChatBannerDock, type ChatBannerDockExtraProps, type DockNotice } from "./ChatBannerDock";
export { ApprovalCard, type ApprovalCardProps } from "./ApprovalCard";
export { QuestionCard, type QuestionCardProps, type QuestionAttachment } from "./QuestionCard";
export { PlanReadyBanner, type PlanReadyBannerProps } from "./PlanReadyBanner";
export {
  BackgroundLivenessBanner,
  type BackgroundLivenessBannerProps
} from "./BackgroundLivenessBanner";

export {
  approvalDetailAriaLabel,
  approvalDetailIsProse,
  approvalKindLabel,
  backgroundLivenessTitle,
  bannerPriority,
  DEFAULT_APPROVAL_OPTIONS,
  resolveDockCard,
  showBackgroundLivenessBanner,
  sortBannerStack,
  splitApprovalOptions,
  type BannerPriority,
  type BannerStackEntry,
  type BannerVariantName,
  type DockCard
} from "./banner-model";

export {
  allowsAnswerAttachments,
  allowsCustomAnswer,
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  isOtherOption,
  isSecretQuestion,
  questionAttachmentKey,
  questionOptionValue,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingAnswerDraft,
  type PendingUserInputProgress,
  type Question,
  type QuestionFlags,
  type QuestionOption,
  type QuestionOptionFlags
} from "./pending-answer";
