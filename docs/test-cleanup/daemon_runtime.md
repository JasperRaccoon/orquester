# Daemon runtime test cleanup

Completed cleanup; the disposition plan was recorded before editing. Baseline: 410 tests passed, zero failures/skips; command below. Each table names every original case; a disposition applies to its parameter family. The contract paragraph for each file supplies all six retention-bar items to its named rows.

**Six-item retention justification for every KEEP/REWRITE row:** (1) the independent contract/source and specific failure family are stated per file; (2) the named case states the distinct caller-visible failure/result, not merely execution; (3) expected literals, supplied input data, external protocol/config bytes or persisted artifacts can disagree with the owner; (4) the named owner service/parser/HTTP/OS artifact is the stable seam; (5) changing private helpers, identifiers, call order or storage implementation while preserving that contract does not change the assertion; (6) each remaining case owns the specified edge at its lowest useful seam, with duplicate/private-wrapper coverage identified for deletion. Exceptions removed during rewriting are explicit below. Risk is limited to losing implementation-detail sensitivity; retained protocol, storage, security and visible-state cases remain discriminating.

Validation per test file: from `apps/daemon`, `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/<file>`. Standalone checks use the same imports followed by `src/<file>.check.ts`. Root runs repository gates after integration.

## `apps/daemon/src/agent-conversations.test.ts`

Provider transcript path/cwd/home identity contract; failure modes: wrong CLI path encoding, ambiguous long-path prefix, wrong managed account/proxy attribution, leaking another project. Owner agent-conversations.ts; production caller index.ts history route. Real provider-shaped JSONL files exercise listAgentConversations.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | claude history is read from the dir the CLI names after the project path | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a claude dir name over 200 chars is matched by its prefix and the transcript's cwd | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | every conversation is attributed to the home it was read from | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a codex account home is attributed, and unrelated projects are ignored | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | without a daemonDir only the system homes are scanned | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/agent-family.test.ts`

Registry launcher families and provider installer protocol; failure modes: proxy launcher gets wrong hook schema/home or Grok receives Claude-only timeout env. Owners agent-hooks.ts and agent-timeout-env.ts; production callers sessions/index. Actual installed settings distinguish installer dispatch.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | agentFamily maps the claudex/claudemix ids onto the claude family | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | grok is its own family and gets no claude timeout env | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | claudex/claudemix map to claude family for BOTH target and installer dispatch | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | claudemix installs claude-family hooks at its CLAUDE_CONFIG_DIR | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/agent-hooks.test.ts`

Agent CLI hook JSON/TOML protocol and host file security; failure modes: lost user config/symlink/mode, wrong trust index, destructive unrecognized TOML, duplicate installs, wrong account home or Grok hook source. Owner AgentHooks.ensureForEntry, called by index session launch. Actual temporary config artifacts are the seam.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | claude install is awaited, quotes the command, and creates 0600 settings + 0755 script | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | claude install preserves an existing file's 0600 mode and its content | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | claude install writes THROUGH a symlinked settings.json (dotfiles setup) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | unrecognized config shapes abort byte-identical (claude string hooks, non-array event, codex array hooks) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | codex install preserves metadata, appends after user groups, and writes 0600 trust blocks | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | codex trust block is keyed to the managed group's actual index when it is not last | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | codex install refuses a multiline-string config.toml BEFORE touching hooks.json | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | installs are idempotent: a second run is byte-identical (claude + codex) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | grok install writes a solely-owned orquester.json with grok-labelled notifier hooks | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | grok install honors GROK_HOME and is idempotent | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | grok install overwrites an edited orquester.json (solely owned) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | per-account env overrides route installs to the account config home | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/agent-status-grok.test.ts`

Grok hook protocol: only Stop(reason=end_turn) finishes; attention/progress and unknown-event mapping. classifyAgentEvent feeds sessions via index. Independent protocol event fixtures expect activity classes; teardown must not cause false completion.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | grok Stop counts as done only for a completed turn | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | grok attention events map to waiting | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | grok progress events map to working | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | unknown grok events are ignored | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/agent-timeout-config.test.ts`

Public @orquester/config parseAppConfig contract: backward-compatible 30-minute default and integer 1..30 validation. Called by config loader/index. No duplicate config-owner tests of this field were found.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | a config with no agents group defaults to 30 minutes | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | an explicit in-range value is preserved | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | out-of-range and non-integer values are rejected | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/agent-timeout-env.test.ts`

Claude CLI timeout environment contract and managed launch composition. buildAgentLaunchEnv is called by index resolveExtraEnv; expected external timeout keys are literal milliseconds and proxy/account collision precedence. No other launch composition owner protects their combined output.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| DELETE | returns null for every non-claude launcher | Duplicates the retained real launch composition cases in this file; helper-specific repetitions add no distinct launch failure. |
| DELETE | covers every claude-family launcher with all three keys | Duplicates the retained real launch composition cases in this file; helper-specific repetitions add no distinct launch failure. |
| DELETE | converts minutes to milliseconds at both bounds | Duplicates the retained real launch composition cases in this file; helper-specific repetitions add no distinct launch failure. |
| KEEP | a claude-family launch carries the timeout env, and cliproxy still wins collisions | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | plain claude (no cliproxy contribution) still carries the timeout env | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a non-claude launcher composes to no timeout keys | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/ansi-activity.test.ts`

ANSI terminal protocol plus caller-visible session activity state: BEL versus string terminator, chunk boundaries, OSC titles/notifications, echo suppression, live-stream idle timing and hook priority. Owners BellScanner/ActivityTracker feed session lifecycle. Byte fixtures and timestamped inputs are independent; scanner grammar cases differ from session lifecycle wiring.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | BellScanner counts BEL in ground state | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | BellScanner ignores OSC terminator BEL and counts a later ground BEL | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | BellScanner ignores OSC content terminated by ST and counts trailing ground BEL | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | BellScanner recognizes C1 ST after C1 string introducers | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | BellScanner swallows BELs inside DCS, SOS, PM, and APC strings | The immediately following recovery case covers the same four introducers and asserts the swallowed BEL before checking recovery. |
| KEEP | BellScanner recovers after BEL terminates DCS, SOS, PM, and APC strings | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | BellScanner returns to ground after CSI final byte so the following BEL counts | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | BellScanner keeps escape and string state across chunk boundaries | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | BellScanner reports the last OSC 0/2 title of each chunk | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | BellScanner reports a chunk-split title once, in the terminating chunk | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | BellScanner counts OSC 9 / OSC 777 notifications as bells | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: an OSC 9 notification raises attention | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: output → working, bell sets attention, input clears it | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: needsAttentionAt tracks structural attention too | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: output echoing local input is neither heartbeat nor bell | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: typing during a live stream cannot make the session read idle | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: a bell 400ms after a keystroke still raises attention | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: exit raises finished attention | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: a title streak makes only title changes count as heartbeats | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: a one-off retitle does not make a session title-driven | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: structural hooks outrank byte-stream heuristics | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ActivityTracker: a bell never downgrades a structural attention | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | ActivityTracker: noteHookSource latches coverage without a transition | Asserts the private bookkeeping latch; terminal/push lifecycle consumers retain their externally observable attention coverage. |

## `apps/daemon/src/assert-ok.test.ts`

Observed Node20/tsx failure: an unmessaged assertion can hang for minutes. The test script preload is used by all package scripts. A bounded real child process executing a long TypeScript module is the lowest stable reproduction; AssertionError semantics and completion can disagree with the preload.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| DELETE | the test script preloads scripts/test/assert-ok.mjs | Proxy identity / exact generated copy / native assertion passthrough are implementation or upstream change detectors, not the observed Node20 hang contract. |
| REWRITE | names its own call, TypeScript and all | Consolidate both assertion entrypoints into a real tsx subprocess with a timeout; assert typed failures complete, without exact message/source formatting. |
| DELETE | quotes a call over several lines as Node does | Proxy identity / exact generated copy / native assertion passthrough are implementation or upstream change detectors, not the observed Node20 hang contract. |
| REWRITE | covers a direct call of the default export | Consolidate both assertion entrypoints into a real tsx subprocess with a timeout; assert typed failures complete, without exact message/source formatting. |
| DELETE | leaves a given message, an Error and a missing value to Node's rules | Proxy identity / exact generated copy / native assertion passthrough are implementation or upstream change detectors, not the observed Node20 hang contract. |

## `apps/daemon/src/cliproxy-config.test.ts`

CLIProxyAPI protocol, persisted configuration, single-refresher credential ownership and authenticated transport gates from README, packages/api and router provider design. Owners cliproxy*.ts and index routes; production callers index daemon setup/routes and session launch. Exact config/auth bytes, public manager status/results, real files and HTTP responses are the stable seams; fakes supply unavailable external services, not expected state transitions.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | state: defaults on garbage, valid passes through | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | secrets: corrupt fails closed, never defaults | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | paths + model charset | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | compactEnvForModel: curated gpt model resolves window + pct | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | compactEnvForModel: acc-prefixed model resolves like its bare id | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| REWRITE | compactEnvForModel: bare claude ids get the arming value only (native window detection) | Replace expected production constant with the independent 1,048,576-token CLI arming value; object must still omit maxContextTokens. |
| REWRITE | compactEnvForModel: claude ids NEVER get maxContextTokens (refused when family-classified) | Replace expected production constant with the independent 1,048,576-token CLI arming value; object must still omit maxContextTokens. |
| KEEP | compactEnvForModel: claude compactWindow/pct overrides pass through (bare-id keyed) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | compactEnvForModel: overrides beat curated defaults, per field | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | compactEnvForModel: a router-shaped id with no configured provider resolves to nothing | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | compactEnvForModel: uncurated non-claude id with no override emits nothing | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | compactEnvForModel: an override alone makes an uncurated id resolvable | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliProxyState: modelOverrides roundtrip and absent-field default | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | CURATED_PROXY_MODEL_IDS is the OAuth picker order sol, terra, luna (no router models) | Copied declaration inventory; configured model resolution and projection behavior remain tested. |
| KEEP | PUT /api/cliproxy/providers/:id validates the provider id charset and body before the manager | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | router mutations map manager errors to 400/404 and restart refusals to 409 | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | router key routes require a key and pass force through (body for POST, query for DELETE) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | catalog route maps unknown → 404, no-key → 409, upstream → 502, and is 403 over the socket | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | every router mutation is refused (403) over the unix socket, and the legacy openrouter/key route is gone | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | POST /api/cliproxy/xai/link returns the device prompt, maps conflict → 409 and upstream → 502 | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | DELETE /api/cliproxy/xai/link passes force through and maps the live-session refusal to 409 | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/cliproxy-files.test.ts`

CLIProxyAPI protocol, persisted configuration, single-refresher credential ownership and authenticated transport gates from README, packages/api and router provider design. Owners cliproxy*.ts and index routes; production callers index daemon setup/routes and session launch. Exact config/auth bytes, public manager status/results, real files and HTTP responses are the stable seams; fakes supply unavailable external services, not expected state transitions.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | config.yaml render: no router block without a key; block + alias with a key; bodies logging off | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | renderConfigYaml emits one openai-compatibility entry per keyed provider with models | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | routerKimiAvailable tracks a keyed provider serving kimi-k3 by name or alias | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | projections: token==apiKey; claudex.env contains ANTHROPIC_MODEL + CLAUDE_CONFIG_DIR; claudemix.env has haiku=backgroundModel and NO ANTHROPIC_MODEL | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | claudex.env Fable slot follows kimi-k3 availability across providers | Replays availability already owned by routerKimiAvailable and projection tests, while unique assertions freeze display prose. |
| KEEP | writeProjections rejects a poisoned router model name or alias | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| REWRITE | wrapper: generated script has no 'source', reads token file path, claudex handles --model | Remove generated-shell source greps; retain private 0700 permissions on both installed launcher files, a host security artifact. |
| KEEP | model charset: writeProjections rejects defaultModel 'x; rm -rf' | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedHome: 0700, marker, .claude.json identity stripped, projects/ absent, skills symlinked | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedHome: HOME-level system .claude.json (sibling of ~/.claude) seeds the onboarding flag | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedHome: no system .claude.json anywhere still writes hasCompletedOnboarding | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedHome: scrubs model-routing env keys from a copied settings.json, keeps the rest | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedHome: seeds managed model-pinned subagents; kimi rides the router availability flag | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| REWRITE | seedHome: seeds the managed delegation CLAUDE.md into claudemix only, kimi line riding the key | Remove exact prose assertion; keep file scoping and external subagent/model identifiers selected by credential availability. |
| KEEP | seedHome: forces autoCompactEnabled:true into an existing settings.json, preserving other keys | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedHome: creates settings.json with managed keys when the system has none | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedHome: settings merge is idempotent and survives a malformed file | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedHome: the managed grok subagent rides the xai link gate, independent of kimi | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| REWRITE | seedHome: the delegation CLAUDE.md names grok only while the xai account is linked | Remove exact heading copy; keep Grok/Kimi model availability in the persisted instruction artifact. |

## `apps/daemon/src/cliproxy-install.test.ts`

CLIProxyAPI protocol, persisted configuration, single-refresher credential ownership and authenticated transport gates from README, packages/api and router provider design. Owners cliproxy*.ts and index routes; production callers index daemon setup/routes and session launch. Exact config/auth bytes, public manager status/results, real files and HTTP responses are the stable seams; fakes supply unavailable external services, not expected state transitions.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | installBinary verifies sha256, installs 0755, keeps prior in bin.prev | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | installBinary rejects a sha256 mismatch and does not install | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | installBinary extracts a nested cli-proxy-api entry | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | installBinary rejects an ambiguous tarball with multiple cli-proxy-api entries | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | installBinary rejects a tarball missing the cli-proxy-api binary | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | installBinary with patches builds from source: git apply then go build, promoted with rollback | Mock manufactures the asserted patched bytes and freezes git/go collaborator argv. Real stock tar extraction/promote/rollback test owns installation durability. |
| REWRITE | installBinary with patches: source sha mismatch rejects before any toolchain call | Drop process-runner spy; retain real checksum rejection and absence of any installed binary. Remove now-unused InstallDeps.run hook. |
| KEEP | listPatches: sorted .patch files only, empty for missing dir | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/cliproxy-manager.test.ts`

CLIProxyAPI protocol, persisted configuration, single-refresher credential ownership and authenticated transport gates from README, packages/api and router provider design. Owners cliproxy*.ts and index routes; production callers index daemon setup/routes and session launch. Exact config/auth bytes, public manager status/results, real files and HTTP responses are the stable seams; fakes supply unavailable external services, not expected state transitions.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| DELETE | boot: port answers + our key accepted → persistence-lost (not foreign) | Duplicate boot/adoption setup asserted by both retained reparent regressions; neither invents own-proxy status in its stub. |
| KEEP | persistence-lost proxy is re-parented under tmux once sessions drain AND the port frees, not just relabeled | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | boot: port answers + key rejected → error 'port conflict', no kill/adopt | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | corrupt secrets.json → state error, secrets file untouched, no config rewrite | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | crash supervision: 3 failed respawns → error latch + single notification event | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | enable: a throwing install does not persist enabled:true (generic catch path) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | enable: a proxy that never probes healthy does not persist enabled:true (proxy-down path) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | enable: a slow-binding proxy that answers on a later probe attempt becomes healthy (startup race) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | enable: a proxy that never probes healthy is reaped — no orphan left holding the port | Only asserts killServiceSession count 2; no actual process ownership, port release or retry behavior is observed. |
| KEEP | disable without force + 2 live sessions → {ok:false, affectedSessions:2}; with force → kills service session | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | disable: an externally-adopted proxy can't be killed → off with a port warning, launchers disabled | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | validateModel: request model wins over default; unknown model fails naming provider; probe hang → bounded failure ≤2s | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | validateModel: claudemix with no request model resolves claudeDefaultModel, NOT defaultModel | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | preflightModels: partitions referenced models into ok/missing against a fresh catalog | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | healthy → registry claudex/claudemix enabled; probe loss → disabled with 'proxy down' | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | enable installs, projects config+token+env, seeds both homes, spawns, enables launchers | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| REWRITE | corrupt secrets.json → enable latches error, installs nothing, writes no config | Remove throwing installer override whose counter never increments; the existing default installer makes the no-install assertion discriminating. |
| KEEP | enable: a throwing install latches error (never wedged in 'starting') and stays retriable | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | bootAdopt: a throw during (re)probe latches error, never stuck in 'starting' | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedProvider writes a prefixed auth file 0600, records the account, marks the provider ok | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedProvider refuses a stale token with 'expired' and writes no auth file (no dual-refresh) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | status per-provider state gates launchers: codex seeded → claudex on, claude absent → claudemix off | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | unseedProvider removes the auth file, drops the account, degrades the provider, broadcasts | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | unseedProvider is idempotent on an unknown id | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | status().routerProviders reports keyState none/set/verified from routerKeys + keyVerifiedAt | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | init(): a legacy openRouterKey migrates into an openrouter router provider, mirror kept | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | probe unions every keyed provider's model names AND aliases into the catalog | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | claudex coupling: a keyed router provider satisfies the codex-or-router gate | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | claudex coupling: a KEYLESS router provider + a claude account → disabled 'no codex, router or Grok credential' | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | upsertRouterProvider: validates the record, restart-gates a KEYED change, and persists | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | upsertRouterProvider: a KEYLESS provider is not restart-gated (it never reaches config.yaml) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | setRouterKey: rejected refuses, unknown stores unverified, ok stamps keyVerifiedAt + legacy mirror | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | setRouterKey: restart-gated while dependent sessions are live | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | clearRouterKey: keeps the provider row, drops the key, and un-satisfies the claudex gate | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | deleteRouterProvider: removes provider + key and resets a model pick that pointed at it | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | fetchRouterCatalog: unknown id, missing key, adapter success and upstream failure | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | credential sync: a proxy-refreshed token is written back into the managed home (repairs a wiped login) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | credential sync: a session-refreshed managed token is written back into the proxy auth file | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seeded accounts persist: a manager over a state file with a seeded codex account reports codex ok + enables claudex, no re-seed | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | boot: a persisted seeded account with a STALE on-disk auth file degrades to 'expired' and disables its launcher; a fresh file stays ok/enabled | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | poll: a seeded credential that expires at runtime degrades to 'expired', disables its launcher, and broadcasts cliproxy.changed | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | enable: a freshly-installed binary that never probes healthy rolls back to bin.prev and respawns | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | reparent: an external survivor still answering on drain stays persistence-lost — no spawn, no error latch | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | setConfig: modelOverrides persist without a restart and surface on status | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxy mutations: 403 on local mode, reach the handler on remote mode | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | GET /api/cliproxy returns the CliProxyStatus shape incl. reasons[] | Shape of a fake status object passed straight through; no real serialization, status derivation, or secret leakage is tested. |
| KEEP | seed route (remote): reads the managed credential, seeds, marks proxy-owned, returns status | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seed route refuses (409) when the proxy is not running; no seed, no ownership flip | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seed route returns 404 (not 500) for a charset-valid accountId with no on-disk credential | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seed route is refused over the unix socket (403); no seed, no ownership flip | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | unseed route (remote): calls unseedProvider, marks proxy-owned false, returns status | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | unseed route is refused over the unix socket (403); no unseed, no ownership flip | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | router key route stores the key, re-projects config.yaml, and is restart-gated | Fake manager itself implements persistence/projection/gating being asserted. Real setRouterKey manager tests and cliproxy-config route status tests own these contracts. |
| DELETE | router key route is refused over the unix socket (403) | Exact duplicate of every-router-mutation local rejection in cliproxy-config.test.ts. |
| KEEP | PUT /api/cliproxy/config: success resolves the full CliProxyStatus (not the {ok} gate result); restart-gated → 409 | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | PUT /api/cliproxy/config is refused over the unix socket (403); the manager is never consulted | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | cliproxyContributor: a real account prefixes the effective model; System/undefined does not | Duplicate launch model/env contract owned by session-launch-env.test.ts and the composed launch tests in agent-timeout-env.test.ts; private merge shape adds no independent failure. |
| DELETE | cliproxyContributor: a router-provider model is emitted bare even with an account; other models are prefixed | Duplicate launch model/env contract owned by session-launch-env.test.ts and the composed launch tests in agent-timeout-env.test.ts; private merge shape adds no independent failure. |
| DELETE | composeExtraEnv: cliproxy env wins on collision, accountId preserved, unsets concatenated | Duplicate launch model/env contract owned by session-launch-env.test.ts and the composed launch tests in agent-timeout-env.test.ts; private merge shape adds no independent failure. |
| KEEP | session model gate: model on refId 'claude' → 400; 'claudex' passes through validateModel | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedProvider: a managed-account label wins over converted email/UUID (claude has no email) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | seedProvider: second claude account seeds ALONGSIDE the first (multi-account routing) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | xai status: derived from the auth dir — none, linked (email/expiry), corrupt files ignored | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | xai status: every auth file past its stamp reads expired, even with the proxy off | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | claudex coupling: a linked Grok account alone satisfies the gate | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | probe union: grok ids validate while linked (no catalog dependency) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | linkXai: works with the proxy OFF and imports a managed account (no seeding) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | linkXai: a start failure surfaces as an upstream result carrying the status | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | linkXai: duplicate attempt while in flight is a conflict; cancel is local-only | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | linkXai: a failed verdict lands on xai.lastLinkError and a fresh attempt clears it | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cancelOrUnlinkXai: live Grok sessions refuse the unlink; force deletes the auth files | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | boot adoption: an orphan xai auth file becomes a managed + seeded grok account | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | boot adoption: a failed import leaves the auth file untouched (still linked) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/cliproxy-secrets.test.ts`

CLIProxyAPI protocol, persisted configuration, single-refresher credential ownership and authenticated transport gates from README, packages/api and router provider design. Owners cliproxy*.ts and index routes; production callers index daemon setup/routes and session launch. Exact config/auth bytes, public manager status/results, real files and HTTP responses are the stable seams; fakes supply unavailable external services, not expected state transitions.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | secrets: creates 0600 with generated values; second load returns identical | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | secrets: corrupt file → {state:'corrupt'}, file untouched (mtime + content unchanged) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | secrets: a router-key write preserves the rest of the file, at 0600 | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | setRouterKey stores under routerKeys and mirrors openrouter into the legacy field | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | clearRouterKey removes the key and clears the openrouter mirror | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/cliproxy-seed.test.ts`

CLIProxyAPI protocol, persisted configuration, single-refresher credential ownership and authenticated transport gates from README, packages/api and router provider design. Owners cliproxy*.ts and index routes; production callers index daemon setup/routes and session launch. Exact config/auth bytes, public manager status/results, real files and HTTP responses are the stable seams; fakes supply unavailable external services, not expected state transitions.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | jwtClaims decodes the payload segment and tolerates malformed input | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | codex conversion maps fields from tokens + id_token claim | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | claude conversion maps from claudeAiOauth and stamps a routing prefix | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | two accounts of one provider get distinct prefixes → individually routable | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | invalid shapes throw, not silently produce garbage | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | accessTokenFreshMs measures against the injected clock, not wall time | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | grok conversion maps the auth.x.ai entry into an xai storage, no prefix | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | grok conversion throws without a usable token pair | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | grok reverse conversion produces a CLI-shaped auth.json (adoption) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/cliproxy-xai.test.ts`

CLIProxyAPI protocol, persisted configuration, single-refresher credential ownership and authenticated transport gates from README, packages/api and router provider design. Owners cliproxy*.ts and index routes; production callers index daemon setup/routes and session launch. Exact config/auth bytes, public manager status/results, real files and HTTP responses are the stable seams; fakes supply unavailable external services, not expected state transitions.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | scanXaiAuthFiles: reads xai-*.json only, tolerating corrupt and foreign files | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | scanXaiAuthFiles: a missing auth dir is 'nothing linked', never a throw | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | deriveXaiAccount: none / linked / expired, latest expiry wins the displayed identity | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | removeXaiAuthFiles: deletes every xai-*.json and nothing else | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | scanXaiQuotaError: picks the most recent usage-exhausted line from the newest log | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/devtools-routes.test.ts`

README remote-only DevTools and secret-redaction/security contract plus Chromium CDP proxy protocol. Owners devtools.ts/index routes, called by BrowserManager and remote server. URL fixtures cover parsing/redaction; real WebSocket peers cover auth close code, queued bytes and loopback Host independent of proxy implementation.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | asset route 404s on path traversal and never reaches upstream | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | asset + ws routes are absent on the local (unix) transport | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ws route rejects a missing/invalid token with 1008 on the remote transport | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ws route preserves a client message sent before the upstream handshake | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | ws route forwards the loopback Host header to upstream | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/devtools.test.ts`

README remote-only DevTools and secret-redaction/security contract plus Chromium CDP proxy protocol. Owners devtools.ts/index routes, called by BrowserManager and remote server. URL fixtures cover parsing/redaction; real WebSocket peers cover auth close code, queued bytes and loopback Host independent of proxy implementation.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | parseDebugPort extracts the loopback port from a puppeteer wsEndpoint | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseDebugPort rejects garbage, missing ports and out-of-range values | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | sanitizeDevtoolsPath accepts normal frontend asset paths | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | sanitizeDevtoolsPath rejects traversal, empty segments and junk | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | redactUrlTokens redacts the plain ?token= form | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | redactUrlTokens redacts the percent-encoded token inside the DevTools wss= value | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | redactUrlTokens leaves token-free URLs untouched | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/grok-device-auth.test.ts`

Grok native auth.json credential schema (issuer/client key, OIDC fields, optional identity/expiry). Owner grok-device-auth.ts; CliProxyManager device flow calls conversion. Literal token fixtures and expected native fields protect importability independently of implementation.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | device tokens become a CLI-shaped auth.json with identity from the id_token | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | identity is optional: no id_token still yields an importable credential | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/recent-projects.test.ts`

Project path/sandbox and recent-project storage/API contracts in AGENTS.md and packages/config/API. Owner RecentProjectsService used by index project routes. Failure modes: record nonproject/file, lost recency/count/cap, stale deleted project, stale archive flag, corrupt-file overwrite. Temporary filesystem and observable lifecycle/list data are stable.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | describeProjectPath accepts only <workspacesDir>/<workspace>/<project> | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | markInteracted records only existing directories, one event each | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | markInteracted upserts newest-first, counts, caps, and persists | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | list drops entries whose directory is gone, and persists the prune | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | list joins the workspaces side-table for the archive curtain | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | markInteracted and snapshot re-read the curtain, not the set list() left behind | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | an unreadable side-table keeps the previous curtain rather than un-hiding | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | without a side-table reader nothing is ever reported archived | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | load survives a corrupt file and drops only the bad entries | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/registry-env.test.ts`

README launchable tools/env privacy contract. Owner RegistryService used by index/session/cliproxy. Failure modes: dotenv parse errors, secret env on public rows, reresolve resurrecting disabled tool, healthy service unable to enable disabled-at-rest launcher. Real isolated registry config with dummy executable avoids host installations.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | parseEnvFile handles common dotenv syntax | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | RegistryService applies per-launcher env files without exposing them in registry responses | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/registry-runtime-state.test.ts`

README launchable tools/env privacy contract. Owner RegistryService used by index/session/cliproxy. Failure modes: dotenv parse errors, secret env on public rows, reresolve resurrecting disabled tool, healthy service unable to enable disabled-at-rest launcher. Real isolated registry config with dummy executable avoids host installations.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | setRuntimeState disables with reason and broadcasts sanitized entry | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | reresolve re-reads env file but cannot resurrect a runtime-disabled entry | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | setRuntimeState enable overrides enabledAtRest:false on a resolved entry | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | the real claudex def stays disabled at rest (enabledAtRest:false) with no runtime override | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/router-providers.test.ts`

Public config/schema/migration contracts in packages/config and docs/superpowers/specs/2026-08-04-router-providers-design.md. Failure modes: malformed URLs/names, ambiguous routing, lost overrides, legacy key leakage to wrong host/prototype keys. These exported config owners feed cliproxy/index; literal config fixtures are independent and no stronger owner covers each malformed/migration edge.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | routerProviderSchema rejects bad ids, bad urls, bad model names | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | validateRouterProviders rejects reserved/duplicate ids and cross-provider model collisions | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | resolveRouterModel matches name, alias, and acc-prefixed forms | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| REWRITE | compactEnvForModel resolves router models by name or alias, overrides win | Use literal expected windows for both names instead of using one production result as the other expected value. |
| KEEP | state/secrets schemas default the new fields; old files still parse | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | migrateLegacyOpenRouter seeds the openrouter provider and mirrors the key | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | ROUTER_PRESETS ship openrouter and tokenrouter with prefilled models | Static declaration inventory; migration, routing and validation tests prove actual configured-provider behavior. |
| KEEP | validateRouterProviders refuses a router model that shadows a curated model id | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | compactEnvForModel emits a router model's compact window even without a context window | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | migrateLegacyOpenRouter skips the seeded record when it would collide with a user provider | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | routerKeyCheckUrl only uses openrouter.ai when the baseUrl really points there | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | getRouterKey never walks the prototype chain and rejects non-string values | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | migrateLegacyOpenRouter refuses to attach the legacy key to a foreign-host 'openrouter' provider | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/saved-prompts-routes.test.ts`

Saved-prompt API/config/storage contract (packages/api, packages/config, AGENTS.md preservation and filesystem rules). Owners SavedPromptsService and index HTTP routes. Failure modes: missing/duplicate seed, lost/corrupt prompts, destructive tolerant rewrite, validation/cap errors, wrong project scope, lost concurrent updates, failed-delete cascade, broken wire event/status. Real library files and service/API data survive storage refactors; wire tests retain route-only envelopes/cascade behavior.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | saved prompts: create, list, update, use and delete over HTTP | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | saved prompts: refusals are { code, message } with the service's status | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | saved prompts: ?projectPath= adds that project's prompts to the global ones | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | deleting a project, then its workspace, deletes their saved prompts | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a delete whose rm fails leaves the project's prompts and to-dos alone | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a read-only library answers reads, refuses writes with a 503, and never fails a project delete | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a workspaces directory moved at runtime is followed by validation and cascades alike | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | working diff route: sandboxed, isRepo:false for a plain dir, maxBytes parsed and clamped | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/saved-prompts.test.ts`

Saved-prompt API/config/storage contract (packages/api, packages/config, AGENTS.md preservation and filesystem rules). Owners SavedPromptsService and index HTTP routes. Failure modes: missing/duplicate seed, lost/corrupt prompts, destructive tolerant rewrite, validation/cap errors, wrong project scope, lost concurrent updates, failed-delete cascade, broken wire event/status. Real library files and service/API data survive storage refactors; wire tests retain route-only envelopes/cascade behavior.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| REWRITE | a first run seeds the four starters, in order, verbatim, and writes the file at once | Remove copied starter bodies/order/timestamp offsets/export inventory; retain nonempty usable global seeds, unique ids, immediate disk persistence and 0600 mode. |
| KEEP | the starters are seeded once: after deleting them, restarts never bring them back | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a corrupt file is moved aside byte for byte, and the library starts empty — not seeded | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | an unknown version, or a file that is not a library at all, is treated as corrupt | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a corrupt file that cannot be moved aside makes the library read-only | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a file that cannot be READ is left where it is, and the library is read-only | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | an unreadable (permission-denied) library is never moved or replaced | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | the tolerant read sets aside only the malformed prompts, and keeps what a newer build added | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | entries this build cannot read, and unknown top-level keys, survive every write untouched | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | create answers the whole record, writes it, and announces it | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | every limit is enforced with a 400 INVALID_REQUEST that says what is wrong | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | tags are trimmed, blanks dropped, deduplicated case-insensitively (first spelling), then limited | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a create past the library limit is a 409 SAVED_PROMPTS_FULL | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | update changes only what the patch names, stamps updatedAt, and announces it | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | marking a prompt used stamps lastUsedAt and counts, without touching updatedAt | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | delete removes the prompt, writes, and announces its id and scope | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | overlapping mutations are all on disk, in their final state | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a project path must be <workspaces>/<workspace>/<project>, inside the sandbox, an existing directory | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | the workspaces directory and sandbox root are read at every use, so a runtime move needs no restart | Same runtime-move scenario has stronger real route validation and cascade coverage in saved-prompts-routes.test.ts. |
| KEEP | list answers the global prompts plus the named project's own, and validates the project | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | deleting a project or a workspace takes its prompts along, announcing each one | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | every change reaches the /events bus on the saved-prompts channel | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/session-initial-command.test.ts`

README daemon-owned persistent PTY/session contract and packages/api SessionSummary/launch request. Owners sessions.ts/index launch env; production callers index session routes. Failure modes: dropped initial command, wrong child env/model/account, lost tmux model on disk, missing bell/exit attention. Real PTYs/generated script execution/persisted index are stronger than resolver/argv call shape.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | initialCommand is typed into the fresh PTY and run by the shell | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a blank initialCommand writes nothing to the PTY | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/session-launch-env.test.ts`

README daemon-owned persistent PTY/session contract and packages/api SessionSummary/launch request. Owners sessions.ts/index launch env; production callers index session routes. Failure modes: dropped initial command, wrong child env/model/account, lost tmux model on disk, missing bell/exit attention. Real PTYs/generated script execution/persisted index are stronger than resolver/argv call shape.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| REWRITE | wrapper exports env and unsets requested keys | Execute the generated launcher with a real Node child, asserting child environment/arguments; no shell source matching or wrapper shape. |
| REWRITE | wrapper still returns a script when only unsets are present (no env) | Execute the generated launcher with a real Node child, asserting child environment/arguments; no shell source matching or wrapper shape. |
| KEEP | cliproxyContributor pins the account and prefixes the model for a real account | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor records no account for the System pick (round-robin) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor records no account for a router model (by alias) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: a router model launches BARE with the provider's compact env | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: routing is data-driven, not name-shaped (zai/glm-5 via alias) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: a non-router model still carries the acc prefix when ambiguous | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | cliproxyContributor pins the account for claudemix | Duplicate of retained prefixed Claude/ambiguous non-router launch cases or composed account attribution; private helper shape adds no independent launch failure. |
| KEEP | cliproxyContributor: the sole seeded account of a provider launches BARE (no acc prefix leak) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | cliproxyContributor: a second seeded account of the same provider forces the prefix | Duplicate of retained prefixed Claude/ambiguous non-router launch cases or composed account attribution; private helper shape adds no independent launch failure. |
| KEEP | cliproxyContributor returns null for a non-proxy entry | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: gpt launch emits window + compact window + pct | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: a router model's own metadata drives the window, with no pct | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: a configured router model emits its 1M window, 450k compact, no pct | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: a PREFIXED claudemix launch rides the [1m] suffix (stripped client-side) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: a 200k-class contextWindow override suppresses the [1m] suffix | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: a BARE claudemix launch (sole seeded claude account) stays arming-only | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: claudemix modelless launch still gets the arming window | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: claudex modelless launch resolves the configured defaultModel | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | cliproxyContributor: state modelOverrides beat curated defaults at launch | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | composeExtraEnv carries accountId from b when a is null | Duplicate of retained prefixed Claude/ambiguous non-router launch cases or composed account attribution; private helper shape adds no independent launch failure. |
| DELETE | composeExtraEnv prefers a's accountId when both set | Duplicate of retained prefixed Claude/ambiguous non-router launch cases or composed account attribution; private helper shape adds no independent launch failure. |
| KEEP | cliproxyContributor: an xAI OAuth model launches BARE with its curated compact env | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/session-model.test.ts`

README daemon-owned persistent PTY/session contract and packages/api SessionSummary/launch request. Owners sessions.ts/index launch env; production callers index session routes. Failure modes: dropped initial command, wrong child env/model/account, lost tmux model on disk, missing bell/exit attention. Real PTYs/generated script execution/persisted index are stronger than resolver/argv call shape.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| REWRITE | resolver receives ctx with model; summary carries it | Drop private resolver call tracking; retain model in the public local-session summary, independently supplied as kimi-k3. |
| DELETE | model omitted → ctx.model undefined (route-level default resolution is upstream) | Private resolver-argument assertion plus absent property. Route model resolution remains owned by resolveLaunchModel coverage; local summary and tmux persistence remain here. |
| KEEP | effective model persists on the reattach record | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/sessions-activity.test.ts`

README terminal activity contract; sessions.ts production lifecycle consumed by index broadcast/push. Failure modes: PTY bells not reflected/cleared, finished event lost by wrong exit ordering. Real PTY processes exercise public manager snapshots/events; the lower scanner tests own grammar only.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | LocalSessionManager tracks bell activity and clears attention on input | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | LocalSessionManager raises finished attention when the command exits | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | buildLaunchCommand adds a login flag for tmux-backed shells only | Pins private shell argv construction without executing a shell or proving login/agent behavior; actual PTY lifecycle tests remain. |
| DELETE | buildLaunchCommand can launch an agent as a child of a real shell | Pins private shell argv construction without executing a shell or proving login/agent behavior; actual PTY lifecycle tests remain. |

## `apps/daemon/src/system-status.test.ts`

Linux /proc format and AGENTS.md daemon session/process ownership security. Owner SystemStatusService and format readers feed index system routes. Failure modes: incorrect CPU/memory/port decoding, wrong session ancestry, reused PID signalled, unrelated or protected process killed, orphaned provider left unmanaged, unreadable disk shown as zero. Literal kernel fixtures own parsing; real isolated child-process kill/listing tests own security and output. Private cache/sleep/collaborator counters are deleted.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | parseCpuSample sums the aggregate line and counts iowait as idle | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseCpuSample tolerates junk | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseMemInfo prefers MemAvailable and converts kB to bytes | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseMemInfo falls back to MemFree on pre-3.14 kernels | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseProcStatus reads name, ppid and RSS | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseProcStatus reads the real uid when the status names one | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | launchMarkerOf reads the agent host's launch marker and the chat it belongs to | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseProcStatus tolerates a kernel thread with no VmRSS | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseCmdline joins the NUL-separated argv | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | decodeProcNetAddress decodes little-endian v4 and v6 addresses | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | decodeProcNetAddress rejects malformed cells | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseProcNetTcp keeps only LISTEN rows | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseSocketInode only matches socket links | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | collectTree tags descendants with the nearest ancestor session | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | collectTree terminates on a corrupted parent cycle | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | descendsFromRoot is the kill boundary | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | descendsFromRoot does not loop on a parent cycle | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | collectDescendants returns the pid plus everything under it | Thin private collectTree wrapper; real subtree kill and collectTree attribution tests are stronger owners. |
| KEEP | parseProcStat survives a comm containing spaces and parentheses | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | parseProcStat agrees with parseProcStatus on this very process | Compares two production parsers; both could agree incorrectly. Literal /proc fixtures and live identity/kill cases supply independent oracles. |
| KEEP | cpuPercentFromSamples is the busy share of the delta | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | mapLimited preserves order and never exceeds the limit | Internal worker scheduling and copied mapping logic, no caller-visible process/resource failure. |
| KEEP | resolveSocketOwners picks the lowest pid sharing a listen socket | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | resources() resamples CPU when the stored baseline is stale | Counts injected sleep calls and accepts any 0..100 result; would pass an incorrect stale CPU result. Remove now-unused clock/sleep options. |
| KEEP | resources() reports an unmeasurable volume as unknown, not as 0 bytes | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | verifyProcessIdentity rejects a pid whose parent changed under us | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | kill() refuses with a discriminating code and only kills our own subtree | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a process carrying the agent host's launch marker is managed even as an orphan: listed, labelled, killable | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a marked process whose parent still runs outside every root is no orphan: never listed, never killable | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | kill() refuses a protectedPids entry, directly and inside a subtree | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | concurrent cold processes()+ports() share one /proc scan | Uses listSessionIds call count as private scan-counter proxy. No resource response or safety behavior is asserted. |

## `apps/daemon/src/tmux-service-session.test.ts`

README service ownership and tmux lifecycle plus shell environment contract. Tmux is called by sessions and cliproxy; sessionEnvBase feeds direct/tmux children. Isolated real tmux socket proves service survives session scans and rejects wrong namespace; environmental shell cases prove executable interactive fallback. No live daemon socket is used.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| DELETE | SERVICE_SESSION_PREFIX is outside the reaped orq- namespace | Declaration checked against a literal plus literal.startsWith literal. The real service-session isolation test below proves reaper exclusion. |
| KEEP | service session lives outside orq- namespace and survives listSessions/reattach scans | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | newServiceSession rejects non-orqsvc names | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/tmux.test.ts`

README service ownership and tmux lifecycle plus shell environment contract. Tmux is called by sessions and cliproxy; sessionEnvBase feeds direct/tmux children. Isolated real tmux socket proves service survives session scans and rejects wrong namespace; environmental shell cases prove executable interactive fallback. No live daemon socket is used.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| DELETE | default args: colors + full history (back-compatible) | Private captureArgs argv shape, not terminal output. Removing the test-only export leaves actual capture behavior and its production call untouched. |
| DELETE | escapes:false drops -e (plain text) | Private captureArgs argv shape, not terminal output. Removing the test-only export leaves actual capture behavior and its production call untouched. |
| DELETE | lines:0 → current screen (-S 0); lines:N → -S -N | Private captureArgs argv shape, not terminal output. Removing the test-only export leaves actual capture behavior and its production call untouched. |
| KEEP | sessionEnvBase replaces nologin shell for child PTYs | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | sessionEnvBase preserves an executable interactive shell | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/usage-aggregate.test.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| REWRITE | worst-account picks the highest-percent window per field across accounts | Remove input/output array identity assertion; retain literal independent worst-window percentages, availability, account counts. |
| DELETE | managed-only (base === null) surfaces the worst managed window, not empty | Strict subset of worst-account highest-percent case using null base and no resetsAt on both windows. |
| KEEP | System base participates in the pool and can be the worst source | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | carries the resets/capacity of the chosen worst window and its freshness | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | null windows everywhere leave head windows null and mark stale | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | an expired window (resetsAt in the past) never wins the worst-account pick | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | windows that all expired leave the head window null | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | a window without resetsAt is treated as current | Strict subset of worst-account highest-percent case using null base and no resetsAt on both windows. |
| KEEP | the System base is exposed as a `system` row (expired windows scrubbed) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | no System base ⇒ no system row | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | head is not stale when a fresh window is shown even if another account is stale | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/usage-claude-home.test.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| DELETE | createClaudeSource honors an explicit claudeHome for credentials | Duplicate: usage-claude-state tests successfully load explicit managed homes; usage-sources.check.ts covers default home plus explicit/environment precedence with real files. |
| DELETE | createClaudeSource without claudeHome falls back to userhome/.claude | Duplicate: usage-claude-state tests successfully load explicit managed homes; usage-sources.check.ts covers default home plus explicit/environment precedence with real files. |

## `apps/daemon/src/usage-claude-state.test.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| REWRITE | asks the endpoint at most once per window, even with nothing to show | Use the independent five-minute request budget instead of importing the implementation interval as expected time. |
| REWRITE | a restart keeps the last reading and waits out the window the previous process opened | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | a 429's Retry-After survives a restart and the last reading is served greyed meanwhile | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | a live reading replaces the account windows, keeps the scoped ones, and skips the poll | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | a live reading on an account with no reading yet stands on its own | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | a stamp from the future (the clock moved back) does not block the endpoint | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| KEEP | UsageStateFile round-trips, drops what does not parse and moves a corrupt file aside | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | a thread's live windows become the account's session and weekly readings | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/usage-codex-wham.test.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | maps plan_type and primary/secondary windows | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | week-only primary_window (7d limit, no secondary) → weekly slot | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | unparseable payload → available:false | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/usage-expiry.test.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | parseClaudeUsage drops a window whose reset time has already passed | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| REWRITE | expired-token lastGood serves only windows that have not reset yet | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |

## `apps/daemon/src/usage-first-reading.test.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | whenFirstReading waits for the first reading after start, and is bounded | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/usage-parse.check.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | Claude legacy/limits[] quota windows and plan | Public protocol/service result; independent fixture; six bar items and failure family above. |
| KEEP | Claude epoch-leak value rejected | Public protocol/service result; independent fixture; six bar items and failure family above. |
| KEEP | Codex primary/secondary and week-only/reset-derived assignment | Public protocol/service result; independent fixture; six bar items and failure family above. |
| KEEP | Codex expired window removed | Public protocol/service result; independent fixture; six bar items and failure family above. |
| KEEP | Latest token_count selected, invalid lines ignored | Public protocol/service result; independent fixture; six bar items and failure family above. |
| KEEP | Grok billing weekly pool/plan/reset and proto3 omitted zero | Public protocol/service result; independent fixture; six bar items and failure family above. |
| KEEP | Expired/malformed Grok billing unavailable | Public protocol/service result; independent fixture; six bar items and failure family above. |

## `apps/daemon/src/usage-scoped.test.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | parseClaudeUsage surfaces a model-scoped weekly limit alongside the legacy windows | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseClaudeUsage drops scoped windows that are unlabeled, expired, or garbage | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | parseClaudeUsage keeps scoped windows in the limits[]-only shape too | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | aggregateWorstAccountUsage carries scoped windows on account rows and the system row | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| REWRITE | stale last-known reading drops scoped windows whose reset has passed | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |

## `apps/daemon/src/usage-sources.check.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| REWRITE | Claude first 429 stays signed-in/stale with plan and backs off | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| DELETE | Claude 200→429 stale reading preserves numbers/asOf (DELETE duplicate usage-claude-state Retry-After/restart case; remove minIntervalMs bypass) | Public protocol/service result; independent fixture; six bar items and failure family above. |
| REWRITE | Claude missing credential is absent | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | Codex empty newest rollout falls back to older token_count | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | Codex API-key mode is absent | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | Codex missing/malformed access token still permits rollout fallback | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | Grok unlinked absent; proxy file gives weekly account row with protocol headers and token redaction | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | Grok expired credential stale and never transmitted | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | Grok 429 serves last-good and backs off | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | Grok CLI auth resolves/caches user id | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | Grok pinned managed home supplies its identity | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |
| REWRITE | Claude/Codex env-home and explicit-home precedence | Public protocol/service result; independent fixture; six bar items and failure family above. Native fetch mocks replace factory injection; see [runtime seam follow-up](daemon-runtime-followup.md) for the six-part bar, callers and validation. |

## `apps/daemon/src/usage-system-visibility.test.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | claude: expired system credentials hide the System row | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | claude: unexpired system credentials keep the System row | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | claude: missing credentials file does not hide (source already reports null) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | codex: system account matching a managed account_id hides the System row | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | codex: system account matching a managed email (no account_id) hides the System row | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | codex: a distinct, unexpired system account keeps the System row | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | codex: an expired system token hides the System row even with a distinct identity | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | codex: missing auth.json does not hide (source already reports null/scrape) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## `apps/daemon/src/usage-tokens.test.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | estimateCostUsd multiplies by the per-million price table | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | 1h-TTL cache writes bill at 2x input, 5m at 1.25x | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | fable and gpt-5.6-sol are priced | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | unknown model yields null cost | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | versioned model ids resolve to the bare pricing key (F1) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | aggregateRows groups by agent/model/day and sums tokens | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | scanCodex reads the real event_msg/token_count/info shape and sums per-turn usage | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | scanClaude also walks managed-account homes | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | scanClaude reads the 1h cache-write split and skips zero-usage rows | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | scanClaude dedupes repeated message.id+requestId across files (F2) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | scanCodex reads model from turn_context payload and prices it (F4) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | recompute caches unchanged files and stays correct on partial rescan (F5) | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | appended lines are parsed incrementally — the already-parsed prefix is never re-read | Pins caching strategy rather than correct current totals: corrupted historical input is required to remain invisible, or private recompute is replaced to count calls. Retained append/tail/truncation tests assert real token totals. |
| KEEP | a truncated/rewritten file is fully re-parsed | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | codex parser state (model, cumulative gate) carries across appended chunks | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | an unterminated tail line is counted once, then not double-counted when completed | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | proxy-home transcripts are tagged with the launcher id, not folded into the claude aggregate | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | requestRecompute coalesces bursts: leading run + one trailing run per cooldown window | Pins caching strategy rather than correct current totals: corrupted historical input is required to remain invisible, or private recompute is replaced to count calls. Retained append/tail/truncation tests assert real token totals. |

## `apps/daemon/src/usage.check.ts`

README quota/token/cost widget, provider usage/auth/rollout protocols, API UsageResponse, persisted usage-state contract. Owners usage.ts/usage-sources.ts/usage-parse.ts/usage-tokens.ts and index aggregation; production callers index usage routes/account selection/watchers. Failure modes: stale/exhausted quota after reset, wrong account attribution, secret/token exposure, repeated 429 traffic, lost restart cache, double-counted transcript tokens, unknown model priced falsely. Independent provider-shaped fixtures and real temporary files drive public source/scanner/service results. Parsing edge tests own schema; source cases own credentials/backoff; aggregation owns cross-account choice.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| KEEP | Forced snapshot includes enabled sources | Public protocol/service result; independent fixture; six bar items and failure family above. |
| KEEP | Identical readings do not rebroadcast | Public protocol/service result; independent fixture; six bar items and failure family above. |
| KEEP | Disabled agent omitted | Public protocol/service result; independent fixture; six bar items and failure family above. |
| KEEP | Global disabled yields no agents | Public protocol/service result; independent fixture; six bar items and failure family above. |
| KEEP | Null unauthenticated source omitted | Public protocol/service result; independent fixture; six bar items and failure family above. |

## `apps/daemon/src/xai-models.test.ts`

Public config routing and compaction contract: Grok OAuth model ids resolve bare or one account prefix; 190k compaction avoids the 200k billing cliff; overrides win; routers cannot shadow built-ins. Owners packages/config compactEnvForModel/resolveXaiModel/validateRouterProviders feed index/cliproxy. Literal expected config outputs are independent; declaration inventories are removed.

| Disposition | Original case / distinct failure guarded | Reason / remaining stronger coverage |
| --- | --- | --- |
| DELETE | XAI_OAUTH_MODELS is the curated Grok pair with the 200k compaction cliff | Declaration inventory duplicated by retained compactEnvForModel exact 190k output tests. |
| KEEP | resolveXaiModel matches bare and acc-prefixed ids only | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | compactEnvForModel resolves xai models from XAI_OAUTH_MODELS | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| KEEP | compactEnvForModel lets modelOverrides win over the xai defaults | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |
| DELETE | compactEnvForModel keeps the router branch ahead of the xai branch | Demands private branch precedence for an explicitly illegal shadowing record; retained collision-rejection test protects reachable configuration. |
| KEEP | validateRouterProviders rejects router models shadowing an xai model id | Retains the distinct named contract/failure at the owner seam above; no retained test subsumes this input/state edge. All six bar items apply. |

## Removed dead support / seams

Removed test-only `captureArgs`, `buildLaunchCommand`, `composeExtraEnv`, `STARTER_PROMPTS`, `mapLimited`, `collectDescendants` exports after repository reference checks; their internal production functions remain. Also made installer helpers `patchesDir`, `releaseUrl`, and `buildPatchedBinary` private after confirming only same-file production callers. Removed `InstallDeps.run`, system resource clock/sleep injection, token-scanner cooldown override, Claude usage minimum-interval bypass, and unused usage cadence overrides after checking production callers; each production default remains unchanged. No fixture or snapshot files become orphaned; temporary fixtures are inline. Simplified the route fake after deleting its reimplemented persistence.

## Validation result

Baseline assigned `.test.ts` run: **410 passed, 0 failed, 0 skipped** (25.1s). Final retained suite: **364 passed, 0 failed, 0 skipped** across the full run and the affected-file retry; **46 fewer cases**, **906 net test/check lines removed** (87 added, 993 removed). No retained baseline regression failed.

- Focused rewritten/seam-owner run: `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/assert-ok.test.ts src/cliproxy-install.test.ts src/session-launch-env.test.ts src/saved-prompts.test.ts src/system-status.test.ts` — 75 passed.
- Assigned `.test.ts` files, using the same node imports and paths listed in this report — 229 passed immediately; eight files were temporarily unable to import an in-progress Grok export edit owned by another worker. After that production export was restored, the precise retry below passed all135 remaining cases.
- Retry: `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/agent-timeout-env.test.ts src/cliproxy-config.test.ts src/cliproxy-manager.test.ts src/devtools-routes.test.ts src/saved-prompts-routes.test.ts src/session-launch-env.test.ts src/usage-aggregate.test.ts src/usage-scoped.test.ts` — 135 passed.
- Standalone checks, each with the same node imports: `src/usage-parse.check.ts`, `src/usage-sources.check.ts`, `src/usage.check.ts` — all passed.
- Scoped `git diff --check` — passed; final production and test diffs reviewed.
- Daemon typecheck retry and repository integration gates are recorded by the root cleanup report. No coverage/test-count gate conflict was observed.

Risk: test-only signatures/exports are narrower; all repository references were checked before removal. Installation, launch environments, polling intervals, session lifecycle, and persisted bytes retain their prior production behavior. The rewritten assertion regression observes bounded process completion and `AssertionError`, so formatting/native passthrough no longer freezes the hook's implementation.
