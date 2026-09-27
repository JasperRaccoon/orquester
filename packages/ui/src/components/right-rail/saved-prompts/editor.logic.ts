/**
 * The saved-prompt editor's rules: the draft a request opens with, the limits
 * it mirrors (the daemon enforces them; the editor says so before a round
 * trip), what a save sends — the whole record on create, only what changed on
 * edit — and where a variable chip lands in the body.
 *
 * Pure, no React.
 */

import {
  SAVED_PROMPT_BODY_MAX,
  SAVED_PROMPT_DESCRIPTION_MAX,
  SAVED_PROMPT_TAG_MAX,
  SAVED_PROMPT_TAGS_MAX,
  SAVED_PROMPT_TITLE_MAX,
  type CreateSavedPromptRequest,
  type SavedPrompt,
  type UpdateSavedPromptRequest
} from "@orquester/api";

import type { SavedPromptEditorRequest } from "./editor-bridge";

export type SavedPromptEditorScope = "global" | "project";

/** What the form holds, as typed. */
export interface SavedPromptDraft {
  title: string;
  description: string;
  /** Comma-separated, as typed; normalised on save. */
  tagsText: string;
  scope: SavedPromptEditorScope;
  pinned: boolean;
  body: string;
}

/** Tags as saved: split on commas, trimmed, inner whitespace collapsed, empties dropped, unique (case-insensitive, first spelling wins). */
export function parseTagsText(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim().replace(/\s+/g, " ");
    if (tag.length === 0) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

export function formatTagsText(tags: readonly string[]): string {
  return tags.join(", ");
}

/** A description is one line: trimmed, any run of whitespace (a pasted newline) one space. */
export function normalizeDescription(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** The draft a request opens with. A duplicate or "Save as prompt" arrives as a prefilled create. */
export function initialDraft(request: SavedPromptEditorRequest): SavedPromptDraft {
  if (request.mode === "edit") {
    const { prompt } = request;
    return {
      title: prompt.title,
      description: prompt.description,
      tagsText: formatTagsText(prompt.tags),
      scope: prompt.projectPath === null ? "global" : "project",
      pinned: prompt.pinned,
      body: prompt.body
    };
  }
  const initial = request.initial ?? {};
  return {
    title: initial.title ?? "",
    description: initial.description ?? "",
    tagsText: formatTagsText(initial.tags ?? []),
    scope: initial.scope === "project" && projectScopeAvailable(request) ? "project" : "global",
    pinned: false,
    body: initial.body ?? ""
  };
}

/** "This project" can be chosen: a project is open, or the prompt being edited already belongs to one. */
export function projectScopeAvailable(request: SavedPromptEditorRequest): boolean {
  if (request.projectPath !== null && request.projectPath.length > 0) return true;
  return request.mode === "edit" && request.prompt.projectPath !== null;
}

export interface SavedPromptDraftValidation {
  /** Save may go ahead. */
  valid: boolean;
  /** Over a limit — shown beside the field at once. */
  errors: { title?: string; description?: string; tags?: string; body?: string };
  /** Required and still empty — not an error to shout about, but Save waits for it. */
  missing: ("title" | "body")[];
}

const count = (value: number): string => value.toLocaleString("en-US");

export function validateSavedPromptDraft(draft: SavedPromptDraft): SavedPromptDraftValidation {
  const errors: SavedPromptDraftValidation["errors"] = {};
  const missing: SavedPromptDraftValidation["missing"] = [];
  const title = draft.title.trim();
  if (title.length === 0) missing.push("title");
  else if (title.length > SAVED_PROMPT_TITLE_MAX) {
    errors.title = `At most ${count(SAVED_PROMPT_TITLE_MAX)} characters.`;
  }
  if (normalizeDescription(draft.description).length > SAVED_PROMPT_DESCRIPTION_MAX) {
    errors.description = `At most ${count(SAVED_PROMPT_DESCRIPTION_MAX)} characters.`;
  }
  const tags = parseTagsText(draft.tagsText);
  const long = tags.find((tag) => tag.length > SAVED_PROMPT_TAG_MAX);
  if (tags.length > SAVED_PROMPT_TAGS_MAX) {
    errors.tags = `At most ${SAVED_PROMPT_TAGS_MAX} tags.`;
  } else if (long !== undefined) {
    errors.tags = `“${long}” is longer than ${SAVED_PROMPT_TAG_MAX} characters.`;
  }
  if (draft.body.trim().length === 0) missing.push("body");
  else if (draft.body.length > SAVED_PROMPT_BODY_MAX) {
    errors.body = `At most ${count(SAVED_PROMPT_BODY_MAX)} characters.`;
  }
  return { valid: missing.length === 0 && Object.keys(errors).length === 0, errors, missing };
}

/** A create sends the whole record; "This project" means the open project. */
export function createRequestFromDraft(
  draft: SavedPromptDraft,
  projectPath: string | null
): CreateSavedPromptRequest {
  return {
    title: draft.title.trim(),
    body: draft.body,
    description: normalizeDescription(draft.description),
    tags: parseTagsText(draft.tagsText),
    projectPath: draft.scope === "project" && projectPath ? projectPath : null,
    pinned: draft.pinned
  };
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/**
 * An edit sends only what changed — so a field another client changed while
 * this editor was open is not written back with its old value. Keeping the
 * scope sends no `projectPath` at all (a project prompt stays in ITS project,
 * whatever project is open); switching it moves the prompt.
 */
export function updatePatchFromDraft(
  prompt: SavedPrompt,
  draft: SavedPromptDraft,
  projectPath: string | null
): UpdateSavedPromptRequest {
  const patch: UpdateSavedPromptRequest = {};
  const title = draft.title.trim();
  if (title !== prompt.title) patch.title = title;
  const description = normalizeDescription(draft.description);
  if (description !== prompt.description) patch.description = description;
  if (draft.body !== prompt.body) patch.body = draft.body;
  const tags = parseTagsText(draft.tagsText);
  if (!sameTags(tags, prompt.tags)) patch.tags = tags;
  if (draft.pinned !== prompt.pinned) patch.pinned = draft.pinned;
  const wasGlobal = prompt.projectPath === null;
  if (draft.scope === "global" && !wasGlobal) patch.projectPath = null;
  else if (draft.scope === "project" && wasGlobal && projectPath) patch.projectPath = projectPath;
  return patch;
}

const COPY_SUFFIX = " (copy)";

/**
 * "<title> (copy)", the title shortened so the whole still fits the limit
 * (UTF-16 units, as the daemon counts) — cut between code points, never
 * through the middle of an emoji's surrogate pair.
 */
export function duplicateTitle(title: string): string {
  const base = title.trim();
  const room = SAVED_PROMPT_TITLE_MAX - COPY_SUFFIX.length;
  if (base.length <= room) return `${base}${COPY_SUFFIX}`;
  let cut = "";
  for (const codePoint of Array.from(base)) {
    if (cut.length + codePoint.length > room) break;
    cut += codePoint;
  }
  return `${cut.trimEnd()}${COPY_SUFFIX}`;
}

/** Duplicate: the editor opens as a create, prefilled from `prompt`, in the prompt's own scope. */
export function duplicateRequest(
  prompt: SavedPrompt,
  projectPath: string | null
): SavedPromptEditorRequest {
  return {
    mode: "create",
    projectPath,
    initial: {
      title: duplicateTitle(prompt.title),
      body: prompt.body,
      description: prompt.description,
      tags: [...prompt.tags],
      scope: prompt.projectPath === null ? "global" : "project"
    }
  };
}

/** `token` replaces the selection `[start, end)` of `text`; the caret goes right after it. */
export function insertAtSelection(
  text: string,
  start: number,
  end: number,
  token: string
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: `${text.slice(0, from)}${token}${text.slice(to)}`, caret: from + token.length };
}
