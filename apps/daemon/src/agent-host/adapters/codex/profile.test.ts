/**
 * Codex — Agent Profile threads (spec 2026-10-18 §6.2): the thread runs in the prepared home, and
 * every `thread/start` / `thread/resume` switches off the skills that are not the profile's
 * (`skills.config`, nested), merged with the session-tool server config. Against the scripted mock
 * app-server; Global threads are covered by the other suites and stay as they were.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { writePreparedManifest } from "../../../session-profiles/manifest.ts";
import type { HostThreadProfile } from "../../host-protocol.ts";
import { recordingSessionTools } from "../../session-tools/testing.ts";
import { createCodexAdapter } from "./index.ts";
import { codexProfileLaunch, codexProfileSkillDisables, codexProfileSkillsConfig } from "./profile.ts";
import { createFakeContext, writeMockCodexServer } from "./testing.ts";

const cleanups: Array<() => void | Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function skill(path: string, scope: string, pluginId: string | null = null) {
  return { name: path.split("/").at(-2), description: "d", path, scope, enabled: true, pluginId };
}

/** A prepared home with its manifest and a seeded state DB, plus a `$HOME` with a global skill. */
async function prepared(options: { seeded?: boolean; manifest?: boolean } = {}) {
  const root = tempDir("codex-profile-");
  const preparedDir = join(root, "prepared", "v-1");
  const home = join(root, "home");
  mkdirSync(join(preparedDir, "skills", "video-cut"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "pdf"), { recursive: true });
  // A global skill symlinked from elsewhere: Codex reports its real location.
  const elsewhere = join(root, "dotfiles", "skills", "notes");
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(home, ".agents", "skills", "notes"));
  if (options.seeded !== false) writeFileSync(join(preparedDir, "state_5.sqlite"), "");
  const profile: HostThreadProfile = { profileId: "editor", revision: "3", preparedDir };
  if (options.manifest !== false) {
    await writePreparedManifest(preparedDir, {
      schema: 1,
      profileId: "editor",
      revision: "3",
      agent: "codex",
      accountKey: "acc1",
      preparedAt: "2026-10-18T00:00:00.000Z",
      agentSection: { stateDbFile: "state_5.sqlite", hideBuiltinSkills: true, skills: ["video-cut"], userSkillRoots: [join(home, ".agents", "skills")] }
    });
  }
  const skills = [
    skill(join(preparedDir, "skills", "video-cut", "SKILL.md"), "user"),
    skill(join(home, ".agents", "skills", "pdf", "SKILL.md"), "user"),
    skill(join(elsewhere, "SKILL.md"), "user"),
    skill(join(root, "repo", ".agents", "skills", "build", "SKILL.md"), "repo"),
    skill(join(preparedDir, "plugins", "cache", "studio", "render", "1.0.0", "skills", "render", "SKILL.md"), "user", "render@studio")
  ];
  return { root, preparedDir, home, profile, skills };
}

describe("codex profile — the skill switch-offs", () => {
  it("switches off $HOME/.agents/skills and every user skill outside the prepared home; keeps the profile's, repo and plugin skills", async () => {
    const p = await prepared();
    const launch = await codexProfileLaunch(p.preparedDir, { userSkillRoots: [] }, p.home);
    const off = codexProfileSkillDisables([{ cwd: "/repo", skills: p.skills as never, errors: [] }], launch);
    assert.deepEqual(off, [p.skills[1]!.path, p.skills[2]!.path]);
    assert.deepEqual(codexProfileSkillsConfig(off), {
      skills: { config: off.map((path) => ({ path, enabled: false })) }
    });
    assert.deepEqual(codexProfileSkillsConfig([]), {});
  });

  it("refuses a home whose state DB is gone", async () => {
    const p = await prepared({ seeded: false });
    await assert.rejects(codexProfileLaunch(p.preparedDir, { stateDbFile: "state_5.sqlite" }, p.home), /not seeded/);
  });
});

describe("codex profile — a launch", () => {
  async function start(p: Awaited<ReturnType<typeof prepared>>, options: { resume?: boolean; withTools?: boolean; accountHome?: string } = {}) {
    const server = writeMockCodexServer({ turns: [], skills: p.skills });
    cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
    const tools = recordingSessionTools();
    const { context } = createFakeContext({
      resolveBin: () => Promise.resolve(server.bin),
      ...(options.withTools !== false ? { sessionTools: tools } : {}),
      // The launch env still names the ACCOUNT home: the profile's home must win anyway.
      buildEnv: (input) =>
        ({ PATH: process.env.PATH ?? "", HOME: p.home, CODEX_HOME: options.accountHome ?? "/accounts/acc1/home", ...input.extraEnv }) as Record<string, string>
    });
    const adapter = await createCodexAdapter(context);
    cleanups.push(() => adapter.stopAll());
    await adapter.refreshSnapshot({ cwd: process.cwd() });
    const started = adapter.startSession({
      threadId: "thread-p",
      cwd: process.cwd(),
      home: { kind: "account", path: options.accountHome ?? "/accounts/acc1/home", accountId: "acc1" },
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required",
      profile: p.profile,
      ...(options.resume ? { resumeCursor: { threadId: "prior-thread" } } : {})
    });
    return { server, adapter, started, tools };
  }

  for (const resume of [false, true]) {
    it(`${resume ? "thread/resume" : "thread/start"} carries the skill switch-offs beside Orquester's server, in the prepared home`, async () => {
      const p = await prepared();
      const { server, started } = await start(p, { resume });
      await started;
      const methods = server.received().flatMap((frame) => (frame.method !== undefined ? [frame.method] : []));
      const open = resume ? "thread/resume" : "thread/start";
      assert.ok(methods.indexOf("skills/list") < methods.indexOf(open), "listed before the thread opens");
      const params = server.received().find((frame) => frame.method === open)?.params as { config?: Record<string, unknown> };
      assert.deepEqual(params.config?.skills, {
        config: [
          { path: p.skills[1]!.path, enabled: false },
          { path: p.skills[2]!.path, enabled: false }
        ]
      });
      assert.ok(params.config?.["mcp_servers.orquester"] !== undefined, "Orquester's server is still attached");
      const list = server.received().find((frame) => frame.method === "skills/list")?.params;
      assert.deepEqual(list, { cwds: [process.cwd()] });
    });
  }

  it("the thread's own catalog is what it loads: the listing minus the switched-off skills (Agent Profiles composer)", async () => {
    const p = await prepared();
    const { adapter, started } = await start(p);
    assert.equal(await adapter.sessionCatalog!("thread-p"), null, "nothing before the start listed");
    await started;
    const catalog = await adapter.sessionCatalog!("thread-p");
    assert.deepEqual(catalog?.slashCommands.map((command) => command.name), ["compact", "feedback"], "the host's own Codex commands");
    assert.deepEqual(catalog?.skills.map((entry) => entry.name), ["video-cut", "build", "render"]);
    assert.ok(!catalog?.skills.some((entry) => entry.path.startsWith(p.home)), "never a Global skill");
  });

  it("without a session-tool grant the switch-offs still go", async () => {
    const p = await prepared();
    const { server, started } = await start(p, { withTools: false });
    await started;
    const params = server.received().find((frame) => frame.method === "thread/start")?.params as { config?: Record<string, unknown> };
    assert.deepEqual(Object.keys(params.config ?? {}), ["skills"]);
  });

  it("fails the start when the prepared manifest is missing — never a Global launch", async () => {
    const p = await prepared({ manifest: false });
    const { server, started } = await start(p);
    await assert.rejects(started, /Agent Profile could not be loaded/);
    // Only the snapshot probe ran: no thread was opened.
    assert.ok(!server.received().some((frame) => frame.method === "thread/start" || frame.method === "thread/resume"), "no thread was opened");
  });

  it("fails the start when the prepared home lost its state DB", async () => {
    const p = await prepared();
    unlinkSync(join(p.preparedDir, "state_5.sqlite"));
    const { started } = await start(p);
    await assert.rejects(started, /not seeded/);
  });

  it("forks a profile child in its prepared home", async () => {
    const p = await prepared();
    const server = writeMockCodexServer({ forkThreadId: "forked-1" });
    cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
    const wrapper = join(server.dir, "codex-wrapper.sh");
    const envLog = join(server.dir, "codex-home.txt");
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s' "$CODEX_HOME" > '${envLog}'\nexec '${server.bin}' "$@"\n`, "utf8");
    chmodSync(wrapper, 0o755);
    const { context } = createFakeContext({
      resolveBin: () => Promise.resolve(wrapper),
      buildEnv: () => ({ PATH: process.env.PATH ?? "", HOME: p.home, CODEX_HOME: "/accounts/acc1/home" })
    });
    const adapter = await createCodexAdapter(context);
    cleanups.push(() => adapter.stopAll());
    await adapter.refreshSnapshot({ cwd: process.cwd() });
    const forked = await adapter.forkConversation!({
      sourceThreadId: "parent",
      sourceResumeCursor: { threadId: "source-1" },
      threadId: "child",
      projectPath: process.cwd(),
      cwd: process.cwd(),
      home: { kind: "account", path: "/accounts/acc1/home", accountId: "acc1" },
      profile: p.profile,
      cut: { firstRemovedTurnId: null, retainedTurnIds: ["turn-1"] }
    });
    assert.deepEqual(forked.resumeCursor, { threadId: "forked-1" });
    assert.equal(readFileSync(envLog, "utf8"), p.preparedDir);
  });
});
