# Repository simplification audit

This audit starts at `2a8a2cff` and covers all seven workspace packages, daemon subsystems, provider adapters, tests, frontend entry points, and repository scripts. Parallel owners searched callers and reviewed behavior before editing; independent reviewers then checked the combined changes. Generated bindings, fixtures, assets, and historical design records were checked for ownership and use. The live daemon and deployment were not operated.

The changes remove unused interfaces, redundant state, forwarding helpers, duplicated implementation, and stale scaffolding. Existing validation, compatibility, security, persistence, and lifecycle safeguards remain. An absent production caller alone did not justify deleting a useful test observation interface or the documented reference API client. Internal exports were narrowed only after checking repository consumers, including barrels and binary-aware searches.

The tables group changes that share evidence and verification. Test names identify retained or improved coverage; completed gate results are recorded at the end. The earlier audit remains in [slop-audit.md](slop-audit.md).

## Daemon and transport

| Change | Evidence and reason | Risk and verification |
| --- | --- | --- |
| Inline agent timeout environment composition; delete its module | One caller immediately unpacked the wrapper's result. | Environment precedence and credential removal: existing timeout and launch tests. |
| Remove hook agent-family mapping | Every supported ID mapped to itself after alias retirement. | Supported and unknown IDs retain switch behavior; hook installation tests. |
| Inline three Git argument builders at four account call sites | Helpers returned literal arrays without validation or branching. | Exact arguments preserved; account clone/remote tests and Git trigger tests. |
| Remove ignored `expectOk` labels and duplicate command success check | Labels were discarded with `void`; `expectOk` already checks response success. | Error shape/status unchanged; MCP message/session tests. |
| Inline activity plan readiness | Earlier returns enforce the repeated pending-request/session guards. | Priority and race behavior: 27 ladder tests passed; old/new activity and push outputs match over 183,708 input combinations. |
| Remove unread host-client response headers | All callers consume status/body/stream only. | Outgoing authentication headers remain; host-client and proxy-route tests. |
| Return parsed owner data directly; drop extra home-settings clone | Schema strips unknown fields; final settings spread already copies the object. | Owner stripping and home-preparation tests retain exact contracts. |
| Remove unused proxy-test local; shorten obsolete comments | Unread binding and duplicated incident/implementation narratives. | No runtime change; relevant auth/upload/tmux invariants remain. |

## Agent host and provider adapters

| Change | Evidence and reason | Risk and verification |
| --- | --- | --- |
| Drop index batch outcome protocol | The sole caller reduced four outcomes to a boolean that both of its callers ignored. | Transactions, cursors, gaps and indexed rows unchanged; index/recovery tests. No schema-version change needed. |
| Remove torn-line return metadata and checkpoint stderr flag | Callers never read either field. | Same line filtering and output bounds; log corruption/Unicode and checkpoint tests. |
| Inline attachment-path, checkpoint-error and byte-count wrappers | Exact forwarding to existing helpers. | Same containment/redaction arguments; attachment and real-Git tests. |
| Consolidate snapshot refresh loops and serial queue | Loops differed only in whether already-probed providers were skipped; existing serial queue implements the same ordering. | Cache hydration, lazy boot, watcher demand, refresh failures and concurrency tests. |
| Remove impossible serial-queue rejection branches | Queue tail starts fulfilled and absorbs every task failure; task promise still rejects to its caller. | Queue drain/error and snapshot concurrency tests. |
| Remove initial-session wrapper and duplicate clock | One runtime caller; identical fresh-object defaults and clock implementation already exist. | Session ingestion and lifecycle tests. |
| Remove unused deferred rejection callbacks in Claude/OpenCode | All callers resolve with ordinary values; none rejects through these helpers. | Caller error behavior preserved; lifecycle, prompt and recycle tests. |
| Inline Claude permission-mode equality | One runtime caller, one wrapper-only test. | Replaced that test with a real adapter callback asserting allow reply and absence of approval events. |
| Remove four Codex status identity functions and two forwarding methods | Functions returned the generated status unchanged; other methods only forwarded existing constants/options. | `ClassifiedItem` still checks status unions; real interrupted-to-failed conversion and deadlines remain; Codex suites. |
| Remove Grok auto-approval wrapper, duplicate test and unread connection stop flag | Session-grant selector already includes its one-shot fallback; strict compiler proved the connection flag is write-only. | Existing permission tests cover both grant types. The separate session flag still classifies intentional exits; SIGTERM behavior is unchanged. |
| Replace stale snapshot prose with current invariants | Old text incorrectly claimed every cached provider was reprobed at boot. | Documentation now matches lazy refresh and current adapter capabilities; provenance retained. |

## Agent profiles and Git providers

| Change | Evidence and reason | Risk and verification |
| --- | --- | --- |
| Replace profile error predicate with `instanceof` | Predicate body was exactly that expression. | Identical narrowing/error mapping; import, route and conversion tests. |
| Remove Bitbucket HTTP error subclasses | Base class already stores raw HTTP status; subclasses only chose error kind. | Same per-status mapping/catches. Added SSH upload conflict/auth/manual/RSA fallback regressions passed against original code before cleanup; polling tests retained. |
| Remove ZIP/copy file counters | No production reader; ZIP limits use separate entry/byte counters. | Limits and skipped-path reports remain. Copy regression inspects actual file content instead of a count. |
| Share Claude/Codex unique-name helpers in existing names module | Two pairs of identical implementations. | Same suffix start/order and asynchronous existence checks; adapter collision tests. |
| Remove unused Codex stash/logger inputs, hook before/key metadata and mutation position result | Fields were supplied or calculated but never read. | Native hook trust, rekeying, rollback and config-client tests. |
| Simplify Grok clone/filter and discard unread output/ref metadata | Single-use helper plus redundant copies; locked item checks remain at their actual consumer. | Grok native-format and locked-item tests. |
| Remove import facade reexports used only by tests | Tests can import defining modules directly. | Import URL, containment and ZIP tests retain coverage. |
| Escape a literal NUL in Bitbucket cache key source | Literal NUL made source appear binary to ordinary search tools. | `\0` has the same runtime value; cache/provider tests. |

## Desktop backend

| Change | Evidence and reason | Risk and verification |
| --- | --- | --- |
| Use one Xauthority encoder/writer | Two implementations encoded the same wildcard MIT cookie. | Regression checks exact header bytes, length, permissions, replacement and fresh cookies; desktop lifecycle integration passes. |
| Remove unused Ogg factory, X11 constants, callback argument and empty protocol listener | No consumers or observable work. | Ogg fixture/chunking and X11 tests; real window tracking integration. |
| Simplify desktop teardown flag and packet reset | Both teardown callers always supplied true; reset statements duplicate existing method. | Process-group cleanup, stop/restart/crash/reattach and audio tests. |
| Remove stale tracker-test skip | Tracker is implemented; old catch converted genuine failures into skips. | Deterministic `xterm -e cat` avoids host-shell startup. All six desktop-manager integration cases pass, including window close and reattach. |
| Remove shell-quote literal test/export | Existing real-shell test exercises hostile input round trips. | Real-shell quoting regression retained. |

## Workflows

| Change | Evidence and reason | Risk and verification |
| --- | --- | --- |
| Remove optional runtime factory injection and duplicated dependency interfaces | Sole caller always supplied the concrete factories now called directly. | Same execution/preview wiring; workflow route and engine integration tests. |
| Remove unused store getter, queue reject field, fake switches/introspection and completion metadata | Repository references show no readers/callers. | Real cancellation, retry, receipt, failover and restart tests remain. |
| Remove E2E evidence-directory dumps | Teardown created unconsumed temporary JSON on every run and never cleaned it. | Actual fixture state/assertions and cleanup remain; workflow E2E tests. |
| Consolidate tab deletion, reset reductions, unknown-account ordering and poller filtering | Identical operations in mutually exclusive branches or duplicate loops. | Sweeper, account-selection and trigger tests; trigger/Git suite passed 59 cases. |
| Remove redundant timing inheritance/default argument and one-use helpers | Existing constants supplied the same values everywhere; return payloads were unread. | Watch/failover deadlines and persisted phase names unchanged; agent-block tests. |
| Remove unreachable sandbox stop sentinel and unread process/log wrappers | `process.exit` precedes every sentinel throw; process promises and file descriptors already have owners. | Stronger stop test checks catch/finally cannot continue; sandbox cancellation, deadline, redaction and recovery tests. |
| Simplify trigger tokenizer guards and scheduler condition | The tokenizer already consumes nonempty input; repeated boolean/date calculation had identical outcomes. | Trigger parser/scheduler regressions retained. |
| Remove two argument-array assertions and unused fixture options | Assertions copied literal builder output; actual Git behavior has integration coverage. | Clone/ref/repository resolution tests retained. |
| Replace regex timer-count assertion | Requiring three interval ticks was scheduler-sensitive. | Retains explicit event-loop progress, deadline warning, elapsed bound and next-worker recovery; independent review required restoring the responsiveness probe. |

## Shared packages and UI

| Change | Evidence and reason | Risk and verification |
| --- | --- | --- |
| Delete unused API scaffolding and duplicate event-name enum/guard | No consumers; channel subscription was never implemented; current event and registry contracts already exist. | Actual wire/persisted envelope validators unchanged; API/config tests and repository typecheck. |
| Simplify workflow outline sorting | Input already preserves node order; stable sort preserves tied edge order without decorating indices. | New branch/position/tie regression; 10,000 generated graphs match original output. |
| Delete unreachable UI store actions and expression-preview wrapper | No app, test, desktop or web consumers. | Active auth/reconnect routes and shared reference client remain; app-store/API tests. |
| Remove clones immediately after `filter` | Filtering already creates a new array. | Sorts still preserve store arrays; tab derivation tests. |
| Remove chat presentation reexports, roster aliases, label wrappers and NaN normalization | Direct existing helpers/expressions produce the same values; active/terminal status sets are disjoint. | 576 baseline comparisons across roster statuses/kinds/fade phases/usage/invalid dates; chat rendering/roster suites. |
| Simplify profile editor forwarding, rejected-field tracking and error shape | Rejected fields are already absent from shown fields; consumers read error code/message only. | Frontmatter round trips, unknown/type-mismatched values and error-placement tests. |
| Inline history loading wrapper | Only renamed a prop on the same component. | Identical arguments/markup; history tests and frontend builds. |
| Remove unused workflow field hook, duplicate system-account literal and forwarding getters/formatters | No hook callers; API owns the literal; Zustand getters are context-free closures. | Workflow inspector/store/render tests. |
| Use one insertion-ordered Set for notification history | Existing array and Set tracked the same distinct run IDs. | Added 500-run retention and duplicate-order regression. |
| Narrow unused internal exports across owned modules | Whole-repository caller/import/barrel searches found none; implementations remain. | Compile-time scope only, verified by all-workspace typechecking and both frontend builds. |
| Remove stale implementation-wave/experiment comments; correct UTF-8 truncation documentation | Comments described completed work, removed experiments, or the wrong return value. | Behavior untouched; current contracts and attribution retained. |

## Repository tooling and retained scope

The identical daemon/UI MockTimers warning preloads now live in `scripts/test`. Both package test scripts use that file, including standalone checks. A direct probe verified string, options-object and Error warning forms are filtered, while unrelated experimental and ordinary warnings still pass through. No dependency change was needed.

Web/desktop entry points, IPC boundaries, service-worker handling, packaging, deployment scripts, registry catalog, assets, and historical documentation were reviewed and retained where differences serve real behavior. Removed two stale provisioning references to procedures no longer in `AGENTS.md`; runtime commands are unchanged. Shell syntax checks passed. Deployment was not requested or performed. Native config tolerance, generated protocol bindings, authentication, path containment, secrets, append ordering, resume identity and tmux/direct-PTY ownership were preserved.

## Verification

- `pnpm check`: passed for all seven workspace packages.
- Typechecking with `--noUnusedLocals --noUnusedParameters`: passed for all seven packages. The scan identified the write-only Grok connection stop flag removed in this audit.
- `pnpm test`: **5,947 passed**, with zero failures, cancellations, skips or TODOs: config 36, API 426, daemon 4,199 and UI 1,286. All ten standalone `.check.ts` scripts also completed successfully. Packages ran sequentially with CPU affinity limiting worker concurrency on the busy host.
- The final Grok connection change was checked separately after the compiler finding: all five connection tests passed.
- Shell syntax checks, the shared warning-preload probe, independent diff reviews and `git diff --check` passed.
- `pnpm build`: passed workspace compilation, desktop main/UI, Linux AppImage packaging and the web bundle. Build warnings remain for CommonJS `import.meta`, the non-module theme bootstrap script, bundle size, and optional packaging metadata/platform dependencies.
- Packaged SQLite and PTY probes passed under Electron ABI 130. The workspace's native binaries were restored byte-for-byte and the same probes passed under Node ABI 115; stale native rebuild metadata was removed.
- The unchanged browser smoke script passed clean storage and legacy usage preferences against the emitted web bundle. A temporary local server supplied health/auth metadata, an inert WebSocket and unauthorized API responses; no live daemon was started. Both screenshots were inspected, and neither scenario reported page or console errors. This checks the unauthenticated shell and storage migration, not authenticated end-to-end behavior.
- Final fetch found `origin/main` unchanged at the audited base, `2a8a2cff`; no remote changes required a merge.

All required repository gates completed. Generated outputs, native binaries, runtime data and temporary verification harnesses are excluded from the commit.
