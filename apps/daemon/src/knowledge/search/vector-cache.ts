import { appendFile, mkdir, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { KnowledgeLogger } from "../store/errors.ts";
import { writeFileAtomic } from "../store/fs.ts";

const MANIFEST = "vectors.json";
const HASH = /^[0-9a-f]{64}$/;
const FILE = /^vectors-\d+\.bin$/;

const manifestSchema = z.object({
  version: z.literal(1),
  modelId: z.string(),
  dimensions: z.number().int().positive(),
  chunker: z.string(),
  /** `EMBEDDING_INPUT_VERSION` of the text the rows were embedded from (absent in a cache written before it existed). */
  input: z.string().optional(),
  file: z.string().regex(FILE),
  /** Vectors in `file` that the manifest accounts for (later bytes are an interrupted append). */
  vectors: z.number().int().nonnegative(),
  /** Cache key → [first vector, vector count]. */
  entries: z.record(z.tuple([z.number().int().nonnegative(), z.number().int().positive()]))
});

type Manifest = z.infer<typeof manifestSchema>;

/**
 * Chunk vectors per cache key (a sha256 hex: `vectorCacheKey` in `vector-index.ts`) under
 * `knowledgeIndexDir` (spec: "a disposable cache"): one append-only `vectors-<generation>.bin` of
 * little-endian float32 rows and a `vectors.json` manifest written atomically after appends.
 * Anything unexpected — an unreadable manifest, another model, dimensions, chunker or embedding
 * input version, a row past the end of the file — discards the cache, which is then rebuilt from
 * the entries. Compaction writes a new generation and drops the old file.
 */
export class VectorCache {
  private manifest: Manifest;
  private readonly rows = new Map<string, Float32Array>();
  private dirty = false;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly dir: string,
    manifest: Manifest,
    private readonly logger: KnowledgeLogger
  ) {
    this.manifest = manifest;
  }

  static async open(options: {
    dir: string;
    modelId: string;
    dimensions: number;
    /** `CHUNKER_VERSION`. */
    chunker: string;
    /** `EMBEDDING_INPUT_VERSION`. */
    input: string;
    logger?: KnowledgeLogger;
  }): Promise<VectorCache> {
    const logger = options.logger ?? console;
    await mkdir(options.dir, { recursive: true });
    const fresh = (): Manifest => ({
      version: 1,
      modelId: options.modelId,
      dimensions: options.dimensions,
      chunker: options.chunker,
      input: options.input,
      file: `vectors-${Date.now()}.bin`,
      vectors: 0,
      entries: {}
    });
    let manifest: Manifest | null = null;
    let data: Float32Array | null = null;
    try {
      const text = await readFile(join(options.dir, MANIFEST), "utf8");
      const parsed = manifestSchema.parse(JSON.parse(text));
      if (parsed.modelId !== options.modelId || parsed.dimensions !== options.dimensions) throw new Error("made by another model");
      if (parsed.chunker !== options.chunker || parsed.input !== options.input) throw new Error("made from other chunks or embedding input");
      const bytes = await readFile(join(options.dir, parsed.file));
      const need = parsed.vectors * parsed.dimensions * 4;
      if (bytes.byteLength < need) throw new Error("the vector file is shorter than its manifest");
      if (bytes.byteLength > need) await truncate(join(options.dir, parsed.file), need);
      for (const [hash, [first, count]] of Object.entries(parsed.entries)) {
        if (!HASH.test(hash) || first + count > parsed.vectors) throw new Error("a row is outside the vector file");
      }
      data = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + need));
      manifest = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`knowledge: rebuilding the embedding cache (${(error as Error).message})`);
      }
      manifest = null;
    }
    const cache = new VectorCache(options.dir, manifest ?? fresh(), logger);
    if (manifest && data) {
      for (const [hash, [first, count]] of Object.entries(manifest.entries)) {
        cache.rows.set(hash, data.subarray(first * manifest.dimensions, (first + count) * manifest.dimensions));
      }
    }
    await cache.removeStrayFiles();
    if (!manifest) await cache.writeManifest();
    return cache;
  }

  get modelId(): string {
    return this.manifest.modelId;
  }

  get dimensions(): number {
    return this.manifest.dimensions;
  }

  get size(): number {
    return this.rows.size;
  }

  /** The key's chunk vectors, row after row (`count * dimensions` floats), or null. */
  get(key: string): Float32Array | null {
    return this.rows.get(key) ?? null;
  }

  /** Appends the rows now; the manifest lands on the next {@link flush}. */
  put(key: string, vectors: Float32Array): Promise<void> {
    return this.serialize(async () => {
      const dims = this.manifest.dimensions;
      if (vectors.length === 0 || vectors.length % dims !== 0) throw new Error("vector rows do not match the dimensions");
      if (this.rows.has(key)) return;
      const copy = new Float32Array(vectors);
      await appendFile(join(this.dir, this.manifest.file), Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength));
      const count = copy.length / dims;
      this.manifest.entries[key] = [this.manifest.vectors, count];
      this.manifest.vectors += count;
      this.rows.set(key, copy);
      this.dirty = true;
    });
  }

  flush(): Promise<void> {
    return this.serialize(async () => {
      if (this.dirty) await this.writeManifest();
    });
  }

  /** Forget every hash not in `live`; compact when the dead rows outnumber the live ones. */
  retain(live: ReadonlySet<string>): Promise<void> {
    return this.serialize(async () => {
      let removed = false;
      for (const hash of [...this.rows.keys()]) {
        if (!live.has(hash)) {
          this.rows.delete(hash);
          removed = true;
        }
      }
      const liveRows = [...this.rows.values()].reduce((n, rows) => n + rows.length / this.manifest.dimensions, 0);
      const dead = this.manifest.vectors - liveRows;
      if (dead > Math.max(256, liveRows)) {
        await this.compact();
        return;
      }
      if (removed) {
        for (const hash of Object.keys(this.manifest.entries)) if (!this.rows.has(hash)) delete this.manifest.entries[hash];
        await this.writeManifest();
      }
    });
  }

  private async compact(): Promise<void> {
    const dims = this.manifest.dimensions;
    const generation = Number(/^vectors-(\d+)\.bin$/.exec(this.manifest.file)?.[1] ?? 0);
    const file = `vectors-${Math.max(Date.now(), generation + 1)}.bin`;
    const total = [...this.rows.values()].reduce((n, rows) => n + rows.length, 0);
    const data = new Float32Array(total);
    const entries: Manifest["entries"] = {};
    let offset = 0;
    for (const [hash, rows] of this.rows) {
      data.set(rows, offset);
      entries[hash] = [offset / dims, rows.length / dims];
      this.rows.set(hash, data.subarray(offset, offset + rows.length));
      offset += rows.length;
    }
    await writeFile(join(this.dir, file), Buffer.from(data.buffer));
    const previous = this.manifest.file;
    this.manifest = { ...this.manifest, file, vectors: total / dims, entries };
    await this.writeManifest();
    if (previous !== file) await rm(join(this.dir, previous), { force: true });
  }

  private async writeManifest(): Promise<void> {
    await writeFileAtomic(join(this.dir, MANIFEST), JSON.stringify(this.manifest));
    this.dirty = false;
  }

  private async removeStrayFiles(): Promise<void> {
    for (const name of await readdir(this.dir)) {
      if (FILE.test(name) && name !== this.manifest.file) await rm(join(this.dir, name), { force: true }).catch(() => undefined);
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch((error: Error) => this.logger.warn(`knowledge: embedding cache write failed (${error.message})`));
    return run;
  }
}
