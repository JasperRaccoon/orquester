# Devices stream audit

Remote baseline `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8` against `923b3a51`. Read all 15 test files and production stream owners, the approved phase1 specification, device spike/capture provenance, daemon protocol writers and workspace callers. Every one of the 106 expanded exact remote cases is accounted for below. Separate state/fleet work is recorded in [devices-state.md](devices-state.md): combined scope 170 original cases → 122 executions.

Stream cases: 106 → 84 (22 removed). Dispositions: CONSOLIDATE 25, DELETE 6, KEEP 46, OPTIMIZE 4, REWRITE 25. Test LOC 1775 → 1611 (-164); including shared fakes/new minimal DOM fixture, 2047 → 1972 (-75). Production LOC 2770 → 2658 (-112).

Production transport/protocol behavior and runtime defaults are preserved. Removed unused injection/configuration surfaces, decoder dependency wrappers, internal exports and unread metadata fields; real browser APIs are the stable test boundary. Header/payload/version compatibility remains protected. The per-page capability cache is unchanged: two missing-WebCodecs hook cases move to the existing screenshot test process, avoiding a new runner file or production cache-reset hook. The small shared DOM fixture restores globals and unmounts every root.

The historical 610d screenshot abort-listener retention fix stays in the real polling/auth/abort scenario. Exact private callback counts become a bounded platform resource assertion. All actually issued signals abort after close. No recorded fixtures, snapshots or dependencies were removed: the redacted nine-frame capture still has real protocol/session consumers.

Independent external specifications used to verify numeric and browser contracts: [USB-IF HID keyboard/keypad page](https://www.usb.org/sites/default/files/hut1_21_0.pdf), [Android KeyEvent constants](https://developer.android.com/reference/android/view/KeyEvent), [W3C WebCodecs](https://www.w3.org/TR/webcodecs/), [W3C AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/). Local primary product contract: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md`, particularly §§7/10.1/10.6, plus recorded hub provenance.

## Baseline performance evidence

Root supplied `/tmp/orquester-test-audit/devices-baseline.log` from the uncontended 610d reference suite. File summaries exclude runner preload; these are investigation signals, not complete isolated process wall times. Slowest local file harness: MJPEG 320.677 ms; hook DOM 167.742 ms; iOS H264 81.372 ms. Slowest cases: all-byte MJPEG split 178.441 ms, no-length delimiter split 61.304 ms, H264 seed/config 53.494 ms, repeated large MJPEG frames 46.649 ms.

The measured parser bottleneck led to smaller incidental JPEG bodies while preserving every byte split, plus three exact alternating large/small byte assertions replacing 50 count-only repetitions. The size change does not reduce protocol variants, large-frame protection or header/delimiter/near-miss boundaries. The matched isolated measurement is recorded below; overall suite measurements remain root-controlled.

## packages/ui/src/components/device/stream/avcConfig.test.ts

**1. independentSource:** Captured serve-sim AVC configuration fixtures, approved phase1 §10.1 and W3C AVC description format

**2. recognizableFailure:** A known fallback avcC must advertise zero reorder without corrupting existing VUI/SPS/PPS/extensions or malformed bytes.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** simulatorAvcConfig input/output wire bytes

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Conversion variants are not exercised by single-stream sessions; caller forwarding remains separately protected.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 22: <code>simulator AVC reorder metadata &gt; adds zero reordering and one reference frame to the captured fallback SPS</code> | CONSOLIDATE | Surviving known captured byte oracle now also owns preserving existing VUI, idempotent output and immutable caller input. Exact Uint8Array identity was replaced by wire-byte equality; the source capture is copied before repair to catch mutation. |
| 27: <code>simulator AVC reorder metadata &gt; preserves existing VUI and leaves the original codec description untouched</code> | CONSOLIDATE | Same protocol repair scenario/setup; the unique existing-VUI and mutation checks move into the captured fallback owner. Surviving owner: packages/ui/src/components/device/stream/avcConfig.test.ts: adds zero reordering and one reference frame to the captured fallback SPS |
| 34: <code>simulator AVC reorder metadata &gt; repairs multiple SPS entries while preserving PPS and profile extensions</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 56: <code>simulator AVC reorder metadata &gt; passes through every truncated prefix of the captured configurations</code> | CONSOLIDATE | Surviving safe pass-through owner retains truncated records, unknown SPS profiles/scaling, illegal lengths/NAL/Golomb/padding and resource bounds. It compares bytes instead of requiring object reuse; the production format converter remains its lowest protocol seam. Surviving owner: preserves unsupported, truncated and malformed codec descriptions |
| 65: <code>simulator AVC reorder metadata &gt; does not modify unsupported profiles, scaling lists, or invalid parameter-set lengths</code> | CONSOLIDATE | The same safe byte pass-through contract is consolidated into one malformed-config owner; all distinct malformed wire shapes remain, without four separate implementation-branch cases. Surviving owner: packages/ui/src/components/device/stream/avcConfig.test.ts: preserves unsupported, truncated and malformed codec descriptions |
| 79: <code>simulator AVC reorder metadata &gt; requires valid SPS trailing bits before appending VUI metadata</code> | CONSOLIDATE | The same safe byte pass-through contract is consolidated into one malformed-config owner; all distinct malformed wire shapes remain, without four separate implementation-branch cases. Surviving owner: packages/ui/src/components/device/stream/avcConfig.test.ts: preserves unsupported, truncated and malformed codec descriptions |
| 85: <code>simulator AVC reorder metadata &gt; passes through invalid NAL headers and unterminated Exp-Golomb values</code> | CONSOLIDATE | The same safe byte pass-through contract is consolidated into one malformed-config owner; all distinct malformed wire shapes remain, without four separate implementation-branch cases. Surviving owner: packages/ui/src/components/device/stream/avcConfig.test.ts: preserves unsupported, truncated and malformed codec descriptions |
| 114: <code>simulator AVC reorder metadata &gt; bounds parsing of oversized configurations and SPS data</code> | CONSOLIDATE | The same safe byte pass-through contract is consolidated into one malformed-config owner; all distinct malformed wire shapes remain, without four separate implementation-branch cases. Surviving owner: packages/ui/src/components/device/stream/avcConfig.test.ts: preserves unsupported, truncated and malformed codec descriptions |

## packages/ui/src/components/device/stream/avcc.test.ts

**1. independentSource:** serve-sim u32 BE/tag envelope format; phase1 §10.1; daemon vphone screen-protocol writer

**2. recognizableFailure:** Transport fragmentation cannot lose/reorder payloads; unknown envelopes cannot desynchronize the stream; oversized lengths fail safely and reset.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** Incremental AvccDemuxer.push wire input/output

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Session tests own decoder glue, not every transport split or malformed/raw payload lifetime.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 34: <code>AvccDemuxer &gt; counts the tag byte in the envelope length (as serve-sim writes it)</code> | REWRITE | Uses a literal u32/tag/payload wire envelope, removing the assertion about the test encoder itself. A tag-counted length disagreement now fails the production demuxer directly. |
| 40: <code>AvccDemuxer &gt; reassembles envelopes split at every byte offset across two reads</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 49: <code>AvccDemuxer &gt; reassembles a stream fed one byte per read</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 56: <code>AvccDemuxer &gt; grows past its initial buffer for large keyframes</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 64: <code>AvccDemuxer &gt; skips unknown tags and empty envelopes</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 70: <code>AvccDemuxer &gt; returns payload copies that survive later reads</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 77: <code>AvccDemuxer &gt; throws on an envelope length no screen frame has, and recovers after reset</code> | REWRITE | Uses independently invalid 0xffffffff rather than importing the implementation cap, and preserves error plus clean subsequent packet recovery. |

## packages/ui/src/components/device/stream/capabilities.test.ts

**1. independentSource:** Approved phase1 §10.1; devices-spikes measured Baseline/High profiles and missing VM encoder; WebCodecs support probe contract

**2. recognizableFailure:** Unsupported browser/host profiles must select usable fallback; missing or throwing platform APIs must not claim decoder support.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** Production capability() browser API and chooseTransport pure boundary

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Only distinct absent-profile/host conditions remain after three hook-owned positive/fallback duplicates are deleted.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 26: <code>chooseTransport &gt; android + WebCodecs</code> | DELETE | Fails unique-protection bar: the actual mounted hook already proves this capability combination selects the expected real session and opens its correctly authenticated transport. The other capability cases retain distinct missing-profile/host conditions. Surviving owner: packages/ui/src/components/device/stream/useDeviceStream.dom.test.ts: streams Android over serve-emu while enabled and routes input through the same socket |
| 26: <code>chooseTransport &gt; android + Baseline only</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 26: <code>chooseTransport &gt; android without WebCodecs</code> | DELETE | Fails unique-protection bar: the actual mounted hook already proves this capability combination selects the expected real session and opens its correctly authenticated transport. The other capability cases retain distinct missing-profile/host conditions. Surviving owner: packages/ui/src/components/device/stream/screenshots.test.ts: falls back to screenshots plus an input-only socket when the browser can&#x27;t decode H.264 |
| 26: <code>chooseTransport &gt; android, WebCodecs without H.264</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 26: <code>chooseTransport &gt; ios, host H.264 + browser H.264</code> | DELETE | Fails unique-protection bar: the actual mounted hook already proves this capability combination selects the expected real session and opens its correctly authenticated transport. The other capability cases retain distinct missing-profile/host conditions. Surviving owner: packages/ui/src/components/device/stream/useDeviceStream.dom.test.ts: switches iOS from H.264 to MJPEG when the host only sends the seed |
| 26: <code>chooseTransport &gt; ios, Blacksmith VM (no host H.264)</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 26: <code>chooseTransport &gt; ios, host caps unknown</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 26: <code>chooseTransport &gt; ios, host H.264, no WebCodecs</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 26: <code>chooseTransport &gt; ios, host H.264, browser without High</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 31: <code>capabilities &gt; reports no WebCodecs when VideoDecoder or EncodedVideoChunk is missing</code> | REWRITE | Probes actual browser-global APIs in independently imported page instances. Removes optional constructor/Chunk injection and its uncached bypass while preserving missing-API, profile support and throwing-probe behavior. Expected capability flags and codec strings are literal. |
| 37: <code>capabilities &gt; probes Baseline and High with optimizeForLatency</code> | REWRITE | Probes actual browser-global APIs in independently imported page instances. Removes optional constructor/Chunk injection and its uncached bypass while preserving missing-API, profile support and throwing-probe behavior. Expected capability flags and codec strings are literal. |
| 43: <code>capabilities &gt; treats a throwing probe as unsupported</code> | REWRITE | Probes actual browser-global APIs in independently imported page instances. Removes optional constructor/Chunk injection and its uncached bypass while preserving missing-API, profile support and throwing-probe behavior. Expected capability flags and codec strings are literal. |

## packages/ui/src/components/device/stream/h264.test.ts

**1. independentSource:** W3C AVC WebCodecs registration §§1–4 and redacted captured Android SPS

**2. recognizableFailure:** Correct profile/constraints/level and Annex-B SPS/IDR detection distinguish decoder configuration and key/delta input.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** codecFromAvcC/codecFromSps/scanAccessUnit format conversion

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Synthetic 3/4-byte start-code and malformed cases retain variant protection without repeated whole captured scans.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 14: <code>H.264 codec strings &gt; reads profile, constraints and level from an avcC record</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 20: <code>H.264 codec strings &gt; reads the codec from the recorded Android emulator SPS (Baseline, level 3.2)</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 28: <code>H.264 codec strings &gt; rejects a non-SPS NAL and short input</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 35: <code>scanAccessUnit &gt; finds SPS and IDR NAL units behind 3- and 4-byte start codes</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 42: <code>scanAccessUnit &gt; reports a delta slice as not key and ignores a start code at the very end</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 47: <code>scanAccessUnit &gt; marks only the first frame of the recorded stream as key</code> | DELETE | Fails unique-protection bar: synthetic mixed 3/4-byte Annex-B positive/negative tests already own IDR detection; replaying all nine captured NAL scans adds no distinct start-code or slice shape. The capture remains exercised by actual ServeEmu decoding. Surviving owner: packages/ui/src/components/device/stream/h264.test.ts: finds SPS and IDR NAL units behind 3- and 4-byte start codes; reports a delta slice as not key |

## packages/ui/src/components/device/stream/keymap.test.ts

**1. independentSource:** Approved phase1 §10.1 input; USB-IF HID Usage Tables keyboard page; Android KeyEvent constants; serve-emu text packet/queue limits

**2. recognizableFailure:** Wrong HID/keycode/meta/phase or UTF-8 split types another key, drops paste data or exceeds host queue.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** Production-consumed mapKeyboardEvent/textToHidStrokes/chunkText results

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Mapping ranges and byte/queue limits are not covered by one hook/session input sample; redundant short paste is removed.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 14: <code>HID usages (iOS) &gt; maps letters, digits, function keys and named keys by physical code</code> | CONSOLIDATE | Literal standardized key/flag values move to the production-consumed browser-event mapping boundary; unused private mapping exports disappear. Unknown private-helper inventories are removed, with real unmapped event refusal retained. Surviving owner: packages/ui/src/components/device/stream/keymap.test.ts: iOS: HID down/up by code, with the typed character on down |
| 30: <code>HID usages (iOS) &gt; types US-layout ASCII with shift where needed</code> | CONSOLIDATE | Known USB HID strokes move into the production-consumed text-to-strokes owner alongside CRLF and unsupported-character behavior. The private per-character helper is no longer exported. Surviving owner: packages/ui/src/components/device/stream/keymap.test.ts: maps ASCII text to USB HID, drops CR and counts characters it cannot type |
| 44: <code>HID usages (iOS) &gt; drops CR and counts characters it can&#x27;t type</code> | CONSOLIDATE | Surviving text conversion owner uses independent HID literals for US-layout ASCII, shift, CRLF and unsupported characters in one paste; direct private helper checks are removed. Surviving owner: maps ASCII text to USB HID, drops CR and counts characters it cannot type |
| 56: <code>Android keycodes &gt; maps letters, digits, function and editing keys</code> | CONSOLIDATE | Literal standardized key/flag values move to the production-consumed browser-event mapping boundary; unused private mapping exports disappear. Unknown private-helper inventories are removed, with real unmapped event refusal retained. Surviving owner: packages/ui/src/components/device/stream/keymap.test.ts: Android: printable keys type text on down only; chords and editing keys send keycodes |
| 69: <code>Android keycodes &gt; builds the meta state bitmask</code> | CONSOLIDATE | Literal standardized key/flag values move to the production-consumed browser-event mapping boundary; unused private mapping exports disappear. Unknown private-helper inventories are removed, with real unmapped event refusal retained. Surviving owner: packages/ui/src/components/device/stream/keymap.test.ts: Android: printable keys type text on down only; chords and editing keys send keycodes |
| 77: <code>mapKeyboardEvent &gt; iOS: HID down/up by code, with the typed character on down</code> | CONSOLIDATE | Surviving browser-key mapping owner covers physical key ranges, standardized editing/function/modifier codes and typed-text/chord/phase behavior. Private helper outputs are replaced by the public platform action; the session wire tests protect encoding separately. |
| 84: <code>mapKeyboardEvent &gt; Android: printable keys type text on down only; chords and editing keys send keycodes</code> | CONSOLIDATE | Surviving browser-key mapping owner covers physical key ranges, standardized editing/function/modifier codes and typed-text/chord/phase behavior. Private helper outputs are replaced by the public platform action; the session wire tests protect encoding separately. |
| 106: <code>chunkText &gt; keeps short text in one chunk</code> | DELETE | Fails unique-protection bar: real hook sendText(&quot;hi&quot;) verifies short text arrives as one actual protocol message, and session splitting verifies a final one-byte packet. Empty-input helper echo has no separate documented outcome. Surviving owner: packages/ui/src/components/device/stream/useDeviceStream.dom.test.ts: streams Android over serve-emu while enabled and routes input through the same socket |
| 111: <code>chunkText &gt; splits at the byte limit without breaking multi-byte code points</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 122: <code>chunkText &gt; caps the chunk count and reports truncation</code> | REWRITE | Retains bounded paste/truncation/prefix data and the externally imposed 300-byte packet and 128-slot queue constraints. Removes the incidental exact conservative 64-chunk choice and the test-only maxBytes/maxChunks override; default production limits stay unchanged. |

## packages/ui/src/components/device/stream/lifecycle.test.ts

**1. independentSource:** Approved phase1 §10.1: 2s stall, retained frame/reconnect and visibility close; DeviceStreamStats public two-second semantics; shared reconnect policy

**2. recognizableFailure:** Stalled streams recover, silence/retry/fatal/close/wake cannot keep stale attempts alive; stats reflect real arrivals and expiry.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** Production-consumed StreamLifecycle state, callbacks, attempt signals and stats

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Session tests own transport adapters, not generic watchdog/retry/wake/time-window variants. Input-only ready duplicate moves to actual session.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 32: <code>StreamLifecycle &gt; goes live on a frame, stalls after 2 s of silence, and recovers on the next frame</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 53: <code>StreamLifecycle &gt; reconnects after long silence, keeping the attempt count for stats</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 69: <code>StreamLifecycle &gt; times out a connection that never paints</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 80: <code>StreamLifecycle &gt; backs off exponentially with jitter, reads error after three failures, and resets on a frame</code> | REWRITE | Uses deterministic virtual timer boundaries rather than 50ms polling; retains exponential retry scheduling, visible failure escalation, and recovery resetting the schedule. Global clock/jitter replace test-only lifecycle now/random/backoff overrides. |
| 104: <code>StreamLifecycle &gt; retries at once when the page wakes</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 113: <code>StreamLifecycle &gt; stops on a fatal error and ignores late failures from the old attempt</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 124: <code>StreamLifecycle &gt; close aborts the attempt, cancels retries and silences callbacks</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 138: <code>StreamLifecycle &gt; marks an input-only attempt ready without a stall watchdog</code> | CONSOLIDATE | Moves the long quiet interval to the actual ServeEmu input-only session owner, which proves it stays connected and still accepts input without decoding. The private ready-method scenario is redundant. Surviving owner: packages/ui/src/components/device/stream/serveEmu.test.ts: input-only mode is live on open and never decodes |
| 149: <code>RateMeter &gt; reports fps and kbps over a sliding two-second window</code> | REWRITE | Measures actual public lifecycle stats after independent known frame/byte arrivals and expiry, including lifetime totals. Removes the RateMeter export and test-only window/clock constructor parameters. |

## packages/ui/src/components/device/stream/mjpeg.test.ts

**1. independentSource:** Multipart framing protocol; approved phase1 §10.1; actual serve-sim multipart writer and vphone bridge output

**2. recognizableFailure:** Fragmented headers/delimiters/bodies, missing length, closing delimiters and large frames preserve byte payloads and bounded parse refusal.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** multipartBoundary and incremental MjpegParser wire results

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Sessions own newest-frame/painting glue, not full framing variants or every byte split. Costly fixture bodies were incidental.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 28: <code>multipartBoundary &gt; reads plain, quoted, dash-prefixed and case-varied boundary parameters</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 35: <code>multipartBoundary &gt; returns null without a boundary</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 46: <code>MjpegParser &gt; parses serve-sim parts split at every byte offset</code> | OPTIMIZE | Retains every byte split, multi-read accumulation and exact body bytes using minimal variable-size JPEG payloads. The baseline identified 178.441ms for the full split case and 61.304ms for delimiter splits; smaller incidental bodies avoid hundreds of unnecessary 256KiB parser allocations without reducing header/delimiter or near-miss fragmentation cases. |
| 52: <code>MjpegParser &gt; parses a stream fed one byte per read</code> | OPTIMIZE | Retains every byte split, multi-read accumulation and exact body bytes using minimal variable-size JPEG payloads. The baseline identified 178.441ms for the full split case and 61.304ms for delimiter splits; smaller incidental bodies avoid hundreds of unnecessary 256KiB parser allocations without reducing header/delimiter or near-miss fragmentation cases. |
| 59: <code>MjpegParser &gt; finds part ends by delimiter when Content-Length is missing</code> | OPTIMIZE | Retains every byte split, multi-read accumulation and exact body bytes using minimal variable-size JPEG payloads. The baseline identified 178.441ms for the full split case and 61.304ms for delimiter splits; smaller incidental bodies avoid hundreds of unnecessary 256KiB parser allocations without reducing header/delimiter or near-miss fragmentation cases. |
| 73: <code>MjpegParser &gt; accepts LF-only line endings, a preamble, padding after the boundary and odd header case</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 85: <code>MjpegParser &gt; stops at the closing delimiter</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 93: <code>MjpegParser &gt; keeps working after many frames (buffer compaction) and with large frames</code> | OPTIMIZE | Replaces 50 repeated count-only frames with three alternating 400KB/small/400KB bodies and exact byte equality. Still crosses allocation/reuse boundaries and now detects corrupted payloads; expensive repeated incidental traffic is removed. Surviving owner: preserves frame bytes across large and small frames |
| 101: <code>MjpegParser &gt; throws on a Content-Length beyond the frame limit</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |

## packages/ui/src/components/device/stream/pointer.test.ts

**1. independentSource:** Approved phase1 §10.1 normalized touch sequence; browser animation-frame coalescing prevents input-queue flood

**2. recognizableFailure:** Move floods coalesce to latest coordinates without losing begin/end ordering; new/closed gestures cannot send stale moves.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** createPointerThrottle output TouchSender sequence plus actual platform RAF

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Socket encoding tests do not exercise RAF scheduling/gesture cancellation; direct clamp duplicate is removed.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 26: <code>sends begin at once and coalesces moves to the latest per animation frame</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 40: <code>flushes a pending move before end and cancels its frame</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 49: <code>drops a stale move when a new gesture begins, and everything after dispose</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 61: <code>clamps coordinates into 0..1</code> | DELETE | Fails unique-protection bar: the actual Android and iOS socket wire-payload tests already check out-of-range touch values are clamped to the protocol domain. No private clamp export needs a direct test. Surviving owner: packages/ui/src/components/device/stream/serveEmu.test.ts: sends serve-emu input JSON; serveSimInput.test.ts: sends nothing until serve-sim admits input, then tagged JSON |

## packages/ui/src/components/device/stream/screenshots.test.ts

**1. independentSource:** Approved phase1 §10.1 Android browser fallback; d5fad1f7 Authorization fix; 610d3c53 screenshot abort-listener cleanup; hub POST screenshot protocol

**2. recognizableFailure:** Fallback paints/posts authenticated screenshots, accepts input separately, reports missing support, stops after auth refusal/close and bounds retained wait closures.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** ScreenshotPollSession actual fetch/ImageBitmap/AbortSignal boundary and mounted useDeviceStream

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Polling timing/auth/resource behavior differs from initial fallback selection; duplicate listener fixture consolidated. Missing APIs are real page globals.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 15: <code>retains only the current wait&#x27;s abort listener across successful polls</code> | CONSOLIDATE | Credible 610d historical memory-retention regression survives inside the real POST/poll/auth/abort workflow. Observe bounded AbortSignal platform handlers across requests instead of a separate fixture and exact initial listener count. Surviving owner: packages/ui/src/components/device/stream/screenshots.test.ts: polls with POST about once a second and paints each screenshot |
| 43: <code>polls with POST about once a second and paints each screenshot</code> | CONSOLIDATE | Surviving polling owner also proves bounded platform abort-handler retention and all issued requests aborted after close. Keeps literal POST path/bearer, actual paint cadence and fatal-403 no-retry semantics; removes duplicate fixture startup. |

## packages/ui/src/components/device/stream/semu.test.ts

**1. independentSource:** Recorded serve-emu-semu-v1.bin provenance JSON; devices-spikes SEMU v1/v2; serve-emu frame-meta protocol

**2. recognizableFailure:** Header offsets, key flags and exact safe microsecond PTS survive v1/v2 and buffer views; unknown/bare packets remain raw.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** parseSemuPacket consumer-used data/isKey/timestamp

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** The recorded session only uses v1 ArrayBuffers; v2 extra header, views, raw fallback and precision limits need this cheaper wire owner. Unused metadata outputs are removed.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 20: <code>SEMU frame metadata &gt; parses the recorded expo-device-hub stream as v1 with keyframe flag and pts</code> | REWRITE | Checks only real consumer-visible payload, keyframe and microsecond PTS fields with independently read capture literals. Removes unused version/serverTimeMs output fields and production-constant expected magic; v2 still skips its extra server-time header and preserves payload/PTS, including raw fallback and nonzero views. |
| 35: <code>SEMU frame metadata &gt; parses v2 headers (24 bytes, server send time)</code> | REWRITE | Checks only real consumer-visible payload, keyframe and microsecond PTS fields with independently read capture literals. Removes unused version/serverTimeMs output fields and production-constant expected magic; v2 still skips its extra server-time header and preserves payload/PTS, including raw fallback and nonzero views. |
| 45: <code>SEMU frame metadata &gt; parses headers inside a larger buffer (Uint8Array views)</code> | REWRITE | Checks only real consumer-visible payload, keyframe and microsecond PTS fields with independently read capture literals. Removes unused version/serverTimeMs output fields and production-constant expected magic; v2 still skips its extra server-time header and preserves payload/PTS, including raw fallback and nonzero views. |
| 53: <code>SEMU frame metadata &gt; treats packets without the magic, unknown versions and bare headers as raw Annex-B</code> | REWRITE | Checks only real consumer-visible payload, keyframe and microsecond PTS fields with independently read capture literals. Removes unused version/serverTimeMs output fields and production-constant expected magic; v2 still skips its extra server-time header and preserves payload/PTS, including raw fallback and nonzero views. |
| 69: <code>SEMU frame metadata &gt; drops a pts beyond 2^53 rather than losing precision</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |

## packages/ui/src/components/device/stream/serveEmu.test.ts

**1. independentSource:** Approved phase1 §§7/10.1; recorded hub frames; serve-emu JSON input and video-session protocol; WebCodecs AVC registration

**2. recognizableFailure:** Actual session configures/forwards recorded frames/PTS, gates stale deltas, resyncs keys, preserves input and closes/retries/errors correctly.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** WebSocket input/output, WebCodecs config/chunks, canvas/frame callbacks and DeviceVideoSession state

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Parser/mapping units cannot detect wrong session wiring, buffering/configuration epochs, input admission, reset or auth-close dispatch.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 40: <code>ServeEmuSession &gt; replays the recorded hub stream: configures from the SPS and decodes every frame in order</code> | REWRITE | Expected PTS are literal bytes transcribed from the redacted capture, not calculated by the production SEMU parser. Distinguishes configuring-queue versus configured delivery and keyframe recovery; real WebSocket/WebCodecs boundary fakes replace option injection. |
| 61: <code>ServeEmuSession &gt; decodes deltas with their SEMU pts once configured, and drops deltas before a keyframe</code> | REWRITE | Expected PTS are literal bytes transcribed from the redacted capture, not calculated by the production SEMU parser. Distinguishes configuring-queue versus configured delivery and keyframe recovery; real WebSocket/WebCodecs boundary fakes replace option injection. |
| 76: <code>ServeEmuSession &gt; rebuilds the decoder after a video-session message and asks for a keyframe</code> | REWRITE | Now asserts the externally submitted key/key sequence, no stale delta, successful painted frames and live state. Removes private decoder-instance/config-call inventories that could pass while a stale delta was decoded. |
| 93: <code>ServeEmuSession &gt; surfaces rejected input and unknown messages as warnings and ignores acks</code> | REWRITE | Removes application-authored warning prose/private decoder construction counts; preserves injected provider rejection, actual reset-video input, successful recovery on the same socket, network/auth error codes and reconnect/fatal-stop behavior. |
| 107: <code>ServeEmuSession &gt; sends serve-emu input JSON: touch, keys, buttons and chunked text</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 131: <code>ServeEmuSession &gt; fails fatally when the browser can&#x27;t decode the stream&#x27;s profile</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 141: <code>ServeEmuSession &gt; resyncs on a decoder error without dropping the connection</code> | REWRITE | Removes application-authored warning prose/private decoder construction counts; preserves injected provider rejection, actual reset-video input, successful recovery on the same socket, network/auth error codes and reconnect/fatal-stop behavior. |
| 156: <code>ServeEmuSession &gt; reconnects with backoff when the socket drops, and stops on a policy close</code> | REWRITE | Removes application-authored warning prose/private decoder construction counts; preserves injected provider rejection, actual reset-video input, successful recovery on the same socket, network/auth error codes and reconnect/fatal-stop behavior. |
| 171: <code>ServeEmuSession &gt; close() closes the socket and goes quiet</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 183: <code>ServeEmuSession &gt; input-only mode is live on open and never decodes</code> | CONSOLIDATE | Surviving actual input-only session owns the long quiet period/no-video-watchdog contract as well as live-on-open, no decode and accepted hardware input; no separate private ready test remains. |

## packages/ui/src/components/device/stream/serveSimH264.test.ts

**1. independentSource:** Approved phase1 §10.1; measured seed-only VM encoder failure; serve-sim avcc protocol; WebCodecs AVC registration

**2. recognizableFailure:** Seed-to-video ordering, known config/chunks, key gating, unsupported decode, body/decode failures and auth/close determine usable view/fallback.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** Fetched authenticated body, WebCodecs config/chunks, painted frames and session state

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Generic lifecycle/format units cannot detect transport-specific decode/fetch cleanup or fatal seed-only diagnosis required by hook fallback.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 64: <code>ServeSimH264Session &gt; paints the seed, then decodes video configured from the repaired avcC</code> | REWRITE | The expected zero-reorder avcC is a fixed known byte record rather than simulatorAvcConfig(description) from production. Preserves bearer headers, seed/video order, key/delta bytes and actual WebCodecs configuration; pure format tests own variant conversion while this owns forwarding to the decoder. |
| 97: <code>ServeSimH264Session &gt; never paints a late seed over decoded video, and gates deltas until a keyframe</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 109: <code>ServeSimH264Session &gt; ends with a fatal no-video error when the host only ever sends the seed (no H.264 encoder)</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 124: <code>ServeSimH264Session &gt; fails fatally when the browser can&#x27;t decode the profile</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 133: <code>ServeSimH264Session &gt; reconnects after the body ends or a decoder error, and stops on 401</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 156: <code>ServeSimH264Session &gt; close() aborts the request</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |

## packages/ui/src/components/device/stream/serveSimInput.test.ts

**1. independentSource:** Approved phase1 §10.1 input/control; serve-sim binary tags; daemon vphone bridge input protocol; USB HID keyboard page

**2. recognizableFailure:** No input before admission/while occupied; correct tagged touch/key/button/orientation/text; rotated coordinates, malformed configs, reconnect and auth close remain correct.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** Real WebSocket protocol bytes and ServeSimInputSocket ready/config outcomes

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Pure maps cannot detect tags/admission/config-routing/reconnect; direct inner-helper duplicates consolidate here.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 45: <code>ServeSimInputSocket &gt; sends nothing until serve-sim admits input, then tagged JSON</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 68: <code>ServeSimInputSocket &gt; exposes the screen config and maps touches into the raw portrait framebuffer when rotated</code> | CONSOLIDATE | Surviving socket owner observes literal 0x82 input and 0x03 output for all supported rotations, native-landscape passthrough and unreadable configs leaving valid mapping intact. Removes direct helper exports and helper-generated protocol fixtures. |
| 79: <code>ServeSimInputSocket &gt; stops sending while another client holds the simulator&#x27;s input</code> | REWRITE | Keeps input-ready/control gating, auth error code and actual admission/reconnect/no-send semantics; removes incidental English reason strings and injects only actual browser-global APIs. |
| 89: <code>ServeSimInputSocket &gt; types ASCII text as shifted HID keystrokes</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 107: <code>ServeSimInputSocket &gt; reconnects with backoff, waits to be admitted again, and stops on an auth close</code> | REWRITE | Keeps input-ready/control gating, auth error code and actual admission/reconnect/no-send semantics; removes incidental English reason strings and injects only actual browser-global APIs. |
| 125: <code>ServeSimInputSocket &gt; close() closes the socket and cancels a pending reconnect</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 135: <code>screen config helpers &gt; validates 0x82 payloads</code> | CONSOLIDATE | Moves unique wire/config/orientation assertions into the real input socket owner, eliminating unused direct parser/rotation exports. Null/no-config passthrough is already proved by the initial input-admission payload test. Surviving owner: packages/ui/src/components/device/stream/serveSimInput.test.ts: exposes the screen config and maps touches into the raw portrait framebuffer when rotated |
| 147: <code>screen config helpers &gt; rotates points only for a portrait framebuffer in another orientation</code> | CONSOLIDATE | Moves unique wire/config/orientation assertions into the real input socket owner, eliminating unused direct parser/rotation exports. Null/no-config passthrough is already proved by the initial input-admission payload test. Surviving owner: packages/ui/src/components/device/stream/serveSimInput.test.ts: exposes the screen config and maps touches into the raw portrait framebuffer when rotated |

## packages/ui/src/components/device/stream/serveSimMjpeg.test.ts

**1. independentSource:** Approved phase1 §10.1 fallback and measured VM MJPEG; serve-sim multipart protocol

**2. recognizableFailure:** Authenticated frame painting goes live, drops obsolete decoded/network backlog and retries nonmultipart response.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** Fetched multipart body/ImageBitmap/canvas/frame callbacks/session state

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Multipart parser has no decode queue/paint/response retry responsibility; both pending-decode and batch-read timing are retained in one owner.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 43: <code>ServeSimMjpegSession &gt; paints each part and reports live with the mjpeg decoder</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |
| 57: <code>ServeSimMjpegSession &gt; keeps only the newest frame while a decode is running</code> | CONSOLIDATE | Surviving latest-frame owner now also feeds several frames in one completed read. Proves both held decoder and batched network arrivals drop obsolete work and present exact intended newest ids using one session fixture. |
| 72: <code>ServeSimMjpegSession &gt; paints only the last of several parts that arrive in one read</code> | CONSOLIDATE | Batch-arrival latest-frame assertion moves into the held-decode owner after recovery; the same latency contract needs one session/fixture. Surviving owner: packages/ui/src/components/device/stream/serveSimMjpeg.test.ts: keeps only the newest frame while a decode is running |
| 81: <code>ServeSimMjpegSession &gt; retries a response that is not multipart</code> | KEEP | Independent protocol/state contract named by this case; its literal fixture/wire/state oracle detects this distinct failure at the lowest production-consumed seam. Adjacent layers exercise routing or different protocol variants, so none supersedes it. |

## packages/ui/src/components/device/stream/useDeviceStream.dom.test.ts

**1. independentSource:** Approved phase1 §§10.1/10.6: visible-only auto transport, input, fallback, retained canvas; auth header fix d5fad1f7

**2. recognizableFailure:** Mounted hook connects only enabled, forwards Android input and adapts iOS H264 seed-only failure to authenticated MJPEG plus working input.

**3. independentOracle:** Literal capture bytes, hardware constants, injected provider data, states, routes and timed arrivals; expectations are not computed by the parser/converter under test. Per-case rows identify rewritten or consolidated oracles.

**4. stableSeam:** Mounted production hook with browser APIs and actual session adapters

**5. refactorResistance:** Observe wire bytes, published action/state/stats values and actual browser API boundaries. Private helper names, authored warning prose, decoder instance counts and forced constructor overrides are not surviving oracles.

**6. uniqueProtection:** Pure session tests cannot detect hook selection/effect lifecycle/input routing. Missing-WebCodecs scenarios move to the existing screenshot process; direct helper inventories disappear.

| Remote line / exact test identity | Disposition | Evidence and surviving owner |
| --- | --- | --- |
| 93: <code>useDeviceStream &gt; streams Android over serve-emu while enabled and routes input through the same socket</code> | REWRITE | Mounts the hook against real platform-global detection and sessions; no forced transport/browserCaps/deps options. Keeps visibility shutdown, stable source canvas, input routing and authenticated adaptive fallback; removes self-derived URL expectations, exact warning prose and input instance counts. |
| 154: <code>useDeviceStream &gt; falls back to screenshots plus an input-only socket when the browser can&#x27;t decode H.264</code> | REWRITE | Moves unchanged meaningful fallback/error scenario into the existing screenshots.test.ts process, where the real page capability cache sees absent APIs. Shared minimal DOM fixture preserves actual automatic transport selection without any cache-reset or injected-capability production hook. Surviving owner: packages/ui/src/components/device/stream/screenshots.test.ts: falls back to screenshots plus an input-only socket when the browser can&#x27;t decode H.264 |
| 178: <code>useDeviceStream &gt; reports an error for Android without WebCodecs and no screenshot URL</code> | REWRITE | Moves unchanged meaningful fallback/error scenario into the existing screenshots.test.ts process, where the real page capability cache sees absent APIs. Shared minimal DOM fixture preserves actual automatic transport selection without any cache-reset or injected-capability production hook. Surviving owner: packages/ui/src/components/device/stream/screenshots.test.ts: reports an error for Android without WebCodecs and no screenshot URL |
| 185: <code>useDeviceStream &gt; switches iOS from H.264 to MJPEG when the host only sends the seed</code> | REWRITE | Mounts the hook against real platform-global detection and sessions; no forced transport/browserCaps/deps options. Keeps visibility shutdown, stable source canvas, input routing and authenticated adaptive fallback; removes self-derived URL expectations, exact warning prose and input instance counts. |
| 240: <code>URL helpers &gt; swaps the serve-sim stream file and keeps the query</code> | CONSOLIDATE | Direct URL-helper inventory duplicates the actual authenticated fallback request/socket owner, which now compares literal protocol URLs. The helpers are private and preserve their production algorithm. Surviving owner: packages/ui/src/components/device/stream/useDeviceStream.dom.test.ts: switches iOS from H.264 to MJPEG when the host only sends the seed |
| 245: <code>URL helpers &gt; sets and deletes query parameters on absolute and relative URLs</code> | CONSOLIDATE | Direct URL-helper inventory duplicates the actual authenticated fallback request/socket owner, which now compares literal protocol URLs. The helpers are private and preserve their production algorithm. Surviving owner: packages/ui/src/components/device/stream/screenshots.test.ts: falls back to screenshots plus an input-only socket when the browser can&#x27;t decode H.264 |

## Removed source seams

- `packages/ui/src/components/device/stream/screenshots.ts:SCREENSHOT_INTERVAL_MS`
- `packages/ui/src/components/device/stream/screenshots.ts:ScreenshotPollOptions`
- `packages/ui/src/components/device/stream/semu.ts:SEMU_MAGIC`
- `packages/ui/src/components/device/stream/semu.ts:SEMU_V1_HEADER_BYTES`
- `packages/ui/src/components/device/stream/semu.ts:SEMU_V2_HEADER_BYTES`
- `packages/ui/src/components/device/stream/avcc.ts:MAX_AVCC_ENVELOPE_BYTES`
- `packages/ui/src/components/device/stream/decoder.ts:SOFT_DECODE_QUEUE`
- `packages/ui/src/components/device/stream/keymap.ts:hidUsageForCode`
- `packages/ui/src/components/device/stream/keymap.ts:hidStrokeForChar`
- `packages/ui/src/components/device/stream/keymap.ts:ANDROID_KEYCODE_BY_CODE`
- `packages/ui/src/components/device/stream/keymap.ts:androidKeycodeForCode`
- `packages/ui/src/components/device/stream/keymap.ts:androidMetaState`
- `packages/ui/src/components/device/stream/keymap.ts:ANDROID_MAX_TEXT_BYTES`
- `packages/ui/src/components/device/stream/keymap.ts:ANDROID_MAX_TEXT_CHUNKS`
- `packages/ui/src/components/device/stream/capabilities.ts:NO_BROWSER_CAPS`
- `packages/ui/src/components/device/stream/mjpeg.ts:MAX_MJPEG_PART_BYTES`
- `packages/ui/src/components/device/stream/useDeviceStream.ts:serveSimStreamUrl`
- `packages/ui/src/components/device/stream/useDeviceStream.ts:withQueryParams`
- `packages/ui/src/components/device/stream/lifecycle.ts:DEFAULT_STALL_MS`
- `packages/ui/src/components/device/stream/lifecycle.ts:DEFAULT_RECONNECT_AFTER_MS`
- `packages/ui/src/components/device/stream/lifecycle.ts:ERROR_AFTER_FAILURES`
- `packages/ui/src/components/device/stream/lifecycle.ts:RateMeter`
- `packages/ui/src/components/device/stream/serveSimInput.ts:IOS_MSG_TOUCH`
- `packages/ui/src/components/device/stream/serveSimInput.ts:IOS_MSG_BUTTON`
- `packages/ui/src/components/device/stream/serveSimInput.ts:IOS_MSG_KEY`
- `packages/ui/src/components/device/stream/serveSimInput.ts:IOS_MSG_ORIENTATION`
- `packages/ui/src/components/device/stream/serveSimInput.ts:IOS_TAG_SCREEN_CONFIG`
- `packages/ui/src/components/device/stream/serveSimInput.ts:IOS_TAG_INPUT_ADMITTED`
- `packages/ui/src/components/device/stream/serveSimInput.ts:taggedJson`
- `packages/ui/src/components/device/stream/serveSimInput.ts:parseScreenConfig`
- `packages/ui/src/components/device/stream/serveSimInput.ts:rawSimulatorPoint`
- `packages/ui/src/components/device/stream/serveSimH264.ts:H264_FIRST_FRAME_MS`
- `packages/ui/src/components/device/stream/types.ts:StreamDeps`
- `packages/ui/src/components/device/stream/types.ts:resolveDeps`

- UseDeviceStreamOptions: deps, browserCaps, unused forced transport
- VideoSessionOptions: deps, unused stall/reconnect overrides
- StreamDeps and resolveDeps wrapper
- Session/decoder dependency options and stored adapters
- capabilities optional constructors and uncached test bypass
- Lifecycle now/random/backoff and RateMeter clock/window injection
- PointerThrottle frame function injection and unused flush member
- chunkText optional byte/count limits
- ScreenshotPollOptions interval/method override
- SemuPacket unused version/serverTimeMs; StreamAttempt unused id; private requestKeyframe

## Validation

Read-only TypeScript syntax inspection reports zero parser diagnostics; scoped `git diff --check` passes. The executed focused checks and matched file benchmarks are recorded below; affected typechecks/build/changed/full gates remain root-owned. Source is frozen.

Focused command from `packages/ui` when granted:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-timeout=600000 --test-concurrency=4 src/components/device/stream/avcConfig.test.ts src/components/device/stream/avcc.test.ts src/components/device/stream/capabilities.test.ts src/components/device/stream/h264.test.ts src/components/device/stream/keymap.test.ts src/components/device/stream/lifecycle.test.ts src/components/device/stream/mjpeg.test.ts src/components/device/stream/pointer.test.ts src/components/device/stream/screenshots.test.ts src/components/device/stream/semu.test.ts src/components/device/stream/serveEmu.test.ts src/components/device/stream/serveSimH264.test.ts src/components/device/stream/serveSimInput.test.ts src/components/device/stream/serveSimMjpeg.test.ts src/components/device/stream/useDeviceStream.dom.test.ts
```

## Executed focused validation and measured optimization

Root granted one exclusive slot. The entire surviving stream/state/fleet target passed **122/122** tests (runner duration 5.585 s), with no skipped tests or product failures. An independent reviewer identified a vacuous oversized-paste prefix oracle; adding `chunks.length > 0` retained the protocol queue bound and the focused keymap rerun passed **5/5**. A prior root-cwd keymap command exited before loading tests because the package-relative path did not exist there; the corrected package-cwd run passed.

Exact commands, from `packages/ui`:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-reporter=/tmp/orquester-test-audit/reporter.mjs --test-timeout=600000 --test-concurrency=4 src/components/device/stream/*.test.ts src/lib/devices/*.test.ts src/components/devices-fleet/*.test.ts
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-reporter=/tmp/orquester-test-audit/reporter.mjs --test-timeout=600000 --test-concurrency=4 src/components/device/stream/keymap.test.ts
```

Three alternating matched before/after runs of the complete MJPEG file each passed all nine tests. Node v24.22.1, four logical CPUs, runner concurrency 4, unchanged dependencies and `TSX_DISABLE_CACHE=1`; only one test process ran at a time. Before used the untouched 610d reference worktree; after used the frozen main source. Process wall times include startup.

| Pair | Before wall seconds | After wall seconds |
| --- | ---: | ---: |
| 1 | 0.576260 | 0.460048 |
| 2 | 0.581540 | 0.467557 |
| 3 | 0.591762 | 0.480222 |

Median wall time **0.581540 → 0.467557 s**, saving **0.113983 s (19.60%)**. Median user CPU 0.64→0.47 s; median peak RSS 162,484→145,632 KiB. Slowest before/after case remains all-byte MJPEG splitting: 150.632→65.355 ms median; no-length delimiter splits 47.161→31.847 ms; large-frame byte/reuse scenario 42.205→39.063 ms. These are file-level results; whole-suite and CI impact are not extrapolated.

The same exact Node runner arguments above targeted `src/components/device/stream/mjpeg.test.ts` from each worktree for each pair. Full command strings, process resources, per-case timings and environment are in `/tmp/orquester-test-audit/devices-stream-profile.json`.

Three isolated copied-source mutants prove the intended remaining oracles:

- Discard a partial multipart delimiter: all-byte split case fails at split 1 because the first frame is missing.
- Truncate a declared part by one byte: large-frame case fails with 399,999 actual versus 400,000 expected bytes.
- Return no chunks only for oversized pastes: truncation case fails the explicit useful-prefix assertion.

All three exited 1 for `ERR_ASSERTION`, rather than unrelated import/setup errors. Hashes of every live stream source/test/helper file matched before and after all profiling/mutants; only isolated copies were mutated. Raw logs remain under `/tmp/orquester-test-audit/devices-*-mutant-*.log`.

Independent source review found no additional concrete blockers. Scoped diff check passes. Full typechecks/build/changed/full suites remain root-controlled; this report does not claim those gates ran.

## Typecheck followup

The root diagnostic `pnpm check` found that the Blob-only ImageBitmap fixture was narrower than the browser's overloaded `createImageBitmap(ImageBitmapSource, …)` function type. The fixture now exposes the explicit platform-function type at its returned installation boundary. Its Blob implementation and every production call remain unchanged; no production cast or extra behavior was added. The root will rerun typechecking and final gates. No additional test or typecheck was executed by this agent for this type-only fixture correction.
