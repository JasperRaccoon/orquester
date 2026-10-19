/**
 * Test double: an in-memory GitHub REST API (the parts the control repo client
 * and the Blacksmith adapter use), served through an injected `fetch`. Shapes
 * follow api.github.com responses; behaviour knobs model the cases that matter
 * (a workflow GitHub has not indexed yet, a 204 dispatch without run details,
 * a cancel that does not land).
 */

export interface FakeRun {
  id: number;
  workflowFile: string;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  inputs: Record<string, string>;
  jobStatus: string;
  /** Whether a plain cancel completes the run (false = only force-cancel does). */
  cancellable: boolean;
}

export interface FakeGithubOptions {
  token: string;
  login?: string;
  scopes?: string | null;
  org?: string;
  role?: "admin" | "member" | null;
  membersCanCreatePrivateRepos?: boolean;
  installations?: Array<{ app_slug: string; repository_selection: string }> | "forbidden";
}

interface FakeRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  files: Map<string, { content: string; sha: string }>;
}

export class FakeGithub {
  readonly options: Required<Omit<FakeGithubOptions, "installations">> & { installations: FakeGithubOptions["installations"] };
  readonly repos = new Map<string, FakeRepo>();
  readonly runs = new Map<number, FakeRun>();
  readonly calls: Array<{ method: string; path: string; body: unknown }> = [];
  /** Dispatches answered 404 (workflow not registered yet) before they are accepted. */
  dispatch404s = 0;
  /** Dispatches answered 422 "does not have 'workflow_dispatch' trigger" before they are accepted. */
  dispatch422s = 0;
  /** Answer accepted dispatches 204 without run details (older GitHub). */
  dispatchNoDetails = false;
  /** GET workflow answers 404 this many times after a commit. */
  workflowGet404s = 0;
  private nextRunId = 9_000_000_001;
  private shaCounter = 0;

  constructor(options: FakeGithubOptions) {
    this.options = {
      login: "octo",
      scopes: "repo, workflow, admin:org",
      org: "Org",
      role: "admin",
      membersCanCreatePrivateRepos: false,
      installations: [{ app_slug: "blacksmith-sh", repository_selection: "all" }],
      ...options
    };
  }

  addRun(run: Partial<FakeRun> & { displayTitle: string }): FakeRun {
    const full: FakeRun = {
      id: this.nextRunId++,
      workflowFile: "orquester-box.yml",
      status: "in_progress",
      conclusion: null,
      createdAt: new Date().toISOString(),
      inputs: {},
      jobStatus: "in_progress",
      cancellable: true,
      ...run
    };
    this.runs.set(full.id, full);
    return full;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.calls.push({ method, path: url.pathname + url.search, body });
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${this.options.token}`) return this.json(401, { message: "Bad credentials" });
    return this.route(method, url, body as Record<string, unknown> | undefined);
  }) as typeof fetch;

  private json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
    if (status === 204 || data === null) return new Response(null, { status, headers });
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private repoJson(repo: FakeRepo): Record<string, unknown> {
    return {
      full_name: repo.fullName,
      default_branch: repo.defaultBranch,
      html_url: `https://github.com/${repo.fullName}`,
      private: repo.private
    };
  }

  private runJson(run: FakeRun): Record<string, unknown> {
    return {
      id: run.id,
      display_title: run.displayTitle,
      name: "Orquester box",
      status: run.status,
      conclusion: run.conclusion,
      created_at: run.createdAt,
      run_started_at: run.createdAt,
      html_url: `https://github.com/x/actions/runs/${run.id}`,
      event: "workflow_dispatch",
      path: `.github/workflows/${run.workflowFile}`
    };
  }

  private route(method: string, url: URL, body: Record<string, unknown> | undefined): Response {
    const path = decodeURIComponent(url.pathname);
    const { options } = this;
    let match: RegExpExecArray | null;

    if (method === "GET" && path === "/user") {
      return this.json(200, { login: options.login }, options.scopes === null ? {} : { "x-oauth-scopes": options.scopes });
    }
    if (method === "GET" && (match = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(path))) {
      if (match[1] !== options.org || options.role === null) return this.json(404, { message: "Not Found" });
      return this.json(200, { state: "active", role: options.role });
    }
    if (method === "GET" && (match = /^\/orgs\/([^/]+)$/.exec(path))) {
      return this.json(200, { login: match[1], members_can_create_private_repositories: options.membersCanCreatePrivateRepos });
    }
    if (method === "GET" && /^\/orgs\/[^/]+\/installations$/.test(path)) {
      if (options.installations === "forbidden") return this.json(403, { message: "Must have admin rights" });
      return this.json(200, { total_count: options.installations?.length ?? 0, installations: options.installations ?? [] });
    }
    if (method === "POST" && (match = /^\/orgs\/([^/]+)\/repos$/.exec(path))) {
      const fullName = `${match[1]}/${String(body?.name)}`;
      if (this.repos.has(fullName)) return this.json(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] });
      const repo: FakeRepo = { fullName, private: body?.private === true, defaultBranch: "main", files: new Map() };
      if (body?.auto_init) repo.files.set("README.md", { content: "# readme\n", sha: this.sha() });
      this.repos.set(fullName, repo);
      return this.json(201, this.repoJson(repo));
    }
    if ((match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path))) {
      const repo = this.repos.get(match[1]!);
      if (repo === undefined) return this.json(404, { message: "Not Found" });
      return this.repoRoute(method, repo, match[2] ?? "", url, body);
    }
    return this.json(404, { message: "Not Found" });
  }

  private sha(): string {
    this.shaCounter += 1;
    return this.shaCounter.toString(16).padStart(40, "0");
  }

  private repoRoute(method: string, repo: FakeRepo, rest: string, url: URL, body: Record<string, unknown> | undefined): Response {
    let match: RegExpExecArray | null;
    if (rest === "" && method === "GET") return this.json(200, this.repoJson(repo));

    if ((match = /^\/contents\/(.+)$/.exec(rest))) {
      const filePath = match[1]!;
      const file = repo.files.get(filePath);
      if (method === "GET") {
        if (file === undefined) return this.json(404, { message: "Not Found" });
        return this.json(200, { sha: file.sha, encoding: "base64", content: Buffer.from(file.content).toString("base64") });
      }
      if (method === "PUT") {
        if (file !== undefined && body?.sha !== file.sha) return this.json(409, { message: "does not match" });
        if (file === undefined && body?.sha !== undefined) return this.json(422, { message: "sha wasn't supplied" });
        const next = { content: Buffer.from(String(body?.content), "base64").toString("utf8"), sha: this.sha() };
        repo.files.set(filePath, next);
        return this.json(file === undefined ? 201 : 200, { content: { sha: next.sha }, commit: { sha: this.sha() } });
      }
    }

    if ((match = /^\/actions\/workflows\/([^/]+)$/.exec(rest)) && method === "GET") {
      if (!repo.files.has(`.github/workflows/${match[1]}`) || this.workflowGet404s > 0) {
        this.workflowGet404s = Math.max(0, this.workflowGet404s - 1);
        return this.json(404, { message: "Not Found" });
      }
      return this.json(200, { id: 77, name: "Orquester box", state: "active", path: `.github/workflows/${match[1]}` });
    }

    if ((match = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest)) && method === "POST") {
      if (this.dispatch404s > 0) {
        this.dispatch404s -= 1;
        return this.json(404, { message: "Not Found" });
      }
      if (this.dispatch422s > 0) {
        this.dispatch422s -= 1;
        return this.json(422, { message: "Workflow does not have 'workflow_dispatch' trigger" });
      }
      const inputs = (body?.inputs ?? {}) as Record<string, string>;
      if (inputs.runner !== undefined && !/^blacksmith-(6|12)vcpu-macos-(15|26|27)$/.test(inputs.runner)) {
        return this.json(422, { message: `Provided value '${inputs.runner}' for input 'runner' not in the list of allowed values` });
      }
      const run = this.addRun({ workflowFile: match[1]!, displayTitle: `orq-${inputs.box_id}`, status: "queued", jobStatus: "queued", inputs });
      if (this.dispatchNoDetails || body?.return_run_details !== true) return this.json(204, null);
      return this.json(200, { workflow_run_id: run.id, run_url: `https://api.github.com/x/${run.id}`, html_url: `https://github.com/x/actions/runs/${run.id}` });
    }

    if ((match = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(rest)) && method === "GET") {
      const created = url.searchParams.get("created");
      const since = created?.startsWith(">=") ? Date.parse(created.slice(2)) : 0;
      const runs = [...this.runs.values()]
        .filter((run) => run.workflowFile === match![1] && Date.parse(run.createdAt) >= since)
        .sort((a, b) => b.id - a.id);
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      return this.json(200, { total_count: runs.length, workflow_runs: runs.slice((page - 1) * perPage, page * perPage).map((run) => this.runJson(run)) });
    }

    if ((match = /^\/actions\/runs\/(\d+)(\/[a-z-]+)?$/.exec(rest))) {
      const run = this.runs.get(Number(match[1]));
      if (run === undefined) return this.json(404, { message: "Not Found" });
      const action = match[2] ?? "";
      if (method === "GET" && action === "") return this.json(200, this.runJson(run));
      if (method === "GET" && action === "/jobs") {
        return this.json(200, {
          total_count: 1,
          jobs: [{ id: run.id + 1, name: run.displayTitle, status: run.jobStatus, conclusion: run.conclusion, started_at: null, runner_name: null, labels: [run.inputs.runner ?? ""] }]
        });
      }
      if (method === "POST" && (action === "/cancel" || action === "/force-cancel")) {
        if (run.status === "completed") return this.json(409, { message: "Cannot cancel a workflow run that is completed." });
        if (action === "/force-cancel" || run.cancellable) {
          run.status = "completed";
          run.conclusion = "cancelled";
          run.jobStatus = "completed";
        }
        return this.json(202, {});
      }
    }
    return this.json(404, { message: "Not Found" });
  }
}
