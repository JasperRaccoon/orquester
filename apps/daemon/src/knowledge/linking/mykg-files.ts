/**
 * Knowledge Graph linking — where myKG keeps a session and how far a run is (myKG 0.4.10:
 * `cli.py` `_make_session_dirs`, `orchestrator.py` `PipelineState.save`, `pass2.py`
 * `run_pass2_batched`).
 *
 * `<mykgDir>/mykg_sessions/<session>/{input,intermediate,output}`; the graph is
 * `output/nodes.jsonl` + `output/edges.jsonl`. `intermediate/pipeline_state.json` holds a status per
 * step (`pending | running | waiting | done | failed`) and the failed steps' `errors`; its
 * top-level `status` is ALWAYS "running", so it is never read. `intermediate/pass2_progress.json`
 * (`total_batches`, `completed`, `failed`) is advisory and only exists in Pass 2.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MYKG_SESSIONS_DIR = "mykg_sessions";

export interface MykgSessionPaths {
  root: string;
  input: string;
  intermediate: string;
  output: string;
  nodes: string;
  edges: string;
}

export function mykgSessionPaths(mykgDir: string, session: string): MykgSessionPaths {
  const root = join(mykgDir, MYKG_SESSIONS_DIR, session);
  const output = join(root, "output");
  return {
    root,
    input: join(root, "input"),
    intermediate: join(root, "intermediate"),
    output,
    nodes: join(output, "nodes.jsonl"),
    edges: join(output, "edges.jsonl")
  };
}

/** myKG session names are UTC timestamps (`2026-10-23T10-00-00`); anything path-like is refused. */
export function isMykgSessionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes("..");
}

export interface MykgProgress {
  /** The step running now, else the last one that is not done; null when nothing is known. */
  step: string | null;
  /** Steps that failed, with myKG's error text. */
  failed: { step: string; error: string }[];
  /** Pass 2's batches (one per entry with `batch_per_file`), while it runs. */
  pass2: { done: number; total: number } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Reads a session's progress files; a missing or half-written file reads as "unknown". */
export async function readMykgProgress(intermediateDir: string): Promise<MykgProgress> {
  const state = await readJson(join(intermediateDir, "pipeline_state.json"));
  let step: string | null = null;
  const failed: MykgProgress["failed"] = [];
  if (isRecord(state) && isRecord(state.steps)) {
    let lastOpen: string | null = null;
    for (const [name, value] of Object.entries(state.steps)) {
      const status = isRecord(value) ? value.status : undefined;
      if (status === "running" || status === "waiting") step = name;
      if (status !== "done" && lastOpen === null && status !== "pending") lastOpen = name;
      if (status === "failed") {
        const errors = isRecord(state.errors) ? state.errors[name] : undefined;
        const error = isRecord(errors) && typeof errors.error === "string" ? errors.error : "failed";
        failed.push({ step: name, error });
      }
    }
    step ??= lastOpen;
  }
  let pass2: MykgProgress["pass2"] = null;
  if (step === "pass2") {
    const progress = await readJson(join(intermediateDir, "pass2_progress.json"));
    if (isRecord(progress) && typeof progress.total_batches === "number") {
      const done = (typeof progress.completed === "number" ? progress.completed : 0) + (typeof progress.failed === "number" ? progress.failed : 0);
      pass2 = { done, total: progress.total_batches };
    }
  }
  return { step, failed, pass2 };
}

/** Entry ids whose extraction myKG gave up on (`intermediate/failed_chunks.json`, keyed by input file). */
export async function readFailedEntryIds(intermediateDir: string): Promise<string[]> {
  const value = await readJson(join(intermediateDir, "failed_chunks.json"));
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.filename !== "string") continue;
    const base = item.filename.split("/").at(-1) ?? "";
    if (base.endsWith(".md")) ids.add(base.slice(0, -3));
  }
  return [...ids];
}
