/**
 * Knowledge Graph linking — `state.json` on disk (`knowledgeStatePath(appdir)`, schema in
 * `@orquester/config` `knowledge-linking.ts`). Writes are atomic (temp + rename) and serialized; a
 * file that does not read is moved aside (`state.json.unreadable-<time>`) and the state starts
 * empty, so a hand edit never stops linking and is never silently overwritten.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  emptyKnowledgeLinkingState,
  parseKnowledgeLinkingState,
  serializeKnowledgeLinkingState,
  type KnowledgeLinkingStateRecord
} from "@orquester/config";

export class LinkingStateFile {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async load(): Promise<KnowledgeLinkingStateRecord> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return emptyKnowledgeLinkingState();
    }
    try {
      return parseKnowledgeLinkingState(JSON.parse(text));
    } catch {
      const aside = `${this.path}.unreadable-${this.now().toISOString().replace(/[:.]/g, "-")}`;
      await rename(this.path, aside).catch(() => undefined);
      return emptyKnowledgeLinkingState();
    }
  }

  /** Writes a copy of `state` (later calls write after earlier ones). */
  save(state: KnowledgeLinkingStateRecord): Promise<void> {
    const text = serializeKnowledgeLinkingState(state);
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
