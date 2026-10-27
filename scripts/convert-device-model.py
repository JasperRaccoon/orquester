# Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): scripts/convert-device-model.py
# Run with Blender 4.5.9:
# blender --background --python scripts/convert-device-model.py -- <model-id> <source> <output.glb>
# The source is Apple's USDZ or a glTF/GLB (Draco decoded by Blender's glTF importer).
# Then optimize using @gltf-transform/cli 4.2.1 with --compress false --simplify false
# --join false --palette false --flatten false --texture-size 1024 --texture-compress webp,
# then `gltf-transform meshopt <in> <out> --level medium` (single-body models and fold rigs;
# the iPhone Duo keeps float geometry).
#
# Single-body models get one `device-screen` mesh: its UVs give the front and portrait axes, it is
# centred, 2.2 units tall, faces +Z and has a black placeholder material.
# Models with a `fold` entry are normalized the same way on their inner display, then split at the
# hinge into two halves whose origins lie on the hinge axis, a little in front of the inner
# display: `left-half`/`right-half` (vertical, book-style hinge) or `bottom-half`/`top-half`
# (horizontal, clamshell hinge). The half carrying the cover display folds; the other stays put.
# Displays become `cover-display` and `inner-display-<side>`; the hinge spine is a `hinge` group
# on the same axis that turns by half the fold.
import hashlib
import json
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

model_id, source, output = sys.argv[sys.argv.index("--") + 1 :]
manifest_path = (
    Path(__file__).resolve().parents[1]
    / "packages/ui/src/components/device/models/sources.json"
)
manifest = json.loads(manifest_path.read_text())
model = next(m for m in manifest["models"] if m["id"] == model_id)
if hashlib.sha256(Path(source).read_bytes()).hexdigest() != model["sourceSha256"]:
    raise ValueError("Source checksum differs from the recorded source asset")
author = model.get("author", manifest["author"])
fold = model.get("fold")
screen_name = fold["innerNode"] if fold else model["screenNode"]
bpy.ops.wm.read_factory_settings(use_empty=True)
if Path(source).suffix.lower() in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=source)
else:
    bpy.ops.wm.usd_import(filepath=source, import_materials=True)
if "bodyNode" in model:
    body = bpy.data.objects[model.get("accessoryNode", model["bodyNode"])]
    objects = [o for o in body.children_recursive if o.type == "MESH"]
    if body.type == "MESH":
        objects.append(body)
else:
    # Samsung's glTF sources are one device per file, flat: every mesh belongs to it.
    objects = [o for o in bpy.data.objects if o.type == "MESH"]
screen = bpy.data.objects[screen_name]
uv = screen.data.uv_layers.active
points = []
coords = []
for loop in screen.data.loops:
    points.append(
        tuple(screen.matrix_world @ screen.data.vertices[loop.vertex_index].co)
    )
    coords.append((*uv.data[loop.index].uv, 1))
coef = np.linalg.lstsq(np.array(coords), np.array(points), rcond=None)[0]
right = Vector(coef[0]).normalized()
up = Vector(coef[1]).normalized()
normal = right.cross(up).normalized()
# The authored UVs establish the device's front and its physical portrait axes.
# No body proportions are changed. The runtime uses a standard planar framebuffer UV.
rot = Matrix((right, up, normal)).to_4x4()
world = [rot @ Vector(p) for p in points]
lo = Vector(tuple(min(p[i] for p in world) for i in range(3)))
hi = Vector(tuple(max(p[i] for p in world) for i in range(3)))
center = (lo + hi) / 2
scale = 2.2 / (hi.y - lo.y)
transform = (
    Matrix.Translation(Vector((0, 0, 0.043)))
    @ Matrix.Diagonal(Vector((scale, scale, scale, 1)))
    @ Matrix.Translation(-center)
    @ rot
)
for o in objects:
    matrix = transform @ o.matrix_world
    o.parent = None
    o.matrix_world = Matrix.Identity(4)
    o.data.transform(matrix)


def black(name):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (0, 0, 0, 1)
    return mat


def bounds(o, axis):
    values = [v.co[axis] for v in o.data.vertices]
    return min(values), max(values)


rig = {}
if fold:
    # Canonical frame here: +X right, +Y up, +Z out of the inner display.
    vertical = fold["hinge"] == "vertical"
    across = 0 if vertical else 1
    low_side, high_side = ("left", "right") if vertical else ("bottom", "top")
    spine = [bpy.data.objects[name] for name in fold["spineNodes"]]
    spine_lo = min(bounds(o, across)[0] for o in spine)
    spine_hi = max(bounds(o, across)[1] for o in spine)
    hinge_at = (spine_lo + spine_hi) / 2
    tolerance = 0.002
    sides = {low_side: [], high_side: []}
    whole = []
    collection = bpy.context.scene.collection
    for o in [o for o in objects if o not in spine]:
        o_lo, o_hi = bounds(o, across)
        if o_hi <= hinge_at + tolerance:
            sides[low_side].append(o)
            whole.append(o)
        elif o_lo >= hinge_at - tolerance:
            sides[high_side].append(o)
            whole.append(o)
        else:
            # Straddles the hinge (the inner display and its bezel): cut it in two.
            for side, keep_low in ((low_side, True), (high_side, False)):
                part = o.copy()
                part.data = o.data.copy()
                part.name = f"{o.name}_{side}"
                collection.objects.link(part)
                mesh = bmesh.new()
                mesh.from_mesh(part.data)
                plane = Vector((0, 0, 0))
                plane[across] = hinge_at
                bmesh.ops.bisect_plane(
                    mesh,
                    geom=mesh.verts[:] + mesh.edges[:] + mesh.faces[:],
                    plane_co=plane,
                    plane_no=Vector((1, 0, 0)) if vertical else Vector((0, 1, 0)),
                    clear_outer=keep_low,
                    clear_inner=not keep_low,
                )
                mesh.to_mesh(part.data)
                mesh.free()
                sides[side].append(part)
            if o == screen:
                screen = None
            bpy.data.objects.remove(o, do_unlink=True)
    objects = spine + sides[low_side] + sides[high_side]
    cover = bpy.data.objects[fold["coverNode"]]
    moving = low_side if cover in sides[low_side] else high_side
    # The halves' frames close onto each other with a hair of clearance. Parts cut at the hinge
    # (hinge links that stand proud of the frame) end up inside the closed device.
    front = max(bounds(o, 2)[1] for o in whole)
    pivot = Vector((0, 0, front + fold.get("clearance", 0.002) / 2))
    pivot[across] = hinge_at
    for side in (low_side, high_side):
        inner = next(o for o in sides[side] if o.name == f"{screen_name}_{side}")
        inner.name = inner.data.name = f"inner-display-{side}"
        inner.data.materials.clear()
        inner.data.materials.append(black(inner.name))
    cover.name = cover.data.name = "cover-display"
    cover.data.materials.clear()
    cover.data.materials.append(black("cover-display"))
    rig = {f"{low_side}-half": sides[low_side], f"{high_side}-half": sides[high_side], "hinge": spine}
    hinge_metrics = {
        "hinge": fold["hinge"],
        "moving": f"{moving}-half",
        "pivot": [round(c, 5) for c in pivot],
        "width": max(bounds(o, 0)[1] for o in objects) - min(bounds(o, 0)[0] for o in objects),
    }
for o in objects:
    # Blender is Z-up; glTF export converts to Y-up. Store canonical Y-up geometry as Blender Z-up.
    o.data.transform(Matrix.Rotation(np.pi / 2, 4, "X"))
    # Coincident, differently tessellated layers z-fight in rasterizers; recessing the
    # lower layers by a hair (scene units) keeps the authored stacking order. The origin
    # lies inside the body, so it decides whether the authored normals face outward.
    depth = model.get("recessNodes", {}).get(o.name)
    if depth:
        normals = [v.normal.copy() for v in o.data.vertices]
        if sum(n.dot(v.co) for n, v in zip(normals, o.data.vertices)) < 0:
            depth = -depth
        for n, v in zip(normals, o.data.vertices):
            v.co -= n * depth
    if not fold and o == screen:
        o.name = "device-screen"
        o.data.name = "device-screen"
        for loop in o.data.loops:
            p = o.data.vertices[loop.vertex_index].co
            uv.data[loop.index].uv = (
                (p.x / ((hi.x - lo.x) * scale)) + 0.5,
                p.z / 2.2 + 0.5,
            )
        # This material is replaced by the viewer and must not retain the marketing screenshot.
        o.data.materials.clear()
        o.data.materials.append(black("device-screen"))
groups = []
for name, members in rig.items():
    group = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(group)
    group.location = Matrix.Rotation(np.pi / 2, 4, "X") @ pivot
    bpy.context.view_layer.update()
    for o in members:
        o.parent = group
        o.matrix_parent_inverse = group.matrix_world.inverted()
    groups.append(group)
for o in list(bpy.data.objects):
    if o not in objects and o not in groups:
        bpy.data.objects.remove(o, do_unlink=True)
for image in bpy.data.images:
    if image.size[0] > 1024 or image.size[1] > 1024:
        k = 1024 / max(image.size)
        image.scale(max(1, round(image.size[0] * k)), max(1, round(image.size[1] * k)))
for o in objects + groups:
    o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=output,
    export_format="GLB",
    use_selection=True,
    export_yup=True,
    export_animations=False,
    export_extras=False,
    export_image_format="AUTO",
    export_copyright=f"{author} Original device assets; see models/sources.json for provenance.",
)
print(
    "MODEL_METRICS",
    json.dumps(
        {
            "width": (hi.x - lo.x) * scale,
            "height": 2.2,
            "bodyMeshes": len(objects),
            "screen": screen.name if screen else None,
            "source": source,
            **({"fold": hinge_metrics} if fold else {}),
        }
    ),
)
