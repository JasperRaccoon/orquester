/**
 * Saved prompts — the right rail's prompt library, global and per project.
 *
 * Owned by the daemon so every client (desktop, web, phone) shares one list:
 * persisted at `<appdir>/daemon/saved-prompts.json`, served by
 * `/api/saved-prompts`, and every change is broadcast on the `/events` channel
 * {@link SAVED_PROMPTS_CHANNEL} so each open client updates live.
 *
 * Also the `{variable}` template rules — which names exist, which context a
 * body pulls in, and how a body renders. Pure: the client gathers the values
 * (the project, git, the clock, the target chat) and renders here, so the
 * rules live in one place.
 */

// ---------------------------------------------------------------------------
// Limits (enforced by the daemon; the editor mirrors them)
// ---------------------------------------------------------------------------

export const SAVED_PROMPT_TITLE_MAX = 120;
export const SAVED_PROMPT_DESCRIPTION_MAX = 300;
/** UTF-16 units. A prompt is a template, not a document. */
export const SAVED_PROMPT_BODY_MAX = 32_000;
export const SAVED_PROMPT_TAG_MAX = 24;
export const SAVED_PROMPT_TAGS_MAX = 6;
/** Every scope together. A create past it is a 409 `SAVED_PROMPTS_FULL`. */
export const SAVED_PROMPTS_MAX = 1_000;

// ---------------------------------------------------------------------------
// The record and the routes
// ---------------------------------------------------------------------------

export interface SavedPrompt {
  id: string;
  title: string;
  /** One line under the title; `""` when none. */
  description: string;
  /** The template text; its `{variable}`s render at use time. */
  body: string;
  /** Free-form labels ("Review"), trimmed and unique, in the user's order. */
  tags: string[];
  /** `null` = global; else the absolute project directory it belongs to. */
  projectPath: string | null;
  /** A favourite: listed in the Pinned section, first. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** The last Insert or Send; `null` when never used. */
  lastUsedAt: string | null;
  useCount: number;
}

/**
 * `GET /api/saved-prompts?projectPath=` — every global prompt, plus that
 * project's own when `projectPath` is given. Unordered: the client sorts.
 */
export interface SavedPromptListQuery {
  projectPath?: string;
}

export interface SavedPromptListResponse {
  prompts: SavedPrompt[];
}

/** `POST /api/saved-prompts` → the created {@link SavedPrompt}. */
export interface CreateSavedPromptRequest {
  title: string;
  body: string;
  description?: string;
  tags?: string[];
  /** `null` = global; else a project directory (`<workspacesDir>/<ws>/<project>`). */
  projectPath: string | null;
  pinned?: boolean;
}

/**
 * `PUT /api/saved-prompts/:id` → the updated {@link SavedPrompt}. Every field
 * is optional; `projectPath` moves the prompt between global and a project.
 */
export interface UpdateSavedPromptRequest {
  title?: string;
  body?: string;
  description?: string;
  tags?: string[];
  projectPath?: string | null;
  pinned?: boolean;
}

// `DELETE /api/saved-prompts/:id` → 204.
// `POST /api/saved-prompts/:id/used` → the updated {@link SavedPrompt}
// (`lastUsedAt` now, `useCount` + 1): an Insert or a Send happened.

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The `/events` channel every saved-prompt change is broadcast on. */
export const SAVED_PROMPTS_CHANNEL = "saved-prompts";

export type SavedPromptEventType = "savedPrompt.upserted" | "savedPrompt.deleted";

/** `savedPrompt.upserted` carries the whole {@link SavedPrompt}; `savedPrompt.deleted` this. */
export interface SavedPromptDeletedPayload {
  id: string;
  projectPath: string | null;
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export type PromptVariableName =
  | "project"
  | "workspace"
  | "projectPath"
  | "branch"
  | "changedFiles"
  | "diff"
  | "date"
  | "time"
  | "agent"
  | "model";

export interface PromptVariableSpec {
  name: PromptVariableName;
  /** Where the value comes from: the open project, git (read at use time), the clock, or the target chat. */
  source: "project" | "git" | "clock" | "chat";
  /** What the editor's variable list says about it. */
  description: string;
}

/** Every variable a saved prompt can use, in the order the editor lists them. */
export const PROMPT_VARIABLES: readonly PromptVariableSpec[] = [
  { name: "project", source: "project", description: "The project's name" },
  { name: "workspace", source: "project", description: "The workspace's name" },
  { name: "projectPath", source: "project", description: "The project's absolute path" },
  { name: "branch", source: "git", description: "The current git branch" },
  {
    name: "changedFiles",
    source: "git",
    description: "The repository's files with uncommitted changes, one per line (as the Git tab lists them)"
  },
  {
    name: "diff",
    source: "git",
    description: "The project folder's uncommitted changes as one patch (capped), plus its untracked files"
  },
  { name: "date", source: "clock", description: "Today's date (YYYY-MM-DD)" },
  { name: "time", source: "clock", description: "The time now (HH:MM)" },
  { name: "agent", source: "chat", description: "The chat's agent" },
  { name: "model", source: "chat", description: "The chat's model" }
];

const VARIABLE_NAMES: ReadonlySet<string> = new Set(PROMPT_VARIABLES.map((spec) => spec.name));

export function isPromptVariableName(name: string): name is PromptVariableName {
  return VARIABLE_NAMES.has(name);
}

/**
 * `{{name}}` (an escape: the literal text `{name}`) or `{name}`. Only a KNOWN
 * name is ever a variable, so code braces (`{ a: 1 }`, `{foo}`, `${x}`) in a
 * prompt pass through untouched.
 */
const TOKEN = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}|\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** The known variables `body` uses, each once, in first-use order. An escaped `{{name}}` does not count. */
export function promptVariablesUsed(body: string): PromptVariableName[] {
  const used: PromptVariableName[] = [];
  for (const match of body.matchAll(TOKEN)) {
    const name = match[2];
    if (name !== undefined && isPromptVariableName(name) && !used.includes(name)) {
      used.push(name);
    }
  }
  return used;
}

/**
 * The inverse of rendering for text that must stay literal: every `{name}` of
 * a KNOWN variable becomes the escape `{{name}}`, so a sent prompt saved as a
 * template (History's "Save as prompt") renders back exactly as it was sent —
 * a `{date}` the user typed never turns into today's date. Everything else is
 * untouched; an existing `{{name}}` escape is doubled once more, so it too
 * renders back as written.
 */
export function escapePromptVariables(text: string): string {
  return text.replace(TOKEN, (whole, escaped: string | undefined, name: string | undefined) => {
    if (escaped !== undefined) return isPromptVariableName(escaped) ? `{${whole}}` : whole;
    return name !== undefined && isPromptVariableName(name) ? `{${whole}}` : whole;
  });
}

/**
 * Render a template: every `{name}` of a known variable becomes its value,
 * `{{name}}` of a known variable becomes the literal `{name}`, and everything
 * else — unknown names, a known name with no value supplied — stays exactly as
 * written.
 */
export function renderPromptTemplate(
  body: string,
  values: Readonly<Partial<Record<PromptVariableName, string>>>
): string {
  return body.replace(TOKEN, (whole, escaped: string | undefined, name: string | undefined) => {
    if (escaped !== undefined) {
      return isPromptVariableName(escaped) ? `{${escaped}}` : whole;
    }
    if (name !== undefined && isPromptVariableName(name)) {
      const value = values[name];
      return value === undefined ? whole : value;
    }
    return whole;
  });
}
