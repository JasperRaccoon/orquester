/**
 * `DELETE /api/agent-accounts/:id` refuses while a session still runs under
 * the account: that session would re-create the deleted home as an orphan.
 * The Claude sign-in's code route maps the link's verdicts to statuses.
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

async function accountsRoute(live: Set<string>, removed: string[], extra: Record<string, unknown> = {}) {
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
      },
      ...extra
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

test("the Claude sign-in code route answers the account, or the link's refusal as a status", async () => {
  const submitted: string[] = [];
  const verdicts = [
    { ok: true, account: { id: "acc-new", agent: "claude" } },
    { ok: false, code: "invalid", error: "That code was not accepted" },
    { ok: false, code: "idle", error: "No Claude sign-in is in progress" },
    { ok: false, code: "upstream", error: "Claude token exchange failed" }
  ];
  const { app, cleanup } = await accountsRoute(new Set(), [], {
    claudeOAuthLink: {
      submit: async (code: string) => {
        submitted.push(code);
        return verdicts.shift();
      }
    }
  });
  try {
    const post = (payload: unknown) =>
      app.inject({ method: "POST", url: "/api/agent-accounts/claude/link/code", payload: payload as object });
    const empty = await post({ code: "  " });
    assert.equal(empty.statusCode, 400);
    assert.deepEqual(submitted, [], "an empty paste never reaches the link");

    const ok = await post({ code: "abc#state" });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().id, "acc-new");
    assert.equal((await post({ code: "abc#state" })).statusCode, 400);
    assert.equal((await post({ code: "abc#state" })).statusCode, 409);
    const upstream = await post({ code: "abc#state" });
    assert.equal(upstream.statusCode, 502);
    assert.match(upstream.json().error, /token exchange failed/);
  } finally {
    await app.close();
    await cleanup();
  }
});
