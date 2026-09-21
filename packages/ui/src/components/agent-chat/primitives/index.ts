/**
 * Shared presentational primitives for the agent chat GUI.
 *
 * Every chat surface — timeline, composer, banners, roster, status line —
 * builds from these, so that four independently-written components end up
 * being one interface. If you find yourself writing a second shimmer, a second
 * status dot or a second disclosure, extend the one here instead.
 *
 * The motion they depend on lives in `packages/ui/src/styles/agent-chat.css`
 * (the `ac-*` utilities); the design reference that explains every value is
 * `docs/superpowers/research/2026-09-20-agent-gui/t3-6-design-language.md`.
 */

export { ShimmerText, type ShimmerTextProps } from "./ShimmerText";
export { StatusDot, type StatusDotProps, type StatusDotSize } from "./StatusDot";
export { WorkingIndicator, type WorkingIndicatorProps } from "./WorkingIndicator";
export {
  Disclosure,
  DisclosurePanel,
  DisclosureChevron,
  type DisclosureProps,
  type DisclosurePanelProps,
  type DisclosureChevronProps
} from "./Disclosure";
export { Kbd, type KbdProps } from "./Kbd";
export { MeterRing, type MeterRingProps } from "./MeterRing";
export { ElapsedTicker, type ElapsedTickerProps } from "./ElapsedTicker";
export {
  BannerCard,
  type BannerCardProps,
  type BannerVariant,
  type BannerDensity
} from "./BannerCard";
export {
  ChatIconButton,
  type ChatIconButtonProps,
  type ChatIconButtonSize,
  type ChatIconButtonVariant
} from "./ChatIconButton";
export { CopyButton, COPY_FEEDBACK_MS, type CopyButtonProps } from "./CopyButton";
export { ScrollToBottomButton, type ScrollToBottomButtonProps } from "./ScrollToBottomButton";

export { formatElapsed, elapsedBetween, type ElapsedStamp } from "./elapsed";
export {
  clampMeterPercent,
  isMeterOverloaded,
  meterDashOffset,
  formatMeterPercent,
  METER_OVERLOAD_PERCENT
} from "./meter";
export { shortcutKeys, isAppleLike } from "./shortcut";
export { useVisibleAnimation, observeVisibleAnimation } from "./visible-animation";
export {
  TONE_TEXT,
  TONE_FILL,
  TONE_BAND,
  TONE_BAND_TEXT,
  type ChatTone
} from "./tone";
