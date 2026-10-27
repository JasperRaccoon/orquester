# Standalone UI check scenarios

Four preexisting `.check.ts` files contain no Node `test` declarations. This separate ledger accounts for 79 logical input/scenario groups ({'KEEP': 48, 'REWRITE': 18, 'DELETE': 13}); it is **excluded from the master Node declaration count**. Retained scenarios: 66; net check LOC: -15.

Before selecting isolated unit cases, credible failures were enumerated: wrong process filter/sort/group/parent selection, invalid Stop eligibility, incorrect resource quantity/unknown state, title leaks through archived/worker ownership, lost kill refusal codes, wrong usage preference/available provider and dropped quota/capacity fields. Kept rows below own those distinct failures at the native production boundary.

Deleted work includes imported-default tautologies, exact indentation/CPU/duration formatting policy, a redundant shallower descendant count, an impossible self-parent process fixture, a second fixed-prefix bitrate copy, and hypothetical primitive kill-error probes. Rewrites observe buildRows instead of private collaborators, semantic identifiers instead of generated keys, unordered sets where order is incidental, and SI quantity/unknown meaning rather than exact strings.

The production owner only loses five test-only exports: DEFAULT_COLUMNS, compareRows, processMetrics, groupMetrics and groupRowKey. Repository-wide imports show TaskManager and OrquesterCore do not import those names; no barrel exposes them. Their internal algorithms remain unchanged. descendantCount stays public and keeps its strongest nested Stop-warning scenario because it has a real separate production caller.

Validation: scoped `git diff --check` passed. After the root granted the exclusive test slot, all four checks passed sequentially from `packages/ui` using the command below. Each printed its success receipt and the command exited 0. Final focused wall time 2.35 s (user 2.17 s, system 0.36 s); no comparable pre-edit focused measurement exists, so no speedup is claimed. Root owns whole-repository/typecheck gates and whole-suite timing.

```sh
/usr/bin/time -p bash -c 'for check in src/components/system/process-table.check.ts src/components/system/session-owner.check.ts src/components/system/system-format.check.ts src/components/topbar/usage-format.check.ts; do TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs "$check" || exit 1; done'
```

## `packages/ui/src/components/system/process-table.check.ts`

### KEEP — line 49: managed process scope

1. **Independent contract/source:** Orquester scope contains only daemon-managed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects listing unrelated host processes as Orquester-owned.
3. **Independent oracle:** Literal expected PIDs [10,11,12] with managed flags authored in host fixture.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 44.

### KEEP — line 50: command search ignores case

1. **Independent contract/source:** Command-line process search is case-insensitive. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects VITE search failing to find the node vite process.
3. **Independent oracle:** Literal query VITE and expected PID11.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 45.

### KEEP — line 51: numeric search targets exact PID

1. **Independent contract/source:** A numeric PID query selects the intended process. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects PID search selecting a different process or no process.
3. **Independent oracle:** Literal query20 and PID20.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 46.

### KEEP — line 52: user filter

1. **Independent contract/source:** User filtering restricts the table to the selected host user. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects another user's processes entering that filtered view.
3. **Independent oracle:** Root-owned fixture PIDs1 and20.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 47.

### KEEP — line 53: state filter

1. **Independent contract/source:** Status filtering selects processes in the requested state. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects sleeping processes shown under Running.
3. **Independent oracle:** Fixture running PID11.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 48.

### REWRITE — line 54: user choices are distinct

1. **Independent contract/source:** The user filter offers each reported username once. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects duplicate/missing user choices; incidental alphabetical presentation order is ignored.
3. **Independent oracle:** Independent set of fixture users orquester/root.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 49.

### KEEP — line 56: legacy daemon managed compatibility

1. **Independent contract/source:** Older daemon rows omitting managed still belong to its own process tree. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects older daemon process lists disappearing under Orquester scope.
3. **Independent oracle:** One literal legacy row without managed must survive.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 51.

### KEEP — line 59: legacy managed stop allowed

1. **Independent contract/source:** A normal managed process is offered Stop. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects Stop being unavailable for a valid legacy managed process.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 54.

### KEEP — line 60: daemon stop protected

1. **Independent contract/source:** The daemon itself is never offered Stop in legacy snapshots. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an unsafe daemon Stop action being offered.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 55.

### KEEP — line 61: legacy unmanaged stop refused

1. **Independent contract/source:** A legacy snapshot cannot authorize stopping an unmanaged process. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects UI offering a target that legacy kill routes refuse.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 56.

### KEEP — line 62: agent host stop protected

1. **Independent contract/source:** The agent host is protected when legacy role tags are present. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a Stop action that would interrupt every hosted chat.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 57.

### KEEP — line 65: explicit server stop allowance wins

1. **Independent contract/source:** The daemon may mark an own-user process outside its tree stoppable. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects refusing a valid own-user container/nohup target after the documented feature change.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 60.

### KEEP — line 66: explicit server stop denial wins

1. **Independent contract/source:** A daemon stoppable:false overrides the managed flag. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects offering Stop for protected infrastructure or another refused process.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 61.

### REWRITE — line 71: descending CPU with unknown last

1. **Independent contract/source:** CPU descending sorts measured values from largest to smallest and unknown readings last. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects unknown CPU sorting first or wrong data ordering; tied PID order is incidental.
3. **Independent oracle:** Fixed readings [30,5,0,0,null] and independent PID membership set.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 66.

### REWRITE — line 72: ascending CPU with unknown last

1. **Independent contract/source:** CPU ascending still places unknown readings after real zero readings. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects treating unknown as measured zero or reversing unknown placement with sort direction.
3. **Independent oracle:** Fixed readings [0,0,5,30,null].
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 68.

### REWRITE — line 73: name sorting

1. **Independent contract/source:** The Name column sorts process names alphabetically. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects incorrect lexical name sorting while tolerating arbitrary order among equal names.
3. **Independent oracle:** Literal process names bash/dockerd/node/node/systemd.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 69.

### REWRITE — line 76: descending uptime

1. **Independent contract/source:** Descending uptime puts the older process first. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects inverting start timestamp versus elapsed uptime.
3. **Independent oracle:** Literal start times1000/9000 and expected PIDs1/2.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 71.

### REWRITE — line 77: ascending uptime

1. **Independent contract/source:** Ascending uptime puts the newer process first. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects applying the descending comparator for both sort directions.
3. **Independent oracle:** Literal start times1000/9000 and expected PIDs2/1.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 72.

### KEEP — line 81: tree parent/child ordering

1. **Independent contract/source:** Tree grouping keeps children after their parent and sorts siblings by the selected metric. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a process appearing under the wrong parent or unsorted sibling branches.
3. **Independent oracle:** Authored PPID graph and literal expected PIDs[1,20,10,11,12].
4. **Stable seam:** buildRows tree model
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Flat/group tests cannot detect hierarchy traversal order.

Final anchor: 76.

### DELETE — line 82: tree indentation depth array

1. **Independent contract/source:** No independent visual regression requirement fixes numeric row-depth bookkeeping. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** The [0,1,1,2,2] array only detects implementation representation/indentation changes.
3. **Independent oracle:** Private model depths, not a user action or externally fixed byte.
4. **Stable seam:** buildRows depth field
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Parent/child process order and collapse remain protected by their semantic owners.

Failed bars: 1, 4, 5.

### KEEP — line 87: collapse hides descendants

1. **Independent contract/source:** Collapsing a parent hides its descendants while preserving its parent row and child metadata. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects toggling a process failing to fold the subtree or deleting the parent row.
3. **Independent oracle:** Literal remaining PIDs[1,20,10] and known direct children2.
4. **Stable seam:** buildRows with a user-toggled process key
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Expanded tree traversal does not exercise collapse.

Final anchor: 78.

### KEEP — line 91: filtered parent promotes children

1. **Independent contract/source:** Filtering out a parent must not discard its still-visible children. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a query-filtered process vanishing because its parent was omitted.
3. **Independent oracle:** Literal surviving child PIDs11/12.
4. **Stable seam:** buildRows tree model over filtered input
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Ordinary full trees contain their parents and cannot reveal this failure.

Final anchor: 82.

### REWRITE — line 92: recycled snapshot parent cycle terminates

1. **Independent contract/source:** A transient parent cycle in non-atomic PID snapshots must terminate without losing the listed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an infinite walk or omitted process after PID reuse across scan reads.
3. **Independent oracle:** Fixed PIDs40/41 and reciprocal PPIDs.
4. **Stable seam:** buildRows tree model
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Cycle-safe full-tree walking differs from ancestor-path walking; replace incidental row cardinality with actual PID preservation.

Final anchor: 83.

### REWRITE — line 96: name grouping and aggregate resources

1. **Independent contract/source:** Same-name processes form one group carrying their combined CPU/memory, sorted among single processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects duplicate groups, missing members or incorrect aggregate usage.
3. **Independent oracle:** Input name node, literal group order and sums30%/6000bytes.
4. **Stable seam:** buildRows name-group output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Use authored group name rather than groupRowKey-derived expected key; no stronger test owns group creation and totals.

Final anchor: 87.

### REWRITE — line 102: expanded group member ordering

1. **Independent contract/source:** Opening a name group reveals its process members in the selected CPU order. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an unresponsive expand action or incorrect member sorting.
3. **Independent oracle:** Literal semantic identities node/11/10.
4. **Stable seam:** buildRows invoked with the produced group row's opaque action key
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Collapsed-group aggregation does not exercise expansion; expected keys no longer come from the subject helper.

Final anchor: 93.

### REWRITE — line 107: mixed-user unmeasured name group

1. **Independent contract/source:** A mixed-user group must not claim one user, must preserve an active member's status and oldest start, and unknown CPU must stay unknown. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects misleading user/status/age and false zero CPU in grouped host resources.
3. **Independent oracle:** Authored users a/b, statuses sleeping/running, starts50/10 and null measurements.
4. **Stable seam:** buildRows group metrics rather than a private aggregation helper
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Known same-user measured totals do not cover unknown and mixed metadata.

Final anchor: 98.

### DELETE — line 113: direct descendant count duplicate

1. **Independent contract/source:** This shallower count duplicates the retained count covering every nested descendant. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** No unique Stop-warning behavior remains in the direct-only count.
3. **Independent oracle:** Expected2 follows the same descendant owner as deeper retained expected4.
4. **Stable seam:** descendantCount
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Retained process-table.check line114 counts nested descendants; subtreeSummary separately checks direct child information.

Failed bars: 6.

### KEEP — line 114: nested descendant Stop warning

1. **Independent contract/source:** Stop warnings count every descendant, including nested grandchildren, without including the selected process itself. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects understating the scope of a Stop action.
3. **Independent oracle:** Authored graph under PID1 has exactly four descendants.
4. **Stable seam:** descendantCount used by the TaskManager confirmation
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** subtreeSummary shares traversal but does not execute this separate production-used Stop-warning selector; one strongest count remains.

Final anchor: 104.

### DELETE — line 115: self-parented PID hypothetical

1. **Independent contract/source:** No independent source requires a live kernel process to be its own parent. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** The impossible single-stat fixture adds defensive branch coverage without a credible owner-visible regression.
3. **Independent oracle:** Fabricated PID5 PPID5.
4. **Stable seam:** descendantCount
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** The credible non-atomic cross-process cycle remains covered through full-tree and ancestor boundaries.

Failed bars: 1, 2.

### KEEP — line 117: subtree direct children and resource totals

1. **Independent contract/source:** Row details list direct children while resource totals include the selected process and all descendants, ignoring unknown CPU. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects incorrect child navigation or subtree CPU/RSS figures.
3. **Independent oracle:** Children11/12; descendants2; CPU30; RSS7000 from authored fixture data.
4. **Stable seam:** subtreeSummary row-detail boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Stop count does not return direct children or resource totals.

Final anchor: 106.

### KEEP — line 122: subtree excludes grandchildren from direct list

1. **Independent contract/source:** Grandchildren contribute to descendant counts but do not appear as direct child links. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a deep process being presented as an immediate child of init.
3. **Independent oracle:** Literal direct children20/10 and descendant total4.
4. **Stable seam:** subtreeSummary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The shallower daemon subtree has no grandchildren.

Final anchor: 111.

### KEEP — line 124: unknown subtree CPU remains unknown

1. **Independent contract/source:** A subtree without any CPU sample must not report measured zero CPU. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects presenting an unavailable reading as a real zero.
3. **Independent oracle:** Literal null result for the authored unmeasured PID12.
4. **Stable seam:** subtreeSummary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Known-value sums cannot distinguish no measurements from measured zero.

Final anchor: 113.

### KEEP — line 125: ancestor path order

1. **Independent contract/source:** Row details return listed ancestors from outermost to immediate parent. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects reversed or wrong process navigation.
3. **Independent oracle:** Literal PIDs1/10.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 114.

### KEEP — line 126: missing parent ends ancestry

1. **Independent contract/source:** An unlisted parent terminates the ancestor path. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects inventing ancestors outside the current process snapshot.
3. **Independent oracle:** Literal empty ancestor list for init.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 115.

### KEEP — line 127: cyclic ancestry terminates

1. **Independent contract/source:** A transient cycle cannot repeat the starting PID or loop forever. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a hanging row-detail expansion under a recycled snapshot.
3. **Independent oracle:** Literal ancestor PID41 for reciprocal40/41 input.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 116.

### KEEP — line 129: core role mapping

1. **Independent contract/source:** The Orquester core strip identifies daemon and agent-host rows by their reported roles. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects the wrong infrastructure process/resource being displayed.
3. **Independent oracle:** Literal daemon PID10 and agent-host PID30 roles.
4. **Stable seam:** coreProcesses used by OrquesterCore
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** TaskManager tree grouping does not select infrastructure roles.

Final anchor: 118.

### KEEP — line 131: legacy daemon PID fallback

1. **Independent contract/source:** An older untagged daemon remains identifiable by the snapshot daemon PID. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects missing daemon data on older server versions.
3. **Independent oracle:** Explicit daemonPid7 and untagged fixture PID7.
4. **Stable seam:** coreProcesses
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Tagged role selection does not exercise compatibility fallback.

Final anchor: 120.

### KEEP — line 132: managed resource totals

1. **Independent contract/source:** Orquester totals include only its managed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects host-wide process usage being attributed to Orquester.
3. **Independent oracle:** Literal managed count3, CPU30 and RSS7000.
4. **Stable seam:** managedTotals used by OrquesterCore
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Subtree totals have different roots/membership and do not prove managed filtering.

Final anchor: 121.

### DELETE — line 135: null columns equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### DELETE — line 136: malformed JSON equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### DELETE — line 137: wrong columns shape equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### REWRITE — line 138: persisted column names validated

1. **Independent contract/source:** Persisted visible columns retain known names once and discard unknown/non-string entries. Source: AGENTS.md localStorage validation; TaskManager column-menu persistence contract.
2. **Detectable failure:** Detects malformed localStorage values reaching rendering or duplicate selected columns.
3. **Independent oracle:** Literal selected set cpu/uptime, independent of display order.
4. **Stable seam:** parseColumns public persistence boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Replaces incidental canonical-order expectation; this uniquely protects stored column selection.

Final anchor: 124.

### KEEP — line 139: all columns hidden is a valid choice

1. **Independent contract/source:** An explicit empty persisted column selection must remain empty. Source: TaskManager column-menu persistence; AGENTS.md persisted configuration validation.
2. **Detectable failure:** Detects forcing defaults back after the user deliberately hides every optional column.
3. **Independent oracle:** Literal empty input list and expected empty selected set.
4. **Stable seam:** parseColumns
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Malformed/default cases do not exercise an intentional valid empty choice.

Final anchor: 125.

### REWRITE — line 142: network byte-to-bit quantity

1. **Independent contract/source:** Network API rates are bytes/s; displayed SI bit-rate text must describe the equivalent quantity. Source: SystemNetworkInfo rxBps/txBps byte-rate wire contract; standard8bits/byte and SI bitrate units.
2. **Detectable failure:** Detects an eightfold unit error or binary scaling mislabeled as decimal SI.
3. **Independent oracle:** Independent SI unit meanings and authored12500000bytes/s =100000000bits/s; interpret the displayed quantity without freezing its prefix/precision.
4. **Stable seam:** formatBitRate consumed by HostResourceCards
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No daemon API test formats its byte-rate into UI bits; one representative multi-unit quantity remains.

Final anchor: 129.

### DELETE — line 143: second exact bitrate label

1. **Independent contract/source:** The second exact1.0Kbps label adds no unique conversion contract. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** It freezes prefix/precision beyond the retained semantic byte-to-bit quantity check.
3. **Independent oracle:** Exact generated string1.0Kbps.
4. **Stable seam:** formatBitRate
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Retained semantic rate check interprets arbitrary SI prefix/precision and catches byte/bit and base1000 mistakes.

Failed bars: 5, 6.

### REWRITE — line 144: unknown network rate is not measured zero

1. **Independent contract/source:** An unavailable nullable measurement must display a nonempty unknown marker, never a numeric zero. Source: SystemProcessInfo.cpuPercent nullable sampling and SystemNetworkInfo nullable wire readings.
2. **Detectable failure:** Detects misleading resource readings while permitting marker wording changes.
3. **Independent oracle:** Independent absence of digits plus a nonempty marker; no exact em-dash copy.
4. **Stable seam:** system-format formatBitRate at host resource display boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The numeric-rate conversion and resource sums do not protect this final unknown-display policy.

Final anchor: 133.

### REWRITE — line 146: unknown CPU is not measured zero

1. **Independent contract/source:** An unavailable nullable measurement must display a nonempty unknown marker, never a numeric zero. Source: SystemProcessInfo.cpuPercent nullable sampling and SystemNetworkInfo nullable wire readings.
2. **Detectable failure:** Detects misleading resource readings while permitting marker wording changes.
3. **Independent oracle:** Independent absence of digits plus a nonempty marker; no exact em-dash copy.
4. **Stable seam:** system-format formatCpu at host resource display boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The numeric-rate conversion and resource sums do not protect this final unknown-display policy.

Final anchor: 135.

### DELETE — line 145: CPU one-decimal copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 147: seconds duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 148: hours/minutes duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 149: days/hours duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### KEEP — line 36: visible session owner

1. **Independent contract/source:** A visible session resolves its own title/kind and project. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects process/port owner chips pointing at the wrong chat/project.
3. **Independent oracle:** Authored live session titleclaude, kindagent and project data.
4. **Stable seam:** resolveSessionOwner used by SessionChip
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Generic project resolution does not join a session id to its title/owner.

Final anchor: 36.

### KEEP — line 44: hidden owner: archived-project

1. **Independent contract/source:** An archived project must not reveal a session title in the System panel. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects a privacy-curtain leak through process/port owner chips.
3. **Independent oracle:** Literal null result for the independently authored archived-project input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: archived-workspace

1. **Independent contract/source:** An archived workspace must hide its session even without a loaded project record. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects bypassing the archive curtain via guessed project fallback.
3. **Independent oracle:** Literal null result for the independently authored archived-workspace input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: no-project

1. **Independent contract/source:** A session without a project must have no navigable named project owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects an orphan/invalid project chip.
3. **Independent oracle:** Literal null result for the independently authored no-project input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: kg-worker

1. **Independent contract/source:** A Knowledge-indexer worker must not appear as a user project/session owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects internal worker names exposed as normal project owners; resolveProjectRef otherwise guesses a visible project even for its appdir path.
3. **Independent oracle:** Literal null result for the independently authored kg-worker input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: unknown-id

1. **Independent contract/source:** An absent/exited session id must resolve to no owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects stale process/port metadata naming an unrelated or nonexistent chat.
3. **Independent oracle:** Literal null result for the independently authored unknown-id input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 49: workspace-only owner fallback

1. **Independent contract/source:** Before the project list loads, the known workspace path must still resolve the correct project name. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects navigation/owner chips missing for an otherwise live visible session during initial loading.
3. **Independent oracle:** Literal workspacews and projectproj from authored paths.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The visible-owner case supplies a complete project record and cannot exercise fallback.

Final anchor: 49.

### KEEP — line 5: kill refusal: PROCESS_PROTECTED

1. **Independent contract/source:** The public kill refusal code PROCESS_PROTECTED must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 5.

### KEEP — line 6: kill refusal: PROCESS_NOT_MANAGED

1. **Independent contract/source:** The public kill refusal code PROCESS_NOT_MANAGED must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 6.

### KEEP — line 7: kill refusal: INVALID_PID

1. **Independent contract/source:** The public kill refusal code INVALID_PID must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 7.

### KEEP — line 8: kill refusal: INVALID_SIGNAL

1. **Independent contract/source:** The public kill refusal code INVALID_SIGNAL must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 8.

### KEEP — line 9: kill refusal: UNSUPPORTED_PLATFORM

1. **Independent contract/source:** The public kill refusal code UNSUPPORTED_PLATFORM must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 9.

### KEEP — line 10: future unknown kill code

1. **Independent contract/source:** An unknown/future refusal code must fall back rather than masquerade as a known refusal. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects forwarding an unsupported server code into typed UI policy.
3. **Independent oracle:** Literal unknown codeSOMETHING_ELSE and null fallback.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Recognized-code cases cannot detect overaccepting an arbitrary code.

Final anchor: 10.

### KEEP — line 11: network kill failure has no code

1. **Independent contract/source:** A genuine request/network Error without an API refusal body has no recognized kill code. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects error handling crashing while reporting a failed request.
3. **Independent oracle:** Native Error fixture and expected null.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** This common actual error shape differs from a future well-formed API body.

Final anchor: 11.

### DELETE — line 12: null thrown kill failure

1. **Independent contract/source:** No independent caller contract or actual API failure source throws this primitive. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Adds hypothetical optional-chaining branch coverage beyond a real network Error.
3. **Independent oracle:** Fabricated null/undefined catch values.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Actual network Error and future unknown-code tolerance remain protected.

Failed bars: 1, 2, 6.

### DELETE — line 13: undefined thrown kill failure

1. **Independent contract/source:** No independent caller contract or actual API failure source throws this primitive. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Adds hypothetical optional-chaining branch coverage beyond a real network Error.
3. **Independent oracle:** Fabricated null/undefined catch values.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Actual network Error and future unknown-code tolerance remain protected.

Failed bars: 1, 2, 6.

### KEEP — line 8: busiest usage driver

1. **Independent contract/source:** Busiest chip preference selects the agent with the highest reported window usage. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects choosing first agent or weekly-only maximum.
3. **Independent oracle:** Claude10/20 versus Codex80/5 selects codex.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 8.

### KEEP — line 9: pinned usage driver

1. **Independent contract/source:** An available explicitly pinned agent overrides busiest. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects ignoring the user's persisted chip preference.
3. **Independent oracle:** Pinnedclaude wins despite Codex80%.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 9.

### KEEP — line 10: missing pinned driver fallback

1. **Independent contract/source:** When the pinned provider is absent, the available busiest provider drives the chip. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a blank chip after logout/provider availability changes.
3. **Independent oracle:** Codex is the only available row.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 10.

### KEEP — line 11: empty usage driver

1. **Independent contract/source:** No available usage readings yield no driver. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a crash on an empty logged-in provider list.
3. **Independent oracle:** Literal null for empty input.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 11.

### REWRITE — line 14: default-enabled missing usage agents

1. **Independent contract/source:** Default-enabled supported usage agents must offer login hints when absent. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a new installation hiding its missing-provider setup hints.
3. **Independent oracle:** Supported Claude/Codex/Grok ids from README/config contract, independent of visual order.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 14.

### REWRITE — line 15: present usage agents not missing

1. **Independent contract/source:** A provider already in the snapshot must not be shown as needing login. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a false setup warning for an authenticated provider.
3. **Independent oracle:** Presentclaude excludes onlyclaude; codex/grok remain.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 15.

### REWRITE — line 16: disabled usage provider not missing

1. **Independent contract/source:** An explicitly disabled agent must not receive a missing-agent hint. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects ignoring the per-agent usage preference.
3. **Independent oracle:** Codexfalse leaves onlyclaude/grok.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 16.

### KEEP — line 17: disabled usage widget has no missing hints

1. **Independent contract/source:** The master disabled preference suppresses all missing-agent hints. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects prompting for disabled usage integration.
3. **Independent oracle:** Literal empty set when enabledfalse.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 17.

### KEEP — line 19: no measured windows

1. **Independent contract/source:** A provider with no readings yields no displayed windows. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects manufacturing empty misleading bars.
3. **Independent oracle:** Literal empty result for null session/weekly.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Scoped-only and credit windows contain actual measurements.

Final anchor: 19.

### REWRITE — line 20: shared and scoped window data preserved

1. **Independent contract/source:** Session/weekly/scoped readings and the scoped reset time must survive normalization. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects dropping a model-scoped quota or mixing its reset metadata with a shared window.
3. **Independent oracle:** Literal percentages10/96/100 and Fable reset timestamp; presentation order is ignored.
4. **Stable seam:** normalizeUsageWindows used by usage cards
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Provider-window merging tests operate a different wire source and do not protect poll-snapshot normalization.

Final anchor: 20.

### KEEP — line 27: scoped-only provider window

1. **Independent contract/source:** A model-scoped reading remains visible even when shared session/weekly pools are absent. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects gating all output on a shared-pool reading.
3. **Independent oracle:** Literal scoped percent40.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The mixed snapshot has shared windows and cannot expose this gating error.

Final anchor: 28.

### KEEP — line 31: Grok credit capacity metadata

1. **Independent contract/source:** Grok weekly quota is denominated in credits and preserves used/limit/remaining/reset values. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects displaying a percent-only or wrong-unit quota and losing capacity information.
3. **Independent oracle:** README weekly credit pool plus authored700/1000/300 and reset timestamp.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Claude percent-only/scoped windows carry no credit capacity metadata.

Final anchor: 31.

## `packages/ui/src/components/system/session-owner.check.ts`

### KEEP — line 49: managed process scope

1. **Independent contract/source:** Orquester scope contains only daemon-managed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects listing unrelated host processes as Orquester-owned.
3. **Independent oracle:** Literal expected PIDs [10,11,12] with managed flags authored in host fixture.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 44.

### KEEP — line 50: command search ignores case

1. **Independent contract/source:** Command-line process search is case-insensitive. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects VITE search failing to find the node vite process.
3. **Independent oracle:** Literal query VITE and expected PID11.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 45.

### KEEP — line 51: numeric search targets exact PID

1. **Independent contract/source:** A numeric PID query selects the intended process. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects PID search selecting a different process or no process.
3. **Independent oracle:** Literal query20 and PID20.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 46.

### KEEP — line 52: user filter

1. **Independent contract/source:** User filtering restricts the table to the selected host user. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects another user's processes entering that filtered view.
3. **Independent oracle:** Root-owned fixture PIDs1 and20.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 47.

### KEEP — line 53: state filter

1. **Independent contract/source:** Status filtering selects processes in the requested state. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects sleeping processes shown under Running.
3. **Independent oracle:** Fixture running PID11.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 48.

### REWRITE — line 54: user choices are distinct

1. **Independent contract/source:** The user filter offers each reported username once. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects duplicate/missing user choices; incidental alphabetical presentation order is ignored.
3. **Independent oracle:** Independent set of fixture users orquester/root.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 49.

### KEEP — line 56: legacy daemon managed compatibility

1. **Independent contract/source:** Older daemon rows omitting managed still belong to its own process tree. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects older daemon process lists disappearing under Orquester scope.
3. **Independent oracle:** One literal legacy row without managed must survive.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 51.

### KEEP — line 59: legacy managed stop allowed

1. **Independent contract/source:** A normal managed process is offered Stop. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects Stop being unavailable for a valid legacy managed process.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 54.

### KEEP — line 60: daemon stop protected

1. **Independent contract/source:** The daemon itself is never offered Stop in legacy snapshots. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an unsafe daemon Stop action being offered.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 55.

### KEEP — line 61: legacy unmanaged stop refused

1. **Independent contract/source:** A legacy snapshot cannot authorize stopping an unmanaged process. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects UI offering a target that legacy kill routes refuse.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 56.

### KEEP — line 62: agent host stop protected

1. **Independent contract/source:** The agent host is protected when legacy role tags are present. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a Stop action that would interrupt every hosted chat.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 57.

### KEEP — line 65: explicit server stop allowance wins

1. **Independent contract/source:** The daemon may mark an own-user process outside its tree stoppable. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects refusing a valid own-user container/nohup target after the documented feature change.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 60.

### KEEP — line 66: explicit server stop denial wins

1. **Independent contract/source:** A daemon stoppable:false overrides the managed flag. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects offering Stop for protected infrastructure or another refused process.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 61.

### REWRITE — line 71: descending CPU with unknown last

1. **Independent contract/source:** CPU descending sorts measured values from largest to smallest and unknown readings last. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects unknown CPU sorting first or wrong data ordering; tied PID order is incidental.
3. **Independent oracle:** Fixed readings [30,5,0,0,null] and independent PID membership set.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 66.

### REWRITE — line 72: ascending CPU with unknown last

1. **Independent contract/source:** CPU ascending still places unknown readings after real zero readings. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects treating unknown as measured zero or reversing unknown placement with sort direction.
3. **Independent oracle:** Fixed readings [0,0,5,30,null].
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 68.

### REWRITE — line 73: name sorting

1. **Independent contract/source:** The Name column sorts process names alphabetically. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects incorrect lexical name sorting while tolerating arbitrary order among equal names.
3. **Independent oracle:** Literal process names bash/dockerd/node/node/systemd.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 69.

### REWRITE — line 76: descending uptime

1. **Independent contract/source:** Descending uptime puts the older process first. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects inverting start timestamp versus elapsed uptime.
3. **Independent oracle:** Literal start times1000/9000 and expected PIDs1/2.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 71.

### REWRITE — line 77: ascending uptime

1. **Independent contract/source:** Ascending uptime puts the newer process first. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects applying the descending comparator for both sort directions.
3. **Independent oracle:** Literal start times1000/9000 and expected PIDs2/1.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 72.

### KEEP — line 81: tree parent/child ordering

1. **Independent contract/source:** Tree grouping keeps children after their parent and sorts siblings by the selected metric. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a process appearing under the wrong parent or unsorted sibling branches.
3. **Independent oracle:** Authored PPID graph and literal expected PIDs[1,20,10,11,12].
4. **Stable seam:** buildRows tree model
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Flat/group tests cannot detect hierarchy traversal order.

Final anchor: 76.

### DELETE — line 82: tree indentation depth array

1. **Independent contract/source:** No independent visual regression requirement fixes numeric row-depth bookkeeping. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** The [0,1,1,2,2] array only detects implementation representation/indentation changes.
3. **Independent oracle:** Private model depths, not a user action or externally fixed byte.
4. **Stable seam:** buildRows depth field
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Parent/child process order and collapse remain protected by their semantic owners.

Failed bars: 1, 4, 5.

### KEEP — line 87: collapse hides descendants

1. **Independent contract/source:** Collapsing a parent hides its descendants while preserving its parent row and child metadata. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects toggling a process failing to fold the subtree or deleting the parent row.
3. **Independent oracle:** Literal remaining PIDs[1,20,10] and known direct children2.
4. **Stable seam:** buildRows with a user-toggled process key
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Expanded tree traversal does not exercise collapse.

Final anchor: 78.

### KEEP — line 91: filtered parent promotes children

1. **Independent contract/source:** Filtering out a parent must not discard its still-visible children. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a query-filtered process vanishing because its parent was omitted.
3. **Independent oracle:** Literal surviving child PIDs11/12.
4. **Stable seam:** buildRows tree model over filtered input
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Ordinary full trees contain their parents and cannot reveal this failure.

Final anchor: 82.

### REWRITE — line 92: recycled snapshot parent cycle terminates

1. **Independent contract/source:** A transient parent cycle in non-atomic PID snapshots must terminate without losing the listed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an infinite walk or omitted process after PID reuse across scan reads.
3. **Independent oracle:** Fixed PIDs40/41 and reciprocal PPIDs.
4. **Stable seam:** buildRows tree model
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Cycle-safe full-tree walking differs from ancestor-path walking; replace incidental row cardinality with actual PID preservation.

Final anchor: 83.

### REWRITE — line 96: name grouping and aggregate resources

1. **Independent contract/source:** Same-name processes form one group carrying their combined CPU/memory, sorted among single processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects duplicate groups, missing members or incorrect aggregate usage.
3. **Independent oracle:** Input name node, literal group order and sums30%/6000bytes.
4. **Stable seam:** buildRows name-group output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Use authored group name rather than groupRowKey-derived expected key; no stronger test owns group creation and totals.

Final anchor: 87.

### REWRITE — line 102: expanded group member ordering

1. **Independent contract/source:** Opening a name group reveals its process members in the selected CPU order. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an unresponsive expand action or incorrect member sorting.
3. **Independent oracle:** Literal semantic identities node/11/10.
4. **Stable seam:** buildRows invoked with the produced group row's opaque action key
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Collapsed-group aggregation does not exercise expansion; expected keys no longer come from the subject helper.

Final anchor: 93.

### REWRITE — line 107: mixed-user unmeasured name group

1. **Independent contract/source:** A mixed-user group must not claim one user, must preserve an active member's status and oldest start, and unknown CPU must stay unknown. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects misleading user/status/age and false zero CPU in grouped host resources.
3. **Independent oracle:** Authored users a/b, statuses sleeping/running, starts50/10 and null measurements.
4. **Stable seam:** buildRows group metrics rather than a private aggregation helper
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Known same-user measured totals do not cover unknown and mixed metadata.

Final anchor: 98.

### DELETE — line 113: direct descendant count duplicate

1. **Independent contract/source:** This shallower count duplicates the retained count covering every nested descendant. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** No unique Stop-warning behavior remains in the direct-only count.
3. **Independent oracle:** Expected2 follows the same descendant owner as deeper retained expected4.
4. **Stable seam:** descendantCount
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Retained process-table.check line114 counts nested descendants; subtreeSummary separately checks direct child information.

Failed bars: 6.

### KEEP — line 114: nested descendant Stop warning

1. **Independent contract/source:** Stop warnings count every descendant, including nested grandchildren, without including the selected process itself. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects understating the scope of a Stop action.
3. **Independent oracle:** Authored graph under PID1 has exactly four descendants.
4. **Stable seam:** descendantCount used by the TaskManager confirmation
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** subtreeSummary shares traversal but does not execute this separate production-used Stop-warning selector; one strongest count remains.

Final anchor: 104.

### DELETE — line 115: self-parented PID hypothetical

1. **Independent contract/source:** No independent source requires a live kernel process to be its own parent. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** The impossible single-stat fixture adds defensive branch coverage without a credible owner-visible regression.
3. **Independent oracle:** Fabricated PID5 PPID5.
4. **Stable seam:** descendantCount
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** The credible non-atomic cross-process cycle remains covered through full-tree and ancestor boundaries.

Failed bars: 1, 2.

### KEEP — line 117: subtree direct children and resource totals

1. **Independent contract/source:** Row details list direct children while resource totals include the selected process and all descendants, ignoring unknown CPU. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects incorrect child navigation or subtree CPU/RSS figures.
3. **Independent oracle:** Children11/12; descendants2; CPU30; RSS7000 from authored fixture data.
4. **Stable seam:** subtreeSummary row-detail boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Stop count does not return direct children or resource totals.

Final anchor: 106.

### KEEP — line 122: subtree excludes grandchildren from direct list

1. **Independent contract/source:** Grandchildren contribute to descendant counts but do not appear as direct child links. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a deep process being presented as an immediate child of init.
3. **Independent oracle:** Literal direct children20/10 and descendant total4.
4. **Stable seam:** subtreeSummary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The shallower daemon subtree has no grandchildren.

Final anchor: 111.

### KEEP — line 124: unknown subtree CPU remains unknown

1. **Independent contract/source:** A subtree without any CPU sample must not report measured zero CPU. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects presenting an unavailable reading as a real zero.
3. **Independent oracle:** Literal null result for the authored unmeasured PID12.
4. **Stable seam:** subtreeSummary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Known-value sums cannot distinguish no measurements from measured zero.

Final anchor: 113.

### KEEP — line 125: ancestor path order

1. **Independent contract/source:** Row details return listed ancestors from outermost to immediate parent. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects reversed or wrong process navigation.
3. **Independent oracle:** Literal PIDs1/10.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 114.

### KEEP — line 126: missing parent ends ancestry

1. **Independent contract/source:** An unlisted parent terminates the ancestor path. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects inventing ancestors outside the current process snapshot.
3. **Independent oracle:** Literal empty ancestor list for init.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 115.

### KEEP — line 127: cyclic ancestry terminates

1. **Independent contract/source:** A transient cycle cannot repeat the starting PID or loop forever. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a hanging row-detail expansion under a recycled snapshot.
3. **Independent oracle:** Literal ancestor PID41 for reciprocal40/41 input.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 116.

### KEEP — line 129: core role mapping

1. **Independent contract/source:** The Orquester core strip identifies daemon and agent-host rows by their reported roles. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects the wrong infrastructure process/resource being displayed.
3. **Independent oracle:** Literal daemon PID10 and agent-host PID30 roles.
4. **Stable seam:** coreProcesses used by OrquesterCore
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** TaskManager tree grouping does not select infrastructure roles.

Final anchor: 118.

### KEEP — line 131: legacy daemon PID fallback

1. **Independent contract/source:** An older untagged daemon remains identifiable by the snapshot daemon PID. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects missing daemon data on older server versions.
3. **Independent oracle:** Explicit daemonPid7 and untagged fixture PID7.
4. **Stable seam:** coreProcesses
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Tagged role selection does not exercise compatibility fallback.

Final anchor: 120.

### KEEP — line 132: managed resource totals

1. **Independent contract/source:** Orquester totals include only its managed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects host-wide process usage being attributed to Orquester.
3. **Independent oracle:** Literal managed count3, CPU30 and RSS7000.
4. **Stable seam:** managedTotals used by OrquesterCore
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Subtree totals have different roots/membership and do not prove managed filtering.

Final anchor: 121.

### DELETE — line 135: null columns equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### DELETE — line 136: malformed JSON equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### DELETE — line 137: wrong columns shape equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### REWRITE — line 138: persisted column names validated

1. **Independent contract/source:** Persisted visible columns retain known names once and discard unknown/non-string entries. Source: AGENTS.md localStorage validation; TaskManager column-menu persistence contract.
2. **Detectable failure:** Detects malformed localStorage values reaching rendering or duplicate selected columns.
3. **Independent oracle:** Literal selected set cpu/uptime, independent of display order.
4. **Stable seam:** parseColumns public persistence boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Replaces incidental canonical-order expectation; this uniquely protects stored column selection.

Final anchor: 124.

### KEEP — line 139: all columns hidden is a valid choice

1. **Independent contract/source:** An explicit empty persisted column selection must remain empty. Source: TaskManager column-menu persistence; AGENTS.md persisted configuration validation.
2. **Detectable failure:** Detects forcing defaults back after the user deliberately hides every optional column.
3. **Independent oracle:** Literal empty input list and expected empty selected set.
4. **Stable seam:** parseColumns
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Malformed/default cases do not exercise an intentional valid empty choice.

Final anchor: 125.

### REWRITE — line 142: network byte-to-bit quantity

1. **Independent contract/source:** Network API rates are bytes/s; displayed SI bit-rate text must describe the equivalent quantity. Source: SystemNetworkInfo rxBps/txBps byte-rate wire contract; standard8bits/byte and SI bitrate units.
2. **Detectable failure:** Detects an eightfold unit error or binary scaling mislabeled as decimal SI.
3. **Independent oracle:** Independent SI unit meanings and authored12500000bytes/s =100000000bits/s; interpret the displayed quantity without freezing its prefix/precision.
4. **Stable seam:** formatBitRate consumed by HostResourceCards
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No daemon API test formats its byte-rate into UI bits; one representative multi-unit quantity remains.

Final anchor: 129.

### DELETE — line 143: second exact bitrate label

1. **Independent contract/source:** The second exact1.0Kbps label adds no unique conversion contract. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** It freezes prefix/precision beyond the retained semantic byte-to-bit quantity check.
3. **Independent oracle:** Exact generated string1.0Kbps.
4. **Stable seam:** formatBitRate
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Retained semantic rate check interprets arbitrary SI prefix/precision and catches byte/bit and base1000 mistakes.

Failed bars: 5, 6.

### REWRITE — line 144: unknown network rate is not measured zero

1. **Independent contract/source:** An unavailable nullable measurement must display a nonempty unknown marker, never a numeric zero. Source: SystemProcessInfo.cpuPercent nullable sampling and SystemNetworkInfo nullable wire readings.
2. **Detectable failure:** Detects misleading resource readings while permitting marker wording changes.
3. **Independent oracle:** Independent absence of digits plus a nonempty marker; no exact em-dash copy.
4. **Stable seam:** system-format formatBitRate at host resource display boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The numeric-rate conversion and resource sums do not protect this final unknown-display policy.

Final anchor: 133.

### REWRITE — line 146: unknown CPU is not measured zero

1. **Independent contract/source:** An unavailable nullable measurement must display a nonempty unknown marker, never a numeric zero. Source: SystemProcessInfo.cpuPercent nullable sampling and SystemNetworkInfo nullable wire readings.
2. **Detectable failure:** Detects misleading resource readings while permitting marker wording changes.
3. **Independent oracle:** Independent absence of digits plus a nonempty marker; no exact em-dash copy.
4. **Stable seam:** system-format formatCpu at host resource display boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The numeric-rate conversion and resource sums do not protect this final unknown-display policy.

Final anchor: 135.

### DELETE — line 145: CPU one-decimal copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 147: seconds duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 148: hours/minutes duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 149: days/hours duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### KEEP — line 36: visible session owner

1. **Independent contract/source:** A visible session resolves its own title/kind and project. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects process/port owner chips pointing at the wrong chat/project.
3. **Independent oracle:** Authored live session titleclaude, kindagent and project data.
4. **Stable seam:** resolveSessionOwner used by SessionChip
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Generic project resolution does not join a session id to its title/owner.

Final anchor: 36.

### KEEP — line 44: hidden owner: archived-project

1. **Independent contract/source:** An archived project must not reveal a session title in the System panel. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects a privacy-curtain leak through process/port owner chips.
3. **Independent oracle:** Literal null result for the independently authored archived-project input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: archived-workspace

1. **Independent contract/source:** An archived workspace must hide its session even without a loaded project record. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects bypassing the archive curtain via guessed project fallback.
3. **Independent oracle:** Literal null result for the independently authored archived-workspace input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: no-project

1. **Independent contract/source:** A session without a project must have no navigable named project owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects an orphan/invalid project chip.
3. **Independent oracle:** Literal null result for the independently authored no-project input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: kg-worker

1. **Independent contract/source:** A Knowledge-indexer worker must not appear as a user project/session owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects internal worker names exposed as normal project owners; resolveProjectRef otherwise guesses a visible project even for its appdir path.
3. **Independent oracle:** Literal null result for the independently authored kg-worker input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: unknown-id

1. **Independent contract/source:** An absent/exited session id must resolve to no owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects stale process/port metadata naming an unrelated or nonexistent chat.
3. **Independent oracle:** Literal null result for the independently authored unknown-id input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 49: workspace-only owner fallback

1. **Independent contract/source:** Before the project list loads, the known workspace path must still resolve the correct project name. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects navigation/owner chips missing for an otherwise live visible session during initial loading.
3. **Independent oracle:** Literal workspacews and projectproj from authored paths.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The visible-owner case supplies a complete project record and cannot exercise fallback.

Final anchor: 49.

### KEEP — line 5: kill refusal: PROCESS_PROTECTED

1. **Independent contract/source:** The public kill refusal code PROCESS_PROTECTED must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 5.

### KEEP — line 6: kill refusal: PROCESS_NOT_MANAGED

1. **Independent contract/source:** The public kill refusal code PROCESS_NOT_MANAGED must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 6.

### KEEP — line 7: kill refusal: INVALID_PID

1. **Independent contract/source:** The public kill refusal code INVALID_PID must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 7.

### KEEP — line 8: kill refusal: INVALID_SIGNAL

1. **Independent contract/source:** The public kill refusal code INVALID_SIGNAL must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 8.

### KEEP — line 9: kill refusal: UNSUPPORTED_PLATFORM

1. **Independent contract/source:** The public kill refusal code UNSUPPORTED_PLATFORM must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 9.

### KEEP — line 10: future unknown kill code

1. **Independent contract/source:** An unknown/future refusal code must fall back rather than masquerade as a known refusal. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects forwarding an unsupported server code into typed UI policy.
3. **Independent oracle:** Literal unknown codeSOMETHING_ELSE and null fallback.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Recognized-code cases cannot detect overaccepting an arbitrary code.

Final anchor: 10.

### KEEP — line 11: network kill failure has no code

1. **Independent contract/source:** A genuine request/network Error without an API refusal body has no recognized kill code. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects error handling crashing while reporting a failed request.
3. **Independent oracle:** Native Error fixture and expected null.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** This common actual error shape differs from a future well-formed API body.

Final anchor: 11.

### DELETE — line 12: null thrown kill failure

1. **Independent contract/source:** No independent caller contract or actual API failure source throws this primitive. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Adds hypothetical optional-chaining branch coverage beyond a real network Error.
3. **Independent oracle:** Fabricated null/undefined catch values.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Actual network Error and future unknown-code tolerance remain protected.

Failed bars: 1, 2, 6.

### DELETE — line 13: undefined thrown kill failure

1. **Independent contract/source:** No independent caller contract or actual API failure source throws this primitive. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Adds hypothetical optional-chaining branch coverage beyond a real network Error.
3. **Independent oracle:** Fabricated null/undefined catch values.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Actual network Error and future unknown-code tolerance remain protected.

Failed bars: 1, 2, 6.

### KEEP — line 8: busiest usage driver

1. **Independent contract/source:** Busiest chip preference selects the agent with the highest reported window usage. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects choosing first agent or weekly-only maximum.
3. **Independent oracle:** Claude10/20 versus Codex80/5 selects codex.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 8.

### KEEP — line 9: pinned usage driver

1. **Independent contract/source:** An available explicitly pinned agent overrides busiest. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects ignoring the user's persisted chip preference.
3. **Independent oracle:** Pinnedclaude wins despite Codex80%.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 9.

### KEEP — line 10: missing pinned driver fallback

1. **Independent contract/source:** When the pinned provider is absent, the available busiest provider drives the chip. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a blank chip after logout/provider availability changes.
3. **Independent oracle:** Codex is the only available row.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 10.

### KEEP — line 11: empty usage driver

1. **Independent contract/source:** No available usage readings yield no driver. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a crash on an empty logged-in provider list.
3. **Independent oracle:** Literal null for empty input.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 11.

### REWRITE — line 14: default-enabled missing usage agents

1. **Independent contract/source:** Default-enabled supported usage agents must offer login hints when absent. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a new installation hiding its missing-provider setup hints.
3. **Independent oracle:** Supported Claude/Codex/Grok ids from README/config contract, independent of visual order.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 14.

### REWRITE — line 15: present usage agents not missing

1. **Independent contract/source:** A provider already in the snapshot must not be shown as needing login. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a false setup warning for an authenticated provider.
3. **Independent oracle:** Presentclaude excludes onlyclaude; codex/grok remain.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 15.

### REWRITE — line 16: disabled usage provider not missing

1. **Independent contract/source:** An explicitly disabled agent must not receive a missing-agent hint. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects ignoring the per-agent usage preference.
3. **Independent oracle:** Codexfalse leaves onlyclaude/grok.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 16.

### KEEP — line 17: disabled usage widget has no missing hints

1. **Independent contract/source:** The master disabled preference suppresses all missing-agent hints. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects prompting for disabled usage integration.
3. **Independent oracle:** Literal empty set when enabledfalse.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 17.

### KEEP — line 19: no measured windows

1. **Independent contract/source:** A provider with no readings yields no displayed windows. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects manufacturing empty misleading bars.
3. **Independent oracle:** Literal empty result for null session/weekly.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Scoped-only and credit windows contain actual measurements.

Final anchor: 19.

### REWRITE — line 20: shared and scoped window data preserved

1. **Independent contract/source:** Session/weekly/scoped readings and the scoped reset time must survive normalization. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects dropping a model-scoped quota or mixing its reset metadata with a shared window.
3. **Independent oracle:** Literal percentages10/96/100 and Fable reset timestamp; presentation order is ignored.
4. **Stable seam:** normalizeUsageWindows used by usage cards
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Provider-window merging tests operate a different wire source and do not protect poll-snapshot normalization.

Final anchor: 20.

### KEEP — line 27: scoped-only provider window

1. **Independent contract/source:** A model-scoped reading remains visible even when shared session/weekly pools are absent. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects gating all output on a shared-pool reading.
3. **Independent oracle:** Literal scoped percent40.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The mixed snapshot has shared windows and cannot expose this gating error.

Final anchor: 28.

### KEEP — line 31: Grok credit capacity metadata

1. **Independent contract/source:** Grok weekly quota is denominated in credits and preserves used/limit/remaining/reset values. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects displaying a percent-only or wrong-unit quota and losing capacity information.
3. **Independent oracle:** README weekly credit pool plus authored700/1000/300 and reset timestamp.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Claude percent-only/scoped windows carry no credit capacity metadata.

Final anchor: 31.

## `packages/ui/src/components/system/system-format.check.ts`

### KEEP — line 49: managed process scope

1. **Independent contract/source:** Orquester scope contains only daemon-managed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects listing unrelated host processes as Orquester-owned.
3. **Independent oracle:** Literal expected PIDs [10,11,12] with managed flags authored in host fixture.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 44.

### KEEP — line 50: command search ignores case

1. **Independent contract/source:** Command-line process search is case-insensitive. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects VITE search failing to find the node vite process.
3. **Independent oracle:** Literal query VITE and expected PID11.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 45.

### KEEP — line 51: numeric search targets exact PID

1. **Independent contract/source:** A numeric PID query selects the intended process. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects PID search selecting a different process or no process.
3. **Independent oracle:** Literal query20 and PID20.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 46.

### KEEP — line 52: user filter

1. **Independent contract/source:** User filtering restricts the table to the selected host user. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects another user's processes entering that filtered view.
3. **Independent oracle:** Root-owned fixture PIDs1 and20.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 47.

### KEEP — line 53: state filter

1. **Independent contract/source:** Status filtering selects processes in the requested state. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects sleeping processes shown under Running.
3. **Independent oracle:** Fixture running PID11.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 48.

### REWRITE — line 54: user choices are distinct

1. **Independent contract/source:** The user filter offers each reported username once. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects duplicate/missing user choices; incidental alphabetical presentation order is ignored.
3. **Independent oracle:** Independent set of fixture users orquester/root.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 49.

### KEEP — line 56: legacy daemon managed compatibility

1. **Independent contract/source:** Older daemon rows omitting managed still belong to its own process tree. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects older daemon process lists disappearing under Orquester scope.
3. **Independent oracle:** One literal legacy row without managed must survive.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 51.

### KEEP — line 59: legacy managed stop allowed

1. **Independent contract/source:** A normal managed process is offered Stop. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects Stop being unavailable for a valid legacy managed process.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 54.

### KEEP — line 60: daemon stop protected

1. **Independent contract/source:** The daemon itself is never offered Stop in legacy snapshots. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an unsafe daemon Stop action being offered.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 55.

### KEEP — line 61: legacy unmanaged stop refused

1. **Independent contract/source:** A legacy snapshot cannot authorize stopping an unmanaged process. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects UI offering a target that legacy kill routes refuse.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 56.

### KEEP — line 62: agent host stop protected

1. **Independent contract/source:** The agent host is protected when legacy role tags are present. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a Stop action that would interrupt every hosted chat.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 57.

### KEEP — line 65: explicit server stop allowance wins

1. **Independent contract/source:** The daemon may mark an own-user process outside its tree stoppable. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects refusing a valid own-user container/nohup target after the documented feature change.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 60.

### KEEP — line 66: explicit server stop denial wins

1. **Independent contract/source:** A daemon stoppable:false overrides the managed flag. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects offering Stop for protected infrastructure or another refused process.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 61.

### REWRITE — line 71: descending CPU with unknown last

1. **Independent contract/source:** CPU descending sorts measured values from largest to smallest and unknown readings last. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects unknown CPU sorting first or wrong data ordering; tied PID order is incidental.
3. **Independent oracle:** Fixed readings [30,5,0,0,null] and independent PID membership set.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 66.

### REWRITE — line 72: ascending CPU with unknown last

1. **Independent contract/source:** CPU ascending still places unknown readings after real zero readings. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects treating unknown as measured zero or reversing unknown placement with sort direction.
3. **Independent oracle:** Fixed readings [0,0,5,30,null].
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 68.

### REWRITE — line 73: name sorting

1. **Independent contract/source:** The Name column sorts process names alphabetically. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects incorrect lexical name sorting while tolerating arbitrary order among equal names.
3. **Independent oracle:** Literal process names bash/dockerd/node/node/systemd.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 69.

### REWRITE — line 76: descending uptime

1. **Independent contract/source:** Descending uptime puts the older process first. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects inverting start timestamp versus elapsed uptime.
3. **Independent oracle:** Literal start times1000/9000 and expected PIDs1/2.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 71.

### REWRITE — line 77: ascending uptime

1. **Independent contract/source:** Ascending uptime puts the newer process first. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects applying the descending comparator for both sort directions.
3. **Independent oracle:** Literal start times1000/9000 and expected PIDs2/1.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 72.

### KEEP — line 81: tree parent/child ordering

1. **Independent contract/source:** Tree grouping keeps children after their parent and sorts siblings by the selected metric. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a process appearing under the wrong parent or unsorted sibling branches.
3. **Independent oracle:** Authored PPID graph and literal expected PIDs[1,20,10,11,12].
4. **Stable seam:** buildRows tree model
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Flat/group tests cannot detect hierarchy traversal order.

Final anchor: 76.

### DELETE — line 82: tree indentation depth array

1. **Independent contract/source:** No independent visual regression requirement fixes numeric row-depth bookkeeping. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** The [0,1,1,2,2] array only detects implementation representation/indentation changes.
3. **Independent oracle:** Private model depths, not a user action or externally fixed byte.
4. **Stable seam:** buildRows depth field
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Parent/child process order and collapse remain protected by their semantic owners.

Failed bars: 1, 4, 5.

### KEEP — line 87: collapse hides descendants

1. **Independent contract/source:** Collapsing a parent hides its descendants while preserving its parent row and child metadata. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects toggling a process failing to fold the subtree or deleting the parent row.
3. **Independent oracle:** Literal remaining PIDs[1,20,10] and known direct children2.
4. **Stable seam:** buildRows with a user-toggled process key
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Expanded tree traversal does not exercise collapse.

Final anchor: 78.

### KEEP — line 91: filtered parent promotes children

1. **Independent contract/source:** Filtering out a parent must not discard its still-visible children. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a query-filtered process vanishing because its parent was omitted.
3. **Independent oracle:** Literal surviving child PIDs11/12.
4. **Stable seam:** buildRows tree model over filtered input
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Ordinary full trees contain their parents and cannot reveal this failure.

Final anchor: 82.

### REWRITE — line 92: recycled snapshot parent cycle terminates

1. **Independent contract/source:** A transient parent cycle in non-atomic PID snapshots must terminate without losing the listed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an infinite walk or omitted process after PID reuse across scan reads.
3. **Independent oracle:** Fixed PIDs40/41 and reciprocal PPIDs.
4. **Stable seam:** buildRows tree model
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Cycle-safe full-tree walking differs from ancestor-path walking; replace incidental row cardinality with actual PID preservation.

Final anchor: 83.

### REWRITE — line 96: name grouping and aggregate resources

1. **Independent contract/source:** Same-name processes form one group carrying their combined CPU/memory, sorted among single processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects duplicate groups, missing members or incorrect aggregate usage.
3. **Independent oracle:** Input name node, literal group order and sums30%/6000bytes.
4. **Stable seam:** buildRows name-group output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Use authored group name rather than groupRowKey-derived expected key; no stronger test owns group creation and totals.

Final anchor: 87.

### REWRITE — line 102: expanded group member ordering

1. **Independent contract/source:** Opening a name group reveals its process members in the selected CPU order. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an unresponsive expand action or incorrect member sorting.
3. **Independent oracle:** Literal semantic identities node/11/10.
4. **Stable seam:** buildRows invoked with the produced group row's opaque action key
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Collapsed-group aggregation does not exercise expansion; expected keys no longer come from the subject helper.

Final anchor: 93.

### REWRITE — line 107: mixed-user unmeasured name group

1. **Independent contract/source:** A mixed-user group must not claim one user, must preserve an active member's status and oldest start, and unknown CPU must stay unknown. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects misleading user/status/age and false zero CPU in grouped host resources.
3. **Independent oracle:** Authored users a/b, statuses sleeping/running, starts50/10 and null measurements.
4. **Stable seam:** buildRows group metrics rather than a private aggregation helper
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Known same-user measured totals do not cover unknown and mixed metadata.

Final anchor: 98.

### DELETE — line 113: direct descendant count duplicate

1. **Independent contract/source:** This shallower count duplicates the retained count covering every nested descendant. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** No unique Stop-warning behavior remains in the direct-only count.
3. **Independent oracle:** Expected2 follows the same descendant owner as deeper retained expected4.
4. **Stable seam:** descendantCount
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Retained process-table.check line114 counts nested descendants; subtreeSummary separately checks direct child information.

Failed bars: 6.

### KEEP — line 114: nested descendant Stop warning

1. **Independent contract/source:** Stop warnings count every descendant, including nested grandchildren, without including the selected process itself. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects understating the scope of a Stop action.
3. **Independent oracle:** Authored graph under PID1 has exactly four descendants.
4. **Stable seam:** descendantCount used by the TaskManager confirmation
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** subtreeSummary shares traversal but does not execute this separate production-used Stop-warning selector; one strongest count remains.

Final anchor: 104.

### DELETE — line 115: self-parented PID hypothetical

1. **Independent contract/source:** No independent source requires a live kernel process to be its own parent. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** The impossible single-stat fixture adds defensive branch coverage without a credible owner-visible regression.
3. **Independent oracle:** Fabricated PID5 PPID5.
4. **Stable seam:** descendantCount
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** The credible non-atomic cross-process cycle remains covered through full-tree and ancestor boundaries.

Failed bars: 1, 2.

### KEEP — line 117: subtree direct children and resource totals

1. **Independent contract/source:** Row details list direct children while resource totals include the selected process and all descendants, ignoring unknown CPU. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects incorrect child navigation or subtree CPU/RSS figures.
3. **Independent oracle:** Children11/12; descendants2; CPU30; RSS7000 from authored fixture data.
4. **Stable seam:** subtreeSummary row-detail boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Stop count does not return direct children or resource totals.

Final anchor: 106.

### KEEP — line 122: subtree excludes grandchildren from direct list

1. **Independent contract/source:** Grandchildren contribute to descendant counts but do not appear as direct child links. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a deep process being presented as an immediate child of init.
3. **Independent oracle:** Literal direct children20/10 and descendant total4.
4. **Stable seam:** subtreeSummary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The shallower daemon subtree has no grandchildren.

Final anchor: 111.

### KEEP — line 124: unknown subtree CPU remains unknown

1. **Independent contract/source:** A subtree without any CPU sample must not report measured zero CPU. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects presenting an unavailable reading as a real zero.
3. **Independent oracle:** Literal null result for the authored unmeasured PID12.
4. **Stable seam:** subtreeSummary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Known-value sums cannot distinguish no measurements from measured zero.

Final anchor: 113.

### KEEP — line 125: ancestor path order

1. **Independent contract/source:** Row details return listed ancestors from outermost to immediate parent. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects reversed or wrong process navigation.
3. **Independent oracle:** Literal PIDs1/10.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 114.

### KEEP — line 126: missing parent ends ancestry

1. **Independent contract/source:** An unlisted parent terminates the ancestor path. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects inventing ancestors outside the current process snapshot.
3. **Independent oracle:** Literal empty ancestor list for init.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 115.

### KEEP — line 127: cyclic ancestry terminates

1. **Independent contract/source:** A transient cycle cannot repeat the starting PID or loop forever. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a hanging row-detail expansion under a recycled snapshot.
3. **Independent oracle:** Literal ancestor PID41 for reciprocal40/41 input.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 116.

### KEEP — line 129: core role mapping

1. **Independent contract/source:** The Orquester core strip identifies daemon and agent-host rows by their reported roles. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects the wrong infrastructure process/resource being displayed.
3. **Independent oracle:** Literal daemon PID10 and agent-host PID30 roles.
4. **Stable seam:** coreProcesses used by OrquesterCore
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** TaskManager tree grouping does not select infrastructure roles.

Final anchor: 118.

### KEEP — line 131: legacy daemon PID fallback

1. **Independent contract/source:** An older untagged daemon remains identifiable by the snapshot daemon PID. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects missing daemon data on older server versions.
3. **Independent oracle:** Explicit daemonPid7 and untagged fixture PID7.
4. **Stable seam:** coreProcesses
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Tagged role selection does not exercise compatibility fallback.

Final anchor: 120.

### KEEP — line 132: managed resource totals

1. **Independent contract/source:** Orquester totals include only its managed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects host-wide process usage being attributed to Orquester.
3. **Independent oracle:** Literal managed count3, CPU30 and RSS7000.
4. **Stable seam:** managedTotals used by OrquesterCore
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Subtree totals have different roots/membership and do not prove managed filtering.

Final anchor: 121.

### DELETE — line 135: null columns equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### DELETE — line 136: malformed JSON equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### DELETE — line 137: wrong columns shape equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### REWRITE — line 138: persisted column names validated

1. **Independent contract/source:** Persisted visible columns retain known names once and discard unknown/non-string entries. Source: AGENTS.md localStorage validation; TaskManager column-menu persistence contract.
2. **Detectable failure:** Detects malformed localStorage values reaching rendering or duplicate selected columns.
3. **Independent oracle:** Literal selected set cpu/uptime, independent of display order.
4. **Stable seam:** parseColumns public persistence boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Replaces incidental canonical-order expectation; this uniquely protects stored column selection.

Final anchor: 124.

### KEEP — line 139: all columns hidden is a valid choice

1. **Independent contract/source:** An explicit empty persisted column selection must remain empty. Source: TaskManager column-menu persistence; AGENTS.md persisted configuration validation.
2. **Detectable failure:** Detects forcing defaults back after the user deliberately hides every optional column.
3. **Independent oracle:** Literal empty input list and expected empty selected set.
4. **Stable seam:** parseColumns
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Malformed/default cases do not exercise an intentional valid empty choice.

Final anchor: 125.

### REWRITE — line 142: network byte-to-bit quantity

1. **Independent contract/source:** Network API rates are bytes/s; displayed SI bit-rate text must describe the equivalent quantity. Source: SystemNetworkInfo rxBps/txBps byte-rate wire contract; standard8bits/byte and SI bitrate units.
2. **Detectable failure:** Detects an eightfold unit error or binary scaling mislabeled as decimal SI.
3. **Independent oracle:** Independent SI unit meanings and authored12500000bytes/s =100000000bits/s; interpret the displayed quantity without freezing its prefix/precision.
4. **Stable seam:** formatBitRate consumed by HostResourceCards
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No daemon API test formats its byte-rate into UI bits; one representative multi-unit quantity remains.

Final anchor: 129.

### DELETE — line 143: second exact bitrate label

1. **Independent contract/source:** The second exact1.0Kbps label adds no unique conversion contract. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** It freezes prefix/precision beyond the retained semantic byte-to-bit quantity check.
3. **Independent oracle:** Exact generated string1.0Kbps.
4. **Stable seam:** formatBitRate
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Retained semantic rate check interprets arbitrary SI prefix/precision and catches byte/bit and base1000 mistakes.

Failed bars: 5, 6.

### REWRITE — line 144: unknown network rate is not measured zero

1. **Independent contract/source:** An unavailable nullable measurement must display a nonempty unknown marker, never a numeric zero. Source: SystemProcessInfo.cpuPercent nullable sampling and SystemNetworkInfo nullable wire readings.
2. **Detectable failure:** Detects misleading resource readings while permitting marker wording changes.
3. **Independent oracle:** Independent absence of digits plus a nonempty marker; no exact em-dash copy.
4. **Stable seam:** system-format formatBitRate at host resource display boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The numeric-rate conversion and resource sums do not protect this final unknown-display policy.

Final anchor: 133.

### REWRITE — line 146: unknown CPU is not measured zero

1. **Independent contract/source:** An unavailable nullable measurement must display a nonempty unknown marker, never a numeric zero. Source: SystemProcessInfo.cpuPercent nullable sampling and SystemNetworkInfo nullable wire readings.
2. **Detectable failure:** Detects misleading resource readings while permitting marker wording changes.
3. **Independent oracle:** Independent absence of digits plus a nonempty marker; no exact em-dash copy.
4. **Stable seam:** system-format formatCpu at host resource display boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The numeric-rate conversion and resource sums do not protect this final unknown-display policy.

Final anchor: 135.

### DELETE — line 145: CPU one-decimal copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 147: seconds duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 148: hours/minutes duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 149: days/hours duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### KEEP — line 36: visible session owner

1. **Independent contract/source:** A visible session resolves its own title/kind and project. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects process/port owner chips pointing at the wrong chat/project.
3. **Independent oracle:** Authored live session titleclaude, kindagent and project data.
4. **Stable seam:** resolveSessionOwner used by SessionChip
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Generic project resolution does not join a session id to its title/owner.

Final anchor: 36.

### KEEP — line 44: hidden owner: archived-project

1. **Independent contract/source:** An archived project must not reveal a session title in the System panel. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects a privacy-curtain leak through process/port owner chips.
3. **Independent oracle:** Literal null result for the independently authored archived-project input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: archived-workspace

1. **Independent contract/source:** An archived workspace must hide its session even without a loaded project record. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects bypassing the archive curtain via guessed project fallback.
3. **Independent oracle:** Literal null result for the independently authored archived-workspace input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: no-project

1. **Independent contract/source:** A session without a project must have no navigable named project owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects an orphan/invalid project chip.
3. **Independent oracle:** Literal null result for the independently authored no-project input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: kg-worker

1. **Independent contract/source:** A Knowledge-indexer worker must not appear as a user project/session owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects internal worker names exposed as normal project owners; resolveProjectRef otherwise guesses a visible project even for its appdir path.
3. **Independent oracle:** Literal null result for the independently authored kg-worker input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: unknown-id

1. **Independent contract/source:** An absent/exited session id must resolve to no owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects stale process/port metadata naming an unrelated or nonexistent chat.
3. **Independent oracle:** Literal null result for the independently authored unknown-id input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 49: workspace-only owner fallback

1. **Independent contract/source:** Before the project list loads, the known workspace path must still resolve the correct project name. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects navigation/owner chips missing for an otherwise live visible session during initial loading.
3. **Independent oracle:** Literal workspacews and projectproj from authored paths.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The visible-owner case supplies a complete project record and cannot exercise fallback.

Final anchor: 49.

### KEEP — line 5: kill refusal: PROCESS_PROTECTED

1. **Independent contract/source:** The public kill refusal code PROCESS_PROTECTED must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 5.

### KEEP — line 6: kill refusal: PROCESS_NOT_MANAGED

1. **Independent contract/source:** The public kill refusal code PROCESS_NOT_MANAGED must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 6.

### KEEP — line 7: kill refusal: INVALID_PID

1. **Independent contract/source:** The public kill refusal code INVALID_PID must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 7.

### KEEP — line 8: kill refusal: INVALID_SIGNAL

1. **Independent contract/source:** The public kill refusal code INVALID_SIGNAL must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 8.

### KEEP — line 9: kill refusal: UNSUPPORTED_PLATFORM

1. **Independent contract/source:** The public kill refusal code UNSUPPORTED_PLATFORM must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 9.

### KEEP — line 10: future unknown kill code

1. **Independent contract/source:** An unknown/future refusal code must fall back rather than masquerade as a known refusal. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects forwarding an unsupported server code into typed UI policy.
3. **Independent oracle:** Literal unknown codeSOMETHING_ELSE and null fallback.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Recognized-code cases cannot detect overaccepting an arbitrary code.

Final anchor: 10.

### KEEP — line 11: network kill failure has no code

1. **Independent contract/source:** A genuine request/network Error without an API refusal body has no recognized kill code. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects error handling crashing while reporting a failed request.
3. **Independent oracle:** Native Error fixture and expected null.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** This common actual error shape differs from a future well-formed API body.

Final anchor: 11.

### DELETE — line 12: null thrown kill failure

1. **Independent contract/source:** No independent caller contract or actual API failure source throws this primitive. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Adds hypothetical optional-chaining branch coverage beyond a real network Error.
3. **Independent oracle:** Fabricated null/undefined catch values.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Actual network Error and future unknown-code tolerance remain protected.

Failed bars: 1, 2, 6.

### DELETE — line 13: undefined thrown kill failure

1. **Independent contract/source:** No independent caller contract or actual API failure source throws this primitive. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Adds hypothetical optional-chaining branch coverage beyond a real network Error.
3. **Independent oracle:** Fabricated null/undefined catch values.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Actual network Error and future unknown-code tolerance remain protected.

Failed bars: 1, 2, 6.

### KEEP — line 8: busiest usage driver

1. **Independent contract/source:** Busiest chip preference selects the agent with the highest reported window usage. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects choosing first agent or weekly-only maximum.
3. **Independent oracle:** Claude10/20 versus Codex80/5 selects codex.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 8.

### KEEP — line 9: pinned usage driver

1. **Independent contract/source:** An available explicitly pinned agent overrides busiest. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects ignoring the user's persisted chip preference.
3. **Independent oracle:** Pinnedclaude wins despite Codex80%.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 9.

### KEEP — line 10: missing pinned driver fallback

1. **Independent contract/source:** When the pinned provider is absent, the available busiest provider drives the chip. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a blank chip after logout/provider availability changes.
3. **Independent oracle:** Codex is the only available row.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 10.

### KEEP — line 11: empty usage driver

1. **Independent contract/source:** No available usage readings yield no driver. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a crash on an empty logged-in provider list.
3. **Independent oracle:** Literal null for empty input.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 11.

### REWRITE — line 14: default-enabled missing usage agents

1. **Independent contract/source:** Default-enabled supported usage agents must offer login hints when absent. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a new installation hiding its missing-provider setup hints.
3. **Independent oracle:** Supported Claude/Codex/Grok ids from README/config contract, independent of visual order.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 14.

### REWRITE — line 15: present usage agents not missing

1. **Independent contract/source:** A provider already in the snapshot must not be shown as needing login. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a false setup warning for an authenticated provider.
3. **Independent oracle:** Presentclaude excludes onlyclaude; codex/grok remain.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 15.

### REWRITE — line 16: disabled usage provider not missing

1. **Independent contract/source:** An explicitly disabled agent must not receive a missing-agent hint. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects ignoring the per-agent usage preference.
3. **Independent oracle:** Codexfalse leaves onlyclaude/grok.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 16.

### KEEP — line 17: disabled usage widget has no missing hints

1. **Independent contract/source:** The master disabled preference suppresses all missing-agent hints. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects prompting for disabled usage integration.
3. **Independent oracle:** Literal empty set when enabledfalse.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 17.

### KEEP — line 19: no measured windows

1. **Independent contract/source:** A provider with no readings yields no displayed windows. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects manufacturing empty misleading bars.
3. **Independent oracle:** Literal empty result for null session/weekly.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Scoped-only and credit windows contain actual measurements.

Final anchor: 19.

### REWRITE — line 20: shared and scoped window data preserved

1. **Independent contract/source:** Session/weekly/scoped readings and the scoped reset time must survive normalization. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects dropping a model-scoped quota or mixing its reset metadata with a shared window.
3. **Independent oracle:** Literal percentages10/96/100 and Fable reset timestamp; presentation order is ignored.
4. **Stable seam:** normalizeUsageWindows used by usage cards
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Provider-window merging tests operate a different wire source and do not protect poll-snapshot normalization.

Final anchor: 20.

### KEEP — line 27: scoped-only provider window

1. **Independent contract/source:** A model-scoped reading remains visible even when shared session/weekly pools are absent. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects gating all output on a shared-pool reading.
3. **Independent oracle:** Literal scoped percent40.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The mixed snapshot has shared windows and cannot expose this gating error.

Final anchor: 28.

### KEEP — line 31: Grok credit capacity metadata

1. **Independent contract/source:** Grok weekly quota is denominated in credits and preserves used/limit/remaining/reset values. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects displaying a percent-only or wrong-unit quota and losing capacity information.
3. **Independent oracle:** README weekly credit pool plus authored700/1000/300 and reset timestamp.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Claude percent-only/scoped windows carry no credit capacity metadata.

Final anchor: 31.

## `packages/ui/src/components/topbar/usage-format.check.ts`

### KEEP — line 49: managed process scope

1. **Independent contract/source:** Orquester scope contains only daemon-managed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects listing unrelated host processes as Orquester-owned.
3. **Independent oracle:** Literal expected PIDs [10,11,12] with managed flags authored in host fixture.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 44.

### KEEP — line 50: command search ignores case

1. **Independent contract/source:** Command-line process search is case-insensitive. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects VITE search failing to find the node vite process.
3. **Independent oracle:** Literal query VITE and expected PID11.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 45.

### KEEP — line 51: numeric search targets exact PID

1. **Independent contract/source:** A numeric PID query selects the intended process. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects PID search selecting a different process or no process.
3. **Independent oracle:** Literal query20 and PID20.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 46.

### KEEP — line 52: user filter

1. **Independent contract/source:** User filtering restricts the table to the selected host user. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects another user's processes entering that filtered view.
3. **Independent oracle:** Root-owned fixture PIDs1 and20.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 47.

### KEEP — line 53: state filter

1. **Independent contract/source:** Status filtering selects processes in the requested state. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects sleeping processes shown under Running.
3. **Independent oracle:** Fixture running PID11.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 48.

### REWRITE — line 54: user choices are distinct

1. **Independent contract/source:** The user filter offers each reported username once. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects duplicate/missing user choices; incidental alphabetical presentation order is ignored.
3. **Independent oracle:** Independent set of fixture users orquester/root.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 49.

### KEEP — line 56: legacy daemon managed compatibility

1. **Independent contract/source:** Older daemon rows omitting managed still belong to its own process tree. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects older daemon process lists disappearing under Orquester scope.
3. **Independent oracle:** One literal legacy row without managed must survive.
4. **Stable seam:** filterProcesses/processUsers inputs and returned process data
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No other filter uses this predicate/compatibility shape; daemon tests do not execute UI filtering.

Final anchor: 51.

### KEEP — line 59: legacy managed stop allowed

1. **Independent contract/source:** A normal managed process is offered Stop. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects Stop being unavailable for a valid legacy managed process.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 54.

### KEEP — line 60: daemon stop protected

1. **Independent contract/source:** The daemon itself is never offered Stop in legacy snapshots. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an unsafe daemon Stop action being offered.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 55.

### KEEP — line 61: legacy unmanaged stop refused

1. **Independent contract/source:** A legacy snapshot cannot authorize stopping an unmanaged process. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects UI offering a target that legacy kill routes refuse.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 56.

### KEEP — line 62: agent host stop protected

1. **Independent contract/source:** The agent host is protected when legacy role tags are present. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a Stop action that would interrupt every hosted chat.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 57.

### KEEP — line 65: explicit server stop allowance wins

1. **Independent contract/source:** The daemon may mark an own-user process outside its tree stoppable. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects refusing a valid own-user container/nohup target after the documented feature change.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 60.

### KEEP — line 66: explicit server stop denial wins

1. **Independent contract/source:** A daemon stoppable:false overrides the managed flag. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects offering Stop for protected infrastructure or another refused process.
3. **Independent oracle:** Literal true/false from authored managed/role/stoppable fixture flags and independent API rules.
4. **Stable seam:** canStop at TaskManager's action-eligibility boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each row exercises a different independently documented authorization/compatibility branch; server enforcement remains separately covered.

Final anchor: 61.

### REWRITE — line 71: descending CPU with unknown last

1. **Independent contract/source:** CPU descending sorts measured values from largest to smallest and unknown readings last. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects unknown CPU sorting first or wrong data ordering; tied PID order is incidental.
3. **Independent oracle:** Fixed readings [30,5,0,0,null] and independent PID membership set.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 66.

### REWRITE — line 72: ascending CPU with unknown last

1. **Independent contract/source:** CPU ascending still places unknown readings after real zero readings. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects treating unknown as measured zero or reversing unknown placement with sort direction.
3. **Independent oracle:** Fixed readings [0,0,5,30,null].
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 68.

### REWRITE — line 73: name sorting

1. **Independent contract/source:** The Name column sorts process names alphabetically. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects incorrect lexical name sorting while tolerating arbitrary order among equal names.
3. **Independent oracle:** Literal process names bash/dockerd/node/node/systemd.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 69.

### REWRITE — line 76: descending uptime

1. **Independent contract/source:** Descending uptime puts the older process first. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects inverting start timestamp versus elapsed uptime.
3. **Independent oracle:** Literal start times1000/9000 and expected PIDs1/2.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 71.

### REWRITE — line 77: ascending uptime

1. **Independent contract/source:** Ascending uptime puts the newer process first. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects applying the descending comparator for both sort directions.
3. **Independent oracle:** Literal start times1000/9000 and expected PIDs2/1.
4. **Stable seam:** buildRows public table-model output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** These select distinct user sort modes; no private metric/comparator call is needed.

Final anchor: 72.

### KEEP — line 81: tree parent/child ordering

1. **Independent contract/source:** Tree grouping keeps children after their parent and sorts siblings by the selected metric. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a process appearing under the wrong parent or unsorted sibling branches.
3. **Independent oracle:** Authored PPID graph and literal expected PIDs[1,20,10,11,12].
4. **Stable seam:** buildRows tree model
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Flat/group tests cannot detect hierarchy traversal order.

Final anchor: 76.

### DELETE — line 82: tree indentation depth array

1. **Independent contract/source:** No independent visual regression requirement fixes numeric row-depth bookkeeping. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** The [0,1,1,2,2] array only detects implementation representation/indentation changes.
3. **Independent oracle:** Private model depths, not a user action or externally fixed byte.
4. **Stable seam:** buildRows depth field
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Parent/child process order and collapse remain protected by their semantic owners.

Failed bars: 1, 4, 5.

### KEEP — line 87: collapse hides descendants

1. **Independent contract/source:** Collapsing a parent hides its descendants while preserving its parent row and child metadata. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects toggling a process failing to fold the subtree or deleting the parent row.
3. **Independent oracle:** Literal remaining PIDs[1,20,10] and known direct children2.
4. **Stable seam:** buildRows with a user-toggled process key
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Expanded tree traversal does not exercise collapse.

Final anchor: 78.

### KEEP — line 91: filtered parent promotes children

1. **Independent contract/source:** Filtering out a parent must not discard its still-visible children. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a query-filtered process vanishing because its parent was omitted.
3. **Independent oracle:** Literal surviving child PIDs11/12.
4. **Stable seam:** buildRows tree model over filtered input
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Ordinary full trees contain their parents and cannot reveal this failure.

Final anchor: 82.

### REWRITE — line 92: recycled snapshot parent cycle terminates

1. **Independent contract/source:** A transient parent cycle in non-atomic PID snapshots must terminate without losing the listed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an infinite walk or omitted process after PID reuse across scan reads.
3. **Independent oracle:** Fixed PIDs40/41 and reciprocal PPIDs.
4. **Stable seam:** buildRows tree model
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Cycle-safe full-tree walking differs from ancestor-path walking; replace incidental row cardinality with actual PID preservation.

Final anchor: 83.

### REWRITE — line 96: name grouping and aggregate resources

1. **Independent contract/source:** Same-name processes form one group carrying their combined CPU/memory, sorted among single processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects duplicate groups, missing members or incorrect aggregate usage.
3. **Independent oracle:** Input name node, literal group order and sums30%/6000bytes.
4. **Stable seam:** buildRows name-group output
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Use authored group name rather than groupRowKey-derived expected key; no stronger test owns group creation and totals.

Final anchor: 87.

### REWRITE — line 102: expanded group member ordering

1. **Independent contract/source:** Opening a name group reveals its process members in the selected CPU order. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects an unresponsive expand action or incorrect member sorting.
3. **Independent oracle:** Literal semantic identities node/11/10.
4. **Stable seam:** buildRows invoked with the produced group row's opaque action key
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Collapsed-group aggregation does not exercise expansion; expected keys no longer come from the subject helper.

Final anchor: 93.

### REWRITE — line 107: mixed-user unmeasured name group

1. **Independent contract/source:** A mixed-user group must not claim one user, must preserve an active member's status and oldest start, and unknown CPU must stay unknown. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects misleading user/status/age and false zero CPU in grouped host resources.
3. **Independent oracle:** Authored users a/b, statuses sleeping/running, starts50/10 and null measurements.
4. **Stable seam:** buildRows group metrics rather than a private aggregation helper
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Known same-user measured totals do not cover unknown and mixed metadata.

Final anchor: 98.

### DELETE — line 113: direct descendant count duplicate

1. **Independent contract/source:** This shallower count duplicates the retained count covering every nested descendant. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** No unique Stop-warning behavior remains in the direct-only count.
3. **Independent oracle:** Expected2 follows the same descendant owner as deeper retained expected4.
4. **Stable seam:** descendantCount
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Retained process-table.check line114 counts nested descendants; subtreeSummary separately checks direct child information.

Failed bars: 6.

### KEEP — line 114: nested descendant Stop warning

1. **Independent contract/source:** Stop warnings count every descendant, including nested grandchildren, without including the selected process itself. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects understating the scope of a Stop action.
3. **Independent oracle:** Authored graph under PID1 has exactly four descendants.
4. **Stable seam:** descendantCount used by the TaskManager confirmation
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** subtreeSummary shares traversal but does not execute this separate production-used Stop-warning selector; one strongest count remains.

Final anchor: 104.

### DELETE — line 115: self-parented PID hypothetical

1. **Independent contract/source:** No independent source requires a live kernel process to be its own parent. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** The impossible single-stat fixture adds defensive branch coverage without a credible owner-visible regression.
3. **Independent oracle:** Fabricated PID5 PPID5.
4. **Stable seam:** descendantCount
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** The credible non-atomic cross-process cycle remains covered through full-tree and ancestor boundaries.

Failed bars: 1, 2.

### KEEP — line 117: subtree direct children and resource totals

1. **Independent contract/source:** Row details list direct children while resource totals include the selected process and all descendants, ignoring unknown CPU. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects incorrect child navigation or subtree CPU/RSS figures.
3. **Independent oracle:** Children11/12; descendants2; CPU30; RSS7000 from authored fixture data.
4. **Stable seam:** subtreeSummary row-detail boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Stop count does not return direct children or resource totals.

Final anchor: 106.

### KEEP — line 122: subtree excludes grandchildren from direct list

1. **Independent contract/source:** Grandchildren contribute to descendant counts but do not appear as direct child links. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a deep process being presented as an immediate child of init.
3. **Independent oracle:** Literal direct children20/10 and descendant total4.
4. **Stable seam:** subtreeSummary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The shallower daemon subtree has no grandchildren.

Final anchor: 111.

### KEEP — line 124: unknown subtree CPU remains unknown

1. **Independent contract/source:** A subtree without any CPU sample must not report measured zero CPU. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects presenting an unavailable reading as a real zero.
3. **Independent oracle:** Literal null result for the authored unmeasured PID12.
4. **Stable seam:** subtreeSummary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Known-value sums cannot distinguish no measurements from measured zero.

Final anchor: 113.

### KEEP — line 125: ancestor path order

1. **Independent contract/source:** Row details return listed ancestors from outermost to immediate parent. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects reversed or wrong process navigation.
3. **Independent oracle:** Literal PIDs1/10.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 114.

### KEEP — line 126: missing parent ends ancestry

1. **Independent contract/source:** An unlisted parent terminates the ancestor path. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects inventing ancestors outside the current process snapshot.
3. **Independent oracle:** Literal empty ancestor list for init.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 115.

### KEEP — line 127: cyclic ancestry terminates

1. **Independent contract/source:** A transient cycle cannot repeat the starting PID or loop forever. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects a hanging row-detail expansion under a recycled snapshot.
3. **Independent oracle:** Literal ancestor PID41 for reciprocal40/41 input.
4. **Stable seam:** ancestorsOf used by TaskManager row details
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Full-tree traversal uses another algorithm/output; no other ancestor scenario has this input.

Final anchor: 116.

### KEEP — line 129: core role mapping

1. **Independent contract/source:** The Orquester core strip identifies daemon and agent-host rows by their reported roles. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects the wrong infrastructure process/resource being displayed.
3. **Independent oracle:** Literal daemon PID10 and agent-host PID30 roles.
4. **Stable seam:** coreProcesses used by OrquesterCore
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** TaskManager tree grouping does not select infrastructure roles.

Final anchor: 118.

### KEEP — line 131: legacy daemon PID fallback

1. **Independent contract/source:** An older untagged daemon remains identifiable by the snapshot daemon PID. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects missing daemon data on older server versions.
3. **Independent oracle:** Explicit daemonPid7 and untagged fixture PID7.
4. **Stable seam:** coreProcesses
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Tagged role selection does not exercise compatibility fallback.

Final anchor: 120.

### KEEP — line 132: managed resource totals

1. **Independent contract/source:** Orquester totals include only its managed processes. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Detects host-wide process usage being attributed to Orquester.
3. **Independent oracle:** Literal managed count3, CPU30 and RSS7000.
4. **Stable seam:** managedTotals used by OrquesterCore
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Subtree totals have different roots/membership and do not prove managed filtering.

Final anchor: 121.

### DELETE — line 135: null columns equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### DELETE — line 136: malformed JSON equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### DELETE — line 137: wrong columns shape equals imported default

1. **Independent contract/source:** No independent contract fixes this default column membership; the expected value is imported from the same owner. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** These assertions restate the owner's own default and cannot independently judge its correctness.
3. **Independent oracle:** Expected DEFAULT_COLUMNS is production-derived.
4. **Stable seam:** parseColumns compared to its private constant
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Valid persisted selection filtering and explicit all-hidden selection survive; TaskManager loadColumns already catches unreadable storage/parser errors. Default presentation policy has no independent exact oracle.

Failed bars: 1, 3.

### REWRITE — line 138: persisted column names validated

1. **Independent contract/source:** Persisted visible columns retain known names once and discard unknown/non-string entries. Source: AGENTS.md localStorage validation; TaskManager column-menu persistence contract.
2. **Detectable failure:** Detects malformed localStorage values reaching rendering or duplicate selected columns.
3. **Independent oracle:** Literal selected set cpu/uptime, independent of display order.
4. **Stable seam:** parseColumns public persistence boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Replaces incidental canonical-order expectation; this uniquely protects stored column selection.

Final anchor: 124.

### KEEP — line 139: all columns hidden is a valid choice

1. **Independent contract/source:** An explicit empty persisted column selection must remain empty. Source: TaskManager column-menu persistence; AGENTS.md persisted configuration validation.
2. **Detectable failure:** Detects forcing defaults back after the user deliberately hides every optional column.
3. **Independent oracle:** Literal empty input list and expected empty selected set.
4. **Stable seam:** parseColumns
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Malformed/default cases do not exercise an intentional valid empty choice.

Final anchor: 125.

### REWRITE — line 142: network byte-to-bit quantity

1. **Independent contract/source:** Network API rates are bytes/s; displayed SI bit-rate text must describe the equivalent quantity. Source: SystemNetworkInfo rxBps/txBps byte-rate wire contract; standard8bits/byte and SI bitrate units.
2. **Detectable failure:** Detects an eightfold unit error or binary scaling mislabeled as decimal SI.
3. **Independent oracle:** Independent SI unit meanings and authored12500000bytes/s =100000000bits/s; interpret the displayed quantity without freezing its prefix/precision.
4. **Stable seam:** formatBitRate consumed by HostResourceCards
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** No daemon API test formats its byte-rate into UI bits; one representative multi-unit quantity remains.

Final anchor: 129.

### DELETE — line 143: second exact bitrate label

1. **Independent contract/source:** The second exact1.0Kbps label adds no unique conversion contract. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** It freezes prefix/precision beyond the retained semantic byte-to-bit quantity check.
3. **Independent oracle:** Exact generated string1.0Kbps.
4. **Stable seam:** formatBitRate
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Retained semantic rate check interprets arbitrary SI prefix/precision and catches byte/bit and base1000 mistakes.

Failed bars: 5, 6.

### REWRITE — line 144: unknown network rate is not measured zero

1. **Independent contract/source:** An unavailable nullable measurement must display a nonempty unknown marker, never a numeric zero. Source: SystemProcessInfo.cpuPercent nullable sampling and SystemNetworkInfo nullable wire readings.
2. **Detectable failure:** Detects misleading resource readings while permitting marker wording changes.
3. **Independent oracle:** Independent absence of digits plus a nonempty marker; no exact em-dash copy.
4. **Stable seam:** system-format formatBitRate at host resource display boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The numeric-rate conversion and resource sums do not protect this final unknown-display policy.

Final anchor: 133.

### REWRITE — line 146: unknown CPU is not measured zero

1. **Independent contract/source:** An unavailable nullable measurement must display a nonempty unknown marker, never a numeric zero. Source: SystemProcessInfo.cpuPercent nullable sampling and SystemNetworkInfo nullable wire readings.
2. **Detectable failure:** Detects misleading resource readings while permitting marker wording changes.
3. **Independent oracle:** Independent absence of digits plus a nonempty marker; no exact em-dash copy.
4. **Stable seam:** system-format formatCpu at host resource display boundary
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The numeric-rate conversion and resource sums do not protect this final unknown-display policy.

Final anchor: 135.

### DELETE — line 145: CPU one-decimal copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 147: seconds duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 148: hours/minutes duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### DELETE — line 149: days/hours duration copy

1. **Independent contract/source:** No independent contract requires this exact precision or compact duration wording. Source: Historical feature commits 44270a72 (task-manager search/filter/grouping/sorting), b40c7f09 (row owner/ancestor/subtree inspection), ab4d0361 (daemon-owned stoppable flag); packages/api/src/index.ts SystemProcessInfo/ProcessSnapshot contracts.
2. **Detectable failure:** Only a formatting change detector remains; it fails valid alternate presentation with the same information.
3. **Independent oracle:** Generated strings62.4%,45s,2h14m,5d3h copied from owner formatting policy.
4. **Stable seam:** system-format string output
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Unknown CPU meaning and network units retain their independent contracts; meaningful durations in workflow protocols have their own owners. No independent exact System copy requirement was found.

Failed bars: 1, 5.

### KEEP — line 36: visible session owner

1. **Independent contract/source:** A visible session resolves its own title/kind and project. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects process/port owner chips pointing at the wrong chat/project.
3. **Independent oracle:** Authored live session titleclaude, kindagent and project data.
4. **Stable seam:** resolveSessionOwner used by SessionChip
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Generic project resolution does not join a session id to its title/owner.

Final anchor: 36.

### KEEP — line 44: hidden owner: archived-project

1. **Independent contract/source:** An archived project must not reveal a session title in the System panel. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects a privacy-curtain leak through process/port owner chips.
3. **Independent oracle:** Literal null result for the independently authored archived-project input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: archived-workspace

1. **Independent contract/source:** An archived workspace must hide its session even without a loaded project record. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects bypassing the archive curtain via guessed project fallback.
3. **Independent oracle:** Literal null result for the independently authored archived-workspace input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: no-project

1. **Independent contract/source:** A session without a project must have no navigable named project owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects an orphan/invalid project chip.
3. **Independent oracle:** Literal null result for the independently authored no-project input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: kg-worker

1. **Independent contract/source:** A Knowledge-indexer worker must not appear as a user project/session owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects internal worker names exposed as normal project owners; resolveProjectRef otherwise guesses a visible project even for its appdir path.
3. **Independent oracle:** Literal null result for the independently authored kg-worker input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 44: hidden owner: unknown-id

1. **Independent contract/source:** An absent/exited session id must resolve to no owner. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects stale process/port metadata naming an unrelated or nonexistent chat.
3. **Independent oracle:** Literal null result for the independently authored unknown-id input.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Other negative inputs use different missing/archive/worker conditions; no stronger test calls this owner resolver.

Final anchor: 44.

### KEEP — line 49: workspace-only owner fallback

1. **Independent contract/source:** Before the project list loads, the known workspace path must still resolve the correct project name. Source: packages/config/src/index.ts protectArchived privacy curtain; SessionSummary owner/project contract; docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md managed worker ownership.
2. **Detectable failure:** Detects navigation/owner chips missing for an otherwise live visible session during initial loading.
3. **Independent oracle:** Literal workspacews and projectproj from authored paths.
4. **Stable seam:** resolveSessionOwner
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The visible-owner case supplies a complete project record and cannot exercise fallback.

Final anchor: 49.

### KEEP — line 5: kill refusal: PROCESS_PROTECTED

1. **Independent contract/source:** The public kill refusal code PROCESS_PROTECTED must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 5.

### KEEP — line 6: kill refusal: PROCESS_NOT_MANAGED

1. **Independent contract/source:** The public kill refusal code PROCESS_NOT_MANAGED must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 6.

### KEEP — line 7: kill refusal: INVALID_PID

1. **Independent contract/source:** The public kill refusal code INVALID_PID must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 7.

### KEEP — line 8: kill refusal: INVALID_SIGNAL

1. **Independent contract/source:** The public kill refusal code INVALID_SIGNAL must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 8.

### KEEP — line 9: kill refusal: UNSUPPORTED_PLATFORM

1. **Independent contract/source:** The public kill refusal code UNSUPPORTED_PLATFORM must survive ApiError.body decoding. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects collapsing this caller-visible refusal into a generic error message.
3. **Independent oracle:** Literal code defined independently by KillProcessErrorCode wire contract.
4. **Stable seam:** killErrorCode used by TaskManager error handling
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Every code has a different user remedy; omission of this specific recognized code is not caught by sibling codes.

Final anchor: 9.

### KEEP — line 10: future unknown kill code

1. **Independent contract/source:** An unknown/future refusal code must fall back rather than masquerade as a known refusal. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects forwarding an unsupported server code into typed UI policy.
3. **Independent oracle:** Literal unknown codeSOMETHING_ELSE and null fallback.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Recognized-code cases cannot detect overaccepting an arbitrary code.

Final anchor: 10.

### KEEP — line 11: network kill failure has no code

1. **Independent contract/source:** A genuine request/network Error without an API refusal body has no recognized kill code. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Detects error handling crashing while reporting a failed request.
3. **Independent oracle:** Native Error fixture and expected null.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** This common actual error shape differs from a future well-formed API body.

Final anchor: 11.

### DELETE — line 12: null thrown kill failure

1. **Independent contract/source:** No independent caller contract or actual API failure source throws this primitive. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Adds hypothetical optional-chaining branch coverage beyond a real network Error.
3. **Independent oracle:** Fabricated null/undefined catch values.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Actual network Error and future unknown-code tolerance remain protected.

Failed bars: 1, 2, 6.

### DELETE — line 13: undefined thrown kill failure

1. **Independent contract/source:** No independent caller contract or actual API failure source throws this primitive. Source: packages/api/src/index.ts KillProcessErrorCode/KillProcessErrorResponse; TaskManager stop-error handling.
2. **Detectable failure:** Adds hypothetical optional-chaining branch coverage beyond a real network Error.
3. **Independent oracle:** Fabricated null/undefined catch values.
4. **Stable seam:** killErrorCode
5. **Refactor resistance:** Deleted because the failed bar below prevents legitimate retention.
6. **Unique protection/surviving owner:** Actual network Error and future unknown-code tolerance remain protected.

Failed bars: 1, 2, 6.

### KEEP — line 8: busiest usage driver

1. **Independent contract/source:** Busiest chip preference selects the agent with the highest reported window usage. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects choosing first agent or weekly-only maximum.
3. **Independent oracle:** Claude10/20 versus Codex80/5 selects codex.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 8.

### KEEP — line 9: pinned usage driver

1. **Independent contract/source:** An available explicitly pinned agent overrides busiest. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects ignoring the user's persisted chip preference.
3. **Independent oracle:** Pinnedclaude wins despite Codex80%.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 9.

### KEEP — line 10: missing pinned driver fallback

1. **Independent contract/source:** When the pinned provider is absent, the available busiest provider drives the chip. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a blank chip after logout/provider availability changes.
3. **Independent oracle:** Codex is the only available row.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 10.

### KEEP — line 11: empty usage driver

1. **Independent contract/source:** No available usage readings yield no driver. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a crash on an empty logged-in provider list.
3. **Independent oracle:** Literal null for empty input.
4. **Stable seam:** pickDriver consumed by UsageWidget
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each distinct persisted preference/availability mode lacks another selector owner.

Final anchor: 11.

### REWRITE — line 14: default-enabled missing usage agents

1. **Independent contract/source:** Default-enabled supported usage agents must offer login hints when absent. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a new installation hiding its missing-provider setup hints.
3. **Independent oracle:** Supported Claude/Codex/Grok ids from README/config contract, independent of visual order.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 14.

### REWRITE — line 15: present usage agents not missing

1. **Independent contract/source:** A provider already in the snapshot must not be shown as needing login. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects a false setup warning for an authenticated provider.
3. **Independent oracle:** Presentclaude excludes onlyclaude; codex/grok remain.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 15.

### REWRITE — line 16: disabled usage provider not missing

1. **Independent contract/source:** An explicitly disabled agent must not receive a missing-agent hint. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects ignoring the per-agent usage preference.
3. **Independent oracle:** Codexfalse leaves onlyclaude/grok.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 16.

### KEEP — line 17: disabled usage widget has no missing hints

1. **Independent contract/source:** The master disabled preference suppresses all missing-agent hints. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects prompting for disabled usage integration.
3. **Independent oracle:** Literal empty set when enabledfalse.
4. **Stable seam:** missingUsageAgents consumed by UsageWidget and UsageOverview
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Each covers a different enabled/present input; exact display order is discarded.

Final anchor: 17.

### KEEP — line 19: no measured windows

1. **Independent contract/source:** A provider with no readings yields no displayed windows. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects manufacturing empty misleading bars.
3. **Independent oracle:** Literal empty result for null session/weekly.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Scoped-only and credit windows contain actual measurements.

Final anchor: 19.

### REWRITE — line 20: shared and scoped window data preserved

1. **Independent contract/source:** Session/weekly/scoped readings and the scoped reset time must survive normalization. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects dropping a model-scoped quota or mixing its reset metadata with a shared window.
3. **Independent oracle:** Literal percentages10/96/100 and Fable reset timestamp; presentation order is ignored.
4. **Stable seam:** normalizeUsageWindows used by usage cards
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Provider-window merging tests operate a different wire source and do not protect poll-snapshot normalization.

Final anchor: 20.

### KEEP — line 27: scoped-only provider window

1. **Independent contract/source:** A model-scoped reading remains visible even when shared session/weekly pools are absent. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects gating all output on a shared-pool reading.
3. **Independent oracle:** Literal scoped percent40.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** The mixed snapshot has shared windows and cannot expose this gating error.

Final anchor: 28.

### KEEP — line 31: Grok credit capacity metadata

1. **Independent contract/source:** Grok weekly quota is denominated in credits and preserves used/limit/remaining/reset values. Source: README.md Usage widget and Grok weekly credit pool; packages/config/src/index.ts UsagePrefs enabled/agents/chip configuration; AgentUsage/UsageWindow/ScopedUsageWindow wire data.
2. **Detectable failure:** Detects displaying a percent-only or wrong-unit quota and losing capacity information.
3. **Independent oracle:** README weekly credit pool plus authored700/1000/300 and reset timestamp.
4. **Stable seam:** normalizeUsageWindows
5. **Refactor resistance:** Semantic data/state/protocol outcomes at the production boundary; no source inspection, private helper calls, opaque generated keys, exact formatting precision, CSS, or geometry expectation.
6. **Unique protection/surviving owner:** Claude percent-only/scoped windows carry no credit capacity metadata.

Final anchor: 31.
