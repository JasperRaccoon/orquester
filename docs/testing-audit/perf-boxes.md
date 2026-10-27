# Incoming native box-fixture cleanup

Implemented incoming ee5 boxes test-helper cleanup: four exact incoming declarations deleted,95test LOC removed; unused spawnTar option removed while actual native extraction fix remains. No baseline or surviving-owner count is added.

The local BoxConnection adapter has no application runtime consumer. Non-test filenames importing it are test fixtures or manually invoked integration programs; application main code uses real socket connections. The new `spawnTar` override was used only by the four deleted helper tests.

The native writeTar repair remains: spawn and exit errors are handled, the source drains past early extractor EOF, and producer failure terminates extraction. Only the injected spawn hook was removed.

## Exact incoming dispositions

- `apps/daemon/src/boxes/testing.test.ts:38` — **DELETE** local tar writes drain the source when a successful extractor closes stdin before source EOF. The fake extractor accepts invalid archive bytes, destroys its writable stream, emits exit0 and explicitly ends the source with padding. Asserting byte count7 and readableEnded only proves the arranged fake lifecycle; no real tar or user-visible downloaded/uploaded artifact is checked. Independent contract, stable product seam and unique protection fail; fake implements the successful extraction being assumed.
- `apps/daemon/src/boxes/testing.test.ts:49` — **DELETE** local tar writes reject an extractor failure even when its stdin closed early. The fake emits a chosen exit2 and the helper rejects with its test-only message. No production caller uses this helper, and the application wire/native archive refusal is protected at actual Go-agent/public tool boundaries. Stable product seam and unique protection fail; exact helper failure prose is not a user protocol contract.
- `apps/daemon/src/boxes/testing.test.ts:58` — **DELETE** local tar writes preserve source failures and stop the extractor. The test mutates a stopped boolean in its fake kill method, emits exit itself, and compares the exact arranged error object. It cannot establish that a native subprocess was terminated or that a user transfer remained atomic. Independent product contract, stable seam/refactor resistance and unique protection fail; collaborator-shape/boolean kill illusion is weaker than real termination/transfer artifacts.
- `apps/daemon/src/boxes/testing.test.ts:81` — **DELETE** local tar writes propagate extractor spawn failures. The injected spawn function returns a handmade EventEmitter and emits the exact expected error object on a microtask. This verifies private test-helper forwarding and requires a new spawnTar seam with no runtime caller. Independent product contract, stable seam and unique protection fail; dead-seam helper test.

## Remaining native owners

- `apps/daemon/src/boxes/temporary/tools.test.ts` — download: tar can close its input before the box finishes; the entire source still decides success. Real native tar plus closure receipt verifies exact file artifact/byte count, late source failure, cancellation,4GiB cap and nonzero extractor status. This is the stronger public user-transfer owner, not proof of every local helper call shape.
- `apps/daemon/src/boxes/hub/agent.integration.test.ts` — tar both ways. Actual Go/TypeScript box protocol + native tar verifies file/link/mode content, excluding filtered files, missing path refusal and a truncated gzipped source failure.
- `apps/daemon/src/boxes/sync/config-sync.test.ts` — a big first sync goes as one gzipped tar per root: modes kept, baseline right, a second pass sends and hashes nothing. Existing public sync integration naturally exercises the repaired native local writeTar fixture using actual valid archives and real filesystem outcomes.
- `apps/daemon/src/devices/hosts/box/remote.test.ts` — execRemote collects output, reports exit codes and times out. Actual native subprocess exit receipts prove timeout and caller cancellation terminate children; a fake kill boolean is not retained as a duplicate assertion of native termination.

All six retention requirements for those existing native owners are recorded in [perf-boxes.json](perf-boxes.json); they are references, not additional test counts. The deleted file removes95test lines plus2source lines for the unused option; no fixture files, snapshots or dependencies were added.

## Validation

Scoped diff check, retained-file syntax parse and orphan-reference check passed. No tests, typecheck, build or timing runs were performed during the parent’s matching baseline. Native public tar/sync/Go/abort targets and full gates remain root-owned. No performance improvement is claimed. No staging or commit performed.
