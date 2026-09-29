/**
 * The marketplace form's rules (agent profile spec §7.4): a GitHub
 * `owner/repo`, a git URL or a local path, each with an optional ref (not
 * for a path) and an optional name.
 */

import type { MarketplaceDraft, MarketplaceSource } from "@orquester/api";

export type MarketplaceSourceType = MarketplaceSource["type"];

export interface MarketplaceForm {
  type: MarketplaceSourceType;
  repo: string;
  url: string;
  path: string;
  ref: string;
  name: string;
}

export function initialMarketplaceForm(): MarketplaceForm {
  return { type: "github", repo: "", url: "", path: "", ref: "", name: "" };
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `owner/repo`, also from a pasted `https://github.com/owner/repo(.git)`; `null` when it is neither. */
export function normalizeGithubRepo(text: string): string | null {
  const trimmed = text.trim();
  if (REPO.test(trimmed)) return trimmed;
  const match = GITHUB_URL.exec(trimmed);
  return match ? `${match[1]}/${match[2]}` : null;
}

function looksLikeGitUrl(text: string): boolean {
  return /^(https?|ssh|git|file):\/\/\S+$/.test(text) || /^[\w.-]+@[\w.-]+:\S+$/.test(text);
}

export interface MarketplaceValidation {
  valid: boolean;
  errors: { source?: string; name?: string; ref?: string };
}

export function validateMarketplaceForm(form: MarketplaceForm): MarketplaceValidation {
  const errors: MarketplaceValidation["errors"] = {};
  if (form.type === "github") {
    if (form.repo.trim() === "") errors.source = "Enter the repository as owner/repo";
    else if (normalizeGithubRepo(form.repo) === null) errors.source = "Use owner/repo, like anthropics/claude-plugins";
  } else if (form.type === "git") {
    if (form.url.trim() === "") errors.source = "Enter the repository's URL";
    else if (!looksLikeGitUrl(form.url.trim())) errors.source = "Use an https://, ssh:// or git@host:path URL";
  } else if (form.path.trim() === "") {
    errors.source = "Enter the folder's path on the daemon's machine";
  } else if (!/^(\/|~)/.test(form.path.trim())) {
    errors.source = "Use an absolute path (/…) or one under ~";
  }
  if (form.type !== "path" && /\s/.test(form.ref.trim())) errors.ref = "A branch, tag or commit, without spaces";
  if (form.name.trim() !== "" && !NAME.test(form.name.trim())) {
    errors.name = "Letters, digits, ., - and _ only";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function marketplaceDraftFromForm(form: MarketplaceForm): MarketplaceDraft {
  const ref = form.ref.trim();
  let source: MarketplaceSource;
  if (form.type === "github") {
    source = { type: "github", repo: normalizeGithubRepo(form.repo) ?? form.repo.trim() };
    if (ref !== "") source.ref = ref;
  } else if (form.type === "git") {
    source = { type: "git", url: form.url.trim() };
    if (ref !== "") source.ref = ref;
  } else {
    source = { type: "path", path: form.path.trim() };
  }
  const draft: MarketplaceDraft = { source };
  if (form.name.trim() !== "") draft.name = form.name.trim();
  return draft;
}
