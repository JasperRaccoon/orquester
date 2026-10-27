# Public image artifact checks

This followup overrides two existing identities from incoming
`610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`. Both are **REWRITE**; no new test is counted.
[Exact six-bar evidence and commands](dead-seams-codec.json) also records the final aliases,
fixtures, dependency and mutation results.

| Original identity in `apps/daemon/src/devices/screenshot-image.test.ts` | Final alias | Reason |
|---|---|---|
| Line 48: `PNG decoding undoes every filter; downscaling averages blocks` | `PNG filters preserve known colors through public thumbnail JPEG output` | Protect image content through the public boundary, with independently encoded PNG input and independently decoded JPEG output. Remove the private resampling algorithm assertion. |
| Line 59: `JPEG: standard tables, valid markers; fitting keeps a small PNG and shrinks a large one to the cap` | `fitting preserves an exact-cap PNG and returns a decodable JPEG within a smaller cap` | Protect exact-cap PNG preservation, real JPEG validity, native base64 size and decoded dimensions without importing private codec helpers. |

The independent contract is the Devices phase 1 §9 screenshot image/cap and phase 2 §2.9 JPEG
thumbnail behavior. Five authored PNGs were encoded with libpng 1.6.43, fixing each of filters
0–4. The test passes them to `thumbnailJpeg`, decodes the actual JPEG using `jpeg-js`, and
checks the known color bars with 8 levels of channel tolerance for JPEG loss. This detects
incorrect PNG reconstruction, color/channel corruption and invalid JPEG artifacts. No inverse
application algorithm calculates either the fixture or its expected pixels.

The second owner calls `fitScreenshot`, checks original PNG byte identity at the native exact
base64 cap, then validates a smaller capped JPEG with the independent decoder. Returned dimensions
must agree with decoded bytes. Worker/header/cache tests cannot replace these image-content and
artifact checks. Internal codec refactors remain free to change their resampling and helper
structure while preserving the public images and limits.

`pngSize`, `decodePng`, `downscale`, `encodeJpeg` and `RgbImage` are now private. Their existing
algorithms are unchanged. The earlier Huffman declaration self-sum and exported base64 helper
remain removed. The test file is 39 LOC smaller than the incoming version.

The exact test-only `jpeg-js` 0.4.4 dependency has bundled types and no transitive dependencies.
Its [official decoder API](https://github.com/jpeg-js/jpeg-js/tree/v0.4.4) supplies the independent
oracle. Five PNGs total 8,930 bytes; their [provenance and SHA-256 hashes](../../apps/daemon/src/devices/fixtures/image-codec/README.md)
record the colors, dimensions, libpng flags and verified filter bytes. No native generator ships
or runs in tests.

Final focused validation passed all 8 image tests, then passed all 8 again in three restored
repetitions. Seven temporary mutations failed their intended assertions: deadline, stale frame,
priority, size cap, Paeth reconstruction, channel corruption and cache expiry. Paeth corruption
produced color 0 instead of 220; channel corruption produced 21 instead of 220. Every source
SHA-256 was restored before the final runs.

The same three-file command with `TSX_DISABLE_CACHE=1`, concurrency 4 and a 30-second failure
deadline ran sequentially on the frozen incoming tree and the final tree: **2.89 s → median
1.62 s** (final repetitions 1.64/1.62/1.62 s), saving **1.27 s / 43.94%**. This focused result
includes the other image cleanup and shared fixture changes; it is not an isolated codec or CI
claim. The independent public pixel check itself takes 23–26 ms. Root owns the repository-wide
typecheck and full-suite gates.
