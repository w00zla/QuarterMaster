# Rendert Items als Icon: Bounding-Box-Fit, Pose und Licht-Rig des Spiels, transparenter Hintergrund.
# Läuft nur in Blenders eigenem Python (kein System-Python), gestartet von src/icons/cli.ts:
#   blender -b --python src/icons/render.py -- --jobs <jobs.json>          (Batch, ein Blender-Prozess)
#   blender -b --python src/icons/render.py -- <in.glb|scene.blend> <out.png> [--pose 90,125,5] [--rig rig.json]
# Eingabe: ein GLB (StarBreaker bundled) oder die scene.blend eines decomposed-Exports (das StarBreaker-Addon
# baut dann die Materialien auf). Pose = defaultOrientation + Kategorie-Offset des Spiels (Grad, Euler XYZ):
# das Modell wird so gedreht, die Zelle ist dann Y-up mit Kamera auf -Z und Bild-oben = -Y. Ohne Pose:
# Kamera aus --az/--el (Grad um Z, 0 = Kamera auf -X; Höhe über der Horizontalen) und drei Sonnen.
import argparse
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Matrix, Vector


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('src', nargs='?', type=os.path.abspath)
    p.add_argument('out', nargs='?', type=os.path.abspath)
    p.add_argument('--jobs', type=os.path.abspath, help='JSON-Liste von {src, out, pose, rig, size}')
    p.add_argument('--size', type=int, default=512)
    p.add_argument('--pose', type=lambda s: [float(x) for x in s.split(',')], default=None)
    p.add_argument('--rig', type=os.path.abspath, default=None, help='Licht-Rig des Spiels (JSON aus der CLI)')
    p.add_argument('--light-scale', type=float, default=30.0, help='Watt je Spiel-Intensität')
    p.add_argument('--fit', type=float, default=0.7, help='Pose-Modus: größte Box-Kante in m, auf die das Item skaliert wird')
    p.add_argument('--mirror', action='store_true', help='Kamera auf +Z statt -Z (Bild spiegeln)')
    p.add_argument('--az', type=float, default=20.0)
    p.add_argument('--el', type=float, default=15.0)
    p.add_argument('--margin', type=float, default=1.06)
    p.add_argument('--samples', type=int, default=16)
    return p.parse_args(argv)


def load(path):
    if path.lower().endswith('.blend'):
        # StarBreaker decomposed: scene.blend öffnen, Materialien vom Addon aufbauen lassen (der
        # Load-Handler des Addons läuft über Timer, die es im Hintergrundmodus nicht gibt)
        bpy.ops.wm.open_mainfile(filepath=path)
        for root in [o for o in bpy.data.objects if any('package_root' in k for k in o.keys())]:
            bpy.ops.starbreaker.refresh_materials(package_root_name=root.name)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)  # deaktiviert Addons, daher nur hier
        bpy.ops.import_scene.gltf(filepath=path)
    return bpy.context.scene


def mesh_corners(objects):
    for o in objects:
        if o.type != 'MESH' or not o.data.vertices:
            continue
        for c in o.bound_box:
            yield o.matrix_world @ Vector(c)


def render(job, a):
    src, out = job['src'], job['out']
    pose, rig, size = job.get('pose'), job.get('rig'), job.get('size', a.size)
    scene = load(src)

    if pose:
        # Pose des Spiels: alles unter ein Empty mit Euler XYZ hängen, Kamera auf -Z, Bild-oben = -Y
        holder = bpy.data.objects.new('icon_pose', None)
        scene.collection.objects.link(holder)
        holder.rotation_mode = 'XYZ'
        holder.rotation_euler = [math.radians(v) for v in pose]
        for o in [o for o in scene.objects if o.parent is None and o is not holder]:
            o.parent = holder
        direction = Vector((0.0, 0.0, 1.0 if a.mirror else -1.0))
        cam_rot = (0.0, 0.0, math.pi) if a.mirror else (math.pi, 0.0, 0.0)
    else:
        az, el = math.radians(a.az), math.radians(a.el)
        direction = Vector((-math.cos(el) * math.cos(az), -math.cos(el) * math.sin(az), math.sin(el)))
        cam_rot = direction.to_track_quat('Z', 'Y').to_euler()
    bpy.context.view_layer.update()

    def bounds():
        corners = list(mesh_corners(scene.objects))
        if not corners:
            raise RuntimeError('keine Meshes in der Szene')
        lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
        hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
        return corners, lo, hi

    corners, lo, hi = bounds()
    if pose and a.fit > 0:
        # Das Spiel skaliert das Item in die Zelle; das Rig (Lichter ~1 m vom Zentrum, Radius 2-3 m) ist
        # dafür ausgelegt. Ein 3 m großer Kühler hätte die Lichter sonst im Modell.
        holder.scale = [a.fit / max((hi - lo).x, (hi - lo).y, (hi - lo).z, 1e-6)] * 3
        bpy.context.view_layer.update()
        corners, lo, hi = bounds()
    center = (lo + hi) / 2

    cam_data = bpy.data.cameras.new('icon_cam')
    cam_data.lens = 60
    cam_data.sensor_fit = 'AUTO'
    cam = bpy.data.objects.new('icon_cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.location = center
    cam.rotation_euler = cam_rot
    bpy.context.view_layer.update()  # sonst ist matrix_world noch die Einheitsmatrix

    # Fit: von der Box-Mitte so weit zurück, dass alle Ecken im Bild liegen, dann auf die Box zentrieren
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    half_tan = (cam_data.sensor_width / 2) / cam_data.lens / a.margin
    inv = cam.matrix_world.inverted()
    push = 0.0
    for c in corners:
        v = inv @ c  # Kameraraum: Blick entlang -Z
        push = max(push, abs(v.x) / half_tan + v.z, abs(v.y) / half_tan + v.z)
    cam.location = center + direction * push
    bpy.context.view_layer.update()
    inv = cam.matrix_world.inverted()
    xs, ys = [], []
    for c in corners:
        v = inv @ c
        xs.append(v.x / -v.z)
        ys.append(v.y / -v.z)
    # Projektion auf das Bild zentrieren (shift in Einheiten der Bildbreite)
    cam_data.shift_x = ((max(xs) + min(xs)) / 2) / (2 * cam_data.sensor_width / 2 / cam_data.lens)
    cam_data.shift_y = ((max(ys) + min(ys)) / 2) / (2 * cam_data.sensor_width / 2 / cam_data.lens)

    cam_rot3 = cam.matrix_world.to_3x3()

    def sun(name, local_dir, energy, color=(1, 1, 1)):
        # Sonne relativ zur Kamera (x rechts, y oben, z zur Kamera)
        d = bpy.data.lights.new(name, 'SUN')
        d.energy = energy
        d.color = color
        d.angle = math.radians(15)
        o = bpy.data.objects.new(name, d)
        scene.collection.objects.link(o)
        v = (cam_rot3 @ Vector(local_dir)).normalized()  # Richtung vom Objekt zur Lichtquelle
        o.rotation_euler = v.to_track_quat('Z', 'Y').to_euler()
        o.location = center + v * 10

    if rig:
        # Rig des Spiels: sitzt in der Zellenmitte, um (90, 180, 0) gedreht; jeder Projektor leuchtet
        # entlang seiner lokalen +X-Achse. Positionen relativ zur Box-Mitte des Items.
        rig_rot = Matrix.Rotation(math.radians(180), 3, 'Y') @ Matrix.Rotation(math.radians(90), 3, 'X')
        with open(rig, encoding='utf-8') as f:
            lights = json.load(f)['lights']
        for l in lights:
            if not l['active'] or l['position'] is None:
                continue
            d = bpy.data.lights.new('rig_' + l['name'], 'SPOT')
            d.energy = l['intensity'] * a.light_scale
            d.color = l['color']
            d.spot_size = math.radians(l['fov'] or 60)
            d.spot_blend = 0.5
            d.shadow_soft_size = l['bulb'] or 0.05
            d.use_shadow = bool(l['shadows'])
            o = bpy.data.objects.new('rig_' + l['name'], d)
            scene.collection.objects.link(o)
            o.location = center + rig_rot @ Vector(l['position'])
            rx, ry, rz = (math.radians(v) for v in l['rotation'])
            light_rot = Matrix.Rotation(rz, 3, 'Z') @ Matrix.Rotation(ry, 3, 'Y') @ Matrix.Rotation(rx, 3, 'X')
            beam = rig_rot @ light_rot @ Vector((1.0, 0.0, 0.0))
            o.rotation_euler = beam.to_track_quat('-Z', 'Y').to_euler()
        ambient = 0.15
    else:
        sun('key', (-0.6, 0.8, 0.7), 3.0)
        sun('fill', (0.8, 0.2, 0.6), 1.2, (0.9, 0.95, 1.0))
        sun('rim', (0.3, 0.6, -0.8), 2.0)
        ambient = 0.6
    world = bpy.data.worlds.new('icon_world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.5, 0.5, 0.5, 1)
    bg.inputs['Strength'].default_value = ambient

    # Render: Eevee, transparenter Film, Standard-Farbkurve (AgX würde entsättigen)
    scene.render.engine = 'BLENDER_EEVEE'
    scene.eevee.taa_render_samples = a.samples
    # Glas (Visiere): SB_GlassPBR ist reine Transmission; ohne Raytracing bricht Eevee nur die graue Welt
    # und das Visier wird eine flache graue Fläche. Mit Raytracing-Refraktion sieht man ins Helminnere.
    scene.eevee.use_raytracing = True
    for m in bpy.data.materials:
        if m.node_tree and any(getattr(n, 'node_tree', None) and n.node_tree.name.startswith('SB_GlassPBR') for n in m.node_tree.nodes):
            m.use_raytrace_refraction = True
            m.surface_render_method = 'DITHERED'
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    return f'bbox {tuple(round(v, 3) for v in (hi - lo))} m, {len(corners) // 8} meshes'


def main():
    a = parse_args()
    if a.jobs:
        with open(a.jobs, encoding='utf-8') as f:
            jobs = json.load(f)
    elif a.src and a.out:
        jobs = [{'src': a.src, 'out': a.out, 'pose': a.pose, 'rig': a.rig, 'size': a.size}]
    else:
        sys.exit('Aufruf: render.py <src> <out> | --jobs <jobs.json>')
    failed = 0
    for job in jobs:
        try:
            info = render(job, a)
            print(f"icon: {job['out']} {info}", flush=True)
        except Exception as e:  # ein kaputtes Item bricht den Batch nicht ab
            failed += 1
            traceback.print_exc()
            print(f"failed: {job['out']} {e}", flush=True)
    if failed:
        sys.exit(1)


main()
