/**
 * Projects that run in a box (spec §8.1, §8.7, §8.11). The project row stays a directory on the
 * host — an empty stub — so every path-keyed store keeps its identity; its box record says where
 * it really lives.
 *
 * - **Create**: the location and source are checked, the stub directory made, the record written,
 *   and setup started in the background; the route answers at once with the project (its box
 *   `provisioning`). Clone, New repo, Empty and Template all work; the clone runs in the box.
 * - **List**: box projects get their repo fields from the record (there is no local `.git`) and a
 *   `box` summary.
 * - **Delete**: the box is destroyed and confirmed gone before anything is removed; a failed
 *   destroy keeps the project (`destroy-failed`, retried by deleting again).
 * - **Archive** changes nothing here: the box keeps running.
 */

import { mkdir, readdir, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { projectBoxInfo, type BoxLocationRequest, type CreateProjectRequest, type ProjectSummary } from "@orquester/api";
import { isValidName } from "@orquester/config";

import { normalizeGitUrl, remoteRepoFields } from "../../repo-id.ts";
import { cloneRefProblem, stripUrlCredentials } from "../../workflows/git-remote/index.ts";
import { BoxError } from "./errors.ts";
import type { BoxLifecycle, StoredBoxProject } from "./lifecycle.ts";
import { resolvePlacement } from "./placement.ts";
import { PROJECT_DELETED_FIELD, type StoreBoxRegistry } from "./registry.ts";
import type { BoxHostingAccounts, BoxSettings } from "./settings.ts";
import type { BoxStore } from "./store.ts";

const MAX_TEMPLATE_COMMAND = 4096;

export interface CreateBoxProjectInput {
  workspace: string;
  /** `<workspacesDir>/<workspace>`. */
  workspaceDir: string;
  body: CreateProjectRequest;
  /** The workspace's bound Git hosting account (clone, New repo, the box's git identity). */
  gitAccountId: string | null;
}

export interface BoxProjectsDeps {
  store: BoxStore;
  registry: StoreBoxRegistry;
  lifecycle: BoxLifecycle;
  settings: BoxSettings;
  accounts: BoxHostingAccounts;
  enabled(): boolean;
  now(): number;
}

function invalid(message: string, status: 400 | 409 = 400): BoxError {
  return new BoxError(status, "BOX_INVALID_REQUEST", message);
}

export function isBoxLocation(location: unknown): location is BoxLocationRequest {
  return typeof location === "object" && location !== null && (location as { kind?: unknown }).kind === "box";
}

export class BoxProjects {
  constructor(private readonly deps: BoxProjectsDeps) {}

  async create(input: CreateBoxProjectInput): Promise<ProjectSummary> {
    if (!this.deps.enabled()) throw new BoxError(409, "BOXES_DISABLED", "Turn on Ephemeral AI VMs in Settings → Plugins to create projects in boxes.");
    const { body, workspace, workspaceDir } = input;
    const location = body.location;
    if (!isBoxLocation(location)) throw invalid("`location` must be a box location.");
    const placement = await resolvePlacement(this.deps.settings, {
      kind: location.boxKind,
      provider: location.provider,
      size: location.size,
      region: location.region,
      image: location.image,
      lifetimeMinutes: location.lifetimeMinutes,
      explicit: true,
      lifetimeRequired: false
    });

    const source = body.source ?? "empty";
    let name: string;
    let url: string | null = null;
    let ref: string | undefined;
    let templateCommand: string | undefined;
    const accountId = input.gitAccountId;
    const requireAccount = (): string => {
      if (!accountId) throw invalid("This workspace has no linked git account.");
      return accountId;
    };
    if (source === "empty") {
      name = (body as Extract<CreateProjectRequest, { name: string }>).name;
      // The Template tab's command (`CreateProjectRequest.templateCommand`), run in the box's first terminal once it is ready.
      if (body.templateCommand !== undefined) {
        const command: unknown = body.templateCommand;
        if (typeof command !== "string" || command.trim().length === 0 || command.length > MAX_TEMPLATE_COMMAND || /[\u0000-\u001f\u007f]/.test(command)) {
          throw invalid(`\`templateCommand\` must be one line of at most ${MAX_TEMPLATE_COMMAND} characters.`);
        }
        templateCommand = command;
      }
    } else if (source === "clone") {
      const clone = body as Extract<CreateProjectRequest, { source: "clone" }>;
      if (typeof clone.url !== "string" || clone.url.trim().length === 0) throw invalid("A repository URL is required.");
      if (clone.name !== undefined && !isValidName(clone.name)) throw invalid("Invalid name.");
      if (clone.ref !== undefined) {
        const problem = cloneRefProblem(clone.ref);
        if (problem) throw invalid(problem);
        ref = clone.ref;
      }
      const resolved = await this.deps.accounts.resolveClone(requireAccount(), clone.url.trim());
      url = resolved.url;
      name = clone.name ?? resolved.name;
    } else if (source === "create") {
      requireAccount();
      name = (body as Extract<CreateProjectRequest, { source: "create" }>).name;
    } else {
      throw invalid("Unknown project source.");
    }
    if (!isValidName(name)) throw invalid("Invalid name.");

    const path = join(workspaceDir, name);
    const occupants = await readdir(path).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : null));
    if (occupants === null || occupants.length > 0) throw invalid(`"${name}" already exists and is not empty.`, 409);
    const existing = this.deps.registry.projectRecord(path);
    if (existing && existing.state !== "destroyed" && resolve(existing.project!.path) === resolve(path)) {
      throw invalid(`"${name}" already has a box.`, 409);
    }

    if (source === "create") {
      const create = body as Extract<CreateProjectRequest, { source: "create" }>;
      const repo = await this.deps.accounts.createRepo(requireAccount(), {
        owner: create.owner,
        name,
        visibility: create.visibility,
        ...(create.description ? { description: create.description } : {})
      });
      url = repo.url;
    }

    const remoteUrl = url === null ? null : stripUrlCredentials(url.trim());
    const remote = remoteUrl ? remoteRepoFields(remoteUrl) : null;
    const repoId = remoteUrl ? normalizeGitUrl(remoteUrl) : null;
    const project: StoredBoxProject = {
      workspace,
      name,
      path,
      source: templateCommand !== undefined ? "template" : source,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(remote ? { cloneUrl: remote.cloneUrl, repoKey: remote.repoKey, repoName: remote.repoName } : {}),
      ...(repoId ? { repoId } : {}),
      ...(ref !== undefined ? { ref } : {}),
      ...(templateCommand !== undefined ? { templateCommand } : {}),
      ...(accountId ? { gitAccountId: accountId } : {})
    };

    const createdStub = occupants.length === 0;
    await mkdir(path, { recursive: true });
    let record;
    try {
      record = await this.deps.lifecycle.create({
        purpose: "project",
        kind: placement.kind,
        provider: placement.adapter.id,
        size: placement.size.id,
        sizeLabel: placement.size.label,
        region: placement.region.id,
        regionLabel: placement.region.label,
        image: placement.image,
        hourlyUsd: placement.size.hourlyUsd,
        lifetimeMinutes: placement.lifetimeMinutes,
        project,
        threadId: null,
        purposeNote: null
      });
    } catch (error) {
      if (createdStub) await rmdir(path).catch(() => undefined);
      throw error;
    }
    const summary = this.deps.registry.summarize(record);
    return {
      name,
      workspace,
      path,
      isArchived: false,
      ...(repoId ? { repoId } : {}),
      ...(remote ?? {}),
      ...(summary ? { box: projectBoxInfo(summary) } : {})
    };
  }

  /** `listProjects` rows with their box: repo fields from the record, and the `box` summary. */
  decorate(projects: ProjectSummary[]): ProjectSummary[] {
    return projects.map((project) => {
      const record = this.exact(project.path);
      if (!record?.project) return project;
      const summary = this.deps.registry.summarize(record);
      if (!summary) return project;
      const { repoKey, repoName, cloneUrl, repoId } = record.project;
      return {
        ...project,
        ...(typeof repoId === "string" ? { repoId } : {}),
        ...(repoKey && repoName && cloneUrl ? { repoKey, repoName, cloneUrl } : {}),
        box: projectBoxInfo(summary)
      };
    });
  }

  /** Before a project's directory is removed: destroy its box and wait until the provider confirms. Throws (keep the project) when it cannot. */
  async beforeDelete(projectPath: string): Promise<void> {
    const record = this.exact(projectPath);
    if (!record || record.state === "destroyed") return;
    await this.deps.lifecycle.destroy(record.id, "deleted");
  }

  /** After the project's directory is gone: the record stays (costs) but no longer owns the path. */
  async afterDelete(projectPath: string): Promise<void> {
    const record = this.exact(projectPath);
    if (!record) return;
    const at = new Date(this.deps.now()).toISOString();
    await this.deps.store.update(record.id, (next) => {
      next[PROJECT_DELETED_FIELD] = at;
    });
  }

  /** Before a whole workspace is removed: destroy every box of its projects. Throws (keep the workspace) when any destroy fails. */
  async beforeWorkspaceDelete(workspaceDir: string): Promise<void> {
    const results = await Promise.allSettled(
      this.underWorkspace(workspaceDir)
        .filter((record) => record.state !== "destroyed")
        .map((record) => this.deps.lifecycle.destroy(record.id, "deleted"))
    );
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length > 0) {
      const first = failed[0]!.reason;
      throw new BoxError(
        502,
        "BOX_PROVIDER_ERROR",
        `Could not destroy ${failed.length} box${failed.length === 1 ? "" : "es"} of this workspace; it was kept. ${first instanceof Error ? first.message : ""}`.trim()
      );
    }
  }

  async afterWorkspaceDelete(workspaceDir: string): Promise<void> {
    const at = new Date(this.deps.now()).toISOString();
    for (const record of this.underWorkspace(workspaceDir)) {
      await this.deps.store.update(record.id, (next) => {
        next[PROJECT_DELETED_FIELD] = at;
      });
    }
  }

  private exact(projectPath: string) {
    const record = this.deps.registry.projectRecord(projectPath);
    return record?.project && resolve(record.project.path) === resolve(projectPath) ? record : undefined;
  }

  private underWorkspace(workspaceDir: string) {
    const root = resolve(workspaceDir);
    return this.deps.store
      .list()
      .filter((record) => record.purpose === "project" && record.project && typeof record[PROJECT_DELETED_FIELD] !== "string" && resolve(record.project.path).startsWith(`${root}/`));
  }
}
