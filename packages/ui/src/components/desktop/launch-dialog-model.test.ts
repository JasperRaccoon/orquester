import test from "node:test";
import assert from "node:assert/strict";

import { DESKTOP_MAX_COMMAND_LENGTH, type DesktopSuggestionsResponse } from "@orquester/api";

import {
  buildCreateRequest,
  buildLaunchRequest,
  clampRenderThreads,
  commandError,
  describeLaunchError,
  envFromRows,
  executableCommand,
  rankSuggestions,
  rowsFromEnv,
  suggestionItems
} from "./launch-dialog-model.ts";

const response: DesktopSuggestionsResponse = {
  entries: [
    { name: "XTerm", command: "xterm", icon: null, source: "system" },
    { name: "Mousepad", command: "mousepad", icon: null, source: "system" },
    { name: "GIMP", command: "gimp-2.10", icon: "gimp", source: "user" }
  ],
  executables: ["build/linux/bin/jasperengine-editor", "run.sh"],
  recent: [
    { command: "./run.sh --dev", cwd: "tools", env: { DEBUG: "1" }, lastUsedAt: "2026-09-30T10:00:00.000Z" }
  ]
};

test("suggestions list recents, then .desktop entries by name, then executables as ./path", () => {
  const items = suggestionItems(response);
  assert.deepEqual(
    items.map((i) => [i.kind, i.label, i.insert]),
    [
      ["recent", "./run.sh --dev", "./run.sh --dev"],
      ["entry", "XTerm", "xterm"],
      ["entry", "Mousepad", "mousepad"],
      ["entry", "GIMP", "gimp-2.10"],
      ["executable", "build/linux/bin/jasperengine-editor", "./build/linux/bin/jasperengine-editor"],
      ["executable", "run.sh", "./run.sh"]
    ]
  );
  assert.equal(items[0]?.recent?.cwd, "tools");
  assert.deepEqual(suggestionItems(null), []);
});

test("an executable path keeps an explicit prefix", () => {
  assert.equal(executableCommand("bin/app"), "./bin/app");
  assert.equal(executableCommand("./bin/app"), "./bin/app");
  assert.equal(executableCommand("/usr/bin/xterm"), "/usr/bin/xterm");
});

test("empty input lists the first suggestions; typing fuzzy-matches name and command", () => {
  const items = suggestionItems(response);
  assert.equal(rankSuggestions(items, "", 3).length, 3);
  assert.equal(rankSuggestions(items, "  ", 3)[0]?.kind, "recent");

  const editor = rankSuggestions(items, "jeditor");
  assert.equal(editor[0]?.insert, "./build/linux/bin/jasperengine-editor");

  // Matches the .desktop name even though the command differs.
  assert.equal(rankSuggestions(items, "gimp")[0]?.label, "GIMP");
  assert.deepEqual(rankSuggestions(items, "zzzz"), []);
});

test("an input that already is a suggestion's command lists nothing", () => {
  assert.deepEqual(rankSuggestions(suggestionItems(response), "xterm"), []);
});

test("the command must be one non-empty line within the limit", () => {
  assert.equal(commandError("xterm"), null);
  assert.ok(commandError("   "));
  assert.ok(commandError("xterm\nrm -rf /"));
  assert.ok(commandError("a".repeat(DESKTOP_MAX_COMMAND_LENGTH + 1)));
  assert.equal(commandError("a".repeat(DESKTOP_MAX_COMMAND_LENGTH)), null);
});

test("env rows: blanks ignored, keys validated, duplicates refused", () => {
  const { env, errors } = envFromRows([
    { id: "a", key: "DEBUG", value: "1" },
    { id: "b", key: "", value: "" },
    { id: "c", key: "1BAD", value: "x" },
    { id: "d", key: "DEBUG", value: "2" },
    { id: "e", key: "", value: "orphan" },
    { id: "f", key: " _OK2 ", value: "" }
  ]);
  assert.deepEqual(env, { DEBUG: "1", _OK2: "" });
  assert.deepEqual(Object.keys(errors).sort(), ["c", "d", "e"]);
});

test("rows round-trip a recent launch's env", () => {
  let n = 0;
  const rows = rowsFromEnv({ A: "1", B: "two" }, () => `r${++n}`);
  assert.deepEqual(envFromRows(rows).env, { A: "1", B: "two" });
});

test("the launch request trims, and omits an empty cwd and env", () => {
  assert.deepEqual(buildLaunchRequest({ command: "  xterm  ", cwd: " ", envRows: [] }), {
    ok: true,
    request: { command: "xterm" }
  });
  assert.deepEqual(
    buildLaunchRequest({ command: "./run.sh", cwd: "tools", envRows: [{ id: "a", key: "X", value: "y" }] }),
    { ok: true, request: { command: "./run.sh", cwd: "tools", env: { X: "y" } } }
  );
  const bad = buildLaunchRequest({ command: "", cwd: "", envRows: [{ id: "a", key: "9", value: "" }] });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.commandError);
    assert.ok(bad.envErrors.a);
  }
});

test("a new desktop sends size and render threads only when not the defaults", () => {
  const app = { command: "xterm" };
  assert.deepEqual(buildCreateRequest("/w/p", app, { sizeId: "fit", renderThreads: 4 }), {
    projectPath: "/w/p",
    app
  });
  assert.deepEqual(buildCreateRequest("/w/p", app, { sizeId: "1600x900", renderThreads: 8 }), {
    projectPath: "/w/p",
    app,
    size: { width: 1600, height: 900 },
    renderThreads: 8
  });
  assert.equal(clampRenderThreads(0), 1);
  assert.equal(clampRenderThreads(99), 16);
  assert.equal(clampRenderThreads(Number.NaN), 4);
});

test("daemon errors show their message and a 409's install hint", () => {
  const unavailable = {
    message: "Orquester API POST /api/desktops failed with status 409: Xvnc is missing",
    serverMessage: "Xvnc is missing",
    body: { code: "DESKTOP_UNAVAILABLE", message: "Xvnc is missing", hint: "sudo apt-get install -y tigervnc-standalone-server" }
  };
  const message = describeLaunchError(unavailable);
  assert.ok(message.includes("Xvnc is missing"));
  assert.ok(message.includes("sudo apt-get install -y tigervnc-standalone-server"));
  assert.equal(describeLaunchError(new Error("boom")), "boom");
  assert.equal(describeLaunchError({ serverMessage: null, message: "x", body: { hint: "x" } }), "x");
});
