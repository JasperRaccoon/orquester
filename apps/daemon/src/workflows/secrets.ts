// Automated workflows — the secrets store, `<appdir>/daemon/workflow-secrets.json` (spec §5.7).
//
// `{version:1, global:{NAME:{value, updatedAt}}, workflows:{<id>:{NAME:{…}}}}`, always 0600. Names
// (`[A-Z][A-Z0-9_]{0,63}`), scope and `updatedAt` are all that ever leave this module over the wire;
// values reach only the engine (`resolve`, a workflow's own secret shadowing a global one) and are
// never logged — no message below quotes one.
//
// Durability follows the saved-prompts model: a file that does not parse (or names a version this
// build does not know) is moved aside to `.corrupt-<stamp>` and the store starts empty; a file that
// cannot even be read — or a corrupt one that cannot be moved — is never written over, and every
// mutation answers 503 `WORKFLOWS_UNAVAILABLE`. Writes are chained and atomic, each serializing the
// map when it runs, and the mode is forced back to 0600 after every write.

import { EventEmitter } from "node:events";
import { chmod, readFile, rename } from "node:fs/promises";
import type { WorkflowSecretName, WorkflowSecretsChangedPayload } from "@orquester/api";
import {
  createDefaultWorkflowSecretsFile,
  parseWorkflowSecretsFile,
  WORKFLOW_SECRET_MAX_VALUE_BYTES,
  WORKFLOW_SECRET_NAME_PATTERN,
  type WorkflowSecretsFile
} from "@orquester/config";
import { writeFileAtomic } from "../agent-hooks.ts";
import type { SecretStore } from "./contracts.ts";
import { excerpt, WorkflowError } from "./errors.ts";
import { MIN_REDACTED_SECRET_LENGTH } from "./sandbox/redact.ts";

export interface WorkflowSecretsServiceOptions {
  /** `workflowSecretsPath(baseDir)`. */
  file: string;
  logger?: Pick<Console, "warn" | "error">;
  now?: () => Date;
}

export class WorkflowSecretsService implements SecretStore {
  /** Emits `"changed"` with a {@link WorkflowSecretsChangedPayload} (names only) after each write. */
  readonly lifecycle = new EventEmitter();
  private data: WorkflowSecretsFile = createDefaultWorkflowSecretsFile();
  private writes: Promise<void> = Promise.resolve();
  private blockedReason: string | null = null;
  private readonly file: string;
  private readonly logger: Pick<Console, "warn" | "error">;
  private readonly now: () => Date;

  constructor(options: WorkflowSecretsServiceOptions) {
    this.file = options.file;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    this.data = createDefaultWorkflowSecretsFile();
    this.blockedReason = null;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      this.block(`workflow-secrets.json could not be read (${code ?? "unknown error"})`);
      return;
    }
    try {
      this.data = parseWorkflowSecretsFile(JSON.parse(text));
    } catch (error) {
      // The parse error of a JSON file quotes no value (JSON.parse names a position only).
      const detail = error instanceof SyntaxError ? "not JSON" : error instanceof Error ? error.message : "invalid";
      const aside = `${this.file}.corrupt-${this.now().toISOString().replace(/[:.]/g, "-")}`;
      try {
        await rename(this.file, aside);
      } catch (moveError) {
        const code = (moveError as NodeJS.ErrnoException)?.code;
        this.block(`workflow-secrets.json is unreadable (${detail}) and could not be moved aside (${code ?? "unknown error"})`);
        return;
      }
      this.data = createDefaultWorkflowSecretsFile();
      this.logger.warn(`workflow-secrets.json is unreadable (${detail}); moved it to ${aside} and started with no secrets.`);
    }
  }

  /** Whether mutations are refused this run (the file on disk cannot be replaced safely). */
  get blocked(): string | null {
    return this.blockedReason;
  }

  list(workflowId?: string): WorkflowSecretName[] {
    const names: WorkflowSecretName[] = Object.entries(this.data.global).map(([name, entry]) => ({
      name,
      scope: "global",
      updatedAt: entry.updatedAt,
      short: entry.value.length < MIN_REDACTED_SECRET_LENGTH
    }));
    if (workflowId !== undefined) {
      for (const [name, entry] of Object.entries(this.data.workflows[workflowId] ?? {})) {
        names.push({ name, scope: "workflow", workflowId, updatedAt: entry.updatedAt, short: entry.value.length < MIN_REDACTED_SECRET_LENGTH });
      }
    }
    return names.sort((a, b) => (a.name === b.name ? (a.scope === "global" ? -1 : 1) : a.name < b.name ? -1 : 1));
  }

  /** The names a workflow can read (global + its own), for validation. */
  names(workflowId?: string): string[] {
    return [...new Set(this.list(workflowId).map((secret) => secret.name))];
  }

  resolve(workflowId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries(this.data.global)) out[name] = entry.value;
    for (const [name, entry] of Object.entries(this.data.workflows[workflowId] ?? {})) out[name] = entry.value;
    return out;
  }

  async set(name: string, value: string, workflowId?: string): Promise<void> {
    this.requireWritable();
    if (typeof name !== "string" || !WORKFLOW_SECRET_NAME_PATTERN.test(name)) {
      throw new WorkflowError(
        400,
        "SECRET_INVALID",
        `"${excerpt(String(name), 70)}" is not a valid secret name: an uppercase letter, then uppercase letters, digits or _ (at most 64).`
      );
    }
    if (typeof value !== "string") {
      throw new WorkflowError(400, "SECRET_INVALID", "A secret value must be a string.");
    }
    if (Buffer.byteLength(value, "utf8") > WORKFLOW_SECRET_MAX_VALUE_BYTES) {
      throw new WorkflowError(400, "SECRET_INVALID", `A secret value is at most ${WORKFLOW_SECRET_MAX_VALUE_BYTES / 1024} KiB.`);
    }
    if (workflowId !== undefined && (typeof workflowId !== "string" || workflowId.length === 0)) {
      throw new WorkflowError(400, "SECRET_INVALID", "workflowId must be a non-empty string.");
    }
    const entry = { value, updatedAt: this.now().toISOString() };
    const next = structuredClone(this.data);
    if (workflowId === undefined) next.global[name] = entry;
    else next.workflows[workflowId] = { ...(next.workflows[workflowId] ?? {}), [name]: entry };
    this.data = next;
    await this.persist();
    this.emitChanged(workflowId ?? null);
  }

  async delete(name: string, workflowId?: string): Promise<boolean> {
    this.requireWritable();
    const scope = workflowId === undefined ? this.data.global : this.data.workflows[workflowId];
    if (scope === undefined || !Object.prototype.hasOwnProperty.call(scope, name)) return false;
    const next = structuredClone(this.data);
    if (workflowId === undefined) delete next.global[name];
    else {
      delete next.workflows[workflowId]![name];
      if (Object.keys(next.workflows[workflowId]!).length === 0) delete next.workflows[workflowId];
    }
    this.data = next;
    await this.persist();
    this.emitChanged(workflowId ?? null);
    return true;
  }

  /** Cascade of a workflow delete. A read-only store holds nothing to delete and must not fail the delete it follows. */
  async deleteForWorkflow(workflowId: string): Promise<void> {
    if (this.blockedReason !== null || this.data.workflows[workflowId] === undefined) return;
    const next = structuredClone(this.data);
    delete next.workflows[workflowId];
    this.data = next;
    await this.persist();
    this.emitChanged(workflowId);
  }

  /** Waits for every write started so far. Never rejects. */
  async flush(): Promise<void> {
    await this.writes.catch(() => undefined);
  }

  private emitChanged(workflowId: string | null): void {
    const payload: WorkflowSecretsChangedPayload = { workflowId };
    this.lifecycle.emit("changed", payload);
  }

  private requireWritable(): void {
    if (this.blockedReason !== null) {
      throw new WorkflowError(
        503,
        "WORKFLOWS_UNAVAILABLE",
        `Workflow secrets are read-only: ${this.blockedReason}. Nothing is saved until the file is fixed and the daemon restarts.`
      );
    }
  }

  private block(reason: string): void {
    this.blockedReason = reason;
    this.logger.error(`${reason}. Workflow secrets are read-only until it is fixed and the daemon restarts.`);
  }

  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      if (this.blockedReason !== null) return;
      try {
        await writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 0o600, false);
        await chmod(this.file, 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        this.logger.error(`Failed to persist workflow secrets (${code ?? "unknown error"})`);
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
}
