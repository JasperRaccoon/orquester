import assert from "node:assert/strict";
import test from "node:test";

import type { AccountSummary, BlacksmithSetupResponse, BlacksmithSetupStep, BoxConnectionSettings } from "@orquester/api";

import { box, provider } from "../../../lib/boxes/fixtures.test-helpers.ts";
import {
  credentialFieldMultiline,
  credentialProblems,
  credentialsPayload,
  keyProviders,
  providerStatusView,
  windowsImageView
} from "./providers.logic.ts";
import {
  connectionDraft,
  connectionProblems,
  connectionRequest,
  httpsUrlProblem,
  tailscaleLocalView,
  tailscaleSetupFailure
} from "./connection.logic.ts";
import { ApiError } from "../../../lib/api-client.ts";
import {
  blacksmithAccounts,
  blacksmithBusy,
  blacksmithCanPickOrg,
  blacksmithCanRetry,
  blacksmithCanTest,
  blacksmithOrgs,
  blacksmithStatus
} from "./blacksmith.logic.ts";
import {
  boxCostLine,
  boxCountdown,
  boxOwner,
  boxStateView,
  boxTitle,
  canDestroyBox,
  listedBoxes,
  setupProgress
} from "./boxes-list.logic.ts";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const OVH_FIELDS = [
  { id: "applicationKey", label: "Application key", secret: false },
  { id: "applicationSecret", label: "Application secret", secret: true },
  { id: "consumerKey", label: "Consumer key", secret: true },
  { id: "project", label: "Project ID", secret: false, optional: true }
];

test("Blacksmith has its own setup row rather than an API key form", () => {
  const list = [provider(), provider({ id: "blacksmith", label: "Blacksmith" }), provider({ id: "vultr", label: "Vultr" })];
  assert.deepEqual(keyProviders(list).map((entry) => entry.id), ["hetzner", "vultr"]);
  assert.deepEqual(keyProviders(null), []);
});

test("status: a pill when configured, the Add API key button when not", () => {
  assert.deepEqual(providerStatusView(provider()), { kind: "pill", tone: "ok", label: "Connected", title: null });
  assert.deepEqual(providerStatusView(provider({ status: "error", error: "401 Unauthorized" })), {
    kind: "pill",
    tone: "danger",
    label: "Error",
    title: "401 Unauthorized"
  });
  assert.deepEqual(providerStatusView(provider({ status: "checking" })).kind, "pill");
  assert.deepEqual(providerStatusView(provider({ status: "not-configured" })), { kind: "add" });
});

test("the form needs every required field, one line each, and sends only what is filled", () => {
  assert.deepEqual(credentialProblems(OVH_FIELDS, {}), {
    applicationKey: "Enter the Application key.",
    applicationSecret: "Enter the Application secret.",
    consumerKey: "Enter the Consumer key."
  });
  assert.equal(credentialsPayload(OVH_FIELDS, {}), null);
  const values = { applicationKey: "  ak ", applicationSecret: "as", consumerKey: "ck", project: "  ", stray: "x" };
  assert.deepEqual(credentialProblems(OVH_FIELDS, values), {});
  assert.deepEqual(credentialsPayload(OVH_FIELDS, values), { applicationKey: "ak", applicationSecret: "as", consumerKey: "ck" });
  assert.deepEqual(credentialProblems(OVH_FIELDS, { ...values, consumerKey: "ck\nextra" }), {
    consumerKey: "The Consumer key must be on one line."
  });
  assert.equal(credentialsPayload([], {}), null);
});

test("a PEM key field takes several lines", () => {
  const pem = { id: "privateKey", label: "API signing key", secret: true };
  assert.equal(credentialFieldMultiline(pem), true);
  assert.equal(credentialFieldMultiline({ id: "token", label: "Token", secret: true }), false);
  assert.equal(credentialFieldMultiline({ id: "k", label: "Key", secret: true, placeholder: "-----BEGIN PRIVATE KEY-----" }), true);
  const value = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n";
  assert.deepEqual(credentialsPayload([pem], { privateKey: value }), { privateKey: value.trim() });
});

test("the Windows image row offers Prepare only while connected without an image", () => {
  assert.equal(windowsImageView(provider()), null);
  const none = provider({ id: "vultr", windowsImage: { state: "none", message: null, updatedAt: null } });
  assert.deepEqual(windowsImageView(none), { tone: "neutral", label: "Not prepared", message: null, canPrepare: true });
  assert.equal(windowsImageView({ ...none, status: "not-configured" })?.canPrepare, false);
  const preparing = provider({ windowsImage: { state: "preparing", message: "Installing updates", updatedAt: null } });
  assert.deepEqual(windowsImageView(preparing), { tone: "info", label: "Preparing…", message: "Installing updates", canPrepare: false });
  assert.equal(windowsImageView(provider({ windowsImage: { state: "failed", message: "x", updatedAt: null } }))?.canPrepare, true);
  assert.equal(windowsImageView(provider({ windowsImage: { state: "ready", message: null, updatedAt: null } }))?.label, "Ready");
});

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const SETTINGS: BoxConnectionSettings = {
  mode: "public-url",
  publicUrl: "https://orquester.example.com",
  tailscale: { configured: false, keyHint: null, tailnet: null, daemonUrl: null, policySnippet: "{}" },
  reachable: "unknown",
  reachableMessage: null,
  checkedAt: null
};

test("URLs boxes dial must be plain https origins", () => {
  assert.equal(httpsUrlProblem("https://orquester.example.com", "public URL"), null);
  assert.equal(httpsUrlProblem("https://my-pc.tail1234.ts.net:8443/", "x"), null);
  assert.equal(httpsUrlProblem("", "public URL"), "Enter the public URL.");
  assert.equal(httpsUrlProblem("orquester.example.com", "public URL"), "The public URL is not a URL.");
  assert.equal(httpsUrlProblem("http://orquester.example.com", "public URL"), "The public URL must start with https://.");
  assert.match(httpsUrlProblem("https://u:p@o.example.com", "public URL")!, /user name/);
  assert.match(httpsUrlProblem("https://o.example.com/?a=1", "public URL")!, /query/);
});

test("the draft starts from the settings and an unchanged draft saves nothing", () => {
  const draft = connectionDraft(SETTINGS);
  assert.equal(draft.publicUrl, "https://orquester.example.com");
  assert.equal(connectionRequest(draft, SETTINGS), null);
  assert.deepEqual(connectionRequest({ ...draft, publicUrl: " https://new.example.com " }, SETTINGS), {
    publicUrl: "https://new.example.com"
  });
  assert.equal(connectionRequest({ ...draft, publicUrl: "nope" }, SETTINGS), null);
  assert.equal(connectionDraft(null).mode, "public-url");
});

test("Tailscale needs credentials unless they are stored, and an address", () => {
  const draft = { ...connectionDraft(SETTINGS), mode: "tailscale" as const };
  assert.deepEqual(connectionProblems(draft, SETTINGS), {
    daemonUrl: "Enter the tailnet address.",
    apiToken: "Enter a Tailscale API access token."
  });
  const token = { ...draft, daemonUrl: "https://pc.tail1234.ts.net", apiToken: " tskey-api-abc " };
  assert.deepEqual(connectionRequest(token, SETTINGS), {
    mode: "tailscale",
    tailscaleDaemonUrl: "https://pc.tail1234.ts.net",
    tailscaleApiToken: "tskey-api-abc"
  });
  const oauth = { ...draft, daemonUrl: "https://pc.tail1234.ts.net", credentialKind: "oauth" as const, oauthClientId: "id" };
  assert.deepEqual(connectionProblems(oauth, SETTINGS), { oauthClientSecret: "Enter the OAuth client secret." });
  assert.deepEqual(connectionRequest({ ...oauth, oauthClientSecret: "s" }, SETTINGS), {
    mode: "tailscale",
    tailscaleDaemonUrl: "https://pc.tail1234.ts.net",
    tailscaleOAuthClientId: "id",
    tailscaleOAuthClientSecret: "s"
  });

  // Stored credentials: leaving the secrets empty keeps them.
  const stored: BoxConnectionSettings = {
    ...SETTINGS,
    mode: "tailscale",
    tailscale: { ...SETTINGS.tailscale, configured: true, daemonUrl: "https://pc.tail1234.ts.net" }
  };
  const kept = connectionDraft(stored);
  assert.deepEqual(connectionProblems(kept, stored), {});
  assert.equal(connectionRequest(kept, stored), null);
  assert.deepEqual(connectionProblems({ ...kept, credentialKind: "oauth" }, stored), {});
  assert.deepEqual(connectionProblems({ ...kept, apiToken: "has space" }, stored), { apiToken: "The token must not contain spaces." });
});

test("Tailscale mode also saves the public URL (macOS boxes) and the federated identity", () => {
  const stored = { ...SETTINGS, mode: "tailscale" as const, tailscale: { ...SETTINGS.tailscale, configured: true, daemonUrl: "https://pc.tail1234.ts.net" } };
  const draft = connectionDraft(stored);
  assert.equal(draft.publicUrl, "https://orquester.example.com");
  assert.equal(connectionRequest(draft, stored), null);
  assert.deepEqual(connectionRequest({ ...draft, publicUrl: "https://mac.example.com" }, stored), { publicUrl: "https://mac.example.com" });
  assert.deepEqual(connectionRequest({ ...draft, publicUrl: "" }, stored), { publicUrl: null }, "optional here: emptying clears it");
  assert.deepEqual(connectionProblems({ ...draft, publicUrl: "http://plain.example.com" }, stored), { publicUrl: "The public URL must start with https://." });
  assert.deepEqual(connectionRequest({ ...draft, workloadClientId: " id1 ", workloadAudience: "api.tailscale.com/id1" }, stored), {
    tailscaleWorkloadClientId: "id1",
    tailscaleWorkloadAudience: "api.tailscale.com/id1"
  });
  assert.deepEqual(connectionProblems({ ...draft, workloadClientId: "id1" }, stored), { workloadAudience: "Enter the audience too." });
  assert.deepEqual(connectionProblems({ ...draft, workloadAudience: "aud" }, stored), { workloadClientId: "Enter the client ID too." });
  assert.deepEqual(connectionProblems({ ...draft, workloadClientId: "bad id", workloadAudience: "aud" }, stored), { workloadClientId: "Letters, digits and . _ : / - only." });
  const withIdentity = { ...stored, tailscale: { ...stored.tailscale, workloadIdentity: { clientId: "id1", audience: "aud" } } };
  const kept = connectionDraft(withIdentity);
  assert.deepEqual([kept.workloadClientId, kept.workloadAudience], ["id1", "aud"]);
  assert.deepEqual(connectionRequest({ ...kept, workloadClientId: "", workloadAudience: "" }, withIdentity), {
    tailscaleWorkloadClientId: null,
    tailscaleWorkloadAudience: null
  });
});

const LOCAL: NonNullable<BoxConnectionSettings["tailscale"]["local"]> = {
  installed: true,
  running: true,
  dnsName: "my-pc.tail1234.ts.net",
  tailnetIp: "100.64.0.7",
  servePort: 10000,
  serving: false,
  suggestedUrl: "https://my-pc.tail1234.ts.net:10000",
  serveCommand: "tailscale serve --bg --https=10000 http://127.0.0.1:47831"
};
const withLocal = (local: Partial<typeof LOCAL> | undefined): BoxConnectionSettings => ({
  ...SETTINGS,
  mode: "tailscale",
  tailscale: { ...SETTINGS.tailscale, ...(local ? { local: { ...LOCAL, ...local } } : {}) }
});

test("Tailscale on this machine: status line, suggested URL and Set up for me", () => {
  // Older daemons say nothing about it.
  assert.deepEqual(tailscaleLocalView(withLocal(undefined), ""), { status: null, tone: "neutral", suggestion: null, canSetUp: false });
  assert.deepEqual(tailscaleLocalView(withLocal({ installed: false, running: false }), ""), {
    status: "Tailscale isn't installed on this machine.",
    tone: "warn",
    suggestion: null,
    canSetUp: false
  });
  assert.deepEqual(tailscaleLocalView(withLocal({ running: false }), ""), {
    status: "Tailscale isn't running on this machine.",
    tone: "warn",
    suggestion: null,
    canSetUp: false
  });
  assert.deepEqual(tailscaleLocalView(withLocal({}), "https://my-pc.tail1234.ts.net"), {
    status: "Tailscale on this machine: my-pc.tail1234.ts.net · not serving Orquester yet",
    tone: "warn",
    suggestion: "https://my-pc.tail1234.ts.net:10000",
    canSetUp: true
  });
  assert.deepEqual(tailscaleLocalView(withLocal({ serving: true }), "https://my-pc.tail1234.ts.net:10000/"), {
    status: "Tailscale on this machine: my-pc.tail1234.ts.net · serving Orquester on :10000",
    tone: "ok",
    suggestion: null,
    canSetUp: false
  });
  assert.equal(tailscaleLocalView(withLocal({ serving: true }), "").suggestion, "https://my-pc.tail1234.ts.net:10000");
  assert.equal(tailscaleLocalView(withLocal({ dnsName: null, suggestedUrl: null }), "").status, "Tailscale on this machine: 100.64.0.7 · not serving Orquester yet");
});

test("a Set up for me refusal keeps the daemon's message and its commands", () => {
  const refusal = new ApiError(409, "POST", "/api/boxes/connection/tailscale-serve", undefined, {
    code: "BOX_TAILSCALE_NEEDS_PERMISSION",
    message: "Tailscale doesn't let this server's user (orq) change what it serves.",
    commands: ["sudo tailscale set --operator=orq", "sudo tailscale serve --bg --https=10000 http://127.0.0.1:47831", 42]
  });
  assert.deepEqual(tailscaleSetupFailure(refusal), {
    message: "Tailscale doesn't let this server's user (orq) change what it serves.",
    commands: ["sudo tailscale set --operator=orq", "sudo tailscale serve --bg --https=10000 http://127.0.0.1:47831"]
  });
  const other = new ApiError(409, "POST", "/x", undefined, { code: "BOX_CONNECTION_NOT_CONFIGURED", message: "Tailscale isn't running.", commands: ["rm -rf /"] });
  assert.deepEqual(tailscaleSetupFailure(other), { message: "Tailscale isn't running.", commands: [] });
});

// ---------------------------------------------------------------------------
// Blacksmith
// ---------------------------------------------------------------------------

const step = (id: BlacksmithSetupStep["id"], state: BlacksmithSetupStep["state"]): BlacksmithSetupStep => ({
  id,
  label: id,
  state,
  message: null,
  actionUrl: null
});

const setup = (states: BlacksmithSetupStep["state"][], overrides: Partial<BlacksmithSetupResponse> = {}): BlacksmithSetupResponse => ({
  gitAccountId: "a1",
  org: "jasper-org",
  repo: "jasper-org/orquester-macos",
  steps: (["account", "org", "app", "repo", "test"] as const).map((id, index) => step(id, states[index] ?? "todo")),
  ...overrides
});

test("Blacksmith uses connected GitHub accounts and their orgs", () => {
  const accounts = [
    { id: "a1", provider: "github" },
    { id: "a2", provider: "bitbucket-cloud" }
  ] as AccountSummary[];
  assert.deepEqual(blacksmithAccounts(accounts).map((account) => account.id), ["a1"]);
  assert.deepEqual(
    blacksmithOrgs([
      { id: "jasper", label: "jasper", kind: "user" },
      { id: "jasper-org", label: "jasper-org", kind: "org" }
    ]).map((owner) => owner.id),
    ["jasper-org"]
  );
  assert.deepEqual(blacksmithOrgs(null), []);
});

test("the Blacksmith row status follows its steps", () => {
  assert.deepEqual(blacksmithStatus(null), { kind: "setup" });
  assert.deepEqual(blacksmithStatus(setup([], { gitAccountId: null })), { kind: "setup" });
  assert.deepEqual(blacksmithStatus(setup(["ok", "ok", "ok", "ok", "ok"])), { kind: "pill", tone: "ok", label: "Connected" });
  assert.deepEqual(blacksmithStatus(setup(["ok", "ok", "action-needed"])), { kind: "pill", tone: "warn", label: "Action needed" });
  assert.deepEqual(blacksmithStatus(setup(["ok", "ok", "ok", "running"])), { kind: "pill", tone: "info", label: "Setting up…" });
  assert.deepEqual(blacksmithStatus(setup(["ok", "ok", "ok", "ok", "failed"])), { kind: "pill", tone: "danger", label: "Error" });
  assert.deepEqual(blacksmithStatus(setup(["ok"])), { kind: "pill", tone: "neutral", label: "In progress" });
});

test("Blacksmith steps unlock in order", () => {
  assert.equal(blacksmithCanPickOrg(setup(["ok"])), true);
  assert.equal(blacksmithCanPickOrg(setup(["failed"])), false);
  assert.equal(blacksmithCanPickOrg(setup(["ok"], { gitAccountId: null })), false);
  assert.equal(blacksmithCanTest(setup(["ok", "ok", "ok", "ok"])), true);
  assert.equal(blacksmithCanTest(setup(["ok", "ok", "ok", "running"])), false);
  assert.equal(blacksmithCanTest(setup(["ok", "ok", "ok", "ok", "running"])), false);
  assert.equal(blacksmithBusy(setup(["ok", "ok", "ok", "ok", "running"])), true);
  assert.equal(blacksmithBusy(null), false);
});

test("a stopped control repo step offers Retry", () => {
  const step = (id: BlacksmithSetupStep["id"], state: BlacksmithSetupStep["state"]): BlacksmithSetupStep => ({ id, label: id, state, message: null, actionUrl: null });
  assert.equal(blacksmithCanRetry(step("repo", "action-needed")), true);
  assert.equal(blacksmithCanRetry(step("repo", "failed")), true);
  assert.equal(blacksmithCanRetry(step("repo", "ok")), false);
  assert.equal(blacksmithCanRetry(step("repo", "running")), false);
  assert.equal(blacksmithCanRetry(step("test", "failed")), false, "the test step has its own Run again");
});

// ---------------------------------------------------------------------------
// Boxes list
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-10-20T10:00:00.000Z");

test("the list shows live boxes, newest first, then the recently destroyed", () => {
  const older = box({ id: "older", createdAt: "2026-10-19T08:00:00.000Z" });
  const newer = box({ id: "newer", createdAt: "2026-10-20T08:00:00.000Z" });
  const recent = box({ id: "recent", state: "destroyed", destroyedAt: "2026-10-20T09:00:00.000Z" });
  const ancient = box({ id: "ancient", state: "destroyed", destroyedAt: "2026-10-18T09:00:00.000Z" });
  assert.deepEqual(listedBoxes([ancient, recent, older, newer], NOW).map((entry) => entry.id), ["newer", "older", "recent"]);
});

test("rows: title, owner, cost, state and countdown", () => {
  assert.equal(boxTitle(box()), "Linux VM · Hetzner · CX22 · Falkenstein");
  assert.equal(boxOwner(box()), "jaspersito / JasperEngine");
  assert.equal(boxOwner(box({ purpose: "temporary", project: null, purposeNote: "build on macOS" })), "Agent chat: build on macOS");
  assert.equal(boxOwner(box({ purpose: "temporary", project: null })), "Agent chat");
  assert.equal(boxCostLine(box()), "$0.0119/h · $0.42 so far");
  assert.equal(boxCostLine(box({ hourlyUsd: null, estimatedCostUsd: 0 })), "$0.00 so far");
  assert.deepEqual(boxStateView(box({ state: "unreachable", stateReason: "Reconnecting…" })), {
    tone: "warn",
    label: "Reconnecting…",
    title: "Reconnecting…"
  });
  assert.deepEqual(boxStateView(box({ state: "destroyed", destroyedReason: "provider-gone" })), {
    tone: "neutral",
    label: "Destroyed",
    title: "Destroyed: it is gone at the provider"
  });
  const deadline = "2026-10-24T16:00:00.000Z";
  assert.equal(boxCountdown(box({ kind: "macos", deadlineAt: deadline }), NOW), "4d 6h left");
  assert.equal(boxCountdown(box({ deadlineAt: deadline, state: "destroying" }), NOW), null);
  assert.equal(boxCountdown(box(), NOW), null);
});

test("setup progress counts done and skipped steps and names the current one", () => {
  const steps = box().setup;
  const running = box({
    state: "provisioning",
    setup: [steps[0], { ...steps[1], state: "running" }, { id: "clone", label: "Clone", state: "pending", startedAt: null, finishedAt: null, message: null }]
  });
  const progress = setupProgress(running);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
  assert.equal(progress.current?.id, "connect");
  assert.equal(progress.failed, false);
  assert.equal(progress.complete, false);
  const failed = setupProgress(box({ setup: [steps[0], { ...steps[1], state: "failed", message: "Timed out" }] }));
  assert.equal(failed.failed, true);
  assert.equal(failed.current?.message, "Timed out");
  assert.equal(setupProgress(box({ setup: [steps[0], { ...steps[1], state: "skipped" }] })).complete, true);
  assert.equal(setupProgress(box({ setup: [] })).complete, false);
});

test("only temporary boxes that still exist offer Destroy", () => {
  assert.equal(canDestroyBox(box()), false);
  assert.equal(canDestroyBox(box({ purpose: "temporary" })), true);
  assert.equal(canDestroyBox(box({ purpose: "temporary", state: "destroy-failed" })), true);
  assert.equal(canDestroyBox(box({ purpose: "temporary", state: "destroying" })), false);
  assert.equal(canDestroyBox(box({ purpose: "temporary", state: "destroyed" })), false);
});
