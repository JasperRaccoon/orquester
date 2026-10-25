# Incoming syntax-highlighter performance tests

Incoming commit: `9983fb4fb5f85b4b05f02bf79cae67cd969f171c`; comparison base: `7feff9eb`. Reviewed the exact highlighter diff, all three added declarations, the manual benchmark, the production highlighter, `CodeBlock` and `languages`, and GUI design §7.3. The four pre-existing declarations are unchanged; their audit remains in `ui_chat_components.md`.

Applied cleanup: **1 DELETE, 1 removed CONSOLIDATE, 1 surviving REWRITE**. Three added declarations become one; the complete file has five declarations instead of seven. Incoming test LOC **77 → 52** (**−25**); versus the comparison base, the final file adds one meaningful declaration and **16 LOC**. No production changes, dependencies, configuration, fixtures or exports are removed. The production optimization and finalized math accessibility rewrite remain intact.

## Every added test declaration

Path for all three rows: `packages/ui/src/components/agent-chat/timeline/markdown/highlight-core.test.ts`. Line IDs refer to the incoming commit.

| Original declaration | Disposition | Evidence and remaining protection |
| --- | --- | --- |
| `streaming code keeps unchanged highlighted lines by identity` (line 38) | **DELETE** | Object equality of token-line arrays is an implementation mechanism used by React memoization. GUI §7.3 specifies source rendering and preserving selection; it does not expose array identity. The test would reject a behavior-preserving implementation that uses another memoization strategy, so it fails stable seam and refactor resistance. Its fresh-highlighter comparison also shares the production formatter. Existing literal source-preservation tests remain; the new surviving context test protects stale highlighting. The manual benchmark still measures the optimization as a diagnostic, without making array identity a regression contract. |
| `appended delimiters may change the preceding line's token classes` (line 50) | **CONSOLIDATE — removed execution** | The literal `comment` classification is the meaningful behavior. Identity assertions and whole-output comparison against `highlightCode` do not supply independent protection. Its initial `/` line changes text when it becomes `/* comment`, so it does not force the optimization to distinguish identical source with different syntax context. The surviving context test below moves that independent comment expectation to an unchanged authored line, then checks leaving the comment too. |
| `incremental results match a fresh highlight through syntax changes and edits` (line 63) | **REWRITE — surviving owner** | Originally compared two production paths sharing `treeToLines`; both could agree while producing the wrong syntax classification. Replaced the six-step parity loop, including its duplicate final input, with one real-JavaScript context transition and literal expectations. Survives as `syntax context changes reclassify unchanged source lines`: the unchanged line `value` must become entirely `comment` inside `/* … */`, retain its exact text, then return to a non-comment syntax class when the comment is removed. No array identity or exact token-run segmentation is asserted. |

## Six-bar evidence for the surviving owner

1. **Independent contract:** GUI §7.3 requires grammar-highlighted source, using the actual selected language. JavaScript block-comment syntax independently determines that `value` inside `/* … */` is comment content and outside it is an identifier expression. `comment` is a semantic value in the production-facing `TokenClass` model; the test does not assert a palette, DOM class or color.
2. **Recognizable failure:** reusing a line solely because its source text is unchanged can leave code highlighted as a comment, or a comment highlighted as executable code, after the surrounding syntax changes. Source bytes must also remain intact through both calls.
3. **Independent oracle:** authored input bytes, literal unchanged-line text `value`, and the independently required comment/non-comment classifications are asserted directly. Expected data never comes from `highlightCode` or a second call implementing the same formatter. The real JavaScript grammar is loaded; no fake parser implements the asserted behavior.
4. **Stable seam:** `createIncrementalTreeHighlighter(parser)(code)` returns the semantic token model consumed by `CodeBlock`. Assertions concern resulting source and syntax category, not parser calls, allocation, cache entries or React render counts. `loadLanguageParser` is the same production language resolver used by code blocks.
5. **Refactor resistance:** parser caching, line-array identity, individual token segmentation, React wrappers and rendering strategy can change. The unchanged line is identified by its authored line position, which is part of the line-oriented output contract, and all its runs may have any segmentation while carrying the correct syntax category.
6. **Unique protection / credible failure mode:** the four existing tests own byte preservation, oversize grammar bypass, grammar failure and unknown-language fallback. None exercises context changes across successive cached calls. Comparing both text and class matters for the unchanged one-token line `value`: deleting the incoming cache comparator's class comparison can reuse the earlier identifier line as comment content. The rewritten test is the lowest stable owner of this semantic invalidation behavior; a fresh static rendering cannot exercise its stateful cache.

Non-test callers were read: `CodeBlock` retains the per-block highlighter while streamed code changes and consumes every returned token's semantic class through `tokenColor`. No production-facing export or caller is removed. Deletion risk is limited to performance-proxy/duplicate assertions; the production optimization remains unchanged.

## Manual benchmark

`packages/ui/src/components/agent-chat/timeline/markdown/highlight-core.bench.ts` is **retained as an optional diagnostic utility**, not an assertion gate or additional named test. The package test glob selects `*.test.ts` and `*.check.ts`; this `*.bench.ts` adds no required-suite runtime or retries.

The script compares an explicitly selected git revision with the working-tree highlighter using the same fixed 251-line / 40-update workload, one discarded warmup and five recorded samples. It reports elapsed medians and render counters; it does not require an identity, render-count or timing threshold. Its only result assertion checks authored source preservation in the synthetic renderer. The script loads a real grammar, uses real React reconciliation in jsdom, removes its temporary revision file in `finally`, and closes its root/document on successful completion. No new dependency or test-only production hook is required.

This is an approximation of `CodeBlock`'s memoized line rendering, not a production browser, layout or paint measurement. The benchmark deliberately omits line separators from its synthetic DOM and compensates only for its own source-fidelity sanity check. The incoming commit's timing claims have not been independently reproduced in this cleanup, so no speedup or CI-cost reduction is claimed here. Retention preserves the reproducibility of the incoming performance work without turning an internal memoization choice into a behavioral test contract.

## Validation and delivery status

Root executed the integrated changed gate:

```sh
pnpm check:changed --no-cache --base 0e61cd5dfed987e9bcbafe097e2582f90586ef4f
```

It **passed**, including all three affected UI test files (`math.test.ts`, `highlight-core.test.ts` and `file-browser-refresh.dom.test.ts`) together in **14.9 s**. Full `pnpm check` and `TSX_DISABLE_CACHE=1 pnpm build` also **passed** after integration; both frontend builds are included. Evidence is `/tmp/orquester-test-audit/integrated-gates.log`. These completed gate results do not establish a whole-suite speedup.

Root then ran `python3 /tmp/orquester-test-audit/highlight-incoming-mutation.py`. From `packages/ui`, its positive and mutant controls used:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-concurrency=4 --test-timeout=600000 --test-name-pattern="syntax context changes reclassify unchanged source lines" src/components/agent-chat/timeline/markdown/highlight-core.test.ts
```

The real-source positive control **passed (exit 0; 1.2558447 s wall time)**. Removing only `token.cls === other.cls` from the cached-line comparator caused the expected failure **(exit 1; 1.4925836 s)** at `assert.ok(after[1]!.every((token) => token.cls === "comment"))`. This verifies the surviving test catches stale syntax classification for unchanged source rather than merely exercising the code. Evidence is `/tmp/orquester-test-audit/highlight-context-positive.log`, `/tmp/orquester-test-audit/highlight-context-mutant.log` and `/tmp/orquester-test-audit/remaining-controls.log`. The driver restored exact production bytes in `finally`; an independent byte comparison against the reviewed incoming source confirmed restoration.

Scoped `git diff --check` passed. The prepared patch is `/tmp/orquester-test-audit/highlight-incoming.patch`; accounting metadata is `/tmp/orquester-test-audit/highlight-incoming.json`. No runtime checks were independently rerun by this worker. The optional benchmark has not been run in this cleanup. The final full test suite is currently active; its result, comparable suite performance and git delivery remain root-owned and pending.
