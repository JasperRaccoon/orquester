import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";

import { BLACKSMITH_ADAPTER } from "../providers/blacksmith.ts";
import { createBlacksmithSetupDriver } from "./blacksmith-setup.ts";
import { BLACKSMITH_APP_INSTALL_URL } from "./control-repo.ts";
import { FakeGithub, type FakeGithubOptions } from "./fake-github.ts";
import {
  BLACKSMITH_DEVICE_CACHE_WORKFLOW_PATH,
  BLACKSMITH_WORKFLOW_FILE,
  BLACKSMITH_WORKFLOW_PATH
} from "./workflow-template.ts";

const TOKEN = "ghp_TESTTOKEN0123456789";
const signal = new AbortController().signal;
const DAEMON_URL = "https://orq.example.com/base";

const fetchMocks = new WeakMap<test.TestContext, test.Mock<typeof fetch>>();

function setup(t: test.TestContext, options: Partial<FakeGithubOptions> = {}) {
  const github = new FakeGithub({ token: TOKEN, ...options });
  const mocked = fetchMocks.get(t);
  if (mocked) mocked.mock.mockImplementation(github.fetch);
  else fetchMocks.set(t, t.mock.method(globalThis, "fetch", github.fetch));
  return { github, driver: createBlacksmithSetupDriver() };
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

test("checkAccount needs a classic token with repo and workflow, and points at the tokens page", async (t) => {
  assert.deepEqual(await setup(t).driver.checkAccount(TOKEN, signal), { ok: true, message: "Signed in as octo." });

  const noWorkflow = await setup(t, { scopes: "repo, read:org" }).driver.checkAccount(TOKEN, signal);
  assert.equal(noWorkflow.ok, false);
  assert.match(noWorkflow.ok ? "" : noWorkflow.message, /Add the workflow scope/);
  assert.equal(noWorkflow.ok ? null : noWorkflow.actionUrl, "https://github.com/settings/tokens");

  const fineGrained = await setup(t, { scopes: null }).driver.checkAccount(TOKEN, signal);
  assert.deepEqual(fineGrained, {
    ok: false,
    message: "Use a classic personal access token with the repo and workflow scopes.",
    actionUrl: "https://github.com/settings/tokens"
  });

  const rejected = await setup(t, { token: "another-token" }).driver.checkAccount(TOKEN, signal);
  assert.equal(rejected.ok, false);
  assert.match(rejected.ok ? "" : rejected.message, /rejected this account's token/);
  assert.ok(!JSON.stringify(rejected).includes(TOKEN));

  const { github, driver } = setup(t);
  await driver.checkAccount(TOKEN, signal);
  assert.deepEqual(github.calls.map((entry) => entry.path), ["/user"], "the account check makes one org-less call");
});

test("checkOrg sends each membership problem to the page that fixes it", async (t) => {
  assert.deepEqual(await setup(t).driver.checkOrg(TOKEN, "Org", signal), { ok: true, message: "octo is an owner of Org." });
  assert.deepEqual(await setup(t, { role: "member", membersCanCreatePrivateRepos: true }).driver.checkOrg(TOKEN, "Org", signal), {
    ok: true,
    message: "octo is a member of Org."
  });

  const outsider = await setup(t, { role: null }).driver.checkOrg(TOKEN, "Org", signal);
  assert.deepEqual(outsider, { ok: false, message: "octo is not a member of Org.", actionUrl: "https://github.com/orgs/Org/people" });

  const invited = await setup(t, { membershipState: "pending" }).driver.checkOrg(TOKEN, "Org", signal);
  assert.deepEqual(invited, { ok: false, message: "Accept the invitation to Org on GitHub first.", actionUrl: "https://github.com/orgs/Org/invitation" });

  const restricted = await setup(t, { role: "member", membersCanCreatePrivateRepos: false }).driver.checkOrg(TOKEN, "Org", signal);
  assert.equal(restricted.ok, false);
  assert.match(restricted.ok ? "" : restricted.message, /cannot create private repositories in Org/);
  assert.equal(restricted.ok ? null : restricted.actionUrl, "https://github.com/organizations/Org/settings/member_privileges");

  const unknown = await setup(t, { role: "member", membersCanCreatePrivateRepos: undefined }).driver.checkOrg(TOKEN, "Org", signal);
  assert.equal(unknown.ok, true);
  assert.match(unknown.message ?? "", /does not say whether members may create private repositories/);

  const scopes = await setup(t, { scopes: "repo" }).driver.checkOrg(TOKEN, "Org", signal);
  assert.equal(scopes.ok ? null : scopes.actionUrl, "https://github.com/settings/tokens");
});

test("checkApp: installed, missing, suspended, selected repositories, or not visible to this token", async (t) => {
  assert.deepEqual(await setup(t).driver.checkApp(TOKEN, "Org", signal), { ok: true, message: "The Blacksmith GitHub App is installed on Org." });

  const missing = await setup(t, { installations: [{ app_slug: "vercel", repository_selection: "all" }] }).driver.checkApp(TOKEN, "Org", signal);
  assert.deepEqual(missing, {
    ok: false,
    message: "Install the Blacksmith GitHub App on Org (an org owner must approve it), then run the checks again.",
    actionUrl: BLACKSMITH_APP_INSTALL_URL
  });

  const suspended = await setup(t, { installations: [{ app_slug: "blacksmith-sh", repository_selection: "all", suspended_at: "2026-10-01T00:00:00Z" }] }).driver.checkApp(
    TOKEN,
    "Org",
    signal
  );
  assert.equal(suspended.ok, false);
  assert.match(suspended.ok ? "" : suspended.message, /suspended on Org/);
  assert.equal(suspended.ok ? null : suspended.actionUrl, "https://github.com/organizations/Org/settings/installations");

  const selected = await setup(t, { installations: [{ app_slug: "blacksmith-sh", repository_selection: "selected" }] }).driver.checkApp(TOKEN, "Org", signal);
  assert.equal(selected.ok, true);
  assert.match(selected.message ?? "", /include Org\/orquester-macos-boxes/);

  const hidden = await setup(t, { installations: "forbidden" }).driver.checkApp(TOKEN, "Org", signal);
  assert.equal(hidden.ok, true, "a member's token cannot list installations; the test run tells");
  assert.match(hidden.message ?? "", /Could not verify the Blacksmith GitHub App on Org/);
  assert.ok((hidden.message ?? "").includes(BLACKSMITH_APP_INSTALL_URL));
});

test("ensureControlRepo creates the private repo, commits the workflow, waits until GitHub lists it, and is idempotent", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const { github, driver } = setup(t);
  github.workflowGet404s = 2;
  const result = await drive(t, driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: DAEMON_URL, signal }));
  assert.deepEqual(result, { repo: "Org/orquester-macos-boxes", workflowFile: BLACKSMITH_WORKFLOW_FILE });
  const repo = github.repos.get("Org/orquester-macos-boxes")!;
  assert.equal(repo.private, true);
  const boxWorkflow = parse(repo.files.get(BLACKSMITH_WORKFLOW_PATH)!.content);
  assert.deepEqual(boxWorkflow.on.workflow_dispatch.inputs.os.options, ["macos", "linux"]);
  assert.deepEqual(boxWorkflow.on.workflow_dispatch.inputs.prepare.options, ["none", "devices"]);
  assert.ok(parse(repo.files.get(BLACKSMITH_DEVICE_CACHE_WORKFLOW_PATH)!.content).on.workflow_dispatch.inputs.request_id);

  const writes = github.calls.filter((entry) => entry.method === "PUT" || entry.method === "POST").length;
  assert.deepEqual(await driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: DAEMON_URL, signal }), result);
  assert.equal(github.calls.filter((entry) => entry.method === "PUT" || entry.method === "POST").length, writes, "a second run writes nothing");
  const credentials = driver.adapterCredentials({ token: TOKEN, org: "Org", ...result });
  assert.deepEqual(await BLACKSMITH_ADAPTER.validate(credentials, { signal }), { ok: true });
});

test("ensureControlRepo over the tailnet commits the workflow that joins it with the federated identity", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const { github, driver } = setup(t);
  const tailscale = { oauthClientId: "kJ2x7CNTRL", audience: "api.tailscale.com/kJ2x7CNTRL" };
  await drive(t, driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: DAEMON_URL, tailscale, signal }));
  const content = github.repos.get("Org/orquester-macos-boxes")!.files.get(BLACKSMITH_WORKFLOW_PATH)!.content;
  assert.match(content, /uses: tailscale\/github-action@v4/);
  assert.match(content, /oauth-client-id: "kJ2x7CNTRL"/);

  // The adapter re-commits from the same template at create: the join travels in its credentials.
  const credentials = driver.adapterCredentials({ token: TOKEN, org: "Org", repo: "Org/orquester-macos-boxes", workflowFile: BLACKSMITH_WORKFLOW_FILE, tailscale });
  assert.deepEqual(credentials, {
    githubToken: TOKEN,
    org: "Org",
    repo: "Org/orquester-macos-boxes",
    tailscaleClientId: "kJ2x7CNTRL",
    tailscaleAudience: "api.tailscale.com/kJ2x7CNTRL"
  });
  const run = await drive(t, driver.dispatchDeviceCacheWarm(credentials, { os: "linux" }, signal));
  assert.equal(github.runs.get(Number(run.runId))!.workflowFile, "orquester-device-cache.yml");
  assert.match(github.repos.get("Org/orquester-macos-boxes")!.files.get(BLACKSMITH_WORKFLOW_PATH)!.content, /oauth-client-id: "kJ2x7CNTRL"/);
  assert.equal((await driver.deviceCacheWarmStatus(credentials, run.runId, signal)).state, "queued");
});

test("ensureControlRepo refuses a daemon URL the workflow cannot use, before touching GitHub", async (t) => {
  const { github, driver } = setup(t);
  await assert.rejects(driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: "http://orq.example.com", signal }), /over https/);
  await assert.rejects(driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: "not a url", signal }));
  assert.equal(github.calls.length, 0);
});

test("every call honours the caller's signal and the injected API URL", async (t) => {
  const github = new FakeGithub({ token: TOKEN });
  const seen: string[] = [];
  const fetchVia = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const url = new URL(String(input));
    seen.push(url.origin);
    return github.fetch(`https://api.github.com${url.pathname.replace(/^\/api\/v3/, "")}${url.search}`, init);
  }) as typeof fetch;
  t.mock.method(globalThis, "fetch", fetchVia);
  const driver = createBlacksmithSetupDriver({ apiUrl: "https://ghe.example.com/api/v3" });

  assert.equal((await driver.checkAccount(TOKEN, signal)).ok, true);
  assert.deepEqual([...new Set(seen)], ["https://ghe.example.com"]);

  const aborted = new AbortController();
  aborted.abort(new Error("stopped"));
  await assert.rejects(driver.ensureControlRepo(TOKEN, "Org", { daemonUrl: DAEMON_URL, signal: aborted.signal }), /stopped/);
  await assert.rejects(driver.checkOrg(TOKEN, "Org", aborted.signal), /stopped/);
  await assert.rejects(driver.checkApp(TOKEN, "Org", aborted.signal), /stopped/);
  assert.equal(github.repos.size, 0);
});
