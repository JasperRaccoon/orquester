# Config test audit

Audited every test in `packages/config`: 19 files, 147 baseline named tests, 2,420 baseline test lines. Final package: 143 tests and 2,383 lines (-37 lines), including one lowest-owner timeout case consolidated from three daemon tests. `packages/registry` has no test script or test files.

Baseline test dispositions: {'KEEP': 128, 'REWRITE': 8, 'CONSOLIDATE': 9, 'DELETE': 2}. Cross-package originals are recorded by the daemon-root owner; the surviving timeout case is recorded below.

Removed five repeated scenarios (two DELETE, three CONSOLIDATE), six parser-derived idempotence assertions and two test-only predicate wrappers. Collection/version format checks now use the real persisted-record parsers. No production runtime behavior, fixture files, dependencies, snapshots or runner configuration changed.

## Behavioral evidence

For every retained row, the file evidence below supplies the independent source, public stable seam, independent oracle, refactor resistance and production consumer. The row identifies its specific observable failure and unique contract. Pure schema/policy checks own parsing/decisions; daemon/UI integration tests remain for the distinct disk I/O, request sequencing and workflow effects. Path checks protect persisted on-disk names across upgrades. No reflection/source inspection or private collaborator expectations are used.

## `packages/config/src/agent-accounts.test.ts`

Source: README.md: managed agent accounts; AGENTS.md: persisted-data validation.

Stable seam: `index.ts: parseAgentAccounts`. Non-test consumer: `apps/daemon/src/agent-accounts.ts`.

Independent oracle: Authored managed-account disk records; literal default identities and rejection of a deliberately unsupported provider.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 5: parseAgentAccounts fills defaults and coerces missing fields | KEEP | An older managed-account index without optional identity/reauth/default fields must still load with null identities and reauth off; detects upgrade-induced account loss or spurious reauthentication. |

| 15: parseAgentAccounts rejects an unknown agent | KEEP | An unsupported agent identity must be refused instead of being launched as a supported provider; the otherwise-valid record isolates the agent enum. |



## `packages/config/src/agent-tools.test.ts`

Source: docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §§7.6,9.6; AGENTS.md: auth server-side and tolerant stores.

Stable seam: `agent-tools.ts: parse/serialize/findGrant/removeThreadFromAgentTools`. Non-test consumer: `apps/daemon/src/agent-tools/service.ts`.

Independent oracle: Authored LEGACY file and literal accepted grant IDs/null denials; expected authorization is never computed from grantScopesOf.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 42: an older build's file round-trips: its toolset switches, unknown keys and grant families survive a rewrite untouched | REWRITE | Authored legacy tool switches, future keys, unknown grant families and unreadable grant records must survive serialization verbatim; literal LEGACY comparison remains, parser-derived idempotence equality removed. |

| 59: grants keep working beside the legacy switches: a grant added and one revoked leave them untouched | KEEP | Adding/revoking an actual grant must preserve retired switches while ignoring their old enabled flag; catches grant edits destroying old-build state or disabling current authorization. |

| 79: missing fields read as defaults; a fresh file holds grants only | REWRITE | Empty persisted input must grant nothing and a fresh serialized file must contain version 1 and an empty grants list; replaces equality to a production default factory with an independent empty-grants oracle. |

| 84: removing a thread drops its chat grants and its legacy rows — nothing else | KEEP | Deleting a thread must revoke its chat grants and old thread switches while preserving other threads and malformed legacy values; input immutability matters because callers share the read store. |

| 101: anything that is not a version-1 file throws, so the daemon moves it aside and grants read as none | KEEP | Unsupported outer versions/shapes must throw so callers quarantine rather than honor a damaged grant file; malformed legacy switches remain opaque. |

| 110: findGrant: only full-access, non workflow-owned callers; chat grants of that chat; project grants of that project | KEEP | Only full-access non-workflow callers may use matching chat/project grants; literal denied modes, cross-project unions, temporary/workspace targets and forbidden families catch privilege escalation. |

| 143: findGrant: workflows grants cover only the workflows recorded in that chat — never a create or a referenced prompt | KEEP | A workflows grant applies only to recorded workflow IDs and never creation, referenced prompts or another project; catches authorization widening despite a valid grant record. |

| 163: findGrant: a cross-project grant covers its one target project | KEEP | A cross-project grant authorizes exactly one recorded destination; catches target substitution or omitted-target authorization. |



## `packages/config/src/auth-sessions.test.ts`

Source: README.md: Security model revocable sessions; AGENTS.md: preserve unknown persisted records and fail closed.

Stable seam: `auth-sessions.ts: parseAuthSessionsFile/serializeAuthSessionsFile; index.ts: authSessionsPath`. Non-test consumer: `apps/daemon/src/auth/sessions.ts`.

Independent oracle: Authored device/API disk records and literal digest, expiry absence, retained unknown data and quarantine expectations.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 23: lives beside daemon.json | KEEP | The remote login store must remain at daemon/auth-sessions.json across upgrades; a path change would silently invalidate devices and API tokens. |

| 27: unknown top-level keys and record fields survive a rewrite | REWRITE | Known bearer digests/password fingerprint, unknown root/record fields and a nonexpiring API record must survive serialization; exact authored raw-file equality replaces parser-derived equality. |

| 45: records this build cannot read are kept verbatim and never honoured | KEEP | Unknown kinds, malformed bearer digests and duplicate digests must remain unreadable while surviving rewrite; catches acceptance of invalid credentials or rollback data loss. |

| 56: anything but a version-1 file throws | KEEP | An unsupported version/nonobject/nonlist must be refused rather than replacing login state; empty input remains a deliberately empty store. |



## `packages/config/src/chat-usage-limit.test.ts`

Source: packages/api/src/agent-chat/usage-limit.ts: recovery wire/state contract; docs/superpowers/research/2026-10-22-t3code-gap/02-providers.md: usage recovery; AGENTS.md: optional persisted-data tolerance.

Stable seam: `index.ts: parseAppConfig/parseSessionsConfig`. Non-test consumer: `apps/daemon/src/agent-chat/limit-recovery.ts; apps/daemon/src/sessions.ts`.

Independent oracle: Authored recovery/legacy config objects with literal resume policy, timestamps and field-level fallback expectations.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 32: the usage-limit settings default to resume on, failover off — also for an app.json without them | KEEP | Legacy app preferences must resume limited chats by default but leave account failover off; explicit failover opt-in must survive parsing. |

| 43: a chat record's usage-limit state round-trips, keeping fields a newer daemon wrote | KEEP | The armed resume state, reset timestamp and newer failover metadata must survive session parsing; catches lost recovery scheduling after daemon restart. |

| 54: a malformed field falls back on its own; a block that does not parse is dropped, never the record | KEEP | Malformed recovery fields must individually fall back, and an unreadable recovery block must not discard the chat tab or its last sequence. |



## `packages/config/src/desktops-config.test.ts`

Source: docs/superpowers/specs/2026-09-30-desktop-tab-design.md: persisted desktop/process/display inputs; docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md: box identity; AGENTS.md: tolerant stores.

Stable seam: `index.ts: parseDesktopsFile/serializeDesktopsFile and desktop path helpers`. Non-test consumer: `apps/daemon/src/desktops/store.ts`.

Independent oracle: Authored desktop/app/box records and literal process status, Xvnc bounds and retained raw records; dimensions are process inputs, not DOM layout.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 27: desktop paths live under the daemon dir | KEEP | Desktop index/runtime directories must keep their documented daemon-owned paths so surviving desktops can be reconciled after restart. |

| 33: defaults are applied to desktop and app records | KEEP | Older desktop/app records must receive usable display defaults while a missing process status is never trusted as running; catches a false live-process claim from incomplete state. |

| 53: unknown record fields and top-level keys survive a parse/serialise round trip | REWRITE | Unknown desktop/app/root fields and the recorded process group must survive serialization; literal field assertions replace production-derived parse-again equality. |

| 71: a VM desktop names its box and its directory there; older records run on this machine | KEEP | Box-backed desktops must preserve box identity/directory, old records remain local, and malformed box identity must be quarantined rather than misrouted locally. |

| 83: a bad record is kept verbatim in rejected while the good ones load | KEEP | Unreadable desktop records and repeated IDs must be retained verbatim beside independent valid desktop IDs; catches silent store loss and duplicate active owners. |

| 93: the outer shape still throws (quarantine, never overwrite) | KEEP | Outer version/list errors must refuse the whole store so the daemon quarantines it rather than overwrites surviving desktop metadata. |

| 98: size is clamped to the display bounds | KEEP | Persisted Xvnc dimensions must round and clamp to 320×240–7680×4320; these are process/resource input bounds, not incidental rendered geometry. |

| 112: recent launches are capped per project; unreadable entries are set aside, not used | KEEP | Recent launches must retain the first twenty valid entries per project, skip malformed commands, and avoid using unreadable project lists. |

| 130: unreadable recent entries are written back verbatim | KEEP | Unreadable recent-launch entries must survive serialization even while not offered as launch candidates; separate write obligation from the preceding read/cap contract. |

| 144: one unreadable app entry is kept verbatim and does not wipe the others | KEEP | A single unreadable app must not erase sibling apps, and its raw record must return to the serialized apps list without leaking the cache-only rejectedApps field. |

| 161: records keep the client's projectPath spelling beside the realpath | KEEP | Client project-path spelling must remain distinct from its realpath, allowing the UI project key and sandbox reconciliation to coexist; old records have no realpath hint. |



## `packages/config/src/idle-compaction.test.ts`

Source: docs/superpowers/research/2026-10-22-t3code-gap/02-providers.md §1a; AGENTS.md: tolerant multi-version config and non-destructive rewrite.

Stable seam: `index.ts: parseAppConfig/resolveIdleCompaction/applyAppConfigUpdate`. Non-test consumer: `apps/daemon/src/agent-chat/idle-compaction.ts; app-config read/update callers`.

Independent oracle: Literal mode choices and an authored old-client update with expected preserved disk fields and replaced override map.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 6: idle compaction defaults to T3 Code's 'when you return', also for an app.json without it | KEEP | Legacy app.json input must select onReturn and no account overrides, matching the documented user setting rather than enabling unattended compaction. |

| 14: a mode another version wrote reads as the default instead of failing the whole file | KEEP | An unknown global mode falls back, unreadable overrides alone disappear, and unrelated timeout preferences survive; catches one newer enum value corrupting the entire app config. |

| 30: an account's override wins over the default; an account without one follows it | KEEP | An explicit account override wins, otherwise the global mode applies, and inherited object keys must never become account overrides. |

| 42: an older client's whole \`agents\` write keeps the idle-compaction settings it does not know | KEEP | An older client updating another agents preference must preserve idle-compaction settings and unknown fields in the stored file; catches cross-version destructive writes. |

| 73: a field the body names wins, a record field is replaced whole, and an invalid update throws | KEEP | Explicit preference values win, the whole per-account record replaces prior entries so deletion works, invalid updates reject, and a first write can start from defaults. |



## `packages/config/src/index.test.ts`

Source: AGENTS.md: sandbox containment, account pinning, tolerant thread/session persistence; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§3.3,5.2; docs/superpowers/specs/2026-09-24-agent-goals-design.md §5.5; packages/ui/src/components/settings/AgentsSettings.tsx: 1–30 minute input; packages/ui/src/store/app.ts: default 30.

Stable seam: `index.ts public naming/config/session/head/log APIs; fs.ts: assertInsideFsRoot`. Non-test consumer: `apps/daemon/src/sessions.ts; agent-host/store; daily-log; apps/daemon/src/index.ts: launch timeout`.

Independent oracle: Authored disk records and exact marker fields; literal local dates/file parts, explicit permitted/rejected paths and FsSandboxError; literal timeout endpoints.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 9: isValidName rejects traversal and empties | KEEP | Workspace/project names must reject hidden names, separators and empty/undefined values while permitting a normal project; catches traversal through public naming validation. |

| 18: a daemon.json written with the retired http.tailscaleServe flag still loads, the flag ignored | KEEP | A daemon config with the retired tailscaleServe field must remain usable while dropping that retired switch; catches a rollback-era file preventing daemon startup. |

| 30: sessionRecordSchema round-trips accountId so reattach keeps the account pin | KEEP | Persisted accountId must survive reattachment so a live account remains pinned and its refresh token is not rotated; older system sessions remain unpinned. |

| 51: sessionRecordSchema keeps a workflow owner and drops a malformed one, never the record | KEEP | Valid workflow/indexer ownership must survive parsing while malformed optional ownership alone is dropped; catches lost ownership or lost tabs on mixed-version metadata. |

| 90: assertInsideFsRoot allows in-root paths and rejects escapes | KEEP | The real filesystem containment API must accept existing/new in-root paths and throw FsSandboxError for escapes; the temp directory is necessary to exercise realpath behavior. |

| 121: legacy proxy-home tabs and thread heads remain readable after launcher retirement | KEEP | Retired cliproxy tabs/heads must remain readable as system-home records with resume identity intact; catches losing stored conversations after launcher retirement. |

| 158: a head written before goals — no marker — still parses, and says no | KEEP | A pre-goals head must remain readable without adding an automatic goal-resume marker; catches unintended autonomous work after upgrade. |

| 165: a malformed goal-resume marker is dropped, never the whole head | KEEP | Non-true goal-resume markers must be dropped without losing the thread; catches malformed state triggering automatic continuation. |

| 174: a head without the goal-hold marker says no, and writes none back | KEEP | An old head must omit the goal-hold marker on rewrite; catches an upgrade inventing a held goal. |

| 181: a malformed goal-hold marker is dropped, never the whole head | KEEP | A malformed goal-hold marker must be dropped independently; catches one optional handover value making the whole thread unreadable. |

| 192: a stamped continuation marker round-trips beside both goal marks — through JSON, as meta.json holds it | REWRITE | An explicitly authored stamped continuation and both true goal markers must survive parsing; prevents losing automatic handover intent. Removes parse-again equality whose expected value came from production. |

| 213: the crash-resume count round-trips on the marker and the head — through JSON, as meta.json holds it | REWRITE | Literal crashAttempt and crashResumedTurn values must survive parsing, preventing a crash loop from losing its retry limit; removes a production-derived idempotence equality. |

| 226: a pending wake round-trips on the head through JSON; a bad one reads as none, a bad task is dropped | REWRITE | A literal completed-task wake must survive, malformed tasks alone disappear and invalid wake state falls back; catches losing deferred task results. Removes a derived parse-again equality. |

| 262: a malformed crash-resume count reads as none, never an unreadable head | KEEP | Invalid nonpositive/noninteger crash counts must disappear without losing the continuation turn or thread; catches corrupt retry state disabling recovery. |

| 276: a malformed continuation stamp reads as unstamped — an older host's marker — never an unreadable head | KEEP | An unreadable continuation stamp must leave its turn/prepared flag usable under the legacy rule and preserve unrelated handover state; catches unreadable threads or wrong restart policy. |

| 300: daily log files: a day's first file, its later parts, and parsing them back | KEEP | Daily log paths must use local calendar day plus documented part suffixes, and parser must reject unrelated/ambiguous filenames; catches wrong-day logs and retention deleting unrelated files. |



## `packages/config/src/knowledge-linking.test.ts`

Source: docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md: linking storage; AGENTS.md: preserve newer persisted fields.

Stable seam: `knowledge-linking.ts: parse/read/serializeKnowledgeLinkingState`. Non-test consumer: `apps/daemon/src/knowledge/linking/state.ts`.

Independent oracle: Authored current/newer state files, explicit intact flag and literal edited file version/data; no expected state is derived from another parser call.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 9: a bad field costs that field only; unknown fields and records survive | KEEP | Unreadable linking fields and list elements must fall back independently while valid state, unknown keys and counters survive; catches one malformed value losing all indexer state. |

| 37: not a version-1 object throws (the caller keeps the file aside) | KEEP | The version-1 parser must refuse unsupported versions and primitives so callers do not overwrite unreadable state. |

| 57: a newer version's state reads what this build knows and keeps its version and unknown fields on rewrite | KEEP | A newer linking state whose known values remain readable must retain its own version and unknown data through an actual edited serialization; catches destructive downgrade writes. |

| 80: a newer version's state with a known field this build cannot read is not intact | KEEP | A newer state with any unreadable known field/list member must be flagged nonintact; catches an older daemon rewriting and discarding newer state. |

| 88: readKnowledgeLinkingState: a current file reads as current; an older, odd or missing version still throws | KEEP | The compatibility reader must distinguish current state from unsupported old/noninteger/missing versions; catches incorrectly adopting a file that must be quarantined. |



## `packages/config/src/knowledge-store.test.ts`

Source: docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md: IDs/storage/provenance; AGENTS.md: tolerant stores.

Stable seam: `knowledge-store.ts: file ID guard, collection parse/serialize and entry frontmatter parser`. Non-test consumer: `apps/daemon/src/knowledge/store/store.ts; knowledge/search/search.ts; knowledge/search/graph.ts`.

Independent oracle: Authored file stems, collections/frontmatter, literal chart-1 fallback/neon preservation, expected valid IDs and retained raw rejected rows.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 24: ids follow the contract's shapes | REWRITE | Entry file-name predicates must accept the literal lowercase twelve-character entry ID and refuse uppercase/short stems used by graph/search file discovery; collection-ID checks move to the real collection parser and its dead wrapper is removed. |

| 32: collections file: unknown fields, unreadable records and unknown keys survive a rewrite | CONSOLIDATE | Collections must retain unknown data/unreadable rows, reject repeated names/IDs and overlong IDs, and serialize an unknown color unchanged; adds literal neon serialization assertion from the consolidated color case. |

| 60: collections file: a colour this build does not know (a newer palette key) is kept for the rewrite | CONSOLIDATE | The standalone newer-color setup duplicates unknown-color preservation in the collections rewrite owner; its only distinct default-color assertion moves into the existing bare-array compatibility case. |

| 70: collections file: a bare array reads as version 1; a wrong outer shape throws | CONSOLIDATE | Legacy bare arrays must remain readable, absent colors default to chart-1, empty stores remain empty and invalid outer shapes refuse rewrite; protects actual old disk shapes without a separate color scenario. |

| 78: entry frontmatter: defaults, tolerated variants, and unknown keys kept | KEEP | Entry frontmatter must normalize legacy savedFrom/empty author, default optional metadata and refuse missing content hash/invalid ID while preserving unknown keys. |

| 103: entry frontmatter: savedFrom keeps unknown keys, and an unknown \`by\` still reads | KEEP | A newer savedFrom identity or unknown nested metadata must survive parsing; catches silently losing provenance when opening entries saved by another version. |



## `packages/config/src/lineage.test.ts`

Source: docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md: opened/delegated ownership and reply delivery; AGENTS.md: durable tolerant records/idempotent commands.

Stable seam: `index.ts: parseSessionsConfig/parseAgentThreadHead/parseForkHandoff/merge and reply outbox parse/serialize`. Non-test consumer: `apps/daemon/src/agent-chat/lineage.ts; agent-chat/replies.ts; sessions.ts`.

Independent oracle: Authored parent/fork/merge/reply/attention records and literal delivery IDs/states, absent values and byte-equivalent rewritten raw files.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 42: a tab record keeps its lineage, and drops one it cannot read — never the record | KEEP | Tab records retain valid parent/fork lineage, while malformed optional lineage never costs the tab and old tabs remain parentless. |

| 57: a fork point that does not read is dropped on its own | KEEP | An unreadable fork point alone must disappear without losing the parent/relation; detects overly coarse optional-field rejection. |

| 65: the head keeps its lineage, and a malformed one reads as none | KEEP | Thread heads independently retain lineage or drop only unreadable lineage; the head and session index use separate persisted schemas. |

| 89: the fork handoff reads whole or not at all | KEEP | Fork handoff must preserve transcript and optional deliveredTurnId/unknown fields while refusing unsupported version or empty transcript; malformed delivery markers must not lose the transcript. |

| 104: the merge outbox keeps unreadable entries and unknown fields for the next rewrite | KEEP | Merge outbox must preserve unreadable rows, unknown fields and failed-attempt state, default legacy states, and refuse bad outer shapes; prevents dropped/replayed queued merges after restart. |

| 131: a lineage's delegation depth persists, and a bad one is dropped on its own | KEEP | Delegation depth must survive or be dropped independently when unreadable; catches depth limits silently resetting after restart. |

| 139: a queued merge keeps its plan mode; an unknown mode is dropped, never the merge | KEEP | Queued plan interaction mode must survive, while an unknown optional mode never loses the merge; catches restart changing the intended execution mode. |

| 151: a tab record keeps an \`opened\` lineage and \`agentCreated: true\`; any other agentCreated is dropped on its own | KEEP | Opened lineage and true agentCreated must survive, while malformed ownership alone disappears; catches a chat losing its agent-created authority identity. |

| 161: the delivery queue: merge, reply and message entries; an unknown kind is kept verbatim, never delivered as a merge | KEEP | The delivery queue must distinguish merge/reply/message, retain unknown kinds as unreadable and preserve cause/subscription metadata; catches delivering an unknown kind as a merge. |

| 205: the reply outbox round-trips and keeps unknown fields, unknown states and unreadable entries verbatim | KEEP | Reply outbox must preserve valid subscriptions/deliveries, unknown raw state, duplicate rows and root fields on serialization; catches cross-chat delivery loss during upgrades. |

| 224: a subscription keeps its idempotency key and its retry-stable queue entry | KEEP | Idempotency and stable queue-entry IDs must survive persistence, and a malformed idempotency key makes only its subscription unreadable; catches duplicated delivery after retry. |

| 235: the reply outbox refuses anything but a version-1 outbox | KEEP | Reply outbox rejects unsupported outer shapes, defaults absent interaction mode, and drops only an unknown origin; catches unsafe rewrites or misrouted origin state. |

| 245: the new stores live beside the merge outbox | KEEP | Reply, tool-grant and approval-journal files must keep their documented daemon-owned paths across upgrades. |

| 251: a lineage keeps the inherited \`workflowOwned: true\`; any other value is dropped on its own | KEEP | Inherited true workflowOwned must survive lineage parsing while other values do not create inherited workflow ownership; catches a delegated chat escaping workflow restrictions. |

| 259: a subscription's posted / ended / toTitle round-trip; a newer ending is kept, a malformed post makes the entry unreadable | KEEP | Posted receipt, ending and destination title must survive, unknown future endings are preserved, and malformed posted receipt quarantines the entry; catches duplicate post after restart. |

| 273: the reply outbox's attention notices round-trip, an unreadable one kept verbatim; an outbox without them writes none | KEEP | Attention notices must retain retry/cause metadata and unknown fields, keep unreadable notices verbatim and remain absent from old empty outboxes; catches lost pending-input notifications. |



## `packages/config/src/plugins-config.test.ts`

Source: docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md: account settings; AGENTS.md: tolerant plugin config.

Stable seam: `index.ts: plugin state parse/read, stored engine and knowledge settings`. Non-test consumer: `apps/daemon/src/plugins/plugins-service.ts; knowledge/settings.ts`.

Independent oracle: Authored legacy/current install records, literal independent engine/version/error settings and explicit unknown-shape preservation/known-shape refusal.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 15: plugin files live in the daemon dir | KEEP | Plugin config, install and preload paths must preserve the on-disk daemon layout so existing installations and launch preloads remain discoverable. |

| 22: a ts-rust record with an engine and tsrs's versions round-trips; a record without them still reads | CONSOLIDATE | The same real plugin record now protects both legacy top-level tsc-rs versions/check/error fields and nested tsrs versions; literal full-record equality catches selective field loss, while old records keep no inferred engine. |

| 43: an engine this build does not know reads as none and is kept; a malformed tsrs record is rejected | KEEP | Unknown engine selections remain raw but are not used; malformed nested tsrs install state must reject at use, preventing a newer engine name corrupting all plugin state. |

| 53: an empty plugins.json reads as no plugin state | KEEP | Empty plugin config and missing known-plugin records must be read as no enabled/install state; catches spontaneous activation or inability to start with no plugins. |

| 59: a full plugin record round-trips | CONSOLIDATE | Top-level installed/previous/skipped/check/error fields are merged into the stronger two-engine record owner; removes a second otherwise-equivalent parse/pluginStateOf roundtrip. |

| 72: an older build's per-workspace list is read as it is, and never defaulted in | KEEP | Legacy per-workspace activation remains stored verbatim and is never invented for current enabled records; catches breaking rollback/migration activation state. |

| 79: unknown fields and unknown plugin ids written by other versions are kept | CONSOLIDATE | Unknown root, install, record and plugin fields must survive; known knowledge settings passthrough now shares this owner and still checks the actual pluginStateOf output against literal settings. |

| 95: an unknown plugin id with any shape does not make the file unreadable, and round-trips verbatim | KEEP | An unknown plugin may have a wholly different/primitive shape without poisoning known-plugin reads; generic unknown object fields alone do not protect this case. |

| 102: a malformed plugins.json is rejected rather than read as empty | KEEP | Malformed plugin outer versions/list shapes must reject rather than masquerade as an empty installation state. |

| 107: a known plugin's malformed record is rejected where it is read | KEEP | A malformed known-plugin activation/install record must reject only where used; catches launching or overwriting untrustworthy plugin state. |

| 117: knowledge-graph settings read field by field; a bad value never makes the record unreadable | KEEP | Knowledge settings must accept only readable account/model/concurrency fields individually, keeping nullable legacy selection and ignoring bad values without losing the plugin. |

| 131: knowledge-graph settings read the account policy field by field, keeping unknown keys | KEEP | Knowledge account policies must preserve literal valid strategy/limits, apply independent defaults and tolerate unknown keys/list items field by field; catches unintended indexing account selection. |

| 171: a plugin record's settings and their unknown keys survive a parse | CONSOLIDATE | Known-plugin settings and unknown metadata passthrough move into the existing unknown-fields owner; no settings-preservation assertion is dropped. |



## `packages/config/src/repo-identities.test.ts`

Source: docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md: repository identities and stored images; AGENTS.md: sandbox-safe file access/tolerant records.

Stable seam: `repo-identities.ts public store parser/filename guards; index.ts path helpers`. Non-test consumer: `apps/daemon/src/repo-identities/service.ts`.

Independent oracle: Authored emoji/image/legacy records and literal safe/unsafe names, retained metadata and first-key owner selection.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 27: the store and its icons live beside the other daemon-owned indexes | KEEP | Repository identity index and icon directory must keep documented daemon-owned paths so existing labels/icons remain accessible. |

| 32: a well-formed store round-trips unchanged | KEEP | Authored emoji, PNG/favicon and absent-icon records must all parse unchanged, including optional labels/source metadata; catches supported identity variants disappearing. |

| 48: unknown fields survive, at every level | KEEP | Unknown root, identity, image and favicon-source fields must survive; protects rollback data across all nested identity layers. |

| 58: bad entries are set aside one by one, verbatim; the rest loads | KEEP | Unreadable identity/icon records, unsafe filenames, unsupported media and malformed metadata must be quarantined verbatim while a valid sibling loads; catches unsafe icon reads or whole-store loss. |

| 84: a repeated repoKey: the first record is the identity, the later one is kept aside | KEEP | A repeated repo key must preserve the first identity and retain the later raw row; catches nondeterministic identity selection or data loss. |

| 92: a missing list or version reads as an empty version-1 store | KEEP | A legacy empty object must remain an empty version-1 identity store rather than an unreadable file. |

| 96: a broken outer shape throws, so the daemon moves the file aside | KEEP | Unsupported outer versions/shapes must refuse rewriting rather than wipe repository labels/icons. |

| 102: icon file names are generated ids only | KEEP | The filename guard used for actual icon reads/deletes must accept supported generated IDs/extensions and refuse traversal, separators, case/extension changes and oversized names. |

| 109: repoIconFileOfEntry reads a well-formed file name off any entry, rejected ones included | KEEP | Garbage collection must recover a safe referenced image filename even from a rejected/future identity without treating unsafe or nonrecord data as a file; catches deleting another version’s still-referenced icon. |



## `packages/config/src/saved-prompts-config.test.ts`

Source: README.md: daemon-owned saved prompt library; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md: prompt ownership; AGENTS.md: preserve unknown persisted records.

Stable seam: `index.ts: parseSavedPromptsConfig/isAgentCreatedPrompt/savedPromptsPath`. Non-test consumer: `apps/daemon/src/saved-prompts.ts`.

Independent oracle: Authored prompt bodies/provenance/scope/default files, literal first-record selection and exact raw rejected entries; records are independent fixtures, not parser-generated oracles.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 20: savedPromptsPath lives beside the other daemon-owned indexes | KEEP | The saved library must remain at daemon/saved-prompts.json so upgrades do not silently hide user prompts. |

| 24: a well-formed library round-trips unchanged | DELETE | Fails unique-protection bar: the repository-scope case already compares the same complete authored legacy/project/global records, and the empty-store case checks rejected/extra defaults. Remove this duplicate parser success setup. |

| 29: bad entries are set aside one by one, verbatim; the rest of the library loads | KEEP | Unreadable saved prompt records must be retained verbatim without dropping valid siblings; catches one corrupt prompt wiping the library. |

| 46: a repeated id keeps its first record; the others are set aside, not dropped | KEEP | Repeated IDs keep the first prompt and retain later raw rows; catches a duplicate replacing a user’s saved content. |

| 54: repository scope round-trips, accepts legacy records, and preserves invalid entries | KEEP | Complete legacy/project/repository/global prompt records must survive parsing while malformed repository scope is quarantined; this is the stronger owner of the deleted generic well-formed case. |

| 64: unknown top-level keys are kept, exactly as found | KEEP | Unknown root keys, including __proto__, remain own data rather than object inheritance; catches prototype pollution or rollback data loss. |

| 72: optional fields default, limits are NOT re-applied, and unknown fields pass through | KEEP | Older prompt defaults, longer stored title/tag lists and unknown record fields must survive without reapplying current editor limits; catches rollback hiding user content. |

| 98: the outer shape still throws — an unknown version included — so the file is not rewritten | KEEP | Unsupported library version/nonlist shape refuses rewriting, while an empty object is a deliberate empty library; catches destructive fallback. |

| 106: createdBy survives a read and a rewrite verbatim — newer kinds and fields too; a non-object makes the record unreadable, kept verbatim | KEEP | Agent-created provenance and unknown future kinds/fields must survive, malformed nonobjects are quarantined and old prompts remain user-owned; catches unauthorized ownership reinterpretation. |

| 121: a null createdBy reads (and is rewritten) as absent; only a structurally invalid non-null value sets the record aside | KEEP | Explicit null provenance must behave as absent while invalid arrays/empty objects quarantine records; catches older null-valued prompts disappearing or being misclassified. |



## `packages/config/src/secret-files.test.ts`

Source: docs/superpowers/specs/2026-10-19-secret-files-plugin-design.md: vault/blob/version/clone storage; AGENTS.md: secret privacy, path containment and tolerant records.

Stable seam: `secret-files.ts: parse/serializeSecretVaultsConfig and real blob filename guard; index.ts path helpers`. Non-test consumer: `apps/daemon/src/secret-files/vault-store.ts`.

Independent oracle: Authored vault/version/hash/path/provenance records with literal forbidden paths/IDs, exact raw serialized files, null-prototype own-key behavior and SHA-256 filenames.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 44: the vault index and its blobs live under daemon/secret-files | KEEP | Vault index/blob directories must keep their daemon/secret-files layout, preserving stored private-file content references across upgrades. |

| 50: a well-formed index round-trips unchanged | DELETE | Fails unique-protection bar: complete vault bytes already round-trip in unknown-fields and retired-files/legacy-record owners, while the duplicate-key case independently retains multiple workspaces. Remove repeated success-only parse/serialize setup. |

| 58: an empty or default file parses to no vaults; missing excluded/clones default | KEEP | Legacy empty/default vaults and missing exclusion/clone maps must still load without invented files or clone baselines. |

| 67: unknown fields survive at every level, and unknown top-level keys are kept | KEEP | Unknown nested version/provenance/file/clone/root metadata must survive actual serialization exactly; catches destructive rollback rewrites of private-file history. |

| 80: bad records are set aside one by one, verbatim, and written back after the good ones | CONSOLIDATE | Invalid paths, hashes, version IDs and record shapes must remain quarantined beside valid vaults; version boundary/separator checks move here from the removed test-only predicate, and a valid minimum-length version remains in the common authored fixture. |

| 126: retired files and unlisted clones round-trip; records without them still parse | KEEP | Retired histories and unlisted clone timestamps must survive, older records gain no retired data, and a formerly retired path may be managed again; catches lost restore histories or broken remanagement. |

| 146: a repeated (workspace, repoKey) keeps the first and sets the rest aside | KEEP | Duplicate workspace/repository keys must preserve the first vault while a different workspace remains usable; catches cross-workspace vault collision. |

| 155: the outer shape throws | KEEP | Unsupported outer versions/shapes must refuse rewrite, preventing a damaged vault index from being replaced with empty state. |

| 161: a __proto__ key in a stored map stays an own key and pollutes nothing | KEEP | An own __proto__ clone/root key must round-trip without polluting Object.prototype; catches attacker-controlled map keys changing object behavior or losing clone baselines. |

| 174: the record schema and the id predicates | CONSOLIDATE | Actual blob-file guard must accept lowercase SHA-256 and reject trailing newline/traversal. Remove the duplicate successful record-schema assertion and dead version-predicate wrapper; its meaningful version checks move to persisted-record rejection. |



## `packages/config/src/session-profiles.test.ts`

Source: docs/superpowers/specs/2026-10-18-agent-profiles-design.md §§4.4,5.5; AGENTS.md: secrets stay on daemon, tolerant records and paths.

Stable seam: `session-profiles.ts persisted manifest/secrets/deleted parsers/serializers; index.ts profile paths and chat/head schemas`. Non-test consumer: `apps/daemon/src/session-profiles/store.ts; session-profiles/export.ts; agent-host/store`.

Independent oracle: Authored manifests/secrets/tombstones and explicit retained values/path bytes; literal s3cret must never appear in thrown text.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 53: reads good items, keeps bad ones verbatim with a reason, and round-trips unknown fields | KEEP | Manifest must load good skills/MCP, report unreadable/new-kind/duplicate items in place, and preserve unknown root/settings/item/MCP metadata on serialization. |

| 73: defaults what an older or hand-written manifest leaves out | KEEP | Handwritten/older manifests must receive empty description/settings and enabled/all-agent defaults without losing their command item. |

| 91: keeps a setting it cannot read verbatim through a rewrite, never failing the profile | KEEP | Unknown-shaped known settings must remain completely raw across rewrite; catches an older build coercing a newer setting and permanently losing it. |

| 102: knowledgeCollections (Knowledge Graph): absent is fine; a list, stale ids or an unreadable value round-trip verbatim | KEEP | Knowledge collection references, including stale or unreadable values, must remain opaque and absent when omitted; catches profile rewrite dropping collection restrictions or inventing selection. |

| 113: keeps a plugin source it cannot read verbatim through a rewrite; reads it only at use | KEEP | Unknown plugin source formats must survive rewrite but remain unreadable at use, while a supported marketplace source retains future metadata; prevents loading an unsupported source as something else. |

| 131: throws on anything that is not a version-1 manifest | KEEP | Unsupported manifest versions and unsafe profile IDs must refuse the entire manifest; catches rewriting incompatible profiles or escaping profile directories. |

| 139: round-trips readable entries, unreadable ones and unknown keys | KEEP | Profile-secret records must preserve readable values, unreadable item rows and root keys; empty files serialize with no secrets, preventing secret loss during mixed-version writes. |

| 153: never quotes a value when it throws | KEEP | Unsupported secret-file versions must throw without including the supplied secret in the error message; independently authored s3cret is forbidden output. |

| 162: round-trips readable entries, unreadable ones and unknown keys; refuses another version | KEEP | Deleted-profile names and unreadable tombstones/unknown fields must survive rewrite, with unsupported versions refused and the documented deleted-index path unchanged. |

| 181: lays the profiles, prepared and staging dirs under <appdir>/daemon/session-profiles | KEEP | Profile source, prepared account/version and staging directories must keep their documented layout; unsafe prepared version segments must throw before path construction. |

| 196: keys the system identity as \`system\` and refuses unsafe segments | KEEP | System account identity must map to system while opaque IDs remain unchanged and unsafe profile path segments reject; catches profile/account directory escape. |

| 209: keeps a profileId on the tab's chat block and drops one that does not read | KEEP | The session-index chat schema must retain valid profileId, omit absent values and drop malformed IDs; catches a restart silently losing the launch profile. |

| 216: keeps a profileId on the thread head (the schema strips unknown keys) | KEEP | The separately persisted thread head must retain valid profileId and drop blank/absent values; head parsing strips unknown keys, so a session-record assertion cannot supersede this one. |



## `packages/config/src/subagent-cache-ttl.test.ts`

Source: packages/ui/src/components/settings/AgentsSettings.tsx: automatic/1h/5m user setting; AGENTS.md: persisted config and state trust.

Stable seam: `index.ts: parseAppConfig/createDefaultAppConfig/parseSubagentCacheTtlState/state path`. Non-test consumer: `apps/daemon/src/subagent-cache-ttl.ts`.

Independent oracle: Literal supported TTL modes and authored automatic decision timestamps/outcomes/costs; unsupported files read as null.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 10: the subagent cache lifetime defaults to auto | KEEP | Old app config/default preferences must select automatic TTL rather than change billing/cache behavior after upgrade. |

| 15: each subagent cache lifetime mode is preserved and anything else is rejected | KEEP | The three supported TTL modes must remain selectable while unsupported strings/nonstring values reject; catches malformed persisted policy silently taking effect. |

| 23: the auto decision is kept in the daemon dir | KEEP | The automatic decision file must keep its daemon/subagent-cache-ttl.json path so previously computed policy remains available. |

| 27: a stored auto decision round-trips | KEEP | An authored automatic decision must retain TTL/timestamps/outcome/request count/cost estimate, including an insufficient-data null estimate; catches losing persisted adaptation state. |

| 45: a stored auto decision that cannot be trusted reads as none | KEEP | Unreadable or unsupported automatic decisions must read as none; catches applying an untrusted TTL or timestamp to future launches. |



## `packages/config/src/tooling.test.ts`

Source: docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md §10: target-specific tool installation and launch environment; Node NODE_OPTIONS process interface.

Stable seam: `tooling.ts: path/environment composition; one actual Node child invocation`. Non-test consumer: `apps/daemon/src/boxes/tooling/provisioner.ts`.

Independent oracle: Literal target paths/PATH/env keys and actual stdout from independently authored preload files; no mock reimplements Node quoting.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 19: box tooling paths follow the target's separators | KEEP | Tooling/install/archive paths must follow the target OS separators and documented cache layout, regardless of daemon OS; catches a Windows box receiving unusable POSIX paths. |

| 35: Node loads preloads with backslashes, spaces and quotes while preserving existing options | KEEP | One real Node child must load authored preload filenames with backslashes/spaces/quotes and retain an existing --title; stdout is an independent interoperability oracle, not a mocked tokenizer. |

| 53: PATH: prepended with the target's delimiter; Windows merges every spelling into the one present | KEEP | PATH contributions must preserve target delimiters/order, merge Windows key spellings case-insensitively, leave POSIX Path separate and refuse to hide the original PATH. |

| 72: env vars land under the existing spelling on Windows; the input env is never changed | KEEP | Windows environment contributions must honor an existing variable spelling without mutating input; catches a child receiving duplicate case-variant env keys or shared launch state being overwritten. |

| 82: no contribution leaves the env as it is; requiring the same file twice adds it once | KEEP | An empty contribution is a no-op and repeated preload contributions must be idempotent; catches duplicate preload side effects across overlapping plugins. |



## `packages/config/src/usage-prefs-migrate.test.ts`

Source: README.md: per-agent usage widget; existing app.json compatibility; AGENTS.md: migrate persisted config without losing user choices.

Stable seam: `index.ts: usagePrefsSchema/usageAgentEnabled/parseAppConfig`. Non-test consumer: `apps/daemon/src/usage.ts; packages/ui usage setting callers`.

Independent oracle: Literal legacy booleans, master-off precedence, new-agent fallback and supported/unsupported chip IDs.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 5: legacy claude/codex booleans migrate into agents record | KEEP | Legacy per-agent usage booleans must migrate preserving both enabled and disabled choices; catches an upgrade turning monitoring back on. |

| 11: new agents record passes through | KEEP | Explicit new per-agent opt-out must apply while an unspecified agent remains enabled; catches unknown/new agent handling overriding existing preferences. |

| 17: disabled master switch overrides per-agent | KEEP | The master usage switch must override an individual enabled agent; catches monitoring continuing after the user disables it. |

| 22: usage defaults and legacy app migration preserve supported chip preferences | KEEP | Legacy app/default chip preferences must retain busiest/default enable and allow the supported Grok chip while rejecting unknown chip IDs. |



## `packages/config/src/workflows-config.test.ts`

Source: docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.5: explicit profile failure cannot become Global; AGENTS.md: tolerant persisted workflow stores.

Stable seam: `workflows.ts: agentConfigSchema/parseWorkflowsFile`. Non-test consumer: `apps/daemon/src/workflows/service.ts`.

Independent oracle: Authored valid/invalid explicit profile IDs with literal quarantine and unknown-field preservation expectations.

Refactor resistance: Observes accepted/rejected public persisted data, rewritten file values, policy decisions, process interoperability or documented paths; does not inspect implementation text, helper call shape, export lists or markup.

Unique owner: Each retained row names a distinct field/variant, authorization decision, compatibility write obligation or actual consumer seam. Daemon/UI integration owns I/O, transport and workflow ordering; these lowest-owner parser/policy cases detect schema/decision regressions directly without replaying those workflows.

| Baseline line and exact test name | Disposition | Specific observable failure / surviving protection |
| --- | --- | --- |

| 17: agent block profileId (Agent Profiles §5.5): kept by id, absent = Global, unknown fields survive | KEEP | An explicit workflow profileId and unknown future config fields must persist, while omitted profileId remains Global; catches unattended runs losing their chosen profile. |

| 25: agent block profileId: a blank or non-string id fails the block, so the record is set aside verbatim — never run as Global | KEEP | A malformed explicit profileId must quarantine that whole workflow record while a valid sibling remains usable; catches silently running a broken explicit profile as Global. |



## Cross-package consolidation

`packages/config/src/index.test.ts` — **CONSOLIDATE**, `Claude stream timeout defaults to 30 minutes and accepts only whole minutes from 1 to 30`. Surviving lowest owner of apps/daemon/src/agent-timeout-config.test.ts (three baseline scenarios): defaults to literal 30; accepts literal endpoints 1/30; refuses 0/31/noninteger/numeric string. The Settings input and independent UI default specify the range/default; config schema is the lowest stable boundary and daemon launch reads it. No new behavioral contract is invented.


## Unused infrastructure and production seams

`isKnowledgeCollectionId` and `isSecretVaultVersionId` had no non-test callers in repository-wide reference searches. Both wrappers and their direct predicate assertions are removed; their actual schema constraints remain, with the literal length/separator cases moved into the surviving collection/vault parser cases. `isKnowledgeEntryId` and `isSecretBlobSha256` remain because production search/discovery/blob reads call them. No fixtures, mocks, snapshots, dependencies or configurations became unused.


## Validation and performance

Original central baseline: all 147 config tests passed. Post-change test/typecheck execution is coordinated by root and will be added after completion. Exact commands: `pnpm --filter @orquester/config test`; `pnpm --filter @orquester/config typecheck`.

No isolated runtime improvement is claimed. There are no test sleeps, browser launches, server startups or database resets here. One real Node subprocess remains to validate NODE_OPTIONS quoting against Node itself; one temporary directory remains to validate filesystem containment against actual realpath behavior. Replacing either with a simulation would weaken the independently specified seam. Overall before/after metrics belong to the central report.
