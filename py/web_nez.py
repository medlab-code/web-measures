# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""« Bords sur la photo » (expérimental, piste P22 de docs/analyses/pistes-profil.md) : droite tracée au sol juste devant le
nez du véhicule, perpendiculaire à la trajectoire de la séquence, vue dans la photo affichée (src/nez.js). Nez est une base de
web_app.App : ses méthodes lisent l'état de l'application (self)."""

import json
import math

from core import autotilt, calibration, metadata, triangulation

NOSE_STEP = 0.05  # m : pas des points de la droite
NOSE_REACH = 12.0  # m : de part et d'autre du droit de la caméra
NOSE_DISTANCE = {1.93: 4.4, 2.07: 4.8}  # m : capot du CD21 (visible à 4,1 m et 4,5 m, src/dessus.js OUTLINES) plus 0,3 m
NOSE_DISTANCE_DEFAULT = 4.5  # m : autres véhicules


class Nez:
    """Droite au sol devant le véhicule (voir web_app.App)."""

    def _nose_view(self, bearing, elev, roll):
        """Comme Session._view_of (cap vrai, élévation en degrés → {yaw, pitch} radians du repère de la photo), mais, sans
        inclinaison calée ni lue pour la photo, avec le défaut de roulis de la campagne (Pose.ROLL_DEFECTS, en degrés ;
        0 : rien) : la caméra est supposée penchée de ce roulis, seul à connaître (sinon le véhicule serait droit).
        Même signe que groundUp de src/dessus.js : roulis positif, verticale penchée vers la droite du cap."""
        item = self.item
        pic, sequence = item.get("id"), item.get("collection")
        if roll == 0.0 or self.calibration.tilt(pic):
            return self._view_of(bearing, elev)
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        yaw = bearing % 360
        pose = self.calibration.pose(sequence, lon, lat)
        if pose:
            yaw = (yaw - pose["offset"]) % 360
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

    def _neighbours_here(self):
        """Vrai si la précédente et la suivante de la photo affichée (celles qui existent) sont chargées : l'axe est alors définitif."""
        for rel in ("prev", "next"):
            nid = metadata.id_from_href(metadata.item_link(self.item, rel))
            if nid and nid not in self.neighbours:
                return False
        return True

    def nose_line(self, distance=None):
        """JSON de la droite au sol à `distance` m devant la caméra (None : au-delà du capot, NOSE_DISTANCE), perpendiculaire
        à l'axe de la séquence à l'endroit de la droite (_nose_axis_at) : {d, virage (écart en degrés entre l'axe à la photo et à la droite, si > 3°, pas affiché), lonlat: [[lon, lat] à -NOSE_REACH, [lon, lat] à +NOSE_REACH] (position recalée de la photo), hauteur, hauteur_source, sigma_h, roulis_campagne, points: [[décalage en m (positif à
        droite de l'axe de la droite), yaw, pitch]]} (radians, repère de la photo affichée), de -NOSE_REACH à +NOSE_REACH tous les
        NOSE_STEP m. Sol plat au niveau du sol sous la caméra (pas de lecture du terrain : la droite est à quelques mètres, et
        la caméra n'est à _camera_height qu'au-dessus de son propre sol). {"error": …} sans photo 360°."""
        item = self.item
        if not item:
            return json.dumps({"error": "Aucune photo affichée."})
        if not autotilt.is_360(item):
            return json.dumps({"error": "Photo non 360° : la droite au sol n'est tracée que sur les photos 360°."})
        height, source, sigma = self.camera_of(item, self.quality)
        mount = self._fleet_mount(item)
        d = float(distance) if distance else NOSE_DISTANCE.get(mount, NOSE_DISTANCE_DEFAULT)
        roll = self._roll_defect(item)
        axis = self._nose_axis()  # cap de la caméra : le centre de la droite est à d devant
        along, turn = self._nose_axis_at(d)  # direction de la droite : perpendiculaire à celle-ci
        gap = math.radians(turn)
        points = []
        for k in range(-int(NOSE_REACH / NOSE_STEP), int(NOSE_REACH / NOSE_STEP) + 1):
            x = k * NOSE_STEP
            right, forward = x * math.cos(gap), d - x * math.sin(gap)  # repère de la caméra (cap `axis`)
            v = self._nose_view(axis + math.degrees(math.atan2(right, forward)),
                                -math.degrees(math.atan2(height, math.hypot(right, forward))), roll)
            points.append([round(x, 2), round(v["yaw"], 6), round(v["pitch"], 6)])
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        fixed = self.calibration.position(item.get("collection"), lon, lat)  # position recalée de la séquence, si elle l'est
        if fixed:
            lon, lat = fixed[0], fixed[1]
        a, b = math.radians(axis), math.radians(along)
        ends = []  # extrémités (-NOSE_REACH, +NOSE_REACH) de la droite sur la carte : une droite, le reste s'interpole
        for x in (-NOSE_REACH, NOSE_REACH):
            east, north = d * math.sin(a) + x * math.cos(b), d * math.cos(a) - x * math.sin(b)
            ends.append([round(v, 7) for v in triangulation._geographic(east, north, lon, lat)])
        out = {"d": d, "hauteur": height, "hauteur_source": source, "sigma_h": sigma,
               "roulis_campagne": roll, "points": points, "lonlat": ends, "reach": NOSE_REACH,
               "voisines": self._neighbours_here()}
        if abs(turn) > 3.0:
            out["virage"] = round(turn)  # écart (degrés) entre l'axe à la photo et l'axe à la droite (pas encore affiché)
        return json.dumps(out)
