/**
 * Blacksmith macOS boxes (spec §11.2): a box is one run of the workflow in the
 * owner's private control repo, on a Blacksmith M4 runner. There is no provider
 * API key: the service passes the Git hosting account chosen in the Blacksmith
 * setup as credentials `{ githubToken, org, repo }` (repo = `owner/name`; default
 * `<org>/orquester-macos-boxes`). The token stays on the host; the run receives
 * only the box id, lifetime, daemon URL and runner label, and authenticates to
 * the daemon with its GitHub OIDC token (`github/oidc.ts`).
 *
 * Instance ref: `{ repository, runId, workflowFile, runner, htmlUrl }`.
 */

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
  forceCancelRun,
  getControlRepo,
  getRun,
  getRunJobs,
  listRecentRuns,
  waitRunCompleted,
  type GithubCallOptions,
  type WorkflowRun
} from "../github/control-repo.ts";
import {
  BLACKSMITH_CONTROL_REPO_NAME,
  BLACKSMITH_DEFAULT_IMAGE,
  BLACKSMITH_IMAGES,
  BLACKSMITH_MAX_LIFETIME_MINUTES,
  BLACKSMITH_SIZES,
  BLACKSMITH_WORKFLOW_FILE,
  blacksmithRunnerLabel,
  isBlacksmithImage,
  isBlacksmithSize
} from "../github/workflow-template.ts";
import { boxIdFromInstanceName, isAuthError } from "./http.ts";

/** Credential keys the service passes (from the Blacksmith setup and the chosen Git hosting account). */
export const BLACKSMITH_CREDENTIAL_KEYS = { githubToken: "githubToken", org: "org", repo: "repo" } as const;

/** Blacksmith macOS runners run in one place; the offers show one region. */
export const BLACKSMITH_REGION = "blacksmith";

/** How long a cancel may take before force-cancel, and how long force-cancel may take. */
const CANCEL_WAIT_MS = 90_000;
const FORCE_CANCEL_WAIT_MS = 120_000;

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

function completedDetail(run: WorkflowRun): string {
  switch (run.conclusion) {
    case "cancelled":
      return "The macOS run was cancelled";
    case "timed_out":
      return "macOS time limit reached";
    case "success":
      return "The macOS run ended";
    case "failure":
      return "The macOS run failed";
    default:
      return `The macOS run ended (${run.conclusion ?? "unknown"})`;
  }
}

export const BLACKSMITH_ADAPTER: BoxProviderAdapter = {
  id: "blacksmith",
  label: "Blacksmith",
  kinds: ["macos"],
  website: "https://www.blacksmith.sh",
  credentialsUrl: "https://app.blacksmith.sh",
  credentialFields: [],
  accountNote:
    "macOS boxes run as GitHub Actions jobs on Blacksmith in a private repo of your GitHub org. Set it up in the macOS section with a connected Git hosting account; Blacksmith bills the org.",
  maxLifetimeMinutes: BLACKSMITH_MAX_LIFETIME_MINUTES,
  needsWindowsImage: false,

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
    if (kind !== "macos") return { sizes: [], regions: [], images: [], priceSource: "table" };
    return {
      sizes: BLACKSMITH_SIZES.map((size) => ({
        id: size.id,
        label: size.label,
        vcpu: size.vcpu,
        ramGb: size.ramGb,
        diskGb: null,
        gpu: null,
        hourlyUsd: Math.round(size.perMinuteUsd * 60 * 100) / 100,
        regions: []
      })),
      regions: [{ id: BLACKSMITH_REGION, label: "Blacksmith", country: null }],
      images: BLACKSMITH_IMAGES.map((image) => ({ id: image.id, label: image.label })),
      priceSource: "table"
    };
  },

  async create(credentials, request: ProviderCreateRequest, options): Promise<ProviderCreateResult> {
    if (request.kind !== "macos") throw new Error("Blacksmith rents macOS boxes only");
    const call = github(credentials, options);
    const size = BLACKSMITH_SIZES.find((candidate) => candidate.id === request.size);
    if (!isBlacksmithSize(request.size) || size === undefined) throw new Error(`Blacksmith: unknown size ${request.size}`);
    const image = request.image ?? BLACKSMITH_DEFAULT_IMAGE;
    if (!isBlacksmithImage(image)) throw new Error(`Blacksmith: unknown macOS version ${image}`);
    const daemonUrl = request.bootstrap.env[ORQ_AGENT_ENV.daemonUrl];
    if (!daemonUrl) throw new Error("Blacksmith: the bootstrap has no daemon URL");
    const lifetime = Math.min(
      BLACKSMITH_MAX_LIFETIME_MINUTES,
      Math.max(1, Math.floor(request.lifetimeMinutes ?? BLACKSMITH_MAX_LIFETIME_MINUTES))
    );
    const runner = blacksmithRunnerLabel(request.size, image);

    const repo = await getControlRepo(call.repository, call);
    if (repo === null) throw new Error(`Blacksmith: the control repo ${call.repository} is missing; run the macOS setup again`);
    const startedAt = Date.now();
    // The run is named orq-<boxId> by the workflow's run-name, so the reconciler finds it even
    // if this call fails after GitHub accepted the dispatch.
    const run = await dispatchBoxRun(
      {
        repository: repo.repository,
        workflowFile: BLACKSMITH_WORKFLOW_FILE,
        ref: repo.defaultBranch,
        inputs: { box_id: request.boxId, lifetime_minutes: String(lifetime), daemon_url: daemonUrl, runner }
      },
      { ...call, deadlineMs: 60_000 }
    );
    return {
      ref: { repository: repo.repository, runId: String(run.runId), workflowFile: BLACKSMITH_WORKFLOW_FILE, runner, htmlUrl: run.htmlUrl },
      hourlyUsd: Math.round(size.perMinuteUsd * 60 * 100) / 100,
      deadlineAt: new Date(startedAt + lifetime * 60_000).toISOString()
    };
  },

  async status(credentials, ref, options): Promise<ProviderInstanceStatus> {
    const call = github(credentials, options);
    const { repository, runId } = refFields(ref);
    const run = await getRun(repository, runId, call);
    if (run === null) return { state: "gone", detail: "The macOS run was deleted on GitHub", publicIp: null, hourlyUsd: null };
    if (run.status === "completed") return { state: "gone", detail: completedDetail(run), publicIp: null, hourlyUsd: null };
    // A run is in_progress as soon as GitHub schedules it; the box exists once its job has a runner.
    const jobs = await getRunJobs(repository, runId, call);
    const running = jobs.some((job) => job.status === "in_progress");
    return {
      state: running ? "running" : "pending",
      detail: running ? null : "Waiting for a Blacksmith macOS runner",
      publicIp: null,
      hourlyUsd: null
    };
  },

  async destroy(credentials, ref, options): Promise<void> {
    const call = github(credentials, options);
    const { repository, runId } = refFields(ref);
    const run = await getRun(repository, runId, call);
    if (run === null || run.status === "completed") return;
    // A plain cancel first (orq-agent may already be exiting on the service's request), then force.
    await cancelRun(repository, runId, call);
    const after = await waitRunCompleted(repository, runId, { ...call, deadlineMs: CANCEL_WAIT_MS });
    if (after !== "timeout") return;
    await forceCancelRun(repository, runId, call);
    const forced = await waitRunCompleted(repository, runId, { ...call, deadlineMs: FORCE_CANCEL_WAIT_MS });
    if (forced === "timeout") throw new Error(`Blacksmith: the macOS run ${runId} did not stop after a force-cancel`);
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
