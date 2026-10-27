TEST SUITE CLEANUP — FINAL INTEGRATION REPORT

The repository-wide cleanup is implemented. Final integrated source passes the
full default suite, all workspace typechecks, the changed-files gate, the complete
production build and explicit pinned real-model checks. performance-results.json
records measurements; delivery.json records integration. Earlier area reports
are phase records: their pending notes are superseded by validation-results.json
and this report, not claims of additional runs.

SCOPE AND COUNTING

All initial tests and incoming tests were read with their production owners.
Remote knowledge-retrieval, Devices, performance, MCP schema and unlike-search changes were merged and
re-audited rather than overwriting either feature work or the cleanup.

Latest upstream comparison: b1c975af002cbc27d37296dc04f4aa81fc76881f.
                    Upstream       Final        Change
Test/check/Go files     1,091       1,080           -11
Test source LOC       297,278     291,774        -5,504
Source declarations    11,543      11,176          -367

Effective outcomes across all 11,543 upstream declarations/families:
KEEP 9,815; DELETE 188; REWRITE 1,005; OPTIMIZE 278; CONSOLIDATE 257.
A parameterized family counts once; mixed deleted/retained vectors are REWRITE.
CONSOLIDATE counts donors and surviving owners, not 257 deleted tests. Runtime
Node counts differ because nested/parameterized cases expand and root-sensitive
fixtures execute selected child processes. Do not add overlapping phase totals.

Ten standalone .check.ts scripts have a separate 125-scenario ledger:
KEEP 81; DELETE 13; REWRITE 18; OPTIMIZE 13. Their final 112 scenarios are not
additional Node source declarations. Six upstream .bench.ts developer diagnostics
remain outside the regression gate; their before/after controls are intentional.
The initial repository had 959 files/272,366 test LOC/10,570 declarations; incoming
features grew the suite, so that earlier tree is not the final deletion baseline.

TEST-BY-TEST EVIDENCE

- effective-dispositions.jsonl.gz: every latest-upstream declaration, disposition
  and evidence report; effective-summary.json has the totals (zero missing).
- surviving-protection-index.jsonl.gz: every final declaration, source owners and
  evidence reports (11,176 mapped; zero unmapped or DELETE-only survivors).
  Of these, 168 renamed/new/consolidated declarations use direct evidence reports
  instead of baseline sourceOwners; they are intentionally not baseline identities.
- standalone-dispositions.json: all 125 standalone scenarios and their evidence.
- Each named subsystem .json/.md ledger supplies path/name, independent contract
  source, credible caller-visible failure, independent oracle, stable seam,
  refactor resistance, unique protection/duplicate owner, callers and validation.
  File-level evidence applies to each named case beneath it; case rows identify
  the distinct input/failure. Follow-up ledgers override earlier identities as
  explained by effective-summary.json. They are not additional coverage counts.
- initial-* and devices-* summaries describe earlier source revisions only.
  incoming-* covers retrieval integration; devices-* covers Devices integration;
  dead-seams-* and final-aliases-* cover final seam/caller reviews; perf-* covers
  the ee5c3249 changes. incoming-schema-refs.* records final e866b62b consolidation.
  schema-effective-summary.json and unlike-effective-summary.json preserve phase
  counts and exact deltas. incoming-unlike.* records the final search fix and
  literal-vector/real-model test rewrites.
  final-review.md records independent integration
  review and the TMPDIR portability correction.

The indexes are plain gzip-compressed JSON Lines; for example:
  gzip -dc docs/testing-audit/effective-dispositions.jsonl.gz | head -1

IMPLEMENTED CLEANUP AND CONTRACT FIXES

Removed private source/export inventories, copied expectations, incidental copy,
CSS/geometry/DOM probes, mock self-confirmations and duplicate scenarios. Public
wire bytes, auth/privacy, durable storage, tolerant migrations, typed refusals,
real process ownership and critical UI behavior remain with their lowest stable
owner. No required gate was removed or important failure hidden with a skip or
retry. Default four-worker isolation and ten-minute test timeout are unchanged.

Removed eleven test files, including private formatter/geometry probes, secret-text
unit duplicates and a newly incoming test-only fake-box seam. Surviving public
owners are linked in their ledgers. Deleted five orphan Android/AVD fixtures
(817 LOC). No snapshot or test configuration needed removal. No existing dependency became
unused; the independent decoder described below is the one added development dependency. Dead fetch/clock/
timing/cache/backend/root/stream options, helper exports and wrappers were removed
after checking production callers. Actual native ports, GitRunner, credential
watch/read, the OIDC domain clock, documented preparers and live UI adapters stay.
There is no removed production-facing API. Leaf dead-seam ledgers list each port.

An independent JPEG decoder (jpeg-js 0.4.4, development-only, no transitive
packages) and five libpng-generated filter fixtures (8,930 bytes, provenance
included) replace an inverse-codec oracle and private codec exports. Namespace
fixtures now use real child processes in owned temporary directories with
canonical-path containment and isolated HOME/TMPDIR/npm cache and environment.
The mapper is a controlled fixture adapter, not a general OS security sandbox.

Legitimate defects exposed during the audit were fixed at their owners:
- Unknown future sync-change states survive age retention.
- Repeated workflow secret protection preserves existing private-use markers and
  does not nest markers when a secret value equals another secret's name.
- Known-OS device-pool cache records unreadable by this version survive rewrites;
  valid current updates take precedence.
- Pairing normalization/parsing rejects raw shell metacharacters in an unquoted
  curl URL while accepting encoded data and normal base paths.
- Native graph layouts accept valid concept IDs such as __proto__, returning
  finite own-key results without changing ordinary layout output.
Upstream's fuller tar input-drain/producer-EOF correction is preserved; an earlier
local --ignore-zeros workaround and redundant padding case were superseded.
The final incoming MCP fix constructs equivalent fresh schemas so supported clients
receive inline array/object shapes. Its two new tests were consolidated into the
existing actual chat/external tools-list owner; both schema-reference mutants
failed at the intended public wire assertion and both restored controls passed.
The later search fix keeps original-target similarity eligibility and applies
unlike steering to ordering. Its narrow-cone regression now uses four literal
3D vectors and independent expected candidate IDs, replacing a generated model
and a second query as oracle. The real-model case requires the known repost in
both outputs before checking downward rank; duplicate exclusion coverage was
removed. The old subtractive target and a missing-penalty mutant each fail their
intended public assertion. Set preservation is asserted only for the bounded
fixture: candidate/page caps may legitimately change returned sets at scale.
No product behavior was changed merely to preserve an invalid test.

MEASURED PERFORMANCE

Final post-b1c full pnpm test: 527.857 s (8.8 minutes); 11,411 Node pass,
zero failures, 32 existing skips, plus Go and standalone checks. Frozen source
hashes stayed unchanged. No separate b1c full-suite baseline was timed.

Prior post-e866 full pnpm test: 518.834 s; 11,410 Node pass, zero failures,
32 existing skips, plus successful Go and standalone checks. There is no separate
e866 full-suite baseline: the matching comparison below is explicitly pre-schema.

Matching pre-schema reference ee5c3249: 528.815 s (8m48.8s), four fixture failures, 40 skips.
Pre-schema final matched full suite: 524.133 s (8m44.1s), zero failures, 32 skips.
Observed difference: 4.682 s / 0.885%. This is within ordinary variance and does
not establish a reliable overall or hosted-CI speedup. No CI job was measured.

The final workload is stronger: the supposed 5,000-entry performance fixture
contained only 2,340 distinct IDs (the first 1,000 yielded 470). IDs are now
injective and assertions prove all 5,000 records exist. Thus these whole-suite
runs are not identical-workload algorithm benchmarks. Runtime counts went from
11,828 registered Node cases (11,784 pass, four fail, 40 skip) to 11,442 (11,410
pass, zero fail, 32 skip). Go and standalone scripts also succeeded in the final
run and are not added to the Node counts.

Comparable focused measurements, with independent mutation controls in ledgers:
- Grok replay file: 20.04 s -> median 6.56 s (67.27%; repeats 6.54/6.56/6.73).
- Two-hour jitter simulation: median 2.103256 -> 1.038307 s (50.63%; three pairs),
  retaining all 7,200 samples and complete statistics.
- Three image files: 2.89 -> median 1.62 s (43.94%; repeats 1.64/1.62/1.62),
  including consolidation/lean fixtures, not a production codec speed claim.
- MJPEG file: median 0.581540 -> 0.467557 s (19.60%; three alternating pairs).
- Fake Android golden cutout: 7.51292 s -> 8.43-9.11 ms, using virtual time.
- Workflow orphan case: 5.06097 s -> 48.92/56.93 ms; the actual orphan's death
  is still observed before advancing the parent-only deadline.

Cache-case counts fell 55 -> 49, but measured wall-time differences were within
noise; no speedup is claimed. V8 compile-cache and six-worker experiments were
rejected: no material benefit, additional cache work or CPU cost. No runner
complexity was added to report a misleading improvement.

Slowest measured-reference file harnesses: HTML browser 28.116 s; device cache
20.125 s; Grok replay 18.293 s; Grok lifecycle 14.124 s; sandbox 12.211 s.
Slowest final harnesses: HTML browser 32.269 s; Grok lifecycle 14.704 s; knowledge
search performance 8.729 s; Android box host 8.681 s; UI history 8.019 s.
Fresh browser processes protect profile/privacy isolation. Real process grace,
child identity and orphan ownership cannot safely become mocked success. Search
protects the full 5,000-entry workload and result fidelity. Hardware-host tests
protect capacity admission/private environment and actual temporary lifecycle.
These costs remain justified. No wider sharing/concurrency change was proven safe
and materially faster. Per-file/case timings exclude some pre-import work;
whole-suite wall/CPU include setup. Max RSS is the largest child, not aggregate.

Environment: Node 24.22.1, pnpm 10.12.1, Go 1.26.1, four available CPUs; packages
sequential, at most four Node file workers; TSX_DISABLE_CACHE=1; no V8 cache.
Timed suites/builds did not overlap. OS/Go caches were retained, not cold-CI runs.
Ambient ORQ_* variables were stripped identically. performance-results.json has
exact command arrays, resource measurements, slow-file/case tables, source hashes
and repeats. timing-events.jsonl.gz preserves compact baseline/final observations.
measurement-reporter.mjs is an optional diagnostic reporter, not a required gate.

VALIDATION AND BASELINE FAILURES

PASS: pnpm check (all eight workspace packages, including Go vet).
PASS: pnpm check:changed --no-cache --base ee5c3249 (416 selected test files plus
all dependent typechecks; its pre-merge comparison resolves merge-base 610d3c53).
PASS: pnpm build (web, desktop and Linux x64 AppImage); native modules restored and
verified for Node after Electron packaging. Bundler/platform metadata warnings
were nonfatal and unrelated. Emitted artifacts remain ignored, not committed.
PASS: completed full matching suite, all Go/standalone/package/root scripts.
PASS: focused controls, mutation experiments and static/caller/diff reviews.
The pre-schema second official pnpm test passed in 522.517 s with the same 11,410 pass /
32 skip / zero failure Node totals; source hashes remained unchanged. Its 1.616 s
spread from the first final run reinforces the limits on the global speed claim.
The final post-schema and post-unlike changed gates, full pnpm check, production
build and full pnpm test also passed. Native modules and source hashes were verified unchanged.
Exact command/results and artifact hashes are in validation-results.json; exact
focused command lists and mutant failure witnesses are in subsystem ledgers.

The measured reference's four failing contracts were retained: three checkpoint
capture/prune/privacy cases and one whole-profile rollback case used filesystem modes
that uid 0 bypasses. Checkpoint failures now use real rejecting Git hooks/ref locks instead of mode
bits; profile rollback executes the same native write failure as an unprivileged
child. Their real failure/rollback assertions remain.
Earlier reference revisions had additional fixture failures; details are in the
phase ledgers. There are no unresolved final test failures.

Integration diagnostics initially found type-inference errors, two stale fixture/
locator oracles and a profile-readiness cleanup race. They were fixed and rerun.
One premature duplicate changed-gate run was interrupted while the first gate
continued; it is excluded from successful results and performance comparisons.
No partial/interrupted invocation is counted as a passing gate. Subsequent clean
changed/full gates passed. Final source hashes were unchanged during measured
validation; test mutants were restored and verified before final gates.

Real Android/iOS SDK/emulators/KVM, macOS/GPU, live provider/paid hosts and the
optional full Python/runtime installation were not exercised. The pinned embedding
model was downloaded into owned temporary storage, all five files matched their
pinned sizes/SHA-256 values, and the five actual-model/evaluation/tokenizer tests
passed in 3.832 s with zero skips. No download was added to the default test gate.
Thirty-two existing final skips remain:
11 root/permission-sensitive cases, four missing box-Chrome cases, ten missing
desktop-server cases, and seven archive/audio/runtime/model cases. These paths
are not claimed as validated by the default gate. Three model cases were
additionally verified with the explicit opt-in above. Real bsdtar archive checks
were also run using an owned
portable extraction outside PATH defaults (8/8, including 18 hostile archives),
without changing the standard timing environment. This work launched no live daemon/dev server or
deployment, and did not restart the live daemon. No separate lint script
exists; typechecks, Go vet, builds, tests and git diff --check are the actual gates.

BASELINE FIXTURE SAFETY INCIDENT

The initial unmodified bootstrap test ran as root; BusyBox's builtin id bypassed
its PATH stub and the fixture overwrote the live orq-agent executable with a
441-byte fake and a synthetic bootstrap-token file. The running process retained
the original inode. The exact 7,811,232-byte ELF was recovered atomically from
/proc/1226/exe, checked byte-for-byte and restored with mode 755, without restarting
or signaling the process. Only the token matching the known synthetic fixture was
removed. The bootstrap fixture now actually drops to uid/gid 65534 under root and
changes ownership only inside its own scratch tree. The same minimal safety fix
was applied to each reference checkout before measuring. This incident is not
hidden by a green final run; it led to actual native fixture isolation.

GIT DELIVERY

Work remains on main as requested. Cleanup commit 701ab21b, retrieval merge
301959ab and Devices merge b659841b preserve incoming history. The final ee5c3249
merge is 9b6308a714c77d89baf534e7476d1db912acb186. Report/confirmation and push
status are recorded in delivery.json and the final chat reply. Fetch and
integration use ordinary merges; no history rewrite, force push or protection
bypass is authorized. The final chat reply records the actual push result and
remote-HEAD verification. The additional e866b62b merge preserves the schema fix
and consolidates its two duplicate catalog setups. No deployment is part of this task.
