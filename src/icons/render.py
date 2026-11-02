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
import numpy as np
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
        # StarBreaker decomposed: das Addon baut die Materialien beim Öffnen auf (im Hintergrundmodus sofort)
        bpy.ops.wm.open_mainfile(filepath=path)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)  # deaktiviert Addons, daher nur hier
        bpy.ops.import_scene.gltf(filepath=path)
    return bpy.context.scene


def hide_screens(scene):
    # UI-Bildschirme (Material-Template screen_hud, z.B. die Anzeige des mobiGlas) bleiben ohne UI-Inhalt
    # unsichtbar, spannten aber die Box auf: das Armband wurde zum Punkt. Ausblenden und nicht einpassen,
    # außer das Item besteht nur daraus.
    def screen_only(o):
        used = {p.material_index for p in o.data.polygons}
        mats = [o.material_slots[i].material for i in used if i < len(o.material_slots)]
        return bool(mats) and all(m is not None and m.get('starbreaker_template_key') == 'screen_hud' for m in mats)
    meshes = [o for o in scene.objects if o.type == 'MESH' and o.data.polygons and not o.hide_render]
    screens = [o for o in meshes if screen_only(o)]
    if screens and len(screens) < len(meshes):
        for o in screens:
            o.hide_render = True
            o['icon_screen'] = True


def unturn_single_mesh(scene):
    # Ein Modell aus genau einem Mesh zeigt das Spiel im Inventar in den Achsen des Meshes, ohne die Drehung seiner
    # NMC-Knoten: die FPS-Minerale (glacosite_fps, carinite_fps, …) tragen am Root +90° um X und standen bei uns
    # hochkant, wo die Lager-Kacheln sie liegend zeigen (alle 10 freien Kacheln passen ohne die Drehung). Im Fork
    # bleibt sie: dort wird dasselbe Mesh auch in Baugruppen verlinkt, wo die Drehung gilt.
    bpy.context.view_layer.update()
    meshes = [o for o in scene.objects if o.type == 'MESH' and o.data.polygons and not o.hide_render]
    if len(meshes) != 1:
        return
    o = meshes[0]
    loc, rot, scale = o.matrix_world.decompose()
    if rot.angle < math.radians(0.5):
        return
    print(f'Knotendrehung entfernt: {o.name} ({math.degrees(rot.angle):.0f}°)')
    o.parent = None
    o.matrix_world = Matrix.LocRotScale(loc, None, scale)


def boost_emission():
    # Leuchtendes (Augenstreifen, Pupillen, LEDs) mal EMISSION_GAIN: bei der Stärke aus den Daten war der Artimex
    # Chairman's Club-Augenstreifen sRGB 126/64/33 gegen 196/79/39 in der Inventar-Kachel, die Pupillen des Dark Bear
    # kaum zu sehen. Jede Emissionsstärke (auch verlinkte, auch in Knotengruppen, je Gruppe einmal).
    done = set()

    def scale(tree, socket):
        if socket is None:
            return
        if not socket.is_linked:
            socket.default_value *= EMISSION_GAIN
            return
        link = socket.links[0]
        mul = tree.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = EMISSION_GAIN
        tree.links.new(link.from_socket, mul.inputs[0])
        tree.links.remove(link)
        tree.links.new(mul.outputs[0], socket)

    def walk(tree):
        for n in list(tree.nodes):
            if n.bl_idname == 'ShaderNodeEmission':
                scale(tree, n.inputs['Strength'])
            elif n.bl_idname == 'ShaderNodeBsdfPrincipled':
                scale(tree, n.inputs.get('Emission Strength'))
            sub = getattr(n, 'node_tree', None)
            if sub is not None and sub.name not in done:
                done.add(sub.name)
                walk(sub)

    for m in bpy.data.materials:
        if m.node_tree is not None:
            walk(m.node_tree)


def sharpen_gloss():
    # Rauheit glänzender Oberflächen (Metall, Glas) mal ROUGHNESS: das Gold des Artimex Chairman's Club blieb ein
    # gleichmäßiger Ton (hellste Pixel max. Y 0.66, orange), die Inventar-Kachel hat warmweiße Glanzspitzen (max. 0.95)
    done = set()

    def scale(tree, socket):
        if not socket.is_linked:
            socket.default_value *= ROUGHNESS
            return
        link = socket.links[0]
        mul = tree.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = ROUGHNESS
        tree.links.new(link.from_socket, mul.inputs[0])
        tree.links.remove(link)
        tree.links.new(mul.outputs[0], socket)

    def walk(tree):
        for n in list(tree.nodes):
            if n.bl_idname == 'ShaderNodeBsdfPrincipled':
                metal, glass = n.inputs['Metallic'], n.inputs.get('Transmission Weight')
                if metal.is_linked or metal.default_value > 0 or (glass is not None and (glass.is_linked or glass.default_value > 0)):
                    scale(tree, n.inputs['Roughness'])
            sub = getattr(n, 'node_tree', None)
            if sub is not None and sub.name not in done:
                done.add(sub.name)
                walk(sub)

    for m in bpy.data.materials:
        if m.node_tree is not None:
            walk(m.node_tree)


def glass_see_through():
    """Für den zweiten Durchgang: alles Glas (Vorlage SB_GlassPBR) durchsichtig in seiner Tönung, statt zu brechen.
    Leuchten hinter Visieren und Linsen landet so im Emissions-Durchgang und bekommt den Bloom (Strata-Polster
    limettengrün hinter dem Visier, Dark Bear-Pupillen hinter den Linsen). False ohne Glas."""
    found = False
    for g in bpy.data.node_groups:
        if not g.name.startswith('SB_GlassPBR'):
            continue
        out = next((n for n in g.nodes if n.bl_idname == 'NodeGroupOutput'), None)
        if out is None:
            continue
        clear = g.nodes.new('ShaderNodeBsdfTransparent')
        tint = next((n for n in g.nodes if n.bl_idname == 'ShaderNodeHueSaturation'), None)
        if tint is not None:
            g.links.new(tint.outputs[0], clear.inputs['Color'])
        g.links.new(clear.outputs[0], out.inputs[0])
        found = True
    return found


def mesh_corners(objects):
    for o in objects:
        if o.type != 'MESH' or not o.data.vertices or o.get('icon_screen'):
            continue
        for c in o.bound_box:
            yield o.matrix_world @ Vector(c)


def render(job, a):
    src, out = job['src'], job['out']
    pose, rig, size = job.get('pose'), job.get('rig'), job.get('size', a.size)
    scene = load(src)
    sharpen_gloss()
    boost_emission()
    hide_screens(scene)
    unturn_single_mesh(scene)

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
    else:
        sun('key', (-0.6, 0.8, 0.7), 3.0)
        sun('fill', (0.8, 0.2, 0.6), 1.2, (0.9, 0.95, 1.0))
        sun('rim', (0.3, 0.6, -0.8), 2.0)
    world = bpy.data.worlds.new('icon_world')
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes['Background']
    bg.inputs['Color'].default_value = (1, 1, 1, 1)
    if pose:
        # Studio-Welt statt grauer Kugel: Eevee beleuchtet mit der Welt diffus und im Glanz gleich (eine Welt-
        # Probe). Gleichmäßiges Grau legte einen Schleier über schwarzen Lack (Geist ASD, Golden Blossom), ohne
        # Welt spiegelte Chrom nur Schwarz und hatte harte schwarze Seiten (Goliath). Softbox oben, schwaches
        # Licht von der Kameraseite, sonst fast schwarz; das Fill-Licht des Rigs ist praktisch aus (0.1).
        # Richtungen in der Zelle: Bild-oben = -Y, zur Kamera = -Z.
        tc = nt.nodes.new('ShaderNodeTexCoord')
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        nt.links.new(tc.outputs['Generated'], sep.inputs[0])

        def band(axis, lo, hi, strength):
            # smoothstep über die negative Achse: 0 bei -axis = lo, strength bei -axis = hi
            m = nt.nodes.new('ShaderNodeMapRange')
            m.interpolation_type = 'SMOOTHSTEP'
            m.inputs['From Min'].default_value = -lo
            m.inputs['From Max'].default_value = -hi
            m.inputs['To Min'].default_value = 0.0
            m.inputs['To Max'].default_value = strength
            nt.links.new(sep.outputs[axis], m.inputs['Value'])
            return m.outputs['Result']

        top = band('Y', STUDIO['top_from'], STUDIO['top_to'], STUDIO['top'])
        front = band('Z', 0.0, 0.9, STUDIO['front'])
        add = nt.nodes.new('ShaderNodeMath')
        add.operation = 'ADD'
        nt.links.new(top, add.inputs[0])
        nt.links.new(front, add.inputs[1])
        base = nt.nodes.new('ShaderNodeMath')
        base.operation = 'ADD'
        nt.links.new(add.outputs[0], base.inputs[0])
        base.inputs[1].default_value = STUDIO['base']
        nt.links.new(base.outputs[0], bg.inputs['Strength'])
    else:
        bg.inputs['Strength'].default_value = 0.15

    # Render: Eevee, transparenter Film, linear als EXR, die Farbkurve setzt write_png (Schulter von Khronos PBR
    # Neutral ohne dessen Toe)
    scene.render.engine = 'BLENDER_EEVEE'
    scene.eevee.taa_render_samples = a.samples
    # Glas (Visiere): das Addon schaltet die Raytracing-Refraktion je Material ein, die Szene muss mitmachen;
    # sonst bricht Eevee nur die graue Welt und das Visier wird eine flache graue Fläche
    scene.eevee.use_raytracing = True
    scene.render.film_transparent = True
    # Mehrlagen-EXR mit dem Emissions-Durchgang: write_png legt daraus den Bloom über das Leuchtende
    bpy.context.view_layer.use_pass_emit = True
    scene.render.image_settings.media_type = 'MULTI_LAYER_IMAGE'
    scene.render.image_settings.file_format = 'OPEN_EXR_MULTILAYER'
    scene.render.image_settings.color_depth = '32'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'  # EXR wird linear geschrieben, die Kurve wirkt hier nicht
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.0
    bpy.ops.render.render(write_still=False)
    exr = out + '.exr'
    bpy.data.images['Render Result'].save_render(exr, scene=scene)
    glow_exr = None
    try:
        if glass_see_through():
            # zweiter Durchgang nur für den Emissions-Durchgang (Bloom hinter Glas), wenige Samples: ~0.1-0.2 s
            scene.eevee.taa_render_samples = GLOW_SAMPLES
            bpy.ops.render.render(write_still=False)
            glow_exr = out + '.glow.exr'
            bpy.data.images['Render Result'].save_render(glow_exr, scene=scene)
        write_png(exr, out, glow_exr)
    finally:
        os.remove(exr)
        if glow_exr and os.path.exists(glow_exr):
            os.remove(glow_exr)
    return f'bbox {tuple(round(v, 3) for v in (hi - lo))} m, {len(corners) // 8} meshes'


# Studio-Welt (Leuchtdichte, weiß): Softbox oben von top_from bis top_to (Anteil der Bild-oben-Richtung),
# Kameraseite, Grund
STUDIO = {'top': 0.4, 'top_from': 0.2, 'top_to': 0.8, 'front': 0.05, 'base': 0.02}
# Faktor auf jede Emissionsstärke (boost_emission)
EMISSION_GAIN = 4.0
# Bloom aus dem Emissions-Durchgang: Stärke und Gauß-Radien (Sigma in px bei 512 px Bildgröße) mit ihren Anteilen
BLOOM = 2.0
BLOOM_BLURS = ((3.0, 0.6), (8.0, 0.4))
# Samples des zweiten Durchgangs (nur Emission hinter Glas, der Bloom verwischt sie ohnehin)
GLOW_SAMPLES = 4
# Faktor auf die Rauheit glänzender Oberflächen (sharpen_gloss): Mitte zwischen den Proben 1.0 und 0.7, das Licht-Rig
# ist ohnehin anders als im Spiel (welche Goldflächen dort hell sind, zeigt die Kachel)
ROUGHNESS = 0.85
# Kontrast der Helligkeit unterhalb Mittelgrau (Exponent): schwarzer Lack hat unter dem Key-Licht einige Prozent und
# wurde ohne ihn dunkelgrau (Geist ASD, ORC-mkX Singularity)
CONTRAST = 1.45


def shoulder(rgb):
    # Khronos PBR Neutral ohne Toe: linear bis 0.8, darüber wird der hellste Kanal weich auf 1 gestaucht und leicht
    # entsättigt (helles Weiß behält Zeichnung, Snow Camo wird keine Fläche). Der Toe der fertigen Kurve zog
    # min(R,G,B) - 6.25·min² von allen Kanälen ab und machte dunkle Farben schwarz oder grell (Geist Whiteout-Kinn
    # B/R 13 statt 1.9, Rogue-Kinn ohne Blau); Standard schnitt Weiß hart ab, AgX und Filmic machen Weiß grau.
    start, desaturation = 0.8, 0.15
    peak = rgb.max(axis=-1, keepdims=True)
    d = 1 - start
    new_peak = 1 - d * d / (peak + d - start)
    comp = rgb * (new_peak / np.maximum(peak, 1e-9))
    g = 1 - 1 / (desaturation * (peak - new_peak) + 1)
    comp = comp * (1 - g) + new_peak * g
    return np.where(peak < start, rgb, comp)


def contrast(rgb):
    # Helligkeit Y unter 0.18 -> 0.18·(Y/0.18)^CONTRAST, als gemeinsamer Faktor auf alle Kanäle: Schatten und Schwarz
    # tiefer, die Farbverhältnisse bleiben (anders als der Toe, der dunkle Farben schwarz machte). Darüber unverändert:
    # über den ganzen Bereich hob er auch die Lichter, Weiß brannte aus (Snow Camo 5.9 % Pixel, CQ7 Snowfire 6.1 %)
    y = (0.2126 * rgb[..., 0:1] + 0.7152 * rgb[..., 1:2] + 0.0722 * rgb[..., 2:3])
    y = np.maximum(y, 1e-9)
    return rgb * np.where(y < 0.18, (y / 0.18) ** (CONTRAST - 1), 1.0)


def gauss_blur(img, sigma):
    """Separierbarer Gauß über (h, w, c), außerhalb schwarz."""
    r = max(1, int(3 * sigma))
    x = np.arange(-r, r + 1)
    k = np.exp(-x * x / (2 * sigma * sigma))
    k /= k.sum()
    pad = np.pad(img, ((r, r), (r, r), (0, 0)))
    rows = sum(k[i] * pad[i:i + img.shape[0]] for i in range(2 * r + 1))
    return sum(k[i] * rows[:, i:i + img.shape[1]] for i in range(2 * r + 1))


def read_layer(exr, layer):
    """Ein Durchgang (Combined, Emission) einer Mehrlagen-EXR als (h, w, c), Zeilen von oben."""
    import OpenImageIO as oiio  # in Blenders Python enthalten
    buf = oiio.ImageBuf(exr)
    spec = buf.spec()
    names = list(spec.channelnames)
    px = buf.get_pixels(oiio.FLOAT).reshape(spec.height, spec.width, -1).astype(np.float64)
    return px[..., [names.index(n) for c in 'RGBA' for n in names if n.endswith(f'.{layer}.{c}')]]


def write_png(exr, out, glow_exr=None):
    """Lineare, vormultiplizierte Mehrlagen-EXR -> sRGB-PNG mit geradem Alpha: Bloom aus dem Emissions-Durchgang
    (Lichthöfe wie im Spiel; der Artimex-Augenstreifen war ohne ihn eine scharfe Linie, wo die Inventar-Kachel ihn
    glühen lässt), dann contrast() und shoulder(). Mit Glas kommt die Emission aus dem zweiten Durchgang (glow_exr),
    in dem das Glas durchsichtig ist: sonst fehlt Leuchten hinter Glas."""
    comb = read_layer(exr, 'Combined')
    emission = read_layer(glow_exr or exr, 'Emission')
    spec_width = comb.shape[1]
    lin, a = comb[..., :3], comb[..., 3:4]
    if emission.size and emission.max() > 0:
        scale = spec_width / 512
        bloom = BLOOM * sum(w * gauss_blur(emission, s * scale) for s, w in BLOOM_BLURS)
        lin = lin + bloom  # Licht, vormultipliziert addiert
        # der Lichthof außerhalb des Items deckt nach seiner Helligkeit
        glow = 0.2126 * bloom[..., 0:1] + 0.7152 * bloom[..., 1:2] + 0.0722 * bloom[..., 2:3]
        a = np.clip(a + (1 - a) * np.clip(glow * 4, 0, 1), 0, 1)
    rgb = np.clip(shoulder(contrast(lin / np.maximum(a, 1e-6))), 0, 1)
    rgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * rgb ** (1 / 2.4) - 0.055)
    h, w = rgb.shape[:2]
    dst = bpy.data.images.new('icon_png', w, h, alpha=True)
    dst.colorspace_settings.name = 'Non-Color'  # Werte sind schon sRGB-kodiert
    # EXR-Zeilen von oben, Blender-Pixel von unten
    dst.pixels.foreach_set(np.concatenate([rgb, a], axis=-1)[::-1].astype(np.float32).ravel())
    dst.filepath_raw = out
    dst.file_format = 'PNG'
    dst.save()
    bpy.data.images.remove(dst)


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
