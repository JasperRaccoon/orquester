// The unit the usage ledger (`usage-history.ts`) folds in: one hour of one session's use of one
// model, from a transcript scanner (`usage-tokens.ts`) or Orquester's chat logs
// (`usage-chat-threads.ts`). Spec: docs/superpowers/specs/2026-11-02-usage-panel-design.md §4.2.

import type { UsageSpeed } from "@orquester/api";

export type { UsageSpeed };

export interface UsageRecord {
  source: "transcripts" | "orquester-chats";
  /** Registry agent id: claude, codex, grok, opencode. */
  agent: string;
  /** The model id as the provider reported it (aliases are applied at query time). */
  model: string;
  /** UTC hour index: Math.floor(ts / 3_600_000). */
  hour: number;
  /** The working directory the requests ran in (project attribution), or null. */
  cwd: string | null;
  /** Provider session id (transcripts) or Orquester thread id (chats), or null. */
  session: string | null;
  speed: UsageSpeed;
  /** Uncached input. */
  input: number;
  cacheRead: number;
  /** Cache writes in total, {@link cacheWrite1h} included. */
  cacheWrite: number;
  cacheWrite1h: number;
  /** Output, {@link reasoning} included. */
  output: number;
  reasoning: number;
  requests: number;
  /** Sum of provider-reported costs over {@link reportedRequests}. */
  reportedCostUsd: number;
  reportedRequests: number;
}

export interface UsageRecordSource {
  /** Hour-aggregated records after de-duplication; null until the first full scan finished. */
  historyRecords(): UsageRecord[] | null;
}

export const HOUR_MS = 3_600_000;
