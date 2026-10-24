/**
 * Knowledge Graph linking — `state.json` on disk (`knowledgeStatePath(appdir)`, schema in
 * `@orquester/config` `knowledge-linking.ts`). Writes are atomic (temp + rename) and serialized; a
 * file that does not read is moved aside (`state.json.unreadable-<time>`) and the state starts
 * empty, so a hand edit never stops linking and is never silently overwritten.
 *
 * A file a newer Orquester wrote (a higher `version`, e.g. after a rollback) is kept in place:
 * {@link LinkingStateFile.newer} says so, and the service links nothing on it (its session and runs
 * are still read). A rewrite keeps the newer version and every field this build does not know; a
 * file with a known field this build could not read exactly as written is never written over.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  emptyKnowledgeLinkingState,
  readKnowledgeLinkingState,
  serializeKnowledgeLinkingState,
  type KnowledgeLinkingStateRecord
} from "@orquester/config";

export interface NewerLinkingState {
  /** The file's version. */
  version: number;
  /** Whether a rewrite is allowed (every known field read as written). */
  writable: boolean;
}

export class LinkingStateFile {
  private chain: Promise<void> = Promise.resolve();
  /** Set by {@link load} when the file is a newer build's; null otherwise. */
  newer: NewerLinkingState | null = null;

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async load(): Promise<KnowledgeLinkingStateRecord> {
    this.newer = null;
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return emptyKnowledgeLinkingState();
    }
    try {
      const read = readKnowledgeLinkingState(JSON.parse(text));
      if (read.kind === "newer") this.newer = { version: read.version, writable: read.intact };
      return read.state;
    } catch {
      const aside = `${this.path}.unreadable-${this.now().toISOString().replace(/[:.]/g, "-")}`;
      await rename(this.path, aside).catch(() => undefined);
      return emptyKnowledgeLinkingState();
    }
  }

  /** Resolves once every write asked for so far has landed (or failed). */
  flush(): Promise<void> {
    return this.chain;
  }

  /**
   * Writes a copy of `state` (later calls write after earlier ones). A newer build's file keeps its
   * version; one that did not read intact is not written at all.
   */
  save(state: KnowledgeLinkingStateRecord): Promise<void> {
    const newer = this.newer;
    if (newer && !newer.writable) return this.chain;
    const text = serializeKnowledgeLinkingState(state, newer?.version);
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, this.path);
    };
    const next = this.chain.then(write, write);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
