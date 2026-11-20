# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""« Largeur dans la visionneuse » (expérimental, piste P22 de docs/analyses/pistes-profil.md) : droite tracée au sol juste devant le
nez du véhicule, perpendiculaire à la trajectoire de la séquence, vue dans la photo affichée (src/nez.js). Nez est une base de
web_app.App : ses méthodes lisent l'état de l'application (self)."""

import json
import math

from core import autotilt, calibration, metadata, precision, triangulation

NOSE_STEP = 0.05  # m : pas des points de la droite
NOSE_REACH = 12.0  # m : de part et d'autre du droit de la caméra
NOSE_DISTANCE = {1.93: 4.4, 2.07: 4.8}  # m : capot du CD21 (visible à 4,1 m et 4,5 m, src/dessus.js OUTLINES) plus 0,3 m
NOSE_DISTANCE_DEFAULT = 4.5  # m : autres véhicules
NOSE_GROUND_STEP = 0.5  # m : pas des points où le relief est lu (pas du MNT LiDAR HD), interpolé linéairement entre eux
NOSE_GROUND_MAX = 50  # lectures du relief gardées (une par photo et par droite)
NOSE_ROTATION_MAX = 45.0  # degrés : rotation à la main de la droite, de part et d'autre de la perpendiculaire au trajet
NOSE_FLAT = "plat (relief indisponible)"  # source du sol quand le MNT manque ou échoue


class Nez:
    """Droite au sol devant le véhicule (voir web_app.App)."""

    def _nose_tilt(self, roll):
        """(verticale vraie vue de la caméra ou None, source, incertitude en degrés ou None) de la photo affichée. D'abord
        l'inclinaison que la vue du dessus applique à cette photo quand elle la tire de la route (birdeye_tilt_set : « vue du
        dessus », « vue du dessus (réglée à la main) » si le tangage ou la part du dévers est réglé à la main) : c'est ce
        qu'elle montre, tangage lu et défaut de roulis compris. Sinon, dans le même ordre que la vue du dessus
        (_birdeye_of, qui lit alors les mêmes sources) : inclinaison calée à la main (« clics »), puis verticales de la photo
        (Calibration.tilt : « verticales », sinon « lidar » lu sous le véhicule), les verticales plus lâches (birdeye_loose,
        web_tilt.LOOSE_SIGMA) quand elles sont plus sûres que celle-ci sans être calées à la main, enfin le roulis de campagne
        (`roll`, degrés ; « roulis de campagne », up None : voir _nose_view) ou rien (« aucune »). Les verticales sont lancées par
        birdeye_request (calcul en arrière-plan, le même que pour la vue du dessus, gardé par photo dans Calibration.auto)."""
        pic = self.item.get("id")
        tilt, loose = self.calibration.tilt(pic), self.birdeye_loose.get(pic)
        ground = self.birdeye_ground.get(pic)
        if ground:
            return tuple(ground["up"]), "vue du dessus (réglée à la main)" if ground["manual"] else "vue du dessus", ground["sigma"]
        if loose and (not tilt or (loose["sigma"] < tilt["sigma"] and not tilt["source"].startswith("clics"))):
            return tuple(loose["up"]), "verticales (seuil élargi)", loose["sigma"]
        if tilt:
            return tuple(tilt["up"]), tilt["source"], tilt["sigma"]
        return None, "roulis de campagne" if roll else "aucune", None

    def birdeye_tilt_set(self, pic, tilt_json):
        """Inclinaison que la vue du dessus applique à la photo `pic` quand elle la tire de la route (src/dessus.js, layerOf :
        groundUp, avec le tangage lu ou réglé à la main, la part du dévers et le défaut de roulis de la campagne) : JSON
        {up (même convention que Calibration.tilt : verticale vraie vue de la caméra [est, nord, haut]), sigma (degrés), manual
        (tangage ou part du dévers réglés à la main)}, ou « null » quand la vue du dessus lit les verticales de la photo (mêmes
        sources que _nose_tilt, rien à retenir) ou n'a plus d'inclinaison pour elle. Rend vrai si la valeur retenue a changé
        (la droite est alors refaite, src/nez.js). Gardée par photo (les 20 dernières) : une autre photo ne la reçoit pas."""
        tilt = json.loads(tilt_json)
        if not tilt:
            return self.birdeye_ground.pop(pic, None) is not None
        tilt = {"up": [round(float(v), 6) for v in tilt["up"]], "sigma": round(float(tilt["sigma"]), 2), "manual": bool(tilt.get("manual"))}
        if self.birdeye_ground.get(pic) == tilt:
            return False
        self.birdeye_ground.pop(pic, None)
        self.birdeye_ground[pic] = tilt
        while len(self.birdeye_ground) > 20:
            del self.birdeye_ground[next(iter(self.birdeye_ground))]
        return True

    def _nose_view(self, bearing, elev, roll, up=None):
        """Comme Session._view_of (cap vrai, élévation en degrés → {yaw, pitch} radians du repère de la photo), mais avec la
        verticale `up` de _nose_tilt quand elle ne vient pas du calage de la photo (verticales plus lâches), ou, sans inclinaison
        calée ni lue pour la photo, avec le défaut de roulis de la campagne (Pose.ROLL_DEFECTS, en degrés ; 0 : rien) : la
        caméra est supposée penchée de ce roulis, seul à connaître (sinon le véhicule serait droit). Avec une inclinaison
        calée ou lue (up None, roll 0.0 ou calibration.tilt), c'est _view_of. Même signe que groundUp de src/dessus.js :
        roulis positif, verticale penchée vers la droite du cap."""
        item = self.item
        sequence = item.get("collection")
        if up is None and (roll == 0.0 or self.calibration.tilt(item.get("id"))):
            return self._view_of(bearing, elev)
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        yaw = bearing % 360
        pose = self.calibration.pose(sequence, lon, lat)
        if pose:
            yaw = (yaw - pose["offset"]) % 360
        if up is None:
            r, h = math.tan(math.radians(roll)), math.radians(self._nose_axis())
            norm = math.sqrt(1 + r * r)
            up = (r * math.cos(h) / norm, -r * math.sin(h) / norm, 1 / norm)
        yaw, pitch = calibration.untilt(up, yaw, elev, inverse=True)
        return {"yaw": math.radians((yaw - self._heading() + 540) % 360 - 180), "pitch": math.radians(pitch)}

    def _nose_axis(self):
        """Axe de la séquence (cap en degrés) à la photo affichée : entre ses voisines, sinon le cap de la photo."""
        axis = self._axis(self.item)
        return axis if axis is not None else self._heading()

    def _nose_axis_at(self, d):
        """(cap en degrés, écart au cap de la photo) de la trajectoire à `d` m devant la caméra, là où est tracée la droite :
        la route a tourné entre la photo et la droite (giratoire de 15 à 20 m de rayon : 15 à 20° pour 4,4 m). Interpolation
        angulaire entre l'axe à la photo (θ0, _nose_axis) et l'axe à la photo suivante dans le sens de marche (θ1), θ = θ0 +
        t (θ1 - θ0), t = d / distance entre les deux photos (bornée à [0, 1]). θ1 se déduit de la seule photo suivante : sur un
        arc de cercle, l'axe à la suivante est le symétrique de θ0 par rapport à la corde photo → suivante, θ1 = θ0 + 2 (c -
        θ0), c = cap de la corde (écarts ramenés à ±180°), |θ1 - θ0| borné à 45°. Pas besoin de la suivante de la suivante.
        Axe de la photo si la suivante manque ou est à moins de 1 m ou à plus de 20 m."""
        axis = self._nose_axis()
        item = self.item
        following = self.neighbours.get(metadata.id_from_href(metadata.item_link(item, "next")))
        if not following:
            return axis, 0.0
        try:
            here = [float(v) for v in item["geometry"]["coordinates"][:2]]
            there = [float(v) for v in following["geometry"]["coordinates"][:2]]
        except (KeyError, TypeError, ValueError):
            return axis, 0.0
        east = (there[0] - here[0]) * math.cos(math.radians(here[1])) * 111320.0
        north = (there[1] - here[1]) * 111320.0
        gap = math.hypot(east, north)
        if not 1.0 <= gap <= 20.0:
            return axis, 0.0
        chord = math.degrees(math.atan2(east, north))
        turn = max(-45.0, min(45.0, 2.0 * ((chord - axis + 540) % 360 - 180)))
        t = min(max(d / gap, 0.0), 1.0)
        return (axis + t * turn) % 360, t * turn

    def _nose_ground(self, lon, lat, axis, along, d, read=True):
        """(relief, en lecture) sous la droite. relief : (source, sigma en m, [(décalage x en m, écart de sol dz en m)]) ou None
        (relief indisponible : la droite est alors posée sur un sol plat). Lu une fois par droite (MNT LiDAR HD au pas de 0,5 m,
        sinon RGE ALTI : precision.fetch_terrain, une requête pour la caméra et les points tous les NOSE_GROUND_STEP m), gardé ;
        `dz` = z du MNT au point moins z du MNT sous la caméra (relatif : aucun souci de géoïde). La lecture est asynchrone
        (hôte JS) : tant qu'elle n'est pas arrivée, en lecture est vrai (sol plat en attendant) et src/nez.js redemande la droite."""
        key = tuple(round(v, 6) for v in (lon, lat, axis, along, d))
        base = key[:3] + key[4:]
        if key in self.nose_ground:
            ground = self.nose_ground[key]
            if ground:
                self.nose_ground_last = (base, ground)
            return (ground or None), ground == {}
        if not read:
            # glissement de la rotation : pas de nouvelle lecture, relief déjà lu pour cette caméra à l'angle précédent
            last = getattr(self, "nose_ground_last", None)
            if last and last[0] == base:
                return last[1], False
            ground = self.nose_ground.get(key)
            return (ground or None), False
        self.nose_ground[key] = {}  # {} : en lecture
        if len(self.nose_ground) > NOSE_GROUND_MAX:
            del self.nose_ground[next(iter(self.nose_ground))]
        a, b = math.radians(axis), math.radians(along)
        half = int(NOSE_REACH / NOSE_GROUND_STEP)
        offsets = [k * NOSE_GROUND_STEP for k in range(-half, half + 1)]
        points = [(lon, lat)] + [triangulation._geographic(d * math.sin(a) + x * math.cos(b), d * math.cos(a) - x * math.sin(b),
                                                           lon, lat) for x in offsets]

        def done(zs, source, error):
            if error or not zs or len(zs) != len(points) or None in zs:
                self.nose_ground[key] = None  # relief indisponible : sol plat
            else:
                sigma = triangulation.RGE_ALTI_ERROR if source == "RGE ALTI" else triangulation.LIDAR_ERROR
                self.nose_ground[key] = (source, sigma, [(x, z - zs[0]) for x, z in zip(offsets, zs[1:])])

        precision.fetch_terrain(points, done)  # synchrone dans les essais, asynchrone dans la page
        ground = self.nose_ground.get(key)
        if ground:
            self.nose_ground_last = (base, ground)
        return (ground or None), ground == {}

    def _neighbours_here(self):
        """Vrai si la précédente et la suivante de la photo affichée (celles qui existent) sont chargées : l'axe est alors définitif."""
        for rel in ("prev", "next"):
            nid = metadata.id_from_href(metadata.item_link(self.item, rel))
            if nid and nid not in self.neighbours:
                return False
        return True

    def nose_line(self, distance=None, rotation=0.0, relief=True):
        """JSON de la droite au sol à `distance` m devant la caméra (None : au-delà du capot, NOSE_DISTANCE), perpendiculaire
        à l'axe de la séquence à l'endroit de la droite (_nose_axis_at) : {d, virage (écart en degrés entre l'axe à la photo et à la droite, si > 3°, pas affiché), lonlat: [[lon, lat] à -NOSE_REACH, [lon, lat] à +NOSE_REACH] (position recalée de la photo), hauteur, hauteur_source, sigma_h, roulis_campagne, inclinaison_source (_nose_tilt : vue du dessus, clics, verticales, verticales (seuil élargi), lidar, roulis de campagne, aucune), inclinaison_sigma (degrés ou None), inclinaison_en_calcul (verticales pas encore arrivées : droite refaite à leur arrivée), points: [[décalage en m (positif à
        droite de l'axe de la droite), yaw, pitch]]} (radians, repère de la photo affichée), de -NOSE_REACH à +NOSE_REACH tous les
        NOSE_STEP m. Les décalages sont des positions horizontales ; le relief est celui du MNT LiDAR HD (_nose_ground) : un point de
        la droite dont le sol est à dz au-dessus du sol sous la caméra est vu à l'élévation -atan2(H - dz, distance horizontale).
        Champs du relief : sol (source : « LiDAR HD », « RGE ALTI » ou « plat (relief indisponible) »), sol_sigma (m, None à plat),
        sol_dz ([[décalage, dz]] tous les 0,5 m, absent à plat), sol_en_lecture (MNT pas encore arrivé : sol plat en attendant, droite
        refaite à son arrivée). {"error": …} sans photo 360°.
        `rotation` (degrés, borné à ±NOSE_ROTATION_MAX ; positif = sens trigonométrique vu du dessus, donc le côté droit de la droite
        avance vers l'avant) tourne la droite autour de son point au droit de la caméra (x = 0), dans le plan du sol : direction
        = direction perpendiculaire à l'axe du trajet tournée de `rotation`. Le relief est lu pour l'angle arrondi à 0,5° ; avec
        `relief` faux (glissement), aucune lecture n'est lancée : le relief déjà lu à l'angle précédent sert en attendant."""
        item = self.item
        if not item:
            return json.dumps({"error": "Aucune photo affichée."})
        if not autotilt.is_360(item):
            return json.dumps({"error": "Photo non 360° : la droite au sol n'est tracée que sur les photos 360°."})
        height, source, sigma = self.camera_of(item, self.quality)
        mount = self._fleet_mount(item)
        d = float(distance) if distance else NOSE_DISTANCE.get(mount, NOSE_DISTANCE_DEFAULT)
        roll = self._roll_defect(item)
        up, tilt_source, tilt_sigma = self._nose_tilt(roll)
        axis = self._nose_axis()  # cap de la caméra : le centre de la droite est à d devant
        along, turn = self._nose_axis_at(d)  # direction de la droite : perpendiculaire à celle-ci
        rot = max(-NOSE_ROTATION_MAX, min(NOSE_ROTATION_MAX, float(rotation or 0.0)))
        along -= rot  # direction de la droite tournée (cap de sa perpendiculaire, rotation positive = sens trigonométrique)
        gap = math.radians(turn - rot)
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        fixed = self.calibration.position(item.get("collection"), lon, lat)  # position recalée de la séquence, si elle l'est
        if fixed:
            lon, lat = fixed[0], fixed[1]
        ground, reading = self._nose_ground(lon, lat, axis, along + rot - round(rot * 2) / 2, d, relief)
        dzs = ground[2] if ground else None
        points = []
        for k in range(-int(NOSE_REACH / NOSE_STEP), int(NOSE_REACH / NOSE_STEP) + 1):
            x = k * NOSE_STEP
            right, forward = x * math.cos(gap), d - x * math.sin(gap)  # repère de la caméra (cap `axis`)
            dz = 0.0
            if dzs:
                f = min(max((x + NOSE_REACH) / NOSE_GROUND_STEP, 0.0), len(dzs) - 1.0)
                i = min(int(f), len(dzs) - 2)
                dz = dzs[i][1] + (f - i) * (dzs[i + 1][1] - dzs[i][1])
            v = self._nose_view(axis + math.degrees(math.atan2(right, forward)),
                                -math.degrees(math.atan2(height - dz, math.hypot(right, forward))), roll,
                                up if tilt_source.startswith(("verticales (seuil", "vue du dessus")) else None)
            points.append([round(x, 2), round(v["yaw"], 6), round(v["pitch"], 6)])
        a, b = math.radians(axis), math.radians(along)
        ends = []  # extrémités (-NOSE_REACH, +NOSE_REACH) de la droite sur la carte : une droite, le reste s'interpole
        for x in (-NOSE_REACH, NOSE_REACH):
            east, north = d * math.sin(a) + x * math.cos(b), d * math.cos(a) - x * math.sin(b)
            ends.append([round(v, 7) for v in triangulation._geographic(east, north, lon, lat)])
        out = {"d": d, "hauteur": height, "hauteur_source": source, "sigma_h": sigma,
               "roulis_campagne": roll, "inclinaison_source": tilt_source, "inclinaison_sigma": tilt_sigma,
               "inclinaison_en_calcul": self.tilts.pending(item.get("id")), "points": points, "lonlat": ends, "reach": NOSE_REACH,
               "voisines": self._neighbours_here(), "sol": ground[0] if ground else NOSE_FLAT,
               "sol_sigma": ground[1] if ground else None, "sol_en_lecture": reading}
        if ground:
            out["sol_dz"] = [[x, round(z, 3)] for x, z in ground[2]]
        if abs(turn) > 3.0:
            out["virage"] = round(turn)  # écart (degrés) entre l'axe à la photo et l'axe à la droite (pas encore affiché)
        return json.dumps(out)
