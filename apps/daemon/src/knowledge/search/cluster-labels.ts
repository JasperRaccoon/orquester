/**
 * Topic names for the similarity graph's clusters, given by an LLM. The concept-based label
 * (`similarity.ts` `clusterLabels`) names a cluster after its most telling concept, which is often
 * a product or a source rather than the topic ("ChatGPT" for an SEO / AI-search cluster, "App Store
 * Preflight" — a skill pack — for App Store review, "Candy Crush" for pricing and paywalls, "DAU"
 * for retention). So each cluster of at least {@link CLUSTER_LABEL_MIN_SIZE} entries is asked about
 * once: a 2–5 word topic name from its top titles and concepts (a `KnowledgeRoundTaskSource`, step
 * {@link CLUSTER_NAME_STEP}, at most {@link CLUSTER_NAME_MAX_PER_ROUND} a round in linking's idle
 * rounds).
 *
 * - The port similarity reads ({@link KnowledgeClusterLabelsPort}): `labelFor(members)` answers the
 *   label of a named cluster whose members are at least {@link CLUSTER_LABEL_REUSE} the same (both
 *   ways), so a label stays as entries are added; `request(clusters)` queues the clusters it drew
 *   without one. A label is never shown to a caller who cannot see every entry it was named from.
 * - Answers: exactly `{label}`, ≤ {@link CLUSTER_LABEL_MAX_CHARS} characters, 2–5 words, no quotes,
 *   not an author's name or handle, nor a product, tool or other brand name alone (the cluster's
 *   entity concepts; {@link validateClusterLabelAnswer}).
 * - Persisted in `cluster-labels.json` (`knowledgeClusterLabelsPath`, tolerant: `@orquester/config`
 *   `knowledge-cluster-labels.ts`), keyed by a hash of the sorted member ids.
 */

import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import {
  emptyKnowledgeClusterLabelsFile,
  readKnowledgeClusterLabelsFile,
  serializeKnowledgeClusterLabelsFile,
  type KnowledgeClusterLabelRecord,
  type KnowledgeClusterLabelsFile
} from "@orquester/config";
import type { KnowledgeRoundTask, KnowledgeRoundTaskSource } from "../ports.ts";
import type { KnowledgeLogger } from "../store/errors.ts";
import { writeFileAtomic } from "../store/fs.ts";

export const CLUSTER_NAME_STEP = "cluster-name";
/** Clusters smaller than this keep their concept label. */
export const CLUSTER_LABEL_MIN_SIZE = 3;
/** Clusters named per round at most. */
export const CLUSTER_NAME_MAX_PER_ROUND = 8;
/** A label is reused for a cluster sharing at least this share of its members, both ways. */
export const CLUSTER_LABEL_REUSE = 0.8;
export const CLUSTER_LABEL_MAX_CHARS = 40;
/** Clusters waiting for a name at most (the oldest go first). */
const PENDING_MAX = 64;
const TITLES_MAX = 12;
const CONCEPTS_MAX = 12;

/** What similarity reads (optional: absent, clusters keep their concept labels). */
export interface KnowledgeClusterLabelsPort {
  /**
   * The LLM label of the cluster with these members (or one at least {@link CLUSTER_LABEL_REUSE}
   * the same), or null. `hidden(id)`: the entry exists but the caller cannot see it — a label named
   * from such an entry is not shown.
   */
  labelFor(memberIds: readonly string[], hidden: (entryId: string) => boolean): string | null;
  /** Clusters drawn (member ids, most central first) that may need a name: queued when they have none. */
  request(clusters: readonly (readonly string[])[]): void;
  /** Moves whenever a label is added (part of the similarity graph's cache key). */
  revision(): number;
}

/** A cluster as the task shows it. */
export interface ClusterDescription {
  /** Member titles, most central first. */
  titles: string[];
  /** Its most shared topic concepts. */
  concepts: { name: string; type: string }[];
  /** Names the label must not be alone: the members' authors and handles, the cluster's entity names. */
  forbidden: string[];
}

export const CLUSTER_NAME_SYSTEM = [
  "You name a cluster of saved knowledge entries that are about the same topic.",
  'Answer with ONLY a JSON object, no prose and no other keys: {"label": "<topic name>"}.',
  `- The label is a topic name of 2 to 5 words and at most ${CLUSTER_LABEL_MAX_CHARS} characters, in Title case or sentence case, e.g. "App Store review rules", "Paywall pricing", "User retention".`,
  "- Name what the entries are about (the shared subject), not who wrote them or where they come from.",
  "- Never only an author's name, a product, tool, app or brand name, or a source's name (a product name may appear inside a topic, e.g. \"ChatGPT search visibility\").",
  "- No quotes, no punctuation at the ends, no emoji."
].join("\n");

const fold = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** `null` when `value` is a valid answer for a cluster whose label must not be any of `forbidden`, else why not. */
export function validateClusterLabelAnswer(value: unknown, forbidden: readonly string[] = []): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 'The answer must be a JSON object {"label": "<topic name>"}.';
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "label");
  if (extra.length > 0) return `The answer has keys it must not have (${extra.slice(0, 3).join(", ")}): only "label".`;
  if (typeof record.label !== "string") return '"label" must be a string.';
  const label = record.label.trim();
  if (label.length === 0) return '"label" must not be empty.';
  if (label.length > CLUSTER_LABEL_MAX_CHARS) return `"label" must be at most ${CLUSTER_LABEL_MAX_CHARS} characters.`;
  if (/["'`“”‘’«»]/.test(label) || /[\r\n\t]/.test(label)) return '"label" must have no quotes and be one line.';
  const words = label.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2 || words.length > 5) return '"label" must be a topic name of 2 to 5 words.';
  const key = fold(label);
  if (key.length === 0) return '"label" must name the topic in words.';
  if (forbidden.some((name) => fold(name) === key)) return '"label" must name the topic, not an author, a product, a tool or another brand alone.';
  return null;
}

/** A validated label, or null (bad JSON included). */
export function parseClusterLabelAnswer(text: string, forbidden: readonly string[] = []): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return validateClusterLabelAnswer(value, forbidden) === null ? (value as { label: string }).label.trim().replace(/\s+/g, " ") : null;
}

/** The task's user message. */
export function clusterNameInput(description: ClusterDescription): string {
  const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
  return [
    `ENTRY TITLES (${description.titles.length})`,
    ...description.titles.map((title) => `- ${oneLine(title)}`),
    "",
    "SHARED CONCEPTS",
    ...(description.concepts.length > 0 ? description.concepts.map((c) => `- ${oneLine(c.name)} (${oneLine(c.type)})`) : ["- (none)"]),
    "",
    "Name the topic these entries share. Answer with the JSON object only."
  ].join("\n");
}

/** The cache key of a member set: sha256 of the sorted ids. */
export function clusterKey(memberIds: readonly string[]): string {
  return createHash("sha256").update([...new Set(memberIds)].sort().join("\n"), "utf8").digest("hex").slice(0, 24);
}

/** Whether two member sets share at least {@link CLUSTER_LABEL_REUSE} of each. */
function similarMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  let shared = 0;
  for (const id of a) if (b.has(id)) shared += 1;
  return shared >= CLUSTER_LABEL_REUSE * Math.max(a.size, b.size);
}

/** What a cluster-name task carries back with its answer. */
interface ClusterPayload {
  key: string;
  members: string[];
  forbidden: string[];
}

function readPayload(value: unknown): ClusterPayload | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== "string" || !Array.isArray(v.members) || !Array.isArray(v.forbidden)) return null;
  const members = v.members.filter((m): m is string => typeof m === "string");
  const forbidden = v.forbidden.filter((m): m is string => typeof m === "string");
  return members.length > 0 ? { key: v.key, members, forbidden } : null;
}

export interface KnowledgeClusterLabelsOptions {
  /** `knowledgeClusterLabelsPath(appdir)`. */
  path: string;
  /** A cluster's titles, concepts and forbidden names (every entry, unscoped); null when none of it exists any more. */
  describe(memberIds: readonly string[]): ClusterDescription | null;
  /** Draws the clusters (the unscoped similarity graph) before a round takes its tasks, so they are requested. */
  refresh?(): Promise<void>;
  limit?: number;
  now?: () => Date;
  logger?: KnowledgeLogger;
}

/** The labels, the port similarity reads and the round task source (see the module header). */
export class KnowledgeClusterLabels implements KnowledgeClusterLabelsPort, KnowledgeRoundTaskSource {
  readonly step = CLUSTER_NAME_STEP;
  private file: KnowledgeClusterLabelsFile = emptyKnowledgeClusterLabelsFile();
  private records: { record: KnowledgeClusterLabelRecord; members: Set<string> }[] = [];
  /** Clusters waiting for a name, by key, oldest first. */
  private readonly pending = new Map<string, { members: string[]; set: Set<string> }>();
  private readonly workListeners = new Set<() => void>();
  private readonly changeListeners = new Set<() => void>();
  private rev = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly logger: KnowledgeLogger;

  constructor(private readonly options: KnowledgeClusterLabelsOptions) {
    this.logger = options.logger ?? console;
  }

  /** Reads the file; one that does not parse is moved aside and the labels start empty. Never rejects. */
  async load(): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(this.options.path, "utf8");
    } catch {
      text = null;
    }
    let file = emptyKnowledgeClusterLabelsFile();
    if (text !== null) {
      try {
        file = readKnowledgeClusterLabelsFile(JSON.parse(text));
      } catch {
        const aside = `${this.options.path}.unreadable-${this.now().getTime()}`;
        await rename(this.options.path, aside).catch(() => undefined);
        this.logger.warn(`knowledge: cluster-labels.json did not read; moved to ${aside}`);
      }
    }
    this.file = file;
    this.records = file.labels.map((record) => ({ record, members: new Set(record.members) }));
    this.rev += 1;
  }

  revision(): number {
    return this.rev;
  }

  /** Called after a label was added. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onWork(listener: () => void): () => void {
    this.workListeners.add(listener);
    return () => this.workListeners.delete(listener);
  }

  labelFor(memberIds: readonly string[], hidden: (entryId: string) => boolean): string | null {
    if (memberIds.length < CLUSTER_LABEL_MIN_SIZE) return null;
    const found = this.find(new Set(memberIds));
    if (!found) return null;
    for (const id of found.record.members) if (hidden(id)) return null;
    return found.record.label;
  }

  request(clusters: readonly (readonly string[])[]): void {
    let added = false;
    for (const members of clusters) {
      if (members.length < CLUSTER_LABEL_MIN_SIZE) continue;
      const set = new Set(members);
      const key = clusterKey(members);
      if (this.pending.has(key) || this.find(set)) continue;
      // A queued cluster that is mostly the same is replaced by the newer member set.
      for (const [other, item] of this.pending) if (similarMembers(item.set, set)) this.pending.delete(other);
      this.pending.set(key, { members: [...members], set });
      added = true;
    }
    while (this.pending.size > PENDING_MAX) this.pending.delete(this.pending.keys().next().value!);
    if (added) for (const listener of [...this.workListeners]) listener();
  }

  async tasks(): Promise<KnowledgeRoundTask[]> {
    if (this.file.readOnly) return [];
    await this.options.refresh?.().catch((error: unknown) => this.logger.warn(`knowledge: drawing the clusters to name failed (${String(error)})`));
    const limit = this.options.limit ?? CLUSTER_NAME_MAX_PER_ROUND;
    const waiting = [...this.pending.entries()].sort((x, y) => y[1].members.length - x[1].members.length);
    const tasks: KnowledgeRoundTask[] = [];
    for (const [key, item] of waiting) {
      if (tasks.length >= limit) break;
      if (this.find(item.set)) {
        this.pending.delete(key);
        continue;
      }
      const description = this.options.describe(item.members);
      if (!description || description.titles.length < CLUSTER_LABEL_MIN_SIZE) {
        this.pending.delete(key);
        continue;
      }
      const shown: ClusterDescription = { ...description, titles: description.titles.slice(0, TITLES_MAX), concepts: description.concepts.slice(0, CONCEPTS_MAX) };
      const payload: ClusterPayload = { key, members: [...item.members].sort(), forbidden: description.forbidden };
      tasks.push({ label: `${CLUSTER_NAME_STEP} ${key}`, system: CLUSTER_NAME_SYSTEM, user: clusterNameInput(shown), payload });
    }
    return tasks;
  }

  validate(value: unknown, payload: unknown): string | null {
    return validateClusterLabelAnswer(value, readPayload(payload)?.forbidden ?? []);
  }

  async record(payload: unknown, answer: string): Promise<void> {
    const task = readPayload(payload);
    const label = task ? parseClusterLabelAnswer(answer, task.forbidden) : null;
    if (!task || label === null) return;
    const run = this.chain.then(async () => {
      const record: KnowledgeClusterLabelRecord = { key: clusterKey(task.members), members: [...task.members].sort(), label, labeledAt: this.now().toISOString() };
      const labels = [...this.file.labels.filter((r) => r.key !== record.key), record];
      const next: KnowledgeClusterLabelsFile = { ...this.file, labels };
      if (!next.readOnly) await writeFileAtomic(this.options.path, serializeKnowledgeClusterLabelsFile(next));
      this.file = next;
      this.records = labels.map((r) => ({ record: r, members: new Set(r.members) }));
      const set = new Set(record.members);
      for (const [key, item] of this.pending) if (key === task.key || similarMembers(item.set, set)) this.pending.delete(key);
      this.rev += 1;
    });
    this.chain = run.catch(() => undefined);
    await run.catch((error: unknown) => this.logger.warn(`knowledge: a cluster label could not be saved (${String(error)})`));
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch (error) {
        this.logger.warn(`knowledge: a cluster labels listener failed (${String(error)})`);
      }
    }
  }

  /** Clusters queued for a name (tests, the live evaluation). */
  waiting(): string[][] {
    return [...this.pending.values()].map((item) => [...item.members]);
  }

  /** The best record for a member set: the most members in common, at least {@link CLUSTER_LABEL_REUSE} both ways. */
  private find(set: ReadonlySet<string>): { record: KnowledgeClusterLabelRecord } | null {
    let best: { record: KnowledgeClusterLabelRecord; shared: number } | null = null;
    for (const { record, members } of this.records) {
      if (!similarMembers(members, set)) continue;
      let shared = 0;
      for (const id of members) if (set.has(id)) shared += 1;
      if (!best || shared > best.shared || (shared === best.shared && record.labeledAt > best.record.labeledAt)) best = { record, shared };
    }
    return best;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}
