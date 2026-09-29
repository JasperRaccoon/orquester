import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RegistryEntry } from "@orquester/api";
import type { RegistryService } from "./registry.ts";
import { LocalSessionManager } from "./sessions.ts";

/**
 * `initialCommand` against a REAL PTY: the point of moving it server-side is
 * that nothing between the daemon and the shell can drop it, so a fake pty
 * would test the wrong thing. `sh` reading its tty is the whole contract.
 */
const SHELL: RegistryEntry = {
  id: "sh",
  name: "sh",
  kind: "shell",
  bin: ["/bin/sh"],
  args: [],
  enabled: true,
  resolvedBin: "/bin/sh",
  installState: "idle"
};

const registry = {
  get(id: string) {
    return id === SHELL.id ? SHELL : undefined;
  }
} as Pick<RegistryService, "get"> as RegistryService;

async function outputContains(manager: LocalSessionManager, id: string, text: string): Promise<void> {
  const signal = AbortSignal.timeout(10_000);
  while (!manager.buffer(id).includes(text)) {
    await once(manager.lifecycle, "output", { signal });
  }
}

test("initialCommand is typed into the fresh PTY and run by the shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "orquester-initial-command-"));
  const mgr = new LocalSessionManager(registry);
  try {
    const session = await mgr.create({
      kind: "shell",
      refId: "sh",
      projectPath: root,
      cwd: root,
      // No client involvement at all: create() returns and the command is
      // already on its way, with no sleep and no follow-up input frame.
      initialCommand: "printf 'orq-typed-%s\\n' ok"
    });
    await outputContains(mgr, session.id, "orq-typed-ok");
    // Typed, not executed out-of-band: the shell echoed the source line too.
    assert.match(mgr.buffer(session.id), /printf 'orq-typed-%s/);
  } finally {
    mgr.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("a blank initialCommand writes nothing to the PTY", async () => {
  const root = await mkdtemp(join(tmpdir(), "orquester-initial-command-blank-"));
  // An entry that echoes back the first line it is given: it prints only if
  // something was actually typed, which is exactly the claim under test (a bare
  // "\n" would still satisfy `read` and print an empty READ[]).
  const echoOnce: RegistryEntry = {
    ...SHELL,
    args: ["-c", "IFS= read -r line; printf 'READ[%s]\\n' \"$line\""]
  };
  const mgr = new LocalSessionManager({
    get: (id: string) => (id === echoOnce.id ? echoOnce : undefined)
  } as Pick<RegistryService, "get"> as RegistryService);
  try {
    const blank = await mgr.create({
      kind: "shell",
      refId: "sh",
      projectPath: root,
      cwd: root,
      initialCommand: "   "
    });
    // The next line must be the first one read: a queued blank command would
    // consume the read and print READ[] before this sentinel can be accepted.
    mgr.input(blank.id, "sentinel\r");
    await outputContains(mgr, blank.id, "READ[sentinel]");
    assert.doesNotMatch(mgr.buffer(blank.id), /READ\[\]/);
  } finally {
    mgr.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
