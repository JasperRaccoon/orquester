import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsageHistoryFile, serializeUsageHistoryFile } from "./index.ts";

const sums = [1, 2, 3, 1, 5, 1, 2, 0.5, 1];

test("a ledger row a newer writer added is kept as read, its table entries at the same indexes, and rewritten unchanged", () => {
  const newerRow = ["transcripts", "claude", "claude-opus-5", "turbo", 100, 1, ...sums, [1]];
  const read = parseUsageHistoryFile({
    version: 2,
    recordedSince: "2026-10-01T00:00:00.000Z",
    future: { keep: true },
    sessions: ["s-current", "s-newer"],
    cwds: ["/work/a", "/work/newer"],
    buckets: [
      ["orquester-chats", "grok", "grok-build", "standard", 101, 0, ...sums, [0], "future-column"],
      newerRow,
      ["transcripts", "codex", "gpt-5.5", "fast", 102, null, ...sums, []],
      "not a row",
      ["transcripts", "codex", "truncated"]
    ]
  });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.file.rows.map((r) => [r.agent, r.hour, r.cwd, r.sessions, r.reportedCostUsd, r.tail]), [
    ["grok", 101, "/work/a", ["s-current"], 0.5, ["future-column"]],
    ["codex", 102, "", [], 0.5, undefined]
  ]);
  assert.deepEqual(read.file.unreadRows, [newerRow]);

  // The current rows change (one goes, one gains a session); the newer row's indexes still resolve.
  const saved = serializeUsageHistoryFile({ ...read.file, rows: [{ ...read.file.rows[0]!, sessions: ["s-current", "s-new"] }] });
  assert.deepEqual(saved.future, { keep: true });
  const { sessions, cwds, buckets } = saved as { sessions: string[]; cwds: string[]; buckets: unknown[][] };
  assert.deepEqual(buckets.at(-1), newerRow);
  assert.equal(sessions[1], "s-newer");
  assert.equal(cwds[1], "/work/newer");
  const reread = parseUsageHistoryFile(saved);
  assert.ok(reread.ok);
  assert.deepEqual(reread.file.rows.map((r) => r.sessions), [["s-current", "s-new"]]);
});

test("rows past retention are left out; a document of another version or none is not read as a ledger", () => {
  const read = parseUsageHistoryFile({ version: 2, sessions: [], cwds: [], buckets: [["transcripts", "claude", "m", "standard", 5, null, ...sums, []], ["transcripts", "claude", "m", "turbo", 5]] }, { minHour: 6 });
  assert.ok(read.ok);
  assert.deepEqual([read.file.rows, read.file.unreadRows, read.pruned], [[], [], true]);
  assert.deepEqual(parseUsageHistoryFile({ version: 3, buckets: [] }), { ok: false, version: 3 });
  assert.deepEqual(parseUsageHistoryFile([1]), { ok: false, version: null });
});
