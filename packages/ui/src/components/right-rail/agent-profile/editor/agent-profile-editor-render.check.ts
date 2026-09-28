/**
 * Render checks for the agent-profile editors (agent profile spec §7.4, §7.5).
 *
 * The `*.logic.test.ts` files own the drafts; this exists because "an existing
 * secret shows ••• set with Replace and never its value", "key | value side by
 * side when wide, stacked when narrow", "every control on a phone is at least
 * 40 px", "every input has a label" and "only the neutral palette plus amber
 * and red" are claims about MARKUP — and a prop mistake typechecks perfectly
 * while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 * The frame is a portal that mounts only in a browser, so the editors are
 * rendered inside the env the frame's owner provides; the editors that load
 * something take an `initial` state, and without one they render their
 * loading state (the effects that would load never run here).
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AGENT_PROFILE_AGENTS,
  AGENT_PROFILE_CREATABLE_KINDS,
  MCP_ADVANCED_FIELDS,
  MCP_TRANSPORTS,
  type AgentProfileAgentId,
  type AgentProfileSnapshot,
  type McpServerView,
  type ProfileImportScanResponse,
  type ProfileItem,
  type ProfileItemDetail
} from "@orquester/api";

import type { ApiClient } from "../../../../lib/api-client";
import { AgentProfileEditorHost } from "../AgentProfileEditorHost";
import { CreateEditor, DetailEditor, EditLoader, ReadOnlyDetail } from "./AgentProfileEditor";
import { DiscardConfirm } from "./EditorFrame";
import { EditorShell } from "./EditorShell";
import { EditorEnvContext, type EditorEnv } from "./env";
import { HookFormView } from "./HookEditor";
import { initialHookForm, validateHookForm } from "./hook.logic";
import { CollisionPrompt, CopySource, GitSource, UploadSource } from "./ImportSources";
import { InstructionsConflict, InstructionsEditor } from "./InstructionsEditor";
import type { EditorVariant } from "./layout.logic";
import { MarkdownCreateEditor, MarkdownEditEditor, SourceSwitcher } from "./MarkdownEditor";
import { MarketplaceFormView } from "./MarketplaceEditor";
import { initialMarketplaceForm, validateMarketplaceForm } from "./marketplace.logic";
import { McpFormView } from "./McpEditor";
import { initialMcpForm, newSecretRow, validateMcpForm, type McpForm } from "./mcp.logic";
import { MarketplaceInstall, SpecInstall } from "./PluginEditor";
import { SubmitStatus } from "./use-submit";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const noop = () => undefined;
/** Every call answers a promise that never settles: nothing here may depend on a daemon. */
const API = new Proxy({}, { get: () => () => new Promise(() => undefined) }) as unknown as ApiClient;

function env(agent: AgentProfileAgentId, variant: EditorVariant, overrides: Partial<EditorEnv> = {}): EditorEnv {
  return {
    agent,
    api: API,
    variant,
    connected: true,
    requestClose: noop,
    finish: noop,
    setDirty: noop,
    switchKind: noop,
    ...overrides
  };
}

function render(element: ReactElement, agent: AgentProfileAgentId, variant: EditorVariant, overrides: Partial<EditorEnv> = {}): string {
  return renderToStaticMarkup(createElement(EditorEnvContext.Provider, { value: env(agent, variant, overrides) }, element));
}

/** An editor's inner view, inside the shell every editor draws. */
function inShell(children: ReactNode, status?: ReactNode): ReactElement {
  return createElement(EditorShell, { title: "T", primary: { label: "Save", onClick: noop }, status, children });
}

const VARIANTS: readonly EditorVariant[] = ["desktop", "phone"];

const BUTTONS = /<button\b[^>]*>[\s\S]*?<\/button>/g;
const text = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

/** The button reading exactly `label`, else the first whose text contains it. */
function buttonWith(html: string, label: string): string {
  const all = html.match(BUTTONS) ?? [];
  const found = all.find((button) => text(button).trim() === label) ?? all.find((button) => text(button).includes(label));
  assert.ok(found, `a button reading "${label}"`);
  return found;
}

const DISABLED = /<button\b[^>]*\sdisabled=""/;
const isDisabled = (button: string): boolean => DISABLED.test(button);

/**
 * The §7.5 rules every editor's markup keeps, whatever state it is in:
 * - every button shows a focus ring;
 * - on a phone every button and text field is at least 40 px tall;
 * - every input, select and textarea has a label (a bound `<label for>`, or an aria name);
 * - only the neutral palette, with amber (`warn`) and red (`danger`) for warnings and destructive actions;
 * - nothing sets a width a 360 px screen cannot hold.
 */
function assertEditorRules(html: string, what: string, variant: EditorVariant): void {
  for (const button of html.match(/<button\b[^>]*>/g) ?? []) {
    assert.match(button, /focus-visible:ring/, `${what}: a focus ring on ${button}`);
    if (variant === "phone") {
      assert.match(button, /\b(?:h-1[0-4]|min-h-1[0-4])\b/, `${what}: a 40 px touch target on ${button}`);
    }
  }
  for (const field of html.match(/<(?:input|select|textarea)\b[^>]*>/g) ?? []) {
    if (/type="(?:file|hidden)"/.test(field)) continue;
    const id = /\sid="([^"]+)"/.exec(field)?.[1];
    const named =
      /\saria-label(?:ledby)?="/.test(field) || (id !== undefined && html.includes(`for="${id}"`));
    assert.ok(named, `${what}: a label for ${field}`);
    if (variant === "phone" && !/type="(?:checkbox|radio)"/.test(field) && !field.startsWith("<textarea")) {
      assert.match(field, /\bh-10\b/, `${what}: a 40 px field on a phone: ${field}`);
    }
  }
  const palette = /\b(?:text|bg|border|ring|accent|divide|from|to)-(?!neutral-|danger|warn|white|black|transparent|current)([a-z]+)-\d{2,3}\b/.exec(html);
  assert.equal(palette, null, `${what}: only neutral, amber and red (found ${palette?.[0]})`);
  for (const match of html.matchAll(/\b(?:min-)?w-\[(\d+)px\]/g)) {
    assert.ok(Number(match[1]) <= 360, `${what}: ${match[0]} would overflow a 360 px screen`);
  }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function item(overrides: Partial<ProfileItem> & Pick<ProfileItem, "id" | "kind" | "name">): ProfileItem {
  return {
    enabled: true,
    toggleable: true,
    editable: true,
    deletable: true,
    locked: false,
    source: { type: "user", label: "User" },
    revision: "rev-1",
    warnings: [],
    ...overrides
  };
}

function snapshot(agent: AgentProfileAgentId, items: ProfileItem[], installed = true): AgentProfileSnapshot {
  return {
    agent,
    installed,
    revision: "snap",
    instructions: { path: "/home/.claude/CLAUDE.md", exists: true, bytes: 10, lines: 1, revision: "i", warnings: [] },
    items,
    fileErrors: [],
    readAt: "2026-09-28T00:00:00.000Z"
  };
}

const SECRET_VALUE = "sk-live-never-shown";
const MCP_VIEW: McpServerView = {
  name: "jira-cloud",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@acme/jira-mcp"],
  env: [
    { key: "JIRA_TOKEN", set: true },
    { key: "JIRA_URL", set: true }
  ],
  advanced: { startup_timeout_sec: 20 }
};

const SCAN: ProfileImportScanResponse = {
  importId: "imp-1",
  candidates: [
    { ref: "skills/review-pr", kind: "skill", name: "review-pr", description: "Reviews a pull request", exists: false },
    { ref: "skills/tdd", kind: "skill", name: "tdd", exists: true },
    { ref: "commands/ship.md", kind: "command", name: "ship", exists: false }
  ],
  notes: ["Skipped symlink skills/linked"]
};

// ---------------------------------------------------------------------------
// The host: nothing until asked
// ---------------------------------------------------------------------------

assert.equal(renderToStaticMarkup(createElement(AgentProfileEditorHost)), "", "the host draws nothing until a request");

// ---------------------------------------------------------------------------
// Every create editor, for every agent, desktop and phone
// ---------------------------------------------------------------------------

for (const agent of AGENT_PROFILE_AGENTS) {
  for (const kind of AGENT_PROFILE_CREATABLE_KINDS[agent]) {
    for (const variant of VARIANTS) {
      const what = `create ${kind} · ${agent} · ${variant}`;
      const html = render(createElement(CreateEditor, { kind }), agent, variant);
      assert.ok(html.includes(`data-editor-variant="${variant}"`), `${what}: the shell`);
      assertEditorRules(html, what, variant);
      if (variant === "phone") {
        assert.ok(buttonWith(html, "Cancel").includes("h-10"), `${what}: Cancel in the sticky header`);
        assert.ok(!html.includes("<kbd"), `${what}: no keyboard hint on a phone`);
      } else {
        assert.ok(html.includes('aria-label="Cancel"'), `${what}: a close button in the header`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

function mcpView(agent: AgentProfileAgentId, variant: EditorVariant, form: McpForm, extra: Partial<Parameters<typeof McpFormView>[0]> = {}): string {
  return render(
    inShell(
      createElement(McpFormView, {
        mode: "create",
        form,
        onChange: noop,
        validation: validateMcpForm(agent, form),
        showErrors: false,
        ...extra
      })
    ),
    agent,
    variant
  );
}

for (const agent of AGENT_PROFILE_AGENTS) {
  for (const transport of MCP_TRANSPORTS[agent]) {
    for (const variant of VARIANTS) {
      const what = `mcp ${transport} · ${agent} · ${variant}`;
      const form = { ...initialMcpForm(agent), name: "docs", transport };
      const html = mcpView(agent, variant, form, { advancedOpen: true });
      assertEditorRules(html, what, variant);
      assert.ok(buttonWith(html, transport === "stdio" ? (variant === "phone" ? "stdio" : "Command (stdio)") : transport.toUpperCase()).includes('aria-pressed="true"'), `${what}: the transport is picked`);
      if (transport === "stdio") {
        assert.ok(html.includes(">Command") && html.includes(">Arguments") && html.includes(">Environment"), `${what}: command, args, env`);
        assert.ok(!html.includes(">URL") && !html.includes(">Headers"), `${what}: no URL or headers`);
      } else {
        assert.ok(html.includes(">URL") && html.includes(">Headers"), `${what}: URL and headers`);
        assert.ok(!html.includes(">Arguments") && !html.includes(">Environment"), `${what}: no command fields`);
      }
      for (const spec of MCP_ADVANCED_FIELDS[agent]) {
        assert.ok(html.includes(spec.label.replace(/&/g, "&amp;")), `${what}: the advanced ${spec.key} field`);
      }
    }
  }
  const transports = render(createElement(CreateEditor, { kind: "mcp" }), agent, "desktop");
  assert.equal(transports.includes(">SSE<"), MCP_TRANSPORTS[agent].includes("sse"), `${agent}: SSE only where it is accepted`);
}

// Secrets on disk: "••• set" with Replace and Remove; a value is never prefilled.
{
  const form = initialMcpForm("codex", MCP_VIEW);
  form.env = [...form.env, { ...newSecretRow("EXTRA", "typed-by-me") }];
  form.env[1] = { ...form.env[1]!, state: "replace" };
  const desktop = mcpView("codex", "desktop", form, { mode: "edit" });
  const phone = mcpView("codex", "phone", form, { mode: "edit" });
  for (const [html, variant] of [[desktop, "desktop"], [phone, "phone"]] as const) {
    assertEditorRules(html, `mcp secrets · ${variant}`, variant);
    assert.ok(html.includes("•••") && text(html).includes("set"), "an existing secret shows ••• set");
    assert.ok(buttonWith(html, "Replace").includes('aria-label="Replace JIRA_TOKEN"'), "with Replace");
    assert.ok(html.includes('aria-label="Remove JIRA_TOKEN"'), "and Remove");
    assert.ok(html.includes('aria-label="New value for JIRA_URL"'), "Replace reveals an empty input for the new value");
    assert.ok(/aria-label="New value for JIRA_URL"[^>]*value=""|value=""[^>]*aria-label="New value for JIRA_URL"/.test(html), "empty");
    assert.ok(buttonWith(html, "Keep").includes("Keep the current value of JIRA_URL"), "and a way back");
    assert.ok(!html.includes(SECRET_VALUE), "no value on disk anywhere");
    assert.ok(html.includes("Renaming moves the server"), "edit: rename is allowed and said");
  }
  assert.ok(desktop.includes("grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]"), "wide: key | value side by side");
  assert.ok(!phone.includes("grid-cols-[minmax(0,2fr)"), "narrow: stacked");
  const narrowDesktop = render(
    inShell(createElement(McpFormView, { mode: "edit", form, onChange: noop, validation: validateMcpForm("codex", form), showErrors: false })),
    "codex",
    "desktop",
    { initialWidth: 400 }
  );
  assert.ok(!narrowDesktop.includes("grid-cols-[minmax(0,2fr)"), "the editor's own width decides, not the device");
  // A replace left empty is refused once Save was pressed.
  const refused = mcpView("codex", "desktop", form, { mode: "edit", showErrors: true });
  assert.ok(refused.includes("Type the new value, or keep the current one"), "an empty replacement is refused");
}

// Arguments listed one per row; the daemon's name refusal beside the field.
{
  const form = { ...initialMcpForm("claude", MCP_VIEW), name: "bad name" };
  const html = mcpView("claude", "desktop", form, { nameError: "Grok refuses that name" });
  assert.ok(html.includes('aria-label="Argument 1"') && html.includes('aria-label="Argument 2"'), "one input per argument");
  assert.ok(html.includes('aria-label="Remove argument 2"'), "each removable");
  assert.ok(html.includes("Grok refuses that name") && html.includes('aria-invalid="true"'), "INVALID_NAME at the name field");
  assert.ok(html.includes("Paste a whole command line"), "the paste hint");
  const invalid = mcpView("claude", "phone", { ...initialMcpForm("claude"), name: "1x" }, { showErrors: true });
  assert.ok(invalid.includes("Enter the command that starts the server"), "a missing command, after Save");
}

// ---------------------------------------------------------------------------
// Refusals and conflict prompts
// ---------------------------------------------------------------------------

for (const variant of VARIANTS) {
  const exists = render(
    inShell(
      "body",
      createElement(SubmitStatus, {
        state: { error: { code: "ITEM_EXISTS", status: 409, message: "An MCP server named jira exists." }, placement: "exists" },
        onResolveConflict: noop,
        onDismiss: noop
      })
    ),
    "claude",
    variant
  );
  assertEditorRules(exists, `exists · ${variant}`, variant);
  assert.ok(buttonWith(exists, "Replace") && buttonWith(exists, "Keep both"), "ITEM_EXISTS offers Replace and Keep both");
  assert.ok(exists.includes("An MCP server named jira exists."), "with the daemon's words");

  const changed = render(
    inShell(
      "body",
      createElement(SubmitStatus, {
        state: { error: { code: "PROFILE_CONFLICT", status: 409, message: "The item changed." }, placement: "changed" },
        onReload: noop
      })
    ),
    "claude",
    variant
  );
  assert.ok(changed.includes("Changed on disk") && buttonWith(changed, "Reload"), "PROFILE_CONFLICT offers Reload");

  const general = render(
    inShell(
      "body",
      createElement(SubmitStatus, {
        state: { error: { code: "AGENT_CLI_FAILED", status: 502, message: "grok mcp add exited 1" }, placement: "general" }
      })
    ),
    "grok",
    variant
  );
  assert.ok(general.includes('role="alert"') && general.includes("grok mcp add exited 1"), "anything else: the banner");

  const nameOnly = renderToStaticMarkup(
    createElement(SubmitStatus, { state: { error: { code: "INVALID_NAME", status: 400, message: "Bad" }, placement: "name" } })
  );
  assert.equal(nameOnly, "", "a name refusal is the name field's, not repeated above Save");

  const collision = render(inShell("body", createElement(CollisionPrompt, { names: ["tdd", "ship"], onResolve: noop, onCancel: noop })), "claude", variant);
  assert.ok(collision.includes("2 of these already exist") && collision.includes("tdd, ship"), "picked collisions ask first");
  assertEditorRules(collision, `collision · ${variant}`, variant);

  const discard = render(createElement(DiscardConfirm, { onKeepEditing: noop, onDiscard: noop, touch: variant === "phone" }), "claude", variant);
  assert.ok(discard.includes('role="alertdialog"') && discard.includes("Discard your changes?"), "the unsaved-changes guard");
  assert.ok(buttonWith(discard, "Discard").includes("bg-danger-600"), "a destructive Discard");
  assert.ok(buttonWith(discard, "Keep editing"), "and a way back");
  assertEditorRules(discard, `discard · ${variant}`, variant);
}

{
  const offline = render(createElement(CreateEditor, { kind: "hook" }), "claude", "desktop", { connected: false });
  const save = buttonWith(offline, "Add hook");
  assert.ok(isDisabled(save) && save.includes("Not connected to the daemon"), "no save while disconnected");
}

// ---------------------------------------------------------------------------
// Skill / command: every source step
// ---------------------------------------------------------------------------

for (const variant of VARIANTS) {
  for (const kind of ["skill", "command"] as const) {
    const what = `${kind} write · ${variant}`;
    const write = render(createElement(MarkdownCreateEditor, { kind }), "claude", variant);
    assertEditorRules(write, what, variant);
    assert.ok(buttonWith(write, "Write").includes('aria-pressed="true"'), `${what}: Write first`);
    assert.ok(write.includes('data-code-area=""'), `${what}: the body editor`);
    assert.ok(write.includes(kind === "skill" ? 'aria-label="Skill instructions"' : 'aria-label="Command prompt"'), `${what}: named`);
    assert.ok(write.includes(">More fields"), `${what}: optional fields folded`);
    if (kind === "skill") assert.ok(write.includes(">Description") && write.includes("aria-required"), "a skill's description is required");
    const copyLabel = variant === "phone" ? "Copy" : "Copy from agent";
    assert.ok(buttonWith(write, copyLabel), `${what}: the switcher fits (${copyLabel})`);
  }

  const sourceToolbar = createElement(SourceSwitcher, { value: "git", onChange: noop });
  const git = render(createElement(GitSource, { kind: "skill", toolbar: sourceToolbar }), "codex", variant);
  assertEditorRules(git, `git · ${variant}`, variant);
  assert.ok(git.includes(">Repository URL") && buttonWith(git, "Scan"), "Git URL: a URL and Scan");
  const cloning = render(createElement(GitSource, { kind: "skill", toolbar: sourceToolbar, initial: { url: "https://github.com/a/b", scanning: true } }), "codex", variant);
  assert.ok(cloning.includes("Cloning and scanning") && isDisabled(buttonWith(cloning, "Cloning…")), "scanning");
  const scanFailed = render(createElement(GitSource, { kind: "skill", toolbar: sourceToolbar, initial: { url: "https://x.example/r", scanError: "git clone failed: not found" } }), "codex", variant);
  assert.ok(scanFailed.includes("Couldn&#x27;t read the repository") && scanFailed.includes("git clone failed"), "a failed scan says why");
  const scanned = render(createElement(GitSource, { kind: "skill", toolbar: sourceToolbar, initial: { url: "https://github.com/a/b", scan: SCAN } }), "codex", variant);
  assertEditorRules(scanned, `git scanned · ${variant}`, variant);
  assert.ok(scanned.includes("Found 3 · 2 selected"), "new candidates start ticked");
  assert.ok(scanned.includes(">exists<"), "a colliding candidate says so");
  assert.ok(buttonWith(scanned, "Import 2") && buttonWith(scanned, "Scan another"), "Import the ticked ones");
  assert.ok(scanned.includes("Skipped symlink skills/linked"), "the scan's notes");
  assert.equal((scanned.match(/type="checkbox"/g) ?? []).length, 3, "a checkbox per candidate");
  const empty = render(createElement(GitSource, { kind: "skill", toolbar: sourceToolbar, initial: { scan: { importId: "i", candidates: [], notes: [] } } }), "codex", variant);
  assert.ok(empty.includes("Nothing to import") && isDisabled(buttonWith(empty, "Import")), "an empty scan");

  const uploadToolbar = createElement(SourceSwitcher, { value: "upload", onChange: noop });
  const upload = render(createElement(UploadSource, { kind: "command", toolbar: uploadToolbar }), "claude", variant);
  assertEditorRules(upload, `upload · ${variant}`, variant);
  assert.ok(upload.includes('accept=".zip,.md"') && upload.includes('type="file"'), "Upload: a .zip/.md file input");
  assert.ok(upload.includes(variant === "desktop" ? "Drop a .zip or .md file here" : "A .zip of skill folders"), "drop zone on desktop only");
  const uploading = render(createElement(UploadSource, { kind: "command", toolbar: uploadToolbar, initial: { fileName: "skills.zip", progress: 42 } }), "claude", variant);
  assert.ok(uploading.includes('role="progressbar"') && uploading.includes('aria-valuenow="42"'), "upload progress");
  assert.ok(isDisabled(buttonWith(uploading, "Uploading…")), "one upload at a time");
  const uploadFailed = render(createElement(UploadSource, { kind: "command", toolbar: uploadToolbar, initial: { fileName: "x.tar", uploadError: "Choose a .zip or a .md file" } }), "claude", variant);
  assert.ok(uploadFailed.includes("Choose a .zip or a .md file") && uploadFailed.includes('role="alert"'), "a refused file");
  const uploaded = render(createElement(UploadSource, { kind: "command", toolbar: uploadToolbar, initial: { fileName: "skills.zip", scan: SCAN } }), "claude", variant);
  assert.ok(uploaded.includes("Found 3") && buttonWith(uploaded, "Import 2"), "the same checklist after an upload");

  const copyToolbar = createElement(SourceSwitcher, { value: "copy", onChange: noop });
  const copyLoading = render(createElement(CopySource, { kind: "skill", toolbar: copyToolbar }), "grok", variant);
  assertEditorRules(copyLoading, `copy loading · ${variant}`, variant);
  assert.ok(copyLoading.includes("Reading Claude") && isDisabled(buttonWith(copyLoading, "Copy")), "Copy: reading the first other agent");
  assert.ok(!copyLoading.includes('value="grok"'), "never the agent itself");
  const copyLoaded = render(
    createElement(CopySource, {
      kind: "skill",
      toolbar: copyToolbar,
      initial: {
        from: "claude",
        selected: "skill:review-pr",
        load: {
          status: "loaded",
          snapshot: snapshot("claude", [
            item({ id: "skill:review-pr", kind: "skill", name: "review-pr", description: "Reviews a PR" }),
            item({ id: "skill:from-plugin", kind: "skill", name: "from-plugin", source: { type: "plugin", label: "Plugin · sp", pluginId: "sp" } }),
            item({ id: "command:c", kind: "command", name: "c" })
          ])
        }
      }
    }),
    "grok",
    variant
  );
  assertEditorRules(copyLoaded, `copy loaded · ${variant}`, variant);
  assert.ok(copyLoaded.includes("review-pr") && !copyLoaded.includes("from-plugin"), "only the agent's own skills");
  assert.ok(!copyLoaded.includes(">c<"), "only the same kind");
  assert.ok(copyLoaded.includes('checked=""') && !isDisabled(buttonWith(copyLoaded, "Copy")), "one picked: Copy");
  const notInstalled = render(
    createElement(CopySource, { kind: "skill", toolbar: copyToolbar, initial: { from: "codex", load: { status: "loaded", snapshot: snapshot("codex", [], false) } } }),
    "grok",
    variant
  );
  assert.ok(notInstalled.includes("Codex is not installed"), "an agent that is not installed");
  const copyFailed = render(createElement(CopySource, { kind: "skill", toolbar: copyToolbar, initial: { load: { status: "error", message: "boom" } } }), "grok", variant);
  assert.ok(copyFailed.includes("boom") && buttonWith(copyFailed, "Retry"), "a failed read, with Retry");
}

// Edit: fields prefilled, unknown keys kept and listed, the skill's other files read-only.
{
  const detail: Extract<ProfileItemDetail, { kind: "skill" | "command" }> = {
    kind: "skill",
    item: item({ id: "skill:review-pr", kind: "skill", name: "review-pr", path: "/home/.claude/skills/review-pr" }),
    document: {
      frontmatter: { name: "review-pr", description: "Reviews a PR", model: "opus", "allowed-tools": ["Read"], metadata: { a: 1 } },
      body: "Do the review."
    },
    files: ["scripts/diff.sh", "reference.md"]
  };
  for (const variant of VARIANTS) {
    const html = render(createElement(MarkdownEditEditor, { detail, onReload: noop }), "claude", variant);
    assertEditorRules(html, `skill edit · ${variant}`, variant);
    assert.ok(html.includes(">Edit skill<") && html.includes("/home/.claude/skills/review-pr"), "titled, with its path");
    assert.ok(html.includes('value="review-pr"') && html.includes("Reviews a PR"), "prefilled");
    assert.ok(html.includes('value="opus"'), "More fields opens when one is set");
    assert.ok(html.includes("Other keys kept as they are") && html.includes("allowed-tools, metadata"), "kept keys listed");
    assert.ok(html.includes("scripts/diff.sh") && html.includes("only SKILL.md is edited here"), "other files read-only");
    assert.ok(html.includes("Do the review."), "the body");
    assert.ok(buttonWith(html, "Save"), "Save");
    assert.ok(!html.includes(">Write<"), "no source switcher on edit");
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

for (const variant of VARIANTS) {
  const create = render(createElement(CreateEditor, { kind: "hook" }), "codex", variant);
  assert.ok(create.includes(">Event") && create.includes(">Matcher") && create.includes(">Command") && create.includes(">Timeout (seconds)"), "hook fields");
  assert.ok(create.includes('placeholder="Bash or Edit|Write"'), "matcher placeholder");
  assert.ok(create.includes('<option value="Interrupt">'), "the agent's own events");
  const stopForm = { ...initialHookForm("claude"), event: "Stop" };
  const stop = render(
    inShell(createElement(HookFormView, { form: stopForm, onChange: noop, validation: validateHookForm("claude", stopForm), showErrors: false })),
    "claude",
    variant
  );
  assertEditorRules(stop, `hook stop · ${variant}`, variant);
  assert.ok(!stop.includes(">Matcher") && stop.includes("they take no matcher"), "no matcher for an event that ignores it");
  const bad = { ...initialHookForm("claude"), timeout: "soon" };
  const refused = render(
    inShell(createElement(HookFormView, { form: bad, onChange: noop, validation: validateHookForm("claude", bad), showErrors: true })),
    "claude",
    variant
  );
  assert.ok(refused.includes("Enter the command to run") && refused.includes("Whole seconds"), "hook refusals");
  const detail: Extract<ProfileItemDetail, { kind: "hook" }> = {
    kind: "hook",
    item: item({ id: "hook:PreToolUse:abc", kind: "hook", name: "PreToolUse" }),
    hook: { event: "PreToolUse", matcher: "Bash", command: "./guard.sh\nexit 0", timeoutSec: 30 }
  };
  const edit = render(createElement(DetailEditor, { detail, onReload: noop }), "claude", variant);
  assert.ok(edit.includes(">Edit hook<") && edit.includes('value="Bash"') && edit.includes("./guard.sh"), "hook edit prefilled");
  assertEditorRules(edit, `hook edit · ${variant}`, variant);
}

// ---------------------------------------------------------------------------
// Plugin and marketplace
// ---------------------------------------------------------------------------

for (const variant of VARIANTS) {
  const loading = render(createElement(MarketplaceInstall, {}), "claude", variant);
  assert.ok(loading.includes("Reading Claude") && loading.includes("marketplaces"), "plugin: loading the marketplaces");
  const none = render(createElement(MarketplaceInstall, { initial: { snapshot: { status: "loaded", value: snapshot("claude", []) } } }), "claude", variant);
  assertEditorRules(none, `plugin none · ${variant}`, variant);
  assert.ok(none.includes("No marketplaces yet") && buttonWith(none, "Add a marketplace"), "no marketplace: explain and offer one");
  assert.ok(!none.includes(">Install<"), "nothing to install from");
  const listed = render(
    createElement(MarketplaceInstall, {
      initial: {
        snapshot: { status: "loaded", value: snapshot("codex", [item({ id: "marketplace:official", kind: "marketplace", name: "official" })]) },
        marketplace: "official",
        plugins: {
          status: "loaded",
          value: [
            { name: "superpowers", description: "TDD, debugging and planning skills", version: "5.0.1", installed: true },
            { name: "linear", description: "Linear issues", installed: false }
          ]
        },
        selected: "linear"
      }
    }),
    "codex",
    variant
  );
  assertEditorRules(listed, `plugin listed · ${variant}`, variant);
  assert.ok(listed.includes('<option value="official"') && listed.includes('aria-label="Search plugins"'), "a marketplace and a search");
  assert.ok(listed.includes(">Installed<") && /<input[^>]*disabled=""[^>]*type="radio"|type="radio"[^>]*disabled=""/.test(listed), "installed ones marked and not pickable");
  assert.ok(listed.includes("TDD, debugging and planning skills"), "descriptions");
  assert.ok(!isDisabled(buttonWith(listed, "Install linear")), "Install the pick");
  const failed = render(
    createElement(MarketplaceInstall, {
      initial: {
        snapshot: { status: "loaded", value: snapshot("grok", [item({ id: "marketplace:m", kind: "marketplace", name: "m" })]) },
        marketplace: "m",
        plugins: { status: "error", message: "marketplace clone missing" }
      }
    }),
    "grok",
    variant
  );
  assert.ok(failed.includes("marketplace clone missing") && buttonWith(failed, "Retry"), "a catalogue that cannot be read");

  const spec = render(createElement(SpecInstall, { initialSpec: "a b", showErrors: true }), "opencode", variant);
  assertEditorRules(spec, `opencode plugin · ${variant}`, variant);
  assert.ok(spec.includes("npm package or file path") && spec.includes("opencode-wakatime"), "OpenCode: a spec, with examples");
  assert.ok(spec.includes("One package or path, without spaces"), "a bad spec");

  for (const type of ["github", "git", "path"] as const) {
    const form = { ...initialMarketplaceForm(), type };
    const html = render(
      inShell(createElement(MarketplaceFormView, { form, onChange: noop, validation: validateMarketplaceForm(form), showErrors: true })),
      "claude",
      variant
    );
    assertEditorRules(html, `marketplace ${type} · ${variant}`, variant);
    assert.ok(html.includes(type === "github" ? ">Repository" : type === "git" ? ">Git URL" : ">Folder"), `marketplace ${type} field`);
    assert.equal(html.includes(">Branch, tag or commit"), type !== "path", "a ref except for a path");
    assert.ok(html.includes('role="alert"') === false && html.includes("text-danger"), "the missing source, said");
  }
}

// Plugins and marketplaces are not editable: their detail is read-only.
{
  const plugin: ProfileItemDetail = {
    kind: "plugin",
    item: item({ id: "plugin:sp@official", kind: "plugin", name: "superpowers", editable: false }),
    plugin: { id: "sp@official", name: "superpowers", marketplace: "official", version: "5.0.1", provides: { skills: 14, hooks: 1 } }
  };
  const html = render(createElement(ReadOnlyDetail, { detail: plugin }), "claude", "phone");
  assertEditorRules(html, "plugin detail · phone", "phone");
  assert.ok(html.includes("Installed as a whole") && html.includes("14 skills, 1 hooks"), "plugin details");
  assert.ok(!html.includes(">Save<") && buttonWith(html, "Close"), "nothing to save");
}

// ---------------------------------------------------------------------------
// Edit: loading and error
// ---------------------------------------------------------------------------

for (const variant of VARIANTS) {
  const loading = render(createElement(EditLoader, { itemId: "mcp:jira" }), "claude", variant);
  assert.ok(loading.includes("Reading the item") && loading.includes('role="status"'), "edit: loading");
  assertEditorRules(loading, `edit loading · ${variant}`, variant);
  const gone = render(createElement(EditLoader, { itemId: "mcp:jira", initial: { status: "error", message: "No such item", code: "ITEM_NOT_FOUND" } }), "claude", variant);
  assert.ok(gone.includes("It is gone") && !gone.includes(">Retry<"), "a deleted item");
  const failed = render(createElement(EditLoader, { itemId: "mcp:jira", initial: { status: "error", message: "offline", code: null } }), "claude", variant);
  assert.ok(failed.includes("offline") && buttonWith(failed, "Retry"), "a failed read, with Retry");
  const mcp = render(
    createElement(EditLoader, {
      itemId: "mcp:jira-cloud",
      initial: { status: "loaded", seq: 0, detail: { kind: "mcp", item: item({ id: "mcp:jira-cloud", kind: "mcp", name: "jira-cloud" }), mcp: MCP_VIEW } }
    }),
    "claude",
    variant
  );
  assert.ok(mcp.includes(">Edit MCP server<") && mcp.includes('value="jira-cloud"') && mcp.includes("•••"), "edit dispatches by the detail's kind");
  assertEditorRules(mcp, `edit mcp · ${variant}`, variant);
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

for (const variant of VARIANTS) {
  const loading = render(createElement(InstructionsEditor, {}), "grok", variant);
  assert.ok(loading.includes("Reading Grok") && !loading.includes(">Save<"), "instructions: loading");
  assertEditorRules(loading, `instructions loading · ${variant}`, variant);
  const failed = render(createElement(InstructionsEditor, { initial: { load: { status: "error", message: "EACCES" } } }), "grok", variant);
  assert.ok(failed.includes("EACCES") && buttonWith(failed, "Retry"), "instructions: a failed read");
  const html = render(
    createElement(InstructionsEditor, {
      initial: {
        load: {
          status: "loaded",
          response: {
            text: "# Rules\n\nBe brief.",
            info: {
              path: "/var/lib/orquester/.grok/AGENTS.md",
              exists: true,
              bytes: 18,
              lines: 3,
              revision: "r1",
              warnings: [{ code: "override", message: "A non-empty AGENTS.override.md shadows this file." }],
              legacyPath: "/var/lib/orquester/.grok/GROK.md"
            }
          }
        }
      }
    }),
    "grok",
    variant
  );
  assertEditorRules(html, `instructions · ${variant}`, variant);
  assert.ok(html.includes(">AGENTS.md<") && html.includes("/var/lib/orquester/.grok/AGENTS.md"), "titled by the file, with its path");
  assert.ok(html.includes("AGENTS.override.md shadows"), "the file's warnings");
  assert.ok(buttonWith(html, "Move GROK.md into AGENTS.md"), "Grok's dead GROK.md: offer the move");
  assert.ok(html.includes('data-code-area=""') && html.includes("Be brief."), "the text in the editor");
  assert.ok(html.includes("3 lines"), "a size line");
  assert.ok(isDisabled(buttonWith(html, "Save")), "nothing to save until it changes");
  const edited = render(
    createElement(InstructionsEditor, {
      initial: {
        text: "changed",
        load: {
          status: "loaded",
          response: {
            text: "orig",
            info: { path: "/h/.grok/AGENTS.md", exists: true, bytes: 4, lines: 1, revision: "r", warnings: [], legacyPath: "/h/.grok/GROK.md" }
          }
        }
      }
    }),
    "grok",
    variant
  );
  assert.ok(!isDisabled(buttonWith(edited, "Save")), "an edit saves");
  assert.ok(isDisabled(buttonWith(edited, "Move GROK.md")), "no move over unsaved edits");
  const conflict = render(inShell("body", createElement(InstructionsConflict, { message: "The file changed.", onReload: noop, onOverwrite: noop })), "codex", variant);
  assertEditorRules(conflict, `instructions conflict · ${variant}`, variant);
  assert.ok(buttonWith(conflict, "Reload") && buttonWith(conflict, "Overwrite").includes("text-danger"), "Reload or Overwrite");
}

console.log("agent-profile editor render checks: ok");
