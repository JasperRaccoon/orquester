# Device frames (3D and flat)

`DeviceViewport` shows a live device screen inside a realistic 3D device (three.js, loaded on
first use) or a flat 2D bezel. Ported from T3 Code (MIT); see `docs/THIRD_PARTY_NOTICES.md`.

```tsx
const view = useRef<DeviceViewportHandle>(null);
// after the decoder draws a frame into `canvas`:
view.current?.notifyFrame();

<div className="relative h-full">
  <DeviceViewport
    ref={view}
    source={canvas}                 // HTMLCanvasElement the decoder draws into, or null
    platform="ios"                  // "ios" | "android"
    deviceName="iPhone 17"          // simulator / emulator device name
    profileName="iphone-17"         // optional; second chance for a model match
    screen={{ width: 1206, height: 2622 }} // raw frame size the stream reports, or null
    orientation="portrait"          // portrait | portrait_upside_down | landscape_left | landscape_right
    mode={preferred}                // "3d" | "flat" — what the user asked for
    onTouch={(phase, x, y) => send(phase, x, y)}
    onModeUnavailable={(reason) => showFlatWithHint(reason.message)}
    keyboardAttached={false}        // optional; Magic Keyboard on the iPad Pro 13-inch model
    foldAngle={null}                // optional; Android foldables, 0 (closed)..180 (open)
    duo={undefined}                 // optional; iPhone Duo binding (see DeviceDuoViewport.tsx)
    subscribeTrackpadScrollEnd={undefined} // optional; desktop shells that see a scroll's end
  />
</div>
```

The viewport fills its positioned parent and measures it itself.

## Props

- `source` — the stream canvas. In 3D it is a texture (not in the DOM). In flat mode the
  viewport **appends the canvas into its own DOM** (no per-frame copy) and removes it when it
  unmounts or switches to 3D; don't attach the same canvas elsewhere at the same time. Size the
  canvas to the frame on the first frame (a fresh canvas is 300×150).
- `screen` — the frame size in device pixels as the stream reports it (serve-sim reports the raw
  portrait framebuffer even in landscape). Until it is known, the canvas size is used.
- `orientation` — the device's reported interface orientation. The body turns with it; an iOS
  portrait framebuffer is rotated into a landscape screen (as serve-sim streams it), an Android
  emulator's already-rotated framebuffer is shown as is.
- `onTouch(phase, x, y)` — `phase` is `begin | move | end`; `x`, `y` are 0..1 over the screen
  **as the user sees it, in its current orientation** (top-left is 0,0), the same in 3D and flat.
  A press must start on the screen; a held touch clamps to the edges. In 3D, dragging outside the
  screen (or Alt-drag, or a two-finger scroll) turns the device instead.
- `mode` / `onModeUnavailable` — 3D falls back to flat when WebGL 2 is missing
  (`webgl-unavailable`), three.js or the viewer fails to load (`load-failed`), the WebGL context
  is lost or a render throws (`render-failed`), or an iPhone Duo has no hinge-reporting `duo`
  binding (`duo-unsupported`). The callback gets `{ code, message }` once per new reason; the
  failure clears when `mode` or `source` changes. The caller owns the per-device preference.
- `duo` — `DeviceDuoBinding`: the full screen report (`screenId`, `hingeAngle`, `hingePose`,
  `supportsHingeAngle`, …), `hingePreview`, `onRawTouch`, `onCommand(DuoCommand)`,
  `setPanels(DuoPanelSinks | null)` for per-panel video, and `onControlRejectedListener`.

## Ref (`DeviceViewportHandle`)

- `notifyFrame()` — a new frame is in `source`; schedules one 3D render (or resyncs the flat
  layout when the canvas size changed). Cheap to call per frame.
- `resetView()` — turn the 3D device back to face the viewer.
- `cancelInput()` — end any touch or gesture in progress (focus loss, control handover).

Pointer presses focus the closest `[data-device-view]` ancestor, so give the panel root that
attribute and a `tabIndex` for keyboard input.

## Models

`../models/` holds Apple's AR device models and Samsung's product-viewer GLBs converted with
`scripts/convert-device-model.py`; `sources.json` records each author, source URL, SHA-256, nodes
and tools. `model.ts` maps simulator device names, and Android emulator names and `orq-` AVD
profile names (Galaxy S26/S26+/S26 Ultra/Z Fold8/Z Flip8), whole and case-insensitively, to model
ids; any other name (Pixels included) gets a procedural body from `shapeProfile.ts`.
`../models/registry.ts` turns ids into Vite asset URLs and is imported only lazily, with three.js,
so Node tests never load a `?url` import. A model that fails to load leaves the procedural body in
place.

Foldable models (Z Fold8, Z Flip8) are hinge rigs shown by `foldModelScene.ts` with the `foldAngle`
prop (open when it is null): `left-half`/`right-half` (vertical hinge) or `bottom-half`/`top-half`
(horizontal hinge) groups with their origins on the hinge axis, a `cover-display` on the half that
folds, `inner-display-<side>` on each half and an optional `hinge` spine group. Like the procedural
fold, one framebuffer shows on the inner pair past 90 degrees and on the cover below it. The iPhone
Duo keeps its own two-panel rig (`duoScene.ts`).

Single-body models and fold rigs are meshopt-compressed (`MeshoptDecoder` is registered in
`modelScene.ts`); the Duo keeps its float rig because its hinge and display UVs are derived from
per-mesh local coordinates. Textures are decoded through `<img>` because the web CSP does not allow
`fetch` of `blob:` URLs.

To add a model: add a `sources.json` entry (id, file, sourceUrl, sourceSha256, and bodyNode +
screenNode for a USDZ, screenNode alone for a one-device glTF, or a `fold` block with hinge,
innerNode, coverNode and spineNodes for a foldable; `author` when not Apple), run the script with
Blender 4.5, optimize with `@gltf-transform/cli` (see the script header), add the id and name
pattern to `model.ts`, the URL to `../models/registry.ts`, and a case to `modelMatch.test.ts`.
