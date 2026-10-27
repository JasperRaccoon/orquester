/**
 * Presentation logic for a multi-file diff (no React): each file section's
 * markers, what an empty section says, and which sections start collapsed.
 * `DiffFilesView` renders it; it is pure so it can be tested without a DOM.
 */

import { classifyChangedFile } from "@orquester/api";

import type { DiffFile } from "./git-diff";

/**
 * What the daemon's bounded git runner appends to a patch it cut at its
 * output cap (`agent-host/checkpoints/git.ts`, `OUTPUT_TRUNCATED_MARKER`).
 */
const TRUNCATION_MARKER = "\n\n[truncated]";

/** The patch without the cut marker, and whether there was one. */
export function splitTruncationMarker(diff: string): { text: string; truncated: boolean } {
  return diff.endsWith(TRUNCATION_MARKER)
    ? { text: diff.slice(0, -TRUNCATION_MARKER.length), truncated: true }
    : { text: diff, truncated: false };
}

export type DiffFileBadgeTone = "added" | "deleted" | "renamed" | "neutral";

export interface DiffFileBadge {
  label: string;
  tone: DiffFileBadgeTone;
}

/** A file section's header markers: its change, a mode change, binary. */
export function diffFileBadges(file: DiffFile): DiffFileBadge[] {
  const badges: DiffFileBadge[] = [];
  if (file.change === "added") badges.push({ label: "Added", tone: "added" });
  else if (file.change === "deleted") badges.push({ label: "Deleted", tone: "deleted" });
  else if (file.change === "renamed") badges.push({ label: "Renamed", tone: "renamed" });
  else if (file.change === "copied") badges.push({ label: "Copied", tone: "renamed" });
  if (file.oldMode !== null && file.newMode !== null && file.oldMode !== file.newMode) {
    badges.push({ label: `Mode ${file.oldMode} → ${file.newMode}`, tone: "neutral" });
  }
  if (file.binary) badges.push({ label: "Binary", tone: "neutral" });
  return badges;
}

/** What a section with no hunks says in place of rows. */
export function diffFileEmptyLabel(file: DiffFile): string {
  if (file.binary) return "Binary file not shown";
  if (file.change === "renamed") return "Renamed without content changes";
  if (file.change === "copied") return "Copied without content changes";
  if (file.change === "added") return "Empty file added";
  if (file.change === "deleted") return "Empty file deleted";
  if (file.oldMode !== null && file.newMode !== null && file.oldMode !== file.newMode) {
    return "Only the file mode changed";
  }
  return "No content changes";
}

/** Past this many rows a file starts collapsed, so one huge file cannot stall the view. */
const LARGE_DIFF_FILE_ROWS = 1_000;

/**
 * Lockfiles and other generated output start collapsed (they are rarely what
 * a reviewer reads, and often the longest thing in a change), as do very long
 * files. Everything else starts open.
 */
export function collapsedByDefault(file: DiffFile): boolean {
  if (classifyChangedFile(file.path) === "generated") return true;
  const rows = file.hunks.reduce((sum, hunk) => sum + hunk.rows.length, 0);
  return rows > LARGE_DIFF_FILE_ROWS;
}

/** A stable per-section key: the same path can appear twice in a patch (a copy and its source). */
export function diffFileKey(file: DiffFile, index: number): string {
  return `${index}\u0000${file.oldPath ?? ""}\u0000${file.newPath ?? ""}`;
}
