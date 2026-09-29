# Agent profile test cleanup

Status: completed cleanup with focused validation passed; repository-wide integration gates are owned by the root report. This disposition ledger was written before test edits. Original inventory: 312 test declarations in 25 files; conversion declarations expand over agent/transport combinations.

Independent sources: [approved profile design](../superpowers/specs/2026-09-28-agent-profile-design.md), repository AGENTS.md/README.md, shared API contracts, recorded CLI protocol fixtures. Literal expected native bytes/data, OS outcomes and captured hashes are the oracles; no retained expectation is copied from an implementation algorithm.

Risk: native configuration/security regressions would affect CLI state. Retained tests below target those failure modes; deletion risk is covered by the named stronger owner or is limited to an internal implementation choice. All fixture/helper dependencies were checked with repository-wide caller searches before removal.

Focused validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test --test-concurrency=1 $(find apps/daemon/src/agent-profile -name "*.test.ts")`. Root agent owns repository check/test gates.

## apps/daemon/src/agent-profile/adapters/claude/claude-json.test.ts

**1 Source:** Native JSON locking and persistence, design §§3.1/4.1/4.5; proper-lockfile ownership. **2 Failure:** lost edits, stolen-lock overwrite, corrupted JSON or incorrect permissions. **4 Stable seam and non-test callers:** mutateClaudeJson; ClaudeAdapter production writes. **6 Lowest owner:** adapter tests do not recreate concurrent external lock ownership.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| a file that does not parse is refused, never overwritten | DELETE | Duplicates the Claude adapter malformed-config refusal and secret-redaction cases, which exercise the real configuration owner. |

## apps/daemon/src/agent-profile/adapters/claude/index.test.ts

**1 Source:** CLI-native file formats, protocol and security matrix in design §§3/4.1/4.4/4.5; README native config remains source of truth. **2 Failure:** native configuration, CLI action, secret boundary, symlink ownership, revision conflict or stash outcome named below fails. **4 Stable seam and non-test callers:** AgentProfileAdapter interface over real scratch homes; AgentProfileService production caller. **6 Lowest owner:** adapter owns each CLI format; lower helpers do not cover CLI-specific native semantics, and service mocks do not exercise these writes.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| the snapshot lists every kind from a realistic ~/.claude, secrets masked | REWRITE | Remove watch-path inventory; retain real native snapshot contents, masking and edit permissions. |
| MCP: create, edit with kept and replaced secrets, rename, off/on through deniedMcpServers, delete | REWRITE | Keep native MCP state and warning presence; remove fixed warning prose. |
| plugins and marketplaces go through the claude CLI with HOME set and no CLAUDE_CONFIG_DIR; toggles write enabledPlugins | REWRITE | Keep external CLI argv, resulting marketplace IDs and affected plugin reference; remove fixed notice prose. |
| a hand-broken settings.json or ~/.claude.json never has its text (a secret) quoted in fileErrors or errors | REWRITE | Keep malformed-config error code and secret exclusion; remove fixed parser-error prose. |

## apps/daemon/src/agent-profile/adapters/codex/codex-config-client.test.ts

**1 Source:** Codex app-server protocol, design §§3.2/4.1, generated app-server bindings. **2 Failure:** bad handshake, lost RPC result, wrong home, orphaned child or timeout. **4 Stable seam and non-test callers:** CodexConfigClient/quoteKeyPath; CodexAdapter production RPC. **6 Lowest owner:** native adapter uses a protocol peer and does not test actual child lifecycle.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| fails a call that misses its deadline with AGENT_CLI_FAILED and kills the child | REWRITE | Keep RPC deadline error and child termination; check affected RPC name without fixed error prose. |

## apps/daemon/src/agent-profile/adapters/codex/hooks.test.ts

**1 Source:** Codex CLI 0.155.1 captured hash vectors and trust-state keys, design §3.2. **2 Failure:** trusted hooks stop running, wrong handler enabled, or another account loses trust. **4 Stable seam and non-test callers:** Codex hook protocol helpers; CodexAdapter and agent account reconciliation. **6 Lowest owner:** captured hashes own normalization; retained rekey cases cover distinct corrupt/duplicate state regressions.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| snake-cases every Codex event | DELETE | Event-name mapping is already exercised by the independently captured Codex trust-hash vectors. |
| agrees with agent-hooks' codexTrustHash for the managed handlers | DELETE | Compares two production implementations; captured Codex CLI hashes are the independent oracle. |
| moves managed and user entries on every path when a group is inserted before the managed one | DELETE | Duplicates the Codex adapter insertion test that verifies persisted trust state for every account path. |
| drops the entries of a removed hook and shifts the rest back | DELETE | Duplicates the Codex adapter removal test that verifies persisted switches and trust positions. |
| writes nothing when nothing moved | DELETE | Asserts the internal edit-list optimization, not a distinct native configuration outcome. |

## apps/daemon/src/agent-profile/adapters/codex/index.test.ts

**1 Source:** CLI-native file formats, protocol and security matrix in design §§3/4.1/4.4/4.5; README native config remains source of truth. **2 Failure:** native configuration, CLI action, secret boundary, symlink ownership, revision conflict or stash outcome named below fails. **4 Stable seam and non-test callers:** AgentProfileAdapter interface over real scratch homes; AgentProfileService production caller. **6 Lowest owner:** adapter owns each CLI format; lower helpers do not cover CLI-specific native semantics, and service mocks do not exercise these writes.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| lists every kind with its source, switches and warnings — and no secret | REWRITE | Remove contentHash-derived expected revision; retain native snapshot protocol data and secret masking. |
| warns about an untrusted hook with a Trust action, and trust() fixes it on every path | REWRITE | Keep persisted account-path/switch ownership, unchanged prior trust values and observable trusted state. Remove expected hashes recomputed with the production helper; captured CLI vectors in hooks.test.ts own exact hash output. |
| watches the files and directories Codex reads | DELETE | Private watcher-path inventory; service real-filesystem watcher test owns observable invalidation. |
| creates, edits (keeping a secret and unknown fields), toggles and deletes through config/batchWrite | REWRITE | Remove operation-count assertions; retain persisted MCP values and externally specified config/batchWrite protocol. |
| inserts a new hook before the managed group and re-keys every path in one batch | REWRITE | Keep persisted account-path/switch ownership, unchanged prior trust values and observable trusted state. Remove expected hashes recomputed with the production helper; captured CLI vectors in hooks.test.ts own exact hash output. |
| toggles a hook on every path, edits it (re-trusted) and deletes it (shifting the rest back) | REWRITE | Keep persisted account-path/switch ownership, unchanged prior trust values and observable trusted state. Remove expected hashes recomputed with the production helper; captured CLI vectors in hooks.test.ts own exact hash output. |
| moves a hook to another event on edit | REWRITE | Keep persisted account-path/switch ownership, unchanged prior trust values and observable trusted state. Remove expected hashes recomputed with the production helper; captured CLI vectors in hooks.test.ts own exact hash output. |
| warns about a hook an account home does not trust, and trust() writes it there | REWRITE | Keep persisted account-path/switch ownership, unchanged prior trust values and observable trusted state. Remove expected hashes recomputed with the production helper; captured CLI vectors in hooks.test.ts own exact hash output. |
| keys an account home reached through a symlink by its realpath too, as Codex canonicalizes CODEX_HOME | REWRITE | Keep persisted account-path/switch ownership, unchanged prior trust values and observable trusted state. Remove expected hashes recomputed with the production helper; captured CLI vectors in hooks.test.ts own exact hash output. |
| starts a new app-server when the registry's codex binary moves | DELETE | Factory argument/close-count change detector; subprocess client tests own externally visible lifecycle. |

## apps/daemon/src/agent-profile/adapters/grok/hooks.test.ts

**1 Source:** CLI-native file formats, protocol and security matrix in design §§3/4.1/4.4/4.5; README native config remains source of truth. **2 Failure:** native configuration, CLI action, secret boundary, symlink ownership, revision conflict or stash outcome named below fails. **4 Stable seam and non-test callers:** AgentProfileAdapter interface over real scratch homes; AgentProfileService production caller. **6 Lowest owner:** adapter owns each CLI format; lower helpers do not cover CLI-specific native semantics, and service mocks do not exercise these writes.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| handlers are listed per group with an empty matcher read as none | DELETE | Private list shape duplicates the Grok snapshot and hook mutation contracts. |
| removing the last handler drops its group and event, keeping unknown keys | DELETE | Private edit helper duplicates the Grok hook removal contract. |
| insert joins a group with the same matcher, or starts one; replace keeps position | DELETE | Private edit helper duplicates the Grok hook create/update contract. |

## apps/daemon/src/agent-profile/adapters/grok/index.test.ts

**1 Source:** CLI-native file formats, protocol and security matrix in design §§3/4.1/4.4/4.5; README native config remains source of truth. **2 Failure:** native configuration, CLI action, secret boundary, symlink ownership, revision conflict or stash outcome named below fails. **4 Stable seam and non-test callers:** AgentProfileAdapter interface over real scratch homes; AgentProfileService production caller. **6 Lowest owner:** adapter owns each CLI format; lower helpers do not cover CLI-specific native semantics, and service mocks do not exercise these writes.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| the snapshot lists every kind from its real home, with sources, locks and no secret | REWRITE | Remove watch-cache call counts and production-derived expected revision; retain independently specified native contents. |
| watchPaths names every file and directory the snapshot reads | DELETE | Private watcher-path inventory; observable watcher owner retained. |
| an MCP server's revision cannot be brute-forced into its secrets, yet still moves when one changes | REWRITE | Remove mismatched-hash negative oracle; retain observable revision change when a secret changes. |

## apps/daemon/src/agent-profile/adapters/grok/inspect.test.ts

**1 Source:** Recorded grok 1.0.34 inspect fixture and fixture provenance README. **2 Failure:** CLI-provided servers/skills/plugins disappear or malformed output is accepted. **4 Stable seam and non-test callers:** parseGrokInspect; GrokAdapter production inspect. **6 Lowest owner:** captured CLI report is the lowest stable protocol seam.

## apps/daemon/src/agent-profile/adapters/grok/toml-patch.test.ts

**1 Source:** Native TOML storage compatibility and comments/unknown-byte preservation, design §§3.3/4.1. **2 Failure:** edits remove unrelated configuration, corrupt CLI trailing commas or attach keys to wrong tables. **4 Stable seam and non-test callers:** patchToml; GrokAdapter native config writes. **6 Lowest owner:** retained cases isolate distinct TOML syntax shapes beyond full adapter examples.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| edits the multi-line plugins array in place | DELETE | Duplicates the Grok adapter plugin-toggle test on real native configuration. |
| appends a new [mcp_servers.<name>] table at the end instead of a root dotted key | DELETE | Formatting choice for table insertion; real MCP create/edit tests protect readable persisted configuration. |
| creates a missing table for a new key at the end | DELETE | Formatting choice for table insertion; native configuration creation remains covered. |
| indents a key added to an indented table like its siblings | DELETE | Indentation preference without a user-facing semantic or preserved-byte requirement. |
| writes into an empty document and skips no-op edits | DELETE | Basic empty-document rendering/no-op optimization duplicated by native create operations. |
| renders values on one line with quoted keys where needed | DELETE | Serialization library formatting inventory, without a distinct owner contract. |

## apps/daemon/src/agent-profile/adapters/opencode/index.test.ts

**1 Source:** CLI-native file formats, protocol and security matrix in design §§3/4.1/4.4/4.5; README native config remains source of truth. **2 Failure:** native configuration, CLI action, secret boundary, symlink ownership, revision conflict or stash outcome named below fails. **4 Stable seam and non-test callers:** AgentProfileAdapter interface over real scratch homes; AgentProfileService production caller. **6 Lowest owner:** adapter owns each CLI format; lower helpers do not cover CLI-specific native semantics, and service mocks do not exercise these writes.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| watchPaths names the config files, the item folders, the inherited skill roots and the stash | DELETE | Private watcher-path inventory; observable watcher owner retained. |
| turning an MCP server off and on edits only its enabled flag, byte for byte | REWRITE | Remove note text copied from production constant; retain exact unchanged bytes around the enabled flag. |
| an own skill shadows an inherited one; other copies make one warning; skill/ and bad skills are listed | REWRITE | Keep inherited-skill precedence, warning code and duplicate path; remove fixed warning prose. |
| a [spec, options] plugin entry is stashed and restored as it was | DELETE | Duplicates the stronger plugin tuple/order/own-text stash restoration regression in the same adapter. |
| hooks and marketplaces are not OpenCode kinds | DELETE | Unsupported kinds are rejected by the service before this adapter can be called. |
| instructions read and write against their revision | REWRITE | Remove production-constant note comparison; retain instructions storage and stale revision conflict. |

## apps/daemon/src/agent-profile/adapters/opencode/jsonc.test.ts

**1 Source:** OpenCode JSONC storage and unchanged-byte preservation, design §§3.4/4.1. **2 Failure:** comment/comma layouts become invalid or unrelated comments and CRLF are lost. **4 Stable seam and non-test callers:** JSONC editing functions; OpenCodeAdapter native writes. **6 Lowest owner:** retained unusual syntax cases are below adapter scenarios and cover distinct parser edits.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| an edit through a key that is set twice is refused: OpenCode reads the last one | DELETE | Stronger adapter duplicate-key refusal verifies original configuration is untouched. |
| a byte-order mark is read past | DELETE | Stronger adapter BOM edit verifies both readability and byte preservation. |
| members and elements go back at a position with their own text | DELETE | Stronger adapter plugin/config-command restoration verifies position and original text. |
| parse accepts comments and trailing commas and reports where it fails | DELETE | Native adapter reads and invalid-config refusal cover parsing through the actual configuration interface. |
| replacing a value touches only that value | DELETE | Stronger adapter enabled-flag toggle verifies unchanged configuration bytes. |
| a missing parent is created as one member | DELETE | Native permission/config creation tests cover absent parents with meaningful settings. |
| replaceJsoncObject edits only the keys that changed | DELETE | Native MCP secret edits verify unchanged unknown keys and comments. |

## apps/daemon/src/agent-profile/convert.test.ts

**1 Source:** Portable copy conversion rules, design §6 and native formats in §3. **2 Failure:** copied item loses source body/support files/secrets, uses unsupported transport, or changes timeout units. **4 Stable seam and non-test callers:** createAgentProfileConverter; AgentProfileService copy and import service. **6 Lowest owner:** converter owns cross-agent normalization; adapters own only their own formats.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| `skill ${from} → ${to}` | REWRITE | Replace catalog-derived Cartesian matrix with explicit Claude-to-Codex skill metadata/body/executable-file preservation. |
| `command ${from} → ${to}` | DELETE | Cartesian expected fields are derived from the same production catalog; explicit import conversion/name tests remain. |
| `mcp ${transport} ${from} → ${to}` | REWRITE | Replace catalog-derived Cartesian matrix with explicit stdio/HTTP secret-preserving conversion. |
| skill: Claude when_to_use becomes Grok when-to-use in place, and back | REWRITE | Keep literal mapped metadata; remove metadata-key ordering preference. |
| skill: nothing to change keeps the source directory and makes no temp dir | DELETE | Temporary-directory allocation optimization, not portable item behavior. |
| skill: a missing or different frontmatter name is set to the item's name | REWRITE | Keep corrected frontmatter names; remove metadata-key ordering preference. |
| command → Codex without a description gets one naming the command | REWRITE | Keep required nonempty skill description and source body; remove incidental note/copy wording. |
| command names are checked; Grok flattens one folder level | REWRITE | Keep invalid name refusal and flattened name; remove incidental notes wording. |
| mcp advanced: ms ↔ s timeouts and the Codex/Grok-only fields | REWRITE | Exercise timeout conversion through the public converter with literal inputs and expected units, not an exported helper. |

## apps/daemon/src/agent-profile/homes.test.ts

**1 Source:** CLI documented environment/default homes, design §4.1 and README account isolation. **2 Failure:** profile edits target another config/home or ignore an explicit home override. **4 Stable seam and non-test callers:** resolveAgentHomes; daemon initialization. **6 Lowest owner:** one lowest configuration resolution owner.

## apps/daemon/src/agent-profile/import.test.ts

**1 Source:** Git/ZIP import rules and limits, design §6.2 and filesystem containment rules in AGENTS.md. **2 Failure:** unsafe URL/archive escapes sandbox, scan misses eligible files, leaked imports persist, or imported content changes. **4 Stable seam and non-test callers:** AgentProfileImportService and parseGitImportUrl; profile service/routes production callers. **6 Lowest owner:** import owner combines real archive/git/file semantics; route tests only own transport.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| the git clone argv keeps the URL after -- and never uses a shell | DELETE | Private argv helper cannot establish its no-shell claim; real git clone and subprocess argv tests remain. |
| a git scan lists skills and commands, skipping symlinks, depth and node_modules | REWRITE | Keep eligible candidates, unsafe omissions and warning paths; remove fixed warning prose. |
| a failed clone is an IMPORT_FAILED and leaves nothing behind | REWRITE | Keep IMPORT_FAILED and cleanup; remove fixed error prose. |
| an empty scan is a 400 IMPORT_FAILED and removes the clone | REWRITE | Keep error status/code and cleanup; remove fixed empty-scan prose. |
| existing(agent) is asked for the scanning agent | DELETE | Callback argument inventory; real candidate collision and import behavior remain. |

## apps/daemon/src/agent-profile/infra/backups.test.ts

**1 Source:** Backup ring persistence and symlink preservation, design §4.1. **2 Failure:** undo loses previous bytes, file mode, link identity or newest retained backup. **4 Stable seam and non-test callers:** ProfileBackups; native write/stash owners. **6 Lowest owner:** backup storage owner covers same-millisecond collision and retention not replayed by adapters.

## apps/daemon/src/agent-profile/infra/cli-runner.test.ts

**1 Source:** External CLI argv/stdin/env/deadline protocol and secret boundary, design §§4.1/4.5. **2 Failure:** shell interpretation, daemon secret leak, hung child, truncated output deadlock or unredacted errors. **4 Stable seam and non-test callers:** runAgentCli/runAgentCliOrThrow/buildAgentCliEnv/redactCliOutput; all native CLI adapters. **6 Lowest owner:** real subprocess boundary owns execution; adapters cannot establish subprocess isolation.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| runAgentCliOrThrow answers on success and throws AGENT_CLI_FAILED with redacted stderr | REWRITE | Keep subprocess error code and secret/path redaction; remove fixed error prose. |

## apps/daemon/src/agent-profile/infra/frontmatter.test.ts

**1 Source:** Markdown frontmatter/YAML compatibility, especially OpenCode YAML 1.1, design §3.4. **2 Failure:** valid user documents fail, malformed metadata overwrites files, or body/metadata types change. **4 Stable seam and non-test callers:** parse/serializeMarkdownDocument; native markdown owners/converter. **6 Lowest owner:** retained delimiter and YAML type cases are parser compatibility boundaries not repeated native CRUD.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| parses a frontmatter block and keeps the body as it is | DELETE | Basic parse example duplicated by actual skill/command native reads and conversion. |
| serialize writes the keys in order, quotes what needs it, and round trips | DELETE | Serializer/parser round trip and key-order formatting; native edits and independent YAML reader regressions remain. |
| mergeFrontmatter: draft overrides in place, null removes, unmentioned keys survive | DELETE | Private merge helper duplicates actual native skill and command edits preserving/deleting fields. |

## apps/daemon/src/agent-profile/infra/fs-write.test.ts

**1 Source:** Atomic native writes, backup/rollback, modes and symlink ownership, design §§4.1/4.5. **2 Failure:** config/link target destroyed, failed validation leaves corrupt content, or executable modes lost. **4 Stable seam and non-test callers:** write/remove/copy profile filesystem helpers; every adapter. **6 Lowest owner:** shared filesystem owner covers generic failure modes once; adapter cases cover CLI-specific semantics.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| a symlink loop is refused | REWRITE | Require the symlink-loop error instead of accepting any failure. |
| readTextIfExists and pathKind | DELETE | Thin filesystem wrapper inventory; write, backup, stash and adapter tests exercise actual filesystem outcomes. |

## apps/daemon/src/agent-profile/infra/hash.test.ts

**1 Source:** Stable hook identity from event/matcher/handler, design §4.3. **2 Failure:** editing a hook changes another hook ID or harmless key/matcher normalization changes identity. **4 Stable seam and non-test callers:** hookItemId; native hook adapters. **6 Lowest owner:** only shared hook-ID identity owner; CLI trust hashing is a separate external protocol.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| stableStringify sorts keys recursively and follows JSON's rules otherwise | DELETE | Generic JSON implementation inventory; native revision/conflict and configuration tests own visible contracts. |
| contentHash is 16 hex, independent of key order, and hashes strings raw | DELETE | Copies production hashing logic and asserts exported length against itself; real stale-revision and secret-change tests remain. |
| itemId and parseItemId round trip; malformed ids are null | DELETE | Self-roundtrip/internal ID parser examples; public native IDs, service kind guards and hook IDs remain. |
| hookItemId hashes the normalized {matcher, handler} and ignores key order | REWRITE | Keep hook identity invariants from the ID contract; remove hash expectation calculated from production serialization. |
| parseHookItemId splits event and hash | DELETE | Only caller of a dead parsing export. No production contract depends on it. |

## apps/daemon/src/agent-profile/infra/markdown-items.test.ts

**1 Source:** Skill/command discovery and safe skill-file access, design §§3/4.5. **2 Failure:** broken links hide valid items, nested commands disappear or excluded/linked files leak. **4 Stable seam and non-test callers:** scanSkills/scanCommands/readSkillFiles/writeSkill; native adapters. **6 Lowest owner:** retained tree-shape/error/security cases exercise shared scan/storage owner.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| readSkillFiles lists the other files, skipping node_modules and .git, never following links | REWRITE | Keep security exclusions; remove self-referential exported file-cap assertion. |
| writeSkill creates SKILL.md with the name first, then merges edits into what is on disk | DELETE | Duplicates actual native skill creation/edit tests including unknown metadata preservation. |
| writeCommand writes nested names and merges frontmatter | DELETE | Duplicates actual nested command creation/edit tests including frontmatter preservation. |

## apps/daemon/src/agent-profile/infra/names.test.ts

**1 Source:** Path containment and profile error mapping, AGENTS.md and design §4.5. **2 Failure:** unsafe path segments or realpath symlink escape reach filesystem mutation. **4 Stable seam and non-test callers:** assertSafeSegment/assertInside; stash/adapter owners. **6 Lowest owner:** shared security seam owns profile-level error semantics and direct stash-safe segments.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| the per-kind name assertions apply the shared rules | DELETE | Thin wrapper restates shared API naming validation; service guards and native adapter rejection remain. |

## apps/daemon/src/agent-profile/infra/secret-digest.test.ts

**1 Source:** Secrets remain host-only and changes invalidate revisions, AGENTS.md/design §4.5. **2 Failure:** nested secret variants appear in metadata or changed credentials keep stale revision. **4 Stable seam and non-test callers:** SecretDigester/deepMasked; native adapters. **6 Lowest owner:** recursive spellings/key variants exceed individual adapter fixtures.

## apps/daemon/src/agent-profile/infra/stash.test.ts

**1 Source:** Manifest, off/on and conflict-safe restoration storage, design §4.4. **2 Failure:** disabled item is lost, restore overwrites unrelated file, modes/links/order change or old debris blocks use. **4 Stable seam and non-test callers:** ProfileStash; all adapters with nonnative off switches. **6 Lowest owner:** shared storage owner tests errors, filesystem boundaries and manifests; adapter tests cover native item semantics.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| a stashed file moves out and restores byte for byte, mode and all | REWRITE | Remove stash path calculated with its own encoder; retain persisted manifest, exact bytes and mode. |
| fragments round trip through the manifest | DELETE | Self-roundtrip duplicates actual hook fragment stashing; takeFragment has no production caller. |
| a leftover entry that is not usable is replaced instead of blocking the id | REWRITE | Create/corrupt stash through its public entry result instead of private entryDir. |
| ids are encoded safely; very long ids are hashed | REWRITE | Exercise long-ID storage and unsafe owner refusal without repeating the encoder algorithm. |

## apps/daemon/src/agent-profile/routes.test.ts

**1 Source:** HTTP request/body/error/upload contracts in packages/api and design §4.6. **2 Failure:** invalid payload reaches a write, HTTP status/code leaks secrets, or upload bytes/files leak. **4 Stable seam and non-test callers:** registered Fastify routes exercised with inject; daemon HTTP server. **6 Lowest owner:** HTTP boundary owns validation/transport; service/adapter outcomes are pruned here.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| every route reaches its service method with parsed arguments | DELETE | Exhaustive private service-method forwarding/argument inventory with arranged stub responses. |
| an MCP draft keeps only its transport's fields; secret entries pass as set/keep | DELETE | Asserts private parsed argument shape; route rejection and native secret-keep/write behavior remain. |
| against the real service: not installed, kind checks and name rules come back as their codes | DELETE | Replays service guards through HTTP; service owns guards and route error-code serialization is separately retained. |
| upload: the octet-stream body is streamed to a temp file under the imports dir, scanned, then removed | REWRITE | Keep streamed bytes and temporary-file cleanup; remove service-call ordering inventory. |

## apps/daemon/src/agent-profile/service.test.ts

**1 Source:** Profile orchestration, capability validation, events/queues/recycle/import lifecycle, design §§4.1/4.6. **2 Failure:** writes race, stale snapshots announce wrong revisions, unsupported writes run, imports leak or live changes stop arriving. **4 Stable seam and non-test callers:** AgentProfileService/AgentProfileEventSource and OS watch lifecycle; daemon routes/broadcaster/recycler. **6 Lowest owner:** service owns coordination; native adapters do not serialize cross-item work or publish shared events.

| Original case | Disposition | Reason / detectable failure and remaining coverage |
| --- | --- | --- |
| snapshotRevision ignores item and file-error order and key order, and moves with any content | DELETE | Direct hashing-helper change detector; observable revision/no-op/out-of-order notification tests remain. |
| mutations to one agent run one at a time, in order; a failure does not break the chain | REWRITE | Keep queue completion/state behavior; remove exact private method sequence. |
| trust, legacy migration and marketplace plugins answer KIND_NOT_SUPPORTED where the adapter has none | REWRITE | Retain unsupported-capability errors; remove arranged stub plugin result equality. |
| a mutation emits changed once with the fresh revision; a no-op write and plain reads emit nothing | REWRITE | Keep public changed-event/revision behavior and exercise a harmless item-order change before the no-op; replaces direct helper inspection with observable notification deduplication. |
| copy: exports from the source, imports into the target, answers the TARGET's snapshot and removes the temp dir | REWRITE | Retain destination state/events/temp cleanup; remove private export/import call lists. |
| imports: take → importItem for each pick in the agent's queue → release, whatever happens | REWRITE | Retain atomic pick validation, import results and release-on-failure; remove arranged scan IDs. |
| watching: realpaths of installed agents' paths (a missing one: its nearest existing parent), debounced 500 ms, deduped | REWRITE | Retain externally changed notification/debounce behavior; remove private watcher path and adapter count inventory. |
| watching: an error closes the agent's watchers; the next snapshot re-arms them | REWRITE | Observe changed events after watcher recovery, instead of only newly created handles. |
| watching: a watch that throws while arming leaves the agent unarmed (retried on the next read) | REWRITE | Observe changed events after recovery from arming failure, instead of only factory calls. |
| stop: closes every watcher and pending timer, closes the adapters, and nothing runs afterwards | REWRITE | Retain lifecycle resource cleanup and absence of post-stop notifications; remove adapter call inventory. |

## Removed production seams and dead support

Repository-wide caller searches found no non-test callers for the removed `parseHookItemId` function or `ProfileStash.takeFragment` method. Removed their barrel exports/docs. `snapshotRevision`, `mapMcpAdvanced`, `gitCloneArgs`, `renderTomlValue`, `encodeStashId`, `PROFILE_HASH_LENGTH`, `SKILL_FILES_MAX`, and `OPENCODE_RECYCLE_NOTE` retain their production implementations but no longer export test-only access. `ProfileStash.entryDir` becomes private after tests use the returned public stash entry. Removed the unused fake adapter marketplace response method, converter catalog matrices/canonicalization/note parsers, the Grok hook-helper test file, the empty Codex lifecycle suite, and unused imports. Native protocol replay fixtures, fake external CLI peers, lock/watch injection and filesystem scratch helpers still serve retained behavioral tests.

Final support audit also found `convertPortableItem` and its default temporary-root constant had no callers anywhere in the repository. The daemon always supplies its appdir through `createProfileConverter`; remove this unused default wrapper and its `tmpdir` import.

## Cartesian declaration expansion

The three template-name rows above summarize these 80 original runnable cases. Agent IDs are literal input labels, not expected values derived from a production catalog. The replacement skill case covers Claude → Codex; one replacement MCP test runs the two listed concrete transports. All other matrix cases fail the independent-oracle bar; explicit native adapter, timeout, name, import and transport-refusal tests retain their actual contracts.

| Original case in `convert.test.ts` | Disposition | Remaining behavior owner |
| --- | --- | --- |
| skill claude → claude | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill claude → codex | REWRITE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill claude → grok | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill claude → opencode | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill codex → claude | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill codex → codex | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill codex → grok | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill codex → opencode | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill grok → claude | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill grok → codex | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill grok → grok | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill grok → opencode | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill opencode → claude | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill opencode → codex | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill opencode → grok | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| skill opencode → opencode | DELETE | Explicit metadata/body/executable-file copy and field-renaming cases; native adapters own each reader. |
| command claude → claude | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command claude → codex | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command claude → grok | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command claude → opencode | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command codex → claude | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command codex → codex | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command codex → grok | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command codex → opencode | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command grok → claude | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command grok → codex | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command grok → grok | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command grok → opencode | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command opencode → claude | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command opencode → codex | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command opencode → grok | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| command opencode → opencode | DELETE | Codex command import, Grok flattening, literal body/name validation cases. |
| mcp stdio claude → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http claude → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse claude → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio claude → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http claude → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse claude → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio claude → grok | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http claude → grok | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse claude → grok | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio claude → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http claude → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse claude → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio codex → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http codex → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse codex → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio codex → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http codex → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse codex → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio codex → grok | REWRITE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http codex → grok | REWRITE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse codex → grok | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio codex → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http codex → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse codex → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio grok → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http grok → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse grok → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio grok → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http grok → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse grok → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio grok → grok | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http grok → grok | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse grok → grok | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio grok → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http grok → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse grok → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio opencode → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http opencode → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse opencode → claude | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio opencode → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http opencode → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse opencode → codex | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio opencode → grok | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http opencode → grok | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse opencode → grok | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp stdio opencode → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp http opencode → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |
| mcp sse opencode → opencode | DELETE | Literal secret-copy, timeout-unit conversion and unsupported-SSE cases. |

Disposition totals by original declaration: 48 DELETE, 45 REWRITE, 219 KEEP. Expanded runnable cases: 124 DELETE, 46 REWRITE, 219 KEEP (389 originally; two retained MCP inputs now share one test).

## Integration review of concurrently removed exports

A concurrent workspace edit removed additional exports while this audit ran. The complete current production diff was reviewed; these declarations remain local with unchanged implementations. Repository-wide TypeScript/TSX/MJS caller searches found no reference outside each defining file (including tests and barrels). These are internal daemon modules, not the shared public API/SDK package. Existing native config/protocol tests exercise their owning methods; risk is compile-time import breakage, covered by the repository typecheck.

| Defining path | Export names made local; external callers: none |
| --- | --- |
| apps/daemon/src/agent-profile/adapters/claude/claude-json.ts | `CLAUDE_JSON_LOCK_OPTIONS`, `readClaudeJson`, `ClaudeJsonUpdateOptions` |
| apps/daemon/src/agent-profile/adapters/claude/index.ts | `ClaudeProfileAdapterDeps` |
| apps/daemon/src/agent-profile/adapters/claude/mcp.ts | `resolveSecretEntries`, `buildMcpDefinition` |
| apps/daemon/src/agent-profile/adapters/claude/settings.ts | `safeJsonError` |
| apps/daemon/src/agent-profile/adapters/codex/codex-config-client.ts | `CODEX_CONFIG_IDLE_MS`, `CODEX_CONFIG_CALL_TIMEOUT_MS`, `CodexConfigLayerSource`, `CodexConfigLayer`, `CodexConfigReadParams`, `CodexConfigReadResult`, `CodexConfigBatchWriteParams`, `CodexConfigWriteResult`, `CodexSkillsListResult`, `CodexSkillsConfigWriteParams`, `CodexHooksListResult`, `CodexPluginMarketplaceEntry`, `CodexPluginReadParams`, `CodexPluginInstallParams`, `CodexMarketplaceAddParams`, `CodexMarketplaceAddResult`, `CodexAppServerClientOptions`, `keySegment` |
| apps/daemon/src/agent-profile/adapters/codex/index.ts | `CodexProfileAdapterDeps` |
| apps/daemon/src/agent-profile/adapters/grok/index.ts | `GROK_ORQUESTER_HOOK_FILE`, `GROK_PROFILE_HOOK_FILE`, `GrokProfileAdapterDeps`, `safeParseError` |
| apps/daemon/src/agent-profile/adapters/grok/inspect.ts | `InspectMcpServer`, `InspectSkill`, `InspectPlugin` |
| apps/daemon/src/agent-profile/adapters/grok/toml-patch.ts | `renderTomlKey`, `renderTomlValue` |
| apps/daemon/src/agent-profile/adapters/index.ts | `AgentProfileAdapterFactoryContext` |
| apps/daemon/src/agent-profile/adapters/opencode/index.ts | `OPENCODE_RECYCLE_NOTE` |
| apps/daemon/src/agent-profile/convert.ts | `ProfileConverterOptions`, `CONVERT_DIR_PREFIX`, `MappedFrontmatter`, `mapMcpAdvanced` |
| apps/daemon/src/agent-profile/import.ts | `IMPORT_TTL_MS`, `ProfileImportLimits`, `DEFAULT_IMPORT_LIMITS` |
| apps/daemon/src/agent-profile/import/git-clone.ts | `GitCloneOptions`, `gitCloneArgs` |
| apps/daemon/src/agent-profile/import/scan.ts | `SCAN_MAX_DEPTH`, `SCAN_MAX_FILE_BYTES`, `SCAN_MAX_CANDIDATES`, `ImportScan` |
| apps/daemon/src/agent-profile/import/zip.ts | `ZipLimits`, `zipEntrySegments` |
| apps/daemon/src/agent-profile/infra/hash.ts | `PROFILE_HASH_LENGTH` |
| apps/daemon/src/agent-profile/infra/markdown-items.ts | `SKILL_FILES_MAX` |
| apps/daemon/src/agent-profile/infra/stash.ts | `encodeStashId` |
| apps/daemon/src/agent-profile/service.ts | `snapshotRevision` |

## Validation and result

- Complete scope command documented above: **264 tests passed, 0 failed, 0 skipped**.
- Final wording/error assertions: targeted Claude, Codex client, Codex adapter and OpenCode adapter run: **7 passed**, other cases deliberately filtered.
- Final Codex trusted-state/account-path rewrites: **6 passed**, other cases deliberately filtered.
- Initial `pnpm --filter @orquester/daemon typecheck` identified an assertion-induced `never[]` narrowing in the rewritten service test; corrected to compare event count. It also reported an unrelated workflow test error, forwarded to that owner. The root integration owns the final repository typecheck/test gates.
- `git diff --check` passed; final source/test diff inspected, including concurrent export-only changes. No coverage or test-count gate conflict encountered. No retained baseline product bug found in this scope.
- Net change excluding this report: **1,183 fewer test lines**, **55 fewer production/support lines**. Deleted functions/default wrapper have no production callers; remaining production implementations and behavior are unchanged.
