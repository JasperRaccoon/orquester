# CLIProxyAPI patch: normalize provider context-overflow errors

**Status:** authored, delivery via upstream PR (see below). Companion to the
compact-parity design (docs/superpowers/specs/2026-07-25-compact-parity-design.md §3.4).

## Why

Claude Code's reactive compact-and-retry only recognizes context overflow when the
error message contains (case-insensitive) "prompt is too long" or "input is too long
for requested model". Upstreams behind CLIProxyAPI say other things:

| upstream | observed overflow message |
|---|---|
| ChatGPT-Codex OAuth (gpt-5.6-*) | `Your input exceeds the context window of this model. Please adjust your input and try again.` |
| OpenRouter (kimi-k3) | `Provider returned error` (envelope), upstream detail `…exceeded model token limit: <n>` |
| Moonshot direct | `Invalid request: Your request exceeded model token limit: <limit> (requested: <n>)` |

None match, so a session that outruns proactive compaction dies unrecoverably.

## What

At CLIProxyAPI's per-executor error-translation layer (where upstream errors become
Anthropic-format `{"type":"error","error":{...}}` bodies), detect overflow by matching
the upstream message against:

    (?i)(exceeds the context window|exceeded model token limit|context_length_exceeded|maximum context length)

and rewrite `error.message` to Anthropic's literal shape, preserving numbers when the
upstream supplies them, else omitting them:

    prompt is too long: <n> tokens > <limit> maximum
    prompt is too long

Status code stays as upstream mapped it (400-class). Only `error.message` changes.

## Delivery

Stock-binary invariant holds (install pipeline pins version + sha256), so:
1. Fork `router-for-me/CLIProxyAPI`, implement against the pinned tag, with unit tests
   per executor (codex, openai-compat) covering the three signatures above.
2. Submit upstream PR referencing Claude Code's reactive-recovery matching.
3. When a release containing the fix ships, bump `CLIPROXY_RELEASE` (version + sha256)
   in `apps/daemon/src/cliproxy-install.ts` — the normal upgrade path.

Until merged, proactive thresholds (spec §3.2) are the primary and sufficient defense;
this patch only restores the last-resort path.
