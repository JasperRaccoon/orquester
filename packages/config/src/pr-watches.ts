// Pull request watches — the on-disk schema (docs/superpowers/specs/2026-10-14-agent-visuals-and-
// session-tools-design.md §5 "PR watch").
//
//   <appdir>/daemon/pr-watches.json   0600, the daemon's own file (`pullRequestWatchesPath`)
//
// Read tolerantly, entry by entry: a malformed entry is kept aside as it was (`unreadable`) and
// written back unchanged, never dropped, and unknown fields of a good entry survive a rewrite
// (`passthrough`), so a newer daemon's watches outlive a rollback. Fields that are only progress
// (`told`, `failures`, `lastError`, `lastStatus`) fall back to their empty value rather than costing
// the watch. No credential is ever stored here: the repository URL is credential-free and the
// account is re-resolved from the project's workspace on every read.
//
// This module imports only zod: the path helper lives in index.ts, which re-exports this file.

import { z } from "zod";

/** What the watch has already told its thread — the dedupe state. A wake moves it forward. */
export const pullRequestWatchToldSchema = z
  .object({
    /** The head commit the told check state belongs to; null before the first read. */
    headSha: z.string().nullable().catch(null).default(null),
    /** Names of the checks already reported failed on `headSha`. */
    failedChecks: z.array(z.string()).catch([]).default([]),
    /** "All checks passed" was reported for `headSha`. */
    passed: z.boolean().catch(false).default(false),
    /** The gate's check names when `passed` was reported. */
    passedChecks: z.array(z.string()).catch([]).default([]),
    /** ISO time: remarks active at or before it were reported (or predate the watch). */
    remarksThrough: z.string(),
    /** Remarks AT `remarksThrough` already reported (hosts stamp per second). */
    remarkIds: z.array(z.string()).catch([]).default([]),
    /** A conflict with the base branch was reported and not yet cleared. */
    conflicting: z.boolean().catch(false).default(false),
    /** Comment-only wakes in a row (a chatty bot's loop guard). */
    wakes: z.number().int().nonnegative().catch(0).default(0)
  })
  .passthrough();
export type PullRequestWatchTold = z.infer<typeof pullRequestWatchToldSchema>;

/** The last read's digest, for the UI's chip and the list tool. */
export const pullRequestWatchStatusSchema = z
  .object({
    state: z.enum(["open", "merged", "closed"]).catch("open"),
    title: z.string().catch(""),
    headSha: z.string().nullable().catch(null),
    baseBranch: z.string().catch(""),
    mergeability: z.enum(["clean", "conflicting", "unknown"]).catch("unknown"),
    checks: z
      .object({
        total: z.number().int().nonnegative().catch(0),
        passed: z.number().int().nonnegative().catch(0),
        failed: z.number().int().nonnegative().catch(0),
        pending: z.number().int().nonnegative().catch(0)
      })
      .catch({ total: 0, passed: 0, failed: 0, pending: 0 })
  })
  .passthrough();
export type PullRequestWatchStatusRecord = z.infer<typeof pullRequestWatchStatusSchema>;

/**
 * A wake persisted BEFORE it is posted: re-posted under the same `commandId` after a crash or a
 * refused attempt, so the host's command receipts deliver it once.
 */
export const pullRequestWatchWakeSchema = z
  .object({
    commandId: z.string().min(1).max(200),
    /** The whole `/turn` input. */
    input: z.string().min(1),
    createdAt: z.string(),
    /** Refused deliveries so far. */
    attempts: z.number().int().nonnegative().catch(0).default(0),
    /**
     * Set (and saved) before the first post: the host may hold it, so its text can no longer
     * change. An unposted wake is rewritten when one of its watches stops.
     */
    posted: z.boolean().catch(true).default(true),
    /** This watch's own part of the message, so the rest can be recomposed without it. */
    part: z
      .object({
        summary: z.string(),
        lines: z.array(z.string()),
        /** The watch keeps going after this message. */
        watching: z.boolean(),
        /** The part reports checks or a conflict (something to act on). */
        actionable: z.boolean(),
        /** The part quotes other people's comments. */
        comments: z.boolean()
      })
      .passthrough()
      .optional()
      .catch(undefined)
  })
  .passthrough();
export type PullRequestWatchWake = z.infer<typeof pullRequestWatchWakeSchema>;

export const PULL_REQUEST_WATCH_END_REASONS = ["merged", "closed", "unreadable", "comment-limit", "thread-gone"] as const;
export type PullRequestWatchEndReason = (typeof PULL_REQUEST_WATCH_END_REASONS)[number];

export const pullRequestWatchSchema = z
  .object({
    id: z.string().min(1).max(200),
    /** The chat thread (= session id) the watch wakes. */
    sessionId: z.string().min(1),
    /** The thread's project when the watch started: the account is its workspace's. */
    projectPath: z.string().min(1),
    /** Credential-free repository URL the pull request is read from. */
    repoUrl: z.string().min(1),
    /** "owner/repo" as shown (DC: "PROJECT/repo"). */
    repository: z.string().catch(""),
    number: z.number().int().positive(),
    /** The pull request's web page. */
    url: z.string().catch(""),
    startedAt: z.string(),
    told: pullRequestWatchToldSchema,
    lastStatus: pullRequestWatchStatusSchema.nullable().catch(null).default(null),
    lastCheckedAt: z.string().nullable().catch(null).default(null),
    /** A short, credential-free reason the last read failed; null after a good one. */
    lastError: z.string().max(500).nullable().catch(null).default(null),
    /** Reads in a row that failed for a reason other than a rate limit. */
    failures: z.number().int().nonnegative().catch(0).default(0),
    pendingWake: pullRequestWatchWakeSchema.nullable().catch(null).default(null),
    /**
     * Set when the watch ended (merged, closed, unreadable…). An ended watch is no longer read;
     * its record stays only until its last wake is delivered.
     */
    endedAt: z.string().nullable().catch(null).default(null),
    /**
     * One of {@link PULL_REQUEST_WATCH_END_REASONS}, or a newer build's reason, kept verbatim (this
     * build only drops such a watch once nothing is left to tell).
     */
    endReason: z.string().max(64).nullable().catch(null).default(null)
  })
  .passthrough();
export type PullRequestWatchRecord = z.infer<typeof pullRequestWatchSchema>;

export interface PullRequestWatchFile {
  watches: PullRequestWatchRecord[];
  /** Entries this build cannot read, kept verbatim for the next rewrite. */
  unreadable: unknown[];
}

export function parsePullRequestWatchFile(value: unknown): PullRequestWatchFile {
  const raw =
    value !== null && typeof value === "object" && Array.isArray((value as { watches?: unknown }).watches)
      ? (value as { watches: unknown[] }).watches
      : [];
  const watches: PullRequestWatchRecord[] = [];
  const unreadable: unknown[] = [];
  for (const entry of raw) {
    const parsed = pullRequestWatchSchema.safeParse(entry);
    if (parsed.success) watches.push(parsed.data);
    else unreadable.push(entry);
  }
  return { watches, unreadable };
}

/** The file body to write: readable watches first, then the unreadable ones as they were. */
export function serializePullRequestWatchFile(file: PullRequestWatchFile): string {
  return `${JSON.stringify({ version: 1, watches: [...file.watches, ...file.unreadable] }, null, 2)}\n`;
}
