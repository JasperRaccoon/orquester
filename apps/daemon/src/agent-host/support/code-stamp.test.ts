import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { computeCodeStamp, readCodeStamp } from "./code-stamp.ts";

const ENTRY = join("apps", "daemon", "src", "agent-host", "main.ts");

/**
 * A miniature checkout: the host entry importing a sibling, a module outside
 * `agent-host/`, a workspace package through its `exports`, an npm package and
 * a `node:` builtin — and files nothing imports.
 */
const CHECKOUT: Record<string, string> = {
  "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "packages/*"\n',
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "apps/daemon/package.json": JSON.stringify({ name: "@orquester/daemon" }),
  [ENTRY]: [
    'import { join } from "node:path";',
    'import { helper } from "./support/helper.ts";',
    'import type { Thread } from "@orquester/api/agent-chat";',
    'import { z } from "zod";',
    'export { boxes } from "../boxes/relay.ts";',
    "export const main = helper;"
  ].join("\n"),
  "apps/daemon/src/agent-host/support/helper.ts": 'import "../side-effect.ts";\nexport const helper = 1;\n',
  "apps/daemon/src/agent-host/side-effect.ts": "export {};\n",
  "apps/daemon/src/boxes/relay.ts": 'export const boxes = await import("./lazy.ts");\n',
  "apps/daemon/src/boxes/lazy.ts": "export const lazy = 1;\n",
  // Not reached: the daemon's own code, a UI package, a test beside the host.
  "apps/daemon/src/index.ts": 'import "./agent-host/main.ts";\n',
  "apps/daemon/src/agent-host/main.test.ts": 'import "./main.ts";\n',
  "packages/api/package.json": JSON.stringify({
    name: "@orquester/api",
    exports: { ".": "./src/index.ts", "./agent-chat": "./src/agent-chat/index.ts" }
  }),
  "packages/api/src/agent-chat/index.ts": 'export * from "./thread.ts";\n',
  "packages/api/src/agent-chat/thread.ts": "export interface Thread { id: string }\n",
  "packages/api/src/index.ts": "export const unrelated = 1;\n",
  "packages/ui/package.json": JSON.stringify({ name: "@orquester/ui", exports: { ".": "./src/index.ts" } }),
  "packages/ui/src/index.ts": "export const ui = 1;\n"
};

async function withCheckout(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "code-stamp-"));
  try {
    for (const [path, content] of Object.entries(CHECKOUT)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Rewrite a file and move its mtime, so the per-process cache cannot hide the change. */
async function rewrite(root: string, path: string, content: string): Promise<void> {
  await writeFile(join(root, path), content);
  const later = new Date(Date.now() + 60_000);
  await utimes(join(root, path), later, later);
}

const stampOf = (root: string, nodeMajor = 24): string | null =>
  computeCodeStamp({ entry: join(root, ENTRY), nodeMajor });

describe("computeCodeStamp", () => {
  it("is deterministic: the same code gives the same stamp, run after run and checkout after checkout", async () => {
    await withCheckout(async (first) => {
      await withCheckout(async (second) => {
        const stamp = stampOf(first);
        assert.ok(stamp !== null && stamp.length > 0);
        assert.equal(stampOf(first), stamp);
        assert.equal(stampOf(second), stamp, "only paths relative to the checkout count");
      });
    });
  });

  it("does not move for a change outside the host's import graph", async () => {
    await withCheckout(async (root) => {
      const before = stampOf(root);
      await rewrite(root, "apps/daemon/src/index.ts", 'import "./agent-host/main.ts";\nexport const daemonOnly = 2;\n');
      await rewrite(root, "apps/daemon/src/agent-host/main.test.ts", "// a test edit\n");
      await rewrite(root, "packages/ui/src/index.ts", "export const ui = 2;\n");
      await rewrite(root, "packages/api/src/index.ts", "export const unrelated = 2;\n");
      await writeFile(join(root, "README.md"), "docs\n");
      assert.equal(stampOf(root), before);
    });
  });

  for (const [what, path] of [
    ["the entry", ENTRY],
    ["a relative import", "apps/daemon/src/agent-host/support/helper.ts"],
    ["a side-effect import", "apps/daemon/src/agent-host/side-effect.ts"],
    ["a module outside agent-host/ it imports", "apps/daemon/src/boxes/relay.ts"],
    ["a literal dynamic import outside agent-host/", "apps/daemon/src/boxes/lazy.ts"],
    ["a workspace package reached through its exports", "packages/api/src/agent-chat/thread.ts"]
  ] as const) {
    it(`moves when ${what} changes`, async () => {
      await withCheckout(async (root) => {
        const before = stampOf(root);
        await rewrite(root, path, `${CHECKOUT[path]}\n// changed\n`);
        const after = stampOf(root);
        assert.notEqual(after, null);
        assert.notEqual(after, before);
      });
    });
  }

  it("moves when the lockfile changes (third-party versions) and with the Node major", async () => {
    await withCheckout(async (root) => {
      const before = stampOf(root);
      assert.notEqual(stampOf(root, 22), before);
      await rewrite(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n# zod bumped\n");
      assert.notEqual(stampOf(root), before);
    });
  });

  it("follows a new import after its graph was cached", async () => {
    await withCheckout(async (root) => {
      stampOf(root);
      await rewrite(root, "apps/daemon/src/agent-host/support/helper.ts", 'import "../side-effect.ts";\nimport "@orquester/api";\nexport const helper = 1;\n');
      const imported = stampOf(root);
      await rewrite(root, "packages/api/src/index.ts", "export const unrelated = 2;\n");
      assert.notEqual(stampOf(root), imported);
    });
  });

  it("is null without an entry or a workspace, and never throws", async () => {
    await withCheckout(async (root) => {
      assert.equal(computeCodeStamp({ entry: join(root, "apps", "missing.ts") }), null);
      await rm(join(root, "pnpm-workspace.yaml"));
      assert.equal(stampOf(root), null);
    });
  });

  it("stamps this checkout's agent host", () => {
    const stamp = readCodeStamp();
    assert.ok(stamp !== null && stamp.length > 0);
    assert.equal(readCodeStamp(), stamp);
  });
});
