# Final agent-host title aliases

These five current titles rename already audited owners. They add no test and change no baseline
disposition count. [The JSON](final-aliases-host.json) records exact original and absorbed
identities, source ledgers and all six behavioral requirements for each surviving owner.

| Final path and line | Final title | Disposition | Original owner |
|---|---|---|---|
| `adapters/codex/mcp-apps.test.ts:332` | an app's model context updates between turns as untrusted context beside the session tools | CONSOLIDATE | `an app's model context rides every turn as untrusted additional context` in [host-adapters](host-adapters.json); also absorbs the toolkit-coexistence case. |
| `adapters/mcp-app-capture.test.ts:314` | reuses the tool listing for 30 s, then expires it; clear invalidates it immediately | REWRITE | `answers within its time-to-live, forgets after it or on clear, and stays bounded` in [host-adapters](host-adapters.json). |
| `adapters/opencode/history.test.ts:136` | fixture 10: history preserves messages, settled turns, unavailable usage and historical attribution | CONSOLIDATE | `fixture 10: the captured history replays as turn markers around completed items` in [Claude/OpenCode adapters](adapters-claude-opencode.json); also absorbs unavailable-usage and historical-stamp cases. |
| `adapters/opencode/snapshot-budget.test.ts:107` | E9: a cold probe waits for readiness and reads the catalogue; the next probe reuses its project server | CONSOLIDATE | `E9: a COLD probe waits for the server to report ready, then reads the catalogue` in [Claude/OpenCode adapters](adapters-claude-opencode.json); also absorbs the second warm probe. |
| `orchestration/launch-config.test.ts:39` | round-trips launcher credentials, keyed server and profile through a private file and a fresh store | CONSOLIDATE | `round-trips through a 0600 file and survives a reread` in [host orchestration](host-orchestration.json); also absorbs keyed-server and profile roundtrips. |

Paths above are relative to `apps/daemon/src/agent-host/`. Evidence follows the existing contracts:
untrusted Codex app context beside toolkit instructions, a real 30-second listing cache,
captured OpenCode history with unavailable usage and correct provenance, cold readiness followed
by canonical-project server reuse, and persisted launcher credentials/profile/server data in a
0600 file. Independent oracles are literal provider frames/events, controlled clock boundaries,
real process readiness and actual filesystem results. Their former duplicate executions remain
absorbed by these owners; this document does not restore or rerun them.

Only documentation changed. All five final path/line/title identities were checked against current
source; no test was run for this alias mapping.
