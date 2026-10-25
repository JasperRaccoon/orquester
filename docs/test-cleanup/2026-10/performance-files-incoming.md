# Incoming file-browser performance tests

Audit scope: incoming `9983fb4fb5f85b4b05f02bf79cae67cd969f171c` against `7feff9eb`, limited to `packages/ui/src/components/files/file-browser-refresh.dom.test.ts`, its `FileBrowser.tsx` / `FilePreview.tsx` / `BinaryCard.tsx` owners, and both `packages/ui/test/performance` utilities. The production listing comparison and lazy-preview optimization are preserved.

The incoming suite had four declarations, seven expanded test cases. It now has three declarations/cases: DELETE 1, REWRITE 3, CONSOLIDATE 3. Test LOC: 149 → 138, net −11. No fixtures, snapshots, dependencies, configuration or production seams became unused. Removed the automated suite's React Profiler import, render-commit counters, warm-up refreshes, class-tree selectors and parameterized commit-count assertions. The manual benchmark retains its Profiler deliberately.

## Independent sources and production consumers

- `README.md`, Files, git & todos: browsing files/directories and rich previews are user-facing capabilities.
- `packages/api/src/index.ts`, `FsEntry` / `FsListResponse`: a listing carries each entry's name, path, kind and byte size; `listFiles` / `readFileBytes` are client API boundaries.
- `apps/daemon/src/index.ts`, `RAW_MAX_BYTES` and `/api/fs/raw`: buffered raw reads are capped at 50 MiB. The preview's mirrored policy must use the refreshed entry size. Test inputs are handwritten 30 MiB and 60 MiB, not imported UI policy constants.
- File navigation's master/detail Back behavior predates the optimization; `FileBrowser`'s documented component contract and incoming `9983fb4f` lazy-loading change identify a credible integration failure: selected files, Back, or reopening can stop mounting the real preview.
- Non-test callers: the shared frontend mounts `FileBrowser`; its actual `TreeLevel` calls the selection/directory actions, `FilePreview` dispatches the selected path and size, and `BinaryCard` reads the selected path through the public API. No helper export or injection hook was introduced.

## Every incoming test's disposition

All rows below refer to `packages/ui/src/components/files/file-browser-refresh.dom.test.ts` at `9983fb4f`. The field loop is expanded into its four concrete cases so no hidden case is omitted.

| Incoming test | Disposition | Failed bar or surviving behavioral owner |
| --- | --- | --- |
| still fetches fresh listings without reconciling an unchanged tree | DELETE | B4/B5 fail: exactly zero React commits is private reconciliation policy and fails harmless rendering refactors. Three fetches plus unchanged names provides no unique refresh protection beyond the changed-listing owner. Manual benchmark still measures commit/runtime cost without imposing implementation shape on the regression gate. |
| opens the lazy preview on selection and restores the empty pane on Back | REWRITE | The real preview still mounts after selecting a file, Back removes preview actions, and the same file reopens. Replace full English/size-format copy matches and markup classes with public buttons and a literal raw-file request path. Consolidate refreshed-size eligibility here. |
| applies a changed entry name | CONSOLIDATE | Visible filename updates now belong to the listing-membership test. The fixture renames both name and path coherently, and the oracle is the literal current filenames. Private commit count removed. |
| applies a changed entry path | CONSOLIDATE | Original path-only fixture disagreed with its unchanged basename and only checked commit count; B1/B4/B5 fail for that assertion. Real selection now verifies the literal requested `/workspace/project/first.pdf` byte path, and directory navigation verifies `/workspace/project/first.bin`, through public API calls. These owners protect meaningful path routing without inventing an inconsistent listing. |
| applies a changed entry kind | REWRITE | Replace commit-count proof with a file replaced by a directory at the same path. Clicking it must issue the directory-list request and display its child, rather than open a file preview. No remaining test owns this refresh-to-navigation transition. |
| applies a changed entry size | CONSOLIDATE | The preview owner first opens a 30 MiB file with its buffered Download action, then refreshes the same entry to 60 MiB and verifies that action is unavailable. This catches stale-size selection across the independently established 50 MiB raw-read ceiling. |
| applies reordered, added and removed entries, including an empty listing | REWRITE | Keep actual listing membership updates and empty-result removal. Drop input-order presentation assertions, English empty-state copy and repeated zero-commit probes, which have no independent ordering/copy/render-count requirement. Handwritten filenames are compared as sets via sorted button labels. |

## Six-bar evidence for every surviving owner

### `refreshes renamed, added and removed files, including an empty directory`

1. Independent contract: the public filesystem listing supplies the files a user can browse; external changes must be reflected by the Refresh action.
2. Real regression: an optimization that freezes a prior nonempty listing, loses additions, or leaves deleted/renamed rows visible fails the literal membership assertions.
3. Independent oracle: expected arrays are handwritten `first.bin`, `second.bin`, `renamed.bin`, `third.bin`, and empty; none comes from comparison helpers or the implementation's output.
4. Stable seam: the actual Refresh button, `listFiles` response, and file buttons carrying user filename data. No CSS class or sibling structure is inspected.
5. Refactor resistance: React component splits, state representation, rendering frequency and input ordering can change while the test still passes.
6. Unique protection: API filesystem tests do not prove that this frontend applies updated responses; preview and directory tests do not prove addition/removal/empty membership. This is the lowest existing seam that spans response caching to visible listing data.

### `opens the selected file, returns with Back and honors refreshed download size`

1. Independent contract: README file preview/navigation capability, the existing mobile master/detail Back workflow, public byte-read route, and daemon's 50 MiB buffered read ceiling.
2. Real regression: lazy preview never mounts, Back fails to clear selection, the same file cannot reopen, wrong selected path reaches the API, or a stale smaller entry size keeps buffered download enabled after growth.
3. Independent oracle: literal byte path `/workspace/project/first.pdf`; existence/removal of Back and Download actions; handwritten 30 MiB / 60 MiB inputs on opposite sides of the daemon limit.
4. Stable seam: click the real file row and preview actions, observe public `readFileBytes(path)`. The API dependency records the requested path and rejects to avoid initiating a browser save; it does not simulate preview/selection behavior.
5. Refactor resistance: no module-load count, React identity, commit count, markup class or complete English copy is asserted. Awaiting the real preview import synchronizes the actual lazy boundary deterministically.
6. Unique protection: pure file-kind tests cannot detect broken lazy selection, Back/reopen or stale listing size propagation; generic lazy-dialog tests do not mount this real preview. One scenario owns these adjacent transitions without extra component mounts or PDF-engine startup.

### `refreshes a file replaced by a directory and opens its listing`

1. Independent contract: `FsEntry.kind` determines whether the public file browser browses a directory or previews a file.
2. Real regression: stale cached `kind: file` makes a replaced directory open a preview and prevents browsing its child.
3. Independent oracle: literal next request `/workspace/project/first.bin` and child filename `child.bin`; no reference projection or production constant supplies the expectation.
4. Stable seam: user clicks the named entry, the API lists its path, and its child becomes a selectable file button.
5. Refactor resistance: tree structure, icon, CSS, React commits and loader implementation can change without invalidating the observed navigation.
6. Unique protection: the membership owner never changes entry kind; the preview owner only selects files. Daemon listing tests cannot prove that the UI uses a refreshed kind for navigation.

## Manual performance utilities

| Path | Disposition | Reason |
| --- | --- | --- |
| `packages/ui/test/performance/file-browser-refresh.ts` | KEEP as a diagnostic, not a regression test | Explicitly documented standalone benchmark, excluded from `src/**/*.test.ts` and check discovery. Runs real FileBrowser against in-memory API responses, recording requests, React work and wall time. Commit counts and rendered-file counts are useful measured workload diagnostics here; they are not contractual pass/fail assertions. No new dependency, server, sleep or CI workload. |
| `packages/ui/test/performance/bundle-audit.mjs` | KEEP as a diagnostic, not a regression test | Explicit standalone CLI reports actual emitted static chunk closures and raw/gzip sizes for an entry, excluding initial-page chunks and deferred dynamic imports. Useful reproducibility tool for the incoming lazy-loading claim; reads already built output and adds no gating execution or build. Its AST/source reads calculate a measurement, not a brittle correctness assertion. |

Neither diagnostic is counted as a retained regression test, and neither contributes to the required suite runtime. No speedup is inferred from incoming commit-message measurements.

## Validation and performance status

The implementation workstream did not start tests, typechecks, builds or benchmarks while root's isolated baseline was active. Root subsequently completed these integrated gates:

- `pnpm check:changed --no-cache --base 0e61cd5dfed987e9bcbafe097e2582f90586ef4f` — PASS. The integrated three-file UI test group, including the rewritten FileBrowser target, passed in 14.9 seconds. This is aggregate gate time, not an isolated file measurement or a before/after speedup. Evidence: `/tmp/orquester-test-audit/integrated-gates.log`.
- `pnpm check` — PASS for the full workspace typecheck.
- `TSX_DISABLE_CACHE=1 pnpm build` — PASS, including emitted web and desktop assets.
- `node /tmp/orquester-test-audit/smoke-file-preview.mjs /var/lib/orquester/workspaces/jaspersito/orquester /tmp/orquester-test-audit/file-preview-smoke` — PASS against the actual emitted browser bundle. The browser opened the directory, selected `preview.ts`, displayed `export const previewContract = 42;` in CodeMirror, returned with Back and reopened the file. Emitted FileBrowser, FilePreview and editor chunks were fetched, and the synthetic file read used the expected path. No live daemon, real account or disk-file edit was involved.

Browser evidence is under `/tmp/orquester-test-audit/file-preview-smoke/`: `results.json` records `passed: true`, `problems: []`, four steps and the JavaScript requests; `surface-results.json` records `unexpected: []` and `serverStopped: true`. The four screenshots are `directory.png`, `first-preview.png`, `back-to-directory.png` and `reopened-preview.png`. The separately recorded background home-API `/api/config/remotes` 401 responses are expected unauthenticated requests, not preview failures.

The first temporary browser fixture decoded filesystem paths incorrectly, so that initial smoke attempt failed on its synthetic API's 404 responses. Root fixed only the temporary fixture to honor the shipped `?p=` base64url path protocol and reran successfully. No timeout increase or production/test source change was needed. The earlier integrated wrapper therefore records a smoke-fixture failure after its successful typecheck/build stages; it must not be presented as a wholly successful wrapper run.

Scoped `git diff --check -- packages/ui/src/components/files/file-browser-refresh.dom.test.ts` passed during implementation. The final full `pnpm test` is active at this document update; its result remains owned by root's final report and is not claimed here.

The fixture mounts an inactive tree and uses its explicit Refresh action, avoiding the active poll timer and rendering warm-up. It creates no PDF engine and awaits module loading directly. No comparable isolated baseline/final runtime measurement was collected for this incoming test file, and no cleanup speedup or CI saving is claimed for it. The retained manual diagnostics were reviewed but not executed by this workstream.
