import type { ForgeLink, GitHubChecksSummary, GitHubLinkPreview } from "@orquester/api";

/**
 * What a forge link pill shows: its icon, the tone that colours it, and the
 * state's words — GitHub's own semantics (open green, merged purple, closed
 * red, draft grey; a completed issue purple, a not-planned one grey). Before a
 * preview loads, or for links that never have one, the icon names the kind of
 * thing linked and the tone is neutral.
 */

export type ForgePillIcon =
  | "pull"
  | "pull-draft"
  | "pull-merged"
  | "pull-closed"
  | "issue"
  | "issue-done"
  | "issue-not-planned"
  | "discussion"
  | "commit"
  | "repo"
  | "file"
  | "folder"
  | "release"
  | "run"
  | "gitlab"
  | "bitbucket";

export type ForgePillTone = "open" | "merged" | "closed" | "draft" | "neutral";

export interface ForgePillPresentation {
  icon: ForgePillIcon;
  tone: ForgePillTone;
  /** "Open", "Merged", "Draft", "Closed", "Closed as not planned"; null before a preview. */
  stateLabel: string | null;
}

function fromPreview(preview: GitHubLinkPreview): ForgePillPresentation | null {
  if (preview.kind === "pull") {
    switch (preview.state) {
      case "open":
        return { icon: "pull", tone: "open", stateLabel: "Open" };
      case "draft":
        return { icon: "pull-draft", tone: "draft", stateLabel: "Draft" };
      case "merged":
        return { icon: "pull-merged", tone: "merged", stateLabel: "Merged" };
      case "closed":
        return { icon: "pull-closed", tone: "closed", stateLabel: "Closed" };
    }
  }
  if (preview.kind === "issue") {
    if (preview.state === "open") return { icon: "issue", tone: "open", stateLabel: "Open" };
    return preview.stateReason === "not_planned"
      ? { icon: "issue-not-planned", tone: "draft", stateLabel: "Closed as not planned" }
      : { icon: "issue-done", tone: "merged", stateLabel: "Closed" };
  }
  return null;
}

export function forgePillPresentation(link: ForgeLink, preview: GitHubLinkPreview | null): ForgePillPresentation {
  const loaded = preview ? fromPreview(preview) : null;
  if (loaded) return loaded;
  if (link.forge === "gitlab") return { icon: "gitlab", tone: "neutral", stateLabel: null };
  if (link.forge === "bitbucket") return { icon: "bitbucket", tone: "neutral", stateLabel: null };
  const icon: ForgePillIcon = (() => {
    switch (link.kind) {
      case "pull":
        return "pull";
      case "issue":
        return "issue";
      case "discussion":
        return "discussion";
      case "commit":
        return "commit";
      case "repo":
        return "repo";
      case "blob":
        return "file";
      case "tree":
        return "folder";
      case "release":
        return "release";
      case "actions-run":
        return "run";
    }
  })();
  return { icon, tone: "neutral", stateLabel: null };
}

export type ChecksTone = "passed" | "failed" | "pending" | "neutral";

/** One line for a PR's checks: the tone of the worst outcome and the counts that matter. */
export function checksPresentation(checks: GitHubChecksSummary | null): { tone: ChecksTone; label: string } | null {
  if (!checks || checks.total === 0) return null;
  const parts: string[] = [];
  if (checks.failed > 0) parts.push(`${checks.failed} failing`);
  if (checks.pending > 0) parts.push(`${checks.pending} pending`);
  if (checks.passed > 0) parts.push(`${checks.passed} passed`);
  if (checks.skipped > 0) parts.push(`${checks.skipped} skipped`);
  const tone: ChecksTone = checks.failed > 0 ? "failed" : checks.pending > 0 ? "pending" : checks.passed > 0 ? "passed" : "neutral";
  const noun = checks.total === 1 ? "check" : "checks";
  return { tone, label: `${checks.total} ${noun}: ${parts.join(", ")}` };
}

/** The verb-and-time line under a preview's title, e.g. "merged" + the merge time. */
export function previewTimeline(preview: GitHubLinkPreview): { verb: string; at: string | null } {
  if (preview.kind === "commit") return { verb: "committed", at: preview.committedAt ?? preview.authoredAt };
  if (preview.kind === "pull" && preview.state === "merged") return { verb: "merged", at: preview.mergedAt ?? preview.updatedAt };
  if (preview.state === "closed") return { verb: "closed", at: preview.closedAt ?? preview.updatedAt };
  return { verb: "opened", at: preview.createdAt };
}
