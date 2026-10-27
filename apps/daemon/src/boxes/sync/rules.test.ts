import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLAUDE_INSTALLED_PLUGINS_REL,
  installedPluginCacheDirs,
  isDeniedRealPath,
  isDeniedRelPath,
  isExecutableChange,
  isSafeEntryName,
  isSafeRelPath,
  isSyncedRel,
  isUninstalledPluginCache,
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
    "plugins/store/cc-plugin-agents-md_builtin-b049b47b3618.json",
    "plugins/cache/claude-plugins-official/hookify/1da406f428c2/.orphaned_at",
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

test("installed_plugins.json names the cache dirs of its installs (installPath of any account home, or name@marketplace + version)", () => {
  const list = {
    version: 2,
    plugins: {
      "superpowers@claude-plugins-official": [
        {
          scope: "user",
          installPath: "/var/lib/orquester/daemon/agent-accounts/claude/bc97/home/plugins/cache/claude-plugins-official/superpowers/7.0.0",
          version: "7.0.0"
        }
      ],
      "hookify@claude-plugins-official": [
        { scope: "user", installPath: "C:\\orq\\h\\plugins\\cache\\claude-plugins-official\\hookify\\465f0934\\", version: "465f0934" }
      ],
      "evil@m": [{ installPath: "/h/plugins/cache/../../../etc", version: "../x" }]
    }
  };
  assert.deepEqual(installedPluginCacheDirs(JSON.stringify(list))?.sort(), [
    "claude-plugins-official/hookify/465f0934",
    "claude-plugins-official/superpowers/7.0.0"
  ]);
  // Version 1: one install object per plugin.
  assert.deepEqual(installedPluginCacheDirs(JSON.stringify({ version: 1, plugins: { "p@m": { version: "1.0" } } })), ["m/p/1.0"]);
  assert.equal(installedPluginCacheDirs("not json"), null);
  assert.equal(installedPluginCacheDirs('{"version":2}'), null);
  assert.equal(CLAUDE_INSTALLED_PLUGINS_REL, "plugins/installed_plugins.json");
});

test("the plugin cache keeps installed versions only; temp clones and in-use markers never sync; marketplaces are host → box only", () => {
  const allowed = new Set(["m/p/1.0"]);
  assert.equal(isUninstalledPluginCache("plugins/cache/m/p/1.0/skills/a/SKILL.md", allowed), false);
  assert.equal(isUninstalledPluginCache("plugins/cache/m/p", allowed), false, "on the way to an installed one");
  assert.equal(isUninstalledPluginCache("plugins/cache/m/p/0.9/skills/a/SKILL.md", allowed), true);
  assert.equal(isUninstalledPluginCache("plugins/cache/m/q", allowed), true);
  assert.equal(isUninstalledPluginCache("plugins/marketplaces/m/x", allowed), false, "outside the cache");
  assert.equal(isUninstalledPluginCache("plugins/cache/m/p/0.9/x", null), false, "no list: no filter");
  const claude = syncRuleFor("claude", "account");
  assert.equal(isSyncedRel(claude, "plugins/cache/temp_git_1791328646189_oneqrz/README.md"), false);
  assert.equal(isSyncedRel(claude, "plugins/cache/m/p/1.0/.in_use/3010287"), false);
  assert.equal(isSyncedRel(claude, "plugins/cache/m/p/1.0/skills/x.md"), true);
  assert.equal(claude.hostOnly("plugins/marketplaces/m/.gcs-sha"), true);
  assert.equal(claude.hostOnly("plugins/known_marketplaces.json"), true);
  assert.equal(claude.hostOnly("plugins/installed_plugins.json"), false);
  assert.equal(claude.hostOnly("skills/x/SKILL.md"), false);
});

test("Codex's plugins/ is its own marketplace store: host → box only, a box's downloads are never collected", () => {
  const codex = syncRuleFor("codex", "account");
  // Each box's Codex fetches the curated plugins its config.toml enables into plugins/cache itself.
  assert.equal(isSyncedRel(codex, "plugins/cache/openai-curated/superpowers/0722921d/skills/x/SKILL.md"), true, "the host's copy is still pushed");
  assert.equal(codex.hostOnly("plugins/cache/openai-curated/superpowers/0722921d/skills/x/scripts/render-graphs.js"), true);
  assert.equal(codex.hostOnly("plugins/.remote-plugin-install-staging/x"), true);
  assert.equal(codex.hostOnly("plugins"), true);
  // What turns a plugin on stays two-way: config.toml.
  assert.equal(codex.hostOnly("config.toml"), false);
  assert.equal(codex.hostOnly("skills/x/SKILL.md"), false);
});
