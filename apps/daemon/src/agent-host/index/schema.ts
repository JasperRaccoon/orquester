/**
 * Agent host — the thread index's schema (design 2026-09-23 "thread index and
 * lazy boot", §C).
 *
 * Every row here is DERIVED from the per-thread `events.ndjson` logs, which
 * stay the only authority (invariant 1). So there is no migration path at
 * all: a file whose `meta.schema_version` is not {@link INDEX_SCHEMA_VERSION},
 * or that fails `PRAGMA quick_check`, is deleted and rebuilt from the logs
 * (`sqlite.ts`). Bump the version for ANY change to the statements below —
 * and for any change to which rows `indexer.ts` derives into them: a file
 * written by the old rule fits every statement, so only the version keeps
 * its rows from being trusted.
 *
 * Beyond the design's table list, four things are deliberate:
 * - `threads.open_turn_id` names the started turn whose byte range still grows
 *   with every event, and `threads.revert_seq` the latest `thread.reverted`:
 *   a range that began before it is sealed, because a revert must never be
 *   folded into a surviving turn's range (`indexer.ts`). Nor may a removed
 *   turn's lines: the revert clips every surviving range at its cut
 *   (`clipAtCut`), which is stored in `turns` and needs no column.
 * - `threads.inflight` is what the thread has in flight that no `turns` row
 *   can hold — `turns.turn_id` is NOT NULL, and a turn has no id until the
 *   provider starts it: the requested-but-unstarted turns, each with its
 *   position among the started ones and the byte range anchored at its
 *   prompt, and the user messages no turn has claimed yet. A JSON object
 *   `{ pending: [{ startedBefore, requestedAt, userMessageId?, span:
 *   { firstSeq, firstByte, lastSeq, endByte } }], prompts: [{ messageId, seq,
 *   byteOffset }] }`, or `''` when nothing is in flight; rewritten with the
 *   cursor in every batch's transaction, so it is always the state as of
 *   `last_seq`. Its shape is part of this schema: changing it is a version
 *   bump like any column.
 * - `message_docs` is the keyed side of `messages_fts`, the way `items` is the
 *   keyed side of `activities_fts`: an FTS5 table has no index on its
 *   UNINDEXED columns, so "replace message X" or "drop thread Y" against it
 *   directly is a full scan. The FTS row's `rowid` IS the keyed row's `rowid`.
 *   It is also every message's SPAN: written by the first line that names the
 *   message (`first_*`), following its latest (`seq`), whether or not the
 *   message ever has text — a history page must not cut one streamed message
 *   in two. A file from before these columns fails to prepare and is rebuilt.
 *   And its AUTHOR: `role` and `agent_id` (the owning subagent, NULL for the
 *   parent conversation's own), both the first line's — the fold takes a
 *   message's role and owner from its first event and never changes them.
 *   They are what lets the right rail's History reach a thread's own prompts
 *   through the partial index `message_docs_prompts`, which holds the
 *   parent's `user` rows alone: the FTS row's `role` is UNINDEXED and holds
 *   no owner at all, so without them every message of the thread — a
 *   subagent fleet's thousands, text and all — would be read to find a few
 *   hundred prompts. And what a revert decides a message by, as the fold
 *   does (`indexer.ts` `dropRevertedUserMessages`): `turn_id`, the latest
 *   line's, and `created_at`, the first line's stamp.
 * - both FTS tables fold diacritics (`remove_diacritics 2`), so "cafe" finds
 *   "café". Tokens are otherwise `unicode61`'s: letters, numbers, private use.
 */

import type { CompactionMarkerState } from "@orquester/api/agent-chat";

/**
 * 5: the merge of two different 4s (2026-09-27), so neither build's version-4
 * file is this one's. (a) A revert clips every surviving turn's range at its
 * cut — the first removed turn's first line (`clipAtCut` in `indexer.ts`). A
 * late event naming a turn stretches its range past the next turn's start (a
 * turn-end capture, a first-load closer, every row of a call a background
 * agent started there), and a rewind that kept such a turn left it reaching
 * into the turns it removed, whose rows "Load older" then served again; no
 * statement changed for it. (b) `message_docs.role` / `.agent_id` /
 * `.turn_id` / `.created_at` and `message_docs_prompts` — each message's
 * author, turn and stamp, for the thread's prompt list (`queries.ts`
 * `prompts`) — and a revert that drops a thread's user messages by the fold's
 * own rule rather than by position. A version-4 file of the prompts build fits
 * every statement but holds `turns` rows that may reach past a cut; one of the
 * clipping build has none of (b)'s columns. Both are rebuilt by this number,
 * never by a statement failing to prepare.
 *
 * 4: taken by each of those two builds for its own half, (a) or (b).
 *
 * 3: `markers` follows the compaction-marker rule the UI and the MCP share
 * ({@link IndexedMarkerKind}) — the legacy `thread.state.changed` marker
 * counts, a subagent's own compaction does not. No statement changed; a
 * version-2 file's markers were derived by the old rule, so it is rebuilt.
 *
 * 2: `threads.inflight`. Version 1 never shipped, but a file a dev build left
 * behind must read as "another version" — deleted and rebuilt — rather than
 * as a file whose statements fail to prepare.
 */
export const INDEX_SCHEMA_VERSION = 5;

/** The `meta` key that carries {@link INDEX_SCHEMA_VERSION}. */
export const SCHEMA_VERSION_KEY = "schema_version";

/** Every table the module reads or writes; a file missing one is rebuilt. */
export const INDEX_TABLES = [
  "meta",
  "threads",
  "turns",
  "items",
  "message_docs",
  "markers",
  "messages_fts",
  "activities_fts"
] as const;

const FTS_TOKENIZER = "tokenize = 'unicode61 remove_diacritics 2'";

/** Run in order, inside one transaction, on an empty file. */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE meta (
     key TEXT PRIMARY KEY,
     value TEXT
   )`,
  `CREATE TABLE threads (
     thread_id TEXT PRIMARY KEY,
     project_path TEXT NOT NULL,
     title TEXT NOT NULL,
     last_seq INTEGER NOT NULL,
     last_byte INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     open_turn_id TEXT,
     revert_seq INTEGER NOT NULL DEFAULT 0,
     inflight TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE turns (
     thread_id TEXT NOT NULL,
     turn_id TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     user_message_id TEXT,
     requested_at TEXT NOT NULL,
     started_at TEXT,
     completed_at TEXT,
     first_seq INTEGER NOT NULL,
     last_seq INTEGER NOT NULL,
     first_byte INTEGER NOT NULL,
     end_byte INTEGER NOT NULL,
     PRIMARY KEY (thread_id, turn_id)
   )`,
  `CREATE INDEX turns_by_ordinal ON turns (thread_id, ordinal)`,
  // Which turn a seq belongs to, and which turns a seq range meets.
  `CREATE INDEX turns_by_first_seq ON turns (thread_id, first_seq)`,
  // A prompt is written before its turn exists; search finds its turn here.
  `CREATE INDEX turns_by_prompt ON turns (thread_id, user_message_id)`,
  `CREATE TABLE items (
     thread_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     byte_offset INTEGER NOT NULL,
     byte_length INTEGER NOT NULL,
     PRIMARY KEY (thread_id, item_id)
   )`,
  `CREATE INDEX items_by_seq ON items (thread_id, seq)`,
  `CREATE TABLE message_docs (
     thread_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     first_seq INTEGER NOT NULL,
     first_byte INTEGER NOT NULL,
     first_length INTEGER NOT NULL,
     role TEXT NOT NULL,
     agent_id TEXT,
     turn_id TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (thread_id, message_id)
   )`,
  `CREATE INDEX message_docs_by_seq ON message_docs (thread_id, seq)`,
  `CREATE INDEX message_docs_by_first_seq ON message_docs (thread_id, first_seq)`,
  // The parent conversation's user messages in log order — its prompts,
  // newest first. Partial, so it holds those rows and nothing else; a query
  // uses it only when its WHERE names both terms.
  `CREATE INDEX message_docs_prompts ON message_docs (thread_id, first_seq)
     WHERE role = 'user' AND agent_id IS NULL`,
  `CREATE TABLE markers (
     thread_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     kind TEXT NOT NULL,
     PRIMARY KEY (thread_id, seq)
   )`,
  `CREATE VIRTUAL TABLE messages_fts USING fts5 (
     text,
     thread_id UNINDEXED,
     message_id UNINDEXED,
     turn_id UNINDEXED,
     role UNINDEXED,
     seq UNINDEXED,
     at UNINDEXED,
     ${FTS_TOKENIZER}
   )`,
  `CREATE VIRTUAL TABLE activities_fts USING fts5 (
     text,
     thread_id UNINDEXED,
     activity_id UNINDEXED,
     turn_id UNINDEXED,
     kind UNINDEXED,
     seq UNINDEXED,
     at UNINDEXED,
     ${FTS_TOKENIZER}
   )`
];

/**
 * `markers.kind` — the phase of a compaction marker of the conversation
 * itself. One row for each activity `isConversationCompactionActivity` accepts
 * (`@orquester/api` `compaction.ts`, the rule the UI's window gate and the
 * MCP's `revert_session` use too): a `context-compaction` row or the legacy
 * `thread.state.changed {state: "compacted"}`, never one a subagent owns. Its
 * kind is `compactionMarkerState`'s: only a `compacted` marker dropped
 * anything, so only it withholds a rewind (`queries.ts` `rewindable`).
 */
export type IndexedMarkerKind = CompactionMarkerState;
