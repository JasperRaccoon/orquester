import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { sessionEnvBase } from "./tmux.ts";

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
