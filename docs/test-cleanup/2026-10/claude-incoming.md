# Incoming Claude settings audit

Incoming commit: `af85b3ff8d9e244e31e768ea8c235bb7bc237a59`, merged through `origin/main` `7feff9eb`. This addendum audits every new or modified named test in that commit, including the two migrated declarations in the deleted `settings-node-options.test.ts`. Earlier unchanged Claude tests remain in [the main ledger](claude.md).

Audit: 17 declaration rows: 0 DELETE, 3 REWRITE, 0 OPTIMIZE, 10 CONSOLIDATE, 4 KEEP. Seven rows are removed owners/migrations and ten describe surviving owners. Relative to the merged pre-cleanup snapshot, the two affected test files go from 49 to 44 declarations and 879 to 828 test lines (**-51 LOC**). The deleted-file migration happened upstream; it is counted in the audit ledger, not claimed as a new cleanup deletion.

Cleanup removes filesystem read-recording support, four redundant launch executions and a separate host-settings fixture. The auto parser becomes private because only its launch builder calls it; expected values are verified through SDK settings rather than its helper export. No snapshots, dependencies or configuration are removed by this incoming work. Integrated changed tests, workspace typechecks, the full build and the Windows regression probe have passed. Full-suite timing remains in progress; no incoming-only speedup is claimed.

## Independent sources

- [Claude settings files and precedence](https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository): documents cwd/project versus repository-root local settings, worktrees, legacy cwd compatibility, home/ownership exceptions, the Windows cwd rule, and flag/local/project/user precedence.
- [Claude environment variables](https://code.claude.com/docs/en/env-vars): documents settings env over inherited shell env, tool-search modes, and numeric scientific/digit-separator spellings.
- [Claude MCP tool search](https://code.claude.com/docs/en/mcp#configure-tool-search): documents deferred tools versus threshold-based auto loading and upfront false.
- [Agent Profiles §6](../../superpowers/specs/2026-10-18-agent-profiles-design.md) and [Ephemeral AI VMs](../../superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md) specify carried runtime settings and remote project/host account boundaries.
- Incoming commit message independently records the cache failure, user-choice preservation, clamping and invalid-suffix compatibility expected of this change. Fixture README was read; these configuration tests do not invent or modify provider traffic captures.

## Production regression corrected

Incoming settings resolution selected the remote repository root for every box platform. With a Windows box started below a repository, root `ENABLE_TOOL_SEARCH=auto` and cwd `false`, that picked auto and forced flag-tier true over the CLI’s explicit cwd false. The official settings reference expressly keeps the local file in cwd on Windows. `ClaudeSession.start` now passes `box.launch.sys.os` (or host `process.platform`), and the settings reader chooses cwd before git-root selection for win32. The existing remote settings owner checks conflicting fixed values for linux and win32. This is a minimal correction to documented behavior; other selection logic remains unchanged. No actual Windows process was launched; target-platform file resolution is the verified seam.

Non-test caller search: `claudeSettingsEnvs`, `claudeSettingsNodeOptions`, and `claudeToolSearchSetting` are used by `session.ts`; `claudeToolSearchOverride` has no caller outside `launch.ts` after the test rewrite, so its export was removed. `platform` is supplied by the real session/box path and is not a test-only injection.

## Declaration dispositions

| Path | Exact incoming test name | Disposition | Evidence and surviving owner |
|---|---|---|---|
| `apps/daemon/src/agent-host/adapters/claude/launch.test.ts` | maps Claude Code's auto modes to on and leaves every other value alone | **REWRITE** | Real compatibility contract trapped behind test-only exported helper; observe the actual SDK flag tier, prune equivalent/unsupported parser spellings, preserve meaningful mode/numeric boundaries. Owner: **matrix**. |
| `apps/daemon/src/agent-host/adapters/claude/launch.test.ts` | turns an auto mode on at the flag tier, since settings env beats the process env | **CONSOLIDATE** | Same auto SDK settings outcome now asserted in the matrix; process-env absence was incidental private representation. Owner: **matrix**. |
| `apps/daemon/src/agent-host/adapters/claude/launch.test.ts` | sits beside NODE_OPTIONS in the flag-tier env | **CONSOLIDATE** | Every matrix case now verifies the independent --preload survives beside the override. Owner: **matrix**. |
| `apps/daemon/src/agent-host/adapters/claude/launch.test.ts` | leaves the user's own choice and the default untouched | **CONSOLIDATE** | Default/true/false/endpoint values already occur in SDK-boundary matrix; original repeated launch setup added no unique regression. Owner: **matrix**. |
| `apps/daemon/src/agent-host/adapters/claude/launch.test.ts` | a profile chat overrides the carried user value in its settings file | **KEEP** | Distinct profile-file carried-env merge; Global inline settings cannot supersede it. Owner: **profile_launch**. |
| `apps/daemon/src/agent-host/adapters/claude/launch.test.ts` | a profile without built-in tools passes tools: [] and loads MCP tools up front | **CONSOLIDATE** | Surviving existing recipe owner now starts with carried ENABLE_TOOL_SEARCH=true and verifies flag-tier false along with its existing tools/preapproval/result-limit contracts. Owner: **no_tools**. |
| `apps/daemon/src/agent-host/adapters/claude/launch.test.ts` | a profile without built-in tools keeps tool search off over a carried user value | **CONSOLIDATE** | Move flag-tier override into existing no-builtins launch scenario and remove second full launch construction. Owner: **no_tools**. |
| `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts` | a box chat reads the project's settings in the box and the user's on the host | **REWRITE** | Replace filesystem read inventories with independent host-only value plus remote-only value; removes read-recording support. Owner: **box**. |
| `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts` | without a box filesystem the project files are read on the host | **CONSOLIDATE** | Host NODE_OPTIONS values move into the existing global precedence sequence and profile precedence owner; no additional temp root/scans needed. Owner: **global**. |
| `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts` | ENABLE_TOOL_SEARCH: local over project over user over the process env | **CONSOLIDATE** | Surviving precedence sequence covers both consumer keys from each single settings read. Owner: **global**. |
| `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts` | ENABLE_TOOL_SEARCH in a profile chat: the carried user value wins; an isolated one reads the user's only | **CONSOLIDATE** | Surviving profile/isolated owner also covers NODE_OPTIONS precedence and retains carried-user plus no-project isolation. Owner: **profile**. |
| `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts` | the local file is read at the repository root, over one left in a subdirectory cwd | **KEEP** | Distinct documented repository-root/legacy-cwd location contract with independent real files. Owner: **root**. |
| `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts` | a worktree's local file is its main checkout's | **KEEP** | Distinct real git worktree compatibility and foreign-backlink rejection; retains actual git construction. Owner: **worktree**. |
| `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts` | a repository rooted at the home keeps its local file in the cwd | **KEEP** | Documented home-root exception cannot be inferred from ordinary repository cases. Owner: **home**. |
| `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts` | a box chat finds the repository root in the box | **REWRITE** | Drop read-call assertion, use valid .git directory fixture, and extend the same scenario with the independently specified Windows cwd distinction. Owner: **box_os**. |
| `apps/daemon/src/agent-host/adapters/claude/settings-node-options.test.ts` | a box chat reads the project's settings in the box and the user's on the host | **CONSOLIDATE** | Incoming commit already migrated this declaration to settings-env.test.ts; preserve its filesystem boundary with stronger value assertions. Owner: **box**. |
| `apps/daemon/src/agent-host/adapters/claude/settings-node-options.test.ts` | without a box filesystem the project files are read on the host, as before | **CONSOLIDATE** | Incoming migration plus this consolidation retains global and profile NODE_OPTIONS semantics in the surviving settings owners. Owner: **profile**. |

## Six behavioral requirements for each surviving owner

### matrix: auto tool-search modes reach the flag tier alongside NODE_OPTIONS; explicit choices stay untouched

Path: `apps/daemon/src/agent-host/adapters/claude/launch.test.ts`.

1. **Independent contract:** Incoming af85b3ff documented cache/explicit-choice requirement; official Claude MCP/env references document true/false/auto:N, thresholds and numeric spellings.
2. **Real regression detection:** Auto modes remain threshold-based and invalidate prompt caching, an explicit off choice is overridden, or adding ENABLE_TOOL_SEARCH drops NODE_OPTIONS.
3. **Independent oracle:** Literal true/undefined per input and literal --preload at settings.env; expected values never invoke production parsing.
4. **Stable seam:** buildClaudeQueryOptions SDK settings.env, the actual CLI flag-tier contract.
5. **Refactor resistance:** Parser/helper names and algorithm may change freely; the test imports only the existing launch builder.
6. **Unique protection:** Lowest launch boundary for Global tool-search rewriting and merging with NODE_OPTIONS; profile-file merge and settings-file location tests exercise different failures.

### profile_launch: a profile chat overrides the carried user value in its settings file

Path: `apps/daemon/src/agent-host/adapters/claude/launch.test.ts`.

1. **Independent contract:** Agent Profiles design §6.0/6.1 carries runtime settings at the flag tier; af85b3ff auto-mode correction must beat that carried env.
2. **Real regression detection:** Carried auto wins over true, a carried token disappears, or an explicit carried false is replaced.
3. **Independent oracle:** Exact independent file.env objects {TOKEN:carried-secret, ENABLE_TOOL_SEARCH:true} and {ENABLE_TOOL_SEARCH:false}.
4. **Stable seam:** Profile settings file contents returned by SDK launch construction.
5. **Refactor resistance:** Observes persisted CLI-facing settings fields, not private merge calls or helper shape.
6. **Unique protection:** Global matrix emits inline SDK settings and cannot detect a broken carried-settings file merge.

### no_tools: a profile without built-in tools passes tools: [] and loads MCP tools up front

Path: `apps/daemon/src/agent-host/adapters/claude/launch.test.ts`.

1. **Independent contract:** Agent Profiles/Knowledge managed-profile contract: tools:[] means no ToolSearch; MCP tools must load upfront; carried user runtime env must survive.
2. **Real regression detection:** A carried true defers MCP tools that the no-builtins agent cannot discover, builtins reappear, large MCP results truncate, or session-tool preapproval disappears.
3. **Independent oracle:** Literal tools:[], flag env false with TOKEN intact, process false/MAX_MCP_OUTPUT_TOKENS60000, fixed allowed tool and ordinary profile absence.
4. **Stable seam:** SDK launch options and CLI profile settings file.
5. **Refactor resistance:** No assertions on helper names, merge order or internal calls; only supported SDK/settings keys.
6. **Unique protection:** Special managed-profile recipe overrides true even though normal profiles preserve it; neither Global matrix nor normal-profile merge owns that policy.

### box: a box chat reads the project's settings in the box and the user's on the host

Path: `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts`.

1. **Independent contract:** Ephemeral AI VMs design §8.5/8.7: project bytes live remotely; account user configuration remains host-owned.
2. **Real regression detection:** Reading project settings on host loses --from-box-project, or reading user settings remotely loses the host-only false.
3. **Independent oracle:** Independent remote NODE_OPTIONS --from-box-project and real host user ENABLE_TOOL_SEARCH false, deliberately split across the two filesystems.
4. **Stable seam:** Configuration reader applied to real host account file plus a byte-only remote filesystem fixture.
5. **Refactor resistance:** Read ordering, batching, extra harmless reads and helper structure may change; removed all read-call inventories.
6. **Unique protection:** Host precedence cannot detect accidental use of host filesystem for box project bytes; root-location test has no host account fixture.

### global: ENABLE_TOOL_SEARCH: local over project over user over the process env

Path: `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts`.

1. **Independent contract:** Official settings/env references define local > shared project > user > shell; NODE_OPTIONS plugin contract preserves the settings value before the plugin preload. Incoming contract conservatively avoids overriding unknown non-string tool-search values.
2. **Real regression detection:** A lower source wins, shell auto beats settings false, missing settings synthesize a value, or NODE_OPTIONS lookup is lost during settings-reader extraction.
3. **Independent oracle:** Literal --user/--project/--local and auto/false/auto:30 values after incremental real-file writes; non-string highest value yields undefined.
4. **Stable seam:** Real settings files through configuration reader and its two consumer-value projections.
5. **Refactor resistance:** No read-list or object traversal assertions; any equivalent file parser and precedence implementation passes.
6. **Unique protection:** Owns host/global precedence for both keys; launch tests receive an already-resolved value and cannot detect wrong file precedence.

### profile: ENABLE_TOOL_SEARCH in a profile chat: the carried user value wins; an isolated one reads the user's only

Path: `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts`.

1. **Independent contract:** Agent Profiles design §6.0/6.1 carries user runtime keys at flag tier; no-builtins managed profiles load no project settings.
2. **Real regression detection:** Project/local false or --local wins over carried user auto/--user, isolated sources omit carried user keys, or isolated sources leak project values when the user key is absent.
3. **Independent oracle:** Literal auto/--user for profile and isolated sources; after clearing user env, both values are undefined despite conflicting project/local files.
4. **Stable seam:** Real settings files at the profile/isolated configuration boundary.
5. **Refactor resistance:** Asserts resolved values only; no exact file-read inventory or source implementation shape.
6. **Unique protection:** Global precedence is intentionally different. Launch recipes cannot detect a settings reader that picked the wrong source before construction.

### root: the local file is read at the repository root, over one left in a subdirectory cwd

Path: `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts`.

1. **Independent contract:** Official settings reference specifies shared settings at cwd, local settings at repository root, and compatibility with older cwd local files.
2. **Real regression detection:** Repository-root shared settings incorrectly apply, a legacy cwd local file is lost, or it overrides the root local value.
3. **Independent oracle:** Independent absent -> auto -> false results while separate literal files are added to a real git repository.
4. **Stable seam:** Real filesystem and real git-created repository; resolved tool-search configuration.
5. **Refactor resistance:** No git administrative-name, read count or private path-picker assertions.
6. **Unique protection:** Global file precedence case runs outside a repository; worktree/root-home cases have different location-selection rules.

### worktree: a worktree's local file is its main checkout's

Path: `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts`.

1. **Independent contract:** Official settings reference explicitly shares the main checkout local file in worktrees; malformed foreign backlinks must not select another checkout configuration.
2. **Real regression detection:** A genuine worktree or its subdirectory misses main local settings, or a forged git pointer borrows that configuration.
3. **Independent oracle:** Literal auto from main for two genuine worktree locations and undefined for the forged foreign backlink.
4. **Stable seam:** Real git init/empty commit/worktree creation and filesystem configuration lookup.
5. **Refactor resistance:** Git writes its own protocol fixtures; no private path algorithm or guessed pointer text for positive cases.
6. **Unique protection:** Ordinary repository tests cannot exercise gitdir/commondir/backlink resolution. Real git setup remains because replacing it with parser-shaped fixtures weakens compatibility evidence.

### home: a repository rooted at the home keeps its local file in the cwd

Path: `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts`.

1. **Independent contract:** Official settings reference explicitly exempts repositories rooted at the CLI home from root-local selection.
2. **Real regression detection:** A home-root repository leaks its local auto setting to unrelated child cwd, or the exception erroneously applies to an ordinary root.
3. **Independent oracle:** Independent undefined with home equal to repo root and auto with a different home.
4. **Stable seam:** Real owned home-root git repository with distinct cwd and controlled CLI home.
5. **Refactor resistance:** No ownership helper calls, uid constants or directory traversal assertions.
6. **Unique protection:** Normal roots/worktrees do not exercise the documented home exception.

### box_os: a box chat reads the root local file on POSIX and the cwd local file on Windows

Path: `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts`.

1. **Independent contract:** Official settings reference explicitly keeps local settings at cwd on Windows; BoxKind supports Windows and BoxSysInfo.os is the real target OS.
2. **Real regression detection:** Windows root auto overrides cwd false and is promoted to forced flag true, or POSIX remote root discovery is lost.
3. **Independent oracle:** Independent conflicting root auto/cwd false; expected linux auto and win32 false. Original incoming implementation produces auto for win32.
4. **Stable seam:** Remote-filesystem configuration resolution parameterized by actual CLI platform, with valid .git directory metadata.
5. **Refactor resistance:** Observes resolved values and platform semantics; removed incidental read.includes assertion and invalid empty .git-file fixture.
6. **Unique protection:** Host-platform tests run on Linux; other remote case only separates filesystems. One declaration protects both supported target-platform choices without another setup-heavy test.

## Parser matrix pruning

The direct-helper matrix had 25 inputs. The surviving SDK matrix uses 13 independently supplied inputs: missing, true, false, auto, one interior threshold (25), endpoints 0/100, clamped -5/150, invalid suffix abc, scientific 1e1/1e2 and grouped 1_000. Multiple interior numbers, redundant unknown-value spellings and parser-prefix/fraction/whitespace variants had no distinct caller-visible outcome remaining beyond those owners. Those rows are not additional named tests; they are not claimed as declaration deletions. The preserved scientific and grouping cases distinguish real numeric normalization failures from the ordinary threshold and clamp cases.

## Validation and performance

Completed through the root-scheduled validation runs:

- `pnpm check:changed --no-cache --base 0e61cd5dfed987e9bcbafe097e2582f90586ef4f`: PASS. Integrated selection ran 16 daemon test files (36.6 s), 3 UI test files (14.9 s), and the selected typechecks (20.7 s).
- `pnpm check`: PASS across all workspaces, including the box-agent Go vet step.
- `TSX_DISABLE_CACHE=1 pnpm build`: PASS for all workspaces, including emitted web/desktop assets and Electron packaging.
- Focused `git diff --check` for the five changed Claude source/test paths: PASS.
- `python3 /tmp/orquester-test-audit/incoming-claude-windows-probe.py`: PASS. The current Windows/POSIX owner passed in an isolated temporary copy (exit 0, 2.664687 s wall; test body 22.193462 ms). Restoring the incoming unconditional root selection in a separate copy failed for the intended Windows assertion (exit 1, 1.829275 s wall; test body 22.025718 ms): `ERR_ASSERTION`, expected `false`, actual `auto`, with assertion label `win32`. The probe changed no shared production files.

Gate evidence is in `/tmp/orquester-test-audit/integrated-gates.log`; the probe completed in the separate successful `remaining-controls` run. Its exact commands and results are recorded in `/tmp/orquester-test-audit/incoming-claude/windows-probe.json` and the adjacent `windows-probe-control.log` and `windows-probe-original-root-selection.log`. Probe timings describe positive and negative controls, not a performance comparison.

The Windows evidence verifies target-OS configuration resolution against independent conflicting file values. No actual Windows CLI process ran. The repository-wide final `pnpm test` is still running; full-suite success and final performance are not yet claimed here.

Performance limits: incoming tests were not part of the original historical baseline. Report their observed timings from the integrated run, rather than attributing an isolated speedup. Real git setup remains for worktree compatibility because replacing it with handcrafted parser-shaped pointers would weaken that evidence.
