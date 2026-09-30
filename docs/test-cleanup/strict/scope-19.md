# Strict cleanup scope 19: accounts, authentication, providers and usage

Completed cleanup. This ledger was started before editing the assigned tests and reconciled against the final source. All 26 files and 166 named baseline cases were read alongside their production owners. Check-script scenarios are enumerated separately. Historical audit prose was checked against current imports and behavior; it is not authority. A preliminary TtlCache deletion was reversed before completion: bitbucket-cloud.ts contains a literal NUL, so ordinary rg hid its real imports; reading the owner and repeating the caller search with rg --text confirmed them.

Named-case dispositions: **1 DELETE, 12 REWRITE, 153 KEEP** (166 original cases, 165 surviving). Check-script scenarios: **1 REWRITE, 27 KEEP**. Six test/check files changed, with **19 fewer test lines**; no production behavior changed.

## Six-bar justification used by each retained row

1. **Independent requirement:** the file-family source below plus the row’s concrete contract, never implementation text alone.
2. **Visible failure:** the row names the incorrect user/caller result or security/storage failure.
3. **Independent oracle:** literals from native/protocol fixtures, known preexisting file bytes, explicit time progression, numeric token totals or public error/status; no expected output comes from the function under test.
4. **Stable seam:** the family’s public codec/service or external protocol/filesystem boundary with named real callers.
5. **Refactor survival:** retained assertions depend on external data/state/security options, not private method identity, collaborator counts, markup or formatting. Rewrites remove incidental command order/copy/JSON whitespace.
6. **Lowest distinct owner:** the family explains the layer split, and deleted duplicates name the retained owner. Every KEEP protects the named input/lifecycle variant not established by the remaining tests; retention is not justified by coverage/count.

For isolated helpers the relevant failure classes were enumerated before deciding: credential codecs can lose fields, choose a wrong identity or accept malformed credentials; ownership guards can reject owned paths or accept unmarked/wrong-id/escaped paths; refresh codecs can lose metadata, use wrong time units or misclassify revoked grants; provider codecs can choose the wrong host/port/account, corrupt wire fields or confuse HTTP retry/error states; quota parsers can slot/drop windows incorrectly; aggregation can select expired/wrong accounts; pricing can double-charge TTL subsets, fabricate unknown prices or lose versioned IDs. Cases unrelated to those observable failures were not retained.

## Sources, seams, callers and coverage ownership

### accounts

**Bar 1:** README “Git hosting identities” and “Security model”; public GitRemoteError/ConditionalPage in providers/types.ts; AccountsService clone/remote options consumed by workflow runtime. Git/SSH credential isolation, bounded unattended execution, repository ref selection and transport fallback are the requirements.

**Bars 3–6 / non-test callers:** AccountsService.cloneCreatedRepo/cloneRepo/lsRemote/listPullRequests, observed through filesystem results or the actual git exec/fetch protocol boundary. index.ts project/account routes and workflows call these methods. Provider parser tests own forge syntax; these cases uniquely own account selection, process isolation and cleanup.

### config

**Bar 1:** The shipped accounts.json legacy format plus @orquester/config parseAccountsConfig/serializeAccountsConfig public migration/rollback API. AGENTS requires tolerant persisted records and compatibility with versions already on disk.

**Bars 3–6 / non-test callers:** Public config codecs called by AccountsService.load/save. Fixed old/new records and literal legacy mirrors are the oracle. packages/config tests do not cover these git-account codec scenarios; direct codec tests are the lowest owner.

### identity

**Bar 1:** README managed accounts and AGENTS credential isolation, owned-home deletion, preserved account identity and config rules; native Claude .credentials.json and Codex/Grok auth.json formats; OAuth refresh token/expiry/error semantics. Agent-profile owner requirements §1.1(5,7) and §5 require global edits to reach managed homes and preserve colliding user content.

**Bars 3–6 / non-test callers:** Native codecs/ownership guard and AgentAccountsService public imports, launches, removal and refresh with real temporary files. index.ts account routes/session launches/usage refresh are non-test callers; agent-accounts.ts calls identity/path/refresh helpers, usage-sources.ts also calls identity decoding. Filesystem/native format is the seam, not private synchronization helpers. Distinct credential format, storage mutation or launch context supplies each row’s unique failure.

### grok

**Bar 1:** README Grok device-code linking, RFC 8628/OIDC token grants, and the CLI-native issuer::client auth.json format. GrokDeviceLinkStatus API defines linking/idle/link/error state; secrets must stay host-only.

**Bars 3–6 / non-test callers:** grokAuthJsonFromDeviceTokens native serialization and GrokDeviceLinkService.start/status/cancel with real AgentAccountsService persistence. index.ts uses link service routes; link service calls the converter. Converter tests uniquely own optional identity/time fields; service tests own lifecycle/cancel/conflict/import failure, not a replay of codec fields.

### provider

**Bar 1:** GitProvider, PullRequestInfo, ReleaseInfo, ConditionalPage, CredentialSpec and GitRemoteError contracts in providers/types.ts; fixed GitHub/Bitbucket REST fixture shapes, native clone URL/SSH greeting/credential-store formats, HTTP conditional/Retry-After semantics. README requires all three hosting providers, custom DC context paths/CA and links.clone URLs.

**Bars 3–6 / non-test callers:** GitProvider methods called by AccountsService and workflow remote polling; external fetch responses and request URLs/headers or credential-store bytes are observed. Fixtures supply input only; literal normalized data/status are independent oracles. Each provider’s parsing/HTTP semantics are the lowest owner; AccountsService tests only add account/provider binding. No fixture README exists under providers/fixtures; the retained JSON is documented as recorded-shape, not proven live captures.

### usage

**Bar 1:** README usage widget quota/cost/account requirements; AgentUsage, UsageAccount, UsageTokenRow and UsageResponse public API; native quota responses and CLI transcript formats. Credible regressions: expired windows frozen at 100%, empty newest rollout masking prior data, repeated resumed turns, partial appended records, restart Retry-After loss, live/default identity duplication.

**Bars 3–6 / non-test callers:** usage-parse codecs, create*Source/shouldHideSystemUsage, UsageService, UsageStateFile, aggregateWorstAccountUsage and UsageTokensScanner. index.ts wires them to REST/events and workflow account selection; usage-sources.ts calls parsers; scanner calls cost estimation. Literal independent windows/timestamps/token sums and native filesystem fixtures are the oracle. Parsers own wire syntax, sources own time/auth/cache state, aggregate owns account selection, service owns preference/events/startup, scanner owns file lifetime and cost calculation; these are distinct rather than repeated layer tests.

### cache

**Bar 1:** The Bitbucket repository/owner picker must isolate listings by credential, respect upstream request budgets without indefinitely stale listings, expose newly created repositories after invalidation, and recover from transient listing failures. These caller requirements follow from README per-account git identities and the provider list/create API; the configured TTL is a duration supplied by the caller, not a copied internal constant.

**Bars 3–6 / non-test callers:** bitbucketCloudProvider.listRepos/listOwners use repoListCache/ownerListCache, and createRepo invalidates the current credential key. TtlCache.get/invalidate is the lowest production-used cache seam. Literal successive values and an explicit fake clock expose stale listings, cross-key leakage, broken invalidation and poisoned failures; no provider HTTP test duplicates these temporal/key/error scenarios. Storage mechanism or provider request refactors leave the contract intact. Before retention, isolated failure modes were enumerated as expiry not evicting, cross-key reuse, invalidation touching the wrong key, and rejected fetch poisoning subsequent successful reads.

## `apps/daemon/src/accounts-clone-url.test.ts`

Family: **accounts**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `prefers SSH when the account's key is installed on the provider` | A key-ready account selects unusable HTTPS instead of SSH. |
| KEEP | `falls back to HTTPS while a DC key upload is still pending` | A pending manual SSH key blocks project creation instead of using HTTPS. |
| KEEP | `uses whichever transport exists when only one is offered` | A single offered transport is rejected, or no transport silently invokes git. |

## `apps/daemon/src/accounts-remote.test.ts`

Family: **accounts**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| REWRITE | `lsRemote over SSH pins the account key, BatchMode, no prompt, 30 s, no shell` | Keep account key isolation, prompt suppression, timeout, safe argv and parsed refs; remove exact SSH option ordering/quoting and arbitrary buffer-size threshold. Check the externally consumed command options independently. |
| REWRITE | `lsRemote over HTTPS uses the credential store and the DC CA bundle; defaultBranch:false narrows` | Keep account credential path, custom CA, requested ref scope, custom timeout and absence of token material. Compare Git config options without order and assert required ref flags independently. |
| REWRITE | `lsRemote on a Bitbucket account pins the daemon-owned known_hosts` | Keep selected key, daemon known_hosts and BatchMode options; stop requiring one complete shell command spelling/order. |
| KEEP | `lsRemote anonymously resets every credential helper` | Anonymous HTTPS accidentally invokes an ambient credential helper. |
| REWRITE | `lsRemote refuses an anonymous SSH read (it would offer this host's own keys) and points at https` | Keep unsupported error and zero executions for both SSH URL forms; remove the incidental English/URL hint assertion. |
| KEEP | `lsRemote refuses unsafe URLs before running anything` | Untrusted URL invokes git option/file/remote-helper execution. |
| REWRITE | `lsRemote classifies failures: auth, not found, timeout — and redacts userinfo` | Keep exact public error kinds and credential redaction; remove timeout message copy (the timeout kind is the caller contract). |
| REWRITE | `cloneRepo without options is the New Project dialog's clone: no ceiling, git's prompting untouched` | Keep clone command/destination, native prompt behavior, absent timeout and selected SSH identity. Remove whole SSH command spelling. |
| KEEP | `an unattended clone (a workflow's) gets a prompt-free env and a 10 min ceiling` | Workflow clone hangs for input or has no timeout bound. |
| KEEP | `cloneRepo removes the clone when the sha cannot be checked out` | Failed SHA checkout leaves a half-made project directory. |
| REWRITE | `cloneRepo: a missing branch name is a clone failure, a bad ref never runs, a timeout says so` | Keep missing-branch status, pre-execution invalid-ref rejection and timeout kind/status; remove upstream sentence fragment matching. |
| KEEP | `listPullRequests resolves the account's provider and repo from any URL form` | Account-bound/anonymous listing resolves wrong forge, repo or authorization. |
| KEEP | `listPullRequests refuses a URL the account's provider cannot parse, and anonymous unknown hosts` | Cross-provider URL or unsupported anonymous host leaks a token/request. |
| REWRITE | `an abbreviated commit no ref resolves fails clearly and removes the clone (never fetches a prefix)` | Keep caller status, no prefix fetch and filesystem cleanup; remove incidental diagnostic wording. |

## `apps/daemon/src/accounts-schema.test.ts`

Family: **config**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `legacy github account payload migrates (githubLogin→login, githubKeyId→remoteKeyId, provider default)` | Legacy GitHub identity or numeric key ID is lost during migration. |
| KEEP | `new-shape bitbucket-server account round-trips` | DC instance/SSH coordinates are lost in accepted stored records. |
| KEEP | `already-migrated payload is untouched (idempotent)` | An existing native Github record without legacy mirrors must load unchanged. The serialization roundtrip includes githubLogin/githubKeyId mirrors, so it would not catch a parser that accidentally requires those legacy fields; the literal migratedConfig without mirrors is an independent storage compatibility oracle. |
| KEEP | `serialize mirrors githubLogin/githubKeyId on github records for old-daemon compat` | Rollback cannot read persisted GitHub identity/key mirrors. |
| KEEP | `serialize does not mirror legacy fields onto bitbucket records` | Bitbucket records are mislabeled with legacy GitHub fields. |
| KEEP | `serialize→parse round-trips to the identical config` | Serializing then loading loses persisted account data. |
| KEEP | `serialize skips a non-numeric remoteKeyId (old schema required a number)` | Non-numeric remote key ID writes an invalid old-schema number. |

## `apps/daemon/src/agent-account-identity.test.ts`

Family: **identity**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `returns null for unknown shapes` | Unrecognized credentials are assigned a provider. |
| KEEP | `codex identity from id_token JWT and account_id` | Explicit Codex account identity is replaced by a conflicting JWT claim. |
| KEEP | `codex accountId falls back to JWT chatgpt_account_id` | JWT-only account IDs are lost, defeating usage identity comparison. |
| KEEP | `detects grok by the issuer::client keyed entry with a key` | Grok credentials are missed or tokenless entries accepted. |
| KEEP | `grok identity prefers the auth.x.ai entry and reads email/user_id` | Multi-issuer Grok files choose the wrong identity or leak missing fields. |

## `apps/daemon/src/agent-account-paths.test.ts`

Family: **identity**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `passes for a well-formed owned home` | Legitimate owned account homes are rejected. |
| KEEP | `rejects a missing marker` | Unmarked homes can be mutated or removed. |
| KEEP | `rejects a marker with the wrong id` | A mismatched ownership marker authorizes another home. |
| KEEP | `rejects a symlinked home that escapes the accounts dir` | A symlink redirects account writes/removal outside the owned root. |

## `apps/daemon/src/agent-account-refresh.test.ts`

Family: **identity**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `selects idle accounts with soon/unknown expiry, skips live and far-future` | Idle refresh selects active/far-future accounts or misses unknown expiry. |
| KEEP | `mergeClaudeRefreshedCreds preserves other fields` | Claude refresh discards scopes/subscription metadata. |
| KEEP | `mergeClaudeRefreshedCreds converts expires_in to an absolute expiresAt (ms)` | Seconds-to-milliseconds expiry conversion leaves a fresh token already expired. |
| KEEP | `refreshClaudeToken maps a 200 body` | Claude token response drops usable rotated token fields. |
| KEEP | `refreshClaudeToken flags invalid_grant` | Claude invalid_grant does not request reauthentication. |
| KEEP | `refreshClaudeToken parses expires_in` | Relative expiry is lost before credential persistence. |
| DELETE | `refreshCodexToken maps a 200 body` | An idle-account refresh already checks the same HTTP token pair through actual auth.json persistence. Transfer its only additional contract (new id_token) to that existing service case with a deliberately changed identity; delete this redundant direct response echo. |
| KEEP | `refreshCodexToken flags invalid_grant` | Codex invalid_grant does not request reauthentication. |
| KEEP | `mergeCodexRefreshedTokens preserves account_id and overwrites tokens` | Codex refresh erases account identity or unrelated native auth fields. |

## `apps/daemon/src/agent-accounts.test.ts`

Family: **identity**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `import a codex blob derives identity and writes a 0700 home + marker` | Imported Codex identity/native token persistence or private home ownership is wrong. |
| KEEP | `import claude requires a label and stores subscriptionType as plan` | Claude unlabeled import accepted or plan/refresh token lost. |
| KEEP | `resolveLaunchEnv selects Claude/Codex homes and unsets competing API credentials` | Wrong CLI home or ambient API credentials causes launches to use/bill the wrong subscription; literal native environment keys and unset lists are the oracle. |
| KEEP | `resolveLaunchEnv falls back to the default account, then System(null)` | Default account resolution or unmanaged System fallback is wrong. |
| KEEP | `resolveLaunchEnv returns the EFFECTIVE account id (explicit and default)` | Session binding misses effective default/explicit identity, allowing live token refresh. |
| KEEP | `resolveLaunchEnv honors the SYSTEM_ACCOUNT_ID sentinel over a default` | Explicit System selection incorrectly inherits a managed default. |
| KEEP | `remove deletes the home and clears it from defaults` | Account removal leaves home or dangling default. |
| KEEP | `index and API responses carry no token material` | Credential token leaks into account index or API response. |
| REWRITE | `ensureFreshForUsage refreshes an idle Codex account whose token is expiring` | Persist a deliberately new id_token as well as access/refresh tokens and preserved account_id. This absorbs the deleted direct refresh success test without adding a separate fixture or mocking storage. |
| KEEP | `ensureFreshForUsage does not refresh an account with a live session` | Live CLI account has its single-use refresh token consumed by daemon. |
| KEEP | `ensureFreshForUsage skips a token that is not near expiry` | Far-future token is needlessly rotated. |
| KEEP | `an account the retired model proxy owned is refreshed by the account service again` | Legacy proxyOwned stored field prevents account service from refreshing. |
| KEEP | `resolveLaunchEnv seeds a Claude home: onboarding, mcps, stripped identity, symlinked skills/plugins` | New Claude home loses onboarding/MCP/profile resources or inherits another login. |
| KEEP | `Claude re-sync refreshes mcpServers but preserves the account's own identity` | Subsequent Claude launch overwrites account identity or retains obsolete MCPs. |
| KEEP | `resolveLaunchEnv seeds a Codex home: symlinked config.toml + migration markers` | Codex launch loses shared config or onboarding migration markers. |
| KEEP | `resolveLaunchEnv shares Claude settings.json (symlink, replaces a stale real file)` | Stale Claude account settings mask shared user hooks. |
| KEEP | `resolveLaunchEnv shares Codex config.toml + hooks.json (replaces stale real files)` | Stale Codex account config/hooks mask shared configuration. |
| KEEP | `resolveLaunchEnv shares chat history: symlinks projects/ (Claude), merging a non-empty home in` | Whole account project directories absent from the shared store must move intact and system history must remain readable through the account home. The colliding-project case exercises file-level moves inside an existing shared directory, so it cannot detect directory-specific skipping or loss of a noncolliding project. |
| KEEP | `resolveLaunchEnv symlinks an empty/absent Codex sessions/ to the shared store` | Codex accounts cannot resume shared session history. |
| KEEP | `shared history recursively merges a COLLIDING project dir, then symlinks` | Colliding history directories lose one account’s sessions. |
| KEEP | `import a grok auth.json derives identity and resolves GROK_HOME at launch` | Grok import loses native identity or launches under ambient XAI_API_KEY. |
| KEEP | `Claude: CLAUDE.md is linked even before it exists (a dangling link reads as missing) and commands/ is created 0700` | New instructions/commands fail to reach an already-launched managed account. |
| KEEP | `Claude: an account's own CLAUDE.md moves to the shared path when the owner has none` | Account-only instructions are discarded instead of adopted. |
| KEEP | `Claude: a differing CLAUDE.md keeps the owner's and saves the account's beside it; an identical one is dropped` | Conflicting instruction files lose data or identical files create spurious conflicts. |
| KEEP | `Claude: a real commands/ merges in — unique moved, identical dropped, a collision kept as <name>-<id8>` | Command merge loses unique/colliding content. |
| KEEP | `Claude: a symlink pointing elsewhere is replaced by the shared link` | Incorrect existing command link keeps account on wrong profile. |
| KEEP | `Codex: skills/ merges user skills, drops the account's bundled .system when the shared dir has one` | Bundled skills overwrite newer shared copies or user skills are lost. |
| KEEP | `Codex: AGENTS.md is shared — linked even before it exists, and an account's own copy moves across` | Codex global instructions fail to propagate. |
| KEEP | `Codex: the account's .system moves across when the shared skills/ has none; an absent shared dir is created` | Codex bundled skills vanish when shared copy absent. |
| KEEP | `Grok: AGENTS.md, commands/ and rules/ are shared; agents/ is not` | Grok instructions/commands/rules fail to share or unrelated agents leak. |
| KEEP | `nothing is linked into an agent home the daemon user does not have` | Launch creates an unwanted system agent home. |
| KEEP | `Claude: two accounts launched at once both keep their own command and CLAUDE.md (no move overwrites another)` | Concurrent account launches overwrite each other’s instructions/commands. |
| KEEP | `Claude: overlapping launches of one account never drop the owner's shared commands` | Overlapping same-account sync deletes owner’s shared commands. |
| KEEP | `Claude: a shared CLAUDE.md that is itself a link (dotfiles) is compared by what it names` | Dotfiles symlink is destroyed or identical content falsely conflicts. |
| KEEP | `Claude: an account copy never replaces a dangling shared CLAUDE.md link` | Dangling owner instruction link is replaced, losing intended dotfiles path. |

## `apps/daemon/src/grok-device-auth.test.ts`

Family: **grok**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `device tokens become a CLI-shaped auth.json with identity from the id_token` | Granted OAuth tokens have unusable native auth key/expiry/identity format. |
| KEEP | `identity is optional: no id_token still yields an importable credential` | A valid grant without identity fields cannot be imported. |

## `apps/daemon/src/grok-device-link.test.ts`

Family: **grok**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `a granted link imports the tokens as a managed grok account` | Granted device flow fails to persist a managed account or exposes wrong link status. |
| KEEP | `a start failure is an upstream result carrying the status, and leaves nothing pending` | Upstream device-start failure is reported as success/pending. |
| KEEP | `a second start while one is pending is a conflict; cancel drops it locally` | Repeated starts replace active device code or cancelled grant imports an account. |
| KEEP | `a failed verdict lands on lastError and a fresh attempt clears it` | Authorization denial is hidden or old failure persists across fresh retry. |
| KEEP | `a failed import is reported as the link's error` | Failed credential persistence reports a successful linked account. |

## `apps/daemon/src/providers/bitbucket-cloud.test.ts`

Family: **provider**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `parseRepoUrl accepts bitbucket.org https/ssh (old + new host)/shorthand` | Supported repository URL loses owner/repo or cross-forge URL is accepted. |
| KEEP | `parseRepoUrl accepts the https form with the embedded username the Clone dialog copies` | Clone-dialog userinfo breaks DC parsing or bypasses instance anchoring. |
| KEEP | `cloneUrls always emits the NEW ssh host` | Clone URL uses retired SSH hostname. |
| KEEP | `toCloudRepoSummary rewrites the API's (possibly stale) ssh host and maps fields` | Repo listing retains stale SSH host/embedded userinfo or loses public repo fields. |
| KEEP | `credentialSpec uses the static token username; sshProbe parses the Cloud greeting` | Git auth username/SSH target/greeting parser is incompatible with Cloud. |

## `apps/daemon/src/providers/bitbucket-server.test.ts`

Family: **provider**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `parseRepoUrl accepts scm/ssh/browse/personal/shorthand forms anchored to the account` | DC URL grammar loses context/personal project or accepts other host. |
| KEEP | `parseRepoUrl accepts the https form with the embedded username the Clone dialog copies` | Clone-dialog userinfo breaks DC parsing or bypasses instance anchoring. |
| KEEP | `pickCloneUrls tolerates name:'http' meaning https and missing ssh` | Native http clone label or one-transport instance becomes uncloneable. |
| KEEP | `an SSH-only instance (HTTP(S) SCM disabled) still yields clone URLs and repo rows` | SSH-only repository omitted or uncloneable record breaks picker. |
| KEEP | `ssh:// URLs parse against the baseUrl host when sshHost was never resolved` | Fresh account without known sshHost cannot clone its instance SSH URL. |
| KEEP | `resolveDcLogin trusts the instance's X-AUSERNAME over the typed username` | Token for another/anonymous user is trusted as typed user. |
| KEEP | `credential host includes non-standard ports; strips creds embedded by the API` | Nonstandard HTTPS port is omitted from credential lookup. |
| KEEP | `ed25519 version gate` | Old DC instance is assigned unsupported Ed25519 keys. |
| KEEP | `sshProbe uses the account sshHost and reports HTTPS-only when absent` | SSH probe hits wrong host/port or claims HTTPS-only instance supports SSH. |

## `apps/daemon/src/providers/credential-line.test.ts`

Family: **provider**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `encodes reserved characters in username and token` | Reserved token bytes corrupt git credential-store URL. |
| KEEP | `keeps a DC port in the host` | Custom HTTPS port is lost in persisted credential lookup. |

## `apps/daemon/src/providers/github.test.ts`

Family: **provider**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `parseRepoUrl accepts https, ssh and shorthand forms` | Supported GitHub URL grammar loses repo identity or accepts another forge. |
| KEEP | `credentialSpec and sshProbe match today's behavior` | GitHub SSH authentication cannot recognize verified login or uses wrong target. |
| KEEP | `cloneUrls derives both transports` | GitHub clone URL is unusable for one transport. |

## `apps/daemon/src/providers/polling.test.ts`

Family: **provider**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| REWRITE | `github: pulls map open/merged/closed, newest-updated first, with the ETag` | GitHub PR mapping must preserve states/body/identity/ETag and request every state ordered newest-updated first. Retain literal normalized fixture data; parse URL query parameters so a behavior-preserving parameter reorder does not fail. |
| KEEP | `github: a matching ETag is sent as If-None-Match and a 304 is notModified` | Conditional poll omits If-None-Match or treats 304 as failure. |
| KEEP | `github: anonymous reads send no Authorization header` | Anonymous GitHub API request includes Authorization. |
| KEEP | `github: releases map drafts, prereleases and a nameless release` | Release drafts/prereleases/nameless titles or publication times are wrong. |
| KEEP | `github: a spent rate limit is a 429 rate_limited error with the reset` | Spent GitHub quota does not tell poller to back off. |
| KEEP | `github: a bad token is a 400 auth error; a missing repo a not_found` | Bad token and missing repo return indistinguishable errors. |
| REWRITE | `bitbucket cloud: pullrequests map OPEN/MERGED/DECLINED with the abbreviated head hash` | Cloud PR mapping must preserve state/abbreviated SHA/auth/destination and request all three states. Retain literal normalized fixture data; compare state parameter values independent of query ordering. |
| KEEP | `bitbucket cloud: a token without read:pullrequest is a missing_scope error` | Missing pullrequest scope fails to produce actionable scope error. |
| KEEP | `bitbucket cloud: a plain 401 stays an auth error; anonymous and 304 work` | Cloud auth failure/anonymous conditional requests are mishandled. |
| KEEP | `bitbucket cloud and server have no releases` | Bitbucket unsupported release feature issues network requests or errors. |
| KEEP | `bitbucket server: pull-requests map states and sort by updatedDate` | DC PR states/data/timestamp sort are wrong; fixed provider fixture records must yield the independently listed newest-first DTOs and account authentication. |
| KEEP | `bitbucket server: every OPEN page is read (a long-lived PR never drops off) and a PR last seen open is looked up` | Old open PR or newly merged known PR disappears from polling. |
| KEEP | `bitbucket server: needs an account; personal projects keep the ~; a 403 is auth` | DC account requirement/personal-project URL/auth error is wrong. |
| KEEP | `retryAfterMs reads seconds and HTTP dates` | Retry-After seconds/date/unreadable forms schedule incorrect retries. |

## `apps/daemon/src/providers/ttl-cache.test.ts`

Family: **cache**. Risk: cross-account listing leakage, stale newly created repositories, excess upstream requests or failures that never recover. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `returns the cached value within the TTL and refetches after it expires` | Fake time 999 ms then 1001 ms around a caller-supplied 1000 ms TTL must return v1 then v2; catches excessive re-fetches and indefinitely stale listings without asserting internal storage. |
| KEEP | `keys are independent and invalidate() drops a single key` | Credential-key a must return its new value after invalidation while credential-key b retains its own prior value; catches cross-account data reuse and invalidating all or no listings. |
| KEEP | `a failed fetch is not cached` | A rejected listing followed by successful value ok must recover; catches a transient provider failure poisoning the picker until process restart. |

## `apps/daemon/src/usage-aggregate.test.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `worst-account picks the highest-percent window per field across accounts` | Pooled session/weekly quotas choose the wrong independent account maximum. |
| KEEP | `System base participates in the pool and can be the worst source` | System source is omitted from pooled warning. |
| KEEP | `carries the resets/capacity of the chosen worst window and its freshness` | Chosen window loses reset/capacity or freshness timestamp. |
| KEEP | `null windows everywhere leave head windows null and mark stale` | No usable windows falsely show a fresh reading. |
| KEEP | `an expired window (resetsAt in the past) never wins the worst-account pick` | Reset 100% quota continues to dominate current pooled usage. |
| KEEP | `windows that all expired leave the head window null` | All expired windows continue showing exhausted quota. |
| KEEP | ``the System base is exposed as a `system` row (expired windows scrubbed)`` | System breakdown displays stale pre-reset quota. |
| KEEP | `no System base ⇒ no system row` | Managed-only account set invents a System row. |
| KEEP | `head is not stale when a fresh window is shown even if another account is stale` | One stale account greys a fresh pooled reading. |

## `apps/daemon/src/usage-claude-state.test.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `asks the endpoint at most once per window, even with nothing to show` | Burst requests exceed five-minute provider budget. |
| KEEP | `a restart keeps the last reading and waits out the window the previous process opened` | Restart loses last reading or repeats recently budgeted request. |
| KEEP | `a 429's Retry-After survives a restart and the last reading is served greyed meanwhile` | Retry-After/grey stale value is forgotten on restart. |
| KEEP | `a live reading replaces the account windows, keeps the scoped ones, and skips the poll` | Out-of-order live data overwrites fresh usage or unnecessary endpoint poll occurs. |
| KEEP | `a live reading on an account with no reading yet stands on its own` | Fresh live-only quota remains unavailable before endpoint reading. |
| KEEP | `a stamp from the future (the clock moved back) does not block the endpoint` | Clock rollback permanently blocks polling. |
| REWRITE | `UsageStateFile round-trips, drops what does not parse and moves a corrupt file aside` | Read the persisted version through JSON.parse instead of a compact-JSON substring; preserve version-1 codec, tolerant records and corrupt-file recovery assertions. |
| KEEP | `a thread's live windows become the account's session and weekly readings` | Thread provider usage windows map/clamp to wrong account slots. |

## `apps/daemon/src/usage-codex-wham.test.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `maps plan_type and primary/secondary windows` | WHAM payload maps plan/window/reset into wrong API fields. |
| KEEP | `week-only primary_window (7d limit, no secondary) → weekly slot` | Week-only plan incorrectly consumes session slot. |
| KEEP | `unparseable payload → available:false` | Unrecognized WHAM body falsely reports available quota. |

## `apps/daemon/src/usage-expiry.test.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `parseClaudeUsage drops a window whose reset time has already passed` | Parsed already-reset Claude window still reports exhausted quota. |
| KEEP | `expired-token lastGood serves only windows that have not reset yet` | Cached last-good reading outlives quota reset while token prevents refetch. |

## `apps/daemon/src/usage-first-reading.test.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `whenFirstReading waits for the first reading after start, and is bounded` | Workflow startup reads empty usage before source completes or waits beyond bound. Use the fake clock to assert the timeout bound; remove the real 5 ms wait and keep-alive interval. Keep the deferred-source completion contract. |

## `apps/daemon/src/usage-parse.check.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

Substantive check-script scenarios appear below.

## `apps/daemon/src/usage-scoped.test.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `parseClaudeUsage surfaces a model-scoped weekly limit alongside the legacy windows` | Legacy quota fields mask concurrent model-scoped cap. |
| KEEP | `parseClaudeUsage drops scoped windows that are unlabeled, expired, or garbage` | Unlabeled/expired/garbage scoped window renders as valid quota. |
| KEEP | `parseClaudeUsage keeps scoped windows in the limits[]-only shape too` | Limits-only response loses model cap. |
| KEEP | `aggregateWorstAccountUsage carries scoped windows on account rows and the system row` | Account/System scoped cap or its expiry disappears during aggregation. |
| KEEP | `stale last-known reading drops scoped windows whose reset has passed` | Expired cached model cap remains exhausted when token prevents fetch. |

## `apps/daemon/src/usage-sources.check.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

Substantive check-script scenarios appear below.

## `apps/daemon/src/usage-system-visibility.test.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `claude: expired system credentials hide the System row` | Expired Claude System login creates permanent empty row. |
| KEEP | `claude: unexpired system credentials keep the System row` | Valid Claude System quota is hidden. |
| KEEP | `codex: system account matching a managed account_id hides the System row` | Duplicate Codex account-ID quota gets rendered twice. |
| KEEP | `codex: system account matching a managed email (no account_id) hides the System row` | Duplicate JWT-email Codex quota gets rendered twice. |
| KEEP | `codex: a distinct, unexpired system account keeps the System row` | Distinct valid Codex System quota is hidden. |
| KEEP | `codex: an expired system token hides the System row even with a distinct identity` | Expired distinct Codex System token creates empty quota row. |
| KEEP | `codex: missing auth.json does not hide (source already reports null/scrape)` | Missing Codex credentials suppress legitimate rollout fallback. |

## `apps/daemon/src/usage-tokens.test.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

| Disposition | Exact original test | Concrete failure, independent oracle or deletion/coverage reason |
| --- | --- | --- |
| KEEP | `1h-TTL cache writes bill at 2x input, 5m at 1.25x` | Billing a 400k 1h subset twice or at the 5m multiplier misstates cost; the independent 600k×6.25 + 400k×10 per-million tariff arithmetic yields $7.75. |
| KEEP | `unknown model yields null cost` | An unknown model must not invent an estimated dollar price; null is required by UsageTokenRow.costUsd rather than a fabricated numeric zero. |
| KEEP | `versioned model ids stay priced (F1)` | Versioned transcript model identifiers lose known API-equivalent pricing; known dated/preview IDs must yield a price while the separate unknown-model case yields null. |
| KEEP | `scanCodex reads the real event_msg/token_count/info shape and sums per-turn usage` | Codex cached-input tokens are charged as ordinary input or per-turn sums wrong. |
| KEEP | `scanClaude reads the 1h cache-write split and skips zero-usage rows` | Claude cache TTL split/zero synthetic entries are misread. |
| KEEP | `scanClaude dedupes repeated message.id+requestId across files (F2)` | Resumed/branched transcript copies double-count turns. |
| KEEP | `recompute caches unchanged files and stays correct on partial rescan (F5)` | Partial rescan loses or double-counts previously read turns. |
| KEEP | `a truncated/rewritten file is fully re-parsed` | Truncated transcript leaves deleted turns in totals. |
| KEEP | `codex parser state (model, cumulative gate) carries across appended chunks` | Appended Codex chunk loses model or counts repeated cumulative event. |
| KEEP | `an unterminated tail line is counted once, then not double-counted when completed` | Completing an unterminated JSONL row double-counts it. |
| KEEP | `managed-account home transcripts are counted with and without a system home` | Managed-only transcripts disappear or mixed managed/system transcripts are double-counted; literal 9/2 then 13/3 token totals are the oracle. |

## `apps/daemon/src/usage.check.ts`

Family: **usage**. Risk: loss of the concrete protocol, security, storage or caller behavior below if misclassified. Validation: focused Node test with daemon import hooks (command below); check scripts run as standalone processes.

Substantive check-script scenarios appear below.

## Check scenarios: `apps/daemon/src/usage.check.ts`

Each KEEP/REWRITE uses all six **usage** bars above; sources and numeric/native fixtures are explicit in the row.

| Disposition | Scenario | Concrete failure / oracle / remaining owner |
| --- | --- | --- |
| KEEP | `initial enabled snapshot/change notification` | Configured Claude/Codex sources appear and first snapshot emits data; literal provider IDs and one first event are observable UsageService API outputs. |
| KEEP | `unchanged recompute deduplication` | Identical payload must not rebroadcast; event subscriber sees one event after a second recompute. |
| KEEP | `per-agent disabled snapshot` | A disabled Codex provider must disappear while enabled Claude remains. |
| KEEP | `globally disabled snapshot` | Global disabled preference returns no agents regardless of readable source data. |
| KEEP | `missing Claude credential source` | A null source is omitted without masking the available Codex source. |

## Check scenarios: `apps/daemon/src/usage-parse.check.ts`

Each KEEP/REWRITE uses all six **usage** bars above; sources and numeric/native fixtures are explicit in the row.

| Disposition | Scenario | Concrete failure / oracle / remaining owner |
| --- | --- | --- |
| KEEP | `Claude legacy shape` | Fixed five_hour/seven_day native payload yields session=45 and weekly=69 plus the Max 20x plan. |
| KEEP | `Claude limits[] shape` | Alternate limits[] protocol yields session=45 and weekly=69 independently of legacy keys. |
| KEEP | `utilization epoch leak #52326` | A reset epoch in utilization is discarded, preserving the valid weekly=69 sibling. |
| KEEP | `Codex primary/secondary duration` | Native window_minutes 300/10080 classify session=3 and weekly=37. |
| KEEP | `Codex week-only primary` | A sole 10080-minute primary window maps to weekly=33 and absent session. |
| KEEP | `Codex reset-distance fallback` | Missing duration plus next-day reset maps weekly=40 rather than a 5h session. |
| KEEP | `Codex expired secondary` | Expired weekly quota is omitted while valid session=3 survives. |
| KEEP | `last token_count and garbage lines` | Last native rate-limit event wins (9), intervening unrelated/malformed lines do not fabricate data. |
| KEEP | `Grok weekly billing pool` | Credit usage 22.4 and native currentPeriod.end become weekly only with the supplied tier. |
| KEEP | `Grok proto3 omitted percent` | A live period with omitted percent means a real zero reading, not missing quota. |
| KEEP | `Grok expired/malformed billing` | Past period and invalid/null bodies return unavailable rather than an invented current limit. |

## Check scenarios: `apps/daemon/src/usage-sources.check.ts`

Each KEEP/REWRITE uses all six **usage** bars above; sources and numeric/native fixtures are explicit in the row.

| Disposition | Scenario | Concrete failure / oracle / remaining owner |
| --- | --- | --- |
| REWRITE | `Claude first 429 remains signed in and backs off` | Keep first-429 available/stale/plan/no-window output; delete the extra immediate-call counter/backoff scenario, already more strongly covered over explicit time boundaries by usage-claude-state.test.ts. |
| KEEP | `Claude no credentials` | Missing native credential file is null, unlike the signed-in 429 placeholder. |
| KEEP | `Codex newest empty log fallback` | On endpoint 500, newer metadata-only rollout cannot hide an older real quota (3/37). |
| KEEP | `Codex API-key mode` | An API-key auth.json suppresses subscription quota even when rollouts exist. |
| KEEP | `Codex missing auth and missing access token` | Absent auth or empty tokens still allow a real existing rollout quota; prevents lost usage after credential reset. |
| KEEP | `Grok no credentials anywhere` | No native managed or system auth file yields null rather than a fabricated account. |
| KEEP | `Grok managed native billing and secret-free payload` | Selected authFile drives Bearer/user-id/client request headers and 22.4 quota; token/user-id must be absent from public serialized data. |
| KEEP | `Grok expired managed credentials` | Expired native grant remains linked/stale and sends zero upstream requests. |
| KEEP | `Grok 429 last-good/backoff` | Successful 50 reading survives later 429 as stale; next immediate read must not retry. |
| KEEP | `Grok CLI /user lookup cached` | Missing user-id resolves through /user, billing still yields 3, and later read reuses resolved identity. |
| KEEP | `Claude environment then explicit home precedence` | CLAUDE_CONFIG_DIR selects a real Pro account; an explicit empty managed home overrides it. |
| KEEP | `Codex explicit home precedence` | Explicit home with actual rollout=9 overrides CODEX_HOME pointing to API-key mode; neither wrong home can satisfy the positive reading. |

## Support and production seam cleanup

- No production seam or support file becomes unused after the duplicate-case deletion. TtlCache remains: its real Bitbucket provider callers were verified with `rg --text` and source review. Both its implementation and all three contract tests are unchanged in the final diff.
- Remove deleted-test-only imports and helper bookkeeping. Keep AccountsExec: retained tests observe the real git/SSH protocol boundary; other process seams and injected clocks are still used by live service composition or necessary stable external-boundary checks. No new seam is added.
- All five polling JSON fixtures remain referenced by distinct HTTP mapping/scope-error tests; no snapshot or fixture becomes unused through these deletions.
- No production behavior is changed to preserve an assertion. No shared owner edit is required.

## Validation

From `apps/daemon`, baseline/final focused command uses `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 <surviving scope-19 .test.ts files>`. The three check scripts use the same imports without `--test`. Baseline log: `/tmp/orquester-test-audit/scope-19-baseline.log`. Root owns repository `pnpm check`, `pnpm test`, final commit/integration/push. No live daemon is run.

Completed focused verification:

- Main focused run: **163/163 passed**, zero failures/skips/cancellations, exit 0 (`scope-19-final.log`, 176.4 s). Two provisionally deleted storage cases were then restored after coverage review.
- Final storage follow-up: **42/42 passed**, covering all restored schema/account tests plus the changed persisted-id-token case (`scope-19-restored-storage.log`, 16.7 s). Together the two runs cover all **165 final named cases**.
- `usage-parse.check.ts`, `usage-sources.check.ts`, `usage.check.ts`: each exited 0 with its OK marker; all 28 documented scenarios run.
- Final `git diff --check`: exit 0. Named-case reconciliation against `/tmp/orquester-test-audit/cases.json`: 166 rows, every DELETE absent and every KEEP/REWRITE present; no omissions or mismatches.
- Final changed-test diff reviewed. `rg --text` verifies surviving production refresh/cache callers. TtlCache implementation and tests have no final diff. No unused support or seam was introduced or retained solely for a deleted test.
- The baseline attempt was interrupted by the orchestration crash before completion; its partial log is not claimed as a passing baseline. No retained-case failure was observed in the completed focused runs.

Root performs required repository typecheck/test gates and integration/commit/push. This scope did not run the live daemon, remote provider network, deployment or destructive account operations outside temporary fixtures.
