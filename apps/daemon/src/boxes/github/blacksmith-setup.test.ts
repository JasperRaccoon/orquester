import assert from "node:assert/strict";
import test from "node:test";

import { BLACKSMITH_CREDENTIAL_KEYS } from "../providers/blacksmith.ts";
import { createBlacksmithSetupDriver } from "./blacksmith-setup.ts";
import { BLACKSMITH_APP_INSTALL_URL } from "./control-repo.ts";
import { FakeGithub, type FakeGithubOptions } from "./fake-github.ts";
import { BLACKSMITH_WORKFLOW_FILE, BLACKSMITH_WORKFLOW_PATH, blacksmithWorkflowTemplate } from "./workflow-template.ts";

const TOKEN = "ghp_TESTTOKEN0123456789";
const signal = new AbortController().signal;
const DAEMON_URL = "https://orq.example.com/base";

function setup(options: Partial<FakeGithubOptions> = {}) {
  const github = new FakeGithub({ token: TOKEN, ...options });
  return { github, driver: createBlacksmithSetupDriver({ fetch: github.fetch }) };
}

/** Run a promise whose waits use mocked setTimeout: flush I/O, then advance the clock, until it settles. */
async function drive<T>(t: test.TestContext, promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  while (!settled) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(1000);
  }
  return promise;
}

test("checkAccount needs a classic token with repo and workflow, and points at the tokens page", async () => {
  assert.deepEqual(await setup().driver.checkAccount(TOKEN, signal), { ok: true, message: "Signed in as octo." });

  const noWorkflow = await setup({ scopes: "repo, read:org" }).driver.checkAccount(TOKEN, signal);
  assert.equal(noWorkflow.ok, false);
  assert.match(noWorkflow.ok ? "" : noWorkflow.message, /Add the workflow scope/);
  assert.equal(noWorkflow.ok ? null : noWorkflow.actionUrl, "https://github.com/settings/tokens");

  const fineGrained = await setup({ scopes: null }).driver.checkAccount(TOKEN, signal);
  assert.deepEqual(fineGrained, {
    ok: false,
    message: "Use a classic personal access token with the repo and workflow scopes.",
    actionUrl: "https://github.com/settings/tokens"
  });

  const rejected = await setup({ token: "another-token" }).driver.checkAccount(TOKEN, signal);
  assert.equal(rejected.ok, false);
  assert.match(rejected.ok ? "" : rejected.message, /rejected this account's token/);
  assert.ok(!JSON.stringify(rejected).includes(TOKEN));

  const { github, driver } = setup();
  await driver.checkAccount(TOKEN, signal);
  assert.deepEqual(github.calls.map((entry) => entry.path), ["/user"], "the account check makes one org-less call");
});

test("checkOrg sends each membership problem to the page that fixes it", async () => {
  assert.deepEqual(await setup().driver.checkOrg(TOKEN, "Org", signal), { ok: true, message: "octo is an owner of Org." });
  assert.deepEqual(await setup({ role: "member", membersCanCreatePrivateRepos: true }).driver.checkOrg(TOKEN, "Org", signal), {
    ok: true,
    message: "octo is a member of Org."
  });

  const outsider = await setup({ role: null }).driver.checkOrg(TOKEN, "Org", signal);
  assert.deepEqual(outsider, { ok: false, message: "octo is not a member of Org.", actionUrl: "https://github.com/orgs/Org/people" });

  const invited = await setup({ membershipState: "pending" }).driver.checkOrg(TOKEN, "Org", signal);
  assert.deepEqual(invited, { ok: false, message: "Accept the invitation to Org on GitHub first.", actionUrl: "https://github.com/orgs/Org/invitation" });

  const restricted = await setup({ role: "member", membersCanCreatePrivateRepos: false }).driver.checkOrg(TOKEN, "Org", signal);
  assert.equal(restricted.ok, false);
  assert.match(restricted.ok ? "" : restricted.message, /cannot create private repositories in Org/);
  assert.equal(restricted.ok ? null : restricted.actionUrl, "https://github.com/organizations/Org/settings/member_privileges");

  const unknown = await setup({ role: "member", membersCanCreatePrivateRepos: undefined }).driver.checkOrg(TOKEN, "Org", signal);
  assert.equal(unknown.ok, true);
  assert.match(unknown.message ?? "", /does not say whether members may create private repositories/);

  const scopes = await setup({ scopes: "repo" }).driver.checkOrg(TOKEN, "Org", signal);
  assert.equal(scopes.ok ? null : scopes.actionUrl, "https://github.com/settings/tokens");
});

test("checkApp: installed, missing, suspended, selected repositories, or not visible to this token", async () => {
  assert.deepEqual(await setup().driver.checkApp(TOKEN, "Org", signal), { ok: true, message: "The Blacksmith GitHub App is installed on Org." });

  const missing = await setup({ installations: [{ app_slug: "vercel", repository_selection: "all" }] }).driver.checkApp(TOKEN, "Org", signal);
  assert.deepEqual(missing, {
    ok: false,
    message: "Install the Blacksmith GitHub App on Org (an org owner must approve it), then run the checks again.",
    actionUrl: BLACKSMITH_APP_INSTALL_URL
  });

  const suspended = await setup({ installations: [{ app_slug: "blacksmith-sh", repository_selection: "all", suspended_at: "2026-10-01T00:00:00Z" }] }).driver.checkApp(
    TOKEN,
    "Org",
    signal
  );
  assert.equal(suspended.ok, false);
  assert.match(suspended.ok ? "" : suspended.message, /suspended on Org/);
  assert.equal(suspended.ok ? null : suspended.actionUrl, "https://github.com/organizations/Org/settings/installations");

  const selected = await setup({ installations: [{ app_slug: "blacksmith-sh", repository_selection: "selected" }] }).driver.checkApp(TOKEN, "Org", signal);
  assert.equal(selected.ok, true);
  assert.match(selected.message ?? "", /include Org\/orquester-macos-boxes/);

  const hidden = await setup({ installations: "forbidden" }).driver.checkApp(TOKEN, "Org", signal);
  assert.equal(hidden.ok, true, "a member's token cannot list installations; the test run tells");
  assert.match(hidden.message ?? "", /Could not verify the Blacksmith GitHub App on Org/);
  assert.ok((hidden.message ?? "").includes(BLACKSMITH_APP_INSTALL_URL));
});

test("ensureControlRepo creates the private repo, commits the workflow, waits until GitHub lists it, and is idempotent", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const { github, driver } = setup();
  github.workflowGet404s = 2;
  const result = await drive(t, driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: DAEMON_URL, signal }));
  assert.deepEqual(result, { repo: "Org/orquester-macos-boxes", workflowFile: BLACKSMITH_WORKFLOW_FILE });
  const repo = github.repos.get("Org/orquester-macos-boxes")!;
  assert.equal(repo.private, true);
  assert.equal(repo.files.get(BLACKSMITH_WORKFLOW_PATH)!.content, blacksmithWorkflowTemplate());
  assert.equal(github.calls.filter((entry) => entry.path.endsWith(`/actions/workflows/${BLACKSMITH_WORKFLOW_FILE}`)).length, 3);

  const writes = github.calls.filter((entry) => entry.method === "PUT" || entry.method === "POST").length;
  assert.deepEqual(await driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: DAEMON_URL, signal }), result);
  assert.equal(github.calls.filter((entry) => entry.method === "PUT" || entry.method === "POST").length, writes, "a second run writes nothing");
});

test("ensureControlRepo refuses a daemon URL the workflow cannot use, before touching GitHub", async () => {
  const { github, driver } = setup();
  await assert.rejects(driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: "http://orq.example.com", signal }), /over https/);
  await assert.rejects(driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: "not a url", signal }));
  assert.equal(github.calls.length, 0);
});

test("every call honours the caller's signal and the injected API URL", async () => {
  const github = new FakeGithub({ token: TOKEN });
  const seen: string[] = [];
  const fetchVia = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const url = new URL(String(input));
    seen.push(url.origin);
    return github.fetch(`https://api.github.com${url.pathname.replace(/^\/api\/v3/, "")}${url.search}`, init);
  }) as typeof fetch;
  const driver = createBlacksmithSetupDriver({ fetch: fetchVia, apiUrl: "https://ghe.example.com/api/v3" });

  assert.equal((await driver.checkAccount(TOKEN, signal)).ok, true);
  assert.deepEqual([...new Set(seen)], ["https://ghe.example.com"]);

  const aborted = new AbortController();
  aborted.abort(new Error("stopped"));
  await assert.rejects(driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: DAEMON_URL, signal: aborted.signal }), /stopped/);
  await assert.rejects(driver.checkOrg(TOKEN, "Org", aborted.signal), /stopped/);
  await assert.rejects(driver.checkApp(TOKEN, "Org", aborted.signal), /stopped/);
  assert.equal(github.repos.size, 0);
});

test("adapterCredentials are exactly the Blacksmith adapter's keys", () => {
  const { driver } = setup();
  const credentials = driver.adapterCredentials({ token: TOKEN, org: "Org", repo: "Org/orquester-macos-boxes", workflowFile: BLACKSMITH_WORKFLOW_FILE });
  assert.deepEqual(credentials, {
    [BLACKSMITH_CREDENTIAL_KEYS.githubToken]: TOKEN,
    [BLACKSMITH_CREDENTIAL_KEYS.org]: "Org",
    [BLACKSMITH_CREDENTIAL_KEYS.repo]: "Org/orquester-macos-boxes"
  });
  assert.deepEqual(Object.keys(credentials).sort(), Object.values(BLACKSMITH_CREDENTIAL_KEYS).sort());
});
