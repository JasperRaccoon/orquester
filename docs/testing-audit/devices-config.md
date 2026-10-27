# Incoming device/config test audit

Incoming source: `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8` compared with `923b`. Audited every changed config test and its owner:15 device tests and 3 tooling tests. Final 18 tests; dispositions {'KEEP': 11, 'REWRITE': 7}. Test LOC 354→351 (−3). No entire legitimate test is removed; seven tests with implementation-derived oracles are rewritten.

Sources: AGENTS.md: persisted-data tolerance and independently meaningful behavior; docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§5–7,10.5,11; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2,4; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3; docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md §10.

All six requirements apply to every row. Assertions use authored literal public settings/path bytes, raw persisted records, explicit accepted/rejected values, and real Node subprocess stdout. Production default/limit comparisons and parse-again expected values are removed. Public persisted-file parsers/serializers, validated settings merge, actual vphone CLI source guard, appdir path helpers, and Node NODE_OPTIONS process interface. No source inspection, private collaborator shape or markup assertions. Internal names/algorithms can change without changing accepted data, safe settings, preserved raw records, public path bytes or actual process output. Config owns data decoding/default/legacy-policy/serialization obligations; daemon store/host tests retain actual disk writing, process launch, leases and pool scheduling, with distinct side-effect/order failure modes.

Production consumers: `apps/daemon/src/devices/store.ts`, `apps/daemon/src/devices/hosts/vphone/cli.ts`, `packages/api/src/devices.ts`, `packages/ui/src/components/settings/DevicesSettings.tsx`, `apps/daemon/src/plugins/session-env.ts`.

| Incoming path:line and exact test name | Disposition | Contract source | Distinct observable failure and surviving oracle |
| --- | --- | --- | --- |

| `packages/config/src/devices.test.ts:34` — device paths live under the daemon appdir | KEEP | Phase1 §§5,11 persistence paths | Public appdir helpers return literal daemon-owned tool/SDK/AVD/runtime/screenshot/settings/lease/pool paths; a directory rename must not orphan persisted state. Oracle is independently authored path bytes; survives implementation renames; lower owner than daemon stores. |

| `packages/config/src/devices.test.ts:47` — settings: an empty or missing value reads as the defaults | REWRITE | Phase1 §§6.2,6.3,10.5 and phase2 placement/approval; fresh-file factory contract | Replace comparisons against production DEFAULT_DEVICES_SETTINGS with literal disabled-host/standing-approval-off/prefer-local settings. Mutating one actual default-file factory result must not mutate another: catches cross-store shared mutable defaults. Remove test-only defaultDevicesSettings export, retain internal factory implementation. |

| `packages/config/src/devices.test.ts:58` — settings: each bad field falls back alone, numbers are clamped, unknown keys survive a round trip | REWRITE | AGENTS tolerant settings and public device setting ranges; phase1 defaults | Literal 32/local cap, documented Mac size, agents policy and 60-minute lease fallback replace values imported from implementation constants. Keep isolated fallback/clamping/profile dedup and unknown nested/root serialized fields; remove parser-derived roundtrip expected value. |

| `packages/config/src/devices.test.ts:93` — settings: a file that is not version 1 or not an object throws (it is moved aside, never overwritten) | KEEP | AGENTS unsupported persisted version quarantine; phase1 §11 | parseDevicesSettingsFile must refuse null/array/newer version; otherwise daemon may overwrite unreadable owner settings. Exact public rejection boundary has no stronger pure owner. |

| `packages/config/src/devices.test.ts:99` — settings: a patch merges field-wise and keeps the keys it does not name | REWRITE | AGENTS field-wise non-destructive settings updates | mergeDevicesSettings must preserve unnamed/unknown nested keys, merge minWarmHosts, apply explicit caps/approval and not mutate original settings; replace derived max-local default with literal 6. Public patch output oracle remains independent; no private shape asserted. |

| `packages/config/src/devices.test.ts:119` — settings: research vphone hosts are keyed by box id, merge field-wise, and a null entry is forgotten | KEEP | Phase3 §2.3 per-machine research setting and patch deletion | Research settings are keyed by safe box IDs; patching a source preserves unnamed values/unknown fields, new hosts can be added and null deletes one entry. Literal map expectations catch wrong-machine updates or inability to disable a host. |

| `packages/config/src/devices.test.ts:134` — settings: an IPSW source is an absolute path or an https:// URL; anything else reads as unset | KEEP | Phase3 §2.3 safe vphone CLI IPSW source interface; apps/daemon/src/devices/hosts/vphone/cli.ts caller | Public source guard accepts authored absolute Mac paths/HTTPS URLs and rejects option-like, relative, HTTP/file/control-character inputs; settings trim safe paths and drop unsafe source alone. Prevents CLI option injection and preserves usable sibling sources. |

| `packages/config/src/devices.test.ts:143` — settings: vphone host entries this build does not read (bad key, not an object, past the max) are written back verbatim | REWRITE | AGENTS unknown persisted records retained; phase3 per-host settings | Keep 64-host read cap and exact dropped-key/serialized malformed-value expectations; remove parse-again equal-to-production-state oracle. Existing invalid/overflow literal fixtures prove unknown records survive serialization, actual daemon store covers write queue. |

| `packages/config/src/devices.test.ts:177` — leases: entry-wise tolerant; rejected entries and unknown keys are written back verbatim | REWRITE | AGENTS entry-wise tolerant persisted records; phase1 §7 live leases | Keep literal acceptedIDs/unknown states/null assignment, but replace parser-again equality with exact independently authored serialized record sequence (valid first, original invalid/duplicate rows verbatim). Catches serialization losing/replacing quarantined lease data. |

| `packages/config/src/devices.test.ts:199` — leases: defaults fill optional fields; a broken outer shape throws | REWRITE | Phase1 §7 default lease owner fields; AGENTS unsupported shape quarantine | Literal lease defaults remain; replace equality to createDefaultDeviceLeasesFile with independent empty-leases result. Outer non-list/newer version/nonobject failures must remain refused, protecting caller quarantine. |

| `packages/config/src/devices.test.ts:217` — rent without asking: one pool switch; a legacy Mac switch is adopted on read and mirrored from patches | KEEP | Phase2 one approval/cap switch; backward compatibility with phase1 Mac settings | Keep legacy Mac approval/cap adoption, explicit pool precedence and patch migration; tests now set up defaults through real default-file factory. Literal true/false and 25/40/70 caps detect accidental autonomous spending or old-client write loss. |

| `packages/config/src/devices.test.ts:231` — idle teardown: the pool's one setting; a legacy Mac idle teardown is adopted on read and mirrored from patches | KEEP | Phase2 pool-wide idle teardown; phase1 legacy Mac preference | Keep legacy idle preference adoption/clamp, current pool precedence and patch mirror back to ios; literal45/15/5/30/10 catch changing teardown policy during upgrade. Default setup uses actual public file factory. |

| `packages/config/src/devices.test.ts:242` — Linux host lifetime: its own pool setting; a file without it keeps its Mac lifetime for Linux hosts | KEEP | Phase2 separate Linux host lifetime; phase1 legacy lifetime migration | Keep 240 default, legacy Mac-lifetime carryover/clamp, explicit Linux override/fallback and patch independence from Mac lifetime. Literal old/new values catch silently shortened or indefinitely billed host lifetimes; unknown sibling keys preserved. |

| `packages/config/src/devices.test.ts:264` — pool settings: the monthly cap defaults, clamps and falls back alone | KEEP | Phase2 standing-approval monthly spend cap; field-level tolerance | Literal 100 default,0 lower clamp and invalid-cap-only fallback preserve a valid maxHosts sibling. Different from legacy cap migration: detects malformed new-field input dropping financial guardrails or unrelated preferences. |

| `packages/config/src/devices.test.ts:271` — device-pool.json: tolerant per section; rejected entries and unknown keys are written back | REWRITE | AGENTS preserve unknown persisted records; phase2 §4 pool state | Authored literal empty state and raw rental/capacity/drain/cache fields replace factory-derived expectations. Unreadable macos=5 must remain serialized while excluded from usable state; a new readable cache write must supersede that retained raw value. Original owner failed undefined !== 5; minimal retention fix passes and selective drop-raw/reversed-precedence mutations each fail their intended assertion. This lowest serialization owner adds no duplicate disk-I/O workflow. |

| `packages/config/src/tooling.test.ts:16` — box tooling paths follow the target's separators | KEEP | Ephemeral AI VMs target tooling path contract; Node NODE_OPTIONS public process interface | Literal cross-OS install/cache/root path results catch incorrect separators or misplaced version archives; refactors of path helpers preserve public outputs. |

| `packages/config/src/tooling.test.ts:32` — Node loads preloads with backslashes, spaces and quotes while preserving existing options | KEEP | Ephemeral AI VMs target tooling path contract; Node NODE_OPTIONS public process interface | Actual Node process must load four authored filenames with backslashes/spaces/quotes and preserve preexisting --title; stdout is an independent interoperability oracle. One subprocess is justified and was already consolidated; no timing shortcut. |

| `packages/config/src/tooling.test.ts:50` — requiring the same file twice adds it once | KEEP | Ephemeral AI VMs target tooling path contract; Node NODE_OPTIONS public process interface | Public appendNodeRequireOption idempotence: repeated same authored preload must yield exactly one require option; no custom Node tokenizer or fake process is involved. |


## Cleanup and verified compatibility fix

Tests now obtain mutable defaults through `createDefaultDevicesSettingsFile().settings`, the actual device-store factory. `defaultDevicesSettings` loses its test-only export but remains used internally. Daemon pool and vphone fixtures were coordinated with their owners and now use the production factory. Runtime-used defaults/ranges/profile/source guards remain. No fixture file, snapshot, dependency or runner configuration became unused.

The incoming pool fixture already supplied unreadable `cache.macos = 5`. Its public parser correctly excluded that value from usable state, but serialization dropped it permanently. The stronger independent disk-value oracle exposed this existing violation of the AGENTS tolerant-persistence contract. The owner now retains unreadable per-OS cache records separately and restores them before current readable state, so explicit later updates take precedence. No live daemon was driven.


## Validation

- `TSX_DISABLE_CACHE=1 node --import tsx --test --test-name-pattern='device-pool.json' src/devices.test.ts` from `packages/config` — Expected original-product failure: unreadable cache records are retained for a newer build; undefined !== 5
  Log: `/tmp/orquester-test-audit/devices-config-expected-failure.log`.

- `TSX_DISABLE_CACHE=1 node --import tsx --test --test-name-pattern='device-pool.json' src/devices.test.ts` from `packages/config` — PASS after minimal owner fix, 1 test
  Log: `/tmp/orquester-test-audit/devices-config-fixed.log`.

- `TSX_DISABLE_CACHE=1 node --import tsx --test --test-name-pattern='device-pool.json' src/devices.test.ts` from `packages/config` — Expected failure specifically at unreadable raw macos preservation assertion; mutation restored. Mutation: `cache: file.state.cache (omit retained raw cache)`.
  Log: `/tmp/orquester-test-audit/devices-config-mutation-drop-raw.log`.

- `TSX_DISABLE_CACHE=1 node --import tsx --test --test-name-pattern='device-pool.json' src/devices.test.ts` from `packages/config` — Expected failure specifically at current cache write supersedes raw value assertion; mutation restored. Mutation: `cache: { ...file.state.cache, ...file.rejected.cache } (raw state overrides current write)`.
  Log: `/tmp/orquester-test-audit/devices-config-mutation-raw-wins.log`.

- `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices.test.ts src/tooling.test.ts` from `packages/config` — PASS 18 tests, 0 failed/skipped; runner duration 411.926748ms
  Log: `/tmp/orquester-test-audit/devices-config-focused.log`.

- `pnpm check:changed / pnpm check / central full test gates` — Not run by this agent; root coordinates after all exports/callers settle.

Both mutations were reverted before the final 18-test pass. `git diff --check` passes. The source/test changes are frozen; repository typecheck and full-suite gates remain root-owned.


## Performance

No sleeps, servers, browsers, emulators or remote networks run in config tests. Retain one actual Node child and four tiny preload files because Node parser interoperability is the independent oracle. No isolated speedup claimed. The focused runner completed 18 cases in 411.926748ms; this is a validation duration, not an equivalent before/after improvement claim. Whole-suite comparisons remain in the central report.
