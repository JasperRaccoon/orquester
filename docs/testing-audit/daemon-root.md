# Daemon root test audit

68 baseline daemon root files: 65 node:test files / 577 source declarations, plus 3 standalone scripts / 29 scenarios. Dynamic table declarations are counted once; byte/name rows remain in the retained source tables.

Baseline commit: `beb7516b10a3c4472399e0f6f2f2b0a187a61186`. Dispositions include baseline participants rather than newly counted replacement scenarios. Each case row is combined with its file evidence for all six behavioral criteria. Original report text is corroborating context; current source/actions/assertions and production callers were reviewed again.

Node declarations: {'KEEP': 503, 'REWRITE': 5, 'DELETE': 4, 'OPTIMIZE': 57, 'CONSOLIDATE': 8}. Standalone scenarios included in total: {'KEEP': 519, 'REWRITE': 5, 'DELETE': 4, 'OPTIMIZE': 70, 'CONSOLIDATE': 8}. Eleven daemon declarations disappear: four DELETE, four search consolidation participants, and three moved timeout participants; one new config survivor is counted by the config owner.

Net daemon-root test LOC: 13,323 → 13,246 (−77). Changes remove exact copy/private argv/object-identity/cut-window coupling, consolidate five equivalent default searches into one, and place timeout schema checks at their configuration owner. Real Git/PTY/tmux/process, migration/security and provider-native usage contracts remain. No dependency, snapshot or fixture artifact became orphaned. Removed production exports are `gitSafetyArgs` and `savedPromptWorkflowUses`; their production bodies/callers remain unchanged.

Fixture resource cleanup uses an immutable file-specific parent and distinct per-case temporary subdirectories. No mutable service/database/files are reused across cases. Final cleanup may add filesystem work, so this is not reported as an execution speedup. The same-account concurrent config-merge case deliberately keeps its 40 event-loop interleavings: losing owner commands remains a real failure and a replacement filesystem timing seam would risk new flakiness.

Root owns full baseline/final measurements and validation scheduling. No tests or typechecks have been run by this agent yet. JSON includes only unambiguous individual baseline timings observed in the original-tree run; absence means unmeasured, and no full-suite speedup is claimed.

## apps/daemon/src/accounts-clone-url.test.ts

**Independent contract:** README Git hosting identities and secrets-stay-home; GitProvider/CloneOptions/GitRemoteError wire contracts in providers/types.ts; git ls-remote/clone native output and credential-file format.

**Stable seam and callers:** AccountsService public clone/list/lsRemote results, actual temporary checkout paths and git subprocess argv/environment, or config parse/serialize API. AccountsService is called by daemon project/account routes and workflow remote-git operations.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Fixed native stdout/SSH failures, literal object/error fields, checked filesystem bytes and expected credential routing. Provider parser tests do not cover account-specific identity/CA/cleanup; service tests do not enumerate provider-native formats.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/accounts-clone-url.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 36 | prefers SSH when the account's key is installed on the provider | KEEP | A key-ready account selects unusable HTTPS instead of SSH. |
| 43 | falls back to HTTPS while a DC key upload is still pending | KEEP | A pending manual SSH key blocks project creation instead of using HTTPS. |
| 50 | uses whichever transport exists when only one is offered | KEEP | A single offered transport is rejected, or no transport silently invokes git. |
| 64 | a created repo whose SSH key is refused is cloned over its reported HTTPS URL | KEEP | An SSH-denied newly created repo must retry the HTTPS URL supplied by its provider; deriving another URL breaks DC context paths. |
| 71 | with no token, a refused key is retried over HTTPS only for a repo known to be public | KEEP | A tokenless private repository must fail closed after SSH refusal; only a known public repository may retry anonymously over HTTPS. |

## apps/daemon/src/accounts-remote.test.ts

**Independent contract:** README Git hosting identities and secrets-stay-home; GitProvider/CloneOptions/GitRemoteError wire contracts in providers/types.ts; git ls-remote/clone native output and credential-file format.

**Stable seam and callers:** AccountsService public clone/list/lsRemote results, actual temporary checkout paths and git subprocess argv/environment, or config parse/serialize API. AccountsService is called by daemon project/account routes and workflow remote-git operations.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Fixed native stdout/SSH failures, literal object/error fields, checked filesystem bytes and expected credential routing. Provider parser tests do not cover account-specific identity/CA/cleanup; service tests do not enumerate provider-native formats.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/accounts-remote.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 131 | lsRemote over SSH pins the account key, BatchMode, no prompt, 30 s, no shell | KEEP | Remote reads use ambient SSH identity, prompt indefinitely, expose tokens or misconfigure the git transport. |
| 156 | lsRemote over HTTPS uses the credential store and the DC CA bundle; defaultBranch:false narrows | KEEP | HTTPS reads ignore account credential store/custom CA or requested default-branch scope. |
| 174 | lsRemote on a Bitbucket account pins the daemon-owned known_hosts | KEEP | Bitbucket SSH reads lose daemon-owned host verification. |
| 183 | lsRemote anonymously resets every credential helper | KEEP | Anonymous HTTPS accidentally invokes an ambient credential helper. |
| 189 | lsRemote refuses an anonymous SSH read (it would offer this host's own keys) and points at https | KEEP | Anonymous SSH offers host keys. |
| 199 | lsRemote refuses unsafe URLs before running anything | KEEP | Untrusted URL invokes git option/file/remote-helper execution. |
| 209 | lsRemote classifies failures: auth, not found, timeout — and redacts userinfo | KEEP | Auth/not-found/timeouts are misclassified or credential userinfo leaks. |
| 250 | cloneRepo without options is the New Project dialog's clone: no ceiling, git's prompting untouched | KEEP | Interactive clones inherit unattended prompt/time restrictions or wrong account key. |
| 261 | an unattended clone (a workflow's) gets a prompt-free env and a 10 min ceiling | KEEP | Workflow clone hangs for input or has no timeout bound. |
| 268 | cloneRepo removes the clone when the sha cannot be checked out | KEEP | Failed SHA checkout leaves a half-made project directory. |
| 285 | cloneRepo: a missing branch name is a clone failure, a bad ref never runs, a timeout says so | KEEP | Invalid refs execute git, or missing refs/timeouts get wrong caller error. |
| 313 | isSshKeyRefusal tells an SSH-layer refusal from a repository's answer | KEEP | Distinct native publickey/host-key/too-many-auth failures must trigger transport fallback, while repository authorization and DNS failures must not. |
| 324 | a clone whose SSH key is refused is retried once over HTTPS through the credential store | REWRITE | Retain public fallback transport/name, two Git invocations, cleanup-before-retry, credential store and secret privacy. Require a notice without freezing incidental English wording. |
| 357 | a clone that went through over SSH says so | KEEP | Successful SSH cloning must report the selected transport without an unnecessary second clone. |
| 363 | no HTTPS retry for a failure that is not a key refusal, nor for an account with no token | KEEP | Repository-not-found errors and tokenless accounts must not cause an unauthorized HTTPS fallback. |
| 380 | when the HTTPS retry fails too, both failures are reported | KEEP | If both transports fail, the caller must receive both actionable failure reasons instead of a misleading SSH-only error. |
| 410 | listPullRequests resolves the account's provider and repo from any URL form | KEEP | Account-bound/anonymous listing resolves wrong forge, repo or authorization. |
| 434 | listPullRequests refuses a URL the account's provider cannot parse, and anonymous unknown hosts | KEEP | Cross-provider URL or unsupported anonymous host leaks a token/request. |
| 446 | an abbreviated commit no ref resolves fails clearly and removes the clone (never fetches a prefix) | KEEP | Unresolvable abbreviated hash is fetched as a prefix or leaves cloned files. |

## apps/daemon/src/accounts-schema.test.ts

**Independent contract:** README Git hosting identities and secrets-stay-home; GitProvider/CloneOptions/GitRemoteError wire contracts in providers/types.ts; git ls-remote/clone native output and credential-file format.

**Stable seam and callers:** AccountsService public clone/list/lsRemote results, actual temporary checkout paths and git subprocess argv/environment, or config parse/serialize API. AccountsService is called by daemon project/account routes and workflow remote-git operations.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Fixed native stdout/SSH failures, literal object/error fields, checked filesystem bytes and expected credential routing. Provider parser tests do not cover account-specific identity/CA/cleanup; service tests do not enumerate provider-native formats.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/accounts-schema.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 17 | legacy github account payload migrates (githubLogin→login, githubKeyId→remoteKeyId, provider default) | KEEP | Legacy GitHub identity or numeric key ID is lost during migration. |
| 26 | new-shape bitbucket-server account round-trips | KEEP | DC instance/SSH coordinates are lost in accepted stored records. |
| 41 | already-migrated payload is untouched (idempotent) | DELETE | Fails unique protection: the identical migratedConfig fixture already round-trips at the stronger native serialization→parse boundary. Surviving owner: apps/daemon/src/accounts-schema.test.ts :: serialize→parse round-trips to the identical config. |
| 48 | serialize mirrors githubLogin/githubKeyId on github records for old-daemon compat | KEEP | Rollback cannot read persisted GitHub identity/key mirrors. |
| 56 | serialize does not mirror legacy fields onto bitbucket records | KEEP | Bitbucket records are mislabeled with legacy GitHub fields. |
| 67 | serialize→parse round-trips to the identical config | KEEP | Serializing then loading loses persisted account data. |
| 71 | serialize skips a non-numeric remoteKeyId (old schema required a number) | KEEP | Non-numeric remote key ID writes an invalid old-schema number. |

## apps/daemon/src/agent-account-identity.test.ts

**Independent contract:** README managed accounts and Agent config; AGENTS owned-home, single-use-token and secret-privacy rules; native Claude/Codex/Grok credential files; docs/superpowers/specs/2026-09-28-agent-profile-design.md §5.

**Stable seam and callers:** Credential codecs and ownership guard used by agent-accounts.ts/usage-sources.ts, and AgentAccountsService public import/remove/resolve/refresh API with real owned homes. Daemon routes, session launch and usage refresh consume these results.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal native credentials, public account metadata, env keys, file contents/modes and independently advanced expiry times. Codec cases own format-specific inputs; service cases own file/environment/lifecycle wiring; merges distinguish different-file, same-file and concurrent user-data loss.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-account-identity.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 10 | returns null for unknown shapes | KEEP | Unrecognized credentials are assigned a provider. |
| 15 | Claude login expiry uses the refresh lifetime, not routine access-token rotation | KEEP | Login metadata must use refresh-token lifetime when renewal exists; routine expired access tokens must not falsely request reauthentication. |
| 33 | codex identity from id_token JWT and account_id | KEEP | Explicit Codex account identity is replaced by a conflicting JWT claim. |
| 46 | codex accountId falls back to JWT chatgpt_account_id | KEEP | JWT-only account IDs are lost, defeating usage identity comparison. |
| 53 | detects grok by the issuer::client keyed entry with a key | KEEP | Grok credentials are missed or tokenless entries accepted. |
| 59 | grok identity prefers the auth.x.ai entry and reads email/user_id | KEEP | Multi-issuer Grok files choose the wrong identity or leak missing fields. |

## apps/daemon/src/agent-account-paths.test.ts

**Independent contract:** README managed accounts and Agent config; AGENTS owned-home, single-use-token and secret-privacy rules; native Claude/Codex/Grok credential files; docs/superpowers/specs/2026-09-28-agent-profile-design.md §5.

**Stable seam and callers:** Credential codecs and ownership guard used by agent-accounts.ts/usage-sources.ts, and AgentAccountsService public import/remove/resolve/refresh API with real owned homes. Daemon routes, session launch and usage refresh consume these results.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal native credentials, public account metadata, env keys, file contents/modes and independently advanced expiry times. Codec cases own format-specific inputs; service cases own file/environment/lifecycle wiring; merges distinguish different-file, same-file and concurrent user-data loss.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-account-paths.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 12 | passes for a well-formed owned home | DELETE | Fails unique protection: actual AgentAccountsService launch/remove workflows require the same marker-owned home to be accepted and prove useful effects; the helper-only success repeats that acceptance. Surviving owner: apps/daemon/src/agent-accounts.test.ts :: resolveLaunchEnv selects Claude/Codex homes and unsets competing API credentials; remove deletes the home and clears it from defaults. |
| 20 | rejects a missing marker | KEEP | Unmarked homes can be mutated or removed. |
| 27 | rejects a marker with the wrong id | KEEP | A mismatched ownership marker authorizes another home. |
| 35 | rejects a symlinked home that escapes the accounts dir | OPTIMIZE | A symlink redirects account writes/removal outside the owned root. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |

## apps/daemon/src/agent-account-refresh.test.ts

**Independent contract:** README managed accounts and Agent config; AGENTS owned-home, single-use-token and secret-privacy rules; native Claude/Codex/Grok credential files; docs/superpowers/specs/2026-09-28-agent-profile-design.md §5.

**Stable seam and callers:** Credential codecs and ownership guard used by agent-accounts.ts/usage-sources.ts, and AgentAccountsService public import/remove/resolve/refresh API with real owned homes. Daemon routes, session launch and usage refresh consume these results.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal native credentials, public account metadata, env keys, file contents/modes and independently advanced expiry times. Codec cases own format-specific inputs; service cases own file/environment/lifecycle wiring; merges distinguish different-file, same-file and concurrent user-data loss.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-account-refresh.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 17 | selects idle accounts with soon/unknown expiry, skips live and far-future | KEEP | Idle refresh selects active/far-future accounts or misses unknown expiry. |
| 31 | held accounts are renewed ahead of their CLI: inside the held margin and above the floor, known expiry only | KEEP | Protects the caller-visible outcome named here: held accounts are renewed ahead of their CLI: inside the held margin and above the floor, known expiry only. assert.deepEqual(picked, ["codex", "grok"]) |
| 48 | mergeClaudeRefreshedCreds preserves other fields | KEEP | Claude refresh discards scopes/subscription metadata. |
| 60 | mergeClaudeRefreshedCreds converts expires_in to an absolute expiresAt (ms) | KEEP | Seconds-to-milliseconds expiry conversion leaves a fresh token already expired. |
| 69 | refreshClaudeToken maps a 200 body | KEEP | Claude token response drops usable rotated token fields. Surviving owner: success token decoding also asserts expires_in from the native OAuth payload; expiry conversion/preservation remains independently tested below. |
| 82 | refreshClaudeToken flags invalid_grant | KEEP | Claude invalid_grant does not request reauthentication. |
| 91 | refreshCodexToken flags invalid_grant | KEEP | Codex invalid_grant does not request reauthentication. |
| 100 | mergeCodexRefreshedTokens preserves account_id and overwrites tokens | KEEP | Codex refresh erases account identity or unrelated native auth fields. |

## apps/daemon/src/agent-accounts-routes.test.ts

**Independent contract:** README managed accounts and Agent config; AGENTS owned-home, single-use-token and secret-privacy rules; native Claude/Codex/Grok credential files; docs/superpowers/specs/2026-09-28-agent-profile-design.md §5.

**Stable seam and callers:** Credential codecs and ownership guard used by agent-accounts.ts/usage-sources.ts, and AgentAccountsService public import/remove/resolve/refresh API with real owned homes. Daemon routes, session launch and usage refresh consume these results.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal native credentials, public account metadata, env keys, file contents/modes and independently advanced expiry times. Codec cases own format-specific inputs; service cases own file/environment/lifecycle wiring; merges distinguish different-file, same-file and concurrent user-data loss.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-accounts-routes.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 53 | an account a live session runs under is not deleted, and the tab is named | KEEP | Deleting an account used by a live tab must return 409 without deleting its home; the error identifies the blocking tab, and idle accounts remain deletable. |
| 71 | the Claude sign-in code route answers the account, or the link's refusal as a status | KEEP | Claude sign-in code HTTP input must reject blank pastes before exchange and map success/invalid/idle/upstream outcomes to 200/400/409/502. |

## apps/daemon/src/agent-accounts.test.ts

**Independent contract:** README managed accounts and Agent config; AGENTS owned-home, single-use-token and secret-privacy rules; native Claude/Codex/Grok credential files; docs/superpowers/specs/2026-09-28-agent-profile-design.md §5.

**Stable seam and callers:** Credential codecs and ownership guard used by agent-accounts.ts/usage-sources.ts, and AgentAccountsService public import/remove/resolve/refresh API with real owned homes. Daemon routes, session launch and usage refresh consume these results.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal native credentials, public account metadata, env keys, file contents/modes and independently advanced expiry times. Codec cases own format-specific inputs; service cases own file/environment/lifecycle wiring; merges distinguish different-file, same-file and concurrent user-data loss.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-accounts.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 25 | import a codex blob derives identity and writes a 0700 home + marker | OPTIMIZE | Imported Codex identity/native token persistence or private home ownership is wrong. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 40 | import claude requires a label and stores subscriptionType as plan | OPTIMIZE | Claude unlabeled import accepted or plan/refresh token lost. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 52 | import claude rejects a blob with empty OAuth tokens | OPTIMIZE | A logged-out Claude keychain blob containing empty OAuth tokens must not create an unusable managed account. Surviving public import owner now also rejects empty OAuth objects and non-string token fields, preserving every meaningful refusal from the helper-only case without creating accounts. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 78 | import claude accepts a refresh-token-only blob | OPTIMIZE | A refresh-token-only Claude credential must remain importable so renewal can recover an expired access token. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 87 | resolveLaunchEnv selects Claude/Codex homes and unsets competing API credentials | OPTIMIZE | Managed Claude/Codex launches must choose their account homes and clear ambient API credentials that would select another billing identity. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 99 | resolveLaunchEnv returns the EFFECTIVE account id (explicit and default) | OPTIMIZE | Session binding misses effective default/explicit identity, allowing live token refresh. Surviving owner now verifies both the effective ID and matching default account home; wrong token-pinning or wrong-home routing fail independently. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 114 | resolveLaunchEnv honors the SYSTEM_ACCOUNT_ID sentinel over a default | OPTIMIZE | Explicit System selection incorrectly inherits a managed default. Surviving owner includes the no-managed-account System fallback, alongside explicit System bypass of a configured default. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 122 | remove deletes the home and clears it from defaults | OPTIMIZE | Account removal leaves home or dangling default. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 131 | index and API responses carry no token material | OPTIMIZE | Credential token leaks into account index or API response. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 163 | ensureFreshForUsage refreshes an idle Codex account whose token is expiring | OPTIMIZE | Idle expiring Codex token is not refreshed/persisted with account identity. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 185 | an empty or missing refresh token is never posted: Claude, Codex and Grok accounts are unavailable to refresh | OPTIMIZE | No provider may post a missing/empty refresh token or mark a valid access-only account as needing reauthentication. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 210 | ensureFreshForUsage does not refresh an account with a live session | OPTIMIZE | Live CLI account has its single-use refresh token consumed by daemon. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 222 | account login metadata follows CLI credential changes, including live accounts | KEEP | CLI credential renewal/logout must update public login deadlines and reauthentication state, including live accounts; unchanged state must not rebroadcast or leak secrets. |
| 250 | ensureFreshForUsage skips a token that is not near expiry | OPTIMIZE | Far-future token is needlessly rotated. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 262 | an account the retired model proxy owned is refreshed by the account service again | KEEP | Legacy proxyOwned stored field prevents account service from refreshing. |
| 290 | resolveLaunchEnv seeds a Claude home: onboarding, mcps, stripped identity, symlinked skills/plugins | OPTIMIZE | New Claude home loses onboarding/MCP/profile resources or inherits another login. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 314 | Claude re-sync refreshes mcpServers but preserves the account's own identity | OPTIMIZE | Subsequent Claude launch overwrites account identity or retains obsolete MCPs. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 334 | resolveLaunchEnv shares Claude settings.json (symlink, replaces a stale real file) | OPTIMIZE | Stale Claude account settings mask shared user hooks. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 351 | resolveLaunchEnv shares Codex config.toml + hooks.json (replaces stale real files) | OPTIMIZE | Stale Codex account config/hooks mask shared configuration. Surviving owner verifies live config/hooks links, stale-file replacement and both native migration markers in one actual launch. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 372 | resolveLaunchEnv symlinks an empty/absent Codex sessions/ to the shared store | OPTIMIZE | Codex accounts cannot resume shared session history. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 385 | shared history recursively merges a COLLIDING project dir, then symlinks | OPTIMIZE | Colliding history directories lose one account’s sessions. Surviving owner independently preserves system bytes, colliding project transcript bytes and a disjoint project before exposing all history through the home link. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 416 | import a grok auth.json derives identity and resolves GROK_HOME at launch | OPTIMIZE | Grok import loses native identity or launches under ambient XAI_API_KEY. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 442 | a Grok refresh replaces auth.json by rename (as the CLI does), 0600, nothing left behind | OPTIMIZE | A Grok refresh must atomically replace its CLI auth file at 0600 while preserving identity and removing temporary files; in-place truncation risks torn credentials. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 464 | the refresher re-reads the live sessions before spending a refresh token (a chat that just started) | OPTIMIZE | A chat started after the caller took its account snapshot must prevent spending that account's single-use refresh token; releasing the account permits renewal. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 483 | the refresher renews held accounts before their CLI, respects its lock, and renews after the lock clears on the next hourly tick | KEEP | Protects the caller-visible outcome named here: the refresher renews held accounts before their CLI, respects its lock, and renews after the lock clears on the next hourly tick. assert.equal(await svc.refreshNow("codex", codex.id), "refreshed"); assert.deepEqual(urls, ["https://auth.openai.com/oauth/token"]) |
| 528 | an invalid_grant for a refresh token a host CLI already rotated is that CLI's refresh, not a login to redo | OPTIMIZE | Protects the caller-visible outcome named here: an invalid_grant for a refresh token a host CLI already rotated is that CLI's refresh, not a login to redo. assert.equal(await svc.refreshNow("codex", acct.id), "refreshed"); assert.equal(svc.getRecord(acct.id)?.needsReauth, false) Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 570 | Claude: CLAUDE.md is linked even before it exists (a dangling link reads as missing) and commands/ is created 0700 | OPTIMIZE | New instructions/commands fail to reach an already-launched managed account. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 588 | Claude: an account's own CLAUDE.md moves to the shared path when the owner has none | OPTIMIZE | Account-only instructions are discarded instead of adopted. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 596 | Claude: a differing CLAUDE.md keeps the owner's and saves the account's beside it; an identical one is dropped | OPTIMIZE | Conflicting instruction files lose data or identical files create spurious conflicts. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 612 | Claude: a real commands/ merges in — unique moved, identical dropped, a collision kept as <name>-<id8> | OPTIMIZE | Command merge loses unique/colliding content. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 633 | Claude: a symlink pointing elsewhere is replaced by the shared link | OPTIMIZE | Incorrect existing command link keeps account on wrong profile. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 641 | Codex: skills/ merges user skills, drops the account's bundled .system when the shared dir has one | OPTIMIZE | Bundled skills overwrite newer shared copies or user skills are lost. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 663 | Codex: AGENTS.md is shared — linked even before it exists, and an account's own copy moves across | OPTIMIZE | Codex global instructions fail to propagate. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 675 | Codex: the account's .system moves across when the shared skills/ has none; an absent shared dir is created | OPTIMIZE | Codex bundled skills vanish when shared copy absent. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 689 | Grok: AGENTS.md, commands/ and rules/ are shared; agents/ is not | OPTIMIZE | Grok instructions/commands/rules fail to share or unrelated agents leak. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 703 | nothing is linked into an agent home the daemon user does not have | OPTIMIZE | Launch creates an unwanted system agent home. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 716 | Claude: two accounts launched at once both keep their own command and CLAUDE.md (no move overwrites another) | OPTIMIZE | Concurrent account launches overwrite each other’s instructions/commands. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 742 | Claude: overlapping launches of one account never drop the owner's shared commands | KEEP | Overlapping same-account sync deletes owner’s shared commands. Keep every one of the original 40 event-loop offsets. Reuse immutable service/account setup within this test and reset both command directories before every schedule; no cross-test fixture sharing. |
| 763 | Claude: a shared CLAUDE.md that is itself a link (dotfiles) is compared by what it names | OPTIMIZE | Dotfiles symlink is destroyed or identical content falsely conflicts. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 774 | Claude: an account copy never replaces a dangling shared CLAUDE.md link | OPTIMIZE | Dangling owner instruction link is replaced, losing intended dotfiles path. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 797 | pruneOrphanHomes moves an orphan's history into the shared store and removes it | OPTIMIZE | History recreated by a deleted account must migrate to the shared store before the orphan home is removed; identical existing transcripts must survive. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 816 | pruneOrphanHomes keeps an orphan whose transcript differs from the shared copy | OPTIMIZE | An orphan whose transcript differs from the shared copy must remain recoverable instead of silently losing the longer conversation. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 827 | pruneOrphanHomes never touches a registered account, one in use, or a foreign dir | OPTIMIZE | Orphan cleanup must never delete a registered account, a live account, or an unrelated directory. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |

## apps/daemon/src/agent-conversations.test.ts

**Independent contract:** README history/resume and packages/api/src/index.ts AgentConversationSummary; CLI transcript filesystem formats.

**Stable seam and callers:** listAgentConversations over real scratch transcript directories index.ts conversation routes; resume consumes account attribution

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Unique transcript discovery/home attribution: provider runtime replay tests start after discovery and do not exercise these directories.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-conversations.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 47 | claude history is read from the dir the CLI names after the project path | KEEP | Detects: claude history is read from the dir the CLI names after the project path.. |
| 70 | a claude dir name over 200 chars is matched by its prefix and the transcript's cwd | KEEP | Detects: a claude dir name over 200 chars is matched by its prefix and the transcript's cwd.. |
| 88 | every conversation is attributed to the home it was read from | KEEP | Detects: every conversation is attributed to the home it was read from.. |
| 128 | a codex account home is attributed, and unrelated projects are ignored | KEEP | Detects: a codex account home is attributed, and unrelated projects are ignored.. |
| 151 | a home left behind by a deleted account is not scanned | KEEP | Detects: a home left behind by a deleted account is not scanned.. |
| 178 | without a daemonDir only the system homes are scanned | KEEP | Detects: without a daemonDir only the system homes are scanned.. |
| 198 | grok rows a managed home reaches through its sessions symlink are listed once, under the system home | KEEP | Detects: grok rows a managed home reaches through its sessions symlink are listed once, under the system home.. |
| 233 | codex rows an Agent Profile home writes through its sessions link are listed once, under the system home | KEEP | Detects: codex rows an Agent Profile home writes through its sessions link are listed once, under the system home.. |

## apps/daemon/src/agent-hooks.test.ts

**Independent contract:** README attention signalling and agent-owned global configuration; Claude/Codex/Grok/OpenCode hook file formats.

**Stable seam and callers:** AgentHooks.ensureForEntry over scratch config files and executable notifier commands sessions.ts and agent launch setup

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Owns installed config bytes/modes, native trust indices and preserved user config; provider event adapters do not install these files.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-hooks.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 18 | claude install is awaited and creates 0600 settings + 0755 script | KEEP | Detects: claude install is awaited and creates 0600 settings + 0755 script.. |
| 38 | claude install preserves an existing file's 0600 mode and its content | KEEP | Detects: claude install preserves an existing file's 0600 mode and its content.. |
| 56 | claude install writes THROUGH a symlinked settings.json (dotfiles setup) | KEEP | Detects: claude install writes THROUGH a symlinked settings.json (dotfiles setup).. |
| 77 | unrecognized config shapes abort byte-identical (claude string hooks, non-array event, codex array hooks) | KEEP | Detects: unrecognized config shapes abort byte-identical (claude string hooks, non-array event, codex array hooks).. |
| 107 | codex install preserves metadata, appends after user groups, and writes 0600 trust blocks | KEEP | Detects: codex install preserves metadata, appends after user groups, and writes 0600 trust blocks.. |
| 136 | codex trust block is keyed to the managed group's actual index when it is not last | KEEP | Detects: codex trust block is keyed to the managed group's actual index when it is not last.. |
| 173 | codex install refuses a multiline-string config.toml BEFORE touching hooks.json | KEEP | Detects: codex install refuses a multiline-string config.toml BEFORE touching hooks.json.. |
| 190 | installs are idempotent: a second run is byte-identical (claude + codex) | KEEP | Detects: installs are idempotent: a second run is byte-identical (claude + codex).. |
| 211 | grok install writes a solely-owned orquester.json with grok-labelled notifier hooks | KEEP | Detects: grok install writes a solely-owned orquester.json with grok-labelled notifier hooks.. |
| 240 | grok install honors GROK_HOME and is idempotent | KEEP | Detects: grok install honors GROK_HOME and is idempotent.. |
| 258 | grok install overwrites an edited orquester.json (solely owned) | KEEP | Detects: grok install overwrites an edited orquester.json (solely owned).. |
| 275 | per-account env overrides route installs to the account config home | KEEP | Detects: per-account env overrides route installs to the account config home.. |
| 292 | opencode installs its plugin into the GLOBAL config dir: OPENCODE_CONFIG_DIR is additive, XDG_CONFIG_HOME moves it | KEEP | Detects: opencode installs its plugin into the GLOBAL config dir: OPENCODE_CONFIG_DIR is additive, XDG_CONFIG_HOME moves it.. |

## apps/daemon/src/agent-status-grok.test.ts

**Independent contract:** README managed accounts and Agent config; AGENTS owned-home, single-use-token and secret-privacy rules; native Claude/Codex/Grok credential files; docs/superpowers/specs/2026-09-28-agent-profile-design.md §5.

**Stable seam and callers:** Credential codecs and ownership guard used by agent-accounts.ts/usage-sources.ts, and AgentAccountsService public import/remove/resolve/refresh API with real owned homes. Daemon routes, session launch and usage refresh consume these results.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal native credentials, public account metadata, env keys, file contents/modes and independently advanced expiry times. Codec cases own format-specific inputs; service cases own file/environment/lifecycle wiring; merges distinguish different-file, same-file and concurrent user-data loss.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-status-grok.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 7 | grok Stop counts as done only for a completed turn | KEEP | Observe-only Grok teardown falsely reports a completed turn. |
| 16 | grok attention events map to waiting | KEEP | Permission/notification fails to request user attention. |
| 21 | grok progress events map to working | KEEP | Prompt/tool progress fails to show working. |
| 26 | unknown grok events are ignored | KEEP | Unsupported event erroneously changes session status. |

## apps/daemon/src/agent-timeout-config.test.ts

**Independent contract:** AgentsSettings.tsx timeout control (whole minutes 1..30), app store default30, and the persisted agent preference API.

**Stable seam and callers:** createDefaultAppConfig/parseAppConfig daemon settings and launch preferences

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Config owner confirmed no duplicate timeout boundary/default tests in its inventory.

Validation target: `pnpm --filter @orquester/config test`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 5 | a config with no agents group defaults to 30 minutes | CONSOLIDATE | A public persisted timeout contract remains, but belongs to its lowest config owner; consolidate the default/in-range/boundary/type examples into one scenario and remove a whole daemon-file startup. Surviving owner: packages/config/src/index.test.ts :: Claude stream timeout defaults to 30 minutes and accepts only whole minutes from 1 to 30. |
| 10 | an explicit in-range value is preserved | CONSOLIDATE | A public persisted timeout contract remains, but belongs to its lowest config owner; consolidate the default/in-range/boundary/type examples into one scenario and remove a whole daemon-file startup. Surviving owner: packages/config/src/index.test.ts :: Claude stream timeout defaults to 30 minutes and accepts only whole minutes from 1 to 30. |
| 16 | out-of-range and non-integer values are rejected | CONSOLIDATE | A public persisted timeout contract remains, but belongs to its lowest config owner; consolidate the default/in-range/boundary/type examples into one scenario and remove a whole daemon-file startup. Surviving owner: packages/config/src/index.test.ts :: Claude stream timeout defaults to 30 minutes and accepts only whole minutes from 1 to 30. |

## apps/daemon/src/agent-timeout-env.test.ts

**Independent contract:** packages/config agent timeout/cache preference and managed-account launch environment contract.

**Stable seam and callers:** buildAgentLaunchEnv index.ts agent launch resolver

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Owns preference/account composition; account-file tests and provider tests do not build terminal launch environments.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-timeout-env.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 5 | a claude launch under a managed account carries the timeout env and keeps the account | KEEP | Detects: a claude launch under a managed account carries the timeout env and keeps the account.. |
| 20 | plain claude (no managed account) still carries the timeout env | KEEP | Detects: plain claude (no managed account) still carries the timeout env.. |
| 26 | a non-claude launcher composes to no timeout keys | KEEP | Detects: a non-claude launcher composes to no timeout keys.. |
| 38 | a claude launch carries the subagent cache lifetime, over whatever the account env says | KEEP | Detects: a claude launch carries the subagent cache lifetime, over whatever the account env says.. |

## apps/daemon/src/ansi-activity.test.ts

**Independent contract:** ECMA-48 BEL/OSC/CSI bytes and packages/api activity/attention contract; README attention signalling.

**Stable seam and callers:** BellScanner.feed and ActivityTracker snapshots/events sessions.ts terminal activity

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Distinct scanner byte states and attention precedence; real session test uniquely checks exit-event wiring/order, rather than repeating scanner cases.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/ansi-activity.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 5 | BellScanner counts BEL in ground state | KEEP | Detects: BellScanner counts BEL in ground state.. |
| 12 | BellScanner ignores OSC terminator BEL and counts a later ground BEL | KEEP | Detects: BellScanner ignores OSC terminator BEL and counts a later ground BEL.. |
| 18 | BellScanner ignores OSC content terminated by ST and counts trailing ground BEL | KEEP | Detects: BellScanner ignores OSC content terminated by ST and counts trailing ground BEL.. |
| 24 | BellScanner recognizes C1 ST after C1 string introducers | KEEP | Detects: BellScanner recognizes C1 ST after C1 string introducers.. |
| 30 | BellScanner recovers after BEL terminates DCS, SOS, PM, and APC strings | KEEP | Detects: BellScanner recovers after BEL terminates DCS, SOS, PM, and APC strings.. |
| 39 | BellScanner returns to ground after CSI final byte so the following BEL counts | KEEP | Detects: BellScanner returns to ground after CSI final byte so the following BEL counts.. |
| 45 | BellScanner keeps escape and string state across chunk boundaries | KEEP | Detects: BellScanner keeps escape and string state across chunk boundaries.. |
| 57 | BellScanner reports the last OSC 0/2 title of each chunk | KEEP | Detects: BellScanner reports the last OSC 0/2 title of each chunk.. |
| 76 | BellScanner reports a chunk-split title once, in the terminating chunk | KEEP | Detects: BellScanner reports a chunk-split title once, in the terminating chunk.. |
| 85 | BellScanner counts OSC 9 / OSC 777 notifications as bells | KEEP | Detects: BellScanner counts OSC 9 / OSC 777 notifications as bells.. |
| 104 | ActivityTracker: output → working, bell sets attention, input clears it | KEEP | Detects: ActivityTracker: output → working, bell sets attention, input clears it.. |
| 149 | ActivityTracker: needsAttentionAt tracks structural attention too | KEEP | Detects: ActivityTracker: needsAttentionAt tracks structural attention too.. |
| 171 | ActivityTracker: output echoing local input is neither heartbeat nor bell | KEEP | Detects: ActivityTracker: output echoing local input is neither heartbeat nor bell.. |
| 196 | ActivityTracker: typing during a live stream cannot make the session read idle | KEEP | Detects: ActivityTracker: typing during a live stream cannot make the session read idle.. |
| 232 | ActivityTracker: a bell 400ms after a keystroke still raises attention | KEEP | Detects: ActivityTracker: a bell 400ms after a keystroke still raises attention.. |
| 245 | ActivityTracker: exit raises finished attention | KEEP | Detects: ActivityTracker: exit raises finished attention.. |
| 271 | ActivityTracker: a title streak makes only title changes count as heartbeats | KEEP | Detects: ActivityTracker: a title streak makes only title changes count as heartbeats.. |
| 292 | ActivityTracker: a one-off retitle does not make a session title-driven | KEEP | Detects: ActivityTracker: a one-off retitle does not make a session title-driven.. |
| 311 | ActivityTracker: structural hooks outrank byte-stream heuristics | KEEP | Detects: ActivityTracker: structural hooks outrank byte-stream heuristics.. |
| 330 | ActivityTracker: a bell never downgrades a structural attention | KEEP | Detects: ActivityTracker: a bell never downgrades a structural attention.. |

## apps/daemon/src/browsers-close-for-project.test.ts

**Independent contract:** README project tabs; project/workspace deletion cascade and configured filesystem path aliases.

**Stable seam and callers:** BrowserManager create/closeForProject/list, persisted scratch index index.ts deletion routes

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only owner of browser-tab cascade prefix/alias behavior; filesystem deletion tests cannot observe these tabs.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/browsers-close-for-project.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 27 | closes the project's tabs and those of projects below it, not siblings sharing a prefix | KEEP | Detects: closes the project's tabs and those of projects below it, not siblings sharing a prefix.. |
| 33 | matches any of the spellings passed (raw join and realpath) | KEEP | Detects: matches any of the spellings passed (raw join and realpath).. |

## apps/daemon/src/browsers-subscribe.test.ts

**Independent contract:** README Design Mode streaming and CDP screenshot transient refusal.

**Stable seam and callers:** BrowserManager.subscribe sink frames/state browser WebSocket routes

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Owns subscription screenshot bootstrap; raw HTML renderer uses separate isolated browsers and does not own Design Mode tabs.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/browsers-subscribe.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 71 | a priming screenshot refused mid-navigation leaves the tab running, with no error | KEEP | Detects: a priming screenshot refused mid-navigation leaves the tab running, with no error.. |
| 79 | a priming screenshot that works is the first frame | KEEP | Detects: a priming screenshot that works is the first frame.. |

## apps/daemon/src/build-info.test.ts

**Independent contract:** README deployment health/build verification; deploy/lib/remote-update.sh version stamp and Git HEAD/ref/worktree formats.

**Stable seam and callers:** readBuildInfo/readGitCommit/findRepoRoot over scratch checkout metadata index.ts daemonBuildInfo bootstrap

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Filesystem discovery remains here; duplicate HTTP build/auth response moves to health-route.test.ts.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/build-info.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 21 | finds the workspace root above a nested directory | KEEP | Detects: finds the workspace root above a nested directory.. |
| 29 | reads the commit from a branch, packed refs, a detached HEAD and a linked worktree | KEEP | Detects: reads the commit from a branch, packed refs, a detached HEAD and a linked worktree.. |
| 57 | falls back to the deploy stamp when there is no .git, and to null without either | KEEP | Detects: falls back to the deploy stamp when there is no .git, and to null without either.. |

## apps/daemon/src/claude-oauth-link.test.ts

**Independent contract:** README managed Claude/Codex/Grok account linking; RFC 7636 PKCE, RFC 8628 device grants, CLI native credential and provider authorization endpoints; AgentAccount/DeviceLink/ClaudeOAuthLink API contracts.

**Stable seam and callers:** Public start/status/submit/cancel link APIs, HTTP request fields and real AgentAccountsService persistence; daemon account-link routes consume these services, which use the native credential converters.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal authorization fields, independently hashed PKCE verifier relationship, virtual expiry/poll time, known provider payloads and actual persisted token bytes. Link services own pending/conflict/import lifecycle; converters own optional identity/native expiry shapes that lifecycle tests do not enumerate.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/claude-oauth-link.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 51 | start hands out the CLI's Claude.ai authorize URL with a PKCE challenge | KEEP | Claude authorization must use the CLI client/redirect/scope and S256 PKCE fields; simultaneous starts conflict and the link has a bounded lifetime. |
| 70 | a pasted code#state becomes a labelled Claude account with the CLI's credentials file | KEEP | A valid code/state pair must send a verifier matching the public challenge and persist a CLI-native credential with independently specified token/identity/expiry fields. |
| 107 | a failed profile lookup leaves the plan unknown but still links | KEEP | An unavailable optional profile endpoint must not discard a successful Claude login; the account remains linked with unknown plan. |
| 114 | malformed, foreign, and rejected codes are refused and keep the sign-in pending | KEEP | Malformed or foreign-state codes must not reach the token endpoint; rejected codes must create no account and leave retryable sign-in pending. |
| 131 | submitting with nothing pending is refused; an unused sign-in expires | KEEP | Submitting without a pending sign-in must return idle; an unused sign-in must expire deterministically after its published lifetime. |
| 141 | the pasted code may be the callback URL itself | KEEP | Pasting the callback URL must parse its code/state pair; incomplete callback or empty-code inputs must be refused. |

## apps/daemon/src/daily-log.test.ts

**Independent contract:** packages/config dailyLogFile/retention contracts and daemon log rotation documented on DailyLogStream.

**Stable seam and callers:** DailyLogStream write/close/settled with actual log files and controlled clock index.ts request-log bootstrap

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only file rollover/retention owner; config path-format tests do not write, flush, prune or reopen logs.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/daily-log.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 42 | rolls over at local midnight without losing a line, and the timer fires at midnight | KEEP | Detects: rolls over at local midnight without losing a line, and the timer fires at midnight.. |
| 59 | a write after midnight goes to the new day even before the timer fires | KEEP | Detects: a write after midnight goes to the new day even before the timer fires.. |
| 70 | continues today's file at boot and starts a new part at the size cap | KEEP | Detects: continues today's file at boot and starts a new part at the size cap.. |
| 93 | prunes daily files older than the retention at boot and at each midnight, nothing else | KEEP | Detects: prunes daily files older than the retention at boot and at each midnight, nothing else.. |
| 106 | a changed logs directory takes effect at the next rollover | KEEP | Detects: a changed logs directory takes effect at the next rollover.. |

## apps/daemon/src/device-link.test.ts

**Independent contract:** README managed Claude/Codex/Grok account linking; RFC 7636 PKCE, RFC 8628 device grants, CLI native credential and provider authorization endpoints; AgentAccount/DeviceLink/ClaudeOAuthLink API contracts.

**Stable seam and callers:** Public start/status/submit/cancel link APIs, HTTP request fields and real AgentAccountsService persistence; daemon account-link routes consume these services, which use the native credential converters.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal authorization fields, independently hashed PKCE verifier relationship, virtual expiry/poll time, known provider payloads and actual persisted token bytes. Link services own pending/conflict/import lifecycle; converters own optional identity/native expiry shapes that lifecycle tests do not enumerate.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/device-link.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 71 | a granted link imports the tokens as a managed grok account | KEEP | A successful Grok device grant must persist the granted token pair in its managed CLI auth home and leave the link idle. |
| 89 | a start failure is an upstream result carrying the status, and leaves nothing pending | KEEP | Device authorization startup failures must preserve the upstream status and leave no pending authorization. |
| 98 | a second start while one is pending is a conflict; cancel drops it locally | KEEP | Starting twice must preserve the first code and report conflict; cancellation must be idempotent and prevent any later token poll/import. |
| 112 | a failed verdict lands on lastError and a fresh attempt clears it | KEEP | A denied device grant must become visible lastError and starting a fresh attempt must clear that obsolete error. |
| 121 | a failed import is reported as the link's error | KEEP | A granted device token whose native account cannot be persisted must report import failure and leave no phantom account. A truthy lastError could pass for an unrelated token/exchange failure; the oracle now requires the filesystem ENOTDIR/EEXIST refusal from obstructed native account persistence. |
| 172 | a Codex link polls past pending, exchanges the code, and imports a codex auth.json | KEEP | Codex device sign-in must continue after pending 403, exchange the authorization code using the verifier, and persist ChatGPT-native account credentials. |
| 211 | a Codex link whose code exchange fails ends with that error and imports nothing | KEEP | A failed Codex code exchange must report the upstream error and create no account. |
| 219 | a Codex poll error other than pending is the link's verdict | KEEP | A non-pending Codex device-poll failure must terminate with an authorization error instead of polling forever. |

## apps/daemon/src/devtools-routes.test.ts

**Independent contract:** README transport asymmetry and authenticated remote-only CDP proxy.

**Stable seam and callers:** createServer HTTP injection plus real loopback WebSocket upstream index.ts remote DevTools routes

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only route owner for proxy mounting/Host forwarding/pre-handshake queue; pure helpers cannot exercise transport wiring.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/devtools-routes.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 120 | asset route 404s on path traversal and never reaches upstream | KEEP | Detects: asset route 404s on path traversal and never reaches upstream.. |
| 134 | asset + ws routes are absent on the local (unix) transport | KEEP | Detects: asset + ws routes are absent on the local (unix) transport.. |
| 159 | ws route rejects a missing/invalid token with 1008 on the remote transport | KEEP | Detects: ws route rejects a missing/invalid token with 1008 on the remote transport.. |
| 169 | ws route preserves a client message sent before the upstream handshake | KEEP | Detects: ws route preserves a client message sent before the upstream handshake.. |
| 192 | ws route forwards the loopback Host header to upstream | KEEP | Detects: ws route forwards the loopback Host header to upstream.. |

## apps/daemon/src/devtools.test.ts

**Independent contract:** README embedded DevTools and privacy model; CDP endpoint/path and URL credential redaction contracts.

**Stable seam and callers:** parseDebugPort/sanitizeDevtoolsPath/redactUrlTokens browsers.ts and index.ts proxy/log requests

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Pure parsing/redaction cases cover syntax classes independently; route tests cover transport mounting, auth and actual relay.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/devtools.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 5 | parseDebugPort extracts the loopback port from a puppeteer wsEndpoint | KEEP | Detects: parseDebugPort extracts the loopback port from a puppeteer wsEndpoint.. |
| 9 | parseDebugPort rejects garbage, missing ports and out-of-range values | KEEP | Detects: parseDebugPort rejects garbage, missing ports and out-of-range values.. |
| 18 | sanitizeDevtoolsPath accepts normal frontend asset paths | KEEP | Detects: sanitizeDevtoolsPath accepts normal frontend asset paths.. |
| 24 | sanitizeDevtoolsPath rejects traversal, empty segments and junk | KEEP | Detects: sanitizeDevtoolsPath rejects traversal, empty segments and junk.. |
| 36 | redactUrlTokens redacts the plain ?token= form | KEEP | Detects: redactUrlTokens redacts the plain ?token= form.. |
| 47 | redactUrlTokens redacts the percent-encoded token inside the DevTools wss= value | KEEP | Detects: redactUrlTokens redacts the percent-encoded token inside the DevTools wss= value.. |
| 54 | redactUrlTokens leaves token-free URLs untouched | KEEP | Detects: redactUrlTokens leaves token-free URLs untouched.. |
| 58 | redactUrlTokens redacts an agent page's signature | KEEP | Detects: redactUrlTokens redacts an agent page's signature.. |

## apps/daemon/src/fs-path-query.test.ts

**Independent contract:** fs-path-query.ts documented plain/path and strict base64url p compatibility; README realpath sandbox.

**Stable seam and callers:** fsPathFromQuery plus createServer filesystem GET routes index.ts filesystem GET routes

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Decoder owns malformed UTF8/precedence; route cases ensure endpoint adoption and containment. No browser blocker/network dependency.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/fs-path-query.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 19 | fsPathFromQuery: `p` decodes base64url UTF-8, `path` is the plain fallback | KEEP | Protects the caller-visible outcome named here: fsPathFromQuery: `p` decodes base64url UTF-8, `path` is the plain fallback. assert.equal(fsPathFromQuery({ p: b64url(spanish) }), spanish); assert.equal(fsPathFromQuery({ path: spanish }), spanish) |
| 29 | fsPathFromQuery: a malformed `p` is unusable (never partially decoded) | KEEP | Protects the caller-visible outcome named here: fsPathFromQuery: a malformed `p` is unusable (never partially decoded). assert.equal(fsPathFromQuery({ p: bad }), undefined, JSON.stringify(bad)); assert.equal(fsPathFromQuery({ p: "abc=", path: "/plain" }), undefined) |
| 75 | /api/fs/raw and /api/fs/download serve a file addressed by base64url `p` | KEEP | Protects the caller-visible outcome named here: /api/fs/raw and /api/fs/download serve a file addressed by base64url `p`. assert.equal(raw.statusCode, 200); assert.deepEqual(raw.rawPayload, bytes) |
| 99 | /api/fs GET routes: a malformed `p` is a 400, and `p` cannot escape the sandbox | KEEP | Protects the caller-visible outcome named here: /api/fs GET routes: a malformed `p` is a 400, and `p` cannot escape the sandbox. assert.equal(res.statusCode, 400, route); assert.equal(res.json().code, "INVALID_REQUEST", route) |

## apps/daemon/src/git-remote-url.test.ts

**Independent contract:** Git origin/currentBranch/topLevel protocols and README git credential privacy.

**Stable seam and callers:** GitService against real isolated Git repositories workflow project triggers and repository resolution

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only remote/branch/top-level discovery owner; repo-id parses existing config to group repos and does not invoke this GitService path.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/git-remote-url.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 28 | remoteUrl reads origin (or a named remote) and strips its credentials | KEEP | Detects: remoteUrl reads origin (or a named remote) and strips its credentials.. |
| 46 | remoteUrl is null outside a repo | KEEP | Detects: remoteUrl is null outside a repo.. |
| 56 | currentBranch names the branch, even unborn; null when detached | KEEP | Detects: currentBranch names the branch, even unborn; null when detached.. |
| 68 | topLevel names the work tree's top directory, also from a folder below it; null outside a repo | KEEP | Detects: topLevel names the work tree's top directory, also from a folder below it; null outside a repo.. |

## apps/daemon/src/git.test.ts

**Independent contract:** README git workflows/security; packages/api Git types and Git porcelain/patch/refs protocols.

**Stable seam and callers:** GitService/GitWatcher public operations, real temp Git repos, controlled process-runner fixtures index.ts git API and workflow prompt readers

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Parser/queue contracts need controlled process outcomes; real-git cases uniquely protect data loss, symlink containment, hook execution and emitted patch interoperability. Host hook/fsmonitor artifacts remain; boxes/remote/exec/git.test.ts owns complementary actual box-side hook/fsmonitor behavior.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/git.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 82 | serializes concurrent git mutations in the same repository | KEEP | Detects: serializes concurrent git mutations in the same repository.. |
| 108 | allows git mutations in different repositories to run concurrently | KEEP | Detects: allows git mutations in different repositories to run concurrently.. |
| 129 | continues a repository queue after an earlier mutation fails | KEEP | Detects: continues a repository queue after an earlier mutation fails.. |
| 153 | discard touches only the requested paths, never the rest of the tree | KEEP | Detects: discard touches only the requested paths, never the rest of the tree.. |
| 166 | discard of a folder pathspec covers the entries beneath it | KEEP | Detects: discard of a folder pathspec covers the entries beneath it.. |
| 185 | log carries parent hashes for the commit graph | KEEP | Detects: log carries parent hashes for the commit graph.. |
| 205 | branches report divergence from the upstream and omit remote HEAD aliases | KEEP | Detects: branches report divergence from the upstream and omit remote HEAD aliases.. |
| 230 | commitDetail reports Unicode renames and binary changes | KEEP | Detects: commitDetail reports Unicode renames and binary changes.. |
| 248 | stash list returns newest first with branch and named or default message | KEEP | Detects: stash list returns newest first with branch and named or default message.. |
| 269 | stash mutations reject invalid index or missing identity before invoking git | KEEP | Detects: stash mutations reject invalid index or missing identity before invoking git.. |
| 280 | a stash op refuses (409) when the index no longer resolves at all | KEEP | Detects: a stash op refuses (409) when the index no longer resolves at all.. |
| 287 | watcher polls only while subscribed, and only emits on a real change | KEEP | Detects: watcher polls only while subscribed, and only emits on a real change.. |
| 324 | the /events filter routes by event TYPE, not by a substring of the payload | KEEP | Detects: the /events filter routes by event TYPE, not by a substring of the payload.. |
| 342 | watcher ignores a lastFetched-only change (the background auto-fetch) | KEEP | Detects: watcher ignores a lastFetched-only change (the background auto-fetch).. |
| 364 | an untracked SYMLINK renders as its target string, never the target's bytes | KEEP | Detects: an untracked SYMLINK renders as its target string, never the target's bytes.. |
| 383 | an untracked file reached through a symlinked PARENT is refused | KEEP | Detects: an untracked file reached through a symlinked PARENT is refused.. |
| 398 | an ordinary untracked file still renders as a new-file patch | KEEP | Detects: an ordinary untracked file still renders as a new-file patch.. |
| 413 | discarding a rename restores BOTH halves (real git, throwaway repo) | KEEP | Detects: discarding a rename restores BOTH halves (real git, throwaway repo).. |
| 432 | a stash sha mismatch is a 409 against real git, and drops nothing | KEEP | Detects: a stash sha mismatch is a 409 against real git, and drops nothing.. |
| 455 | workingDiffMaxBytes parses an integer, defaults, and clamps | KEEP | Detects: workingDiffMaxBytes parses an integer, defaults, and clamps.. |
| 469 | an overflow on a read that did not ask for a cap is still an error | KEEP | Detects: an overflow on a read that did not ask for a cap is still an error.. |
| 486 | working diff of a directory that is not a repo is isRepo:false, never an error | KEEP | Detects: working diff of a directory that is not a repo is isRepo:false, never an error.. |
| 508 | working diff of a clean repo is an empty patch with nothing untracked | KEEP | Detects: working diff of a clean repo is an empty patch with nothing untracked.. |
| 522 | working diff: staged and unstaged changes in ONE patch against HEAD; untracked files listed, not patched | KEEP | Detects: working diff: staged and unstaged changes in ONE patch against HEAD; untracked files listed, not patched.. |
| 558 | working diff before the first commit is against the empty tree | KEEP | Detects: working diff before the first commit is against the empty tree.. |
| 580 | working diff cuts a long patch at the last whole line within maxBytes, never mid-character | KEEP | Detects: working diff cuts a long patch at the last whole line within maxBytes, never mid-character.. |
| 609 | working diff stops git once a huge patch has written enough, and still cuts cleanly | KEEP | Detects: working diff stops git once a huge patch has written enough, and still cuts cleanly.. |
| 629 | working diff of a project inside a larger checkout stays within the project | KEEP | Detects: working diff of a project inside a larger checkout stays within the project.. |
| 652 | working diff ignores the user's own diff config: no quoting, a/ b/ prefixes, repo-relative paths | KEEP | Detects: working diff ignores the user's own diff config: no quoting, a/ b/ prefixes, repo-relative paths.. |
| 682 | gitSafetyArgs: fsmonitor off everywhere, hooks off for the daemon's own reads on this host | DELETE | Fails stable seam/refactor resistance and unique protection: pins a private argv matrix/order. Actual host and box repository artifacts prove fsmonitor suppression and intended hook execution. Internalize the tests-only helper export. Surviving owner: apps/daemon/src/git.test.ts :: a repo's own fsmonitor command and post-index-change hook never run on the daemon's reads; commit hooks still do; apps/daemon/src/boxes/remote/exec/git.test.ts. |
| 694 | a repo's own fsmonitor command and post-index-change hook never run on the daemon's reads; commit hooks still do | KEEP | Detects: a repo's own fsmonitor command and post-index-change hook never run on the daemon's reads; commit hooks still do.. |

## apps/daemon/src/glob.test.ts

**Independent contract:** packages/config/src/glob.ts documented include/exclude grammar and bounds.

**Stable seam and callers:** parseGlobList/matchesGlobList/mergeGlobLists search.ts and UI search glob handling

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Owns compiler grammar/budget protection; search tests protect engine integration and contextual error mapping. Config owner confirmed no duplicate grammar suite.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/glob.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 20 | empty field matches everything | KEEP | Detects: empty field matches everything.. |
| 26 | * matches within a segment but not across / | KEEP | Detects: * matches within a segment but not across /.. |
| 35 | ? matches exactly one non-slash char | KEEP | Detects: ? matches exactly one non-slash char.. |
| 41 | ** matches any run of segments including zero | KEEP | Detects: ** matches any run of segments including zero.. |
| 47 | leading / anchors to the root (no **/ wrap) | KEEP | Detects: leading / anchors to the root (no **/ wrap).. |
| 54 | leading ./ is stripped | KEEP | Detects: leading ./ is stripped.. |
| 59 | folder shorthand matches the dir and everything under it | KEEP | Detects: folder shorthand matches the dir and everything under it.. |
| 67 | folder shorthand does NOT apply to terms with a dot or metachar | KEEP | Detects: folder shorthand does NOT apply to terms with a dot or metachar.. |
| 76 | anchored folder shorthand | KEEP | Detects: anchored folder shorthand.. |
| 81 | brace expansion, one level | KEEP | Detects: brace expansion, one level.. |
| 87 | multiple brace groups expand as a cartesian product | KEEP | Detects: multiple brace groups expand as a cartesian product.. |
| 95 | comma splitting happens at brace-depth 0 only | KEEP | Detects: comma splitting happens at brace-depth 0 only.. |
| 103 | empty terms are dropped | KEEP | Detects: empty terms are dropped.. |
| 109 | include vs exclude combine: pass iff any include and no exclude | KEEP | Detects: include vs exclude combine: pass iff any include and no exclude.. |
| 119 | ! in an include field moves the term to the exclude bucket | KEEP | Detects: ! in an include field moves the term to the exclude bucket.. |
| 126 | ! mixed with positives in one include field | KEEP | Detects: ! mixed with positives in one include field.. |
| 133 | ! in an exclude field is stripped (still excludes) | KEEP | Detects: ! in an exclude field is stripped (still excludes).. |
| 139 | glob matching is case-sensitive | KEEP | Detects: glob matching is case-sensitive.. |
| 144 | relPath with leading ./ or . segments is tolerated | KEEP | Detects: relPath with leading ./ or . segments is tolerated.. |
| 152 | NUL byte is rejected | KEEP | Detects: NUL byte is rejected.. |
| 156 | field over 1024 chars is rejected | KEEP | Detects: field over 1024 chars is rejected.. |
| 161 | term over 256 chars is rejected | KEEP | Detects: term over 256 chars is rejected.. |
| 166 | more than 64 terms is rejected | KEEP | Detects: more than 64 terms is rejected.. |
| 171 | too many brace expansions is rejected | KEEP | Detects: too many brace expansions is rejected.. |
| 177 | unbalanced braces are rejected | KEEP | Detects: unbalanced braces are rejected.. |
| 182 | nested braces are rejected | KEEP | Detects: nested braces are rejected.. |
| 186 | ** inside a segment is rejected | KEEP | Detects: ** inside a segment is rejected.. |
| 193 | GlobError carries the offending pattern | KEEP | Detects: GlobError carries the offending pattern.. |
| 203 | a bare ** term matches everything | KEEP | Detects: a bare ** term matches everything.. |
| 208 | consecutive ** segments collapse and still match | KEEP | Detects: consecutive ** segments collapse and still match.. |
| 216 | pathological many-star pattern stays linear | KEEP | Detects: pathological many-star pattern stays linear.. |

## apps/daemon/src/grok-device-auth.test.ts

**Independent contract:** README managed Claude/Codex/Grok account linking; RFC 7636 PKCE, RFC 8628 device grants, CLI native credential and provider authorization endpoints; AgentAccount/DeviceLink/ClaudeOAuthLink API contracts.

**Stable seam and callers:** Public start/status/submit/cancel link APIs, HTTP request fields and real AgentAccountsService persistence; daemon account-link routes consume these services, which use the native credential converters.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal authorization fields, independently hashed PKCE verifier relationship, virtual expiry/poll time, known provider payloads and actual persisted token bytes. Link services own pending/conflict/import lifecycle; converters own optional identity/native expiry shapes that lifecycle tests do not enumerate.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/grok-device-auth.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 12 | device tokens become a CLI-shaped auth.json with identity from the id_token | KEEP | Granted OAuth tokens have unusable native auth key/expiry/identity format. |
| 34 | identity is optional: no id_token still yields an importable credential | KEEP | A valid grant without identity fields cannot be imported. |

## apps/daemon/src/health-route.test.ts

**Independent contract:** README public liveness and authenticated build verification; packages/api health/info types.

**Stable seam and callers:** createServer HTTP injection on authenticated remote transport index.ts health/info routes

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Surviving single HTTP owner for public health versus authenticated version/full commit/short build; build-info stays at on-disk discovery seam.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/health-route.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 23 | health is public and identifies the service; info carries the build to signed-in clients | KEEP | Surviving owner combines public liveness, signed-in protocol/short build and the full version/commit assertions from build-info; temporary appdir is cleaned up. |

## apps/daemon/src/http-routing.test.ts

**Independent contract:** README transport asymmetry/security; shared agent-chat/profile/knowledge route contracts.

**Stable seam and callers:** createServer inject for actual remote/local route registration and bearer hook index.ts route assembly

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only composition owner for encoded-path auth bypass, long route IDs, signed visual exemption and socket-only controls; individual route handlers do not test daemon mounting.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/http-routing.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 53 | the bearer hook refuses percent-encoded spellings of a gated path | KEEP | Detects: the bearer hook refuses percent-encoded spellings of a gated path.. |
| 87 | the Agent Profiles routes are on both transports, bearer-gated on the remote one | KEEP | Detects: the Agent Profiles routes are on both transports, bearer-gated on the remote one.. |
| 116 | agent profile item routes match ids longer than the router's default 100-character parameter | KEEP | Detects: agent profile item routes match ids longer than the router's default 100-character parameter.. |
| 140 | an agent page's signed route passes the bearer hook on its signature alone; minting still needs the bearer | KEEP | Detects: an agent page's signed route passes the bearer hook on its signature alone; minting still needs the bearer.. |
| 201 | the session-tool call route is socket-only, and the socket still requires the agent host's bearer | KEEP | Detects: the session-tool call route is socket-only, and the socket still requires the agent host's bearer.. |
| 247 | the request_secret routes are mounted on remote HTTP behind its bearer, never echoing an answer | KEEP | Detects: the request_secret routes are mounted on remote HTTP behind its bearer, never echoing an answer.. |
| 270 | the Knowledge Graph routes are bearer-gated on the remote transport, worker routes absent there | KEEP | Detects: the Knowledge Graph routes are bearer-gated on the remote transport, worker routes absent there.. |

## apps/daemon/src/known-hosts.test.ts

**Independent contract:** README SSH identity privacy/security and OpenSSH known_hosts host matching/TOFU contract.

**Stable seam and callers:** ensureKnownHosts/parseKnownHostsDocument over scratch trust files accounts.ts SSH setup

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only trust-file seed/update owner; account/provider HTTP tests do not verify the hostname pins SSH consumes.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/known-hosts.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 8 | seeds once, idempotently, preserving TOFU-appended entries | KEEP | Detects: seeds once, idempotently, preserving TOFU-appended entries.. |
| 21 | every pinned line covers BOTH bitbucket.org and ssh.bitbucket.org | KEEP | Detects: every pinned line covers BOTH bitbucket.org and ssh.bitbucket.org.. |
| 35 | parseKnownHostsDocument keeps only well-formed bitbucket lines, normalized + deduped | KEEP | Detects: parseKnownHostsDocument keeps only well-formed bitbucket lines, normalized + deduped.. |

## apps/daemon/src/model-proxy-retirement.test.ts

**Independent contract:** Persisted migration obligation: model-proxy-retirement.ts one-shot token handback, launcher ownership and retirement marker.

**Stable seam and callers:** retireModelProxy over real legacy-shaped account files index.ts boot migration

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Retired feature remains a supported one-time migration: losing fresher tokens or deleting user launchers is still a credible failure; current launch tests cannot protect it.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/model-proxy-retirement.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 49 | the proxy's fresher tokens are handed back, its launcher files removed, and it runs once | KEEP | Detects: the proxy's fresher tokens are handed back, its launcher files removed, and it runs once.. |
| 119 | no proxy directory: nothing happens | KEEP | Detects: no proxy directory: nothing happens.. |

## apps/daemon/src/project-clone-ref-route.test.ts

**Independent contract:** README cloning and index.ts clone-ref route contract; Git ref safety.

**Stable seam and callers:** createServer project-create HTTP request before AccountsService clone side effect index.ts project creation route

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only route owner for typed ref refusal before clone; account tests validate actual git execution at a different boundary.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/project-clone-ref-route.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 67 | a bad ref is a 400 INVALID_REF and nothing is cloned | KEEP | Detects: a bad ref is a 400 INVALID_REF and nothing is cloned.. |

## apps/daemon/src/project-create-routes.test.ts

**Independent contract:** README filesystem/project creation, terminal initialCommand limit and Agent Profiles agent-chat restriction.

**Stable seam and callers:** createServer POST project/session requests with actual scratch directories index.ts project/session route registration

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Protects refusal/no-write and request validation; real PTY tests uniquely prove accepted commands execute and are not repeated route validation.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/project-create-routes.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 58 | creating a project refuses an existing NON-EMPTY directory | KEEP | Detects: creating a project refuses an existing NON-EMPTY directory.. |
| 77 | creating a project still succeeds on a fresh or existing EMPTY directory | KEEP | Detects: creating a project still succeeds on a fresh or existing EMPTY directory.. |
| 99 | a project name that is an existing FILE is refused, not a 500 | KEEP | Detects: a project name that is an existing FILE is refused, not a 500.. |
| 115 | initialCommand is rejected when it is over-long or carries control bytes | KEEP | Detects: initialCommand is rejected when it is over-long or carries control bytes.. |
| 145 | a terminal launch naming an Agent Profile is refused, never silently Global | KEEP | Detects: a terminal launch naming an Agent Profile is refused, never silently Global.. |

## apps/daemon/src/project-list-routes.test.ts

**Independent contract:** packages/api ProjectSummary and README secrets stay home; repository grouping contract.

**Stable seam and callers:** createServer project listing over scratch checkout metadata index.ts GET projects route

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only owner of listing serialization/omission/privacy; repo-id owns URL syntax but not which raw fields are sent to clients.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/project-list-routes.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 50 | project listings carry repoKey, repoName and a credential-free cloneUrl | KEEP | Detects: project listings carry repoKey, repoName and a credential-free cloneUrl.. |

## apps/daemon/src/push.test.ts

**Independent contract:** docs/orquester-mcp.md notify_user/approval and unified MCP design; Web Push payload and server principal rate limits.

**Stable seam and callers:** PushService sent Web Push payloads/observer events plus HTTP route/principal index.ts hooks/approvals/workflow push callers

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Distinct service sanitization/debounce and route principal binding; service fakes only intercept outbound push transport, not asserted payload/rate logic.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/push.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 38 | notify_user's push: flattened, capped text, deep-linked to the chat, and never an action button | KEEP | Detects: notify_user's push: flattened, capped text, deep-linked to the chat, and never an action button.. |
| 49 | rate limits: one push per chat per 5 minutes, one per external credential per minute, none for a person; every accepted call takes its slot | KEEP | Detects: rate limits: one push per chat per 5 minutes, one per external credential per minute, none for a person; every accepted call takes its slot.. |
| 72 | a rate-limited slot is taken even when nobody is subscribed, so the limit cannot be probed around | KEEP | Detects: a rate-limited slot is taken even when nobody is subscribed, so the limit cannot be probed around.. |
| 80 | an approval card pushes "Approval needed: <title>" for its chat, with no action button, debounced per chat | KEEP | Detects: an approval card pushes "Approval needed: <title>" for its chat, with no action button, debounced per chat.. |
| 93 | POST /api/push/notify: validated body, the agent's push always deep-links to its own chat, 429 RATE_LIMITED past the limit | REWRITE | Retain HTTP429, RATE_LIMITED code, retryAfterSeconds300, input refusals and principal-bound deep links; remove incidental complete retry message copy. |
| 127 | every push past its debounce or limit reaches the observer with its kind and deep link, subscribers or not; a test push does not | KEEP | Detects: every push past its debounce or limit reaches the observer with its kind and deep link, subscribers or not; a test push does not.. |
| 161 | an observer that throws is logged and never stops the push | KEEP | Detects: an observer that throws is logged and never stops the push.. |

## apps/daemon/src/recent-projects.test.ts

**Independent contract:** packages/api RecentProjectSummary and README workspace/project shape; persisted archive/recent-selection contract.

**Stable seam and callers:** RecentProjectsService over actual files, directories and lifecycle broadcasts index.ts project selection; saved-prompts.ts describeProjectPath

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only recent interaction ordering/count/liveness/archive owner; saved prompts reuse path classification but do not maintain recent state.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/recent-projects.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 12 | describeProjectPath accepts only <workspacesDir>/<workspace>/<project> | KEEP | Detects: describeProjectPath accepts only <workspacesDir>/<workspace>/<project>.. |
| 26 | markInteracted records only existing directories, one event each | KEEP | Detects: markInteracted records only existing directories, one event each.. |
| 51 | markInteracted upserts newest-first, counts, caps, and persists | KEEP | Detects: markInteracted upserts newest-first, counts, caps, and persists.. |
| 95 | list drops entries whose directory is gone, and persists the prune | KEEP | Detects: list drops entries whose directory is gone, and persists the prune.. |
| 127 | list joins the workspaces side-table for the archive curtain | KEEP | Detects: list joins the workspaces side-table for the archive curtain.. |
| 165 | markInteracted and snapshot re-read the curtain, not the set list() left behind | KEEP | Detects: markInteracted and snapshot re-read the curtain, not the set list() left behind.. |
| 213 | an unreadable side-table keeps the previous curtain rather than un-hiding | KEEP | Detects: an unreadable side-table keeps the previous curtain rather than un-hiding.. |
| 240 | load survives a corrupt file and drops only the bad entries | KEEP | Detects: load survives a corrupt file and drops only the bad entries.. |

## apps/daemon/src/registry-env.test.ts

**Independent contract:** README registry and per-launcher configuration/host-secret guarantees; native dotenv grammar and launcher environment keys.

**Stable seam and callers:** parseEnvFile and RegistryService get/list used by daemon registry routes and session launch; fixture bins are absolute and the file process has an empty PATH/HOME.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal parsed environment and exposed/internal data; parser owns grammar while service owns native file discovery, default-plus-override composition and privacy. No real installed agent is run.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/registry-env.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 24 | parseEnvFile handles common dotenv syntax | KEEP | Supported dotenv comments/quotes/export prefixes are misparsed. |
| 42 | RegistryService applies per-launcher env files without exposing them in registry responses | KEEP | Launcher environment is not loaded or secrets escape registry response. |
| 81 | the Claude entry turns its task tools on, and a per-launcher env file still decides | KEEP | The Claude launcher must expose its documented task tools and let the owner override launch environment values without losing unrelated registry defaults. |

## apps/daemon/src/repo-id.test.ts

**Independent contract:** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md; Git config/worktree format and README credential privacy.

**Stable seam and callers:** normalizeGitUrl/parseOriginUrl/detectRepoInfo/remoteRepoFields index.ts project listing and repository-scoped services

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only syntax/identity owner: fixed hostile URL cases and synthetic Git config/worktree files cover grouping without spawning git or exposing credentials.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/repo-id.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 28 | normalizeGitUrl collapses every URL form of one repo onto host/path | KEEP | Detects: normalizeGitUrl collapses every URL form of one repo onto host/path.. |
| 47 | normalizeGitUrl drops a userinfo whose password holds an unencoded @ | KEEP | Detects: normalizeGitUrl drops a userinfo whose password holds an unencoded @.. |
| 51 | normalizeGitUrl refuses a scheme URL whose authority is ambiguous (an unencoded / in the password) | KEEP | Detects: normalizeGitUrl refuses a scheme URL whose authority is ambiguous (an unencoded / in the password).. |
| 60 | detectRepoInfo: an ambiguous origin URL falls back to the realpathed root, and no remote fields | KEEP | Detects: detectRepoInfo: an ambiguous origin URL falls back to the realpathed root, and no remote fields.. |
| 70 | parseOriginUrl reads the first url of [remote "origin"] only | KEEP | Detects: parseOriginUrl reads the first url of [remote "origin"] only.. |
| 88 | parseOriginUrl honors git value syntax: quotes, escapes, comments, case | KEEP | Detects: parseOriginUrl honors git value syntax: quotes, escapes, comments, case.. |
| 101 | detectRepoInfo: a checkout with an origin yields the normalized id and the raw URL | KEEP | Detects: detectRepoInfo: a checkout with an origin yields the normalized id and the raw URL.. |
| 111 | detectRepoInfo: a local-only repo is identified by its realpathed root | KEEP | Detects: detectRepoInfo: a local-only repo is identified by its realpathed root.. |
| 123 | detectRepoInfo: a linked worktree resolves to its main repo's config and root | KEEP | Detects: detectRepoInfo: a linked worktree resolves to its main repo's config and root.. |
| 141 | detectRepoInfo: not a git checkout (or a broken gitfile) is null | KEEP | Detects: detectRepoInfo: not a git checkout (or a broken gitfile) is null.. |
| 150 | remoteRepoFields: https token userinfo never survives | KEEP | Detects: remoteRepoFields: https token userinfo never survives.. |
| 164 | remoteRepoFields: scp-like and ssh logins stay, an ssh password goes | KEEP | Detects: remoteRepoFields: scp-like and ssh logins stay, an ssh password goes.. |
| 174 | remoteRepoFields: malformed userinfo that stripping cannot remove yields nothing | KEEP | Detects: remoteRepoFields: malformed userinfo that stripping cannot remove yields nothing.. |
| 187 | remoteRepoFields: no parseable remote, no fields | KEEP | Detects: remoteRepoFields: no parseable remote, no fields.. |

## apps/daemon/src/saved-prompts-routes.test.ts

**Independent contract:** packages/api/src/saved-prompts.ts HTTP contracts; README project/workspace deletion and server-stamped principal security.

**Stable seam and callers:** createServer HTTP injection with real SavedPromptsService and scratch files index.ts saved-prompt routes/cascades

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Owns integrated HTTP adoption, cascades after successful filesystem deletion and principal enrichment. Non-protective readOnly probe is removed; actual no-write contract remains in service suite.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/saved-prompts-routes.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 113 | saved prompts: create, list, update, use and delete over HTTP | KEEP | Detects: saved prompts: create, list, update, use and delete over HTTP.. |
| 152 | saved prompts: refusals are { code, message } with the service's status | KEEP | Detects: saved prompts: refusals are { code, message } with the service's status.. |
| 189 | saved prompts: ?projectPath= adds that project's prompts to the global ones | KEEP | Detects: saved prompts: ?projectPath= adds that project's prompts to the global ones.. |
| 210 | repository prompts list and stay editable from another checkout after deleting the original workspace | KEEP | Detects: repository prompts list and stay editable from another checkout after deleting the original workspace.. |
| 241 | deleting a project, then its workspace, deletes their folder prompts | KEEP | Detects: deleting a project, then its workspace, deletes their folder prompts.. |
| 271 | a delete whose rm fails leaves the project's prompts and to-dos alone | KEEP | Detects: a delete whose rm fails leaves the project's prompts and to-dos alone.. |
| 294 | a read-only library answers reads, refuses writes with a 503, and never fails a project delete | KEEP | Detects: a read-only library answers reads, refuses writes with a 503, and never fails a project delete.. |
| 319 | a workspaces directory moved at runtime is followed by validation and cascades alike | KEEP | Detects: a workspaces directory moved at runtime is followed by validation and cascades alike.. |
| 353 | working diff route rejects missing and outside paths | KEEP | Detects: working diff route rejects missing and outside paths.. |
| 371 | saved prompts: createdBy and the pin refusal follow the server-stamped principal, never the body | KEEP | Detects: saved prompts: createdBy and the pin refusal follow the server-stamped principal, never the body.. |
| 401 | saved prompts: list rows name the workflows that reference each prompt, read live from the workflow store's reference index | KEEP | Detects: saved prompts: list rows name the workflows that reference each prompt, read live from the workflow store's reference index.. |
| 420 | GET /api/saved-prompts/:id answers one prompt whatever its scope (a repository prompt no checkout lists too); 404 when none | KEEP | Detects: GET /api/saved-prompts/:id answers one prompt whatever its scope (a repository prompt no checkout lists too); 404 when none.. |

## apps/daemon/src/saved-prompts.test.ts

**Independent contract:** packages/api/src/saved-prompts.ts, packages/config saved-prompt storage schema and saved-prompts.ts documented durable scope/principal/reference preconditions.

**Stable seam and callers:** SavedPromptsService, actual scratch JSON, event bus and reference-index HTTP preconditions index.ts saved-prompt library, workflow prompt consumers and MCP

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Service owns durable records/migrations/queues/authorization and reference races; routes retain request adoption, cascade composition and response status behavior. Reference discovery belongs to workflows/reference-index.test.ts; route list tests retain live public use projection.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/saved-prompts.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 144 | first-run starter prompts are usable global records persisted before mutation | KEEP | Detects: first-run starter prompts are usable global records persisted before mutation.. |
| 165 | the starters are seeded once: after deleting them, restarts never bring them back | KEEP | Detects: the starters are seeded once: after deleting them, restarts never bring them back.. |
| 184 | a corrupt file is moved aside byte for byte, and the library starts empty — not seeded | KEEP | Detects: a corrupt file is moved aside byte for byte, and the library starts empty — not seeded.. |
| 203 | an unknown version, or a file that is not a library at all, is treated as corrupt | KEEP | Detects: an unknown version, or a file that is not a library at all, is treated as corrupt.. |
| 224 | a corrupt file that cannot be moved aside makes the library read-only | KEEP | Detects: a corrupt file that cannot be moved aside makes the library read-only.. |
| 250 | a file that cannot be READ is left where it is, and the library is read-only | KEEP | Detects: a file that cannot be READ is left where it is, and the library is read-only.. |
| 278 | an unreadable (permission-denied) library is never moved or replaced | KEEP | Detects: an unreadable (permission-denied) library is never moved or replaced.. |
| 300 | the tolerant read sets aside only the malformed prompts, and keeps what a newer build added | KEEP | Detects: the tolerant read sets aside only the malformed prompts, and keeps what a newer build added.. |
| 356 | entries this build cannot read, and unknown top-level keys, survive every write untouched | KEEP | Detects: entries this build cannot read, and unknown top-level keys, survive every write untouched.. |
| 411 | create answers the whole record, writes it, and announces it | KEEP | Detects: create answers the whole record, writes it, and announces it.. |
| 448 | field limits are enforced with 400 INVALID_REQUEST | KEEP | Detects: field limits are enforced with 400 INVALID_REQUEST.. |
| 497 | tags are trimmed, blanks dropped, deduplicated case-insensitively (first spelling), then limited | KEEP | Detects: tags are trimmed, blanks dropped, deduplicated case-insensitively (first spelling), then limited.. |
| 527 | a create past the library limit is a 409 SAVED_PROMPTS_FULL | KEEP | Detects: a create past the library limit is a 409 SAVED_PROMPTS_FULL.. |
| 558 | update changes only what the patch names, stamps updatedAt, and announces it | KEEP | Detects: update changes only what the patch names, stamps updatedAt, and announces it.. |
| 601 | marking a prompt used stamps lastUsedAt and counts, without touching updatedAt | KEEP | Detects: marking a prompt used stamps lastUsedAt and counts, without touching updatedAt.. |
| 628 | delete removes the prompt, writes, and announces its id and scope | KEEP | Detects: delete removes the prompt, writes, and announces its id and scope.. |
| 644 | overlapping mutations are all on disk, in their final state | KEEP | Detects: overlapping mutations are all on disk, in their final state.. |
| 669 | a project path must be <workspaces>/<workspace>/<project>, inside the sandbox, an existing directory | KEEP | Detects: a project path must be <workspaces>/<workspace>/<project>, inside the sandbox, an existing directory.. |
| 712 | list answers the global prompts plus the named project's own, and validates the project | KEEP | Detects: list answers the global prompts plus the named project's own, and validates the project.. |
| 735 | project prompts are shared by normalized origin across checkouts and workspaces | KEEP | Detects: project prompts are shared by normalized origin across checkouts and workspaces.. |
| 767 | legacy prompts gain durable repository scope without losing fields or metadata | KEEP | Detects: legacy prompts gain durable repository scope without losing fields or metadata.. |
| 794 | a remote added after saving shares the prompt; moving scope resets repository identity | KEEP | Detects: a remote added after saving shares the prompt; moving scope resets repository identity.. |
| 822 | repository migration never reads Git config outside the project sandbox | KEEP | Detects: repository migration never reads Git config outside the project sandbox.. |
| 848 | repository prompts are shared with Git worktrees | KEEP | Detects: repository prompts are shared with Git worktrees.. |
| 861 | only a project that is its repository's top level has a repository key: a plain folder inside a repository, or a repository without an origin, keeps folder scope | KEEP | Detects: only a project that is its repository's top level has a repository key: a plain folder inside a repository, or a repository without an origin, keeps folder scope.. |
| 888 | a stale stored key never orphans a prompt: its own folder lists it, other checkouts of the folder's repository do not, nothing is rewritten | KEEP | Detects: a stale stored key never orphans a prompt: its own folder lists it, other checkouts of the folder's repository do not, nothing is rewritten.. |
| 906 | a read-only list upgrades no record (no write, no event); a normal list then binds it | KEEP | Detects: a read-only list upgrades no record (no write, no event); a normal list then binds it.. |
| 928 | deleting a project or a workspace takes its folder prompts along, announcing each one | KEEP | Detects: deleting a project or a workspace takes its folder prompts along, announcing each one.. |
| 976 | upserts and deletions reach the /events bus on the saved-prompts channel | KEEP | Detects: upserts and deletions reach the /events bus on the saved-prompts channel.. |
| 1001 | createdBy is derived from the principal: an agent's create is stamped, the user's and an external client's are not | KEEP | Detects: createdBy is derived from the principal: an agent's create is stamped, the user's and an external client's are not.. |
| 1018 | pinning an agent-created prompt is the user's alone: 403 AGENT_PROMPT_PIN_REFUSED for agents and external clients | KEEP | Detects: pinning an agent-created prompt is the user's alone: 403 AGENT_PROMPT_PIN_REFUSED for agents and external clients.. |
| 1036 | createdBy tolerance: a newer kind, unknown fields and a null survive the read and every rewrite | KEEP | Detects: createdBy tolerance: a newer kind, unknown fields and a null survive the read and every rewrite.. |
| 1063 | savedPromptWorkflowUses: every workflow whose agent block names a saved prompt, once each (from the workflow store's reference index) | DELETE | Fails unique protection: index tests already own reference deduplication/absent references, and real list routes own projection/live updates. Secondary expectations came from production savedPromptIdsOf, failing independent oracle. Internalize the wrapper export. Surviving owner: apps/daemon/src/workflows/reference-index.test.ts; apps/daemon/src/saved-prompts-routes.test.ts :: saved prompts: list rows name the workflows that reference each prompt, read live from the workflow store's reference index. |
| 1108 | expectWorkflowUses on PUT and DELETE: refused 409 WORKFLOW_USES_CHANGED, nothing saved, unless the index's uses are exactly those; without it (the UI) nothing changes | KEEP | Detects: expectWorkflowUses on PUT and DELETE: refused 409 WORKFLOW_USES_CHANGED, nothing saved, unless the index's uses are exactly those; without it (the UI) nothing changes.. |
| 1134 | expectWorkflowUses race: a workflow saved while the write awaits is seen in the write's own step, and the write is refused | KEEP | Detects: expectWorkflowUses race: a workflow saved while the write awaits is seen in the write's own step, and the write is refused.. |
| 1146 | expectWorkflowUses with no workflow index: refused 409, never read as no uses; a write without it goes through | KEEP | Detects: expectWorkflowUses with no workflow index: refused 409, never read as no uses; a write without it goes through.. |
| 1163 | list rows carry usesUnknown when the index cannot tell which workflows use a prompt, and only then | KEEP | Detects: list rows carry usesUnknown when the index cannot tell which workflows use a prompt, and only then.. |

## apps/daemon/src/search.test.ts

**Independent contract:** README file search/gitignore/sandbox behavior; packages/api FsSearch/FsFileList response offsets, caps and refusal contracts; packages/config glob grammar.

**Stable seam and callers:** searchProjectFiles/listProjectFiles against actual scratch files, Git and both real-ripgrep/fallback-node discovery paths index.ts file search and listing routes; workflow file readers

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Different engines own distinct code/protocol paths: retaining shared behavioral examples detects backend disagreement rather than duplicate implementation. Explicit Unicode offsets, symlink/no-follow, ignored files, caps, cancellation and contextual refusal cases are not covered by the pure glob compiler.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/search.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 135 | node: literal match reports full-line column and matchLength | KEEP | Detects: node: literal match reports full-line column and matchLength.. |
| 146 | node: long line windows start/end but keeps true column | KEEP | Detects: node: long line windows start/end but keeps true column.. |
| 159 | node: İ case-fold maps hits back to original offsets | KEEP | Detects: node: İ case-fold maps hits back to original offsets.. |
| 172 | node: İstanbul folds to itself and reports its true length | KEEP | Detects: node: İstanbul folds to itself and reports its true length.. |
| 186 | node: case-insensitive 'i' against İ yields a non-empty, correctly-sliced match | KEEP | Detects: node: case-insensitive 'i' against İ yields a non-empty, correctly-sliced match.. |
| 199 | node: case-insensitive folds ASCII case | KEEP | Detects: node: case-insensitive folds ASCII case.. |
| 209 | node: CRLF lines have no trailing carriage return | CONSOLIDATE | The five cases traverse the same immutable tree with the same public search options. One response retains positive CRLF matching and absent binary/oversized/vendor/symlink/secret results, catching each original failure while eliminating four duplicate traversals. The oversized fixture now puts its match before the1MiB boundary, so incorrectly scanning a capped prefix cannot pass as skipping the whole file. Surviving owner: apps/daemon/src/search.test.ts :: node: default search normalizes CRLF and excludes binary, oversized, vendored and symlinked files. |
| 221 | node: binary file with a NUL is skipped | CONSOLIDATE | The five cases traverse the same immutable tree with the same public search options. One response retains positive CRLF matching and absent binary/oversized/vendor/symlink/secret results, catching each original failure while eliminating four duplicate traversals. The oversized fixture now puts its match before the1MiB boundary, so incorrectly scanning a capped prefix cannot pass as skipping the whole file. Surviving owner: apps/daemon/src/search.test.ts :: node: default search normalizes CRLF and excludes binary, oversized, vendored and symlinked files. |
| 226 | node: file over 1 MiB is skipped | CONSOLIDATE | The five cases traverse the same immutable tree with the same public search options. One response retains positive CRLF matching and absent binary/oversized/vendor/symlink/secret results, catching each original failure while eliminating four duplicate traversals. The oversized fixture now puts its match before the1MiB boundary, so incorrectly scanning a capped prefix cannot pass as skipping the whole file. Surviving owner: apps/daemon/src/search.test.ts :: node: default search normalizes CRLF and excludes binary, oversized, vendored and symlinked files. |
| 231 | node: node_modules and .git are never searched | CONSOLIDATE | The five cases traverse the same immutable tree with the same public search options. One response retains positive CRLF matching and absent binary/oversized/vendor/symlink/secret results, catching each original failure while eliminating four duplicate traversals. The oversized fixture now puts its match before the1MiB boundary, so incorrectly scanning a capped prefix cannot pass as skipping the whole file. Surviving owner: apps/daemon/src/search.test.ts :: node: default search normalizes CRLF and excludes binary, oversized, vendored and symlinked files. |
| 239 | node: a symlink (here one escaping the root) is skipped entirely | CONSOLIDATE | The five cases traverse the same immutable tree with the same public search options. One response retains positive CRLF matching and absent binary/oversized/vendor/symlink/secret results, catching each original failure while eliminating four duplicate traversals. The oversized fixture now puts its match before the1MiB boundary, so incorrectly scanning a capped prefix cannot pass as skipping the whole file. Surviving owner: apps/daemon/src/search.test.ts :: node: default search normalizes CRLF and excludes binary, oversized, vendored and symlinked files. |
| 249 | node: whole-word excludes category/scatter but keeps cat and my_cat-adjacent | KEEP | Detects: node: whole-word excludes category/scatter but keeps cat and my_cat-adjacent.. |
| 259 | node: underscore counts as a word char (my_cat is not a whole-word cat) | KEEP | Detects: node: underscore counts as a word char (my_cat is not a whole-word cat).. |
| 269 | node: without whole-word every occurrence matches | KEEP | Detects: node: without whole-word every occurrence matches.. |
| 279 | node: include limits the searched files | KEEP | Detects: node: include limits the searched files.. |
| 285 | node: exclude removes matched files | KEEP | Detects: node: exclude removes matched files.. |
| 290 | node: unbalanced brace is INVALID_GLOB on the include field | KEEP | Detects: node: unbalanced brace is INVALID_GLOB on the include field.. |
| 303 | node: over-cap term count is INVALID_GLOB on the exclude field | KEEP | Detects: node: over-cap term count is INVALID_GLOB on the exclude field.. |
| 318 | node: regex mode is refused without ripgrep | KEEP | Detects: node: regex mode is refused without ripgrep.. |
| 332 | node: a pre-aborted signal rejects with REQUEST_ABORTED | KEEP | Detects: node: a pre-aborted signal rejects with REQUEST_ABORTED.. |
| 346 | node: an abort fired mid-search never returns a success payload | KEEP | Detects: node: an abort fired mid-search never returns a success payload.. |
| 361 | both engines: no empty file at the cap and totalMatches respects it | KEEP | Detects: both engines: no empty file at the cap and totalMatches respects it.. |
| 380 | node: empty query is rejected | KEEP | Detects: node: empty query is rejected.. |
| 389 | node: a symlink cycle (self -> .) is not followed and terminates fast | KEEP | Detects: node: a symlink cycle (self -> .) is not followed and terminates fast.. |
| 410 | rg: skips symlink cycles and duplicate directory links | KEEP | Detects: rg: skips symlink cycles and duplicate directory links.. |
| 427 | node: near-cap results select the fixed path-order prefix; rg keeps the budget | KEEP | Detects: node: near-cap results select the fixed path-order prefix; rg keeps the budget.. |
| 467 | rg: regex mode matches | KEEP | Detects: rg: regex mode matches.. |
| 473 | rg: a bad regex is a 400 | KEEP | Detects: rg: a bad regex is a 400.. |
| 484 | rg: whole-word matches the node engine | KEEP | Detects: rg: whole-word matches the node engine.. |
| 491 | rg: node_modules and .git stay excluded | KEEP | Detects: rg: node_modules and .git stay excluded.. |
| 497 | rg: include glob limits files like the node engine | KEEP | Detects: rg: include glob limits files like the node engine.. |
| 502 | rg: byte offsets become character offsets for a unicode line | KEEP | Detects: rg: byte offsets become character offsets for a unicode line.. |
| 511 | node: a capped mixed-case dir selects the byte-order prefix; rg keeps the budget | KEEP | Detects: node: a capped mixed-case dir selects the byte-order prefix; rg keeps the budget.. |
| 536 | both engines: a literal [ ] in an include matches a literal filename, not a class | KEEP | Detects: both engines: a literal [ ] in an include matches a literal filename, not a class.. |
| 557 | rg: a glob the node parser accepts but rg rejects is INVALID_GLOB carrying the field | KEEP | Detects: rg: a glob the node parser accepts but rg rejects is INVALID_GLOB carrying the field.. |
| 614 | both engines: gitignored files are hidden by default and searched with includeIgnored | KEEP | Detects: both engines: gitignored files are hidden by default and searched with includeIgnored.. |
| 634 | both engines: an include glob never re-includes a gitignored file | KEEP | Detects: both engines: an include glob never re-includes a gitignored file.. |
| 653 | both engines: the file listing hides gitignored files unless includeIgnored | KEEP | Detects: both engines: the file listing hides gitignored files unless includeIgnored.. |
| 675 | both engines: a capped listing keeps the shallowest files | KEEP | Detects: both engines: a capped listing keeps the shallowest files.. |
| 696 | both engines: listing skips symlinks, .git and node_modules outside a git repo | KEEP | Detects: both engines: listing skips symlinks, .git and node_modules outside a git repo.. |
| 716 | listing: a pre-aborted signal rejects with REQUEST_ABORTED | KEEP | Detects: listing: a pre-aborted signal rejects with REQUEST_ABORTED.. |

## apps/daemon/src/session-initial-command.test.ts

**Independent contract:** README persistent terminals and index.ts documented server-side initialCommand behavior.

**Stable seam and callers:** LocalSessionManager with real sh PTY and output events index.ts session launch route

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only terminal execution owner: inject-route tests cannot detect commands lost between launch and PTY or unintended blank input.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-initial-command.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 40 | initialCommand is typed into the fresh PTY and run by the shell | KEEP | Detects: initialCommand is typed into the fresh PTY and run by the shell.. |
| 62 | a blank initialCommand writes nothing to the PTY | KEEP | Detects: a blank initialCommand writes nothing to the PTY.. |

## apps/daemon/src/session-launch-env.test.ts

**Independent contract:** README managed-account environment isolation and literal child argv contract.

**Stable seam and callers:** writeAddonEnvLaunchScript executed as a real child sessions.ts launcher composition

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only actual shell quoting/unset owner; NODE_OPTIONS session tests cover plugin composition rather than arbitrary literal argv and credential removal.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-launch-env.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 7 | launcher child receives env overrides, removals and literal arguments | KEEP | Detects: launcher child receives env overrides, removals and literal arguments.. |
| 21 | launcher removes inherited credentials even without env overrides | KEEP | Detects: launcher removes inherited credentials even without env overrides.. |

## apps/daemon/src/session-node-options.test.ts

**Independent contract:** README plugin/session configuration and packages/config documented Node --require option contribution contract.

**Stable seam and callers:** LocalSessionManager and SessionManager with real child-visible NODE_OPTIONS on isolated PTY/tmux sessions.ts launches on both backends

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Backend-specific environment precedence needs real launch coverage. Expectations now use literal Node option strings instead of production appendNodeRequireOption, so broken quoting/ordering can disagree with the oracle.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-node-options.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 98 | no preload active: the child's NODE_OPTIONS is the daemon's, untouched | KEEP | Detects: no preload active: the child's NODE_OPTIONS is the daemon's, untouched.. |
| 103 | a preload active: appended to the daemon's, the entry's or the launcher's NODE_OPTIONS | KEEP | Replace production-computed expected NODE_OPTIONS with literal --require/precedence values; real child execution on each backend can disagree with broken composition. Existing none/inherited/unset checks remain. |
| 120 | a preload active and no NODE_OPTIONS anywhere: just the preload | KEEP | Replace production-computed expected NODE_OPTIONS with literal --require/precedence values; real child execution on each backend can disagree with broken composition. Existing none/inherited/unset checks remain. |
| 131 | a launcher that unsets NODE_OPTIONS clears the inherited value; the preload is still added | KEEP | Replace production-computed expected NODE_OPTIONS with literal --require/precedence values; real child execution on each backend can disagree with broken composition. Existing none/inherited/unset checks remain. |
| 190 | the first session on a new server appends to the daemon's NODE_OPTIONS | KEEP | Replace production-computed expected NODE_OPTIONS with literal --require/precedence values; real child execution on each backend can disagree with broken composition. Existing none/inherited/unset checks remain. |
| 199 | a running server: appended to its global NODE_OPTIONS, which stays unchanged | KEEP | Replace production-computed expected NODE_OPTIONS with literal --require/precedence values; real child execution on each backend can disagree with broken composition. Existing none/inherited/unset checks remain. |
| 214 | the entry's and the launcher wrapper's NODE_OPTIONS are appended to | KEEP | Replace production-computed expected NODE_OPTIONS with literal --require/precedence values; real child execution on each backend can disagree with broken composition. Existing none/inherited/unset checks remain. |
| 230 | a launcher that unsets NODE_OPTIONS clears the inherited value; the preload is still added | KEEP | Replace production-computed expected NODE_OPTIONS with literal --require/precedence values; real child execution on each backend can disagree with broken composition. Existing none/inherited/unset checks remain. |
| 234 | a global value unset on the server: just the preload | KEEP | Replace production-computed expected NODE_OPTIONS with literal --require/precedence values; real child execution on each backend can disagree with broken composition. Existing none/inherited/unset checks remain. |

## apps/daemon/src/session-resize-settle.test.ts

**Independent contract:** packages/api terminal-stream.ts reset/replay protocol and ISessionManager settleResize completion guarantee.

**Stable seam and callers:** SessionManager resize/settleResize with isolated tmux and observed client/window dimensions session-stream.ts resize resynchronization

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Real idle tmux must apply resize before snapshot; controlled protocol tests cannot detect tmux timing. Removed direct-backend method-absence inventory has no independent behavior.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-resize-settle.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 55 | resolves once tmux has applied the size, for a program that prints nothing | KEEP | Detects: resolves once tmux has applied the size, for a program that prints nothing.. |
| 67 | resolves at once when no resize is outstanding | KEEP | Detects: resolves at once when no resize is outstanding.. |
| 76 | resolves on abort and for an unknown session | KEEP | Detects: resolves on abort and for an unknown session.. |

## apps/daemon/src/session-stream.test.ts

**Independent contract:** packages/api/src/terminal-stream.ts and README multiplexed terminal replay/reconnect contract.

**Stable seam and callers:** createSessionStream frame input/output with controllable snapshots and socket drain callbacks index.ts /ws stream route

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only deterministic owner of snapshot/exit/unsubscribe/backpressure/resize interleavings; PTY tests exercise actual backends, not congested socket ordering.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-stream.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 127 | sends the snapshot as a replay, then live output | KEEP | Detects: sends the snapshot as a replay, then live output.. |
| 137 | output produced during the capture follows the snapshot instead of being lost | KEEP | Detects: output produced during the capture follows the snapshot instead of being lost.. |
| 150 | an unsub during the capture wins and nothing streams | KEEP | Detects: an unsub during the capture wins and nothing streams.. |
| 162 | an unknown session ends at once | KEEP | Detects: an unknown session ends at once.. |
| 169 | a session that exited before the sub gets its snapshot then end | KEEP | Detects: a session that exited before the sub gets its snapshot then end.. |
| 180 | an exit during the capture ends after the snapshot, once | KEEP | Detects: an exit during the capture ends after the snapshot, once.. |
| 198 | output past the high-water mark is held, not sent, until the socket drains | KEEP | Detects: output past the high-water mark is held, not sent, until the socket drains.. |
| 213 | held output past its budget is dropped; the drain brings reset, a fresh snapshot, then live output | KEEP | Detects: held output past its budget is dropped; the drain brings reset, a fresh snapshot, then live output.. |
| 233 | a partial drain above the low-water mark keeps holding | KEEP | Detects: a partial drain above the low-water mark keeps holding.. |
| 248 | every terminal that overflowed is resynced; others are not | KEEP | Detects: every terminal that overflowed is resynced; others are not.. |
| 264 | an exit while held follows the held output | KEEP | Detects: an exit while held follows the held output.. |
| 279 | an exit while overflowed is delivered after the resync snapshot | KEEP | Detects: an exit while overflowed is delivered after the resync snapshot.. |
| 296 | output held during a resync that outgrows the budget triggers another resync | KEEP | Detects: output held during a resync that outgrows the budget triggers another resync.. |
| 318 | a slow link behind a snapshot near the budget does not loop on snapshots | KEEP | Detects: a slow link behind a snapshot near the budget does not loop on snapshots.. |
| 347 | after one real overflow a slow link recovers to live output | KEEP | Detects: after one real overflow a slow link recovers to live output.. |
| 376 | pong and end are never dropped | KEEP | Detects: pong and end are never dropped.. |
| 385 | a closed socket stops everything | KEEP | Assert no additional output/exit/pong frames reach the closed socket, instead of observing the fixture EventEmitter listener inventory. |
| 398 | the first resize after a sub re-snapshots once the backend applied it, not on a timer | KEEP | Detects: the first resize after a sub re-snapshots once the backend applied it, not on a timer.. |
| 420 | an unsub while waiting for the resize cancels the wait and the snapshot | KEEP | Detects: an unsub while waiting for the resize cancels the wait and the snapshot.. |
| 434 | input and resize reach the session | KEEP | Detects: input and resize reach the session.. |

## apps/daemon/src/sessions-activity.test.ts

**Independent contract:** README attention signalling; session activity and lifecycle ordering consumed by clients.

**Stable seam and callers:** LocalSessionManager real exiting PTY with lifecycle/activity output sessions.ts PTY process lifecycle

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Uniquely verifies backend exit wiring/order; ActivityTracker unit tests cannot detect manager forgetting or prematurely broadcasting exit attention.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/sessions-activity.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 12 | LocalSessionManager raises finished attention when the command exits | KEEP | Detects: LocalSessionManager raises finished attention when the command exits.. |

## apps/daemon/src/subagent-cache-ttl-route.test.ts

**Independent contract:** Usage API/config cache-TTL preference/status contracts; recorded subagent request protocol and specified 5m/1h cache tariffs; weekly auto-decision, minimum observation and 14-day analysis documented by controller public API and comments.

**Stable seam and callers:** estimateSubagentCacheCosts/decideSubagentCacheTtl typed calculation boundary and SubagentCacheTtlController resolve/status/init used by daemon launch and usage routes; the HTTP case reads real app config.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Manually calculated token-unit costs, independent timestamps and literal outcomes; calculators own cost/order decisions, controller owns persistence/schedules/scanner readiness, route owns live preference/auth wiring. Duplicated setup/oracles are consolidated below.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/subagent-cache-ttl-route.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 30 | the status route answers for the stored mode, to authenticated clients only | REWRITE | Keep real router auth401, current fixed5m→1h configuration reads and defaultauto with unavailable usage. Remove repeated600-request/16%-saving/week-policy assertions already owned by subagent-cache-ttl.test.ts. Clean the scratch directory. |

## apps/daemon/src/subagent-cache-ttl.test.ts

**Independent contract:** Usage API/config cache-TTL preference/status contracts; recorded subagent request protocol and specified 5m/1h cache tariffs; weekly auto-decision, minimum observation and 14-day analysis documented by controller public API and comments.

**Stable seam and callers:** estimateSubagentCacheCosts/decideSubagentCacheTtl typed calculation boundary and SubagentCacheTtlController resolve/status/init used by daemon launch and usage routes; the HTTP case reads real app config.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Manually calculated token-unit costs, independent timestamps and literal outcomes; calculators own cost/order decisions, controller owns persistence/schedules/scanner readiness, route owns live preference/auth wiring. Duplicated setup/oracles are consolidated below.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/subagent-cache-ttl.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 39 | a 5m subagent that re-writes its prefix after a 10 minute wait would have read it at 1h | KEEP | A five-minute cache rewrite after ten idle minutes must cost 250000 versus 210000 under one hour, even when transcript requests arrive reversed. Surviving fixed-cost owner receives reversed transcript requests, preserving sorting protection without a second self-referential estimator call. |
| 45 | a subagent that never waits 5 minutes only pays the dearer 1h write | KEEP | A busy subagent with no cache-expiry wait must incur the dearer one-hour writes without an invented read saving. |
| 51 | a wait of an hour or more expires both caches, so only the write price differs | KEEP | A gap of at least one hour must expire both cache lifetimes; estimating a one-hour cache hit would choose an incorrect billing mode. |
| 56 | a 1h subagent that read its prefix after a wait would have re-written it at 5m | KEEP | A subagent actually using one-hour cache must estimate the five-minute rewrite after a wait while preserving externally warmed shared tokens. |
| 67 | auto picks 1h when it would have been more than 5% cheaper | KEEP | Auto mode must select one hour for a meaningful saving and report the measured -16 percent over sufficient requests. |
| 75 | auto picks 5m when 1h would have been more than 5% dearer | KEEP | Auto mode must return five minutes when one-hour write overhead makes that lifetime materially dearer. |
| 81 | auto keeps the current choice when the two are within 5% | KEEP | A near-equal estimated cost must keep the current lifetime, preventing unnecessary weekly switching. |
| 91 | auto falls back to 5m when there are too few subagent requests to judge | KEEP | Insufficient observed usage must choose the conservative five-minute default with an explicit insufficient result. |
| 103 | always-1h and always-5m apply as chosen without reading any usage | OPTIMIZE | An explicit one-hour/five-minute preference must apply without scanning or consulting usage. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 109 | auto decides from the last 14 days and keeps the decision for a week | OPTIMIZE | Auto mode must scan the documented 14-day window, hold its decision until seven days and reevaluate/persist when that interval ends. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 129 | auto's decision survives a daemon restart | OPTIMIZE | A current cache-TTL decision must survive restart without re-reading usage. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 137 | auto waits for the transcript scan instead of deciding on nothing | OPTIMIZE | A scanner that has not completed must not persist an insufficient-data verdict and delay the first meaningful decision. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 147 | auto looks again the next day when there was too little usage to judge | OPTIMIZE | Insufficient usage must retry after one day, rather than waiting a week or rescanning on every launch. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 159 | an unreadable stored decision is ignored | OPTIMIZE | Malformed persisted decision bytes must not prevent the next valid auto decision. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 167 | status reports the mode, what launches get, and auto's last and next check | OPTIMIZE | Controller status must expose the effective lifetime/decision schedule; a fixed mode must stop scheduling auto checks. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |

## apps/daemon/src/system-status.test.ts

**Independent contract:** packages/api SystemResources/Processes/Details contracts; Linux proc(5) formats; README system security and own-user/process protection.

**Stable seam and callers:** public parsers plus SystemStatusService on actual isolated processes and /proc index.ts system status/process API

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Raw fixtures own numeric/protocol parsing; real process cases uniquely own process identity/protected ancestor/UID/signal behavior and orphan attribution. Retained parser tests do not spawn expensive hosts.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/system-status.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 106 | parseCpuSample sums the aggregate line and counts iowait as idle | KEEP | Detects: parseCpuSample sums the aggregate line and counts iowait as idle.. |
| 111 | parseCpuSample tolerates junk | KEEP | Detects: parseCpuSample tolerates junk.. |
| 116 | parseMemInfo prefers MemAvailable and converts kB to bytes | KEEP | Detects: parseMemInfo prefers MemAvailable and converts kB to bytes.. |
| 121 | parseMemInfo falls back to MemFree on pre-3.14 kernels | KEEP | Detects: parseMemInfo falls back to MemFree on pre-3.14 kernels.. |
| 127 | parseProcStatus reads name, ppid and RSS | KEEP | Detects: parseProcStatus reads name, ppid and RSS.. |
| 132 | parseProcStatus reads the real uid when the status names one | KEEP | Detects: parseProcStatus reads the real uid when the status names one.. |
| 137 | launchMarkerOf reads the agent host's launch marker and the chat it belongs to | KEEP | Detects: launchMarkerOf reads the agent host's launch marker and the chat it belongs to.. |
| 153 | parseProcStatus tolerates a kernel thread with no VmRSS | KEEP | Detects: parseProcStatus tolerates a kernel thread with no VmRSS.. |
| 162 | parseCmdline joins the NUL-separated argv | KEEP | Detects: parseCmdline joins the NUL-separated argv.. |
| 167 | decodeProcNetAddress decodes little-endian v4 and v6 addresses | KEEP | Detects: decodeProcNetAddress decodes little-endian v4 and v6 addresses.. |
| 180 | decodeProcNetAddress rejects malformed cells | KEEP | Detects: decodeProcNetAddress rejects malformed cells.. |
| 186 | parseProcNetTcp keeps only LISTEN rows | KEEP | Detects: parseProcNetTcp keeps only LISTEN rows.. |
| 196 | parseSocketInode only matches socket links | KEEP | Detects: parseSocketInode only matches socket links.. |
| 220 | collectTree tags descendants with the nearest ancestor session | KEEP | Detects: collectTree tags descendants with the nearest ancestor session.. |
| 240 | collectTree terminates on a corrupted parent cycle | KEEP | Detects: collectTree terminates on a corrupted parent cycle.. |
| 248 | descendsFromRoot does not loop on a parent cycle | KEEP | Detects: descendsFromRoot does not loop on a parent cycle.. |
| 256 | shieldedPids covers each guarded pid and every ancestor up to init, cycle-safe | KEEP | Detects: shieldedPids covers each guarded pid and every ancestor up to init, cycle-safe.. |
| 271 | parseProcStat survives a comm containing spaces and parentheses | KEEP | Detects: parseProcStat survives a comm containing spaces and parentheses.. |
| 280 | parseProcStatDetail reads state, cpu ticks, threads and starttime past a weird comm | KEEP | Detects: parseProcStatDetail reads state, cpu ticks, threads and starttime past a weird comm.. |
| 300 | processStateOf names every scheduler state and falls back to other | KEEP | Detects: processStateOf names every scheduler state and falls back to other.. |
| 307 | parseProcIo reads the block-layer byte counters, not rchar/wchar | KEEP | Detects: parseProcIo reads the block-layer byte counters, not rchar/wchar.. |
| 313 | parseNetDev sums physical interfaces and skips loopback, bridges and tunnels | KEEP | Detects: parseNetDev sums physical interfaces and skips loopback, bridges and tunnels.. |
| 331 | parseDiskStats counts whole disks only, in 512-byte sectors | KEEP | Detects: parseDiskStats counts whole disks only, in 512-byte sectors.. |
| 344 | parsePasswd maps uids to names and skips malformed lines | KEEP | Detects: parsePasswd maps uids to names and skips malformed lines.. |
| 349 | parseBootTime reads btime from /proc/stat | KEEP | Detects: parseBootTime reads btime from /proc/stat.. |
| 354 | parseCgroupPath prefers the unified v2 line, then v1's systemd hierarchy | KEEP | Detects: parseCgroupPath prefers the unified v2 line, then v1's systemd hierarchy.. |
| 369 | ratePerSecond and processCpuPercent refuse resets and empty intervals | KEEP | Detects: ratePerSecond and processCpuPercent refuse resets and empty intervals.. |
| 380 | procMetrics diffs only the same process within the staleness window | REWRITE | Keep PID reuse/staleness and zero/sliver rate handling. Replace sample-map object identity with a subsequent5% reported CPU rate; replacing the baseline with the200ms sliver would yield4.5%, so the oracle distinguishes the intended regression without requiring map reuse. |
| 422 | cpuPercentFromSamples is the busy share of the delta | KEEP | Detects: cpuPercentFromSamples is the busy share of the delta.. |
| 431 | resolveSocketOwners picks the lowest pid sharing a listen socket | KEEP | Detects: resolveSocketOwners picks the lowest pid sharing a listen socket.. |
| 469 | resources() reports an unmeasurable volume as unknown, not as 0 bytes | KEEP | Detects: resources() reports an unmeasurable volume as unknown, not as 0 bytes.. |
| 483 | verifyProcessIdentity rejects a pid whose parent changed under us | KEEP | Detects: verifyProcessIdentity rejects a pid whose parent changed under us.. |
| 507 | kill() refuses with a discriminating code, kills our own user's processes and never another user's | KEEP | Detects: kill() refuses with a discriminating code, kills our own user's processes and never another user's.. |
| 574 | kill() sends SIGKILL when asked, ending a process SIGTERM cannot, and refuses any other signal | KEEP | Detects: kill() sends SIGKILL when asked, ending a process SIGTERM cannot, and refuses any other signal.. |
| 604 | a process carrying the agent host's launch marker is managed even as an orphan: listed, labelled, killable | KEEP | Detects: a process carrying the agent host's launch marker is managed even as an orphan: listed, labelled, killable.. |
| 647 | a marked process whose parent still runs outside every root is no orphan: listed unmanaged, stoppable as our user's | KEEP | Detects: a marked process whose parent still runs outside every root is no orphan: listed unmanaged, stoppable as our user's.. |
| 682 | kill() refuses a protectedPids entry and every process it runs under | KEEP | Detects: kill() refuses a protectedPids entry and every process it runs under.. |
| 722 | processes() lists only our own tree unless the whole host is asked for | KEEP | Detects: processes() lists only our own tree unless the whole host is asked for.. |
| 732 | processes() lists the whole host, marks our tree managed and tags the daemon and agent host | KEEP | Detects: processes() lists the whole host, marks our tree managed and tags the daemon and agent host.. |
| 772 | processDetails() resolves our own exe and cwd, refuses a bad pid and reports a gone one | KEEP | Detects: processDetails() resolves our own exe and cwd, refuses a bad pid and reports a gone one.. |
| 792 | resources() reports host rates, load, uptime and identity | KEEP | Detects: resources() reports host rates, load, uptime and identity.. |

## apps/daemon/src/terminal-history.test.ts

**Independent contract:** packages/api terminal-stream.ts replay bytes and README reconnect scrollback; ECMA-48 query suppression/Unicode preservation.

**Stable seam and callers:** TerminalOutputRing and sanitizeTerminalReplayChunk outputs sessions.ts and boxes/remote/exec/terminals.ts

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Ring tests own externally replayed content/cap/boundary effects; byte filter tables own terminal query classes. Removed safeCutIndex helper tests duplicated ring results and pinned a private integer strategy.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/terminal-history.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 20 | keeps everything below the cap, in order | KEEP | Detects: keeps everything below the cap, in order.. |
| 27 | retains at most the cap and only ever drops from the front | REWRITE | Retain every append's cap, chronological output suffix and line-boundary checks. Remove the private 1024-character cut-search-window floor; it has no replay contract. |
| 44 | large single appends are trimmed to the cap | KEEP | Detects: large single appends are trimmed to the cap.. |
| 52 | never starts with a lone low surrogate | KEEP | Detects: never starts with a lone low surrogate.. |
| 63 | trimming does not start the replay inside an escape sequence | KEEP | Detects: trimming does not start the replay inside an escape sequence.. |
| 72 | strips queries split across appends and keeps the rest | KEEP | Detects: strips queries split across appends and keeps the rest.. |
| 79 | an unterminated huge OSC is stored rather than held forever | KEEP | Detects: an unterminated huge OSC is stored rather than held forever.. |
| 88 | clear empties it | KEEP | Detects: clear empties it.. |
| 100 | passes plain text through untouched | KEEP | Detects: passes plain text through untouched.. |
| 131 | `strips the ${name}` | KEEP | Protects the caller-visible outcome named here: `strips the ${name}`. assert.equal(sanitize(`a${sequence}b`).text, "ab") |
| 149 | `keeps ${name}` | KEEP | Protects the caller-visible outcome named here: `keeps ${name}`. assert.equal(sanitize(`a${sequence}b`).text, `a${sequence}b`) |
| 154 | holds a sequence split across chunks until it completes | KEEP | Detects: holds a sequence split across chunks until it completes.. |
| 161 | a lone trailing ESC is pending, not dropped | KEEP | Detects: a lone trailing ESC is pending, not dropped.. |

## apps/daemon/src/tmux-history-limit.test.ts

**Independent contract:** packages/api TERMINAL_SCROLLBACK_LINES and tmux history-limit fixed-at-pane-creation behavior.

**Stable seam and callers:** Tmux.newSession on a dedicated socket and actual pane history limits sessions.ts persistent backend

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only owner of tmux history capacity/new-versus-existing compatibility; terminal ring tests exercise separate direct/fallback storage.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/tmux-history-limit.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 13 | new sessions keep the client's scrollback in history; existing panes keep theirs | KEEP | Detects: new sessions keep the client's scrollback in history; existing panes keep theirs.. |

## apps/daemon/src/tmux-service-session.test.ts

**Independent contract:** README desktop/session persistence and tmux service namespace exclusion from user-session reaper.

**Stable seam and callers:** Tmux service/user session listings on isolated socket; guarded calls before process execution desktop manager and service lifecycle callers

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only service-session visibility owner. Invalid namespace checks now require the intended guard reason and need no tmux installation or scratch server.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/tmux-service-session.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 29 | service session lives outside orq- namespace and survives listSessions/reattach scans | KEEP | Detects: service session lives outside orq- namespace and survives listSessions/reattach scans.. |
| 43 | newServiceSession rejects non-orqsvc names | KEEP | Namespace refusal happens before tmux execution: remove executable/version/scratch-server prerequisites and require an orqsvc- guard error, preventing an unrelated tmux failure from satisfying the negative case. |

## apps/daemon/src/tmux-service-window.test.ts

**Independent contract:** Desktop design §5.2 service windows/listing and tmux namespace isolation contract.

**Stable seam and callers:** Tmux actual named service windows/pane PIDs plus guarded calls desktops/manager.ts and desktop-host.ts

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Owns named multiwindow listing/absent server behavior; session tests do not create app windows. Namespace guard checks now reject for the intended reason without tmux setup.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/tmux-service-window.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 25 | service windows: named first window, extra windows, pane pids | KEEP | Detects: service windows: named first window, extra windows, pane pids.. |
| 58 | service window helpers keep the orqsvc- guard | KEEP | Namespace refusal happens before tmux execution: remove executable/version/scratch-server prerequisites and require an orqsvc- guard error, preventing an unrelated tmux failure from satisfying the negative case. |
| 68 | listServiceSessions is empty when no server runs | KEEP | Detects: listServiceSessions is empty when no server runs.. |

## apps/daemon/src/tmux.test.ts

**Independent contract:** README service-host shell launch support: nologin daemon accounts still launch interactive shells.

**Stable seam and callers:** sessionEnvBase child environment with actual executable candidates tmux.ts/session launch environment callers

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only login-shell fallback owner; child env override tests cannot detect an invalid daemon account shell being inherited.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/tmux.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 6 | sessionEnvBase replaces nologin shell for child PTYs | KEEP | Detects: sessionEnvBase replaces nologin shell for child PTYs.. |
| 20 | sessionEnvBase preserves an executable interactive shell | KEEP | Detects: sessionEnvBase preserves an executable interactive shell.. |

## apps/daemon/src/todos.test.ts

**Independent contract:** README daemon-owned synced to-do lists and atomic durable TodoListManager persistence contract.

**Stable seam and callers:** concurrent create/update followed by independent manager reload and directory inspection index.ts todo routes and MCP/workflow callers

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Only concurrent todo-persist race owner; route/SDK tests do not execute overlapping real filesystem writes.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/todos.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 14 | overlapping persists never share the tmp file: every change reaches the file, nothing fails, no tmp is left | KEEP | Detects: overlapping persists never share the tmp file: every change reaches the file, nothing fails, no tmp is left.. |

## apps/daemon/src/usage-aggregate.test.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/usage-aggregate.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 19 | worst-account picks the highest-percent window per field across accounts | KEEP | Pooled session/weekly quotas choose the wrong independent account maximum. |
| 35 | System base participates in the pool and can be the worst source | KEEP | System source is omitted from pooled warning. |
| 52 | carries the resets/capacity of the chosen worst window and its freshness | KEEP | Chosen window loses reset/capacity or freshness timestamp. |
| 74 | null windows everywhere leave head windows null and mark stale | KEEP | No usable windows falsely show a fresh reading. |
| 83 | an expired window (resetsAt in the past) never wins the worst-account pick | KEEP | Reset 100% quota continues to dominate current pooled usage. |
| 101 | windows that all expired leave the head window null | KEEP | All expired windows continue showing exhausted quota. |
| 110 | historical readings stay on account cards without driving current quota aggregates | KEEP | Historical lastKnown quotas and needsReauth must remain visible on account cards while being excluded from current aggregate limits. |
| 120 | the System base is exposed as a `system` row (expired windows scrubbed) | KEEP | System breakdown displays stale pre-reset quota. |
| 144 | no System base ⇒ no system row | KEEP | Managed-only account set invents a System row. |
| 149 | head is not stale when a fresh window is shown even if another account is stale | KEEP | One stale account greys a fresh pooled reading. |

## apps/daemon/src/usage-chat-threads.test.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/usage-chat-threads.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 38 | sums each settled turn's reported cost and tokens per UTC day and model, for that agent's chats only | KEEP | Only the configured agent's settled chat turns may contribute UTC-day/model token and reported-cost totals; model changes must affect subsequent turns. |
| 60 | appended turns are counted once; a partial last line waits for its newline; a rebuilt log is read again; a removed thread drops out | KEEP | Incremental thread scans must count appended complete turns once, defer partial rows, replace rewritten history and drop deleted threads. |
| 79 | no threads directory yet: no rows | KEEP | Usage before the threads directory exists must yield an empty snapshot instead of startup failure. |
| 84 | tolerant of every line it cannot use: malformed, unknown or old shapes are skipped, never thrown on | KEEP | Malformed/old/unknown chat-log rows must not crash scanning or contribute fabricated cost; valid settlements after junk must still count. |
| 118 | an over-long line is skipped and counted, never held whole; lines across read chunks still parse, a multi-byte character across a chunk too | KEEP | Oversize thread rows must be skipped once across appended chunks; small reads must preserve UTF8 model names and later valid turns. |

## apps/daemon/src/usage-claude-state.test.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/usage-claude-state.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 55 | asks the endpoint at most once per window, even with nothing to show | KEEP | Burst requests exceed five-minute provider budget. |
| 82 | a restart keeps the last reading and waits out the window the previous process opened | KEEP | Restart loses last reading or repeats recently budgeted request. |
| 100 | expired or cleared credentials keep historical quotas across restarts and recover on login | KEEP | Expired/cleared/deleted credentials must preserve literal historical quota/observation values after restart; renewed credentials must restore live numbers and clear reauthentication. Replace values copied from the first implementation response with literal observed percentages, reset timestamps and asOf, so a wrong initial parser/lastKnown payload fails. |
| 154 | a 429's Retry-After survives a restart and the last reading is served greyed meanwhile | KEEP | Retry-After/grey stale value is forgotten on restart. |
| 177 | a live reading replaces the account windows, keeps the scoped ones, and skips the poll | KEEP | Out-of-order live data overwrites fresh usage or unnecessary endpoint poll occurs. |
| 211 | a live reading on an account with no reading yet stands on its own | KEEP | Fresh live-only quota remains unavailable before endpoint reading. |
| 223 | a stamp from the future (the clock moved back) does not block the endpoint | KEEP | Clock rollback permanently blocks polling. |
| 232 | UsageStateFile round-trips, drops what does not parse and moves a corrupt file aside | KEEP | Usage cache load must round-trip a valid reading, discard malformed entries safely and quarantine corrupt storage bytes. |
| 270 | a thread's live windows become the account's session and weekly readings | KEEP | Thread provider usage windows map/clamp to wrong account slots. |

## apps/daemon/src/usage-codex-wham.test.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/usage-codex-wham.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 8 | maps plan_type and primary/secondary windows | KEEP | WHAM payload maps plan/window/reset into wrong API fields. |
| 27 | week-only primary_window (7d limit, no secondary) → weekly slot | KEEP | Week-only plan incorrectly consumes session slot. |
| 43 | unparseable payload → available:false | KEEP | Unrecognized WHAM body falsely reports available quota. |

## apps/daemon/src/usage-expiry.test.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/usage-expiry.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 13 | parseClaudeUsage drops a window whose reset time has already passed | KEEP | Parsed already-reset Claude window still reports exhausted quota. |
| 26 | expired-token lastGood serves only windows that have not reset yet | KEEP | Cached last-good reading outlives quota reset while token prevents refetch. |
| 82 | expired-token lastGood serves a refilled 5h window as 0% instead of dropping it | KEEP | A previously observed rolling five-hour window must refill to zero after reset while a still-current weekly cap remains visible. |
| 128 | a source that never read a 5h window still serves none | KEEP | A source with no observed session window must not fabricate a zero-percent session bar after token expiry. |

## apps/daemon/src/usage-first-reading.test.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/usage-first-reading.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 6 | whenFirstReading waits for the first reading after start, and is bounded | KEEP | Workflow boot account selection must wait for the first usable reading, and a controlled timer must bound waiting for a source that cannot finish. |

## apps/daemon/src/usage-parse.check.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx src/usage-parse.check.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| script | Claude legacy shape | KEEP | Observed five_hour/seven_day utilization fields must normalize to the independent 45/69 session/weekly values and Max 20x plan. |
| script | Claude limits[] shape | KEEP | The alternate limits[] response must normalize session and weekly_all slots. |
| script | utilization epoch leak #52326 | KEEP | A leaked epoch in utilization must be dropped while the valid weekly value survives. |
| script | Codex primary/secondary duration | KEEP | Recorded rollout primary/secondary windows must normalize 3/37 percent and Pro plan. |
| script | Codex week-only primary | KEEP | A sole seven-day primary pool must appear as weekly, never session. |
| script | Codex reset-distance fallback | KEEP | Without duration metadata a far-future reset must identify the weekly pool. |
| script | Codex expired secondary | KEEP | An expired secondary reading must disappear while a current primary survives. |
| script | last token_count and garbage lines | KEEP | The latest native token_count rate_limits must win; blank/malformed lines cannot create a reading. |
| script | Grok weekly billing pool | KEEP | Native credit percent/period/tier must yield a weekly-only 22.4 percent pool. |
| script | Grok proto3 omitted percent | KEEP | An omitted proto3 scalar in a current billing period must mean zero usage, not unavailable. |
| script | Grok expired/malformed billing | KEEP | Past-period and malformed billing payloads must never claim current quota. |

## apps/daemon/src/usage-scoped.test.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/usage-scoped.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 34 | parseClaudeUsage surfaces a model-scoped weekly limit alongside the legacy windows | KEEP | Legacy quota fields mask concurrent model-scoped cap. |
| 43 | parseClaudeUsage drops scoped windows that are unlabeled, expired, or garbage | KEEP | Unlabeled/expired/garbage scoped window renders as valid quota. |
| 64 | parseClaudeUsage keeps scoped windows in the limits[]-only shape too | KEEP | Limits-only response loses model cap. |
| 80 | aggregateWorstAccountUsage carries scoped windows on account rows and the system row | KEEP | Account/System scoped cap or its expiry disappears during aggregation. |
| 110 | stale last-known reading drops scoped windows whose reset has passed | KEEP | Expired cached model cap remains exhausted when token prevents fetch. |

## apps/daemon/src/usage-sources.check.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx src/usage-sources.check.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| script | Claude first 429 remains signed in | OPTIMIZE | A credentialed account whose first poll is rate-limited must stay available/stale with its credential-derived plan and no invented quota. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Claude no credentials | OPTIMIZE | A home without native credentials and prior readings must report no signed-in source. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Codex newest empty log fallback | OPTIMIZE | An empty newer rollout cannot mask the older real token_count reading when WHAM is down. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Codex API-key mode | OPTIMIZE | API-key mode must suppress subscription quota even when prior OAuth rollout files remain in that home. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Codex missing auth | OPTIMIZE | Missing auth.json must still allow a real rollout reading. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Codex missing access token | OPTIMIZE | A native file without access_token must still allow a real rollout reading. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Grok no credentials anywhere | OPTIMIZE | No CLI or explicit managed credential must report no linked source. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Grok managed billing identity and privacy | OPTIMIZE | An explicit managed auth file must select the billing bearer/user ID and public email row while keeping token/user ID off the returned wire payload. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Grok expired credentials | OPTIMIZE | Expired Grok native credentials must stay linked/stale and never be sent upstream. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Grok 429 backoff | OPTIMIZE | A failed refresh must serve last-good quota stale and send no additional request inside Retry-After. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Grok CLI user lookup cached | OPTIMIZE | A CLI auth file without user ID must resolve it once before billing and reuse that identity on subsequent reads. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Claude environment and explicit-home precedence | OPTIMIZE | Native CLAUDE_CONFIG_DIR must beat userhome; an explicit managed home must beat both. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| script | Codex explicit-home precedence | OPTIMIZE | A positive rollout reading from explicit codexHome must beat an unrelated CODEX_HOME API-key account. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |

## apps/daemon/src/usage-system-visibility.test.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/usage-system-visibility.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 44 | claude: expired system credentials hide the System row | KEEP | Expired Claude System login creates permanent empty row. |
| 55 | claude: unexpired system credentials keep the System row | KEEP | Valid Claude System quota is hidden. |
| 66 | codex: system account matching a managed account_id hides the System row | KEEP | Duplicate Codex account-ID quota gets rendered twice. |
| 79 | codex: system account matching a managed email (no account_id) hides the System row | KEEP | Duplicate JWT-email Codex quota gets rendered twice. |
| 92 | codex: a distinct, unexpired system account keeps the System row | KEEP | Distinct valid Codex System quota is hidden. |
| 105 | codex: an expired system token hides the System row even with a distinct identity | KEEP | Expired distinct Codex System token creates empty quota row. |
| 118 | codex: missing auth.json does not hide (source already reports null/scrape) | KEEP | Missing Codex credentials suppress legitimate rollout fallback. |

## apps/daemon/src/usage-tokens.test.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/usage-tokens.test.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| 8 | 1h-TTL cache writes bill at 2x input, 5m at 1.25x | KEEP | Mixed one-hour/five-minute cache writes must bill the one-hour subset once at 2x and the rest at 1.25x, giving the independently calculated 7.75 cache cost. |
| 14 | unknown model yields null cost | KEEP | Unknown native model names must stay unpriced instead of inventing an API-equivalent charge. |
| 18 | versioned model ids stay priced (F1) | KEEP | Native dated/preview model IDs must retain known pricing rather than disappearing from cost estimates. |
| 26 | scanCodex reads the real event_msg/token_count/info shape and sums per-turn usage | OPTIMIZE | Codex cached-input tokens are charged as ordinary input or per-turn sums wrong. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 52 | scanClaude reads the 1h cache-write split and skips zero-usage rows | OPTIMIZE | Claude cache TTL split/zero synthetic entries are misread. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 89 | scanClaude dedupes repeated message.id+requestId across files (F2) | OPTIMIZE | Resumed/branched transcript copies double-count turns. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 111 | recompute caches unchanged files and stays correct on partial rescan (F5) | OPTIMIZE | Partial rescan loses or double-counts previously read turns. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 135 | an unchanged refresh has a fresh persisted timestamp and repairs caller mutations | KEEP | Protects the caller-visible outcome named here: an unchanged refresh has a fresh persisted timestamp and repairs caller mutations. assert.equal(refreshed.rows[0]?.inputTokens, 10); assert.equal(refreshed.rows[0]?.outputTokens, 4) |
| 161 | refresh invalidates totals and dedup winners after deletion, same-size rewrite, truncation and recreation | KEEP | Protects the caller-visible outcome named here: refresh invalidates totals and dedup winners after deletion, same-size rewrite, truncation and recreation. assert.equal((await scanner.snapshot(true)).rows[0]?.inputTokens, 10, "sorted first file wins dedup"); assert.equal((await scanner.snapshot(true)).rows[0]?.inputTokens, 20, "deleting the winner exposes its duplicate") |
| 195 | the first empty scan replaces a persisted snapshot from removed transcripts | KEEP | Protects the caller-visible outcome named here: the first empty scan replaces a persisted snapshot from removed transcripts. assert.equal((await scanner.snapshot()).rows.length, 1); assert.deepEqual((await scanner.snapshot(true)).rows, []) |
| 208 | codex parser state (model, cumulative gate) carries across appended chunks | OPTIMIZE | Appended Codex chunk loses model or counts repeated cumulative event. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 247 | an unterminated tail line is counted once, then not double-counted when completed | OPTIMIZE | Completing an unterminated JSONL row double-counts it. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 266 | managed-account home transcripts are counted with and without a system home | OPTIMIZE | Managed Claude transcripts must contribute under the ordinary agent ID both before and after a system transcript directory exists. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 302 | subagent requests are reported once each, with their time and cache usage, apart from the main thread | OPTIMIZE | Subagent usage must be separated from main-thread turns, deduplicated across streamed blocks and exposed with timestamps/TTL splits for the decision window. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 346 | subagent requests are unknown until the transcripts have been scanned once | OPTIMIZE | Before scanning, subagent usage must be unknown rather than an authoritative empty sample; after an empty scan it becomes an empty sample. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |
| 356 | claude-opus-5-5 has its own row: it reproduces the CLI's charges in claude fixtures 17, 18 and 19 (1-hour cache writes) | KEEP | Observed CLI charges for Opus 5.5 fixtures 17/18/19 must match their independent dollar totals rather than using the broader Opus 5 prefix tariff. |
| 369 | a trailing context tag is dropped before the lookup: claude-opus-4-8[1m] bills at standard opus 4.8 rates (claude fixture 01: 0.21547) | KEEP | A context-tagged Opus 4.8 model must reproduce fixture 01 cost; context tags cannot silently make known transcript usage unpriced. |
| 375 | codex rollouts an Agent Profile home writes through its sessions link are counted once | OPTIMIZE | A profile rollout written through account/system sessions symlinks must contribute once, preventing duplicate billing from realpath aliases. Isolated per-case mkdtemp children now live under a file-owned scratch parent removed by the final hook/finally. This bounds filesystem residue even after assertion failures, without sharing mutable fixture data. This is resource cleanup, not a measured wall-time gain. |

## apps/daemon/src/usage.check.ts

**Independent contract:** README usage widget; AgentUsage/UsageAccount/UsageTokenRow API; native Claude limits/Grok billing/Codex WHAM and rollout shapes; durable thread.session-set event schema; fixture-reported Claude dollar charges.

**Stable seam and callers:** Production quota parsers, source functions, public UsageService/scanner APIs and UsageStateFile storage used by index.ts usage routes/events and launch/workflow account selection.

**Independent oracle and real regression:** Literal fixture bytes, independently arranged requests/files, specified status/error/data values, manual clock advances or observable process artifacts. The case assertion excerpt identifies the concrete oracle. The case reason names an incorrect caller-visible result, protocol byte, permission decision, persisted state, leaked secret or lost user data.

**Refactor resistance:** Retained observations use returned data, native files, public lifecycle events, terminal frames or actual process effects. Internal identifiers/container shape may change; removed object-identity, private-option and scan-window assertions no longer constrain refactors.

**Unique protection:** Literal known percentages/costs/tokens, independently controlled times and real small native logs. Parser tests own formats; sources own credentials/backoff/expiry/live/restart; aggregators own cross-account selection; scanners own incremental append/rewrite/dedup/grouping. These are distinct failures, and broader source smoke tests do not supersede cache ordering or persistence checks.

Validation target: `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx src/usage.check.ts`. Not claimed executed here.

| Baseline line | Test declaration / standalone scenario | Outcome | Reason / surviving owner |
| ---: | --- | --- | --- |
| script | initial enabled snapshot/change notification | KEEP | Enabled available providers must appear in the first forced snapshot and emit one public changed event. |
| script | unchanged recompute deduplication | KEEP | Identical provider data must not broadcast repeatedly. |
| script | per-agent disabled snapshot | KEEP | Disabling Codex must remove only Codex from public usage. |
| script | globally disabled snapshot | KEEP | Disabling usage globally must return no agents. |
| script | missing Claude credential source | KEEP | A null source must be omitted while the available Codex source remains. |
