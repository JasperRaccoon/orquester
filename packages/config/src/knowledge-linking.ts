// state.json — the Knowledge Graph plugin's linking state (spec
// docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md, "Linking runs"): the myKG
// session the graph lives in, what is waiting to be linked, the run in flight (persisted BEFORE its
// child is spawned, so a restart re-runs it), recent run results, token totals and the last error.
//
// This module imports only zod: the path helper (`knowledgeStatePath`) lives in index.ts, which
// re-exports this file. `@orquester/config` does not depend on `@orquester/api`, so the run and
// worker records MIRROR `KnowledgeRunSummary` / `KnowledgeWorkerView` there; keep them in step.
//
// Tolerance (AGENTS.md): every object is `passthrough`, so a field a newer build added survives this
// build's rewrite; every field reads with a default (`.catch`), so a bad value costs that field, never
// the file. A list entry that does not read is dropped.
//
// A file a NEWER build wrote (a higher `version`, e.g. after a rollback) is read, not moved aside:
// `readKnowledgeLinkingState` reads the fields this build knows (the myKG session, the runs …),
// says whether every one of them read exactly as written (`intact`), and keeps the newer version
// and every unknown field for a rewrite. The daemon runs no linking on it and writes it back only
// when it read intact (`apps/daemon/src/knowledge/linking/state.ts`).
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`.**

import { z } from "zod";

export const KNOWLEDGE_LINKING_STATE_VERSION = 1;
/** Run summaries kept (newest first). */
export const KNOWLEDGE_RECENT_RUNS_MAX = 20;
/** Worker records kept (the current run's and the most recent ones). */
export const KNOWLEDGE_RECENT_WORKERS_MAX = 40;
/** Days of per-day token totals kept (the week's figure reads the last 7). */
export const KNOWLEDGE_TOKEN_DAYS_MAX = 35;

const RUN_MODES = ["full", "update", "grow-schema", "rebuild"] as const;
const PAUSE_REASONS = ["usage-limit", "no-account", "not-installed", "plugin-off", "error"] as const;

const count = z.number().int().nonnegative().catch(0);
const nullableString = z.string().nullable().catch(null);

/** A list whose unreadable entries are dropped, never the file. */
function tolerantList<T extends z.ZodTypeAny>(item: T): z.ZodType<z.infer<T>[], z.ZodTypeDef, unknown> {
  return z
    .array(z.unknown())
    .catch([])
    .transform((values) => values.flatMap((value) => {
      const parsed = item.safeParse(value);
      return parsed.success ? [parsed.data as z.infer<T>] : [];
    }));
}

export const knowledgeRunRecordSchema = z
  .object({
    id: z.string().min(1),
    mode: z.enum(RUN_MODES),
    startedAt: z.string(),
    finishedAt: nullableString,
    durationMs: z.number().nonnegative().nullable().catch(null),
    entries: count,
    tasks: count,
    tokensIn: count,
    tokensOut: count,
    outcome: z.enum(["running", "ok", "failed", "cancelled"]).catch("failed"),
    error: nullableString
  })
  .passthrough();
export type KnowledgeRunRecord = z.infer<typeof knowledgeRunRecordSchema>;

export const knowledgeWorkerRecordSchema = z
  .object({
    sessionId: z.string().min(1),
    accountId: z.string().catch(""),
    runId: z.string().min(1),
    state: z.enum(["running", "done", "failed"]).catch("done"),
    tasks: count,
    startedAt: z.string(),
    finishedAt: nullableString
  })
  .passthrough();
export type KnowledgeWorkerRecord = z.infer<typeof knowledgeWorkerRecordSchema>;

/** The run in flight, written before its child starts. */
export const knowledgeCurrentRunSchema = z
  .object({
    id: z.string().min(1),
    mode: z.enum(RUN_MODES),
    startedAt: z.string(),
    /**
     * The myKG session it extracts into: the recorded one for `update`/`grow-schema`; for `full`
     * and `rebuild`, null until the child names the session it created (`Session: <name>`).
     */
    session: nullableString,
    /** Entries the run links (their link state is set when it ends). */
    entryIds: z.array(z.string()).catch([]),
    /**
     * Each entry's `contentHash` when the run started: only an entry still at that hash is marked
     * `linked` (or `failed`) when the run ends; one edited meanwhile stays pending for the next run.
     */
    entryHashes: z.record(z.string()).catch({}),
    tasks: count,
    tokensIn: count,
    tokensOut: count,
    /** The child's pid while it runs (a restart stops a survivor before re-running). */
    pid: z.number().int().positive().nullable().catch(null),
    /**
     * That pid's start time (Linux: `/proc/<pid>/stat` field 22, clock ticks since boot), so a
     * restart never signals another process that reused the pid; null when it was not read.
     */
    pidStartTime: z.number().int().nonnegative().nullable().catch(null)
  })
  .passthrough();
export type KnowledgeCurrentRunRecord = z.infer<typeof knowledgeCurrentRunSchema>;

const tokenPairSchema = z.object({ in: count, out: count }).passthrough().catch({ in: 0, out: 0 });

export const knowledgePauseRecordSchema = z
  .object({
    reason: z.enum(PAUSE_REASONS),
    message: z.string().catch(""),
    resumesAt: nullableString
  })
  .passthrough();
export type KnowledgePauseRecord = z.infer<typeof knowledgePauseRecordSchema>;

export const knowledgeLinkingStateSchema = z
  .object({
    version: z.literal(KNOWLEDGE_LINKING_STATE_VERSION),
    /** The myKG session the graph lives in (`mykg_sessions/<session>`); null before the first run. */
    session: nullableString,
    /** When the first change still waiting to be linked was recorded. */
    pendingSince: nullableString,
    pendingEntryIds: z.array(z.string()).catch([]),
    /** A "Rebuild graph" waits for the run in flight. */
    rebuildRequested: z.boolean().catch(false),
    /**
     * A full extract or rebuild that created this session and did not finish: the next full or
     * rebuild run resumes it (`--session`, no `--update`), reusing the tasks it answered.
     */
    resumeSession: nullableString,
    /** Schema growth policy inputs: entries when the schema last changed, entries linked since. */
    schema: z
      .object({ entriesAtChange: count, changedSince: count })
      .passthrough()
      .catch({ entriesAtChange: 0, changedSince: 0 }),
    currentRun: knowledgeCurrentRunSchema.nullable().catch(null),
    /** A pause that outlives the process (an error, waiting for a usage reset). */
    pause: knowledgePauseRecordSchema.nullable().catch(null),
    recentRuns: tolerantList(knowledgeRunRecordSchema),
    workers: tolerantList(knowledgeWorkerRecordSchema),
    tokens: z
      .object({
        total: tokenPairSchema,
        /** `YYYY-MM-DD` (UTC) → that day's totals. */
        byDay: z.record(tokenPairSchema).catch({})
      })
      .passthrough()
      .catch({ total: { in: 0, out: 0 }, byDay: {} }),
    lastError: z.object({ message: z.string(), at: z.string() }).passthrough().nullable().catch(null)
  })
  .passthrough();
export type KnowledgeLinkingStateRecord = z.infer<typeof knowledgeLinkingStateSchema>;

export function emptyKnowledgeLinkingState(): KnowledgeLinkingStateRecord {
  return {
    version: KNOWLEDGE_LINKING_STATE_VERSION,
    session: null,
    pendingSince: null,
    pendingEntryIds: [],
    rebuildRequested: false,
    resumeSession: null,
    schema: { entriesAtChange: 0, changedSince: 0 },
    currentRun: null,
    pause: null,
    recentRuns: [],
    workers: [],
    tokens: { total: { in: 0, out: 0 }, byDay: {} },
    lastError: null
  };
}

/**
 * Reads a `state.json` value. Throws when it is not a version-1 object (the caller keeps the file
 * aside and starts empty); anything inside it that does not read falls back to its default.
 */
export function parseKnowledgeLinkingState(value: unknown): KnowledgeLinkingStateRecord {
  const parsed = knowledgeLinkingStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Not a version-${KNOWLEDGE_LINKING_STATE_VERSION} knowledge linking state.`);
  }
  return parsed.data;
}

export type KnowledgeLinkingStateRead =
  | { kind: "current"; state: KnowledgeLinkingStateRecord }
  | {
      kind: "newer";
      /** The file's version (written back on a rewrite). */
      version: number;
      /** What this build reads of it (its unknown fields kept); `state.version` is this build's. */
      state: KnowledgeLinkingStateRecord;
      /**
       * Every field this build knows that the file holds read exactly as written (none fell back
       * to a default, no list entry was dropped): only then may the file be written back.
       */
      intact: boolean;
    };

/**
 * Reads a `state.json` value, a newer build's included (see the header). Throws when it is neither
 * a version-1 object nor an object of a higher integer version.
 */
export function readKnowledgeLinkingState(value: unknown): KnowledgeLinkingStateRead {
  if (isPlainObject(value) && Number.isInteger(value.version) && (value.version as number) > KNOWLEDGE_LINKING_STATE_VERSION) {
    const parsed = knowledgeLinkingStateSchema.safeParse({ ...value, version: KNOWLEDGE_LINKING_STATE_VERSION });
    if (!parsed.success) throw new Error("Not a readable knowledge linking state.");
    const state = parsed.data as Record<string, unknown>;
    const intact = Object.keys(knowledgeLinkingStateSchema.shape).every(
      (key) => key === "version" || !Object.prototype.hasOwnProperty.call(value, key) || jsonEqual(value[key], state[key])
    );
    return { kind: "newer", version: value.version as number, state: parsed.data, intact };
  }
  return { kind: "current", state: parseKnowledgeLinkingState(value) };
}

/** The file text; `version` is a newer file's own (`readKnowledgeLinkingState`), else this build's. */
export function serializeKnowledgeLinkingState(state: KnowledgeLinkingStateRecord, version: number = KNOWLEDGE_LINKING_STATE_VERSION): string {
  return `${JSON.stringify({ ...state, version }, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deep equality of JSON values (object key order aside). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEqual(a[key], b[key]));
}
