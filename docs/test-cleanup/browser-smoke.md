# Browser smoke cleanup

Recorded before editing `scripts/smoke-web.mjs` and `scripts/smoke-web-fixtures.json`.

The deployment caller is `deploy.sh:smoke_test`. Production owners read for this decision:
`apps/web/src/main.tsx`, `packages/ui/src/OrquesterApp.tsx`, `components/layout/AppShell.tsx`,
`components/ErrorBoundary.tsx`, `components/topbar/TopBar.tsx`, `lib/app-config.ts`, and
`store/app.ts`. The workflow can fail when an emitted bundle cannot load, initialization
throws, persisted data crashes rendering, or only the error boundary renders.

| Disposition | Scenario | Failure / remaining owner / risk |
| --- | --- | --- |
| REWRITE | `clean-storage` | A fresh deployed browser must reach the app's accessible Settings control without uncaught errors. The old nonempty-root assertion also accepted the error boundary. Wait for browser network/DOM readiness instead of a fixed three-second sleep; record a screenshot and JSON result. No unit test owns emitted-bundle startup. Low risk: read-only browser load with isolated storage. |
| REWRITE | `legacy-usage-prefs-pre-agents-record` | A historically persisted usage object must not crash the assembled app after deploy. Keep this single historical integration regression and capture the same artifacts. Config migration tests own field-by-field parsing; they cannot detect consuming unmigrated state during real React initialization. Low risk: synthetic historical localStorage in an isolated browser context. |
| DELETE | `corrupt-app-config`, `garbage-app-config` | These repeat tolerant parser cases at an extra layer. Remaining owner: `packages/ui/src/lib/app-config.check.ts` and `packages/config/src/index.test.ts`. |
| DELETE | `corrupt-theme-prefs`, `garbage-theme-prefs` | Generic malformed-storage variants do not add a distinct critical workflow to the fresh/historical startup checks. Remove their fixture records. No visual-regression requirement exists. |
| DELETE | `corrupt-chat-prefs`, `garbage-chat-prefs` | Remaining owner: `packages/ui/src/lib/chat-prefs.test.ts` tests invalid persisted values directly. |
| DELETE | `corrupt-thread-visits`, `garbage-thread-visits` | Remaining owner: `packages/ui/src/lib/thread-visits.test.ts` tests corrupt persisted values directly. |

Both retained scenarios satisfy the six-part bar: (1) README's web-client startup and the
recorded historical blank-page regression specify the behavior; (2) an inaccessible app,
uncaught error, or render fallback fails; (3) required interactive control and zero errors
are fixed independently of source; (4) the browser sees the deployed public app;
(5) no component names, tree shape, classes, widths or coordinates are asserted, so internal
refactors preserve the check; (6) deployment/bundle initialization is owned here, with parser
matrices left to their lower seams. The Settings accessible name selects a user control; its
wording is not separately snapshotted. Screenshots are evidence, not visual comparisons.

Validation planned: `node --check scripts/smoke-web.mjs`, then run the existing smoke command
against a safe existing web surface if one is available. Runtime evidence is written outside
the repository to a fresh temporary directory (or `SMOKE_ARTIFACT_DIR`). No credentials are
seeded or written to artifacts. Final execution results will be recorded below.

Validation completed: `node --check scripts/smoke-web.mjs` and the web production build
passed. Both retained scenarios passed against that emitted bundle on an isolated local
static HTTP surface; API requests received unauthenticated responses and a temporary WebSocket
listener allowed connection setup. This validates bundle initialization and historical browser
storage, not a deployed daemon or authenticated session workflow. The first static-only attempt
correctly failed on missing WebSocket handshakes; no smoke assertion was weakened. The final
run produced two screenshots and `results.json` in
`/var/lib/orquester/tmp/orquester-smoke-Fh5LSp`. The temporary server was stopped afterward;
no live daemon or deployment was changed.

The final post-build smoke rerun also passed both scenarios; current artifacts are in
`/var/lib/orquester/tmp/orquester-smoke-b6IU6M` (`results.json` and two screenshots).

The merged web bundle (including incoming retirement commit `8dcbdc61`) was checked again with the same isolated static/unauthenticated transport surface. Both retained scenarios passed with no console/page failures. Final artifacts: `/var/lib/orquester/tmp/orquester-smoke-oEvA33/results.json`, `clean-storage.png`, and `legacy-usage-prefs-pre-agents-record.png` in that directory. Log: `/tmp/orquester-test-cleanup/merged-smoke.log`. The temporary server was stopped after the check.
