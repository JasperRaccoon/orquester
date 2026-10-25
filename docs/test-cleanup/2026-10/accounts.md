# Accounts, authentication, providers, repo identities and usage audit

Audited all 41 assigned baseline files: 329 named node:test declarations and 29 standalone check scenarios (358 total). Dispositions: CONSOLIDATE: 13, KEEP: 321, OPTIMIZE: 14, REWRITE: 10. Consolidation counts include both retired declarations and their explicitly identified surviving owners. Six declarations are consolidated away; surviving named declarations: 323.

Every row below was reviewed against its production owner. The family evidence applies to every surviving row; the row supplies its concrete recognizable failure and any changed/surviving owner. Retained expensive coverage includes native account-file merge races, adversarial bounded HTML/SVG parsing, authenticated streams and actual local HTTP favicon security. These contracts are intentionally retained. No meaningful remote-provider test reaches a live provider.

## Six-part retention evidence

### git

1. Independent contract source: README Git hosting identities and secrets-stay-home; GitProvider/CloneOptions/GitRemoteError wire contracts in providers/types.ts; git ls-remote/clone native output and credential-file format.
2. Real regression: each row names its user/caller-visible failure, rather than executed lines or private method shape.
3. Independent oracle and unique lowest owner: Fixed native stdout/SSH failures, literal object/error fields, checked filesystem bytes and expected credential routing. Provider parser tests do not cover account-specific identity/CA/cleanup; service tests do not enumerate provider-native formats.
4. Stable seam and non-test callers: AccountsService public clone/list/lsRemote results, actual temporary checkout paths and git subprocess argv/environment, or config parse/serialize API. AccountsService is called by daemon project/account routes and workflow remote-git operations.
5. Refactor resistance: assert public results, persisted/native bytes, error kinds, external traffic or deterministic lifetime signals; identifier/layout/private collaborator changes alone need not change the expectations. Explicit copy/private-shape failures found during this audit are rewritten below.
6. Unique protection: every row identifies a distinct protocol input, security/storage lifecycle, request boundary or billing state; the family distinctions above explain why neighboring layers do not supersede it. Retired duplicates explicitly point to their remaining owner.
Risk: deleting the surviving checks would remove the named contract protection. Changes below remove repeated setup/data permutations while retaining the public assertions. Validation: assigned node:test files and the three usage check scripts, through the repository preload hooks; root schedules runs.

### identity

1. Independent contract source: README managed accounts and Agent config; AGENTS owned-home, single-use-token and secret-privacy rules; native Claude/Codex/Grok credential files; docs/superpowers/specs/2026-09-28-agent-profile-design.md §5.
2. Real regression: each row names its user/caller-visible failure, rather than executed lines or private method shape.
3. Independent oracle and unique lowest owner: Literal native credentials, public account metadata, env keys, file contents/modes and independently advanced expiry times. Codec cases own format-specific inputs; service cases own file/environment/lifecycle wiring; merges distinguish different-file, same-file and concurrent user-data loss.
4. Stable seam and non-test callers: Credential codecs and ownership guard used by agent-accounts.ts/usage-sources.ts, and AgentAccountsService public import/remove/resolve/refresh API with real owned homes. Daemon routes, session launch and usage refresh consume these results.
5. Refactor resistance: assert public results, persisted/native bytes, error kinds, external traffic or deterministic lifetime signals; identifier/layout/private collaborator changes alone need not change the expectations. Explicit copy/private-shape failures found during this audit are rewritten below.
6. Unique protection: every row identifies a distinct protocol input, security/storage lifecycle, request boundary or billing state; the family distinctions above explain why neighboring layers do not supersede it. Retired duplicates explicitly point to their remaining owner.
Risk: deleting the surviving checks would remove the named contract protection. Changes below remove repeated setup/data permutations while retaining the public assertions. Validation: assigned node:test files and the three usage check scripts, through the repository preload hooks; root schedules runs.

### auth

1. Independent contract source: README Security model: digest-only revocable tokens, 30 idle days, per-device revocation, API token lifetime, password-bound devices and no credential logs; packages/api auth route/session contracts.
2. Real regression: each row names its user/caller-visible failure, rather than executed lines or private method shape.
3. Independent oracle and unique lowest owner: Literal error/status kinds, independent fake clock progression, actual durable JSON/modes and real HTTP/websocket closure/subscription signals. Store tests own restart/tolerant storage/expiry; transport tests own authentication wiring and revocation of distinct streaming technologies.
4. Stable seam and non-test callers: AuthSessionStore mint/verify/list/revoke/load/flush API and authenticated HTTP/websocket/stream routes through createServer. Production index.ts auth hooks, websocket handlers, event streams and auth/routes.ts consume the store.
5. Refactor resistance: assert public results, persisted/native bytes, error kinds, external traffic or deterministic lifetime signals; identifier/layout/private collaborator changes alone need not change the expectations. Explicit copy/private-shape failures found during this audit are rewritten below.
6. Unique protection: every row identifies a distinct protocol input, security/storage lifecycle, request boundary or billing state; the family distinctions above explain why neighboring layers do not supersede it. Retired duplicates explicitly point to their remaining owner.
Risk: deleting the surviving checks would remove the named contract protection. Changes below remove repeated setup/data permutations while retaining the public assertions. Validation: assigned node:test files and the three usage check scripts, through the repository preload hooks; root schedules runs.

### oauth

1. Independent contract source: README managed Claude/Codex/Grok account linking; RFC 7636 PKCE, RFC 8628 device grants, CLI native credential and provider authorization endpoints; AgentAccount/DeviceLink/ClaudeOAuthLink API contracts.
2. Real regression: each row names its user/caller-visible failure, rather than executed lines or private method shape.
3. Independent oracle and unique lowest owner: Literal authorization fields, independently hashed PKCE verifier relationship, virtual expiry/poll time, known provider payloads and actual persisted token bytes. Link services own pending/conflict/import lifecycle; converters own optional identity/native expiry shapes that lifecycle tests do not enumerate.
4. Stable seam and non-test callers: Public start/status/submit/cancel link APIs, HTTP request fields and real AgentAccountsService persistence; daemon account-link routes consume these services, which use the native credential converters.
5. Refactor resistance: assert public results, persisted/native bytes, error kinds, external traffic or deterministic lifetime signals; identifier/layout/private collaborator changes alone need not change the expectations. Explicit copy/private-shape failures found during this audit are rewritten below.
6. Unique protection: every row identifies a distinct protocol input, security/storage lifecycle, request boundary or billing state; the family distinctions above explain why neighboring layers do not supersede it. Retired duplicates explicitly point to their remaining owner.
Risk: deleting the surviving checks would remove the named contract protection. Changes below remove repeated setup/data permutations while retaining the public assertions. Validation: assigned node:test files and the three usage check scripts, through the repository preload hooks; root schedules runs.

### provider

1. Independent contract source: GitProvider/conditional-page/error contracts in providers/types.ts; recorded native REST fixtures under providers/fixtures; git credential-store and native SSH greeting formats; README git identities.
2. Real regression: each row names its user/caller-visible failure, rather than executed lines or private method shape.
3. Independent oracle and unique lowest owner: Literal recorded payload results, expected headers/URLs/error kinds, deferred requests and controlled time. Provider tests own native protocol mapping/pagination/HTTP classification; gate/cache tests own queue/expiry/isolation schedules absent from provider integration samples.
4. Stable seam and non-test callers: Production GitProvider methods consumed by AccountsService, or the HostRateGate/TtlCache get/run/invalidate/paused APIs used by provider HTTP methods. Network boundaries are stubbed, and outputs/errors/credential routing are observed.
5. Refactor resistance: assert public results, persisted/native bytes, error kinds, external traffic or deterministic lifetime signals; identifier/layout/private collaborator changes alone need not change the expectations. Explicit copy/private-shape failures found during this audit are rewritten below.
6. Unique protection: every row identifies a distinct protocol input, security/storage lifecycle, request boundary or billing state; the family distinctions above explain why neighboring layers do not supersede it. Retired duplicates explicitly point to their remaining owner.
Risk: deleting the surviving checks would remove the named contract protection. Changes below remove repeated setup/data permutations while retaining the public assertions. Validation: assigned node:test files and the three usage check scripts, through the repository preload hooks; root schedules runs.

### registry

1. Independent contract source: README registry and per-launcher configuration/host-secret guarantees; native dotenv grammar and launcher environment keys.
2. Real regression: each row names its user/caller-visible failure, rather than executed lines or private method shape.
3. Independent oracle and unique lowest owner: Literal parsed environment and exposed/internal data; parser owns grammar while service owns native file discovery, default-plus-override composition and privacy. No real installed agent is run.
4. Stable seam and non-test callers: parseEnvFile and RegistryService get/list used by daemon registry routes and session launch; fixture bins are absolute and the file process has an empty PATH/HOME.
5. Refactor resistance: assert public results, persisted/native bytes, error kinds, external traffic or deterministic lifetime signals; identifier/layout/private collaborator changes alone need not change the expectations. Explicit copy/private-shape failures found during this audit are rewritten below.
6. Unique protection: every row identifies a distinct protocol input, security/storage lifecycle, request boundary or billing state; the family distinctions above explain why neighboring layers do not supersede it. Retired duplicates explicitly point to their remaining owner.
Risk: deleting the surviving checks would remove the named contract protection. Changes below remove repeated setup/data permutations while retaining the public assertions. Validation: assigned node:test files and the three usage check scripts, through the repository preload hooks; root schedules runs.

### repo

1. Independent contract source: packages/api/src/repo-identities.ts public CRUD, MIME/byte/label limits, refusal codes, version caching, source attribution and broadcast channels; docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md; AGENTS tolerant storage and secret/network boundaries.
2. Real regression: each row names its user/caller-visible failure, rather than executed lines or private method shape.
3. Independent oracle and unique lowest owner: Literal bytes/labels/error codes/security headers and recoverable persisted records; real local HTTP redirects/chunks and fake DNS exercise the actual guarded connection. Store owns persistence/validation; route tests retain transport-only statuses/uploads/auth/cache/concurrency; codecs own exact MIME/HTML/IP cases without repeating network setup.
4. Stable seam and non-test callers: RepoIdentitiesService public filesystem/API/event seam and registerRepoIdentityRoutes HTTP API used by index.ts on both transports; fetchFavicon and byte/HTML/SSRF codecs used by that service.
5. Refactor resistance: assert public results, persisted/native bytes, error kinds, external traffic or deterministic lifetime signals; identifier/layout/private collaborator changes alone need not change the expectations. Explicit copy/private-shape failures found during this audit are rewritten below.
6. Unique protection: every row identifies a distinct protocol input, security/storage lifecycle, request boundary or billing state; the family distinctions above explain why neighboring layers do not supersede it. Retired duplicates explicitly point to their remaining owner.
Risk: deleting the surviving checks would remove the named contract protection. Changes below remove repeated setup/data permutations while retaining the public assertions. Validation: assigned node:test files and the three usage check scripts, through the repository preload hooks; root schedules runs.

### cachettl

1. Independent contract source: Usage API/config cache-TTL preference/status contracts; recorded subagent request protocol and specified 5m/1h cache tariffs; weekly auto-decision, minimum observation and 14-day analysis documented by controller public API and comments.
2. Real regression: each row names its user/caller-visible failure, rather than executed lines or private method shape.
3. Independent oracle and unique lowest owner: Manually calculated token-unit costs, independent timestamps and literal outcomes; calculators own cost/order decisions, controller owns persistence/schedules/scanner readiness, route owns live preference/auth wiring. Duplicated setup/oracles are consolidated below.
4. Stable seam and non-test callers: estimateSubagentCacheCosts/decideSubagentCacheTtl typed calculation boundary and SubagentCacheTtlController resolve/status/init used by daemon launch and usage routes; the HTTP case reads real app config.
5. Refactor resistance: assert public results, persisted/native bytes, error kinds, external traffic or deterministic lifetime signals; identifier/layout/private collaborator changes alone need not change the expectations. Explicit copy/private-shape failures found during this audit are rewritten below.
6. Unique protection: every row identifies a distinct protocol input, security/storage lifecycle, request boundary or billing state; the family distinctions above explain why neighboring layers do not supersede it. Retired duplicates explicitly point to their remaining owner.
Risk: deleting the surviving checks would remove the named contract protection. Changes below remove repeated setup/data permutations while retaining the public assertions. Validation: assigned node:test files and the three usage check scripts, through the repository preload hooks; root schedules runs.

### usage

1. Independent contract source: README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.
2. Real regression: each row names its user/caller-visible failure, rather than executed lines or private method shape.
3. Independent oracle and unique lowest owner: Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.
4. Stable seam and non-test callers: Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.
5. Refactor resistance: assert public results, persisted/native bytes, error kinds, external traffic or deterministic lifetime signals; identifier/layout/private collaborator changes alone need not change the expectations. Explicit copy/private-shape failures found during this audit are rewritten below.
6. Unique protection: every row identifies a distinct protocol input, security/storage lifecycle, request boundary or billing state; the family distinctions above explain why neighboring layers do not supersede it. Retired duplicates explicitly point to their remaining owner.
Risk: deleting the surviving checks would remove the named contract protection. Changes below remove repeated setup/data permutations while retaining the public assertions. Validation: assigned node:test files and the three usage check scripts, through the repository preload hooks; root schedules runs.

## `apps/daemon/src/accounts-clone-url.test.ts`

Shared six-bar evidence: **git** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| prefers SSH when the account's key is installed on the provider | KEEP | A key-ready account selects unusable HTTPS instead of SSH. |
| falls back to HTTPS while a DC key upload is still pending | KEEP | A pending manual SSH key blocks project creation instead of using HTTPS. |
| uses whichever transport exists when only one is offered | KEEP | A single offered transport is rejected, or no transport silently invokes git. |
| a created repo whose SSH key is refused is cloned over its reported HTTPS URL | KEEP | An SSH-denied newly created repo must retry the HTTPS URL supplied by its provider; deriving another URL breaks DC context paths. |
| with no token, a refused key is retried over HTTPS only for a repo known to be public | KEEP | A tokenless private repository must fail closed after SSH refusal; only a known public repository may retry anonymously over HTTPS. |

## `apps/daemon/src/accounts-remote.test.ts`

Shared six-bar evidence: **git** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| lsRemote over SSH pins the account key, BatchMode, no prompt, 30 s, no shell | KEEP | Remote reads use ambient SSH identity, prompt indefinitely, expose tokens or misconfigure the git transport. |
| lsRemote over HTTPS uses the credential store and the DC CA bundle; defaultBranch:false narrows | KEEP | HTTPS reads ignore account credential store/custom CA or requested default-branch scope. |
| lsRemote on a Bitbucket account pins the daemon-owned known_hosts | KEEP | Bitbucket SSH reads lose daemon-owned host verification. |
| lsRemote anonymously resets every credential helper | KEEP | Anonymous HTTPS accidentally invokes an ambient credential helper. |
| lsRemote refuses an anonymous SSH read (it would offer this host's own keys) and points at https | KEEP | Anonymous SSH offers host keys. |
| lsRemote refuses unsafe URLs before running anything | KEEP | Untrusted URL invokes git option/file/remote-helper execution. |
| lsRemote classifies failures: auth, not found, timeout — and redacts userinfo | KEEP | Auth/not-found/timeouts are misclassified or credential userinfo leaks. |
| cloneRepo without options is the New Project dialog's clone: no ceiling, git's prompting untouched | KEEP | Interactive clones inherit unattended prompt/time restrictions or wrong account key. |
| an unattended clone (a workflow's) gets a prompt-free env and a 10 min ceiling | KEEP | Workflow clone hangs for input or has no timeout bound. |
| cloneRepo removes the clone when the sha cannot be checked out | KEEP | Failed SHA checkout leaves a half-made project directory. |
| cloneRepo: a missing branch name is a clone failure, a bad ref never runs, a timeout says so | KEEP | Invalid refs execute git, or missing refs/timeouts get wrong caller error. |
| isSshKeyRefusal tells an SSH-layer refusal from a repository's answer | KEEP | Distinct native publickey/host-key/too-many-auth failures must trigger transport fallback, while repository authorization and DNS failures must not. |
| a clone whose SSH key is refused is retried once over HTTPS through the credential store | KEEP | A refused SSH clone must remove its partial checkout before one credential-store HTTPS retry; neither arguments nor returned notices may expose the PAT. |
| a clone that went through over SSH says so | KEEP | Successful SSH cloning must report the selected transport without an unnecessary second clone. |
| no HTTPS retry for a failure that is not a key refusal, nor for an account with no token | KEEP | Repository-not-found errors and tokenless accounts must not cause an unauthorized HTTPS fallback. |
| when the HTTPS retry fails too, both failures are reported | KEEP | If both transports fail, the caller must receive both actionable failure reasons instead of a misleading SSH-only error. |
| listPullRequests resolves the account's provider and repo from any URL form | KEEP | Account-bound/anonymous listing resolves wrong forge, repo or authorization. |
| listPullRequests refuses a URL the account's provider cannot parse, and anonymous unknown hosts | KEEP | Cross-provider URL or unsupported anonymous host leaks a token/request. |
| an abbreviated commit no ref resolves fails clearly and removes the clone (never fetches a prefix) | KEEP | Unresolvable abbreviated hash is fetched as a prefix or leaves cloned files. |

## `apps/daemon/src/accounts-schema.test.ts`

Shared six-bar evidence: **git** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| legacy github account payload migrates (githubLogin→login, githubKeyId→remoteKeyId, provider default) | KEEP | Legacy GitHub identity or numeric key ID is lost during migration. |
| new-shape bitbucket-server account round-trips | KEEP | DC instance/SSH coordinates are lost in accepted stored records. |
| already-migrated payload is untouched (idempotent) | KEEP | Already-migrated account data is changed during reload. |
| serialize mirrors githubLogin/githubKeyId on github records for old-daemon compat | KEEP | Rollback cannot read persisted GitHub identity/key mirrors. |
| serialize does not mirror legacy fields onto bitbucket records | KEEP | Bitbucket records are mislabeled with legacy GitHub fields. |
| serialize→parse round-trips to the identical config | KEEP | Serializing then loading loses persisted account data. |
| serialize skips a non-numeric remoteKeyId (old schema required a number) | KEEP | Non-numeric remote key ID writes an invalid old-schema number. |

## `apps/daemon/src/agent-account-identity.test.ts`

Shared six-bar evidence: **identity** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| returns null for unknown shapes | KEEP | Unrecognized credentials are assigned a provider. |
| claude blob needs a non-empty access or refresh token | CONSOLIDATE | Fails uniqueness: account import cases already reject empty OAuth credentials, accept refresh-only credentials, and accept access-only credentials; login-status cases cover empty-token metadata. Its uniquely malformed/empty-object cases move to the public account-import refusal owner; positive token combinations are already covered by actual imports. Remove the duplicate helper execution. |
| Claude login expiry uses the refresh lifetime, not routine access-token rotation | KEEP | Login metadata must use refresh-token lifetime when renewal exists; routine expired access tokens must not falsely request reauthentication. |
| codex identity from id_token JWT and account_id | KEEP | Explicit Codex account identity is replaced by a conflicting JWT claim. |
| codex accountId falls back to JWT chatgpt_account_id | KEEP | JWT-only account IDs are lost, defeating usage identity comparison. |
| detects grok by the issuer::client keyed entry with a key | KEEP | Grok credentials are missed or tokenless entries accepted. |
| grok identity prefers the auth.x.ai entry and reads email/user_id | KEEP | Multi-issuer Grok files choose the wrong identity or leak missing fields. |

## `apps/daemon/src/agent-account-paths.test.ts`

Shared six-bar evidence: **identity** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| passes for a well-formed owned home | KEEP | Legitimate owned account homes are rejected. |
| rejects a missing marker | KEEP | Unmarked homes can be mutated or removed. |
| rejects a marker with the wrong id | KEEP | A mismatched ownership marker authorizes another home. |
| rejects a symlinked home that escapes the accounts dir | KEEP | A symlink redirects account writes/removal outside the owned root. |

## `apps/daemon/src/agent-account-refresh.test.ts`

Shared six-bar evidence: **identity** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| selects idle accounts with soon/unknown expiry, skips live and far-future | KEEP | Idle refresh selects active/far-future accounts or misses unknown expiry. |
| mergeClaudeRefreshedCreds preserves other fields | KEEP | Claude refresh discards scopes/subscription metadata. |
| mergeClaudeRefreshedCreds converts expires_in to an absolute expiresAt (ms) | KEEP | Seconds-to-milliseconds expiry conversion leaves a fresh token already expired. |
| refreshClaudeToken maps a 200 body | CONSOLIDATE | Claude token response drops usable rotated token fields. Surviving owner: success token decoding also asserts expires_in from the native OAuth payload; expiry conversion/preservation remains independently tested below. |
| refreshClaudeToken flags invalid_grant | KEEP | Claude invalid_grant does not request reauthentication. |
| refreshClaudeToken parses expires_in | CONSOLIDATE | Relative expiry is lost before credential persistence. Remove the second successful-token endpoint invocation; its expires_in assertion moves to the successful-body owner above. Failed bar 6: same operation/oracle. |
| refreshCodexToken flags invalid_grant | KEEP | Codex invalid_grant does not request reauthentication. |
| mergeCodexRefreshedTokens preserves account_id and overwrites tokens | KEEP | Codex refresh erases account identity or unrelated native auth fields. |

## `apps/daemon/src/agent-accounts-routes.test.ts`

Shared six-bar evidence: **identity** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| an account a live session runs under is not deleted, and the tab is named | KEEP | Deleting an account used by a live tab must return 409 without deleting its home; the error identifies the blocking tab, and idle accounts remain deletable. |
| the Claude sign-in code route answers the account, or the link's refusal as a status | KEEP | Claude sign-in code HTTP input must reject blank pastes before exchange and map success/invalid/idle/upstream outcomes to 200/400/409/502. |

## `apps/daemon/src/agent-accounts.test.ts`

Shared six-bar evidence: **identity** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| import a codex blob derives identity and writes a 0700 home + marker | KEEP | Imported Codex identity/native token persistence or private home ownership is wrong. |
| import claude requires a label and stores subscriptionType as plan | KEEP | Claude unlabeled import accepted or plan/refresh token lost. |
| import claude rejects a blob with empty OAuth tokens | CONSOLIDATE | A logged-out Claude keychain blob containing empty OAuth tokens must not create an unusable managed account. Surviving public import owner now also rejects empty OAuth objects and non-string token fields, preserving every meaningful refusal from the helper-only case without creating accounts. |
| import claude accepts a refresh-token-only blob | KEEP | A refresh-token-only Claude credential must remain importable so renewal can recover an expired access token. |
| resolveLaunchEnv selects Claude/Codex homes and unsets competing API credentials | KEEP | Managed Claude/Codex launches must choose their account homes and clear ambient API credentials that would select another billing identity. |
| resolveLaunchEnv falls back to the default account, then System(null) | CONSOLIDATE | Default account resolution or unmanaged System fallback is wrong. Remove this duplicate account fixture; effective-account/default launch now asserts its resolved home, and the explicit-System case retains the unsupported-agent null result. Failed bar 6. |
| resolveLaunchEnv returns the EFFECTIVE account id (explicit and default) | CONSOLIDATE | Session binding misses effective default/explicit identity, allowing live token refresh. Surviving owner now verifies both the effective ID and matching default account home; wrong token-pinning or wrong-home routing fail independently. |
| resolveLaunchEnv honors the SYSTEM_ACCOUNT_ID sentinel over a default | CONSOLIDATE | Explicit System selection incorrectly inherits a managed default. Surviving owner includes the no-managed-account System fallback, alongside explicit System bypass of a configured default. |
| remove deletes the home and clears it from defaults | KEEP | Account removal leaves home or dangling default. |
| index and API responses carry no token material | KEEP | Credential token leaks into account index or API response. |
| ensureFreshForUsage refreshes an idle Codex account whose token is expiring | KEEP | Idle expiring Codex token is not refreshed/persisted with account identity. |
| an empty or missing refresh token is never posted: Claude, Codex and Grok accounts are unavailable to refresh | KEEP | No provider may post a missing/empty refresh token or mark a valid access-only account as needing reauthentication. |
| ensureFreshForUsage does not refresh an account with a live session | KEEP | Live CLI account has its single-use refresh token consumed by daemon. |
| account login metadata follows CLI credential changes, including live accounts | KEEP | CLI credential renewal/logout must update public login deadlines and reauthentication state, including live accounts; unchanged state must not rebroadcast or leak secrets. |
| ensureFreshForUsage skips a token that is not near expiry | KEEP | Far-future token is needlessly rotated. |
| an account the retired model proxy owned is refreshed by the account service again | KEEP | Legacy proxyOwned stored field prevents account service from refreshing. |
| resolveLaunchEnv seeds a Claude home: onboarding, mcps, stripped identity, symlinked skills/plugins | KEEP | New Claude home loses onboarding/MCP/profile resources or inherits another login. |
| Claude re-sync refreshes mcpServers but preserves the account's own identity | KEEP | Subsequent Claude launch overwrites account identity or retains obsolete MCPs. |
| resolveLaunchEnv seeds a Codex home: symlinked config.toml + migration markers | CONSOLIDATE | Codex launch loses shared config or onboarding migration markers. Remove duplicated Codex account/home setup; migration-marker assertions move into the existing config/hooks launch owner. Failed bar 6. |
| resolveLaunchEnv shares Claude settings.json (symlink, replaces a stale real file) | KEEP | Stale Claude account settings mask shared user hooks. |
| resolveLaunchEnv shares Codex config.toml + hooks.json (replaces stale real files) | CONSOLIDATE | Stale Codex account config/hooks mask shared configuration. Surviving owner verifies live config/hooks links, stale-file replacement and both native migration markers in one actual launch. |
| resolveLaunchEnv shares chat history: symlinks projects/ (Claude), merging a non-empty home in | CONSOLIDATE | Account Claude history is lost or system history unavailable. Remove a second history fixture. The recursive-history owner now also includes a noncolliding project and reads the system transcript through the account link. Failed bar 6. |
| resolveLaunchEnv symlinks an empty/absent Codex sessions/ to the shared store | KEEP | Codex accounts cannot resume shared session history. |
| shared history recursively merges a COLLIDING project dir, then symlinks | CONSOLIDATE | Colliding history directories lose one account’s sessions. Surviving owner independently preserves system bytes, colliding project transcript bytes and a disjoint project before exposing all history through the home link. |
| import a grok auth.json derives identity and resolves GROK_HOME at launch | KEEP | Grok import loses native identity or launches under ambient XAI_API_KEY. |
| a Grok refresh replaces auth.json by rename (as the CLI does), 0600, nothing left behind | KEEP | A Grok refresh must atomically replace its CLI auth file at 0600 while preserving identity and removing temporary files; in-place truncation risks torn credentials. |
| the refresher re-reads the live sessions before spending a refresh token (a chat that just started) | KEEP | A chat started after the caller took its account snapshot must prevent spending that account's single-use refresh token; releasing the account permits renewal. |
| Claude: CLAUDE.md is linked even before it exists (a dangling link reads as missing) and commands/ is created 0700 | KEEP | New instructions/commands fail to reach an already-launched managed account. |
| Claude: an account's own CLAUDE.md moves to the shared path when the owner has none | KEEP | Account-only instructions are discarded instead of adopted. |
| Claude: a differing CLAUDE.md keeps the owner's and saves the account's beside it; an identical one is dropped | KEEP | Conflicting instruction files lose data or identical files create spurious conflicts. |
| Claude: a real commands/ merges in — unique moved, identical dropped, a collision kept as <name>-<id8> | KEEP | Command merge loses unique/colliding content. |
| Claude: a symlink pointing elsewhere is replaced by the shared link | KEEP | Incorrect existing command link keeps account on wrong profile. |
| Codex: skills/ merges user skills, drops the account's bundled .system when the shared dir has one | KEEP | Bundled skills overwrite newer shared copies or user skills are lost. |
| Codex: AGENTS.md is shared — linked even before it exists, and an account's own copy moves across | KEEP | Codex global instructions fail to propagate. |
| Codex: the account's .system moves across when the shared skills/ has none; an absent shared dir is created | KEEP | Codex bundled skills vanish when shared copy absent. |
| Grok: AGENTS.md, commands/ and rules/ are shared; agents/ is not | KEEP | Grok instructions/commands/rules fail to share or unrelated agents leak. |
| nothing is linked into an agent home the daemon user does not have | KEEP | Launch creates an unwanted system agent home. |
| Claude: two accounts launched at once both keep their own command and CLAUDE.md (no move overwrites another) | KEEP | Concurrent account launches overwrite each other’s instructions/commands. |
| Claude: overlapping launches of one account never drop the owner's shared commands | OPTIMIZE | Overlapping same-account sync deletes owner’s shared commands. Keep every one of the original 40 event-loop offsets. Reuse immutable service/account setup within this test and reset both command directories before every schedule; no cross-test fixture sharing. |
| Claude: a shared CLAUDE.md that is itself a link (dotfiles) is compared by what it names | KEEP | Dotfiles symlink is destroyed or identical content falsely conflicts. |
| Claude: an account copy never replaces a dangling shared CLAUDE.md link | KEEP | Dangling owner instruction link is replaced, losing intended dotfiles path. |
| pruneOrphanHomes moves an orphan's history into the shared store and removes it | KEEP | History recreated by a deleted account must migrate to the shared store before the orphan home is removed; identical existing transcripts must survive. |
| pruneOrphanHomes keeps an orphan whose transcript differs from the shared copy | KEEP | An orphan whose transcript differs from the shared copy must remain recoverable instead of silently losing the longer conversation. |
| pruneOrphanHomes never touches a registered account, one in use, or a foreign dir | KEEP | Orphan cleanup must never delete a registered account, a live account, or an unrelated directory. |

## `apps/daemon/src/agent-status-grok.test.ts`

Shared six-bar evidence: **identity** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| grok Stop counts as done only for a completed turn | KEEP | Observe-only Grok teardown falsely reports a completed turn. |
| grok attention events map to waiting | KEEP | Permission/notification fails to request user attention. |
| grok progress events map to working | KEEP | Prompt/tool progress fails to show working. |
| unknown grok events are ignored | KEEP | Unsupported event erroneously changes session status. |

## `apps/daemon/src/auth/routes.test.ts`

Shared six-bar evidence: **auth** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| auth info discloses no salt; login mints a working token and the stored hash is no bearer | OPTIMIZE | Remote sign-in must issue a usable random bearer while auth metadata discloses no salt and bcrypt hashes/legacy hash-derived credentials cannot authenticate.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| a wrong password or username is refused, and repeated guesses lock the IP out | OPTIMIZE | Wrong usernames/passwords must share an auth refusal; every guess counts toward per-IP lockout, without locking a different IP.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| the download's ?token= and /mcp accept a session token and refuse the legacy credential | OPTIMIZE | Download query-token and MCP bearer exceptions must accept revocable device/API sessions and refuse the retired hash-derived credential.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| /ws accepts a session token, refuses the legacy credential, and closes when the session is revoked | OPTIMIZE | A websocket must reject legacy credentials and close with policy violation when its valid session is revoked.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| revoking a session ends its open event stream | OPTIMIZE | Revoking an authenticated events connection must terminate the response and release its broadcaster sink.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| revoking a session ends its terminal output stream | OPTIMIZE | Revoking an authenticated terminal stream must terminate its response and release the PTY subscription.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| a stream that opens after its session was revoked is cut as it opens | OPTIMIZE | Revocation during asynchronous scrollback capture must cut the stream at establishment; no subscription may survive the race.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| revoking a session ends its agent-chat event stream and the host subscription | OPTIMIZE | Revoking a chat-event stream must close the client response and abort the upstream agent-host subscription.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| a login whose password changed while it was checked mints nothing | OPTIMIZE | A password change between bcrypt verification and token creation must prevent minting a bearer bound to the retired password.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| logout, list, revoke one and revoke-others | OPTIMIZE | Session management HTTP routes must list only safe summaries, revoke exactly the chosen/other devices, and make logout immediately revoke the caller.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| the password retype check answers ok/false without failing the session | OPTIMIZE | Password retype verification must return a boolean for authenticated callers without revoking a session after a wrong retype; unauthenticated verification is refused.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| changing the password signs every device out and keeps API tokens | OPTIMIZE | Saving a new password must revoke all devices, retain API tokens, reject the old password and accept the new one; cryptographic work factor is not this lifecycle contract. Generate a real cost-4 bcrypt salt for this test only. The config route still hashes, persists and verifies real passwords; the unchanged lifecycle assertions detect missing hashing, wrong password handling or revocation bugs. Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |
| neither the password nor a token reaches the request log | OPTIMIZE | Request logs must contain the exercised download path while omitting plaintext passwords and bearer bytes, including URL query credentials.  Shared fixture now builds the local transport only when exercised, closes only built apps and removes its owned scratch directory; real auth/stream assertions remain. |

## `apps/daemon/src/auth/sessions.test.ts`

Shared six-bar evidence: **auth** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| a minted token verifies; the file holds only its digest, at 0600 | KEEP | Minted bearers must verify while only a 64-hex digest is persisted at 0600; plaintext token or random-part persistence is a credential disclosure. |
| verify refuses anything but a live token | KEEP | Missing, malformed, forged and legacy hash-derived bearers must never verify merely because their format resembles a token. |
| device sessions lapse after 30 idle days; each use slides the expiry; API tokens never lapse | KEEP | Device sessions must expire after 30 idle days and each authenticated use must slide that window; API tokens remain live until revocation. |
| a peek (touch=false) neither stamps the use nor slides the expiry | KEEP | Non-touching token checks must not update lastUsedAt or prolong device-session lifetime. |
| lastUsedAt reaches the disk at most every few minutes per session | KEEP | Frequent authenticated uses must update in-memory activity without a disk write per request; after the documented interval activity must be durable. |
| revoke one, revoke all but the current, and listeners hear each revocation | KEEP | Revoking one/other sessions must invalidate their tokens and notify listeners exactly for removed sessions, preserving the current session. |
| a password change revokes every device session, keeps API tokens, and is noticed across a restart | KEEP | Password-hash rotation discovered after restart must durably revoke devices while preserving API tokens and never storing the bcrypt hash itself. |
| the file keeps unknown fields and records it cannot read, and never honours the latter | KEEP | Session rewrites must preserve unknown fields/newer records but never authorize an unreadable record, even with a copied valid digest. |
| a corrupt file is moved aside and nobody is signed in; an unreadable one refuses sign-in | KEEP | Corrupt session storage must quarantine recoverable bytes and sign everyone out; unreadable storage must refuse token issuance. |
| device labels come from the user agent | KEEP | Device identification must preserve browser/platform meaning for mobile, Electron, Firefox and unrecognized clients, so the user can revoke the intended device. |
| a login bound to a hash the sessions are no longer bound to mints nothing | KEEP | Creating a device session after the store has rebound to another password hash must fail with StalePasswordError and mint no token. |

## `apps/daemon/src/claude-oauth-link.test.ts`

Shared six-bar evidence: **oauth** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| start hands out the CLI's Claude.ai authorize URL with a PKCE challenge | KEEP | Claude authorization must use the CLI client/redirect/scope and S256 PKCE fields; simultaneous starts conflict and the link has a bounded lifetime. |
| a pasted code#state becomes a labelled Claude account with the CLI's credentials file | KEEP | A valid code/state pair must send a verifier matching the public challenge and persist a CLI-native credential with independently specified token/identity/expiry fields. |
| a failed profile lookup leaves the plan unknown but still links | KEEP | An unavailable optional profile endpoint must not discard a successful Claude login; the account remains linked with unknown plan. |
| malformed, foreign, and rejected codes are refused and keep the sign-in pending | KEEP | Malformed or foreign-state codes must not reach the token endpoint; rejected codes must create no account and leave retryable sign-in pending. |
| submitting with nothing pending is refused; an unused sign-in expires | KEEP | Submitting without a pending sign-in must return idle; an unused sign-in must expire deterministically after its published lifetime. |
| the pasted code may be the callback URL itself | KEEP | Pasting the callback URL must parse its code/state pair; incomplete callback or empty-code inputs must be refused. |

## `apps/daemon/src/device-link.test.ts`

Shared six-bar evidence: **oauth** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| a granted link imports the tokens as a managed grok account | KEEP | A successful Grok device grant must persist the granted token pair in its managed CLI auth home and leave the link idle. |
| a start failure is an upstream result carrying the status, and leaves nothing pending | KEEP | Device authorization startup failures must preserve the upstream status and leave no pending authorization. |
| a second start while one is pending is a conflict; cancel drops it locally | KEEP | Starting twice must preserve the first code and report conflict; cancellation must be idempotent and prevent any later token poll/import. |
| a failed verdict lands on lastError and a fresh attempt clears it | KEEP | A denied device grant must become visible lastError and starting a fresh attempt must clear that obsolete error. |
| a failed import is reported as the link's error | REWRITE | A granted device token whose native account cannot be persisted must report import failure and leave no phantom account. A truthy lastError could pass for an unrelated token/exchange failure; the oracle now requires the filesystem ENOTDIR/EEXIST refusal from obstructed native account persistence. |
| a Codex link polls past pending, exchanges the code, and imports a codex auth.json | KEEP | Codex device sign-in must continue after pending 403, exchange the authorization code using the verifier, and persist ChatGPT-native account credentials. |
| a Codex link whose code exchange fails ends with that error and imports nothing | KEEP | A failed Codex code exchange must report the upstream error and create no account. |
| a Codex poll error other than pending is the link's verdict | KEEP | A non-pending Codex device-poll failure must terminate with an authorization error instead of polling forever. |

## `apps/daemon/src/grok-device-auth.test.ts`

Shared six-bar evidence: **oauth** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| device tokens become a CLI-shaped auth.json with identity from the id_token | KEEP | Granted OAuth tokens have unusable native auth key/expiry/identity format. |
| identity is optional: no id_token still yields an importable credential | KEEP | A valid grant without identity fields cannot be imported. |

## `apps/daemon/src/providers/bitbucket-cloud.test.ts`

Shared six-bar evidence: **provider** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| parseRepoUrl accepts bitbucket.org https/ssh (old + new host)/shorthand | KEEP | Supported repository URL loses owner/repo or cross-forge URL is accepted. |
| parseRepoUrl accepts the https form with the embedded username the Clone dialog copies | KEEP | Clone-dialog userinfo breaks URL parsing or smuggles an evil host. |
| cloneUrls always emits the NEW ssh host | KEEP | Clone URL uses retired SSH hostname. |
| toCloudRepoSummary rewrites the API's (possibly stale) ssh host and maps fields | KEEP | Repo listing retains stale SSH host/embedded userinfo or loses public repo fields. |
| credentialSpec uses the static token username; sshProbe parses the Cloud greeting | KEEP | Git auth username/SSH target/greeting parser is incompatible with Cloud. |
| SSH key uploads distinguish duplicate keys from authentication and upstream errors | KEEP | Bitbucket Cloud SSH key duplication is recoverable 409, while bad auth/upstream failures must retain distinct GitRemoteError kinds/statuses. |
| pagination follows a next link only on the API's own origin; credentials never go elsewhere (S-M4) | KEEP | Untrusted next-page URLs must never receive provider credentials; origin, scheme, userinfo and API-root lookalikes are all refused before fetching. |
| pagination on the API's own origin is followed | KEEP | Allowed same-origin API pagination must actually read the next page, so the SSRF guard cannot disable legitimate repo discovery. |

## `apps/daemon/src/providers/bitbucket-server.test.ts`

Shared six-bar evidence: **provider** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| parseRepoUrl accepts scm/ssh/browse/personal/shorthand forms anchored to the account | KEEP | DC URL grammar loses context/personal project or accepts other host. |
| parseRepoUrl accepts the https form with the embedded username the Clone dialog copies | KEEP | Clone-dialog userinfo breaks DC parsing or bypasses instance anchoring. |
| pickCloneUrls tolerates name:'http' meaning https and missing ssh | KEEP | Native http clone label or one-transport instance becomes uncloneable. |
| an SSH-only instance (HTTP(S) SCM disabled) still yields clone URLs and repo rows | KEEP | SSH-only repository omitted or uncloneable record breaks picker. |
| ssh:// URLs parse against the baseUrl host when sshHost was never resolved | KEEP | Fresh account without known sshHost cannot clone its instance SSH URL. |
| resolveDcLogin trusts the instance's X-AUSERNAME over the typed username | KEEP | Token for another/anonymous user is trusted as typed user. |
| credential host includes non-standard ports; strips creds embedded by the API | KEEP | Nonstandard HTTPS port is omitted from credential lookup. |
| ed25519 version gate | KEEP | Old DC instance is assigned unsupported Ed25519 keys. |
| sshProbe uses the account sshHost and reports HTTPS-only when absent | KEEP | SSH probe hits wrong host/port or claims HTTPS-only instance supports SSH. |
| SSH key uploads preserve manual fallback, duplicate and algorithm errors | KEEP | DC key upload auth restrictions must yield the manual key-paste URL; duplicate and algorithm failures retain actionable errors, and 5xx remains upstream. |

## `apps/daemon/src/providers/credential-line.test.ts`

Shared six-bar evidence: **provider** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| encodes reserved characters in username and token | KEEP | Reserved token bytes corrupt git credential-store URL. |
| keeps a DC port in the host | KEEP | Custom HTTPS port is lost in persisted credential lookup. |

## `apps/daemon/src/providers/github.test.ts`

Shared six-bar evidence: **provider** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| parseRepoUrl accepts https, ssh and shorthand forms | KEEP | Supported GitHub URL grammar loses repo identity or accepts another forge. |
| credentialSpec and sshProbe match today's behavior | KEEP | GitHub SSH authentication cannot recognize verified login or uses wrong target. |
| cloneUrls derives both transports | KEEP | GitHub clone URL is unusable for one transport. |

## `apps/daemon/src/providers/polling.test.ts`

Shared six-bar evidence: **provider** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| github: pulls map open/merged/closed, newest-updated first, with the ETag | KEEP | GitHub PR protocol mapping loses states/body/identity/ETag. |
| github: a matching ETag is sent as If-None-Match and a 304 is notModified | KEEP | Conditional poll omits If-None-Match or treats 304 as failure. |
| github: anonymous reads send no Authorization header | KEEP | Anonymous GitHub API request includes Authorization. |
| github: releases map drafts, prereleases and a nameless release | KEEP | Release drafts/prereleases/nameless titles or publication times are wrong. |
| github: a spent rate limit is a 429 rate_limited error with the reset | KEEP | Spent GitHub quota does not tell poller to back off. |
| github: a bad token is a 400 auth error; a missing repo a not_found | KEEP | Bad token and missing repo return indistinguishable errors. |
| bitbucket cloud: pullrequests map OPEN/MERGED/DECLINED with the abbreviated head hash | KEEP | Cloud PR mapping loses state/abbreviated SHA/auth or destination. |
| bitbucket cloud: a token without read:pullrequest is a missing_scope error | KEEP | Missing pullrequest scope fails to produce actionable scope error. |
| bitbucket cloud: a plain 401 stays an auth error; anonymous and 304 work | KEEP | Cloud auth failure/anonymous conditional requests are mishandled. |
| bitbucket cloud and server have no releases | KEEP | Bitbucket unsupported release feature issues network requests or errors. |
| bitbucket server: pull-requests map states and sort by updatedDate | KEEP | DC PR state/data/timestamp normalization must match recorded native payloads and remain sorted independently of state-page request order. |
| bitbucket server: every OPEN page is read (a long-lived PR never drops off) and a PR last seen open is looked up | KEEP | Old open PR or newly merged known PR disappears from polling. |
| bitbucket server: needs an account; personal projects keep the ~; a 403 is auth | KEEP | DC account requirement/personal-project URL/auth error is wrong. |
| bitbucket cloud: a 429 is not retried; it pauses the account, and later requests fail fast | KEEP | One Bitbucket Cloud 429 must pause background and interactive calls for the same account without retries; another account remains usable. |
| bitbucket cloud: a 429 without Retry-After pauses for 60 s | KEEP | Missing Retry-After on a Cloud 429 must use the documented 60-second fallback, independently of Retry-After parsing. |
| bitbucket server: a 429 reads Retry-After and stops the rest of the poll's pages | KEEP | A DC 429 must stop all remaining pagination/known-open lookups and reject later repository polls for the same account without another HTTP request. |
| github: a spent quota pauses the account until its reset; other answers start no pause | KEEP | A GitHub exhausted quota must pause releases and PR polling together until reset; unrelated 404 answers must not pause another account. |
| retryAfterMs reads seconds and HTTP dates | KEEP | Retry-After seconds/date/unreadable forms schedule incorrect retries. |

## `apps/daemon/src/providers/rate-gate.test.ts`

Shared six-bar evidence: **provider** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| a 429 pauses the host for its Retry-After; background and interactive requests then fail fast | REWRITE | A Retry-After pause must reject both background and interactive sends, expose remaining wait and allow requests precisely after expiry. Remove incidental complete error wording; preserve rate_limited kind, remaining delay and the independent zero-send oracle. |
| a 429 with no usable Retry-After pauses for 60 s and says so on the error | KEEP | A rate-limited answer without usable Retry-After must expose the fallback pause on its error and actually hold the host. |
| a pause is extended, never shortened, and other failures start none | KEEP | A new shorter pause must not shorten an existing quota pause; upstream errors after expiry must not restart one. |
| at most `slots` requests are in flight; the rest queue, and a pause started meanwhile refuses them | KEEP | The gate must enforce concurrent-request slots, hand released slots to queued work, and reject work whose host becomes paused while it queues. |
| gates are per host and per account, and an unlimited gate never queues | REWRITE | Host/account canonicalization must share quota pauses while other hosts/tokens/anonymous quota remain isolated; an unlimited gate must not queue independent work. Replace object-identity assertions with shared pause and isolated successful-request outcomes. Returning wrappers around the same quota state may now refactor safely. |
| a pause never runs past an hour, whatever Retry-After asks for | KEEP | Malicious or mistaken week-long Retry-After values must not lock a provider account out beyond one hour; requests resume at the cap. |

## `apps/daemon/src/providers/ttl-cache.test.ts`

Shared six-bar evidence: **provider** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| returns the cached value within the TTL and refetches after it expires | KEEP | Listing cache fails to expire or hammers provider within TTL. |
| keys are independent and invalidate() drops a single key | KEEP | One credential’s invalidation evicts/returns another credential’s listing. |
| a failed fetch is not cached | KEEP | Failed listing is cached permanently instead of retried. |

## `apps/daemon/src/registry-env.test.ts`

Shared six-bar evidence: **registry** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| parseEnvFile handles common dotenv syntax | KEEP | Supported dotenv comments/quotes/export prefixes are misparsed. |
| RegistryService applies per-launcher env files without exposing them in registry responses | KEEP | Launcher environment is not loaded or secrets escape registry response. |
| the Claude entry turns its task tools on, and a per-launcher env file still decides | KEEP | The Claude launcher must expose its documented task tools and let the owner override launch environment values without losing unrelated registry defaults. |

## `apps/daemon/src/repo-identities/favicon.test.ts`

Shared six-bar evidence: **repo** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| normalizeFaviconDomain reduces accepted forms to the hostname | KEEP | Pasted homepage/domain/IDN forms must normalize into the public hostname used for favicon discovery, stripping paths and one trailing dot. |
| normalizeFaviconDomain refuses everything that is not a public domain | KEEP | Credentialed, local, literal-IP, malformed, overlong and port-bearing domain input must be refused before any network fetch. |
| scanIconLinks reads icon links tolerantly and resolves them against the page | KEEP | Native HTML link forms must decode entities and relative URLs while ignoring comments/scripts, non-icon links and unsafe javascript targets. |
| scanIconLinks honours <base href> | KEEP | An HTML base URL must affect relative icon resolution, preventing missing favicons on sites that host assets beneath a base path. |
| scanIconLinks skips <linkfoo>/<basement>, and an unclosed tag ends the scan | KEEP | Tag-prefix lookalikes and unterminated quoted tags must not invent icon requests from hostile markup. |
| scanIconLinks scans a hostile 1 MB page in linear time | KEEP | Adversarial near-tag HTML up to the fetch cap must complete within the generous safety bound; old nested scans caused CPU denial of service. |
| rankIconCandidates orders SVG, large sizes, apple, icon, then /favicon.ico, de-duplicated | KEEP | The documented favicon preference order must prefer SVG/large/apple icons, deduplicate candidates and leave favicon.ico as final fallback. |
| data: icon URLs are candidates and decode locally | KEEP | Supported image data URLs must rank/decode without network; invalid MIME/base64 and over-cap inline images must be refused. |
| fetchFavicon picks the best icon and reports its sniffed type | KEEP | Favicon discovery must fetch the chosen preferred icon and return its real bytes/type, independent of a false HTTP Content-Type. |
| fetchFavicon falls back to /favicon.ico | KEEP | A site without link icons must still discover its conventional favicon.ico. |
| fetchFavicon uses a data: icon without fetching it | KEEP | An inline favicon must produce real decoded image bytes while making no extra image HTTP request. |
| fetchFavicon still tries /favicon.ico when the homepage answers non-2xx | KEEP | Non-2xx homepages must still permit conventional icon fallback; if none succeeds, the public error names the status without exposing response bodies. |
| fetchFavicon follows a redirect to another host, re-guarding it | KEEP | Cross-host redirects must re-resolve and re-guard each hop, then resolve relative icon paths against the final page URL. |
| fetchFavicon refuses a redirect to a private or local address | KEEP | Redirects must never contact private DNS or local/literal metadata targets, preserving SSRF protection beyond the original URL. |
| fetchFavicon refuses a host when any DNS answer is private | KEEP | A mixed public/private DNS answer must block the entire target before HTTP, preventing address-selection bypass. |
| fetchFavicon skips icon candidates on blocked hosts and says so when nothing else works | KEEP | Blocked icon hosts must be skipped and classified safely while a usable same-site conventional icon may still succeed. |
| fetchFavicon skips an oversized icon for the next candidate | KEEP | Declared and chunked over-cap icon bodies must be stopped and skipped so a later valid candidate can succeed. |
| fetchFavicon reads at most 1 MB of HTML | KEEP | Icon links after the one-MiB HTML cap must never be fetched, while an early valid link survives truncation. |
| fetchFavicon rejects bytes that are not an image | KEEP | An HTTP image label must not make HTML body bytes a usable favicon; unsuccessful candidates end in FAVICON_NOT_FOUND. |
| fetchFavicon makes at most 4 candidate fetches | KEEP | Favicon discovery must stop after four candidate fetches, bounding adversarial pages with many broken icons. |
| fetchFavicon follows at most 3 redirects | KEEP | Three redirect hops must remain usable, but a fourth must stop before reaching the target. |
| fetchFavicon reports an unresolvable host as unreachable | KEEP | DNS failure must become FAVICON_UNREACHABLE naming the domain, instead of an unclassified transport exception. |
| fetchFavicon's deadline spans the whole operation | KEEP | The overall deadline and caller cancellation must abort in-progress image/page reads and prohibit further fallback requests. |

## `apps/daemon/src/repo-identities/image-sniff.test.ts`

Shared six-bar evidence: **repo** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| sniffRepoIcon recognizes each stored type by its bytes | KEEP | Each independently specified PNG/JPEG/WebP/ICO/SVG byte signature must map to the stored MIME, independent of declared filenames. |
| sniffRepoIcon accepts an SVG prolog, a self-closing root and trailing comments | KEEP | Valid SVG BOM/prolog/self-closing/trailing-comment documents must remain importable. |
| sniffRepoIcon refuses everything else | KEEP | Empty, other-format, cursor, non-root, incomplete and invalid-UTF8 bytes must not masquerade as stored icons. |
| sniffRepoIcon reads doctype subsets, any case, and stops at a comment body holding --> | KEEP | SVG document scanning must respect doctype subsets, quoted delimiters and comment boundaries; unterminated declarations must be rejected. |
| sniffRepoIcon answers adversarial SVG-ish text in linear time | KEEP | Adversarial SVG-like text must remain bounded and return the correct refusal/acceptance result; old regex backtracking caused CPU denial of service. |

## `apps/daemon/src/repo-identities/routes.test.ts`

Shared six-bar evidence: **repo** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| label: set, list, invalid, and a null or blank label clears the record | REWRITE | The label HTTP route must return/list normalized identities, map invalid values to INVALID_LABEL and clear null/blank labels. Detailed label-length grammar remains at the store validator; retain one independent HTTP invalid-type mapping instead of repeating that grammar at the router. |
| emoji: one trimmed emoji is stored; anything else is INVALID_EMOJI | REWRITE | The emoji HTTP route must return a normalized single emoji and map missing/invalid values to INVALID_EMOJI. Detailed emoji grammar remains in the store and API emoji codec; retain HTTP invalid/missing field cases and actual normalized successful data. |
| every route validates the repo key | REWRITE | Each distinct repo-key HTTP entry point must refuse traversal before mutation/fetch; missing/repeated query parameters must also be invalid. Use one invalid traversal key for each of the six distinct HTTP boundaries instead of six invalid keys at every boundary. Detailed key grammar remains at the store validator; missing/repeated query shape cases stay. |
| upload, GET with the security headers, replace removes the old file, DELETE clears it | KEEP | Icon HTTP uploads/reads/deletion must preserve bytes and enforce nosniff, sandbox CSP and version-dependent caching; replacing an image must invalidate its old URL. |
| upload refusals: content type, magic bytes, declared ≠ sniffed, ICO, broken SVG, empty | REWRITE | Raw uploads must apply the upload-only type allowlist (including ICO rejection), and map a service byte/type mismatch to INVALID_ICON without writing. Remove six byte/SVG permutations already owned by service/image-sniff; retain raw upload allowlist/ICO rejection and a real service mismatch mapped to INVALID_ICON. The unused JPEG fixture is removed. |
| over the cap: a declared length and a streamed body are both 413, and nothing is stored | KEEP | Both Content-Length and streaming byte caps must return 413/close without storing; exactly-at-cap payloads must remain usable. |
| favicon: a fetched icon is stored with its source; refusals map to their statuses | KEEP | The favicon HTTP route must persist source attribution, map typed fetch/store refusals to API codes, preserve the prior icon and redact unexpected upstream body details. |
| favicon: one fetch per repo at a time — a second is 409 FAVICON_BUSY | KEEP | Concurrent fetches for one repo must conflict while a different repo proceeds; completion must release the lock for the next request. |
| favicon: the one-fetch lock holds across every server the routes are registered on | REWRITE | Both daemon transports must share the same per-repository favicon lock; a lock owned by one Fastify registration must protect the other. Remove direct observation of faviconFetches.size; next-request lock release is already verified behaviorally by the adjacent per-repo concurrency case. Cross-transport exclusion remains uniquely checked here. |
| the daemon serves the routes on both transports; the remote one requires the bearer, ?token= included | KEEP | Repo identity routes must exist on socket and HTTP, but remote access requires bearer authentication and does not accept query-token bypass. |

## `apps/daemon/src/repo-identities/safe-fetch.test.ts`

Shared six-bar evidence: **repo** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| isBlockedAddress refuses every non-public IPv4 range | KEEP | The SSRF IP classifier must block every specified non-public IPv4 allocation, including cloud metadata and multicast/reserved ranges. |
| isBlockedAddress allows public IPv4, including the neighbours of blocked ranges | KEEP | Public addresses immediately beside blocked IPv4 ranges must remain reachable, detecting overbroad subnet masks. |
| isBlockedAddress refuses every non-public IPv6 range | KEEP | Non-public IPv6 allocations must be refused, including loopback, link-local, ULA, multicast, documentation and transition ranges. |
| isBlockedAddress unwraps IPv4 embedded in mapped, translated, NAT64 and 6to4 forms | KEEP | Private IPv4 targets encoded inside mapped/translated/NAT64/6to4 IPv6 must remain blocked while public embedded addresses remain allowed. |
| isBlockedAddress allows public IPv6 and refuses garbage | KEEP | Public IPv6 must remain reachable; malformed IP strings must fail closed instead of bypassing address validation. |
| hostnameProblem separates local names from malformed ones | KEEP | Local metadata/internal hostnames and malformed DNS labels must remain distinguishable from public names before resolution. |
| checkRequestUrl allows only https to a plausible public name | KEEP | Guarded network URLs must require public HTTPS names without credentials/alternate ports; trusted local-test behavior must never enable normal URL escape. |
| pinnedLookup answers only the vetted host with only the vetted addresses | KEEP | The pinned DNS lookup must serve only the vetted host/address families and reject a different hostname, preventing DNS rebinding at connection time. |

## `apps/daemon/src/repo-identities/service.test.ts`

Shared six-bar evidence: **repo** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| a missing file is an empty store, and nothing is written until a change | KEEP | Loading an absent identity store must be read-only until the first user change; startup must not manufacture a persisted file. |
| label: set, trimmed, persisted 0600; clearing the last field removes the record | KEEP | Labels must trim and persist securely; idempotent writes must emit nothing, and clearing the last field must remove the persisted identity and publish deletion. |
| label, emoji and repo key validation | KEEP | The store boundary must enforce label/emoji/repo-key validity for every operation, including callers other than the HTTP upload route. |
| emoji is trimmed and replaces an image icon, whose file goes once the write landed | KEEP | Replacing an image with a normalized emoji must remove the referenced file only after persistence and leave no image to serve; icon paths remain restrictive. |
| image: stored with a version, served back; the wire never names the file | REWRITE | Image storage must preserve bytes/MIME and source, hide host filenames on wire, and change versions/files when bytes are replaced. Remove a version property whose expected value came from the result itself; keep independent MIME/source/byte and version-change assertions. |
| image refusals: wrong magic, declared ≠ sniffed, empty, over the cap, unknown type | KEEP | The image store must reject declared/sniffed mismatch, invalid SVG, empty/oversize and unsupported input without writing; favicon-only ICO remains accepted. |
| clearIcon: back to the label alone, or the record removed with its file | KEEP | Clearing icons must preserve an independent label, remove icon-only records/files and leave no orphan image on repeated clears. |
| reload: unknown fields and rejected records survive a rewrite; orphan icons are swept | KEEP | Reload/rewrite must preserve unknown fields and unreadable records while sweeping only unreferenced generated icon names. |
| a corrupt file is moved aside byte for byte, its icons kept; the store starts empty | KEEP | Corrupt/newer-version identity stores must be moved aside byte-for-byte and retain their icons; a fresh store must remain writable. |
| later loads keep the icons a moved-aside file names, and still sweep true orphans | KEEP | Future loads must continue retaining icons mentioned by quarantined or truncated files while sweeping true orphans. |
| an unreadable file makes the store read-only: every mutation 503, nothing written | KEEP | An unreadable identity file must make every mutation unavailable without replacing the file or creating icons. |
| overlapping changes land in order: the last state is on disk | KEEP | Concurrent label/image/emoji mutations must persist the final values in order and remove every replaced image file. |
| publishRepoIdentityEvents puts every change on the repo-identities channel | KEEP | Identity changes and deletions must be published through the independently documented repo-identities channel/event names. |

## `apps/daemon/src/subagent-cache-ttl-route.test.ts`

Shared six-bar evidence: **cachettl** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| the status route answers for the stored mode, to authenticated clients only | KEEP | The authenticated cache-TTL route must read the saved mode at request time and default a missing preference to auto with the actual controller result. |

## `apps/daemon/src/subagent-cache-ttl.test.ts`

Shared six-bar evidence: **cachettl** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| a 5m subagent that re-writes its prefix after a 10 minute wait would have read it at 1h | CONSOLIDATE | A five-minute cache rewrite after ten idle minutes must cost 250000 versus 210000 under one hour, even when transcript requests arrive reversed. Surviving fixed-cost owner receives reversed transcript requests, preserving sorting protection without a second self-referential estimator call. |
| a subagent that never waits 5 minutes only pays the dearer 1h write | KEEP | A busy subagent with no cache-expiry wait must incur the dearer one-hour writes without an invented read saving. |
| a wait of an hour or more expires both caches, so only the write price differs | KEEP | A gap of at least one hour must expire both cache lifetimes; estimating a one-hour cache hit would choose an incorrect billing mode. |
| a 1h subagent that read its prefix after a wait would have re-written it at 5m | KEEP | A subagent actually using one-hour cache must estimate the five-minute rewrite after a wait while preserving externally warmed shared tokens. |
| requests are ordered per subagent, whatever order they arrive in | CONSOLIDATE | The original expected value called the same estimator again; consolidate unordered input into the fixed 250000/210000 oracle of the first cost case. Remove the separate expected-value-from-implementation oracle; reversed request order is now protected by the first fixed-cost owner. Failed bars 3/6 in its original form. |
| auto picks 1h when it would have been more than 5% cheaper | KEEP | Auto mode must select one hour for a meaningful saving and report the measured -16 percent over sufficient requests. |
| auto picks 5m when 1h would have been more than 5% dearer | KEEP | Auto mode must return five minutes when one-hour write overhead makes that lifetime materially dearer. |
| auto keeps the current choice when the two are within 5% | KEEP | A near-equal estimated cost must keep the current lifetime, preventing unnecessary weekly switching. |
| auto falls back to 5m when there are too few subagent requests to judge | KEEP | Insufficient observed usage must choose the conservative five-minute default with an explicit insufficient result. |
| always-1h and always-5m apply as chosen without reading any usage | KEEP | An explicit one-hour/five-minute preference must apply without scanning or consulting usage. |
| auto decides from the last 14 days and keeps the decision for a week | KEEP | Auto mode must scan the documented 14-day window, hold its decision until seven days and reevaluate/persist when that interval ends. |
| auto's decision survives a daemon restart | KEEP | A current cache-TTL decision must survive restart without re-reading usage. |
| auto waits for the transcript scan instead of deciding on nothing | KEEP | A scanner that has not completed must not persist an insufficient-data verdict and delay the first meaningful decision. |
| auto looks again the next day when there was too little usage to judge | KEEP | Insufficient usage must retry after one day, rather than waiting a week or rescanning on every launch. |
| an unreadable stored decision is ignored | KEEP | Malformed persisted decision bytes must not prevent the next valid auto decision. |
| status reports the mode, what launches get, and auto's last and next check | KEEP | Controller status must expose the effective lifetime/decision schedule; a fixed mode must stop scheduling auto checks. |

## `apps/daemon/src/usage-aggregate.test.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| worst-account picks the highest-percent window per field across accounts | KEEP | Pooled session/weekly quotas choose the wrong independent account maximum. |
| System base participates in the pool and can be the worst source | KEEP | System source is omitted from pooled warning. |
| carries the resets/capacity of the chosen worst window and its freshness | KEEP | Chosen window loses reset/capacity or freshness timestamp. |
| null windows everywhere leave head windows null and mark stale | KEEP | No usable windows falsely show a fresh reading. |
| an expired window (resetsAt in the past) never wins the worst-account pick | KEEP | Reset 100% quota continues to dominate current pooled usage. |
| windows that all expired leave the head window null | KEEP | All expired windows continue showing exhausted quota. |
| historical readings stay on account cards without driving current quota aggregates | KEEP | Historical lastKnown quotas and needsReauth must remain visible on account cards while being excluded from current aggregate limits. |
| the System base is exposed as a `system` row (expired windows scrubbed) | KEEP | System breakdown displays stale pre-reset quota. |
| no System base ⇒ no system row | KEEP | Managed-only account set invents a System row. |
| head is not stale when a fresh window is shown even if another account is stale | KEEP | One stale account greys a fresh pooled reading. |

## `apps/daemon/src/usage-chat-threads.test.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| sums each settled turn's reported cost and tokens per UTC day and model, for that agent's chats only | KEEP | Only the configured agent's settled chat turns may contribute UTC-day/model token and reported-cost totals; model changes must affect subsequent turns. |
| appended turns are counted once; a partial last line waits for its newline; a rebuilt log is read again; a removed thread drops out | KEEP | Incremental thread scans must count appended complete turns once, defer partial rows, replace rewritten history and drop deleted threads. |
| no threads directory yet: no rows | KEEP | Usage before the threads directory exists must yield an empty snapshot instead of startup failure. |
| tolerant of every line it cannot use: malformed, unknown or old shapes are skipped, never thrown on | KEEP | Malformed/old/unknown chat-log rows must not crash scanning or contribute fabricated cost; valid settlements after junk must still count. |
| an over-long line is skipped and counted, never held whole; lines across read chunks still parse, a multi-byte character across a chunk too | KEEP | Oversize thread rows must be skipped once across appended chunks; small reads must preserve UTF8 model names and later valid turns. |

## `apps/daemon/src/usage-claude-state.test.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| asks the endpoint at most once per window, even with nothing to show | KEEP | Burst requests exceed five-minute provider budget. |
| a restart keeps the last reading and waits out the window the previous process opened | KEEP | Restart loses last reading or repeats recently budgeted request. |
| expired or cleared credentials keep historical quotas across restarts and recover on login | REWRITE | Expired/cleared/deleted credentials must preserve literal historical quota/observation values after restart; renewed credentials must restore live numbers and clear reauthentication. Replace values copied from the first implementation response with literal observed percentages, reset timestamps and asOf, so a wrong initial parser/lastKnown payload fails. |
| a 429's Retry-After survives a restart and the last reading is served greyed meanwhile | KEEP | Retry-After/grey stale value is forgotten on restart. |
| a live reading replaces the account windows, keeps the scoped ones, and skips the poll | KEEP | Out-of-order live data overwrites fresh usage or unnecessary endpoint poll occurs. |
| a live reading on an account with no reading yet stands on its own | KEEP | Fresh live-only quota remains unavailable before endpoint reading. |
| a stamp from the future (the clock moved back) does not block the endpoint | KEEP | Clock rollback permanently blocks polling. |
| UsageStateFile round-trips, drops what does not parse and moves a corrupt file aside | KEEP | Usage cache load must round-trip a valid reading, discard malformed entries safely and quarantine corrupt storage bytes. |
| a thread's live windows become the account's session and weekly readings | KEEP | Thread provider usage windows map/clamp to wrong account slots. |

## `apps/daemon/src/usage-codex-wham.test.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| maps plan_type and primary/secondary windows | KEEP | WHAM payload maps plan/window/reset into wrong API fields. |
| week-only primary_window (7d limit, no secondary) → weekly slot | KEEP | Week-only plan incorrectly consumes session slot. |
| unparseable payload → available:false | KEEP | Unrecognized WHAM body falsely reports available quota. |

## `apps/daemon/src/usage-expiry.test.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| parseClaudeUsage drops a window whose reset time has already passed | KEEP | Parsed already-reset Claude window still reports exhausted quota. |
| expired-token lastGood serves only windows that have not reset yet | KEEP | Cached last-good reading outlives quota reset while token prevents refetch. |
| expired-token lastGood serves a refilled 5h window as 0% instead of dropping it | KEEP | A previously observed rolling five-hour window must refill to zero after reset while a still-current weekly cap remains visible. |
| a source that never read a 5h window still serves none | KEEP | A source with no observed session window must not fabricate a zero-percent session bar after token expiry. |

## `apps/daemon/src/usage-first-reading.test.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| whenFirstReading waits for the first reading after start, and is bounded | KEEP | Workflow boot account selection must wait for the first usable reading, and a controlled timer must bound waiting for a source that cannot finish. |

## `apps/daemon/src/usage-scoped.test.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| parseClaudeUsage surfaces a model-scoped weekly limit alongside the legacy windows | KEEP | Legacy quota fields mask concurrent model-scoped cap. |
| parseClaudeUsage drops scoped windows that are unlabeled, expired, or garbage | KEEP | Unlabeled/expired/garbage scoped window renders as valid quota. |
| parseClaudeUsage keeps scoped windows in the limits[]-only shape too | KEEP | Limits-only response loses model cap. |
| aggregateWorstAccountUsage carries scoped windows on account rows and the system row | KEEP | Account/System scoped cap or its expiry disappears during aggregation. |
| stale last-known reading drops scoped windows whose reset has passed | KEEP | Expired cached model cap remains exhausted when token prevents fetch. |

## `apps/daemon/src/usage-system-visibility.test.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| claude: expired system credentials hide the System row | KEEP | Expired Claude System login creates permanent empty row. |
| claude: unexpired system credentials keep the System row | KEEP | Valid Claude System quota is hidden. |
| codex: system account matching a managed account_id hides the System row | KEEP | Duplicate Codex account-ID quota gets rendered twice. |
| codex: system account matching a managed email (no account_id) hides the System row | KEEP | Duplicate JWT-email Codex quota gets rendered twice. |
| codex: a distinct, unexpired system account keeps the System row | KEEP | Distinct valid Codex System quota is hidden. |
| codex: an expired system token hides the System row even with a distinct identity | KEEP | Expired distinct Codex System token creates empty quota row. |
| codex: missing auth.json does not hide (source already reports null/scrape) | KEEP | Missing Codex credentials suppress legitimate rollout fallback. |

## `apps/daemon/src/usage-tokens.test.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| 1h-TTL cache writes bill at 2x input, 5m at 1.25x | KEEP | Mixed one-hour/five-minute cache writes must bill the one-hour subset once at 2x and the rest at 1.25x, giving the independently calculated 7.75 cache cost. |
| unknown model yields null cost | KEEP | Unknown native model names must stay unpriced instead of inventing an API-equivalent charge. |
| versioned model ids stay priced (F1) | KEEP | Native dated/preview model IDs must retain known pricing rather than disappearing from cost estimates. |
| scanCodex reads the real event_msg/token_count/info shape and sums per-turn usage | KEEP | Codex cached-input tokens are charged as ordinary input or per-turn sums wrong. |
| scanClaude reads the 1h cache-write split and skips zero-usage rows | KEEP | Claude cache TTL split/zero synthetic entries are misread. |
| scanClaude dedupes repeated message.id+requestId across files (F2) | KEEP | Resumed/branched transcript copies double-count turns. |
| recompute caches unchanged files and stays correct on partial rescan (F5) | KEEP | Partial rescan loses or double-counts previously read turns. |
| a truncated/rewritten file is fully re-parsed | KEEP | Truncated transcript leaves deleted turns in totals. |
| codex parser state (model, cumulative gate) carries across appended chunks | KEEP | Appended Codex chunk loses model or counts repeated cumulative event. |
| an unterminated tail line is counted once, then not double-counted when completed | KEEP | Completing an unterminated JSONL row double-counts it. |
| managed-account home transcripts are counted with and without a system home | KEEP | Managed Claude transcripts must contribute under the ordinary agent ID both before and after a system transcript directory exists. |
| subagent requests are reported once each, with their time and cache usage, apart from the main thread | KEEP | Subagent usage must be separated from main-thread turns, deduplicated across streamed blocks and exposed with timestamps/TTL splits for the decision window. |
| subagent requests are unknown until the transcripts have been scanned once | KEEP | Before scanning, subagent usage must be unknown rather than an authoritative empty sample; after an empty scan it becomes an empty sample. |
| claude-opus-5-5 has its own row: it reproduces the CLI's charges in claude fixtures 17, 18 and 19 (1-hour cache writes) | KEEP | Observed CLI charges for Opus 5.5 fixtures 17/18/19 must match their independent dollar totals rather than using the broader Opus 5 prefix tariff. |
| a trailing context tag is dropped before the lookup: claude-opus-4-8[1m] bills at standard opus 4.8 rates (claude fixture 01: 0.21547) | KEEP | A context-tagged Opus 4.8 model must reproduce fixture 01 cost; context tags cannot silently make known transcript usage unpriced. |
| codex rollouts an Agent Profile home writes through its sessions link are counted once | KEEP | A profile rollout written through account/system sessions symlinks must contribute once, preventing duplicate billing from realpath aliases. |

## `apps/daemon/src/usage.check.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| initial enabled snapshot/change notification | KEEP | Enabled available providers must appear in the first forced snapshot and emit one public changed event. |
| unchanged recompute deduplication | KEEP | Identical provider data must not broadcast repeatedly. |
| per-agent disabled snapshot | KEEP | Disabling Codex must remove only Codex from public usage. |
| globally disabled snapshot | KEEP | Disabling usage globally must return no agents. |
| missing Claude credential source | KEEP | A null source must be omitted while the available Codex source remains. |

## `apps/daemon/src/usage-parse.check.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| Claude legacy shape | KEEP | Observed five_hour/seven_day utilization fields must normalize to the independent 45/69 session/weekly values and Max 20x plan. |
| Claude limits[] shape | KEEP | The alternate limits[] response must normalize session and weekly_all slots. |
| utilization epoch leak #52326 | KEEP | A leaked epoch in utilization must be dropped while the valid weekly value survives. |
| Codex primary/secondary duration | KEEP | Recorded rollout primary/secondary windows must normalize 3/37 percent and Pro plan. |
| Codex week-only primary | KEEP | A sole seven-day primary pool must appear as weekly, never session. |
| Codex reset-distance fallback | KEEP | Without duration metadata a far-future reset must identify the weekly pool. |
| Codex expired secondary | KEEP | An expired secondary reading must disappear while a current primary survives. |
| last token_count and garbage lines | KEEP | The latest native token_count rate_limits must win; blank/malformed lines cannot create a reading. |
| Grok weekly billing pool | KEEP | Native credit percent/period/tier must yield a weekly-only 22.4 percent pool. |
| Grok proto3 omitted percent | KEEP | An omitted proto3 scalar in a current billing period must mean zero usage, not unavailable. |
| Grok expired/malformed billing | KEEP | Past-period and malformed billing payloads must never claim current quota. |

## `apps/daemon/src/usage-sources.check.ts`

Shared six-bar evidence: **usage** above. Production/support caller search retained necessary native/parser APIs and isolation hooks; no test-only production seam is removed in this scope.

| Baseline exact test name / check scenario | Disposition | Concrete reason and surviving coverage |
| --- | --- | --- |
| Claude first 429 remains signed in | KEEP | A credentialed account whose first poll is rate-limited must stay available/stale with its credential-derived plan and no invented quota. |
| Claude no credentials | KEEP | A home without native credentials and prior readings must report no signed-in source. |
| Codex newest empty log fallback | KEEP | An empty newer rollout cannot mask the older real token_count reading when WHAM is down. |
| Codex API-key mode | KEEP | API-key mode must suppress subscription quota even when prior OAuth rollout files remain in that home. |
| Codex missing auth | KEEP | Missing auth.json must still allow a real rollout reading. |
| Codex missing access token | KEEP | A native file without access_token must still allow a real rollout reading. |
| Grok no credentials anywhere | KEEP | No CLI or explicit managed credential must report no linked source. |
| Grok managed billing identity and privacy | KEEP | An explicit managed auth file must select the billing bearer/user ID and public email row while keeping token/user ID off the returned wire payload. |
| Grok expired credentials | KEEP | Expired Grok native credentials must stay linked/stale and never be sent upstream. |
| Grok 429 backoff | KEEP | A failed refresh must serve last-good quota stale and send no additional request inside Retry-After. |
| Grok CLI user lookup cached | KEEP | A CLI auth file without user ID must resolve it once before billing and reuse that identity on subsequent reads. |
| Claude environment and explicit-home precedence | KEEP | Native CLAUDE_CONFIG_DIR must beat userhome; an explicit managed home must beat both. |
| Codex explicit-home precedence | KEEP | A positive rollout reading from explicit codexHome must beat an unrelated CODEX_HOME API-key account. |

## Cleanup and validation record

Implemented across ten assigned test files: 94 test lines added, 125 removed (net **−31**). Six duplicate declarations were consolidated into their existing public owners, leaving 323 named tests plus the 29 check-script scenarios. One unused JPEG byte fixture was removed; no snapshots, fixture files, dependencies, configuration or production behavior changed. No supporting production export became unused: token codecs, clocks, ownership guards and provider isolation hooks still have production or retained behavioral callers.

The authentication fixture now creates its local Fastify transport only when used, closes only the transports it constructed and removes its owned temporary directory. Its password-change scenario retains real bcrypt hashing and old/new password verification with a cost-4 salt. The account-history race retains all 40 original scheduling offsets while reusing immutable account setup and resetting command directories between schedules; the sole owned directory is removed afterward.

Baseline profiling recorded 6,137.9 ms for the password-change lifecycle and 782.4 ms for the same-account command race under the repository's four-worker run. These are baseline observations, not a claimed speedup. Comparable after timings and runtime validation await the root's scheduled test slot. The root owns repository-wide gates, total-suite timing, final diff review and Git delivery.

Completed static checks: `git diff --check -- $(cat /tmp/orquester-test-audit/accounts.files)` passed; a TypeScript syntax parse of all 41 proposed files had no diagnostics. No test, typecheck or build has been run by this scope after the implementation hold was released; execution is centrally scheduled to avoid competing runs in this worktree.
