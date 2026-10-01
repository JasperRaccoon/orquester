// Automated workflows — runs on disk (spec §5.8).
//
//   <runsDir>/<runId>/run.json                    the whole run (atomic rewrite, serialized per run)
//   <runsDir>/<runId>/events.ndjson               the run's progress, appended
//   <runsDir>/<runId>/nodes/<nodeId>/<attempt>/   an attempt's files (sandbox logs, output.json, …)
//   <runsDir>/index.json                          a CACHE of the per-workflow summaries
//
// The run directories are the authority. `init()` walks them and builds the in-memory index
// (summaries per workflow, newest first); `index.json` only saves re-reading an unchanged run.json
// (an entry is reused when the file's size and mtime still match), and is rewritten — coalesced —
// after changes. An unreadable run.json is skipped with a warning.
//
// Writes of one run are serialized and coalesced: a `save` queued while a write of the same run is
// in flight replaces the content that write will carry, so the file always ends at the latest
// state and never goes back. A run deleted (a workflow delete, the retention sweep) is remembered,
// so a late `save` or `appendEvent` never recreates its directory.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isRunActive,
  WORKFLOW_LIMITS,
  type ListWorkflowRunsResponse,
  type WorkflowBlockRun,
  type WorkflowRun,
  type WorkflowRunSummary
} from "@orquester/api";
import { writeFileAtomic } from "../agent-hooks.ts";
import type { PersistedRun, RunStore } from "./contracts.ts";
import { jsonBytes, toRunSummary } from "./run-context.ts";

export interface RunStoreOptions {
  /** `workflowRunsDir(baseDir)`. */
  dir: string;
  logger?: Pick<Console, "warn" | "error">;
}

/** Newest first: `queuedAt` descending, then id descending (deterministic). */
function newestFirst(a: WorkflowRunSummary, b: WorkflowRunSummary): number {
  if (a.queuedAt !== b.queuedAt) return a.queuedAt < b.queuedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** A block output cut to the inline preview: whole when it fits, else the head of its JSON text. */
function previewOutput(output: unknown): { output: unknown; truncated: boolean } {
  const maxBytes = WORKFLOW_LIMITS.inlineOutputPreviewBytes;
  if (jsonBytes(output) <= maxBytes) return { output, truncated: false };
  let text: string;
  try {
    text = JSON.stringify(output, null, 2) ?? "";
  } catch {
    return { output: null, truncated: true };
  }
  const head = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
  return { output: head, truncated: true };
}

/**
 * A persisted run as the wire serves it (`GET /api/workflow-runs/:runId` without the engine): the
 * store's own bookkeeping (`version`, `depth`, `seededOutputs`, `fromNodeId`, each block's
 * `waitingOn` and `outputFile`) is dropped and every block output is cut to the inline preview.
 */
export function persistedRunToWire(run: PersistedRun): WorkflowRun {
  const { version: _version, depth: _depth, seededOutputs: _seeded, fromNodeId: _from, blocks, ...rest } = run;
  const wireBlocks: Record<string, WorkflowBlockRun> = {};
  for (const [nodeId, block] of Object.entries(blocks)) {
    const { waitingOn: _waitingOn, outputFile, ...wire } = block;
    if (wire.output !== undefined) {
      const preview = previewOutput(wire.output);
      wire.output = preview.output;
      if (preview.truncated || outputFile !== undefined) wire.outputTruncated = true;
    } else if (outputFile !== undefined) {
      wire.outputTruncated = true;
    }
    wireBlocks[nodeId] = wire;
  }
  return { ...(rest as Omit<WorkflowRun, "blocks">), blocks: wireBlocks };
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/** A path segment for an id: the id itself when it is plainly safe, else a stable hash of it. */
function pathSegment(id: string): string {
  return SAFE_SEGMENT.test(id) ? id : `x-${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

function isRunId(id: unknown): id is string {
  return typeof id === "string" && SAFE_SEGMENT.test(id);
}

interface IndexEntry {
  summary: WorkflowRunSummary;
  /** run.json's size and mtime when the summary was taken (the cache key). */
  size: number;
  mtimeMs: number;
}

interface RunWriter {
  writing: Promise<void>;
  queued: Promise<void> | null;
  content: string;
}

export class FileRunStore implements RunStore {
  private readonly dir: string;
  private readonly logger: Pick<Console, "warn" | "error">;
  /** runId -> entry. */
  private readonly entries = new Map<string, IndexEntry>();
  /** workflowId -> runIds, newest first. */
  private readonly byWorkflow = new Map<string, WorkflowRunSummary[]>();
  private readonly writers = new Map<string, RunWriter>();
  private readonly eventWrites = new Map<string, Promise<void>>();
  private readonly deleted = new Set<string>();
  private indexWriting: Promise<void> = Promise.resolve();
  private indexQueued: Promise<void> | null = null;

  constructor(options: RunStoreOptions) {
    this.dir = resolve(options.dir);
    this.logger = options.logger ?? console;
  }

  async create(run: PersistedRun): Promise<void> {
    if (!isRunId(run.id)) throw new Error("A run id must be 1-128 letters, digits, _ or -");
    this.deleted.delete(run.id);
    await mkdir(join(this.dir, run.id), { recursive: true });
    await this.save(run);
  }

  save(run: PersistedRun): Promise<void> {
    if (!isRunId(run.id) || this.deleted.has(run.id)) return Promise.resolve();
    const content = `${JSON.stringify(run)}\n`;
    this.index(toRunSummary(run));
    let writer = this.writers.get(run.id);
    if (writer === undefined) {
      writer = { writing: Promise.resolve(), queued: null, content };
      this.writers.set(run.id, writer);
    }
    writer.content = content;
    if (writer.queued !== null) return writer.queued;
    const w = writer;
    const next = w.writing
      .catch(() => undefined)
      .then(async () => {
        w.queued = null;
        if (this.deleted.has(run.id)) return;
        const file = join(this.dir, run.id, "run.json");
        await writeFileAtomic(file, w.content, 0o600, false);
        try {
          const info = await stat(file);
          const entry = this.entries.get(run.id);
          if (entry) {
            entry.size = info.size;
            entry.mtimeMs = info.mtimeMs;
          }
        } catch {
          // the next load re-reads it.
        }
        void this.persistIndex();
      });
    w.queued = next;
    w.writing = next;
    next.then(
      () => {
        if (this.writers.get(run.id) === w && w.queued === null && w.writing === next) this.writers.delete(run.id);
      },
      (error) => this.logger.error(`workflow run ${run.id} could not be saved (${(error as NodeJS.ErrnoException)?.code ?? String(error)})`)
    );
    return next;
  }

  async load(runId: string): Promise<PersistedRun | null> {
    if (!isRunId(runId) || this.deleted.has(runId)) return null;
    // A write in flight is the newest state: wait for it rather than read the file under it.
    await this.writers.get(runId)?.writing.catch(() => undefined);
    return this.readRunFile(runId);
  }

  /** The summary of a run the index knows (no I/O). */
  summaryOf(runId: string): WorkflowRunSummary | undefined {
    const entry = this.entries.get(runId);
    return entry ? structuredClone(entry.summary) : undefined;
  }

  async listUnfinished(): Promise<PersistedRun[]> {
    const out: PersistedRun[] = [];
    for (const entry of this.entries.values()) {
      if (!isRunActive(entry.summary.status)) continue;
      const run = await this.load(entry.summary.id);
      if (run !== null) out.push(run);
    }
    return out;
  }

  async listForWorkflow(workflowId: string, opts: { before?: string; limit: number }): Promise<ListWorkflowRunsResponse> {
    const list = this.byWorkflow.get(workflowId) ?? [];
    const limit = Math.max(1, Math.min(Math.floor(opts.limit) || 1, 500));
    let start = 0;
    if (opts.before !== undefined && opts.before !== "") {
      const at = list.findIndex((summary) => summary.id === opts.before);
      // An unknown cursor (a run swept meanwhile, a foreign id) reads as a first page.
      start = at === -1 ? 0 : at + 1;
    }
    const page = list.slice(start, start + limit);
    const more = start + limit < list.length;
    return { runs: structuredClone(page), before: more && page.length > 0 ? page[page.length - 1]!.id : null };
  }

  latestForWorkflow(workflowId: string): WorkflowRunSummary | undefined {
    const first = this.byWorkflow.get(workflowId)?.[0];
    return first ? structuredClone(first) : undefined;
  }

  activeForWorkflow(workflowId: string): WorkflowRunSummary[] {
    return structuredClone((this.byWorkflow.get(workflowId) ?? []).filter((summary) => isRunActive(summary.status)));
  }

  appendEvent(runId: string, event: Record<string, unknown>): Promise<void> {
    if (!isRunId(runId) || this.deleted.has(runId)) return Promise.resolve();
    const line = `${JSON.stringify(event)}\n`;
    const previous = this.eventWrites.get(runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.deleted.has(runId)) return;
        await mkdir(join(this.dir, runId), { recursive: true });
        await appendFile(join(this.dir, runId, "events.ndjson"), line, { encoding: "utf8", mode: 0o600 });
      });
    this.eventWrites.set(runId, next);
    next.then(
      () => {
        if (this.eventWrites.get(runId) === next) this.eventWrites.delete(runId);
      },
      () => undefined
    );
    return next;
  }

  /** `<runsDir>/<runId>/nodes/<nodeId>/<attempt>` — the path only, nothing created. */
  attemptPath(runId: string, nodeId: string, attempt: number): string {
    if (!isRunId(runId)) throw new Error("Invalid run id");
    const n = Math.max(0, Math.floor(attempt));
    return join(this.dir, runId, "nodes", pathSegment(nodeId), String(n));
  }

  async attemptDir(runId: string, nodeId: string, attempt: number): Promise<string> {
    const path = this.attemptPath(runId, nodeId, attempt);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  async writeOutputFile(runId: string, nodeId: string, attempt: number, output: unknown): Promise<string> {
    const dir = await this.attemptDir(runId, nodeId, attempt);
    const path = join(dir, "output.json");
    await writeFileAtomic(path, JSON.stringify(output ?? null), 0o600, false);
    return path;
  }

  async readOutputFile(path: string): Promise<unknown> {
    const target = resolve(path);
    const rel = relative(this.dir, target);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      throw new Error("An output file lies inside the workflow runs directory");
    }
    return JSON.parse(await readFile(target, "utf8")) as unknown;
  }

  async deleteForWorkflow(workflowId: string, options: { keep?: ReadonlySet<string> } = {}): Promise<void> {
    const list = (this.byWorkflow.get(workflowId) ?? []).filter((summary) => !options.keep?.has(summary.id));
    await Promise.all(list.map((summary) => this.deleteRun(summary.id)));
    if ((this.byWorkflow.get(workflowId)?.length ?? 0) === 0) this.byWorkflow.delete(workflowId);
    void this.persistIndex();
  }

  /** Every workflow id with a run on record (a deleted workflow's kept runs included). */
  workflowIds(): string[] {
    return [...this.byWorkflow.keys()];
  }

  async sweep(): Promise<void> {
    const cutoff = new Date().getTime() - WORKFLOW_LIMITS.runRetentionDays * 86_400_000;
    const doomed: string[] = [];
    for (const list of this.byWorkflow.values()) {
      list.forEach((summary, position) => {
        if (isRunActive(summary.status)) return;
        // A run still holding a temporary project is kept until the sweeper deletes the project
        // (`deleteAfter`): its record is the only thing that names the project, so dropping it first
        // would leak the directory for good (a failing schedule passes 100 runs in hours).
        if (summary.tempProject && !summary.tempProject.deleted) return;
        const at = Date.parse(summary.endedAt ?? summary.queuedAt);
        const tooOld = Number.isFinite(at) && at < cutoff;
        if (position >= WORKFLOW_LIMITS.runsPerWorkflow || tooOld) doomed.push(summary.id);
      });
    }
    await Promise.all(doomed.map((runId) => this.deleteRun(runId)));
    if (doomed.length > 0) void this.persistIndex();
  }

  /** Waits for every write started or queued so far. Never rejects. */
  async flush(): Promise<void> {
    await Promise.all([
      ...[...this.writers.values()].map((writer) => writer.writing.catch(() => undefined)),
      ...[...this.eventWrites.values()].map((write) => write.catch(() => undefined))
    ]);
    await this.indexWriting.catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------

  /**
   * Build the index from the run directories (index.json only short-cuts unchanged run.json files).
   * Call once at boot, before anything reads the store.
   */
  async init(): Promise<void> {
    this.entries.clear();
    this.byWorkflow.clear();
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (error) {
      // Never fatal at boot: the history is empty and each create retries the directory.
      this.logger.error(`workflow-runs could not be created (${(error as NodeJS.ErrnoException)?.code ?? String(error)}); no run history this run.`);
      return;
    }
    const cached = await this.readIndexCache();
    let names: string[];
    try {
      names = (await readdir(this.dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (error) {
      this.logger.error(`workflow-runs could not be listed (${(error as NodeJS.ErrnoException)?.code ?? String(error)}); no run history this run.`);
      return;
    }
    for (const runId of names) {
      if (!isRunId(runId)) continue;
      const file = join(this.dir, runId, "run.json");
      let info;
      try {
        info = await stat(file);
      } catch {
        continue; // a directory without run.json (its create never finished) is not a run.
      }
      const hit = cached.get(runId);
      if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs && hit.summary.id === runId) {
        this.entries.set(runId, hit);
        continue;
      }
      const run = await this.readRunFile(runId);
      if (run === null) {
        this.logger.warn(`workflow-runs/${runId}/run.json is unreadable; the run is not listed.`);
        continue;
      }
      this.entries.set(runId, { summary: toRunSummary(run), size: info.size, mtimeMs: info.mtimeMs });
    }
    for (const entry of this.entries.values()) this.addToWorkflow(entry.summary);
    for (const list of this.byWorkflow.values()) list.sort(newestFirst);
    await this.persistIndex();
  }

  private addToWorkflow(summary: WorkflowRunSummary): void {
    const list = this.byWorkflow.get(summary.workflowId);
    if (list) list.push(summary);
    else this.byWorkflow.set(summary.workflowId, [summary]);
  }

  /** Put a run's newest summary into the index (keeps the newest-first order). */
  private index(summary: WorkflowRunSummary): void {
    const previous = this.entries.get(summary.id);
    if (previous) {
      const oldList = this.byWorkflow.get(previous.summary.workflowId);
      if (oldList) {
        const at = oldList.findIndex((s) => s.id === summary.id);
        if (at !== -1) oldList.splice(at, 1);
      }
      previous.summary = summary;
      // The file's stamp belongs to the OLD summary: until the write lands and re-stamps it, the
      // cached index must not pair the new file with a stale summary (a crash in between would
      // leave an unfinished run listed as finished, never resumed).
      previous.size = -1;
      previous.mtimeMs = -1;
    } else {
      this.entries.set(summary.id, { summary, size: -1, mtimeMs: -1 });
    }
    const list = this.byWorkflow.get(summary.workflowId) ?? [];
    let at = list.findIndex((other) => newestFirst(summary, other) < 0);
    if (at === -1) at = list.length;
    list.splice(at, 0, summary);
    this.byWorkflow.set(summary.workflowId, list);
  }

  private async deleteRun(runId: string): Promise<void> {
    this.deleted.add(runId);
    const entry = this.entries.get(runId);
    this.entries.delete(runId);
    if (entry) {
      const list = this.byWorkflow.get(entry.summary.workflowId);
      if (list) {
        const at = list.findIndex((s) => s.id === runId);
        if (at !== -1) list.splice(at, 1);
        if (list.length === 0) this.byWorkflow.delete(entry.summary.workflowId);
      }
    }
    await this.writers.get(runId)?.writing.catch(() => undefined);
    await this.eventWrites.get(runId)?.catch(() => undefined);
    this.writers.delete(runId);
    this.eventWrites.delete(runId);
    // Retries: a detached sandbox runner of a run being cancelled can still write its exit.json into
    // an attempt directory while the tree is removed (ENOTEMPTY); a later write finds no directory.
    await rm(join(this.dir, runId), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch((error) =>
      this.logger.warn(`workflow run ${runId} could not be deleted (${(error as NodeJS.ErrnoException)?.code ?? String(error)})`)
    );
  }

  private async readRunFile(runId: string): Promise<PersistedRun | null> {
    let text: string;
    try {
      text = await readFile(join(this.dir, runId, "run.json"), "utf8");
    } catch {
      return null;
    }
    try {
      const run = JSON.parse(text) as PersistedRun;
      if (
        run === null ||
        typeof run !== "object" ||
        run.version !== 1 ||
        run.id !== runId ||
        typeof run.workflowId !== "string" ||
        typeof run.status !== "string" ||
        typeof run.queuedAt !== "string" ||
        run.blocks === null ||
        typeof run.blocks !== "object"
      ) {
        return null;
      }
      return run;
    } catch {
      return null;
    }
  }

  private get indexFile(): string {
    return join(this.dir, "index.json");
  }

  private async readIndexCache(): Promise<Map<string, IndexEntry>> {
    const out = new Map<string, IndexEntry>();
    try {
      const raw = JSON.parse(await readFile(this.indexFile, "utf8")) as { version?: unknown; runs?: unknown };
      if (raw?.version !== 1 || raw.runs === null || typeof raw.runs !== "object") return out;
      for (const [runId, value] of Object.entries(raw.runs as Record<string, unknown>)) {
        const entry = value as Partial<IndexEntry> | null;
        if (
          entry &&
          typeof entry.size === "number" &&
          typeof entry.mtimeMs === "number" &&
          entry.summary &&
          typeof entry.summary === "object" &&
          typeof entry.summary.workflowId === "string" &&
          typeof entry.summary.queuedAt === "string" &&
          typeof entry.summary.status === "string"
        ) {
          out.set(runId, entry as IndexEntry);
        }
      }
    } catch {
      // Missing or unreadable: it is a cache — every run.json is read instead.
    }
    return out;
  }

  /** Coalesced: every change made while a write runs rides the ONE write queued after it. */
  private persistIndex(): Promise<void> {
    if (this.indexQueued) return this.indexQueued;
    const next = this.indexWriting
      .catch(() => undefined)
      .then(async () => {
        this.indexQueued = null;
        const runs: Record<string, IndexEntry> = {};
        for (const [runId, entry] of this.entries) {
          // An entry whose file stamp is unknown yet (a write in flight) is not cached.
          if (entry.size >= 0) runs[runId] = entry;
        }
        try {
          await writeFileAtomic(this.indexFile, JSON.stringify({ version: 1, runs }), 0o600, false);
        } catch (error) {
          this.logger.warn(`workflow-runs/index.json could not be written (${(error as NodeJS.ErrnoException)?.code ?? String(error)})`);
        }
      });
    this.indexQueued = next;
    this.indexWriting = next;
    return next;
  }
}
