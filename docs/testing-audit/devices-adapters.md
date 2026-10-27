# Incoming Devices adapter audit

Compared `923b3a51b594ef668483a5bd320af41187899e34` with incoming
`610d3c53b480dcfe71ff45f14ce59b6df29f8bf8` using the frozen Devices reference.
The adapter delta changes one test declaration and adds none. Its only edit removes an unused
destructured `globalGrok` value. Disposition: **1 KEEP**, no additional adapter code changes or
test LOC changes. [Machine-readable evidence](devices-adapters.json) contains exact identities,
sources, all six retention requirements, source review and validation limits.

| Exact test at incoming reference | Disposition | Contract and unique failure |
|---|---|---|
| `apps/daemon/src/agent-host/adapters/grok/profile-isolation.live.test.ts:263`, `Grok profile isolation (live)` → `a real session (no prompt): the catalog includes profile/repo skills, excludes Global skills and runs the profile hook` | KEEP | Agent Profiles design §6.3 and §8 requires profile/repo items, Global isolation and an actually firing profile hook. A real session detects lost profile plugin argv, wrong home, incompatible CLI discovery or a non-running hook. |

Expected skill names come from independently created profile/repo inputs, forbidden names come
from the Global filesystem, and a real hook writes the marker file. The stable boundary is the
real CLI's `available_commands_update` plus that filesystem effect, reached through
`createGrokAdapter.startSession`. No private call shape is asserted. The neighboring inspect
cases and fake-provider spawn tests cannot prove runtime plugin hook execution; inspect itself
can misreport disabled plugins. This no-prompt session is the narrow real-provider owner of that
runtime contract. It uses catalog arrival and a cleared failure deadline, without an arbitrary
sleep.

The 12 changed adapter production owners outside the MCP agent's `session-tools.ts` scope were
also inspected. Nine export/re-export removals have no external repository callers; stdio-entry,
history-source and shorter-prefix text helpers were inlined without changing their values or
conditions. No further dead seam was found. After integration, these owner files and the changed
live test match the incoming source. The earlier Grok replay pacing, Codex MCP consolidation,
capture/peer timeout cleanup and capacity-error coverage remain intact relative to local HEAD.

No test run or performance measurement was made for this incoming adapter delta: root owns the
test slot. The live case requires `ORQUESTER_GROK_LIVE=1`, a real Grok executable and an explicit
authentication path; ordinary suite runs skip it. No speedup or authenticated validation is
claimed. Source-only review and this report's `git diff --check` passed.
