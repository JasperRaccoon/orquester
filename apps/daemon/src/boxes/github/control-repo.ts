/**
 * The Blacksmith control repo (spec §11.2), over the GitHub REST API with a Git
 * hosting account's token (a classic PAT with `repo` + `workflow`; the caller
 * reads it from the accounts store — nothing here touches files). The token is
 * sent only to api.github.com and never appears in errors.
 *
 * Setup: {@link checkGithubAccount} → {@link detectBlacksmithApp} →
 * {@link ensureControlRepo} → {@link ensureControlWorkflows} → {@link waitWorkflowReady}.
 * Boxes: {@link ensureControlWorkflows} (each create: a changed template is re-committed),
 * {@link dispatchBoxRun}, {@link getRun}, {@link getRunJobs}, {@link cancelRun} /
 * {@link forceCancelRun}, {@link listRecentRuns}. Device caches: {@link dispatchWorkflowRun}.
 */

import { createHash } from "node:crypto";

import type { ProviderCallOptions } from "../contracts.ts";
import { providerRequest, ProviderHttpError } from "../providers/http.ts";
import {
  BLACKSMITH_CONTROL_REPO_NAME,
  BLACKSMITH_DEVICE_CACHE_WORKFLOW_PATH,
  BLACKSMITH_WORKFLOW_PATH,
  blacksmithDeviceCacheWorkflowTemplate,
  blacksmithWorkflowTemplate,
  type BlacksmithWorkflowInputs,
  type BlacksmithWorkflowOptions
} from "./workflow-template.ts";

const PROVIDER = "GitHub";
const DEFAULT_API = "https://api.github.com";

export const BLACKSMITH_APP_SLUG = "blacksmith-sh";
export const BLACKSMITH_APP_INSTALL_URL = "https://github.com/apps/blacksmith-sh/installations/new";
/** Scopes the classic token needs: create the private repo, commit a workflow file, dispatch and cancel runs. */
export const REQUIRED_GITHUB_SCOPES: readonly string[] = ["repo", "workflow"];

export interface GithubCallOptions extends ProviderCallOptions {
  token: string;
  /** Default https://api.github.com (GitHub Enterprise: `https://host/api/v3`). */
  apiUrl?: string;
}

function headers(options: GithubCallOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${options.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "orquester-boxes"
  };
}

async function gh<T>(
  options: GithubCallOptions,
  request: { method?: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown; okStatuses?: readonly number[]; attempts?: number }
): Promise<{ status: number; headers: Headers; data: T }> {
  return providerRequest<T>(
    PROVIDER,
    {
      method: request.method ?? "GET",
      url: `${options.apiUrl ?? DEFAULT_API}${request.path}`,
      headers: headers(options),
      body: request.body,
      okStatuses: request.okStatuses,
      attempts: request.attempts
    },
    options
  );
}

function repoPath(repository: string): string {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) throw new Error(`Not an owner/name repository: ${repository}`);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A poll's deadline passed. */
export class GithubPollTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubPollTimeoutError";
  }
}

/** Poll with exponential backoff until `attempt` returns a value or the deadline passes. */
async function pollUntil<T>(
  attempt: () => Promise<T | undefined>,
  options: { signal: AbortSignal; deadlineMs: number; firstDelayMs?: number; maxDelayMs?: number; timeoutMessage: () => string }
): Promise<T> {
  const deadline = Date.now() + options.deadlineMs;
  let delay = options.firstDelayMs ?? 1000;
  for (;;) {
    const result = await attempt();
    if (result !== undefined) return result;
    const left = deadline - Date.now();
    if (left <= 0) throw new GithubPollTimeoutError(options.timeoutMessage());
    await abortableDelay(Math.min(delay, left), options.signal);
    delay = Math.min(delay * 2, options.maxDelayMs ?? 10_000);
  }
}

// ---------------------------------------------------------------------------
// Account checks
// ---------------------------------------------------------------------------

export interface GithubAccountCheck {
  login: string;
  /** From `X-OAuth-Scopes`; null for tokens that report none (fine-grained tokens, apps). */
  scopes: string[] | null;
  /** Required scopes the token lacks (all of them when `scopes` is null). */
  missingScopes: string[];
  /** The account's role in the org; null when it is not a member. */
  orgRole: "admin" | "member" | null;
  /** `pending` = invited but not accepted yet. */
  membershipState: "active" | "pending" | null;
  /** Whether the account can create private repos in the org; null when GitHub does not say (members of some orgs). */
  canCreateRepo: boolean | null;
  /** One line for the setup step when something is missing, else null. */
  problem: string | null;
}

/** `X-OAuth-Scopes` grants `scope` (`repo` covers nothing broader; `admin:org` covers `read:org`). */
function hasScope(scopes: string[], scope: string): boolean {
  if (scopes.includes(scope)) return true;
  if (scope === "read:org") return scopes.includes("admin:org") || scopes.includes("write:org");
  return false;
}

export type GithubTokenCheck = Pick<GithubAccountCheck, "login" | "scopes" | "missingScopes" | "problem">;

/** Check the token's scopes alone (one `GET /user`, no org). Throws on network/server failures and a rejected token. */
export async function checkGithubToken(options: GithubCallOptions): Promise<GithubTokenCheck> {
  const user = await gh<{ login: string }>(options, { path: "/user" });
  const header = user.headers.get("x-oauth-scopes");
  const scopes = header === null ? null : header.split(",").map((scope) => scope.trim()).filter((scope) => scope.length > 0);
  const missingScopes = REQUIRED_GITHUB_SCOPES.filter((scope) => scopes === null || !hasScope(scopes, scope));
  let problem: string | null = null;
  if (scopes === null) {
    problem = `Use a classic personal access token with the ${REQUIRED_GITHUB_SCOPES.join(" and ")} scopes.`;
  } else if (missingScopes.length > 0) {
    problem = `Add the ${missingScopes.join(" and ")} scope${missingScopes.length > 1 ? "s" : ""} to this token on GitHub (Settings → Developer settings → Personal access tokens).`;
  }
  return { login: user.data.login, scopes, missingScopes, problem };
}

/** Check the token's scopes and its membership in `org` (spec §11.2 step 1). Throws only on network/server failures. */
export async function checkGithubAccount(org: string, options: GithubCallOptions): Promise<GithubAccountCheck> {
  const token = await checkGithubToken(options);
  const { login, scopes, missingScopes } = token;

  const membership = await gh<{ state?: string; role?: string }>(options, {
    path: `/user/memberships/orgs/${encodeURIComponent(org)}`,
    okStatuses: [403, 404]
  });
  const member = membership.status === 200;
  const orgRole = member ? (membership.data.role === "admin" ? "admin" : "member") : null;
  const membershipState = member ? (membership.data.state === "pending" ? "pending" : "active") : null;

  let canCreateRepo: boolean | null = null;
  if (orgRole === "admin" && membershipState === "active") {
    canCreateRepo = true;
  } else if (orgRole === "member" && membershipState === "active") {
    const orgInfo = await gh<{ members_can_create_private_repositories?: boolean; members_can_create_repositories?: boolean }>(options, {
      path: `/orgs/${encodeURIComponent(org)}`,
      okStatuses: [403, 404]
    });
    const value = orgInfo.data?.members_can_create_private_repositories ?? orgInfo.data?.members_can_create_repositories;
    canCreateRepo = typeof value === "boolean" ? value : null;
  } else {
    canCreateRepo = false;
  }

  // The token's scopes come first.
  let problem: string | null = token.problem;
  if (problem !== null) return { login, scopes, missingScopes, orgRole, membershipState, canCreateRepo, problem };
  if (orgRole === null) {
    problem = `${login} is not a member of ${org}.`;
  } else if (membershipState === "pending") {
    problem = `Accept the invitation to ${org} on GitHub first.`;
  } else if (canCreateRepo === false) {
    problem = `${login} cannot create private repositories in ${org}; ask an org owner to allow it or to make them an owner.`;
  }
  return { login, scopes, missingScopes, orgRole, membershipState, canCreateRepo, problem };
}

export interface BlacksmithAppStatus {
  /** null when the token may not list the org's installations (not an org owner, or no `read:org`). */
  installed: boolean | null;
  /** `all` or `selected` repositories, when installed. */
  repositorySelection: string | null;
  suspended: boolean;
  /** Where an org owner installs the app (always set, for the setup step's link). */
  installUrl: string;
}

/** Whether the Blacksmith GitHub App is installed on the org (spec §11.2 step 3). */
export async function detectBlacksmithApp(org: string, options: GithubCallOptions): Promise<BlacksmithAppStatus> {
  const unknown: BlacksmithAppStatus = { installed: null, repositorySelection: null, suspended: false, installUrl: BLACKSMITH_APP_INSTALL_URL };
  const found = await findInPages<{ app_slug?: string; repository_selection?: string; suspended_at?: string | null }>(
    options,
    `/orgs/${encodeURIComponent(org)}/installations`,
    "installations",
    (installation) => installation.app_slug === BLACKSMITH_APP_SLUG,
    [403, 404]
  );
  if (found === "forbidden") return unknown;
  if (found === null) return { ...unknown, installed: false };
  return {
    installed: true,
    repositorySelection: found.repository_selection ?? null,
    suspended: Boolean(found.suspended_at),
    installUrl: BLACKSMITH_APP_INSTALL_URL
  };
}

/** Walk a paginated list (`?per_page=100&page=n`) until `match` finds an item. */
async function findInPages<T>(
  options: GithubCallOptions,
  path: string,
  field: string,
  match: (item: T) => boolean,
  okStatuses: readonly number[]
): Promise<T | null | "forbidden"> {
  for (let page = 1; page <= 20; page++) {
    const response = await gh<Record<string, unknown>>(options, { path: `${path}?per_page=100&page=${page}`, okStatuses });
    if (response.status !== 200) return "forbidden";
    const items = (response.data?.[field] ?? []) as T[];
    const hit = items.find(match);
    if (hit !== undefined) return hit;
    if (items.length < 100) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repository and workflow file
// ---------------------------------------------------------------------------

export interface ControlRepo {
  /** `owner/name`. */
  repository: string;
  defaultBranch: string;
  htmlUrl: string;
  created: boolean;
}

interface RepoResponse {
  full_name: string;
  default_branch: string;
  html_url: string;
  private: boolean;
  archived?: boolean;
}

function toControlRepo(data: RepoResponse, created: boolean): ControlRepo {
  if (!data.private) throw new Error(`${data.full_name} exists but is public; make it private or delete it first`);
  if (data.archived) throw new Error(`${data.full_name} is archived; unarchive it first`);
  return { repository: data.full_name, defaultBranch: data.default_branch, htmlUrl: data.html_url, created };
}

/** The control repo, or null when it does not exist (or the token cannot see it). */
export async function getControlRepo(repository: string, options: GithubCallOptions): Promise<ControlRepo | null> {
  const response = await gh<RepoResponse>(options, { path: repoPath(repository), okStatuses: [404] });
  return response.status === 404 ? null : toControlRepo(response.data, false);
}

/** Create the private control repo in the org, or return it when it exists (idempotent). */
export async function ensureControlRepo(
  org: string,
  options: GithubCallOptions & { name?: string }
): Promise<ControlRepo> {
  const name = options.name ?? BLACKSMITH_CONTROL_REPO_NAME;
  const path = repoPath(`${org}/${name}`);
  const existing = await gh<RepoResponse>(options, { path, okStatuses: [404] });
  if (existing.status === 200) return toControlRepo(existing.data, false);

  const created = await gh<RepoResponse>(options, {
    method: "POST",
    path: `/orgs/${encodeURIComponent(org)}/repos`,
    body: {
      name,
      private: true,
      auto_init: true,
      description: "Orquester macOS boxes (managed by Orquester; runs on Blacksmith)",
      has_issues: false,
      has_projects: false,
      has_wiki: false
    },
    okStatuses: [422],
    attempts: 1
  });
  if (created.status === 201) return toControlRepo(created.data, true);
  // 422 "name already exists": created concurrently, or by an earlier attempt whose response was lost.
  const again = await gh<RepoResponse>(options, { path });
  return toControlRepo(again.data, false);
}

export interface WorkflowFileResult {
  changed: boolean;
  /** The commit that wrote the file (null when unchanged). */
  commitSha: string | null;
}

/** The git blob id of `content` (what the contents API reports as a file's `sha`). */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * Commit `content` at `path` on the default branch unless it is already there (idempotent,
 * updates when the template changes). The committed file's blob sha is compared with the
 * content's first; the decoded content decides when they differ.
 */
export async function ensureWorkflowFile(
  repo: ControlRepo,
  path: string,
  content: string,
  options: GithubCallOptions & { label?: string }
): Promise<WorkflowFileResult> {
  const label = options.label ?? "the Orquester box workflow";
  const wanted = gitBlobSha(content);
  const filePath = `${repoPath(repo.repository)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await gh<{ sha?: string; content?: string; encoding?: string }>(options, {
      path: `${filePath}?ref=${encodeURIComponent(repo.defaultBranch)}`,
      okStatuses: [404]
    });
    let sha: string | undefined;
    if (current.status === 200) {
      sha = current.data.sha;
      if (sha === wanted) return { changed: false, commitSha: null };
      const existing = current.data.encoding === "base64" ? Buffer.from(current.data.content ?? "", "base64").toString("utf8") : null;
      if (existing === content) return { changed: false, commitSha: null };
    }
    const written = await gh<{ commit?: { sha?: string } }>(options, {
      method: "PUT",
      path: filePath,
      body: {
        message: sha === undefined ? `Add ${label}` : `Update ${label}`,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: repo.defaultBranch,
        ...(sha === undefined ? {} : { sha })
      },
      // 409/422: the file changed between the read and the write (sha mismatch) — read again.
      okStatuses: [409, 422],
      attempts: 1
    });
    if (written.status === 200 || written.status === 201) return { changed: true, commitSha: written.data.commit?.sha ?? null };
  }
  throw new Error(`${PROVIDER}: could not write ${path} in ${repo.repository} (it keeps changing)`);
}

/** The control repo's workflow files and their contents for these options. */
export function controlWorkflowFiles(options: BlacksmithWorkflowOptions = {}): Array<{ path: string; label: string; content: string }> {
  return [
    { path: BLACKSMITH_WORKFLOW_PATH, label: "the Orquester box workflow", content: blacksmithWorkflowTemplate(options) },
    { path: BLACKSMITH_DEVICE_CACHE_WORKFLOW_PATH, label: "the Orquester device cache workflow", content: blacksmithDeviceCacheWorkflowTemplate() }
  ];
}

/**
 * Commit every control-repo workflow whose committed content differs from this build's
 * template (setup, and each box create: orgs set up by an older build pick up new inputs).
 * Resolves the paths it wrote.
 */
export async function ensureControlWorkflows(
  repo: ControlRepo,
  templateOptions: BlacksmithWorkflowOptions,
  options: GithubCallOptions
): Promise<{ changed: string[] }> {
  const changed: string[] = [];
  for (const file of controlWorkflowFiles(templateOptions)) {
    const result = await ensureWorkflowFile(repo, file.path, file.content, { ...options, label: file.label });
    if (result.changed) changed.push(file.path);
  }
  return { changed };
}

/** Wait until GitHub has registered the workflow file (it 404s for a short while after the commit). */
export async function waitWorkflowReady(
  repository: string,
  workflowFile: string,
  options: GithubCallOptions & { deadlineMs?: number }
): Promise<{ id: number; state: string }> {
  return pollUntil(
    async () => {
      const response = await gh<{ id: number; state: string }>(options, {
        path: `${repoPath(repository)}/actions/workflows/${encodeURIComponent(workflowFile)}`,
        okStatuses: [404]
      });
      if (response.status !== 200) return undefined;
      if (response.data.state !== "active") throw new Error(`${PROVIDER}: the workflow ${workflowFile} is ${response.data.state}; enable it in the repo's Actions tab`);
      return response.data;
    },
    { signal: options.signal, deadlineMs: options.deadlineMs ?? 120_000, timeoutMessage: () => `${PROVIDER}: ${workflowFile} did not appear in ${repository}'s workflows` }
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface WorkflowRun {
  id: number;
  /** The run name (`run-name`): `orq-<boxId>` for box runs. */
  displayTitle: string;
  /** queued | in_progress | completed | waiting | requested | pending. */
  status: string;
  /** success | failure | cancelled | timed_out | … once completed. */
  conclusion: string | null;
  createdAt: string;
  runStartedAt: string | null;
  htmlUrl: string;
  event: string;
  path: string;
}

interface RunResponse {
  id: number;
  display_title?: string;
  name?: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string | null;
  html_url: string;
  event: string;
  path?: string;
}

function toRun(data: RunResponse): WorkflowRun {
  return {
    id: data.id,
    displayTitle: data.display_title ?? data.name ?? "",
    status: data.status,
    conclusion: data.conclusion,
    createdAt: data.created_at,
    runStartedAt: data.run_started_at ?? null,
    htmlUrl: data.html_url,
    event: data.event,
    path: data.path ?? ""
  };
}

/**
 * 422s that mean "GitHub has not indexed this version of the workflow yet" (right after a
 * commit): retried until the deadline. Any other 422 (a bad input value) fails at once.
 */
function isNotYetIndexed(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.status === 404) return true;
  if (error.status !== 422) return false;
  return /workflow_dispatch|unexpected inputs|no ref found|not found/i.test(error.message);
}

export interface DispatchResult {
  runId: number;
  htmlUrl: string | null;
}

/**
 * Start one box run: `workflow_dispatch` with `return_run_details: true` (GitHub answers
 * with the run id). Retries 404/"not indexed yet" 422 with backoff until `deadlineMs`. Where
 * GitHub answers 204 without details, the run is found by its `orq-<boxId>` name.
 */
export async function dispatchBoxRun(
  request: { repository: string; workflowFile: string; ref: string; inputs: BlacksmithWorkflowInputs },
  options: GithubCallOptions & { deadlineMs?: number }
): Promise<DispatchResult> {
  return dispatchWorkflowRun({ ...request, inputs: { ...request.inputs }, runName: `orq-${request.inputs.box_id}` }, options);
}

/**
 * Start a run of any control-repo workflow ({@link dispatchBoxRun}'s rules); `runName` is the
 * run name its `run-name` gives these inputs, to find the run when GitHub answers 204.
 */
export async function dispatchWorkflowRun(
  request: { repository: string; workflowFile: string; ref: string; inputs: Readonly<Record<string, string>>; runName: string },
  options: GithubCallOptions & { deadlineMs?: number }
): Promise<DispatchResult> {
  const dispatchedAfter = Date.now() - 5_000;
  const dispatched = await pollUntil<{ status: number; data: { workflow_run_id?: number; html_url?: string } | null }>(
    async () => {
      try {
        return await gh<{ workflow_run_id?: number; html_url?: string } | null>(options, {
          method: "POST",
          path: `${repoPath(request.repository)}/actions/workflows/${encodeURIComponent(request.workflowFile)}/dispatches`,
          body: { ref: request.ref, inputs: request.inputs, return_run_details: true },
          // A dispatch is not idempotent: a lost response must not start a second box.
          attempts: 1
        });
      } catch (error) {
        if (isNotYetIndexed(error)) return undefined;
        throw error;
      }
    },
    {
      signal: options.signal,
      deadlineMs: options.deadlineMs ?? 120_000,
      timeoutMessage: () => `${PROVIDER}: ${request.repository} does not accept dispatches of ${request.workflowFile} yet`
    }
  );
  const runId = dispatched.data?.workflow_run_id;
  if (typeof runId === "number") return { runId, htmlUrl: dispatched.data?.html_url ?? null };

  const name = request.runName;
  const run = await pollUntil(
    async () => (await listRecentRuns(request.repository, request.workflowFile, { ...options, since: new Date(dispatchedAfter) })).find(
      (candidate) => candidate.displayTitle === name
    ),
    { signal: options.signal, deadlineMs: 60_000, timeoutMessage: () => `${PROVIDER}: the dispatched run ${name} did not show up` }
  );
  return { runId: run.id, htmlUrl: run.htmlUrl };
}

/** A run, or null when it no longer exists. */
export async function getRun(repository: string, runId: number | string, options: GithubCallOptions): Promise<WorkflowRun | null> {
  const response = await gh<RunResponse>(options, { path: `${repoPath(repository)}/actions/runs/${encodeURIComponent(String(runId))}`, okStatuses: [404] });
  return response.status === 404 ? null : toRun(response.data);
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  runnerName: string | null;
  labels: string[];
}

export async function getRunJobs(repository: string, runId: number | string, options: GithubCallOptions): Promise<WorkflowJob[]> {
  const response = await gh<{ jobs?: Array<Record<string, unknown>> }>(options, {
    path: `${repoPath(repository)}/actions/runs/${encodeURIComponent(String(runId))}/jobs?per_page=100`,
    okStatuses: [404]
  });
  if (response.status === 404) return [];
  return (response.data.jobs ?? []).map((job) => ({
    id: job.id as number,
    name: String(job.name ?? ""),
    status: String(job.status ?? ""),
    conclusion: (job.conclusion as string | null | undefined) ?? null,
    startedAt: (job.started_at as string | null | undefined) ?? null,
    runnerName: (job.runner_name as string | null | undefined) ?? null,
    labels: Array.isArray(job.labels) ? (job.labels as string[]) : []
  }));
}

/** Request cancellation. Resolves `false` when the run had already finished or no longer exists. */
export async function cancelRun(repository: string, runId: number | string, options: GithubCallOptions): Promise<boolean> {
  const response = await gh(options, {
    method: "POST",
    path: `${repoPath(repository)}/actions/runs/${encodeURIComponent(String(runId))}/cancel`,
    okStatuses: [404, 409]
  });
  return response.status === 202;
}

/** Cancel without waiting for `always()` steps — the last resort when a cancel does not land. */
export async function forceCancelRun(repository: string, runId: number | string, options: GithubCallOptions): Promise<boolean> {
  const response = await gh(options, {
    method: "POST",
    path: `${repoPath(repository)}/actions/runs/${encodeURIComponent(String(runId))}/force-cancel`,
    okStatuses: [404, 409]
  });
  return response.status === 202;
}

/** Runs of the workflow created since `since` (newest first), across pages. */
export async function listRecentRuns(
  repository: string,
  workflowFile: string,
  options: GithubCallOptions & { since: Date }
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  const created = `>=${options.since.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  for (let page = 1; page <= 10; page++) {
    const response = await gh<{ workflow_runs?: RunResponse[] }>(options, {
      path: `${repoPath(repository)}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=100&page=${page}&created=${encodeURIComponent(created)}`,
      okStatuses: [404]
    });
    if (response.status === 404) return runs;
    const items = response.data.workflow_runs ?? [];
    runs.push(...items.map(toRun));
    if (items.length < 100) break;
  }
  return runs;
}

/** Wait (backoff + deadline) until a run is completed; returns it, or null when it disappeared. */
export async function waitRunCompleted(
  repository: string,
  runId: number | string,
  options: GithubCallOptions & { deadlineMs: number }
): Promise<WorkflowRun | null | "timeout"> {
  try {
    return await pollUntil<WorkflowRun | null>(
      async () => {
        const run = await getRun(repository, runId, options);
        if (run === null || run.status === "completed") return run;
        return undefined;
      },
      { signal: options.signal, deadlineMs: options.deadlineMs, firstDelayMs: 2000, timeoutMessage: () => `run ${runId} still running` }
    );
  } catch (error) {
    if (error instanceof GithubPollTimeoutError) return "timeout";
    throw error;
  }
}
