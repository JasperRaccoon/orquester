# Runner performance review

Decision: **reject the ephemeral Node V8 compile-cache candidate**. The 32-file ABBA experiment found no material improvement, so no runner, worker-count, package gate or production change was introduced.

## Matching reference profile

Reference `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8` on Node v24.22.1, 4 CPUs: **536.367s** overall; child user/system CPU 1190.734s/189.885s. The completed `--no-bail` reference records four known daemon baseline failures; it is not a passing full-suite result. Their resolution belongs to the root audit. No failure is treated as disposable here.

| Package | Node runner wall (s) | Recorded file summaries | Named tests | Named-body duration sum (s) |
| --- | ---: | ---: | ---: | ---: |
| config | 2.584 | 20 | 160 | 0.397 |
| api | 5.961 | 60 | 716 | 2.584 |
| box-agent | 7.294 | 2 | 4 | 6.488 |
| daemon | 354.017 | 632 | 7720 | 333.270 |
| ui | 142.604 | 342 | 3128 | 71.991 |
| desktop | 1.187 | 7 | 38 | 0.069 |
| web | 0.114 | 1 | 13 | 0.027 |
| root | 1.162 | 4 | 24 | 1.187 |

Daemon and UI account for **92.59%** of this reference wall time. Named-body durations do not include the whole startup/import lifecycle; per-worker test-harness summaries start after pre-test imports. Their sums overlap across workers and cannot be subtracted directly from parallel wall time to calculate exact compilation cost. The existing reporter lacks worker spawn/import timestamps, so it cannot separate loader, transform, I/O and idle-capacity costs precisely.

Largest matching-reference named cases include the GitHub device-cache cutout workflow (19.778s), Android golden cutout (7.513s), platform cross-build (6.452s), and real SIGTERM→SIGKILL grace scenarios (~5s each). The HTML browser file also repeatedly starts Chromium under the explicit fresh-process/profile isolation contract; sharing a browser would weaken that contract. The UI isolated-page helper already recycles compiled-transform namespaces while replacing module instances.

## Controlled cache experiment

Used the frozen reference checkout, 20 daemon and 12 UI files selected for broad shared imports and short assertion bodies. The same **391 daemon + 219 UI = 610 tests** passed in each variant, with no failures, cancellations or skipped cases. Four isolated file workers and sequential package execution stayed unchanged. `TSX_DISABLE_CACHE=1` remained set throughout.

A has no `NODE_COMPILE_CACHE`; each B starts with a different empty temporary directory. Code can warm across workers within that one B invocation, but no B directory survives for the next repeat. Directory creation and cleanup are included in the wall measurement. Module instances/global state were never shared. The source/package/lock manifest was frozen immediately before the slot and verified unchanged before/after every variant. The JSON report contains every sample SHA-256 and a digest of the full source manifest.

| Variant | Wall incl. setup/cleanup (s) | Child user CPU (s) | Child system CPU (s) | Max single-process RSS (KiB) | Cache bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 | 12.219296 | 27.829688 | 3.749016 | 291640 | 0 |
| B1 | 12.614033 | 28.047311 | 4.148863 | 302840 | 21220788 |
| B2 | 12.509181 | 27.617315 | 4.048335 | 299808 | 21220860 |
| A2 | 12.620852 | 28.612327 | 3.937963 | 303276 | 0 |

Uncached mean: **12.420074s**. Cached mean: **12.561607s**. Candidate difference: **+0.141533s / +1.14%** (slower), within the observed two-run variation. This supports no performance gain claim and does not establish a meaningful slowdown either. Each cached run generated 1,381 files, about 21.2 MB, and both directories were verified removed. RSS is the maximum individual process, not aggregate worker memory.

The candidate would add cache-directory ownership, cancellation handling and cleanup infrastructure without a measured benefit. It was therefore rejected. No full-suite or hosted-CI speedup is inferred from the sample; no matching full-suite cache experiment was warranted. More concurrency and worker/module pooling remain unproven and were not introduced.

## Exact commands and artifacts

Executed the temporary diagnostic driver once, after root granted the exclusive slot:

```sh
python3 /tmp/orquester-test-audit/run-compile-cache-sample.py /tmp/orquester-test-audit/devices-reference
```

For each A1/B1/B2/A2 variant, the driver ran the following unchanged package preambles and fixed file lists, wrapped in `/usr/bin/time -v`. The JSON report records the exact argument arrays, package directories and all eight command timings.

```sh
# cwd: apps/daemon
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 --test-reporter=/tmp/orquester-test-audit/reporter.mjs src/mcp/history.test.ts src/agent-host/orchestration/validate.test.ts src/agent-host/orchestration/liveness.test.ts src/mcp/tools/usage.test.ts src/agent-host/adapters/codex/collab-relaunch.test.ts src/workflows/services.test.ts src/session-tools/legacy-aliases.test.ts src/agent-host/adapters/claude/goal.test.ts src/agent-chat/chat-sessions.test.ts src/agent-host/adapters/auth-status.test.ts src/mcp/tools/secrets.test.ts src/agent-host/adapters/codex/goal.test.ts src/agent-host/adapters/claude/normalize.goal.test.ts src/agent-host/ingestion/activities.test.ts src/agent-host/adapters/codex/child-routing.test.ts src/agent-host/adapters/grok/usage.test.ts src/agent-host/adapters/claude/project-history.test.ts src/agent-host/adapters/claude/usage.test.ts src/agent-host/adapters/claude/prompt-cache.test.ts src/agent-host/adapters/claude/rollback.test.ts
```

```sh
# cwd: packages/ui
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-timeout=600000 --test-concurrency=4 --test-reporter=/tmp/orquester-test-audit/reporter.mjs src/components/agent-chat/thread-link.render.test.ts src/components/settings/agent-tools-settings.logic.test.ts src/components/boxes/surfaces/box-surfaces.logic.test.ts src/lib/secret-files/store.test.ts src/lib/agent-chat/transport.test.ts src/lib/agent-chat/mcp-app-consent.test.ts src/lib/agent-chat/reducer.logic.test.ts src/lib/workflows/app-wiring.test.ts src/lib/workflows/process-settings.test.ts src/lib/repo-identities/icon-images.test.ts src/lib/terminal-links.test.ts src/lib/agent-chat/lineage.logic.test.ts
```

Artifacts under `/tmp/orquester-test-audit/`: `compile-cache-experiment.log`, `compile-cache-sample-results.json`, `compile-cache-frozen-hashes.json`, and `compile-cache-{a1,b1,b2,a2}-{apps-daemon,packages-ui}.{log,time}`. These are diagnostic measurements, not required-gate changes.

Node’s exact-runtime documentation describes compiled-code caching, first-load cost and cleanup; it also notes coverage-precision limitations. No coverage flags are used by these package commands. [Node 24.22.1 module compile cache](https://r2.nodejs.org/docs/latest-v24.x/api/module.html#module-compile-cache).
