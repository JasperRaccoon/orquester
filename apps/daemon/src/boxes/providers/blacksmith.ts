/**
 * Blacksmith boxes (spec §11.2; Devices phase 2 §2 goal 1): a box is one run of the workflow in
 * the owner's private control repo — macOS on a Blacksmith M4 runner, or Linux on a Blacksmith x64
 * runner (nested virtualization: `/dev/kvm` for Android emulators). There is no provider API key:
 * the service passes the Git hosting account chosen in the Blacksmith setup as credentials
 * `{ githubToken, org, repo }` (repo = `owner/name`; default `<org>/orquester-macos-boxes`), plus
 * the Tailscale identity the runs join with, when they do. The token stays on the host; the run
 * receives only the box id, lifetime, daemon URL, runner label, OS and what to prepare, and
 * authenticates to the daemon with its GitHub OIDC token (`github/oidc.ts`).
 *
 * Each create first re-commits the control repo's workflows whose template changed (phase 2 §5),
 * so orgs set up by an older build pick up new inputs. {@link dispatchDeviceCacheWarm} starts the
 * device-cache workflow for the device service.
 *
 * Instance ref: `{ repository, runId, workflowFile, runner, htmlUrl }`.
 */

import { randomUUID } from "node:crypto";

import type {
  BoxProviderAdapter,
  ProviderCallOptions,
  ProviderCreateRequest,
  ProviderCreateResult,
  ProviderCredentials,
  ProviderInstanceRef,
  ProviderInstanceState,
  ProviderInstanceStatus,
  ProviderManagedInstance,
  ProviderOffers
} from "../contracts.ts";
import { ORQ_AGENT_ENV } from "../bootstrap/bootstrap.ts";
import {
  cancelRun,
  checkGithubAccount,
  dispatchBoxRun,
  dispatchWorkflowRun,
  ensureControlWorkflows,
  forceCancelRun,
  getControlRepo,
  getRun,
  getRunJobs,
  listRecentRuns,
  waitRunCompleted,
  type ControlRepo,
  type GithubCallOptions,
  type WorkflowRun
} from "../github/control-repo.ts";
import {
  BLACKSMITH_CONTROL_REPO_NAME,
  BLACKSMITH_DEFAULT_IMAGE,
  BLACKSMITH_DEFAULT_LINUX_IMAGE,
  BLACKSMITH_DEVICE_CACHE_WORKFLOW_FILE,
  BLACKSMITH_IMAGES,
  BLACKSMITH_LINUX_IMAGES,
  BLACKSMITH_LINUX_SIZES,
  BLACKSMITH_MAX_LIFETIME_MINUTES,
  BLACKSMITH_SIZES,
  BLACKSMITH_WORKFLOW_FILE,
  blacksmithRunnerLabel,
  blacksmithRunnerOs,
  isBlacksmithImage,
  isBlacksmithLinuxImage,
  type BlacksmithDeviceCacheInputs,
  type BlacksmithOs,
  type BlacksmithSizeInfo,
  type BlacksmithWorkflowOptions
} from "../github/workflow-template.ts";
import { boxIdFromInstanceName, isAuthError } from "./http.ts";

/** Credential keys the service passes (from the Blacksmith setup and the chosen Git hosting account). */
export const BLACKSMITH_CREDENTIAL_KEYS = {
  githubToken: "githubToken",
  org: "org",
  repo: "repo",
  /** The Tailscale federated identity the runs join the tailnet with (both set, or neither). */
  tailscaleClientId: "tailscaleClientId",
  tailscaleAudience: "tailscaleAudience"
} as const;

/** Blacksmith runners run in one place; the offers show one region. */
export const BLACKSMITH_REGION = "blacksmith";

/** How long a cancel may take before force-cancel, and how long force-cancel may take. */
const CANCEL_WAIT_MS = 90_000;
const FORCE_CANCEL_WAIT_MS = 120_000;

/** The runner the cache-warming run uses when the device service names none. */
const DEVICE_CACHE_DEFAULT_SIZES: Readonly<Record<BlacksmithOs, string>> = { linux: "8vcpu", macos: "6vcpu" };

interface BlacksmithAccess {
  token: string;
  org: string;
  repository: string;
}

function access(credentials: ProviderCredentials): BlacksmithAccess {
  const token = credentials[BLACKSMITH_CREDENTIAL_KEYS.githubToken]?.trim();
  const org = credentials[BLACKSMITH_CREDENTIAL_KEYS.org]?.trim();
  if (!token || !org) throw new Error("Blacksmith: finish the macOS setup (Git hosting account and GitHub org) first");
  const repository = credentials[BLACKSMITH_CREDENTIAL_KEYS.repo]?.trim() || `${org}/${BLACKSMITH_CONTROL_REPO_NAME}`;
  return { token, org, repository };
}

function github(credentials: ProviderCredentials, options: ProviderCallOptions): GithubCallOptions & BlacksmithAccess {
  const resolved = access(credentials);
  return { ...resolved, signal: options.signal, fetch: options.fetch };
}

/** The template options the setup committed the workflow with (the Tailscale join). */
function workflowOptions(credentials: ProviderCredentials): BlacksmithWorkflowOptions {
  const oauthClientId = credentials[BLACKSMITH_CREDENTIAL_KEYS.tailscaleClientId]?.trim();
  const audience = credentials[BLACKSMITH_CREDENTIAL_KEYS.tailscaleAudience]?.trim();
  return oauthClientId && audience ? { tailscale: { oauthClientId, audience } } : {};
}

/** The control repo with its workflows as this build writes them (re-committed when stale). */
async function readyControlRepo(credentials: ProviderCredentials, call: GithubCallOptions & BlacksmithAccess): Promise<ControlRepo> {
  const repo = await getControlRepo(call.repository, call);
  if (repo === null) throw new Error(`Blacksmith: the control repo ${call.repository} is missing; run the Blacksmith setup again`);
  await ensureControlWorkflows(repo, workflowOptions(credentials), call);
  return repo;
}

function hourly(size: BlacksmithSizeInfo<string>): number {
  return Math.round(size.perMinuteUsd * 60 * 100) / 100;
}

/** The runner label for a kind, size and image (defaults: the OS's default image); throws on unknown values. */
function runnerFor(os: BlacksmithOs, size: string, image: string | null): { runner: string; size: BlacksmithSizeInfo<string> } {
  if (os === "linux") {
    const info = BLACKSMITH_LINUX_SIZES.find((candidate) => candidate.id === size);
    if (info === undefined) throw new Error(`Blacksmith: unknown Linux size ${size}`);
    const chosen = image ?? BLACKSMITH_DEFAULT_LINUX_IMAGE;
    if (!isBlacksmithLinuxImage(chosen)) throw new Error(`Blacksmith: unknown Linux image ${chosen}`);
    return { runner: blacksmithRunnerLabel(info.id, chosen), size: info };
  }
  const info = BLACKSMITH_SIZES.find((candidate) => candidate.id === size);
  if (info === undefined) throw new Error(`Blacksmith: unknown size ${size}`);
  const chosen = image ?? BLACKSMITH_DEFAULT_IMAGE;
  if (!isBlacksmithImage(chosen)) throw new Error(`Blacksmith: unknown macOS version ${chosen}`);
  return { runner: blacksmithRunnerLabel(info.id, chosen), size: info };
}

/** "macOS" or "Linux" for a box's run (its runner label; macOS for refs without one). */
function runOsLabel(ref: ProviderInstanceRef): string {
  return blacksmithRunnerOs(ref.runner) === "linux" ? "Linux" : "macOS";
}

function refFields(ref: ProviderInstanceRef): { repository: string; runId: string } {
  const repository = ref.repository;
  const runId = ref.runId;
  if (typeof repository !== "string" || (typeof runId !== "string" && typeof runId !== "number")) {
    throw new Error("Blacksmith: the box record has no workflow run reference");
  }
  return { repository, runId: String(runId) };
}

function runState(run: WorkflowRun): ProviderInstanceState {
  if (run.status === "completed") return "gone";
  return run.status === "in_progress" ? "running" : "pending";
}

function completedDetail(run: WorkflowRun, os: string): string {
  switch (run.conclusion) {
    case "cancelled":
      return `The ${os} run was cancelled`;
    case "timed_out":
      return `${os} time limit reached`;
    case "success":
      return `The ${os} run ended`;
    case "failure":
      return `The ${os} run failed`;
    default:
      return `The ${os} run ended (${run.conclusion ?? "unknown"})`;
  }
}

/**
 * GitHub answers 404 for a private repo the token cannot see as for a missing one: a run's 404
 * means it was deleted only while its control repo is still visible. Throws otherwise.
 */
async function assertRepoVisible(repository: string, call: GithubCallOptions, os = "macOS"): Promise<void> {
  if ((await getControlRepo(repository, call)) !== null) return;
  throw new Error(
    `Blacksmith: the control repo ${repository} is not visible to the Git hosting account (deleted, renamed, or access removed), so the ${os} run's state cannot be confirmed; check it on GitHub`
  );
}

export const BLACKSMITH_ADAPTER: BoxProviderAdapter = {
  id: "blacksmith",
  label: "Blacksmith",
  kinds: ["macos", "linux"],
  website: "https://www.blacksmith.sh",
  credentialsUrl: "https://app.blacksmith.sh",
  credentialFields: [],
  accountNote:
    "macOS and Linux (x64, with KVM) boxes run as GitHub Actions jobs on Blacksmith in a private repo of your GitHub org. Set it up here with a connected Git hosting account; Blacksmith bills the org.",
  maxLifetimeMinutes: BLACKSMITH_MAX_LIFETIME_MINUTES,

  async validate(credentials, options) {
    let call: GithubCallOptions & BlacksmithAccess;
    try {
      call = github(credentials, options);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    try {
      const account = await checkGithubAccount(call.org, call);
      if (account.problem !== null) return { ok: false, message: account.problem };
      const repo = await getControlRepo(call.repository, call);
      if (repo === null) return { ok: false, message: `The control repo ${call.repository} does not exist yet; run the macOS setup` };
      return { ok: true };
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      if (isAuthError(error)) return { ok: false, message: "GitHub rejected the Git hosting account's token" };
      return { ok: false, message: (error as Error).message };
    }
  },

  async offers(_credentials, kind): Promise<ProviderOffers> {
    if (kind !== "macos" && kind !== "linux") return { sizes: [], regions: [], images: [], priceSource: "table" };
    return {
      sizes: (kind === "linux" ? BLACKSMITH_LINUX_SIZES : BLACKSMITH_SIZES).map((size) => ({
        id: size.id,
        label: size.label,
        vcpu: size.vcpu,
        ramGb: size.ramGb,
        diskGb: null,
        gpu: null,
        hourlyUsd: hourly(size),
        regions: []
      })),
      regions: [{ id: BLACKSMITH_REGION, label: "Blacksmith", country: null }],
      images: (kind === "linux" ? BLACKSMITH_LINUX_IMAGES : BLACKSMITH_IMAGES).map((image) => ({ id: image.id, label: image.label })),
      priceSource: "table"
    };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    if (request.kind !== "macos" && request.kind !== "linux") throw new Error("Blacksmith rents macOS and Linux boxes only");
    const os: BlacksmithOs = request.kind;
    const call = github(credentials, options);
    const { runner, size } = runnerFor(os, request.size, request.image);
    const daemonUrl = request.bootstrap.env[ORQ_AGENT_ENV.daemonUrl];
    if (!daemonUrl) throw new Error("Blacksmith: the bootstrap has no daemon URL");
    const lifetime = Math.min(
      BLACKSMITH_MAX_LIFETIME_MINUTES,
      Math.max(1, Math.floor(request.lifetimeMinutes ?? BLACKSMITH_MAX_LIFETIME_MINUTES))
    );

    const repo = await readyControlRepo(credentials, call);
    const startedAt = Date.now();
    // The run is named orq-<boxId> by the workflow's run-name, so the reconciler finds it even
    // if this call fails after GitHub accepted the dispatch.
    const run = await dispatchBoxRun(
      {
        repository: repo.repository,
        workflowFile: BLACKSMITH_WORKFLOW_FILE,
        ref: repo.defaultBranch,
        inputs: {
          box_id: request.boxId,
          lifetime_minutes: String(lifetime),
          daemon_url: daemonUrl,
          runner,
          os,
          prepare: request.prepare ?? "none"
        }
      },
      { ...call, deadlineMs: 60_000 }
    );
    return {
      ref: { repository: repo.repository, runId: String(run.runId), workflowFile: BLACKSMITH_WORKFLOW_FILE, runner, htmlUrl: run.htmlUrl },
      hourlyUsd: hourly(size),
      deadlineAt: new Date(startedAt + lifetime * 60_000).toISOString()
    };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const call = github(credentials, options);
    const { repository, runId } = refFields(ref);
    const run = await getRun(repository, runId, call);
    const os = runOsLabel(ref);
    if (run === null) {
      await assertRepoVisible(repository, call, os);
      return { state: "gone", detail: `The ${os} run was deleted on GitHub`, publicIp: null, hourlyUsd: null };
    }
    if (run.status === "completed") return { state: "gone", detail: completedDetail(run, os), publicIp: null, hourlyUsd: null };
    // A run is in_progress as soon as GitHub schedules it; the box exists once its job has a runner.
    const jobs = await getRunJobs(repository, runId, call);
    const running = jobs.some((job) => job.status === "in_progress");
    return {
      state: running ? "running" : "pending",
      detail: running ? null : `Waiting for a Blacksmith ${os} runner`,
      publicIp: null,
      hourlyUsd: null
    };
  },

  async destroy(credentials, ref, options): Promise<void> {
    const call = github(credentials, options);
    const { repository, runId } = refFields(ref);
    const run = await getRun(repository, runId, call);
    if (run === null) return assertRepoVisible(repository, call, runOsLabel(ref));
    if (run.status === "completed") return;
    // A plain cancel first (orq-agent may already be exiting on the service's request), then force.
    await cancelRun(repository, runId, call);
    const after = await waitRunCompleted(repository, runId, { ...call, deadlineMs: CANCEL_WAIT_MS });
    if (after !== "timeout") return;
    await forceCancelRun(repository, runId, call);
    const forced = await waitRunCompleted(repository, runId, { ...call, deadlineMs: FORCE_CANCEL_WAIT_MS });
    if (forced === "timeout") throw new Error(`Blacksmith: the ${runOsLabel(ref)} run ${runId} did not stop after a force-cancel`);
  },

  async listManaged(credentials, options): Promise<ProviderManagedInstance[]> {
    const call = github(credentials, options);
    // A box run lives at most BLACKSMITH_MAX_LIFETIME_MINUTES plus its queue time.
    const since = new Date(Date.now() - (BLACKSMITH_MAX_LIFETIME_MINUTES + 24 * 60) * 60_000);
    const runs = await listRecentRuns(call.repository, BLACKSMITH_WORKFLOW_FILE, { ...call, since });
    return runs
      .filter((run) => run.status !== "completed" && run.displayTitle.startsWith("orq-"))
      .map((run) => ({
        ref: { repository: call.repository, runId: String(run.id), workflowFile: BLACKSMITH_WORKFLOW_FILE, htmlUrl: run.htmlUrl },
        name: run.displayTitle,
        boxId: boxIdFromInstanceName(run.displayTitle),
        createdAt: run.createdAt,
        state: runState(run)
      }));
  }
};

// ---------------------------------------------------------------------------
// Device caches (Devices phase 2 §2 goal 6)
// ---------------------------------------------------------------------------

export interface DeviceCacheWarmRequest {
  os: BlacksmithOs;
  /** A size id of the OS (default {@link DEVICE_CACHE_DEFAULT_SIZES}). */
  size?: string;
  /** An image id of the OS (default: the OS's default image — the one device hosts use). */
  image?: string;
}

export interface DeviceCacheWarmRun {
  /** The workflow run id (`deviceCacheWarmStatus` takes it). */
  runId: string;
  htmlUrl: string | null;
  runner: string;
}

export interface DeviceCacheWarmStatus {
  runId: string;
  /** `queued` until a runner picks the job up; `gone` when the run no longer exists. */
  state: "queued" | "running" | "completed" | "gone";
  /** GitHub's conclusion once completed: `success` means the caches exist now. */
  conclusion: string | null;
  htmlUrl: string | null;
}

/**
 * Start the device-cache workflow for one OS (re-committing the control repo's workflows first
 * when they are stale). Builds and saves what is missing; caches that exist are only looked up.
 * Bills the org for the run's minutes.
 */
export async function dispatchDeviceCacheWarm(
  credentials: ProviderCredentials,
  request: DeviceCacheWarmRequest,
  options: ProviderCallOptions
): Promise<DeviceCacheWarmRun> {
  if (request.os !== "macos" && request.os !== "linux") throw new Error(`Blacksmith: unknown OS ${String(request.os)}`);
  const call = github(credentials, options);
  const { runner } = runnerFor(request.os, request.size ?? DEVICE_CACHE_DEFAULT_SIZES[request.os], request.image ?? null);
  const repo = await readyControlRepo(credentials, call);
  const inputs: BlacksmithDeviceCacheInputs = { request_id: randomUUID(), os: request.os, runner };
  const run = await dispatchWorkflowRun(
    {
      repository: repo.repository,
      workflowFile: BLACKSMITH_DEVICE_CACHE_WORKFLOW_FILE,
      ref: repo.defaultBranch,
      inputs: { ...inputs },
      runName: `orq-cache-${inputs.os}-${inputs.request_id}`
    },
    { ...call, deadlineMs: 60_000 }
  );
  return { runId: String(run.runId), htmlUrl: run.htmlUrl, runner };
}

/** A device-cache run's state (one GitHub call). */
export async function deviceCacheWarmStatus(
  credentials: ProviderCredentials,
  runId: string,
  options: ProviderCallOptions
): Promise<DeviceCacheWarmStatus> {
  const call = github(credentials, options);
  const run = await getRun(call.repository, runId, call);
  if (run === null) {
    await assertRepoVisible(call.repository, call, "device cache");
    return { runId, state: "gone", conclusion: null, htmlUrl: null };
  }
  const state = run.status === "completed" ? "completed" : run.status === "in_progress" ? "running" : "queued";
  return { runId, state, conclusion: run.status === "completed" ? run.conclusion : null, htmlUrl: run.htmlUrl };
}
