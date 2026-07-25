# Auto-compact parity for claudex/claudemix (gpt/kimi main models)

**Date:** 2026-07-25 · **Status:** approved design, pre-plan
**Goal:** a claudex session on gpt-5.6-* or kimi-k3 (and claudemix on Claude) compacts with the
same UX as native Claude Code on Anthropic models: proactive auto-compaction at a sane
threshold, correct context-window assumptions, no "Prompt is too long" deaths.

## 1. Corrected premise — no compact-model routing exists or is needed

Compaction always runs on the **session's main model**: the summarization request reuses the
conversation's cached prefix (same system prompt, tools, history) and there is no knob to pin a
different compaction model. GPT sessions compact with GPT, kimi with kimi, Claude with Claude —
automatically. `ANTHROPIC_DEFAULT_HAIKU_MODEL` (our background model) has **zero** effect on
compaction. This spec therefore builds no per-family compact-model machinery, and the claudex
design spec's contrary claim (`2026-07-22-claudex-addon-design.md`, compaction/§8 cost notes)
must be corrected in the same change.

## 2. Research + spike findings this design rests on

Verified against Claude Code v2.1.219 docs and empirically on vps-a (2026-07-25):

- Behind `ANTHROPIC_BASE_URL`, unknown model ids are assumed to have a **200k** window — and
  **since v2.1.161 proactive auto-compaction is gated OFF entirely on non-first-party base URLs**
  (claude-code issues #65585/#64802; binary-confirmed `firstParty` check). Setting
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is the documented workaround and re-arms proactive
  compaction — it is therefore **mandatory arming for every launcher behind our proxy,
  including claudemix's Claude models**, not a tuning knob.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` overrides the assumed window, applied directly for ids not
  recognized as Claude models (v2.1.193+; binary shows an ungated read for non-`claude-*` ids).
  For recognized `claude-*` ids it is a no-op unless `DISABLE_COMPACT` is set (which we never
  set). `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100) can only lower the trigger; it applies to main
  conversations and subagents. AUTO_COMPACT_WINDOW is clamped to ≥100,000.
- **Verified compaction internals (binary analysis, v2.1.210 + v2.1.220 concordant):** default
  trigger = `compactWindow − 33,000` (a 20,000-token summary reserve + 13,000 margin; a user's
  "Autocompact buffer: 33k (16.5%)" dump matches to the token). The compact request itself sends
  the full transcript and asks `max_tokens=32,000` while only 20,000 is reserved — a
  **12k-token regression** (older builds passed a matching 20k override; raw error
  `198667 + 20000 > 200000` on record in #8136). Net: at the default trigger the compact
  request's own margin is ~1k, so **any token-count drift makes the compaction request itself
  overflow the provider and fail** — this is the reported "kimi compaction fails because context
  is already full" failure mode. Kimi drifts worst: Claude Code's between-turn estimates use a
  Claude-style tokenizer while kimi counts heavier (3.7× measured on synthetic text), so real
  context leads believed context.
- **Failed compactions are silent:** notifications hidden since v2.1.41 (partially restored for
  manual `/compact` in v2.1.216); a 3-strike circuit breaker then stops retrying with only a
  debug log. Combined with the reactive-wording mismatch below, a wedged session gives no
  visible warning. Large absolute margins are therefore the only robust defense.
- **Spike (proactive fire):** a throwaway PTY session on `gpt-5.6-luna` through the managed
  proxy with `autoCompactEnabled:true`, `MAX_CONTEXT_TOKENS=200000`, `AUTO_COMPACT_WINDOW=100000`,
  `PCT_OVERRIDE=50` showed "N% until auto-compact" in the status line and **fired real
  compactions** — 3 completed cycles, 3 prose summary records in the transcript (no
  tool-call-instead-of-summary failures). This is consistent with the #65585 gate: the spike had
  `AUTO_COMPACT_WINDOW` set, which re-arms proactive compaction behind a third-party base URL.
  The session ended in the by-design thrashing guard because the test's
  single 100k tool output can never fit the 100k test window post-compact — not a stack failure.
- **Ceilings (measured through our proxy):**
  - `gpt-5.6-sol` via Codex OAuth: accepted 173k, subagent died past that; `gpt-5.6-terra` and
    `gpt-5.6-luna` both rejected ~205k with "Your input exceeds the context window of this
    model." → the whole GPT trio is **200k-class** on this backend (the API's advertised 1M and
    other proxies' 372k do not apply here).
  - `kimi-k3` via OpenRouter: accepted a **923,231-token** request; rejected >1.05M → the route
    serves the full **1,048,576** window. (Earlier smaller-looking probes were tokenizer
    artifacts; kimi's usage numbers are real-tokenizer counts.)
- **Usage meter:** the compaction trigger reads the `usage` block of inference responses. Through
  CLIProxyAPI, gpt sessions report plausible, monotonically-growing totals (21k → 43k → 101k in
  the spike) and kimi reports real counts. No proxy work needed.
- **Reactive backstop is unreliable on non-Claude routes:** the Codex path's overflow error is
  "Your input exceeds the context window…", the OpenRouter path's is "Provider returned error" —
  neither matches Anthropic's "Prompt is too long" that reactive recovery keys on. (Claude
  Code's own client-side length check still applies at its *believed* window, which is why
  correct `MAX_CONTEXT_TOKENS` matters doubly.) Proactive thresholds carry the weight.

## 3. Design

### 3.1 Turn auto-compact on (boolean, per home + system)

- **Ops (vps-a):** set `autoCompactEnabled: true` in the system `~/.claude/settings.json`
  (normal Claude sessions; user approved "everywhere"). vps-b has no cliproxy and no key set
  (default = enabled) — nothing to do.
- **Proxy homes:** `seedHome` currently `copyIfMissing`s `settings.json` once, which froze
  `autoCompactEnabled:false` into both homes. Replace with **seed-once + managed-key merge**:
  every `seedHomes()` run (enable + every boot via `bootAdopt`) force-merges a small managed-key
  set — initially `{ autoCompactEnabled: true }` — into the home's `settings.json`, preserving
  all other keys (user edits, theme, hooks). This self-heals existing homes on the next deploy
  restart, and gives future seed-shape changes a propagation path (same latent bug class as the
  frozen `"model": "opus"`). Managed keys deliberately clobber in-home edits of those same keys;
  everything else is untouched. Never write `/etc/claude-code/managed-settings.json` (host-global
  — would leak into the user's plain sessions).

### 3.2 Per-model windows/thresholds (numeric, per launch)

- **Metadata:** `CURATED_PROXY_MODELS` in `@orquester/config` becomes a record list:
  `{ id, contextWindow, compactWindow?, compactPct? }`, with a derived plain-id array for the two
  existing UI call sites. Defaults from the measured numbers:

  | model | contextWindow | compactWindow | compactPct | trigger |
  |---|---|---|---|---|
  | gpt-5.6-sol | 200,000 | 200,000 | 75 | 150k |
  | gpt-5.6-terra | 200,000 | 200,000 | 75 | 150k |
  | gpt-5.6-luna | 200,000 | 200,000 | 75 | 150k |
  | kimi-k3 | 1,048,576 | 450,000 | unset (default) | 417k (450k − 33k) |
  | any `claude-*` (claudemix) | — (native) | 1,048,576 (arming; clamped) | unset (default) | native per believed window |

  Rationale: the gpt trigger (75% of the compact window) leaves ~50k headroom below the measured
  wall (sol accepted 173k, rejected by 205k) — comfortably covering the compact request's own
  32k `max_tokens` plus tokenizer drift, which is exactly the margin the default 33k buffer
  lacks (the community kimi failure). Kimi compacts at 417k of its real 1M — the ~600k slack
  absorbs the worst-case drift and the 12k reserve regression outright, and keeps the
  summarization request itself far from any wall; the status line shows the true 1M meter
  (documented decoupling — honest capacity, early compaction, intended). Claude models get
  `compactWindow=1,048,576` purely as the **#65585 arming value**: Claude Code clamps
  `AUTO_COMPACT_WINDOW` to the model's believed window, so a 200k Claude model compacts at its
  native 167k, an extended/1M model at its native threshold — the emitted number's only job is
  to defeat the third-party-base-URL gate, never to shrink a window. This matters concretely:
  the seeded OAuth route was probed accepting a **456,557-token** `claude-fable-5` request
  (2026-07-25), so hard-coding 200k would have compacted fable sessions ~5× too early — and
  1M is now simply the *default* window for current opus-class models (Opus 5, launched
  2026-07-24 with a native 1M window, is the new Claude Code opus default), so any hard-coded
  claude window would rot with every model launch. If a
  Claude model's believed window ever exceeds what the route actually serves, reactive recovery
  still catches it — Anthropic's own "prompt is too long" wording passes through on the Claude
  path.

- **Overrides:** `cliProxyState` gains an optional `modelOverrides` record
  (`{ [modelId]: { contextWindow?, compactWindow?, compactPct? } }`), zod-defaulted (additive —
  old state files parse; remember `parseCliProxyState` falls back wholesale on schema miss).
  `setConfig` accepts it with `needsRestart=false` (no `config.yaml` projection is touched, so
  no 409-while-sessions-live gate). Model Proxy settings UI gets a compact "Context windows"
  section listing curated models with editable window/threshold values.

- **Launch-time emission:** `cliproxyContributor` (which already receives the per-launch model)
  emits, keyed on the **bare** model id (routing prefix `acc<hex>/` stripped first):
  - when the bare id starts with `claude` (claudemix, Claude-family launches):
    `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1048576` **only** — the #65585 arming value that restores
    native proactive behavior behind a third-party base URL. No `MAX_CONTEXT_TOKENS` (no-op /
    gated for recognized Claude ids), no `PCT_OVERRIDE` (native 33k-buffer formula applies).
  - otherwise `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<contextWindow>`,
    `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<compactWindow ?? contextWindow>`, and
    `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<compactPct>` when set — resolved as
    override → curated default → (uncurated non-claude id) no emission (safe: it stays
    reactive-only, same as today).
  - When no model rides the launch (claudex default-model launch), resolve against the
    configured `defaultModel` the same way. claudemix launches with no model resolve as
    `claude-*` (arming value only).

### 3.3 Accepted limitations (explicit)

- **Mid-session `/model` switches keep launch-time numbers** (env is frozen per PTY). Within the
  gpt trio this is harmless (shared window family). A kimi↔gpt switch mis-declares the window;
  the UI/docs note "switch window families → open a fresh tab". (User-approved trade-off; the
  `[1m]`-suffix per-model alternative was considered and rejected for now — extra moving parts,
  unverified proxy passthrough.)
- **Prefixed Claude ids** (`accXX/claude-*`, only with ≥2 seeded Claude accounts) are not
  recognized by Claude Code as Claude models and get the 200k assumption. The bare-id rule
  treats them as Claude (prefix stripped first), so they receive the same 200k arming value —
  which matches the assumption Claude Code applies to them anyway. Consistent, no special case.
- **Thrashing guard:** a single tool output larger than the (window − trigger) slack can still
  wedge a session by design (3 strikes); with the production numbers this needs a ~50k+ single
  artifact on gpt. Not mitigated further.
- **Compaction failures stay silent** (Claude Code hides them; 3-strike breaker with debug-only
  logging). Our margins make failures unlikely, but Orquester does not add its own detection in
  this iteration. A future improvement: watch session transcripts for climbing `preTokens`
  without `compactMetadata.trigger:"auto"` records and surface a session warning.
- **Compaction cost/effort:** compaction inherits the session's effort (max on claudex). A
  proxy-side effort-cap on compaction requests (detectable by the summarization marker string)
  is a **future** optimization, not in scope. Same for CLIProxyAPI-native Codex compaction and
  `count_tokens` work (already implemented proxy-side).

### 3.4 Proxy patch: normalize provider overflow errors (in scope, final phase)

The highest-leverage backstop fix (binary-confirmed): CLIProxyAPI rewrites provider
context-overflow errors to Anthropic's literal phrasing
`prompt is too long: <n> tokens > <max> maximum` so Claude Code's reactive compact-and-retry
recognizes them on gpt/kimi routes (it string-matches case-insensitively on "prompt is too
long" / "input is too long for requested model"; the Codex path's "Your input exceeds the
context window…" and OpenRouter's "Provider returned error" both miss). Mechanism follows the
established `deploy/cliproxy-patches/` precedent (the documented Kimi translator patch):
a small, documented patch against the pinned CLIProxyAPI version, mapping the known overflow
signatures per upstream (Codex, OpenRouter) at the error-translation layer. The implementation
plan decides the delivery route — reviving the shelved source-build apparatus for a patched
binary vs. an upstream PR with a version bump — with the patch file itself committed either
way. This restores the reactive safety net end-to-end: proactive thresholds remain the primary
defense; the rewrite makes the last-resort path work instead of wedging.

## 4. Testing

- Unit (contributor): per-model emission — sol/terra/luna values; kimi values; prefix-stripped
  resolution (`acc…/gpt-5.6-sol` → sol numbers); `claude-*` and `acc…/claude-*` emit the 200k
  arming value only (no MAX_CONTEXT_TOKENS, no PCT); override precedence (state override beats
  curated default); uncurated non-claude id emits nothing; default-model launch resolves like an
  explicit pick; claudemix modelless launch gets the arming value.
- Unit (settings merge): managed keys forced on existing file; other keys preserved; malformed
  file handled; file created when absent; idempotent (no write churn when converged).
- Unit (state): `modelOverrides` roundtrip + absent-field default; `setConfig` accepts overrides
  without restart gating.
- Manual (post-deploy): fresh claudex tab on sol → status line shows "N% until auto-compact";
  drive past ~150k → compaction completes and session continues; kimi tab shows 1M-based meter.

## 5. Rollout

1. Land code; deploy. `bootAdopt`'s `seedHomes` + projection rewrite self-heals both homes
   (`autoCompactEnabled:true` merged, env files regenerated) on the restart.
2. Flip vps-a system `~/.claude/settings.json` `autoCompactEnabled` to `true` (ops step, not
   code). vps-b: nothing.
3. Correct the compaction claim in `2026-07-22-claudex-addon-design.md`.
4. Existing sessions keep old env — relaunch tabs to pick up compaction behavior.
