// Automated workflows — `<appdir>/daemon/workflow-state.json`: the runtime state that changes without
// an edit (schedule cursors, git trigger cursors, account cooldowns, REST ETags). Spec §3, §5.4, §6.
//
// The state is a CACHE of progress, never an authority: a bad entry is dropped by the tolerant parse
// (`parseWorkflowStateFile`), and a file that cannot be read or parsed starts the daemon with an
// empty state — logged, never thrown at boot. A corrupt file is moved aside first (best effort), so
// what it held is still there to look at.
//
// Memory is the live copy: `update` applies its mutator at once (so `get()` sees it immediately) and
// resolves once a write holding the change has landed. Writes are serialized and coalesced — every
// update queued while a write runs is carried by the ONE write that follows it — and each is atomic
// (temp file + rename) at 0600.

import { readFile, rename } from "node:fs/promises";
import { createDefaultWorkflowStateFile, parseWorkflowStateFile, type WorkflowStateFile } from "@orquester/config";
import { writeFileAtomic } from "../agent-hooks.ts";

export interface WorkflowStateStoreLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface WorkflowStateStoreOptions {
  /** `workflowStatePath(baseDir)` from @orquester/config. */
  path: string;
  logger?: WorkflowStateStoreLogger;
}

export class WorkflowStateStore {
  private state: WorkflowStateFile = createDefaultWorkflowStateFile();
  /** The latest write (settled or not); the next one chains after it. */
  private writing: Promise<void> = Promise.resolve();
  /** A write queued behind `writing` that has not started yet — it will carry every change made until it starts. */
  private queued: Promise<void> | null = null;
  private readonly path: string;
  private readonly logger: WorkflowStateStoreLogger;

  constructor(options: WorkflowStateStoreOptions) {
    this.path = options.path;
    this.logger = options.logger ?? console;
  }

  /** Reads the file. Never throws: missing → empty; unreadable or corrupt → empty, logged. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn(`workflow-state.json could not be read (${code ?? String(error)}); starting with an empty workflow state.`);
      }
      this.state = createDefaultWorkflowStateFile();
      return;
    }
    try {
      this.state = parseWorkflowStateFile(JSON.parse(text));
    } catch (error) {
      this.state = createDefaultWorkflowStateFile();
      const aside = `${this.path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        await rename(this.path, aside);
        this.logger.warn(`workflow-state.json is corrupt (${(error as Error).message}); moved it to ${aside} and started with an empty workflow state.`);
      } catch {
        this.logger.warn(`workflow-state.json is corrupt (${(error as Error).message}); starting with an empty workflow state.`);
      }
    }
  }

  /** A snapshot: mutating it changes nothing. */
  get(): WorkflowStateFile {
    return structuredClone(this.state);
  }

  /**
   * Applies `mutator` to a copy of the state and swaps it in at once (a mutator that throws changes
   * nothing and rejects). Resolves when a write carrying the change has landed; rejects when that
   * write fails — the change stays in memory and rides the next write.
   */
  update(mutator: (draft: WorkflowStateFile) => void): Promise<void> {
    const draft = structuredClone(this.state);
    try {
      mutator(draft);
    } catch (error) {
      return Promise.reject(error);
    }
    this.state = draft;
    return this.scheduleWrite();
  }

  /** Waits for every write started or queued so far. Never rejects. */
  async flush(): Promise<void> {
    await this.writing.catch(() => undefined);
  }

  private scheduleWrite(): Promise<void> {
    if (this.queued) return this.queued;
    const next = this.writing
      .catch(() => undefined)
      .then(async () => {
        this.queued = null;
        const content = `${JSON.stringify(this.state, null, 2)}\n`;
        try {
          await writeFileAtomic(this.path, content, 0o600, false);
        } catch (error) {
          this.logger.error(`workflow-state.json could not be written: ${(error as Error).message}`);
          throw error;
        }
      });
    this.queued = next;
    this.writing = next;
    return next;
  }
}
