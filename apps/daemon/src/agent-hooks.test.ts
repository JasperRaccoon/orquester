import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, lstat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHooks } from "./agent-hooks.ts";

const silent = { error: () => {} };

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orq-agent-hooks-"));
}

test("claude install is awaited, quotes the command, and creates 0600 settings + 0755 script", async () => {
  const s = await scratch();
  try {
    const hooks = new AgentHooks(join(s, "d"), join(s, "h"), silent);
    await hooks.ensureForEntry("claude", {});

    const settingsStat = await stat(join(s, "h", ".claude", "settings.json"));
    assert.equal(settingsStat.mode & 0o777, 0o600);
    const scriptStat = await stat(join(s, "d", "hooks", "agent-hook.sh"));
    assert.equal(scriptStat.mode & 0o777, 0o755);

    const settings = JSON.parse(await readFile(join(s, "h", ".claude", "settings.json"), "utf8"));
    const command: string = settings.hooks.Stop[0].hooks[0].command;
    assert.ok(command.startsWith("'"), "script path is POSIX single-quoted");
    assert.ok(command.endsWith(" claude Stop"));
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});

test("claude install preserves an existing file's 0600 mode and its content", async () => {
  const s = await scratch();
  try {
    const settingsPath = join(s, "h", ".claude", "settings.json");
    await mkdir(join(s, "h", ".claude"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ model: "opus" }), { mode: 0o600 });

    await new AgentHooks(join(s, "d"), join(s, "h"), silent).ensureForEntry("claude", {});

    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.model, "opus");
    assert.ok(settings.hooks.Stop);
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});

test("claude install writes THROUGH a symlinked settings.json (dotfiles setup)", async () => {
  const s = await scratch();
  try {
    const real = join(s, "dotfiles", "settings.json");
    await mkdir(join(s, "dotfiles"), { recursive: true });
    await writeFile(real, JSON.stringify({ model: "opus" }), { mode: 0o600 });
    await mkdir(join(s, "h", ".claude"), { recursive: true });
    const link = join(s, "h", ".claude", "settings.json");
    await symlink(real, link);

    await new AgentHooks(join(s, "d"), join(s, "h"), silent).ensureForEntry("claude", {});

    assert.ok((await lstat(link)).isSymbolicLink(), "the symlink survives");
    const target = JSON.parse(await readFile(real, "utf8"));
    assert.equal(target.model, "opus");
    assert.ok(target.hooks.Stop, "the dotfiles target received the hooks");
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});

test("unrecognized config shapes abort byte-identical (claude string hooks, non-array event, codex array hooks)", async () => {
  const s = await scratch();
  try {
    const cases: Array<{ home: string; file: string; content: string; entry: "claude" | "codex" }> = [
      {
        home: "h1",
        file: ".claude/settings.json",
        content: JSON.stringify({ hooks: "managed-elsewhere" }),
        entry: "claude"
      },
      {
        home: "h2",
        file: ".claude/settings.json",
        content: JSON.stringify({ hooks: { Stop: { not: "an array" } } }),
        entry: "claude"
      },
      { home: "h3", file: ".codex/hooks.json", content: JSON.stringify({ hooks: [] }), entry: "codex" }
    ];
    for (const c of cases) {
      const path = join(s, c.home, c.file);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, c.content);
      await new AgentHooks(join(s, `d-${c.home}`), join(s, c.home), silent).ensureForEntry(c.entry, {});
      assert.equal(await readFile(path, "utf8"), c.content, `${c.file} (${c.home}) untouched`);
    }
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});

test("codex install preserves metadata, appends after user groups, and writes 0600 trust blocks", async () => {
  const s = await scratch();
  try {
    const codexHome = join(s, "h", ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "hooks.json"),
      JSON.stringify({
        description: "my hooks",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/bin/mine" }] }] }
      })
    );

    await new AgentHooks(join(s, "d"), join(s, "h"), silent).ensureForEntry("codex", {});

    const doc = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"));
    assert.equal(doc.description, "my hooks");
    assert.ok(JSON.stringify(doc.hooks.Stop[0]).includes("/usr/bin/mine"), "user group keeps index 0");
    assert.ok(JSON.stringify(doc.hooks.Stop[1]).includes("agent-hook.sh"), "managed group appended");

    const toml = await readFile(join(codexHome, "config.toml"), "utf8");
    assert.ok(toml.includes('[hooks.state."'));
    assert.ok(toml.includes("sha256:"));
    assert.equal((await stat(join(codexHome, "config.toml"))).mode & 0o777, 0o600);
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});

test("codex install refuses a multiline-string config.toml BEFORE touching hooks.json", async () => {
  const s = await scratch();
  try {
    const codexHome = join(s, "h", ".codex");
    await mkdir(codexHome, { recursive: true });
    const ml = 'title = """\n[hooks.state."fake"]\n"""\n';
    await writeFile(join(codexHome, "config.toml"), ml);

    await new AgentHooks(join(s, "d"), join(s, "h"), silent).ensureForEntry("codex", {});

    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), ml, "config.toml untouched");
    await assert.rejects(stat(join(codexHome, "hooks.json")), "hooks.json was never created");
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});

test("installs are idempotent: a second run is byte-identical (claude + codex)", async () => {
  const s = await scratch();
  try {
    const first = new AgentHooks(join(s, "d"), join(s, "h"), silent);
    await first.ensureForEntry("claude", {});
    await first.ensureForEntry("codex", {});
    const settings1 = await readFile(join(s, "h", ".claude", "settings.json"), "utf8");
    const toml1 = await readFile(join(s, "h", ".codex", "config.toml"), "utf8");

    // Fresh instance: no in-flight/latch state, exercises the reinstall path.
    const second = new AgentHooks(join(s, "d"), join(s, "h"), silent);
    await second.ensureForEntry("claude", {});
    await second.ensureForEntry("codex", {});

    assert.equal(await readFile(join(s, "h", ".claude", "settings.json"), "utf8"), settings1);
    assert.equal(await readFile(join(s, "h", ".codex", "config.toml"), "utf8"), toml1);
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});

test("per-account env overrides route installs to the account config home", async () => {
  const s = await scratch();
  try {
    const hooks = new AgentHooks(join(s, "d"), join(s, "h"), silent);
    await hooks.ensureForEntry("claude", { CLAUDE_CONFIG_DIR: join(s, "acc", ".claude") });
    await hooks.ensureForEntry("codex", { CODEX_HOME: join(s, "acc", ".codex") });

    const acc = JSON.parse(await readFile(join(s, "acc", ".claude", "settings.json"), "utf8"));
    assert.ok(acc.hooks.Stop);
    const toml = await readFile(join(s, "acc", ".codex", "config.toml"), "utf8");
    assert.ok(toml.includes(join(s, "acc", ".codex", "hooks.json")), "trust key uses the account path");
    await assert.rejects(stat(join(s, "h", ".claude", "settings.json")), "default home untouched");
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});
