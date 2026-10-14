// The plugins' NODE_OPTIONS preload in shell sessions (plugins spec §3.3), on
// both backends and for real: each session's command writes the NODE_OPTIONS
// it got to a file and exits. The tmux cases run on a throwaway `-S` server.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

import type { RegistryEntry } from "@orquester/api";
import { appendNodeRequireOption } from "@orquester/config";

import { setSessionNodePreload } from "./plugins/session-env.ts";
import type { RegistryService } from "./registry.ts";
import { LocalSessionManager, SessionManager } from "./sessions.ts";
import { Tmux, tmuxAvailable, tmuxVersionOk } from "./tmux.ts";

const PRELOAD = "/srv/orq/daemon/plugins/ts-rust/preload.cjs";
/** The daemon's own NODE_OPTIONS for these tests (valid, so nothing Node-based trips on it). */
const DAEMON_NODE_OPTIONS = "--no-deprecation";

let root = "";
let counter = 0;
let savedNodeOptions: string | undefined;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "orq-session-node-options-"));
  savedNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = DAEMON_NODE_OPTIONS;
});

after(async () => {
  setSessionNodePreload(null);
  if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = savedNodeOptions;
  await rm(root, { recursive: true, force: true });
});

/** A shell entry whose command records its NODE_OPTIONS (or `<unset>`) in a fresh file. */
function recordingEntry(env?: Record<string, string>): { entry: RegistryEntry; out: string } {
  counter += 1;
  const out = join(root, `node-options-${counter}`);
  return {
    out,
    entry: {
      id: "sh",
      name: "sh",
      kind: "shell",
      bin: ["/bin/sh"],
      args: ["-c", `printf '%s' "\${NODE_OPTIONS-<unset>}" > '${out}'`],
      enabled: true,
      resolvedBin: "/bin/sh",
      installState: "idle",
      ...(env ? { env } : {})
    }
  };
}

interface Manager {
  create: LocalSessionManager["create"];
  lifecycle: LocalSessionManager["lifecycle"];
}

/** Run `entry` as a session and return the NODE_OPTIONS its command saw. */
async function nodeOptionsOf(
  makeManager: (registry: RegistryService) => Manager,
  recorded: { entry: RegistryEntry; out: string }
): Promise<string> {
  const manager = makeManager({ get: (id: string) => (id === "sh" ? recorded.entry : undefined) } as RegistryService);
  const exited = once(manager.lifecycle, "exited", { signal: AbortSignal.timeout(10_000) });
  await manager.create({ kind: "shell", refId: "sh", projectPath: root, cwd: root });
  await exited;
  return readFile(recorded.out, "utf8");
}

describe("direct node-pty sessions", () => {
  const managers: LocalSessionManager[] = [];
  const local =
    (extraEnv?: Record<string, string>, unset?: string[]) =>
    (registry: RegistryService): Manager => {
      const manager = new LocalSessionManager(
        registry,
        extraEnv ? { resolveExtraEnv: () => ({ env: extraEnv, unset }) } : {}
      );
      managers.push(manager);
      return manager;
    };

  after(() => {
    for (const manager of managers) manager.closeAll();
  });

  test("no preload active: the child's NODE_OPTIONS is the daemon's, untouched", async () => {
    setSessionNodePreload(null);
    assert.equal(await nodeOptionsOf(local(), recordingEntry()), DAEMON_NODE_OPTIONS);
  });

  test("a preload active: appended to the daemon's, the entry's or the launcher's NODE_OPTIONS", async () => {
    setSessionNodePreload(PRELOAD);
    try {
      assert.equal(await nodeOptionsOf(local(), recordingEntry()), appendNodeRequireOption(DAEMON_NODE_OPTIONS, PRELOAD));
      assert.equal(
        await nodeOptionsOf(local(), recordingEntry({ NODE_OPTIONS: "--trace-warnings" })),
        appendNodeRequireOption("--trace-warnings", PRELOAD)
      );
      assert.equal(
        await nodeOptionsOf(local({ NODE_OPTIONS: "--no-warnings" }), recordingEntry({ NODE_OPTIONS: "--trace-warnings" })),
        appendNodeRequireOption("--no-warnings", PRELOAD)
      );
    } finally {
      setSessionNodePreload(null);
    }
  });

  test("a preload active and no NODE_OPTIONS anywhere: just the preload", async () => {
    delete process.env.NODE_OPTIONS;
    setSessionNodePreload(PRELOAD);
    try {
      assert.equal(await nodeOptionsOf(local(), recordingEntry()), appendNodeRequireOption(undefined, PRELOAD));
    } finally {
      setSessionNodePreload(null);
      process.env.NODE_OPTIONS = DAEMON_NODE_OPTIONS;
    }
  });

  test("a launcher that unsets NODE_OPTIONS clears the inherited value; the preload is still added", async () => {
    await assertLauncherUnset(local);
  });
});

/** Same on both backends: the launcher's unset applies first, then the preload is appended. */
async function assertLauncherUnset(
  backend: (extraEnv?: Record<string, string>, unset?: string[]) => (registry: RegistryService) => Manager
): Promise<void> {
  const entryEnv = { NODE_OPTIONS: "--trace-warnings" };
  assert.equal(await nodeOptionsOf(backend({}, ["NODE_OPTIONS"]), recordingEntry(entryEnv)), "<unset>");
  setSessionNodePreload(PRELOAD);
  try {
    assert.equal(
      await nodeOptionsOf(backend({}, ["NODE_OPTIONS"]), recordingEntry(entryEnv)),
      appendNodeRequireOption(undefined, PRELOAD)
    );
    assert.equal(
      await nodeOptionsOf(backend({ NODE_OPTIONS: "--no-warnings" }, ["NODE_OPTIONS"]), recordingEntry(entryEnv)),
      appendNodeRequireOption(undefined, PRELOAD)
    );
  } finally {
    setSessionNodePreload(null);
  }
}

describe("tmux-backed sessions", { skip: tmuxAvailable() && tmuxVersionOk() ? false : "tmux >= 3.2 unavailable" }, () => {
  let socket = "";
  let tmux: Tmux;
  const managers: SessionManager[] = [];
  const tmuxed =
    (extraEnv?: Record<string, string>, unset?: string[]) =>
    (registry: RegistryService): Manager => {
      const manager = new SessionManager(
        registry,
        tmux,
        join(root, `sessions-${managers.length}.json`),
        extraEnv ? { resolveExtraEnv: () => ({ env: extraEnv, unset }) } : {}
      );
      managers.push(manager);
      return manager;
    };

  before(() => {
    socket = join(root, "tmux.sock");
    tmux = new Tmux(socket);
  });

  after(async () => {
    for (const manager of managers) manager.closeAll();
    await new Promise<void>((resolve) => execFile("tmux", ["-S", socket, "kill-server"], () => resolve()));
  });

  // Ordered: the first session starts the server, whose global env is then
  // the daemon's (this process's) env; the server exits with it.
  test("the first session on a new server appends to the daemon's NODE_OPTIONS", async () => {
    setSessionNodePreload(PRELOAD);
    try {
      assert.equal(await nodeOptionsOf(tmuxed(), recordingEntry()), appendNodeRequireOption(DAEMON_NODE_OPTIONS, PRELOAD));
    } finally {
      setSessionNodePreload(null);
    }
  });

  test("a running server: appended to its global NODE_OPTIONS, which stays unchanged", async () => {
    // Keeps the server (and so its global env) alive between the sessions below.
    await tmux.newServiceSession({ name: "orqsvc-keeper", cwd: root, env: {}, bin: "sleep", args: ["600"] });
    await promisify(execFile)("tmux", ["-S", socket, "set-environment", "-g", "NODE_OPTIONS", "--trace-deprecation"]);
    setSessionNodePreload(PRELOAD);
    try {
      assert.equal(await nodeOptionsOf(tmuxed(), recordingEntry()), appendNodeRequireOption("--trace-deprecation", PRELOAD));
    } finally {
      setSessionNodePreload(null);
    }
    assert.equal(await tmux.inheritedEnvValue("NODE_OPTIONS"), "--trace-deprecation");
    // No preload: the pane gets the global value as it is.
    assert.equal(await nodeOptionsOf(tmuxed(), recordingEntry()), "--trace-deprecation");
  });

  test("the entry's and the launcher wrapper's NODE_OPTIONS are appended to", async () => {
    setSessionNodePreload(PRELOAD);
    try {
      assert.equal(
        await nodeOptionsOf(tmuxed(), recordingEntry({ NODE_OPTIONS: "--trace-warnings" })),
        appendNodeRequireOption("--trace-warnings", PRELOAD)
      );
      assert.equal(
        await nodeOptionsOf(tmuxed({ NODE_OPTIONS: "--no-warnings" }), recordingEntry({ NODE_OPTIONS: "--trace-warnings" })),
        appendNodeRequireOption("--no-warnings", PRELOAD)
      );
    } finally {
      setSessionNodePreload(null);
    }
  });

  test("a launcher that unsets NODE_OPTIONS clears the inherited value; the preload is still added", async () => {
    await assertLauncherUnset(tmuxed);
  });

  test("a global value unset on the server: just the preload", async () => {
    await promisify(execFile)("tmux", ["-S", socket, "set-environment", "-g", "-u", "NODE_OPTIONS"]);
    assert.equal(await tmux.inheritedEnvValue("NODE_OPTIONS"), undefined);
    setSessionNodePreload(PRELOAD);
    try {
      assert.equal(await nodeOptionsOf(tmuxed(), recordingEntry()), appendNodeRequireOption(undefined, PRELOAD));
    } finally {
      setSessionNodePreload(null);
    }
    assert.equal(await nodeOptionsOf(tmuxed(), recordingEntry()), "<unset>");
  });
});
