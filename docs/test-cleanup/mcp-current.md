# MCP test cleanup

Pre-edit dispositions recorded after reading every owned test and its production owner. Tools/messages and tools/workflows are separately audited in `mcp-messages-current.md` and `mcp-workflows-current.md`; neither is included below. No production behavior is changed by this scope.

The independent references are [the MCP user/protocol documentation](../orquester-mcp.md) and [the MCP v2 behavior specification](../superpowers/specs/2026-09-22-orquester-mcp-v2-design.md), supplemented by the public API wire/storage contracts and AGENTS.md security boundaries. In particular, specification §7.6 defines transcript shedding order, its 320-byte hint reserve, code-point caps, and live-agent retention; §4.5 defines the error/result envelope; §12 defines tool annotations and required parameters. A request assertion here is retained only for the documented DaemonApi wire operation a caller triggers, not an internal collaborator implementation. Fixture text is caller/provider data; incidental refusal prose is removed.

For each retained case the named scenario below is the exact failure it detects, reviewed against the owner. The six-bar justification applies per case through the stated file owner: **B1** the cited independent contract specifies it; **B2** violating the named result/state/bytes/refusal loses or corrupts caller-visible behavior; **B3** expected literals, input data, language JSON/UTF-8 encoders, or seeded durable log events are independent oracles (never evaluated production output); **B4** the listed public/stable seam is observed; **B5** implementation names/control flow may change without changing assertions; **B6** the stated owner is the lowest seam for that particular contract, with duplicate parsing/formatting/integration removed. Integration cases retain only cross-boundary selection/retention/index agreement that separate owners cannot prove.

Risk is low for deletions because the stronger owner is identified per row; retained cases continue protecting the listed failure. Rewrites retain only the named distinct contract and remove duplicate/private/copy checks. Each file lists its production callers and focused validation command.

## `apps/daemon/src/mcp/addressing.test.ts`

B1 source: §5 Addressing + AGENTS realpath containment. B4/B5 seam: resolveProject/projectNamesFor. Non-test callers: catalog, sessions, todos, workflow tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/addressing.test.ts`.

## `apps/daemon/src/mcp/agents.test.ts`

B1 source: §Catalogue/§Sessions and public provider capability/model contracts. B4/B5 seam: loadAgents, supportsFrom, resolveModelSelection, validateAccountId. Non-test callers: catalog, sessions, messages and views. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/agents.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| REWRITE | supports.goals is the provider's goal surface read through parseGoalSupport: a Codex-like block rides list_agents, a malformed one and a row without capabilities read null (L102) | Keep one provider-to-MCP goal-capability projection. Remove unknown-action/malformed parser permutations; packages/api/src/agent-chat/goal.test.ts owns parseGoalSupport independently. |

## `apps/daemon/src/mcp/attachments.test.ts`

B1 source: §9 Attachments + AGENTS sandbox/binary upload/secret boundaries. B4/B5 seam: attachmentInputSchema/uploadInlineAttachments with real temporary files. Non-test callers: messages and requests tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/attachments.test.ts`.

## `apps/daemon/src/mcp/daemon-api.test.ts`

B1 source: DaemonApi public transport boundary + §3 Authentication/§9 Attachments. B4/B5 seam: InjectDaemonApi against injected HTTP routes, streams and broadcaster. Non-test callers: daemon MCP registration and every tool. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/daemon-api.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| DELETE | a Fastify-shaped 4xx without a code keeps its message: the reason, not the status text (L116) | Repeats the nonempty-reason preference already covered directly by errors.test.ts; testing the framework serializer does not strengthen the daemonError contract. |

## `apps/daemon/src/mcp/errors.test.ts`

B1 source: §10 Safety and daemon error-envelope protocol. B4/B5 seam: daemonError. Non-test callers: reads, attachments and MCP tool owners. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/errors.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| DELETE | a real Fastify crash, errno code and all, maps to INTERNAL without its path (L37) | Repeats the errno-shaped 5xx/path-redaction case in errors.test.ts through a framework serializer. The lower daemonError contract owns this; real serialization adds no independent application behavior. |

## `apps/daemon/src/mcp/fs-tools.test.ts`

B1 source: §Files + AGENTS realpath containment and binary-safe UTF-8 byte offsets. B4/B5 seam: FsTools with real filesystem sandbox. Non-test callers: files tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/fs-tools.test.ts`.

## `apps/daemon/src/mcp/history.integration.test.ts`

B1 source: §Messages complete older-history navigation over durable event log + real index compatibility. B4/B5 seam: read_transcript/readOlderHistory through real orchestrator and SQLite index. Non-test callers: messages read_transcript; orchestrator history endpoints. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/history.integration.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| DELETE | a small range below the window is read in ONE page, every log row of its turns present (L150) | The one-page count is a read-planning optimization; completeness is covered by retained public transcript-pagination integration and history.test.ts cursor boundary cases. |
| DELETE | a range from turn 1 walks every block down to the log's start, where the host's cursor is null (L173) | Basic all-block completeness repeats the retained paging-through-tool integration and huge-turn continuation case; no separate user contract. |

## `apps/daemon/src/mcp/history.test.ts`

B1 source: §Messages older history: cursor paging, partial availability, launch bounds, capped reads and legacy hosts. B4/B5 seam: readOlderHistory over DaemonApi history pages. Non-test callers: messages read_transcript. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/history.test.ts`.

## `apps/daemon/src/mcp/reads.test.ts`

B1 source: §8 Waiting + documented idempotent command IDs/receipts and error contracts. B4/B5 seam: sendCommand/readThread over DaemonApi. Non-test callers: all chat tools and chat-client/workflow executor. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/reads.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| DELETE | sendCommand mints a UUID commandId, posts the body and returns the receipt (L6) | Ordinary route/receipt pass-through is covered by session commands and the retry receipt case; the retained caller-commandId override case independently validates UUID generation and input preservation. |

## `apps/daemon/src/mcp/result.test.ts`

B1 source: §10 Safety: 60000 UTF-8 result bytes, bounded errors and private-path redaction. B4/B5 seam: ok/toSafeToolError and code-point/UTF-8 budget utilities. Non-test callers: server and all bounded MCP projections. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/result.test.ts`.

## `apps/daemon/src/mcp/server.test.ts`

B1 source: §2–4 MCP HTTP/auth/SDK wire contract and documented tool annotation/schema table. B4/B5 seam: injected authenticated POST /mcp and JSON-RPC tools/list/tools/call. Non-test callers: daemon index.ts HTTP registration. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/server.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| DELETE | tools/list exposes the documented public names and strict argument schemas (L103) | Duplicates the independently specified required-parameter/annotation catalogue test. Strict additionalProperties is consolidated there; ordering of the export inventory is not a protocol requirement. |
| REWRITE | tools/list pins every tool's required params and annotations (spec §12 snapshot) (L117) | Consolidate advertised strict arguments into the independent MCP SDK schema/annotation contract; remove the redundant ordered inventory. Missing parameters, wrong mutation hints or permissive unknown arguments would mislead SDK callers. |
| DELETE | nested attachment arguments reject unknown fields and accept documented fields (L213) | Repeats strict attachment union validation owned by attachments.test.ts. The supposed valid path only reaches a missing-session error, not a successful upload; generic server unknown-argument rejection remains. |
| DELETE | no refusal grows with what the caller sent: a 2 MiB id or project is quoted back inside 4_000 (L244) | Repeats bounded ToolError serialization from result.test.ts through three ordinary tool lookups. Server success/error envelope integration and lowest-owner error budget remain. |
| DELETE | an unknown tool is a JSON-RPC InvalidParams error (-32602), as the MCP spec has it, not a tool result (L279) | The retained oversized unknown-tool case proves the same -32602/no-result protocol behavior plus bounded attacker-controlled text. |
| REWRITE | an unknown tool's name is quoted capped: a 2 MiB name gets a short −32602, not a 2 MiB one (L289) | Retain the bounded invalid-method-name protocol regression and remove its repeated identical error-code assertion. |
| REWRITE | GET and DELETE /mcp answer 405 with Allow: POST (L345) | Retain HTTP status 405 and Allow: POST protocol assertions; drop incidental English error copy. |
| REWRITE | POST /mcp answers 406 unless Accept lists both application/json and text/event-stream (L357) | Retain the required MCP Accept negotiation status; drop framework-generated English error copy. |
| REWRITE | the daemon mounts /mcp on the HTTP transport behind the bearer hook, and every tool's daemon call carries the caller's bearer (L385) | Retain real daemon remote-auth enforcement and bearer propagation. Drop repeated tools/list count (catalogue shape has its own lowest transport test). |

## `apps/daemon/src/mcp/todo-tools.test.ts`

B1 source: §Todos: workspace/project persistence, selector/toggle preservation and safe refusals. B4/B5 seam: TodoTools with real TodoStore and filesystem. Non-test callers: todos tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/todo-tools.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| REWRITE | toggleItem errors are safe and actionable (L95) | Retain the independently specified refusal, no-write guarantee, and actionable caller identifiers/attachment index. Remove exact English sentence and punctuation expectations; require the public error code so unrelated failures cannot pass. B1–B6 are justified by this file’s protocol source and stable tool/store boundary above. |
| REWRITE | a missing list's id is echoed capped and escaped: one short line whatever the caller sent (L129) | Keep unknown-id status, bounded escaped caller data and store conflict propagation; remove English sentence/punctuation oracle. |
| REWRITE | a refusal quotes the caller's item capped and escaped, and a long list's items bounded, never the whole list (L145) | Keep INVALID_ARGUMENT, escaped bounded selector, actionable item identities and total count; remove exact refusal sentences. |
| REWRITE | the longest refusal there can be ends whole under the error cap, whatever the input: the quote escaped at its longest, 40 items at their cap (L173) | Keep escaped hostile data, preserved total count and <=4000-code-point safety cap. Remove exact 3701 length derived from the template and English prefix checks. |

## `apps/daemon/src/mcp/tools/catalog.test.ts`

B1 source: §Catalogue: scope, filtering, resumability, model options and partial bounded responses. B4/B5 seam: catalog tool run/schema against DaemonApi. Non-test callers: server registered MCP tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/catalog.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| REWRITE | list_projects leaves out a workspace whose projects cannot be read and names it in warnings; the rest is listed (L109) | Keep partial success, failed-workspace identifiers/error codes and no private-path leak; remove exact warning sentences. |
| REWRITE | a filter naming nothing that exists is refused, not answered with an empty list; an archived workspace says why it is empty (L129) | Keep unknown-filter refusal and archived-workspace opt-in with usable identifiers; remove exact warning/refusal sentences. |
| DELETE | list_agents hides legacy models unless includeLegacyModels (L152) | The retained agents.test.ts loadAgents contract already covers includeLegacyModels; named-model tool filtering still covers tool-level selection. |

## `apps/daemon/src/mcp/tools/files.test.ts`

B1 source: §Files: readable file/directory response, 60000-byte envelope and chained UTF-8 windows. B4/B5 seam: files tool run with real FsTools. Non-test callers: server registered MCP tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/files.test.ts`.

## `apps/daemon/src/mcp/tools/output.integration.test.ts`

B1 source: §Tool output and persisted activity retention: a returned outputItemId must retrieve actual running/durable command bytes. B4/B5 seam: read_transcript → read_tool_output over real host fold/retention/output reader. Non-test callers: server registered MCP tools and host item/output endpoints. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/output.integration.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| DELETE | a finished shell: its completion — cut on the wire, holding no output — reads back as the joined chunks (L160) | Covered by the running-shell integration through completion and the output selector unit matrix; no unique seam failure. |
| DELETE | a host that predates the join answers its route miss: the completion's payload comes back, never an error (L199) | The old route is simulated by the test helper, not an old real host. Same compatibility refusal is owned at stable DaemonApi seam by output.test.ts. |
| REWRITE | past the cap a running command loses its start — sixteen later calls of its agent, all more recently active, hold the slots — so its latest chunk is the entry and the id, and its whole output reads back from the log (L213) | Retain actual retention-to-transcript-outputItemId-to-durable-output cross-boundary regression. Remove repeated old/new-host window permutations already owned by output.test.ts. |
| DELETE | the Write's completion answers its payload, its input included; the Bash call's answers its output (L310) | Replays provider fixture, ingestion, store and MCP extraction for the same file-change-versus-command contract: retained provider replay, API command-output tests and MCP output selector test are the stronger individual owners. Remove its separate fake route/store harness. |

## `apps/daemon/src/mcp/tools/output.test.ts`

B1 source: §Tool output: item selection, window protocol/compatibility, offsets, caps and private-error refusal. B4/B5 seam: read_tool_output run/schema over DaemonApi. Non-test callers: server registered MCP tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/output.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| DELETE | a Codex command answers its item's whole aggregatedOutput as command-output — not the wire's one-line preview (L58) | Duplicates retained unslimmed-output precedence case and API commandOutputText/storedCommandOutput owner tests; projection/pagination stay covered. |
| DELETE | a Grok command answers rawOutput's stdout then its stderr, and ACP content blocks where rawOutput has no text (L71) | Provider stdout/stderr/ACP extraction is owned by retained packages/api/src/agent-chat/command-output.test.ts. MCP selection/window/transport behavior remains. |
| REWRITE | ${host}: a background shell's output — in no item's data — answers the host's join as command-output (L241) | Keep joined output response for both real protocol versions; remove the incidental complete GET-call inventory. |
| REWRITE | ${host}: the item's own unslimmed output comes first: the host's join is never asked for it (L264) | Run once: the full item response takes precedence over the join and makes no host request, so the two host variants exercise identical behavior. Independent whole-output input remains the oracle. |

## `apps/daemon/src/mcp/tools/requests.test.ts`

B1 source: §Requests/§9 Attachments: exact question IDs/answers/options, all-validation-before-side-effects and allowed approval decisions. B4/B5 seam: answer_question/dismiss_question/resolve_approval public tool run. Non-test callers: server registered MCP tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/requests.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| REWRITE | answer_question refusals: unanswered question, invalid selection without custom, secret with attachments, unknown key, wrong requestId, none pending (L74) | Retain the independently specified refusal, no-write guarantee, and actionable caller identifiers/attachment index. Remove exact English sentence and punctuation expectations; require the public error code so unrelated failures cannot pass. B1–B6 are justified by this file’s protocol source and stable tool/store boundary above. |
| DELETE | answer_question uploads per-question attachments and allows attachment-only answers (L87) | Covered more strongly by the retained all-files-before-upload case, which also verifies attachment-only answers and per-question reference slicing. |
| REWRITE | dismiss_question only for message-mode questions; resolve_approval validates the decision (L96) | Retain request selection/decision and asynchronous dismissal contracts; remove expected commandId copied from the actual command. |
| REWRITE | answer_question validates every question before uploading any attachment (L114) | Retain the independently specified refusal, no-write guarantee, and actionable caller identifiers/attachment index. Remove exact English sentence and punctuation expectations; require the public error code so unrelated failures cannot pass. B1–B6 are justified by this file’s protocol source and stable tool/store boundary above. |
| REWRITE | answer_question keys: an exact id beats a 1-based index, and a question named twice is refused (L122) | Retain the independently specified refusal, no-write guarantee, and actionable caller identifiers/attachment index. Remove exact English sentence and punctuation expectations; require the public error code so unrelated failures cannot pass. B1–B6 are justified by this file’s protocol source and stable tool/store boundary above. |
| REWRITE | answer_question reports every problem at once, treats blank answers as unanswered, dedupes selections and takes files only where the GUI offers them (L140) | Retain the independently specified refusal, no-write guarantee, and actionable caller identifiers/attachment index. Remove exact English sentence and punctuation expectations; require the public error code so unrelated failures cannot pass. B1–B6 are justified by this file’s protocol source and stable tool/store boundary above. |
| REWRITE | answer_question: a blank answer beside files is attachment-only, and a failed upload names its question and sends nothing (L157) | Keep blank-to-attachment-only normalization; remove malformed-base64 repetition owned by attachments.test.ts and the all-files validation case. |
| REWRITE | an empty requestId is refused, never read as omitted: with one request pending it would have acted on that one (L223) | Retain the independently specified refusal, no-write guarantee, and actionable caller identifiers/attachment index. Remove exact English sentence and punctuation expectations; require the public error code so unrelated failures cannot pass. B1–B6 are justified by this file’s protocol source and stable tool/store boundary above. |
| REWRITE | answer_question validates every file of every question before uploading any, and slices the refs back per question (L241) | Retain the independently specified refusal, no-write guarantee, and actionable caller identifiers/attachment index. Remove exact English sentence and punctuation expectations; require the public error code so unrelated failures cannot pass. B1–B6 are justified by this file’s protocol source and stable tool/store boundary above. |
| REWRITE | answer_question: a host refusal while uploading names the question and that question's own attachment index (L260) | Retain the independently specified refusal, no-write guarantee, and actionable caller identifiers/attachment index. Remove exact English sentence and punctuation expectations; require the public error code so unrelated failures cannot pass. B1–B6 are justified by this file’s protocol source and stable tool/store boundary above. |

## `apps/daemon/src/mcp/tools/search.test.ts`

B1 source: §Search: scope/cursors, closed conversations, hit mapping and bounded useful excerpts. B4/B5 seam: search_sessions public tool run/schema. Non-test callers: server registered MCP tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/search.test.ts`.

## `apps/daemon/src/mcp/tools/sessions.test.ts`

B1 source: §Sessions: creation/resume/selection, busy and compaction guards, receipts, cancellation and bounded checkpoint diff. B4/B5 seam: session tool run/schema through DaemonApi plus real sandbox cwd. Non-test callers: server registered MCP tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/sessions.test.ts`.

## `apps/daemon/src/mcp/tools/todos.test.ts`

B1 source: §Todos: unambiguous project/workspace selectors, persistent CRUD and bounded successful bodies. B4/B5 seam: todo tool run with real TodoTools/TodoStore. Non-test callers: server registered MCP tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/todos.test.ts`.

## `apps/daemon/src/mcp/tools/usage.test.ts`

B1 source: §Usage: refresh, UTC cost period, unpriced values and preserved totals under response caps. B4/B5 seam: usage tool run through DaemonApi. Non-test callers: server registered MCP tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/usage.test.ts`.

## `apps/daemon/src/mcp/tools/watch.test.ts`

B1 source: §8 Waiting: project/session selector, newest attention and cursor response. B4/B5 seam: wait_for_session public tool run/schema. Non-test callers: server registered MCP tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/tools/watch.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| REWRITE | wait_for_session returns flagged sessions after the cursor, newest first, with a new cursor (L20) | Keep public projected reasons, attention ordering and cursor. Remove duplicate timeout path and private context-read count, owned by wait.test.ts. |

## `apps/daemon/src/mcp/transcript.test.ts`

B1 source: §Messages transcript protocol: entry kinds/turns, ownership, output IDs, visible retained data and UTF-8 budget; persisted-log regressions. B4/B5 seam: transcriptEntries and shared cutTail byte contract. Non-test callers: messages, views and history. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/transcript.test.ts`.

## `apps/daemon/src/mcp/usage-view.test.ts`

B1 source: §Usage: account association, stale/available measurements and UTC ages. B4/B5 seam: usageView. Non-test callers: usage tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/usage-view.test.ts`.

## `apps/daemon/src/mcp/views.test.ts`

B1 source: §Views + goals public summary/detail contracts + persisted legacy-thread compatibility. B4/B5 seam: sessionView/sessionDetail/buildViewContext/assistantTextForTurn. Non-test callers: session, message, request, watch tools and chat-client/workflow executor. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/views.test.ts`.

| Disposition | Original test (original line) | Failure/remaining owner and reason |
| --- | --- | --- |
| DELETE | buildViewContext reads a degraded providers body field-wise, as list_agents does: nothing throws, and only a row with an id and a capabilities object counts (L88) | Repeats providerRows tolerant field parsing already covered by agents.test.ts; buildViewContext normal projection and provider failure tests remain. |
| REWRITE | the detail's goal is null when the snapshot's does not read, whatever the summary says, and from a host that predates goals; a mistyped fact is dropped (L363) | Keep cleared/missing snapshot goal winning over a stale continuing summary. Remove malformed-field parsing permutations owned by packages/api/src/agent-chat/goal.test.ts. |

## `apps/daemon/src/mcp/wait.test.ts`

B1 source: §8 Waiting semantics: events, cursor progression, cancellation and terminal outcomes. B4/B5 seam: waitForTurn/waitForAttention/turnOutcome over DaemonApi event subscription. Non-test callers: messages and watch tools. B6: distinct cases below belong to this owner; shared downstream helpers do not cover its selection/projection/ordering or cross-boundary behavior.

Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/mcp/wait.test.ts`.

## Support and validation record

Completed dead support removal: duplicate EXPECTED_TOOLS inventory and one-use goal-provider arrangement wrappers; unused framework-error test imports; output integration old-host simulation, separate provider-fixture/store route harness and their imports. Shared fixtures/testing utilities retain live tests. No production-only export or injection hook becomes unused: `cutTail` is consumed by views, `retryDelayMs` by the workflow executor, and every retained exported owner has callers listed above.

Cleanup is implemented, not audit-only. No production source changed in this scope. The first whole-MCP run executed 395 tests: 394 passed, one newly rewritten todo assertion was too broad (it required all available-item text to be escaped, while the contract applies to the quoted selector). Corrected that assertion without changing production behavior. Focused rerun of todo-tools/output: 41/41 passed; final agents helper simplification: 9/9 passed. Final whole-MCP run: **395/395 passed**, including the separately cleaned messages/workflows suites (`--test-concurrency=4`, 61.5 seconds). Final review then removed remaining incidental refusal wording and required error codes in requests/todos; the affected **24/24 tests passed**.

`pnpm --filter @orquester/daemon typecheck` reported no MCP diagnostics but exited 2 for concurrent Codex test edits: missing RuntimeEvent import, unsupported findLast, incomplete MockConfig values and unsupported listModels force option. Reported the exact diagnostics to the owning/root agent for repository-gate resolution. `git diff --check` passes for this scope; reviewed the final own diff and support references.

Completed owned source-case dispositions: {'KEEP': 298, 'REWRITE': 26, 'DELETE': 17}. Dynamic host cases describe both host modes in one row, except the rewritten unslimmed-output precedence case now runs once because it never calls either host.

The adjacent `mintCommandId` export in reads.ts is re-exported by chat-client but has no external production consumer (its function is used internally by sendCommand). This export predates the deleted tests; reported to root for any shared chat-client cleanup. No deleted test leaves a production flag, wrapper or injection seam needed solely for tests.
