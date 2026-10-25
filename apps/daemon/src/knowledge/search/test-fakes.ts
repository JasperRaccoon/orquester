import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeCollection, KnowledgeEntry, KnowledgeEntryMeta } from "@orquester/api";
import type { KnowledgeEntryChange } from "../ports.ts";
import { knowledgeContentHash } from "../store/normalize.ts";
import type { KnowledgeEmbedder, KnowledgeEmbedderSource } from "./embedder.ts";
import type { KnowledgeGraph } from "./graph.ts";
import type { KnowledgeSearchStore } from "./search.ts";

/** Supply graph fixtures through the same JSONL boundary as myKG. */
export async function loadGraph(graph: KnowledgeGraph, nodes: readonly unknown[], edges: readonly unknown[] = []): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kg-graph-fixture-"));
  try {
    await Promise.all([
      writeFile(join(dir, "nodes.jsonl"), nodes.map((node) => JSON.stringify(node)).join("\n")),
      writeFile(join(dir, "edges.jsonl"), edges.map((edge) => JSON.stringify(edge)).join("\n"))
    ]);
    await graph.load(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** An in-memory store for search tests (the real store is covered by its own tests). */
export class FakeStore implements KnowledgeSearchStore {
  readonly entries = new Map<string, KnowledgeEntry>();
  collections: KnowledgeCollection[] = [];
  private readonly listeners = new Set<(change: KnowledgeEntryChange) => void>();
  private seq = 0;

  collection(id: string, name: string): KnowledgeCollection {
    const at = "2026-10-01T00:00:00.000Z";
    const collection: KnowledgeCollection = { id, name, description: "", color: "chart-1", createdAt: at, updatedAt: at };
    this.collections.push(collection);
    return collection;
  }

  /** Adds (or replaces) an entry; emits `added` unless `silent`. */
  put(id: string, body: string, collections: string[], extra: Partial<KnowledgeEntryMeta> = {}, silent = false): KnowledgeEntry {
    this.seq += 1;
    const at = new Date(Date.parse("2026-10-01T00:00:00.000Z") + this.seq * 1000).toISOString();
    const entry: KnowledgeEntry = {
      id,
      title: extra.title ?? body.split("\n")[0]!.slice(0, 60),
      kind: "note",
      author: null,
      handle: null,
      url: null,
      postedAt: null,
      savedAt: at,
      updatedAt: at,
      savedFrom: { by: "user" },
      collections,
      contentHash: knowledgeContentHash(body),
      linkState: "pending",
      ...extra,
      body
    };
    const existed = this.entries.has(id);
    this.entries.set(id, entry);
    if (!silent) this.emit({ kind: existed ? "edited" : "added", entryIds: [id] });
    return entry;
  }

  remove(id: string): void {
    this.entries.delete(id);
    this.emit({ kind: "deleted", entryIds: [id] });
  }

  emit(change: KnowledgeEntryChange): void {
    for (const listener of this.listeners) listener(change);
  }

  listMeta(): readonly KnowledgeEntryMeta[] {
    return [...this.entries.values()].map(({ body: _body, ...meta }) => meta);
  }

  getMeta(id: string): KnowledgeEntryMeta | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const { body: _body, ...meta } = entry;
    return meta;
  }

  async getEntry(id: string): Promise<KnowledgeEntry | null> {
    return this.entries.get(id) ?? null;
  }

  onChange(listener: (change: KnowledgeEntryChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listCollections(): readonly KnowledgeCollection[] {
    return this.collections;
  }

  resolveCollection(ref: string): KnowledgeCollection | null {
    return this.collections.find((c) => c.id === ref) ?? this.collections.find((c) => c.name.toLowerCase() === ref.trim().toLowerCase()) ?? null;
  }
}

/**
 * A deterministic "semantic" embedder: words in the same group land on the same dimension, so
 * "ranking in ChatGPT" and "cited by AI answer engines" are close without sharing a word. Other
 * words hash onto the remaining dimensions.
 */
export class FakeEmbedder implements KnowledgeEmbedder {
  readonly dimensions: number;
  readonly modelId: string;
  calls = 0;
  texts = 0;
  failWith: Error | null = null;

  constructor(options: { dimensions?: number; modelId?: string; groups?: string[][] } = {}) {
    this.dimensions = options.dimensions ?? 32;
    this.modelId = options.modelId ?? "fake/semantic";
    (options.groups ?? DEFAULT_GROUPS).forEach((group, index) => {
      for (const word of group) this.group.set(word, index);
    });
    this.reserved = (options.groups ?? DEFAULT_GROUPS).length;
  }

  private readonly group = new Map<string, number>();
  private readonly reserved: number;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls += 1;
    this.texts += texts.length;
    if (this.failWith) throw this.failWith;
    return texts.map((text) => this.vector(text));
  }

  vector(text: string): Float32Array {
    const v = new Float32Array(this.dimensions);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const group = this.group.get(word);
      if (group !== undefined) v[group]! += 3;
      else {
        let h = 0x811c9dc5;
        for (let i = 0; i < word.length; i += 1) h = Math.imul(h ^ word.charCodeAt(i), 0x01000193) >>> 0;
        v[this.reserved + (h % (this.dimensions - this.reserved))]! += 0.2;
      }
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i += 1) v[i]! /= norm;
    return v;
  }
}

const DEFAULT_GROUPS = [
  ["chatgpt", "llm", "ai", "perplexity", "gemini", "answer", "engines", "cited", "cite", "citations"],
  ["ranking", "rank", "visibility", "surface", "appear"],
  ["ads", "campaign", "cpc", "budget", "spend"],
  ["app", "ios", "android", "store", "screenshots"]
];

export class FakeEmbedderSource implements KnowledgeEmbedderSource {
  private readonly listeners = new Set<() => void>();
  constructor(public embedder: KnowledgeEmbedder | null) {}

  current(): KnowledgeEmbedder | null {
    return this.embedder;
  }

  set(embedder: KnowledgeEmbedder | null): void {
    this.embedder = embedder;
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const silentLogger = (): { warn: (m: string) => void; error: (m: string) => void; lines: string[] } => {
  const lines: string[] = [];
  return { warn: (m) => lines.push(m), error: (m) => lines.push(m), lines };
};

/** A myKG-shaped node record. */
export function node(id: string, name: string, sourceFiles: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: id.split("-")[0],
    confidence: 0.9,
    attributes: { name: { value: name, confidence: 1 }, ...((extra.attributes as object) ?? {}) },
    source_files: sourceFiles,
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "attributes"))
  };
}

/** A myKG-shaped edge record (`sourceFiles: null` → no provenance field). */
export function edge(id: string, from: string, to: string, sourceFiles: string[] | null, type = "related_to"): Record<string, unknown> {
  return {
    id,
    type,
    from,
    to,
    confidence: 0.8,
    attributes: {},
    method: "llm_extraction",
    ...(sourceFiles ? { source_files: sourceFiles } : {})
  };
}
