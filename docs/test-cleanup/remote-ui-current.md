# Incoming UI test audit

Status: completed incoming cleanup. Dispositions were recorded before source edits and applied after root started the merge. Audited `HEAD...origin/main` at remote **8d216c11**, whose UI feature commit is **0aac87f3**. Incoming behavior is preserved while test-only support is removed; root owns final merge staging, gates and commit. Incoming named dispositions: **14 DELETE, 19 REWRITE, 37 KEEP** (some REWRITE outcomes consolidate into one existing lifecycle case).

Scope: every named case in incoming `list.logic.test.ts` (31) and `store.test.ts` (39), plus every assertion in the incoming modified render check. Unchanged cases retain their already recorded audit in [ui-other.md](ui-other.md); explicit incoming rows below prevent the remote merge from resurrecting rejected coverage.

Independent contract: `git show 0aac87f3 --format=fuller` declares one kind at a time, per-agent persisted selection, global search across kinds, unknown-version kind reachability, active-kind-first Add, saved-item reveal, and wrapping arrow/Home/End navigation while Escape remains the dock's. These are caller-visible requirements independent of the tested implementation. `packages/api/src/agent-profile.ts` and the profile design specify stable item IDs/kinds; AGENTS.md requires field-wise browser validation and preservation of unknown persisted fields. Layout, icon and wording declarations do not create a visual-regression requirement.

## Isolated failure model and six bars

**Tab/data owner** can hide valid records from another daemon version, select a kind with no reachable tab, search only the active kind, navigate to the wrong saved-item kind, lose available create actions or present the wrong empty-state action. **Storage owner** can forget per-agent selection, accept malformed/unsupported tabs, erase another app version's data, or lose memory updates when storage is unavailable. **Keyboard owner** can fail to wrap, select the wrong Home/End tab, or consume Escape/vertical/unrelated keys that belong elsewhere. Retained cases below fail for those concrete causes.

For every KEEP/REWRITE row, the following full bar applies together with its per-case literal outcome/reason:

1. The independent incoming feature/API/storage contract above specifies the named behavior.
2. The listed failure affects the visible tab/items/action or remembered preference; keyboard regressions affect focus selection and dock dismissal.
3. Literal IDs, tab indices, storage objects, error discriminants and fixed fixtures supply expected outcomes; no production constant or implementation-derived expected result is used.
4. `profileKindTabs`, `effectiveKindTab`, `filterProfileItems`, `profileItemKindOfId`, `addMenuKinds` and `agentProfileEmptyState` are called by the real `AgentProfilePanel`/`AgentProfilePanelView`. `parseAgentProfilePrefs`/`serializeAgentProfilePrefs` and remembered-tab actions own actual browser preferences; `kindTabKeyTarget` is called by `KindTabs`' real key handler. Existing state cases observe the production Zustand store/API actions.
5. Semantic data, state and key destinations survive component/algorithm/identifier refactors; private collection shape, string formatting, HTML order and CSS are excluded. The existing live key-target helper is a pure declared navigation seam, not a test-created wrapper.
6. The real lowest owner is retained once: API catalog tests own capability inventories; tab derivation owns reachability; the filter owns search activation; the prefs parser/serializer own persistence compatibility; state actions own browser cache lifecycle; keyboard target conversion owns key destinations. No retained render check duplicates those results.

Risk: medium merge risk because both branches edit panel props/list semantics and the preference cache; production behavior must keep incoming tabs/search/persistence while removing the old width injection and storage override. Root-required typecheck/build will cover both shared UI entry points. Focused validation after merge: named list/store/keyboard tests plus `pnpm --filter @orquester/ui typecheck`; root runs repository gates. No source changes were made during the pre-merge audit; implementation began only after the merge signal.

## `packages/ui/src/components/right-rail/agent-profile/list.logic.test.ts`

| Disposition | Incoming case (remote line) | Exact failure / decision |
|---|---|---|
| DELETE | L72 the agent's own kinds in AGENT_PROFILE_KINDS order, each counted — zero included, no All | Static capability/label inventory fails B5/B6. The retained unexpected-kind/count case exercises real tab derivation; remembered-tab and global-search cases protect selection. Type contracts define valid kind IDs. |
| DELETE | L86 only the kinds that agent has: OpenCode has no marketplaces or hooks | Pure capability inventory duplicates API profile kinds. Its former real fallback behavior moved to the incoming remembered-tab scenario, which is the stronger owner. |
| REWRITE | L93 a kind the agent should not have (another daemon version) gets a tab while it has items, after the rest | Keep nonempty known/unknown kind IDs and their fixture counts, so records from another daemon version remain reachable. Drop exhaustive empty-capability inventory; semantic compatibility output remains the oracle. |
| KEEP | L106 shows the remembered tab when it is one of the agent's, else the agent's first | Missing/invalid/unsupported persisted picks must recover to MCP; valid skill/command picks and an unexpected kind with records must stay selectable. Literal expected kinds detect stranded panels independently of matching implementation. |
| KEEP | L121 reads a saved item's kind off its id | The profile API specifies stable kind-prefixed item IDs, including hook event/hash and plugin marketplace syntax. Wrong parsing reveals the wrong tab after save; malformed/unknown IDs must yield no kind. |
| KEEP | L128 + Add lists the shown tab's kind first, and still every creatable kind | Feature commit explicitly requires the active creatable kind first without losing other actions; an uncreatable active kind must not invent an action. Fixed literal kind arrays detect omitted/misdirected creation. |
| REWRITE | L150 shows the tab's kind; a search looks across every kind, whatever the tab | Keep returned IDs for tab-only browsing, whitespace clearing, cross-kind search and no matches. Drop direct isProfileSearchActive assertions: the production filter result is the stronger behavior owner. |
| REWRITE | L164 groups in the agent's kind order, each sorted by name, empty kinds left out | Remove exact section labels; retain item grouping/order data from the panel requirement. |
| KEEP | L213 no matches while searching, else the empty tab's own state | Search no-match and empty-kind states select different user actions. Literal discriminants/kind/query protect empty tabs, including an empty profile; no generated wording is asserted. |
| DELETE | L223 titles an empty kind in words | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | L243 words the facts, and never shows Claude's off-switch caveat as a fact | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | L249 drops what the description already says, and bare flags | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | L265 a hook's second line reads alike for every agent: event, matcher, then the rest | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | L295 a hook's name shows the ends of its absolute paths | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | L305 plugins and marketplaces: a version, where from, how many installed | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | L323 an unknown key from another daemon version still shows, after the known ones | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| REWRITE | L329 its tooltip carries the adapter's off-switch caveat while on | Check the daemon-provided caveat survives only while disabling is available; wording outside that warning is not a contract (profile spec §4.6). |
| DELETE | L339 says what pressing it does | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | L344 explains why it is disabled | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | L388 names the file, its lines and when it was edited | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | L402 says a missing file is not created yet | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| REWRITE | L413 lists the four agents, installed as the snapshot, else the overview, says | Remove exact agent labels; retain fresh snapshot precedence and unknown installation state. |
| DELETE | L433 collapses the picker to a dropdown below the segmented control's width | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |

## `packages/ui/src/lib/agent-profile/store.test.ts`

| Disposition | Incoming case (remote line) | Exact failure / decision |
|---|---|---|
| REWRITE | L231 repairs the source, the warnings and the meta | Retain tolerant source/warning/meta validation and externally supplied labels; remove the generated fallback label wording assertion. B1 payload validation, B2 invalid metadata reaching the UI, B3 malformed fixed fixtures, B4 real sanitizer, B5 semantic data only, B6 client boundary ownership. |
| REWRITE | L304 is single-flight: concurrent callers share one request | Delete promise-identity constraints; retain request coalescing observed at public daemon API. |
| REWRITE | L316 a forced load during one in flight asks once more after it — shared by every forced caller | Delete promise-identity constraints; retain request coalescing observed at public daemon API. |
| REWRITE | L346 keeps the daemon's code (a not-installed agent) and names a route this daemon lacks | Keep the daemon AGENT_NOT_INSTALLED code used by the panel; remove generated unsupported-route sentence matching. B1 daemon refusal protocol, B2 picker incorrectly treats an absent agent as actionable, B3 literal error code, B4 real store load, B5 semantic code independent of copy, B6 only store owns refusal preservation. |
| REWRITE | L477 replaces the snapshot with the answer's and says so, the change carrying the item's revision | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | L498 the daemon's notes become the notice | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | L509 a 409 PROFILE_CONFLICT refetches the agent and says it changed on disk | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | L520 another refusal becomes the notice in the daemon's words | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | L531 AGENT_NOT_INSTALLED refetches the agent and the overview (the picker learns it) | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | L543 a copy lands the TARGET's snapshot on the target | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| KEEP | L656 keeps a tab only for a known agent that has that kind | Device storage must be validated field-wise against known agents/kinds: valid neighboring tabs survive bad type, unsupported kind and unknown-agent data. Literal prefs object is independent; this is the lowest storage parse owner. |
| REWRITE | L673 serializes over what another bundle stored, keeping its fields and tabs | Keep JSON data preservation for unknown top-level fields and other-agent tabs while changing the selected agent/tab. Parse output before comparison: JSON property order is not a storage contract. Corrupt previous tabs are repaired without removing unrelated data. |
| REWRITE | L692 reads the stored pick once, remembers a new one, and survives a store reset | Use real global localStorage with descriptor restoration; include initial stored valid/unsupported tabs, subsequent picks, tab updates and reset persistence in one browser-cache lifecycle. No write counts or cache-reset injection. |
| REWRITE | L709 remembers the tab per agent, next to the pick, and refuses a kind the agent lacks | Consolidate real per-agent mutation, rejected unsupported kind, other-version tab preservation and reset survival into the bootstrap persistence case. This removes duplicate lifecycle setup and the private storage/cache override; all independent outcomes remain protected. |
| REWRITE | L745 a storage that throws leaves the pick and the tabs in memory | Install a throwing browser localStorage getter, perform actual remembered-agent and tab actions, and observe both through production selectors. Remove injected storage/cache reset and assumptions about previous process cache state. |

## `packages/ui/src/components/right-rail/agent-profile/agent-profile-render.check.ts`

DELETE the static render suite and all its fixtures/harnesses. Its DOM/class/style/geometry/copy inventories fail B4/B5; assertions for tabs, filtering, empty state and counts additionally duplicate retained pure owners (B6). Negative secret assertions still arrange no secret. Repeated callbacks are NOOPs, so the suite does not prove tab click behavior. Preserve only the new independently specified keyboard destination assertions as one minimal named test (`KindTabs.test.ts`), without DOM identifiers/icons/markup or copied arithmetic. This is a REWRITE of an existing contract trapped in a bad suite, not added coverage of implementation.

Every original incoming assertion is listed below, including unchanged assertions previously rejected in ui-other.md. The six navigation statements are REWRITE; all others are DELETE for the suite reasons above:

- DELETE L249: `assert.ok(start >= 0, ˋrow ${id} is listedˋ);`.
- DELETE L262: `assert.ok(html.startsWith('<div data-agent-profile-panel="" class="flex min-h-0 flex-1 flex-col">'), "the dock's panel contract");`.
- DELETE L263: `assert.ok(/class="min-h-0 flex-1 space-y-1\.5 overflow-y-auto px-3 pb-3/.test(html), "the list scrolls itself, px-3");`.
- DELETE L266: `assert.ok(html.includes('data-agent-picker="segmented"'), "a 400 px panel shows the segmented picker");`.
- DELETE L268: `assert.equal((segments.match(/<button/g) ?? []).length, 4, "four agents");`.
- DELETE L269: `assert.ok(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?Claude<\/button>/.test(segments), "Claude is the pressed one");`.
- DELETE L270: `assert.ok(/<button[^>]*disabled=""[^>]*title="Grok is not installed"/.test(segments), "Grok, not installed, is disabled and says so");`.
- DELETE L271: `assert.ok(segments.includes(">OpenCode</button>"), "OpenCode by its whole name");`.
- DELETE L273: `assert.equal((segments.match(/<span aria-hidden="true" class="flex h-3\.5 w-3\.5/g) ?? []).length, 4, "an icon per agent");`.
- DELETE L276: `assert.ok(html.includes('data-profile-instructions=""'), "the instructions card");`.
- DELETE L277: `assert.ok(html.includes("CLAUDE.md") && html.includes("42 lines · edited 2h ago"), "file, lines, edited ago");`.
- DELETE L282: `assert.ok(cardAt > 0 && cardAt < searchAt && searchAt < tablistAt && tablistAt < listAt, "card, search, tabs, then the list");`.
- DELETE L286: `assert.ok(/<div role="tablist" aria-label="Kinds" aria-orientation="horizontal"/.test(tablist), "a named tablist");`.
- DELETE L287: `assert.ok(/class="flex flex-wrap transition-opacity gap-1(\.5)?[ "]/.test(tablist), "it wraps onto more lines");`.
- DELETE L288: `assert.ok(!/overflow-x-auto|flex-nowrap|mask-image/.test(html), "no scroll row, no edge fades");`.
- DELETE L290: `assert.deepEqual([...tabs.keys()], ["mcp", "skill", "plugin", "marketplace", "hook", "command"], "the agent's kinds, in order");`.
- DELETE L291: `assert.ok(!/>All</.test(tablist), "no All tab");`.
- DELETE L293: `assert.ok(/role="tab"/.test(tab) && /\bwhitespace-nowrap\b/.test(tab) && !/\btruncate\b/.test(tab), ˋ${kind}: a whole tabˋ);`.
- DELETE L294: `assert.ok(/<svg[^>]*class="lucide lucide-[\w-]+ shrink-0/.test(tab), ˋ${kind}: its iconˋ);`.
- DELETE L295: `assert.ok(/data-kind-count=""[^>]*class="[^"]*rounded-full/.test(tab), ˋ${kind}: its count as a badgeˋ);`.
- DELETE L298: `assert.ok(tabs.get(kind)!.includes(ˋlucide-${icon} ˋ), ˋ${kind}: the ${icon} iconˋ);`.
- DELETE L303: `assert.ok(/aria-selected="true"/.test(mcp) && /tabindex="0"/.test(mcp), "MCP, the agent's first kind, is the tab shown");`.
- DELETE L304: `assert.ok(/\bbg-neutral-100 text-neutral-900\b/.test(mcp), "filled");`.
- DELETE L305: `assert.ok(mcp.includes(ˋid="${labelledBy}"ˋ), "and it labels the list");`.
- DELETE L307: `assert.ok(panelId.length > 0 && mcp.includes(ˋaria-controls="${panelId}"ˋ), "which it controls");`.
- DELETE L310: `assert.ok(/aria-selected="false"/.test(tab) && /tabindex="-1"/.test(tab), ˋ${kind}: not selected, no tab stopˋ);`.
- DELETE L311: `assert.ok(!/bg-neutral-100 text-neutral-900/.test(tab) && /\bborder\b/.test(tab), ˋ${kind}: an outlined pillˋ);`.
- DELETE L312: `assert.ok(/hover:border-neutral-700/.test(tab), ˋ${kind}: with a hoverˋ);`.
- DELETE L313: `assert.ok(/focus-visible:ring-2/.test(tab), ˋ${kind}: and a focus ringˋ);`.
- DELETE L315: `assert.ok(/MCP<span data-kind-count=""[^>]*bg-neutral-900 text-neutral-100[^>]*><span class="sr-only">, <\/span>2</.test(mcp), "MCP 2, the badge contrasting");`.
- DELETE L316: `assert.ok(/Hooks<span data-kind-count=""[^>]*bg-neutral-800 text-neutral-400[^>]*><span class="sr-only">, <\/span>3</.test(tabs.get("hook")!), "Hooks 3, muted");`.
- DELETE L319: `assert.ok(/Marketplaces<span[^>]*text-neutral-600[^>]*><span class="sr-only">, <\/span>0</.test(marketplace), "Marketplaces 0");`.
- DELETE L320: `assert.ok(/text-neutral-500 hover:/.test(marketplace) && /lucide-store shrink-0 text-neutral-600/.test(marketplace), "reads muted");`.
- DELETE L321: `assert.ok(/\bh-8\b/.test(mcp), "a comfortable 32 px in the dock");`.
- DELETE L324: `assert.ok(html.includes(ˋdata-profile-item="${USER.id}"ˋ) && html.includes(ˋdata-profile-item="${OFF.id}"ˋ), "MCP's rows");`.
- DELETE L325: `for (const other of [STASHED, LOCKED, INHERITED, CACHE]) assert.ok(!html.includes(ˋdata-profile-item="${other.id}"ˋ), ˋnot ${other.id}ˋ);`.
- DELETE L326: `assert.ok(!/uppercase tracking-wider[^>]*>MCP servers/.test(html), "the tab names the list: no section label");`.
- DELETE L327: `assert.ok(!html.includes("Searching all kinds") && !html.includes("data-searching"), "not searching");`.
- DELETE L335: `assert.ok(user.includes('title="jira-cloud"') && /\btruncate\b/.test(user), "the name truncates with its tooltip");`.
- DELETE L336: `assert.ok(user.includes("stdio · Jira issues, sprints and boards") && user.includes("line-clamp-1"), "one clamped line");`.
- DELETE L337: `assert.ok(!user.includes("rounded-md border border-neutral-700/80 px-1.5"), "no badge for the user's own");`.
- DELETE L338: `assert.ok(/role="switch" aria-checked="true" aria-label="Turn off jira-cloud"/.test(user), "the switch says what it does");`.
- DELETE L339: `assert.ok(!/disabled=""/.test(switchOf(user)), "and works");`.
- DELETE L340: `assert.ok(user.includes("More actions for jira-cloud"), "its menu");`.
- DELETE L344: `assert.ok(/opacity-55/.test(off) && off.includes("(off)"), "an off row is dimmed and says so");`.
- DELETE L345: `assert.ok(/aria-checked="false" aria-label="Turn on serena"/.test(off));`.
- DELETE L346: `assert.ok(switchOf(rowOf(rows, STASHED.id)).includes("set aside by Orquester"), "a stashed row's switch says where it went");`.
- DELETE L350: `assert.ok(locked.includes("(locked)") && locked.includes('title="Locked — Orquester manages this"'), "a lock with its reason");`.
- DELETE L351: `assert.ok(/disabled=""/.test(switchOf(locked)), "the switch is disabled");`.
- DELETE L352: `assert.ok(/<span class="inline-flex shrink-0" title="Locked — Orquester manages this">/.test(locked), "its tooltip on the wrapper");`.
- DELETE L353: `assert.ok(locked.includes(">Orquester</span>"), "its source badge");`.
- DELETE L354: `assert.ok(locked.includes("More actions for agent-hook.sh"), "a path to copy still gives it a menu");`.
- DELETE L358: `assert.ok(inherited.includes(">From Claude</span>"), "the source badge");`.
- DELETE L359: `assert.ok(inherited.includes('title="Manage in Claude"') && /disabled=""/.test(switchOf(inherited)));`.
- DELETE L360: `assert.ok(/<button[^>]*>Manage in Claude<svg/.test(inherited), "a Manage in Claude button");`.
- DELETE L364: `assert.ok(plugin.includes('title="Managed by plugin superpowers"'));`.
- DELETE L365: `assert.ok(!plugin.includes("More actions") && /<span aria-hidden="true" class="shrink-0 w-7"><\/span>/.test(plugin), "the menu's place held");`.
- DELETE L366: `assert.ok(/shrink-\[100\]/.test(plugin), "the badge shrinks first");`.
- DELETE L370: `assert.ok(untrusted.includes("Not trusted by Codex") && /text-warn/.test(untrusted), "an amber warning chip");`.
- DELETE L371: `assert.ok(/<button[^>]*title="Trust lint-on-edit as it is now"[^>]*>[\s\S]*?Trust<\/button>/.test(untrusted), "with Trust");`.
- DELETE L373: `assert.ok(cache.includes("Plugin cache missing") && !cache.includes(">Trust<"), "a warning without an action has no button");`.
- DELETE L376: `assert.ok(/<button type="button" class="app-no-drag flex w-full rounded-md/.test(html), "a full-width + Add trigger");`.
- DELETE L377: `assert.ok(html.includes("to Claude&#x27;s profile") && html.includes("Changes apply to new sessions"), "Add, and the hint");`.
- DELETE L378: `assert.ok(html.includes('<div role="status" class="sr-only"></div>') && html.includes('<div role="alert" class="sr-only"></div>'), "live regions, always mounted");`.
- DELETE L387: `assert.ok(narrow.includes('data-agent-picker="dropdown"') && !narrow.includes('data-agent-picker="segmented"'), "280 px: one dropdown");`.
- DELETE L388: `assert.ok(/<span class="sr-only">Agent: <\/span><span class="min-w-0 flex-1 truncate">Claude<\/span>/.test(narrow), "naming the agent");`.
- DELETE L390: `assert.ok(opencode.includes("OpenCode servers restart when idle"), "OpenCode's hint");`.
- DELETE L391: `assert.deepEqual([...tabsOf(opencode).keys()], ["mcp", "skill", "plugin", "command"], "only OpenCode's kinds");`.
- DELETE L404: `assert.ok(/class="flex flex-wrap transition-opacity gap-1(\.5)?[ "]/.test(tablist), ˋ${variant} ${width}: the tabs wrapˋ);`.
- DELETE L405: `assert.ok(!/overflow-x-auto|flex-nowrap|mask-image|\btruncate\b/.test(tablist), ˋ${variant} ${width}: nothing scrolls or clipsˋ);`.
- DELETE L406: `assert.equal(tabsOf(html).size, 6, ˋ${variant} ${width}: all six tabsˋ);`.
- DELETE L408: `assert.ok(/\bshrink-0\b/.test(tab) && /\bwhitespace-nowrap\b/.test(tab), ˋ${variant} ${width}: ${kind} keeps its sizeˋ);`.
- DELETE L409: `assert.ok(new RegExp(ˋ\\b${variant === "sheet" ? "h-10" : "h-8"}\\bˋ).test(tab), ˋ${variant} ${width}: ${kind}'s targetˋ);`.
- DELETE L416: `assert.ok(narrow.includes('data-agent-picker="dropdown"') && narrow.indexOf("data-profile-instructions") < narrow.indexOf('role="tablist"'), "260 px: the card still above the tabs");`.
- DELETE L421: `assert.ok(/data-searching=""[^>]*class="[^"]*opacity-60/.test(tablistOf(searching)), "the tabs are dimmed");`.
- DELETE L422: `assert.ok(/aria-selected="true"/.test(tabs.get("skill")!) && !/bg-neutral-100 text-neutral-900/.test(tablistOf(searching)), "the tab stays selected, unfilled");`.
- DELETE L423: `assert.ok(searching.includes("Searching all kinds — clear the search to return to Skills"), "and a line says the search looks past it");`.
- DELETE L424: `assert.ok(!searching.includes('role="tabpanel"') && searching.includes('aria-label="Search results in Claude&#x27;s profile"'), "the list is the results, not a tab");`.
- DELETE L426: `assert.ok(sections.every((at, index) => at > 0 && (index === 0 || at > sections[index - 1]!)), "matches of every kind, in kind order");`.
- DELETE L427: `assert.ok(/uppercase tracking-wider[^>]*>MCP servers<span[^>]*>2<\/span>/.test(searching), "each under its section label, counted");`.
- DELETE L428: `assert.ok(searching.includes("data-profile-instructions"), "the instructions card stays");`.
- DELETE L430: `assert.ok(narrowed.includes(ˋdata-profile-item="${UNTRUSTED.id}"ˋ) && !narrowed.includes(ˋdata-profile-item="${INHERITED.id}"ˋ), "a hook found from the Skills tab");`.
- DELETE L432: `assert.ok(cleared.includes('role="tabpanel"') && !cleared.includes("Searching all kinds"), "a blank search is back on the tab");`.
- DELETE L433: `assert.ok(cleared.includes(ˋdata-profile-item="${INHERITED.id}"ˋ) && !cleared.includes(ˋdata-profile-item="${USER.id}"ˋ), "the Skills tab's rows");`.
- DELETE L437: `assert.ok(/aria-selected="true"[^>]*tabindex="0"[^>]*data-kind-tab="hook"[^>]*bg-neutral-100 text-neutral-900/.test(hooks), "the Hooks tab, remembered, is shown filled");`.
- DELETE L438: `for (const entry of [LOCKED, PLUGIN_HOOK, UNTRUSTED]) assert.ok(hooks.includes(ˋdata-profile-item="${entry.id}"ˋ), ˋ${entry.id} under Hooksˋ);`.
- DELETE L439: `assert.ok(!hooks.includes(ˋdata-profile-item="${USER.id}"ˋ), "not MCP's");`.
- DELETE L441: `assert.ok(/aria-selected="true"[^>]*data-kind-tab="mcp"/.test(opencode), "a kind OpenCode lacks falls back to its first tab");`.
- DELETE L442: `assert.ok(opencode.includes("No MCP servers yet."), "and that tab's empty state");`.
- DELETE L446: `assert.ok(/aria-selected="true"[^>]*data-kind-tab="marketplace"/.test(marketplaces), "the empty tab can be shown");`.
- DELETE L447: `assert.ok(/Marketplaces<span data-kind-count=""[^>]*bg-neutral-900 text-neutral-100[^>]*><span class="sr-only">, <\/span>0</.test(marketplaces), "filled, counting 0");`.
- DELETE L448: `assert.ok(marketplaces.includes("No marketplaces yet.") && /Add marketplace<\/button>/.test(marketplaces), "its own empty state and Add");`.
- DELETE L449: `assert.ok(marketplaces.includes("data-profile-instructions") && tabsOf(marketplaces).size === 6, "the card and every tab stay");`.
- REWRITE L452: `assert.equal(kindTabKeyTarget("ArrowRight", 5, 6), 0);`.
- REWRITE L453: `assert.equal(kindTabKeyTarget("ArrowLeft", 0, 6), 5);`.
- REWRITE L454: `assert.equal(kindTabKeyTarget("ArrowRight", 2, 6), 3);`.
- REWRITE L455: `assert.equal(kindTabKeyTarget("Home", 4, 6), 0);`.
- REWRITE L456: `assert.equal(kindTabKeyTarget("End", 1, 6), 5);`.
- REWRITE L457: `for (const key of ["Escape", "Enter", " ", "ArrowUp", "ArrowDown", "Tab", "a"]) assert.equal(kindTabKeyTarget(key, 2, 6), null, key);`.
- DELETE L466: `assert.ok(loading.includes('aria-label="Loading the profile"') && loading.includes("animate-pulse"), "a loading skeleton");`.
- DELETE L467: `assert.ok(loading.includes('aria-busy="true"'), "the list is busy");`.
- DELETE L468: `assert.ok(!loading.includes('role="tablist"') && !loading.includes("data-profile-instructions"), "no tabs without a snapshot");`.
- DELETE L469: `assert.ok(/<button class="[^"]*\bw-full\b[^"]*" type="button" disabled="">[\s\S]{0,600}?Add<\/button>/.test(loading), "Add waits for the snapshot");`.
- DELETE L472: `assert.ok(notInstalled.includes("Grok is not installed.") && notInstalled.includes("Install it from Settings → Agents."));`.
- DELETE L475: `assert.ok(error.includes("Couldn&#x27;t load Claude&#x27;s profile") && error.includes("The daemon did not answer."));`.
- DELETE L476: `assert.ok(/<button[^>]*>Retry<\/button>/.test(error), "with Retry");`.
- DELETE L479: `assert.ok(emptyKind.includes("No MCP servers yet.") && /Add MCP server<\/button>/.test(emptyKind), "an empty kind offers its Add");`.
- DELETE L480: `assert.ok(emptyKind.includes("data-profile-instructions"), "the instructions card stays on every tab");`.
- DELETE L483: `assert.ok(codexCommands.includes("No commands yet.") && !codexCommands.includes("Add command"), "Codex cannot create commands");`.
- DELETE L486: `assert.ok(none.includes("No MCP servers yet.") && none.includes("data-profile-instructions"), "nothing at all: the first tab's empty state");`.
- DELETE L487: `assert.ok([...tabsOf(none).values()].every((tab) => /<span class="sr-only">, <\/span>0<\/span>/.test(tab)), "every tab counting 0");`.
- DELETE L490: `assert.ok(noMatches.includes("Nothing matches “zzz”"));`.
- DELETE L493: `assert.ok(refreshFailed.includes("The daemon did not answer.") && />Retry<\/button>/.test(refreshFailed) && refreshFailed.includes("data-profile-item"), "a failed refresh keeps the rows, with Retry");`.
- DELETE L514: `assert.ok(partial.includes('data-profile-file-errors=""') && partial.includes("A file could not be read"), "a partial snapshot's banner");`.
- DELETE L515: `assert.ok(partial.includes("/var/lib/orquester/.codex/config.toml") && partial.includes("expected ˋ=ˋ at line 12"), "naming the file and why");`.
- DELETE L516: `assert.ok(/data-profile-instructions[\s\S]*?Shadowed by AGENTS\.override\.md/.test(partial), "the instructions warning as a chip");`.
- DELETE L521: `assert.ok(ok.includes('data-profile-notice="ok"') && ok.includes('<div role="status" class="sr-only">Turned off serena.'), "an ok notice, read out");`.
- DELETE L523: `assert.ok(bad.includes('data-profile-notice="error"') && /text-danger/.test(bad), "a refusal in the danger colour");`.
- DELETE L524: `assert.ok(bad.includes('<div role="alert" class="sr-only">It changed on disk'), "read out as an alert");`.
- DELETE L530: `assert.ok(/aria-busy="true"/.test(row) && /animate-spin/.test(row), "a change in flight shows");`.
- DELETE L531: `assert.ok(/aria-disabled="true"/.test(switchOf(row)) && !/disabled=""/.test(switchOf(row)), "the switch refuses clicks yet keeps focus");`.
- DELETE L532: `assert.ok(/ring-neutral-500\/50/.test(rowOf(busy, OFF.id)), "the saved item is outlined");`.
- DELETE L541: `assert.ok(html.includes('data-agent-picker="segmented"'), "a 360 px phone fits the segments");`.
- DELETE L543: `assert.ok((segments.match(/<button[^>]*class="[^"]*\bh-10\b/g) ?? []).length === 4, "segments 40 px tall");`.
- DELETE L544: `assert.ok([...tabsOf(html).values()].filter((tab) => /class="[^"]*\bh-10\b/.test(tab)).length === 6, "every tab a 40 px target");`.
- DELETE L547: `assert.ok(/\bh-10\b/.test(switchOf(user)) && /\bw-12\b/.test(switchOf(user)), "the switch's target is 40 px");`.
- DELETE L548: `assert.ok(/<span title="More actions" class="[^"]*\bh-10 w-10\b/.test(user), "so is the menu's");`.
- DELETE L549: `assert.ok(/<button[^>]*class="[^"]*\bmin-h-10\b[^"]*"[^>]*>Manage in Claude/.test(rowOf(rows, INHERITED.id)), "and Manage in");`.
- DELETE L551: `assert.ok(/\bh-10\b/.test(trust), "and Trust");`.
- DELETE L552: `assert.ok(/min-h-14/.test(html.match(/data-profile-instructions[^>]*class="[^"]*"/)?.[0] ?? ""), "the instructions card");`.
- DELETE L553: `assert.ok(/inline-flex w-full items-center justify-center gap-2 rounded-md bg-neutral-200 px-3 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 h-10/.test(html), "and + Add");`.
- DELETE L556: `assert.ok(/data-agent-picker="dropdown" class="[^"]*\bh-10\b/.test(narrow), "a narrow sheet's dropdown is 40 px");`.
- DELETE L562: `assert.ok(row.includes('role="group" aria-label="Delete serena"'), "Delete asks on the row");`.
- DELETE L563: `assert.ok(/<button[^>]*>Cancel<\/button>/.test(row) && /bg-danger-600[^>]*>Delete<\/button>/.test(row), "Cancel and a red Delete");`.
- DELETE L564: `assert.ok(!rowOf(deleting, USER.id).includes("aria-label=\"Delete"), "only that row asks");`.
- DELETE L568: `assert.ok(asked.includes("Codex already has <span"), "a copy's collision asks on the row");`.
- DELETE L569: `for (const label of ["Replace", "Keep both", "Cancel"]) assert.ok(asked.includes(ˋ>${label}</button>ˋ), label);`.
- DELETE L608: `assert.ok(mcp.includes("http · https://mcp.context7.com/mcp"), ˋ${variant}: the transport and the target as the second lineˋ);`.
- DELETE L609: `assert.ok(!/<p[^>]*>[^<]*deniedMcpServers/.test(mcp), ˋ${variant}: the off-switch caveat is not a second-line factˋ);`.
- DELETE L610: `assert.ok(`.
- DELETE L618: `assert.ok(hook.includes(">PreToolUse · Bash</p>"), ˋ${variant}: a hook's event and matcher said once, not "command · …" twiceˋ);`.
- DELETE L622: `assert.ok(copyPath.includes("Copy path"), ˋ${variant}: an open-file warning offers the file's pathˋ);`.
- DELETE L623: `assert.ok(variant === "docked" ? /\bh-6\b/.test(copyPath) : /\bh-10\b/.test(copyPath), ˋ${variant}: sized for the variantˋ);`.
- DELETE L624: `assert.ok(!rowOf(html, noPath.id).includes("Copy path"), ˋ${variant}: no path, no buttonˋ);`.
- DELETE L647: `assert.match(button, /focus-visible:ring/, ˋa focus ring on ${button}ˋ);`.
- DELETE L679: `assert.ok(html.startsWith('<div data-profile-item="mcp:jira-cloud"'), "keyed by its id");`.
- DELETE L680: `assert.ok(/<button type="button" class="app-no-drag inline-flex shrink-0 rounded-md/.test(html), "the menu trigger is a fixed-size button");`.
- DELETE L688: `assert.ok(!noActions.includes("More actions"), "nothing to offer, no menu");`.
- DELETE L718: `assert.deepEqual([...tabsOf(narrow).keys()], ["mcp", "skill", "plugin", "command", "hook"], "a hook OpenCode should not have gets a tab after its kinds");`.
- DELETE L720: `assert.ok(narrow.includes('placeholder="Search profile…"'), "a search placeholder the 260 px dock holds");`.
- DELETE L721: `assert.ok(narrow.includes('aria-label="Search OpenCode&#x27;s profile"'), "its name still says whose");`.
- DELETE L724: `assert.ok(hint.length > 0 && !/\btruncate\b/.test(hint) && /text-balance/.test(hint), "OpenCode's hint wraps, never clips");`.
- DELETE L727: `assert.ok(!card.includes("h-8 w-8 shrink-0 items-center justify-center rounded-lg"), "a narrow panel's card drops the file icon");`.
- DELETE L728: `assert.ok(/\bw-6\b/.test(card), "and narrows its chevron");`.
- DELETE L731: `assert.ok(wideCard.includes("h-8 w-8 shrink-0 items-center justify-center rounded-lg"), "a wide one keeps it");`.
- DELETE L736: `assert.ok(chip.length > 0 && /break-words/.test(chip) && !/\btruncate\b/.test(chip), "a warning chip wraps");`.
- DELETE L742: `assert.ok(hook.includes(ˋtitle="${orquesterHook.name.replace(/'/g, "&#x27;")}"ˋ), "the whole command in the tooltip");`.
- DELETE L743: `assert.ok(hook.includes(">&#x27;…/agent-hook.sh&#x27; grok Stop</span>"), "the part that tells hooks apart");`.
- DELETE L744: `assert.ok(hook.includes(">Stop · timeout 10 s · orquester.json</p>"), "event first");`.
- DELETE L747: `assert.ok(/<div class="flex min-w-0 items-center gap-1\.5 overflow-hidden">/.test(hook), "the name line clips its badge");`.
- DELETE L751: `assert.ok(/<div class="flex flex-wrap items-center gap-1\.5 px-3 -mt-2 pb-1">/.test(rowOf(sheet, inherited.id)), "no gap under the row");`.

## Merge/support actions

- Keep the incoming `KindTabs`, panel integration, search semantics and per-agent prefs cache. `KindChips` remains removed by the feature.
- Keep deleted `agent-profile-render.check.ts` absent after merge; no resurrection of its row fixtures, HTML regex helpers or width override.
- Remove the original render-only `data-agent-profile-panel`, `data-agent-picker` and `data-profile-instructions` markers too; the deleted check is their only reader. These selectors have no style/behavior consumers.
- Remove render-only `data-kind-tabs`, `data-searching`, `data-kind-count` and `data-kind-tabs-searching` markers; repository-wide searches find no production readers. Keep `data-kind-tab`, which the real keyboard handler reads.
- Remove new `PROFILE_KIND_ICONS` and `KindTabsProps` exports if their only references remain inside `KindTabs`; preserve production-used `kindTabId` and live keyboard seam.
- Keep storage override, `__setAgentProfileStorageForTests`, private getter export, dead sanitizer re-exports, private constants/types and renderer injection props removed. Existing parser/serializer APIs remain the stable storage contract seams.
- Preserve earlier list-test deletion/rewrite decisions; incoming capability arrays and exact wording do not undo them.
- Consolidate cache-bootstrap/persistence assertions through browser localStorage instead of introducing another reset hook.

## Validation

- Focused merged tests passed: **60 tests**, 12 suites, 0 failures/skips. Covers all 17 list cases, 38 profile-store cases, the extracted keyboard case, two real app-event dispatch cases and two editor-save publication cases.
- Command from `packages/ui`: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=4 src/components/right-rail/agent-profile/list.logic.test.ts src/components/right-rail/agent-profile/KindTabs.test.ts src/lib/agent-profile/store.test.ts src/lib/agent-profile/app-wiring.test.ts src/components/right-rail/agent-profile/editor/saved.test.ts`.
- `pnpm --filter @orquester/ui typecheck` passed.
- Reviewed the auto-merged `AgentProfilePanelView`: tabs/ARIA/search changes and production measured-width defaults were all correct. Removed only the dead render selector afterward.
- Relative to incoming remote versions, audited test files plus extracted keyboard coverage have **992 fewer lines**.
- All five merge-conflict file contents resolved; no old chip APIs, storage override or conflict markers remain in this scope. The deleted render check stays absent.
- `git diff --check -- packages/ui docs/test-cleanup/remote-ui-current.md` passed. Root owns final shared gates, staging and merge commit.
