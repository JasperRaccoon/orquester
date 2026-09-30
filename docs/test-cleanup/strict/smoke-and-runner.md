# Deployment smoke and shared runner disposition

Reviewed before changing test/support files. These decisions belong to the cleanup starting at `32c81248`; historical cleanup records are not assumed to validate current cases.

## scripts/smoke-web.mjs

Production caller: `deploy.sh` invokes this script after deployment. The real browser loads the emitted web client, whose `apps/web/src/main.tsx` installs `createLocalStorageAppConfigAdapter`; `packages/ui/src/store/app.ts` consumes the loaded configuration. The desktop entry point instead loads daemon configuration and is covered by the shared client typecheck/build.

- **KEEP** `clean-storage`. Independent requirement: README's supported web client and post-deploy smoke gate require a fresh browser to boot. Failure: a broken emitted import, asset, initialization or React tree prevents the app's accessible Settings control appearing, or emits an uncaught browser error. Oracle: a visible accessible control and no uncaught errors, not a generated markup snapshot or production constant. Seam: an isolated browser context loading the emitted application. Refactor tolerance: modules, class names, layout and internal hooks can change; the usable app remains observable. Lowest distinct owner: unit parsing/store tests cannot detect bundler or browser startup failures. Artifact: screenshot and `results.json` record the scenario outcome.
- **KEEP** `legacy-usage-prefs-pre-agents-record`. Independent requirement: AGENTS.md requires validation of localStorage before shared state; the legacy persisted `orquester.app` record is the input that previously crashed startup (documented in the app-config owner). Failure: the emitted client reads old preferences without migration and fails to initialize. Oracle: literal historic storage bytes and the same usable-page/error criteria as above. Seam: localStorage supplied before any application script, then the real emitted client. Refactor tolerance: migration internals and usage-widget structure can change while old clients still boot. Lowest distinct owner: schema tests establish transformation values; this case uniquely establishes that actual startup applies them, so it is not another parser scenario at an extra layer. Artifact: its own screenshot and JSON result.

Remaining stronger coverage: config migration tests own exact field preservation; UI app-config checks own malformed record filtering. Smoke makes no duplicate field/value assertions. Risk: no test or production changes in this scope. Validation: run the existing smoke command against an isolated static server for the built web output, with only unauthenticated synthetic API responses; do not connect to or operate the live daemon.

## Shared test support

- **KEEP support** `scripts/smoke-web-fixtures.json`: the one surviving legacy record is consumed by the retained startup regression.
- **KEEP support** `scripts/test/assert-ok.mjs` and `assert-ok-hooks.mjs`: every package test command uses them to avoid Node 20's assertion/source-map hang. Their caller-visible assertion API regressions are reviewed in scope 20. Callable/named import interception is required runner behavior, not an unused production export.
- **KEEP support** package `quiet-mock-timers.mjs`: native mock timers remain used by retained cancellation/deadline regressions; the loader suppresses only the known experimental warning.
- SVG loader support is checked again after UI pruning; it is retained only if a surviving test imports a component with SVG assets.

No production seam removed in this scope. Final validation results are recorded in the strict cleanup index.
