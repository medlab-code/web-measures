# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Application de mesure dans le navigateur : le cœur de calcul du plugin (core/), piloté par
la page (src/app.js). Même enchaînement que le plugin QGIS (plugin.py, viewer_dock.py) :

- clic dans la photo → direction corrigée du calage (tools.photo_click) → profil du terrain
  le long de la visée → point 3D → mesure (measures.MeasureTool) ;
- triangulation : visée du centre de la vue (tools.Triangulator) ;
- calages : inclinaison, cap et position, hauteur de caméra (tools.CalibrationTool) ;
- photo affichée : précision GPS vérifiée (precision.PrecisionChecker), inclinaison
  automatique (autotilt.TiltChecker), axe de la séquence entre les photos voisines.

La page appelle les méthodes de App ; les résultats sont rendus en JSON (texte). Quand une
lecture réseau ou un calcul aboutit après coup, App appelle notify() pour que la page se
redessine.
"""

import json
import math
import traceback
from datetime import datetime

import web_host
from core import autotilt, buildings, calibration, capture, filters, measures, metadata, precision, roads, terrain, tools

GROUND_MODES = ("road", "width", "height", "free")  # mesures par lancer de rayon
CALIBRATION_MODES = ("tilt", "heading", "camera")
MODES = GROUND_MODES + ("tri",) + CALIBRATION_MODES


class WebItem:
    """Dessin d'une mesure ou d'une façade sur la carte (voir measures.MeasureTool.new_item) :
    gardé ici, rendu en GeoJSON par App.map_geojson."""

    def __init__(self, wall=False):
        self.wall = wall
        self.points, self.label, self.extras = [], "", []
        self.removed = False

    def set_data(self, points, label="", extras=None):
        self.points, self.label, self.extras = list(points), label, list(extras or [])

    def remove(self):
        self.removed = True


class RaysItem:
    """Visées sur la carte (triangulation, repères du calage du cap) : voir
    tools.Triangulator.new_item."""

    def __init__(self):
        self.rays, self.point = [], None
        self.removed = False

    def set_data(self, rays, point):
        self.rays, self.point = list(rays), point

    def remove(self):
        self.removed = True


class App:
    def __init__(self, notify, remote=None, api_url=web_host.API_URL):
        web_host.install(remote, api_url)
        if remote is not None:
            autotilt.HAS_NUMPY = True  # verticales calculées dans le Pyodide d'arrière-plan, qui a numpy
        self.notify = notify  # fonction de la page : redessiner après une lecture réseau
        self.items, self.rays = [], []
        self.calibration = calibration.Calibration()
        self.terrain = terrain.TerrainProvider()
        self.roads = roads.RoadAxisProvider()
        self.buildings = buildings.BuildingProvider()
        self.precision = precision.PrecisionChecker()
        self.tilts = autotilt.TiltChecker()
        self.roads.ready = self._roads_ready
        self.buildings.ready = self._buildings_ready
        self.tool = measures.MeasureTool(None)
        self.tool.new_item = self._new_item
        self.tool.calibration = self.calibration
        self.tool.road_lookup = self.roads.lookup
        self.tool.wall_lookup = self.buildings.lookup
        self.triangulator = tools.Triangulator()
        self.triangulator.new_item = self._new_rays
        self.reference = ("ground", 5.0)  # calage de la hauteur de caméra : longueur connue
        self.calibrator = tools.CalibrationTool(self.calibration, self.current_ids, lambda: self.reference)
        self.calibrator.new_item = self._new_rays
        self.mode = "road"
        self.tool.set_mode("road")
        self.item = None  # fiche STAC de la photo affichée
        self.quality = None  # vérification de sa précision (voir precision.PrecisionChecker)
        self.neighbours = {}  # fiches des photos voisines (axe de la séquence) : id -> fiche
        self.photo_filter = filters.PhotoFilter()
        self.message = ""
        self.new_camera = None  # hauteur de caméra calée, à reporter dans le réglage de la page
        self.points = []  # points triangulés gardés : (lon, lat, attributs)
        self._handles = []  # clés des poignées de la carte, dans l'ordre de handles()
        self.calibration_version = 0  # augmente à chaque changement du calage (à enregistrer)
        self.active = False  # bouton « Mesure » de la page : clics dans la photo pour mesurer
        self.epoch = 0  # change quand les clics en cours sont abandonnés (profil arrivé trop tard)

    # Dessin --------------------------------------------------------------------------
    def _new_item(self, wall=False):
        item = WebItem(wall)
        self.items.append(item)
        return item

    def _new_rays(self):
        item = RaysItem()
        self.rays.append(item)
        return item

    def current_ids(self):
        item = self.item or {}
        return item.get("id"), item.get("collection")

    def _active(self):
        """Outil du mode : MeasureTool, Triangulator ou CalibrationTool."""
        if self.mode == "tri":
            return self.triangulator
        if self.mode in CALIBRATION_MODES:
            if self.calibrator.mode != self.mode:
                self.calibrator.set_mode(self.mode)
            return self.calibrator
        self.tool.set_mode(self.mode)
        return self.tool

    def _calibration_changed(self):
        self.calibration_version += 1

    # Réglages ------------------------------------------------------------------------
    def set_active(self, on):
        """Bouton « Mesure » : activé, les clics dans la photo mesurent et l'inclinaison de la
        photo est calculée ; désactivé, les mesures en cours sont terminées (les mesures réussies
        restent affichées), comme dans le plugin."""
        self.active = bool(on)
        self.message = ""
        if self.active:
            if self.item:
                pic = self.item.get("id")
                self.tilts.check(self.item, self.calibration, lambda: self._on_tilt(pic))
        else:
            self._clear_measures()
        return self.status()

    def set_mode(self, mode):
        if mode not in MODES:
            return self.status()
        self._clear_measures()
        self.mode = mode
        self.message = ""
        self._active()
        return self.status()

    def _clear_measures(self):
        """Termine les mesures en cours (réussies, elles restent affichées) ; le calage déjà
        fait est conservé (comme le plugin à un changement de mode)."""
        self.epoch += 1
        self.triangulator.clear()
        self.tool.finish()
        self.calibrator.reset()

    def set_camera_height(self, value):
        self.tool.set_camera_height(float(value))
        return self.status()

    def set_use_wall(self, value):
        self.tool.set_use_wall(bool(value))
        return self.status()

    def set_surface(self, surface):
        self.tool.set_surface(surface)
        return self.status()

    def set_plane_height(self, value):
        self.tool.set_plane_height(float(value))
        return self.status()

    def start_facade(self):
        self.tool.start_facade()
        return self.status()

    def start_wall_facade(self):
        self.tool.start_wall_facade()
        return self.status()

    def set_bridge(self, value):
        """« Mesure sur un pont » : sol plat sous la caméra ; les profils déjà lus ne valent plus."""
        self.terrain.bridge = bool(value)
        self.epoch += 1
        self.tool.clear()
        self.calibrator.reset()
        self.message = ""
        return self.status()

    def set_reference(self, kind, length):
        """Référence du calage de la hauteur de caméra : "ground" (longueur au sol) ou "height"
        (hauteur d'un objet), en m."""
        self.reference = ("height" if kind == "height" else "ground", float(length))
        if self.mode == "camera":
            self.calibrator.reset()  # clics en attente faits pour l'ancienne référence
        return self.status()

    def set_api_url(self, url):
        """Instance Panoramax choisie : recherches du cœur (précision GPS, trajectoire)."""
        web_host.host.api_url = url
        self.neighbours = {}

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

    # Photo affichée ------------------------------------------------------------------
    def set_picture(self, item_json):
        """Photo affichée dans la visionneuse : sa fiche STAC (texte JSON)."""
        item = json.loads(item_json)
        self.item = item
        pic = item.get("id")
        self.quality = self.precision.known(item)
        self.precision.check(item, lambda res: self._on_precision(pic, res))
        for rel in ("prev", "next"):  # voisines : axe de la séquence
            nid = metadata.id_from_href(metadata.item_link(item, rel))
            if nid and nid not in self.neighbours:
                web_host.fetch_json("{}/search?ids={}".format(web_host.host.api_url, nid),
                                    lambda data, error, nid=nid: self._on_neighbour(nid, data))
        if self.active:
            self.tilts.check(item, self.calibration, lambda: self._on_tilt(pic))
        return self.status()

    def _on_neighbour(self, nid, data):
        features = (data or {}).get("features") or []
        if features:
            self.neighbours[nid] = features[0]
            if len(self.neighbours) > 200:
                self.neighbours.pop(next(iter(self.neighbours)))

    def _axis(self, item):
        def neighbour(rel):
            return self.neighbours.get(metadata.id_from_href(metadata.item_link(item, rel)))
        return metadata.sequence_axis(item, neighbour("prev"), neighbour("next"))

    def _on_precision(self, pic, res):
        if pic != (self.item or {}).get("id"):
            return  # photo déjà quittée
        self.quality = res
        self.notify()

    def _on_tilt(self, pic):
        """Inclinaison automatique arrivée : clics déjà faits sur la photo corrigés."""
        self._calibration_changed()
        cal = self.calibration

        def correct(c):
            gps = c.get("gps") or [None, None]
            return cal.correct(pic, c.get("sequence"), c["raw"][0], c["raw"][1], gps[0], gps[1])

        try:
            self.tool.recorrect(pic, correct)
        except Exception:
            traceback.print_exc()
        self.notify()

    def _heading(self):
        """Cap du centre de l'image (degrés) : EXIF précis, sinon view:azimuth."""
        precise = metadata.precise_heading(self.item)
        return precise if precise is not None else (metadata.item_heading(self.item) or 0.0)

    # Clics -------------------------------------------------------------------------------
    def click(self, yaw, pitch):
        """Clic dans la photo affichée : direction dans le repère de la photo (radians, cap
        relatif au centre de l'image, comme le donne la visionneuse)."""
        if not self.active:
            return self.status()
        if not self.item:
            self.message = "Photo en cours de chargement : cliquez à nouveau."
            return self.status()
        if self.mode == "tri":
            self.message = "Triangulation : placez le réticule sur l'objet puis « Viser »."
            return self.status()
        raw_yaw = (math.degrees(yaw) + self._heading()) % 360
        click = tools.photo_click(self.item, raw_yaw, math.degrees(pitch), self.calibration, self.quality,
                                  [yaw, pitch], self._axis(self.item))
        if click is None:
            self.message = "Position de la photo inconnue."
            return self.status()
        self.message = ""
        tool = self._active()
        if tool is self.tool and tool.select_near(click):
            return self.status()  # repère d'un point : sélectionné pour le viser à nouveau
        if not tool.needs_profile():
            tool.add_click(click)  # sommet d'un objet ou calage : pas de terrain
            self._after_calibration(tool)
            return self.status()
        self.message = "Altitude du terrain le long de la visée…"
        epoch = self.epoch
        self.terrain.profile(click["lon"], click["lat"], click["yaw"],
                             lambda profile, label, warning: self._profiled(epoch, tool, click, profile, label,
                                                                            warning))
        return self.status()

    def _profiled(self, epoch, tool, click, profile, label, warning):
        if epoch != self.epoch:
            return  # mode changé, mesure effacée ou désactivée entre-temps : clic abandonné
        try:
            click.update(profile=profile, terrain=label, precise_ground=label in terrain.PRECISE_LABELS)
            tool.add_click(click, warning)
            self.message = ""  # la mesure en cours dit la suite (status)
            self._after_calibration(tool)
        except Exception:
            traceback.print_exc()
        self.notify()

    def _after_calibration(self, tool):
        if tool is not self.calibrator:
            return
        self._calibration_changed()
        if tool.new_camera is not None:
            self.new_camera, tool.new_camera = tool.new_camera, None

    def take_camera_height(self):
        """Hauteur de caméra juste calée (à reporter dans le réglage « Caméra à »), ou None."""
        height, self.new_camera = self.new_camera, None
        return height

    def waiting_map(self):
        """Calage du cap : le repère cliqué dans la photo attend son clic sur la carte."""
        return self.mode == "heading" and self.calibrator.waiting_map()

    def map_click(self, lon, lat):
        """Clic sur la carte pendant le calage du cap : le repère. Retourne True s'il a servi."""
        if not self.waiting_map():
            return False
        self.calibrator.add_map_point(float(lon), float(lat))
        self._calibration_changed()
        return True

    def cancel_landmark(self):
        self.calibrator.reset()
        return self.status()

    def aim(self, yaw, pitch):
        """Triangulation : visée du centre de la vue (radians, dans le repère de la photo)."""
        if not self.active:
            return self.status()
        if not self.item:
            self.message = "Aucune photo affichée : impossible de viser."
            return self.status()
        sighting = tools.photo_sighting(self.item, (math.degrees(yaw) + self._heading()) % 360,
                                        math.degrees(pitch), self.calibration, self.quality)
        if sighting is None:
            self.message = "Position de la photo inconnue : impossible de viser."
            return self.status()
        self.message = ""
        self.triangulator.add(sighting)
        return self.status()

    def keep_point(self):
        """Garde le point triangulé (exporté avec les mesures), puis repart de zéro."""
        values = self.triangulator.attributes()
        if values is None:
            self.message = self.triangulator.error or "Il faut au moins deux visées qui se croisent."
            return self.status()
        r = self.triangulator.result
        values["commentaire"] = ""
        self.points.append((r["lon"], r["lat"], values))
        self.triangulator.clear()
        self.message = "Point gardé (incertitude ±{} m) : il sera exporté avec les mesures.".format(
            measures._num(r["uncertainty"]))
        return self.status()

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
        """« Effacer » : sélection d'un point, mesure en cours, visées, ou calage du mode."""
        self.message = ""
        tool = self._active()
        if tool is self.tool and tool.cancel_selection():
            return self.status()
        self.epoch += 1
        tool.clear()
        if tool is self.calibrator:
            self._calibration_changed()
        return self.status()

    def clear_all(self):
        self.epoch += 1
        self.triangulator.clear()
        self.tool.clear_all()
        self.calibrator.reset()
        self.points = []
        self.message = ""
        return self.status()

    def _roads_ready(self):
        if self.tool.recompute_roads():
            self.notify()

    def _buildings_ready(self):
        self.tool.recompute_walls()
        self.notify()

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

    # Affichage -----------------------------------------------------------------------
    def status(self):
        """Texte de la mesure (consigne ou résultat)."""
        if not self.active:
            return self.message or "Cliquez « 📐 Mesure » pour mesurer dans la photo ou la caler."
        return self.message or self._active().status()

    def state(self):
        """État de la photo affichée (JSON) : ligne de qualité, calage, hauteur de caméra
        proposée, raisons du mode dégradé…"""
        item, pic = self.item, (self.item or {}).get("id")
        lon = lat = None
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        except (KeyError, TypeError, ValueError):
            pass
        suggestion = precision.camera_suggestion(self.quality) if item else None
        tilt = tools.tilt_state(self.calibration, pic, bool(pic) and self.tilts.pending(pic))
        sequence = (item or {}).get("collection")
        return json.dumps({
            "quality": precision.state_text(self.quality, metadata.item_accuracy(item), tilt) if item else "",
            "calibration": tools.calibration_text(self.calibration, pic, sequence, lon, lat) if item else "",
            "camera": [round(suggestion[0], 2), suggestion[1]] if suggestion else None,
            "degraded": precision.degraded_reasons(self.quality) if precision.degraded(self.quality) else [],
            "advice": precision.DEGRADED_ADVICE,
            "waiting_map": self.waiting_map(),
            "point": self.triangulator.result is not None,
            "active": self.active,
        })

    def viewer_marks(self):
        """Repères de la photo affichée (JSON) : pour chaque mesure, points (cap et élévation
        dans le repère de la photo, radians), libellé, point sélectionné."""
        pic = (self.item or {}).get("id")
        marks = self.tool.done_marks()
        if self.active and self.mode in GROUND_MODES:  # mesure ou calage en cours
            marks = marks + [self.tool.viewer_marks()]
        elif self.active and self.mode in CALIBRATION_MODES:
            marks = marks + [self.calibrator.viewer_marks()]
        out = []
        for m in marks:
            points = [p for p in m["points"] if p.get("pic") == pic and p.get("yaw") is not None]
            if points:
                out.append({"points": [[p["yaw"], p["pitch"], bool(p.get("sel"))] for p in points],
                            "label": m.get("label", ""), "beside": m.get("beside", False)})
        return json.dumps(out)

    def handles(self):
        """Poignées déplaçables sur la carte (JSON) : [[lon, lat, façade ?]], repérées par leur
        rang pour move_handle. Seulement en mesure, comme dans le plugin."""
        handles = self.tool.handles() if self.active and self.mode in GROUND_MODES else []
        self._handles = [key for key, _, _ in handles]
        return json.dumps([[lon, lat, key[0] == "facade"] for key, lon, lat in handles])

    def map_geojson(self):
        """Mesures, façades, visées et points triangulés à dessiner sur la carte (GeoJSON, texte)."""
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
            if item.wall or not item.extras:
                if len(item.points) >= 2:
                    add("facade" if item.wall else "mesure", "LineString", [list(p) for p in item.points], item.label)
            else:  # largeur perpendiculaire : plan perpendiculaire à la route, puis trait de la visionneuse
                if len(item.points) >= 2:
                    add("trace", "LineString", [list(p) for p in item.points])
                if len(item.extras) >= 2:
                    add("mesure", "LineString", [list(item.extras[0]), list(item.extras[-1])], item.label,
                        "plan perpendiculaire")
            for p in ([] if item.wall else (item.extras if item.extras else item.points)):
                add("point", "Point", list(p))
            for start, end in zip(item.points, item.extras):  # pointillés vers les bords cliqués
                add("lien", "LineString", [list(start), list(end)])
            if len(item.points) == 1 and item.label:  # hauteur : étiquette au pied
                add("etiquette", "Point", list(item.points[0]), item.label)
        self.rays = [r for r in self.rays if not r.removed]
        for item in self.rays:
            for lon, lat, elon, elat in item.rays:
                add("visee", "LineString", [[lon, lat], [elon, elat]])
            if item.point:
                add("cible", "Point", list(item.point))
        for lon, lat, values in self.points:
            add("triangule", "Point", [lon, lat], "±{} m".format(measures._num(values["incert_m"], 2)))
        return json.dumps({"type": "FeatureCollection", "features": features})

    def results(self):
        """Mesures terminées et points gardés, pour la liste de la page (JSON)."""
        out = [{"id": id(m), "kind": "mesure", "text": m.label(), "comment": getattr(m, "comment", "")}
               for m in self.tool.measures() if m.result]
        out += [{"id": i, "kind": "point", "text": "Point triangulé ±{} m".format(measures._num(v["incert_m"], 2)),
                 "comment": v.get("commentaire", "")}
                for i, (_, _, v) in enumerate(self.points)]
        return json.dumps(out)

    def set_comment(self, kind, ident, text):
        """Commentaire d'une mesure ou d'un point gardé (champ « commentaire » de l'export)."""
        if kind == "point":
            if 0 <= ident < len(self.points):
                self.points[ident][2]["commentaire"] = text
            return
        for m in self.tool.measures():  # rangé sur la mesure : effacée, son commentaire disparaît avec elle
            if id(m) == ident:
                m.comment = text

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
                "terrain": " + ".join(sorted({c.get("terrain") for c in m.clicks if c.get("terrain")})),
                "axe_route": m.axis_source if m.kind == "road" else None,
                "recales": len(m.overrides),
                "photos": ",".join(dict.fromkeys(c.get("pic") or "" for c in m.clicks)),
                "date_mesure": datetime.now().isoformat(timespec="seconds"),
                "commentaire": getattr(m, "comment", ""),
            }))
        for lon, lat, values in self.points:
            out.append(([(lon, lat)], dict({"type": "point triangulé"}, **values)))
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

    def has_results(self):
        return bool(self.points) or any(m.result for m in self.tool.measures())

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
                           "caption": capture.caption_for(item, heading),
                           "name": "panoramax_{}_cap{:03.0f}_{}".format(date, heading, (item.get("id") or "")[:8])})

    def caption(self, yaw):
        """Cartouche d'attribution de la vue (obligation des licences Panoramax)."""
        if not self.item:
            return "Panoramax"
        return capture.caption_for(self.item, _view_heading(self.item, yaw))


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
