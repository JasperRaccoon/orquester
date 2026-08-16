import assert from "node:assert/strict";
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

async function waitFor(poll: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (poll()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
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
    await waitFor(() => mgr.buffer(session.id).includes("orq-typed-ok"));
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
    args: ["-c", "IFS= read -r line; printf 'READ[%s]\\n' \"$line\"; sleep 5"]
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
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(mgr.buffer(blank.id).includes("READ["), false, "whitespace must not be typed");

    const typed = await mgr.create({
      kind: "shell",
      refId: "sh",
      projectPath: root,
      cwd: root,
      initialCommand: "hello there"
    });
    await waitFor(() => mgr.buffer(typed.id).includes("READ[hello there]"));
  } finally {
    mgr.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
