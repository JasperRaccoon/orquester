/**
 * Render smoke checks for the Saved prompts panel and its editor.
 *
 * `list.logic.test.ts`, `store.test.ts`, `variables.test.ts` and
 * `editor.logic.test.ts` own the rules; this exists because "the pinned card
 * has an Insert and a Send button", "a collapsed row opens from its own
 * chevron", "with no chat both are disabled and the list says why" and "every
 * variable has a chip" are claims about MARKUP — and a prop mistake
 * typechecks perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 * The modal, the confirm and the actions menu's panel are portals that mount
 * only when open, so the presentational pieces are rendered as the panel and
 * the modal mount them.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PROMPT_VARIABLES, type SavedPrompt } from "@orquester/api";

import {
  savedPromptSections,
  savedPromptsEmptyState,
  type SavedPromptScopeFilter
} from "../../../lib/saved-prompts/list.logic";
import { NO_CHAT_TARGET_REASON } from "../chat-target";
import { initialDraft } from "./editor.logic";
import { SavedPromptEditorForm, type SavedPromptEditorFormProps } from "./SavedPromptEditorForm";
import { SavedPromptItem, type SavedPromptItemProps } from "./SavedPromptItem";
import {
  SavedPromptsPanelView,
  type SavedPromptListActions,
  type SavedPromptsPanelViewProps
} from "./SavedPromptsPanelView";

const render = (element: ReactElement): string => renderToStaticMarkup(element);

const PROJECT = "/w/acme/app";

function prompt(overrides: Partial<SavedPrompt> & { id: string; title: string }): SavedPrompt {
  return {
    description: "",
    body: "",
    tags: [],
    projectPath: null,
    pinned: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: null,
    useCount: 0,
    ...overrides
  };
}

const REVIEW = prompt({
  id: "review",
  title: "Review current changes",
  description:
    "Review the current diff for bugs, regressions, and missing tests. Prioritize findings by severity.",
  body: "Review this diff for bugs and regressions:\n\n{diff}\n\n(branch {branch})",
  tags: ["Review"],
  pinned: true
});
const PLAN = prompt({
  id: "plan",
  title: "Plan before coding",
  description: "Explore the codebase and propose a plan",
  body: "Explore {project} and propose a plan before writing code.",
  projectPath: PROJECT,
  lastUsedAt: "2026-09-20T00:00:00.000Z"
});
const FIX = prompt({
  id: "fix",
  title: "Fix failing tests",
  description: "Find the root cause and verify the fix",
  body: "Find the root cause of the failing tests."
});
const HANDOFF = prompt({
  id: "handoff",
  title: "Create a handoff",
  description: "Summarize decisions, changes, and next steps",
  body: "Summarize decisions, changes, and next steps."
});
const PROMPTS = [REVIEW, PLAN, FIX, HANDOFF];

const noop = () => undefined;
const ACTIONS: SavedPromptListActions = {
  expand: noop,
  deliver: noop,
  togglePin: noop,
  edit: noop,
  duplicate: noop,
  move: noop,
  remove: noop,
  confirmRemove: noop,
  cancelRemove: noop
};

function viewProps(
  overrides: Partial<SavedPromptsPanelViewProps> & { prompts?: SavedPrompt[]; status?: "loading" | "loaded" | "error" } = {}
): SavedPromptsPanelViewProps {
  const { prompts = PROMPTS, status = "loaded", ...rest } = overrides;
  const scope: SavedPromptScopeFilter = rest.scope ?? "all";
  const query = rest.query ?? "";
  const sections = savedPromptSections(prompts, { scope, projectPath: PROJECT, query });
  return {
    variant: "docked",
    query,
    onQueryChange: noop,
    scope,
    onScopeChange: noop,
    projectAvailable: true,
    sections,
    empty: savedPromptsEmptyState({ status, error: "boom", scope, sections, query }),
    loadError: null,
    onRetry: noop,
    notice: null,
    onDismissNotice: noop,
    canDeliver: true,
    expandedId: REVIEW.id,
    busy: null,
    feedback: null,
    actions: ACTIONS,
    onNewPrompt: noop,
    ...rest
  };
}

// The HTML attribute, not the `disabled:` Tailwind variants in a class list.
const DISABLED_ATTR = /\sdisabled=""/;

/** The `<button …>…</button>` whose text contains `label` (buttons never nest here). */
function buttonWith(html: string, label: string): string {
  for (const match of html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)) {
    const text = match[0].replace(/<[^>]+>/g, "");
    if (text.includes(label)) return match[0];
  }
  throw new Error(`no button containing “${label}” in:\n${html}`);
}

/** The card element of one prompt (the root carrying its `data-saved-prompt`). */
function cardOf(html: string, id: string): string {
  const start = html.indexOf(`data-saved-prompt="${id}"`);
  assert.ok(start >= 0, `a card for ${id}`);
  const next = html.indexOf("data-saved-prompt=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

// ---------------------------------------------------------------------------
// The panel: the mockup's state — a pinned card open, three rows below
// ---------------------------------------------------------------------------

const panel = render(createElement(SavedPromptsPanelView, viewProps()));

assert.ok(panel.startsWith('<div class="flex min-h-0 flex-1 flex-col">'), "fills the dock and scrolls itself");
assert.ok(panel.includes('placeholder="Search prompts…"'), "the search field");
assert.ok(panel.includes('aria-label="Search saved prompts"'));
assert.ok(buttonWith(panel, "All").includes('aria-pressed="true"'), "All is the scope");
assert.ok(!DISABLED_ATTR.test(buttonWith(panel, "Project")), "Project is offered with a project open");
assert.ok(panel.includes(">Pinned</div>"), "the Pinned section");
assert.ok(panel.includes(">Prompts</div>"), "then the rest");
assert.ok(
  panel.indexOf(">Pinned</div>") < panel.indexOf("Review current changes") &&
    panel.indexOf("Review current changes") < panel.indexOf(">Prompts</div>"),
  "the pinned card sits under Pinned, above the rest"
);
// The rest in recency order: used last first, then the never-used by title.
const order = [PLAN, HANDOFF, FIX].map((entry) => panel.indexOf(`data-saved-prompt="${entry.id}"`));
assert.deepEqual([...order].sort((a, b) => a - b), order, "Plan (used) → Create a handoff → Fix failing tests");

// The expanded pinned card.
const card = cardOf(panel, REVIEW.id);
assert.ok(card.includes("Review current changes"));
assert.ok(card.includes('aria-expanded="true"'), "its header collapses it");
const star = buttonWith(card, "Pin");
assert.ok(star.includes('aria-pressed="true"'), "the star is pressed for a pinned prompt");
assert.ok(star.includes("fill-neutral-300"), "and filled");
assert.ok(star.includes('title="Pin"') && !card.includes("Unpin"), "one stable label, the state is aria-pressed");
assert.ok(star.includes("h-6 w-6"), "docked: a 24px target");
assert.ok(card.includes("data-card-focus"), "the header stands for the card when focus lands on it");
assert.ok(
  panel.includes('tabindex="-1" aria-label="Saved prompts" class="min-h-0 flex-1'),
  "the list itself can take focus (the last card gone)"
);
assert.ok(card.includes("More actions for Review current changes"), "the actions menu");
assert.ok(card.includes(">Review</span>"), "the tag chip");
assert.ok(card.includes("Global</span>"), "the scope chip");
assert.ok(card.includes("Prioritize findings by severity."), "the description");
assert.ok(card.includes("Context: current diff, branch"), "the context the body reads");
const insert = buttonWith(card, "Insert");
const send = buttonWith(card, "Send");
assert.ok(!DISABLED_ATTR.test(insert) && !DISABLED_ATTR.test(send), "both enabled with a chat");
assert.ok(insert.includes("bg-neutral-200"), "Insert is the primary, filled button");
assert.ok(send.includes("border-neutral-700"), "Send is the outline one");
assert.ok(send.includes("lucide-arrow-up-right"), "Send ↗");
assert.ok(card.includes("grid grid-cols-2"), "side by side");

// A collapsed row.
const row = cardOf(panel, PLAN.id);
assert.ok(row.includes("Plan before coding"));
assert.ok(row.includes("Explore the codebase and propose a plan"), "its one-line description");
const rowBody = buttonWith(row, "Plan before coding");
assert.ok(!rowBody.includes("Insert"), "clicking the row never inserts");
assert.ok(!DISABLED_ATTR.test(rowBody));
assert.ok(rowBody.includes('aria-expanded="false"'), "the whole row is one button, and expands");
assert.ok(rowBody.includes("lucide-chevron-right"), "the chevron is inside it");
assert.equal((row.match(/<button\b/g) ?? []).length, 1, "one button per collapsed row");
assert.ok(!row.includes(">Insert</button>"), "a collapsed row has no Insert/Send buttons");
assert.ok(!panel.includes(NO_CHAT_TARGET_REASON), "no no-chat hint while a chat is the target");

// The footer.
const newPrompt = buttonWith(panel, "New prompt");
assert.ok(newPrompt.includes("lucide-plus") && newPrompt.includes("w-full"), "+ New prompt, full width");
assert.ok(newPrompt.includes("bg-neutral-200"), "filled, like Insert");
assert.ok(panel.includes("Open a prompt to insert or send it"), "the hint under it");
assert.ok(
  panel.lastIndexOf("New prompt") > panel.lastIndexOf("data-saved-prompt="),
  "the footer is below the list"
);

// A collapsed pinned row carries the muted star.
const pinnedRow = render(
  createElement(SavedPromptsPanelView, viewProps({ expandedId: null }))
);
assert.ok(cardOf(pinnedRow, REVIEW.id).includes("fill-neutral-500"), "a pinned row shows a muted star");
assert.ok(cardOf(pinnedRow, REVIEW.id).includes("(pinned)"));

// ---------------------------------------------------------------------------
// No chat: disabled, with the reason once at the top
// ---------------------------------------------------------------------------

const noChat = render(createElement(SavedPromptsPanelView, viewProps({ canDeliver: false })));
assert.ok(noChat.includes(NO_CHAT_TARGET_REASON), "the list says why");
assert.ok(
  noChat.indexOf(NO_CHAT_TARGET_REASON) < noChat.indexOf("data-saved-prompt="),
  "above the prompts"
);
const noChatCard = cardOf(noChat, REVIEW.id);
assert.ok(DISABLED_ATTR.test(buttonWith(noChatCard, "Insert")), "Insert disabled");
assert.ok(DISABLED_ATTR.test(buttonWith(noChatCard, "Send")), "Send disabled");
assert.ok(!DISABLED_ATTR.test(buttonWith(cardOf(noChat, PLAN.id), "Plan before coding")), "a row still opens");
assert.ok(!DISABLED_ATTR.test(buttonWith(noChat, "New prompt")), "and a prompt can still be written");

// ---------------------------------------------------------------------------
// Resolving, then the outcome
// ---------------------------------------------------------------------------

const busy = render(
  createElement(SavedPromptsPanelView, viewProps({ busy: { id: REVIEW.id, action: "send" } }))
);
const busyCard = cardOf(busy, REVIEW.id);
const ARIA_DISABLED = 'aria-disabled="true"';
assert.ok(buttonWith(busyCard, "Send").includes("animate-spin"), "a spinner on the pressed button");
assert.ok(!buttonWith(busyCard, "Insert").includes("animate-spin"), "only there");
for (const label of ["Insert", "Send"]) {
  const button = buttonWith(busyCard, label);
  assert.ok(button.includes(ARIA_DISABLED), `${label} refuses clicks meanwhile`);
  assert.ok(!DISABLED_ATTR.test(button), `${label} is never \`disabled\` for it: that would drop its focus`);
  assert.ok(button.includes("aria-disabled:opacity-50"), `${label} still looks disabled`);
}
assert.ok(!DISABLED_ATTR.test(buttonWith(cardOf(busy, PLAN.id), "Plan before coding")), "other prompts stay usable");
assert.ok(!buttonWith(cardOf(busy, PLAN.id), "Plan before coding").includes(ARIA_DISABLED));

const busyRow = render(
  createElement(SavedPromptsPanelView, viewProps({ expandedId: null, busy: { id: PLAN.id, action: "insert" } }))
);
const busyRowBody = buttonWith(cardOf(busyRow, PLAN.id), "Plan before coding");
assert.ok(!DISABLED_ATTR.test(busyRowBody), "a row resolving still opens");
assert.ok(busyRowBody.includes("animate-spin"));

const queued = render(
  createElement(SavedPromptsPanelView, {
    ...viewProps(),
    feedback: { id: REVIEW.id, tone: "ok", text: "Queued — sends when the current turn finishes" }
  })
);
assert.ok(cardOf(queued, REVIEW.id).includes("Queued — sends when the current turn finishes"), "on its card");
assert.ok(
  queued.includes('<div role="status" class="sr-only">Queued — sends when the current turn finishes</div>'),
  "and read out through the panel's always-mounted status region"
);
assert.ok(queued.includes('<div role="alert" class="sr-only"></div>'), "the alert region, mounted and empty");
assert.ok(
  panel.includes('<div role="status" class="sr-only"></div><div role="alert" class="sr-only"></div>'),
  "both regions exist before anything is said in them"
);

const refused = render(
  createElement(SavedPromptsPanelView, {
    ...viewProps({ expandedId: null }),
    feedback: { id: PLAN.id, tone: "error", text: "Couldn't read git status: fatal: bad object" }
  })
);
const refusedRow = cardOf(refused, PLAN.id);
assert.ok(refusedRow.includes("Couldn&#x27;t read git status: fatal: bad object"), "the reason, on its row");
assert.ok(refusedRow.includes("text-danger"));
assert.ok(
  !buttonWith(refusedRow, "Plan before coding").includes("fatal: bad object"),
  "beside the row's buttons, not inside one — it is not part of the row's name"
);
assert.ok(
  refused.includes('<div role="alert" class="sr-only">Couldn&#x27;t read git status: fatal: bad object</div>'),
  "read out through the alert region"
);

const notice = render(
  createElement(SavedPromptsPanelView, viewProps({ notice: "Couldn't pin the prompt: offline" }))
);
assert.ok(notice.includes("Couldn&#x27;t pin the prompt: offline"), "a failed change is shown");
assert.ok(buttonWith(notice, "Dismiss").includes("h-6 w-6"), "and can be dismissed — a 24px target");

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

const loading = render(createElement(SavedPromptsPanelView, viewProps({ prompts: [], status: "loading" })));
assert.ok(loading.includes("Loading prompts…"));

const failed = render(createElement(SavedPromptsPanelView, viewProps({ prompts: [], status: "error" })));
assert.ok(failed.includes("Couldn&#x27;t load saved prompts") && failed.includes("boom"));
assert.ok(buttonWith(failed, "Retry"), "with a retry");

const none = render(createElement(SavedPromptsPanelView, viewProps({ prompts: [] })));
assert.ok(none.includes("No saved prompts yet"));
assert.ok(none.includes("they can use variables like {project} and {branch}."));

const noMatch = render(createElement(SavedPromptsPanelView, viewProps({ query: "deploy" })));
assert.ok(noMatch.includes("No prompts match “deploy”"));

const noProject = render(
  createElement(SavedPromptsPanelView, viewProps({ prompts: [REVIEW, FIX], scope: "project" }))
);
assert.ok(noProject.includes("No project prompts yet"));
assert.ok(buttonWith(noProject, "Project").includes('aria-pressed="true"'));

const refreshFailed = render(
  createElement(SavedPromptsPanelView, viewProps({ loadError: "Couldn't refresh saved prompts: offline" }))
);
assert.ok(
  refreshFailed.includes('<span class="min-w-0 flex-1 break-words">Couldn&#x27;t refresh saved prompts: offline</span>'),
  "the line says what the panel was told, word for word (list.logic's savedPromptsLoadErrorLine)"
);
assert.ok(buttonWith(refreshFailed, "Retry"), "with a retry");

// No project open: the Project scope is not offered.
const noProjectOpen = render(
  createElement(SavedPromptsPanelView, viewProps({ projectAvailable: false }))
);
const projectOption = buttonWith(noProjectOpen, "Project");
assert.ok(DISABLED_ATTR.test(projectOption), "Project is disabled without a project");
assert.ok(projectOption.includes('title="Open a project to list its prompts"'), "and says why");

// ---------------------------------------------------------------------------
// The sheet (mobile): bigger touch targets
// ---------------------------------------------------------------------------

const sheet = render(createElement(SavedPromptsPanelView, viewProps({ variant: "sheet" })));
const sheetCard = cardOf(sheet, REVIEW.id);
assert.ok(buttonWith(sheetCard, "Insert").includes("h-10"), "taller Insert");
assert.ok(buttonWith(sheetCard, "Send").includes("h-10"), "taller Send");
assert.ok(buttonWith(cardOf(sheet, PLAN.id), "Plan before coding").includes("py-3"), "taller rows");
assert.ok(buttonWith(sheetCard, "Pin").includes("h-10 w-10"), "a 40px star");
// No second bottom sheet for the actions: they sit in the card.
assert.ok(!sheetCard.includes("More actions"), "no actions menu in the sheet");
assert.ok(sheetCard.includes('aria-label="Actions for Review current changes"'));
for (const label of ["Edit", "Duplicate", "Move to this project", "Delete"]) {
  assert.ok(buttonWith(sheetCard, label).includes("min-h-10"), `${label} inline, 40px tall`);
}
assert.ok(buttonWith(sheetCard, "Delete").includes("text-danger"), "Delete reads as destructive");
// Docked keeps them behind the menu.
assert.ok(!card.includes('aria-label="Actions for'), "docked: behind the … menu, not inline");

// A modal confirm would open under the sheet, so the card asks itself there.
const confirming = render(
  createElement(SavedPromptsPanelView, viewProps({ variant: "sheet", confirmingDeleteId: REVIEW.id }))
);
const confirmingCard = cardOf(confirming, REVIEW.id);
assert.ok(confirmingCard.includes('aria-label="Delete prompt"'), "the card asks before deleting");
assert.ok(confirmingCard.includes("Delete this prompt?"));
assert.ok(buttonWith(confirmingCard, "Delete").includes("bg-danger-600"), "a destructive Delete");
assert.ok(buttonWith(confirmingCard, "Cancel"), "and a way back");
assert.ok(!confirmingCard.includes(">Insert"), "in place of Insert / Send while it asks");
assert.ok(!confirmingCard.includes('aria-label="Actions for'), "and of the actions: one decision at a time");
assert.ok(!cardOf(confirming, PLAN.id).includes("Delete this prompt?"), "only on that card");

// ---------------------------------------------------------------------------
// One item on its own: a project prompt's menu and chips
// ---------------------------------------------------------------------------

const itemProps: SavedPromptItemProps = {
  prompt: PLAN,
  expanded: true,
  variant: "docked",
  canDeliver: true,
  busy: null,
  feedback: null,
  canMoveToProject: true,
  onExpand: noop,
  onCollapse: noop,
  onDeliver: noop,
  onTogglePin: noop,
  onEdit: noop,
  onDuplicate: noop,
  onMove: noop,
  onDelete: noop
};
const projectCard = render(createElement(SavedPromptItem, itemProps));
assert.ok(projectCard.includes("Project</span>"), "a project prompt's scope chip");
assert.ok(!projectCard.includes("Context:"), "no Context line without git variables");
const pin = buttonWith(projectCard, "Pin");
assert.ok(pin.includes('aria-pressed="false"') && pin.includes('title="Pin"'), "an unpinned star offers Pin");
const bodyOnly = render(
  createElement(SavedPromptItem, { ...itemProps, prompt: { ...PLAN, description: "" } })
);
assert.ok(bodyOnly.includes("Explore {project} and propose a plan"), "no description: the body previews");

// ---------------------------------------------------------------------------
// The editor form
// ---------------------------------------------------------------------------

function formProps(overrides: Partial<SavedPromptEditorFormProps> = {}): SavedPromptEditorFormProps {
  return {
    mode: "create",
    draft: initialDraft({ mode: "create", projectPath: PROJECT }),
    onChange: noop,
    projectScopeAvailable: true,
    saving: false,
    error: null,
    onSave: noop,
    onCancel: noop,
    ...overrides
  };
}

const fresh = render(createElement(SavedPromptEditorForm, formProps()));
assert.ok(fresh.includes(">New prompt</span>"), "titled New prompt");
for (const label of ["Title", "Description", "Scope", "Tags", "Pinned", "Prompt", "Variables"]) {
  assert.ok(fresh.includes(`>${label}`), `the ${label} field`);
}
assert.ok(fresh.includes('role="switch"') && fresh.includes('aria-label="Pinned"'), "pinned is a switch");
assert.ok(fresh.includes("<textarea") && fresh.includes('rows="12"') && fresh.includes("font-mono"), "a monospace body");
assert.ok(fresh.includes("resize-y"), "resizable");
assert.ok(fresh.includes("0/120") && fresh.includes("0/300") && fresh.includes("0/32,000"), "live counts");
assert.ok(!DISABLED_ATTR.test(buttonWith(fresh, "This project")), "This project with a project open");
assert.ok(buttonWith(fresh, "Global").includes('aria-pressed="true"'), "global by default");
for (const spec of PROMPT_VARIABLES) {
  const chip = buttonWith(fresh, `{${spec.name}}`);
  assert.ok(chip.includes(`title="${spec.description.replace(/'/g, "&#x27;")}"`), `{${spec.name}} explains itself`);
}
assert.ok(DISABLED_ATTR.test(buttonWith(fresh, "Save")), "nothing to save yet");
assert.ok(buttonWith(fresh, "Save").includes('title="Give the prompt a title and a body"'));
assert.ok(!fresh.includes("Uses:"), "no Uses line without variables");
assert.ok(fresh.includes("<kbd"), "the save shortcut");

const filled = render(
  createElement(
    SavedPromptEditorForm,
    formProps({
      mode: "edit",
      draft: {
        title: "Review current changes",
        description: "",
        tagsText: "Review",
        scope: "project",
        pinned: true,
        body: "Check {branch} then {diff} and {branch} again, {unknown} stays"
      }
    })
  )
);
assert.ok(filled.includes(">Edit prompt</span>"), "titled Edit prompt");
assert.ok(filled.includes("Uses: {branch}, {diff}"), "the variables the body uses, once each, known ones only");
assert.ok(!DISABLED_ATTR.test(buttonWith(filled, "Save")), "a valid draft saves");
assert.ok(filled.includes('aria-checked="true"'), "pinned");

const over = render(
  createElement(
    SavedPromptEditorForm,
    formProps({ draft: { ...formProps().draft, title: "t".repeat(121), body: "x" } })
  )
);
assert.ok(over.includes("121/120") && over.includes("At most 120 characters."), "over the limit, said at once");
assert.ok(DISABLED_ATTR.test(buttonWith(over, "Save")));

const noProjectForm = render(createElement(SavedPromptEditorForm, formProps({ projectScopeAvailable: false })));
assert.ok(DISABLED_ATTR.test(buttonWith(noProjectForm, "This project")), "no project: global only");

const saving = render(
  createElement(
    SavedPromptEditorForm,
    formProps({ saving: true, error: "Saved prompts are full", draft: { ...formProps().draft, title: "T", body: "B" } })
  )
);
assert.ok(buttonWith(saving, "Saving…").includes("animate-spin"), "saving shows");
assert.ok(DISABLED_ATTR.test(buttonWith(saving, "Saving…")), "no second save meanwhile");
assert.ok(!DISABLED_ATTR.test(buttonWith(saving, "Cancel")), "but the editor may be closed: the save still lands");
assert.ok(saving.includes("Saved prompts are full") && saving.includes('role="alert"'), "a refusal, inline");

console.log("saved-prompts render checks: ok");
