# CLIProxyAPI patch: omit empty content on kimi/moonshot bare tool-call turns

**Status:** SHIPPED as `0002-kimi-omit-empty-content-with-tool-calls.patch` (built by the
same `buildPatchedBinary` pipeline as 0001).

## Why

Moonshot's API rejects any historical assistant message whose `content` is an empty
string — even when `tool_calls` are present ("content must not be empty"). CLIProxyAPI's
Claude→OpenAI request translator emits exactly that shape (`content: ""`) for a **bare**
tool-call assistant turn (no text). The 2026-07-23 spike showed Claude Code *usually*
pairs preamble text with tool calls, so the branch rarely fires — but whether an
assistant turn has text depends on the model's own output, not the harness, and kimi
itself can emit bare tool calls. One such turn poisons the entire remaining session
history with a permanent 400.

## What

`internal/translator/openai/claude/openai_claude_request.go`: when an assistant turn has
`tool_calls` and no content, and the target model matches `(?i)kimi|moonshot`, the
`content` field is **omitted** (the OpenAI spec treats it as optional alongside
`tool_calls`) instead of being emitted as `""`. All other models keep the existing
empty-string behavior — some OpenAI-compatible providers require the field to exist.
Upstream tests added for both branches.

## History

Originally researched for the claudex design
(`docs/superpowers/specs/2026-07-22-claudex-addon-design.md` §7) and deliberately NOT
shipped — the deciding argument was avoiding the whole Go-toolchain/source-build
apparatus. That apparatus now exists for patch 0001, so this ships as defense-in-depth
at ~zero marginal cost. Re-verify both patches on any `CLIPROXY_SOURCE` version bump.
