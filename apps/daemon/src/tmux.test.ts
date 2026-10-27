import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { sessionEnvBase, tmuxVersionOutputOk } from "./tmux.ts";

test("tmux version floor accepts numeric, letter-suffixed and development versions", () => {
  for (const version of ["tmux 3.2", "tmux 3.2a", "tmux next-3.4", "tmux 4.0"]) {
    assert.equal(tmuxVersionOutputOk(version), true, version);
  }
  for (const version of ["tmux 2.9a", "tmux 3.1c", "tmux next", ""]) {
    assert.equal(tmuxVersionOutputOk(version), false, version);
  }
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

test("sessionEnvBase preserves an executable interactive shell", (t) => {
  const candidate = ["/bin/sh", "/usr/bin/sh"].find((path) => {
    try {
      accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!candidate) return t.skip("no executable shell available");

  const originalShell = process.env.SHELL;
  try {
    process.env.SHELL = candidate;
    assert.equal(sessionEnvBase().SHELL, candidate);
  } finally {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  }
});
