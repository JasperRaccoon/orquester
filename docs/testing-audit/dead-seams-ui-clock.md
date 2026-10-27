# Usage-limit clock dead seams

Follow-up to the base and incoming UI-lib ledgers: this report supersedes their seven usage-limit rows. All 7 original `610d3c53` identities were re-read against the owner and every production caller; 5 cases remain. Test LOC 140 → 91 (-49).

## Removed seams and preserved behavior

`LimitClockOptions` and its locale/timeZone propagation existed only for tests. Production banner and session-marker callers use ambient browser Intl defaults. Removed the type, optional formatter/status/marker arguments and banner `clock` field. The four formatter/label helper exports had only local production callers plus direct test imports; they are now private, with all runtime functions retained. Native default locale/timezone behavior and the production-supplied countdown `now` are preserved.

The rewritten clock owner launches one Node child with native `LANG=en_GB.UTF-8`, `LC_ALL=en_GB.UTF-8`, and `TZ=America/Los_Angeles`. It exercises the same public banner model as production, asserts known literal local times across UTC midnight and daylight saving, and proves armed status selects `resumeAt`. Neither Intl nor the formatter is mocked; expected values are not derived from their output. Cosmetic prose, weekday/date prefixes, compact countdown spellings and direct helper labels no longer own tests.

## Every original case

| Exact original name | Disposition | Final owner and reason |
| --- | --- | --- |
| countdowns are floored to the minute and never negative | DELETE | B1/B4: a private compact-label formatting inventory. No independently specified requirement fixes d/h/m abbreviations, six rounding branches or negative-input probe. Actual displayed reset/resume timestamps remain protected at the banner boundary. |
| the clock reads today's time alone, a weekday within the week, a date beyond | REWRITE | the banner uses the user's local clock and the actual reset or resume time — Replace injected en-US/UTC options with real process locale/timezone. Literal Pacific/UK time data prove native user defaults, midnight/DST handling and the actual field selected; remove cosmetic weekday/date-prefix and invalid-helper probes. |
| the status line follows the automatic resume | CONSOLIDATE | the banner uses the user's local clock and the actual reset or resume time — Remove full English status-string inventory. Actual resetAt versus resumeAt selection moves to public banner time test; armed/off/unknown/resuming controls are owned by the banner action-state case. |
| the banner: title, detail, toggle and switch | REWRITE | banner actions reflect whether automatic resume is armed, off, unknown or running — Retain armed/off/unknown/running action values, busy state and positive same-family account-switch availability. Delete exact titles, action labels and copied countdown/status descriptions. |
| switching is offered only with another usable account of the same agent, never for OpenCode | KEEP | switching is offered only with another usable account of the same agent, never for OpenCode — Unique switch eligibility: reject reauthentication-required, current-only, wrong-family or absent accounts; system-login chats may move to a managed same-family account, while OpenCode never offers the unsupported operation. |
| account labels, the failover notice and the Limited marker | REWRITE | failover identifies its accounts and only limited sessions have a marker — Retain failover destination/source identity and marker presence/absence. Delete helper-label wording inventory and duplicate full status strings. |
| an overload reads as the model at capacity and its retry, never offers a switch | REWRITE | an overload retries on its account instead of offering an account switch — Retain overload no-switch decision, account attribution refusal, toggle values and provider diagnostic preservation; simplify repeated setup without retaining formatting options. |

## Six-bar evidence

The JSON records B1–B6 per retained/rewritten/consolidated owner. Sources are the user-local-time requirement, the API recovery-state/identity meanings, the banner action caller, and the session-marker consumer. Literal clock values, action booleans, source/destination account data and warning presence can disagree with production. Public models and native locale boundaries remain stable across helper refactors. Each owner’s unique failure is recorded independently, rather than claiming coverage based on test names.

## Validation and cost

From `packages/ui`:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-timeout=600000 --test-concurrency=4 src/lib/agent-chat/usage-limit.logic.test.ts
```

Passed **5/5**, runner wall **1.819629 s**, real startup-locale child case **696.620 ms**. Exact full commands are also recorded in JSON.

The same command was repeated with `NODE_OPTIONS='--import /tmp/orquester-test-audit/ui-clock-mutation-loader.mjs' ORQUESTER_CLOCK_MUTATION=utc`, and then `ORQUESTER_CLOCK_MUTATION=locale`. These external-loader mutations force UTC or en-US formatting. Each failed exactly the intended native clock assertion (actual `6:40` or `11:40 PM`, literal expected `23:40`); the four action/account cases passed. The initial mutation loader had a Uint8Array decoding mistake and failed to find its target; after correcting the harness, both probes reached the intended assertion. No production file was mutated.

`git diff --check -- packages/ui/src/lib/agent-chat/usage-limit.logic* docs/testing-audit/dead-seams-ui-clock.*` passed. Root owns typecheck/full suite and git delivery. Logs are `/tmp/orquester-test-audit/dead-seams-ui-clock-{focused,utc-mutant,locale-mutant}.log`.

The single process startup establishes actual Intl locale, covering all four timestamps without sleeps or network. This cost is retained for unique default-locale/timezone protection that override-driven tests missed. No equivalent focused pre-edit comparison exists, so no speedup is claimed. Root's full-suite comparison owns total performance claims.
