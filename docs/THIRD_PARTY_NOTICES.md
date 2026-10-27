# Third-party notices

Orquester bundles no third-party source at build time beyond its npm
dependencies, each of which carries its own licence in `node_modules`. This
file records source that was **ported into this repository** and therefore
travels with it, and npm dependencies bundled into the web client whose licences
carry an obligation worth stating.

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

A later round, ported from T3 Code at commit `ed9b7ca9`, marks each port with an
`// Adapted from T3 Code (MIT): <path>` comment. It covers the terminal output
protocol, link patterns and replay guard; the change-kind classifier; idle
compaction; the handoff budget; Claude plugin skill discovery; Codex usage-limit
detection; connection diagnosis and reconnect supervision; the Tailscale serve
helper; desktop notifications, application menu and window state; composer
prompt recall, image fitting and pending-request sends; the workflow prompt
framing; and the chat math renderer.

The chat math parser (`packages/ui/src/components/agent-chat/timeline/markdown/math*.ts`)
also adapts [micromark-extension-llm-math](https://github.com/ofk/micromark-extension-llm-math)
3.1.0 as patched by T3 Code. Like the `micromark-extension-math` it forks
(© Titus Wormer), it is MIT licensed under the same terms reproduced below.

The 3D device frame viewer (`packages/ui/src/components/device/three/**`) ports
T3 Code's device viewer from `packages/client-runtime/src/device/` (phone, Duo and
Android-fold scenes, GLB model loading, motion, framing, snapping, interaction,
render scheduling and their tests) and `apps/web/src/components/device/` (the
viewport components, viewer mounting, trackpad gestures, Duo and fold controls),
together with `scripts/convert-device-model.py`. Each ported file carries an
`// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): <path>` header.
The device models under `packages/ui/src/components/device/models/` are
conversions of Apple Inc.'s published AR assets and of Samsung Electronics Co.,
Ltd.'s published product-viewer models (Galaxy S26, S26+, S26 Ultra, Z Fold8 and
Z Flip8). They are not covered by this licence, no open-source or redistribution
licence has been established for either author's assets, and `sources.json`
beside them records each author, source URL, checksum and conversion.

The device stream client (`packages/ui/src/components/device/stream/**`) adapts
T3 Code's `packages/client-runtime/src/device/stream.ts`, `avcConfig.ts` (with
its tests) and `frame.ts`: the avcc envelope demuxer, the SPS reorder-metadata
repair, SEMU packet and Annex-B parsing, the decoder handling, serve-sim and
serve-emu input encoding, the HID and Android key tables and text chunking.
Each adapted file carries the same `// Adapted from T3 Code (MIT, Copyright 2026
T3 Tools Inc.): <path>` header.

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

---

## pele 1.9.0 — MIT

Chat Mermaid diagrams (`packages/ui/src/components/agent-chat/timeline/markdown/MermaidBlock.tsx`)
are drawn by [pele](https://github.com/obsidianmd/pele) (Copyright (c) 2026
kepano, MIT), installed from npm as `pele@1.9.0` (pinned exactly) and bundled
**unmodified** into the web and desktop clients by `packages/ui`, one lazily
loaded chunk per diagram type. Pele has no runtime dependencies. The specs and
grammar files it derives from Mermaid are MIT licensed as well. Its licence text
ships in the package (`node_modules/pele/LICENSE`); a redistribution must keep
that notice.

---

## noVNC 1.7.0 — MPL-2.0

The Desktop tab (`docs/superpowers/specs/2026-09-30-desktop-tab-design.md`)
renders the remote display with [noVNC](https://github.com/novnc/noVNC)'s RFB
client, installed from npm as `@novnc/novnc@1.7.0` and bundled **unmodified**
into the web and desktop clients by `packages/ui`. noVNC is Copyright (C) The
noVNC authors; its core library is licensed under the Mozilla Public License
2.0, whose full text and per-file notices ship in the package
(`node_modules/@novnc/novnc/LICENSE.txt`, `AUTHORS`) and at
<https://www.mozilla.org/MPL/2.0/>.

MPL-2.0 is a file-level copyleft: it reaches only noVNC's own files, not the
Orquester code that imports them. Anyone distributing Orquester must keep
noVNC's source available under MPL-2.0 (the unmodified npm package, or
<https://github.com/novnc/noVNC/tree/v1.7.0>), and **any modification to a noVNC
file must be published under MPL-2.0**.

---

## opus-decoder 0.7.12 — MIT (includes libopus, BSD-3-Clause)

The Desktop tab's audio falls back to [`opus-decoder`](https://github.com/eshaz/wasm-audio-decoders)
(Copyright (c) Ethan Halsall, MIT), installed from npm as `opus-decoder@0.7.12`
and bundled by `packages/ui`, on browsers without WebCodecs Opus. Its inlined
WebAssembly is built from [libopus](https://opus-codec.org/) (Copyright (c)
Xiph.Org Foundation, Skype Limited, Octasic, Jean-Marc Valin, Timothy B.
Terriberry, CSIRO, Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo and
others), licensed under the BSD-3-Clause licence
(<https://opus-codec.org/license/>). Its own dependencies are MIT
(`@wasm-audio-decoders/common`, `simple-yenc`) and Apache-2.0
(`@eshaz/web-worker`). Each licence text ships in the package or at the linked
page; a redistribution must keep those notices.

---

## Desktop host packages — not distributed

Desktop tabs run TigerVNC (`Xvnc`), Openbox and PulseAudio (GPL) and ffmpeg
(LGPL/GPL, depending on the build) on the daemon's host. They are installed from
the operating system's distribution (`deploy/lib/remote-provision.sh`) and run as
separate processes that the daemon talks to over sockets and pipes. Orquester
neither ships nor links them, so their licences place no obligation on
Orquester's code.
