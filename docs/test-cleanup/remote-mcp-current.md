# Incoming MCP profile test cleanup

Status: completed cleanup. The audit below was recorded before source merge/edit against `origin/main` at `8d216c11`. Scope: all 20 incoming `apps/daemon/src/mcp/tools/agent-profile.test.ts` tests, its production owner and incoming `mcp/server.test.ts` changes. Completed dispositions: 16 REWRITE, 4 DELETE; no unchanged profile KEEP.

Independent source: `docs/orquester-mcp.md` §13 (Tools, Creating and editing, Revisions, Instructions, Imports from Git, Secrets, Errors), shared `packages/api` agent-profile wire contracts, and AGENTS.md DaemonApi/security boundaries. Read the complete incoming tests and `tools/agent-profile.ts`; compared server changes with the already-cleaned server test. Native-storage contracts are owned by the retained adapter/service/import suites (see `agent-profile.md`), while one real MCP-to-native-file workflow remains in `remote-profile-current.md`.

Common bars 4–5 and callers for every REWRITE below: invoke a registered public tool with its strict input schema; observe caller result/error or the documented public DaemonApi HTTP payload. Production callers are external MCP agents through `mcp/server.ts`; HTTP route consumers also include the agent-profile GUI through the shared API. DaemonApi requests are a stable cross-package contract, not private collaborators. Canned route responses contain fixed facts only and implement no persistence, revisions, secret merge, conflict policy, filtering, IDs or imports. No assertion uses private call ordering/counts except proving a rejected preflight emits no request. Internal helper extraction/renaming and equivalent route-client refactors preserve all assertions.

Risk and validation for each row: security/writes have medium regression impact, read projection/byte-limit cases low-to-medium; exact unique failure is listed. Rewrites reduce fake-domain confidence and preserve the narrow independent seam. Focused command after merge: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/agent-profile.test.ts apps/daemon/src/mcp/server.test.ts`. Root owns `pnpm check`, `pnpm test`, merge and push. Before concluding, inspect scoped diff and `git diff --check`.

## REWRITE: list_agent_profiles: every agent with installed, version and counts; installedOnly filters

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Tools table: installedOnly filters available agents.
- **2 Detectable failure:** an unavailable agent is offered to an installed-only caller.
- **3 Independent oracle:** literal installed flags and expected agent ids.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** overview fixture has fixed values; delete fake counting.
- **6 Lowest owner / remaining stronger coverage:** MCP filtering has no lower owner; API overview types and adapter discovery own availability.

## REWRITE: get_agent_profile: items with their flags and revisions, instructions, authoring; kind and query filter

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Tools/Item/authoring: kind and case-insensitive id/name/description/source filtering, actionable flags, revisions and counts.
- **2 Detectable failure:** a matching plugin skill is hidden, a locked source appears editable, or the caller loses the revision needed for a guarded edit.
- **3 Independent oracle:** literal mixed user/plugin items, expected ids, false editable and fixed revision.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove shared-catalog inventories and exact not-installed prose.
- **6 Lowest owner / remaining stronger coverage:** API catalog tests own allowed capabilities; adapters own source discovery; this tool owns filtered MCP projection.

## REWRITE: get_agent_profile: a list too big for one result keeps its head and says so

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Tools: oversized lists preserve a prefix and report truncated/omitted.
- **2 Detectable failure:** caller receives an oversized answer or silently loses rows.
- **3 Independent oracle:** 60,000-byte public cap, original literal ids and independent total 1,500.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove arbitrary minimum retained count and explanatory-copy matching.
- **6 Lowest owner / remaining stronger coverage:** result.test.ts owns string fitting; only profile tool owns envelope plus row omission metadata.

## REWRITE: get_agent_profile_item: an MCP server shows its secret KEYS only — even when the daemon sends a value

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Secrets: env/header values are write-only even if a route returns them.
- **2 Detectable failure:** a credential reaches an external agent.
- **3 Independent oracle:** hostile canned entries contain marker values; expected output has only literal key/set fields and excludes markers.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove leaky fake mode and exact secretsNote wording.
- **6 Lowest owner / remaining stronger coverage:** adapters own route masking; MCP deliberately rebuilds entries independently and owns this second public security boundary.

## REWRITE: get_agent_profile_item: credentials written into a server or marketplace URL are shown as ***

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Secrets: credentials in server and marketplace URLs are masked; noncredential @ characters survive.
- **2 Detectable failure:** credential leak or a legitimate repository path is corrupted.
- **3 Independent oracle:** literal credential URLs and literal masked/unchanged expected URLs.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** exercise get_agent_profile_item rather than exported redaction helper; preserve real URL on update via public outgoing draft.
- **6 Lowest owner / remaining stronger coverage:** no lower public MCP owner; adapter read masks env but retains URL for subsequent updates.

## REWRITE: get_agent_profile_item: a skill's frontmatter, body and files; a body too big is cut and flagged

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Tools: document detail preserves small bodies, truncates long bodies visibly within cap.
- **2 Detectable failure:** agent unknowingly writes an incomplete skill or receives invalid UTF-16/oversized answer.
- **3 Independent oracle:** literal markdown/file names, emoji body prefix, bodyChars and byte cap.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** drop unrelated hook pass-through and repeated generic not-found check.
- **6 Lowest owner / remaining stronger coverage:** result.test.ts owns byte fitting in isolation; tool owns its document envelope and bodyTruncated indication.

## REWRITE: create_agent_profile_item: exactly one kind object; a kind the agent cannot create is refused before any call

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Creating and editing: exactly one supported kind, strict fields, valid agent and transport family.
- **2 Detectable failure:** ambiguous or unsupported write reaches daemon, or secret-map typo is silently accepted.
- **3 Independent oracle:** literal invalid arguments must yield INVALID_ARGUMENT/KIND_NOT_SUPPORTED before any request.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** retain zero requests only for preflight guard, remove exact English errors.
- **6 Lowest owner / remaining stronger coverage:** server owns generic strict-schema enforcement; this tool owns kind exclusivity/capability/transport semantic rules.

## REWRITE: create_agent_profile_item: MCP env/headers maps become SecretEntryDrafts; the answer names ids, notes and a summary — no value

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Creating and editing: default transport, env/header maps and document objects become public daemon drafts; mutation result names only changed items.
- **2 Detectable failure:** wrong transport or secret entry form reaches native adapter; unrelated profile contents escape mutation response.
- **3 Independent oracle:** literal SecretEntryDraft and document draft objects plus changed-id selection from a snapshot with unrelated row.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove fake create/storage/name-conflict assertions and ordinary hook/plugin/marketplace pass-through permutations.
- **6 Lowest owner / remaining stronger coverage:** adapter/service own persistence/collision policy; MCP is lowest owner of its compact public input to daemon wire translation.

## DELETE: mergeSecretEntries: unnamed keys are kept, a string replaces, null removes, new keys are added

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 private merge helper repeats public update contract.
- **2 Detectable failure:** only helper shape or duplicated merge behavior.
- **3 Independent oracle:** n/a.
- **4 Stable seam/callers:** the original seam/arrangement provides no additional independently owned contract.
- **5 Refactor resilience / change:** remove helper-level test and its only external import.
- **6 Lowest owner / remaining stronger coverage:** rewritten update_agent_profile_item case owns retained/replaced/removed/new secret keys through public tool.

## REWRITE: update_agent_profile_item (MCP): reads the current revision, keeps unnamed secrets, replaces and removes named ones

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Creating and editing/Revisions: omitted keys retained via keep, strings replace, null removes, transport changes discard old side; omitted revision read from current detail.
- **2 Detectable failure:** rotated credential is lost, retained key disappears, or invalid cross-transport fields reach daemon.
- **3 Independent oracle:** literal outgoing draft and fixed current revision; no fake resolved secret state.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** move private merge variants here; remove route-sequence inventory, fake storage and fake rename outcomes.
- **6 Lowest owner / remaining stronger coverage:** adapter suite owns resolving keep and native persistence; this tool owns patch to full-wire-draft conversion.

## REWRITE: update_agent_profile_item: a stale revision answers PROFILE_CONFLICT with the fresh item, and nothing was written

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Revisions: explicit revision is passed unchanged and PROFILE_CONFLICT adds fresh item or itemGone.
- **2 Detectable failure:** stale edit silently loses its concurrency guard or caller receives stale/no conflict detail.
- **3 Independent oracle:** canned old/current revisions and refusal; expected literal fresh revision/id or itemGone.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove fake touch, no-write assertion and retry storage simulation.
- **6 Lowest owner / remaining stronger coverage:** real service/adapter suites own refusing stale writes; MCP alone enriches conflict response.

## REWRITE: update_agent_profile_item (skill, hook): the body is kept when omitted, frontmatter keys pass through, null clears a hook field

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Creating and editing: omitted document body survives, frontmatter null is forwarded, hook null removes; wrong kind cannot be edited.
- **2 Detectable failure:** partial edit destroys markdown, cannot clear hook matcher, or mismatched draft writes wrong kind.
- **3 Independent oracle:** literal existing body/hook data and exact public outgoing draft; error codes for invalid kind.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove fake frontmatter merge, fake renamed storage and generated hook-id claims.
- **6 Lowest owner / remaining stronger coverage:** document/hook adapters own native rename/id/frontmatter merging; MCP owns patch expansion and kind preflight.

## REWRITE: set_agent_profile_item_enabled: without revision the current one is read first; with one, no read

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Revisions: toggle writes use current revision when omitted and preserve explicit revision; unknown item/uninstalled agent fail.
- **2 Detectable failure:** toggle is unguarded or explicit guard is overwritten; missing item proceeds to mutation.
- **3 Independent oracle:** literal revisions and POST enabled payload, missing/uninstalled snapshot states.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove exact GET/POST list and duplicate stale-conflict detail assertions.
- **6 Lowest owner / remaining stronger coverage:** service/adapter own actual toggle; MCP currentItem lookup and request guard is lowest owner.

## REWRITE: delete_agent_profile_item: needs confirm: true; reads the revision; answers the id and notes

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Tools/Revisions: deletion requires confirm true and carries current revision.
- **2 Detectable failure:** unconfirmed destructive request reaches daemon or deletes a changed item without a guard.
- **3 Independent oracle:** invalid confirm inputs produce no request; literal DELETE revision query and returned requested identity.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove fake find-after-delete and exact notes prose.
- **6 Lowest owner / remaining stronger coverage:** service owns deletion; confirmation exists only at MCP schema boundary and query guard is MCP translation.

## REWRITE: copy_agent_profile_item and trust_agent_profile_hook: the target's ids, notes and summary

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Tools: copy selects target-agent summary and conflict policy; trust carries current hook revision.
- **2 Detectable failure:** copy reports source instead of target or silently changes collision choice; trust omits guard.
- **3 Independent oracle:** literal outgoing copy/trust requests and target snapshot with changed item id.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove fake target conversion, trust warning mutation and copy secret persistence.
- **6 Lowest owner / remaining stronger coverage:** convert/adapters own copy/native trust; tool owns cross-agent response identity and request translation.

## REWRITE: get_agent_instructions pages a long text; write_agent_instructions reads the revision, and a conflict names the fresh one

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Instructions/Revisions: long text pages reassemble exactly; writes replace whole text and preserve optional or empty revision; conflicts contain current info.
- **2 Detectable failure:** instructions are skipped/duplicated on paging, whole replacement is corrupted, missing-file guard is erased or stale conflict info returned.
- **3 Independent oracle:** literal Unicode source text, byte cap, literal PUT body and fixed conflict revision.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove fake instruction storage and full route sequence; caller follows returned cursor.
- **6 Lowest owner / remaining stronger coverage:** adapters own file bytes/conflicts; MCP owns pagination and optional revision translation/enrichment.

## REWRITE: import_agent_profile_items: scan by url (never echoed), then import by importId and picks

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 Imports: exclusive scan vs take inputs; URL not echoed; selected refs/onConflict reach daemon.
- **2 Detectable failure:** caller leaks private scan URL or imports different candidates/conflict policy.
- **3 Independent oracle:** literal hostile scan response includes url; projected result omits it; exact public import payload.
- **4 Stable seam/callers:** public tool input/output and documented DaemonApi payload; external MCP clients, as detailed above.
- **5 Refactor resilience / change:** remove fake cloning, candidate store, expiry simulation and generic error prose.
- **6 Lowest owner / remaining stronger coverage:** import.test.ts owns real clone/expiry/selection lifecycle; MCP owns two-mode argument protocol and projection.

## DELETE: list_marketplace_plugins: the catalogue

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 ordinary marketplace canned roundtrip plus route inventory.
- **2 Detectable failure:** stub returns arranged catalogue.
- **3 Independent oracle:** n/a.
- **4 Stable seam/callers:** the original seam/arrangement provides no additional independently owned contract.
- **5 Refactor resilience / change:** remove case; do not introduce a replacement implementation-restating test.
- **6 Lowest owner / remaining stronger coverage:** server spec checks public registration/schema/annotations; profile adapter/CLI suites own catalogue data; distinct bounded projection is shared with retained profile list.

## DELETE: daemon errors keep their codes; a 5xx body is never echoed

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 generic daemon code preservation/5xx masking and exact recovery prose.
- **2 Detectable failure:** duplicates common error mapper or English hint wording.
- **3 Independent oracle:** n/a.
- **4 Stable seam/callers:** the original seam/arrangement provides no additional independently owned contract.
- **5 Refactor resilience / change:** remove three fake-error permutations.
- **6 Lowest owner / remaining stronger coverage:** mcp/errors.test.ts owns daemonError codes, structured failures and 5xx body hiding; retained profile revision/guard cases exercise real tool-specific errors.

## DELETE: no secret value appears in any result or error any test produced

Path: `apps/daemon/src/mcp/tools/agent-profile.test.ts`.

- **1 Independent source:** §13 global secret sweep with arbitrary previous-answer count.
- **2 Detectable failure:** depends on execution order and repeats local assertions.
- **3 Independent oracle:** n/a.
- **4 Stable seam/callers:** the original seam/arrangement provides no additional independently owned contract.
- **5 Refactor resilience / change:** remove seen collector and wrapper serialization/identity probes.
- **6 Lowest owner / remaining stronger coverage:** local hostile-detail, URL, mutation and scan security assertions plus retained real E2E secret workflow own this invariant.

## Incoming server test changes

`apps/daemon/src/mcp/server.test.ts` changes touch two original assertions, without adding a new test callback:

- **DELETE** incoming 13-name additions to `EXPECTED_TOOLS` / the original exact ordered tool-inventory test. This is already removed in the local cleanup, and the independently specified CONTRACT table is a stronger owner. Do not reintroduce the array or its duplicate loop when resolving merge conflicts.
- **KEEP** the 13 incoming §13 tool rows in the existing `tools/list pins every tool's required params and annotations (spec §12 snapshot)` test: `list_agent_profiles`, `get_agent_profile`, `get_agent_profile_item`, `create_agent_profile_item`, `update_agent_profile_item`, `set_agent_profile_item_enabled`, `delete_agent_profile_item`, `copy_agent_profile_item`, `trust_agent_profile_hook`, `get_agent_instructions`, `write_agent_instructions`, `import_agent_profile_items`, `list_marketplace_plugins`. **1:** §13 table independently names tools/required arguments; protocol annotations distinguish read/write/destructive actions. **2:** a missing or misadvertised tool, unusable required argument or wrong destructive/read-only capability fails. **3:** literal spec table supplies expected required keys and annotations, never generated from definitions. **4:** public HTTP `tools/list`; caller is external MCP client. **5:** no ordering, internal export list, wrapper structure or full descriptions are asserted. **6:** this is the lowest assembled owner of advertised schemas/annotations; profile tool tests exercise calls, not registration metadata. Risk low; validate via focused server test.

## Support and production seams

Deleted `FakeProfileDaemon` (domain reimplementation), mutable maps/revision counter/create/update/copy/secret-resolution/import logic, `McpState`, `seeded`, route-sequence helper, global `seen` collection and arbitrary sweep, unnecessary imported domain draft types and direct `ok()` structuredContent identity assertion. Use existing shared `FakeDaemonApi` with literal snapshots/details and one small test-only schema/run helper.

Incoming production helpers `itemView`, `redactUrlCredentials`, `mergeSecretEntries`, `mcpUpdateDraft` have no external non-test callers (`git grep` on the incoming tree). Only the incoming test imports the latter two tested helpers. They have live internal tool callers, so remove only their unnecessary `export` keywords; keep behavior and internal functions. `agentProfileTools` remains exported and used by production server registration. No test-only flags or injection hooks are needed.

## Execution

- Incoming unmodified profile baseline: **20/20 passed**, `/tmp/remote-mcp-baseline.log`.
- Applied the pre-recorded rewrite: profile file **653 → 316 lines (−337)**; 16 retained rewritten cases, four deleted. No replacement domain fake.
- Profile and server focused command above: **32/32 passed**, no skips/failures; `/tmp/remote-mcp-focused.log`.
- Resolved the merge conflict in `server.test.ts` by preserving the existing cleanup and all 13 new independent CONTRACT rows. Removed the redundant incoming EXPECTED_TOOLS array.
- Removed the four unused helper exports. Production function bodies are unchanged; repository-wide incoming-tree search found no external production callers.
- Scoped final diff and `git diff --check` passed. The separate real profile HTTP E2E owner also reports its persistence/redaction workflow passing with the unchanged production behavior.
- Root owns the final combined `pnpm check` / `pnpm test` gates and commit/push. No coverage/test-count gate conflict encountered in this scope.
