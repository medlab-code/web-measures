# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""« Largeur dans la visionneuse » (expérimental, piste P22 de docs/analyses/pistes-profil.md) : droite tracée au sol juste devant le
nez du véhicule, perpendiculaire à la trajectoire de la séquence, vue dans la photo affichée (src/nez.js). Nez est une base de
web_app.App : ses méthodes lisent l'état de l'application (self)."""

import json
import math

import web_profils
from core import autotilt, metadata, precision, triangulation

NOSE_STEP = 0.05  # m : pas des points de la droite
NOSE_REACH = 12.0  # m : de part et d'autre du droit de la caméra
NOSE_DISTANCE = {1.93: 4.4, 2.07: 4.8}  # m : capot du CD21 (visible à 4,1 m et 4,5 m, src/dessus.js OUTLINES) plus 0,3 m
NOSE_DISTANCE_DEFAULT = 4.5  # m : autres véhicules
NOSE_OVERLAP = 1.0  # m : recouvrement au-delà de la photo suivante, butée lointaine de la droite glissée en profondeur
NOSE_FAR_DEFAULT = 6.0  # m : butée lointaine au-delà du nez quand la photo suivante n'est pas connue (écart de 5 m et recouvrement de 1 m)
NOSE_GROUND_STEP = 0.5  # m : pas des points où le relief est lu (pas du MNT LiDAR HD), interpolé linéairement entre eux
NOSE_GROUND_MAX = 50  # lectures du relief gardées (une par photo et par droite)
NOSE_ROTATION_MAX = 45.0  # degrés : rotation à la main de la droite, de part et d'autre de la perpendiculaire au trajet
NOSE_FLAT = "plat (relief indisponible)"  # source du sol quand le MNT manque ou échoue


class Nez:
    """Droite au sol devant le véhicule (voir web_app.App)."""

    def _nose_tilt(self):
        """(source, incertitude en degrés ou None) de l'inclinaison de la photo affichée : celle de Calibration.tilt, l'ordre
        unique des mesures et de la largeur dans la visionneuse (vue du dessus, clics, verticales, LiDAR, verticales à seuil
        élargi, roulis par défaut de la campagne seul) ; « aucune » sans inclinaison. La droite est projetée avec elle (_view_of), comme les
        mesures. Les verticales sont lancées par birdeye_request (calcul en arrière-plan, le même que pour la vue du dessus,
        gardé par photo dans Calibration.auto)."""
        tilt = self.calibration.tilt(self.item.get("id"))
        return (tilt["source"], tilt["sigma"]) if tilt else ("aucune", None)

    def birdeye_tilt_set(self, pic, tilt_json):
        """Inclinaison que la vue du dessus applique à la photo `pic` quand elle la tire de la route (src/dessus.js, layerOf :
        groundUp, avec le tangage lu ou réglé à la main, la part du dévers et le roulis par défaut de la campagne), avec la hauteur
        de sa couche et son terrain : JSON {up (même convention que Calibration.tilt : verticale vraie vue de la caméra [est,
        nord, haut] ; None quand la vue du dessus lit les verticales de la photo : mêmes sources que _nose_tilt, rien à retenir),
        sigma (degrés), manual (tangage ou part du dévers réglés à la main), height (m, hauteur de la caméra au-dessus du sol :
        monture, parallaxe ou altitude GPS, comme src/dessus.js layerOf) et height_sigma, ground (terrain lissé de la vue :
        {lon, lat du centre, n points de côté, step en m, z en m depuis le centre (lignes du sud au nord), ref : sol sous la
        caméra} ou None sans LiDAR HD)}, ou « null » quand la vue du dessus n'a plus rien pour elle. Rend vrai si la valeur retenue a changé
        (la droite est alors refaite, src/nez.js, et les mesures déjà faites sur la photo recalculées, comme à l'arrivée de
        l'inclinaison automatique : _recompute). Gardée par photo (les 20 dernières) : une autre photo ne la reçoit pas."""
        tilt = json.loads(tilt_json)
        if not tilt:
            changed = self.birdeye_ground.pop(pic, None) is not None
        else:
            ground = tilt.get("ground")
            if ground:
                ground = {"lon": float(ground["lon"]), "lat": float(ground["lat"]), "n": int(ground["n"]),
                          "step": float(ground["step"]), "z": [float(v) for v in ground["z"]], "ref": float(ground["ref"])}
                if len(ground["z"]) != ground["n"] ** 2 or ground["n"] < 2:
                    ground = None
            height = tilt.get("height")
            route = tilt.get("route")  # route annoncée même quand les verticales priment : témoin de la confiance (tilt_sources)
            route = ({"up": [round(float(v), 6) for v in route["up"]], "sigma": round(float(route.get("sigma") or 0.0), 2),
                      "manual": bool(tilt.get("route_manual"))} if route and route.get("up") else None)
            tilt = {"up": [round(float(v), 6) for v in tilt["up"]] if tilt.get("up") else None,
                    "sigma": round(float(tilt.get("sigma") or 0.0), 2), "manual": bool(tilt.get("manual")),
                    "height": round(float(height), 3) if height else None,
                    "height_sigma": round(float(tilt.get("height_sigma") or 0.0), 3), "ground": ground}
            old = self.birdeye_ground.get(pic)
            changed = {k: v for k, v in (old or {}).items() if k != "route"} != tilt
            if changed or (old or {}).get("route") != route:
                self.birdeye_ground.pop(pic, None)
                self.birdeye_ground[pic] = dict(tilt, route=route)
                while len(self.birdeye_ground) > 20:
                    del self.birdeye_ground[next(iter(self.birdeye_ground))]
                if not changed:  # seule la route de la confiance a changé : ni mesures ni droite à refaire, seulement leur confiance
                    self._stamp_confidence({pic})
                    self.notify()
        if changed:
            self._recompute({pic})
            self.notify()
        return changed

    def _birdeye_ground_dz(self, pic, lon, lat, axis, along, d):
        """Écarts de sol [(décalage x en m, dz)] sous la droite d'après le terrain lissé de la vue du dessus (birdeye_tilt_set), ou
        None sans lui. Même maillage que celui qui projette la photo (lissé sur 2 m le long de la route, 1 m de maille, bilinéaire
        comme terrainAt de src/dessus.js, borné au maillage) : le sol de la droite est celui de Bird Eye, pas le MNT brut au pas de
        0,5 m (creux et bombement de la chaussée qui faisaient une largeur trop courte de 2 %). dz = sol au point moins sol sous la
        caméra (ref)."""
        bird = self.birdeye_ground.get(pic)
        g = bird and bird.get("ground")
        if not g:
            return None
        n, step = g["n"], g["step"]
        radius = (n - 1) * step / 2
        ox, oy = triangulation._local(lon, lat, g["lon"], g["lat"])  # caméra dans le repère du centre du maillage
        a, b = math.radians(axis), math.radians(along)
        half = int(NOSE_REACH / NOSE_GROUND_STEP)
        out = []
        for k in range(-half, half + 1):
            x = k * NOSE_GROUND_STEP
            east = ox + d * math.sin(a) + x * math.cos(b)
            north = oy + d * math.cos(a) - x * math.sin(b)
            fx = min(n - 1.001, max(0.0, (east + radius) / step))
            fy = min(n - 1.001, max(0.0, (north + radius) / step))
            i, j = int(fx), int(fy)
            u, v = fx - i, fy - j
            z = g["z"]
            h = (z[j * n + i] * (1 - u) + z[j * n + i + 1] * u) * (1 - v) + (z[(j + 1) * n + i] * (1 - u) + z[(j + 1) * n + i + 1] * u) * v
            out.append((x, h - g["ref"]))
        return out

    def _nose_height(self, item):
        """(hauteur de la caméra, source, incertitude en m) de la droite. Annoncée par la vue du dessus quand elle a calé la photo
        (birdeye_tilt_set : celle de sa couche, monture, parallaxe ou altitude GPS) ; sinon la monture du véhicule avant l'altitude
        GPS (même ordre que la vue du dessus : l'altitude GPS moins le sol LiDAR faisait 1,80 m au lieu de 1,93 m sur le CD21, une
        largeur de 7 % trop courte) ; sinon camera_of. Seule la largeur ↔ prend cet ordre : camera_of reste celui des autres mesures."""
        bird = self.birdeye_ground.get((item or {}).get("id"))
        if bird and bird.get("height"):
            return bird["height"], "vue du dessus", bird["height_sigma"] or web_profils.HEIGHT_SIGMA_DEFAULT
        known = self._mount_height(item or {})
        if known:
            return known[0], "monture", known[1]
        return self.camera_of(item, self.quality)

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
            # (ou à la distance précédente : glissement de la droite en profondeur, relief approché en attendant)
            last = getattr(self, "nose_ground_last", None)
            if last and last[0][:3] == base[:3]:
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

    def _nose_gap(self):
        """Écart (m) entre la photo affichée et la suivante de la séquence, d'après leurs positions ; None si la suivante n'est pas
        connue (pas chargée, absente) ou si l'écart est hors de 1 à 20 m (même garde que _nose_axis_at)."""
        item = self.item
        following = self.neighbours.get(metadata.id_from_href(metadata.item_link(item, "next")))
        if not following:
            return None
        try:
            here = [float(v) for v in item["geometry"]["coordinates"][:2]]
            there = [float(v) for v in following["geometry"]["coordinates"][:2]]
        except (KeyError, TypeError, ValueError):
            return None
        gap = math.hypot((there[0] - here[0]) * math.cos(math.radians(here[1])) * 111320.0, (there[1] - here[1]) * 111320.0)
        return gap if 1.0 <= gap <= 20.0 else None

    def _nose_range(self, mount):
        """(distance minimale, distance maximale) de la droite devant la caméra, en m : près, la distance du nez (capot) ; au loin,
        la distance du nez plus l'écart réel jusqu'à la photo suivante plus NOSE_OVERLAP de recouvrement (nez + NOSE_FAR_DEFAULT
        sans photo suivante connue)."""
        near = NOSE_DISTANCE.get(mount, NOSE_DISTANCE_DEFAULT)
        gap = self._nose_gap()
        return near, near + (NOSE_FAR_DEFAULT if gap is None else gap + NOSE_OVERLAP)

    def _nose_confidence(self, item):
        """Confiance de l'inclinaison de la photo (Calibration.confidence) pour l'encart de la droite : {etat, ecart_tangage,
        ecart_roulis} (écarts en degrés, arrondis) ou None sans inclinaison."""
        got = self.tilt_confidence_of(item.get("id"), item)
        if not got:
            return None
        return {"etat": got["state"], "ecart_tangage": None if got["d_pitch"] is None else round(got["d_pitch"], 2),
                "ecart_roulis": None if got["d_roll"] is None else round(got["d_roll"], 2)}

    def nose_line(self, distance=None, rotation=0.0, relief=True):
        """JSON de la droite au sol à `distance` m devant la caméra (None ou 0 : au-delà du capot, NOSE_DISTANCE ; sinon bornée par _nose_range, rendue
        dans `d`, `d_min` et `d_max` : glissement de la droite en profondeur), perpendiculaire
        à l'axe de la séquence à l'endroit de la droite (_nose_axis_at) : {d, virage (écart en degrés entre l'axe à la photo et à la droite, si > 3°, pas affiché), lonlat: [[lon, lat] à -NOSE_REACH, [lon, lat] à +NOSE_REACH] (position recalée de la photo), hauteur, hauteur_source, sigma_h, roulis_campagne, inclinaison_source (_nose_tilt : vue du dessus, clics, verticales, verticales (seuil élargi), lidar, roulis par défaut de la campagne, aucune), inclinaison_sigma (degrés ou None), inclinaison_en_calcul (verticales pas encore arrivées : droite refaite à leur arrivée), points: [[décalage en m (positif à
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
        height, source, sigma = self._nose_height(item)
        mount = self._fleet_mount(item)
        d_min, d_max = self._nose_range(mount)
        d = min(max(float(distance), d_min), d_max) if distance else d_min
        roll = round(self._roll_default(item, item.get("id")), 2)  # roulis par défaut du véhicule (positif : à droite)
        tilt_source, tilt_sigma = self._nose_tilt()
        axis = self._nose_axis()  # cap de la caméra : le centre de la droite est à d devant
        along, turn = self._nose_axis_at(d)  # direction de la droite : perpendiculaire à celle-ci
        rot = max(-NOSE_ROTATION_MAX, min(NOSE_ROTATION_MAX, float(rotation or 0.0)))
        along -= rot  # direction de la droite tournée (cap de sa perpendiculaire, rotation positive = sens trigonométrique)
        gap = math.radians(turn - rot)
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        fixed = self.calibration.position(item.get("collection"), lon, lat)  # position recalée de la séquence, si elle l'est
        if fixed:
            lon, lat = fixed[0], fixed[1]
        smooth = self._birdeye_ground_dz(item.get("id"), lon, lat, axis, along, d)
        if smooth:  # terrain lissé de la vue du dessus : sans lecture, sans attente
            ground, reading = ("LiDAR HD (vue du dessus)", triangulation.LIDAR_ERROR, smooth), False
        else:
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
            v = self._view_of(axis + math.degrees(math.atan2(right, forward)),
                              -math.degrees(math.atan2(height - dz, math.hypot(right, forward))))
            points.append([round(x, 2), round(v["yaw"], 6), round(v["pitch"], 6)])
        a, b = math.radians(axis), math.radians(along)
        ends = []  # extrémités (-NOSE_REACH, +NOSE_REACH) de la droite sur la carte : une droite, le reste s'interpole
        for x in (-NOSE_REACH, NOSE_REACH):
            east, north = d * math.sin(a) + x * math.cos(b), d * math.cos(a) - x * math.sin(b)
            ends.append([round(v, 7) for v in triangulation._geographic(east, north, lon, lat)])
        out = {"d": d, "d_min": d_min, "d_max": d_max, "hauteur": height, "hauteur_source": source, "sigma_h": sigma,
               "roulis_campagne": roll, "roulis_libelle": self._roll_label(item), "inclinaison_source": tilt_source, "inclinaison_sigma": tilt_sigma,
               "inclinaison_confiance": self._nose_confidence(item),
               "inclinaison_en_calcul": self.tilts.pending(item.get("id")), "points": points, "lonlat": ends, "reach": NOSE_REACH,
               "voisines": self._neighbours_here(), "sol": ground[0] if ground else NOSE_FLAT,
               "sol_sigma": ground[1] if ground else None, "sol_en_lecture": reading}
        if ground:
            out["sol_dz"] = [[x, round(z, 3)] for x, z in ground[2]]
        if abs(turn) > 3.0:
            out["virage"] = round(turn)  # écart (degrés) entre l'axe à la photo et l'axe à la droite (pas encore affiché)
        return json.dumps(out)
