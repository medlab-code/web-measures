# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Application de mesure dans le navigateur : la session de mesure du cœur du plugin
(core/session.py), reliée à la page (src/app.js), qui en appelle les méthodes ; les résultats
sont rendus en JSON (texte). Ce qui est propre à la page reste ici : services du navigateur
(web_host), dessin de la carte en GeoJSON, filtre des photos, calage enregistré dans le
navigateur, exports CSV et GeoJSON, capture Full HD. Quand une lecture réseau ou un calcul
aboutit après coup, la session appelle notify() pour que la page se redessine.
"""

import json
import math
from datetime import datetime

import web_host
from core import autotilt, capture, filters, measures, metadata, session, widths
from core.session import GROUND_MODES, MODES  # noqa: F401 (modes de la page)


class WebItem:
    """Dessin d'une mesure sur la carte (voir measures.MeasureTool.new_item) : gardé ici, rendu
    en GeoJSON par App.map_geojson."""

    def __init__(self):
        self.points, self.label, self.extras = [], "", []
        self.removed = False

    def set_data(self, points, label="", extras=None):
        self.points, self.label, self.extras = list(points), label, list(extras or [])

    def remove(self):
        self.removed = True


class RaysItem:
    """Visées sur la carte (triangulation, repères du calage du cap) : voir
    tools.Triangulator.new_item."""

    def __init__(self, calibration=False):
        self.rays, self.point = [], None
        self.calibration = calibration  # repères du calage du cap : dessinés à part (noir)
        self.removed = False

    def set_data(self, rays, point):
        self.rays, self.point = list(rays), point

    def remove(self):
        self.removed = True


class App(session.Session):
    def __init__(self, notify, remote=None, api_url=web_host.API_URL):
        web_host.install(remote, api_url)
        if remote is not None:
            autotilt.HAS_NUMPY = True  # verticales calculées dans le Pyodide d'arrière-plan, qui a numpy
        super().__init__(notify)
        self.items, self.rays = [], []
        self.tool.new_item = self._new_item
        self.triangulator.new_item = self._new_rays
        self.calibrator.new_item = lambda: self._new_rays(calibration=True)
        self.photo_filter = filters.PhotoFilter()

    # Données pour la page (JSON) -------------------------------------------------------
    def set_picture(self, item_json):
        """Photo affichée dans la visionneuse : sa fiche STAC (texte JSON)."""
        return super().set_picture(json.loads(item_json))

    def state(self):
        return json.dumps(super().state())

    def viewer_marks(self):
        return json.dumps(super().viewer_marks())

    def focus(self):
        return json.dumps(super().focus())

    def handles(self):
        return json.dumps(super().handles())

    def results(self):
        return json.dumps(super().results())

    def take_proposal(self):
        return json.dumps(super().take_proposal())

    # Dessin ------------------------------------------------------------------------------
    def _new_item(self):
        item = WebItem()
        self.items.append(item)
        return item

    def _new_rays(self, calibration=False):
        item = RaysItem(calibration)
        self.rays.append(item)
        return item

    def set_filter(self, text):
        """Filtre des photos (JSON : since, kind, max_gps, producer [id, nom])."""
        data = json.loads(text) if text else {}
        producer = data.get("producer")
        self.photo_filter = filters.PhotoFilter(data.get("since") or None, data.get("kind") or None,
                                                data.get("max_gps"), tuple(producer) if producer else None)

    def filter_matches(self, item_json):
        return self.photo_filter.matches(json.loads(item_json))

    def filter_text(self):
        return self.photo_filter.describe()

    def producer(self):
        """Producteur de la photo affichée (JSON [id, nom] ou null)."""
        p = filters.item_producer(self.item)
        return json.dumps(list(p) if p else None)

    # Calage enregistré ---------------------------------------------------------------
    def calibration_json(self):
        return json.dumps(self.calibration.to_dict(), separators=(",", ":"))

    def load_calibration(self, text):
        """Calage enregistré dans le navigateur : remplace celui en mémoire. Retourne False
        s'il est illisible."""
        try:
            data = json.loads(text) if text else None
        except ValueError:
            return False
        self.calibration.load(data)
        return True

    def merge_calibration(self, text):
        """Calage d'un fichier : complète celui en mémoire. Retourne le nombre de photos ou
        séquences ajoutées, ou -1 si le fichier est illisible."""
        try:
            added = self.calibration.merge(json.loads(text))
        except (ValueError, TypeError, AttributeError):
            return -1
        if added:
            self._calibration_changed()
        return added

    def map_geojson(self):
        """Mesures, visées et points triangulés à dessiner sur la carte (GeoJSON, texte)."""
        features = []

        def add(kind, geometry_type, coordinates, label="", sublabel=""):
            properties = {"kind": kind, "label": label}
            if sublabel:  # sous le trait, le long de celui-ci
                properties["sublabel"] = sublabel
            features.append({"type": "Feature", "properties": properties,
                             "geometry": {"type": geometry_type, "coordinates": coordinates}})

        self.items = [i for i in self.items if not i.removed]
        for item in self.items:
            if not item.points:
                continue
            if len(item.points) >= 2:
                add("mesure", "LineString", [list(p) for p in item.points], item.label)
            for p in item.points:
                add("point", "Point", list(p))
            if len(item.points) == 1 and item.label:  # hauteur : étiquette au pied
                add("etiquette", "Point", list(item.points[0]), item.label)
        self.rays = [r for r in self.rays if not r.removed]
        for item in self.rays:
            for lon, lat, elon, elat in item.rays:
                add("calage" if item.calibration else "visee", "LineString", [[lon, lat], [elon, elat]])
            if item.point:
                add("repere" if item.calibration else "cible", "Point", list(item.point))
        road = (self.ref_point or {}).get("road") if self.active and self.mode == "road" else None
        if road:  # largeur : droite de mesure passant par le point de référence
            add("trace", "LineString", [list(p) for p in widths.guide(self.ref_point, road["axis"])])
        for lon, lat, values in self.points:
            add("triangule", "Point", [lon, lat], values["nom"])  # nom seul : pas d'incertitude sur la carte
        for i, j, values in self.links:  # distance entre deux points gardés : trait rouge, comme une mesure
            add("distance", "LineString", [list(self.points[i][:2]), list(self.points[j][:2])],
                "{}↔{} {} m".format(self.points[i][2]["nom"], self.points[j][2]["nom"],
                                    round(values["valeur_m"])))  # au mètre près : précision de la triangulation
        return json.dumps({"type": "FeatureCollection", "features": features})

    # Export ------------------------------------------------------------------------------
    def _records(self):
        """Mesures terminées et points triangulés : (géométrie [(lon, lat)], attributs), comme
        les couches du plugin."""
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
                "axe_route": m.axis_source if m.kind == "road" else None,
                "recales": len(m.overrides),
                "photos": ",".join(dict.fromkeys(c.get("pic") or "" for c in m.clicks)),
                "date_mesure": datetime.now().isoformat(timespec="seconds"),
                "commentaire": getattr(m, "comment", ""),
            }))
        for lon, lat, values in self.points:
            out.append(([(lon, lat)], dict({"type": "point triangulé"}, **values)))
        for i, j, values in self.links:
            (lon1, lat1, v1), (lon2, lat2, v2) = self.points[i], self.points[j]
            out.append(([(lon1, lat1), (lon2, lat2)], {
                "type": "distance entre points triangulés", "valeur_m": values["valeur_m"],
                "incert_m": values["incert_m"], "horiz_m": values["valeur_m"], "points": "{}-{}".format(v1["nom"], v2["nom"]),
                "photos": ",".join(dict.fromkeys(p for v in (v1, v2) for p in v.get("photos", "").split(",") if p)),
                "date_mesure": datetime.now().isoformat(timespec="seconds"),
                "commentaire": values.get("commentaire", ""),
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
        des extrémités en WGS 84 ; mesures et points triangulés dans le même tableau."""
        records = self._records()
        if not records:
            return ""
        keys = list(dict.fromkeys(k for _, attrs in records for k in attrs))
        rows = [";".join(keys + ["lon1", "lat1", "lon2", "lat2"])]
        for ends, attrs in records:
            a, b = ends[0], ends[-1]
            values = [attrs.get(k) for k in keys] + [a[0], a[1], b[0], b[1]]
            rows.append(";".join(_csv(v) for v in values))
        return "\n".join(rows) + "\n"

    # Captures --------------------------------------------------------------------------
    def capture_args(self, yaw, pitch, vfov):
        """Paramètres de la capture HD de la vue (JSON), pour le Pyodide d'arrière-plan :
        photo, cadrage (cap absolu, inclinaison, champ vertical, en degrés), redressement,
        cartouche d'attribution, nom du fichier. "" sans photo HD."""
        item = self.item
        href = (((item or {}).get("assets") or {}).get("hd") or {}).get("href")
        if not href:
            return ""
        props = item.get("properties") or {}
        fov = (props.get("pers:interior_orientation") or {}).get("field_of_view")
        rounded = metadata.item_heading(item) or 0.0
        heading = _view_heading(item, yaw)
        tilt = self.calibration.tilt(item.get("id")) if item.get("id") else None
        date = "".join(ch for ch in (props.get("datetime") or "") if ch.isdigit())[:8] or "sansdate"
        return json.dumps({"href": href, "azimuth": rounded, "is360": bool(fov and float(fov) >= 360),
                           "heading": heading, "pitch": math.degrees(pitch), "vfov": float(vfov),
                           "photo_hfov": float(fov) if fov else None,
                           "up": list(tilt["up"]) if tilt else None,  # vue redressée
                           "caption": capture.caption_for(item, None),  # sans le cap
                           "name": "panoramax_{}_cap{:03.0f}_{}".format(date, heading, (item.get("id") or "")[:8])})

    def caption(self, yaw):
        """Cartouche d'attribution de la vue (obligation des licences Panoramax) : auteur, date,
        catégorie de la licence ; sans le cap (yaw, gardé pour la page, ne sert plus)."""
        if not self.item:
            return "Panoramax"
        return capture.caption_for(self.item, None)


def _view_heading(item, yaw):
    """Cap (degrés) du centre de la vue : la visionneuse s'oriente sur view:azimuth."""
    return (math.degrees(yaw) + (metadata.item_heading(item) or 0.0)) % 360


def _csv(value):
    if value is None:
        return ""
    if isinstance(value, float):
        return repr(round(value, 7)).replace(".", ",")
    text = str(value)
    return '"' + text.replace('"', '""') + '"' if any(c in text for c in ';"\n') else text
