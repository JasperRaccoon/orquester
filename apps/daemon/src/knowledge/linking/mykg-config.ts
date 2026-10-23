/**
 * Knowledge Graph linking — the `mykg_config.yaml` the daemon writes for the myKG child (spec
 * "Linking runs"). myKG has no built-in defaults: `mykg.config` reads every constant from the
 * YAML found upward from its cwd and raises on a missing key, so the file is one COMPLETE,
 * self-contained profile. It is the pinned version's shipped `agent-claude-code` profile
 * (myKG 0.4.10 `mykg_config.yaml`, verified key by key against `src/mykg/config.py`,
 * `llm/config.py`, `steps/step_validate_graph.py`, `exporter.py` and `cli.py`) with:
 *
 * - `preprocess.enabled: false`, `preprocess.extensions: []` — entries are Markdown; no MinerU
 *   venv is ever built, and the input copy takes `.md` only;
 * - `fetch.enabled: false` — no crawling;
 * - every export that can be switched off is: `networkx_enabled` (it also writes the CDN-loading
 *   `knowledge_graph.html`), `obsidian_enabled`, `neo4j_csv_enabled`, `html_max_nodes: 0`. The
 *   Turtle file (`knowledge_graph.ttl`) is written unconditionally by `validate_graph`: no key
 *   turns it off;
 * - `orphan_pass.enabled: false`; `report.enabled: false` (no post-run walkthrough);
 * - `pass2.prep_mode: batch_chunks` + `batch_per_file: true` — one entry per extraction call, so
 *   an edit or a delete removes exactly that entry's contribution, and a call's concepts are never
 *   credited to another entry (`concat` mode credits a batch to every file in it, which would leak
 *   hidden entries' concepts into visible ones);
 * - smaller chunks and batches ({@link MYKG_CHUNK_TOKENS}, {@link MYKG_BATCH_TOKENS}) so a task
 *   fits a tool result;
 * - name normalization one concept type per call, each type's list capped
 *   ({@link MYKG_NORMALIZE_MAX_NAMES}; the token trade-off is at that constant);
 * - `pass1/pass2/orphan.max_workers` = {@link mykgMaxWorkers} — enough calls in flight that the
 *   inbox always holds at least `concurrency × 2` waiting tasks beside the leased ones;
 * - `llm.timeout` 48 h: an inbox task waits through a usage-limit pause rather than failing the
 *   step (a run that still times out is re-run; answered tasks are cached);
 * - `agent.poll_interval_seconds: 1`; `error_gate` off; `llm_log`/`capture_prompts` off;
 *   `mcp.enabled: false`.
 *
 * `llm.model` is informational for the agent provider (the worker chat's model answers).
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { KNOWLEDGE_CONCURRENCY_MAX, KNOWLEDGE_CONCURRENCY_MIN } from "@orquester/api";

/** The myKG version this config (and the prompt overlay) was verified against. */
export const MYKG_CONFIG_VERSION = "0.4.10";
/** The profile name myKG resolves (`profile:`); the only one in the file. */
export const MYKG_PROFILE = "agent-claude-code";
export const MYKG_CONFIG_FILE = "mykg_config.yaml";
/**
 * Task size. A worker receives each task as an MCP tool result, which Claude Code truncates past
 * `MAX_MCP_OUTPUT_TOKENS` (25k by default; the indexer launch raises it, `CLAUDE_NO_BUILTIN_TOOLS_ENV`).
 * myKG packs whole chunks into a batch up to `batch_token_target`, and a chunk bigger than the
 * target is a batch of its own — with the shipped 25k-token window one long article would be a
 * 25k-token task. Chunks of 8k tokens and 12k-token batches keep every task's input ≤ 12k tokens
 * (plus myKG's prompt and, once per chat, the step's instructions). `max_schema_proposals: 12`
 * bounds Pass 1's harmonize call (it sends every sampled proposal in one task).
 */
export const MYKG_CHUNK_TOKENS = 8000;
export const MYKG_BATCH_TOKENS = 12000;

/**
 * Name normalization (`normalize_names`, myKG 0.4.10 `name_normalizer.py`, `steps/step_normalize.py`)
 * is the one step whose cost grows with the whole knowledge base: every run that changes anything
 * sends the inventory of EVERY extracted name, grouped by concept type, so the model can map
 * surface forms ("Alice", "A. Smith") to one canonical name.
 *
 * What myKG lets us control, and why the cheaper-looking options are wrong:
 * - `enabled: false` on small updates (or `max_names_per_type` cut down for them) is NOT an
 *   option. Each run rebuilds `raw_extractions.json` from the per-entry shards, which hold the
 *   names as extracted (not normalized), and rewrites `name_normalization.json` from this run's
 *   answers alone. A run without normalization therefore UNDOES every earlier merge: aliases split
 *   back into duplicate concepts until the next full normalization. Quality would oscillate.
 * - Nothing in myKG makes it incremental: no "only new names" mode, no cross-run alias memory.
 *
 * So the step always runs on every name, and the plugin makes it cheap through caching instead:
 * - `batch_token_target: 1` puts each concept type in a call of its own (myKG never splits a type;
 *   it packs whole types greedily up to the target). An answered task is cached by its prompt, so a
 *   type whose names did not change costs nothing; with packed batches, one new name re-sent every
 *   type packed beside it, and a type that grew shifted the packing of all the types after it.
 * - myKG's cache key also holds the call's label, `normalize_names batch i/n`, which moves when a
 *   type appears or the types reorder; the inbox broker therefore answers a normalization task
 *   from an earlier answer to the identical prompt (`inbox.ts` `REUSABLE_STEPS`), label aside.
 * - Per call, the step's instructions reach a worker chat once per chat (the broker's dedup), so
 *   more, smaller calls add little beyond each type's own names.
 * Net effect: an update re-sends only the name lists of the types it touched (typically the few a
 * new entry adds names to), not the whole inventory; quality is unchanged, every name is still
 * normalized against every other name of its type.
 *
 * `max_names_per_type` keeps one type's call within a tool result (myKG's own cap of 50k names
 * would be a ~300k-token task no chat could read whole): names past the first
 * `MYKG_NORMALIZE_MAX_NAMES` of a type (myKG keeps them sorted, so alphabetically last) are not
 * normalized — only ever a concern for a type with thousands of distinct names.
 */
export const MYKG_NORMALIZE_BATCH_TOKENS = 1;
export const MYKG_NORMALIZE_MAX_NAMES = 6000;

/** Seconds a task waits for its `.done` (myKG `llm.timeout`). */
export const MYKG_TASK_TIMEOUT_SECONDS = 48 * 60 * 60;

/** myKG's concurrent LLM calls for `concurrency` worker chats: 3 × concurrency, 4..24. */
export function mykgMaxWorkers(concurrency: number): number {
  const c = Math.min(KNOWLEDGE_CONCURRENCY_MAX, Math.max(KNOWLEDGE_CONCURRENCY_MIN, Math.round(concurrency)));
  return Math.min(24, Math.max(4, c * 3));
}

export interface MykgConfigOptions {
  /** Worker chats at once (`KnowledgeSettings.concurrency`). */
  concurrency: number;
  /** Informational only (the worker chats' model). */
  model?: string | null;
}

/** The config document (a plain object; {@link renderMykgConfig} writes it as YAML). */
export function buildMykgConfig(options: MykgConfigOptions): Record<string, unknown> {
  const workers = mykgMaxWorkers(options.concurrency);
  return {
    profile: MYKG_PROFILE,
    profiles: {
      [MYKG_PROFILE]: {
        provider: "agent",
        llm_retry: { max_retries: 0 },
        llm: {
          context_window: 200000,
          model: options.model?.trim() || "sonnet",
          max_output_tokens: 32000,
          timeout: MYKG_TASK_TIMEOUT_SECONDS,
          retry_429_max: 3,
          retry_429_base_delay: 2.0
        },
        agent: { inbox_dir: "agent_inbox", outbox_dir: "agent_outbox", poll_interval_seconds: 1 },
        pipeline: {
          ingest: { max_workers: 8 },
          preprocess: {
            enabled: false,
            subdir: "_preprocessed",
            keep_artifacts: false,
            extra_args: [],
            timeout_seconds: 1800,
            uv_path: "uv",
            uv_python_version: "3.12",
            mineru_spec: "mineru[all] pdftext<0.7.0",
            install_timeout_seconds: 1800,
            extensions: []
          },
          fetch: { enabled: false, max_workers: 1 },
          chunking: { window_tokens: MYKG_CHUNK_TOKENS, overlap_tokens: 800, tiktoken_encoding: "cl100k_base" },
          pass1: {
            batch_token_target: MYKG_BATCH_TOKENS,
            max_workers: workers,
            per_file_batching: false,
            max_schema_proposals: 12,
            random_seed: 0
          },
          pass2: {
            max_workers: workers,
            stateful_chunks: false,
            prep_mode: "batch_chunks",
            per_file_token_target: 15000,
            concat_batch_token_target: 15000,
            batch_token_target: MYKG_BATCH_TOKENS,
            batch_per_file: true,
            batch_retry_max: 0
          },
          normalize_names: { enabled: true, max_names_per_type: MYKG_NORMALIZE_MAX_NAMES, batch_token_target: MYKG_NORMALIZE_BATCH_TOKENS },
          orphan_pass: {
            enabled: false,
            min_cooccurrence: 1,
            top_k_per_orphan: 5,
            confidence_base: 0.5,
            confidence_weight: 0.5,
            max_workers: workers,
            schema_max_restarts: 0,
            excerpt_window: 4000,
            excerpt_context: 1500,
            excerpt_max_total: 16000,
            blank_recovery_enabled: true,
            connected_sample_size: 200
          },
          assembly: {
            confidence_agg: "mean",
            edge_id_prefix: "edge-",
            edge_id_hex_length: 6,
            edge_dedup_separator: "|",
            confidence_fallback: 0.0,
            confidence_scalar_omitted: 0.5
          },
          export: {
            schema_namespace: "http://mykg.local/schema/",
            data_namespace: "http://mykg.local/data/",
            rdf_namespace: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
            rdfs_namespace: "http://www.w3.org/2000/01/rdf-schema#",
            schema_prefix_label: "ex",
            data_prefix_label: "data",
            comment_width: 42,
            skos_namespace: "http://www.w3.org/2004/02/skos/core#",
            networkx_enabled: false,
            obsidian_enabled: false,
            obsidian_vault_dir: "obsidian_vault",
            neo4j_csv_enabled: false,
            neo4j_csv_dir: "neo4j_csv",
            html_max_nodes: 0
          },
          error_gate: { enabled: false, threshold: 3 },
          feedback: { max_file_chars: 64000 },
          paths: { output_dir: "output", intermediate_dir: "intermediate", sessions_dir: "mykg_sessions" },
          output: { json_indent: 2 },
          logging: { max_bytes: 10485760, backup_count: 3, llm_log: false, capture_prompts: false, error_output_max_chars: 2000 },
          report: { enabled: false },
          merge_graphs: {
            reextraction_strategy: "surgical",
            surgical_top_k_chunks_per_property: 1,
            human_review: false,
            orphan_pass_max_restarts: 0
          },
          append: { grow_schema_backfill_top_k_chunks_per_type: 10 }
        },
        mcp: { enabled: false, host: "localhost", port: 3100, transport: "stdio" }
      }
    }
  };
}

const HEADER = `# Written by Orquester's Knowledge Graph plugin for myKG ${MYKG_CONFIG_VERSION}. Do not edit:
# it is rewritten before every linking run.
`;

/** The YAML text. Every string is quoted, so a value never changes type on the way through PyYAML. */
export function renderMykgConfig(options: MykgConfigOptions): string {
  return HEADER + stringify(buildMykgConfig(options), { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", lineWidth: 0 });
}

/** Writes `<mykgDir>/mykg_config.yaml` atomically (temp + rename). Returns its path. */
export async function writeMykgConfig(mykgDir: string, options: MykgConfigOptions): Promise<string> {
  await mkdir(mykgDir, { recursive: true, mode: 0o700 });
  const path = join(mykgDir, MYKG_CONFIG_FILE);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, renderMykgConfig(options), { mode: 0o600 });
  await rename(tmp, path);
  return path;
}
