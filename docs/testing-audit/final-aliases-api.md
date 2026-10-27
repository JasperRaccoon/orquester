# Final API test-title aliases

Final-title aliases for two previously audited API rewrites. Traceability only: no new tests, audit decisions or baseline counts.

Do not add these two entries to baseline/disposition totals; both already exist as REWRITE in api.json under originalOwner.

## unrelated data stays intact, and the input is not mutated

REWRITE — `packages/api/src/agent-chat/secret-requests.test.ts:92`.

Source ledger: `docs/testing-audit/api.json`. Original owner: `packages/api/src/agent-chat/secret-requests.test.ts:92` — `nothing else changes, and an untouched value is the same reference` at `beb7516b10a3c4472399e0f6f2f2b0a187a61186`.

1. **Independent contract:** Agent visuals/session-tools design §5 Secrets and host ingestion redaction contract: remove only the structurally marked request-secret value; preserve unrelated tool data, request metadata and caller-owned input. AGENTS.md privacy rule does not authorize corrupting ordinary value fields.
2. **Recognizable regression:** A broad value-key scrubber erases an ordinary form value, recursive redaction rewrites unrelated nested command output, already-redacted request JSON is altered, or in-place deletion destroys the original result before its one intended recipient reads it.
3. **Independent oracle:** Literal command/output/nested JSON and ordinary {name:x,value:kept} results; unchanged already-redacted input text; the original input still contains the independently supplied secret sentinel after the call. No expected redaction result is computed by the production redactor.
4. **Stable seam:** Exported stripSecretRequestValues(input) over the provider-result data boundary, used by real agent-host secret-redaction.ts before logs/events are written.
5. **Refactor resistance:** Deep value equality permits cloning, allocation changes, recursion changes and helper renames. The test no longer asserts an untouched object must retain its reference.
6. **Unique protection:** The other secret tests prove secret removal from provider/string/deep/cut layouts and prose preservation. They do not prove ordinary value fields survive or that redaction leaves the original caller-owned secret-bearing object intact. This is the lowest shared redactor owner for those distinct collateral-data failures.

## a string blob is cut at the cap; arguments and small values stay intact

REWRITE — `packages/api/src/agent-chat/session-tools.test.ts:276`.

Source ledger: `docs/testing-audit/api.json`. Original owner: `packages/api/src/agent-chat/session-tools.test.ts:303` — `a string blob is cut at the cap; arguments, small values and untouched data keep their identity` at `beb7516b10a3c4472399e0f6f2f2b0a187a61186`.

1. **Independent contract:** Agent visuals/session-tools design §§1.1/1.5 and apps/daemon/src/agent-host/README.md ingestion contract: durable session-tool results are bounded with omission information, Unicode remains intact, call arguments stay as supplied, and small results remain complete.
2. **Recognizable regression:** An unbounded ordinary result is persisted, truncation splits a multibyte character or loses its omission marker, arguments are incorrectly truncated with output, or small result records lose fields/content.
3. **Independent oracle:** Literal full argument object and complete small-result record; independently recognizable omitted-byte marker; the Unicode result contains only whole é characters before that marker. The existing size assertion uses the published cap to exercise truncation; this alias does not claim a new independently fixed byte-limit magnitude assertion.
4. **Stable seam:** Exported boundSessionToolData(input) provider-result persistence projection, consumed by real agent-host ingestion and Codex item handling.
5. **Refactor resistance:** Assertions inspect returned data and string content; deep equality allows new object allocations and different walk/copy algorithms. Former input/small-result object identity requirements were removed.
6. **Unique protection:** Image/base64 cases protect special blob layouts; shared wire slimmer tests protect a different projection. They do not protect ordinary oversized UTF8 result truncation together with full arguments and small-result preservation at this durable-log boundary. This is the lowest stable persistence projection owner.
