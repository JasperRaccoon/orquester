# Scope 17: workflow execution cleanup

Completed cleanup ledger. Initial dispositions below were recorded before source/test edits; the final UTF-8 boundary refinement was recorded before its edit. Baseline validation was started before editing.

Independent source **D** is `docs/superpowers/specs/2026-09-28-automated-workflows-design.md`; current wire contracts and production owners were read before using it. Requirements referenced here are only those that match current behavior. Regression cases explicitly describe a visible failure, rather than treating source code as its own specification.

Focused validation command (from apps/daemon): `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2` plus the scope paths. Root owns repository gates. Each deletion is low risk because its named remaining owner survives; retained filesystem/process/security cases carry moderate regression risk if changed, so all scope tests run before/after.

Each file rationale supplies B1/B4/B5/B6 for every KEEP/REWRITE row; each row supplies the concrete B2 failure and B3 independent oracle. B5 means only output data, protocol requests, persisted records or OS effects are asserted; no source inspection, private call-count inventory, markup or incidental structure is required. The same prescribed protocol outputs can disagree with an incorrect implementation after internal refactoring. Fakes provide remote input/protocol state, not selection, failover, timer policy or redaction logic under test. Real disk/process owners are used where fake implementations would own the asserted behavior.

## `apps/daemon/src/workflows/agent/cooldowns.test.ts`

**B1:** D §5.4 and persisted AccountCooldown keys; bounded escalation regression avoids hourly repeated burns. **Owners read:** cooldowns.ts. **B4 and non-test callers:** public CooldownStore and buildCooldown persistence record; daemon-wiring.ts creates shared CooldownStore; failover.ts builds/writes cooldowns. **B5:** output/protocol/state assertions survive internal refactors. **B6:** selection/failover scenarios do not exercise real file pruning or reset precedence.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `the cooldown store keys <family>:<accountId>, serves only active ones and prunes expired on write` | Wrong family/account key or expiry filtering can repeatedly select a burnt account; literal claude:a1/codex:system keys, active reads and persisted pruned keys are the oracle. |
| KEEP | `cooldownUntil: resetsAt, else the burnt window's reset, else an hour; auth always an hour` | Provider reset precedence, invalid reset fallback and auth cooldown can strand or prematurely reuse an account; fixed UTC timestamps and one-hour fallback are the oracle. |
| KEEP | `cooldownUntil: a limit with no known reset escalates per strike (1 h, 2 h, 4 h at most); a known reset never does` | Repeated unknown resets can spin hourly forever, or a known reset can be delayed; fixed 1/2/4-hour bounded escalation and unchanged known reset/auth timestamps are the oracle. |

## `apps/daemon/src/workflows/agent/executor.test.ts`

**B1:** D §§5.1,5.3–5.5 and public CreateSessionRequest/agent-chat command protocol. **Owners read:** executor.ts, create.ts, prompt.ts, watch.ts. **B4 and non-test callers:** NodeExecutor.execute and DaemonApi requests/events; daemon-wiring.ts registers NodeExecutor; engine executes it. **B5:** output/protocol/state assertions survive internal refactors. **B6:** selection helpers cannot catch session lifecycle, unattended command composition, wake observation or output ownership.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `happy path: creates the session like the MCP, sends the prompt with the autonomy note, returns the last message` | Wrong session ownership/account/model or final-message selection breaks workflow tabs and downstream data; literal CreateSessionRequest/turn fields and final JSON answer are the oracle. The exact autonomy note is explicitly prescribed by D §5.1. |
| KEEP | `continue-session mode: a follow-up turn into the upstream block's session; its text only` | A continued block can create another tab or return an earlier answer; same session ID, second answer and empty silent follow-up are the oracle. |
| KEEP | `continue-session mode without an upstream session fails as a validation error` | A missing upstream session can launch unrelated work; validation failure and zero created sessions are the oracle. |
| KEEP | `a saved prompt + append renders {{…}} first, escaped for the {variables} pass, then the variables` | Trigger data containing {diff}/{branch} can execute the second rendering pass; literal escaped incoming data plus saved prompt/append output are the oracle. |
| DELETE | `a new chat's title renders {{…}} (secrets stay hidden) and falls back to workflow · block` | Duplicate title rendering/redaction assertions already owned by the lower renderSessionTitle seam in helpers.test.ts; the extra exact default-title punctuation has no independent wording contract. |
| KEEP | `a failed variable read fails the block naming it, and no session is created` | A failed git variable read can silently launch an incomplete prompt; expression failure naming {diff} and no created session are the oracle. |
| KEEP | `a missing saved prompt fails the block` | A deleted saved prompt can be sent blank; validation failure is the oracle. |
| KEEP | `questions are answered autonomously: custom text where allowed, else (Recommended), else the first option — message-mode too, never dismissed` | Unattended questions can hang or choose the wrong option; explicit custom response, pg recommended value, red fallback, multiselect array and message-mode answer are the oracle. Exact custom response is prescribed by D §5.5. |
| KEEP | `an approval is accepted` | An unattended approval can hang or be denied; accept decision and subsequent completed answer are the oracle. |
| KEEP | `a plan card is implemented with the plan implementation prompt` | A proposed plan can end the workflow before implementation; a follow-up containing the supplied plan and implemented output are the oracle. |
| DELETE | `done only after background work ends (then the quiet window)` | Duplicate no-wake completion path. The retained no-wake 90-second-window case checks both early-completion and failure-to-finish; handoff/output ownership cases cover parent-only text. |
| KEEP | `whenOnlyWatchLoopsRemain: finish ends after a 60 s grace; wait keeps waiting until maxMinutes` | A monitoring process can block finish forever, or wait policy can finish early; grace-bounded finish versus timeout at maxMinutes are the oracle. |
| DELETE | `a background agent waking the parent into a provider-started turn is waited for; its text is the output` | Duplicate provider-started wake scenario: the retained 20-second delayed wake exercises the harder lost-wake regression and asserts the same parent result and new turn. |
| KEEP | `a wake that becomes a turn only 20 s after the background work ended is still waited for (a held Claude wake)` | A delayed provider-started wake can be missed and expose the launch message; literal helper-reported final answer and second turn are the oracle. |
| KEEP | `background work that ended with no wake finishes after the 90 s wake window` | Background completion without a wake can hang forever or finish before the wake guard; literal parent output and 100–130-second total window are the oracle for the documented delayed-wake regression. |
| KEEP | `a quiet window catches a wake that comes right after the turn settles` | A wake inside the initial quiet interval can be discarded; final woken answer is the oracle. |
| KEEP | `maxMinutes interrupts the agent and fails the block with timeout` | Unresponsive agents can ignore maxMinutes; timeout plus interrupted remote turn are the oracle. |
| KEEP | `the run's cancel interrupts the agent and ends the block cancelled` | Cancelled runs can leave remote work active; cancelled block and interrupt command are the oracle. |
| KEEP | `a failed turn without a limit/auth reason is an agent_error with the host's message` | An ordinary provider crash can be misclassified as account exhaustion; agent_error and unchanged host diagnostic are the oracle. |
| KEEP | `the live fields: selection, sessionId, hops and a throttled activity line` | Run views can lose session/selection/hop identity or activity progress; output session identity and two supplied activity values observed through ctx.update are the oracle. |
| KEEP | `a host that is restarting (503 on create) is retried on the clock; one session results` | A temporary host 503 can fail the run or create duplicate sessions; completed output and one session after two refused creates are the oracle. |
| KEEP | `an account the daemon would not launch (gone from its catalogue) is passed over by the catalogue check, never sent` | A stale selection reader can launch a removed account; only a2 may reach session creation and a1 has unavailable skip reason. |
| KEEP | `a stored chain naming an agent this host does not offer (a removed launcher) passes it over and runs the next entry` | A persisted removed launcher can abort the whole chain; only supported Claude creates a session and removed launcher carries catalog skip reason. |

## `apps/daemon/src/workflows/agent/failover.test.ts`

**B1:** D §5.4 and agent-chat account/interrupt protocol; repeated-reset/provider-key regressions. **Owners read:** executor.ts, failover.ts, select.ts, watch.ts. **B4 and non-test callers:** NodeExecutor.execute and DaemonApi command protocol; coolDown writes shared CooldownStore; daemon-wiring.ts registers executor; executor uses failover helpers. **B5:** output/protocol/state assertions survive internal refactors. **B6:** pure ranking does not prove switching, interruption, handoff, shared cooldown application or resume budget.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `limit at create (the provider never starts): switch account in the same session` | A provider failing before a turn ID exists can evade failover; beta output in the original session and switched hop identify success. |
| DELETE | `limit at turn start: switch account` | Duplicate normal failed-turn account switch. The retained mid-turn case has the same structured limit plus partial transcript; create/parked/background cases protect different protocol states. |
| KEEP | `limit mid-turn: the partial work stays in the session and the new account continues it` | A mid-turn limit can stop the run or discard the session; rest-done output on a2 and one session are the oracle. |
| KEEP | `limit while parked (Claude's warning, turn still running): cooled until resetsAt, interrupted, switched` | A parked runtime.warning can leave the original turn running; exact reset cooldown and interrupted old turn plus a2 switch are the oracle. |
| KEEP | `limit during background work: the whole thread is interrupted, then switched` | An interrupt scoped to the parent turn can leave exhausted-account background work alive; successful switched result and whole-thread interrupt without turnId are the protocol oracle. |
| KEEP | `a switch refused once (something still in flight) waits for idle again, then switches` | A transient busy refusal can force needless new-session handoff; a2 success in one session is the oracle. |
| KEEP | `a switch the host keeps refusing hands off to a NEW session on the same agent's next account` | Persistent refusal can loop forever; second session, a2 result and handoff hop are the oracle. |
| KEEP | `cross-family handoff: a new session with the handoff prompt (original prompt, notice, last messages, git status)` | Cross-family continuation can lose prior work or use the wrong owner; fixed original prompt/messages/git status and codex ownership/output are the oracle. Handoff notice wording is prescribed by D §5.4. |
| KEEP | `an auth handoff says the login failed and never passes the provider's error text as the agent's messages` | Provider authentication diagnostics can be presented as the previous agent’s work; original real assistant text remains and Invalid API key is absent, with auth hop reason. |
| KEEP | `the handoff caps the previous messages at 32 KiB (newest kept) and git status at 8 KiB` | Unbounded history/status can overrun provider input and discard newest progress; NEWEST remains and prompt byte budget stays within declared 32-KiB/8-KiB plus framing limit. |
| KEEP | `OpenCode has no accounts: a limit goes to the next chain entry` | Accountless OpenCode can attempt an unsupported account switch; next Claude entry finishes with handoff hop and no account command. |
| KEEP | `chain exhausted: fails all_burnt with every hop and skip` | Complete chain exhaustion can produce a generic error or incomplete audit; all_burnt plus four fixed hop/account skips are the oracle. |
| KEEP | `wait-for-reset: waits until the earliest reset, then resumes in the same session on that account` | A reset wait can consume maxMinutes or restart in a new session; after-reset output, same session, resumed hop, reset timestamp and persisted wait are the oracle. |
| KEEP | `wait-for-reset refuses a reset beyond maxWaitHours` | A reset after the configured budget can hold a workflow forever; all_burnt is the oracle. |
| KEEP | `an auth failure skips the account (1 h cooldown, unusable for the run) and fails over` | Auth can be treated as quota exhaustion or leave the failed account reusable; a2 output, auth hop and one-hour auth cooldown are the oracle. |
| KEEP | `at most 12 hops: a chain of 14 burnt accounts gives up with limit_exceeded` | Unlimited cross-account hopping can spin through arbitrarily many accounts; limit_exceeded after 12 fixed-account hops is the oracle. |
| KEEP | `the cooldown is shared: the next block skips the burnt account` | Cooldowns isolated to one block can retry an exhausted account in the next block; next block selects a2 and exposes a1 cooldown skip. |
| KEEP | `a model the catalogue does not list skips its chain entry (why: catalog) and the next entry runs` | An absent model can block a valid later chain entry; codex output and Claude catalog skip are the oracle. |
| KEEP | `wait-for-reset over 48 h with limits that never name a reset: resumed hops are not counted, cooldowns escalate` | Reset resumptions counted as new-account hops can prematurely exhaust a 48-hour wait; 13 failed resets then success in one session, 14 recorded hops and 47–48-hour elapsed budget are the regression oracle. |
| KEEP | `coolDown keys accountless launches by provider and never reads another quota's reset` | An accountless provider can inherit Codex’s five-day quota cooldown; independent 3-day managed-account reset, one-hour OpenCode reset and untouched Codex system key are the oracle. |

## `apps/daemon/src/workflows/agent/helpers.test.ts`

**B1:** D §§5.1,5.4,5.5,5.7–5.9; persisted baseline, bounded text, title security and delayed-summary regressions. **Owners read:** classify.ts, create.ts, prompt.ts, executor.ts. **B4 and non-test callers:** persisted baseline/thread snapshot protocol, title serialization boundary, NodeExecutor.execute; watch.ts reads baseline/activity; executor.ts renders title and output. **B5:** output/protocol/state assertions survive internal refactors. **B6:** fixtures isolate eviction/lagging-summary/security transformations absent from executor scenarios; workflow output caps differ from generic byte helpers.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| DELETE | `UTF-8 clipping never splits a code point; the tail keeps the newest part` | Delete the wrapper-specific probe after preserving its real no-split failure in the retained public output-cap case with an odd-byte UTF-8 boundary. The handoff case owns newest-tail behavior; remove the wrapper-specific export for clipUtf8Tail. |
| KEEP | `only failures after this block's baseline count` | An old account error can fail a new block; pre-baseline error ignored and new warning reset retained are literal protocol-fixture expectations. |
| KEEP | `a baseline row that left the window falls back to the time cut` | Evicted baseline rows can make old transcript data count as current work; timestamp-cut result contains m2 only. |
| KEEP | `the baseline takes the thread's latest turn over a lagging summary` | A lagging summary can make an already-finished turn look new; snapshot-completed t5 remains old and t6 is new. |
| REWRITE | `the output text is capped at 2 MiB` | Large agent replies can overflow downstream output or corrupt the final code point. Use one ASCII byte followed by two-byte é characters: the independent two-MiB limit requires 2,097,151 complete UTF-8 bytes, textTruncated, and no replacement character. This preserves the deleted helper probe’s real behavior at the public block-output seam. |
| KEEP | `the handoff reads the parent's words since the block began in the session` | Continuing-session handoff can leak an earlier block or subagent transcript into current work; only current work reaches the next provider. |
| KEEP | `wait-for-reset honours maxWaitHours from the first wait` | Repeated waits can reset the user’s maxWaitHours budget; fixed first-wait timestamp permits the first reset but refuses a later over-budget decision and unknown reset. |
| KEEP | `the activity line reads tool calls and assistant text, never a provider's stderr or warnings` | Provider stderr or raw tool bytes can masquerade as useful progress; last tool summary/assistant line chosen while warnings-only settled thread gives no activity. |
| REWRITE | `a chat title renders its {{…}} like the prompt, but never a secret's value` | Title templates can leak secret values, fail open on missing input or retain multiline data; literal rendered input and secret placeholders are the oracle. REWRITE removes cap assertions derived from MAX_TITLE_CHARS, the arbitrary cap’s export and exact default-title punctuation; retain template/security/undefined-on-empty behavior. |
| KEEP | `a chat title never shows a secret the render escaped, transformed or nested` | JSON escaping, transforms, nested values/keys or whitespace flattening can defeat title redaction; literal secret values/fragments absent and named placeholders present for each template are the oracle. |
| REWRITE | `a chat title drops control and format characters` | Bidi/control sequences can spoof a workflow tab or inject terminal controls; supplied control characters are absent while readable input remains and all-control titles return undefined. REWRITE replaces a full whitespace-formatting snapshot with control/format-character absence and removes exact default-title punctuation. |

## `apps/daemon/src/workflows/agent/resume.test.ts`

**B1:** D §5.8; AGENTS.md requires persisting wait before side effects, idempotent command IDs and host-only secret values. **Owners read:** executor.ts state parser/persist/post; testing/scenario.ts and fake-chat-host.ts reviewed. **B4 and non-test callers:** persisted WaitingOn and DaemonApi protocol; engine resumes registered agent NodeExecutor from WaitingOn. **B5:** output/protocol/state assertions survive internal refactors. **B6:** single daemon restart E2E cannot distinguish every persisted phase/side-effect lost-ack boundary.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `name` | Each persisted agent phase can lose work or duplicate a command after restart; literal finished text, session/user-message counts, replay commandId/body and cleared waitingOn are independent protocol oracles. Parameter cases are detailed below. |
| KEEP | `a persisted state this version cannot read ends the block interrupted` | Unreadable future persisted versions can launch corrupt work; interrupted error is the storage-compatibility oracle. |
| KEEP | `the deadline is wall-clock: a resumed block does not get its maxMinutes again` | Restart can renew maxMinutes indefinitely; timeout before 31 total minutes for a 30-minute request is the oracle. |
| KEEP | ``a secret in the prompt is never persisted, and a restart at ${phase} still sends the real value`` | Restart at creating/sending can persist a raw credential or send a marker; all saved states exclude the supplied token and exactly one outgoing prompt includes its real value. |
| KEEP | `a handoff prompt carrying the secret keeps it out of the state and sends the real value` | Cross-family handoff can put credentials into pending persisted input or lose them on resumed send; both executors’ saved states exclude token and codex receives its real value. |

## `apps/daemon/src/workflows/agent/secret-text.test.ts`

**B1:** D §§5.7–5.8 and retained persisted prompt marker compatibility/security. **Owners read:** secret-text.ts and sandbox/redact.ts. **B4 and non-test callers:** persisted marker codec; executor.ts protect()/post(). **B5:** output/protocol/state assertions survive internal refactors. **B6:** resume integration tests prove wiring; codec cases cover overlapping markers, name collisions and deleted keys independently.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `protectSecrets hides every value (longest first, ≥ 4 chars); revealSecrets restores the exact text` | Persisted prompt markers can leak overlapping secret values or corrupt round trips; fixed private-use persisted marker bytes and exact original text on reveal are the storage oracle. |
| KEEP | `a secret whose value is another secret's name never corrupts a marker` | One secret value equalling another secret name can corrupt marker parsing; exact original text survives protect/reveal. |
| KEEP | `a marker for a secret that no longer exists is sent as nothing; text without markers is untouched` | A removed secret can leave stale marker text in a resumed command; gone marker resolves to empty and unrelated text survives. |

## `apps/daemon/src/workflows/agent/select.test.ts`

**B1:** D §5.2 literal policy, owner example and AccountSelectionDecision API. **Owners read:** select.ts, families.ts. **B4 and non-test callers:** pure AccountSelectionDecision boundary shared by preview/runtime; daemon-wiring accountPreview; failover.ts pickCandidate/coolDown. **B5:** output/protocol/state assertions survive internal refactors. **B6:** executor uses fixed ranking and cannot cover policy threshold/usage-join matrix; this is lowest owner.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `owner's example: soonest weekly reset under 85% picks jasperclaude and skips therealeduard465` | Wrong threshold/ranking can choose the burnt owner-example account; jasperclaude wins and eduard threshold skip is the oracle from D §5.2. |
| KEEP | `soonest-reset without a threshold takes the earliest weekly reset` | Applying an implicit threshold can reject the otherwise earliest weekly reset; therealeduard465 is the oracle. |
| KEEP | `soonest-reset on the session window: unknown resets go last` | Unknown session resets can outrank a known earlier reset; jasperclaude wins the supplied two-hour versus four-hour inputs. |
| KEEP | `least-used (max) picks jasperinuwu` | Wrong default least-used metric can select a busier account; jasperinuwu is the literal oracle. |
| KEEP | `least-used ties break on the soonest weekly reset, then the label` | Equal usage can rank non-deterministically or ignore reset time; x then y after excluding x are independent literal candidates. |
| KEEP | `fixed order [therealeduard465, jasperclaude] under 85% weekly picks jasperclaude — by label or by id` | Fixed policies can ignore user order, label aliases or thresholds; jasperclaude with threshold and eduard without it are the oracle for both ID/label inputs. |
| KEEP | `an allow-list filters the family, and names what it cannot find` | An allow-list can leak unlisted accounts or omit missing-account diagnostics; arakuma wins and ghost is unavailable. |
| KEEP | `a scoped threshold applies only to the models it names` | A model-scoped cap can block unrelated models or ignore a named one; opus selects eduard, fable skips him and unscoped Fable cap applies to both. |
| KEEP | `a window at 100% is always burnt; a burnt scoped window stops only the models it covers` | Fully used windows can remain eligible or poison unrelated models; opus may use b, fable none, with earliest reset fixed at one hour. |
| KEEP | `expired windows are ignored: a pre-reset 100% no longer blocks` | Stale pre-reset quota can block an available account; expired 100% windows still select a. |
| KEEP | `unknown usage is tried after every known account — or dropped with unknownUsage: exclude` | Missing/unavailable/old usage can outrank known usage or be silently excluded; known wins by default, missing is fallback, explicit exclude returns no candidate and named reasons. |
| KEEP | `needsReauth, cooldowns and the exclude set drop candidates` | Auth/cooldown/run exclusions can select unusable accounts or collide across families; only jasperclaude remains and every excluded account has the prescribed reason. |
| KEEP | `an expired cooldown no longer counts` | Expired cooldowns can permanently blacklist an account; jasperinuwu is eligible again. |
| KEEP | `cross-family fallback: claude (all burnt or cooling) → codex (reauth, burnt) → grok` | Cross-family ranking can stop at the first exhausted family or ignore onlyChainIndex; Grok g1 at index 2 wins while Codex-only selection returns null. |
| KEEP | `nothing eligible anywhere: chosen null and the earliest instant a candidate frees` | No-candidate decisions can omit or miscompute reset time; chosen null and 20-hour earliest reset among supplied blockers are the oracle. |
| KEEP | `a threshold breach with an unknown reset contributes no earliest instant` | Unknown resets can generate fictitious wait deadlines; chosen null without earliestResetAt is the oracle. |
| KEEP | `opencode has no accounts: one system candidate, only its cooldown applies` | OpenCode can improperly require managed accounts or accept cooled/excluded provider keys; system candidate then no candidate for each explicit blocker are the oracle. |
| KEEP | `system: the family's system row, or its head row when it has no managed accounts` | Wrong system usage source can compare an aggregate as a personal quota; Grok solo/system row, hidden unknown row and explicit system allow-list produce fixed decisions. |
| KEEP | `chosen carries the entry's model options` | Dropping model options during selection can execute at the wrong effort; the caller-visible choice retains literal effort=high. |
| KEEP | `burntWindowResetAt: the latest reset among burnt windows` | A partially reset multi-window account can be retried too soon; latest active burnt window is three days while unburnt/expired/missing rows yield no reset. |
| KEEP | `accountless cooldowns are per provider: one provider's limit never cools another's entries` | One accountless provider’s quota can block another provider or Codex system account; only the matching provider/bare model keys are excluded. |

## `apps/daemon/src/workflows/agent/validation-catalog.test.ts`

**B1:** D §7.2 validation against host catalog; unavailable startup/failure-backoff/provider-change cache regressions. **Owners read:** validation-catalog.ts and packages/api/src/workflows/agent-catalog.ts. **B4 and non-test callers:** ValidationCatalog public current/ready/expire plus actual DaemonApi reads; daemon-wiring.ts creates, expires and refreshes; index.ts awaits ready before writes. **B5:** output/protocol/state assertions survive internal refactors. **B6:** API catalog tests own conversion; retained cases exclusively own async cache lifecycle.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| DELETE | `a provider's models count only once it has been probed` | Duplicate conversion policy owned by packages/api/src/workflows/agent-catalog.test.ts (probed/unknown/empty models). No daemon cache behavior is asserted here. |
| KEEP | `nothing is known before the client is attached; ready() then reads the host's catalogue` | Daemon startup before API attachment can incorrectly reject definitions or never load catalog; undefined before attachment then literal Codex model catalog are the oracle. |
| DELETE | `a degraded or errored provider (a failed probe's fallback list) counts as not loaded` | Duplicate degraded/error conversion matrix owned by packages/api/src/workflows/agent-catalog.test.ts; wrapper adds no distinct behavior. |
| REWRITE | `a failed read is not retried on every request, only once the refresh window has passed` | A failing provider can trigger repeated remote reads on each request; no calls inside 30-second failure backoff and a new read at expiry are the oracle. REWRITE uses native Date.now mock and removes test-only now/ttl options. |
| REWRITE | `expire() reads again at once — even inside a failure's backoff — and keeps the last reading until then` | Provider changes can remain hidden by a failure backoff or erase last usable catalog; expire refreshes immediately while fixed prior catalog remains readable. REWRITE uses native clock mock and removes test-only now/ttl options. |

## `apps/daemon/src/workflows/git-remote/clone-ref.test.ts`

**B1:** D §5.10; Git CLI/ref/advertisement protocol and option-injection boundary. **Owners read:** clone-ref.ts and accounts.ts clone caller. **B4 and non-test callers:** Git argv/ref validation and ls-remote prefix parser; AccountsService cloneRepo; request validation. **B5:** output/protocol/state assertions survive internal refactors. **B6:** account transport tests own cleanup/auth; these keep independent SHA-length, ambiguity and raw Git protocol boundaries.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `cloneRefProblem accepts branches, tags and shas` | Valid branch/tag/SHA or 250-character ref can be rejected; explicit allowed values yield no problem. |
| KEEP | `cloneRefProblem refuses empty, long, option-like, whitespace and control characters` | Option injection, control bytes and excessive/non-string refs can reach Git; every listed unsafe ref must be rejected independently of error prose. |
| KEEP | `sha detection: only full ids skip --branch; short hex may be either` | A short hexadecimal branch can be mistaken for a detached commit or SHA-256 rejected; fixed full/short/ambiguous identifiers specify classification. |
| KEEP | `cloneArgs: a name rides --branch, a sha and no ref clone plainly, the URL follows --` | Git can interpret URL as an option or branch name as a commit; explicit Git CLI argument protocol with --, --branch and --detach is the oracle. |
| KEEP | `isMissingRemoteRef recognises git's messages` | Authentication failure can be mistaken for a missing branch and trigger destructive retry; literal Git remote-ref diagnostics match while auth error does not. |
| KEEP | `resolveAbbreviatedSha: one commit by prefix, null when none or ambiguous` | Prefix resolution can choose an ambiguous commit or fail on aliases/case; one fixed full SHA, none and two different matching SHAs specify the oracle. |

## `apps/daemon/src/workflows/git-remote/ls-remote.test.ts`

**B1:** D §6.2 and Git ls-remote advertisement protocol. **Owners read:** ls-remote.ts. **B4 and non-test callers:** raw Git stdout parser; AccountsService.lsRemote. **B5:** output/protocol/state assertions survive internal refactors. **B6:** poller sees normalized DTOs, so cannot catch raw peeled-tag/CRLF/SHA256/prototype issues.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `parseLsRemote reads heads, lightweight and annotated tags, and the HEAD symref` | Git heads, annotated tag commits or HEAD symref can be parsed incorrectly; literal Git advertisement yields fixed heads/tag objects/default branch. |
| KEEP | `parseLsRemote: a peeled line before its tag, CRLF, junk and uppercase shas` | Out-of-order peeled tags or noisy CRLF output can corrupt selected commit; fixed parsed tag survives and unrelated malformed refs are absent. |
| KEEP | `parseLsRemote: no HEAD line → no defaultBranch; a __proto__ branch stays an own key` | A __proto__ branch can mutate the result prototype or disappear; own SHA property with ordinary prototype and absent defaultBranch are the security oracle. |
| KEEP | `parseLsRemote: SHA-256 object ids` | SHA-256 repositories can silently produce no heads; 64-byte hex object ID remains in the parsed main head. |

## `apps/daemon/src/workflows/git-remote/remote-url.test.ts`

**B1:** D §§5.10,6.2 canonical poller identity; README/AGENTS credential and transport security. **Owners read:** remote-url.ts. **B4 and non-test callers:** URL normalization, validation and credential sanitization boundaries; AccountsService; git-poller.ts and repo display consumers. **B5:** output/protocol/state assertions survive internal refactors. **B6:** poller covers wiring only, these cases own complete transport aliases/unsafe input/credential forms.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `repoKeyOf: every GitHub form of one repo has one key` | Equivalent GitHub URLs can create multiple pollers/dedup identities; all explicit transport/browser/credential forms map to one fixed key. |
| KEEP | `repoKeyOf: Bitbucket Cloud's old and new SSH hosts are one host` | Bitbucket SSH host aliases can split one repository into multiple identities; fixed bitbucket.org/acme/web-app key is the oracle. |
| KEEP | `repoKeyOf: Bitbucket Server/DC forms reduce to host/project/repo` | DC context-path, SSH, browse and personal-project URLs can watch different repo keys; literal host/project/repo and ~jdoe keys are the oracle. |
| KEEP | `repoKeyOf: other hosts keep their whole path (GitLab subgroups)` | GitLab subgroup stripping can collide different repositories; entire group/sub/repo path is the oracle. |
| KEEP | `repoKeyOf: refuses what git would not be handed` | Unsafe or invalid repository identities can start local/helper transport work; fixed unsafe forms return null. |
| KEEP | `repoDisplayName keeps the original case` | User-visible repository identity can lose case/subgroups; original AppsStats and DC project case survive while malformed text remains trimmed. |
| KEEP | `remoteUrlProblem accepts the four transports and refuses the rest` | Local-file/helper/option injection transports can reach Git; the explicit accepted four transport families and rejected unsafe forms are the security oracle. |
| KEEP | `stripUrlCredentials drops the whole http(s) userinfo (a token may be the user) and an ssh password` | Credentials can enter persisted repository payloads; exact credential-free URLs preserve SSH login but remove token username/password. |
| KEEP | `redactUrlUserinfo hides a token user in http(s) text and a password anywhere, keeps ssh logins` | Git errors can leak bare-token usernames/passwords; fixed sanitized free-text outputs preserve only legitimate SSH user. |

## `apps/daemon/src/workflows/nodes/nodes.test.ts`

**B1:** D §4 Wait, §§3.2,5.6,5.9 shell output contract. **Owners read:** nodes/wait.ts, nodes/shell.ts. **B4 and non-test callers:** public workflow run/output with actual Wait/Shell owners; executor registry and engine. **B5:** output/protocol/state assertions survive internal refactors. **B6:** schedule tests compute calendar data only; raw sandbox log caps differ from shell downstream output cap.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `until HH:MM waits for the next such time in the block's time zone` | Wall-clock Wait can resolve in the wrong zone/day or drop its input; fixed next-day 07:00Z boundary and passthrough output are the oracle. |
| KEEP | `the workflow's own time zone applies when the block names none` | Absent per-block zone can ignore workflow timezone; fixed 10:30Z deadline and cancellable run are the oracle. |
| KEEP | `stdout and stderr are the tails within the cap, with a warning; the whole log stays on disk` | Large shell output can overflow downstream state or lose latest/error bytes; fixed 16-MiB output budget, tail/err-tail presence, head absence, warning and larger on-disk log are the oracle. |

## `apps/daemon/src/workflows/nodes/regex-worker.test.ts`

**B1:** D §4 untrusted matches must not block daemon; AGENTS secret redaction. **Owners read:** nodes/regex-worker.ts; API rules evaluator. **B4 and non-test callers:** RuleMatcher and public evaluateRulesAsync warnings; IF/Switch executors use shared matcher. **B5:** output/protocol/state assertions survive internal refactors. **B6:** API matches tests cannot prove real off-thread termination/recovery; no remaining API case protects long secret prefix clipping.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `an ordinary pattern answers` | Regex worker transport can lose flags/input or report all matches true; explicit case-insensitive positive and negative match outputs are the oracle. |
| KEEP | `a catastrophic pattern is stopped at the deadline, the loop stays free, and the next search works` | Catastrophic regex can freeze daemon event loop or poison all future matches; bounded false+warning, independently observed event-loop ticks and successful next match are the security oracle. |
| KEEP | `a clipped value is redacted before the clip` | A diagnostic clip can expose a long secret prefix; no supplied prefix and named placeholder in actual API evaluator warnings are the security oracle. The supplied matcher is unused by numeric gt, not the behavior under test. |

## `apps/daemon/src/workflows/sandbox/log-reader.test.ts`

**B1:** D §§5.6,5.7,7.3 byte-offset log API and secret redaction. **Owners read:** sandbox/log-reader.ts. **B4 and non-test callers:** filesystem bytes plus public LogWindow/follow iterator; engine log reading; shell output collector; workflow log routes. **B5:** output/protocol/state assertions survive internal refactors. **B6:** redactor cannot protect cross-window byte positions or live-file completion; routes duplicate no matrix.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `windows of any size cut at character boundaries and join to the whole text` | Byte paging can split Unicode or lose/repeat bytes; concatenating independently supplied UTF-8 text across sizes 1–12 reproduces the exact original without replacement characters. |
| KEEP | `a secret is never split across windows` | Redaction windows can leak credentials in halves; literal fully redacted text across sizes 1–40 and absence of each secret are the oracle. |
| KEEP | `an offset inside a secret serves its placeholder, never its tail` | A caller-controlled offset inside a credential can reveal its tail; placeholder followed by 67890 is the oracle. |
| KEEP | `holdTail keeps back a partial character and a possible secret prefix` | Growing file can expose a secret prefix or incomplete UTF-8 bytes; after append only a complete placeholder is returned and partial character bytes remain unread. |
| KEEP | `a missing file reads as empty` | A not-yet-created log can throw rather than produce an empty page; fixed empty/eof window is the API oracle. |
| KEEP | `yields as the file grows and ends once it is not live and fully read` | Log follow can reorder, drop final bytes or leak credentials crossing appends; exact joined redacted output after writer completion is the oracle. |
| KEEP | `an abort ends a live follow` | Aborted HTTP log following can remain open forever; the iterator returns after first supplied chunk and abort. |

## `apps/daemon/src/workflows/sandbox/redact.test.ts`

**B1:** D §5.7 exact secret replacement policy. **Owners read:** sandbox/redact.ts. **B4 and non-test callers:** Redactor text/value interface; engine outputs/events/errors, title renderer, log reader and secret codec. **B5:** output/protocol/state assertions survive internal refactors. **B6:** byte log windows and agent markers have different responsibilities; direct text/deep matching is lowest owner.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `text: every value ≥ 4 chars, longest first` | Overlapping secrets or short noise tokens can be redacted incorrectly; literal longest-value-first placeholders and retained three-character text are the oracle. |
| KEEP | `value: deep through arrays and objects, values only` | Nested output redaction can miss secrets or mutate original execution input; literal deep redacted object and unchanged original are the oracle. |
| KEEP | `special regex characters in a value are literal` | Regex metacharacters in a credential can cause over-redaction or leaks; only exact a.b*c(d) receives the placeholder. |

## `apps/daemon/src/workflows/sandbox/sandbox.test.ts`

**B1:** D §§5.6,5.8,5.9 public code SDK/process/log/storage contract and README/AGENTS credential isolation. **Owners read:** sandbox.ts, runner.mjs, code-host.mjs, env.ts, proc.ts. **B4 and non-test callers:** SandboxRunner backed by real detached OS processes and actual files; code/shell node runSandboxAttempt and engine restart. **B5:** output/protocol/state assertions survive internal refactors. **B6:** orchestrator fakes cannot catch process-group/deadline/ESM/filesystem behavior; higher-layer duplicate SDK inventory removed by engine agent.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `a return value is the result; log() and console.log reach stdout` | Code SDK context/result/log plumbing can lose upstream data or leave secret input behind; 21→42, fixed node/run values, log bytes and removed input.json are the oracle against a real subprocess. |
| KEEP | `undefined returns as null` | Undefined code return can create unreadable/missing JSON output; persisted result is successful null. |
| KEEP | `a throw is a failure with message and stack` | Thrown code errors can masquerade as success or omit diagnostics; nonzero exit with fixed boom message/stack is the oracle. |
| KEEP | `stop() ends the run as stopped, with its reason, even from a promise chain` | Code stop inside a caught promise chain can continue past user intent; stop reason survives and later return cannot win. |
| KEEP | `require resolves the project's own node_modules` | Code require can resolve daemon dependencies instead of project dependencies; uniquely created project fake-pkg answer 42 is the oracle. |
| KEEP | `a module with top-level await works` | ESM top-level await can be rejected by a wrapper; independent expression 7×6 returns 42. |
| KEEP | `a non-serializable return is an error` | Non-JSON values can corrupt result storage; BigInt return produces a recorded error. |
| KEEP | `a return over maxOutputBytes is an error` | Oversized code return can exceed public storage bound; 16-MiB string plus JSON framing must fail. |
| KEEP | `a default export that is not a function is a clear error` | Missing/non-callable default export can hang or report success; both supplied invalid modules return failure. |
| KEEP | `a syntax error is a failure` | Unparseable source can fail without a usable terminal result; syntax-invalid module records failure. |
| KEEP | `an open handle does not hold the attempt` | User-created open handles can keep a completed attempt alive; done result terminates despite a retained interval. |
| KEEP | `stdout, stderr and the exit code` | Shell stream/exit collection can discard stderr or normalize nonzero exit; fixed out/err bytes and exit 7 are the oracle. |
| KEEP | `sh works too, and the cwd is the request's` | Sh selection/cwd can be ignored; successful pwd equals the requested temporary directory. |
| KEEP | `each stream is capped with one notice line` | Unbounded logs can exhaust disk or reporting can lose cap status; first 50 MiB plus a nonempty single notice and capped exit metadata are the oracle. |
| KEEP | `the environment is built, never inherited` | Daemon credentials or spoofed ownership env can reach children; credential name/value absent, caller FOO retained, reserved run/workflow identity and UUID launch ownership override spoofed values. |
| KEEP | `an invalid env name refuses the spawn` | Invalid env names can enter child launch; invalid-name rejection is the public spawn contract. |
| KEEP | `a missing cwd refuses the spawn` | A nonexistent cwd can start work elsewhere; failed spawn is the filesystem contract. |
| KEEP | `the runner enforces the deadline itself` | A detached runner can lose deadlines when daemon is unavailable; own 200-ms timeout with distant waiter backstop yields timedOut/SIGTERM. |
| KEEP | `a work that ignores SIGTERM is SIGKILLed after the grace` | SIGTERM-ignoring work can survive cancellation; ready marker proves handler installed, then cancelled/SIGKILL exit is the oracle. |
| KEEP | `a cancel kills the whole group, grandchildren included` | Cancellation can kill parent but leave grandchildren; actual recorded grandchild process identity must disappear and cancelled exit remain. |
| KEEP | `kill() ends a running attempt` | Explicit kill can return before process death or omit exit record; actual process gone and recorded cancel without result are the oracle. |
| KEEP | `a runner killed outright reads as interrupted, and its work is ended` | Runner crash can leave orphan work running and falsely report a normal exit; actual SIGKILL produces interrupted result and orphan identity disappears. |
| KEEP | `a restarted daemon adopts a running attempt and reads its exit` | Daemon restart can fail to adopt detached children; serialized persisted handle is enough for new runner to read exit 4 and final log bytes. |
| DELETE | `readExit is null before an attempt ends` | Trivial empty-directory read probe duplicates the running-attempt/adoption/deadline paths, which require no false exit before completion. No distinct failure remains. |
| KEEP | `isAlive refuses a recycled pid (starttime mismatch)` | Recycled PID can be mistaken for owned work; actual same PID with altered starttime is rejected while current identity is alive. |

## `apps/daemon/src/workflows/triggers/git-events.test.ts`

**B1:** D §6.2 git event payload, persisted dedup-key transitions and glob contract. **Owners read:** git-events.ts, glob.ts. **B4 and non-test callers:** pure cursor + remote DTO → event protocol; git-poller.ts detects events. **B5:** output/protocol/state assertions survive internal refactors. **B6:** poller tests own scheduling/I/O, these isolate distinct pagination rollback/reopen and glob boundary regressions.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `glob: anchored, `*` stops at `/`, `**` crosses it, `?` is one character` | Branch filter globs can cross slash boundaries, lose anchoring or hang on adversarial patterns; fixed positive/negative names, empty patterns and hostile pattern result are the oracle. |
| KEEP | `sameSha compares an abbreviation (Bitbucket Cloud's 12 hex) as a prefix` | Full and abbreviated Bitbucket SHA representations can generate false updates; explicit 12-character prefix/case match, mismatch and too-short negative are the protocol oracle. |
| KEEP | `pushFired keeps the newest 1000` | Persistent dedup state can grow without bound or discard newest keys; fixed 1,000 retained keys start at k1 and end at b. |
| KEEP | `pull requests: an old PR scrolling into the page is recorded silently; one opened and merged between polls yields both` | An older paginated PR can look newly opened, or a newly merged-between-polls PR can lose one action; only PR 11 opened+merged events are the oracle. |
| KEEP | `pull requests: a lower-numbered new PR walked after a higher one still opens (the mark is the page's base)` | Walking higher-numbered PR first can hide lower-numbered new PR; both 12 and 11 appear in independent event list. |
| KEEP | `pull requests: dedup keys name the transition — a force-push rollback and a second close after a reopen fire` | Destination-only dedup can suppress force-push rollback or second close after reopen; fixed update/close transitions plus legacy cursor compatibility are the oracle. |
| KEEP | `push: a force-push rollback (A..B then B..A) is a new dedup key, not a repeat of the first push to A` | Push rollback can collide with previous destination key; explicit A→B and B→A payloads have distinct transition keys and cannot match legacy destination-only ring. |

## `apps/daemon/src/workflows/triggers/git-poller.test.ts`

**B1:** D §6.2 cadence/baseline/dedup/payload/filter/security; persisted ETag/cursor atomicity regression. **Owners read:** git-poller.ts, git-events.ts. **B4 and non-test callers:** GitPoller public lifecycle, TriggerHost fire, GitRemoteReader and real WorkflowStateStore; daemon-wiring.ts starts/stops poller and serves trigger state. **B5:** output/protocol/state assertions survive internal refactors. **B6:** pure detection cannot prove timer/request/cursor ordering, per-account sharing, stop, retries or credential plumbing.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `push: the first poll only baselines; a later push fires once with previousSha..sha` | First poll can replay old work or unchanged head refire; zero baseline events then exactly one literal A→B payload and updated visible trigger state are the oracle. |
| KEEP | `push: branch globs; a new matching branch fires with no previousSha; deleted branches are ignored` | Branch filtering can omit new refs or fire deleted/unmatched refs; only release/1.0 and new release/2.0 payloads appear, no event on deletion. |
| KEEP | `push: branches [] watches the default branch, read only when unknown and every 10th poll` | Default-branch changes can fire old history or keep watching former default forever; main then dev changes yield exactly those two branch events with silent rebaseline. |
| KEEP | `tag: one run per new matching tag (version order), at most 10 per poll, the rest skipped; moved tags ignored` | Tag bursts can run unbounded work, re-fire moved tags or use annotated object rather than commit; literal version order, ten fired/two missed, commit SHA and no repeat are the oracle. |
| KEEP | `release: drafts never, pre-releases only when asked for` | Drafts/pre-releases can trigger forbidden work or promotion be lost; fixed stable/all workflow event lists and payload distinguish filtering/promotion/dedup. |
| KEEP | `release on a provider without releases shows an error and fires nothing` | Unsupported release providers can appear healthy or trigger work; visible error and zero fire are the oracle. |
| KEEP | `pull_request: opened, updated, merged and closed; the base filter; payload and text` | PR transitions or base filters can emit wrong workflow data; literal merged/updated/opened ordering, full PR42 payload and later close count are the oracle. |
| KEEP | `pull_request: Bitbucket Cloud's 12-char head sha compares consistently and polls every 180 s` | Cloud polling can exceed declared 180-second cadence or repeat unchanged abbreviated head; no request before deadline and exactly changed short head fires. |
| KEEP | `ETags: a baselined listing sends its ETag; a 304 fires nothing and still counts as a poll` | HTTP 304 can erase cursor or act like an empty/new list; supplied ETag is reused, no event on 304 and changed page emits only PR2. |
| KEEP | `dedup survives a restart: a new poller over the same state never re-fires, and still fires what is new` | Restart can replay already-fired work, including reconstructed seen state; same persisted store suppresses B replay and still emits B→C. |
| KEEP | `a changed filter or repo re-baselines; a disabled or deleted trigger is pruned` | Changed filters/repos can treat existing history as new or disabled triggers keep polling; silent new baseline then dev change, persisted new repo key and zero later network work are the oracle. |
| KEEP | `two triggers on one repo share one poller (one ls-remote per poll); another account is another poller` | Equivalent repository triggers can multiply requests or cross account identities; fixed anonymous/account2 transport counts and events for all three subscribers are the oracle. |
| KEEP | `failures back off exponentially to 15 min, show on the trigger, honour Retry-After and never fire` | Errors can busy-loop, ignore Retry-After or lose pending push; fixed 120/240/480/900-second backoff and 40-minute Retry-After, no failure events, eventual B event are the oracle. |
| REWRITE | `a PR listing without the scope says which scope is missing; push triggers on the same repo keep polling` | A PR missing-scope error can break independent push polling or hide required scope; REWRITE keeps read:pullrequest identifier/error presence and successful push baseline, removes exact error sentence. |
| KEEP | `an unresolvable repository shows why and polls nothing; stop() leaves no timer` | Unresolvable/unsafe repository can perform network reads; zero remote lsRemote calls after a minute is the observable security oracle. The old test title overclaims stop-timer validation; no stop-only coverage is claimed. |
| KEEP | `stop() mid-poll commits and fires nothing` | A late poll after daemon stop can commit/fire unwanted work; explicit held remote reply released after stop leaves original persisted SHA and no event. |
| KEEP | `a token typed as the URL's user never reaches the poll, the payload or the error text` | URL username tokens can leak through requests, workflow events or trigger error; literal token absent from all three surfaces and payload URL sanitized. |
| KEEP | `ETags: a new ETag is written in the same state update as the cursors that judged its page` | ETag stored before matching cursor can hide changes forever after a crash and 304; every persisted update pairs W/2 with PR2 seen, and exactly one event fires. |
| KEEP | `the pulls poll names the PRs its triggers last saw open (so a DC listing can look them up)` | DC can miss transitions for older open PRs unless supplied lookup IDs; explicit [9,4] open IDs, excluding merged PR2, are the provider interface oracle. |
| KEEP | `pull_request: an abbreviated head (Bitbucket Cloud) is completed from the branch heads before it fires` | Cloud short SHA can fail later clone; full branch-head SHA replaces changed PR7 abbreviation in both payload fields using configured account/repository. |

## `apps/daemon/src/workflows/triggers/repo-resolve.test.ts`

**B1:** D §§5.10,6.2 workspace project shape and GitRepoRef account/origin resolution. **Owners read:** repo-resolve.ts and git-poller.ts periodic reconcile. **B4 and non-test callers:** ResolveRepo with filesystem layout/remote/account interfaces; daemon-wiring.ts constructs resolver for poller. **B5:** output/protocol/state assertions survive internal refactors. **B6:** poller fake resolver bypasses project/workspace lookup; periodic actual resolver case uniquely covers newly appearing origins.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `project repositories reject paths outside the workspace project layout` | An out-of-layout project can inherit wrong workspace credentials or watch outside configured scope; all fixed outside/nested paths return null. |
| REWRITE | `repo kind url: as given, with its account or none` | Explicit repository account selection can be lost; trimmed URL with null/acc1 account is the oracle. REWRITE removes internal remoteUrl call inventory. |
| KEEP | `repo kind project: an existing project's origin + its workspace's account` | Existing project can watch wrong origin or use another workspace account; literal team/solo origin-account pairs and missing-origin null are the oracle. |
| REWRITE | `repo kind project on a temp workflow: its clone URL + that workspace's account; an empty temp project has none` | Temp clone can poll wrong identity or empty temp can invent a repo; clone URL/team account and empty-source null are the oracle. REWRITE removes internal remoteUrl call inventory. |
| KEEP | `a project whose origin appears later is picked up by the periodic re-resolve` | Origin created after startup can remain unresolved forever; after bounded periodic refresh a real resolver leads to acc-team remote read, baseline true and cleared error. |

## `apps/daemon/src/workflows/triggers/scheduler.test.ts`

**B1:** D §6.1 scheduling/grace/clock jumps; AGENTS persist before side effects. **Owners read:** scheduler.ts and WorkflowStateStore. **B4 and non-test callers:** Scheduler public lifecycle, real persisted cursor and TriggerHost fire; daemon-wiring.ts lifecycle; engine/rail trigger summaries. **B5:** output/protocol/state assertions survive internal refactors. **B6:** API cron calculator cannot catch durability, missed runs, timer recovery or edits/re-enable behavior.

| Disposition | Original case | Failure / oracle / remaining owner |
|---|---|---|
| KEEP | `a new trigger is scheduled from now and fires at its time, once, with the schedule payload` | New schedules can fire early, duplicate or lose payload cursor; fixed 10:15 UTC firing boundary, next10:30 cursor and literal schedule payload are the oracle. |
| KEEP | `the cursor is persisted before the fire` | Fire before persisted cursor can duplicate a run on crash; actual state file already contains next10:30 inside host.fire. |
| KEEP | `the timer never sleeps more than 60 s, and a clock jump is noticed within a minute` | Clock jumps can leave schedules asleep until tomorrow or stop leave work firing; fixed missed-within-grace 09:00 event within minute, next next-day cursor and no fires after stop. |
| KEEP | `boot: a run missed by less than the grace fires once; beyond it one missed stub, never a burst` | Downtime can lose eligible recent run or burst all missed slots; one recent catch-up versus one missed stub over three days, then normal next slot. |
| KEEP | `edits rearm: a changed cron or zone recomputes from now; disable prunes, re-enable never fires a stale time; delete prunes` | Changed cron/zone can retain old timer or re-enable replay stale work; fixed hourly/Kolkata deadlines, pruned disabled/deleted cursor and no re-enable catchup are the oracle. |
| KEEP | `an unrelated edit keeps the cursor; a disabled node is not scheduled; an invalid cron warns once and never fires` | Unrelated edits can delay a valid schedule, or disabled/invalid triggers fire; unchanged10:15 cursor and only s1 fire IDs are the oracle. Warning count is not claimed despite old title. |
| KEEP | `a failed cursor write skips that one run but never stops the timer` | Failed persistence can fire non-durable work or kill all future scheduling; real filesystem write failure suppresses10:15 but succeeds10:30 after repair. |
| KEEP | `a failed write while reconciling still arms the timer` | Boot-time write failure can leave scheduler permanently unarmed; real directory/file collision repaired before next slot still allows one fire. |

## Parameter details and isolated failure inventory

The `resume.test.ts` declaration `name` expands to 22 original durable-phase cases. These are protocol/state compatibility cases, not an export inventory: every phase can exist in a persisted `WaitingOn` after a daemon handover. Every entry requires completed literal output, no extra session or user message, and cleared waiting state. Lost acknowledgments additionally require the exact previously persisted command ID and body.

- Plain: selecting, creating, sending, watching, output; lost create acknowledgement (sending/creating) and lost turn acknowledgement (watching/sending). Failure: lost initial prompt, duplicate session or duplicate turn.
- Question: answering; second watching with lost answering acknowledgement. Failure: unanswered pending input or duplicate answer after restart.
- Switch: interrupting, waiting-idle, failing-over, switching, second sending with lost switching acknowledgement, second sending, second watching. Failure: account switch lost, wrong old account resumed, duplicate continue prompt, or unfinished background work.
- Handoff: handing-off, second creating, second sending with lost creating acknowledgement. Failure: old family reused, context lost or extra cross-family session.
- Reset: waiting-reset, second failing-over, second sending. Failure: skipped reset deadline, stale account/candidate or duplicate resumed work.
- Secret declaration expands to creating and sending, separately covering persisted create input and command body. Cross-family handoff is a separate security scenario.

Other isolated boundaries can fail through malformed external input, stale/evicted records, out-of-order data, incorrect policy filtering, secret leakage, invalid UTF-8 boundaries, wrong OS identity, premature completion, or unbounded work. The per-case rows keep only those observed failures. APIs are not kept merely because exported.

## Removed dead support and seams

- Removed imports for deleted helper/cap cases and unused repo-resolver call collector. Removed zero-consumer support fields `fakePrompts.rendered`, `FakeContext.last`, and `Scenario.runWithRestart.resumedFrom`. Replaced the unused trigger logger capture/factory with one quiet logger value.
- Privatized `clipUtf8Tail` and `MAX_TITLE_CHARS`: external references were tests only. Also privatized the unused exported `MAX_PLAN_IMPLEMENTATIONS`, `MAX_COOLDOWN_MS`, `DEFAULT_COOLDOWN_MS` and `MAX_ESCALATED_COOLDOWN_MS` constants after a repository-wide caller search found only owner-local references.
- Remove ValidationCatalog `now`/`ttlMs` injections and unused custom ready wait; production has one daemon-wiring caller using defaults. Native Date.now mock keeps cache timing deterministic without production hooks.
- Remove ValidationCatalog `invalidate()` (zero callers), its conversion-only wrapper, and make private catalog timing constants private. Preserve actual runtime `expire()`/`ready()` lifecycle.
- Other scoped exported helpers retain real production callers; shared agent/trigger fakes remain needed by retained protocol scenarios. Scheduler/poller idle drains stay, as AGENTS requires event/drain synchronization rather than sleeps.


## Completed cleanup and verification

- Audited all 20 assigned files: 191 original declarations, including the explicitly detailed 22-case persisted-phase matrix and two secret phases. Final disposition: 8 DELETE, 8 REWRITE, 175 KEEP. Runtime count drops from 213 to 205; these counts are reporting, not a deletion target.
- Removed duplicate executor title/background/wake scenarios, the normal-limit duplicate, the UTF-8 wrapper probe, two catalog conversion duplicates and the empty readExit probe. The output-cap rewrite now deliberately cuts between the bytes of a Unicode character, retaining the real no-corruption regression through the block output seam.
- Removed unused test support and unused production exports/hooks listed above. No fixture/snapshot files became unused. No production behavior was changed; runtime callers retain the same default catalog timing and conversion.
- Baseline command began before edits and recorded no failed case before an environment interruption; its log stopped after case 123. No complete baseline pass is claimed, and it was not rerun after the interruption.
- Full focused scope command passed **205/205 tests**, **10 suites**, zero failed/skipped/cancelled. Log: `/tmp/orquester-test-audit/scope-17-after.log`.
- After dead support removal, reran `agent/{executor,helpers,resume}.test.ts` and `triggers/{scheduler,git-poller,repo-resolve}.test.ts` with the same package hooks and concurrency bound: **90/90 passed**. Log: `/tmp/orquester-test-audit/scope-17-support-final.log`.
- Final UTF-8 boundary and title assertions passed **10/10 tests** in the last helpers run. Log: `/tmp/orquester-test-audit/scope-17-helpers-final.log`.
- Scoped diff reviewed and `git diff --check` passed. Repository typecheck/test/build gates, remote integration and commit/push belong to the root agent. No live daemon, socket, port or service was touched.

Final scoped code/test/support diff: 51 added, 181 deleted lines (**net -130 LOC**), excluding this audit ledger.
