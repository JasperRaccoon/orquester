# UI other test cleanup

Status: completed cleanup. Dispositions were recorded before edits; implementation and focused validation are recorded below. Scope: every original UI test/check outside lib/components agent-chat and workflows. 45 files; 322 named declarations (one parameterized declaration covers signOut/selectConnection) and 6 check scripts. Named dispositions: **24 DELETE, 24 REWRITE, 274 KEEP**. Check scripts: **2 DELETE, 1 REWRITE, 3 KEEP**. Final named execution expands to 298 passing cases.

Independent sources: AGENTS.md payload validation, persisted compatibility and security rules; README product workflows; `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` (§5.2 migration, §6 launch, §7 composer/history/attention); `docs/superpowers/specs/2026-09-28-agent-profile-design.md` (§3 ownership, §4.3 revisions, §4.5 validation, §6 import, §7 UI); public API wire types in `packages/api/src/agent-profile.ts`, saved-prompts and agent-chat contracts. Specific historic failures are also identified in tests (wrong-tab shortcuts, stale-load races, WebKit gesture-bound copying, prototype-key lookups, archived-data exposure).

Shared six-bar justification applied to each KEEP/REWRITE row: **B1** the file source below supplies the independent contract; **B2** the specific failure is the negation of the named scenario, shown in the failure column; **B3** fixed fixture inputs and literal expected data/state constitute an oracle independent of the implementation (not its constants, except stable protocol error discriminants); **B4** the actual production-used seam below is invoked; **B5** assertions depend on returned data, public state, API requests or externally required callback lifecycle, not markup/private collaborators, so algorithm/module refactors preserve them; **B6** no stronger retained test owns that seam-specific conversion, async ordering, or state transition. Daemon/API tests own their own persistence/validation, not browser caches or UI request construction. Where a duplicate, representation or copy assertion existed it is explicitly DELETE/REWRITE.

Risk: low for pure deletion; editor hook removals must preserve every production default. Focused validation command for all retained `.test.ts`: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=4 <retained paths>` from packages/ui. Remaining `.check.ts` use the same import preloads without `--test`. Package typecheck: `pnpm --filter @orquester/ui typecheck`. Root owns final repository gates.

## `packages/ui/src/components/command-palette/conversation-search.test.ts`

Owner read: `packages/ui/src/components/command-palette/conversation-search.ts`. Production callers: CommandPalette and search-hit rendering. Independent source (B1): Conversation search public query/snippet protocol and palette mode navigation.

Isolated-owner failure model considered before retention: Wrong mode navigation, truncated/blank requests, corrupt marked snippets, confusing unavailable indexing with transport failure, losing previous results, or hiding empty/truncated search state.

## `packages/ui/src/components/right-rail/agent-profile/agent-profile-render.check.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention.

DELETE entire check script: static markup/class/geometry/copy inventories and source greps do not survive a behavior-preserving render or identifier refactor (B4/B5 fail); no actions run. The secret-negative check never supplies the alleged secret, so it passes for the wrong reason. Retained editor draft, store, error classification and concurrency tests own the real contracts.

## `packages/ui/src/components/right-rail/agent-profile/default-agent.test.ts`

Owner read: `packages/ui/src/components/right-rail/agent-profile/default-agent.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention.

Isolated-owner failure model considered before retention: The profile opens on the wrong active adapter, stale preference, uninstalled agent or unsupported provider; fallback ordering selects a profile the user cannot manage.

## `packages/ui/src/components/right-rail/agent-profile/editor/agent-profile-editor-render.check.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention.

DELETE entire check script: static markup/class/geometry/copy inventories and source greps do not survive a behavior-preserving render or identifier refactor (B4/B5 fail); no actions run. The secret-negative check never supplies the alleged secret, so it passes for the wrong reason. Retained editor draft, store, error classification and concurrency tests own the real contracts.

## `packages/ui/src/components/right-rail/agent-profile/editor/markdown.logic.test.ts`

Owner read: `packages/ui/src/components/right-rail/agent-profile/editor/markdown.logic.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention.

Isolated-owner failure model considered before retention: Skill drafts override CLI boolean defaults, destroy unknown frontmatter, send command names as metadata, clear the wrong field or accept an invalid agent-specific file name.

| Disposition | Original test | Failure / reason |
|---|---|---|
| DELETE | a skill's name field is the name input, never a second field | Private editor field inventory. Draft tests protect the name written to the API. |
| DELETE | names: skills are hyphenated lowercase words, commands may have one folder | Replays public name validator cases through a message wrapper; packages/api agent-profile validation is the stronger owner. |
| REWRITE | names: Grok's commands are flat files — a folder is refused before the daemon does | Retain agent-specific flat-command validity through validateMarkdownForm; delete private flag and hint-copy assertions. |

## `packages/ui/src/components/right-rail/agent-profile/editor/mcp.logic.test.ts`

Owner read: `packages/ui/src/components/right-rail/agent-profile/editor/mcp.logic.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention.

Isolated-owner failure model considered before retention: Pasted command arguments/env are altered, secret keep/replace intent is lost, invalid or duplicate keys are accepted, transport-specific fields are mixed, advanced typed values/unknown keys are lost, or editing silently changes transport.

| Disposition | Original test | Failure / reason |
|---|---|---|
| DELETE | existing secrets are never prefilled | No secret value enters the fixture, so the negative security claim passes for the wrong reason. Daemon profile redaction owns non-disclosure; retained secretDrafts/stdIO draft tests protect keep/replace semantics. |
| DELETE | the advanced form reads lists and numbers from the view, and opens when anything is set | Private form representation and disclosure appearance; retained wire-draft conversion covers actual values. |
| DELETE | names follow the strictest CLI's rule | Replays imported public API name validator through UI error wording; API tests own accepted names. |
| REWRITE | the default transport is the agent's first; a view's is kept | Drop default-array-order assertion; retain saved SSE transport through the outgoing draft, avoiding silent conversion on edit. |
| DELETE | the signature ignores row identities | Private serialization/memo signature assertion; no user interaction observes dirty state. |

## `packages/ui/src/components/right-rail/agent-profile/editor/saved.test.ts`

Owner read: `packages/ui/src/components/right-rail/agent-profile/editor/saved.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention.

Isolated-owner failure model considered before retention: A save fails to publish its returned snapshot/item IDs, or a malformed answer replaces valid profile state.

## `packages/ui/src/components/right-rail/agent-profile/editor/small-editors.logic.test.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention.

Isolated-owner failure model considered before retention: Hook matcher/command semantics change, invalid import/plugin/marketplace requests are sent, import collisions are skipped, copy sources expose foreign items, instruction overwrite carries an obsolete revision, or daemon refusal codes reach the wrong field.

| Disposition | Original test | Failure / reason |
|---|---|---|
| REWRITE | hook: the agent's events, an unlisted event on disk kept selectable, validation | Remove catalogue/default inventories; retain validation of command/timeout and legacy unknown event preservation. |
| REWRITE | import: git URLs, upload names, upload progress | Retain accepted import URL/file formats; remove arithmetic progress display assertion. |
| REWRITE | instructions: overwrite re-reads for the fresh revision, then writes mine | Retain optimistic-concurrency API request with fresh revision; remove unrelated exact summary/file-label assertions and arranged response echo. |
| DELETE | layout: width breakpoints and titles | Geometry and exact copy assertions, expressly excluded by cleanup rules. |
| REWRITE | errors: the daemon's nested code and message; placement by code | Retain protocol code/message classification; remove exact generic fallback copy. |

## `packages/ui/src/components/right-rail/agent-profile/list.logic.test.ts`

Owner read: `packages/ui/src/components/right-rail/agent-profile/list.logic.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention.

Isolated-owner failure model considered before retention: Filtering hides valid records or leaks another project/kind, search misses words/accented content, groups omit unknown-version data, uninstalled agents remain actionable, warning caveats disappear, or copy/manage targets name the wrong agent.

| Disposition | Original test | Failure / reason |
|---|---|---|
| DELETE | All then the agent's own kinds in AGENT_PROFILE_KINDS order, each counted — zero included | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| REWRITE | only the kinds that agent has: OpenCode has no marketplaces or hooks | Drop capability-chip inventory; retain unsupported-filter recovery so switching agents cannot strand the panel on an unavailable filter. |
| REWRITE | groups in the agent's kind order, each sorted by name, empty kinds left out | Remove exact section labels; retain item grouping/order data from the panel requirement. |
| DELETE | titles an empty kind in words | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | words the facts, and never shows Claude's off-switch caveat as a fact | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | drops what the description already says, and bare flags | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | a hook's second line reads alike for every agent: event, matcher, then the rest | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | a hook's name shows the ends of its absolute paths | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | plugins and marketplaces: a version, where from, how many installed | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | an unknown key from another daemon version still shows, after the known ones | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| REWRITE | its tooltip carries the adapter's off-switch caveat while on | Check the daemon-provided caveat survives only while disabling is available; wording outside that warning is not a contract (profile spec §4.6). |
| DELETE | says what pressing it does | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | explains why it is disabled | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | names the file, its lines and when it was edited | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | says a missing file is not created yet | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| REWRITE | lists the four agents, installed as the snapshot, else the overview, says | Remove exact agent labels; retain fresh snapshot precedence and unknown installation state. |
| DELETE | collapses the picker to a dropdown below the segmented control's width | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |

## `packages/ui/src/components/right-rail/dock-keyboard.test.ts`

Owner read: `packages/ui/src/components/right-rail/dock-keyboard.ts`. Production callers: RightRailDock, RightRailBar and right-rail panels. Independent source (B1): AGENTS.md field-wise browser storage validation; dock keyboard ownership and right-rail viewing preference.

Isolated-owner failure model considered before retention: Escape reaches the wrong owner, auto-repeat closes multiple layers, IME cancellation closes the dock, or portaled children leak keys into terminal/global shortcuts.

## `packages/ui/src/components/right-rail/history/history-format.test.ts`

Owner read: `packages/ui/src/components/right-rail/history/history-format.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract.

Isolated-owner failure model considered before retention: A huge prompt is returned without a bound or truncation leaves an invalid Unicode surrogate.

## `packages/ui/src/components/right-rail/right-rail-state.test.ts`

Owner read: `packages/ui/src/components/right-rail/right-rail-state.ts`. Production callers: RightRailDock, RightRailBar and right-rail panels. Independent source (B1): AGENTS.md field-wise browser storage validation; dock keyboard ownership and right-rail viewing preference.

Isolated-owner failure model considered before retention: Malformed persisted data discards valid preferences, newer-version records stop loading, failed localStorage aborts interaction, drag persists before release, or real state changes do not notify subscribers.

## `packages/ui/src/components/right-rail/saved-prompts/deliver.test.ts`

Owner read: `packages/ui/src/components/right-rail/saved-prompts/deliver.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows.

Isolated-owner failure model considered before retention: Resolved prompt content reaches a different chat after a tab switch, a superseded/disposed action still sends, a missing target starts work, or rejected delivery increments use count.

## `packages/ui/src/components/right-rail/saved-prompts/editor-save.test.ts`

Owner read: `packages/ui/src/components/right-rail/saved-prompts/editor-save.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows.

Isolated-owner failure model considered before retention: Unchanged/invalid drafts issue writes, concurrent saves duplicate mutation, close during save drops the result/error, or thrown requests permanently lock saving.

## `packages/ui/src/components/right-rail/saved-prompts/editor.logic.test.ts`

Owner read: `packages/ui/src/components/right-rail/saved-prompts/editor.logic.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows.

Isolated-owner failure model considered before retention: Client validation rejects valid limits or permits daemon-rejected input, create/update changes the wrong scope or unchanged fields, duplicate truncation damages Unicode, or a variable replaces the wrong selection.

## `packages/ui/src/components/system/session-owner.check.ts`

Owner read: `packages/ui/src/components/system/session-owner.ts`. Production callers: SystemPanel, process tree actions and SessionChip. Independent source (B1): SystemProcessInfo/KillProcessErrorCode protocol and archived project privacy boundary.

Isolated-owner failure model considered before retention: Archived/missing session ownership leaks a title or valid active sessions cannot navigate to their owning project.

KEEP each original assertion group:

- KEEP visible session names its project and title — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP archived project/workspace, missing-project and unknown sessions disclose no title — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP unloaded project is resolved from the owning workspace path — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.

## `packages/ui/src/components/system/system-format.check.ts`

Owner read: `packages/ui/src/components/system/system-format.ts`. Production callers: SystemPanel, process tree actions and SessionChip. Independent source (B1): SystemProcessInfo/KillProcessErrorCode protocol and archived project privacy boundary.

Isolated-owner failure model considered before retention: Orphan tmux roots/descendants disappear, cyclic PID input hangs, rolled-up memory is wrong, kill targets include the wrong PIDs, or daemon protection codes become unclassified.

KEEP each original assertion group:

- KEEP orphan tmux pane and daemon roots preserve all descendants; subtree RSS/PIDs are correct kill targets — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP recycled-PID cycle terminates and preserves processes — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP self-parenting process remains a root — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP recognized API kill refusal codes survive; unknown/network/null errors remain unclassified — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.

## `packages/ui/src/components/topbar/usage-format.check.ts`

Owner read: `packages/ui/src/components/topbar/usage-format.ts`. Production callers: UsageChip and UsageDetailsPanel, app usage events. Independent source (B1): ProviderUsageWindow sparse update API and persisted UsagePrefs settings.

Isolated-owner failure model considered before retention: The wrong usage driver is selected, disabled agents are fetched, scoped usage disappears without base windows, or credit capacity/reset data is lost.

KEEP each original assertion group:

- KEEP busiest/pinned/missing-pinned/empty driver selection reflects UsagePrefs — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP only enabled agents missing from current usage require fetching — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP unknown windows stay absent; scoped usage remains available independently of session/week — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP Grok capacity numbers and reset time survive normalization with credits unit — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.

## `packages/ui/src/components/topbar/usage-format.test.ts`

Owner read: `packages/ui/src/components/topbar/usage-format.ts`. Production callers: UsageChip and UsageDetailsPanel, app usage events. Independent source (B1): ProviderUsageWindow sparse update API and persisted UsagePrefs settings.

Isolated-owner failure model considered before retention: Sparse usage events erase unnamed windows or duplicate values already owned by the daemon poll.

| Disposition | Original test | Failure / reason |
|---|---|---|
| DELETE | an empty update is a no-op, not a reset | Redundant subset of sparse-update preservation: the existing omitted-weekly-window case exercises the same contract. |

## `packages/ui/src/lib/agent-auth-notice.test.ts`

Owner read: `packages/ui/src/lib/agent-auth-notice.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts.

Isolated-owner failure model considered before retention: Dismissed auth errors continually reappear on provider refresh, or changed provider/auth outcomes fail to raise a new notice.

## `packages/ui/src/lib/agent-chat-active-tab.test.ts`

Owner read: `packages/ui/src/lib/agent-chat-active-tab.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts.

Isolated-owner failure model considered before retention: Mounted hidden chats capture keys, terminal/no-selection state retains a chat owner, stale unmount clears a newer claim, or activation closes a just-subscribed popover.

## `packages/ui/src/lib/agent-profile/app-wiring.test.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention.

Isolated-owner failure model considered before retention: Stream dispatch drops correctly channeled updates or applies identical payloads delivered on an unrelated channel; direct store tests cannot detect this routing error.

| Disposition | Original test | Failure / reason |
|---|---|---|
| DELETE | a malformed payload is ignored without a throw | Duplicate malformed-event test at extra layer; store.test.ts asserts an already populated store is preserved, a stronger oracle. |
| DELETE | ˋ${name} resets them before it switches the clientˋ | Source-shape grep depends on local method spelling and set-call ordering. Store reset/connection-switch tests exercise actual outcomes. |

## `packages/ui/src/lib/agent-profile/store.test.ts`

Owner read: `packages/ui/src/lib/agent-profile/store.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention.

Isolated-owner failure model considered before retention: Malformed wire data poisons state, stale async replies resurrect/overwrite rows, scopes/connections leak into one another, reconnect/event invalidation never refreshes, concurrent requests duplicate, mutation errors/optimistic rollback disappear, or device preferences are lost.

| Disposition | Original test | Failure / reason |
|---|---|---|
| REWRITE | repairs the source, the warnings and the meta | Retain tolerant source/warning/meta validation and externally supplied labels; remove the generated fallback label wording assertion. B1 payload validation, B2 invalid metadata reaching the UI, B3 malformed fixed fixtures, B4 real sanitizer, B5 semantic data only, B6 client boundary ownership. |
| REWRITE | is single-flight: concurrent callers share one request | Delete promise-identity constraints; retain request coalescing observed at public daemon API. |
| REWRITE | a forced load during one in flight asks once more after it — shared by every forced caller | Delete promise-identity constraints; retain request coalescing observed at public daemon API. |
| REWRITE | keeps the daemon's code (a not-installed agent) and names a route this daemon lacks | Keep the daemon AGENT_NOT_INSTALLED code used by the panel; remove generated unsupported-route sentence matching. B1 daemon refusal protocol, B2 picker incorrectly treats an absent agent as actionable, B3 literal error code, B4 real store load, B5 semantic code independent of copy, B6 only store owns refusal preservation. |
| REWRITE | replaces the snapshot with the answer's and says so, the change carrying the item's revision | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | the daemon's notes become the notice | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | a 409 PROFILE_CONFLICT refetches the agent and says it changed on disk | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | another refusal becomes the notice in the daemon's words | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | AGENT_NOT_INSTALLED refetches the agent and the overview (the picker learns it) | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | a copy lands the TARGET's snapshot on the target | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | reads the stored pick once, remembers a new one, and survives a store reset | Use global browser localStorage with descriptor restoration; remove production-only storage injection/reset hook and write-count constraint. |
| REWRITE | a storage that throws leaves the pick in memory | Use global browser localStorage with descriptor restoration; remove production-only storage injection/reset hook and write-count constraint. |

## `packages/ui/src/lib/app-config.check.ts`

Owner read: `packages/ui/src/lib/app-config.ts`. Production callers: app store, MainView, launchers and chat preference controls. Independent source (B1): AGENTS.md tolerant browser persistence and chat preference/unread contracts.

Isolated-owner failure model considered before retention: Corrupt localStorage crashes startup, an invalid field discards valid neighbors, absent fields overwrite host defaults, or a legacy usage value fails the client aggregate migration.

REWRITE: delete standalone normalizeUsagePrefs schema passthrough/current/legacy/garbage cases; `packages/config` owns that migration. KEEP complete `sanitizeStoredAppConfig` mixed valid/invalid input, missing host defaults, malformed blobs and malformed nested usage isolation. B1 AGENTS.md migration/validation, B2 no client startup crash or overwritten host defaults, B3 literal legacy fixture/results, B4 adapter sanitizer, B5 no schema-internal assertions, B6 aggregate localStorage shape is distinct from config schema.

## `packages/ui/src/lib/chat-prefs.test.ts`

Owner read: `packages/ui/src/lib/chat-prefs.ts`. Production callers: app store, MainView, launchers and chat preference controls. Independent source (B1): AGENTS.md tolerant browser persistence and chat preference/unread contracts.

Isolated-owner failure model considered before retention: Old/corrupt preference records overwrite defaults, wrong types enter UI state, or unknown permission modes reach launches.

## `packages/ui/src/lib/composer-inbox.test.ts`

Owner read: `packages/ui/src/lib/composer-inbox.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts.

Isolated-owner failure model considered before retention: Pre-mount delivery is lost, mounted delivery is replayed, closed sessions retain prompts, or content/attachments cross session boundaries or lose order.

## `packages/ui/src/lib/copy-produced.test.ts`

Owner read: `packages/ui/src/lib/copy-produced.ts`. Production callers: CopyButton. Independent source (B1): Async Clipboard API gesture timing and rejected promise behavior; credible Safari copy regression.

Isolated-owner failure model considered before retention: Safari receives the write after user activation expires, unread/truncated data is copied, rejected reads become unhandled rejections, or fallback clipboard support drops valid text.

## `packages/ui/src/lib/file-icon.test.ts`

Owner read: `packages/ui/src/lib/file-icon.ts`. Production callers: FilePreview and FileTypeIcon attachment rendering. Independent source (B1): Filename/MIME classification boundary; malicious Object.prototype-named input crash regression.

Isolated-owner failure model considered before retention: Untrusted Object.prototype-named filename/MIME selects a non-icon prototype member and crashes attachment rendering.

## `packages/ui/src/lib/file-kind.test.ts`

Owner read: `packages/ui/src/lib/file-kind.ts`. Production callers: FilePreview and FileTypeIcon attachment rendering. Independent source (B1): Filename/MIME classification boundary; malicious Object.prototype-named input crash regression.

Isolated-owner failure model considered before retention: Prototype-named extensions return a non-kind value, archive suffixes select the wrong preview, or uppercase extension classification fails.

## `packages/ui/src/lib/launch-models.test.ts`

Owner read: `packages/ui/src/lib/launch-models.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts.

Isolated-owner failure model considered before retention: Launch requests omit/reuse unavailable model IDs, default selection becomes nondeterministic, or model search removes the current/default selection needed by the user.

## `packages/ui/src/lib/open-layers.test.ts`

Owner read: `packages/ui/src/lib/open-layers.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts.

Isolated-owner failure model considered before retention: Nested layer release closes another layer, duplicate cleanup corrupts the open-layer count, or Escape cannot identify the topmost layer.

## `packages/ui/src/lib/preferred-model.test.ts`

Owner read: `packages/ui/src/lib/preferred-model.ts`. Production callers: app store, MainView, launchers and chat preference controls. Independent source (B1): AGENTS.md tolerant browser persistence and chat preference/unread contracts.

Isolated-owner failure model considered before retention: Stored option values of the wrong type enter launch requests, remembered options leak to another model, or invalid storage aborts launch.

## `packages/ui/src/lib/prompt-history/checkpoints.logic.test.ts`

Owner read: `packages/ui/src/lib/prompt-history/checkpoints.logic.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract.

Isolated-owner failure model considered before retention: Unavailable checkpoints are offered, history overwrites the live fold, steer/autonomous turns get the wrong origin or rewind opener, totals are wrong, or prompt/path search misses matches.

## `packages/ui/src/lib/prompt-history/index-cache.test.ts`

Owner read: `packages/ui/src/lib/prompt-history/index-cache.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract.

Isolated-owner failure model considered before retention: Concurrent prompt reads duplicate, failed pages erase loaded prompts, old hosts are retried endlessly, catching-up state loses retryability, cursors skip/duplicate rows, or cut text stays permanently failed.

## `packages/ui/src/lib/prompt-history/prompts.logic.test.ts`

Owner read: `packages/ui/src/lib/prompt-history/prompts.logic.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract.

Isolated-owner failure model considered before retention: Overlapping history duplicates prompts, subagent/internal messages become reusable, rewind removes a prompt but its index copy survives, ordering/turn association changes, or multi-word search misses matches.

## `packages/ui/src/lib/prompt-history/rewind.logic.test.ts`

Owner read: `packages/ui/src/lib/prompt-history/rewind.logic.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract.

Isolated-owner failure model considered before retention: Compaction is missed outside visible rows, unsupported/busy chats rewind, stale row counts are guessed, an in-flight send races rewind, or page/rewind failure is reported as success.

## `packages/ui/src/lib/prompt-history/thread-inputs.test.ts`

Owner read: `packages/ui/src/lib/prompt-history/thread-inputs.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract.

Isolated-owner failure model considered before retention: Token-only streaming invalidates history subscriptions despite the external-store selector requirement, or busy/approval/rewind changes fail to update the panel.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP after merge review | moves when what the panel shows moves: the turn settling, a request docking, a rewind | Retain snapshot identity as well as busy/approval/rewind data: usePromptHistory passes this selector to useSyncExternalStore, so an in-place mutation would leave History stale even if the data assertions passed. |

## `packages/ui/src/lib/regexp.test.ts`

Owner read: `packages/ui/src/lib/regexp.ts`. Production callers: FilePreview, composer attachments and timeline token splitting. Independent source (B1): ECMAScript regular expression literal escaping including Unicode mode.

Isolated-owner failure model considered before retention: A literal user metacharacter acquires regex syntax, matches the wrong text or cannot compile under Unicode regex mode.

## `packages/ui/src/lib/saved-prompts/app-wiring.test.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows.

Isolated-owner failure model considered before retention: Stream dispatch drops correctly channeled updates or applies identical payloads delivered on an unrelated channel; direct store tests cannot detect this routing error.

## `packages/ui/src/lib/saved-prompts/list.logic.test.ts`

Owner read: `packages/ui/src/lib/saved-prompts/list.logic.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows.

Isolated-owner failure model considered before retention: Another project's prompts leak into the list, case/accent/word matching misses valid prompts, edits remain cached under stale text, or favorites lose their independently required separate section.

## `packages/ui/src/lib/saved-prompts/store.test.ts`

Owner read: `packages/ui/src/lib/saved-prompts/store.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows.

Isolated-owner failure model considered before retention: Malformed wire data poisons state, stale async replies resurrect/overwrite rows, scopes/connections leak into one another, reconnect/event invalidation never refreshes, concurrent requests duplicate, mutation errors/optimistic rollback disappear, or device preferences are lost.

## `packages/ui/src/lib/saved-prompts/variables.test.ts`

Owner read: `packages/ui/src/lib/saved-prompts/variables.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows.

Isolated-owner failure model considered before retention: A no-chat template leaks a previous agent/model or a real selected registry/catalog identity loses its label/fallback.

## `packages/ui/src/lib/session-kind.test.ts`

Owner read: `packages/ui/src/lib/session-kind.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts.

Isolated-owner failure model considered before retention: Legacy terminal/chat kinds overlap, unavailable adapters are offered for resume, or seed titles overwrite a user-chosen title.

## `packages/ui/src/lib/thread-visits.test.ts`

Owner read: `packages/ui/src/lib/thread-visits.ts`. Production callers: app store, MainView, launchers and chat preference controls. Independent source (B1): AGENTS.md tolerant browser persistence and chat preference/unread contracts.

Isolated-owner failure model considered before retention: Corrupt visits poison unread state, wall-clock visits hide newer completions, older reads regress a watermark, mark-unread changes another thread, or running/unvisited chats become falsely unread.

| Disposition | Original test | Failure / reason |
|---|---|---|
| DELETE | an unparseable visit stamp is ignored without changing the stored data | Duplicate of the no-completed-turn and monotonic-read cases in this file. |
| REWRITE | mark-unread stamps one millisecond before the completion | Assert unread state and unchanged other thread instead of freezing the private timestamp-offset encoding. |

## `packages/ui/src/lib/transporters/http-transporter-stream.test.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: ApiClient stream consumers in web and desktop transports. Independent source (B1): Transporter.openStream public callback lifecycle and HTTP response status semantics.

Isolated-owner failure model considered before retention: HTTP errors are delivered as stream data, failed responses omit/duplicate lifecycle callbacks, or successful chunks fail to end once.

Net source/test change in this scope: **1,864 fewer test lines** and **81 fewer production lines** (audit report excluded).

## Production seams and support removed

- Render checks and their local fixtures/harnesses; no standalone snapshots.
- Test-only editor `initial`, `initialSpec`, `initialSource`, forced `showErrors`, `advancedOpen`, markdown `moreOpen`, panel `width`, environment `initialWidth`, preset-effect bypasses, and unused exported inner components/types/helpers; production callers use the existing defaults.
- `agentProfileEntry` test-only exported selector is private; its tests read the same public Zustand store snapshot used by hooks. Sanitizer tests import their owning module instead of dead store re-exports.
- Agent-profile storage override and `__setAgentProfileStorageForTests`; retained persistence tests use actual browser global boundary.
- Additional orphaned internal component props/types/constants and helper exports are private after a repository-wide caller search; no runtime call is removed. The panel width override and markdown disclosure override had only the removed render-check callers.
- SVG preload and timer preload are shared package support; retain while any surviving UI tests need them. No package script is changed to suppress tests.

## Validation results

- Baseline focused run: 314 tests passed; initial baseline list omitted the separately identified 9 active-tab cases. Those were read and included in final execution.
- Final focused run across all 39 retained `.test.ts` files: **298 tests, 60 suites, 0 failures, 0 skipped**.
- Four retained check scripts passed: `app-config.check.ts`, `system-format.check.ts`, `session-owner.check.ts`, `usage-format.check.ts`.
- `pnpm --filter @orquester/ui typecheck` passed both before and after removal of render-only props and orphaned exports.
- Follow-up import/selector cleanup: **41 tests passed** across profile store, app wiring and editor saved publication. Final generated-copy pruning: **37 store tests passed**, no failures/skips.
- `git diff --check` passed. Final source/test diff reviewed; every removed injection branch preserved the production default, and callers were searched across the repository.
- Root owns final repository test/typecheck/build gates, remote integration, commit and push. No baseline product failure was found, no coverage/test-count conflict appeared, and no user workflow/E2E artifact contract was removed.
