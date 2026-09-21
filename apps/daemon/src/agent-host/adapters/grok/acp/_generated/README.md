# Generated ACP catalog

Plain-TypeScript data for the Agent Client Protocol, for the Grok adapter's ACP client to import.
No Effect, no runtime dependency, no validation library — types plus `as const` tables.

## Files

| File | Contents | Produced by |
|---|---|---|
| `meta.ts` | `AGENT_METHODS`, `CLIENT_METHODS`, `PROTOCOL_METHODS`, `ACP_PROTOCOL_VERSION`, `ACP_SCHEMA_RELEASE` | `meta.unstable.json`, verbatim |
| `schema.ts` | 171 type aliases, one per `$defs` entry, alphabetical | `schema.unstable.json`, mechanically |
| `methods.ts` | `ACP_METHOD_CATALOG` (method → side / request-or-notification / params + result type names), `AcpMethodParams`, `AcpMethodResult`, `CLIENT_HANDLED_METHODS`, `AGENT_CALLABLE_METHODS` | both, joined on the schema's `x-method` / `x-side` annotations |
| `xai.ts` | The `x.ai/*` extension surface: method names in both spellings, a catalog with an `observed` flag per entry, and the payload types | **hand-written** from the captures + T3 Code |
| `index.ts` | Barrel |

## Source and ref

```
https://github.com/agentclientprotocol/agent-client-protocol/releases/download/v0.11.3/schema.unstable.json
https://github.com/agentclientprotocol/agent-client-protocol/releases/download/v0.11.3/meta.unstable.json
```

`v0.11.3` is the exact release T3 Code pins — `packages/effect-acp/scripts/generate.ts:16`
(`const CURRENT_SCHEMA_RELEASE = "v0.11.3"`) — so this catalog and T3's
`packages/effect-acp/src/_generated/` describe the same protocol. `AGENT_METHODS`,
`CLIENT_METHODS` and `PROTOCOL_VERSION` here are byte-identical to T3's `meta.gen.ts`, except that
T3's generator drops the `protocolMethods` table (`$/cancel_request`), which is kept here.

The Grok CLI this was validated against (1.0.34) negotiates `protocolVersion: 1`, matching
`ACP_PROTOCOL_VERSION`.

## How to regenerate

The generator is scratch tooling, not part of the repo — the committed output is the artifact.

1. Download the two assets for the target release into a working directory.
2. Walk `$defs` and emit one `export type` per entry:
   - `$ref: "#/$defs/X"` → `X`
   - `const` → a string/number literal; `enum` → a union of literals
   - `oneOf` / `anyOf` → a union; `allOf` → an intersection (a discriminated `oneOf` member is
     `Base & { tag: "literal" }`)
   - `type: ["integer","null"]` → `number | null`
   - `type: "array"` → `ReadonlyArray<T>`; `additionalProperties: true` → an index signature
   - every property `readonly`, and optional unless listed in `required`
   - the first sentence of `description` becomes a JSDoc line
3. `Error` is emitted as **`AcpError`** so it cannot shadow the global `Error` type. It is the only
   rename.
4. Build `methods.ts` by grouping `$defs` on `x-method` + `x-side`: the entry whose name ends in
   `Response` is the result type, the other is the params type. A method with no `Response` type is
   a notification.
5. Bump `RELEASE` in the header comments and re-run `pnpm --filter @orquester/daemon typecheck`.

`xai.ts` is **not** regenerable — xAI publishes no schema. Re-derive it from a fresh capture and
keep the `observed` / `observedSpelling` / `observedWrapped` flags honest: `observed: false` means
"T3 registers it, we have never seen it", and nothing should depend on such an entry.

## Using it

`ACP_METHOD_CATALOG` is what makes the §9 structural assertion possible — "every method present in
a capture must map to a defined disposition". Iterate a fixture, look each `method` up, and fail on
a miss rather than letting a catch-all swallow it. `x.ai/*` methods resolve through
`XAI_EXTENSION_CATALOG` instead; anything in neither table must take the documented fallback
(surface it plus a `runtime.warning`), never silent loss.

Read `../../../../../../test/fixtures/grok/README.md` ("Protocol observations") before writing the
client. Several of the shapes here are advertised by the protocol but never used by Grok, and
several things Grok does are not in the protocol at all.
