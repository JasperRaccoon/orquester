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

- Behind `ANTHROPIC_BASE_URL`, unknown model ids are assumed to have a **200k** window and
  auto-compaction is **reactive-only** (waits for a context-limit error) unless
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set — that env var is the proactive switch.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` overrides the assumed window, applied directly for ids not
  recognized as Claude models (v2.1.193+). For recognized `claude-*` ids it is a no-op unless
  `DISABLE_COMPACT` is set (which we never set). `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100) can
  only lower the trigger; it applies to main conversations and subagents. AUTO_COMPACT_WINDOW is
  clamped to ≥100,000.
- **Spike (proactive fire):** a throwaway PTY session on `gpt-5.6-luna` through the managed
  proxy with `autoCompactEnabled:true`, `MAX_CONTEXT_TOKENS=200000`, `AUTO_COMPACT_WINDOW=100000`,
  `PCT_OVERRIDE=50` showed "N% until auto-compact" in the status line and **fired real
  compactions** — 3 completed cycles, 3 prose summary records in the transcript (no
  tool-call-instead-of-summary failures). The rumored hard-gate behind non-first-party base URLs
  does not reproduce. The session ended in the by-design thrashing guard because the test's
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

  | model | contextWindow | compactWindow | compactPct | trigger ≈ |
  |---|---|---|---|---|
  | gpt-5.6-sol | 200,000 | 200,000 | 75 | 150k |
  | gpt-5.6-terra | 200,000 | 200,000 | 75 | 150k |
  | gpt-5.6-luna | 200,000 | 200,000 | 75 | 150k |
  | kimi-k3 | 1,048,576 | 450,000 | unset (default) | ~435k |

  Rationale: the gpt trigger leaves ~50k headroom below the measured wall (sol accepted 173k,
  rejected by 205k) for the summarization request + output budget. Kimi deliberately compacts
  around ~435k despite the 1M window — summarizing a near-1M transcript is a slow, expensive,
  failure-prone single request; the status line will show the true 1M meter (documented
  decoupling), which is intended: honest capacity display, early compaction.

- **Overrides:** `cliProxyState` gains an optional `modelOverrides` record
  (`{ [modelId]: { contextWindow?, compactWindow?, compactPct? } }`), zod-defaulted (additive —
  old state files parse; remember `parseCliProxyState` falls back wholesale on schema miss).
  `setConfig` accepts it with `needsRestart=false` (no `config.yaml` projection is touched, so
  no 409-while-sessions-live gate). Model Proxy settings UI gets a compact "Context windows"
  section listing curated models with editable window/threshold values.

- **Launch-time emission:** `cliproxyContributor` (which already receives the per-launch model)
  emits, keyed on the **bare** model id (routing prefix `acc<hex>/` stripped first):
  - nothing when the bare id starts with `claude` — claudemix and Claude-family launches keep
    fully native behavior;
  - otherwise `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<contextWindow>`,
    `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<compactWindow ?? contextWindow>`, and
    `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<compactPct>` when set — resolved as
    override → curated default → (uncurated id) no emission.
  - When no model rides the launch (claudex default-model launch), resolve against the
    configured `defaultModel` the same way.

### 3.3 Accepted limitations (explicit)

- **Mid-session `/model` switches keep launch-time numbers** (env is frozen per PTY). Within the
  gpt trio this is harmless (shared window family). A kimi↔gpt switch mis-declares the window;
  the UI/docs note "switch window families → open a fresh tab". (User-approved trade-off; the
  `[1m]`-suffix per-model alternative was considered and rejected for now — extra moving parts,
  unverified proxy passthrough.)
- **Prefixed Claude ids** (`accXX/claude-*`, only with ≥2 seeded Claude accounts) are not
  recognized by Claude Code as Claude models and get the 200k assumption; we deliberately skip
  emitting overrides for them (safe-conservative). Known cosmetic gap, revisit if multi-Claude
  accounts become common.
- **Thrashing guard:** a single tool output larger than the (window − trigger) slack can still
  wedge a session by design (3 strikes); with the production numbers this needs a ~50k+ single
  artifact on gpt. Not mitigated further.
- **Compaction cost/effort:** compaction inherits the session's effort (max on claudex). A
  proxy-side effort-cap on compaction requests (detectable by the summarization marker string)
  is a **future** optimization, not in scope. Same for CLIProxyAPI-native Codex compaction and
  `count_tokens` work (already implemented proxy-side).

## 4. Testing

- Unit (contributor): per-model emission — sol/terra/luna values; kimi values; prefix-stripped
  resolution (`acc…/gpt-5.6-sol` → sol numbers); `claude-*` and `acc…/claude-*` emit nothing;
  override precedence (state override beats curated default); uncurated id emits nothing;
  default-model launch resolves like an explicit pick.
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
