import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { captureArgs, sessionEnvBase } from "./tmux.ts";

test("default args: colors + full history (back-compatible)", () => {
  assert.deepEqual(captureArgs("orq-x"), ["capture-pane", "-p", "-e", "-J", "-S", "-", "-t", "orq-x"]);
});

test("escapes:false drops -e (plain text)", () => {
  assert.deepEqual(captureArgs("orq-x", { escapes: false, lines: "all" }),
    ["capture-pane", "-p", "-J", "-S", "-", "-t", "orq-x"]);
});

test("lines:0 → current screen (-S 0); lines:N → -S -N", () => {
  assert.deepEqual(captureArgs("orq-x", { escapes: false, lines: 0 }),
    ["capture-pane", "-p", "-J", "-S", "0", "-t", "orq-x"]);
  assert.deepEqual(captureArgs("orq-x", { escapes: false, lines: 40 }),
    ["capture-pane", "-p", "-J", "-S", "-40", "-t", "orq-x"]);
});

test("sessionEnvBase replaces nologin shell for child PTYs", () => {
  const originalShell = process.env.SHELL;
  try {
    process.env.SHELL = "/usr/sbin/nologin";
    const env = sessionEnvBase();
    assert.notEqual(env.SHELL, "/usr/sbin/nologin");
    assert.ok(env.SHELL);
    assert.doesNotMatch(env.SHELL, /\/(?:nologin|false)$/);
  } finally {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  }
});

test("sessionEnvBase preserves an executable interactive shell", () => {
  const candidate = ["/bin/sh", "/usr/bin/sh"].find((path) => {
    try {
      accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!candidate) {
    return;
  }

  const originalShell = process.env.SHELL;
  try {
    process.env.SHELL = candidate;
    assert.equal(sessionEnvBase().SHELL, candidate);
  } finally {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  }
});
