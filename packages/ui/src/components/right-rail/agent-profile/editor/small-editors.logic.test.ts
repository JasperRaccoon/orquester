/** The hook, plugin, marketplace, import, instructions, layout and error rules. */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentProfileSnapshot, ProfileImportCandidate, ProfileItem } from "@orquester/api";

import { isAbort, profileError, profileErrorPlacement } from "./errors";
import { eventTakesMatcher, hookDraftFromForm, initialHookForm, validateHookForm } from "./hook.logic";
import {
  copyableItems,
  copySourceAgents,
  defaultCopySource,
  defaultPicks,
  gitUrlError,
  pickedCollisions,
  toggleAllPicks,
  togglePick,
  uploadFileError
} from "./import.logic";
import { overwriteInstructions } from "./instructions.logic";

import {
  initialMarketplaceForm,
  marketplaceDraftFromForm,
  validateMarketplaceForm
} from "./marketplace.logic";
import {
  filterMarketplacePlugins,
  marketplaceNames,
  pluginInstallMode,
  pluginSpecError,
  specPluginDraft
} from "./plugin.logic";

test("hook: the matcher is left out for events that ignore it, and when blank", () => {
  const form = { event: "PreToolUse", matcher: " Edit|Write ", command: "  ./check.sh\n", timeout: "30" };
  assert.deepEqual(hookDraftFromForm(form), { event: "PreToolUse", matcher: "Edit|Write", command: "./check.sh", timeoutSec: 30 });
  assert.deepEqual(hookDraftFromForm({ ...form, event: "Stop" }), { event: "Stop", command: "./check.sh", timeoutSec: 30 });
  assert.deepEqual(hookDraftFromForm({ ...form, matcher: " ", timeout: "" }), { event: "PreToolUse", command: "./check.sh" });
  assert.equal(eventTakesMatcher("UserPromptSubmit"), false);
  assert.equal(eventTakesMatcher("PostToolUse"), true);
});

test("hook: a multi-line command keeps its inner lines", () => {
  const draft = hookDraftFromForm({ event: "Stop", matcher: "", command: "set -e\nnpm test\n", timeout: "" });
  assert.equal(draft.command, "set -e\nnpm test");
});

test("hook: the agent's events, an unlisted event on disk kept selectable, validation", () => {
  const edit = initialHookForm("claude", { event: "Stop", command: "x", timeoutSec: 5 });
  const bad = validateHookForm("claude", { event: "Nope", matcher: "", command: " ", timeout: "0" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["command", "event", "timeout"]);
  assert.equal(validateHookForm("claude", edit).valid, true);
  assert.equal(validateHookForm("claude", { ...edit, event: "Custom" }, "Custom").valid, true);
});

function item(overrides: Partial<ProfileItem> & { id: string; kind: ProfileItem["kind"]; name: string }): ProfileItem {
  return {
    enabled: true,
    toggleable: true,
    editable: true,
    deletable: true,
    locked: false,
    source: { type: "user", label: "User" },
    revision: "r",
    warnings: [],
    ...overrides
  };
}

function snapshot(items: ProfileItem[]): AgentProfileSnapshot {
  return {
    agent: "claude",
    installed: true,
    revision: "s",
    instructions: { path: "/h/.claude/CLAUDE.md", exists: true, bytes: 1, lines: 1, revision: "i", warnings: [] },
    items,
    fileErrors: [],
    readAt: "2026-09-28T00:00:00.000Z"
  };
}

test("plugin: marketplaces from the snapshot, filtering, OpenCode specs", () => {
  const snap = snapshot([
    item({ id: "marketplace:official", kind: "marketplace", name: "official" }),
    item({ id: "plugin:x", kind: "plugin", name: "x" })
  ]);
  assert.deepEqual(marketplaceNames(snap), ["official"]);
  assert.deepEqual(marketplaceNames(null), []);
  const plugins = [
    { name: "superpowers", description: "Skills for TDD", installed: true },
    { name: "linear", description: "Linear issues", installed: false },
    { name: "tdd-guard", installed: false }
  ];
  assert.deepEqual(
    filterMarketplacePlugins(plugins, "").map((p) => p.name),
    ["linear", "tdd-guard", "superpowers"],
    "installed ones last"
  );
  assert.deepEqual(filterMarketplacePlugins(plugins, "TDD").map((p) => p.name), ["tdd-guard", "superpowers"]);
  assert.equal(pluginInstallMode("opencode"), "spec");
  assert.equal(pluginInstallMode("grok"), "marketplace");
  assert.ok(pluginSpecError(""));
  assert.ok(pluginSpecError("a b"));
  assert.equal(pluginSpecError("@scope/pkg@1.0.0"), undefined);
  assert.deepEqual(specPluginDraft("  pkg "), { spec: "pkg" });
});

test("marketplace: GitHub repos (URLs normalised), git URLs, paths; ref only where it applies", () => {
  const form = { ...initialMarketplaceForm(), repo: "https://github.com/acme/plugins.git", ref: " v2 ", name: " acme " };
  assert.equal(validateMarketplaceForm(form).valid, true);
  assert.deepEqual(marketplaceDraftFromForm(form), {
    name: "acme",
    source: { type: "github", repo: "acme/plugins", ref: "v2" }
  });
  assert.deepEqual(marketplaceDraftFromForm({ ...form, type: "path", path: " ~/mkt ", name: "" }), {
    source: { type: "path", path: "~/mkt" }
  });
  assert.deepEqual(marketplaceDraftFromForm({ ...form, type: "git", url: "git@host:x/y.git", ref: "", name: "" }), {
    source: { type: "git", url: "git@host:x/y.git" }
  });
  assert.ok(validateMarketplaceForm({ ...form, type: "git", url: "not a url" }).errors.source);
  assert.ok(validateMarketplaceForm({ ...form, type: "path", path: "relative/dir" }).errors.source);
  assert.ok(validateMarketplaceForm({ ...form, name: "bad name" }).errors.name);
  assert.ok(validateMarketplaceForm(initialMarketplaceForm()).errors.source);
  assert.ok(validateMarketplaceForm({ ...form, repo: "owner" }).errors.source);
  assert.equal(validateMarketplaceForm({ ...form, repo: "owner/repo" }).valid, true);
});

const CANDIDATES: ProfileImportCandidate[] = [
  { ref: "skills/a", kind: "skill", name: "a", exists: false },
  { ref: "skills/b", kind: "skill", name: "b", exists: true },
  { ref: "commands/c.md", kind: "command", name: "c", exists: false }
];

test("import: new candidates start ticked; collisions among the picks ask first", () => {
  const picks = defaultPicks(CANDIDATES);
  assert.deepEqual(picks, ["skills/a", "commands/c.md"]);
  assert.deepEqual(pickedCollisions(CANDIDATES, picks), []);
  const withB = togglePick(picks, "skills/b");
  assert.deepEqual(pickedCollisions(CANDIDATES, withB).map((c) => c.name), ["b"]);
  assert.deepEqual(togglePick(withB, "skills/b"), picks);
  assert.deepEqual(toggleAllPicks(CANDIDATES, picks), ["skills/a", "skills/b", "commands/c.md"]);
  assert.deepEqual(toggleAllPicks(CANDIDATES, ["skills/a", "skills/b", "commands/c.md"]), []);
});

test("import: git URLs, upload names, upload progress", () => {
  assert.equal(gitUrlError("https://github.com/acme/skills/tree/main/skills/x"), undefined);
  assert.equal(gitUrlError("git@github.com:acme/skills.git"), undefined);
  assert.ok(gitUrlError(""));
  assert.ok(gitUrlError("acme/skills"));
  assert.equal(uploadFileError("skills.ZIP"), undefined);
  assert.equal(uploadFileError("review.md"), undefined);
  assert.ok(uploadFileError("skills.tar.gz"));
});

test("copy: every other agent; only the source agent's own items of the kind", () => {
  assert.deepEqual(copySourceAgents("grok"), ["claude", "codex", "opencode"]);
  assert.equal(defaultCopySource("claude", () => null), "codex", "unknown yet: the first other");
  assert.equal(defaultCopySource("claude", (other) => other !== "codex"), "grok", "a missing one is not the default");
  assert.equal(defaultCopySource("claude", () => false), "codex", "none installed: still one to show");
  const snap = snapshot([
    item({ id: "skill:zeta", kind: "skill", name: "zeta" }),
    item({ id: "skill:alpha", kind: "skill", name: "alpha" }),
    item({ id: "skill:inh", kind: "skill", name: "inh", source: { type: "inherited", label: "From Claude", ownerAgent: "claude" } }),
    item({ id: "skill:plug", kind: "skill", name: "plug", source: { type: "plugin", label: "Plugin · x", pluginId: "x" } }),
    item({ id: "command:c", kind: "command", name: "c" })
  ]);
  assert.deepEqual(copyableItems(snap, "skill").map((i) => i.name), ["alpha", "zeta"]);
  assert.deepEqual(copyableItems(snap, "command").map((i) => i.name), ["c"]);
  assert.deepEqual(copyableItems(snap, "hook"), []);
  assert.deepEqual(copyableItems(null, "skill"), []);
});

test("instructions: overwrite re-reads for the fresh revision, then writes mine", async () => {
  const calls: string[] = [];
  await overwriteInstructions(
    {
      read: async () => {
        calls.push("read");
        return {
          text: "theirs",
          info: { path: "/h/AGENTS.md", exists: true, bytes: 6, lines: 1, revision: "fresh", warnings: [] }
        };
      },
      write: async (agent, request) => {
        calls.push(`write ${agent} ${request.revision} ${request.text}`);
        return { snapshot: snapshot([]), itemIds: [], notes: ["Saved"] };
      }
    },
    "codex",
    "mine"
  );
  assert.deepEqual(calls, ["read", "write codex fresh mine"]);
});

test("errors: the daemon's nested code and message; placement by code", () => {
  const apiError = {
    name: "ApiError",
    status: 409,
    message: "Orquester API … failed",
    serverMessage: "An MCP server named jira already exists",
    body: { error: { code: "ITEM_EXISTS", message: "An MCP server named jira already exists" } }
  };
  const info = profileError(apiError);
  assert.deepEqual(info, { code: "ITEM_EXISTS", status: 409, message: "An MCP server named jira already exists" });
  assert.equal(profileErrorPlacement(info), "exists");
  assert.equal(profileErrorPlacement({ code: "INVALID_NAME", status: 400, message: "" }), "name");
  assert.equal(profileErrorPlacement({ code: "PROFILE_CONFLICT", status: 409, message: "" }), "changed");
  assert.equal(profileErrorPlacement({ code: "AGENT_CLI_FAILED", status: 502, message: "" }), "general");
  assert.deepEqual(profileError(new Error("offline")), { code: null, status: null, message: "offline" });
  assert.equal(isAbort({ name: "AbortError" }), true);
  assert.equal(isAbort(new Error("x")), false);
});
