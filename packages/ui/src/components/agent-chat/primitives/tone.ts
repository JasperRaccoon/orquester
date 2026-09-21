/**
 * The five tones every agent-chat surface speaks in, and the Orquester tokens
 * each one maps to.
 *
 * There is no sixth tone and no per-component colour: an icon, a dot, a banner
 * and a row heading that mean the same thing must pick the same tone here, or
 * the surface stops being readable at a glance. In particular (spec §7.3):
 *
 *   - a non-zero command exit is `muted`, not `danger` — only a `runtime.error`
 *     or a `*.failed` lifecycle event earns the destructive treatment;
 *   - `runtime.warning` is `warn`, distinct from both;
 *   - an idle-but-resumable agent is `muted`, never `info` — a live-coloured
 *     idle dot reads as stuck.
 *     *T3: apps/web/src/components/AgentsPanel.tsx:42-44*
 */
export type ChatTone = "muted" | "neutral" | "info" | "ok" | "warn" | "danger";

/** Foreground/icon colour per tone. */
export const TONE_TEXT: Record<ChatTone, string> = {
  muted: "text-neutral-500",
  neutral: "text-neutral-300",
  info: "text-info",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger"
};

/** `currentcolor` carrier for a filled shape (status dot, meter arc). */
export const TONE_FILL: Record<ChatTone, string> = {
  muted: "text-neutral-600",
  neutral: "text-neutral-400",
  info: "text-info",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger"
};

/**
 * Wash + hairline for a banded surface (banner, inline notice). Always used
 * with the matching {@link TONE_BAND_TEXT}; the `-soft` steps are the wash
 * bases and are only ever applied through an alpha modifier, as the preset
 * documents.
 */
export const TONE_BAND: Record<ChatTone, string> = {
  muted: "border-neutral-800 bg-neutral-900/40",
  neutral: "border-neutral-800 bg-neutral-900/60",
  info: "border-info-900/50 bg-info-soft/30",
  ok: "border-ok-900/50 bg-ok-soft/30",
  warn: "border-warn-900/50 bg-warn-soft/30",
  danger: "border-danger-900/50 bg-danger-soft/40"
};

/** Text colour that survives its own {@link TONE_BAND} wash in both modes. */
export const TONE_BAND_TEXT: Record<ChatTone, string> = {
  muted: "text-neutral-400",
  neutral: "text-neutral-200",
  info: "text-info-300",
  ok: "text-ok-300",
  warn: "text-warn-300",
  danger: "text-danger-300"
};
