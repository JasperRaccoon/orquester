/**
 * Catalog family `boxes` (Ephemeral AI VMs spec §13): temporary cloud machines an agent chat rents
 * for a task — `create_box`, `list_boxes`, `box_exec`, `box_exec_output`, `box_upload`,
 * `box_download`, `box_forward_port`, `destroy_box`. Chat-only (like `request_secret`): external
 * MCP clients do not get them; the daemon advertises them only while the plugin can rent a box.
 *
 * - **Approval.** `create_box` spends the owner's money, so every call opens a `spend` card
 *   (`spendFamily`: in every permission mode, workflow-owned and agent-to-agent chats included,
 *   never grantable) showing provider, size, region, the estimated $/h, the time limit and the
 *   worst-case cost. The provider, size and region are resolved BEFORE the card (from the plugin's
 *   kinds and offers routes) and pinned: what the owner approved is what is rented.
 * - **Ownership** is the daemon's: the temporary-box routes and the `DaemonApi` box operations reach
 *   only the calling chat's own boxes (`boxes/temporary/tools.ts`).
 * - **Nothing is copied into a box**: the agent moves what it needs with `box_upload` /
 *   `box_download` (streamed by the daemon, never through JSON, host paths inside the chat's
 *   project).
 *
 * Everything goes through `DaemonApi` (D-1): this module imports types and pure contracts only.
 */

import { isAbsolute, resolve } from "node:path";

import { z } from "zod";
import {
  BOX_KIND_LABELS,
  BOX_KINDS,
  boxRoutes,
  isBoxProviderId,
  TEMPORARY_BOX_DEFAULT_LIFETIME_MINUTES,
  TEMPORARY_BOX_MAX_LIFETIME_MINUTES,
  TEMPORARY_BOX_MIN_LIFETIME_MINUTES,
  TEMPORARY_BOX_PURPOSE_MAX_CHARS,
  temporaryBoxRoutes,
  type ApprovalPreviewSection,
  type BoxKind,
  type BoxKindsResponse,
  type BoxOffersResponse,
  type BoxProviderId,
  type BoxProviderInfo,
  type BoxProvidersResponse,
  type BoxResponse,
  type BoxSizeOffer,
  type BoxSummary,
  type CreateTemporaryBoxRequest,
  type TemporaryBoxesResponse
} from "@orquester/api";

import type { BoxExecResult, BoxJobOutput, BoxOutputTail } from "../../boxes/temporary/contract.ts";
import { defineTool, DESTRUCTIVE, MUTATING, type AnyOrquesterTool, type ApprovalPreview, type ScopeClaim, type ScopeContext, type ThreadCaller } from "../catalog/contract.ts";
import type { DaemonApi, DaemonOutcome } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { clipText, MAX_ECHO_CHARS } from "../result.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const BOX_EXEC_DEFAULT_TIMEOUT_SECONDS = 600;
export const BOX_EXEC_MAX_TIMEOUT_SECONDS = 7_200;
export const BOX_EXEC_COMMAND_MAX_CHARS = 64 * 1024;
export const BOX_OUTPUT_MAX_WAIT_SECONDS = 600;

/** How long `create_box` waits for a box to become ready, per kind (Windows images and GPU marketplaces are slow). */
export const BOX_READY_TIMEOUT_MS: Readonly<Record<BoxKind, number>> = {
  linux: 15 * 60_000,
  "linux-gpu": 25 * 60_000,
  windows: 25 * 60_000,
  "windows-gpu": 30 * 60_000,
  macos: 20 * 60_000
};

/** The kind as the card's title says it: "Rent a Linux box". */
const KIND_WORDS: Readonly<Record<BoxKind, string>> = {
  linux: "Linux",
  "linux-gpu": "Linux + GPU",
  windows: "Windows",
  "windows-gpu": "Windows + GPU",
  macos: "macOS"
};

const SETUP_HINT = "Settings › Plugins › Ephemeral AI VMs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const boxIdField = z.string().trim().min(1).max(100).describe("A box id from create_box or list_boxes.");

function threadCaller(caller: ScopeContext["caller"], tool: string): ThreadCaller {
  if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", `${tool} is a chat tool.`);
  return caller;
}

/** A box operation's refusal as a tool error (the daemon's message is written for the agent). */
function unwrap<T>(outcome: DaemonOutcome<T>): T {
  if (!outcome.ok) throw new ToolError(outcome.code, outcome.message);
  return outcome.value;
}

const unwired = (): never => {
  throw new ToolError("BOXES_DISABLED", "Temporary boxes are not available right now.");
};

/** The claim of a call on the caller's own box: no project, the caller itself. */
function ownBoxScope(ctx: ScopeContext, reads: ScopeClaim["reads"], writes: boolean): ScopeClaim {
  return { projects: [], sessions: ctx.caller.kind === "thread" ? [ctx.caller.threadId] : [], self: "allow", reads, writes, causesTurnIn: [] };
}

/** A host path the agent gave: relative ones are taken from its cwd (else its project root). */
function hostPath(caller: ThreadCaller, path: string): string {
  if (caller.projectPath === "") throw new ToolError("NO_PROJECT", "This chat has no project, so there is nowhere on the host to move files from or to.");
  return isAbsolute(path) ? path : resolve(caller.cwd || caller.projectPath, path);
}

function money(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

/** Minutes as the card says them: "45 min", "2 h", "1 h 30 min", "3 d 4 h". */
export function durationLabel(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [days ? `${days} d` : "", hours ? `${hours} h` : "", mins && days === 0 ? `${mins} min` : ""].filter((part) => part !== "");
  return parts.length > 0 ? parts.join(" ") : "0 min";
}

function sizeLabel(size: BoxSizeOffer): string {
  const parts = [`${size.vcpu} vCPU`, `${size.ramGb} GB RAM`];
  if (size.diskGb !== null) parts.push(`${size.diskGb} GB disk`);
  if (size.gpu) parts.push(`GPU ${size.gpu.count}× ${size.gpu.model}${size.gpu.vramGb !== null ? ` (${size.gpu.vramGb} GB)` : ""}`);
  return `${size.label} — ${parts.join(" · ")}`;
}

/** An output tail as the agent reads it. */
function tail(prefix: string, output: BoxOutputTail): Record<string, unknown> {
  return { [prefix]: output.text, [`${prefix}_bytes`]: output.bytes, [`${prefix}_truncated`]: output.truncated };
}

/** A box as `list_boxes` and `destroy_box` show it. */
function boxView(box: BoxSummary): Record<string, unknown> {
  return {
    box_id: box.id,
    kind: box.kind,
    provider: box.provider,
    state: box.state,
    ...(box.stateReason ? { state_reason: box.stateReason } : {}),
    ...(box.destroyedReason ? { destroyed_reason: box.destroyedReason } : {}),
    os: box.os,
    arch: box.arch,
    connected: box.connected,
    hourly_usd: box.hourlyUsd,
    estimated_cost_usd: Math.round(box.estimatedCostUsd * 100) / 100,
    deadline: box.deadlineAt,
    purpose: box.purposeNote
  };
}

async function getJson<T>(api: DaemonApi, path: string, notFound: { code: string; message: string }): Promise<T> {
  const res = await api.request("GET", path);
  // A 404 that is not the plugin's own refusal (a `BOX_*` code): its routes are not there.
  const code = (res.body as { code?: unknown } | null)?.code;
  if (res.status === 404 && !(typeof code === "string" && code.startsWith("BOX"))) throw new ToolError(notFound.code, notFound.message);
  if (res.status >= 400) throw daemonError(res);
  return res.body as T;
}

const PLUGIN_OFF = { code: "BOXES_DISABLED", message: `The Ephemeral AI VMs plugin is not enabled. Ask the owner to turn it on and connect a provider in ${SETUP_HINT}.` };

// ---------------------------------------------------------------------------
// create_box: the plan the card shows and the run rents
// ---------------------------------------------------------------------------

export interface BoxPlan {
  kind: BoxKind;
  provider: BoxProviderInfo;
  size: BoxSizeOffer;
  region: { id: string; label: string };
  image: { id: string; label: string } | null;
  lifetimeMinutes: number;
  hourlyUsd: number | null;
}

/**
 * Resolve what `create_box` would rent from the plugin's routes: the provider (the requested one,
 * else the cheapest connected one for the kind), the size (requested, else the cheapest priced),
 * the region (requested, else the first the size is offered in), the time limit (default 2 h,
 * capped by the provider). Throws a refusal naming what to set up when nothing can rent the kind.
 */
export async function planBox(
  api: DaemonApi,
  args: { kind: BoxKind; provider?: string; size?: string; region?: string; lifetime_minutes?: number }
): Promise<BoxPlan> {
  const [kinds, providers] = await Promise.all([
    getJson<BoxKindsResponse>(api, boxRoutes.kinds, PLUGIN_OFF),
    getJson<BoxProvidersResponse>(api, boxRoutes.providers, PLUGIN_OFF)
  ]);
  const label = BOX_KIND_LABELS[args.kind];
  const availability = kinds.kinds.find((entry) => entry.kind === args.kind);
  const connected = availability?.providers ?? [];
  if (connected.length === 0) {
    const candidates = providers.providers.filter((provider) => provider.kinds.includes(args.kind)).map((provider) => provider.label);
    throw new ToolError(
      "BOX_PROVIDER_NOT_CONFIGURED",
      `No provider that rents ${label} boxes is set up. Ask the owner to connect one in ${SETUP_HINT}${candidates.length > 0 ? `: ${candidates.join(", ")}` : ""}.${args.kind === "macos" ? " macOS boxes need the Blacksmith setup there (a GitHub organisation with the Blacksmith app)." : ""}`
    );
  }
  if (availability?.unavailableReason) {
    throw new ToolError("BOX_CONNECTION_NOT_CONFIGURED", `${label} boxes cannot be rented right now: ${availability.unavailableReason} (${SETUP_HINT}).`);
  }
  let providerId: BoxProviderId;
  if (args.provider !== undefined) {
    if (!isBoxProviderId(args.provider) || !connected.includes(args.provider)) {
      throw new ToolError("INVALID_ARGUMENT", `provider must be one of the connected providers for ${label}: ${connected.join(", ")}.`);
    }
    providerId = args.provider;
  } else {
    providerId = connected[0]!;
  }
  const provider = providers.providers.find((entry) => entry.id === providerId);
  if (!provider) throw new ToolError("BOX_PROVIDER_NOT_CONFIGURED", `The provider ${providerId} is not set up (${SETUP_HINT}).`);
  const offers = await getJson<BoxOffersResponse>(api, boxRoutes.offers(providerId, args.kind), PLUGIN_OFF);

  let size: BoxSizeOffer | undefined;
  if (args.size !== undefined) {
    size = offers.sizes.find((offer) => offer.id === args.size);
    if (!size) throw new ToolError("INVALID_ARGUMENT", `${provider.label} has no ${label} size "${clipText(args.size, MAX_ECHO_CHARS)}". Sizes: ${offers.sizes.slice(0, 20).map((offer) => offer.id).join(", ")}.`);
  } else {
    // The cheapest priced size; unpriced ones only when none has a price.
    size = [...offers.sizes].sort((a, b) => (a.hourlyUsd ?? Number.POSITIVE_INFINITY) - (b.hourlyUsd ?? Number.POSITIVE_INFINITY))[0];
  }
  if (!size) throw new ToolError("BOX_PROVIDER_ERROR", `${provider.label} offers no ${label} size right now.`);
  const allowed = offers.regions.filter((region) => size!.regions.length === 0 || size!.regions.includes(region.id));
  let region: (typeof allowed)[number] | undefined = allowed[0];
  if (args.region !== undefined) {
    region = allowed.find((entry) => entry.id === args.region);
    if (!region) throw new ToolError("INVALID_ARGUMENT", `Size ${size.id} of ${provider.label} is not offered in region "${clipText(args.region, MAX_ECHO_CHARS)}". Regions: ${allowed.map((entry) => entry.id).join(", ")}.`);
  }
  if (!region) throw new ToolError("BOX_PROVIDER_ERROR", `${provider.label} offers size ${size.id} in no region right now.`);

  const max = provider.maxLifetimeMinutes ?? TEMPORARY_BOX_MAX_LIFETIME_MINUTES;
  const lifetimeMinutes = args.lifetime_minutes ?? Math.min(TEMPORARY_BOX_DEFAULT_LIFETIME_MINUTES, max);
  if (lifetimeMinutes > max) throw new ToolError("INVALID_ARGUMENT", `lifetime_minutes is at most ${max} with ${provider.label}.`);
  const image = offers.images[0] ? { id: offers.images[0].id, label: offers.images[0].label } : null;
  return {
    kind: args.kind,
    provider,
    size,
    region: { id: region.id, label: region.country ? `${region.label} (${region.country})` : region.label },
    image,
    lifetimeMinutes,
    hourlyUsd: size.hourlyUsd
  };
}

/** The card (spec §13.2): what is rented, what it costs per hour and at worst. */
export function boxCard(plan: BoxPlan, purpose: string, unattended: boolean): ApprovalPreview {
  const worst = plan.hourlyUsd !== null ? (plan.hourlyUsd * plan.lifetimeMinutes) / 60 : null;
  const sections: ApprovalPreviewSection[] = [
    { kind: "text", title: "Purpose", text: purpose },
    {
      kind: "fields",
      title: "The box",
      rows: [
        { label: "Provider", value: plan.provider.label },
        { label: "Size", value: sizeLabel(plan.size) },
        { label: "Region", value: plan.region.label },
        ...(plan.image ? [{ label: "Image", value: plan.image.label }] : []),
        { label: "Estimated price", value: plan.hourlyUsd !== null ? `${money(plan.hourlyUsd)}/h` : "unknown" },
        { label: "Time limit", value: durationLabel(plan.lifetimeMinutes) },
        { label: "Worst case", value: worst !== null ? `${money(worst)} if it runs the whole ${durationLabel(plan.lifetimeMinutes)}` : "unknown" }
      ]
    }
  ];
  if (plan.hourlyUsd === null) {
    sections.push({ kind: "warning", level: "caution", text: `${plan.provider.label} reported no price for this size: check its pricing before approving.` });
  }
  if (unattended) {
    sections.push({
      kind: "warning",
      level: "caution",
      text: "This chat runs unattended (an automated workflow, or a turn another agent started). It waits for your answer here; unanswered, it is denied after 30 minutes."
    });
  }
  sections.push({
    kind: "warning",
    level: "caution",
    text: `${plan.provider.label} bills your account from now until the box is destroyed: by the agent (destroy_box), at the time limit, or when this chat closes. Orquester copies nothing into the box; the agent decides what to upload.`
  });
  return { title: `Rent a ${KIND_WORDS[plan.kind]} box`, scopeLabel: `Billed to your ${plan.provider.label} account`, sections, pins: planPins(plan), ungrantable: true };
}

/** The approved plan, frozen with the card (`ApprovalPreview.pins`): what `run` rents. */
function planPins(plan: BoxPlan): Record<string, string> {
  return {
    provider: plan.provider.id,
    size: plan.size.id,
    region: plan.region.id,
    ...(plan.image ? { image: plan.image.id } : {}),
    lifetimeMinutes: String(plan.lifetimeMinutes)
  };
}

/** Destroy a box `create_box` gave up on (best effort: the reconciler catches what this misses). */
async function abandon(api: DaemonApi, boxId: string, reason: "agent" | "provisioning-failed"): Promise<void> {
  try {
    await api.request("DELETE", temporaryBoxRoutes.box(boxId), { query: { reason } });
  } catch {
    // The box service's own deadline and the reconciler tear down what this could not.
  }
}

const createBox = defineTool({
  name: "create_box",
  title: "Rent a temporary box",
  description:
    "Rent a cloud machine for this chat when the host can't do the job (another OS, a GPU, isolation). It COSTS the owner money: every box needs their approval on a card (up to 30 min); if denied, don't retry — ask. Then waits until it is ready (minutes; Windows and macOS longer). Orquester copies nothing in: send what you need with box_upload (e.g. a git bundle), run with box_exec, fetch results with box_download. Destroy it with destroy_box as soon as you are done; it is also destroyed at its time limit and when this chat closes.",
  input: {
    kind: z.enum(BOX_KINDS as unknown as [BoxKind, ...BoxKind[]]),
    provider: z.string().trim().min(1).max(40).optional().describe("A connected provider id; default: the cheapest for the kind."),
    size: z.string().trim().min(1).max(200).optional().describe("A size id; default: the cheapest."),
    region: z.string().trim().min(1).max(200).optional().describe("A region id; default: the first the size is offered in."),
    lifetime_minutes: z
      .number()
      .int()
      .min(TEMPORARY_BOX_MIN_LIFETIME_MINUTES)
      .max(TEMPORARY_BOX_MAX_LIFETIME_MINUTES)
      .optional()
      .describe("Time limit, then it is destroyed. Default 120; at most the provider's maximum."),
    purpose: z.string().trim().min(1).max(TEMPORARY_BOX_PURPOSE_MAX_CHARS).describe("What you need it for, shown to the owner.")
  },
  audiences: ["chat"],
  toolset: "boxes",
  tier: "act",
  spendFamily: "boxes",
  scope: async (_args, ctx) => ownBoxScope(ctx, "none", true),
  async approval(args, ctx) {
    const caller = threadCaller(ctx.caller, "create_box");
    const plan = await planBox(ctx.api, args);
    return boxCard(plan, args.purpose, caller.workflowOwned || caller.exchange !== null);
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  resultKind: "json",
  async run(args, ctx) {
    threadCaller(ctx.caller, "create_box");
    const pins = ctx.approval?.pins;
    // Fail closed: a box is rented only as a card showed it.
    if (!pins || !isBoxProviderId(pins.provider) || !pins.size || !pins.region || !pins.lifetimeMinutes) {
      throw new ToolError("PERMISSION_DENIED", "create_box needs the owner's approval on its card.");
    }
    const { api, signal } = ctx;
    if (!api.boxWaitReady) unwired();
    const body: CreateTemporaryBoxRequest = {
      kind: args.kind,
      provider: pins.provider,
      size: pins.size,
      region: pins.region,
      ...(pins.image ? { image: pins.image } : {}),
      lifetimeMinutes: Number(pins.lifetimeMinutes),
      purposeNote: args.purpose
    };
    const res = await api.request("POST", temporaryBoxRoutes.list, { body });
    if (res.status >= 400) throw daemonError(res);
    const created = (res.body as BoxResponse).box;
    if (signal.aborted) {
      await abandon(api, created.id, "agent");
      throw new ToolError("CANCELLED", "The call was cancelled; the box was destroyed.");
    }
    const ready = await api.boxWaitReady!(created.id, BOX_READY_TIMEOUT_MS[args.kind], { signal });
    if (!ready.ok) {
      const cancelled = signal.aborted || ready.code === "CANCELLED";
      await abandon(api, created.id, cancelled ? "agent" : "provisioning-failed");
      if (cancelled) throw new ToolError("CANCELLED", "The call was cancelled; the box was destroyed.");
      throw new ToolError(ready.code, `${ready.message} The box was destroyed; you may try again or another provider.`);
    }
    const box = ready.value;
    return {
      box_id: box.id,
      kind: box.kind,
      provider: box.provider,
      os: box.os,
      arch: box.arch,
      hourly_usd: box.hourlyUsd,
      deadline: box.deadlineAt,
      note: "Ready and empty: Orquester copied nothing into it. It bills until destroy_box, its deadline, or this chat closing."
    };
  }
});

const listBoxes = defineTool({
  name: "list_boxes",
  title: "List this chat's boxes",
  description: "This chat's temporary boxes: id, kind, provider, state, OS/arch, $/h, estimated cost so far, deadline.",
  input: {},
  audiences: ["chat"],
  toolset: "boxes",
  tier: "read",
  scope: async (_args, ctx) => ownBoxScope(ctx, "metadata", false),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  resultKind: "json",
  async run(_args, { api, caller }) {
    threadCaller(caller, "list_boxes");
    const res = await api.request("GET", temporaryBoxRoutes.list);
    if (res.status >= 400) throw daemonError(res);
    return { boxes: (res.body as TemporaryBoxesResponse).boxes.map(boxView) };
  }
});

const boxExec = defineTool({
  name: "box_exec",
  title: "Run a command in a box",
  description:
    "Run a command line in one of this chat's boxes (bash on Linux/macOS, PowerShell on Windows by default) and return exit code and output (the last 24 KB of stdout, 12 KB of stderr, with total byte counts). Long builds: background: true returns a job_id at once; read it with box_exec_output.",
  input: {
    box_id: boxIdField,
    command: z.string().min(1).max(BOX_EXEC_COMMAND_MAX_CHARS),
    shell: z.enum(["bash", "sh", "powershell", "cmd"]).optional(),
    cwd: z.string().min(1).max(4096).optional().describe("A path in the box; default: its user's home."),
    timeout_seconds: z.number().int().min(1).max(BOX_EXEC_MAX_TIMEOUT_SECONDS).optional().describe("Foreground only; default 600. The command is stopped then."),
    background: z.boolean().optional()
  },
  audiences: ["chat"],
  toolset: "boxes",
  tier: "act",
  scope: async (_args, ctx) => ownBoxScope(ctx, "content", true),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  resultKind: "json",
  async run(args, { api, caller, signal }) {
    threadCaller(caller, "box_exec");
    if (!api.boxExec) unwired();
    const result: BoxExecResult = unwrap(
      await api.boxExec!(
        args.box_id,
        {
          command: args.command,
          ...(args.shell ? { shell: args.shell } : {}),
          ...(args.cwd ? { cwd: args.cwd } : {}),
          timeoutSeconds: args.timeout_seconds ?? BOX_EXEC_DEFAULT_TIMEOUT_SECONDS,
          background: args.background === true
        },
        { signal }
      )
    );
    if (result.background) {
      return { job_id: result.jobId, shell: result.shell, started_at: result.startedAt, note: "Running in the background: read it with box_exec_output." };
    }
    const cut = result.stdout.truncated || result.stderr.truncated;
    return {
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
      ...(result.connectionLost ? { connection_lost: true } : {}),
      duration_ms: result.durationMs,
      ...tail("stdout", result.stdout),
      ...tail("stderr", result.stderr),
      ...(result.timedOut ? { note: "Stopped at the timeout: run long commands with background: true." } : cut ? { note: "Only the end of the output is shown: redirect to a file and box_download it for all of it." } : {})
    };
  }
});

const boxExecOutput = defineTool({
  name: "box_exec_output",
  title: "Read a background job",
  description: "A background job's state (running, exit code) and the last 32 KB of its output (stdout and stderr together). wait_seconds waits for it to finish first.",
  input: {
    box_id: boxIdField,
    job_id: z.string().trim().min(1).max(100),
    wait_seconds: z.number().int().min(0).max(BOX_OUTPUT_MAX_WAIT_SECONDS).optional()
  },
  audiences: ["chat"],
  toolset: "boxes",
  tier: "read",
  scope: async (_args, ctx) => ownBoxScope(ctx, "content", false),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  resultKind: "json",
  async run(args, { api, caller, signal }) {
    threadCaller(caller, "box_exec_output");
    if (!api.boxJobOutput) unwired();
    const job: BoxJobOutput = unwrap(await api.boxJobOutput!(args.box_id, args.job_id, (args.wait_seconds ?? 0) * 1000, { signal }));
    return {
      job_id: job.jobId,
      running: job.running,
      exit_code: job.exitCode,
      signal: job.signal,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
      ...tail("output", job.output),
      ...(job.lost ? { lost: job.lost } : {})
    };
  }
});

const transferInput = {
  box_id: boxIdField,
  local_path: z.string().min(1).max(4096).describe("A file or directory inside this chat's project (relative: from your cwd)."),
  remote_path: z.string().min(1).max(4096).describe("Its path in the box (relative: from the box user's home).")
};

const boxUpload = defineTool({
  name: "box_upload",
  title: "Copy into a box",
  description: "Copy a file or directory from this chat's project into one of its boxes, streamed. remote_path becomes the copy (a directory's contents land in it). Send only what the task needs; for a repo, a git bundle is compact.",
  input: transferInput,
  audiences: ["chat"],
  toolset: "boxes",
  tier: "act",
  scope: async (_args, ctx) => ownBoxScope(ctx, "content", true),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  resultKind: "json",
  async run(args, { api, caller, signal }) {
    const thread = threadCaller(caller, "box_upload");
    if (!api.boxUpload) unwired();
    const result = unwrap(await api.boxUpload!(args.box_id, { localPath: hostPath(thread, args.local_path), remotePath: args.remote_path }, { signal }));
    return { kind: result.kind, bytes: result.bytes, local_path: result.localPath, remote_path: result.remotePath };
  }
});

const boxDownload = defineTool({
  name: "box_download",
  title: "Copy out of a box",
  description: "Copy a file or directory from one of this chat's boxes into its project, streamed. local_path becomes the copy: an existing file is replaced, an existing directory is refused.",
  input: transferInput,
  audiences: ["chat"],
  toolset: "boxes",
  tier: "act",
  scope: async (_args, ctx) => ownBoxScope(ctx, "content", true),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  resultKind: "json",
  async run(args, { api, caller, signal }) {
    const thread = threadCaller(caller, "box_download");
    if (!api.boxDownload) unwired();
    const result = unwrap(await api.boxDownload!(args.box_id, { remotePath: args.remote_path, localPath: hostPath(thread, args.local_path) }, { signal }));
    return { kind: result.kind, bytes: result.bytes, local_path: result.localPath, remote_path: result.remotePath };
  }
});

const boxForwardPort = defineTool({
  name: "box_forward_port",
  title: "Forward a box port",
  description: "Expose a port of one of this chat's boxes (a dev server) on a host loopback URL the Browser tab can open. Closed when the box is destroyed.",
  input: { box_id: boxIdField, port: z.number().int().min(1).max(65_535) },
  audiences: ["chat"],
  toolset: "boxes",
  tier: "act",
  scope: async (_args, ctx) => ownBoxScope(ctx, "none", true),
  annotations: { ...MUTATING, idempotentHint: true, openWorldHint: false },
  resultKind: "json",
  async run(args, { api, caller, signal }) {
    threadCaller(caller, "box_forward_port");
    if (!api.boxForwardPort) unwired();
    const forward = unwrap(await api.boxForwardPort!(args.box_id, args.port, { signal }));
    return { url: forward.url, host_port: forward.hostPort, box_port: forward.boxPort };
  }
});

const destroyBox = defineTool({
  name: "destroy_box",
  title: "Destroy a box",
  description: "Destroy one of this chat's boxes and stop its billing; waits for the provider to confirm. Everything in it is lost: box_download what you need first.",
  input: { box_id: boxIdField },
  audiences: ["chat"],
  toolset: "boxes",
  tier: "act",
  // Stopping spend is never refused while planning.
  planSafe: true,
  scope: async (_args, ctx) => ownBoxScope(ctx, "none", true),
  annotations: { ...DESTRUCTIVE, openWorldHint: true },
  resultKind: "json",
  async run(args, { api, caller }) {
    threadCaller(caller, "destroy_box");
    const res = await api.request("DELETE", temporaryBoxRoutes.box(args.box_id), { query: { reason: "agent" } });
    if (res.status >= 400) throw daemonError(res);
    return boxView((res.body as BoxResponse).box);
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const boxesFamily: readonly AnyOrquesterTool[] = [createBox, listBoxes, boxExec, boxExecOutput, boxUpload, boxDownload, boxForwardPort, destroyBox];
