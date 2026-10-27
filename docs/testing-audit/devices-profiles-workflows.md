# Incoming profile and workflow test disposition

Incoming reference `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8` compared with `923b3a51`. All five changed test files were read with their production owners, public contracts and design requirements: 19 declarations / 22 expanded cases. One callback-only declaration already removed on main stays deleted; 18 declarations / 21 expanded cases remain. Counts: DELETE 1, REWRITE 3, OPTIMIZE 0, CONSOLIDATE 0, KEEP 15. This round overlaps the original profile/workflow ledgers and must not be double-counted.

## Integration and infrastructure

Keep incoming unused workspaceAccounts fixture option removal. Repository-wide TypeScript search finds no caller. Removed wrapper preparerFor replaced by direct typed registry lookup; manifest/preparer-only constants and helpers stay private. Keep main removal of contributor injection and unused names cache: production workflow uses liveIds(), deleted notices use durable deletedName().

Critical workflow artifacts are retained outside cleaned appdirs; only already-asserted redacted public summaries are serialized mode 0600. Native profile preparation/materialization stays real.

Concurrent profile test genuinely prepares separate kits for each supported agent. Restart/switch/delete/failure tests each compose distinct lifetime transitions. MCP suite shares one immutable/runtime context with per-case workflow IDs and explicit cleanup; no state oracle depends on execution order.

## Validation and performance

No test run started because root owns the single-run worktree slot. Incoming timing is unavailable; no speedup claim. Source/reference inspection and scoped `git diff --check` passed. Root owns final changed/full checks and timing. No incoming revision timing or percentage improvement is claimed. Each case lists its focused validation command.

Workflow artifact writes removed by the incoming diff were restored. The MCP dry-run case drops display wording checks and instead reads the unchanged stored node through the public MCP tool. Incoming profile materialization and native configuration are preserved; removed injection/cache seams remain absent.

## `apps/daemon/src/session-profiles/launch.test.ts:63` — KEEP

`apply over the account's launch: env wins, unset merges, home follows the home variable, serverPool replaces` (suite: the per-agent launch contributions).

- **Contract/source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §7 One seam; session-profiles/README.md Launching a chat
- **Behavior:** Account env is overlaid by the profile; unset wins, resume home and provider pool follow profile values; inputs remain unchanged.
- **Real regression:** A profile leaves an account credential/home active or mutates a reused base env.
- **Independent oracle:** Literal collision/removal values, explicit override and unchanged base env.
- **Stable seam:** applyProfileContribution public composition result
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** The real integration journeys do not deliberately collide env/unset values or exercise an explicit home override.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/launch.test.ts

## `apps/daemon/src/session-profiles/launch.test.ts:89` — DELETE

`ensures the profile is ready for the agent and account, reads its section and applies the contribution` (suite: createProfileLaunchResolver).

- **Contract/source:** No independent contract for injected contributor callback shape.
- **Behavior:** An injected function reads the arranged manifest and returns its arranged CODEX_HOME.
- **Real regression:** Only private collaborator arguments or the fabricated registry callback would differ.
- **Independent oracle:** Fails bar 3: fake callback itself implements the value being asserted.
- **Stable seam:** Fails bar 4: test-only contributors option and callback recording.
- **Refactor resistance:** Fails bar 5: registry refactoring invalidates the private call assertions.
- **Unique protection:** Fails bar 6: actual per-agent concurrent-profile integration journeys and native preparer/contribution cases protect manifest-to-launch behavior.
- **Production callers / test seams:** No production caller supplies contributors; fixed real registry remains.
- **Cost:** Removes one temporary manifest and one callback-only resolver execution; no isolated timing measured.
- **Deletion risk:** Low: real profiles still traverse lifecycle, manifest, contributor and host adapter input.
- **Change:** Preserved prior cleanup: delete this declaration, fake registry factory, recorded calls, exported contributor registry types and resolver injection option.
- **Validation:** Full root check:changed/typecheck and session-profiles/launch.test.ts plus integration.test.ts.

## `apps/daemon/src/session-profiles/launch.test.ts:116` — REWRITE

`asks the System account as null, and names its home through accountHome` (suite: createProfileLaunchResolver).

- **Contract/source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.3, §7 resume identity
- **Behavior:** An empty account ID uses System authentication while the prepared profile remains the resume home.
- **Real regression:** System launches point Grok auth at the prepared home or retain no account identity.
- **Independent oracle:** Literal /system/grok/auth.json and actual prepared directory result.
- **Stable seam:** createProfileLaunchResolver with the real Grok contributor and on-disk validated manifest
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Concurrent integration cases use managed accounts, so they cannot prove the System account fallback.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Preserved prior cleanup: replace fabricated callback observation with actual GROK_AUTH_PATH and homePath results.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/launch.test.ts

## `apps/daemon/src/session-profiles/launch.test.ts:130` — REWRITE

`passes the lifecycle's refusals through and turns a bad manifest or a failing contributor into PROFILE_NOT_READY` (suite: createProfileLaunchResolver).

- **Contract/source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.5, §7 error contracts; packages/api/src/session-profiles
- **Behavior:** Known lifecycle failures retain their error code; missing manifests, invalid real contribution inputs and unsupported agents refuse launch.
- **Real regression:** Preparation failure silently launches Global, loses the refusal category, or generic filesystem errors escape the profile error contract.
- **Independent oracle:** Explicit SessionProfileError codes; missing-manifest reason and a real missing-account-home reason.
- **Stable seam:** createProfileLaunchResolver result/rejection with filesystem manifest input
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Full integration preparation failure cannot isolate missing manifests, absent contributor credentials and unknown agent normalization.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Preserved prior cleanup: real Grok contributor failure replaces arbitrary injected throw; missing-manifest and lifecycle/error cases remain.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/launch.test.ts

## `apps/daemon/src/session-profiles/launch.test.ts:169` — KEEP

`liveIds: unknown until the first list lands, then the existing profiles (unreadable ones too), following creates and deletes` (suite: SessionProfileNames).

- **Contract/source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.5; apps/daemon/src/index.ts workflowProfileIds; session-profiles/README.md workflow validation
- **Behavior:** Profile validation treats initial uncertainty as unknown, includes unreadable directories, reflects create/delete/recreate, and never revives stale-list deletions.
- **Real regression:** A workflow rejects a recreated/unreadable profile or accepts a deleted one because an older startup list landed late.
- **Independent oracle:** Manually authored p1/p2/p3/p-broken sets and deferred list/event order.
- **Stable seam:** SessionProfileNames.track/liveIds service-event boundary
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** No real profile integration fixture controls the initial list race or delete/recreate of the same ID.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Retained incoming recreated-ID assertion while preserving removal of the unused name cache.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/launch.test.ts

## `apps/daemon/src/session-profiles/launch.test.ts:189` — KEEP

`liveIds stays unknown when the list cannot be read` (suite: SessionProfileNames).

- **Contract/source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.5; apps/daemon/src/index.ts workflowProfileIds
- **Behavior:** A failed initial profile list leaves workflow validation uncertain rather than authoritatively empty.
- **Real regression:** Transient EACCES causes every stored workflow profile to be incorrectly reported missing.
- **Independent oracle:** Literal undefined after rejected initial list.
- **Stable seam:** SessionProfileNames.track/liveIds service-event boundary
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** The successful deferred-list race never rejects the initial read.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/launch.test.ts

## `apps/daemon/src/session-profiles/integration.test.ts:669` — KEEP

`${agent}: two concurrent chats on one account with different profiles get distinct kits and no Global item; a Global chat beside them is unchanged` (suite: Agent Profiles end to end (daemon → host → adapter launch inputs)).

Expanded exact names: `claude: two concurrent chats on one account with different profiles get distinct kits and no Global item; a Global chat beside them is unchanged`; `codex: two concurrent chats on one account with different profiles get distinct kits and no Global item; a Global chat beside them is unchanged`; `grok: two concurrent chats on one account with different profiles get distinct kits and no Global item; a Global chat beside them is unchanged`; `opencode: two concurrent chats on one account with different profiles get distinct kits and no Global item; a Global chat beside them is unchanged`.

- **Contract/source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §6.1–6.4, §9 verification; session-profiles/README.md
- **Behavior:** Concurrent chats sharing one account see only their distinct selected profile kit; a neighboring Global chat retains Global setup.
- **Real regression:** Prepared homes or provider pools collide, profile/global skills leak across chats, or Global defaults are modified.
- **Independent oracle:** Authored Editor/Developer kit names and content; absence of seeded Global fixtures; distinct home/pool identities.
- **Stable seam:** real daemon service/routes → host protocol → provider launch inputs and effective native configuration
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Native unit builders do not compose real lifecycle, account env, daemon/host transport and adapter options concurrently.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/integration.test.ts

## `apps/daemon/src/session-profiles/integration.test.ts:725` — KEEP

`a daemon and host restart keeps the chat's profile, and its next start picks up the edited profile's new version` (suite: Agent Profiles end to end (daemon → host → adapter launch inputs)).

- **Contract/source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.6, §7, §9 verification
- **Behavior:** A persisted chat retains profile and resume cursor across restart, adopting edits only at next start.
- **Real regression:** Restart loses the profile, pins obsolete prepared content, or starts another conversation.
- **Independent oracle:** Before/after immutable version identities; literal added skill and same stored resume cursor.
- **Stable seam:** real daemon service/routes → host protocol → provider launch inputs and effective native configuration
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Builder refresh tests lack persisted daemon+host binding and actual re-launch together.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/integration.test.ts

## `apps/daemon/src/session-profiles/integration.test.ts:759` — KEEP

`a profile switch mid-chat relaunches with the new kit on the same conversation; a switch to Global drops it` (suite: Agent Profiles end to end (daemon → host → adapter launch inputs)).

- **Contract/source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.3, §5.5, §7
- **Behavior:** Switching profiles changes effective kit in the same conversation; switching to Global removes isolation.
- **Real regression:** The chat chip changes while adapter kit stays stale, conversation cursor is lost, or Global retains profile config.
- **Independent oracle:** Literal Editor/Developer kit and absent profile on Global; unchanged learned cursor.
- **Stable seam:** real daemon service/routes → host protocol → provider launch inputs and effective native configuration
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Restart/edit does not exercise switch command application and Global teardown in Claude/OpenCode providers.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/integration.test.ts

## `apps/daemon/src/session-profiles/integration.test.ts:790` — KEEP

`a deleted profile: an interactive chat falls back to Global with a notice naming it; an unattended one fails to start` (suite: Agent Profiles end to end (daemon → host → adapter launch inputs)).

- **Contract/source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.5–5.6
- **Behavior:** Interactive deleted-profile chats fall back with the durable name notice; unattended chats fail without Global execution.
- **Real regression:** Deletion silently runs unattended work with Global permissions or loses the visible former-profile identity.
- **Independent oracle:** No profile in interactive launch, authored Editor name/reason payload, zero unattended starts and retained profile binding.
- **Stable seam:** real daemon service/routes → host protocol → provider launch inputs and effective native configuration
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Individual error mapping and deleted-name store tests cannot prove the interactive/unattended policy at actual host restart.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Retained real durable profiles.deletedName callback; the obsolete SessionProfileNames cache remains removed.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/integration.test.ts

## `apps/daemon/src/session-profiles/integration.test.ts:827` — KEEP

`a failed preparation fails the launch with its reason, never Global: at create, and at a later start` (suite: Agent Profiles end to end (daemon → host → adapter launch inputs)).

- **Contract/source:** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.5–5.6, §7
- **Behavior:** Preparation failure refuses both initial create and an existing chat next start; it never silently selects Global.
- **Real regression:** A missing Codex executable still creates a tab or an old chat launches using Global instead of its requested profile.
- **Independent oracle:** PROFILE_NOT_READY with missing-install reason, no new chat record, no resumed start, retained launch profile.
- **Stable seam:** real daemon service/routes → host protocol → provider launch inputs and effective native configuration
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Launch unit normalization does not prove create bookkeeping and durable restart binding when preparation becomes unavailable.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/session-profiles/integration.test.ts

## `apps/daemon/src/workflows/e2e-agent.test.ts:68` — KEEP

`a restart while the agent works resumes the watcher and never sends the turn twice` (suite: e2e: agent blocks through the engine).

- **Contract/source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §2 wiring, §5.8 durability
- **Behavior:** Restart re-enters a persisted agent watcher without a second turn/session and returns the full original answer.
- **Real regression:** A fresh runtime re-posts a completed command or treats a durable watcher as a new execution.
- **Independent oracle:** One actual fake-provider turn command, attempt 1, authored working/all-done answer and persisted watching checkpoint.
- **Stable seam:** real workflow HTTP routes, FileRunStore, daemon wiring and engine over a fresh runtime
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Executor resume unit fixtures do not recreate daemon stores/runtime from disk or exercise engine resume wiring.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** Provider wait is virtual (10 minutes advanced on FakeClock); real stores are explicitly flushed. Two runtime boots are required to prove restart. No arbitrary wall-clock sleep.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Preserved the main-branch verified JSON artifact write removed by incoming remote cleanup.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/workflows/e2e-agent.test.ts

## `apps/daemon/src/workflows/e2e-mcp.test.ts:52` — KEEP

`the published Jira create and edit example stays valid on the real routes` (suite: e2e: the MCP workflow tools against the real routes).

- **Contract/source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §8 MCP worked example; apps/daemon/src/mcp/tools/workflows-guide.ts published Jira example
- **Behavior:** Published create/edit commands are actually executable and produce a safe disabled saved workflow.
- **Real regression:** An advertised example drifts from current schemas, graph/reference rules or revision handling.
- **Independent oracle:** Externally published command bytes parsed from the guide, independently accepted by real routes with no validation errors and disabled saved workflow.
- **Stable seam:** real JSON-RPC MCP tools → InjectDaemonApi → workflow routes/services/stores
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Mocked API tool tests cannot reject schema-invalid, reference-invalid examples through actual workflow services.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** One shared isolated daemon and MCP app for all three independent cases; only the run case spawns a code sandbox. No repeated browser, network or server startup.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Preserved verified JSON artifact write.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/workflows/e2e-mcp.test.ts

## `apps/daemon/src/workflows/e2e-mcp.test.ts:70` — REWRITE

`create_workflow and update_workflow {dryRun: true} validate on the real route and save nothing` (suite: e2e: the MCP workflow tools against the real routes).

- **Contract/source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §8; apps/daemon/src/mcp/tools/workflows.ts published dryRun descriptions
- **Behavior:** Dry-run create/update validate actual draft semantics without saving definitions or node edits.
- **Real regression:** A dry-run bypasses real validation, creates a workflow, or mutates a stored node while leaving revision unchanged.
- **Independent oracle:** Authored valid/invalid graphs, valid/saved flags, unchanged workflow membership/revision and stored node name Work read back via get_workflow.
- **Stable seam:** real JSON-RPC MCP tools → InjectDaemonApi → workflow routes/services/stores
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Mocked /validate responses prove adaptation only; this is the real validator/storage composition and public node readback.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** One shared isolated daemon and MCP app for all three independent cases; only the run case spawns a code sandbox. No repeated browser, network or server startup.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Remove exact project/rename display-copy assertions; retain invalid graph/no-save behavior and add public get_workflow readback proving the node remains Work. Preserve verified artifact.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/workflows/e2e-mcp.test.ts

## `apps/daemon/src/workflows/e2e-mcp.test.ts:107` — KEEP

`run_workflow waits for a real run and its stored output can be read by node name` (suite: e2e: the MCP workflow tools against the real routes).

- **Contract/source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §8 MCP run/output, revisions; packages/api/src/workflows/types.ts
- **Behavior:** Revision-pinned run refuses stale edits, waits for completion and exposes the real stored output by block name.
- **Real regression:** Stale revision runs side effects, wait returns before completion, or output lookup names point to the wrong persisted node.
- **Independent oracle:** Explicit REVISION_CONFLICT, finished/succeeded flags and literal {doubled:42} from input n=21; exact returned run ID.
- **Stable seam:** real JSON-RPC MCP tools → InjectDaemonApi → workflow routes/services/stores
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Stub-driven tool tests cannot prove engine execution, storage and output re-read through real daemon routes.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** One shared isolated daemon and MCP app for all three independent cases; only the run case spawns a code sandbox. No repeated browser, network or server startup.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Preserved verified JSON artifact write.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/workflows/e2e-mcp.test.ts

## `apps/daemon/src/workflows/e2e.test.ts:97` — KEEP

`a manual pipeline produces its final output and redacts secrets in public and durable artifacts` (suite: e2e: a manual run through code, IF, shell and HTTP).

- **Contract/source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §5.6–5.8 and §8 lifecycle wire contract
- **Behavior:** A real code→IF→shell→HTTP run composes values, emits lifecycle/history, and redacts credentials from all public/durable views while delivering the real value to its destination.
- **Real regression:** An adapter mismatch breaks graph composition; secrets leak in events/log route/run.json/events.ndjson; plaintext code input survives completion.
- **Independent oracle:** Literal greeting, query n=21, exit 0 and authored secret value; loopback receiver independently records the real token while public/file outputs must redact it; input.json must be ENOENT.
- **Stable seam:** real HTTP workflow routes and daemon runtime on real stores, with real sandbox children
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Node unit redaction tests cannot exercise actual process output, downstream HTTP input, public event/log transport and durable artifacts together.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No per-case timing available for this incoming revision; root coordinates full and focused measurements. Shared fixture cost is described below.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Preserved sanitized verified JSON artifact write.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/workflows/e2e.test.ts

## `apps/daemon/src/workflows/e2e.test.ts:199` — KEEP

`the runtime stops while a shell block sleeps; a new one over the same appdir resumes it` (suite: e2e: a daemon restart mid-run).

- **Contract/source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §2 shutdown, §5.6 process sandbox, §5.8 persistence/resume
- **Behavior:** Detached child survives shutdown and a fresh runtime resumes the same attempt before executing its successor.
- **Real regression:** stop kills the child, new boot repeats the process, or saved WaitingOn fails to reconnect after restart.
- **Independent oracle:** Real pid liveness after shutdown, persisted process checkpoint, attempt 1 and literal {after:"slept"}.
- **Stable seam:** real HTTP workflow routes and daemon runtime on real stores, with real sandbox children
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Engine fake-executor and process-spawn unit cases cannot prove actual daemon shutdown/store rehydration across a living detached OS child.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** No arbitrary sleep: child uses fs.watch on a release file, released only after new runtime boots. Two boots and one real detached child are essential to the contract.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Preserved event/file release synchronization and verified JSON artifact write.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/workflows/e2e.test.ts

## `apps/daemon/src/workflows/e2e.test.ts:260` — KEEP

`nextRunAt reaches the rail, the scheduler fires the run on time, the next time follows` (suite: e2e: the schedule trigger).

- **Contract/source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §6.1 schedule trigger, §8 list/event transport
- **Behavior:** Scheduler publishes next run, launches at the specified UTC time, advances cursor and reflects the next time through route/event summaries.
- **Real regression:** A scheduling cursor is correct internally but absent/stale in public rows, or wiring fails to launch the actual engine.
- **Independent oracle:** Literal 12:05 and 12:10 UTC timestamps and schedule payload from authored 5-minute schedule.
- **Stable seam:** real scheduler → engine + public workflow list/broadcast summaries
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Scheduler units use a fake host and cannot prove daemon trigger-state publication plus actual run output.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** Schedule time is controlled by ManualClock and idle drains; no elapsed five-minute wait or sleep. Real code sandbox remains the integration oracle.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Preserved verified JSON artifact write.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/workflows/e2e.test.ts

## `apps/daemon/src/workflows/e2e.test.ts:313` — KEEP

`the poller baselines, fires once on a push, and a failing poll shows on the rail` (suite: e2e: the git trigger).

- **Contract/source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §6.2 git baseline/dedup/failure; §8 public summaries
- **Behavior:** Baseline does not fire, changed head launches the real graph with previous/current SHA, and poll error is published without another run.
- **Real regression:** Wiring treats baseline as a push, loses cursor payload, repeats an event on failure, or hides poll authentication error from clients.
- **Independent oracle:** Authored a/b SHA heads, no baseline/failed-poll run events, literal branch/previous/current output and public lastError row.
- **Stable seam:** real git poller with independent remote heads → engine + public list/broadcast summaries
- **Refactor resistance:** Assertions observe documented data, errors, files or protocol effects; identifier-only changes and behavior-preserving decomposition do not change their oracle.
- **Unique protection:** Poller units use fake host callbacks and do not prove daemon summary publishing plus actual graph execution.
- **Production callers / test seams:** The real daemon/chat/workflow paths use the production owner; dependency fakes provide inputs, not the result asserted.
- **Cost:** Remote is deterministic and local, poll time virtual, no GitHub/network setup. Actual code sandbox proves trigger-to-engine wiring.
- **Deletion risk:** Meaningful unique protection would be lost; retain the case at this seam.
- **Change:** Preserved verified JSON artifact write.
- **Validation:** cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/workflows/e2e.test.ts
