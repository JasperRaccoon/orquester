import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isDeniedRealPath,
  isDeniedRelPath,
  isExecutableChange,
  isSafeEntryName,
  isSafeRelPath,
  isSyncedRel,
  syncRootKind,
  syncRuleFor
} from "./rules.ts";

test("the deny list refuses credential files, credential-like names and credential stores", () => {
  for (const rel of [
    ".credentials.json",
    "auth.json",
    "secrets.json",
    "skills/x/.env",
    "skills/x/.env.local",
    "plugins/p/api_key.txt",
    "plugins/p/my-token",
    "commands/SECRET.md",
    "skills/deploy/id_ed25519",
    "skills/deploy/server.pem",
    "skills/tokens/readme.md",
    "skills/x/.npmrc",
    "plugins/.ssh/config",
    "skills/x/credentials"
  ]) {
    assert.equal(isDeniedRelPath(rel), true, rel);
  }
  for (const rel of ["settings.json", "CLAUDE.md", "skills/review/SKILL.md", "keybindings.json", "plugins/cache/p/1.0/hooks/run.sh"]) {
    assert.equal(isDeniedRelPath(rel), false, rel);
  }
});

test("realpaths are checked for store dirs, file names and deny roots, not for every dir name", () => {
  assert.equal(isDeniedRealPath("/home/u/.ssh/id_rsa"), true);
  assert.equal(isDeniedRealPath("/home/u/.ssh/config"), true);
  assert.equal(isDeniedRealPath("/home/u/.config/gh/hosts.yml"), true);
  assert.equal(isDeniedRealPath("/home/u/.claude/.credentials.json"), true);
  assert.equal(isDeniedRealPath("/home/u/notes/innocent.md"), false);
  // A project called secret-files is fine as a directory; the file name decides.
  assert.equal(isDeniedRealPath("/work/secret-files/CLAUDE.md"), false);
  assert.equal(isDeniedRealPath("/app/daemon/keys/x.pub", ["/app/daemon/keys"]), true);
});

test("include lists keep transcripts, caches, telemetry and state out", () => {
  const claude = syncRuleFor("claude", "account");
  for (const rel of ["settings.json", ".claude.json", "skills/a/SKILL.md", "plugins/installed_plugins.json", "plugins/cache/m/p/1/x.js", "commands/a.md", "agents/r.md", "CLAUDE.md"]) {
    assert.equal(isSyncedRel(claude, rel), true, rel);
  }
  for (const rel of [
    "projects/-x/abc.jsonl",
    "todos/a.json",
    "statsig/x",
    "shell-snapshots/s.sh",
    "ide/1.lock",
    "history.jsonl",
    "sessions/x",
    "plugins/plugin-catalog-cache.json",
    "plugins/plugin-directory-cache-v2.json",
    "plugins/synced/acct_org/.marketplaces.json",
    "plugins/.staging/x/plugin.json",
    "skills/synced/acct_org/review/SKILL.md",
    "skills/.trash/1792491947496-764074-sQIMC3/old/SKILL.md",
    "plugins/installed_plugins.json.bak",
    "plugins/data/p/state.json",
    "plugins/marketplaces/m/.git/HEAD",
    "settings.json.bak-20260820",
    ".credentials.json",
    "skills/../x"
  ]) {
    assert.equal(isSyncedRel(claude, rel), false, rel);
  }
  const codex = syncRuleFor("codex", "account");
  assert.equal(isSyncedRel(codex, "config.toml"), true);
  assert.equal(isSyncedRel(codex, "skills/mine/SKILL.md"), true);
  assert.equal(isSyncedRel(codex, "skills/.system/x/SKILL.md"), false);
  for (const rel of ["sessions/2026/01/01/rollout-x.jsonl", "state_5.sqlite", "logs_2.sqlite-wal", "auth.json", "history.jsonl", "models_cache.json"]) {
    assert.equal(isSyncedRel(codex, rel), false, rel);
  }
  const opencodePrepared = syncRuleFor("opencode", "prepared");
  assert.equal(isSyncedRel(opencodePrepared, "opencode/opencode.json"), true);
  assert.equal(isSyncedRel(opencodePrepared, "opencode/node_modules/x/index.js"), false);
  assert.equal(isSyncedRel(opencodePrepared, "xdg"), true);
  assert.equal(isSyncedRel(opencodePrepared, "xdg/gh"), false);
  assert.equal(isSyncedRel(syncRuleFor("grok", "account"), "sessions/x/summary.json"), false);
});

test("roots under the prepared root are host → box only", () => {
  assert.equal(syncRootKind("/app/daemon/session-profiles/prepared/p/claude/shared/v-1", "/app/daemon/session-profiles/prepared"), "prepared");
  assert.equal(syncRootKind("/app/daemon/agent-accounts/claude/a/home", "/app/daemon/session-profiles/prepared"), "account");
  assert.equal(syncRuleFor("claude", "prepared").twoWay, false);
  assert.equal(syncRuleFor("claude", "account").twoWay, true);
});

test("box-listed names: only plain segments; temp files of either side never sync", () => {
  for (const name of ["", ".", "..", "a/b", "../x", "a\\b", "..\\x", "a\u0000b"]) assert.equal(isSafeEntryName(name), false, JSON.stringify(name));
  for (const name of ["s1.jsonl", ".hidden", "...", "a..b", "rollout-1-x.jsonl"]) assert.equal(isSafeEntryName(name), true, name);
  assert.equal(isSafeRelPath("s1/subagents/a.jsonl"), true);
  for (const rel of ["s1/../x", "./s1", "s1//a", "s1/", "/s1"]) assert.equal(isSafeRelPath(rel), false, rel);
  const claude = syncRuleFor("claude", "account");
  assert.equal(isSyncedRel(claude, "skills/x/.SKILL.md.orq-tmp-123"), false);
  assert.equal(isSyncedRel(claude, "skills/x/SKILL.md.orq-sync-abc"), false);
  assert.equal(isSyncedRel(claude, "skills/a\\..\\b"), false);
});

test("executable changes: Grok's trusted folders list counts", () => {
  const grok = syncRuleFor("grok", "account");
  assert.equal(isExecutableChange({ rule: grok, rel: "trusted_folders.toml", mode: 0o644, content: Buffer.from(""), configKeysChanged: false }), true);
});

test("executable changes: hooks, scripts, exec bits and process-starting config keys", () => {
  const claude = syncRuleFor("claude", "account");
  const base = { rule: claude, mode: 0o644, content: Buffer.from("text"), configKeysChanged: false };
  assert.equal(isExecutableChange({ ...base, rel: "hooks/pre.sh" }), true);
  assert.equal(isExecutableChange({ ...base, rel: "skills/a/run.py" }), true);
  assert.equal(isExecutableChange({ ...base, rel: "skills/a/tool", content: Buffer.from("#!/bin/sh\necho") }), true);
  assert.equal(isExecutableChange({ ...base, rel: "skills/a/tool", mode: 0o755 }), true);
  assert.equal(isExecutableChange({ ...base, rel: "settings.json", configKeysChanged: true }), true);
  assert.equal(isExecutableChange({ ...base, rel: "skills/a/SKILL.md" }), false);
  assert.equal(isExecutableChange({ ...base, rel: "CLAUDE.md" }), false);
});
