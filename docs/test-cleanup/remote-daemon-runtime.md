# Incoming daemon runtime test audit and merge cleanup

Completed remote cleanup, with dispositions recorded before editing. Audit of remote `8dcbdc61` relative to baseline `008f84e6`. Root merges the model-proxy retirement; this report supersedes earlier KEEP/REWRITE decisions for the retired owners below. Sources read: incoming test and owner diffs, current daemon cleanup, `agent-hooks.ts`, `agent-accounts.ts`, `usage-sources.ts`, `usage-tokens.ts`, `system-status.ts`, `sessions.ts`, `index.ts`, registry and tmux wiring.

No production edits before the root merge-ready signal. Preserve previously deleted inventories/test-only seams and the real shell execution rewrites. Grok device-link and model-proxy-retirement tests/owners belong to the accounts/files agent.

## Incoming surviving/modified contracts

Each case below specifies its six retention bars explicitly. Risk is loss of the named migration, security, config or output contract; focused verification exercises the lowest owning production service with real files/processes and controlled external network replies. No owner is changed merely to preserve a test.

- **REWRITE** `apps/daemon/src/agent-accounts.test.ts` — `an account the retired model proxy owned is refreshed by the account service again`: Persisted account migration/refresh ownership is an independent compatibility contract after proxy retirement. A legacy proxyOwned:true record must not leave a managed login expired. Read the resulting auth.json and require NEW/NEWR credential bytes, not only a fetch count or internal record shape. AgentAccountsService init/ensureFreshForUsage plus its persisted credential file is the stable lowest storage/lifecycle seam; native fetch mocking only supplies OAuth bytes. Helper/clock refactors cannot alter this expectation. The ordinary expiring-account test never loads the legacy flag, so it cannot detect this regression. Keep the existing native fetch setup and remove incoming fetchImpl injection.
- **KEEP** `apps/daemon/src/agent-conversations.test.ts` — `every conversation is attributed to the home it was read from`: Resume identity is an existing public conversation-list contract, and the retired launcher cannot resume a proxy home. Real system/account/proxy transcript files must list only sys-1/acct-1 with their literal home/account identity. A wrong owner resumes the wrong credentials; scanning a retired home exposes an unusable conversation. listAgentConversations is the public lowest filesystem-listing owner, independent fixture IDs determine expected rows, internal scanner refactors preserve the output, and no single-provider parser test covers multi-home attribution/exclusion.
- **DELETE** `apps/daemon/src/agent-family.test.ts` — `agentFamily maps each launcher id onto its family`: direct switch/declaration inventory. The only production consumers are hook installation/config targeting and timeout composition. Real agent-hooks.test.ts config writes, the retired-launcher no-config-side-effect case, and the composed non-Claude timeout case cover their caller-visible failures at the stable effect seam; no distinct behavior remains.
- **DELETE** `apps/daemon/src/agent-family.test.ts` — `grok is its own family and gets no claude timeout env`: Duplicate direct helper assertion. The rewritten composed non-Claude launch case in agent-timeout-env.test.ts covers grok, codex and retired IDs at the real launch environment owner.
- **DELETE** `apps/daemon/src/agent-family.test.ts` — `claude installs claude-family hooks at its CLAUDE_CONFIG_DIR, never the opencode plugin`: The remote turns a formerly proxy-specific dispatch regression into the existing agent-hooks.test.ts cases “claude install is awaited, quotes the command, and creates 0600 settings + 0755 script” and “per-account env overrides route installs to the account config home”. Those execute the same real installer and verify the public config file; this extra layer adds no distinct failure.
- **REWRITE** `apps/daemon/src/agent-family.test.ts` — `a retired launcher id installs nothing`: Retirement means unsupported claudex/claudemix IDs must not modify agent configuration. Exercise both literal retired IDs through real AgentHooks.ensureForEntry against a temporary config tree and require no settings/plugin/hooks artifact. This is a caller-visible config side-effect rule with a literal absent-file expectation; public installation is the lowest side-effect seam, internal dispatch refactors survive, and the family mapping alone cannot detect an installer that writes before checking family.
- **DELETE** `apps/daemon/src/agent-timeout-env.test.ts` — `returns null for every non-claude launcher`: Direct timeout helper duplicates the retained composed non-Claude launch contract; keep the earlier cleanup deletion.
- **DELETE** `apps/daemon/src/agent-timeout-env.test.ts` — `the claude launcher gets all three keys`: Three external override keys are already asserted on the retained managed Claude launch composition; keep the earlier cleanup deletion.
- **DELETE** `apps/daemon/src/agent-timeout-env.test.ts` — `converts minutes to milliseconds at both bounds`: Isolated multiplication examples duplicate actual timeout environment composition and do not establish a separate user contract; earlier cleanup already removed this case.
- **KEEP** `apps/daemon/src/agent-timeout-env.test.ts` — `a claude launch under a managed account carries the timeout env and keeps the account`: The Claude CLI timeout env keys are an external config contract; managed launch must preserve the resolved account home and ID. Literal 1800000 values and /from-account differ from any implementation calculation. buildAgentLaunchEnv is used by index.ts resolveExtraEnv, the lowest combined composition seam; dropping its contributor or overwriting account identity changes a real session. Refactoring merge helpers preserves the observed environment and no remaining lower helper test covers the composition.
- **KEEP** `apps/daemon/src/agent-timeout-env.test.ts` — `plain claude (no managed account) still carries the timeout env`: System-home Claude launch also receives the externally documented timeout overrides when the account contributor is null. Literal 900000 checks the CLI-visible result through production launch composition. A null short-circuit could drop all overrides while the managed-account case passes; no remaining stronger case covers it, and helper refactors cannot change this output.
- **REWRITE** `apps/daemon/src/agent-timeout-env.test.ts` — `a non-claude launcher composes to no timeout keys`: Non-Claude and retired launcher IDs must not receive Claude-specific environment keys. Exercise codex/grok/claudex/claudemix through the same production composition while preserving a supplied account environment. Literal absent-key/preserved-CODEX_HOME expectations do not derive from production; a wrong family leaks configuration into a real child. This is the lowest composed caller seam, refactor tolerant, and complements rather than duplicates the positive Claude cases.
- **DELETE** `apps/daemon/src/chat-client/index.test.ts` — `chat-client re-exports the very functions the MCP uses, never copies`: Export identity inventory; retain the whole-file deletion from the original cleanup. Actual workflow/MCP caller tests cover behavior and the typechecker finds missing exports.
- **REWRITE** `apps/daemon/src/session-launch-env.test.ts` — `wrapper exports env and unsets requested keys`: Preserve the original cleanup replacement “launcher child receives env overrides, removals and literal arguments”. Shell environment removal and literal argument safety are external process/security contracts. A real spawned child emits its actual env/argv; literal expected values expose injection, bad quoting or inherited secret leakage. The generated script process is the lowest stable effect seam and survives wrapper refactors; no source grep/helper merge test protects execution.
- **REWRITE** `apps/daemon/src/session-launch-env.test.ts` — `wrapper still returns a script when only unsets are present (no env)`: Preserve the original cleanup replacement “launcher removes inherited credentials even without env overrides”. Removing a credential without adding env values is a separate real child-process security behavior. The child observes no inherited key; expected empty JSON is literal. Script execution is stable across refactors and uniquely catches an empty-env early return.
- **DELETE** `apps/daemon/src/session-launch-env.test.ts` — `composeExtraEnv carries accountId from b when a is null`: Private merge shape; the real composed launch and child execution cases own caller effects. Preserve earlier deletion and private composeExtraEnv export.
- **DELETE** `apps/daemon/src/session-launch-env.test.ts` — `composeExtraEnv prefers a's accountId when both set`: Private merge shape duplicates the retained launch composition account identity; preserve earlier deletion.
- **REWRITE** `apps/daemon/src/system-status.test.ts` — `kill() refuses a protectedPids entry, directly and inside a subtree`: The agent-host kill guard is a security/session-ownership contract in AGENTS.md and agent-chat design §3.1. Real spawned test children prove PROCESS_PROTECTED and actual survival for direct/descendant kills; literal code/liveness checks are independent of the implementation. SystemStatusService.kill is the lowest process-control owner; refactors preserve externally observed survival, and parser/identity tests cannot detect signaling a protected child. Adopt the new {pid,label} input, delete exact refusal-copy assertion, and use child readiness/exit events instead of sleep delays.
- **DELETE** `apps/daemon/src/tmux-service-session.test.ts` — `SERVICE_SESSION_PREFIX is outside the reaped orq- namespace`: Declaration/literal checked against itself; retained actual tmux service-session isolation proves reaper exclusion. Keep prior deletion despite renamed string in remote.
- **KEEP** `apps/daemon/src/usage-tokens.test.ts` — `managed-account home transcripts are counted under the bare agent, alongside the system home`: Usage aggregation is a public data contract: separate literal system/account transcripts with 4+9 input tokens must report 13 under claude. Real temporary transcript files are read by UsageTokensScanner, the lowest aggregation owner. Wrong labeling or omitted account roots changes the visible quota; literal totals and family are independent of scanner logic; internal caches/refactors preserve output. Single-home parser tests do not protect aggregation across real homes.

## Incoming standalone Grok usage checks

Path: `apps/daemon/src/usage-sources.check.ts`, `grokTests`. Shared six-bar record: (1) public usage data, credential isolation and persisted managed-home compatibility independently require correct reading/authentication and stale fallback; (2) each named failure below affects visible account usage or sends an invalid credential; (3) fixture credentials, percentages and request headers are literal and not computed by createGrokSource; (4) real auth files feed the production usage source and only the external HTTP endpoint is mocked; (5) no private parser/cache identifiers or call shape are asserted; (6) createGrokSource is the lowest owner of credential-source selection and public usage response, while account refresh/device-link tests do not read billing. Retain existing native global fetch setup so no removed fetchImpl seam returns.

- **REWRITE** `No credential anywhere returns null` — Absent managed and CLI files must produce the signed-out state instead of a fake authenticated row. All six shared bar items apply; no stronger owner covers this distinct input/selection/failure branch.
- **REWRITE** `Freshest managed-home credential supplies billing headers and account label` — Two real auth files with distinct expiration/token/identity values must select SECRET-TOK/uid-1/user@example.com; a wrong home contaminates account usage. All six shared bar items apply; no stronger owner covers this distinct input/selection/failure branch.
- **REWRITE** `Token material never enters the returned usage payload` — Returned JSON must not include the literal secret bearer or user identifier; the public usage endpoint must not expose credentials. All six shared bar items apply; no stronger owner covers this distinct input/selection/failure branch.
- **REWRITE** `Managed home outranks the CLI login` — A newer CLI token must not replace the selected managed credential; observe literal outbound Authorization. All six shared bar items apply; no stronger owner covers this distinct input/selection/failure branch.
- **REWRITE** `Expired managed credential returns stale without fetching` — The source must not send a known-expired token and must preserve the signed-in state instead of null. All six shared bar items apply; no stronger owner covers this distinct input/selection/failure branch.
- **REWRITE** `429 preserves the last-good percentage and suppresses repeated network calls` — A rate-limited endpoint must keep 50% stale and respect backoff; network request count here is the actual external protocol side effect, not private collaborator shape. All six shared bar items apply; no stronger owner covers this distinct input/selection/failure branch.
- **REWRITE** `CLI fallback resolves missing user ID once and reads billing` — Missing managed files must fall through to CLI login; actual /user then /billing interaction and subsequent percentage distinguish an unusable fallback. All six shared bar items apply; no stronger owner covers this distinct input/selection/failure branch.
- **REWRITE** `Explicit authFile pins one managed account` — Per-account poll must read MGMT-TOK with managed@example.com rather than another discovered credential. All six shared bar items apply; no stronger owner covers this distinct input/selection/failure branch.

Unchanged Claude/Codex/home-override checks keep the dispositions in daemon_runtime.md; this merge only adapts Grok credential ownership and preserves removal of fetch injection.

## Retired product-owner deletions

Every named case below is **DELETE**, superseding any earlier KEEP/REWRITE. Remote retirement removes the model-proxy launcher/routes/installers/runtime-state override and their non-test callers. The old contract is no longer a supported behavior; retaining a test would keep a dead production seam or fail against intentionally removed behavior. No replacement is needed. Migration/security behavior for old persisted records is covered by the new model-proxy-retirement, legacy account refresh and conversation exclusion cases. Risk is limited to accidentally restoring retired owners during conflict resolution; verify absence of their imports/callers and run daemon/repository gates.

### `apps/daemon/src/cliproxy-config.test.ts`

- **DELETE** `state: defaults on garbage, valid passes through` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `secrets: corrupt fails closed, never defaults` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `paths + model charset` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel: curated gpt model resolves window + pct` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel: acc-prefixed model resolves like its bare id` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel: bare claude ids get the arming value only (native window detection)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel: claude ids NEVER get maxContextTokens (refused when family-classified)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel: claude compactWindow/pct overrides pass through (bare-id keyed)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel: overrides beat curated defaults, per field` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel: a router-shaped id with no configured provider resolves to nothing` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel: uncurated non-claude id with no override emits nothing` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel: an override alone makes an uncurated id resolvable` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `cliProxyState: modelOverrides roundtrip and absent-field default` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `CURATED_PROXY_MODEL_IDS is the OAuth picker order sol, terra, luna (no router models)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `PUT /api/cliproxy/providers/:id validates the provider id charset and body before the manager` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `router mutations map manager errors to 400/404 and restart refusals to 409` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `router key routes require a key and pass force through (body for POST, query for DELETE)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `catalog route maps unknown → 404, no-key → 409, upstream → 502, and is 403 over the socket` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `every router mutation is refused (403) over the unix socket, and the legacy openrouter/key route is gone` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `POST /api/cliproxy/xai/link returns the device prompt, maps conflict → 409 and upstream → 502` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `DELETE /api/cliproxy/xai/link passes force through and maps the live-session refusal to 409` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/cliproxy-files.test.ts`

- **DELETE** `config.yaml render: no router block without a key; block + alias with a key; bodies logging off` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `renderConfigYaml emits one openai-compatibility entry per keyed provider with models` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `routerKimiAvailable tracks a keyed provider serving kimi-k3 by name or alias` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `projections: token==apiKey; claudex.env contains ANTHROPIC_MODEL + CLAUDE_CONFIG_DIR; claudemix.env has haiku=backgroundModel and NO ANTHROPIC_MODEL` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `claudex.env Fable slot follows kimi-k3 availability across providers` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `writeProjections rejects a poisoned router model name or alias` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `wrapper: generated script has no 'source', reads token file path, claudex handles --model` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `model charset: writeProjections rejects defaultModel 'x; rm -rf'` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: 0700, marker, .claude.json identity stripped, projects/ absent, skills symlinked` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: HOME-level system .claude.json (sibling of ~/.claude) seeds the onboarding flag` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: no system .claude.json anywhere still writes hasCompletedOnboarding` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: scrubs model-routing env keys from a copied settings.json, keeps the rest` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: seeds managed model-pinned subagents; kimi rides the router availability flag` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: seeds the managed delegation CLAUDE.md into claudemix only, kimi line riding the key` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: forces autoCompactEnabled:true into an existing settings.json, preserving other keys` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: creates settings.json with managed keys when the system has none` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: settings merge is idempotent and survives a malformed file` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: the managed grok subagent rides the xai link gate, independent of kimi` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedHome: the delegation CLAUDE.md names grok only while the xai account is linked` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/cliproxy-install.test.ts`

- **DELETE** `installBinary verifies sha256, installs 0755, keeps prior in bin.prev` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `installBinary rejects a sha256 mismatch and does not install` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `installBinary extracts a nested cli-proxy-api entry` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `installBinary rejects an ambiguous tarball with multiple cli-proxy-api entries` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `installBinary rejects a tarball missing the cli-proxy-api binary` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `installBinary with patches builds from source: git apply then go build, promoted with rollback` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `installBinary with patches: source sha mismatch rejects before any toolchain call` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `listPatches: sorted .patch files only, empty for missing dir` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/cliproxy-manager.test.ts`

- **DELETE** `boot: port answers + our key accepted → persistence-lost (not foreign)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `persistence-lost proxy is re-parented under tmux once sessions drain AND the port frees, not just relabeled` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `boot: port answers + key rejected → error 'port conflict', no kill/adopt` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `corrupt secrets.json → state error, secrets file untouched, no config rewrite` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `crash supervision: 3 failed respawns → error latch + single notification event` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `enable: a throwing install does not persist enabled:true (generic catch path)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `enable: a proxy that never probes healthy does not persist enabled:true (proxy-down path)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `enable: a slow-binding proxy that answers on a later probe attempt becomes healthy (startup race)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `enable: a proxy that never probes healthy is reaped — no orphan left holding the port` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `disable without force + 2 live sessions → {ok:false, affectedSessions:2}; with force → kills service session` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `disable: an externally-adopted proxy can't be killed → off with a port warning, launchers disabled` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `validateModel: request model wins over default; unknown model fails naming provider; probe hang → bounded failure ≤2s` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `validateModel: claudemix with no request model resolves claudeDefaultModel, NOT defaultModel` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `preflightModels: partitions referenced models into ok/missing against a fresh catalog` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `healthy → registry claudex/claudemix enabled; probe loss → disabled with 'proxy down'` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `enable installs, projects config+token+env, seeds both homes, spawns, enables launchers` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `corrupt secrets.json → enable latches error, installs nothing, writes no config` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `enable: a throwing install latches error (never wedged in 'starting') and stays retriable` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `bootAdopt: a throw during (re)probe latches error, never stuck in 'starting'` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedProvider writes a prefixed auth file 0600, records the account, marks the provider ok` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedProvider refuses a stale token with 'expired' and writes no auth file (no dual-refresh)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `status per-provider state gates launchers: codex seeded → claudex on, claude absent → claudemix off` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `unseedProvider removes the auth file, drops the account, degrades the provider, broadcasts` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `unseedProvider is idempotent on an unknown id` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `status().routerProviders reports keyState none/set/verified from routerKeys + keyVerifiedAt` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `init(): a legacy openRouterKey migrates into an openrouter router provider, mirror kept` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `probe unions every keyed provider's model names AND aliases into the catalog` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `claudex coupling: a keyed router provider satisfies the codex-or-router gate` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `claudex coupling: a KEYLESS router provider + a claude account → disabled 'no codex, router or Grok credential'` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `upsertRouterProvider: validates the record, restart-gates a KEYED change, and persists` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `upsertRouterProvider: a KEYLESS provider is not restart-gated (it never reaches config.yaml)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `setRouterKey: rejected refuses, unknown stores unverified, ok stamps keyVerifiedAt + legacy mirror` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `setRouterKey: restart-gated while dependent sessions are live` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `clearRouterKey: keeps the provider row, drops the key, and un-satisfies the claudex gate` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `deleteRouterProvider: removes provider + key and resets a model pick that pointed at it` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `fetchRouterCatalog: unknown id, missing key, adapter success and upstream failure` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `credential sync: a proxy-refreshed token is written back into the managed home (repairs a wiped login)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `credential sync: a session-refreshed managed token is written back into the proxy auth file` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seeded accounts persist: a manager over a state file with a seeded codex account reports codex ok + enables claudex, no re-seed` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `boot: a persisted seeded account with a STALE on-disk auth file degrades to 'expired' and disables its launcher; a fresh file stays ok/enabled` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `poll: a seeded credential that expires at runtime degrades to 'expired', disables its launcher, and broadcasts cliproxy.changed` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `enable: a freshly-installed binary that never probes healthy rolls back to bin.prev and respawns` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `reparent: an external survivor still answering on drain stays persistence-lost — no spawn, no error latch` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `setConfig: modelOverrides persist without a restart and surface on status` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `cliproxy mutations: 403 on local mode, reach the handler on remote mode` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `GET /api/cliproxy returns the CliProxyStatus shape incl. reasons[]` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seed route (remote): reads the managed credential, seeds, marks proxy-owned, returns status` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seed route refuses (409) when the proxy is not running; no seed, no ownership flip` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seed route returns 404 (not 500) for a charset-valid accountId with no on-disk credential` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seed route is refused over the unix socket (403); no seed, no ownership flip` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `unseed route (remote): calls unseedProvider, marks proxy-owned false, returns status` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `unseed route is refused over the unix socket (403); no unseed, no ownership flip` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `router key route stores the key, re-projects config.yaml, and is restart-gated` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `router key route is refused over the unix socket (403)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `PUT /api/cliproxy/config: success resolves the full CliProxyStatus (not the {ok} gate result); restart-gated → 409` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `PUT /api/cliproxy/config is refused over the unix socket (403); the manager is never consulted` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `cliproxyContributor: a real account prefixes the effective model; System/undefined does not` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `cliproxyContributor: a router-provider model is emitted bare even with an account; other models are prefixed` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `composeExtraEnv: cliproxy env wins on collision, accountId preserved, unsets concatenated` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `session model gate: model on refId 'claude' → 400; 'claudex' passes through validateModel` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedProvider: a managed-account label wins over converted email/UUID (claude has no email)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `seedProvider: second claude account seeds ALONGSIDE the first (multi-account routing)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `xai status: derived from the auth dir — none, linked (email/expiry), corrupt files ignored` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `xai status: every auth file past its stamp reads expired, even with the proxy off` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `claudex coupling: a linked Grok account alone satisfies the gate` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `probe union: grok ids validate while linked (no catalog dependency)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `linkXai: works with the proxy OFF and imports a managed account (no seeding)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `linkXai: a start failure surfaces as an upstream result carrying the status` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `linkXai: duplicate attempt while in flight is a conflict; cancel is local-only` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `linkXai: a failed verdict lands on xai.lastLinkError and a fresh attempt clears it` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `cancelOrUnlinkXai: live Grok sessions refuse the unlink; force deletes the auth files` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `boot adoption: an orphan xai auth file becomes a managed + seeded grok account` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `boot adoption: a failed import leaves the auth file untouched (still linked)` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/cliproxy-secrets.test.ts`

- **DELETE** `secrets: creates 0600 with generated values; second load returns identical` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `secrets: corrupt file → {state:'corrupt'}, file untouched (mtime + content unchanged)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `secrets: a router-key write preserves the rest of the file, at 0600` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `setRouterKey stores under routerKeys and mirrors openrouter into the legacy field` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `clearRouterKey removes the key and clears the openrouter mirror` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/cliproxy-seed.test.ts`

- **DELETE** `jwtClaims decodes the payload segment and tolerates malformed input` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `codex conversion maps fields from tokens + id_token claim` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `claude conversion maps from claudeAiOauth and stamps a routing prefix` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `two accounts of one provider get distinct prefixes → individually routable` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `invalid shapes throw, not silently produce garbage` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `accessTokenFreshMs measures against the injected clock, not wall time` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `grok conversion maps the auth.x.ai entry into an xai storage, no prefix` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `grok conversion throws without a usable token pair` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `grok reverse conversion produces a CLI-shaped auth.json (adoption)` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/cliproxy-xai.test.ts`

- **DELETE** `scanXaiAuthFiles: reads xai-*.json only, tolerating corrupt and foreign files` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `scanXaiAuthFiles: a missing auth dir is 'nothing linked', never a throw` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `deriveXaiAccount: none / linked / expired, latest expiry wins the displayed identity` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `removeXaiAuthFiles: deletes every xai-*.json and nothing else` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `scanXaiQuotaError: picks the most recent usage-exhausted line from the newest log` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/registry-runtime-state.test.ts`

- **DELETE** `setRuntimeState disables with reason and broadcasts sanitized entry` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `reresolve re-reads env file but cannot resurrect a runtime-disabled entry` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `setRuntimeState enable overrides enabledAtRest:false on a resolved entry` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `the real claudex def stays disabled at rest (enabledAtRest:false) with no runtime override` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/router-providers.test.ts`

- **DELETE** `routerProviderSchema rejects bad ids, bad urls, bad model names` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `validateRouterProviders rejects reserved/duplicate ids and cross-provider model collisions` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `resolveRouterModel matches name, alias, and acc-prefixed forms` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel resolves router models by name or alias, overrides win` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `state/secrets schemas default the new fields; old files still parse` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `migrateLegacyOpenRouter seeds the openrouter provider and mirrors the key` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `ROUTER_PRESETS ship openrouter and tokenrouter with prefilled models` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `validateRouterProviders refuses a router model that shadows a curated model id` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel emits a router model's compact window even without a context window` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `migrateLegacyOpenRouter skips the seeded record when it would collide with a user provider` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `routerKeyCheckUrl only uses openrouter.ai when the baseUrl really points there` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `getRouterKey never walks the prototype chain and rejects non-string values` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `migrateLegacyOpenRouter refuses to attach the legacy key to a foreign-host 'openrouter' provider` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/session-model.test.ts`

- **DELETE** `resolver receives ctx with model; summary carries it` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `model omitted → ctx.model undefined (route-level default resolution is upstream)` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `effective model persists on the reattach record` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/xai-models.test.ts`

- **DELETE** `XAI_OAUTH_MODELS is the curated Grok pair with the 200k compaction cliff` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `resolveXaiModel matches bare and acc-prefixed ids only` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel resolves xai models from XAI_OAUTH_MODELS` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel lets modelOverrides win over the xai defaults` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `compactEnvForModel keeps the router branch ahead of the xai branch` — retired product owner; no remaining production caller/contract, as above.
- **DELETE** `validateRouterProviders rejects router models shadowing an xai model id` — retired product owner; no remaining production caller/contract, as above.
### `apps/daemon/src/session-launch-env.test.ts` retired contributor cases

- **DELETE** `cliproxyContributor pins the account and prefixes the model for a real account` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor records no account for the System pick (round-robin)` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor records no account for a router model (by alias)` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: a router model launches BARE with the provider's compact env` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: routing is data-driven, not name-shaped (zai/glm-5 via alias)` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: a non-router model still carries the acc prefix when ambiguous` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor pins the account for claudemix` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: the sole seeded account of a provider launches BARE (no acc prefix leak)` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: a second seeded account of the same provider forces the prefix` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor returns null for a non-proxy entry` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: gpt launch emits window + compact window + pct` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: a router model's own metadata drives the window, with no pct` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: a configured router model emits its 1M window, 450k compact, no pct` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: a PREFIXED claudemix launch rides the [1m] suffix (stripped client-side)` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: a 200k-class contextWindow override suppresses the [1m] suffix` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: a BARE claudemix launch (sole seeded claude account) stays arming-only` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: claudemix modelless launch still gets the arming window` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: claudex modelless launch resolves the configured defaultModel` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: state modelOverrides beat curated defaults at launch` — retired launch-model/proxy owner; no remaining production caller/contract.
- **DELETE** `cliproxyContributor: an xAI OAuth model launches BARE with its curated compact env` — retired launch-model/proxy owner; no remaining production caller/contract.

## Validation plan

After merge: run focused daemon Node test hooks for agent-accounts, agent-conversations, agent-family, agent-timeout-env, session-launch-env, system-status, tmux-service-session and usage-tokens; execute usage-sources.check.ts with the same import hooks. Inspect final diff and git diff --check. Root runs final pnpm check/test/build and commits/pushes.

Implementation complete; focused results appear below.

## Superseded baseline names in partially retained files

These decisions override earlier reports where the remote changes the supported behavior rather than simply renaming a case.

- **DELETE** `apps/daemon/src/agent-accounts.test.ts` — `a proxy-owned account is never refreshed by the account service (single-refresher rule)`: the proxy no longer exists to refresh credentials. Its former ownership rule is retired; the incoming legacy-record refresh regression above protects the migration and is verified against persisted credential bytes.
- **DELETE** `apps/daemon/src/agent-family.test.ts` — `agentFamily maps the claudex/claudemix ids onto the claude family`: removed launcher mapping plus declaration inventory; real hook/timeout owners above protect supported dispatch.
- **DELETE** `apps/daemon/src/agent-family.test.ts` — `claudex/claudemix map to claude family for BOTH target and installer dispatch`: the aliases are retired; native Claude installation already has stronger real config tests in agent-hooks.test.ts.
- **DELETE** `apps/daemon/src/agent-family.test.ts` — `claudemix installs claude-family hooks at its CLAUDE_CONFIG_DIR`: installation under a retired launcher is no longer supported. The incoming no-side-effect regression asserts the new requirement for both retired IDs.
- **DELETE** `apps/daemon/src/agent-timeout-env.test.ts` — `a claude-family launch carries the timeout env, and cliproxy still wins collisions`: proxy collision precedence no longer exists. The native managed-Claude composition case above retains the still-supported timeout/account identity contract.
- **KEEP** `apps/daemon/src/agent-timeout-env.test.ts` — `plain claude (no cliproxy contribution) still carries the timeout env`: renamed to `plain claude (no managed account) still carries the timeout env`; the independent CLI config contract, literal expectation, public composition seam, refactor tolerance and unique null-contributor failure are justified above.
- **DELETE** `apps/daemon/src/usage-tokens.test.ts` — `proxy-home transcripts are tagged with the launcher id, not folded into the claude aggregate`: the launcher-specific proxy scan/label is retired. The incoming real managed-home aggregation regression protects the supported account/system scan.

## Completed implementation and verification

The working tree now resolves all assigned remote conflicts. Retired proxy owners and their tests remain deleted; the removed chat-client export inventory, timeout helper duplicates, tmux prefix declaration and private composeExtraEnv export stay deleted. Existing real shell child-process regressions survive. The account migration regression observes refreshed credential-file bytes, Grok usage checks use native fetch mocking and actual managed credential files, and the protected-process regression waits on child readiness/exit instead of fixed delays.

- Focused Node daemon command with existing tsx/assert-ok/quiet-mock-timers hooks across `agent-accounts.test.ts`, `agent-conversations.test.ts`, `agent-family.test.ts`, `agent-timeout-env.test.ts`, `session-launch-env.test.ts`, `system-status.test.ts`, `tmux-service-session.test.ts`, `usage-tokens.test.ts`: **77 passed, 0 failed**. Log: `/tmp/orquester-test-cleanup/remote-runtime-focused.log`.
- `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs src/usage-sources.check.ts`: **passed**. Log: `/tmp/orquester-test-cleanup/remote-runtime-usage-check.log`.
- Final source/test diff and automatic index.ts merge reviewed; retired runtime wiring removed, native account/timeout composition retained, no test-only timing/fetch seam restored. `git diff --check`: **passed**.
- Root owns staging, merge commit and final repository check/test/build gates.
