/**
 * The box tools (Ephemeral AI VMs spec §13) through the executor: chat-only schemas and their
 * validation; `create_box`'s spend card (every permission mode, workflow-owned chats included, never
 * a grant, refused while planning) with the plan it shows pinned into the create; approve, deny,
 * timeout and abort with the real approval-card registry; readiness failures and cancellation
 * destroying the box; the "set up a provider" refusal; and the operation tools' mapping over
 * `DaemonApi` with the caller's principal forced.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  accountLendRoutes,
  boxPathMapFor,
  boxRoutes,
  hostToBoxPath,
  temporaryBoxRoutes,
  type BoxKindsResponse,
  type BoxOffersResponse,
  type BoxProviderInfo,
  type BoxLentAccount,
  type BoxSummary,
  type LendAccountsPreviewResponse
} from "@orquester/api";
import type { AgentChatToolApprovalEventPayload, CallerPrincipal } from "@orquester/api/agent-chat";

import { ToolApprovalRegistry } from "../../agent-chat/tool-approvals.ts";
import { boxSummary, ManualClock } from "../../boxes/temporary/testing.ts";
import type { BoxExecRequest } from "../../boxes/temporary/contract.ts";
import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ApprovalPort, ApprovalRequest, ThreadCaller } from "../catalog/contract.ts";
import type { DaemonBoxCallOptions, DaemonOutcome } from "../daemon-api.ts";
import { audienceSchema, executeToolCall } from "../executor.ts";
import { gate } from "../gate/policy.ts";
import { FakeDaemonApi } from "../testing.ts";
import { boxesFamily } from "./boxes.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mcp-boxes-")));
const PROJECT = join(ROOT, "acme", "game");
mkdirSync(join(PROJECT, "sub"), { recursive: true });
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

function provider(over: Partial<BoxProviderInfo>): BoxProviderInfo {
  return {
    id: "hetzner",
    label: "Hetzner",
    kinds: ["linux"],
    website: "https://hetzner.com",
    credentialsUrl: "https://console.hetzner.cloud",
    credentialFields: [],
    status: "connected",
    error: null,
    keyHint: "abcd",
    accountNote: null,
    maxLifetimeMinutes: null,
    ...over
  };
}

const KINDS: BoxKindsResponse = {
  kinds: [
    { kind: "linux", providers: ["hetzner", "vultr"], fromHourlyUsd: 0.006, maxLifetimeMinutes: null, unavailableReason: null },
    { kind: "macos", providers: [], fromHourlyUsd: null, maxLifetimeMinutes: 7200, unavailableReason: null },
    { kind: "windows", providers: ["vultr"], fromHourlyUsd: 0.05, maxLifetimeMinutes: null, unavailableReason: "Tailscale is not set up on this desktop" }
  ]
};

const PROVIDERS = {
  providers: [
    provider({}),
    provider({ id: "vultr", label: "Vultr", kinds: ["linux", "windows"], maxLifetimeMinutes: 240 }),
    provider({ id: "blacksmith", label: "Blacksmith", kinds: ["macos"], status: "not-configured", maxLifetimeMinutes: 7200 })
  ]
};

const OFFERS: BoxOffersResponse = {
  provider: "hetzner",
  kind: "linux",
  sizes: [
    { id: "cx42", label: "CX42", vcpu: 8, ramGb: 16, diskGb: 160, gpu: null, hourlyUsd: 0.03, regions: [] },
    { id: "cx22", label: "CX22", vcpu: 2, ramGb: 4, diskGb: 40, gpu: null, hourlyUsd: 0.006, regions: ["nbg1", "fsn1"] }
  ],
  regions: [
    { id: "hel1", label: "Helsinki", country: "FI" },
    { id: "nbg1", label: "Nuremberg", country: "DE" },
    { id: "fsn1", label: "Falkenstein", country: "DE" }
  ],
  images: [],
  priceSource: "live",
  fetchedAt: "2026-10-20T00:00:00.000Z"
};

interface BoxCall {
  op: string;
  args: unknown[];
  principal: CallerPrincipal | undefined;
}

/** The daemon's box routes and operations, faked; every operation records the principal it acted for. */
function fakeApi(): { api: FakeDaemonApi; ops: BoxCall[]; created: unknown[]; deleted: { path: string; query?: Record<string, string> }[]; ready: { outcome: DaemonOutcome<BoxSummary> | null } } {
  const api = new FakeDaemonApi();
  api.fsRoot = api.workspacesDir = ROOT;
  const ops: BoxCall[] = [];
  const created: unknown[] = [];
  const deleted: { path: string; query?: Record<string, string> }[] = [];
  const ready: { outcome: DaemonOutcome<BoxSummary> | null } = { outcome: null };
  api
    .on("GET", boxRoutes.kinds, { status: 200, body: KINDS })
    .on("GET", boxRoutes.providers, { status: 200, body: PROVIDERS })
    .on("GET", boxRoutes.offers("hetzner", "linux"), { status: 200, body: OFFERS })
    .on("POST", temporaryBoxRoutes.list, ({ body }) => {
      created.push(body);
      return { status: 200, body: { box: boxSummary({ id: "tmp-1", state: "provisioning", os: null, arch: null }) } };
    })
    .on("GET", temporaryBoxRoutes.list, { status: 200, body: { boxes: [boxSummary({ id: "tmp-1", estimatedCostUsd: 0.01234 })] } })
    .on("GET", accountLendRoutes.all, { status: 200, body: { lends: [] } })
    .on("DELETE", `${temporaryBoxRoutes.list}/*`, ({ path, query }) => {
      deleted.push({ path, ...(query ? { query } : {}) });
      return { status: 200, body: { box: boxSummary({ id: "tmp-1", state: "destroyed", destroyedReason: "agent" }) } };
    });
  const record = (op: string, args: unknown[], opts: DaemonBoxCallOptions | undefined) => ops.push({ op, args, principal: opts?.principal });
  Object.assign(api, {
    boxWaitReady: async (boxId: string, timeoutMs: number, opts?: DaemonBoxCallOptions) => {
      record("waitReady", [boxId, timeoutMs], opts);
      return ready.outcome ?? { ok: true, value: boxSummary({ id: boxId, os: "linux", arch: "arm64", hourlyUsd: 0.006 }) };
    },
    boxExec: async (boxId: string, request: BoxExecRequest, opts?: DaemonBoxCallOptions) => {
      record("exec", [boxId, request], opts);
      if (request.background) return { ok: true, value: { background: true, shell: "bash", jobId: "job-1", startedAt: "2026-10-20T00:00:00.000Z" } };
      return {
        ok: true,
        value: {
          background: false,
          shell: request.shell ?? "bash",
          exitCode: 0,
          signal: null,
          timedOut: false,
          connectionLost: false,
          durationMs: 12,
          stdout: { text: "tail", bytes: 90_000, truncated: true },
          stderr: { text: "", bytes: 0, truncated: false }
        }
      };
    },
    boxJobOutput: async (boxId: string, jobId: string, waitMs: number, opts?: DaemonBoxCallOptions) => {
      record("jobOutput", [boxId, jobId, waitMs], opts);
      return { ok: true, value: { jobId, running: false, exitCode: 0, signal: null, output: { text: "done\n", bytes: 5, truncated: false }, startedAt: null, finishedAt: null, lost: null } };
    },
    boxUpload: async (boxId: string, request: { localPath: string; remotePath: string }, opts?: DaemonBoxCallOptions) => {
      record("upload", [boxId, request], opts);
      return { ok: true, value: { kind: "file", bytes: 3, localPath: request.localPath, remotePath: `/root/${request.remotePath}` } };
    },
    boxDownload: async (boxId: string, request: { remotePath: string; localPath: string }, opts?: DaemonBoxCallOptions) => {
      record("download", [boxId, request], opts);
      return { ok: false, code: "ALREADY_EXISTS", message: "local_path already exists" };
    },
    boxForwardPort: async (boxId: string, port: number, opts?: DaemonBoxCallOptions) => {
      record("forward", [boxId, port], opts);
      return { ok: true, value: { url: "http://127.0.0.1:41234/", hostPort: 41234, boxPort: port } };
    }
  });
  return { api, ops, created, deleted, ready };
}

function chat(over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: "me", title: "Game", projectPath: PROJECT, workspace: "acme", cwd: join(PROJECT, "sub"), agentId: "claude", callId: "c1",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; code: string; message: string };

async function call(api: FakeDaemonApi, name: string, args: Record<string, unknown>, opts: { caller?: ThreadCaller | { kind: "external" }; port?: ApprovalPort; signal?: AbortSignal } = {}): Promise<Outcome> {
  const result: CallToolResult = await executeToolCall(
    { approvals: opts.port ?? new FakeApprovalPort() },
    { name, arguments: args },
    { caller: opts.caller ?? chat(), api, signal: opts.signal ?? new AbortController().signal }
  );
  const content = result.structuredContent as Record<string, unknown>;
  return result.isError ? { ok: false, code: content.code as string, message: content.message as string } : { ok: true, value: content };
}

const createArgs = { kind: "linux", purpose: "build the engine on Linux" };

// ---------------------------------------------------------------------------
// Schemas and audience
// ---------------------------------------------------------------------------

test("the box tools are chat-only; schemas refuse bad and unknown arguments", async () => {
  const { api } = fakeApi();
  for (const tool of boxesFamily) {
    const external = await call(api, tool.name, {}, { caller: { kind: "external" } });
    assert.ok(!external.ok && external.code === "TOOL_NOT_FOUND", tool.name);
  }
  const schema = (name: string) => audienceSchema(boxesFamily.find((tool) => tool.name === name)!, "chat");
  assert.ok(schema("create_box").safeParse(createArgs).success);
  assert.ok(!schema("create_box").safeParse({ kind: "solaris", purpose: "x" }).success);
  assert.ok(!schema("create_box").safeParse({ kind: "linux" }).success, "purpose is required");
  assert.ok(!schema("create_box").safeParse({ ...createArgs, lifetime_minutes: 5 }).success);
  assert.ok(!schema("create_box").safeParse({ ...createArgs, lifetime_minutes: 90.5 }).success);
  assert.ok(!schema("create_box").safeParse({ ...createArgs, threadId: "other" }).success, "unknown keys are refused");
  assert.ok(schema("box_exec").safeParse({ box_id: "b", command: "ls", shell: "powershell", timeout_seconds: 7200 }).success);
  assert.ok(!schema("box_exec").safeParse({ box_id: "b", command: "ls", timeout_seconds: 7201 }).success);
  assert.ok(!schema("box_exec").safeParse({ box_id: "b", command: "ls", shell: "zsh" }).success);
  assert.ok(!schema("box_exec_output").safeParse({ box_id: "b", job_id: "j", wait_seconds: 601 }).success);
  assert.ok(!schema("box_forward_port").safeParse({ box_id: "b", port: 70_000 }).success);
  assert.ok(!schema("box_upload").safeParse({ box_id: "b", local_path: "a" }).success);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("gate: a spend tool cards in every mode, for a workflow-owned chat too, and is refused while planning", () => {
  const input = (caller: ThreadCaller) => ({
    tool: "create_box", tier: "act" as const, planSafe: false, spendFamily: "boxes" as const, caller,
    scope: { projects: [], sessions: [], reads: "none" as const, writes: true, causesTurnIn: [] },
    targets: [], pendingTargets: [], unknownTargets: [], workspaceTargets: [], deniedPaths: [], notOwnChildren: []
  });
  for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto", "full-access"] as const) {
    for (const workflowOwned of [false, true]) {
      const decision = gate(input(chat({ runtimeMode, workflowOwned })));
      assert.ok(decision.kind === "card", `${runtimeMode} ${workflowOwned}`);
      assert.deepEqual([decision.approvalKind, decision.family, decision.crossProject], ["spend", "boxes", false]);
    }
  }
  const planning = gate(input(chat({ planning: true })));
  assert.ok(planning.kind === "deny" && planning.code === "PERMISSION_DENIED");
});

// ---------------------------------------------------------------------------
// create_box
// ---------------------------------------------------------------------------

test("create_box in full access still opens a card: the plan (cheapest provider, size, first region), its price and worst case; no grant", async () => {
  const { api, created, ops } = fakeApi();
  const port = new FakeApprovalPort();
  const outcome = await call(api, "create_box", createArgs, { port });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  assert.equal(port.cards.length, 1);
  const card: ApprovalRequest = port.cards[0]!;
  assert.equal(card.kind, "spend");
  assert.equal(card.family, "boxes");
  assert.match(card.title, /Linux/);
  assert.match(card.scope.label, /Hetzner/);
  assert.deepEqual(card.grantOptions, []);
  assert.equal(port.grantQueries.length, 0, "no grant is ever looked for");
  const fields = card.sections.find((section) => section.kind === "fields");
  assert.ok(fields && fields.kind === "fields");
  const rows = Object.fromEntries(fields.rows.map((row) => [row.label, row.value]));
  assert.equal(rows.Provider, "Hetzner");
  assert.match(rows.Size!, /CX22.*2 vCPU.*4 GB.*40 GB/);
  assert.match(rows.Region!, /Nuremberg.*DE/);
  assert.equal(rows["Estimated price"], "$0.006/h");
  assert.equal(rows["Time limit"], "2 h");
  assert.match(rows["Worst case"]!, /\$0\.012\b/);
  assert.ok(card.sections.some((section) => section.kind === "text" && section.text === "build the engine on Linux"));
  assert.ok(card.sections.some((section) => section.kind === "warning" && section.text.includes("Orquester copies nothing into the box")));
  // What runs is what the card showed.
  assert.deepEqual(created, [{ kind: "linux", provider: "hetzner", size: "cx22", region: "nbg1", lifetimeMinutes: 120, purposeNote: "build the engine on Linux" }]);
  assert.deepEqual(ops.map((op) => op.op), ["waitReady"]);
  assert.deepEqual(ops[0]!.args, ["tmp-1", 15 * 60_000]);
  assert.equal(ops[0]!.principal?.kind, "agent", "the operation acts for the calling chat");
  assert.equal((ops[0]!.principal as { threadId?: string }).threadId, "me");
  assert.deepEqual(outcome.value, {
    box_id: "tmp-1",
    kind: "linux",
    provider: "hetzner",
    os: "linux",
    arch: "arm64",
    hourly_usd: 0.006,
    deadline: "2026-10-20T02:00:00.000Z",
    note: "Ready and empty: Orquester copied nothing into it. It bills until destroy_box, its deadline, or this chat closing.",
    toolApproval: { approvalId: "a_1", kind: "spend", family: "boxes", title: "Rent a Linux box", outcome: "approved" }
  });
});

test("create_box: a chosen provider, size, region and time limit are checked against the offers and the provider's maximum", async () => {
  const { api, created } = fakeApi();
  const chosen = await call(api, "create_box", { ...createArgs, size: "cx42", region: "hel1", lifetime_minutes: 45 });
  assert.ok(chosen.ok, chosen.ok ? "" : chosen.message);
  assert.deepEqual(created.at(-1), { kind: "linux", provider: "hetzner", size: "cx42", region: "hel1", lifetimeMinutes: 45, purposeNote: "build the engine on Linux" });
  const wrongRegion = await call(api, "create_box", { ...createArgs, size: "cx22", region: "hel1" });
  assert.ok(!wrongRegion.ok && wrongRegion.code === "INVALID_ARGUMENT" && wrongRegion.message.includes("nbg1, fsn1"));
  const wrongSize = await call(api, "create_box", { ...createArgs, size: "big" });
  assert.ok(!wrongSize.ok && wrongSize.code === "INVALID_ARGUMENT");
  const unconnected = await call(api, "create_box", { ...createArgs, provider: "linode" });
  assert.ok(!unconnected.ok && unconnected.code === "INVALID_ARGUMENT" && unconnected.message.includes("hetzner, vultr"));
  api.on("GET", boxRoutes.offers("vultr", "linux"), { status: 200, body: { ...OFFERS, provider: "vultr" } });
  const overMax = await call(api, "create_box", { ...createArgs, provider: "vultr", lifetime_minutes: 300 });
  assert.ok(!overMax.ok && overMax.code === "INVALID_ARGUMENT" && overMax.message.includes("at most 240 with Vultr"));
});

test("create_box with no provider for the kind: a clear refusal naming what to set up, and no card", async () => {
  const { api } = fakeApi();
  const port = new FakeApprovalPort();
  const macos = await call(api, "create_box", { kind: "macos", purpose: "test on macOS" }, { port });
  assert.ok(!macos.ok);
  assert.equal(macos.code, "BOX_PROVIDER_NOT_CONFIGURED");
  assert.match(macos.message, /Settings › Plugins › Ephemeral AI VMs: Blacksmith/);
  assert.match(macos.message, /GitHub organisation/);
  const windows = await call(api, "create_box", { kind: "windows", purpose: "test on Windows" }, { port });
  assert.ok(!windows.ok && windows.code === "BOX_CONNECTION_NOT_CONFIGURED" && windows.message.includes("Tailscale is not set up"));
  const off = new FakeDaemonApi();
  off.fsRoot = off.workspacesDir = ROOT;
  const disabled = await call(off, "create_box", createArgs, { port });
  assert.ok(!disabled.ok && disabled.code === "BOXES_DISABLED");
  assert.equal(port.cards.length, 0, "no card opens for a box that cannot be rented");
});

test("create_box from an unattended chat: the card still opens and says nobody may be watching", async () => {
  for (const caller of [chat({ workflowOwned: true, runtimeMode: "approval-required" }), chat({ exchange: { id: "x1", hop: 1 } })]) {
    const { api } = fakeApi();
    const port = new FakeApprovalPort();
    const outcome = await call(api, "create_box", createArgs, { caller, port });
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
    assert.ok(port.cards[0]!.sections.some((section) => section.kind === "warning" && section.text.includes("runs unattended")));
  }
  const { api } = fakeApi();
  const port = new FakeApprovalPort();
  await call(api, "create_box", createArgs, { port });
  assert.ok(!port.cards[0]!.sections.some((section) => section.kind === "warning" && section.text.includes("runs unattended")));
});

test("create_box: a box that does not become ready is destroyed (provisioning-failed); a cancelled wait destroys it (agent)", async () => {
  const failing = fakeApi();
  failing.ready.outcome = { ok: false, code: "BOX_NOT_READY", message: "The box was not ready within 15 minutes." };
  const failed = await call(failing.api, "create_box", createArgs);
  assert.ok(!failed.ok && failed.code === "BOX_NOT_READY" && failed.message.includes("was destroyed"));
  assert.deepEqual(failing.deleted, [{ path: temporaryBoxRoutes.box("tmp-1"), query: { reason: "provisioning-failed" } }]);

  const cancelling = fakeApi();
  const controller = new AbortController();
  Object.assign(cancelling.api, {
    boxWaitReady: async () => {
      controller.abort();
      return { ok: false, code: "CANCELLED", message: "The wait was cancelled." };
    }
  });
  const cancelled = await call(cancelling.api, "create_box", createArgs, { signal: controller.signal });
  assert.ok(!cancelled.ok && cancelled.code === "CANCELLED");
  assert.deepEqual(cancelling.deleted, [{ path: temporaryBoxRoutes.box("tmp-1"), query: { reason: "agent" } }]);
});

// ---------------------------------------------------------------------------
// The card through the real approval-card registry
// ---------------------------------------------------------------------------

function registryHarness() {
  const clock = new ManualClock();
  const opened: string[] = [];
  const waiters: ((id: string) => void)[] = [];
  const events: AgentChatToolApprovalEventPayload[] = [];
  const registry = new ToolApprovalRegistry({
    publish: (event) => {
      events.push(event);
      if (!event.opened) return;
      const waiter = waiters.shift();
      if (waiter) waiter(event.opened.approvalId);
      else opened.push(event.opened.approvalId);
    },
    log: () => {},
    clock
  });
  const port: ApprovalPort = {
    findGrant: async () => null,
    request: (card, signal) =>
      registry.open(
        { threadId: card.threadId, tool: card.tool, kind: card.kind, family: card.family, title: card.title, scope: card.scope, sections: card.sections, secretFields: card.secretFields, grantOptions: card.grantOptions },
        signal
      ),
    recordWorkflowInGrant: async () => {}
  };
  const nextCard = (): Promise<string> => (opened.length > 0 ? Promise.resolve(opened.shift()!) : new Promise((resolve) => waiters.push(resolve)));
  return { registry, port, clock, nextCard, events };
}

test("the card in the registry: approve rents, deny refuses with the owner's words, expiry times out, abort cancels", async () => {
  // Approve.
  {
    const h = registryHarness();
    const { api, created } = fakeApi();
    const running = call(api, "create_box", createArgs, { port: h.port });
    const id = await h.nextCard();
    const [summary] = h.registry.list("me");
    assert.equal(summary!.kind, "spend");
    assert.match(summary!.title, /Linux/);
    assert.deepEqual(summary!.grantOptions, []);
    assert.ok(created.length === 0, "nothing is rented while the card waits");
    const answer = await h.registry.answer("me", id, { decision: "approve" });
    assert.ok(answer.ok);
    const outcome = await running;
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
    assert.equal(created.length, 1);
  }
  // Deny with a reason.
  {
    const h = registryHarness();
    const { api, created } = fakeApi();
    const running = call(api, "create_box", createArgs, { port: h.port });
    await h.registry.answer("me", await h.nextCard(), { decision: "deny", reason: "use the host" });
    const outcome = await running;
    assert.equal(created.length, 0);
    assert.ok(!outcome.ok && outcome.code === "APPROVAL_DENIED" && outcome.message.includes("use the host"));
  }
  // Nobody answers within 30 minutes.
  {
    const h = registryHarness();
    const { api, created } = fakeApi();
    const running = call(api, "create_box", createArgs, { port: h.port });
    await h.nextCard();
    h.clock.advance(30 * 60_000 - 1);
    assert.equal(h.registry.list("me").length, 1, "the card remains available until its 30-minute deadline");
    h.clock.advance(1);
    const outcome = await running;
    assert.equal(created.length, 0);
    assert.ok(!outcome.ok && outcome.code === "APPROVAL_TIMEOUT");
  }
  // The call is aborted while the card waits.
  {
    const h = registryHarness();
    const { api, created } = fakeApi();
    const controller = new AbortController();
    const running = call(api, "create_box", createArgs, { port: h.port, signal: controller.signal });
    await h.nextCard();
    controller.abort();
    const outcome = await running;
    assert.ok(!outcome.ok && outcome.code === "CANCELLED");
    assert.equal(created.length, 0);
    assert.equal(h.registry.list("me").length, 0, "the card closed");
  }
  // Planning never opens a rental card or rents a machine.
  {
    const h = registryHarness();
    const { api, created } = fakeApi();
    const running = call(api, "create_box", createArgs, { port: h.port, caller: chat({ planning: true }) });
    await Promise.race([running, h.nextCard()]);
    assert.equal(h.registry.list("me").length, 0);
    assert.equal(created.length, 0);
    const outcome = await running;
    assert.ok(!outcome.ok && outcome.code === "PERMISSION_DENIED");
  }
});

// ---------------------------------------------------------------------------
// The operation tools
// ---------------------------------------------------------------------------

test("list_boxes and destroy_box go through the temporary-box routes", async () => {
  const { api, deleted } = fakeApi();
  const listed = await call(api, "list_boxes", {});
  assert.ok(listed.ok);
  const [box] = listed.value.boxes as Record<string, unknown>[];
  assert.equal(box!.box_id, "tmp-1");
  assert.equal(box!.estimated_cost_usd, 0.01);
  const destroyed = await call(api, "destroy_box", { box_id: "tmp-1" });
  assert.ok(destroyed.ok && destroyed.value.state === "destroyed");
  assert.deepEqual(deleted, [{ path: temporaryBoxRoutes.box("tmp-1"), query: { reason: "agent" } }]);
  // A refused route passes its code through.
  api.on("DELETE", `${temporaryBoxRoutes.list}/*`, { status: 404, body: { code: "BOX_NOT_FOUND", message: "No temporary box of this chat has that id." } });
  const foreign = await call(api, "destroy_box", { box_id: "theirs" });
  assert.ok(!foreign.ok && foreign.code === "BOX_NOT_FOUND");
  // Stopping spend works while planning.
  const planning = await call(fakeApi().api, "destroy_box", { box_id: "tmp-1" }, { caller: chat({ planning: true }) });
  assert.ok(planning.ok);
});

test("box_exec: defaults, the result's tails and counts, background jobs, and box_exec_output", async () => {
  const { api, ops } = fakeApi();
  const fg = await call(api, "box_exec", { box_id: "tmp-1", command: "make" });
  assert.ok(fg.ok);
  assert.deepEqual(ops.at(-1)!.args, ["tmp-1", { command: "make", timeoutSeconds: 600, background: false }]);
  assert.equal(fg.value.stdout, "tail");
  assert.equal(fg.value.stdout_bytes, 90_000);
  assert.equal(fg.value.stdout_truncated, true);
  assert.match(fg.value.note as string, /box_download/);
  const bg = await call(api, "box_exec", { box_id: "tmp-1", command: "make -j8", background: true, shell: "sh", cwd: "/src" });
  assert.ok(bg.ok && bg.value.job_id === "job-1");
  assert.deepEqual(ops.at(-1)!.args, ["tmp-1", { command: "make -j8", shell: "sh", cwd: "/src", timeoutSeconds: 600, background: true }]);
  const out = await call(api, "box_exec_output", { box_id: "tmp-1", job_id: "job-1", wait_seconds: 30 });
  assert.ok(out.ok && out.value.output === "done\n" && out.value.running === false);
  assert.deepEqual(ops.at(-1)!.args, ["tmp-1", "job-1", 30_000]);
  for (const op of ops) assert.equal((op.principal as { threadId?: string } | undefined)?.threadId, "me", op.op);
});

test("box_upload / box_download: relative host paths from the chat's cwd; refusals pass through; a chat with no project is refused", async () => {
  const { api, ops } = fakeApi();
  const up = await call(api, "box_upload", { box_id: "tmp-1", local_path: "bundle.git", remote_path: "repo.git" });
  assert.ok(up.ok, up.ok ? "" : up.message);
  assert.deepEqual(ops.at(-1)!.args, ["tmp-1", { localPath: join(PROJECT, "sub", "bundle.git"), remotePath: "repo.git" }]);
  assert.equal(up.value.remote_path, "/root/repo.git");
  const down = await call(api, "box_download", { box_id: "tmp-1", remote_path: "out", local_path: join(PROJECT, "out") });
  assert.ok(!down.ok && down.code === "ALREADY_EXISTS");
  const homeless = await call(api, "box_upload", { box_id: "tmp-1", local_path: "a", remote_path: "b" }, { caller: chat({ projectPath: "", workspace: "", cwd: "/tmp" }) });
  assert.ok(!homeless.ok && homeless.code === "NO_PROJECT");
});

test("box_upload / box_download from a chat in a Windows box: C:\\orq\\… and backslash-relative local paths are its project's host paths; another drive is refused", async () => {
  const { api, ops } = fakeApi();
  const boxPaths = boxPathMapFor("win32");
  const caller = chat({ boxPaths });
  const absolute = await call(api, "box_upload", { box_id: "tmp-1", local_path: hostToBoxPath(boxPaths, join(PROJECT, "build", "out.zip")), remote_path: "out.zip" }, { caller });
  assert.ok(absolute.ok, absolute.ok ? "" : absolute.message);
  assert.equal((ops.at(-1)!.args[1] as { localPath: string }).localPath, join(PROJECT, "build", "out.zip"));
  await call(api, "box_download", { box_id: "tmp-1", remote_path: "out", local_path: "build\\out.zip" }, { caller });
  assert.equal((ops.at(-1)!.args[1] as { localPath: string }).localPath, join(PROJECT, "sub", "build", "out.zip"));
  const count = ops.length;
  const elsewhere = await call(api, "box_upload", { box_id: "tmp-1", local_path: "D:\\build\\out.zip", remote_path: "out.zip" }, { caller });
  assert.ok(!elsewhere.ok && elsewhere.code === "PERMISSION_DENIED");
  assert.equal(ops.length, count, "refused before the daemon is asked");
  // A chat on the host: a backslash is part of the file's name, as it always was.
  await call(api, "box_upload", { box_id: "tmp-1", local_path: "build\\out.zip", remote_path: "out.zip" });
  assert.equal((ops.at(-1)!.args[1] as { localPath: string }).localPath, join(PROJECT, "sub", "build\\out.zip"));
});

test("box_upload / box_download claim local_path: outside every project refused, another project a card below Full access", async () => {
  mkdirSync(join(ROOT, "acme", "other"), { recursive: true });
  for (const tool of ["box_download", "box_upload"] as const) {
    const { api, ops } = fakeApi();
    Object.assign(api, { boxDownload: async (boxId: string, request: { localPath: string; remotePath: string }, opts?: DaemonBoxCallOptions) => {
      ops.push({ op: "download", args: [boxId, request], principal: opts?.principal });
      return { ok: true, value: { kind: "file", bytes: 3, ...request } };
    } });
    const outside = await call(api, tool, { box_id: "tmp-1", remote_path: "out", local_path: join(ROOT, "loose.txt") });
    assert.equal(ops.length, 0, "refused before the daemon is asked");
    assert.ok(!outside.ok && outside.code === "PERMISSION_DENIED", tool);

    const port = new FakeApprovalPort({ outcome: "denied", approvalId: "", reason: "no" });
    const elsewhere = await call(api, tool, { box_id: "tmp-1", remote_path: "out", local_path: join(ROOT, "acme", "other", ".git", "config") }, { caller: chat({ runtimeMode: "auto" }), port });
    assert.equal(port.cards.length, 1, `${tool}: a card for another project's path`);
    assert.equal(port.cards[0]!.family, "cross-project");
    assert.equal(ops.length, 0);
    assert.ok(!elsewhere.ok, tool);

    // In its own project the call goes on to the daemon (which owns the .git refusal).
    const own = new FakeApprovalPort();
    await call(api, tool, { box_id: "tmp-1", remote_path: "out", local_path: "artifact.bin" }, { caller: chat({ runtimeMode: "approval-required" }), port: own });
    assert.equal(own.cards.length, 0);
    assert.equal(ops.length, 1);
  }
});

test("box_forward_port returns the host loopback URL; without the box backend every operation is BOXES_DISABLED", async () => {
  const { api } = fakeApi();
  const forward = await call(api, "box_forward_port", { box_id: "tmp-1", port: 5173 });
  assert.ok(forward.ok && forward.value.url === "http://127.0.0.1:41234/" && forward.value.box_port === 5173);
  const bare = new FakeDaemonApi();
  bare.fsRoot = bare.workspacesDir = ROOT;
  for (const [name, args] of [
    ["box_exec", { box_id: "b", command: "ls" }],
    ["box_exec_output", { box_id: "b", job_id: "j" }],
    ["box_upload", { box_id: "b", local_path: "a", remote_path: "b" }],
    ["box_download", { box_id: "b", local_path: "a", remote_path: "b" }],
    ["box_forward_port", { box_id: "b", port: 80 }]
  ] as const) {
    const outcome = await call(bare, name, args);
    assert.ok(!outcome.ok && outcome.code === "BOXES_DISABLED", name);
  }
});

test("box_forward_port in a box project: url is the project box's, browser_url the host Browser tab's", async () => {
  const { api } = fakeApi();
  Object.assign(api, {
    boxForwardPort: async (_boxId: string, port: number) => ({
      ok: true,
      value: { url: "http://127.0.0.1:21000/", browserUrl: "http://127.0.0.1:41234/", hostPort: 41234, boxPort: port, projectBoxPort: 21000 }
    })
  });
  const forward = await call(api, "box_forward_port", { box_id: "tmp-1", port: 5173 });
  assert.ok(forward.ok);
  assert.equal(forward.value.url, "http://127.0.0.1:21000/");
  assert.equal(forward.value.browser_url, "http://127.0.0.1:41234/");
  assert.equal(forward.value.project_box_port, 21000);
});

test("create_box on one of the owner's own machines: a 'Use your machine' card (free, names the machine), pinned to that machine", async () => {
  const { api, created } = fakeApi();
  const machine = { id: "m4c0ffee1234", label: "Mac mini (macOS, arm64)", vcpu: 0, ramGb: 0, diskGb: null, gpu: null, hourlyUsd: 0, regions: [] };
  api
    .on("GET", boxRoutes.kinds, {
      status: 200,
      body: { kinds: [{ kind: "macos", providers: ["blacksmith", "byo"], fromHourlyUsd: 0, maxLifetimeMinutes: null, unavailableReason: null }] }
    })
    .on("GET", boxRoutes.providers, {
      status: 200,
      body: { providers: [...PROVIDERS.providers, provider({ id: "byo", label: "Your machines", kinds: ["linux", "macos"], keyHint: null })] }
    })
    .on("GET", boxRoutes.offers("byo", "macos"), {
      status: 200,
      body: { ...OFFERS, provider: "byo", kind: "macos", sizes: [machine], regions: [{ id: "own", label: "Your machine", country: null }] }
    });
  const port = new FakeApprovalPort();
  const outcome = await call(api, "create_box", { kind: "macos", provider: "byo", purpose: "run the iOS tests" }, { port });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  const card = port.cards[0]!;
  assert.equal(card.kind, "spend", "the same never-grantable family as a rental");
  assert.deepEqual(card.grantOptions, []);
  assert.ok(card.title.includes(machine.label), "approval names the actual machine");
  const fields = card.sections.find((section) => section.kind === "fields");
  assert.ok(fields && fields.kind === "fields");
  assert.ok(fields.rows.some((row) => row.value === machine.label));
  assert.ok(fields.rows.some((row) => /free/i.test(row.value)), "owned machines do not incur rental charges");
  assert.ok(card.sections.some((section) => section.kind === "warning" && section.text.includes(machine.label) && /command|execute|code/i.test(section.text)));
  assert.deepEqual(created, [{ kind: "macos", provider: "byo", size: machine.id, region: "own", lifetimeMinutes: 120, purposeNote: "run the iOS tests" }]);
});

test("create_box with provider byo when none of the owner's machines is free: a refusal saying so, and no card", async () => {
  const { api } = fakeApi();
  api.on("GET", boxRoutes.providers, { status: 200, body: { providers: [...PROVIDERS.providers, provider({ id: "byo", label: "Your machines", kinds: ["linux"], keyHint: null })] } })
    .on("GET", boxRoutes.offers("byo", "linux"), { status: 200, body: { ...OFFERS, provider: "byo" } });
  const port = new FakeApprovalPort();
  const refused = await call(api, "create_box", { ...createArgs, provider: "byo" }, { port });
  assert.equal(port.cards.length, 0);
  assert.ok(!refused.ok && refused.code === "BOX_NOT_READY");
});

// ---------------------------------------------------------------------------
// Lending accounts (spec 2026-11-03-lend-accounts-to-boxes-design.md §8, §9)
// ---------------------------------------------------------------------------

const lendArgs = { claude: ["ada"], codex: ["bob"], purpose: "run the paid eval" };

const PREVIEW: LendAccountsPreviewResponse = {
  accounts: [
    { accountId: "acct-claude", agent: "claude", label: "ada@acme.dev", tokenExpiresAt: "2026-11-03T19:40:00.000Z", alreadyLent: false },
    { accountId: "acct-codex", agent: "codex", label: "bob@acme.dev", tokenExpiresAt: "2026-11-13T08:00:00.000Z", alreadyLent: false }
  ],
  minutes: 90,
  expiresAt: "2026-11-03T21:40:00.000Z",
  boxLabel: "Hetzner · 8 vCPU"
};

function lend(over: Partial<BoxLentAccount & { boxId: string }> = {}): BoxLentAccount & { boxId: string } {
  return {
    boxId: "tmp-1", id: "lend-1", accountId: "acct-claude", agent: "claude", label: "ada@acme.dev", threadId: "me", purposeNote: "run the paid eval",
    createdAt: "2026-11-03T17:40:00.000Z", expiresAt: "2026-11-03T21:40:00.000Z", tokenExpiresAt: "2026-11-03T19:40:00.000Z", status: "active", statusMessage: null,
    home: "/var/lib/orquester/daemon/agent-accounts/claude/acct-claude/home", ...over
  };
}

/** {@link fakeApi} plus the lend routes on `boxId`, recording what is previewed and posted. */
function lendApi(boxId = "tmp-1", preview: LendAccountsPreviewResponse = PREVIEW) {
  const base = fakeApi();
  const previews: unknown[] = [];
  const posted: unknown[] = [];
  base.api
    .on("POST", accountLendRoutes.preview(boxId), ({ body }) => {
      previews.push(body);
      return { status: 200, body: preview };
    })
    .on("POST", accountLendRoutes.box(boxId), ({ body }) => {
      posted.push(body);
      return { status: 200, body: { boxId, appdir: "/var/lib/orquester", lent: [lend()] } };
    });
  return { ...base, previews, posted };
}

const lendTool = () => boxesFamily.find((tool) => tool.name === "box_lend_accounts")!;

test("box_lend_accounts run refuses without whole approved pins, and posts exactly the pins whatever the arguments say", async () => {
  const { api, posted } = lendApi("pinned-box");
  const ctx = (pins?: Record<string, string>) => ({
    api, caller: chat(), signal: new AbortController().signal, now: Date.now,
    ...(pins ? { approval: { outcome: "approved" as const, approvalId: "a_1", pins } } : {})
  });
  const parsed = { ...lendArgs, claude: ["someone-else"], minutes: 1440, box_id: "another-box" };
  const accounts = JSON.stringify([{ agent: "claude", accountId: "acct-claude" }]);
  const refused: (Record<string, string> | undefined)[] = [undefined, {}, { boxId: "pinned-box", accounts, minutes: "soon" }, { boxId: "pinned-box", accounts: "[]", minutes: "90" }, { boxId: "pinned-box", accounts: '[{"agent":"grok","accountId":"x"}]', minutes: "90" }];
  for (const pins of refused) {
    await assert.rejects(Promise.resolve(lendTool().run(parsed as never, ctx(pins) as never)), (error: { code?: string }) => error.code === "PERMISSION_DENIED", JSON.stringify(pins));
  }
  assert.deepEqual(posted, []);
  await lendTool().run(parsed as never, ctx({ boxId: "pinned-box", accounts, minutes: "90" }) as never);
  assert.deepEqual(posted, [{ accounts: [{ agent: "claude", accountId: "acct-claude" }], minutes: 90, purposeNote: "run the paid eval" }]);
});

test("box_lend_accounts in full access opens a spend card naming every account and warning that tokens are readable; approving lends what the preview resolved", async () => {
  const { api, previews, posted } = lendApi();
  const port = new FakeApprovalPort();
  const outcome = await call(api, "box_lend_accounts", { ...lendArgs, minutes: 1440 }, { port });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  const card = port.cards[0]!;
  assert.deepEqual([card.kind, card.family, card.grantOptions], ["spend", "accounts", []]);
  assert.equal(port.grantQueries.length, 0, "no grant is ever looked for");
  const rows = card.sections.flatMap((section) => (section.kind === "fields" ? section.rows : []));
  for (const account of PREVIEW.accounts) assert.ok(rows.some((row) => row.label === account.label), account.label);
  assert.ok(card.sections.some((section) => section.kind === "text" && section.text === lendArgs.purpose));
  const warnings = card.sections.flatMap((section) => (section.kind === "warning" ? [section.text] : []));
  assert.ok(warnings.some((text) => text.includes("can read these logins")));
  assert.ok(warnings.some((text) => text.includes("Codex tokens last about 10 days")));
  // The real end is counted from approval, so the card promises no clock time.
  assert.ok(!rows.some((row) => row.label === "Ends at"));
  assert.match(rows.find((row) => row.label === "Time limit")!.value, /^1 h 30 min from approval, at most until/);
  assert.deepEqual(previews, [{ claude: ["ada"], codex: ["bob"], minutes: 1440 }]);
  // The clamped minutes and the resolved ids, not the arguments.
  assert.deepEqual(posted, [{ accounts: [{ agent: "claude", accountId: "acct-claude" }, { agent: "codex", accountId: "acct-codex" }], minutes: 90, purposeNote: lendArgs.purpose }]);
  assert.equal(outcome.value.appdir, "/var/lib/orquester");
  assert.deepEqual((outcome.value.accounts as { id: string }[]).map((account) => account.id), ["acct-claude"]);

  const claudeOnly = new FakeApprovalPort();
  await call(lendApi("tmp-1", { ...PREVIEW, accounts: [PREVIEW.accounts[0]!] }).api, "box_lend_accounts", { claude: ["ada"], purpose: "p" }, { port: claudeOnly, caller: chat({ workflowOwned: true }) });
  const claudeWarnings = claudeOnly.cards[0]!.sections.flatMap((section) => (section.kind === "warning" ? [section.text] : []));
  assert.ok(!claudeWarnings.some((text) => text.includes("Codex")));
  assert.ok(claudeWarnings.some((text) => text.includes("unattended")));
});

test("box_lend_accounts: planning says it lends quota, naming no account is refused, and a denied card lends nothing", async () => {
  const { api, posted, previews } = lendApi();
  const planning = await call(api, "box_lend_accounts", lendArgs, { caller: chat({ planning: true }) });
  assert.ok(!planning.ok && planning.code === "PERMISSION_DENIED" && /quota/.test(planning.message), JSON.stringify(planning));
  const none = await call(api, "box_lend_accounts", { claude: [], purpose: "p" });
  assert.ok(!none.ok && none.code === "INVALID_ARGUMENT");
  const tooMany = await call(api, "box_lend_accounts", { claude: ["a", "b", "c", "d"], codex: ["e", "f", "g"], purpose: "p" });
  assert.ok(!tooMany.ok && tooMany.code === "INVALID_ARGUMENT");
  assert.deepEqual(previews, []);
  const denied = await call(api, "box_lend_accounts", lendArgs, { port: new FakeApprovalPort({ outcome: "denied", approvalId: "" }) });
  assert.ok(!denied.ok);
  assert.deepEqual(posted, []);
});

test("box_lend_accounts' default box: the VM the chat runs in, else its only live temporary box, else LEND_NO_BOX with the fix", async () => {
  const inProject = lendApi("project-box");
  assert.ok((await call(inProject.api, "box_lend_accounts", lendArgs, { caller: chat({ projectBoxId: "project-box" }) })).ok);
  assert.equal(inProject.posted.length, 1);

  const temporary = lendApi("tmp-2");
  temporary.api.on("GET", temporaryBoxRoutes.list, { status: 200, body: { boxes: [boxSummary({ id: "old", state: "destroyed" }), boxSummary({ id: "tmp-2" })] } });
  assert.ok((await call(temporary.api, "box_lend_accounts", lendArgs)).ok);
  assert.equal(temporary.posted.length, 1);

  const none = fakeApi();
  none.api.on("GET", temporaryBoxRoutes.list, { status: 200, body: { boxes: [boxSummary({ id: "old", state: "destroyed" })] } });
  const noBox = await call(none.api, "box_lend_accounts", lendArgs);
  assert.ok(!noBox.ok && noBox.code === "LEND_NO_BOX" && noBox.message.includes("create_box"));

  const several = fakeApi();
  several.api.on("GET", temporaryBoxRoutes.list, { status: 200, body: { boxes: [boxSummary({ id: "tmp-a" }), boxSummary({ id: "tmp-b" })] } });
  const ambiguous = await call(several.api, "box_lend_accounts", lendArgs);
  assert.ok(!ambiguous.ok && ambiguous.code === "LEND_NO_BOX" && ambiguous.message.includes("box_id"));
});

test("box_lend_accounts: a refusal passes through with its fix, from the preview (no card) and from the lend itself", async () => {
  const message = 'No Claude account "ada". Known: grace@acme.dev.';
  const { api } = fakeApi();
  api.on("POST", accountLendRoutes.preview("tmp-1"), { status: 404, body: { code: "ACCOUNT_NOT_FOUND", message } });
  const port = new FakeApprovalPort();
  const refused = await call(api, "box_lend_accounts", lendArgs, { port });
  assert.deepEqual(refused, { ok: false, code: "ACCOUNT_NOT_FOUND", message });
  assert.equal(port.cards.length, 0);

  const late = lendApi();
  late.api.on("POST", accountLendRoutes.box("tmp-1"), { status: 409, body: { code: "BOX_NOT_READY", message: "The VM is not connected." } });
  assert.deepEqual(await call(late.api, "box_lend_accounts", lendArgs), { ok: false, code: "BOX_NOT_READY", message: "The VM is not connected." });
});

test("list_boxes carries this chat's lends on every VM, project VMs included", async () => {
  const { api } = fakeApi();
  api.on("GET", accountLendRoutes.all, { status: 200, body: { lends: [lend({ boxId: "project-box", status: "renewal-failing", statusMessage: "Retrying." })] } });
  const listed = await call(api, "list_boxes", {});
  assert.ok(listed.ok);
  const [row] = listed.value.lent_accounts as Record<string, unknown>[];
  assert.deepEqual([row!.box_id, row!.id, row!.status, row!.lent_until], ["project-box", "acct-claude", "renewal-failing", "2026-11-03T21:40:00.000Z"]);
});

test("list_boxes while no box can be rented still answers with the chat's lends; a lend read that fails still fails", async () => {
  const { api } = fakeApi();
  api.on("GET", temporaryBoxRoutes.list, { status: 503, body: { code: "BOXES_DISABLED", message: "Temporary boxes are not available." } });
  api.on("GET", accountLendRoutes.all, { status: 200, body: { lends: [lend({ boxId: "project-box" })] } });
  const listed = await call(api, "list_boxes", {});
  assert.ok(listed.ok, listed.ok ? "" : listed.message);
  assert.deepEqual(listed.value.boxes, []);
  assert.equal((listed.value.lent_accounts as unknown[]).length, 1);
  api.on("GET", temporaryBoxRoutes.list, { status: 500, body: { code: "INTERNAL", message: "x" } });
  assert.ok(!(await call(api, "list_boxes", {})).ok);
});

test("box_return_accounts ends only this chat's lends on that VM, by name or all, with no card, while planning too", async () => {
  const lends = [
    lend({ boxId: "project-box", id: "l1" }),
    lend({ boxId: "project-box", id: "l2", agent: "codex", accountId: "acct-codex", label: "bob@acme.dev" }),
    lend({ boxId: "tmp-1", id: "l3" })
  ];
  const world = () => {
    const { api, deleted } = fakeApi();
    const ended: string[] = [];
    api.on("GET", accountLendRoutes.all, { status: 200, body: { lends } }).on("DELETE", "/api/boxes/*", ({ path }) => {
      ended.push(path);
      return { status: 200, body: { lends: [] } };
    });
    return { api, deleted, ended };
  };
  const port = new FakeApprovalPort();
  const all = world();
  const everything = await call(all.api, "box_return_accounts", {}, { port, caller: chat({ projectBoxId: "project-box", planning: true }) });
  assert.ok(everything.ok, everything.ok ? "" : everything.message);
  assert.deepEqual(all.ended, [accountLendRoutes.lend("project-box", "l1"), accountLendRoutes.lend("project-box", "l2")]);
  assert.equal(port.cards.length, 0);

  const named = world();
  const one = await call(named.api, "box_return_accounts", { box_id: "project-box", codex: ["bob", "nobody"] });
  assert.ok(one.ok);
  assert.deepEqual(named.ended, [accountLendRoutes.lend("project-box", "l2")]);
  assert.deepEqual(one.value.not_lent, ["nobody"]);

  // Two VMs and none named as this chat's own: it must say which.
  const unnamed = await call(world().api, "box_return_accounts", {});
  assert.ok(!unnamed.ok && unnamed.code === "LEND_NO_BOX");
});
