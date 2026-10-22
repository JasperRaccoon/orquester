/**
 * The Browser tab's VM rules (Ephemeral AI VMs: the VM browser): a project on
 * a Linux box runs its tab's Chromium in the box, so it needs no Chromium on
 * the host; macOS and Windows boxes and host projects use the host's. Pure:
 * the "+" menu and the browser toolbar render these answers.
 */

import type { BoxKind, BrowserSummary } from "@orquester/api";

/** Whether a project box of this kind runs its Browser tab's Chromium itself (the daemon's rule). */
export function boxKindRunsBrowser(kind: BoxKind | null | undefined): boolean {
  return kind === "linux" || kind === "linux-gpu";
}

export type BrowserMenuEntry =
  | { kind: "open" }
  /** The transport cannot stream frames (the desktop unix socket). */
  | { kind: "no-channel" }
  /** Host Chromium needed and none detected. */
  | { kind: "no-chromium" };

/**
 * The "+" menu's Browser entry: offered when frames can stream and a Chromium
 * can run — the host's (detected) or, for a Linux box project, the box's.
 */
export function browserMenuEntry(input: {
  hasChannel: boolean;
  hostChromium: boolean;
  /** The current project's box kind; null for a host project. */
  boxKind: BoxKind | null;
}): BrowserMenuEntry {
  if (!input.hasChannel) return { kind: "no-channel" };
  if (input.hostChromium || boxKindRunsBrowser(input.boxKind)) return { kind: "open" };
  return { kind: "no-chromium" };
}

/** The starting overlay's line for a tab whose Chromium starts in the VM; null otherwise. */
export function vmStartingText(browser: Pick<BrowserSummary, "status" | "runsIn" | "progress">): string | null {
  if (browser.runsIn !== "box" || browser.status !== "starting") return null;
  return browser.progress?.trim() || "Starting Chromium in the VM…";
}

/** The no-sandbox warning's tooltip, where the Chromium runs. */
export function unsandboxedTitle(runsIn: BrowserSummary["runsIn"]): string {
  return runsIn === "box" ? "Chromium is running without its sandbox in the VM" : "Chromium is running without its sandbox on this host";
}
