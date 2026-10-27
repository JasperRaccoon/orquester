# Incoming MCP schema compatibility regression

Reference: `e866b62bd0d197200683dcdd61e38d1302235b4e`, after `ee5c3249`.

The incoming commit adds **one file, 52 test LOC and two declarations**. Both assertions protect a concrete supported-client compatibility failure: shared Zod nodes become JSON-schema `$ref` values, and a client that does not follow them loses array/object type guidance. The commit records rejected or mistyped `knowledge_search.unlike`, `knowledge_get.ids`, `knowledge_merge.keep`, `wait_for_session.sessionIds`, device drag destinations and profile edit arguments. This is a wire compatibility contract, not a requirement to use schema factories.

Disposition: **CONSOLIDATE both incoming registrations into the existing registry owner**. The [JSON ledger](incoming-schema-refs.json) identifies each original name/line, all six behavioral criteria, failure and independent oracle, exact surviving owner, production review and validation target. The existing owner is re-audited rather than added to declaration totals.

| Incoming registration | Outcome | Surviving protection |
| --- | --- | --- |
| `schema-refs.test.ts:27` — no chat tool's input schema holds a `$ref` | CONSOLIDATE | Recursive reference rejection in the existing registry loop over `serializeChatTools(catalogFor("chat"))` output. |
| `schema-refs.test.ts:34` — no external tool's input schema holds a `$ref` | CONSOLIDATE | Same property in the existing loop over the actual `registerMcp` HTTP `tools/list` response. |
| `registry.test.ts:83` — tools/list and instructions preserve audience names, MCP annotations and context byte budgets | CONSOLIDATE, surviving existing owner | Both transferred properties plus its existing audience/name/annotation/context contracts, using its already-paid catalog reads. |

The incoming external test reconstructs `McpServer.registerTool` from `audienceShape`/`audienceSchema`; the existing registry owner enters the actual daemon `registerMcp` implementation through Fastify and HTTP JSON-RPC. Reusing that owner both removes duplicate setup and observes the stronger delivered boundary. Chat and external results must both remain checked because audience projection and chat compaction can fail independently.

The transferred expectation must remain an independent recursive assertion over schema keys, including nested object and array schemas. It must not assert Zod object identities, factory counts, source syntax or collaborator registration shape. Renaming schema helpers or replacing Zod with an equivalent producer must leave a conforming wire schema passing.

Implemented: moved the recursive key walker into `registry.test.ts`, asserted no `$ref` keys for every row in its current audience loop, deleted the incoming file, and updated production comments in the four changed schema owners to point at `catalog/registry.test.ts`. The surviving test name is unchanged and now starts at line 92. This adds 10 LOC to the existing test owner; relative to the incoming reference it removes one file, two declarations and 42 test LOC. No dependency, export, timeout or runner change is needed. The four production deltas construct fresh equivalent schema nodes; validation constraints and handlers stay unchanged.

Validation is root-coordinated after integration: run the focused registry test, reinstate a credible shared-schema regression and observe a `$ref` offender failure, restore the source and pass, then run required changed/full gates. This reviewer implemented only the released test/comment consolidation, ran no tests and staged no files. No speedup is measured or claimed; avoiding repeated catalog setup is a structural cost reduction. Final root validation records supersede this phase-local pending state.

Root validation passed 71/71 focused cases, the five-file changed gate and the full workspace typecheck. Reusing the knowledge example-array schema failed with `chat knowledge_search: unsupported schema references` and `#/properties/similarTo`; reusing the wait scalar/array schema failed at the external tools-list assertion. Both restored controls passed and source SHA-256 values match. Exact commands/results are appended in the JSON ledger. Final production build/full-suite results are recorded centrally.

Final root production build and full `pnpm test` also passed (518.834 s; 11,410 Node pass / 32 existing skip / zero fail, plus Go/standalone checks). Frozen source hashes were unchanged throughout. These completed results supersede the phase-local pending notes above.
