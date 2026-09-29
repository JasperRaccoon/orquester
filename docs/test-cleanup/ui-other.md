# UI other test cleanup

Status: completed cleanup. Dispositions were recorded before edits; implementation and focused validation are recorded below. Scope: every original UI test/check outside lib/components agent-chat and workflows. 45 files; 322 named declarations (one parameterized declaration covers signOut/selectConnection) and 6 check scripts. Named dispositions: **24 DELETE, 24 REWRITE, 274 KEEP**. Check scripts: **2 DELETE, 1 REWRITE, 3 KEEP**. Final named execution expands to 298 passing cases.

Independent sources: AGENTS.md payload validation, persisted compatibility and security rules; README product workflows; `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` (§5.2 migration, §6 launch, §7 composer/history/attention); `docs/superpowers/specs/2026-09-28-agent-profile-design.md` (§3 ownership, §4.3 revisions, §4.5 validation, §6 import, §7 UI); public API wire types in `packages/api/src/agent-profile.ts`, saved-prompts and agent-chat contracts. Specific historic failures are also identified in tests (wrong-tab shortcuts, stale-load races, WebKit gesture-bound copying, prototype-key lookups, archived-data exposure).

Shared six-bar justification applied to each KEEP/REWRITE row: **B1** the file source below supplies the independent contract; **B2** the specific failure is the negation of the named scenario, shown in the failure column; **B3** fixed fixture inputs and literal expected data/state constitute an oracle independent of the implementation (not its constants, except stable protocol error discriminants); **B4** the actual production-used seam below is invoked; **B5** assertions depend on returned data, public state, API requests or externally required callback lifecycle, not markup/private collaborators, so algorithm/module refactors preserve them; **B6** no stronger retained test owns that seam-specific conversion, async ordering, or state transition. Daemon/API tests own their own persistence/validation, not browser caches or UI request construction. Where a duplicate, representation or copy assertion existed it is explicitly DELETE/REWRITE.

Risk: low for pure deletion; editor hook removals must preserve every production default. Focused validation command for all retained `.test.ts`: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=4 <retained paths>` from packages/ui. Remaining `.check.ts` use the same import preloads without `--test`. Package typecheck: `pnpm --filter @orquester/ui typecheck`. Root owns final repository gates.

## `packages/ui/src/components/command-palette/conversation-search.test.ts`

Owner read: `packages/ui/src/components/command-palette/conversation-search.ts`. Production callers: CommandPalette and search-hit rendering. Independent source (B1): Conversation search public query/snippet protocol and palette mode navigation. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Wrong mode navigation, truncated/blank requests, corrupt marked snippets, confusing unavailable indexing with transport failure, losing previous results, or hiding empty/truncated search state. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | switches to search when ˋ?ˋ is typed first, and keeps the rest as the query | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | leaves an ordinary query alone | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | treats a ˋ?ˋ typed inside the mode as text | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | trims, and sends nothing for blank input | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | never sends more than the host would read | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | splits a snippet on its «marks» | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | keeps a snippet without marks, or with an unclosed one, as plain text | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | says the index is unavailable only when the host answers ˋindexed: falseˋ | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | never reads an HTTP error as an unavailable index — it is a failure worth retrying | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | says there are no matches, rather than showing nothing | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | shows the previous results while the next search runs | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | surfaces any other failure in words | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | says when more matched than it shows | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/components/right-rail/agent-profile/agent-profile-render.check.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

DELETE entire check script: static markup/class/geometry/copy inventories and source greps do not survive a behavior-preserving render or identifier refactor (B4/B5 fail); no actions run. The secret-negative check never supplies the alleged secret, so it passes for the wrong reason. Retained editor draft, store, error classification and concurrency tests own the real contracts.

Every original assertion below is DELETE (location before editing); expressions identify unnamed checks and parameterized loops:

- DELETE L226: `assert.ok(start >= 0, ˋrow ${id} is listedˋ);` — static/source assertion; rationale above.
- DELETE L239: `assert.ok(html.startsWith('<div data-agent-profile-panel="" class="flex min-h-0 flex-1 flex-col">'), "the dock's panel contract");` — static/source assertion; rationale above.
- DELETE L240: `assert.ok(/class="min-h-0 flex-1 space-y-1\.5 overflow-y-auto px-3 pb-3/.test(html), "the list scrolls itself, px-3");` — static/source assertion; rationale above.
- DELETE L243: `assert.ok(html.includes('data-agent-picker="segmented"'), "a 400 px panel shows the segmented picker");` — static/source assertion; rationale above.
- DELETE L245: `assert.equal((segments.match(/<button/g) ?? []).length, 4, "four agents");` — static/source assertion; rationale above.
- DELETE L246: `assert.ok(/<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?Claude<\/button>/.test(segments), "Claude is the pressed one");` — static/source assertion; rationale above.
- DELETE L247: `assert.ok(/<button[^>]*disabled=""[^>]*title="Grok is not installed"/.test(segments), "Grok, not installed, is disabled and says so");` — static/source assertion; rationale above.
- DELETE L248: `assert.ok(segments.includes(">OpenCode</button>"), "OpenCode by its whole name");` — static/source assertion; rationale above.
- DELETE L250: `assert.equal((segments.match(/<span aria-hidden="true" class="flex h-3\.5 w-3\.5/g) ?? []).length, 4, "an icon per agent");` — static/source assertion; rationale above.
- DELETE L253: `assert.ok(html.includes('aria-label="Search Claude&#x27;s profile"'));` — static/source assertion; rationale above.
- DELETE L255: `assert.ok(/overflow-x-auto/.test(chips) && /flex-nowrap/.test(chips), "one scrolling row that never wraps");` — static/source assertion; rationale above.
- DELETE L256: `assert.ok(chips.includes("mask-image"), "with its edge fades");` — static/source assertion; rationale above.
- DELETE L257: `assert.ok(/aria-pressed="true"[^>]*>[\s\S]*?All[\s\S]*?>9</.test(chips), "All is pressed, with the total");` — static/source assertion; rationale above.
- DELETE L258: `assert.ok(/MCP<span[^>]*>2</.test(chips) && /Hooks<span[^>]*>3</.test(chips), "each kind with its count");` — static/source assertion; rationale above.
- DELETE L259: `assert.ok(/Marketplaces<span[^>]*>0</.test(chips), "an empty kind keeps its chip");` — static/source assertion; rationale above.
- DELETE L262: `assert.ok(html.includes('data-profile-instructions=""'), "the instructions card");` — static/source assertion; rationale above.
- DELETE L263: `assert.ok(html.includes("CLAUDE.md") && html.includes("42 lines · edited 2h ago"), "file, lines, edited ago");` — static/source assertion; rationale above.
- DELETE L267: `assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]!)), "sections in AGENT_PROFILE_KINDS order");` — static/source assertion; rationale above.
- DELETE L268: `assert.ok(!html.includes('aria-label="Marketplaces"'), "no section for an empty kind");` — static/source assertion; rationale above.
- DELETE L272: `assert.ok(user.includes('title="jira-cloud"') && /\btruncate\b/.test(user), "the name truncates with its tooltip");` — static/source assertion; rationale above.
- DELETE L273: `assert.ok(user.includes("stdio · Jira issues, sprints and boards") && user.includes("line-clamp-1"), "one clamped line");` — static/source assertion; rationale above.
- DELETE L274: `assert.ok(!user.includes("rounded-md border border-neutral-700/80 px-1.5"), "no badge for the user's own");` — static/source assertion; rationale above.
- DELETE L275: `assert.ok(/role="switch" aria-checked="true" aria-label="Turn off jira-cloud"/.test(user), "the switch says what it does");` — static/source assertion; rationale above.
- DELETE L276: `assert.ok(!/disabled=""/.test(switchOf(user)), "and works");` — static/source assertion; rationale above.
- DELETE L277: `assert.ok(user.includes("More actions for jira-cloud"), "its menu");` — static/source assertion; rationale above.
- DELETE L281: `assert.ok(/opacity-55/.test(off) && off.includes("(off)"), "an off row is dimmed and says so");` — static/source assertion; rationale above.
- DELETE L282: `assert.ok(/aria-checked="false" aria-label="Turn on serena"/.test(off));` — static/source assertion; rationale above.
- DELETE L283: `assert.ok(switchOf(rowOf(html, STASHED.id)).includes("set aside by Orquester"), "a stashed row's switch says where it went");` — static/source assertion; rationale above.
- DELETE L287: `assert.ok(locked.includes("(locked)") && locked.includes('title="Locked — Orquester manages this"'), "a lock with its reason");` — static/source assertion; rationale above.
- DELETE L288: `assert.ok(/disabled=""/.test(switchOf(locked)), "the switch is disabled");` — static/source assertion; rationale above.
- DELETE L289: `assert.ok(/<span class="inline-flex shrink-0" title="Locked — Orquester manages this">/.test(locked), "its tooltip on the wrapper");` — static/source assertion; rationale above.
- DELETE L290: `assert.ok(locked.includes(">Orquester</span>"), "its source badge");` — static/source assertion; rationale above.
- DELETE L291: `assert.ok(locked.includes("More actions for agent-hook.sh"), "a path to copy still gives it a menu");` — static/source assertion; rationale above.
- DELETE L295: `assert.ok(inherited.includes(">From Claude</span>"), "the source badge");` — static/source assertion; rationale above.
- DELETE L296: `assert.ok(inherited.includes('title="Manage in Claude"') && /disabled=""/.test(switchOf(inherited)));` — static/source assertion; rationale above.
- DELETE L297: `assert.ok(/<button[^>]*>Manage in Claude<svg/.test(inherited), "a Manage in Claude button");` — static/source assertion; rationale above.
- DELETE L301: `assert.ok(plugin.includes('title="Managed by plugin superpowers"'));` — static/source assertion; rationale above.
- DELETE L302: `assert.ok(!plugin.includes("More actions") && /<span aria-hidden="true" class="shrink-0 w-7"><\/span>/.test(plugin), "the menu's place held");` — static/source assertion; rationale above.
- DELETE L303: `assert.ok(/shrink-\[100\]/.test(plugin), "the badge shrinks first");` — static/source assertion; rationale above.
- DELETE L307: `assert.ok(untrusted.includes("Not trusted by Codex") && /text-warn/.test(untrusted), "an amber warning chip");` — static/source assertion; rationale above.
- DELETE L308: `assert.ok(/<button[^>]*title="Trust lint-on-edit as it is now"[^>]*>[\s\S]*?Trust<\/button>/.test(untrusted), "with Trust");` — static/source assertion; rationale above.
- DELETE L310: `assert.ok(cache.includes("Plugin cache missing") && !cache.includes(">Trust<"), "a warning without an action has no button");` — static/source assertion; rationale above.
- DELETE L313: `assert.ok(/<button type="button" class="app-no-drag flex w-full rounded-md/.test(html), "a full-width + Add trigger");` — static/source assertion; rationale above.
- DELETE L314: `assert.ok(html.includes("to Claude&#x27;s profile") && html.includes("Changes apply to new sessions"), "Add, and the hint");` — static/source assertion; rationale above.
- DELETE L315: `assert.ok(html.includes('<div role="status" class="sr-only"></div>') && html.includes('<div role="alert" class="sr-only"></div>'), "live regions, always mounted");` — static/source assertion; rationale above.
- DELETE L324: `assert.ok(narrow.includes('data-agent-picker="dropdown"') && !narrow.includes('data-agent-picker="segmented"'), "280 px: one dropdown");` — static/source assertion; rationale above.
- DELETE L325: `assert.ok(/<span class="sr-only">Agent: <\/span><span class="min-w-0 flex-1 truncate">Claude<\/span>/.test(narrow), "naming the agent");` — static/source assertion; rationale above.
- DELETE L327: `assert.ok(opencode.includes("OpenCode servers restart when idle"), "OpenCode's hint");` — static/source assertion; rationale above.
- DELETE L329: `assert.ok(!chips.includes("Hooks") && !chips.includes("Marketplaces"), "only OpenCode's kinds");` — static/source assertion; rationale above.
- DELETE L338: `assert.ok(loading.includes('aria-label="Loading the profile"') && loading.includes("animate-pulse"), "a loading skeleton");` — static/source assertion; rationale above.
- DELETE L339: `assert.ok(loading.includes('aria-busy="true"'), "the list is busy");` — static/source assertion; rationale above.
- DELETE L340: `assert.ok(!loading.includes("Filter by kind") && !loading.includes("data-profile-instructions"), "no filters without a snapshot");` — static/source assertion; rationale above.
- DELETE L341: `assert.ok(/<button class="[^"]*\bw-full\b[^"]*" type="button" disabled="">[\s\S]{0,600}?Add<\/button>/.test(loading), "Add waits for the snapshot");` — static/source assertion; rationale above.
- DELETE L344: `assert.ok(notInstalled.includes("Grok is not installed.") && notInstalled.includes("Install it from Settings → Agents."));` — static/source assertion; rationale above.
- DELETE L347: `assert.ok(error.includes("Couldn&#x27;t load Claude&#x27;s profile") && error.includes("The daemon did not answer."));` — static/source assertion; rationale above.
- DELETE L348: `assert.ok(/<button[^>]*>Retry<\/button>/.test(error), "with Retry");` — static/source assertion; rationale above.
- DELETE L351: `assert.ok(emptyKind.includes("No MCP servers yet.") && /Add MCP server<\/button>/.test(emptyKind), "an empty kind offers its Add");` — static/source assertion; rationale above.
- DELETE L352: `assert.ok(!emptyKind.includes("data-profile-instructions"), "the instructions card stays out of a filtered list");` — static/source assertion; rationale above.
- DELETE L355: `assert.ok(codexCommands.includes("No commands yet.") && !codexCommands.includes("Add command"), "Codex cannot create commands");` — static/source assertion; rationale above.
- DELETE L358: `assert.ok(none.includes("Claude has no MCP servers, skills or plugins yet.") && none.includes("data-profile-instructions"));` — static/source assertion; rationale above.
- DELETE L361: `assert.ok(noMatches.includes("Nothing matches “zzz”"));` — static/source assertion; rationale above.
- DELETE L364: `assert.ok(refreshFailed.includes("The daemon did not answer.") && />Retry<\/button>/.test(refreshFailed) && refreshFailed.includes("data-profile-item"), "a failed refresh keeps the rows, with Retry");` — static/source assertion; rationale above.
- DELETE L385: `assert.ok(partial.includes('data-profile-file-errors=""') && partial.includes("A file could not be read"), "a partial snapshot's banner");` — static/source assertion; rationale above.
- DELETE L386: `assert.ok(partial.includes("/var/lib/orquester/.codex/config.toml") && partial.includes("expected ˋ=ˋ at line 12"), "naming the file and why");` — static/source assertion; rationale above.
- DELETE L387: `assert.ok(/data-profile-instructions[\s\S]*?Shadowed by AGENTS\.override\.md/.test(partial), "the instructions warning as a chip");` — static/source assertion; rationale above.
- DELETE L392: `assert.ok(ok.includes('data-profile-notice="ok"') && ok.includes('<div role="status" class="sr-only">Turned off serena.'), "an ok notice, read out");` — static/source assertion; rationale above.
- DELETE L394: `assert.ok(bad.includes('data-profile-notice="error"') && /text-danger/.test(bad), "a refusal in the danger colour");` — static/source assertion; rationale above.
- DELETE L395: `assert.ok(bad.includes('<div role="alert" class="sr-only">It changed on disk'), "read out as an alert");` — static/source assertion; rationale above.
- DELETE L401: `assert.ok(/aria-busy="true"/.test(row) && /animate-spin/.test(row), "a change in flight shows");` — static/source assertion; rationale above.
- DELETE L402: `assert.ok(/aria-disabled="true"/.test(switchOf(row)) && !/disabled=""/.test(switchOf(row)), "the switch refuses clicks yet keeps focus");` — static/source assertion; rationale above.
- DELETE L403: `assert.ok(/ring-neutral-500\/50/.test(rowOf(busy, OFF.id)), "the saved item is outlined");` — static/source assertion; rationale above.
- DELETE L412: `assert.ok(html.includes('data-agent-picker="segmented"'), "a 360 px phone fits the segments");` — static/source assertion; rationale above.
- DELETE L414: `assert.ok((segments.match(/<button[^>]*class="[^"]*\bh-10\b/g) ?? []).length === 4, "segments 40 px tall");` — static/source assertion; rationale above.
- DELETE L416: `assert.ok((chips.match(/<button[^>]*class="[^"]*\bh-10\b/g) ?? []).length === 7, "every chip a 40 px target");` — static/source assertion; rationale above.
- DELETE L418: `assert.ok(/\bh-10\b/.test(switchOf(user)) && /\bw-12\b/.test(switchOf(user)), "the switch's target is 40 px");` — static/source assertion; rationale above.
- DELETE L419: `assert.ok(/<span title="More actions" class="[^"]*\bh-10 w-10\b/.test(user), "so is the menu's");` — static/source assertion; rationale above.
- DELETE L420: `assert.ok(/<button[^>]*class="[^"]*\bmin-h-10\b[^"]*"[^>]*>Manage in Claude/.test(rowOf(html, INHERITED.id)), "and Manage in");` — static/source assertion; rationale above.
- DELETE L422: `assert.ok(/\bh-10\b/.test(trust), "and Trust");` — static/source assertion; rationale above.
- DELETE L423: `assert.ok(/min-h-14/.test(html.match(/data-profile-instructions[^>]*class="[^"]*"/)?.[0] ?? ""), "the instructions card");` — static/source assertion; rationale above.
- DELETE L424: `assert.ok(/inline-flex w-full items-center justify-center gap-2 rounded-md bg-neutral-200 px-3 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 h-10/.test(html), "and + Add");` — static/source assertion; rationale above.
- DELETE L427: `assert.ok(/data-agent-picker="dropdown" class="[^"]*\bh-10\b/.test(narrow), "a narrow sheet's dropdown is 40 px");` — static/source assertion; rationale above.
- DELETE L433: `assert.ok(row.includes('role="group" aria-label="Delete serena"'), "Delete asks on the row");` — static/source assertion; rationale above.
- DELETE L434: `assert.ok(/<button[^>]*>Cancel<\/button>/.test(row) && /bg-danger-600[^>]*>Delete<\/button>/.test(row), "Cancel and a red Delete");` — static/source assertion; rationale above.
- DELETE L435: `assert.ok(!rowOf(deleting, USER.id).includes("aria-label=\"Delete"), "only that row asks");` — static/source assertion; rationale above.
- DELETE L439: `assert.ok(asked.includes("Codex already has <span"), "a copy's collision asks on the row");` — static/source assertion; rationale above.
- DELETE L440: `for (const label of ["Replace", "Keep both", "Cancel"]) assert.ok(asked.includes(ˋ>${label}</button>ˋ), label);` — static/source assertion; rationale above.
- DELETE L479: `assert.ok(mcp.includes("http · https://mcp.context7.com/mcp"), ˋ${variant}: the transport and the target as the second lineˋ);` — static/source assertion; rationale above.
- DELETE L480: `assert.ok(!/<p[^>]*>[^<]*deniedMcpServers/.test(mcp), ˋ${variant}: the off-switch caveat is not a second-line factˋ);` — static/source assertion; rationale above.
- DELETE L481: `assert.ok(` — static/source assertion; rationale above.
- DELETE L489: `assert.ok(hook.includes(">PreToolUse · Bash</p>"), ˋ${variant}: a hook's event and matcher said once, not "command · …" twiceˋ);` — static/source assertion; rationale above.
- DELETE L493: `assert.ok(copyPath.includes("Copy path"), ˋ${variant}: an open-file warning offers the file's pathˋ);` — static/source assertion; rationale above.
- DELETE L494: `assert.ok(variant === "docked" ? /\bh-6\b/.test(copyPath) : /\bh-10\b/.test(copyPath), ˋ${variant}: sized for the variantˋ);` — static/source assertion; rationale above.
- DELETE L495: `assert.ok(!rowOf(html, noPath.id).includes("Copy path"), ˋ${variant}: no path, no buttonˋ);` — static/source assertion; rationale above.
- DELETE L515: `assert.match(button, /focus-visible:ring/, ˋa focus ring on ${button}ˋ);` — static/source assertion; rationale above.
- DELETE L547: `assert.ok(html.startsWith('<div data-profile-item="mcp:jira-cloud"'), "keyed by its id");` — static/source assertion; rationale above.
- DELETE L548: `assert.ok(/<button type="button" class="app-no-drag inline-flex shrink-0 rounded-md/.test(html), "the menu trigger is a fixed-size button");` — static/source assertion; rationale above.
- DELETE L556: `assert.ok(!noActions.includes("More actions"), "nothing to offer, no menu");` — static/source assertion; rationale above.
- DELETE L587: `assert.ok(narrow.includes('placeholder="Search profile…"'), "a search placeholder the 260 px dock holds");` — static/source assertion; rationale above.
- DELETE L588: `assert.ok(narrow.includes('aria-label="Search OpenCode&#x27;s profile"'), "its name still says whose");` — static/source assertion; rationale above.
- DELETE L591: `assert.ok(hint.length > 0 && !/\btruncate\b/.test(hint) && /text-balance/.test(hint), "OpenCode's hint wraps, never clips");` — static/source assertion; rationale above.
- DELETE L594: `assert.ok(!card.includes("h-8 w-8 shrink-0 items-center justify-center rounded-lg"), "a narrow panel's card drops the file icon");` — static/source assertion; rationale above.
- DELETE L595: `assert.ok(/\bw-6\b/.test(card), "and narrows its chevron");` — static/source assertion; rationale above.
- DELETE L598: `assert.ok(wideCard.includes("h-8 w-8 shrink-0 items-center justify-center rounded-lg"), "a wide one keeps it");` — static/source assertion; rationale above.
- DELETE L603: `assert.ok(chip.length > 0 && /break-words/.test(chip) && !/\btruncate\b/.test(chip), "a warning chip wraps");` — static/source assertion; rationale above.
- DELETE L609: `assert.ok(hook.includes(ˋtitle="${orquesterHook.name.replace(/'/g, "&#x27;")}"ˋ), "the whole command in the tooltip");` — static/source assertion; rationale above.
- DELETE L610: `assert.ok(hook.includes(">&#x27;…/agent-hook.sh&#x27; grok Stop</span>"), "the part that tells hooks apart");` — static/source assertion; rationale above.
- DELETE L611: `assert.ok(hook.includes(">Stop · timeout 10 s · orquester.json</p>"), "event first");` — static/source assertion; rationale above.
- DELETE L614: `assert.ok(/<div class="flex min-w-0 items-center gap-1\.5 overflow-hidden">/.test(hook), "the name line clips its badge");` — static/source assertion; rationale above.
- DELETE L618: `assert.ok(/<div class="flex flex-wrap items-center gap-1\.5 px-3 -mt-2 pb-1">/.test(rowOf(sheet, inherited.id)), "no gap under the row");` — static/source assertion; rationale above.

## `packages/ui/src/components/right-rail/agent-profile/default-agent.test.ts`

Owner read: `packages/ui/src/components/right-rail/agent-profile/default-agent.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: The profile opens on the wrong active adapter, stale preference, uninstalled agent or unsupported provider; fallback ordering selects a profile the user cannot manage. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | is the provider serving the tab's refId | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | falls back to the registry's chat adapter while the providers have not loaded | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | is none for no tab, or an agent this panel has no profile for | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | is the visible chat tab's agent first | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | else the one last picked | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | else the first installed one | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | passes over an agent known not to be installed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | is Claude when nothing is known at all | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/components/right-rail/agent-profile/editor/agent-profile-editor-render.check.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

DELETE entire check script: static markup/class/geometry/copy inventories and source greps do not survive a behavior-preserving render or identifier refactor (B4/B5 fail); no actions run. The secret-negative check never supplies the alleged secret, so it passes for the wrong reason. Retained editor draft, store, error classification and concurrency tests own the real contracts.

Every original assertion below is DELETE (location before editing); expressions identify unnamed checks and parameterized loops:

- DELETE L99: `assert.ok(found, ˋa button reading "${label}"ˋ);` — static/source assertion; rationale above.
- DELETE L106: `assert.ok(found, ˋa button reading "${label}"ˋ);` — static/source assertion; rationale above.
- DELETE L123: `assert.match(button, /focus-visible:ring/, ˋ${what}: a focus ring on ${button}ˋ);` — static/source assertion; rationale above.
- DELETE L125: `assert.match(button, /\b(?:h-1[0-4]|min-h-1[0-4])\b/, ˋ${what}: a 40 px touch target on ${button}ˋ);` — static/source assertion; rationale above.
- DELETE L133: `assert.ok(named, ˋ${what}: a label for ${field}ˋ);` — static/source assertion; rationale above.
- DELETE L135: `assert.match(field, /\bh-10\b/, ˋ${what}: a 40 px field on a phone: ${field}ˋ);` — static/source assertion; rationale above.
- DELETE L139: `assert.equal(palette, null, ˋ${what}: only neutral, amber and red (found ${palette?.[0]})ˋ);` — static/source assertion; rationale above.
- DELETE L141: `assert.ok(Number(match[1]) <= 360, ˋ${what}: ${match[0]} would overflow a 360 px screenˋ);` — static/source assertion; rationale above.
- DELETE L202: `assert.equal(renderToStaticMarkup(createElement(AgentProfileEditorHost)), "", "the host draws nothing until a request");` — static/source assertion; rationale above.
- DELETE L213: `assert.ok(html.includes(ˋdata-editor-variant="${variant}"ˋ), ˋ${what}: the shellˋ);` — static/source assertion; rationale above.
- DELETE L216: `assert.ok(buttonWith(html, "Cancel").includes("h-10"), ˋ${what}: Cancel in the sticky headerˋ);` — static/source assertion; rationale above.
- DELETE L217: `assert.ok(!html.includes("<kbd"), ˋ${what}: no keyboard hint on a phoneˋ);` — static/source assertion; rationale above.
- DELETE L219: `assert.ok(html.includes('aria-label="Cancel"'), ˋ${what}: a close button in the headerˋ);` — static/source assertion; rationale above.
- DELETE L253: `assert.ok(` — static/source assertion; rationale above.
- DELETE L257: `assert.ok(buttonWith(html, transport === "stdio" ? (variant === "phone" ? "stdio" : "Command (stdio)") : transport.toUpperCase()).includes('aria-pressed="true"'), ˋ${what}: the transport is pickedˋ);` — static/source assertion; rationale above.
- DELETE L259: `assert.ok(html.includes(">Command") && html.includes(">Arguments") && html.includes(">Environment"), ˋ${what}: command, args, envˋ);` — static/source assertion; rationale above.
- DELETE L260: `assert.ok(!html.includes(">URL") && !html.includes(">Headers"), ˋ${what}: no URL or headersˋ);` — static/source assertion; rationale above.
- DELETE L262: `assert.ok(html.includes(">URL") && html.includes(">Headers"), ˋ${what}: URL and headersˋ);` — static/source assertion; rationale above.
- DELETE L263: `assert.ok(!html.includes(">Arguments") && !html.includes(">Environment"), ˋ${what}: no command fieldsˋ);` — static/source assertion; rationale above.
- DELETE L266: `assert.ok(html.includes(spec.label.replace(/&/g, "&amp;")), ˋ${what}: the advanced ${spec.key} fieldˋ);` — static/source assertion; rationale above.
- DELETE L271: `assert.equal(transports.includes(">SSE<"), MCP_TRANSPORTS[agent].includes("sse"), ˋ${agent}: SSE only where it is acceptedˋ);` — static/source assertion; rationale above.
- DELETE L283: `assert.ok(html.includes("•••") && text(html).includes("set"), "an existing secret shows ••• set");` — static/source assertion; rationale above.
- DELETE L284: `assert.ok(buttonWith(html, "Replace").includes('aria-label="Replace JIRA_TOKEN"'), "with Replace");` — static/source assertion; rationale above.
- DELETE L285: `assert.ok(html.includes('aria-label="Remove JIRA_TOKEN"'), "and Remove");` — static/source assertion; rationale above.
- DELETE L286: `assert.ok(html.includes('aria-label="New value for JIRA_URL"'), "Replace reveals an empty input for the new value");` — static/source assertion; rationale above.
- DELETE L287: `assert.ok(/aria-label="New value for JIRA_URL"[^>]*value=""|value=""[^>]*aria-label="New value for JIRA_URL"/.test(html), "empty");` — static/source assertion; rationale above.
- DELETE L288: `assert.ok(buttonWith(html, "Keep").includes("Keep the current value of JIRA_URL"), "and a way back");` — static/source assertion; rationale above.
- DELETE L289: `assert.ok(!html.includes(SECRET_VALUE), "no value on disk anywhere");` — static/source assertion; rationale above.
- DELETE L290: `assert.ok(html.includes("Renaming moves the server"), "edit: rename is allowed and said");` — static/source assertion; rationale above.
- DELETE L292: `assert.ok(desktop.includes("grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]"), "wide: key | value side by side");` — static/source assertion; rationale above.
- DELETE L293: `assert.ok(!phone.includes("grid-cols-[minmax(0,2fr)"), "narrow: stacked");` — static/source assertion; rationale above.
- DELETE L300: `assert.ok(!narrowDesktop.includes("grid-cols-[minmax(0,2fr)"), "the editor's own width decides, not the device");` — static/source assertion; rationale above.
- DELETE L303: `assert.ok(refused.includes("Type the new value, or keep the current one"), "an empty replacement is refused");` — static/source assertion; rationale above.
- DELETE L310: `assert.ok(html.includes('aria-label="Argument 1"') && html.includes('aria-label="Argument 2"'), "one input per argument");` — static/source assertion; rationale above.
- DELETE L311: `assert.ok(html.includes('aria-label="Remove argument 2"'), "each removable");` — static/source assertion; rationale above.
- DELETE L312: `assert.ok(html.includes("Grok refuses that name") && html.includes('aria-invalid="true"'), "INVALID_NAME at the name field");` — static/source assertion; rationale above.
- DELETE L313: `assert.ok(html.includes("Paste a whole command line"), "the paste hint");` — static/source assertion; rationale above.
- DELETE L315: `assert.ok(invalid.includes("Enter the command that starts the server"), "a missing command, after Save");` — static/source assertion; rationale above.
- DELETE L336: `assert.ok(buttonWith(exists, "Replace") && buttonWith(exists, "Keep both"), "ITEM_EXISTS offers Replace and Keep both");` — static/source assertion; rationale above.
- DELETE L337: `assert.ok(exists.includes("An MCP server named jira exists."), "with the daemon's words");` — static/source assertion; rationale above.
- DELETE L350: `assert.ok(changed.includes("Changed on disk") && buttonWith(changed, "Reload"), "PROFILE_CONFLICT offers Reload");` — static/source assertion; rationale above.
- DELETE L362: `assert.ok(general.includes('role="alert"') && general.includes("grok mcp add exited 1"), "anything else: the banner");` — static/source assertion; rationale above.
- DELETE L378: `assert.ok(buttonWith(oneCopy, "Replace") && !oneCopy.includes(">Keep both<"), "no Keep both where a second copy cannot exist");` — static/source assertion; rationale above.
- DELETE L379: `assert.ok(oneCopy.includes("Replace it?"), "and it asks only that");` — static/source assertion; rationale above.
- DELETE L394: `assert.ok(renamedOntoTaken.includes("&quot;jira&quot; already exists.") && renamedOntoTaken.includes('role="alert"'), "an edit's ITEM_EXISTS: the refusal");` — static/source assertion; rationale above.
- DELETE L395: `assert.ok(!renamedOntoTaken.includes(">Replace<") && !renamedOntoTaken.includes(">Keep both<"), "without a Replace that cannot work");` — static/source assertion; rationale above.
- DELETE L403: `assert.equal(nameOnly, "", "a name refusal is the name field's, not repeated above Save");` — static/source assertion; rationale above.
- DELETE L415: `assert.ok(noNameField.includes('role="alert"') && noNameField.includes("is not a valid skill name."), "said above Save instead of nowhere");` — static/source assertion; rationale above.
- DELETE L418: `assert.ok(collision.includes("2 of these already exist") && collision.includes("tdd, ship"), "picked collisions ask first");` — static/source assertion; rationale above.
- DELETE L422: `assert.ok(discard.includes('role="alertdialog"') && discard.includes("Discard your changes?"), "the unsaved-changes guard");` — static/source assertion; rationale above.
- DELETE L423: `assert.ok(buttonWith(discard, "Discard").includes("bg-danger-600"), "a destructive Discard");` — static/source assertion; rationale above.
- DELETE L424: `assert.ok(buttonWith(discard, "Keep editing"), "and a way back");` — static/source assertion; rationale above.
- DELETE L431: `assert.ok(isDisabled(save) && save.includes("Not connected to the daemon"), "no save while disconnected");` — static/source assertion; rationale above.
- DELETE L443: `assert.ok(buttonWith(write, "Write").includes('aria-pressed="true"'), ˋ${what}: Write firstˋ);` — static/source assertion; rationale above.
- DELETE L444: `assert.ok(write.includes('data-code-area=""'), ˋ${what}: the body editorˋ);` — static/source assertion; rationale above.
- DELETE L445: `assert.ok(write.includes(kind === "skill" ? 'aria-label="Skill instructions"' : 'aria-label="Command prompt"'), ˋ${what}: namedˋ);` — static/source assertion; rationale above.
- DELETE L446: `assert.ok(write.includes(">More fields"), ˋ${what}: optional fields foldedˋ);` — static/source assertion; rationale above.
- DELETE L447: `assert.ok(` — static/source assertion; rationale above.
- DELETE L451: `if (kind === "skill") assert.ok(write.includes(">Description") && write.includes("aria-required"), "a skill's description is required");` — static/source assertion; rationale above.
- DELETE L455: `assert.deepEqual(` — static/source assertion; rationale above.
- DELETE L460: `if (variant === "phone") assert.ok(write.includes('aria-label="Copy from agent"'), ˋ${what}: a short label keeps its whole nameˋ);` — static/source assertion; rationale above.
- DELETE L466: `assert.ok(git.includes(">Repository URL") && buttonWith(git, "Scan"), "Git URL: a URL and Scan");` — static/source assertion; rationale above.
- DELETE L468: `assert.ok(cloning.includes("Cloning and scanning") && isDisabled(buttonWith(cloning, "Cloning…")), "scanning");` — static/source assertion; rationale above.
- DELETE L470: `assert.ok(scanFailed.includes("Couldn&#x27;t read the repository") && scanFailed.includes("git clone failed"), "a failed scan says why");` — static/source assertion; rationale above.
- DELETE L473: `assert.ok(scanned.includes("Found 3 · 2 selected"), "new candidates start ticked");` — static/source assertion; rationale above.
- DELETE L474: `assert.ok(scanned.includes(">exists<"), "a colliding candidate says so");` — static/source assertion; rationale above.
- DELETE L475: `assert.ok(buttonWith(scanned, "Import 2") && buttonWith(scanned, "Scan another"), "Import the ticked ones");` — static/source assertion; rationale above.
- DELETE L476: `assert.ok(scanned.includes("Skipped symlink skills/linked"), "the scan's notes");` — static/source assertion; rationale above.
- DELETE L477: `assert.equal((scanned.match(/type="checkbox"/g) ?? []).length, 3, "a checkbox per candidate");` — static/source assertion; rationale above.
- DELETE L479: `assert.ok(empty.includes("Nothing to import") && isDisabled(buttonWith(empty, "Import")), "an empty scan");` — static/source assertion; rationale above.
- DELETE L484: `assert.ok(upload.includes('accept=".zip,.md"') && upload.includes('type="file"'), "Upload: a .zip/.md file input");` — static/source assertion; rationale above.
- DELETE L485: `assert.ok(upload.includes(variant === "desktop" ? "Drop a .zip or .md file here" : "A .zip of skill folders"), "drop zone on desktop only");` — static/source assertion; rationale above.
- DELETE L487: `assert.ok(uploading.includes('role="progressbar"') && uploading.includes('aria-valuenow="42"'), "upload progress");` — static/source assertion; rationale above.
- DELETE L488: `assert.ok(isDisabled(buttonWith(uploading, "Uploading…")), "one upload at a time");` — static/source assertion; rationale above.
- DELETE L490: `assert.ok(uploadFailed.includes("Choose a .zip or a .md file") && uploadFailed.includes('role="alert"'), "a refused file");` — static/source assertion; rationale above.
- DELETE L492: `assert.ok(uploaded.includes("Found 3") && buttonWith(uploaded, "Import 2"), "the same checklist after an upload");` — static/source assertion; rationale above.
- DELETE L497: `assert.ok(copyLoading.includes("Reading Claude") && isDisabled(footerButton(copyLoading, "Copy")), "Copy: reading the first other agent");` — static/source assertion; rationale above.
- DELETE L498: `assert.ok(!copyLoading.includes('value="grok"'), "never the agent itself");` — static/source assertion; rationale above.
- DELETE L520: `assert.ok(copyLoaded.includes("review-pr") && !copyLoaded.includes("from-plugin"), "only the agent's own skills");` — static/source assertion; rationale above.
- DELETE L521: `assert.ok(!copyLoaded.includes(">c<"), "only the same kind");` — static/source assertion; rationale above.
- DELETE L522: `assert.ok(copyLoaded.includes('checked=""') && !isDisabled(footerButton(copyLoaded, "Copy")), "one picked: Copy");` — static/source assertion; rationale above.
- DELETE L528: `assert.ok(notInstalled.includes("Codex is not installed"), "an agent that is not installed");` — static/source assertion; rationale above.
- DELETE L530: `assert.ok(copyFailed.includes("boom") && buttonWith(copyFailed, "Retry"), "a failed read, with Retry");` — static/source assertion; rationale above.
- DELETE L550: `assert.ok(html.includes("Reading Grok"), "starts on the first installed other agent");` — static/source assertion; rationale above.
- DELETE L551: `assert.ok(html.includes(">Codex (not installed)</option>"), "the missing one says so");` — static/source assertion; rationale above.
- DELETE L568: `assert.ok(html.includes(">Edit skill<") && html.includes("/home/.claude/skills/review-pr"), "titled, with its path");` — static/source assertion; rationale above.
- DELETE L569: `assert.ok(html.includes('value="review-pr"') && html.includes("Reviews a PR"), "prefilled");` — static/source assertion; rationale above.
- DELETE L570: `assert.ok(html.includes('value="opus"'), "More fields opens when one is set");` — static/source assertion; rationale above.
- DELETE L571: `assert.ok(html.includes("Other keys kept as they are") && html.includes("allowed-tools, metadata"), "kept keys listed");` — static/source assertion; rationale above.
- DELETE L572: `assert.ok(html.includes("scripts/diff.sh") && html.includes("only SKILL.md is edited here"), "other files read-only");` — static/source assertion; rationale above.
- DELETE L573: `assert.ok(html.includes("Do the review."), "the body");` — static/source assertion; rationale above.
- DELETE L574: `assert.ok(buttonWith(html, "Save"), "Save");` — static/source assertion; rationale above.
- DELETE L575: `assert.ok(!html.includes(">Write<"), "no source switcher on edit");` — static/source assertion; rationale above.
- DELETE L585: `assert.ok(create.includes(">Event") && create.includes(">Matcher") && create.includes(">Command") && create.includes(">Timeout (seconds)"), "hook fields");` — static/source assertion; rationale above.
- DELETE L586: `assert.ok(create.includes('placeholder="Bash or Edit|Write"'), "matcher placeholder");` — static/source assertion; rationale above.
- DELETE L587: `assert.ok(create.includes('<option value="Interrupt">'), "the agent's own events");` — static/source assertion; rationale above.
- DELETE L595: `assert.ok(!stop.includes(">Matcher") && stop.includes("they take no matcher"), "no matcher for an event that ignores it");` — static/source assertion; rationale above.
- DELETE L602: `assert.ok(refused.includes("Enter the command to run") && refused.includes("Whole seconds"), "hook refusals");` — static/source assertion; rationale above.
- DELETE L609: `assert.ok(edit.includes(">Edit hook<") && edit.includes('value="Bash"') && edit.includes("./guard.sh"), "hook edit prefilled");` — static/source assertion; rationale above.
- DELETE L619: `assert.ok(loading.includes("Reading Claude") && loading.includes("marketplaces"), "plugin: loading the marketplaces");` — static/source assertion; rationale above.
- DELETE L622: `assert.ok(none.includes("No marketplaces yet") && buttonWith(none, "Add a marketplace"), "no marketplace: explain and offer one");` — static/source assertion; rationale above.
- DELETE L623: `assert.ok(!none.includes(">Install<"), "nothing to install from");` — static/source assertion; rationale above.
- DELETE L643: `assert.ok(listed.includes('<option value="official"') && listed.includes('aria-label="Search plugins"'), "a marketplace and a search");` — static/source assertion; rationale above.
- DELETE L644: `assert.ok(listed.includes(">Installed<") && /<input[^>]*disabled=""[^>]*type="radio"|type="radio"[^>]*disabled=""/.test(listed), "installed ones marked and not pickable");` — static/source assertion; rationale above.
- DELETE L645: `assert.ok(listed.includes("TDD, debugging and planning skills"), "descriptions");` — static/source assertion; rationale above.
- DELETE L648: `assert.ok(/\bline-clamp-2\b/.test(description) && !/\bblock\b/.test(description), "descriptions clamped to two lines");` — static/source assertion; rationale above.
- DELETE L649: `assert.ok(!isDisabled(buttonWith(listed, "Install linear")), "Install the pick");` — static/source assertion; rationale above.
- DELETE L661: `assert.ok(failed.includes("marketplace clone missing") && buttonWith(failed, "Retry"), "a catalogue that cannot be read");` — static/source assertion; rationale above.
- DELETE L665: `assert.ok(spec.includes("npm package or file path") && spec.includes("opencode-wakatime"), "OpenCode: a spec, with examples");` — static/source assertion; rationale above.
- DELETE L666: `assert.ok(spec.includes("One package or path, without spaces"), "a bad spec");` — static/source assertion; rationale above.
- DELETE L676: `assert.ok(html.includes(type === "github" ? ">Repository" : type === "git" ? ">Git URL" : ">Folder"), ˋmarketplace ${type} fieldˋ);` — static/source assertion; rationale above.
- DELETE L677: `assert.equal(html.includes(">Branch, tag or commit"), type !== "path", "a ref except for a path");` — static/source assertion; rationale above.
- DELETE L678: `assert.ok(html.includes('role="alert"') === false && html.includes("text-danger"), "the missing source, said");` — static/source assertion; rationale above.
- DELETE L691: `assert.ok(html.includes("Installed as a whole") && html.includes("14 skills, 1 hooks"), "plugin details");` — static/source assertion; rationale above.
- DELETE L692: `assert.ok(!html.includes(">Save<") && buttonWith(html, "Close"), "nothing to save");` — static/source assertion; rationale above.
- DELETE L701: `assert.ok(loading.includes("Reading the item") && loading.includes('role="status"'), "edit: loading");` — static/source assertion; rationale above.
- DELETE L704: `assert.ok(gone.includes("It is gone") && !gone.includes(">Retry<"), "a deleted item");` — static/source assertion; rationale above.
- DELETE L706: `assert.ok(failed.includes("offline") && buttonWith(failed, "Retry"), "a failed read, with Retry");` — static/source assertion; rationale above.
- DELETE L715: `assert.ok(mcp.includes(">Edit MCP server<") && mcp.includes('value="jira-cloud"') && mcp.includes("•••"), "edit dispatches by the detail's kind");` — static/source assertion; rationale above.
- DELETE L725: `assert.ok(loading.includes("Reading Grok") && !loading.includes(">Save<"), "instructions: loading");` — static/source assertion; rationale above.
- DELETE L728: `assert.ok(failed.includes("EACCES") && buttonWith(failed, "Retry"), "instructions: a failed read");` — static/source assertion; rationale above.
- DELETE L753: `assert.ok(html.includes(">AGENTS.md<") && html.includes("/var/lib/orquester/.grok/AGENTS.md"), "titled by the file, with its path");` — static/source assertion; rationale above.
- DELETE L754: `assert.ok(html.includes("AGENTS.override.md shadows"), "the file's warnings");` — static/source assertion; rationale above.
- DELETE L755: `assert.ok(buttonWith(html, "Move GROK.md into AGENTS.md"), "Grok's dead GROK.md: offer the move");` — static/source assertion; rationale above.
- DELETE L756: `assert.ok(html.includes('data-code-area=""') && html.includes("Be brief."), "the text in the editor");` — static/source assertion; rationale above.
- DELETE L757: `assert.ok(html.includes("3 lines"), "a size line");` — static/source assertion; rationale above.
- DELETE L758: `assert.ok(isDisabled(buttonWith(html, "Save")), "nothing to save until it changes");` — static/source assertion; rationale above.
- DELETE L775: `assert.ok(!isDisabled(buttonWith(edited, "Save")), "an edit saves");` — static/source assertion; rationale above.
- DELETE L776: `assert.ok(isDisabled(buttonWith(edited, "Move GROK.md")), "no move over unsaved edits");` — static/source assertion; rationale above.
- DELETE L779: `assert.ok(buttonWith(conflict, "Reload") && buttonWith(conflict, "Overwrite").includes("text-danger"), "Reload or Overwrite");` — static/source assertion; rationale above.
- DELETE L793: `assert.match(source(file), /<SubmitStatus[^>]*\bnameShown\b/, ˋ${file}: its name field says itˋ);` — static/source assertion; rationale above.
- DELETE L796: `assert.doesNotMatch(source(file), /nameShown/, ˋ${file}: no name field, so the banner says itˋ);` — static/source assertion; rationale above.
- DELETE L801: `assert.match(source(file), /<SubmitStatus[^>]*keepBoth=\{false\}/, ˋ${file}: one copy onlyˋ);` — static/source assertion; rationale above.
- DELETE L803: `assert.equal((source("PluginEditor.tsx").match(/<SubmitStatus[^>]*keepBoth=\{false\}/g) ?? []).length, 2, "both plugin installers: one copy only");` — static/source assertion; rationale above.
- DELETE L807: `assert.match(source(file), /onResolveConflict=\{detail \? undefined : submit\.resolveConflict\}/, ˋ${file}: conflict answers for a create onlyˋ);` — static/source assertion; rationale above.
- DELETE L813: `assert.ok(read > 0 && read < frame.indexOf("useLayoutEffect("), "the opener is read before any effect");` — static/source assertion; rationale above.
- DELETE L814: `assert.match(frame, /needsInitialFocus\(dialogRef\.current, document\.activeElement\)/, "and the dialog takes focus when nothing inside did");` — static/source assertion; rationale above.
- DELETE L815: `assert.equal((frame.match(/tabIndex=\{-1\}/g) ?? []).length, 2, "both dialogs can take focus");` — static/source assertion; rationale above.
- DELETE L818: `assert.match(source("AgentProfileEditor.tsx"), /if \(dirty\.current && !saving\.current\) setConfirming\(true\)/);` — static/source assertion; rationale above.
- DELETE L820: `assert.match(submit, /env\.setSaving\(true\)/);` — static/source assertion; rationale above.
- DELETE L821: `assert.match(submit, /if \(!alive\.current\) \{\s*setAgentProfileNotice\(\{ tone: "error", text: closedSaveFailure\(info\) \}\)/);` — static/source assertion; rationale above.
- DELETE L822: `assert.equal(` — static/source assertion; rationale above.
- DELETE L829: `assert.match(source("EditorShell.tsx"), /onKeyDownCapture=\{\(event\) => \{\s*if \(!isSaveChord\(event\.nativeEvent\)\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);` — static/source assertion; rationale above.
- DELETE L831: `assert.equal(isSaveChord(chord), true);` — static/source assertion; rationale above.
- DELETE L832: `assert.equal(isSaveChord({ ...chord, ctrlKey: false, metaKey: true }), true);` — static/source assertion; rationale above.
- DELETE L833: `assert.equal(isSaveChord({ ...chord, ctrlKey: false }), false, "plain Enter types");` — static/source assertion; rationale above.
- DELETE L834: `assert.equal(isSaveChord({ ...chord, isComposing: true }), false, "an IME's Enter");` — static/source assertion; rationale above.
- DELETE L835: `assert.equal(isSaveChord({ ...chord, repeat: true }), false, "a held chord saves once");` — static/source assertion; rationale above.
- DELETE L838: `assert.match(source("InstructionsEditor.tsx"), /if \(info\.code === "PROFILE_CONFLICT"\) \{\s*setMigrateError\(MIGRATE_CONFLICT_MESSAGE\);\s*setAttempt\(\(n\) => n \+ 1\);/);` — static/source assertion; rationale above.
- DELETE L839: `assert.match(MIGRATE_CONFLICT_MESSAGE, /reloaded/);` — static/source assertion; rationale above.
- DELETE L844: `assert.equal(focusOpener({ activeElement: body, body }), null, "never <body>");` — static/source assertion; rationale above.
- DELETE L845: `assert.equal(focusOpener({ activeElement: null, body }), null);` — static/source assertion; rationale above.
- DELETE L846: `assert.equal(focusOpener({ activeElement: button, body }), button, "the trigger that opened it");` — static/source assertion; rationale above.
- DELETE L849: `assert.equal(needsInitialFocus(dialog, inside), false, "a field inside autofocused: leave it");` — static/source assertion; rationale above.
- DELETE L850: `assert.equal(needsInitialFocus(dialog, button), true, "focus still behind the dialog: take it");` — static/source assertion; rationale above.
- DELETE L851: `assert.equal(needsInitialFocus(dialog, null), true);` — static/source assertion; rationale above.
- DELETE L852: `assert.equal(needsInitialFocus(null, button), false);` — static/source assertion; rationale above.

## `packages/ui/src/components/right-rail/agent-profile/editor/markdown.logic.test.ts`

Owner read: `packages/ui/src/components/right-rail/agent-profile/editor/markdown.logic.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Skill drafts override CLI boolean defaults, destroy unknown frontmatter, send command names as metadata, clear the wrong field or accept an invalid agent-specific file name. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| DELETE | a skill's name field is the name input, never a second field | Private editor field inventory. Draft tests protect the name written to the API. |
| KEEP | a new skill's switches start at the CLI's defaults and send nothing until changed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | editing keeps unknown keys and type-mismatched keys untouched, and removes a cleared key | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a command carries no frontmatter name and keeps a name key found on disk | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| DELETE | names: skills are hyphenated lowercase words, commands may have one folder | Replays public name validator cases through a message wrapper; packages/api agent-profile validation is the stronger owner. |
| REWRITE | names: Grok's commands are flat files — a folder is refused before the daemon does | Retain agent-specific flat-command validity through validateMarkdownForm; delete private flag and hint-copy assertions. |
| KEEP | validation: a skill needs its description and a body; a command's description is optional | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/components/right-rail/agent-profile/editor/mcp.logic.test.ts`

Owner read: `packages/ui/src/components/right-rail/agent-profile/editor/mcp.logic.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Pasted command arguments/env are altered, secret keep/replace intent is lost, invalid or duplicate keys are accepted, transport-specific fields are mixed, advanced typed values/unknown keys are lost, or editing silently changes transport. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | splitCommandLine splits like a shell: quotes, escapes, continuations, no expansion | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a pasted command line becomes command + args, with leading assignments as env | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | secret drafts: untouched rows keep, replaced and new rows send a value, removed rows are absent | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| DELETE | existing secrets are never prefilled | No secret value enters the fixture, so the negative security claim passes for the wrong reason. Daemon profile redaction owns non-disclosure; retained secretDrafts/stdIO draft tests protect keep/replace semantics. |
| KEEP | secret rows: bad keys, duplicates (headers case-insensitively) and an empty replacement are refused | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the stdio draft carries command, args, cwd and env; the http draft url and headers only | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | advanced fields are coerced by type; unknown keys on disk pass through; blanks are left out | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| DELETE | the advanced form reads lists and numbers from the view, and opens when anything is set | Private form representation and disclosure appearance; retained wire-draft conversion covers actual values. |
| DELETE | names follow the strictest CLI's rule | Replays imported public API name validator through UI error wording; API tests own accepted names. |
| KEEP | validation: stdio needs a command, http a real http(s) URL, numbers must parse | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | the default transport is the agent's first; a view's is kept | Drop default-array-order assertion; retain saved SSE transport through the outgoing draft, avoiding silent conversion on edit. |
| DELETE | the signature ignores row identities | Private serialization/memo signature assertion; no user interaction observes dirty state. |

## `packages/ui/src/components/right-rail/agent-profile/editor/saved.test.ts`

Owner read: `packages/ui/src/components/right-rail/agent-profile/editor/saved.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: A save fails to publish its returned snapshot/item IDs, or a malformed answer replaces valid profile state. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a save puts the answer's snapshot in the store and tells the panel what changed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an answer without a usable snapshot still tells the panel, and leaves the store alone | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/components/right-rail/agent-profile/editor/small-editors.logic.test.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Hook matcher/command semantics change, invalid import/plugin/marketplace requests are sent, import collisions are skipped, copy sources expose foreign items, instruction overwrite carries an obsolete revision, or daemon refusal codes reach the wrong field. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | hook: the matcher is left out for events that ignore it, and when blank | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | hook: a multi-line command keeps its inner lines | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | hook: the agent's events, an unlisted event on disk kept selectable, validation | Remove catalogue/default inventories; retain validation of command/timeout and legacy unknown event preservation. |
| KEEP | plugin: marketplaces from the snapshot, filtering, OpenCode specs | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | marketplace: GitHub repos (URLs normalised), git URLs, paths; ref only where it applies | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | import: new candidates start ticked; collisions among the picks ask first | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | import: git URLs, upload names, upload progress | Retain accepted import URL/file formats; remove arithmetic progress display assertion. |
| KEEP | copy: every other agent; only the source agent's own items of the kind | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | instructions: overwrite re-reads for the fresh revision, then writes mine | Retain optimistic-concurrency API request with fresh revision; remove unrelated exact summary/file-label assertions and arranged response echo. |
| DELETE | layout: width breakpoints and titles | Geometry and exact copy assertions, expressly excluded by cleanup rules. |
| REWRITE | errors: the daemon's nested code and message; placement by code | Retain protocol code/message classification; remove exact generic fallback copy. |

## `packages/ui/src/components/right-rail/agent-profile/list.logic.test.ts`

Owner read: `packages/ui/src/components/right-rail/agent-profile/list.logic.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Filtering hides valid records or leaks another project/kind, search misses words/accented content, groups omit unknown-version data, uninstalled agents remain actionable, warning caveats disappear, or copy/manage targets name the wrong agent. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| DELETE | All then the agent's own kinds in AGENT_PROFILE_KINDS order, each counted — zero included | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| REWRITE | only the kinds that agent has: OpenCode has no marketplaces or hooks | Drop capability-chip inventory; retain unsupported-filter recovery so switching agents cannot strand the panel on an unavailable filter. |
| KEEP | the search matches every word in the name, description, source or meta, any case | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | filters by kind and query together | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | groups in the agent's kind order, each sorted by name, empty kinds left out | Remove exact section labels; retain item grouping/order data from the panel requirement. |
| KEEP | a kind the agent should not have (another daemon version) still shows, after the rest | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | rows when there are some | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | not installed wins over everything | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | loading, then an error with its message, while there is no snapshot | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | no matches, an empty kind, or nothing at all | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| DELETE | titles an empty kind in words | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| KEEP | knows an agent is not installed from its snapshot, its refusal, or the overview | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| DELETE | words the facts, and never shows Claude's off-switch caveat as a fact | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | drops what the description already says, and bare flags | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | a hook's second line reads alike for every agent: event, matcher, then the rest | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | a hook's name shows the ends of its absolute paths | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | plugins and marketplaces: a version, where from, how many installed | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | an unknown key from another daemon version still shows, after the known ones | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| REWRITE | its tooltip carries the adapter's off-switch caveat while on | Check the daemon-provided caveat survives only while disabling is available; wording outside that warning is not a contract (profile spec §4.6). |
| DELETE | says what pressing it does | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | explains why it is disabled | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| KEEP | copies only copyable kinds, to the other installed agents that have the kind | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | names where an inherited item is managed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| DELETE | names the file, its lines and when it was edited | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| DELETE | says a missing file is not created yet | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |
| REWRITE | lists the four agents, installed as the snapshot, else the overview, says | Remove exact agent labels; retain fresh snapshot precedence and unknown installation state. |
| DELETE | collapses the picker to a dropdown below the segmented control's width | Copy, declaration inventory, or appearance change detector; no independently required wording/geometry. Permissions remain covered by store sanitization and daemon owner; meaningful list filtering and navigation stay. |

## `packages/ui/src/components/right-rail/dock-keyboard.test.ts`

Owner read: `packages/ui/src/components/right-rail/dock-keyboard.ts`. Production callers: RightRailDock, RightRailBar and right-rail panels. Independent source (B1): AGENTS.md field-wise browser storage validation; dock keyboard ownership and right-rail viewing preference. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Escape reaches the wrong owner, auto-repeat closes multiple layers, IME cancellation closes the dock, or portaled children leak keys into terminal/global shortcuts. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | an Escape nothing inside the dock handled leaves the dock | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an Escape the panel consumed (the search field clearing itself) stays the panel's | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an Escape an open dropdown, menu or dialog of the panel closes is that layer's alone | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an IME composition's Escape cancels the composition, nothing else | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a held Escape leaves once: its auto-repeat is not another press | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | keys from a portaled child (a dropdown the panel opened) are never the dock's | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | every other key typed in the dock is contained there | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/components/right-rail/history/history-format.test.ts`

Owner read: `packages/ui/src/components/right-rail/history/history-format.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: A huge prompt is returned without a bound or truncation leaves an invalid Unicode surrogate. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | cuts a long one — a pasted 200 KB log becomes a few hundred characters | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | never ends on half a surrogate pair | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/components/right-rail/right-rail-state.test.ts`

Owner read: `packages/ui/src/components/right-rail/right-rail-state.ts`. Production callers: RightRailDock, RightRailBar and right-rail panels. Independent source (B1): AGENTS.md field-wise browser storage validation; dock keyboard ownership and right-rail viewing preference. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Malformed persisted data discards valid preferences, newer-version records stop loading, failed localStorage aborts interaction, drag persists before release, or real state changes do not notify subscribers. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | nothing stored, or garbage stored, loads the defaults | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a well-formed payload round-trips | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | each field is validated on its own: one bad field never costs the others | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the workflows panel is a panel like the others | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the agent profile panel is a panel like the others | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | malformed stored widths fall back without losing the panel | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a payload written by another version is still read field by field | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | load and save swallow storage errors and missing storage | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | toggling opens, switches and closes the dock — and persists every change | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a live drag updates the state only; the release persists it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | subscribers hear real changes only, and can unsubscribe | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a storage that throws never breaks the store | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/components/right-rail/saved-prompts/deliver.test.ts`

Owner read: `packages/ui/src/components/right-rail/saved-prompts/deliver.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Resolved prompt content reaches a different chat after a tab switch, a superseded/disposed action still sends, a missing target starts work, or rejected delivery increments use count. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | renders for the chat captured at the click, delivers there, and counts the use | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | refuses when another chat is on screen once the prompt is rendered — nothing lands, nothing counted | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | with no chat at the click, refuses at once and renders nothing | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a click supersedes the one still resolving: the first lands nowhere, its git reads stop | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | dispose (the panel going away) stops the delivery in flight | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | counts the use only when the chat took it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/components/right-rail/saved-prompts/editor-save.test.ts`

Owner read: `packages/ui/src/components/right-rail/saved-prompts/editor-save.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Unchanged/invalid drafts issue writes, concurrent saves duplicate mutation, close during save drops the result/error, or thrown requests permanently lock saving. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | an edit that changes nothing sends nothing, and closes | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an invalid draft is not sent | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | one save at a time: a second while the first is in flight is not sent | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | closed while saving: a success still lands and is revealed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | closed while saving: a failure becomes the panel's notice | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a request that throws is a failure, and the guard is released | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/components/right-rail/saved-prompts/editor.logic.test.ts`

Owner read: `packages/ui/src/components/right-rail/saved-prompts/editor.logic.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Client validation rejects valid limits or permits daemon-rejected input, create/update changes the wrong scope or unchanged fields, duplicate truncation damages Unicode, or a variable replaces the wrong selection. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a title and a body are required — as missing, not as errors | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | mirrors every limit | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a create: the whole record, normalised; This project = the open project | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an edit: only the fields that changed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an edit moves a prompt only when its scope changes — and to the open project | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | never cuts an emoji in half | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | inserts at the caret, or over the selection, and puts the caret after it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/components/system/session-owner.check.ts`

Owner read: `packages/ui/src/components/system/session-owner.ts`. Production callers: SystemPanel, process tree actions and SessionChip. Independent source (B1): SystemProcessInfo/KillProcessErrorCode protocol and archived project privacy boundary. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Archived/missing session ownership leaks a title or valid active sessions cannot navigate to their owning project. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

KEEP each original assertion group:

- KEEP visible session names its project and title — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP archived project/workspace, missing-project and unknown sessions disclose no title — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP unloaded project is resolved from the owning workspace path — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.

## `packages/ui/src/components/system/system-format.check.ts`

Owner read: `packages/ui/src/components/system/system-format.ts`. Production callers: SystemPanel, process tree actions and SessionChip. Independent source (B1): SystemProcessInfo/KillProcessErrorCode protocol and archived project privacy boundary. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Orphan tmux roots/descendants disappear, cyclic PID input hangs, rolled-up memory is wrong, kill targets include the wrong PIDs, or daemon protection codes become unclassified. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

KEEP each original assertion group:

- KEEP orphan tmux pane and daemon roots preserve all descendants; subtree RSS/PIDs are correct kill targets — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP recycled-PID cycle terminates and preserves processes — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP self-parenting process remains a root — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP recognized API kill refusal codes survive; unknown/network/null errors remain unclassified — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.

## `packages/ui/src/components/topbar/usage-format.check.ts`

Owner read: `packages/ui/src/components/topbar/usage-format.ts`. Production callers: UsageChip and UsageDetailsPanel, app usage events. Independent source (B1): ProviderUsageWindow sparse update API and persisted UsagePrefs settings. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: The wrong usage driver is selected, disabled agents are fetched, scoped usage disappears without base windows, or credit capacity/reset data is lost. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

KEEP each original assertion group:

- KEEP busiest/pinned/missing-pinned/empty driver selection reflects UsagePrefs — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP only enabled agents missing from current usage require fetching — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP unknown windows stay absent; scoped usage remains available independently of session/week — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.
- KEEP Grok capacity numbers and reset time survive normalization with credits unit — B1 protocol/requirement above; B2 wrong caller-visible result; B3 fixed expected data; B4 exported production conversion; B5 representation-independent data checks; B6 no stronger conversion owner.

## `packages/ui/src/components/topbar/usage-format.test.ts`

Owner read: `packages/ui/src/components/topbar/usage-format.ts`. Production callers: UsageChip and UsageDetailsPanel, app usage events. Independent source (B1): ProviderUsageWindow sparse update API and persisted UsagePrefs settings. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Sparse usage events erase unnamed windows or duplicate values already owned by the daemon poll. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a sparse update replaces only the windows it names | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| DELETE | an empty update is a no-op, not a reset | Redundant subset of sparse-update preservation: the existing omitted-weekly-window case exercises the same contract. |
| KEEP | a window the daemon's own poll already covers is dropped, not printed twice | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/agent-auth-notice.test.ts`

Owner read: `packages/ui/src/lib/agent-auth-notice.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Dismissed auth errors continually reappear on provider refresh, or changed provider/auth outcomes fail to raise a new notice. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a dismissal sticks across the re-publish the provider load causes | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a DIFFERENT message on the same provider still gets through | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the same message on a different provider still gets through | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the key spans [adapterId, status, auth.status, message] (T3's banner key) | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/agent-chat-active-tab.test.ts`

Owner read: `packages/ui/src/lib/agent-chat-active-tab.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Mounted hidden chats capture keys, terminal/no-selection state retains a chat owner, stale unmount clears a newer claim, or activation closes a just-subscribed popover. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | only the published tab is active; every other mounted tab is not | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | no chat tab showing means no chat tab owns the keyboard | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | subscribers see each change once and never a repeat of the same id | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a tab releases the keyboard only while it still holds it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a fast switch keeps the newcomer's claim when the old tab unmounts after it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the active chat tab is the one showing, not merely one that is mounted | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a terminal tab on screen means NO chat tab owns the keyboard | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | no active tab, or an id naming none, owns nothing | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a popover subscribed while its unfocused grid cell is being activated stays open | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/agent-profile/app-wiring.test.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Stream dispatch drops correctly channeled updates or applies identical payloads delivered on an unrelated channel; direct store tests cannot detect this routing error. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | agentProfile.changed on the agent-profile channel refetches the loaded agent | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the same message on another channel does not | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| DELETE | a malformed payload is ignored without a throw | Duplicate malformed-event test at extra layer; store.test.ts asserts an already populated store is preserved, a stronger oracle. |
| DELETE | ˋ${name} resets them before it switches the clientˋ | Source-shape grep depends on local method spelling and set-call ordering. Store reset/connection-switch tests exercise actual outcomes. |

## `packages/ui/src/lib/agent-profile/store.test.ts`

Owner read: `packages/ui/src/lib/agent-profile/store.ts`. Production callers: AgentProfilePanel, AgentProfilePanelView, ProfileItemRow, editor forms/host and app store. Independent source (B1): Agent profile spec §§3–8; API profile wire requests; AGENTS.md validation/unknown-field retention. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Malformed wire data poisons state, stale async replies resurrect/overwrite rows, scopes/connections leak into one another, reconnect/event invalidation never refreshes, concurrent requests duplicate, mutation errors/optimistic rollback disappear, or device preferences are lost. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | keeps a well-formed snapshot as it is | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | refuses a snapshot that names no known agent | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | drops malformed items rather than failing the snapshot, and keeps the first of a duplicate id | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | fails permissions closed and locks everything on a locked item | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | repairs the source, the warnings and the meta | Retain tolerant source/warning/meta validation and externally supplied labels; remove the generated fallback label wording assertion. B1 payload validation, B2 invalid metadata reaching the UI, B3 malformed fixed fixtures, B4 real sanitizer, B5 semantic data only, B6 client boundary ownership. |
| KEEP | repairs the instructions and the file errors, and tolerates a missing list | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | sanitizes the overview: known agents once, counts of known kinds only | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | loads a snapshot, and a second unforced load asks nothing | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | is single-flight: concurrent callers share one request | Delete promise-identity constraints; retain request coalescing observed at public daemon API. |
| REWRITE | a forced load during one in flight asks once more after it — shared by every forced caller | Delete promise-identity constraints; retain request coalescing observed at public daemon API. |
| KEEP | a first load that fails is an error; a refresh that fails keeps the snapshot beside the error | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | keeps the daemon's code (a not-installed agent) and names a route this daemon lacks | Keep the daemon AGENT_NOT_INSTALLED code used by the panel; remove generated unsupported-route sentence matching. B1 daemon refusal protocol, B2 picker incorrectly treats an absent agent as actionable, B3 literal error code, B4 real store load, B5 semantic code independent of copy, B6 only store owns refusal preservation. |
| KEEP | an answer for another agent or in a bad shape is an error, not state | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | loads the overview, sanitized | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | marks everything loaded stale on a reconnect, and a load crossing it asks again | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | refetches a loaded agent whose revision moved | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | does nothing for the revision already held | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | does not fetch an agent that was never loaded | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | refreshes a loaded overview too | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a change during an agent's FIRST load asks once more after it (that answer may predate the change) | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | ignores a malformed payload or another type without a throw | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | replaces the snapshot with the answer's and says so, the change carrying the item's revision | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | the daemon's notes become the notice | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | a 409 PROFILE_CONFLICT refetches the agent and says it changed on disk | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | another refusal becomes the notice in the daemon's words | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | AGENT_NOT_INSTALLED refetches the agent and the overview (the picker learns it) | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| REWRITE | a copy lands the TARGET's snapshot on the target | Keep changed data, conflict/refusal code, pending state and daemon error/notes; remove exact locally generated success/error sentence assertions. |
| KEEP | a copy whose name is taken answers ITEM_EXISTS quietly; the retry carries onConflict | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an answer whose snapshot does not parse refetches instead | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a load that started before a mutation answered does not overwrite the mutation's snapshot | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | forgets everything, and an answer in flight across it is dropped | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a client of another connection resets first | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | after a reset an event refetches nothing (no client bound) | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | parses field by field, and anything unusable is no pick | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | serializes over what another bundle stored, keeping its fields | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | reads the stored pick once, remembers a new one, and survives a store reset | Use global browser localStorage with descriptor restoration; remove production-only storage injection/reset hook and write-count constraint. |
| REWRITE | a storage that throws leaves the pick in memory | Use global browser localStorage with descriptor restoration; remove production-only storage injection/reset hook and write-count constraint. |

## `packages/ui/src/lib/app-config.check.ts`

Owner read: `packages/ui/src/lib/app-config.ts`. Production callers: app store, MainView, launchers and chat preference controls. Independent source (B1): AGENTS.md tolerant browser persistence and chat preference/unread contracts. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Corrupt localStorage crashes startup, an invalid field discards valid neighbors, absent fields overwrite host defaults, or a legacy usage value fails the client aggregate migration. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

REWRITE: delete standalone normalizeUsagePrefs schema passthrough/current/legacy/garbage cases; `packages/config` owns that migration. KEEP complete `sanitizeStoredAppConfig` mixed valid/invalid input, missing host defaults, malformed blobs and malformed nested usage isolation. B1 AGENTS.md migration/validation, B2 no client startup crash or overwritten host defaults, B3 literal legacy fixture/results, B4 adapter sanitizer, B5 no schema-internal assertions, B6 aggregate localStorage shape is distinct from config schema.

## `packages/ui/src/lib/chat-prefs.test.ts`

Owner read: `packages/ui/src/lib/chat-prefs.ts`. Production callers: app store, MainView, launchers and chat preference controls. Independent source (B1): AGENTS.md tolerant browser persistence and chat preference/unread contracts. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Old/corrupt preference records overwrite defaults, wrong types enter UI state, or unknown permission modes reach launches. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a missing or non-object blob falls back whole | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a blob from an older bundle keeps the fields it does have | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | wrong-typed fields are dropped, not coerced | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | only known permission modes survive the per-agent map | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an agent with no remembered mode gets the full-access default | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/composer-inbox.test.ts`

Owner read: `packages/ui/src/lib/composer-inbox.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Pre-mount delivery is lost, mounted delivery is replayed, closed sessions retain prompts, or content/attachments cross session boundaries or lose order. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a delivery made before the composer mounts is waiting for it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a mounted composer receives deliveries directly and nothing queues | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | after unsubscribing, deliveries queue again | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | deliveries are per session and never cross | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | clearing a closed tab drops what was queued for it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a delivery becomes draft text plus one attachment path per line | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | either half alone stands on its own, and an empty delivery is empty text | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | merging keeps order and concatenates attachments | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/copy-produced.test.ts`

Owner read: `packages/ui/src/lib/copy-produced.ts`. Production callers: CopyButton. Independent source (B1): Async Clipboard API gesture timing and rejected promise behavior; credible Safari copy regression. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Safari receives the write after user activation expires, unread/truncated data is copied, rejected reads become unhandled rejections, or fallback clipboard support drops valid text. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a string is written with writeText at once, inside the click | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a text still being read starts write() inside the click, and copies it once read | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | without ClipboardItem, or without write(), a text being read falls back to writeText once read | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a read that fails copies nothing down either path, and never the cut text | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a write refused without reading its item leaves nothing unhandled when the read fails too | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | with no async clipboard at all (an insecure origin) nothing is copied, and a failing read is still observed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/file-icon.test.ts`

Owner read: `packages/ui/src/lib/file-icon.ts`. Production callers: FilePreview and FileTypeIcon attachment rendering. Independent source (B1): Filename/MIME classification boundary; malicious Object.prototype-named input crash regression. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Untrusted Object.prototype-named filename/MIME selects a non-icon prototype member and crashes attachment rendering. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | reads only its own table keys: a name or mime spelled like an Object.prototype member is unknown | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/file-kind.test.ts`

Owner read: `packages/ui/src/lib/file-kind.ts`. Production callers: FilePreview and FileTypeIcon attachment rendering. Independent source (B1): Filename/MIME classification boundary; malicious Object.prototype-named input crash regression. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Prototype-named extensions return a non-kind value, archive suffixes select the wrong preview, or uppercase extension classification fails. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | never resolves a prototype member: an extension like ˋconstructorˋ is the text fallback | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | classifies by lowercased extension and collapses .tar.* names | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/launch-models.test.ts`

Owner read: `packages/ui/src/lib/launch-models.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Launch requests omit/reuse unavailable model IDs, default selection becomes nondeterministic, or model search removes the current/default selection needed by the user. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a launch always names a model, so the host cannot refuse it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the remembered pick wins while the catalogue still serves it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a remembered pick the catalogue dropped falls back to the default | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | two models flagged default resolve deterministically to catalogue order | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | no default flag at all falls back to the first entry | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | no catalogue yields null, so the caller can refuse instead of posting | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the selected model is always shown, even when a query excludes it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the catalogue default stays one click away when it is not the selection | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | search matches the slug or the display name, case-insensitively | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a query with no match shows nothing but the selection | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/open-layers.test.ts`

Owner read: `packages/ui/src/lib/open-layers.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Nested layer release closes another layer, duplicate cleanup corrupts the open-layer count, or Escape cannot identify the topmost layer. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a layer counts as open from its opening until its release | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | nested layers count separately: closing the inner one leaves the outer one open | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a release runs once in effect: a second call never closes another layer | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a tracked layer knows when a newer one (a dropdown inside a sheet) is above it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/preferred-model.test.ts`

Owner read: `packages/ui/src/lib/preferred-model.ts`. Production callers: app store, MainView, launchers and chat preference controls. Independent source (B1): AGENTS.md tolerant browser persistence and chat preference/unread contracts. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Stored option values of the wrong type enter launch requests, remembered options leak to another model, or invalid storage aborts launch. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | round-trips model and options, and drops what it cannot type | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | launch carries the remembered options only for the remembered model | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | garbage storage loads as empty rather than throwing | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/prompt-history/checkpoints.logic.test.ts`

Owner read: `packages/ui/src/lib/prompt-history/checkpoints.logic.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Unavailable checkpoints are offered, history overwrites the live fold, steer/autonomous turns get the wrong origin or rewind opener, totals are wrong, or prompt/path search misses matches. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | lists only ready checkpoints, newest turn first | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | adds the older ones only a loaded history page carries; the fold's copy wins | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | is its turn's, for a prompt that started one | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | is none for a steer — it rides a turn another prompt opened | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | counts files and sums the lines | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | names what opened each turn, newest first | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | goes back to whichever user message opened the turn, and to none the agent opened | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | numbers a card by its turn's ordinal, falling back to the checkpoint's own count | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | matches the opening prompt and the changed paths together | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/prompt-history/index-cache.test.ts`

Owner read: `packages/ui/src/lib/prompt-history/index-cache.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Concurrent prompt reads duplicate, failed pages erase loaded prompts, old hosts are retried endlessly, catching-up state loses retryability, cursors skip/duplicate rows, or cut text stays permanently failed. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | coalesces a session's first page and caches its prompts | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | falls back for a host without an index, and does not ask it again | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | asks a host without an index once more when the thread says its history is indexed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | falls back on a failure, says why, and retries on request | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | keeps catching-up state during retries until the index answers | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | turns a failed re-ask into a failure the user can retry, and a terminal answer into no index | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | appends the next page once per message and moves the cursor | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | keeps what it has when an older page fails, and retries it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | wants the next older page only when one exists and nothing is in the way | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | reads as paging while a page is on its way or the next one is due | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | reads a cut prompt once, and again only after a failure | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | keeps asking while the list holds less than a page and the host has more | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/prompt-history/prompts.logic.test.ts`

Owner read: `packages/ui/src/lib/prompt-history/prompts.logic.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Overlapping history duplicates prompts, subagent/internal messages become reusable, rewind removes a prompt but its index copy survives, ordering/turn association changes, or multi-word search misses matches. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | numbers opening prompts by started turns and keeps the first claim | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | walks the pages, the bridge, then the window — parent user messages only, once each | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | lists the parent's reusable prompts newest first, with the turn each one started | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | leaves out what nobody typed, and says what it was | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | numbers a pending prompt when its turn starts | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | keeps the chat's copy of a prompt both hold, and adds what only the index has below it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | drops an index entry whose turn the fold no longer knows — a rewind removed it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | merges by time, newest first, each list keeping its own order; a tie keeps the loaded prompt first | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | lists an index prompt once even when two pages carried it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | needs every word, in any order | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | shows all prompts for a blank query | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/prompt-history/rewind.logic.test.ts`

Owner read: `packages/ui/src/lib/prompt-history/rewind.logic.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Compaction is missed outside visible rows, unsupported/busy chats rewind, stale row counts are guessed, an in-flight send races rewind, or page/rewind failure is reported as success. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | finds a compaction the settled turn's fold hides from the rows | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | takes the newest across the loaded pages, the bridge and the window | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | reads a rendered prompt's verdict off its row | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | is never offered where the adapter cannot roll back, or for a prompt that started no turn | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | vouches for an index-only prompt by its page's ˋrewindableˋ, unless a compaction came since | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | rewinds a rendered prompt to its row's count, without paging anything in | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | brings an older prompt in first, then reads its count off the fresh rows | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | refuses when the reveal shows the turn but still not the prompt's row — no count the rows did not vouch for | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | says why the reveal could not bring the prompt in, or that its row withholds it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | reads a reveal that threw as a history page that failed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | waits for the agent to be idle — before it starts, and again after paging in | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | waits for a composer send still on its way, read fresh at each step | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | never offers what the adapter cannot do, nor a prompt that started no turn | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | says why the rewind failed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/prompt-history/thread-inputs.test.ts`

Owner read: `packages/ui/src/lib/prompt-history/thread-inputs.ts`. Production callers: HistoryPanel, PromptCard, CheckpointCard and history thread selectors. Independent source (B1): Chat history/checkpoint/rewind requirements and thread prompt/history wire contract. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Token-only streaming invalidates history subscriptions despite the external-store selector requirement, or busy/approval/rewind changes fail to update the panel. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | hands back the same value while a turn's answer streams | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| REWRITE | moves when what the panel shows moves: the turn settling, a request docking, a rewind | Remove changed-object identity assertion; retain busy/approval/rewind data used by the panel. |

## `packages/ui/src/lib/regexp.test.ts`

Owner read: `packages/ui/src/lib/regexp.ts`. Production callers: FilePreview, composer attachments and timeline token splitting. Independent source (B1): ECMAScript regular expression literal escaping including Unicode mode. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: A literal user metacharacter acquires regex syntax, matches the wrong text or cannot compile under Unicode regex mode. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | escapes every metacharacter so the escaped form matches the literal | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/saved-prompts/app-wiring.test.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Stream dispatch drops correctly channeled updates or applies identical payloads delivered on an unrelated channel; direct store tests cannot detect this routing error. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | an upsert and a delete on the saved-prompts channel reach the store | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | the same message on another channel does not | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/saved-prompts/list.logic.test.ts`

Owner read: `packages/ui/src/lib/saved-prompts/list.logic.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Another project's prompts leak into the list, case/accent/word matching misses valid prompts, edits remain cached under stale text, or favorites lose their independently required separate section. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | the project can use every global prompt and its own, never another project's | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | All is global + this project's; Project is this project's only | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | folds the letters no decomposition takes apart: ł, ø, ß and their capitals | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | matches title, description, tags and body, case- and accent-insensitively | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | every word must match, each anywhere | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an edited record is searched by its new text | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | favorites are separated from unpinned prompts | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/saved-prompts/store.test.ts`

Owner read: `packages/ui/src/lib/saved-prompts/store.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Malformed wire data poisons state, stale async replies resurrect/overwrite rows, scopes/connections leak into one another, reconnect/event invalidation never refreshes, concurrent requests duplicate, mutation errors/optimistic rollback disappear, or device preferences are lost. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | repairs optional fields and refuses what cannot be trusted | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | shares concurrent loads and refreshes only when stale or forced | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | no project loads the global list alone | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a reload replaces exactly its scope: what the daemon dropped goes, another project's stays | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an event that overtakes the load answer it is newer than survives the answer | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an answer never brings back a prompt deleted meanwhile, nor overwrites a newer copy | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an id nothing touched during the load takes the answer as-is, even stamped older | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a first load that fails is an error; a failed refresh keeps the rows beside the error | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a forced load asked while one is in flight asks again after it — once, for every such call | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a project list the daemon refuses (400) falls back to the global list, and says why | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | any other failure of a project list does not fall back | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an answer of the wrong shape is a load error, not a crash | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a malformed row is dropped, the rest of the answer kept | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | stale marks a reconnect: the rows stay and the next load refreshes in the background | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a load that crosses a reconnect asks once more, then is fresh | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a failed load that crossed a reconnect retries once, not forever | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an older record never replaces a newer one; a later use does | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a delete removes, and nothing brings the id back | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | malformed payloads and unknown types are ignored without a throw | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an update applies its answer; a delete removes and tombstones | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a failed change becomes the notice and reloads every loaded scope | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a quiet failure leaves the notice to the caller | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a pin shows at once, then carries the daemon's record | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a refused pin falls back to the held value, with the notice | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | two quick flips: only the latest answer clears the flip | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a use bumps the record; a failed bump is silent and reloads nothing | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | forgets everything, and an answer from before it is dropped | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a reset before the request left sends nothing | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a client of another connection starts over | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a mutation answered after a reset is not applied | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/saved-prompts/variables.test.ts`

Owner read: `packages/ui/src/lib/saved-prompts/variables.ts`. Production callers: SavedPromptsPanel, SavedPromptEditor and app store event routing. Independent source (B1): Saved-prompt public API scope/template contract and README right-rail workflows. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: A no-chat template leaks a previous agent/model or a real selected registry/catalog identity loses its label/fallback. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | renders both as empty without a target chat | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | labels an agent by its registry name and a model by its catalogue name, else the raw id | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/session-kind.test.ts`

Owner read: `packages/ui/src/lib/session-kind.ts`. Production callers: MainView, NewTabMenu, ProjectOverview, ChatComposer and app store. Independent source (B1): Chat GUI migration, model launch, keyboard ownership, composer delivery and attention contracts. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Legacy terminal/chat kinds overlap, unavailable adapters are offered for resume, or seed titles overwrite a user-chosen title. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | the three session kinds are classified without overlap | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | ProjectOverview offers a row only while its agent is installed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | NewTabMenu lists a row under the agent that wrote it | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a conversation whose agent has no adapter is not offered | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | only a title nobody chose may be overwritten by the seed | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/thread-visits.test.ts`

Owner read: `packages/ui/src/lib/thread-visits.ts`. Production callers: app store, MainView, launchers and chat preference controls. Independent source (B1): AGENTS.md tolerant browser persistence and chat preference/unread contracts. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: Corrupt visits poison unread state, wall-clock visits hide newer completions, older reads regress a watermark, mark-unread changes another thread, or running/unvisited chats become falsely unread. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a junk blob loads as empty and bad entries are dropped | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | reading a thread stamps the TURN'S COMPLETION, never the clock | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a thread whose latest turn never completed has nothing to read | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | visits are monotonic: an older stamp never moves the mark back | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| DELETE | an unparseable visit stamp is ignored without changing the stored data | Duplicate of the no-completed-turn and monotonic-read cases in this file. |
| REWRITE | mark-unread stamps one millisecond before the completion | Assert unread state and unchanged other thread instead of freezing the private timestamp-offset encoding. |
| KEEP | mark-unread is a no-op without a completed turn, and is idempotent | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a never-visited thread is not unread, and a running turn is never unread | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | an unreadable visit stamp reads as unread rather than silently read | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

## `packages/ui/src/lib/transporters/http-transporter-stream.test.ts`

Owner read: adjacent production modules listed by the callers below; exact owners and dependencies were read before editing. Production callers: ApiClient stream consumers in web and desktop transports. Independent source (B1): Transporter.openStream public callback lifecycle and HTTP response status semantics. Lower-seam owner retained: this file for the listed unique behavior; shared API/daemon validation remains in its owning package.

Isolated-owner failure model considered before retention: HTTP errors are delivered as stream data, failed responses omit/duplicate lifecycle callbacks, or successful chunks fail to end once. Each named row below is a distinct fixed input/outcome that fails for the corresponding regression; the title is the exact expected behavior, and its negation is the observed failure.

| Disposition | Original test | Failure / reason |
|---|---|---|
| KEEP | a non-2xx answer is one error and one end — its JSON body is never stream data | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |
| KEEP | a 2xx body streams, then ends once | KEEP the exact named outcome: the failure model and independent source above identify B1/B2; fixed cases, production-used seam, data-only oracle and unique layer ownership satisfy B3–B6. |

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
- Final focused run across all 39 retained `.test.ts` files: **298 tests, 60 suites, 0 failures, 0 skipped**. Log: `/tmp/ui-other-final-tests.log`.
- Four retained check scripts passed: `app-config.check.ts`, `system-format.check.ts`, `session-owner.check.ts`, `usage-format.check.ts`.
- `pnpm --filter @orquester/ui typecheck` passed both before and after removal of render-only props and orphaned exports.
- Follow-up import/selector cleanup: **41 tests passed** across profile store, app wiring and editor saved publication. Final generated-copy pruning: **37 store tests passed**, no failures/skips. Logs: `/tmp/ui-other-final-seam-tests.log`, `/tmp/ui-other-final-store-tests.log`.
- `git diff --check` passed. Final source/test diff reviewed; every removed injection branch preserved the production default, and callers were searched across the repository.
- Root owns final repository test/typecheck/build gates, remote integration, commit and push. No baseline product failure was found, no coverage/test-count conflict appeared, and no user workflow/E2E artifact contract was removed.
