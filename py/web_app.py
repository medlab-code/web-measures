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
from core import (autotilt, buildings, calibration, capture, filters, geometry, measures, metadata, precision,
                  roads, terrain, tools, triangulation, widths)

GROUND_MODES = ("road", "width", "height")  # mesures par lancer de rayon (voir core/measures.py)
CALIBRATION_MODES = ("tilt", "heading", "camera")
MODES = GROUND_MODES + ("tri",) + CALIBRATION_MODES
REF_MODES = ("height", "road")  # mesures appuyées sur un point de référence triangulé
NUDGE = 0.01  # pas (m) d'un point de largeur déplacé aux flèches du clavier
VERTICAL_LENGTH = 12.0  # m : verticale tracée au-dessus du point de référence d'une hauteur
NUDGE_WORDS = {"left": "vers la gauche", "right": "vers la droite", "up": "en s'éloignant",
               "down": "en se rapprochant"}
# Triangulation et mesures qui s'y appuient : acceptées hors RTK, mais signalées
RTK_WARNING = (" ⚠ Photo sans position GPS RTK vérifiée : mesure probablement incohérente "
               "(la triangulation demande des positions précises).")


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
        self.triangulator.AIM = "Cliquez sur l'objet dans la photo"
        self.triangulator.AIM_AGAIN = "cliquez sur le même objet"
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
        self.links = []  # distances entre deux points gardés : (n° du premier, n° du second, attributs)
        self.named = 0  # points gardés depuis le début : nom du suivant (A, B… voir _point_name)
        self.proposal = None  # (n°, n°) : distance à proposer après l'effacement du point qui les reliait
        # Hauteur, largeur : point de référence triangulé (lon, lat, uncertainty, name, sequences ;
        # largeur : road, axe de la route en ce point, None en cours de lecture), validé : les
        # mesures suivantes s'y appuient, depuis n'importe quelle photo, jusqu'au prochain
        # (new_reference) ; None : à trianguler d'abord
        self.ref_point = None
        self.width_sel = None  # largeur : (mesure, 0 pour le point de référence ou 1 pour le bord) à recaler
        self.last_free = None  # mesure libre : n° du dernier point gardé, relié au suivant
        self.point_views = {}  # nom d'un point gardé -> {photo : [cap, élévation] de sa visée (radians)}
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
        if self._aiming():
            return self.triangulator
        if self.mode in CALIBRATION_MODES:
            if self.calibrator.mode != self.mode:
                self.calibrator.set_mode(self.mode)
            return self.calibrator
        self.tool.set_mode(self.mode)
        return self.tool

    def _aiming(self):
        """Les clics dans la photo sont-ils des visées de triangulation ? En triangulation, et
        en hauteur ou largeur tant que le point de référence n'est pas validé."""
        return self.mode == "tri" or (self.mode in REF_MODES and self.ref_point is None)

    def _calibration_changed(self):
        self.calibration_version += 1

    # Réglages ------------------------------------------------------------------------
    def set_active(self, on):
        """Bouton « Mesure » : activé, les clics dans la photo mesurent et l'inclinaison de la
        photo est calculée ; désactivé, les mesures en cours sont terminées (les mesures réussies
        restent affichées), comme dans le plugin. Les visées de la triangulation restent : on
        peut désactiver la mesure pour aller viser depuis une autre photo."""
        self.active = bool(on)
        self.message = ""
        if self.active:
            self._check_tilt()
        else:
            self._clear_measures(keep_sightings=True)
        return self.status()

    def _check_tilt(self):
        """Inclinaison automatique de la photo affichée, en mesure ou en calage seulement : la
        triangulation ne vise qu'en cap, elle n'en a pas besoin (calcul long évité)."""
        if self.active and self.item and self.mode != "tri":
            pic = self.item.get("id")
            self.tilts.check(self.item, self.calibration, lambda: self._on_tilt(pic))

    def set_mode(self, mode):
        if mode not in MODES:
            return self.status()
        self._clear_measures()
        self.mode = mode
        self.ref_point = None
        self.message = ""
        self._active()
        self._check_tilt()  # en quittant la triangulation
        return self.status()

    def _clear_measures(self, keep_sightings=False):
        """Termine les mesures en cours (réussies, elles restent affichées) ; le calage déjà
        fait est conservé (comme le plugin à un changement de mode)."""
        self.epoch += 1
        if not keep_sightings:
            self.triangulator.clear()
        self.tool.finish()
        self.calibrator.reset()

    def set_camera_height(self, value):
        self.tool.set_camera_height(float(value))
        return self.status()

    def set_use_wall(self, value):
        self.tool.set_use_wall(bool(value))
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
        self._check_tilt()
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
        if self._aiming():
            return self.aim(yaw, pitch)
        raw_yaw = (math.degrees(yaw) + self._heading()) % 360
        click = tools.photo_click(self.item, raw_yaw, math.degrees(pitch), self.calibration, self.quality,
                                  [yaw, pitch], self._axis(self.item))
        if click is None:
            self.message = "Position de la photo inconnue."
            return self.status()
        self.message = ""
        tool = self._active()
        if self.mode == "road":
            return self._width_click(click)
        if self.mode == "height" and tool.selected is not None and \
                click.get("pic") != tool.selected[0].clicks[0].get("pic"):
            self.message = ("Ce point se recale par un clic sur la photo de sa mesure (le pied et le sommet "
                            "y sont visés ensemble) ; ici, flèches ↑ ↓ : 1 cm ; Entrée pour terminer.")
            return self.status()
        # Hauteur : la sélection d'un point se fait au clic droit (select_point) ; le pied d'une
        # nouvelle hauteur tombe sur celui des autres hauteurs du même point de référence
        if tool is self.tool and self.mode != "height" and tool.select_near(click):
            return self.status()  # repère d'un point : sélectionné pour le viser à nouveau
        foot = self._reference_foot() if self.mode == "height" and tool.selected is None and (
            tool.current is None or len(tool.current.clicks) >= tool.current.needed()) else None
        if foot is not None:  # pied déjà visé depuis cette photo à la triangulation : ce clic est le sommet
            self.message = "Altitude du terrain le long de la visée…"
            epoch = self.epoch
            self.terrain.profile(foot["lon"], foot["lat"], foot["yaw"], lambda profile, label, warning: (
                self._profiled(epoch, tool, foot, profile, label, warning),
                self.terrain.profile(click["lon"], click["lat"], click["yaw"], lambda p, lb, wn: self._profiled(
                    epoch, tool, click, p, lb, wn))))
            return self.status()
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
            reaimed = getattr(tool, "selected", None) is not None
            text = tool.add_click(click, warning)
            self.message = text if reaimed else ""  # point recalé : son résultat ; sinon la suite (status)
            self._after_calibration(tool)
            self._anchor_height()
        except Exception:
            traceback.print_exc()
        self.notify()

    def select_point(self, yaw, pitch):
        """Clic droit dans la photo : sélectionne le point de hauteur ou de largeur dont la croix
        est sous le clic, depuis n'importe quelle photo, pour le recaler (clic gauche, flèches du
        clavier, Entrée pour terminer)."""
        if not self.active or not self.item or self.mode not in REF_MODES:
            return self.status()
        click = tools.photo_click(self.item, (math.degrees(yaw) + self._heading()) % 360, math.degrees(pitch),
                                  self.calibration, self.quality, [yaw, pitch], self._axis(self.item))
        if click is None:
            return self.status()
        self.message = ""
        if self.mode == "road":
            self.width_sel = self._width_near(click)
            found = self.width_sel is not None
        else:
            self.tool.selected = self._height_near(click)
            found = self.tool.selected is not None
        if not found:
            self.message = "Aucune croix de mesure sous le clic droit."
        return self.status()

    def _width_click(self, click):
        """Largeur : le bord opposé, sur la droite perpendiculaire passant par le point de
        référence (voir core/widths.py). Chaque clic donne une largeur ; un point sélectionné
        au clic droit (select_point) est recalé par le clic suivant (voir _recale_width)."""
        if self.width_sel is not None:
            return self._recale_width(click)
        ref = self.ref_point
        if ref.get("road") is None:
            self._road_at_reference()
            if ref.get("road") is None:
                self.message = "Axe de la route en cours de lecture (BD TOPO) : cliquez à nouveau dans un instant."
                return self.status()
        m = widths.PerpendicularWidth(self.tool, ref, ref["road"], click)
        if m.error:
            m.remove()
            self.message = m.error
            return self.status()
        self.tool.done.append(m)
        self.message = (m.status() + self._rtk_warning(ref["sequences"] + [click.get("sequence")])
                        + " Autre largeur depuis ce point : cliquez un autre bord ; sinon « Nouveau point de référence »."
                          " Clic droit sur une croix : la recaler.")
        return self.status()

    def _width_points(self, m):
        """Repères du point de référence et du bord d'une largeur dans la photo affichée :
        [{yaw, pitch (radians, repère de la photo), abs_yaw, elev (degrés)}]. Le point de
        référence, projeté au sol comme la droite de mesure (il est dessus) ; le bord, là où il
        a été cliqué sur sa photo, projeté au sol sur les autres."""
        pic = (self.item or {}).get("id")
        points = [self._project(plon, plat) for plon, plat in m.result["points"]]
        if pic is not None and pic == m.clicks[1].get("pic"):
            p = m.viewer_marks()["points"][1]
            points[1] = {"yaw": p["yaw"], "pitch": p["pitch"], "abs_yaw": p["abs_yaw"], "elev": p["elev"]}
        return points

    def _project(self, plon, plat):
        """Repère dans la photo affichée d'un point de la carte, au sol supposé plat (hauteur de
        caméra du réglage) : {yaw, pitch (radians, repère de la photo), abs_yaw, elev (degrés)}."""
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        x, y = triangulation._local(plon, plat, lon, lat)
        bearing = math.degrees(math.atan2(x, y))
        elev = -math.degrees(math.atan2(self.tool.camera_height, max(math.hypot(x, y), 0.5)))
        return {"yaw": math.radians((bearing - self._heading() + 540) % 360 - 180), "pitch": math.radians(elev),
                "abs_yaw": bearing % 360, "elev": elev}

    def _free_mark_point(self, k):
        """Repère du point gardé n° k dans la photo affichée : là où il a été visé depuis elle,
        sinon projeté au sol."""
        lon, lat, values = self.points[k]
        view = self.point_views.get(values["nom"], {}).get(self.item.get("id"))
        point = {"yaw": view[0], "pitch": view[1]} if view else self._project(lon, lat)
        return dict(point, pic=self.item.get("id"))

    def _free_marks(self):
        """Mesure libre : distances (trait et étiquette) et points gardés seuls, dans la photo
        affichée. Les points de référence des hauteurs et largeurs sont montrés par elles."""
        refs = {(m.reference or {}).get("name") for m in self._heights()} | {m.edge.get("name") for m in self._widths()}
        if self.ref_point:
            refs.add(self.ref_point["name"])
        marks, linked = [], set()
        for i, j, values in self.links:
            linked |= {i, j}
            marks.append({"points": [self._free_mark_point(i), self._free_mark_point(j)],
                          "label": "↔ {} m ± {} m".format(measures._num(values["valeur_m"], 2),
                                                          measures._num(values["incert_m"], 2))})
        for k, (_, _, values) in enumerate(self.points):
            if k not in linked and values["nom"] not in refs:
                marks.append({"points": [self._free_mark_point(k)], "label": ""})
        return marks

    def _reference_mark(self):
        """Croix du point de référence validé dans la photo affichée. Hauteur : là où il a été
        visé depuis cette photo, sinon projeté au sol. Largeur : sur la droite de mesure
        (projeté au sol comme elle). None dès qu'une mesure s'y appuie (sa croix le montre)."""
        ref, pic = self.ref_point, self.item.get("id")
        if self.mode == "road" and any(m.edge is ref for m in self._widths()):
            return None
        if self.mode == "height" and any((m.reference or {}).get("name") == ref["name"] for m in self._heights()):
            return None  # le pied des hauteurs qui s'y appuient le montre
        seen = next((s for s in ref.get("sightings", []) if s["pic"] == pic and s.get("view")), None)
        if seen is not None and self.mode != "road":
            point = {"yaw": seen["view"][0], "pitch": seen["view"][1]}
        else:
            point = self._project(ref["lon"], ref["lat"])
        return {"points": [dict(point, pic=pic)], "label": "", "beside": False}

    def _heights(self):
        return [m for m in self.tool.done if m.kind == "height" and m.result]

    def _height_points(self, m):
        """Repères du pied et du sommet d'une hauteur dans la photo affichée : [{yaw, pitch
        (radians, repère de la photo), abs_yaw, elev (degrés)}]. Sur la photo de la mesure, là
        où ils ont été visés ; sur les autres, projetés depuis leur position 3D, la caméra
        supposée à l'altitude de celle de la mesure (repères seulement)."""
        pic = (self.item or {}).get("id")
        if pic == m.clicks[0].get("pic"):
            return [{"yaw": p["yaw"], "pitch": p["pitch"], "abs_yaw": p["abs_yaw"], "elev": p["elev"]}
                    for p in m.viewer_marks()["points"]]
        pts, _, origin, _ = m.points()
        c0 = m.clicks[0]
        z0 = measures._ground_z(m.clicks)[c0.get("pic")]
        cam_z = geometry.camera(c0, self.tool.camera_for(c0, z0), origin, z0)[0][2]
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        cx, cy = triangulation._local(lon, lat, *origin)
        heading, out = self._heading(), []
        for x, y, z in pts:
            bearing = math.degrees(math.atan2(x - cx, y - cy))
            elev = math.degrees(math.atan2(z - cam_z, max(math.hypot(x - cx, y - cy), 0.5)))
            out.append({"yaw": math.radians((bearing - heading + 540) % 360 - 180), "pitch": math.radians(elev),
                        "abs_yaw": bearing % 360, "elev": elev})
        return out

    def _height_near(self, click):
        """(hauteur, n° de point) dont le repère est le plus près du clic sur la photo
        affichée (à moins de measures.SELECT_ANGLE degrés), ou None."""
        return self._nearest(click, [(m, self._height_points(m)) for m in self._heights()])

    def _nearest(self, click, candidates):
        raw = click.get("raw") or [click["yaw"], click["elev"]]
        best, best_d = None, measures.SELECT_ANGLE
        for m, points in candidates:
            for index, p in enumerate(points):
                dyaw = (raw[0] - p["abs_yaw"] + 540) % 360 - 180
                d = math.hypot(dyaw * math.cos(math.radians(raw[1])), raw[1] - p["elev"])
                if d < best_d:
                    best, best_d = (m, index), d
        return best

    def _widths(self):
        return [m for m in self.tool.measures() if isinstance(m, widths.PerpendicularWidth) and m.result]

    def _width_near(self, click):
        """(largeur, n° de point) dont le repère est le plus près du clic (à moins de
        measures.SELECT_ANGLE degrés), ou None."""
        return self._nearest(click, [(m, self._width_points(m)) for m in self._widths()])

    def _recale_width(self, click):
        """Point sélectionné d'une largeur, recalé par ce clic : le bord, sur la droite de
        mesure dans la nouvelle direction ; le point de référence, retriangulé avec cette
        visée en plus (celle déjà faite depuis cette photo remplacée), et toutes les largeurs
        qui s'y appuient recalculées."""
        m, index = self.width_sel
        self.width_sel = None
        if index == 1:
            m.reaim(1, click)
            self.message = (m.error + " " if m.error else "") + m.status() + " Bord recalé."
            return self.status()
        edge = m.edge
        sighting = tools.photo_sighting(self.item, click["raw"][0], click["raw"][1], self.calibration, self.quality)
        if sighting is None:
            self.message = "Position de la photo inconnue : point de référence non recalé."
            return self.status()
        sighting["view"] = click.get("pos")
        tri = tools.Triangulator()
        tri.sightings = [s for s in edge.get("sightings", []) if s["pic"] != sighting["pic"]] + [sighting]
        tri._compute()
        values = tri.attributes()
        if values is None:
            self.message = "Point de référence non recalé : {}".format(tri.error or "il faut deux visées.")
            return self.status()
        r = tri.result
        edge.update(lon=r["lon"], lat=r["lat"], uncertainty=r["uncertainty"], sightings=tri.sightings,
                    sequences=[s.get("sequence") for s in tri.sightings])
        for k, (_, _, v) in enumerate(self.points):  # le point gardé du même nom suit
            if v["nom"] == edge["name"]:
                self.points[k] = (r["lon"], r["lat"], dict(v, **values))
        for w in self.tool.measures():
            if isinstance(w, widths.PerpendicularWidth) and w.edge is edge:
                w.clicks[0] = w._edge_mark(w.clicks[1])
                w.compute()
        self.message = "Point de référence {} retriangulé avec {} visées (±{} m) : largeurs recalculées.".format(
            edge["name"], len(tri.sightings), measures._num(r["uncertainty"], 2))
        return self.status()

    def nudge_point(self, key):
        """Flèches du clavier sur le point sélectionné (key : "left", "right", "up", "down"),
        qui reste sélectionné : hauteur, pied ou sommet monté (↑) ou descendu (↓) de 1 cm ;
        largeur, voir _nudge_width."""
        if key not in NUDGE_WORDS or not self.item:
            return self.status()
        if self.mode == "height" and self.tool.selected is not None:
            m, index = self.tool.selected
            if key in ("up", "down"):
                m.lift(index, NUDGE if key == "up" else -NUDGE)
                self.message = (m.error + " " if m.error else "") + (m.status() if m.result else "")
            else:
                self.message = "← → sans effet sur une hauteur : ↑ ↓ montent ou descendent le point."
            self.message += " Flèches ↑ ↓ : encore 1 cm ; clic : recaler ; Entrée : terminer."
            return self.status()
        return self._nudge_width(key)

    def finish_point(self):
        """Touche Entrée : fin du calage du point sélectionné (hauteur ou largeur), qui
        redevient un point ordinaire ; le résultat de sa mesure s'affiche."""
        if self.mode == "height" and self.tool.selected is not None:
            m = self.tool.selected[0]
            self.tool.cancel_selection()
            self.message = m.status() if m.result else ""
            return self.status()
        return self.finish_width()

    def _nudge_width(self, key):
        """Flèches du clavier : point sélectionné d'une largeur déplacé de 1 cm le long de la
        droite de mesure, dans le sens vu sur la photo affichée (key : "left", "right" ; "up" :
        en s'éloignant de la caméra, "down" : en s'en rapprochant). Il reste sélectionné. Le
        point de référence entraîne toutes les largeurs qui en partent."""
        if self.width_sel is None:
            return self.status()
        m, index = self.width_sel
        d = self._nudge_sign(m, index, key) * NUDGE  # le long de widths.perpendicular(axe)
        if index == 1:
            m.nudge(d * m.side())  # vers l'extérieur du point de référence : plus large
            self.message = m.status()
        else:
            edge = m.edge
            mates = [w for w in self._widths() if w.edge is edge]
            widths.move_edge(edge, m.road["axis"], d)
            self._edge_moved(edge, mates)
            if any(w.error or w.result["value"] < widths.MIN_WIDTH for w in mates):
                widths.move_edge(edge, m.road["axis"], -d)  # au-delà d'un bord : refusé
                self._edge_moved(edge, mates)
                self.message = "Le point de référence ne passe pas au-delà du bord."
            else:
                self.message = "Point de référence {} déplacé de 1 cm {}. {}".format(
                    edge["name"], NUDGE_WORDS[key], m.status())
        self.message += " Flèches : encore 1 cm ; clic : recaler ; Entrée : terminer."
        return self.status()

    def finish_width(self):
        """Touche Entrée : fin du calage du point sélectionné d'une largeur, qui redevient un
        point ordinaire ; le résultat de la largeur s'affiche."""
        if self.width_sel is not None:
            m = self.width_sel[0]
            self.width_sel = None
            self.message = m.status() if m.result else ""
        return self.status()

    def _nudge_sign(self, m, index, key):
        """Sens (+1 ou -1, le long de widths.perpendicular(axe)) qui déplace le point n° index
        de la largeur m vers la droite (ou s'éloigne de la caméra) sur la photo affichée."""
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        x, y = triangulation._local(*m.result["points"][index], lon, lat)
        ux, uy = widths.perpendicular(m.road["axis"])
        if key in ("up", "down"):
            sign = 1 if x * ux + y * uy > 0 else -1  # +u éloigne de la caméra
        else:
            sign = 1 if x * uy - y * ux < 0 else -1  # +u tourne le cap vers la droite (sens horaire)
        return sign if key in ("right", "up") else -sign

    def _edge_moved(self, edge, mates):
        """Point de référence déplacé : son point gardé et ses largeurs suivent."""
        for k, (_, _, v) in enumerate(self.points):
            if v["nom"] == edge["name"]:
                self.points[k] = (edge["lon"], edge["lat"], v)
        for w in mates:
            w.clicks[0] = w._edge_mark(w.clicks[1])
            w.compute()

    def _road_at_reference(self):
        """Axe de la route au point de référence de la largeur : tronçon de la BD TOPO qui
        longe la trajectoire de la photo, sinon trajectoire de la séquence (voir roads.py).
        Laisse road à None pendant la lecture (reprise par _roads_ready)."""
        ref = self.ref_point
        track = self._axis(self.item) if self.item else None
        heading = track if track is not None else metadata.item_heading(self.item or {})
        res = self.roads.lookup(ref["lon"], ref["lat"], None if heading is None else (heading + 90) % 360,
                                (self.item or {}).get("collection"))
        if isinstance(res, dict):
            ref["road"] = {"axis": res["axis"], "source": res["source"]}
        elif res != "pending":
            ref["road"] = {"axis": heading or 0.0,
                           "source": "séquence" if track is not None else "orientation de la photo"}

    def new_reference(self):
        """Hauteur : « Nouveau point de référence » ; les hauteurs déjà faites restent."""
        self.epoch += 1  # pied cliqué en attente de son profil : abandonné
        self.tool.clear()
        self.triangulator.clear()
        self.ref_point = None
        self.message = ""
        return self.status()

    def _reference_foot(self):
        """Hauteur : clic du pied pris dans la visée du point de référence faite depuis la photo
        affichée (le pied est le point triangulé), ou None si elle n'a pas servi à le viser."""
        ref = self.ref_point
        seen = next((s for s in (ref or {}).get("sightings", [])
                     if s["pic"] == (self.item or {}).get("id") and s.get("view")), None)
        if seen is None:
            return None
        yaw, pitch = seen["view"]
        return tools.photo_click(self.item, (math.degrees(yaw) + self._heading()) % 360, math.degrees(pitch),
                                 self.calibration, self.quality, [yaw, pitch], self._axis(self.item))

    def _anchor_height(self):
        """Hauteur terminée : calée sur le point de référence, qui reste pour les suivantes."""
        m = self.tool.current
        if self.mode != "height" or self.ref_point is None or m is None or not m.result or m.reference:
            return
        ref = self.ref_point
        m.anchor(ref["lon"], ref["lat"], ref["uncertainty"], ref["name"])
        if m.error:
            self.message = m.error
            return
        self.message = (m.status() + self._rtk_warning(ref["sequences"] + [c.get("sequence") for c in m.clicks])
                        + " Autre hauteur sur ce point : cliquez un autre sommet, depuis cette photo ou une autre "
                          "de la triangulation ; sinon « Nouveau point de référence ». Clic droit sur une croix : "
                          "la recaler.")
        self.tool.finish()  # mesure terminée : affichée avec les autres pendant les visées suivantes

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
        """Triangulation : visée de la direction cliquée (radians, dans le repère de la photo)."""
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
        sighting["view"] = [yaw, pitch]  # repère de la visée dans la photo (viewer_marks)
        replaced = any(s["pic"] == sighting["pic"] for s in self.triangulator.sightings)
        self.triangulator.add(sighting)
        if replaced:  # une visée par photo : un second clic (le sommet ?) remplace la première
            self.message = "Visée de cette photo remplacée : une seule visée par photo. "
            if self.mode == "height":
                self.message += ("Étape 1 : visez le pied de l'objet depuis une autre photo (flèches pour changer "
                                 "de photo), puis « Valider le point » ; le pied et le sommet se cliquent ensuite.")
            elif self.mode == "road":
                self.message += ("Étape 1 : visez le premier bord depuis une autre photo (flèches pour changer "
                                 "de photo), puis « Valider le point » ; le bord opposé se clique ensuite.")
            else:
                self.message += "Changez de photo (flèches) pour viser le même objet d'un autre point de vue."
            self.message += self._rtk_warning([s.get("sequence") for s in self.triangulator.sightings])
        return self.status()

    def keep_point(self):
        """Garde le point triangulé (exporté avec les mesures), puis repart de zéro."""
        values = self.triangulator.attributes()
        if values is None:
            self.message = self.triangulator.error or "Il faut au moins deux visées qui se croisent."
            return self.status()
        r = self.triangulator.result
        sightings = self.triangulator.sightings
        sequences = [s.get("sequence") for s in sightings]
        warning = self._rtk_warning(sequences)
        name = _point_name(self.named)
        self.named += 1
        values = dict({"nom": name}, **values, commentaire="")
        self.points.append((r["lon"], r["lat"], values))
        self.point_views[name] = {s["pic"]: s["view"] for s in sightings if s.get("view")}
        self.triangulator.clear()
        if self.mode in REF_MODES:  # point de référence, sans distance au précédent
            self.ref_point = {"lon": r["lon"], "lat": r["lat"], "uncertainty": r["uncertainty"], "name": name,
                              "sequences": sequences, "road": None, "sightings": list(sightings)}
            if self.mode == "height":
                self.message = ("Point de référence {} validé (±{} m) : c'est le pied. Cliquez maintenant le sommet "
                                "de l'objet, depuis cette photo ou une autre de la triangulation (flèches).")
            else:
                self._road_at_reference()
                self.message = ("Point de référence {} validé (±{} m). Cliquez maintenant le bord opposé, au sol, "
                                "depuis une photo prise quelques mètres avant ou après (flèches) : seule la direction "
                                "du clic compte, la largeur se prend sur la droite tracée.")
            self.message = self.message.format(name, measures._num(r["uncertainty"])) + warning
            return self.status()
        self.message = "Point {} gardé (±{} m).".format(name, measures._num(r["uncertainty"]))
        if self.last_free is not None:  # mesure libre : distance au point gardé précédent, aussitôt
            self.message += " " + self._link(self.last_free, len(self.points) - 1)
        self.last_free = len(self.points) - 1
        self.message += (" Visez maintenant le point suivant depuis au moins deux photos : sa distance à {} sera "
                         "calculée.").format(name) + warning
        return self.status()

    def _link(self, i, j):
        """Distance horizontale entre les points gardés n° i et j (la triangulation donne une
        position sur la carte), incertitude des deux points combinée, gardée comme une mesure.
        Retourne le texte à afficher."""
        (lon1, lat1, v1), (lon2, lat2, v2) = self.points[i], self.points[j]
        x, y = triangulation._local(lon2, lat2, lon1, lat1)
        value, unc = math.hypot(x, y), math.hypot(v1["incert_m"], v2["incert_m"])
        self.links.append((i, j, {"valeur_m": round(value, 3), "incert_m": round(unc, 2), "commentaire": ""}))
        return "Distance {}–{} : {} m (±{} m).".format(
            v1["nom"], v2["nom"], measures._num(value, 2), measures._num(unc, 2))

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
        if self.width_sel is not None:
            self.width_sel = None
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
        self.points, self.links, self.named = [], [], 0
        self.last_free, self.point_views = None, {}
        self.ref_point = None
        self.message = ""
        return self.status()

    def _roads_ready(self):
        changed = self.tool.recompute_roads()
        ref = self.ref_point
        if ref is not None and self.mode == "road" and ref.get("road") is None:  # axe au point de référence
            self._road_at_reference()
            changed = changed or ref.get("road") is not None
        if changed:
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
        if self.message:
            return self.message
        if self.width_sel is not None:
            if self.width_sel[1] == 0:
                return ("Point de référence {} sélectionné : cliquez-le à nouveau depuis cette photo, il sera "
                        "retriangulé avec ses autres visées ; flèches du clavier : 1 cm le long de la droite "
                        "(← → dans la photo, ↑ ↓ en s'éloignant ou en se rapprochant) ; Entrée pour "
                        "terminer.").format(
                    self.width_sel[0].edge.get("name", ""))
            return ("Bord de la largeur sélectionné : cliquez sa position exacte, depuis cette photo ou une autre "
                    "(seule la direction compte, il reste sur la droite de mesure) ; flèches du clavier : 1 cm le "
                    "long de la droite (← → dans la photo, ↑ ↓ en s'éloignant ou en se rapprochant) ; Entrée "
                    "pour terminer.")
        if self.mode == "height" and self.tool.selected is not None:
            return ("{} de la hauteur sélectionné : cliquez sa position exacte sur la photo de la mesure, ou "
                    "flèches du clavier ↑ ↓ : 1 cm ; Entrée pour terminer.").format(
                "Pied" if self.tool.selected[1] == 0 else "Sommet")
        text = self._active().status()
        sequences = []
        if self._aiming():
            sequences = [s.get("sequence") for s in self.triangulator.sightings]
        if self.mode == "tri":
            text = "Mesure libre (distance au point gardé précédent) : " + text
        if self.mode == "height" and self.ref_point is None:
            text = ("Hauteur, étape 1/2 : visez le pied de l'objet depuis au moins deux photos (une visée par "
                    "photo, flèches pour changer de photo). " + text)
            if self.triangulator.result is not None:
                text += " Puis « Valider le point »."
        elif self.mode == "height":
            current = self.tool.current
            if (current is None or len(current.clicks) >= current.needed()) and self._reference_foot() is not None:
                text = ("Cliquez le sommet de l'objet : le pied est le point {} visé depuis cette photo.").format(
                    self.ref_point["name"])
            elif current is None or len(current.clicks) >= current.needed():
                text = ("Cette photo n'a pas servi à viser le point : cliquez le pied puis le sommet, ou passez sur "
                        "une photo de la triangulation (seul le sommet y est à cliquer).")
            text = "Hauteur, étape 2/2 (point {}) : {}".format(self.ref_point["name"], text)
            current = self.tool.current
            sequences = self.ref_point["sequences"] + [c.get("sequence") for c in (current.clicks if current else [])]
        elif self.mode == "road" and self.ref_point is None:
            text = ("Largeur, étape 1/2 : visez le premier bord (pied de bordure, marquage…) depuis au moins deux "
                    "photos (une visée par photo, flèches pour changer de photo). " + text)
            if self.triangulator.result is not None:
                text += " Puis « Valider le point »."
        elif self.mode == "road":
            road = self.ref_point.get("road")
            text = ("Largeur, étape 2/2 (point {}) : cliquez le bord opposé, au sol, depuis une photo prise quelques "
                    "mètres avant ou après le point (pas juste en face) ; la largeur se prend sur la droite tracée{}.").format(
                self.ref_point["name"], " (axe de la route en cours de lecture)" if road is None
                else ", perpendiculaire à l'axe {}° ({})".format(measures._num(road["axis"] % 180, 0), road["source"]))
            sequences = self.ref_point["sequences"]
        return text + self._rtk_warning(sequences)

    def _rtk_warning(self, sequences):
        """RTK_WARNING si l'une des séquences n'a pas de position RTK vérifiée (vérification
        terminée), sinon ""."""
        for sequence in dict.fromkeys(s for s in sequences if s):
            res = self.precision.known({"collection": sequence})
            if res is not None and not res.get("precise"):
                return RTK_WARNING
        return ""

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
            "aiming": self._aiming(),
            "point_sel": self.width_sel is not None or (self.mode == "height" and self.tool.selected is not None),
            "active": self.active,
            "lights": self._lights(pic) if item else [],
        })

    def _lights(self, pic):
        """Voyants de la visionneuse : [(nom, état)], état « ok », « non » ou « attente »."""
        res = self.quality

        def light(value):
            return "attente" if value is None else ("ok" if value else "non")

        if self.calibration.tilt(pic):
            tilt = "ok"
        else:
            tilt = "attente" if self.tilts.pending(pic) else "non"
        return [("RTK", light(res["precise"] if res else None)),
                ("LiDAR HD", light(res["lidar"] if res else None)),
                ("Inclinaison", tilt)]

    def viewer_marks(self):
        """Repères de la photo affichée (JSON) : pour chaque mesure, points (cap et élévation
        dans le repère de la photo, radians), libellé, point sélectionné."""
        pic = (self.item or {}).get("id")
        # Hauteurs et largeurs : visibles depuis toutes les photos (voir _height_points, _width_points)
        marks = [self.tool._marks(m) for m in self.tool.done
                 if not isinstance(m, widths.PerpendicularWidth) and not (m.kind == "height" and m.result)]
        if self.item:
            for m in self._heights():
                marks.append({"points": [dict(p, pic=pic, sel=self.tool.selected == (m, k))
                                         for k, p in enumerate(self._height_points(m))],
                              "label": m.label(), "beside": True})
            for m in self._widths():
                marks.append({"points": [dict(p, pic=pic, sel=self.width_sel == (m, k))
                                         for k, p in enumerate(self._width_points(m))],
                              "label": m.label(), "beside": False})
        if self.item:  # mesure libre : points gardés et distances, depuis toutes les photos
            marks += self._free_marks()
        if self.active and self._aiming():  # visées faites depuis cette photo
            marks = marks + [{"points": [{"pic": s["pic"], "yaw": s["view"][0], "pitch": s["view"][1]}
                                         for s in self.triangulator.sightings if "view" in s], "sighting": True}]
        elif self.active and self.mode in GROUND_MODES:  # mesure ou calage en cours
            marks = marks + [self.tool.viewer_marks()]
        elif self.active and self.mode in CALIBRATION_MODES:
            marks = marks + [self.calibrator.viewer_marks()]
        if self.active and self.mode in REF_MODES and self.ref_point and self.item:
            marks = marks + [m for m in [self._reference_mark()] if m]
        road = (self.ref_point or {}).get("road") if self.active and self.mode == "road" else None
        if road and self.item:  # en premier : dessinée sous les traits rouges des largeurs
            marks = [self._guide_mark(road)] + marks
        if self.active and self.mode == "height" and self.ref_point and self.item:  # de même
            marks = [self._vertical_mark()] + marks
        out = []
        for m in marks:
            points = [p for p in m["points"] if p.get("pic") == pic and p.get("yaw") is not None]
            if points:
                out.append({"points": [[p["yaw"], p["pitch"], bool(p.get("sel"))] for p in points],
                            "label": m.get("label", ""), "beside": m.get("beside", False),
                            "sighting": m.get("sighting", False), "guide": m.get("guide", False),
                            "vertical": m.get("vertical", False)})
        return json.dumps(out)

    def focus(self):
        """Points à montrer ensemble sur la carte (JSON, [[lon, lat]]) pendant une mesure :
        photo affichée, photos des visées en cours et leur point, point de référence de la
        hauteur, mesure en cours ou dernière terminée (points et photos)."""
        if not self.active or self.mode in CALIBRATION_MODES:
            return "[]"
        if self.mode == "tri" and not self.triangulator.sightings and self.links:
            i, j, _ = self.links[-1]  # mesure libre : distance qui vient d'être calculée, seule
            return json.dumps([list(self.points[i][:2]), list(self.points[j][:2]), "segment"])
        pts = []
        try:
            pts.append([float(v) for v in self.item["geometry"]["coordinates"][:2]])
        except (KeyError, TypeError, ValueError):
            pass
        pts += [[s["lon"], s["lat"]] for s in self.triangulator.sightings]
        if self.triangulator.result:
            pts.append([self.triangulator.result["lon"], self.triangulator.result["lat"]])
        if self.mode in REF_MODES and self.ref_point:
            pts.append([self.ref_point["lon"], self.ref_point["lat"]])
        if self.mode in GROUND_MODES:
            m = self.tool.current or (self.tool.done[-1] if self.tool.done else None)
            if m is not None and m.result:
                pts += [list(p) for p in m.result["picks"]] + [[c["lon"], c["lat"]] for c in m.clicks]
        return json.dumps(pts)

    def _vertical_mark(self):
        """Hauteur : verticale passant par le point de référence, dans la photo affichée
        (repère de la visionneuse, tracé vert) : du sol supposé plat, à la hauteur de caméra du
        réglage, jusqu'à VERTICAL_LENGTH m."""
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        x, y = triangulation._local(self.ref_point["lon"], self.ref_point["lat"], lon, lat)
        d = max(math.hypot(x, y), 0.5)
        yaw = math.radians((math.degrees(math.atan2(x, y)) - self._heading() + 540) % 360 - 180)
        height = self.tool.camera_height
        points = [{"pic": self.item.get("id"), "yaw": yaw, "pitch": math.atan2(k * VERTICAL_LENGTH / 24 - height, d)}
                  for k in range(25)]
        return {"points": points, "guide": True, "vertical": True}

    def _guide_mark(self, road):
        """Droite de mesure de la largeur dans la photo affichée (repère de la visionneuse) :
        points au sol supposé plat, à la hauteur de caméra du réglage ; la mesure n'en dépend pas."""
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        heading, height = self._heading(), self.tool.camera_height
        ux, uy = widths.perpendicular(road["axis"])
        ax, ay = triangulation._local(self.ref_point["lon"], self.ref_point["lat"], lon, lat)
        points = []
        for k in range(-40, 41):
            t = k * widths.GUIDE_LENGTH / 40
            x, y = ax + t * ux, ay + t * uy
            d = math.hypot(x, y)
            if d < 1.0:
                continue
            yaw = (math.degrees(math.atan2(x, y)) - heading + 540) % 360 - 180
            points.append({"pic": self.item.get("id"), "yaw": math.radians(yaw), "pitch": -math.atan2(height, d)})
        return {"points": points, "guide": True}

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
                    add("trace", "LineString", [list(p) for p in item.points], sublabel="plan perpendiculaire")
                if len(item.extras) >= 2:
                    add("mesure", "LineString", [list(item.extras[0]), list(item.extras[-1])], item.label)
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

    def results(self):
        """Mesures terminées et points gardés, pour la liste de la page (JSON)."""
        out = [{"id": id(m), "kind": "mesure", "text": m.label(), "comment": getattr(m, "comment", "")}
               for m in self.tool.measures() if m.result]
        out += [{"id": i, "kind": "point", "text": "Point {} ±{} m".format(
                    v["nom"], measures._num(v["incert_m"], 2)), "comment": v.get("commentaire", "")}
                for i, (_, _, v) in enumerate(self.points)]
        out += [{"id": k, "kind": "distance", "text": "↔ {}–{} : {} m ± {} m".format(
                    self.points[i][2]["nom"], self.points[j][2]["nom"], measures._num(v["valeur_m"], 2),
                    measures._num(v["incert_m"], 2)), "comment": v.get("commentaire", "")}
                for k, (i, j, v) in enumerate(self.links)]
        return json.dumps(out)

    def delete_result(self, kind, ident):
        """Efface un résultat de la liste : mesure (et son dessin), point triangulé (et les
        distances qui le relient ; les autres gardent leur nom) ou distance."""
        if kind == "mesure":
            tool = self.tool
            for m in tool.measures():
                if id(m) == ident:
                    if tool.selected is not None and tool.selected[0] is m:
                        tool.selected = None
                    m.remove()
                    if m is tool.current:
                        tool.current = None
                    else:
                        tool.done.remove(m)
                    self.message = "Mesure effacée."
                    break
        elif kind == "point" and 0 <= ident < len(self.points):
            name = self.points[ident][2]["nom"]
            self.last_free = None if self.last_free == ident else (
                None if self.last_free is None else self.last_free - (self.last_free > ident))
            before = [i for i, j, _ in self.links if j == ident]
            after = [j for i, j, _ in self.links if i == ident]
            del self.points[ident]
            shift = lambda k: k - (k > ident)  # noqa: E731
            self.links = [(shift(i), shift(j), v) for i, j, v in self.links if ident not in (i, j)]
            self.message = "Point {} effacé.".format(name)
            # Point au milieu d'une chaîne (A–B–C, B effacé) : la distance A–C est proposée
            if before and after and not any({i, j} == {shift(before[0]), shift(after[0])} for i, j, _ in self.links):
                self.proposal = (shift(before[0]), shift(after[0]))
        elif kind == "distance" and 0 <= ident < len(self.links):
            del self.links[ident]
            self.message = "Distance effacée."
        return self.status()

    def take_proposal(self):
        """Distance proposée après un effacement (JSON : [n°, n°, « A », « C »] ou null), une
        seule fois."""
        p, self.proposal = self.proposal, None
        if p is None or max(p) >= len(self.points):
            return json.dumps(None)
        return json.dumps([p[0], p[1], self.points[p[0]][2]["nom"], self.points[p[1]][2]["nom"]])

    def link_points(self, i, j):
        """Distance entre deux points gardés, à la demande (voir take_proposal)."""
        if 0 <= i < len(self.points) and 0 <= j < len(self.points) and i != j:
            self.message = self._link(int(i), int(j))
        return self.status()

    def set_comment(self, kind, ident, text):
        """Commentaire d'une mesure ou d'un point gardé (champ « commentaire » de l'export)."""
        if kind == "point":
            if 0 <= ident < len(self.points):
                self.points[ident][2]["commentaire"] = text
            return
        if kind == "distance":
            if 0 <= ident < len(self.links):
                self.links[ident][2]["commentaire"] = text
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

    def has_results(self):
        return bool(self.points) or bool(self.links) or any(m.result for m in self.tool.measures())

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


def _point_name(n):
    """Nom du n-ième point gardé (0 : A) : A … Z, puis AA, AB…, comme les colonnes d'un tableur."""
    name = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        name = chr(65 + r) + name
    return name


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
