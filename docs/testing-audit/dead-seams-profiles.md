# Profile drain-only seam removal

This is a synchronization/dead-seam follow-up, overlapping original ledgers; counts must not be added as new tests. No declared behavioral contract is deleted.

Removed `SessionProfileLifecycle.idle()`, its background promise Set and tracking wrapper after repository-wide callers proved they served only tests. Production `stop()` remains synchronous and aborting; existing per-key job/GC chains, error handling and preparer/lease/context-clock ports remain. README no longer advertises the drain.

Synchronization uses actual `ensureReady` promises, public preparation status events, public `gc()`, and native filesystem notifications. Automatic publish/availability/periodic GC still must cause its own filesystem effect. No fixed poll count, sleep or replacement production flag was introduced.

Counts: DELETE 0, REWRITE 20, OPTIMIZE 0, CONSOLIDATE 0, KEEP 11. Exact incoming 610d declaration names remain their final aliases. No new timing measurement or speedup is claimed. Scoped diff/reference checks passed. Focused lifecycle+integration execution passed twice: 34/34 expanded cases each, 6.84 s and 6.94 s wall. Root owns whole-repository gates.

Validation command (twice, timed with `/usr/bin/time`): `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=30000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts src/session-profiles/integration.test.ts`. Logs: `/tmp/orquester-test-audit/profiles-dead-seams-focused.log` and `/tmp/orquester-test-audit/profiles-dead-seams-focused-repeat.log`. Both runs have zero failures, skips and cancellations. The initial 33/34 run exposed an ENOTEMPTY staging race: restart waited only the selected agent while another preparer still wrote files. Awaiting all default-agent actual readiness promises plus public GC before restart fixed it; teardown also waits for public GC. No receipt hung. These measurements have no equivalent pre-change baseline, so no speedup is claimed.

Rejection handling formerly attached by `track` remains explicit without tracking: public `gc()` returns its original promise and attaches a handler; fire-and-forget collections and job promises attach `catch(noop)`. Actual callers retain their original results/rejections.

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:171`

`prepares atomically for the final path and answers the ready dir`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 staging/atomic publication
- **Real regression:** Partial homes or nonprivate artifacts become launchable.
- **Independent oracle:** Literal manifest identity, actual final content/path/mode and empty staging.
- **Stable seam:** ensureReady plus native files
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Atomic publication and private staging path are not proven by launch wiring.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** prepares atomically for the final path and answers the ready dir
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:203`

`refuses an agent without a preparer and reports it not-prepared with the reason`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.5 unsupported profile agents
- **Real regression:** An unsupported agent launches with Global rather than refusing.
- **Independent oracle:** PROFILE_UNSUPPORTED_AGENT and explicit not-prepared state.
- **Stable seam:** ensureReady rejection and status
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** No other case uses a missing agent preparer.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** refuses an agent without a preparer and reports it not-prepared with the reason
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:213`

`answers PROFILE_NOT_FOUND for an unknown profile`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.5 launch refusal; path containment
- **Real regression:** Unknown or traversing profile ID is launched/read.
- **Independent oracle:** PROFILE_NOT_FOUND for absent and ../evil identifiers.
- **Stable seam:** ensureReady rejection
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Absent/traversal identity differs from preparation failure.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** answers PROFILE_NOT_FOUND for an unknown profile
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:219`

`keeps the previous ready dir when a preparation fails, reports the reason and never leaks a secret`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.5–5.6; AGENTS.md host-only secrets
- **Real regression:** Failed preparation destroys the old version or leaks its credential in status/log/event.
- **Independent oracle:** Authored token absent in errors/logs/events; previous immutable bytes intact; failed/ready states.
- **Stable seam:** ensureReady, native previous files and emitted status
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Only this fixture injects a secret-bearing preparation error and then recovers.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** keeps the previous ready dir when a preparation fails, reports the reason and never leaks a secret
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:260`

`dedupes launches onto the preparation in flight`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 bounded preparation queue
- **Real regression:** Concurrent launches create redundant competing homes.
- **Independent oracle:** One real adapter preparation receipt and equal returned immutable version identity.
- **Stable seam:** ensureReady callers and actual preparer port
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Ordinary sequential cache reuse cannot catch overlapping initial callers.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** dedupes launches onto the preparation in flight
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:282`

`answers a waiting launch with the failure in flight instead of retrying`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 in-flight job results
- **Real regression:** Waiting launch retries the same failed preparation instead of receiving its actual failure.
- **Independent oracle:** Both caller promises reject with authored validation reason; single adapter execution.
- **Stable seam:** ensureReady promises + adapter port receipt
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Distinct from successful dedupe: failure must not trigger a hidden retry.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** answers a waiting launch with the failure in flight instead of retrying
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:303`

`serializes one key, runs different keys concurrently, and caps them globally`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 resource cap/key queue
- **Real regression:** Same-key preparations overlap or global job concurrency exceeds its cap.
- **Independent oracle:** Explicit start/release receipts, max simultaneously running adapter jobs=2, two serialized key versions.
- **Stable seam:** Real preparer port + ensureReady
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Only fixture holds multiple keys and a stale same-key job concurrently.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** serializes one key, runs different keys concurrently, and caps them globally
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:341`

`re-prepares on a revision, preparer version, CLI version or Global input change`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 fingerprint contract; §6.0 Global runtime settings
- **Real regression:** Edited profile/config/CLI/preparer versions reuse obsolete homes; unchanged inputs rebuild needlessly.
- **Independent oracle:** Authored revisions/input bytes/version strings and preparation receipts; fresh lifecycle reuses current home.
- **Stable seam:** ensureReady after service/config events; on-disk versions
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Only case varies each fingerprint input while controlling unchanged content.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** re-prepares on a revision, preparer version, CLI version or Global input change
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:391`

`prepares a new profile in the background and removes a deleted one after its jobs settle`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.6 create/delete; §6.5 queue
- **Real regression:** Background creation never prepares or deletion permits a queued job to recreate files.
- **Independent oracle:** Public ready status without calling ensureReady for initial work; actual removed directory after held job releases.
- **Stable seam:** prepareStatus events + native deletion, public gc
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Proves event-triggered preparation independently of launch-triggered ensureReady.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** prepares a new profile in the background and removes a deleted one after its jobs settle
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:427`

`keys per account for a perAccount preparer and aggregates their status`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.2 per-account homes; §7 status
- **Real regression:** Managed accounts share homes or aggregate status hides a failed account.
- **Independent oracle:** Literal system/acc-1 key paths and account-home fixture; failed reason for acc-bad.
- **Stable seam:** ensureReady and status
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Only fixture covers system/shared/account identity and mixed per-account outcomes.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** keys per account for a perAccount preparer and aggregates their status
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:451`

`re-prepares a key marked stale (Codex re-seed)`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.2 Codex re-seed
- **Real regression:** Missing state re-seed marker is ignored or remains permanently stale.
- **Independent oracle:** Two preparations followed by stable reuse for one account.
- **Stable seam:** markStale → ensureReady
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Normal fingerprint changes do not cover forced refresh with unchanged fingerprint.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** re-prepares a key marked stale (Codex re-seed)
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:463`

`re-prepares a current version its preparer calls unusable (Codex: state DB gone) and hands preparers the CLI binary`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.2 launchable Codex home and registry CLI
- **Real regression:** A home with missing state DB is reused or preparer receives wrong executable.
- **Independent oracle:** Broken-home fixture rejected by usability port, different returned version, literal /opt/bin/codex.
- **Stable seam:** ensureReady + real preparer protocol
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Only fixture marks an otherwise-current fingerprint unusable.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** re-prepares a current version its preparer calls unusable (Codex: state DB gone) and hands preparers the CLI binary
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:482`

`cleans staging at boot, drops prepared dirs of deleted profiles and re-prepares stale ones`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 boot recovery
- **Real regression:** Partial staging/orphan pointer survives startup or stale prepared revision remains current.
- **Independent oracle:** Seeded staging bytes disappear, orphan pointer/root removed, literal preparer version changes then cache reuse.
- **Stable seam:** start, ensureReady, gc and filesystem
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Ordinary launches do not scan orphaned/partial persisted directories on boot.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** cleans staging at boot, drops prepared dirs of deleted profiles and re-prepares stale ones
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:512`

`refuses launches after stop and passes an aborted signal to preparations in flight`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 daemon shutdown
- **Real regression:** Stopped daemon accepts preparation or leaves an in-flight adapter un-aborted.
- **Independent oracle:** Actual AbortSignal receipt and PROFILE_NOT_READY from pending/new launches.
- **Stable seam:** stop and pending ensureReady
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Only fixture holds work through stop and observes cancellation at the adapter port.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** refuses launches after stop and passes an aborted signal to preparations in flight
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:534`

`publishes every preparation as a new version and never touches an older one`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 immutable version layout
- **Real regression:** Refresh modifies old leased-compatible bytes or current pointer references wrong version.
- **Independent oracle:** Different version paths, unchanged old bytes/mtime and complete manifests.
- **Stable seam:** ensureReady, gc and native version files
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Atomic initial publication does not prove immutable old versions across refresh.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** publishes every preparation as a new version and never touches an older one
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:556`

`never reuses a version name, even for the same fingerprint at the same instant`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 immutable version identity
- **Real regression:** Identical fingerprints at fixed time overwrite an old version.
- **Independent oracle:** Five distinct returned version identities at one controlled timestamp.
- **Stable seam:** markStale → ensureReady paths
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Other tests allow wall-clock time/fingerprint to distinguish names.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** never reuses a version name, even for the same fingerprint at the same instant
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:571`

`keeps a leased old version, removes it once unleased and after the handout grace`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 prepared-dir leases/10-minute handout grace
- **Real regression:** GC removes in-use or recently handed out home, or never releases expired old home.
- **Independent oracle:** Literal grace progression, controlled lease membership and actual path presence/removal.
- **Stable seam:** gc and native files
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Unleased auto-GC does not cover handout-before-lease and expired lease transitions.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** keeps a leased old version, removes it once unleased and after the handout grace
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:596`

`re-reads the leases for a key reached after the handout grace (a snapshot that old is stale)`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 safe GC under slow queue
- **Real regression:** GC uses an obsolete lease snapshot after waiting behind a preparation and deletes active home.
- **Independent oracle:** Fresh lease-read receipt, held real preparer, controlled time and retained actually leased path.
- **Stable seam:** gc + preparer/lease ports + native files
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Only fixture advances past handout grace while a key is locked behind work.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** re-reads the leases for a key reached after the handout grace (a snapshot that old is stale)
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:638`

`removes an unleased old version right after publishing`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 publish-triggered garbage collection
- **Real regression:** Successful refresh leaks obsolete unleased homes until a manual/periodic pass.
- **Independent oracle:** Actual old directory disappears and only current immutable version remains.
- **Stable seam:** ensureReady followed by filesystem notification
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Public gc is deliberately not used to cause this automatic publish cleanup.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** removes an unleased old version right after publishing
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:650`

`deletes nothing when inUse() fails or no leases source is wired`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 fail-safe unknown leases
- **Real regression:** Host outage or absent lease wiring permits destructive collection.
- **Independent oracle:** Actual previous/deleted home remains; deleted current pointer disappears; public gc completes.
- **Stable seam:** gc and native pointer/version files
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Only case contrasts failed lease service with entirely absent lease service.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** deletes nothing when inUse() fails or no leases source is wired
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:676`

`collects again once the leases become knowable (the host turned healthy after boot)`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 late host adoption
- **Real regression:** Old versions leak after initially unavailable lease service becomes healthy.
- **Independent oracle:** Old path retained while unknown, then removed after external availability event.
- **Stable seam:** start plus lease availability port and filesystem notification
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Explicit gc cases would hide a missing onAvailable subscription.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** collects again once the leases become knowable (the host turned healthy after boot)
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:704`

`skips quietly while the host is not adopted yet, then collects once it is (no boot false alarm)`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 expected pre-adoption unknown leases
- **Real regression:** Normal boot emits false host-failure warnings or later adoption fails collection.
- **Independent oracle:** No unknown-lease warning, retained path while unavailable, actual later removal.
- **Stable seam:** start/gc, logger boundary and lease availability edge
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Other failed-service case represents an actual host failure rather than expected not-yet-adopted state.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** skips quietly while the host is not adopted yet, then collects once it is (no boot false alarm)
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:737`

`runs a slow periodic pass that collects what no trigger would (a deleted profile's leftovers)`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 hourly GC of deleted-profile leftovers
- **Real regression:** A deleted leased home remains forever once its final session ends.
- **Independent oracle:** Path survives before one-hour deadline and disappears after the virtual interval.
- **Stable seam:** start periodic timer + native files
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** No publish/delete trigger fires after final lease release, so explicit/edge GC cases cannot replace it.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** runs a slow periodic pass that collects what no trigger would (a deleted profile's leftovers)
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:767`

`on delete removes pointers and unleased versions; a leased one stays until a later GC`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.6 deletion; §6.5 leases
- **Real regression:** Deleted profile stays launchable, loses leased data immediately, or retains unleased account homes.
- **Independent oracle:** No current pointer, PROFILE_NOT_FOUND, kept leased version and removed other key/root.
- **Stable seam:** service delete, ensureReady, gc, native filesystem
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Only fixture deletes multiple account keys with mixed lease state and reboots.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** on delete removes pointers and unleased versions; a leased one stays until a later GC
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## KEEP — `apps/daemon/src/session-profiles/lifecycle.test.ts:796`

`flips the pointer atomically: a reader always sees a complete version`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 atomic pointer publication
- **Real regression:** Concurrent launch reader sees missing pointer or incomplete manifest during replacement.
- **Independent oracle:** Continuous reader opens complete current manifest while ten immutable versions publish.
- **Stable seam:** readCurrentVersion/native manifest vs ensureReady
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Initial atomic publish cannot catch pointer replacement gaps while readers run.
- **Change:** Case body unchanged; supporting drain-only production infrastructure removed.
- **Final alias:** flips the pointer atomically: a reader always sees a complete version
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/lifecycle.test.ts:823`

`treats a legacy unversioned key dir as stale and collects it subject to its lease`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.5 persisted layout compatibility
- **Real regression:** Legacy home is treated current or its still-leased files are destroyed.
- **Independent oracle:** Seeded legacy manifest/skill preserved until lease release, stale temp removed, new version created.
- **Stable seam:** start/ensureReady/gc and native files
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** Only case uses the supported pre-versioning on-disk layout.
- **Change:** Remove test-only lifecycle-wide drain; synchronize through the named public receipt/readiness/filesystem contract.
- **Final alias:** treats a legacy unversioned key dir as stale and collects it subject to its lease
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/lifecycle.test.ts

## REWRITE — `apps/daemon/src/session-profiles/integration.test.ts:669`

`${agent}: two concurrent chats on one account with different profiles get distinct kits and no Global item; a Global chat beside them is unchanged`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.3–5.6, §6, §7–§9 verification
- **Real regression:** ${agent}: two concurrent chats on one account with different profiles get distinct kits and no Global item; a Global chat beside them is unchanged
- **Independent oracle:** Literal authored Editor/Developer native kits, stable conversation cursor, profile binding, explicit refusal categories and absence of Global launch on unattended/error paths.
- **Stable seam:** real daemon → host → adapter launch and native prepared configuration
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** This declared end-to-end lifetime/agent scenario composes real stores, lifecycle, host launch refresh and provider inputs; builder/resolver units cannot prove that composition.
- **Change:** Shared makeProfile waits for real ensureReady calls for supported default accounts and public gc. Restart/edit waits for all default-agent readiness; deleted/failing launches use their normal production refusal behavior. Teardown awaits public gc before stopping; no test-only drain remains.
- **Final alias:** ${agent}: two concurrent chats on one account with different profiles get distinct kits and no Global item; a Global chat beside them is unchanged
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/integration.test.ts

## REWRITE — `apps/daemon/src/session-profiles/integration.test.ts:724`

`a daemon and host restart keeps the chat's profile, and its next start picks up the edited profile's new version`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.3–5.6, §6, §7–§9 verification
- **Real regression:** a daemon and host restart keeps the chat's profile, and its next start picks up the edited profile's new version
- **Independent oracle:** Literal authored Editor/Developer native kits, stable conversation cursor, profile binding, explicit refusal categories and absence of Global launch on unattended/error paths.
- **Stable seam:** real daemon → host → adapter launch and native prepared configuration
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** This declared end-to-end lifetime/agent scenario composes real stores, lifecycle, host launch refresh and provider inputs; builder/resolver units cannot prove that composition.
- **Change:** Shared makeProfile waits for real ensureReady calls for supported default accounts and public gc. Restart/edit waits for all default-agent readiness; deleted/failing launches use their normal production refusal behavior. Teardown awaits public gc before stopping; no test-only drain remains.
- **Final alias:** a daemon and host restart keeps the chat's profile, and its next start picks up the edited profile's new version
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/integration.test.ts

## REWRITE — `apps/daemon/src/session-profiles/integration.test.ts:758`

`a profile switch mid-chat relaunches with the new kit on the same conversation; a switch to Global drops it`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.3–5.6, §6, §7–§9 verification
- **Real regression:** a profile switch mid-chat relaunches with the new kit on the same conversation; a switch to Global drops it
- **Independent oracle:** Literal authored Editor/Developer native kits, stable conversation cursor, profile binding, explicit refusal categories and absence of Global launch on unattended/error paths.
- **Stable seam:** real daemon → host → adapter launch and native prepared configuration
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** This declared end-to-end lifetime/agent scenario composes real stores, lifecycle, host launch refresh and provider inputs; builder/resolver units cannot prove that composition.
- **Change:** Shared makeProfile waits for real ensureReady calls for supported default accounts and public gc. Restart/edit waits for all default-agent readiness; deleted/failing launches use their normal production refusal behavior. Teardown awaits public gc before stopping; no test-only drain remains.
- **Final alias:** a profile switch mid-chat relaunches with the new kit on the same conversation; a switch to Global drops it
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/integration.test.ts

## REWRITE — `apps/daemon/src/session-profiles/integration.test.ts:789`

`a deleted profile: an interactive chat falls back to Global with a notice naming it; an unattended one fails to start`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.3–5.6, §6, §7–§9 verification
- **Real regression:** a deleted profile: an interactive chat falls back to Global with a notice naming it; an unattended one fails to start
- **Independent oracle:** Literal authored Editor/Developer native kits, stable conversation cursor, profile binding, explicit refusal categories and absence of Global launch on unattended/error paths.
- **Stable seam:** real daemon → host → adapter launch and native prepared configuration
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** This declared end-to-end lifetime/agent scenario composes real stores, lifecycle, host launch refresh and provider inputs; builder/resolver units cannot prove that composition.
- **Change:** Shared makeProfile waits for real ensureReady calls for supported default accounts and public gc. Restart/edit waits for all default-agent readiness; deleted/failing launches use their normal production refusal behavior. Teardown awaits public gc before stopping; no test-only drain remains.
- **Final alias:** a deleted profile: an interactive chat falls back to Global with a notice naming it; an unattended one fails to start
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/integration.test.ts

## REWRITE — `apps/daemon/src/session-profiles/integration.test.ts:826`

`a failed preparation fails the launch with its reason, never Global: at create, and at a later start`

- **Independent source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.3–5.6, §6, §7–§9 verification
- **Real regression:** a failed preparation fails the launch with its reason, never Global: at create, and at a later start
- **Independent oracle:** Literal authored Editor/Developer native kits, stable conversation cursor, profile binding, explicit refusal categories and absence of Global launch on unattended/error paths.
- **Stable seam:** real daemon → host → adapter launch and native prepared configuration
- **Refactor resistance:** Checks semantic launch/status/error or native persisted artifacts through existing public boundaries. New synchronization contains no fixed poll counts or sleeps and no replacement production test flag.
- **Unique protection:** This declared end-to-end lifetime/agent scenario composes real stores, lifecycle, host launch refresh and provider inputs; builder/resolver units cannot prove that composition.
- **Change:** Shared makeProfile waits for real ensureReady calls for supported default accounts and public gc. Restart/edit waits for all default-agent readiness; deleted/failing launches use their normal production refusal behavior. Teardown awaits public gc before stopping; no test-only drain remains.
- **Final alias:** a failed preparation fails the launch with its reason, never Global: at create, and at a later start
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/integration.test.ts
