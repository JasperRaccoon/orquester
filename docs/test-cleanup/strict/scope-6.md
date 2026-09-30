# Strict cleanup scope 6 — UI support, right rail and transport

Recorded before test edits. Scope: all 45 assigned files, 306 named declarations plus the substantive check-script scenarios below. Completed cleanup: **15 DELETE, 49 REWRITE, 242 KEEP** of the 306 named declarations; four check scripts reviewed, with app-config scenarios rewritten through the production adapter. This is an implementation ledger, not a recommendation-only audit.

Six-bar key for every retained row: **1** the file-specific independent source below specifies the listed contract; **2** violating the named behavior causes the listed class of caller-visible failure; **3** authored literal inputs, IDs, request fields and state outcomes are the oracle (never the owner's computed expectation); **4** the listed production caller seam is observed; **5** assertions tolerate helper renames, algorithm changes and rendering refactors; **6** this file owns the listed projection/transport/storage boundary, distinct from daemon persistence or API schema tests. Where an isolated decision is retained, its actual failure modes are enumerated by the case names and file-level observable list.

Per-file validation: `cd packages/ui && node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 <retained .test.ts paths>`; check scripts use the same imports without `--test`. Root owns full repository gates.

Risk: tests/support only; production edits remove visibility of helpers with no external production callers. No production behavior is changed. Store fakes supply transport data or timing and never compute the store result being asserted. Existing public IO dependencies remain because real UI callers bind them.

## `packages/ui/src/components/command-palette/conversation-search.test.ts`

**Independent source (bar 1):** thread-index-and-lazy-boot-design §C Search/Client; shared ThreadSearchResponse and 200-character query contract.
**Seam and non-test callers (bar 4):** conversation-search.ts functions called by CommandPalette.
**Failure/oracle (bars 2–3):** incorrect mode/query/snippet segments and notice state; failed search distinguished from indexed:false. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** mode/query/snippet segments and notice state; failed search distinguished from indexed:false is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `switches to search when `?` is typed first, and keeps the rest as the query` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `leaves an ordinary query alone` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `treats a `?` typed inside the mode as text` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `trims, and sends nothing for blank input` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `never sends more than the host would read` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `splits a snippet on its «marks»` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `keeps a snippet without marks, or with an unclosed one, as plain text` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `says the index is unavailable only when the host answers `indexed: false`` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `never reads an HTTP error as an unavailable index — it is a failure worth retrying` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `says there are no matches, rather than showing nothing` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `shows the previous results while the next search runs` — Compare previous response data structurally rather than requiring the same object reference. The search design specifies retaining visible results during loading; lost prior hits are observable, the supplied prior response is independent, shownSearchResponse is the palette seam, and cloning/memoization refactors must survive. The loading-with-previous branch has no stronger owner.
- **KEEP** `surfaces any other failure in words` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `says when more matched than it shows` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/right-rail/agent-profile/KindTabs.test.ts`

**Independent source (bar 1):** profile spec §7.3 and ARIA tab behavior.
**Seam and non-test callers (bar 4):** KindTabs.tsx internal helper; only external consumer is this test.
**Failure/oracle (bars 2–3):** incorrect no retained case. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** no retained case is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **DELETE** `tab navigation wraps, supports Home/End, and leaves unrelated keys to their owners` — Private arithmetic helper exported only to tests; it does not exercise tab focus, selection, modifier handling or DOM keyboard ownership. No stronger keyboard component test claimed; remove this false proxy and its export.

## `packages/ui/src/components/right-rail/agent-profile/default-agent.test.ts`

**Independent source (bar 1):** agent-profile-design §7.3 active/remembered picker and disabled uninstalled agents; provider refIds contract.
**Seam and non-test callers (bar 4):** default-agent.ts called by AgentProfilePanel.
**Failure/oracle (bars 2–3):** incorrect chosen supported provider or null. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** chosen supported provider or null is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `is the provider serving the tab's refId` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `falls back to the registry's chat adapter while the providers have not loaded` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `is none for no tab, or an agent this panel has no profile for` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `is the visible chat tab's agent first` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `else the one last picked` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **DELETE** `else the first installed one` — Exact catalogue-order fallback has no independent requirement; §7.3 specifies active and remembered picks, which remain covered.
- **KEEP** `passes over an agent known not to be installed` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **DELETE** `is Claude when nothing is known at all` — Hard-codes the implementation fallback agent when neither installation nor prior choice is known; §7.3 does not require Claude.

## `packages/ui/src/components/right-rail/agent-profile/editor/markdown.logic.test.ts`

**Independent source (bar 1):** agent-profile-design §3.1/§7.4; MarkdownDocumentDraft and PROFILE_FRONTMATTER_FIELDS wire contracts.
**Seam and non-test callers (bar 4):** MarkdownEditor.tsx form/draft/validation functions.
**Failure/oracle (bars 2–3):** incorrect CLI frontmatter fields, explicit removals, preserved unknown keys and refused invalid names/body. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** CLI frontmatter fields, explicit removals, preserved unknown keys and refused invalid names/body is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **REWRITE** `a new skill's switches start at the CLI's defaults and send nothing until changed` — Assert the wire frontmatter through markdownDraftFromForm (the editor's production seam); make frontmatterDraft private.
- **KEEP** `editing keeps unknown keys and type-mismatched keys untouched, and removes a cleared key` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `a command carries no frontmatter name and keeps a name key found on disk` — Assert command draft frontmatter through markdownDraftFromForm; remove private helper dependency.
- **KEEP** `names: Grok's commands are flat files — a folder is refused before the daemon does` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `validation: a skill needs its description and a body; a command's description is optional` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/right-rail/agent-profile/editor/mcp.logic.test.ts`

**Independent source (bar 1):** agent-profile-design §3.1/§7.4; McpServerDraft/SecretEntryDraft and per-provider field contracts; shell quoting and HTTP header token semantics.
**Seam and non-test callers (bar 4):** McpEditor.tsx parsePastedCommandLine/mcpDraftFromForm/validateMcpForm.
**Failure/oracle (bars 2–3):** incorrect authored command words, secret keep/value entries, transport and advanced request fields. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** authored command words, secret keep/value entries, transport and advanced request fields is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **REWRITE** `splitCommandLine splits like a shell: quotes, escapes, continuations, no expansion` — Retain authored POSIX word examples through parsePastedCommandLine, which McpEditor actually calls; remove splitCommandLine export.
- **KEEP** `a pasted command line becomes command + args, with leading assignments as env` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `secret drafts: untouched rows keep, replaced and new rows send a value, removed rows are absent` — Observe mcpDraftFromForm.env at the request seam; remove secretDrafts export.
- **REWRITE** `secret rows: bad keys, duplicates (headers case-insensitively) and an empty replacement are refused` — Observe validateMcpForm.errors for env/header rows; remove validateSecretRows export.
- **KEEP** `the stdio draft carries command, args, cwd and env; the http draft url and headers only` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `advanced fields are coerced by type; unknown keys on disk pass through; blanks are left out` — Observe mcpDraftFromForm.advanced, preserving unknown configuration and explicit false; remove advancedDraft export.
- **KEEP** `validation: stdio needs a command, http a real http(s) URL, numbers must parse` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `editing an SSE server preserves its transport in the saved draft` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/right-rail/agent-profile/editor/saved.test.ts`

**Independent source (bar 1):** profile spec §7.2 shared store and §7.3 saved-item feedback; ProfileMutationResponse.
**Seam and non-test callers (bar 4):** all profile editors call publishSaved; AgentProfilePanel subscribes editor bridge.
**Failure/oracle (bars 2–3):** incorrect returned snapshot item IDs and sanitized notification payload. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** returned snapshot item IDs and sanitized notification payload is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `a save puts the answer's snapshot in the store and tells the panel what changed` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an answer without a usable snapshot still tells the panel, and leaves the store alone` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/right-rail/agent-profile/editor/small-editors.logic.test.ts`

**Independent source (bar 1):** profile spec §6 import/copy and §7.4 editors; HookDraft, MarketplaceDraft, ProfileInstructions revision and error envelopes.
**Seam and non-test callers (bar 4):** HookEditor/PluginEditor/MarketplaceEditor/ImportSource/InstructionsEditor.
**Failure/oracle (bars 2–3):** incorrect valid request fields, candidate collision identities, own-source filtering and fresh overwrite revision. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** valid request fields, candidate collision identities, own-source filtering and fresh overwrite revision is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `hook: the matcher is left out for events that ignore it, and when blank` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `hook: a multi-line command keeps its inner lines` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `hook: the agent's events, an unlisted event on disk kept selectable, validation` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `plugin: marketplaces from the snapshot, filtering, OpenCode specs` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `marketplace: GitHub repos (URLs normalised), git URLs, paths; ref only where it applies` — Retain authored GitHub URL/repo/path request examples through marketplaceDraftFromForm and validateMarketplaceForm; remove normalizeGithubRepo's test-only export.
- **KEEP** `import: new candidates start ticked; collisions among the picks ask first` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `import: git URLs, upload names, upload progress` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `copy: every other agent; only the source agent's own items of the kind` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `instructions: overwrite re-reads for the fresh revision, then writes mine` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `errors: the daemon's nested code and message; placement by code` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/right-rail/agent-profile/list.logic.test.ts`

**Independent source (bar 1):** profile spec §7.3 tabs/search/grouping/installation/management; ProfileItem source and kind fields.
**Seam and non-test callers (bar 4):** AgentProfilePanel/ProfileList/ProfileRow and kind tabs use list.logic functions.
**Failure/oracle (bars 2–3):** incorrect kind membership, matching IDs, semantic empty states, eligible copy/management targets. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** kind membership, matching IDs, semantic empty states, eligible copy/management targets is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **REWRITE** `a kind the agent should not have (another daemon version) gets a tab while it has items, after the rest` — Keep membership/count compatibility contract; stop asserting order.
- **REWRITE** `shows the remembered tab when it is one of the agent's, else the agent's first` — Retain valid remembered selections and reject corrupt/unsupported localStorage values by requiring a tab the agent actually offers; drop the unspecified first-tab/MCP fallback. §7.3 specifies per-agent remembered selection and AGENTS requires storage validation. Wrong selection becomes caller-visible; authored tab IDs are independent of the algorithm; effectiveKindTab is called by AgentProfilePanel and is the lowest owner of choosing an offered tab.
- **KEEP** `reads a saved item's kind off its id` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **DELETE** `+ Add lists the shown tab's kind first, and still every creatable kind` — The specification requires supported kinds in Add, not a particular ordering; this case primarily freezes reorder-helper output.
- **REWRITE** `the search matches every word in the name, description, source or meta, any case` — Observe matching result IDs through filterProfileItems, the AgentProfilePanel seam, and privatize matchesProfileQuery. §7.3 search supplies the contract; omitted/extra matching item IDs are the visible failure; literal queries and IDs supply the oracle, tolerate helper/algorithm changes, and exercise distinct multiword, case, source and meta matching beyond the sibling cross-kind case.
- **KEEP** `shows the tab's kind; a search looks across every kind, whatever the tab` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `groups in the agent's kind order, each sorted by name, empty kinds left out` — Keep kind-to-item partition and empty-group exclusion; stop freezing undocumented display order.
- **REWRITE** `a kind the agent should not have (another daemon version) still shows, after the rest` — Keep forward-version kind membership; stop asserting placement after other kinds.
- **DELETE** `rows when there are some` — A trivial null-return branch assertion against arranged shown=3; substantive unavailable/loading/empty/search states remain at this seam.
- **KEEP** `not installed wins over everything` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `loading, then an error with its message, while there is no snapshot` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `no matches while searching, else the empty tab's own state` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `knows an agent is not installed from its snapshot, its refusal, or the overview` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `its tooltip carries the adapter's off-switch caveat while on` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `copies only copyable kinds, to the other installed agents that have the kind` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `names where an inherited item is managed` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `lists the four agents, installed as the snapshot, else the overview, says` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/right-rail/dock-keyboard.test.ts`

**Independent source (bar 1):** agent-chat-gui-design §7 keyboard: open layers own Escape, repeated Escape must not interrupt, dock contains question-answer digits.
**Seam and non-test callers (bar 4):** RightRailDock calls dockKeyAction.
**Failure/oracle (bars 2–3):** incorrect leave/ignore/contain decisions for distinct real keyboard hazards. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** leave/ignore/contain decisions for distinct real keyboard hazards is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `an Escape nothing inside the dock handled leaves the dock` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an Escape the panel consumed (the search field clearing itself) stays the panel's` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an Escape an open dropdown, menu or dialog of the panel closes is that layer's alone` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an IME composition's Escape cancels the composition, nothing else` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a held Escape leaves once: its auto-repeat is not another press` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `keys from a portaled child (a dropdown the panel opened) are never the dock's` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `every other key typed in the dock is contained there` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/right-rail/history/history-format.test.ts`

**Independent source (bar 1):** Unicode text integrity regression: truncating a surrogate pair produces a replacement character.
**Seam and non-test callers (bar 4):** History prompt and checkpoint cards call previewText.
**Failure/oracle (bars 2–3):** incorrect well-formed Unicode after a preview truncation. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** well-formed Unicode after a preview truncation is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **DELETE** `cuts a long one — a pasted 200 KB log becomes a few hundred characters` — Pins an arbitrary 500-character presentation budget and ellipsis; no independent exact preview-size requirement. Unicode corruption regression remains.
- **REWRITE** `never ends on half a surrogate pair` — Keep Unicode integrity; assert no unpaired surrogate instead of exact preview copy/cut count.

## `packages/ui/src/components/right-rail/right-rail-state.test.ts`

**Independent source (bar 1):** AGENTS field-wise localStorage validation; per-device panel/width persistence; React external-store subscription contract.
**Seam and non-test callers (bar 4):** RightRailDock/RightRailBar use rightRailState and mutation functions.
**Failure/oracle (bars 2–3):** incorrect literal stored key/payload fields, state changes and notifications; no geometry oracle. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** literal stored key/payload fields, state changes and notifications; no geometry oracle is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **DELETE** `nothing stored, or garbage stored, loads the defaults` — Pins undocumented open/320px defaults instead of a storage contract. Retained malformed-field and storage-error cases protect usable validated state.
- **REWRITE** `a well-formed payload round-trips` — Retain the named storage contract through a freshly imported module's public rightRailState/setRightRailOpen/setRightRailWidth operations and actual stored bytes; privatize parse/serialize/load/save helpers. Fresh modules isolate each browser startup without introducing a runtime reset hook. The existing literal storage inputs and outcomes remain the oracle; API-level store tests are the lowest production-owned seam after removing test-only exports.
- **REWRITE** `each field is validated on its own: one bad field never costs the others` — Retain the named storage contract through a freshly imported module's public rightRailState/setRightRailOpen/setRightRailWidth operations and actual stored bytes; privatize parse/serialize/load/save helpers. Fresh modules isolate each browser startup without introducing a runtime reset hook. The existing literal storage inputs and outcomes remain the oracle; API-level store tests are the lowest production-owned seam after removing test-only exports.
- **REWRITE** `the workflows panel is a panel like the others` — Retain the named storage contract through a freshly imported module's public rightRailState/setRightRailOpen/setRightRailWidth operations and actual stored bytes; privatize parse/serialize/load/save helpers. Fresh modules isolate each browser startup without introducing a runtime reset hook. The existing literal storage inputs and outcomes remain the oracle; API-level store tests are the lowest production-owned seam after removing test-only exports.
- **REWRITE** `the agent profile panel is a panel like the others` — Retain the named storage contract through a freshly imported module's public rightRailState/setRightRailOpen/setRightRailWidth operations and actual stored bytes; privatize parse/serialize/load/save helpers. Fresh modules isolate each browser startup without introducing a runtime reset hook. The existing literal storage inputs and outcomes remain the oracle; API-level store tests are the lowest production-owned seam after removing test-only exports.
- **REWRITE** `malformed stored widths fall back without losing the panel` — Retain the named storage contract through a freshly imported module's public rightRailState/setRightRailOpen/setRightRailWidth operations and actual stored bytes; privatize parse/serialize/load/save helpers. Fresh modules isolate each browser startup without introducing a runtime reset hook. The existing literal storage inputs and outcomes remain the oracle; API-level store tests are the lowest production-owned seam after removing test-only exports.
- **REWRITE** `a payload written by another version is still read field by field` — Retain the named storage contract through a freshly imported module's public rightRailState/setRightRailOpen/setRightRailWidth operations and actual stored bytes; privatize parse/serialize/load/save helpers. Fresh modules isolate each browser startup without introducing a runtime reset hook. The existing literal storage inputs and outcomes remain the oracle; API-level store tests are the lowest production-owned seam after removing test-only exports.
- **REWRITE** `load and save swallow storage errors and missing storage` — Retain the named storage contract through a freshly imported module's public rightRailState/setRightRailOpen/setRightRailWidth operations and actual stored bytes; privatize parse/serialize/load/save helpers. Fresh modules isolate each browser startup without introducing a runtime reset hook. The existing literal storage inputs and outcomes remain the oracle; API-level store tests are the lowest production-owned seam after removing test-only exports.
- **KEEP** `toggling opens, switches and closes the dock — and persists every change` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `a live drag updates the state only; the release persists it` — Keep explicit user-set widths and persistence timing; remove the unrelated exact 320px reset expectation.
- **REWRITE** `subscribers hear real changes only, and can unsubscribe` — Observe selected panel notifications and stable unchanged snapshot required by useSyncExternalStore; remove incidental default-width expectation.
- **KEEP** `a storage that throws never breaks the store` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/right-rail/saved-prompts/deliver.test.ts`

**Independent source (bar 1):** SavedPrompt usage/Create/Update field contracts; prompt targeting and save lifecycle regressions.
**Seam and non-test callers (bar 4):** SavedPromptsPanel/SavedPromptEditor bind production resolver, chat and store dependencies.
**Failure/oracle (bars 2–3):** incorrect captured chat routing, cancellation, no wrong-chat delivery and use counted only after acceptance. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** captured chat routing, cancellation, no wrong-chat delivery and use counted only after acceptance is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `renders for the chat captured at the click, delivers there, and counts the use` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `refuses when another chat is on screen once the prompt is rendered — nothing lands, nothing counted` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `with no chat at the click, refuses at once and renders nothing` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a click supersedes the one still resolving: the first lands nowhere, its git reads stop` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `dispose (the panel going away) stops the delivery in flight` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `counts the use only when the chat took it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/right-rail/saved-prompts/editor-save.test.ts`

**Independent source (bar 1):** SavedPrompt usage/Create/Update field contracts; prompt targeting and save lifecycle regressions.
**Seam and non-test callers (bar 4):** SavedPromptsPanel/SavedPromptEditor bind production resolver, chat and store dependencies.
**Failure/oracle (bars 2–3):** incorrect single in-flight save, no empty/unchanged request, late completion/failure still handled. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** single in-flight save, no empty/unchanged request, late completion/failure still handled is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `an edit that changes nothing sends nothing, and closes` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an invalid draft is not sent` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `one save at a time: a second while the first is in flight is not sent` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `closed while saving: a success still lands and is revealed` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `closed while saving: a failure becomes the panel's notice` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a request that throws is a failure, and the guard is released` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/right-rail/saved-prompts/editor.logic.test.ts`

**Independent source (bar 1):** SavedPrompt usage/Create/Update field contracts; prompt targeting and save lifecycle regressions.
**Seam and non-test callers (bar 4):** SavedPromptsPanel/SavedPromptEditor bind production resolver, chat and store dependencies.
**Failure/oracle (bars 2–3):** incorrect normalized request fields, sparse edits preserving scope, valid limits, Unicode title and caret insertion. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** normalized request fields, sparse edits preserving scope, valid limits, Unicode title and caret insertion is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `a title and a body are required — as missing, not as errors` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `mirrors every limit` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a create: the whole record, normalised; This project = the open project` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an edit: only the fields that changed` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an edit moves a prompt only when its scope changes — and to the open project` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `never cuts an emoji in half` — Retain the API's 120-code-unit title limit and Unicode validity on duplicate creation; remove the implementation-dependent assertion that exactly prefix length 111 keeps the emoji. A lone surrogate corrupts a user-supplied title, the boundary strings and validity predicate are independent, duplicateRequest is the editor's caller seam, and changing suffix wording must survive. No stronger duplicate-title owner covers this regression.
- **KEEP** `inserts at the caret, or over the selection, and puts the caret after it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/components/system/session-owner.check.ts`

**Independent source (bar 1):** archived project/workspace visibility policy and SessionSummary ownership.
**Seam and non-test callers (bar 4):** SystemPanel calls resolveSessionOwner.
**Failure/oracle (bars 2–3):** incorrect visible owner identity; no archived title leakage. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** visible owner identity; no archived title leakage is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `visible session resolves its title and project` — Fixed input process/config/session data gives the stated output; all six bars above apply.
- **KEEP** `archived project/workspace and missing/unknown session never reveal a title` — Fixed input process/config/session data gives the stated output; all six bars above apply.
- **KEEP** `workspace-path fallback resolves a project absent from loaded project list` — Fixed input process/config/session data gives the stated output; all six bars above apply.

## `packages/ui/src/components/system/system-format.check.ts`

**Independent source (bar 1):** SystemProcessInfo pid/ppid/RSS and KillProcessErrorCode API; recycled PID cycle regression.
**Seam and non-test callers (bar 4):** SystemPanel calls buildProcessTree/subtreePids/killErrorCode.
**Failure/oracle (bars 2–3):** incorrect process membership/ancestry/RSS totals and refusal codes. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** process membership/ancestry/RSS totals and refusal codes is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `daemon and detached tmux pane form separate process roots with children` — Fixed input process/config/session data gives the stated output; all six bars above apply.
- **KEEP** `RSS totals and subtree PID membership include descendants` — Fixed input process/config/session data gives the stated output; all six bars above apply.
- **KEEP** `recycled PID cycle and self-parent terminate without losing processes` — Fixed input process/config/session data gives the stated output; all six bars above apply.
- **KEEP** `known kill refusal codes survive while unknown/non-API errors yield no code` — Fixed input process/config/session data gives the stated output; all six bars above apply.

## `packages/ui/src/components/topbar/usage-format.check.ts`

**Independent source (bar 1):** UsagePrefs pinned/busiest/disabled config and AgentUsage/ScopedUsageWindow data; README quota widget.
**Seam and non-test callers (bar 4):** UsageWidget uses pickDriver/missingUsageAgents/normalizeUsageWindows.
**Failure/oracle (bars 2–3):** incorrect driver ID, enabled missing-agent IDs, scoped percent/reset/capacity data. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** driver ID, enabled missing-agent IDs, scoped percent/reset/capacity data is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `busiest driver, explicitly pinned driver, unavailable pin fallback and empty list` — Fixed input process/config/session data gives the stated output; all six bars above apply.
- **KEEP** `missing enabled usage agents exclude present/disabled agents and disabled widget` — Fixed input process/config/session data gives the stated output; all six bars above apply.
- **KEEP** `scoped-only and combined windows preserve percentages and reset timestamps` — Fixed input process/config/session data gives the stated output; all six bars above apply.
- **KEEP** `Grok weekly capacity preserves credit units, used/limit/remaining and reset` — Fixed input process/config/session data gives the stated output; all six bars above apply.

## `packages/ui/src/components/topbar/usage-format.test.ts`

**Independent source (bar 1):** ProviderUsageWindow sparse update protocol and daemon/provider overlap.
**Seam and non-test callers (bar 4):** app event state and UsageWidget call mergeProviderUsageWindows/providerWindowsToNormalized.
**Failure/oracle (bars 2–3):** incorrect preserved omitted windows and unique IDs. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** preserved omitted windows and unique IDs is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `a sparse update replaces only the windows it names` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a window the daemon's own poll already covers is dropped, not printed twice` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/icons/registry-icons.test.ts`

**Independent source (bar 1):** credible prototype-key rendering crash: untrusted registry refId must not select Object.prototype as a component.
**Seam and non-test callers (bar 4):** RegistryIcon used by tab/launch/profile controls.
**Failure/oracle (bars 2–3):** incorrect a nonempty rendered icon for hostile refId strings without crashing. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** a nonempty rendered icon for hostile refId strings without crashing is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **DELETE** `draws a known agent's own icon` — React.isValidElement also accepts the wrong or generic icon, so this does not prove the named icon behavior.
- **REWRITE** `an id naming an Object.prototype member falls back to the generic icon instead of crashing` — Render through React DOM server and require nonempty output; remove private element.type equality. This catches invalid inherited component types that isValidElement alone misses.
- **DELETE** `an unknown kind draws nothing` — Casts strings outside RegistryKind solely to freeze null output; actual arbitrary refId prototype collision is retained through rendered output.

## `packages/ui/src/lib/agent-auth-notice.test.ts`

**Independent source (bar 1):** agent-chat-gui-design provider status/auth notice; repeated provider-republish dismissal regression.
**Seam and non-test callers (bar 4):** app store and provider-status publisher call notice functions.
**Failure/oracle (bars 2–3):** incorrect dismissed result suppressed; changed provider/message/auth/status remains actionable. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** dismissed result suppressed; changed provider/message/auth/status remains actionable is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `a dismissal sticks across the re-publish the provider load causes` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a DIFFERENT message on the same provider still gets through` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `the same message on a different provider still gets through` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `the key spans [adapterId, status, auth.status, message] (T3's banner key)` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/agent-chat-active-tab.test.ts`

**Independent source (bar 1):** agent-chat-gui-design keyboard ownership: only visible chat may answer/interrupt; activation-order regression.
**Seam and non-test callers (bar 4):** MainView, AgentChatView, composer/question handlers and popovers.
**Failure/oracle (bars 2–3):** incorrect active session ID, no cross-tab actions, lifecycle notification/dismissal. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** active session ID, no cross-tab actions, lifecycle notification/dismissal is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `only the published tab is active; every other mounted tab is not` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `no chat tab showing means no chat tab owns the keyboard` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `subscribers see each change once and never a repeat of the same id` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a tab releases the keyboard only while it still holds it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **DELETE** `a fast switch keeps the newcomer's claim when the old tab unmounts after it` — Same transition as retained non-owner release test: release(a) while b owns active ID. Adds no distinct state or failure.
- **KEEP** `the active chat tab is the one showing, not merely one that is mounted` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a terminal tab on screen means NO chat tab owns the keyboard` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `no active tab, or an id naming none, owns nothing` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a popover subscribed while its unfocused grid cell is being activated stays open` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/agent-profile/app-wiring.test.ts`

**Independent source (bar 1):** profile spec §7.2/§8 channel routing of agentProfile.changed.
**Seam and non-test callers (bar 4):** useAppStore.applyEvent called by event subscription.
**Failure/oracle (bars 2–3):** incorrect only profile channel triggers refreshed snapshot. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** only profile channel triggers refreshed snapshot is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `agentProfile.changed on the agent-profile channel refetches the loaded agent` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `the same message on another channel does not` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/agent-profile/store.test.ts`

**Independent source (bar 1):** profile spec §7.2 state/convergence, §7.3 errors, §8 mutation revision and target; AGENTS wire/storage validation.
**Seam and non-test callers (bar 4):** AgentProfilePanel, editor saves and app connection/event lifecycle call store API.
**Failure/oracle (bars 2–3):** incorrect sanitized profile data, per-agent revisions, cache convergence and connection/storage isolation. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** sanitized profile data, per-agent revisions, cache convergence and connection/storage isolation is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `keeps a well-formed snapshot as it is` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `refuses a snapshot that names no known agent` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `drops malformed items rather than failing the snapshot, and keeps the first of a duplicate id` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `fails permissions closed and locks everything on a locked item` — Observe sanitized item permissions through sanitizeAgentProfileSnapshot, the production store input boundary; make sanitizeProfileItem private. Drop unrelated synthesized name/enabled defaults; the retained contract is that malformed capability flags never grant UI mutation authority.
- **REWRITE** `repairs the source, the warnings and the meta` — Observe source/warning/meta repairs through sanitizeAgentProfileSnapshot; remove direct dependency on its private item sanitizer. Drop unspecified synthesized source and warning-code defaults. Retain incoming warning messages, valid code/action, known source ownership, and removal of malformed metadata.
- **KEEP** `repairs the instructions and the file errors, and tolerates a missing list` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `sanitizes the overview: known agents once, counts of known kinds only` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `loads a snapshot, and a second unforced load asks nothing` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `is single-flight: concurrent callers share one request` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a forced load during one in flight asks once more after it — shared by every forced caller` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a first load that fails is an error; a refresh that fails keeps the snapshot beside the error` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `keeps the daemon's refusal code for a not-installed agent` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an answer for another agent or in a bad shape is an error, not state` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `loads the overview, sanitized` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `marks everything loaded stale on a reconnect, and a load crossing it asks again` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `refetches a loaded agent whose revision moved` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `does nothing for the revision already held` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `does not fetch an agent that was never loaded` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `refreshes a loaded overview too` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a change during an agent's FIRST load asks once more after it (that answer may predate the change)` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `ignores a malformed payload or another type without a throw` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `replaces the snapshot with the answer's and says so, the change carrying the item's revision` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `the daemon's notes become the notice` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a 409 PROFILE_CONFLICT refetches the agent and says it changed on disk` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `another refusal becomes the notice in the daemon's words` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `AGENT_NOT_INSTALLED refetches the agent and the overview (the picker learns it)` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a copy lands the TARGET's snapshot on the target` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a copy whose name is taken answers ITEM_EXISTS quietly; the retry carries onConflict` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an answer whose snapshot does not parse refetches instead` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a load that started before a mutation answered does not overwrite the mutation's snapshot` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `forgets everything, and an answer in flight across it is dropped` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a client of another connection resets first` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `after a reset an event refetches nothing (no client bound)` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `parses field by field, and anything unusable is no pick` — Observe lastAgentProfileAgent/lastAgentProfileTab and rememberAgentProfileAgent/rememberAgentProfileTab on an isolated module over supplied localStorage bytes; privatize parseAgentProfilePrefs/serializeAgentProfilePrefs. AGENTS and §7.3 specify tolerant persisted selections and unknown-field preservation. Fixed malformed/old-version bytes and written fields independently expose lost selections, invalid tabs or erased foreign preferences; the real panel interface survives parser refactors and uniquely owns these startup/migration scenarios.
- **REWRITE** `keeps a tab only for a known agent that has that kind` — Observe lastAgentProfileAgent/lastAgentProfileTab and rememberAgentProfileAgent/rememberAgentProfileTab on an isolated module over supplied localStorage bytes; privatize parseAgentProfilePrefs/serializeAgentProfilePrefs. AGENTS and §7.3 specify tolerant persisted selections and unknown-field preservation. Fixed malformed/old-version bytes and written fields independently expose lost selections, invalid tabs or erased foreign preferences; the real panel interface survives parser refactors and uniquely owns these startup/migration scenarios.
- **REWRITE** `serializes over what another bundle stored, keeping its fields and tabs` — Observe lastAgentProfileAgent/lastAgentProfileTab and rememberAgentProfileAgent/rememberAgentProfileTab on an isolated module over supplied localStorage bytes; privatize parseAgentProfilePrefs/serializeAgentProfilePrefs. AGENTS and §7.3 specify tolerant persisted selections and unknown-field preservation. Fixed malformed/old-version bytes and written fields independently expose lost selections, invalid tabs or erased foreign preferences; the real panel interface survives parser refactors and uniquely owns these startup/migration scenarios.
- **KEEP** `reads stored selections, remembers each agent's tab, and keeps preferences across a reset` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a storage that throws leaves the pick and the tabs in memory` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/app-config.check.ts`

**Independent source (bar 1):** AGENTS validate localStorage; AppConfig partial merge and legacy UsagePrefs migration.
**Seam and non-test callers (bar 4):** createLocalStorageAppConfigAdapter in web initialization; desktop uses its daemon-backed configuration path.
**Failure/oracle (bars 2–3):** incorrect valid flags survive, absent flags stay absent, invalid fields excluded, legacy usage preserved. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** valid flags survive, absent flags stay absent, invalid fields excluded, legacy usage preserved is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **REWRITE** `valid partial fields survive without inventing absent host defaults` — Load authored localStorage JSON through the real app-config adapter; retain the stated partial-config/migration result, privatize the internal sanitizer, and satisfy all six bars above without exporting an implementation helper.
- **REWRITE** `legacy usage per-agent preferences migrate` — Load authored localStorage JSON through the real app-config adapter; retain the stated partial-config/migration result, privatize the internal sanitizer, and satisfy all six bars above without exporting an implementation helper.
- **REWRITE** `non-object data is rejected` — Load authored localStorage JSON through the real app-config adapter; retain the stated partial-config/migration result, privatize the internal sanitizer, and satisfy all six bars above without exporting an implementation helper.
- **REWRITE** `invalid usage field is dropped without discarding valid unrelated fields` — Load authored localStorage JSON through the real app-config adapter; retain the stated partial-config/migration result, privatize the internal sanitizer, and satisfy all six bars above without exporting an implementation helper.

## `packages/ui/src/lib/chat-prefs.test.ts`

**Independent source (bar 1):** agent-chat-gui-design runtime permission modes/default and §7.4 follow-up/skills preferences; AGENTS storage validation.
**Seam and non-test callers (bar 4):** composer, settings and launch controls call chat prefs.
**Failure/oracle (bars 2–3):** incorrect valid remembered preference values and safe mode filtering. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** valid remembered preference values and safe mode filtering is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **REWRITE** `a missing or non-object blob falls back whole` — Load literal JSON through loadChatPrefs, which the app store calls; privatize sanitizeChatPrefs. The named configuration compatibility/default/permission-mode contract and literal expected fields stay independent; parser refactors no longer affect the test.
- **REWRITE** `a blob from an older bundle keeps the fields it does have` — Load literal JSON through loadChatPrefs, which the app store calls; privatize sanitizeChatPrefs. The named configuration compatibility/default/permission-mode contract and literal expected fields stay independent; parser refactors no longer affect the test.
- **REWRITE** `wrong-typed fields are dropped, not coerced` — Load literal JSON through loadChatPrefs, which the app store calls; privatize sanitizeChatPrefs. The named configuration compatibility/default/permission-mode contract and literal expected fields stay independent; parser refactors no longer affect the test.
- **REWRITE** `only known permission modes survive the per-agent map` — Load literal JSON through loadChatPrefs, which the app store calls; privatize sanitizeChatPrefs. The named configuration compatibility/default/permission-mode contract and literal expected fields stay independent; parser refactors no longer affect the test.
- **REWRITE** `an agent with no remembered mode gets the full-access default` — Load literal JSON through loadChatPrefs, which the app store calls; privatize sanitizeChatPrefs. The named configuration compatibility/default/permission-mode contract and literal expected fields stay independent; parser refactors no longer affect the test.

## `packages/ui/src/lib/composer-inbox.test.ts`

**Independent source (bar 1):** agent-chat-gui-design §7.4 attachments and external prompt delivery into persistent tabs.
**Seam and non-test callers (bar 4):** ChatComposer and app delivery/close lifecycle call inbox functions.
**Failure/oracle (bars 2–3):** incorrect ordered exact text/attachment paths and per-session one-time delivery. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** ordered exact text/attachment paths and per-session one-time delivery is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `a delivery made before the composer mounts is waiting for it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a mounted composer receives deliveries directly and nothing queues` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `after unsubscribing, deliveries queue again` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `deliveries are per session and never cross` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `clearing a closed tab drops what was queued for it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a delivery becomes draft text plus one attachment path per line` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `either half alone stands on its own, and an empty delivery is empty text` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **DELETE** `merging keeps order and concatenates attachments` — Only caller is this test: mergeComposerDeliveries is dead runtime code. Mounted delivery and queued ordered drain tests remain; remove the function and test.

## `packages/ui/src/lib/copy-produced.test.ts`

**Independent source (bar 1):** Async Clipboard API transient user activation and MIME/data promises; credible WebKit async-copy and Chromium rejected-write regressions.
**Seam and non-test callers (bar 4):** copyText/copyTextBestEffort pass navigator clipboard and ClipboardItem.
**Failure/oracle (bars 2–3):** incorrect synchronous browser call, eventual full Blob bytes, fallback and observed promise failures. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** synchronous browser call, eventual full Blob bytes, fallback and observed promise failures is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **REWRITE** `a string is written with writeText at once, inside the click` — Record browser API calls only; remove fake clipboard copied-text behavior.
- **REWRITE** `a text still being read starts write() inside the click, and copies it once read` — Record the synchronous write invocation, then inspect its real Blob promise bytes and MIME; fake no longer implements copying.
- **REWRITE** `without ClipboardItem, or without write(), a text being read falls back to writeText once read` — Keep deferred capability fallback using recorded writeText arguments; remove fake copying.
- **REWRITE** `a read that fails copies nothing down either path, and never the cut text` — Verify deferred item rejects or writeText stays uncalled; remove mocked copy behavior from oracle.
- **KEEP** `a write refused without reading its item leaves nothing unhandled when the read fails too` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `with no async clipboard at all (an insecure origin) nothing is copied, and a failing read is still observed` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/file-icon.test.ts`

**Independent source (bar 1):** credible Object.prototype collision in arbitrary file names/MIME from filesystem API.
**Seam and non-test callers (bar 4):** FileTypeIcon and file list call fileIconIdFor.
**Failure/oracle (bars 2–3):** incorrect hostile keys use generic file ID rather than inherited function/object. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** hostile keys use generic file ID rather than inherited function/object is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `reads only its own table keys: a name or mime spelled like an Object.prototype member is unknown` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/file-kind.test.ts`

**Independent source (bar 1):** README file previews and MIME classification API; prototype-extension crash regression.
**Seam and non-test callers (bar 4):** file preview/editor calls detectFileKind.
**Failure/oracle (bars 2–3):** incorrect image/archive/text routing and MIME values from authored file names. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** image/archive/text routing and MIME values from authored file names is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `never resolves a prototype member: an extension like `constructor` is the text fallback` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `classifies by lowercased extension and collapses .tar.* names` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/launch-models.test.ts`

**Independent source (bar 1):** ProviderModel catalogue and mandatory ModelSelection.model launch request; rejected empty/stale model regression.
**Seam and non-test callers (bar 4):** ProjectOverview/NewTabMenu/LaunchModelPicker call resolver/list.
**Failure/oracle (bars 2–3):** incorrect served selected/default model or null, search result identities retaining current selection. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** served selected/default model or null, search result identities retaining current selection is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `a launch always names a model, so the host cannot refuse it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `the remembered pick wins while the catalogue still serves it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a remembered pick the catalogue dropped falls back to the default` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **DELETE** `two models flagged default resolve deterministically to catalogue order` — Requires the first of multiple defaults solely because find() does; launch must choose a served model, not an undocumented tie order.
- **KEEP** `no default flag at all falls back to the first entry` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `no catalogue yields null, so the caller can refuse instead of posting` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `the selected model is always shown, even when a query excludes it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **DELETE** `the catalogue default stays one click away when it is not the selection` — All three fixture models fit the ordinary list, so this passes even if default prioritization is deleted; no independent exact prioritization requirement.
- **KEEP** `search matches the slug or the display name, case-insensitively` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a query with no match shows nothing but the selection` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/open-layers.test.ts`

**Independent source (bar 1):** agent-chat-gui-design §7 open layers own Escape before chat interruption.
**Seam and non-test callers (bar 4):** Modal/BottomSheet/Dropdown/ContextMenu/composer use layer registry.
**Failure/oracle (bars 2–3):** incorrect nested/idempotent releases and topmost keyboard owner. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** nested/idempotent releases and topmost keyboard owner is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **DELETE** `a layer counts as open from its opening until its release` — Duplicates the open/close lifecycle asserted by the retained nested-layer case and tracked-layer lifecycle; no distinct failure.
- **KEEP** `nested layers count separately: closing the inner one leaves the outer one open` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a release runs once in effect: a second call never closes another layer` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a tracked layer knows when a newer one (a dropdown inside a sheet) is above it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/preferred-model.test.ts`

**Independent source (bar 1):** ModelSelection model/options protocol; AGENTS localStorage validation.
**Seam and non-test callers (bar 4):** launch controls save/load model selection and build requests.
**Failure/oracle (bars 2–3):** incorrect typed remembered options survive only for same selected model; corrupt blobs excluded. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** typed remembered options survive only for same selected model; corrupt blobs excluded is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `round-trips model and options, and drops what it cannot type` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `launch carries the remembered options only for the remembered model` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `garbage storage loads as empty rather than throwing` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/prompt-history/checkpoints.logic.test.ts`

**Independent source (bar 1):** Checkpoint/Turn protocol, agent-chat-gui-design §6 rewind origin and ready checkpoint rules.
**Seam and non-test callers (bar 4):** history hooks/cards call checkpoint projection.
**Failure/oracle (bars 2–3):** incorrect available checkpoint IDs, opening prompt identities, ordinal and diff totals. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** available checkpoint IDs, opening prompt identities, ordinal and diff totals is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `lists only ready checkpoints, newest turn first` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `adds the older ones only a loaded history page carries; the fold's copy wins` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `is its turn's, for a prompt that started one` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `is none for a steer — it rides a turn another prompt opened` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `counts files and sums the lines` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `names what opened each turn, newest first` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `goes back to whichever user message opened the turn, and to none the agent opened` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `numbers a card by its turn's ordinal, falling back to the checkpoint's own count` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `matches the opening prompt and the changed paths together` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/prompt-history/index-cache.test.ts`

**Independent source (bar 1):** ThreadPromptsResponse before/indexed/catchingUp and whole-text protocol; thread-index design client fallback/pagination.
**Seam and non-test callers (bar 4):** history hooks own PromptIndexCache and pager predicates.
**Failure/oracle (bars 2–3):** incorrect page/text data, cursors, retry state, per-session isolation and empty-page continuation. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** page/text data, cursors, retry state, per-session isolation and empty-page continuation is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `coalesces a session's first page and caches its prompts` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `falls back for a host without an index, and does not ask it again` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `asks a host without an index once more when the thread says its history is indexed` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `falls back on a failure, says why, and retries on request` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `keeps catching-up state during retries until the index answers` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `turns a failed re-ask into a failure the user can retry, and a terminal answer into no index` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `appends the next page once per message and moves the cursor` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `keeps what it has when an older page fails, and retries it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `wants the next older page only when one exists and nothing is in the way` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `reads as paging while a page is on its way or the next one is due` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `reads a cut prompt once, and again only after a failure` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `keeps asking while the list holds less than a page and the host has more` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/prompt-history/prompts.logic.test.ts`

**Independent source (bar 1):** Turn.userMessageId, ThreadPromptEntry and recallable prompt protocol; thread-index design history client.
**Seam and non-test callers (bar 4):** history selector/hooks call prompt projection and merge.
**Failure/oracle (bars 2–3):** incorrect parent reusable prompt IDs/text, started-turn numbers, rewind pruning and normalized search. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** parent reusable prompt IDs/text, started-turn numbers, rewind pruning and normalized search is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `numbers opening prompts by started turns and keeps the first claim` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `walks the pages, the bridge, then the window — parent user messages only, once each` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `lists the parent's reusable prompts newest first, with the turn each one started` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `leaves out what nobody typed, and says what it was` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `numbers a pending prompt when its turn starts` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `keeps the chat's copy of a prompt both hold, and adds what only the index has below it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `drops an index entry whose turn the fold no longer knows — a rewind removed it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `merges by time, newest first, each list keeping its own order; a tie keeps the loaded prompt first` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `lists an index prompt once even when two pages carried it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `needs every word, in any order` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `shows all prompts for a blank query` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/prompt-history/rewind.logic.test.ts`

**Independent source (bar 1):** agent-chat-gui-design §6 rewind requires settled parent user turn after compaction, supported adapter and idle composer.
**Seam and non-test callers (bar 4):** history hooks call promptRewindTarget/runPromptRewind.
**Failure/oracle (bars 2–3):** incorrect vouched target message/count, compaction denial, fresh busy rechecks and refusal propagation. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** vouched target message/count, compaction denial, fresh busy rechecks and refusal propagation is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **REWRITE** `finds a compaction the settled turn's fold hides from the rows` — Read compaction through latestLoadedCompactionAt, the real history caller seam; make latestSettledCompactionAt private while preserving the blocked older rewind regression.
- **KEEP** `takes the newest across the loaded pages, the bridge and the window` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `reads a rendered prompt's verdict off its row` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `is never offered where the adapter cannot roll back, or for a prompt that started no turn` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `vouches for an index-only prompt by its page's `rewindable`, unless a compaction came since` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `rewinds a rendered prompt to its row's count, without paging anything in` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `brings an older prompt in first, then reads its count off the fresh rows` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `refuses when the reveal shows the turn but still not the prompt's row — no count the rows did not vouch for` — Keep failed outcome and absence of a rewind command after reveal; remove expected copy imported from the implementation.
- **REWRITE** `says why the reveal could not bring the prompt in, or that its row withholds it` — Use distinct caller-supplied reveal reasons for propagation; withheld row asserts refusal/no rewind instead of implementation-owned copy.
- **REWRITE** `reads a reveal that threw as a history page that failed` — Assert failed outcome and no rewind; remove the imported fallback-message oracle.
- **REWRITE** `waits for the agent to be idle — before it starts, and again after paging in` — Assert refusal and no rewind for initially running and subsequently pending requests; remove exact imported UI copy.
- **REWRITE** `waits for a composer send still on its way, read fresh at each step` — Assert refusal/no rewind before and after reveal while sending; remove exact imported UI copy.
- **REWRITE** `never offers what the adapter cannot do, nor a prompt that started no turn` — Assert refusal and zero side effects for unsupported adapter and steer; remove implementation-owned error text.
- **KEEP** `says why the rewind failed` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/prompt-history/thread-inputs.test.ts`

**Independent source (bar 1):** agent-chat-gui-design rewind busy guards from turn/request/rewind state.
**Seam and non-test callers (bar 4):** history hooks use createHistoryThreadSelector and rewindBusyOf.
**Failure/oracle (bars 2–3):** incorrect semantic busy flags; projection correctness distinct from action tests with already-projected inputs. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** semantic busy flags; projection correctness distinct from action tests with already-projected inputs is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **DELETE** `hands back the same value while a turn's answer streams` — Freezes memo object identity across changed snapshots; a behavior-preserving selector refactor may allocate. Prompt extraction/rewind facts are owned by prompts.logic and rewind.logic tests.
- **REWRITE** `moves when what the panel shows moves: the turn settling, a request docking, a rewind` — Keep busy-state projection through rewindBusyOf, the lowest seam called both by the selector and the rewind action; remove identity assertions and all unrelated row/prompt/history fixture setup.

## `packages/ui/src/lib/regexp.test.ts`

**Independent source (bar 1):** literal filesystem/editor search must not interpret user punctuation as regular-expression syntax.
**Seam and non-test callers (bar 4):** file/editor search callers use escapeRegExp.
**Failure/oracle (bars 2–3):** incorrect real RegExp matches literal text and excludes wildcard interpretation. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** real RegExp matches literal text and excludes wildcard interpretation is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `escapes every metacharacter so the escaped form matches the literal` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/saved-prompts/app-wiring.test.ts`

**Independent source (bar 1):** SavedPromptEventType and SAVED_PROMPTS_CHANNEL protocol.
**Seam and non-test callers (bar 4):** useAppStore.applyEvent called by stream subscriber.
**Failure/oracle (bars 2–3):** incorrect saved prompt IDs added/deleted only on the owning channel. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** saved prompt IDs added/deleted only on the owning channel is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `an upsert and a delete on the saved-prompts channel reach the store` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `the same message on another channel does not` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/saved-prompts/list.logic.test.ts`

**Independent source (bar 1):** SavedPrompt scope/pinned contract and searchable user-entered title/description/tags/body; stale cached-title regression.
**Seam and non-test callers (bar 4):** SavedPromptsPanel calls project and search grouping functions.
**Failure/oracle (bars 2–3):** incorrect visible prompt identities, own/global isolation, text matching and favorite partition. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** visible prompt identities, own/global isolation, text matching and favorite partition is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `the project can use every global prompt and its own, never another project's` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `All is global + this project's; Project is this project's only` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `folds the letters no decomposition takes apart: ł, ø, ß and their capitals` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `matches title, description, tags and body, case- and accent-insensitively` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `every word must match, each anywhere` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an edited record is searched by its new text` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `favorites are separated from unpinned prompts` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/saved-prompts/store.test.ts`

**Independent source (bar 1):** saved-prompts API shared live library, sparse PUT, upsert/delete events and project scope; AGENTS validate/reset client data.
**Seam and non-test callers (bar 4):** SavedPromptsPanel/editor and app event/reconnect/connection lifecycle.
**Failure/oracle (bars 2–3):** incorrect actual stored prompt records, request scopes, no stale overwrite/resurrection or cross-daemon leakage. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** actual stored prompt records, request scopes, no stale overwrite/resurrection or cross-daemon leakage is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `repairs optional fields and refuses what cannot be trusted` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `shares concurrent loads and refreshes only when stale or forced` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `no project loads the global list alone` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a reload replaces exactly its scope: what the daemon dropped goes, another project's stays` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an event that overtakes the load answer it is newer than survives the answer` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an answer never brings back a prompt deleted meanwhile, nor overwrites a newer copy` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an id nothing touched during the load takes the answer as-is, even stamped older` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a first load that fails is an error; a failed refresh keeps the rows beside the error` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a forced load asked while one is in flight asks again after it — once, for every such call` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a project list the daemon refuses (400) falls back to the global list, and says why` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `any other failure of a project list does not fall back` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an answer of the wrong shape is a load error, not a crash` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a malformed row is dropped, the rest of the answer kept` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `stale marks a reconnect: the rows stay and the next load refreshes in the background` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a load that crosses a reconnect asks once more, then is fresh` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a failed load that crossed a reconnect retries once, not forever` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an older record never replaces a newer one; a later use does` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a delete removes, and nothing brings the id back` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `malformed payloads and unknown types are ignored without a throw` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an update applies its answer; a delete removes and tombstones` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a failed change becomes the notice and reloads every loaded scope` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a quiet failure leaves the notice to the caller` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a pin shows at once, then carries the daemon's record` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a refused pin falls back to the held value, with the notice` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `two quick flips: only the latest answer clears the flip` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a use bumps the record; a failed bump is silent and reloads nothing` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `forgets everything, and an answer from before it is dropped` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a reset before the request left sends nothing` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a client of another connection starts over` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a mutation answered after a reset is not applied` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/saved-prompts/variables.test.ts`

**Independent source (bar 1):** PromptVariableSpec chat sources and ProviderModel display identity; no target means no chat context.
**Seam and non-test callers (bar 4):** SavedPromptsPanel captures target and calls resolver/label functions.
**Failure/oracle (bars 2–3):** incorrect rendered agent/model data with no-target empty values and catalogue fallback. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** rendered agent/model data with no-target empty values and catalogue fallback is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `renders both as empty without a target chat` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `labels an agent by its registry name and a model by its catalogue name, else the raw id` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/session-kind.test.ts`

**Independent source (bar 1):** SessionSummary kinds, agent adapter capabilities, AgentConversationSummary ownership; preserve manual titles.
**Seam and non-test callers (bar 4):** ProjectOverview/NewTabMenu/app session handling use predicates.
**Failure/oracle (bars 2–3):** incorrect launchable conversation IDs and manual-title preservation. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** launchable conversation IDs and manual-title preservation is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `the three session kinds are classified without overlap` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `ProjectOverview offers a row only while its agent is installed` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `NewTabMenu lists a row under the agent that wrote it` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **REWRITE** `a conversation whose agent has no adapter is not offered` — Exercise isResumableByInstalledAgent with the unsupported agent explicitly installed, so a refusal can only mean missing chat capability. The public resume capability contract, fixed registry fixture, caller-visible false result, and ProjectOverview seam survive helper renames; make isChatResumableConversation private. Other cases cover missing installation and wrong provider independently.
- **KEEP** `only a title nobody chose may be overwritten by the seed` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/thread-visits.test.ts`

**Independent source (bar 1):** completion read-marker regression and AGENTS stored state validation; GUI unread attention semantics.
**Seam and non-test callers (bar 4):** ChatView and tab context menu mark completions read/unread.
**Failure/oracle (bars 2–3):** incorrect timestamp/data monotonicity, thread isolation and unread decisions. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** timestamp/data monotonicity, thread isolation and unread decisions is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **REWRITE** `a junk blob loads as empty and bad entries are dropped` — Feed stored JSON into loadThreadVisits, the app store production entry point, and privatize sanitizeThreadVisits. AGENTS requires validating persisted data; literal valid/invalid timestamps independently expose unread-marker corruption; no other load case owns malformed storage and internal parser refactors now survive.
- **KEEP** `reading a thread stamps the TURN'S COMPLETION, never the clock` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a thread whose latest turn never completed has nothing to read` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `visits are monotonic: an older stamp never moves the mark back` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `mark-unread makes the completed turn unread without changing another thread` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `mark-unread is a no-op without a completed turn, and is idempotent` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a never-visited thread is not unread, and a running turn is never unread` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `an unreadable visit stamp reads as unread rather than silently read` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## `packages/ui/src/lib/transporters/http-transporter-stream.test.ts`

**Independent source (bar 1):** StreamHandlers data/error/end public transporter protocol and HTTP success/error semantics.
**Seam and non-test callers (bar 4):** HttpTransporter used by ApiClient stream consumers in web client.
**Failure/oracle (bars 2–3):** incorrect real Response error JSON withheld from data; success bytes and end delivered. Each retained named scenario below fixes the input and observes the resulting data/state described by its name.
**Refactor/ownership (bars 5–6):** real Response error JSON withheld from data; success bytes and end delivered is observed at its owning UI boundary; no source grep, private collaborator inventory, layout or markup snapshot. API/daemon tests validate their own wire/storage rules but cannot detect incorrect UI translation here.
**Remaining coverage:** retained sibling cases own the other distinct outcomes; deletion reasons identify a stronger case where one exists. **Risk:** low test cleanup; no runtime semantics altered. **Validation:** scoped command above for this path.

- **KEEP** `a non-2xx answer is one error and one end — its JSON body is never stream data` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.
- **KEEP** `a 2xx body streams, then ends once` — Distinct caller-visible scenario at the stated seam; the named expected IDs/data/state are fixed independently of its implementation. All six bars above apply.

## Dead support removed

- Delete unused `mergeComposerDeliveries`; only its deleted test called it.
- Privatize `isChatResumableConversation`, `sanitizeThreadVisits`, `sanitizeChatPrefs`, `sanitizeStoredAppConfig`, `parseRightRailState`, `serializeRightRailState`, `loadRightRailState`, `saveRightRailState`, `parseAgentProfilePrefs`, and `serializeAgentProfilePrefs` after exercising contracts through real production entry points.
- App-config check scenarios are rewritten through `createLocalStorageAppConfigAdapter().load()`: retained field-wise validation and legacy migration behavior now observes the web client's actual adapter boundary. Authored JSON and fixed output fields remain independent; no reset/export hook is added.

- Delete `KindTabs.test.ts`; make `kindTabKeyTarget` private (only its component calls it).
- Make `frontmatterDraft`, `splitCommandLine`, `secretDrafts`, `validateSecretRows`, and `advancedDraft` private after moving valuable request contracts through production form/draft functions.
- Make `normalizeGithubRepo`, `sanitizeProfileItem`, `latestSettledCompactionAt`, and `matchesProfileQuery` private; their contracts are exercised through their actual production entry points.
- Internalize the six now-unreferenced rewind copy constants (`PROMPT_GONE`, `TURN_TOO_FAR_BACK`, `TURN_LOAD_FAILED`, `REWIND_NOT_OFFERED`, `REWIND_WITHHELD`, `REWIND_NOT_RENDERED`); they carry no public API/wire contract.
- Migrate the compaction fixture to production `deriveTimelineRowsWithState(...).rows` so scope 3 can delete the test-only rows wrapper.
- Remove now-unused test imports, duplicate fixture helpers and fake clipboard copy simulation.
- No scope-owned external fixture or snapshot files exist; shared agent-chat builders still have production-contract tests using them.

## Validation and completion

**Completed locally; ready for root integration.** All 306 original declarations reconcile exactly once to this ledger by file/name. The final scope has 291 named tests and four retained check scripts. Test/support edits are net **−186 lines**; including production visibility/dead-code cleanup, the scoped diff is **−205 lines** across 37 files (23 test/check files and 14 production files). The ledger itself is excluded from those counts.

- Baseline execution was started before pruning but interrupted by the agent/session crash. Its partial output is not claimed as a passing baseline; no retained baseline failure was observed. Root instructed the resumed agent not to rerun baseline.
- First complete scoped run: **292/292 tests passed**, plus `session-owner.check.ts`, `system-format.check.ts`, `usage-format.check.ts`, and `app-config.check.ts`. This precedes deletion of the final dead composer-merge case.
- Subsequent focused validation after late edits: **80/80**, **42/42**, **45/45**, and finally **75/75** tests passed, with no skips/failures. Each late-edited case is included in those runs. The last 75 cover rail state, profile storage, chat preferences, thread visits, composer inbox, session classification and rewind busy-state projection. The rewritten `app-config.check.ts` also passed after sanitizer privatization.
- `pnpm --filter @orquester/ui typecheck`: **passed** after fixing the restored default-agent type import and narrowed thread fixture cast.
- Final scoped diff inspected; `git diff --check`: **passed**. No product behavior change, replacement restatement tests, new production test hooks, external messages, commits, or pushes were introduced by this scope agent.
- No incoming remote changes were assigned to scope 6. Root owns remote integration, full repository gates, commit and push; there is no local blocker. No scope-owned E2E case exists, so no new E2E artifact is claimed.
