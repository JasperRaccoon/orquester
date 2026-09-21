# Generated `codex app-server` protocol bindings

Captured from **`codex-cli 0.154.0`** (`/var/lib/orquester/.npm-global/bin/codex`) on **2026-09-21**.
Everything under `protocol/` is verbatim generator output; `meta.ts` is derived from it by a
script; nothing here is hand-edited. Orquester's equivalent of T3 Code's
`packages/effect-codex-app-server/src/_generated/`.

## Layout

| Path | What |
|---|---|
| `protocol/` | 847 files of `ts-rs`-generated TypeScript, exactly as `codex app-server generate-ts --experimental` wrote them. Root = the v1/legacy surface plus the protocol envelopes (`ClientRequest`, `ClientNotification`, `ServerRequest`, `ServerNotificationEnvelope`); `protocol/v2/` = the current API (`thread/*`, `turn/*`, `item/*`, `account/*`, …); `protocol/serde_json/JsonValue.ts` = the `serde_json::Value` escape hatch. Both directories ship the generator's own `index.ts` barrel. |
| `meta.ts` | The method catalogue: every client→server request, client→server notification, server→client request and server notification, with the params/result **type name** and a typed `…ByMethod` interface per direction. Plus `EXPERIMENTAL_ONLY_*` lists and `CODEX_PROTOCOL_CLI_VERSION`. |
| `regenerate-meta.mjs` | The parser that rebuilds `meta.ts` from `protocol/`. Plain Node, no deps; not part of the TypeScript program (`allowJs: false`). |
| `index.ts` | Barrel. `export type * as CodexProtocol from "./protocol"` + `export * from "./meta"`. |

```ts
import { type CodexProtocol, SERVER_REQUEST_METHODS } from "./_generated";
type StartParams = CodexProtocol.v2.ThreadStartParams;
type Approval = CodexProtocol.v2.CommandExecutionApprovalDecision;
```

The generated files use extensionless relative imports, which is what the daemon already does
(`moduleResolution: "Bundler"`, tsx at runtime). They typecheck under the repo's strict
`tsconfig.base.json` **unmodified** — there is no `@ts-nocheck` anywhere in this directory.

## Regenerating for a newer CLI

```sh
export PATH="/var/lib/orquester/.npm-global/bin:$PATH"
codex --version                                  # record this; it goes in meta.ts + this README

SCRATCH=$(mktemp -d)
codex app-server generate-ts --experimental --out "$SCRATCH/ts-exp"   # what we ship
codex app-server generate-ts               --out "$SCRATCH/ts"        # stable subset, for the diff
# optional, not committed — JSON Schema of the same protocol:
codex app-server generate-json-schema --experimental --out "$SCRATCH/schema"

GEN=apps/daemon/src/agent-host/adapters/codex/_generated
rm -rf "$GEN/protocol" && cp -r "$SCRATCH/ts-exp" "$GEN/protocol"
node "$GEN/regenerate-meta.mjs" "$GEN/protocol" "$SCRATCH/ts" "$GEN/meta.ts" "<new version>"
pnpm --filter @orquester/daemon typecheck
```

`regenerate-meta.mjs` (committed beside the bindings) is the small parser that turns the four generated union types
into `meta.ts`; it prints every method whose result type it could not resolve by the
`<Base>Params → <Base>Response` rule, and carries a six-entry `RESULT_OVERRIDES` table for the
ones that rule cannot reach (`config/mcpServer/reload` → `McpServerRefreshResponse`,
`account/logout` → `LogoutAccountResponse`, `account/workspaceMessages/read` →
`GetWorkspaceMessagesResponse`, `externalAgentConfig/import/readHistories` →
`ExternalAgentConfigImportHistoriesReadResponse`, `config/value/write` and `config/batchWrite` →
`ConfigWriteResponse`). If a regeneration prints new unresolved methods, extend that table rather
than guessing in the adapter.

`generate-json-schema` produces the same protocol as JSON Schema (draft-07), including a bundled
`codex_app_server_protocol.schemas.json` and a v2-only bundle. It is **not** committed — nothing
in Orquester validates Codex frames at runtime (the adapter is a normaliser, not a validator), so
it would be 5.4 MB of dead weight. Regenerate it on demand if you ever need runtime validation.

## Stable vs `--experimental` — why we ship the experimental output

`generate-ts` without `--experimental` emits a *subset*: 58 fewer client-request methods (102 instead of 160), one
fewer server-request method, and — the reason this matters — **fewer fields on types the stable
server actually sends**. The one that bites:

```
# stable generator output, v2/CommandExecutionRequestApprovalParams.ts
proposedNetworkPolicyAmendments?: Array<NetworkPolicyAmendment> | null};
                                                                     ^ ends here
```

but the shipped 0.154.0 server sends, on every command approval (see
`apps/daemon/test/fixtures/codex/02-command-approval-accept.ndjson`):

```json
{"method":"item/commandExecution/requestApproval","id":0,"params":{ … ,
 "proposedExecpolicyAmendment":["ls","-1"],
 "availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["ls","-1"]}},"cancel"]}}
```

`availableDecisions` — the field the UI needs in order to render the provider's own button set
(§4.3) — exists **only** in the `--experimental` output. Likewise `additionalPermissions`. So the
stable output would silently under-describe real traffic. We ship the experimental output and
record the gap in `EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS` /
`EXPERIMENTAL_ONLY_SERVER_REQUEST_METHODS` / `EXPERIMENTAL_ONLY_SERVER_NOTIFICATION_METHODS` so an
adapter can still refuse to *send* an experimental-only method if it wants to. Note that several
experimental-only methods answer perfectly well on the stable binary — `collaborationMode/list` is
in the probe fixture — so the list is advisory, not a capability gate.

Counts: 160 client requests (58 experimental-only), 1 client notification, 11 server requests
(1 experimental-only: `currentTime/read`), 83 server notifications (0 experimental-only).

## Method catalogue vs T3 Code

T3's `meta.gen.ts` header pins upstream protocol ref `678157acaa819d5510adfe359abb5d0392cfe461`.
Diffed against this 0.154.0 catalogue:

**Nothing was removed or renamed.** Every method T3 knows still exists, spelled the same way.
The catalogue only grew.

- **client→server requests: 92 → 160 (+68).**
  `server/diagnostics`, `userVerification/{status,enroll,delete,verify}`,
  `thread/{increment_elicitation,decrement_elicitation}`,
  `thread/queue/{add,list,update,delete,reorder,start}`, `thread/section/move`,
  `thread/settings/update`, `thread/memoryMode/set`, `memory/reset`,
  `thread/backgroundTerminals/{clean,list,terminate}`, **`thread/revert`**,
  `project/{list,read,create,import,update,move,delete}`,
  `threadSection/{list,create,update,delete}`, `thread/{search,searchOccurrences}`,
  **`thread/turns/list`**, **`thread/items/list`**, `plugin/{search,reconcile}`,
  `turn/settings/update`,
  `thread/realtime/{start,appendAudio,appendText,appendSpeech,stop,listVoices}`,
  `thread/timeline/list`,
  `remoteControl/{status/read,pairing/start,pairing/status,client/list,client/revoke}`,
  **`collaborationMode/list`**, `mock/experimentalMethod`,
  `environment/{add,info,status}`, `mcpServer/event/stream/{start,stop}`,
  `account/bedrock/{discover,setup}`, `process/{spawn,writeStdin,kill,resizePty}`,
  `externalAgentConfig/import/recordHistory`,
  `fuzzyFileSearch/session{Start,Update,Stop}`.
  The three in bold matter for §4.5: the spec says `thread/turns/list` is "a raw call not in the
  generated meta" and that rollback is a two-path affair — in 0.154.0 `thread/turns/list`,
  `thread/items/list` and `thread/revert` are all first-class generated methods, and
  `thread/rollback` carries `/** DEPRECATED: `thread/rollback` will be removed soon. */`.
- **server→client requests: 10 → 11 (+1).** `currentTime/read` (experimental-only). All ten T3
  handles are unchanged, including the two legacy ones (`applyPatchApproval`,
  `execCommandApproval`) that T3 answers `-32601`.
- **server notifications: 72 → 83 (+11).** `thread/reverted`, `thread/queue/changed`,
  `project/changed`, `thread/project/updated`, `autoApprovalReview/strictReviewRequired`,
  `mcpServer/event/stream/notification`,
  `modelProvider/{authRecoveryStarted,authRecoveryCompleted}`,
  `thread/realtime/item/{started,transcript/delta,completed}`.
  `thread/reverted` is the one an adapter must handle: it is what `thread/revert` emits.
- **client→server notifications: 1 → 1.** Still only `initialized`.

## Transport, confirmed against the generated schema

`protocol/` has no `jsonrpc` field anywhere — `JSONRPCRequest` is
`{id, method, params?, trace?}` and `JSONRPCResponse` is `{id, result}`. NDJSON, one JSON object
per line, exactly as T3's `packages/effect-codex-app-server/src/protocol.ts` writes it. The
`trace` field (a W3C Trace Context) is new since T3's pin and is optional.
