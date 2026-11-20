# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""« Bords sur la photo » (expérimental, piste P22 de docs/analyses/pistes-profil.md) : droite tracée au sol juste devant le
nez du véhicule, perpendiculaire à la trajectoire de la séquence, vue dans la photo affichée (src/nez.js). Nez est une base de
web_app.App : ses méthodes lisent l'état de l'application (self)."""

import json
import math

from core import autotilt, calibration, triangulation

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

    def nose_line(self, distance=None):
        """JSON de la droite au sol à `distance` m devant la caméra (None : au-delà du capot, NOSE_DISTANCE), perpendiculaire
        à l'axe de la séquence : {d, lonlat: [[lon, lat] à -NOSE_REACH, [lon, lat] à +NOSE_REACH] (position recalée de la photo), hauteur, hauteur_source, sigma_h, roulis_campagne, points: [[décalage en m (positif à
        droite de l'axe), yaw, pitch]]} (radians, repère de la photo affichée), de -NOSE_REACH à +NOSE_REACH tous les
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
        axis = self._nose_axis()
        points = []
        for k in range(-int(NOSE_REACH / NOSE_STEP), int(NOSE_REACH / NOSE_STEP) + 1):
            x = k * NOSE_STEP
            v = self._nose_view(axis + math.degrees(math.atan2(x, d)),
                                -math.degrees(math.atan2(height, math.hypot(x, d))), roll)
            points.append([round(x, 2), round(v["yaw"], 6), round(v["pitch"], 6)])
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        fixed = self.calibration.position(item.get("collection"), lon, lat)  # position recalée de la séquence, si elle l'est
        if fixed:
            lon, lat = fixed[0], fixed[1]
        a = math.radians(axis)
        ends = []  # extrémités (-NOSE_REACH, +NOSE_REACH) de la droite sur la carte : une droite, le reste s'interpole
        for x in (-NOSE_REACH, NOSE_REACH):
            east, north = d * math.sin(a) + x * math.cos(a), d * math.cos(a) - x * math.sin(a)
            ends.append([round(v, 7) for v in triangulation._geographic(east, north, lon, lat)])
        return json.dumps({"d": d, "hauteur": height, "hauteur_source": source, "sigma_h": sigma,
                           "roulis_campagne": roll, "points": points, "lonlat": ends, "reach": NOSE_REACH})
