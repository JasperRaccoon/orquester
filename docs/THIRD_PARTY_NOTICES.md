# Third-party notices

Orquester bundles no third-party source at build time beyond its npm
dependencies, each of which carries its own licence in `node_modules`. This
file records source that was **ported into this repository** and therefore
travels with it.

---

## T3 Code — MIT

The agent chat GUI (`docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md`)
is modelled on [T3 Code](https://github.com/pingdotgg/t3code), pinned at commit
`adcd908` during design and implementation. Its adapter boundary, its normalised
runtime-event union, its orchestration event vocabulary and several pure
reducers were ported into this codebase and reimplemented in its idiom (plain
TypeScript, no Effect). Field, event and status names are T3's wherever T3 has
one.

Ported or closely derived, each carrying a `// Ported from T3 Code (MIT): <path>`
header where the port is substantial:

- `packages/api/src/agent-chat/**` — the runtime event union
  (`packages/contracts/src/providerRuntime.ts`), the adapter and provider-snapshot
  contracts (`packages/contracts/src/{provider,model,server,providerUsageLimits}.ts`),
  the domain event vocabulary and thread projection
  (`packages/contracts/src/orchestration.ts`), the pending-request reducer
  (`packages/client-runtime/src/pendingRequests.ts`) and the subagent roster fold
  (`packages/client-runtime/src/state/subagentRuntime.ts`).
- `apps/daemon/src/agent-host/**` — the adapter interface
  (`apps/server/src/provider/Services/ProviderAdapter.ts`), the stderr capture,
  classification and redaction (`apps/server/src/provider/acp/AcpStderr.ts`,
  `apps/server/src/provider/Layers/CodexSessionRuntime.ts`), and the adapter,
  ingestion, checkpoint and liveness service shapes.
- `packages/ui/src/{lib,components}/agent-chat/**` — the timeline row model and
  the normalised work-log record
  (`apps/web/src/components/chat/MessagesTimeline.logic.ts`,
  `apps/web/src/session-logic.ts`), and the design language of the chat
  surfaces.

T3 Code is distributed under the MIT licence, reproduced in full below.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
