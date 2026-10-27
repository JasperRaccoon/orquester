# Agent config, Agent Profiles and isolation audit

Scope: 50 test files, 485 baseline test/it declarations (parameterized declarations count once). This ledger records a disposition for every baseline declaration. Native config, public API, security and persisted compatibility checks remain; no live daemon was started. Existing opt-in real OpenCode checks were not changed.

Dispositions: CONSOLIDATE 6, DELETE 5, KEEP 462, OPTIMIZE 1, REWRITE 11. Nine declarations are removed: five DELETE and four absorbed CONSOLIDATE scenarios. Both surviving consolidation owners are counted as CONSOLIDATE.

The test-by-test rows inherit all six evidence fields listed for their file. The exact test name is the claimed contract and the concrete failing input/operation; the file evidence identifies its independent source, observable seam and distinction from stronger owners. DELETE and changed cases carry their own specific reasoning. The companion [JSON ledger](profiles.json) preserves baseline identities for accounting.

## Implemented changes

- Removed the unused in-memory profile-name cache (`get`, `note`, `idle`, pending read tracking and per-change `service.get`). Production workflow validation consumes `liveIds`; deletion notices already read durable `deleted.json`. The integration fixture now uses the same durable `deletedName` callback as production.
- Removed the fabricated contributor injection option and exported contributor lookup wrapper/registry/types. Actual launch resolution still uses the same registered per-agent contributors.
- Replaced the Grok environment oracle derived from its production map with literal native keys/values, then removed duplicate map/compatibility/System-path checks.
- Moved Claude/Grok private file modes and plugin-copy immutability assertions into their existing golden preparation, eliminating four duplicate full fixture preparations.
- Advanced the ordinary CLI SIGTERM deadline with the existing Node virtual clock; the real spawned child and all meaningful exit assertions remain.
- Removed incidental `/compact` description copy and a cache-path setup tautology.

A legitimate baseline rollback regression failed because uid 0 bypasses the fixture's directory permissions. Its root execution now drops privileges for that same test, preserving the real filesystem commit failure and original rollback assertions. A TAP pass-count check prevents an accidentally empty child selection. This may add child startup cost on root runners; correctness takes priority over reporting a misleading green pass.

No fixture, snapshot, dependency or configuration became unused. Existing real-CLI fixture scripts remain used by seed/probe/native protocol tests. No generated provider code was edited.

## Measurement and validation

Root owns the one test-run slot and full-suite baseline/final timing. No separate test runs have been started by this workstream yet. Focused targets: the nine changed test files, plus `src/session-profiles/contributions/codex.test.ts` and `src/session-profiles/preparers/opencode.test.ts`; full daemon typecheck/full repository gate remain centrally coordinated.

The baseline individual tests observed so far include ~561 ms Claude plugin lifecycle, ~526 ms Grok skill/command lifecycle and ~457 ms Codex config lifecycle. Those remain because they verify distinct native file/process effects. These overlapping runner measurements are not standalone file speedup claims. Root measurements provide final comparable wall time.

Removed work: four complete filesystem preparations and one mandatory 200 ms real deadline wait. No total-suite speedup is claimed without the final comparable run. The opt-in real OpenCode tests are intentionally expensive because they detect upstream loader behavior that local scripted fixtures cannot prove.

## File and test dispositions

### `apps/daemon/src/agent-profile/adapters/claude/claude-json.test.ts`

- Independent contract: Agent config design §4.1; Claude lock protocol observed on 2.1.280; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: updateClaudeJsonMcpServers → real locked file, its unchanged keys, mode, error codes and lock release.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Lost concurrent Claude writes, overwritten broken files, leaked parse context and uncaught compromised-lock errors are distinct failures of the locked writer; general adapter CRUD does not exercise lock ownership races.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/adapters/claude/claude-json.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a write waits while Claude holds the lock, then lands with every other key as it was | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an unchanged mutation writes nothing; a throw inside the lock writes nothing and releases | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the locked writer refuses malformed JSON without overwriting it or exposing secrets | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a lock taken over before the write is a conflict — never proper-lockfile's uncaught throw — and nothing is written | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a missing file is created 0600 holding only mcpServers | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/adapters/claude/index.test.ts`

- Independent contract: Agent config design §§4–6; native Claude files and CLI commands; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: ClaudeProfileAdapter public operations → native ~/.claude.json, settings.json, markdown and CLI argv/environment.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Each named item operation has a distinct native owner or state transition, including managed hook protection, stashed twins, pin preservation and existing nonconforming names. The cross-agent service does not implement these native encodings.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/adapters/claude/index.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the snapshot lists every kind from a realistic ~/.claude, secrets masked | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| MCP: create, edit with kept and replaced secrets, rename, off/on through deniedMcpServers, delete | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skills: create, edit, rename, off/on through skillOverrides, delete (a symlink loses only its link) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| hooks: managed groups stay locked and byte-identical while user hooks are added, edited, stashed, restored and deleted | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a stashed hook whose twin is back in settings.json refuses to restore | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| commands: create, edit, rename, off/on by stash, restore conflict, delete | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| stash restore of a command whose path is taken answers STASH_CONFLICT | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| plugins and marketplaces go through the claude CLI with HOME set and no CLAUDE_CONFIG_DIR; toggles write enabledPlugins | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a stale revision is a conflict and nothing is written | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a settings.json that does not parse: the snapshot is partial, its writes refused, other files still writable | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| instructions: read, create, write with a revision, conflict on a stale one | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| export and import round trip: MCP with real secrets, a skill directory, a command | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a hand-broken settings.json or ~/.claude.json never has its text (a secret) quoted in fileErrors or errors | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a hook naming agent-hook.sh is refused: it would turn its user group into Orquester's managed one | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| off then on keeps a plugin's version pin and a skill's partial override | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| turning off a hook whose identical copy is already stashed replaces that copy instead of refusing | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the claude CLI gets CLAUDE_CONFIG_DIR only when the daemon's own moved the config dir | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a server whose name Claude accepts but the profile's naming rule does not can still be edited in place | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keepBothNames: the names Claude's own writes would collide with — claude.json servers (not plugin ones), any skills/ entry, stashed commands | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/adapters/codex/codex-config-client.test.ts`

- Independent contract: Agent config design §4.2, on-demand app-server, deadlines and idle lifecycle; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: CodexAppServerClient → real child JSON-RPC, process identity/exit and public errors.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Reuse, idle replacement, pending-call ownership, deadline killing, RPC failure mapping and key-path escaping can fail independently. Adapter CRUD does not tick these lifecycle timers.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/adapters/codex/codex-config-client.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| spawns on demand with CODEX_HOME, handshakes once and reuses the child | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| closes after the idle window and respawns on the next call | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| does not close for idleness while a call is pending | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| fails a call that misses its deadline with AGENT_CLI_FAILED and kills the child | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| hands an answered error back as CodexRpcError, mapped by toProfileError | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| reports a binary that does not start as AGENT_CLI_FAILED | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| quotes key path segments the way the config API reads them | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/adapters/codex/hooks.test.ts`

- Independent contract: Codex 0.155.1 observed trust-hash vectors; native hooks.state format; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: hook hashes/state parsing/rekey results → persisted Codex trust entries.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Literal provider hashes independently check the protocol. Position changes, stale trust and identical handlers require distinct off/trust state; adapter happy-path hooks do not enumerate these ambiguous persisted inputs.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/adapters/codex/hooks.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| reproduces the hash codex-cli 0.155.1 reports for every event and field variation | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| has no hash for handlers Codex does not run | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| parses state keys from the right, paths with colons included | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses a hooks.json it could not edit safely | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| gives identical handlers distinct ids | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| repairs an entry already keyed to the wrong position by its trusted hash | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps a modified hook's entry (stale trust, its off switch) at its moved position | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps two identical handlers' own switches apart | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/adapters/codex/index.test.ts`

- Independent contract: Agent config design §§4–6; native Codex config API and trust files; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: CodexProfileAdapter public operations → real fake-CLI process protocol and native files.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The fixture implements the external CLI dependency, while the actual adapter owns field translation, stale revisions, trust moves, account realpaths and rollback. Each named failure uses a distinct native mutation, privacy surface or race; service mocks cannot supersede it.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/adapters/codex/index.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| lists every kind with its source, switches and warnings — and no secret | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| warns about an untrusted hook with a Trust action, and trust() fixes it on every path | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| reports an unreadable config.toml and refuses to write it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| reports an unparseable hooks.json | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| masks secrets in readItem | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| creates, edits (keeping a secret and unknown fields), toggles and deletes through config/batchWrite | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| renames a server and preserves secret values | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses bad drafts before writing | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| answers 409 on a stale item revision and on a config version conflict | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| exports real values and imports a portable server | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| creates, edits, toggles by path and deletes a user skill | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| toggles a symlinked skill by its realpath, and deleting it removes only the link | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| toggles bundled and plugin skills by name and shared skills by path, and never edits them | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| renames a skill, keeping its off switch | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| exports a skill as a copy and imports one | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| inserts a new hook before the managed group and re-keys every account path | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| toggles a hook on every path, edits it (re-trusted) and deletes it (shifting the rest back) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| moves a hook to another event on edit | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses to touch Orquester's managed hooks | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps hooks.json and its links intact when writing through the account-home symlinks' target | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| puts hooks.json back when the state write fails | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| warns about a hook an account home does not trust, and trust() writes it there | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keys an account home reached through a symlink by its realpath too, as Codex canonicalizes CODEX_HOME | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses to overwrite a hooks.json rewritten while the mutation ran | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| replaces and terminates the app-server when the registry's codex binary moves | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| toggles, uninstalls and installs a plugin through the app-server | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| pluginSource: the plugin's directory inside the marketplace checkout, whose root (not its manifest) is the pinned checkout | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| enabling an installed plugin reads its VERSION directory: provides, the pointing check, and a missing cache still cards | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| lists a marketplace's plugins, removes and adds a marketplace | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| deletes a legacy prompt and refuses to create one | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| reads and writes AGENTS.md against its revision | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/adapters/grok/index.test.ts`

- Independent contract: Agent config design §§4–6; Grok native config/inspect/CLI formats; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: GrokProfileAdapter public operations → TOML, profile hooks, files, CLI argv and public views.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Grok-specific inherited definitions, disabled lists, shared installs, symlink replacement and stale inspect caching have distinct caller-visible failures. Generic conversion and service tests do not own those native mutations.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/adapters/grok/index.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the snapshot lists every kind from its real home, with sources, locks and no secret | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| MCP servers: create, read masked, edit with kept secrets, rename, delete — comments and the compat pin survive | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| MCP on/off mirrors grok mcp disable/enable, for own and inherited servers alike | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skills and commands: create, edit, toggle via [skills] disabled (inherited too), delete | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| hooks: create into profile.json, off by stash and back, edit, delete; Orquester's and config.toml's are refused | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a hook turned back on whose file is gone recreates it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| plugins: toggle through [plugins] lists, install and uninstall through grok, remove a linked plugin | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| marketplaces: add through grok with a branch, list its plugins, remove | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| instructions: write with a revision, and GROK.md folded into AGENTS.md | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| with no AGENTS.md the migration makes GROK.md's text the file | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an unreadable config.toml is a file error without its secrets, and refuses every write to it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an unreadable hook file is a file error and refuses writes to it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| when grok inspect fails, inherited servers come from ~/.claude.json with a warning | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a plugin installed together with others from one source is not deletable alone (grok would uninstall them all) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an MCP server's revision moves when its secret changes | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| create with replace over a symlinked skill or command replaces the link, never the shared target | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| turning off a hook whose identical copy is already stashed replaces that copy instead of refusing | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an inspect still running when a write lands is not cached: the next snapshot sees the write | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/adapters/grok/inspect.test.ts`

- Independent contract: Redacted Grok 1.0.34 inspect capture in test/fixtures/grok/12-cli-text; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: parseGrokInspect → parsed native report/source ownership.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The recorded report is an external oracle. Plugin ownership and rejection of non-reports exercise forms not supplied by the broad adapter fixture.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/adapters/grok/inspect.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the recorded grok 1.0.34 inspect report parses into servers, skills and plugins | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| plugin sources keep their plugin name; anything that is not a report is null | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/adapters/grok/toml-patch.test.ts`

- Independent contract: Agent config design §4.1 preserves unedited native config; Grok-written trailing-comma TOML; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: editToml → parsed target plus unchanged surrounding bytes.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Table deletion, inline-table insertion, native trailing-comma arrays and refusal below a scalar can independently corrupt a user config. The adapter fixture does not use all these representations.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/adapters/grok/toml-patch.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| deletes a table with its sub-tables and leaves the rest byte-for-byte | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| adds a server when mcp_servers is an inline table | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| edits the trailing-comma arrays Grok's own CLI writes | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses to set below a value that is not a table | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/adapters/opencode/index.test.ts`

- Independent contract: Agent config design §§4–6; observed OpenCode 1.18.32 readers and permissions; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: OpenCodeProfileAdapter public operations → JSONC/markdown files and public warnings/errors.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: These cases cover distinct native representations and permission precedence, YAML 1.1, duplicate keys, BOM, command naming and stashing. The shared service and primitive parser tests do not exercise the same full edit/read contracts.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/adapters/opencode/index.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the snapshot lists the host's MCP servers, inherited skills and the locked status plugin | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an MCP server's detail masks environment values | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| turning an MCP server off and on edits only its enabled flag, byte for byte | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a stale revision is a conflict and changes nothing | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| creating, editing (secrets kept, renamed, removed) and deleting an MCP server keeps the rest of the file | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a missing config is created as opencode.jsonc with $schema, 0600 | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| several config files: the edit goes to opencode.jsonc, overrides are honoured, a warning names them | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a config file that does not parse is reported and no config write is attempted | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| own skills: create, edit, rename, delete | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skill switches write permission.skill (absent permission) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a permission action string is rewritten to the object it means before a skill is turned off | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a permission.skill action string keeps its meaning as the wildcard rule | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| turning a skill on past a wildcard deny adds an allow rule; a later catch-all is refused | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an own skill shadows an inherited one; other copies make one warning; skill/ and bad skills are listed | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| deleting an own skill drops its permission rule | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| command frontmatter is validated strictly before anything is written | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| command files: create nested, edit, stash off and restore byte for byte, delete | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| config commands: listed, edited in place, stashed off and restored, deleted | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| plugins: install npm and file specs, stash off and restore in place, delete; the status plugin is locked | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| plugin files are stashed off and restored | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| instructions read and write against their revision | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| export carries real MCP values and a skill copy; import honours the conflict policy | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| frontmatter is written for OpenCode's YAML 1.1 reader: values it would retype are quoted, also on a body-only edit | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a `key: value: more` line loads through OpenCode's own fallback, so it is neither skipped nor unreadable | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a skill switch carries a blanket deny from tools or another file instead of dropping it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an MCP server switched off with the newer `disabled` key is off, and an edit keeps it off | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a config key set twice refuses the edit instead of changing the copy OpenCode ignores | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| replacing a skill never deletes a folder that holds a skill of another name | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a command's frontmatter name is the one OpenCode uses: warned, and a create under it is a clash | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| plugins and config commands turned off and on keep their order and their own text | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a config with a byte-order mark is edited and keeps it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an agent's own permission rules that override a skill are warned about | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| Orquester's status plugin cannot be listed again as a plugin spec | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/adapters/opencode/jsonc.test.ts`

- Independent contract: Agent config design §4.1: comments, formatting and unknown keys outside the edit survive; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: setJsonc → edited native bytes and parsed meaning.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Comment/comma ownership, same-line comments, empty trailing-comma objects and CRLF are distinct persisted layouts absent from adapter CRUD. Exact bytes protect the stated editor contract, not markup or source layout.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/adapters/opencode/jsonc.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a member whose comma follows a comment, or a leading-comma layout, is removed cleanly | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| appending a member keeps the last member's same-line comment on its line | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| removing a member takes only its own line, whatever its position | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| removing the only member before a trailing comma leaves a valid empty object | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| CRLF files keep CRLF | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/convert.test.ts`

- Independent contract: Agent config design §6: cross-agent copy mapping and source preservation; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: createProfileConverter → portable items, copied files, modes and refusal codes.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Each named target representation, unit conversion, name validation and symlink refusal has a distinct conversion failure. Native adapters do not own cross-agent frontmatter/timeout translation.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/convert.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| skill conversion preserves content and executable support files without changing the source | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| MCP conversion preserves stdio and HTTP secrets without exposing them in notes or mutating the source | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skill: Claude when_to_use becomes Grok when-to-use in place, and back | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skill: a missing or different frontmatter name is set to the item's name | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skill names are checked against the rule | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skill: a symlink inside refuses the copy and leaves no temp dir | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skill: the source directory may itself be a symlink | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skill: an unparseable SKILL.md is an invalid item | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| command → Codex without a description gets one naming the command | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| command names are checked; Grok flattens one folder level | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| mcp advanced: ms ↔ s timeouts and the Codex/Grok-only fields | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| mcp: an empty advanced map is omitted; sse cannot go to Codex or OpenCode | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| mcp server names are checked | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/daemon-mcp.test.ts`

- Independent contract: Unified MCP design §12.1 D-12; AGENTS.md full-trust endpoint and realpath containment rules; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: DaemonMcpDetector and its HTTP/socket routes → flagged servers and refusal codes.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Bearer, URL, name, account-home, project trust and symlink ancestry mistakes can bypass denial of the full-trust endpoint. These detector inputs are not redundant with the downstream session-tool denial tests.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/daemon-mcp.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| urlReachesDaemon: loopback on the daemon's port with path /mcp, or a configured origin | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| pointingReason: a bearer in a header, an argument or an env reference; the URL; the name; bearer wins | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| detect: every CLI's user config shape in the system home | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| detect: every managed account home, each file read once, and project-level configs (all projects or one) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| routes: GET lists flagged servers on both transports; the socket-only check merges the item's current values and never echoes them | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a projectPath filter must realpath inside the workspaces root; outside (or through a symlink out) it is refused, never read | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a chat in a subdirectory: every directory from the project down to its cwd is scanned, nothing outside | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| codexLoadingHomes: Codex's own trust rules (probed on 0.159.0) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a project reached through a symlink: its link path's ancestors are read for Codex too; listing follows project links only | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/e2e-mcp.test.ts`

- Independent contract: Unified MCP design approval preview/write consistency; Agent config design secret handling; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Real tool executor → HTTP routes → real adapter → native files and approval cards.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The retained flows uniquely verify that a stale approval cannot write, secrets stay host-only, and selected/reversed batch picks use the exact shown names. Unit parser and adapter tests do not cover those component joins.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/e2e-mcp.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| MCP profile creation and partial edits persist secrets without returning them | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| chat: add a skill to Claude Code through edit_agent_profile with a card, then a stale update is refused | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| chat: one batch writing the same name twice — two picks, two creates — shows and writes the same suffixes; fail is refused before the card | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/homes.test.ts`

- Independent contract: Agent config design native HOME/env resolution; OpenCode additive OPENCODE_CONFIG_DIR and XDG rules; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: resolveAgentHomes → CLI-native config paths.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Defaults, explicit overrides, empty variables and OpenCode XDG behavior are distinct environment contracts. No filesystem fixture can cover all override combinations without a broader seam.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/homes.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| resolveAgentHomes: the CLIs' defaults under HOME when no variable is set | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| resolveAgentHomes: every override variable wins, and CLAUDE_CONFIG_DIR moves .claude.json with it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| resolveAgentHomes: an empty variable counts as unset, as in agent-hooks and agent-accounts | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| resolveAgentHomes: OpenCode's global dir follows XDG_CONFIG_HOME, as OpenCode's own `Global.Path.config` does | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/import.test.ts`

- Independent contract: Agent config design §6: supported git/upload forms, bounded imports and safe extraction; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: ProfileImportStore and git URL/clone boundary → real temp files/candidates/error codes.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The cases protect different URL protocols, traversal encodings, archive limits, ownership/TTL states and agent conversions. Real local-git integration is retained for command/protocol behavior; injected clone fixtures isolate scanning only.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/import.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| git URLs: accepted forms and what they clone | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| git URLs: refused forms | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a git scan lists skills and commands, skipping symlinks, depth and node_modules | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a tree URL clones the repo at the ref and scans only the folder | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a skill at the repository root is named after the repository | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a refused URL never reaches the clone | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a failed clone is an IMPORT_FAILED and leaves nothing behind | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an empty scan is a 400 IMPORT_FAILED and removes the clone | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a checkout over 50 MB is refused and removed | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the .git directory does not count toward the size cap | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| Codex: commands are offered as skills and converted when taken | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| Grok: nested commands are offered flat | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| take: commands carry parsed frontmatter mapped to the agent; skills stay in the import until release | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an import expires after the TTL, swept lazily on the next call | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the sweep removes directories a previous run leaked once they are old | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| stop() removes every import and refuses new ones | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| open imports are capped | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| real git: a shallow clone of a local bare repo, symlinks refused, subfolder selected | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| upload: a zip is extracted and scanned | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| upload: a zip with a traversal, an absolute path, a drive letter or a symlink is refused whole | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| upload: zip entry and size caps | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| upload: the default caps are 5000 entries and 100 MB | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| upload: a file that is not a zip is refused | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| upload: a SKILL.md is one skill, any other .md one command, anything else refused | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| upload: the upload file is not needed after the scan | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/infra/backups.test.ts`

- Independent contract: Agent config design §4.1: newest 50 per-agent backups preserve modes and old data; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: ProfileBackups → backup files, modes, ring contents and original bytes.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Mode preservation, directory/symlink copying, bounded retention and same-millisecond collision handling are separate data-loss modes. Adapter writes do not drive ring exhaustion or timestamp collisions.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/infra/backups.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| save copies a file with its mode, and answers null for a missing path | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| save copies a directory tree, keeping inner symlinks as symlinks | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the ring keeps the newest 50 entries per agent | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| two saves in one millisecond both survive, in order | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/infra/cli-runner.test.ts`

- Independent contract: Agent config design native argv-only CLI, explicit env, deadlines and redacted stderr; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: runAgentCli/buildAgentCliEnv/redactCliOutput → real child argv/env/stdin/exit plus public results.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The child is real; only the clock is controlled for deadline behavior. Shell expansion, env leakage, stdin handling, signal escalation, bounded output and error redaction have separate externally visible failures.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/infra/cli-runner.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| exit code, stdout and stderr come back; argv reaches the CLI verbatim with no shell | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| input is fed to stdin; without input stdin is empty | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the child's env is built explicitly: agent homes, ORQUESTER_* and NODE_OPTIONS never leak | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| buildAgentCliEnv refuses ORQUESTER_* and malformed extras | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a deadline kills the child and says so | OPTIMIZE | Retains real child, timedOut=true, null exit code and SIGTERM assertions; advances a virtual 200 ms deadline immediately after synchronous spawn. No real elapsed-time contract requires the wait. |
| a child that ignores SIGTERM is SIGKILLed after the grace period | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| output is capped per stream with a marker, and the child is still drained to its exit | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| runAgentCli rejects when the binary cannot be started | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| runAgentCliOrThrow answers on success and throws AGENT_CLI_FAILED with redacted stderr | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| redactCliOutput masks credential shapes and named secrets but keeps ordinary text | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/infra/frontmatter.test.ts`

- Independent contract: Agent config design markdown reader/writer and body preservation; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Markdown parse/serialize → literal body/frontmatter results or refused malformed input.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: BOM/CRLF/fences, missing frontmatter, malformed mappings and bodies starting with fences are distinct user document forms. Adapters supply ordinary markdown and do not own each parser form.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/infra/frontmatter.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| handles CRLF, a BOM, trailing spaces on the fences and a block at end of text | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| no frontmatter, an empty one, and an unclosed fence | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| malformed YAML and a non-mapping block throw clear errors | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| serialize omits an empty block, except to protect a body that starts with a fence | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/infra/fs-write.test.ts`

- Independent contract: Agent config design §4.1 atomic verified edits, backups and symlink preservation; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Filesystem write/remove/copy operations → real bytes, mode, links and error codes.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Root symlinks, parent symlinks, dangling links, loops, existing directories and failed-verify rollback differ in filesystem semantics. Generic config CRUD does not uniquely cover these destructive failure modes.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/infra/fs-write.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a new file gets the default mode, parents are created, no backup is taken | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an existing file keeps its mode and its previous version is backed up | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| writing through a symlink updates the target and keeps the link | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a write through a symlinked parent directory lands in the real directory | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a dangling symlink is followed to the file it names, which is created | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a symlink loop is refused | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| writing onto a directory is refused | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a verified write that no longer parses is rolled back from its backup | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a verified write of a NEW file that fails removes it again | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| removeProfilePath backs up and deletes files and trees; a symlink loses only the link | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copyTree follows the root, refuses or skips inner symlinks | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/infra/hash.test.ts`

- Independent contract: Agent config design §4.3 persisted hook IDs; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: hookItemId → literal SHA-256 identity vector and equivalence/difference relations.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The literal external format vector is independent of the implementation. Stable key order, matcher normalization and changed handler identity prevent collisions or disappearing edits not proved by normal adapter flows.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/infra/hash.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| hookItemId hashes the normalized {matcher, handler} and ignores key order | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/infra/markdown-items.test.ts`

- Independent contract: Agent config design skill/command scanning and preserve broken user documents; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: scanSkills/scanCommands/readSkillFiles/writeSkill → real fixture tree and unchanged bad bytes.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Native directory depth, unreadable/symlinked entries, support-file containment and broken-write refusal use distinct file forms. Shared frontmatter parsing does not own directory enumeration.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/infra/markdown-items.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| scanSkills lists skill dirs, follows and marks symlinks, tolerates broken ones | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| scanCommands lists .md files, one folder level when nested | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| readSkillFiles lists the other files, skipping node_modules and .git, never following links | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| writeSkill refuses to merge into a broken file without changing its bytes | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/infra/names.test.ts`

- Independent contract: AGENTS.md filesystem containment; Agent config design §4.5 safe path segments; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: assertSafeSegment → accepted segment or INVALID_NAME.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The scanner/writer last-line guard must reject separators, NUL, dot segments and hidden entries. The API validators have stricter agent names and cannot supersede this broader filesystem segment contract.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/infra/names.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| assertSafeSegment refuses separators, NUL, .., leading dots and empty | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/infra/secret-digest.test.ts`

- Independent contract: AGENTS.md secrets stay host-only; Agent config design secret-safe revisions; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: SecretDigester.deepMasked → serialized revision input with secrets removed and public values retained.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Nested secret-map spellings and OAuth/password fields are absent from the simple MCP top-level adapter fixtures. A leak or loss of non-secret fields independently fails the literal input oracle.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/infra/secret-digest.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| deepMasked hides every secret spelling at any depth and keeps everything else | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/infra/stash.test.ts`

- Independent contract: Agent config design §4.4: disabled items restore byte-for-byte, no overwrite; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: ProfileStash → real payloads, manifests, modes, conflicts and cross-filesystem restoration.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: File/tree/link, occupied restore target, existing entry, broken manifest, long ID and EXDEV cases represent distinct data-loss risks. Adapter enable/disable does not cover all stash storage representations.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/infra/stash.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a stashed file moves out and restores byte for byte, mode and all | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a stashed directory (with an inner symlink) and a stashed symlink restore intact | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| restore refuses with STASH_CONFLICT when the original path is taken, and keeps the entry | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| stashing an id that is already stashed is refused; remove() then re-stash replaces it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| list is sorted, per agent, and skips broken entries with a warning | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a leftover entry that is not usable is replaced instead of blocking the id | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| long item ids round trip and unsafe stash owners are refused | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| stash and restore across filesystems copy, fsync and remove | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/preview-reads.test.ts`

- Independent contract: Unified MCP design §§7.1–7.2: complete approval previews, pins and no followed links; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Preview reads/service/route boundary → shown files/hash/source/error state.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Each named native source, hash/size bound, plugin location, prepared-name and unreadable-cache case changes what approval authorizes. Adapter snapshots do not own complete preview content or checkout containment.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/preview-reads.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| readPreviewTree: text in full, executables and binaries flagged with hashes, symlinks listed not followed, .git skipped | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| readPreviewTree: past the byte cap the tree is incomplete, never cut silently | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| readGitCommit: a symbolic HEAD through loose and packed refs, a detached HEAD, a worktree's .git file; null elsewhere | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| pluginProvidesOf and claudePluginSource: what a plugin ships, and where it lives in its marketplace | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| ProfileImportStore.inspect: an open scan's source and every candidate in full; a taken scan is gone | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| routes: the card reads answer what the service reads, and 503 without it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| pluginProvidesOf: hooks and MCP servers a manifest declares by path (one, or a list) count too | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| ProfileImportStore.inspect shows picks as they will be imported: frontmatter mapped, a Codex command made a skill | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| AgentProfileService.mcpCandidate: header and env values and every Codex env reference, daemon-side only | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| codexPluginLocation: the checkout is the manifest's root (either layout); a relative source resolves against it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| pluginPreview: a plugin directory outside the marketplace checkout (on realpaths, a symlink included) is marked: its commit does not pin it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copyPreview and keep-both import detail: written under the target's own keep-both name, SKILL.md carrying it; temp copies removed | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| readInstalledPlugin: the reported version, symlinked versions only inside the plugin cache, and unreadable reasons | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| readInstalledPlugin: the cache root comes from the path as named — an account home reaching the cache through a symlink still follows sibling versions | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| claudePluginFetch: which catalogue sources a git clone can fetch | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/routes.test.ts`

- Independent contract: Shared API agentProfileRoutes request/response contracts; AGENTS.md binary upload and redaction rules; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Fastify HTTP injection → status/code/body, decoded inputs and actual upload temp bytes.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: URL ID decoding, multiline initial revision, validation/error mapping, route caps and pre-response upload cleanup are transport failures absent from service tests. Stubs isolate service behavior; the route owns wire decoding and streaming.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/routes.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| HTTP item routes decode nested command IDs as a single identifier | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| HTTP instruction writes preserve an empty initial revision and multiline text | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| validation: precise 400s, and nothing reaches the service | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| validation: an unknown agent in the path is 404 UNKNOWN_AGENT | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| validation: no refusal quotes a secret value, a git URL or an unparsable body | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a JSON body over the route limit is 413 in the module's error shape | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an AgentProfileError answers its own status and code; anything else is a generic 500 | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| upload: the octet-stream body is streamed to a temp file under the imports dir, scanned, then removed | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| upload: the temp file is removed when the scan fails too | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| upload refusals before the body is read answer Connection: close and never reach the scan | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| only the upload route accepts an octet-stream body | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-profile/service.test.ts`

- Independent contract: Agent config design shared per-agent queue, snapshot/event/lifecycle behavior; docs/superpowers/specs/2026-09-28-agent-profile-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: AgentProfileService public operations/lifecycle events → returned state, refusal codes and temp ownership.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Each named queue race, write/read refusal, notification or watcher lifecycle protects service coordination, not native adapter encodings. Deferred dependencies only schedule external completion; real service logic determines the asserted state and events.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-profile/service.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| snapshot: a not-installed agent (or one with no adapter) answers an empty snapshot, not an error | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| overview: counts per kind per agent; one failing adapter reads as counts {} and is logged | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| mutations to one agent run one at a time, in order; a failure does not break the chain | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| reads do not queue behind a held mutation | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a mutation or detail read on a not-installed agent is 404 AGENT_NOT_INSTALLED and never reaches the adapter | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| create: kinds the agent does not have or cannot create are 400 KIND_NOT_SUPPORTED | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| create/update: names follow the shared rules and MCP transports the agent's own | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| update: plugins and marketplaces are not editable; the draft kind must match the item | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| trust, legacy migration and marketplace plugins answer KIND_NOT_SUPPORTED where the adapter has none | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a mutation emits changed once with the fresh revision; a no-op write and plain reads emit nothing | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the first mutation on an agent is announced even with no baseline | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a revision from a read that began before a newer one is dropped, never announced | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| publishAgentProfileEvents puts every change on the agent-profile channel | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| afterWrite runs after each successful write only, and its failures never fail the write | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a mutation that fails after writing part of its work still announces the change and runs afterWrite | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copy: exports from the source, imports into the target, answers the TARGET's snapshot and removes the temp dir | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copy: the temp dir is removed when the import fails too | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copy: refused onto the same agent, for non-copyable kinds, and where the target cannot create the kind | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copy with a converter: imports the converted item and removes its temp dir | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copy: opposite copies between two agents do not deadlock | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| imports: take → importItem for each pick in the agent's queue → release, whatever happens | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| watching: changes are debounced for 500 ms and unchanged snapshots are not announced | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| watching: an error closes the agent's watchers; the next snapshot re-arms them | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| watching: a watch that throws while arming leaves the agent unarmed (retried on the next read) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| stop: closes every watcher and pending timer, closes the adapters, and nothing runs afterwards | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| stop during arming closes the watchers that arming opens | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the default watcher: a real fs.watch on the nearest existing directory announces a file created in it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/contributions/codex.test.ts`

- Independent contract: Agent Profiles design §§6.2,7: seeded account/profile home and resume identity; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Real launch resolver/registry → CODEX_HOME/homePath or PROFILE_NOT_READY.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: This is the lowest assembled launch seam for Codex home selection and unseeded refusal. The broad workflow also covers successful launches but not the missing state DB after preparation.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/contributions/codex.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| points CODEX_HOME and the resume home at the prepared home, over the account's launch | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses an unseeded home: PROFILE_NOT_READY, never a launch | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/contributions/grok.test.ts`

- Independent contract: Agent Profiles design §6.3 and agent-isolation README native env recipe; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: grokProfileLaunchContribution → literal launch environment/homePath or refusal.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The surviving literal environment oracle catches credential-home and compatibility leaks, including accidentally setting the Claude skills disable variable. The refusal case independently covers unknown/nonabsolute/inside-profile homes.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/contributions/grok.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| points GROK_HOME (and the thread's home) at the prepared dir and GROK_AUTH_PATH at the account's auth.json | REWRITE | Expected compatibility env is now literal protocol data, no spread from the production map. It uniquely catches wrong native keys, lost account credential path, extra Claude-skills override and wrong resume home. |
| uses the Global home's auth.json for the System identity | DELETE | Fails unique protection: changes only the accountHome string on the same generic path join. System account normalization/auth selection is now checked through the real resolver in launch.test.ts. |
| keeps Claude skills compat on and every other compat surface off | DELETE | Fails unique protection: exactly duplicates the full literal env oracle in the surviving contribution case. |
| refuses an unknown account home, or one inside the profile | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/imports.test.ts`

- Independent contract: Agent Profiles design §4.5, §4.4 secrets and export/import obligations; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Real SessionProfileImports/Service/Store → native copied files, preserved Global data, exports and refusals.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: These joins uniquely verify atomic scope/conflict application, consistent source snapshots, plugin cache ownership and secret-redacted export. Primitive scan/convert/store tests do not test these composed import routes.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/imports.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| copies skills, commands, MCP servers (secrets host-only), hooks, plugins and instructions; Global is untouched | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| maps frontmatter for a single other agent, appends instructions, and follows the conflict policy | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses an agent that is not installed and items that cannot be imported | REWRITE | The plugin-owned skill refusal is unconditional and first proves the actual installed plugin skill is listed as unavailable; removes a conditional branch that silently skipped the assertion and prevents the negative passing for a missing item. |
| scans a repository: commands stay commands, exists is the profile's, picks land with the chosen scope | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| scans an uploaded .zip and .md; refuses an archive that escapes or carries a symlink | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copies items with their files, plugin cache, secret values and scope | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copies one consistent snapshot of the source: an edit of the source during the copy does not tear it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| Claude: a marketplace folder, a catalogue-only plugin given a manifest, and a remote source cloned | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| Codex, Grok and OpenCode: version root, a remote marketplace's catalogue, a Global plugin file; symlinks refused | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| exports a zip without any secret value, and builds a new profile from it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| redacts credential-looking URL parts, args and hook command values in an export, and says which | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an import never makes a managed profile nor carries the managed-only no-built-in-tools setting; a managed profile is never exported or copied from | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses an export that is not exactly one | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/integration.test.ts`

- Independent contract: Agent Profiles design §§5–8: isolation, resume, refresh, switch, deletion and failed launches; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Daemon/store/preparer/real host socket/orchestrator → effective launch input plus durable events.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: This critical workflow spans the daemon/host boundary. Distinct concurrent kits, restart edits, profile switch, interactive versus unattended deletion and preparation failure cannot be superseded by isolated preparer/resolver tests.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/integration.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| ${agent}: two concurrent chats on one account with different profiles get distinct kits and no Global item; a Global chat beside them is unchanged | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a daemon and host restart keeps the chat's profile, and its next start picks up the edited profile's new version | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a profile switch mid-chat relaunches with the new kit on the same conversation; a switch to Global drops it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a deleted profile: an interactive chat falls back to Global with a notice naming it; an unattended one fails to start | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a failed preparation fails the launch with its reason, never Global: at create, and at a later start | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/knowledge.test.ts`

- Independent contract: Agent Profiles settings.knowledgeCollections wire/persistence contract; AGENTS.md tolerant stores; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Real profile service/store/routes/export and knowledge lookups → persisted settings and public results.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Collection replacement, malformed input, duplicate/export persistence, future values, sorted lookup and fail-closed unreadability protect different consumers and persisted representations.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/knowledge.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| absent is none ticked; create and update replace the list (deduplicated); the wire shows it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses what is not a list of collection ids, or too many | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the route validates the field (400) and saves a good one | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| duplicate and export/import keep the ticked ids (stale ones too: they are ignored where used) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a hand-edited or newer value is kept through a rewrite and reads as none ticked (or its ids only) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| profilesForCollection: per collection id, the profiles ticking it, by name | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| profileKnowledgeCollections: a deleted profile is missing; an unreadable one throws (the caller fails closed) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/launch.test.ts`

- Independent contract: Agent Profiles design §§5.5–7, shared launch composition and failed launch behavior; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: applyProfileContribution/real resolver/liveIds → launch environment/error codes/current profile IDs.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Literal launch composition, System account auth path, failure mapping and stale initial-list races remain. Actual Codex/OpenCode contribution owners cover the deleted fabricated-contributor happy path; durable deleted-name store tests cover the deleted cache.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/launch.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| apply over the account's launch: env wins, unset merges, home follows the home variable, serverPool replaces | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| ensures the profile is ready for the agent and account, reads its section and applies the contribution | DELETE | Fails independent oracle/refactor resistance/unique protection: the fake contributor turns arranged manifest values into the exact expected fields and asserts private callback arguments. Real Codex contribution, OpenCode resolver and cross-host integration protect actual launch outputs. |
| asks the System account as null, and names its home through accountHome | REWRITE | Calls the real Grok contributor; literal GROK_AUTH_PATH and homePath now prove System normalization/resume identity instead of recording fake callback shape. |
| passes the lifecycle's refusals through and turns a bad manifest or a failing contributor into PROFILE_NOT_READY | REWRITE | Uses the real unknown-account-home refusal from Grok instead of an injected throwing function. Public typed refusal codes and missing-manifest behavior remain protected. |
| knows every listed profile, follows changes, and keeps a deleted one's name for the notice | DELETE | Fails production relevance/unique protection: production uses only liveIds and durable SessionProfileService.deletedName. Its cache/get/note/idle and service.get refresh existed only for tests and were removed. Durable deletion-name store and host integration remain. |
| liveIds: unknown until the first list lands, then the existing profiles (unreadable ones too), following creates and deletes | REWRITE | Retains independent live-ID initial-read/create/delete race expectations; removes obsolete name-cache assertion/drain. Stale lists must not revive deleted IDs or lose a new profile; unreadable IDs remain live. |
| liveIds stays unknown when the list cannot be read | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/lifecycle.test.ts`

- Independent contract: Agent Profiles design §6.5 plus version/lease constraints in §12; AGENTS.md durability; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: SessionProfileLifecycle public lifecycle → published versions/current pointer, errors, prepare status and retained/deleted dirs.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Each named concurrent preparation, staleness input, shutdown or lease-GC interleaving protects a distinct storage/process failure. Deferred preparers control scheduling only; real lifecycle and filesystem determine publishing and collection.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/lifecycle.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| prepares atomically for the final path and answers the ready dir | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses an agent without a preparer and reports it not-prepared with the reason | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| answers PROFILE_NOT_FOUND for an unknown profile | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps the previous ready dir when a preparation fails, reports the reason and never leaks a secret | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| dedupes launches onto the preparation in flight | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| answers a waiting launch with the failure in flight instead of retrying | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| serializes one key, runs different keys concurrently, and caps them globally | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| re-prepares on a revision, preparer version, CLI version or Global input change | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| prepares a new profile in the background and removes a deleted one after its jobs settle | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keys per account for a perAccount preparer and aggregates their status | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| re-prepares a key marked stale (Codex re-seed) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| re-prepares a current version its preparer calls unusable (Codex: state DB gone) and hands preparers the CLI binary | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| cleans staging at boot, drops prepared dirs of deleted profiles and re-prepares stale ones | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses launches after stop and passes an aborted signal to preparations in flight | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| publishes every preparation as a new version and never touches an older one | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| never reuses a version name, even for the same fingerprint at the same instant | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps a leased old version, removes it once unleased and after the handout grace | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| re-reads the leases for a key reached after the handout grace (a snapshot that old is stale) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| removes an unleased old version right after publishing | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| deletes nothing when inUse() fails or no leases source is wired | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| collects again once the leases become knowable (the host turned healthy after boot) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skips quietly while the host is not adopted yet, then collects once it is (no boot false alarm) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| runs a slow periodic pass that collects what no trigger would (a deleted profile's leftovers) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| on delete removes pointers and unleased versions; a leased one stays until a later GC | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| flips the pointer atomically: a reader always sees a complete version | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| treats a legacy unversioned key dir as stale and collects it subject to its lease | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/manifest.test.ts`

- Independent contract: Agent Profiles prepared-manifest compatibility and AGENTS.md host handover rules; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Manifest writer/reader/parser → literal envelope, privacy mode and typed launch refusal.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Unknown fields, missing/broken/wrong identity versions and unknown schema/agent are persisted wire-format cases. Full successful launch workflows do not cover malformed manifests independently.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/manifest.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| round-trips through the file, 0600, unknown fields kept | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| fails a launch whose prepared dir is missing, unreadable, or for another profile, revision or agent | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses an unknown schema or agent | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/preparers/claude.test.ts`

- Independent contract: Agent Profiles design §§4.4,6.1,6.5,8 native golden output and immutable secret files; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: claudePreparer → native plugin/MCP/instruction files, manifest section, permissions and copy isolation.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The native output owner now also verifies private permissions and cache-edit independence using the same preparation. Separate settings/namespace/empty cases have distinct launch contracts. Host integration does not enumerate these output combinations.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/preparers/claude.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| shares preparations across accounts without copying Global files | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| names a copied plugin as the CLI loads it: its manifest name, else its directory (the item id) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| writes the plugin, the plugin copy, the MCP file and the instructions (golden) | CONSOLIDATE | Surviving native-output owner now also verifies MCP/instruction files 0600 and source-cache mutation leaves the prepared plugin unchanged. Same real preparation and all former meaningful assertions retained. Final name: writes an immutable plugin copy and private MCP and instruction files (golden). |
| keeps the secrets file and the instructions 0600 | CONSOLIDATE | Assertions moved unchanged to the claude native-output golden owner; removes a duplicate full filesystem preparation without losing privacy-mode coverage. |
| copies the plugin, so a later edit of the profile's cache does not reach the prepared version | CONSOLIDATE | Source-cache edit and literal unchanged prepared-file assertion moved to the claude native-output golden owner. Removes one redundant full preparation; copy isolation remains. |
| with the Workflow tool off: disableWorkflows and no workflow-authoring | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a managed profile without built-in tools says so in its section; others never carry the key | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| showing built-in skills omits the allow-list entirely | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an empty profile writes no plugin, MCP or instructions file | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/preparers/codex.test.ts`

- Independent contract: Agent Profiles design §§6.0,6.2,6.5,8: per-account seeded homes and native config; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: codexPreparer → real prepared files, account links, seeded fake-CLI DB and errors.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Account-specific auth/history, hook trust at the final path, runtime settings, missing binary/DB and secret-free failure are distinct preparer failures; generic seed tests do not assemble the full profile home.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/preparers/codex.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| prepares per account and tracks the Global config.toml | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| builds the isolated home: config, instructions, skills, commands as skills, hooks with trust, plugins, links, seeded DB | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| without Codex plugins: plugins feature off; built-ins shown when the profile says so; no instructions file | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the System account links the system home's login and history | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an account home without sessions/ yet links the shared one every account home links to | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| fails without a codex binary, and when the seed cannot create the state DB | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| never leaves a secret value in a failure reason or a log line | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/preparers/grok.test.ts`

- Independent contract: Agent Profiles design §§4.4,6.0,6.3,6.5,8: native config recipe and immutable private files; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: grokPreparer → native TOML/plugin/hooks/history files, permissions and copy isolation.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The golden owner includes permissions and source-cache mutation once. Runtime carry-over, first recipe, built-in visibility, empty profile and malformed Global config differ in caller-visible effects; the host integration does not cover every output form.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/preparers/grok.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| shares preparations across accounts and tracks the Global config.toml | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| builds a Grok home with only the profile's kit (golden) | CONSOLIDATE | Surviving native-output owner now also verifies config/instruction files 0600 and profile directory 0700 and source-cache mutation leaves the prepared plugin unchanged. Same real preparation and all former meaningful assertions retained. Final name: builds a private Grok home with an immutable copy of the profile's kit (golden). |
| carries the Global runtime settings over, minus the item sections, plus the profile's MCP servers | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| writes a first config.toml with the recipe, the exclusion lists as of now and no plugin deny list yet | REWRITE | Expected user-root paths are now literal observed native paths, rather than expanded from the production GROK_USER_SKILL_ROOTS map. Final-version bundled paths, symlink exclusion and first-spawn recipe remain protected. |
| keeps the config files and instructions 0600 in a 0700 tree | CONSOLIDATE | Assertions moved unchanged to the grok native-output golden owner; removes a duplicate full filesystem preparation without losing privacy-mode coverage. |
| copies the plugin, so a later edit of the profile's cache does not reach the prepared version | CONSOLIDATE | Source-cache edit and literal unchanged prepared-file assertion moved to the grok native-output golden owner. Removes one redundant full preparation; copy isolation remains. |
| showing built-in skills leaves bundled skills out of the ignore list | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an empty profile still gets the recipe, the managed hooks and the shared links — nothing else | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| fails with the reason when the Global config does not parse | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/preparers/opencode-isolation.live.test.ts`

- Independent contract: Agent Profiles design §§6.4,8; real OpenCode loader canaries; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Opt-in real CLI debug/server → actual loaded profile/project/Global items and instruction sources.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: The real CLI uniquely detects upstream config-loader changes that scripted fixtures cannot catch. Retains its existing explicit opt-in; no new skip or gate change introduced. Critical artifacts are inspected from sandboxed CLI/server responses.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/preparers/opencode-isolation.live.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a profile server loads only the profile's items and the repo's own; Global loads the user's | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| instructions: the profile's and the repo's own (AGENTS.md, else CLAUDE.md) as in Global; never the user's | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/preparers/opencode.test.ts`

- Independent contract: Agent Profiles design §§6.0,6.4,6.5,8 and native isolation probe requirements; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: opencodePreparer/real contribution/resolver/server pool → native config, shadow links, launch env and refusals.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Different native input files, denied-skill policy, unverified HOME override, missing instruction sentinel, refreshed XDG shadow and server-pool ownership are distinct failures not replaced by fake-preparer lifecycle tests.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/preparers/opencode.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| shares preparations across accounts and tracks every Global config file | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| writes the config dir, the plugin copies, the status plugin and the XDG shadow (golden) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps the Global permission as is when built-in skills are shown, and merges the deny last otherwise | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| verifies OPENCODE_TEST_HOME against the CLI binary; the probe leaves nothing behind | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses when ~/.opencode holds config and the override is not verified (no binary, or one that ignores it) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| always writes AGENTS.md — empty without instructions — so OpenCode never falls back to ~/.claude/CLAUDE.md | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| fails with the reason when a Global config file does not parse | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| names the version's keyed server with the profile env | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses at every launch while ~/.opencode holds config and the override is not verified | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses a version without AGENTS.md (an older preparation) instead of letting ~/.claude/CLAUDE.md in | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refreshes the shadow at every launch: new entries linked, gone ones and a stray `opencode` link removed | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| loads Orquester's status plugin once and never writes it through to the real ~/.config/opencode | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| goes through the resolver: the account's launch stays as is, the keyed server is the profile's | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| starts with the contribution's env over the launcher env; the project's Global server is unchanged | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/resolve.test.ts`

- Independent contract: Agent Profiles design §§4.2–4.4: scope/support/settings/host secrets; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: resolveForAgent/settings resolution → concrete resolved items or skipped item IDs/reasons.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Enabled/scope filtering, missing secrets, unsupported transports/hooks, missing files, future agent/settings values and managed-only built-in settings can independently alter launched context. Native preparers consume resolved items and do not own these invalid inputs.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/resolve.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| keeps enabled items in scope for the agent, with their source paths | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| hands MCP servers their REAL secret values, and skips one whose value is missing | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skips an MCP transport the agent lacks, for that agent only | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| applies plugins and hooks to their one agent and skips an invalid single-agent scope | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| skips items whose content is missing and items that do not read | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| ignores an agent id this build does not know | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| honours claudeBuiltinTools: false only on a managed profile | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| resolves the settings with their defaults, per agent | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/routes.test.ts`

- Independent contract: Shared API sessionProfileRoutes and Agent Profiles CRUD/import/export/delete preconditions; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Real Fastify/profile service/store → HTTP status/code, persisted state and secret-free response.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: HTTP precondition races, malformed bodies, box-switch field preservation, secret refusals and binary imports/export each have wire-specific failure modes beyond store API tests.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/routes.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| refuses 409 WORKFLOW_USES_CHANGED, nothing deleted, unless the uses are exactly the ones confirmed; any order | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| an empty expectation deletes an unused profile; without one (an older client) nothing is checked | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| fails closed: unknown uses, or no index, refuse a delete that names the precondition; a malformed one is 400 | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| runs the CRUD flow and never answers a secret value | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| answers refusals in the {error: {code, message}} shape | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps an MCP server's Run in box switch (boxes) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| never quotes a secret value in a refusal | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| imports from Global, streams uploads, exports a zip without secrets and imports it as a new profile | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses an upload before reading it, and answers 503 when imports are not wired | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/session-profiles/store.test.ts`

- Independent contract: Agent Profiles design §§4.2–4.5 and §5.6; AGENTS.md tolerant persistence and secrets; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Real profile store/service → native persisted bytes/modes/revisions and caller views.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Each named CRUD/revision, managed-owner, rollback, scope-collision, future-record, duplicate, missing-content and fallback-catalog case has a distinct persisted/consumer contract. Native preparers do not mutate the source store.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/session-profiles/store.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| creates, lists, updates and deletes with optimistic revisions | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps a deleted profile's last name on disk, read by a later store (a daemon restart) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses ids that are not one safe path segment as not found | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| serializes concurrent mutations: two edits from the same revision → one conflict | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| lists an unreadable profile as an error and never rewrites it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps the store private: 0700 dirs, 0600 manifest and secrets | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| ensureManaged creates once, is idempotent, and re-aligns a drifted profile with one bump | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses user edits, deletes and copies of a managed profile, and frees its name | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| no user read of a managed profile answers anything but 404 (instructions, items, preparation) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| the service announces a managed profile only when it changed | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses to take over a profile with that id that is not the managed one | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| stores MCP secret values only in secrets.json and masks them in every view | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| rolls a failed mutation back whole: secrets, rewritten documents and instructions keep their previous text | REWRITE | Baseline failed under uid 0 because root bypassed chmod(0500), so no commit failure occurred. Root runs the same selected regression once in a uid/gid 65534 child with sanitized env and an asserted one-test TAP pass; other users execute it inline. The real EACCES barrier and all four rollback actions/byte assertions remain unchanged; no production injection, sleep or skip is introduced. |
| writes skills as directories and commands as markdown, by item id | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses a name twice for overlapping agents, allows it for disjoint ones | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| requires exactly one agent for hooks and plugins, and a hook event that agent fires | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps unknown fields and unreadable items through rewrites; an unreadable item can be deleted | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps settings and a plugin source this build cannot read through a rewrite | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| writes and removes instructions under the profile's revision | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copies items, instructions and secrets under a new id and a unique name | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses to resolve a profile whose secrets do not read, without quoting them | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| marks items whose content is missing | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| is the profile's own enabled, in-scope skills and commands (Codex: commands as skills) plus /compact — never anything else | REWRITE | Retains literal command/skill IDs, user-authored description/input hint, scopes, disabled filtering and Codex conversion. Removes only incidental built-in /compact prose. |
| adds a Claude plugin's skills as plugin:skill, for Claude only | REWRITE | Keeps literal visible names/scopes/descriptions and agent scope exclusion; removes cache.endsWith(itemId), which only reasserted setup/path layout. |

### `apps/daemon/src/agent-isolation/claude-names.test.ts`

- Independent contract: Agent Profiles design §6.1; Claude 2.1.285 observed skill/command/plugin naming; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Native fixture scans/naming → exact Claude allow-list and project MCP identities.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Directory/frontmatter distinctions, plugin path overrides, sanitized names, ancestor precedence and installed plugin IDs require distinct observed input forms; profile launch fixtures supply ordinary names only.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-isolation/claude-names.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a skill is its directory — the frontmatter name is display only; symlinked skill dirs count | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| a command is its path below the root, joined by `:` | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| plugin ids: commands then skills; manifest skills add to skills/, manifest commands replace commands/ | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| plugin skill ids are the loader's: folder names sanitised, a single SKILL.md by its frontmatter name | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| one naming for a plugin and its skills, dotted plugin names included | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| project entries: `.claude/` of the cwd and its ancestors, stopping below the home | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| project MCP: every `.mcp.json` from the cwd up, the nearest definition winning | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| installed plugin ids from installed_plugins.json (v2), none when it is missing | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-isolation/claude-plugin.test.ts`

- Independent contract: Agent Profiles design §6.1 generated local plugin and atomic replacement; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: generateClaudeLocalPlugin → native manifest/files/allow-list and preserved prior generation on refusal.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Root/inner symlink behavior, qualified IDs, full replacement, empty kit and invalid collision rollback are distinct native plugin failures. The preparer assembles the helper and does not exhaust these malformed native inputs.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-isolation/claude-plugin.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| writes a valid plugin layout and returns Claude's ids | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| replaces a previous generation as a whole and leaves no staging behind | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| writes an empty plugin (manifest only) for an empty kit | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses bad names, clashing ids and a skill without SKILL.md, keeping the previous plugin | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-isolation/codex-seed.test.ts`

- Independent contract: Agent Profiles design §6.2 and agent-isolation README observed initialize/DB behavior; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: seedCodexHome → real fake-CLI process, persisted DB/history link and refusal.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Fresh, reusable, relink-only, upgrade, concurrent, missing-DB, hung-child and nonempty-history cases have distinct data-loss/liveness failure modes. Full Codex preparation does not inject all those process/filesystem states.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-isolation/codex-seed.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| seeds a fresh home on an empty real sessions/ directory, then links it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| does nothing when the home is already seeded and linked | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| only relinks (no Codex) when the DB is present but the link is missing or points elsewhere | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| re-seeds a linked home whose state DB is missing (a Codex upgrade) | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| runs one Codex for concurrent calls on the same home | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| fails when Codex answers without creating the expected DB, leaving an empty sessions/ to retry | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| kills a Codex that never answers initialize and reports the deadline | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| kills a Codex that does not exit on stdin EOF and still links | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| reports a binary that cannot be started | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses to replace a non-empty real sessions/ directory | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-isolation/grok.test.ts`

- Independent contract: Agent Profiles design §6.3 and agent-isolation README observed Grok exclusions; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Native exclusion list/config rendering plus real inspect process → parsed native output/errors.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Every symlink target/root, built-in exclusion, inspect output/failure and empty-profile form has a distinct isolation failure. Static env inventory was deleted; the actual launch contribution now owns its literal native environment.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-isolation/grok.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| lists the user skill and command roots, every entry by absolute path, and each symlinked entry's target | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| adds <grokHome>/bundled/skills when hiding built-ins | REWRITE | Checks presence of the literal native exclusion path; removes incidental last-array-position requirement, since Grok consumes an exclusion set. |
| tolerates a home without either directory | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| runs inspect with the given env and cwd and returns the exact plugin names | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| parses a real-shaped report | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| answers an error result on a non-zero exit, with the stderr tail | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| answers an error result on a deadline and kills the child | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| answers an error result for a binary that cannot start | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| answers an error result for output that is not a report | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| renders isolated native settings while carrying runtime policy | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| writes empty lists and no mcp_servers table for an empty profile | REWRITE | Checks empty MCP server semantics, allowing either an absent or empty native TOML table; ignores an implementation-only serialization choice. Final name: writes empty exclusion lists and no MCP servers for an empty profile. |
| turns every Claude/Cursor compat cell off except Claude skills | DELETE | Fails unique protection and stable seam: inventories an exported static map; the literal environment returned by Grok launch contribution catches every same compatibility leak. |

### `apps/daemon/src/agent-isolation/opencode-home.test.ts`

- Independent contract: Agent Profiles design §6.4: fail closed unless native HOME override is proven; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: opencodeHomeConfigItems/probeOpencodeTestHome → actual fake CLI control/canary results and scratch cleanup.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Loaded config versus installer files and effective/ignored/inconclusive/failing/hung probes represent distinct safe-launch decisions not exercised by one preparer happy path.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-isolation/opencode-home.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| names the config files and non-empty item dirs of ~/.opencode that OpenCode would load | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| answers nothing for a home without ~/.opencode, or with only non-config entries | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| is effective when the canary loads without the override and not with it | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| is not effective for an OpenCode that ignores the variable | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| is inconclusive (not effective) when the control run does not load ~/.opencode | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| is not effective when OpenCode fails, prints no JSON or hangs | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| is not effective for a binary that cannot start | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-isolation/runtime-settings.test.ts`

- Independent contract: Agent Profiles design §6.0: keep runtime policy/unknown fields, exclude Global item sources; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: Per-agent runtime config filters → literal native config maps and unchanged inputs.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: Each CLI has independently observed key spellings, trust/state exceptions and nested profile forms. Real profile preparation fixtures use only a small subset and do not supersede these native security filters.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-isolation/runtime-settings.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| keeps runtime settings and unknown keys, drops every item key | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| removes deniedMcpServers when only serverName entries were there | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| copies deeply and leaves the input untouched | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| keeps trust entries, models, policy, profiles and unknown keys; drops item sections | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| drops MCP servers, plugins, skills, hooks and compat; keeps the rest | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| drops mcp, plugin, instructions, command, agent and skill paths; keeps provider, model, permission | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |

### `apps/daemon/src/agent-isolation/xdg-shadow.test.ts`

- Independent contract: Agent Profiles design §6.4: retain other tools config while hiding OpenCode Global; no real-tree writes; docs/superpowers/specs/2026-10-18-agent-profiles-design.md.
- Real regression: Each row's exact named operation/input identifies the credible regression; the case asserts its caller-visible state/error or native persisted result.
- Independent oracle: Literal fixture inputs, recorded provider vectors, expected refusal codes, observable file/mode contents and controlled scheduling; no production-derived replacement oracle introduced.
- Stable seam: buildXdgConfigShadow → real symlinks, permissions, preserved tool files and refused overlap.
- Refactor resistance: Checks API/file/protocol effects rather than imports, source identifiers or private source shape. Native bytes and env keys are deliberate external-reader contracts.
- Unique protection: First build, idempotence, refresh/retarget/removal, tool-created real files, absent source and path overlap have different filesystem risks; ordinary OpenCode preparation does not exercise all shadow states.
- Validation: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-isolation/xdg-shadow.test.ts`.

| Baseline test | Disposition | Reason / surviving owner |
| --- | --- | --- |
| links every real entry except the excluded ones, in a 0700 directory | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| is idempotent | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refreshes: links new entries, removes stale and newly excluded links, retargets wrong ones | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| leaves a real entry a tool created in the shadow alone | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| builds an empty shadow when the real directory does not exist | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
| refuses a shadow inside the real directory, and relative paths | KEEP | Retains the exact named contract through the file seam and independent oracle above; distinct failing input/operation, with no stronger owner of that scenario. |
