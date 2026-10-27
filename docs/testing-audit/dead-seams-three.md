# Three quantization dead export

This final follow-up supersedes exactly one `devices-three` REWRITE row and its intermediate-title alias. Count the original case once:

| Path / original610d identity | Final disposition | Surviving owner |
| --- | --- | --- |
| `packages/ui/src/components/device/three/modelScene.test.ts:82` — bakes a meshopt-quantized display's node transform back into float geometry | CONSOLIDATE | Existing public `modelAssets.test.ts` deployed-asset loading cases |

The removed intermediate title was “preserves normalized screen coordinates when loading a meshopt-quantized display”. No new test or fixture was added. Follow-up test LOC **−34**; resulting entire three subtree is **74→49 runtime cases**, **50→34 declarations**, **1634→1154 test LOC (−480)**. Final original-case outcomes: DELETE16, REWRITE29, CONSOLIDATE9, KEEP20. Existing asset cases are referenced as owners, not counted a second time.

## Public owner proof

An external loader skipped normalized Int16-to-Float32 attribute conversion before applying the model node transform, recreating the historical corruption. **11 existing slab GLB cases failed with `Device model display is not normalized`**. Accessory, unquantized Duo and two fold rigs passed, so the failures were specific to the affected normalized device-screen path. The mutant supplied no mock geometry and did not touch production source.

This evidence makes the private helper case redundant. Removed its test-only import and made `bakeDisplayTransform` private; `loadDeviceModel` in the same file still calls it. No external production caller needs the export. The pre-export-removal source hash is reconstructed exactly by adding that keyword back, confirming that the only intentional production change was export removal. Hashes are recorded in JSON.

## Six-bar evidence of surviving owners

- **B1_independentContract**: Phase1core§10.4 requires shipped GLBs to load with meshopt; converter header defines centred2.2-unit +Z device-screen format. These actual deployed binaries must construct a usable scene.
- **B2_realRegression**: Skipping conversion of normalized Int16 vertex attributes before the node transform corrupts display bounds; the public loader+scene test fails for11actual slab GLBs with Device model display is not normalized.
- **B3_independentOracle**: Actual committed binary assets and the independently documented converter format determine successful scene construction. Tests use production loadDeviceModel, not a separately configured loader or geometry-returning mock. Only native fetch/image decoding is isolated.
- **B4_stableSeam**: loadDeviceModel followed by createImportedPhoneScene, exactly the production phoneViewer loading/installation path.
- **B5_refactorResistance**: No dependency on bakeDisplayTransform export/name, buffer class or internal transform loop. Asset acceptance and required serialized display format remain valid if normalization moves or is rewritten.
- **B6_uniqueProtection**: Each asset file remains its own deployed-binary compatibility owner; together they also catch the concrete historical conversion omission, so the private helper test adds no necessary regression protection.

Affected public asset owners: `loads iphone-18-pro.glb into its viewer scene`, `loads iphone-18-pro-max.glb into its viewer scene`, `loads ipad-pro-13-m5.glb into its viewer scene`, `loads iphone-17.glb into its viewer scene`, `loads iphone-air.glb into its viewer scene`, `loads iphone-17e.glb into its viewer scene`, `loads ipad-air.glb into its viewer scene`, `loads ipad-a16.glb into its viewer scene`, `loads galaxy-s26.glb into its viewer scene`, `loads galaxy-s26-plus.glb into its viewer scene`, `loads galaxy-s26-ultra.glb into its viewer scene`.

## Validation

From `packages/ui`, the mutation command was:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --import /tmp/orquester-test-audit/three-quantization-mutation-loader.mjs --test --test-timeout=600000 --test-concurrency=4 src/components/device/three/modelAssets.test.ts
```

Expected failure:11affected asset cases, correct normalization errors. Initial loader matching failed because transpilation removed parentheses; after correcting the harness, the intended corruption reached the real scene validator. No product failure was inferred from the initial harness failure.

After consolidation, the normal command was:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-timeout=600000 --test-concurrency=4 src/components/device/three/modelAssets.test.ts src/components/device/three/modelScene.test.ts
```

**17/17 passed**, runner wall **747.928 ms**. `git diff --check` passed. Logs: `/tmp/orquester-test-audit/dead-seams-three-quantization-mutant.log` and `dead-seams-three-focused.log`. Root owns full compile/test gates. No isolated before/after speedup is claimed.
