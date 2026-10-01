/**
 * `DELETE /api/agent-accounts/:id` refuses while a session still runs under
 * the account: that session would re-create the deleted home as an orphan.
 */

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";

import { createServer as createDaemonApp } from "./index.ts";

type Args = Parameters<typeof createDaemonApp>;

async function accountsRoute(live: Set<string>, removed: string[]) {
  const appdir = await mkdtemp(join(tmpdir(), "orq-accounts-route-"));
  const workspacesDir = join(appdir, "ws");
  const app = createDaemonApp(
    createDefaultDaemonConfig({ env: {} }),
    {
      daemonDir: join(appdir, "daemon"),
      workspacesDir,
      workspacesMetaFile: join(appdir, "daemon", "workspaces.json"),
      fsRoot: workspacesDir
    } as unknown as Args[1],
    createDefaultClientConfig(join(appdir, "daemon.sock")),
    createWriteStream("/dev/null"),
    {
      sessions: {
        liveAccountIds: () => live,
        list: () => [
          { id: "s1", title: "Fix the build", accountId: "acc-busy" },
          { id: "s2", title: "Other", accountId: "acc-other" }
        ]
      },
      agentAccounts: {
        removeAccount: async (id: string) => {
          removed.push(id);
        }
      }
    } as unknown as Args[4],
    { authRequired: false, mode: "local" }
  );
  return { app, cleanup: () => rm(appdir, { recursive: true, force: true }) };
}

test("an account a live session runs under is not deleted, and the tab is named", async () => {
  const removed: string[] = [];
  const { app, cleanup } = await accountsRoute(new Set(["acc-busy"]), removed);
  try {
    const refused = await app.inject({ method: "DELETE", url: "/api/agent-accounts/acc-busy" });
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /"Fix the build"/);
    assert.deepEqual(removed, []);

    const ok = await app.inject({ method: "DELETE", url: "/api/agent-accounts/acc-idle" });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(removed, ["acc-idle"]);
  } finally {
    await app.close();
    await cleanup();
  }
});
