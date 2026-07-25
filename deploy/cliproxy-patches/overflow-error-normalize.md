# CLIProxyAPI patch: normalize provider context-overflow errors

**Status:** SHIPPED as `0001-normalize-context-overflow-errors.patch` — the daemon's
installer builds CLIProxyAPI from the pinned source with committed patches applied
(`buildPatchedBinary` in `apps/daemon/src/cliproxy-install.ts`; version reports as
`v7.2.95+orq1`). Requires a Go toolchain at `<appdir>/go/bin/go` (deploy runbook) or on
PATH. Verified end-to-end 2026-07-25: a >1M-token kimi-k3 request through the patched
proxy returns `prompt is too long: 1107646 tokens > 1048576 maximum`. An upstream PR
remains worthwhile so the patch can eventually retire. Companion to the compact-parity
design (docs/superpowers/specs/2026-07-25-compact-parity-design.md §3.4).

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

## Delivery (implemented)

`installBinary` dispatches on committed patches: when `deploy/cliproxy-patches/*.patch`
exist, it downloads the pinned SOURCE tarball (`CLIPROXY_SOURCE`, sha256-verified),
applies each patch with `git apply`, `go build ./cmd/server`, and promotes the result
with the same `bin.prev/` rollback as the stock path. The patch itself lands at the
Claude-protocol error chokepoint (`sdk/api/handlers/claude/code_handlers.go`,
`claudeErrorDetailFromText` → `normalizeClaudeOverflow`): 400/413-class only (429
"too many tokens per minute" rate-limit wordings pass through untouched), scans the
OpenRouter `error.metadata.raw` nested detail, and updates the upstream package tests.

Retirement path: submit the patch upstream; when a release containing it ships, bump
`CLIPROXY_RELEASE`, delete the `.patch`, and the installer reverts to stock automatically.

Proactive thresholds (spec §3.2) remain the primary defense; this restores the
last-resort reactive path.
