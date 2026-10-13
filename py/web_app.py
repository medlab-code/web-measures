# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Application de mesure dans le navigateur : le cœur de calcul du plugin (core/), piloté par
la page (src/app.js). Même enchaînement que le plugin QGIS : clic dans la photo → direction
corrigée du calage → profil du terrain le long de la visée → point 3D → mesure.

La page appelle les méthodes de App ; les résultats sont rendus en JSON (texte). Quand une
lecture réseau aboutit après coup (terrain, axe de la route, façade), App appelle notify()
pour que la page se redessine.
"""

import json
import math
import traceback
from datetime import datetime

import web_host
from core import buildings, calibration, measures, metadata, roads, terrain

MODES = ("road", "width", "height")


class WebItem:
    """Dessin d'une mesure ou d'une façade sur la carte (voir core.measures.MeasureTool.new_item) :
    gardé ici, rendu en GeoJSON par App.map_geojson."""

    def __init__(self, wall=False):
        self.wall = wall
        self.points, self.label, self.extras = [], "", []
        self.removed = False

    def set_data(self, points, label="", extras=None):
        self.points, self.label, self.extras = list(points), label, list(extras or [])

    def remove(self):
        self.removed = True


class App:
    def __init__(self, notify):
        web_host.install()
        self.notify = notify  # fonction de la page : redessiner après une lecture réseau
        self.items = []
        self.calibration = calibration.Calibration()
        self.terrain = terrain.TerrainProvider()
        self.roads = roads.RoadAxisProvider()
        self.buildings = buildings.BuildingProvider()
        self.roads.ready = self._roads_ready
        self.buildings.ready = self._buildings_ready
        self.tool = measures.MeasureTool(None)
        self.tool.new_item = self._new_item
        self.tool.calibration = self.calibration
        self.tool.road_lookup = self.roads.lookup
        self.tool.wall_lookup = self.buildings.lookup
        self.tool.set_mode("road")
        self.item = None  # fiche STAC de la photo affichée
        self.message = ""
        self._handles = []  # clés des poignées de la carte, dans l'ordre de handles()

    # Réglages ----------------------------------------------------------------------
    def _new_item(self, wall=False):
        item = WebItem(wall)
        self.items.append(item)
        return item

    def set_mode(self, mode):
        if mode in MODES:
            self.tool.set_mode(mode)
        self.message = ""
        return self.status()

    def set_camera_height(self, value):
        self.tool.set_camera_height(float(value))
        return self.status()

    def set_use_wall(self, value):
        self.tool.set_use_wall(bool(value))
        return self.status()

    def set_picture(self, item_json):
        """Photo affichée dans la visionneuse : sa fiche STAC (texte JSON)."""
        self.item = json.loads(item_json)
        return self.status()

    # Clics ---------------------------------------------------------------------------
    def click(self, yaw, pitch):
        """Clic dans la photo affichée : direction dans le repère de la photo (radians, cap
        relatif au centre de l'image, comme le donne la visionneuse)."""
        item = self.item
        if not item:
            self.message = "Photo en cours de chargement : cliquez à nouveau."
            return self.status()
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        except (KeyError, TypeError, ValueError):
            self.message = "Position de la photo inconnue."
            return self.status()
        precise = metadata.precise_heading(item)
        heading = precise if precise is not None else (metadata.item_heading(item) or 0.0)
        raw_yaw = (math.degrees(yaw) + heading) % 360
        raw_elev = math.degrees(pitch)
        pic, sequence = item.get("id"), item.get("collection")
        cyaw, celev = self.calibration.correct(pic, sequence, raw_yaw, raw_elev, lon, lat)
        accuracy = metadata.item_accuracy(item)
        click = {"pic": pic, "lon": lon, "lat": lat, "camera_alt": None, "gps": [lon, lat],
                 "gps_accuracy": accuracy, "yaw": cyaw, "elev": celev, "raw": [raw_yaw, raw_elev],
                 "sequence": sequence, "accuracy": accuracy, "precise": precise is not None,
                 "axis": metadata.item_heading(item), "axis_source": "orientation de la photo",
                 "pos": [yaw, pitch]}
        self.message = ""
        if self.tool.select_near(click):
            return self.status()  # repère d'un point : sélectionné pour le viser à nouveau
        self.message = "Altitude du terrain le long de la visée…"
        self.terrain.profile(lon, lat, cyaw, lambda profile, label, warning: self._profiled(click, profile, label,
                                                                                            warning))
        return self.status()

    def _profiled(self, click, profile, label, warning):
        try:
            click.update(profile=profile, terrain=label, precise_ground=label in terrain.PRECISE_LABELS)
            self.tool.add_click(click, warning)
            self.message = ""  # la mesure en cours dit la suite (status)
        except Exception:
            traceback.print_exc()
        self.notify()

    def _roads_ready(self):
        if self.tool.recompute_roads():
            self.notify()

    def _buildings_ready(self):
        self.tool.recompute_walls()
        self.notify()

    def move_handle(self, index, lon, lat):
        """Poignée n° index (voir handles) glissée sur la carte en (lon, lat)."""
        if not 0 <= index < len(self._handles):
            return self.status()
        try:
            self.message = self.tool.move_handle(self._handles[index], float(lon), float(lat))
        except Exception:
            traceback.print_exc()
            self.message = "Recalage impossible."
        return self.status()

    def clear(self):
        self.tool.clear()
        self.message = ""
        return self.status()

    def clear_all(self):
        self.tool.clear_all()
        self.message = ""
        return self.status()

    # Affichage ---------------------------------------------------------------------
    def status(self):
        """Texte de la mesure (consigne ou résultat)."""
        return self.message or self.tool.status()

    def viewer_marks(self):
        """Repères de la photo affichée (JSON) : pour chaque mesure, points (cap et élévation
        dans le repère de la photo, radians), libellé, point sélectionné."""
        pic = (self.item or {}).get("id")
        marks = self.tool.done_marks() + [self.tool.viewer_marks()]
        out = []
        for m in marks:
            points = [p for p in m["points"] if p.get("pic") == pic and p.get("yaw") is not None]
            if points:
                out.append({"points": [[p["yaw"], p["pitch"], bool(p.get("sel"))] for p in points],
                            "label": m.get("label", ""), "beside": m.get("beside", False)})
        return json.dumps(out)

    def handles(self):
        """Poignées déplaçables sur la carte (JSON) : [[lon, lat, façade ?]], repérées par leur
        rang pour move_handle."""
        handles = self.tool.handles()
        self._handles = [key for key, _, _ in handles]
        return json.dumps([[lon, lat, key[0] == "facade"] for key, lon, lat in handles])

    def map_geojson(self):
        """Mesures et façades à dessiner sur la carte (GeoJSON, texte)."""
        features = []
        self.items = [i for i in self.items if not i.removed]
        for item in self.items:
            if not item.points:
                continue
            kind = "facade" if item.wall else ("trace" if item.extras else "mesure")
            if len(item.points) >= 2:
                features.append({"type": "Feature", "properties": {"kind": kind, "label": item.label},
                                 "geometry": {"type": "LineString", "coordinates": [list(p) for p in item.points]}})
            for p in ([] if item.wall else (item.extras if item.extras else item.points)):
                features.append({"type": "Feature", "properties": {"kind": "point"},
                                 "geometry": {"type": "Point", "coordinates": list(p)}})
            for start, end in zip(item.points, item.extras):  # pointillés vers les bords cliqués
                features.append({"type": "Feature", "properties": {"kind": "lien"},
                                 "geometry": {"type": "LineString", "coordinates": [list(start), list(end)]}})
            if len(item.points) == 1 and item.label:  # hauteur : étiquette au pied
                features.append({"type": "Feature", "properties": {"kind": "etiquette", "label": item.label},
                                 "geometry": {"type": "Point", "coordinates": list(item.points[0])}})
        return json.dumps({"type": "FeatureCollection", "features": features})

    # Export ----------------------------------------------------------------------------
    def _records(self):
        """Mesures terminées : (géométrie [(lon, lat)], attributs), comme la couche du plugin."""
        out = []
        for m in self.tool.measures():
            r = m.result
            if not r:
                continue
            d = r["decomposition"]
            ends = r["points"] if len(r["points"]) >= 2 else r["picks"]
            height, source = self.tool.camera_info(m.clicks[0], measures._ground_z(m.clicks)[m.clicks[0].get("pic")])

            def num(value, digits=3):
                return None if value is None else round(value, digits)

            out.append((ends, {
                "type": measures.KIND_NAMES[m.kind],
                "surface": measures.SURFACE_NAMES.get(m.surface, m.surface),
                "valeur_m": num(r["value"]), "incert_m": num(r["uncertainty"]),
                "horiz_m": num(d["horizontal"]), "vert_m": num(d["vertical"]),
                "long_route_m": num(d["along"]), "travers_m": num(d["across"]),
                "dist_photo_m": num(max(r["ranges"]), 1), "camera_m": num(height, 2),
                "camera_calee": measures.CAMERA_SOURCES.get(source, 0),
                "terrain": " + ".join(sorted({c.get("terrain") for c in m.clicks if c.get("terrain")})),
                "axe_route": m.axis_source if m.kind == "road" else None,
                "recales": len(m.overrides),
                "photos": ",".join(dict.fromkeys(c.get("pic") or "" for c in m.clicks)),
                "date_mesure": datetime.now().isoformat(timespec="seconds"),
            }))
        return out

    def export_geojson(self):
        features = [{"type": "Feature", "properties": attrs,
                     "geometry": ({"type": "LineString", "coordinates": [list(p) for p in ends]} if len(ends) >= 2
                                  else {"type": "Point", "coordinates": list(ends[0])})}
                    for ends, attrs in self._records()]
        return json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, indent=1)

    def export_csv(self):
        """CSV (séparateur point-virgule, virgule décimale : tableurs français), coordonnées
        des extrémités en WGS 84."""
        records = self._records()
        if not records:
            return ""
        keys = list(records[0][1])
        rows = [";".join(keys + ["lon1", "lat1", "lon2", "lat2"])]
        for ends, attrs in records:
            a, b = ends[0], ends[-1]
            values = [attrs[k] for k in keys] + [a[0], a[1], b[0], b[1]]
            rows.append(";".join(_csv(v) for v in values))
        return "\n".join(rows) + "\n"

    def has_results(self):
        return any(m.result for m in self.tool.measures())


def _csv(value):
    if value is None:
        return ""
    if isinstance(value, float):
        return repr(round(value, 7)).replace(".", ",")
    text = str(value)
    return '"' + text.replace('"', '""') + '"' if any(c in text for c in ';"\n') else text
