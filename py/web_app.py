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
import re
import time
from datetime import datetime

import web_host
from core import (autotilt, capture, filters, host, measures, metadata, precision, roads, session, tools,
                  triangulation, widths)
from core.session import GROUND_MODES, MODES  # noqa: F401 (modes de la page)


# Mots laissés en minuscules dans un nom remis en forme (sauf au début) : « Pont de France »
_SMALL_WORDS = {"de", "du", "des", "la", "le", "les", "et", "en", "sur", "sous", "aux", "à"}


def _bridge_name(text):
    """Nom de pont tiré du nom d'un tronçon BD TOPO en majuscules (« PONT DE FRANCE » -> « Pont de
    France »), ou None s'il ne nomme pas un ouvrage (nom de la rue qui passe dessus)."""
    words = (text or "").strip().lower().split()
    if not words or words[0] not in ("pont", "viaduc", "passerelle"):
        return None

    def word(w, first):
        if "'" in w:  # d'or -> d'Or
            head, tail = w.split("'", 1)
            return (head.capitalize() if first else head) + "'" + word(tail, False)
        if not first and w in _SMALL_WORDS:
            return w
        return "-".join(part.capitalize() for part in w.split("-"))

    return " ".join(word(w, k == 0) for k, w in enumerate(words))


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
        self.aim_frame = False  # photo affichée pas encore tournée vers le point à viser (take_aim_frame)
        # Calage de l'inclinaison : pied et sommet de l'objet vertical cliqués, gardés ici jusqu'à
        # « Valider l'objet vertical » (le cœur cale dès le second clic, sans laisser les voir ni
        # les déplacer) ; indice de la croix sélectionnée pour être déplacée, ou None
        self.tilt_clicks, self.tilt_sel = [], None
        self.fall_cells = {}  # maille -> tronçons BD TOPO avec leur largeur (hauteur de chute, voir fall)
        self.falls = {}  # (séquence, pont) -> hauteur de chute calculée (dict text, title) ou en cours

    # Données pour la page (JSON) -------------------------------------------------------
    def set_picture(self, item_json):
        """Photo affichée dans la visionneuse : sa fiche STAC (texte JSON)."""
        self.aim_frame = True
        return super().set_picture(json.loads(item_json))

    def state(self):
        return json.dumps(dict(super().state(), tilt_ready=self._tilt_pending() and len(self.tilt_clicks) == 2))

    def fall_json(self):
        """Hauteur de chute (voir fall), en JSON : demandée par la page hors lecture de la séquence
        (sinon une lecture BD TOPO par maille de 100 m traversée)."""
        return json.dumps(self.fall())

    def viewer_marks(self):
        marks = super().viewer_marks()
        if self._tilt_pending():  # objet vertical en cours (croix et trait du calage), effacé une fois validé
            marks.append({"points": [c["pos"] + [k == self.tilt_sel] for k, c in enumerate(self.tilt_clicks)],
                          "label": "", "calage": True})
        return json.dumps(marks)

    def focus(self):
        return json.dumps(super().focus())

    def handles(self):
        return json.dumps(super().handles())

    def results(self):
        return json.dumps(super().results())

    def take_proposal(self):
        return json.dumps(super().take_proposal())

    def take_frame(self):
        return json.dumps(super().take_frame())

    def take_bridge_alert(self):
        return json.dumps(super().take_bridge_alert())

    # Calage de l'inclinaison : objet vertical validé par un bouton -----------------------------
    TILT_NEAR = 1.5  # degrés : clic sur une croix de l'objet en cours (sélection pour la déplacer)

    def _tilt_pending(self):
        """Objet vertical en cours sur la photo affichée (calage de l'inclinaison)."""
        return bool(self.active and self.mode == "tilt" and self.item and self.tilt_clicks
                    and self.tilt_clicks[0]["pic"] == self.item.get("id"))

    def click(self, yaw, pitch):
        if not (self.active and self.mode == "tilt" and self.item):
            return super().click(yaw, pitch)
        self._check_tilt()
        raw_yaw = (math.degrees(yaw) + self._heading()) % 360
        click = tools.photo_click(self.item, raw_yaw, math.degrees(pitch), self.calibration, self.quality, [yaw, pitch])
        if click is None:
            self.message = "Position de la photo inconnue."
            return self.status()
        self.message = ""
        if not self._tilt_pending():
            self.tilt_clicks, self.tilt_sel = [], None  # le sommet doit être sur la même photo que le pied
        if self.tilt_sel is not None:  # croix sélectionnée : nouvelle position
            self.tilt_clicks[self.tilt_sel], self.tilt_sel = click, None
            return self.status()
        near = [k for k, c in enumerate(self.tilt_clicks)
                if math.hypot(math.degrees(c["pos"][0] - yaw), math.degrees(c["pos"][1] - pitch)) < self.TILT_NEAR]
        if near:
            self.tilt_sel = near[0]
        elif len(self.tilt_clicks) < 2:
            self.tilt_clicks.append(click)
        else:
            self.message = ("Pied et sommet déjà placés : cliquez une de leurs croix pour la déplacer, puis "
                            "« ✔ Valider l'objet vertical » (« Effacer » pour l'abandonner).")
        return self.status()

    def validate_tilt(self):
        """« Valider l'objet vertical » : le pied et le sommet cliqués calent l'inclinaison de la photo."""
        if self._tilt_pending() and len(self.tilt_clicks) == 2:
            clicks, self.tilt_clicks, self.tilt_sel = self.tilt_clicks, [], None
            for c in clicks:
                self.calibrator.add_click(c)
            self._after_calibration(self.calibrator)
        return self.status()

    def _calibration_text(self):
        if not self._tilt_pending():
            return super()._calibration_text()
        n = len(self.calibration.verticals.get(self.item.get("id"), [])) + 1
        if self.tilt_sel is not None:
            return "{} de l'objet {} sélectionné : cliquez sa position exacte.".format(
                "Pied" if self.tilt_sel == 0 else "Sommet", n)
        if len(self.tilt_clicks) == 1:
            return ("Calage de l'inclinaison, objet {} : cliquez maintenant son sommet, le plus haut possible sur "
                    "la même verticale (zoomez pour être précis).").format(n)
        return ("Objet {} : pied et sommet placés. Pour en déplacer un, cliquez sa croix puis sa position exacte ; "
                "sinon « ✔ Valider l'objet vertical ».").format(n)

    def clear(self):
        if self._tilt_pending():
            self.tilt_clicks, self.tilt_sel = [], None
            self.message = "Objet vertical abandonné."
            return self.status()
        return super().clear()

    def set_mode(self, mode):
        self.tilt_clicks, self.tilt_sel = [], None
        return super().set_mode(mode)

    # Hauteur de chute sur un pont (ticket #15) ---------------------------------------------
    FALL_SIDE = 1.0  # m au-delà du bord de la chaussée : pied du garde-corps, côté vide
    FALL_STEP = 2.0  # m entre deux points le long du pont (plus si le pont est long)
    FALL_POINTS = 80  # points au plus : une seule requête au service d'altimétrie
    FALL_WIDTH = 6.0  # m : largeur de chaussée supposée quand la BD TOPO ne la donne pas
    FALL_TOUCH = 1.0  # m : tronçons en pont bout à bout (un pont coupé en plusieurs tronçons)
    FALL_RETRY = 60.0  # s avant de refaire un calcul qui a échoué (service injoignable)
    FALL_NO_RTK = ("Hauteur de chute non calculée : la position GPS de cette séquence n'est pas vérifiée RTK. "
                   "L'altitude du tablier, tirée de l'altitude GPS de la caméra, serait fausse de plusieurs mètres.")

    def fall(self):
        """Photo prise sur un pont (BD TOPO) : hauteur de chute la plus grande sur toute la longueur du
        pont ({text, title}), son explication sans RTK vérifié, ou l'attente de son calcul ; None hors
        d'un pont. Tablier : altitude GPS RTK (NGF) moins hauteur de caméra, aux photos de la séquence
        prises sur le pont ; dessous : MNT LiDAR HD (RGE ALTI en secours), qui ignore le tablier, au
        pied des garde-corps des deux côtés."""
        item = self.item or {}
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        except (KeyError, TypeError, ValueError):
            return None
        sections = self._fall_sections(lon, lat)
        if not sections or sections is roads.PENDING:
            return None
        axis = self._axis(item)
        sec = roads.on_bridge(sections, lon, lat, metadata.item_heading(item) if axis is None else axis)
        if sec is None:
            return None
        chain = self._bridge_chain(sections, sec)
        # Nom du pont (BD TOPO), et sa route : « Pont de France (D905) », sinon « Pont de la D111 »,
        # « Pont de l'A38 » (élision devant une voyelle)
        name = next((c["bridge_name"] for c in chain if c.get("bridge_name")), None)
        road = next((c["name"] for c in chain if re.match(r"[A-Z]+\d", c.get("name") or "")), None)
        of_road = road and ("Pont de l'" if road[0] in "AEIOUY" else "Pont de la ") + road
        bridge = "{} ({})".format(name, road) if name and road else name or of_road or "Pont"
        if self.quality is None:
            return {"text": bridge + "\nHauteur de chute : vérification de la position GPS en cours…", "title": ""}
        if not self.quality.get("precise"):
            return {"text": bridge + "\n" + self.FALL_NO_RTK, "title": ""}
        key = (item.get("collection"), min(p for c in chain for p in c["line"]))
        res = self.falls.get(key)
        if res is None or time.monotonic() >= res.get("retry_at", float("inf")):
            res = self.falls[key] = {"text": "Hauteur de chute : calcul en cours…", "title": ""}
            self._compute_fall(key, chain, item, lon, lat)
        return {"text": bridge + "\n" + res["text"], "title": res["title"]}

    def _fall_sections(self, lon, lat):
        """Tronçons BD TOPO de la maille du point, avec leur largeur de chaussée (« width », m ou None),
        lus ici : ceux du cœur (roads) ne la gardent pas. roads.PENDING pendant la lecture, None si la BD
        TOPO n'a pas répondu (shortcut : pas de nouvel essai avant le rechargement de la page)."""
        cell = roads._cell(lon, lat)
        if cell in self.fall_cells:
            return self.fall_cells[cell]
        self.fall_cells[cell] = roads.PENDING

        def done(data, error):
            out = None
            if not error:
                out = []
                for feat in (data or {}).get("features") or []:
                    props = feat.get("properties") or {}
                    try:
                        width = float(props.get("largeur_de_chaussee"))
                    except (TypeError, ValueError):
                        width = None
                    out += [dict(sec, width=width if width and width > 0 else None,
                                 bridge_name=_bridge_name(props.get("nom_collaboratif_gauche")))
                            for sec in roads.parse_sections({"features": [feat]})]
            self.fall_cells[cell] = out
            self.notify()

        host.fetch_json(roads.wfs_url(cell), done, timeout_ms=15000)
        return self.fall_cells[cell]

    def _bridge_chain(self, sections, first):
        """Tronçons en pont bout à bout avec first : le pont entier."""
        chain = [first]
        grown = True
        while grown:
            grown = False
            ends = [p for c in chain for p in (c["line"][0], c["line"][-1])]
            for sec in sections:
                if sec["level"] > 0 and sec not in chain and any(
                        tools._metres(p, q) < self.FALL_TOUCH for p in (sec["line"][0], sec["line"][-1]) for q in ends):
                    chain.append(sec)
                    grown = True
        return chain

    def _compute_fall(self, key, chain, item, lon, lat):
        """Calcul de la hauteur de chute du pont (chain), rangé dans self.falls[key], puis notify()."""
        camera = self._camera_height()
        lines = [[triangulation._local(p[0], p[1], lon, lat) for p in c["line"]] for c in chain]
        total = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for line in lines for a, b in zip(line, line[1:]))
        step = max(self.FALL_STEP, 2 * total / self.FALL_POINTS)
        samples = []  # (x, y) au pied des garde-corps, des deux côtés, en m depuis la photo
        for c, line in zip(chain, lines):
            length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(line, line[1:]))
            offset = (c["width"] or self.FALL_WIDTH) / 2 + self.FALL_SIDE
            n = max(1, round(length / step))
            for k in range(n + 1):
                s = k * length / n
                (x, y), a, b = roads._at(line, s), roads._at(line, s - 1.0), roads._at(line, s + 1.0)
                t = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
                nx, ny = -(b[1] - a[1]) / t, (b[0] - a[0]) / t
                samples += [(x + side * offset * nx, y + side * offset * ny) for side in (-1, 1)]
        reach = max(math.hypot(x, y) for x, y in samples) + 10.0

        def failed():
            self.falls[key] = {"text": "Hauteur de chute : calcul impossible (service injoignable)", "title": "",
                               "retry_at": time.monotonic() + self.FALL_RETRY}
            self.notify()

        def got_photos(data, error):
            if error:
                return failed()
            decks = []  # (x, y, altitude du tablier) aux photos de la séquence prises sur le pont
            for feat in (data or {}).get("features") or []:
                try:
                    plon, plat = (float(v) for v in feat["geometry"]["coordinates"][:2])
                except (KeyError, TypeError, ValueError):
                    continue
                ngf = host.ngf_altitude(plon, plat, metadata.item_altitude(feat))
                if ngf is None or feat.get("collection") != item.get("collection") or \
                        roads.on_bridge(chain, plon, plat) is None:
                    continue
                decks.append(triangulation._local(plon, plat, lon, lat) + (ngf - camera,))
            if not decks:
                return failed()
            precision.fetch_terrain([triangulation._geographic(x, y, lon, lat) for x, y in samples],
                                    lambda ground, source, error: got_ground(decks, ground, source, error))

        def got_ground(decks, ground, source, error):
            if error:
                return failed()
            best = None
            for (x, y), z in zip(samples, ground or []):
                if z is None:
                    continue
                # shortcut : tablier à l'altitude de la photo la plus proche (photos tous les ~5 m) ;
                # interpoler entre les photos si des ponts longs et pentus le demandent
                deck = min(decks, key=lambda d: math.hypot(d[0] - x, d[1] - y))[2]
                if best is None or deck - z > best[0]:
                    best = (deck - z, math.hypot(x, y))
            if best is None:
                return failed()
            terrain = triangulation.RGE_ALTI_ERROR if source == "RGE ALTI" else triangulation.LIDAR_ERROR
            sigma = math.hypot(precision.VERIFIED_ACCURACY, triangulation.GROUND_ERROR, terrain)
            self.falls[key] = {
                "text": "Hauteur de chute max : {} m (±{} m)".format(measures._num(best[0], 1), measures._num(sigma, 1)),
                "title": ("Plus grande hauteur entre le tablier (altitude GPS RTK moins hauteur de caméra) et le "
                          "terrain sous le pont ({}), le long des deux bords, à {} m de la photo. Au-dessus de "
                          "l'eau : niveau au relevé, pas le fond.").format(
                    source, measures._num(best[1], 0))}
            self.notify()

        host.fetch_json(metadata.search_url(lon, lat, reach, 100, item.get("collection"), host.api_url), got_photos)

    def take_aim_frame(self):
        """Visées guidées : repère dans la photo affichée ([[cap, élévation]] en radians, JSON) du
        point à viser, tel qu'il est placé avant d'être triangulé : le bord B d'une largeur là où
        l'a mis le clic de la mesure, ou le point de référence (bord d'une largeur, pied d'une
        hauteur) là où la première visée touche le sol plat. Une seule fois par photo affichée, et seulement si elle n'a pas encore servi à
        le viser ; null sinon. Propre à la page (pas dans le cœur du plugin)."""
        if not self.aim_frame or not self.active or not self.item:
            return "null"
        self.aim_frame = False
        sightings = self.triangulator.sightings
        if not sightings or any(s["pic"] == self.item.get("id") for s in sightings):
            return "null"
        if self.b_aiming is not None:
            lon, lat = self.b_aiming.result["points"][1]
        elif self.mode in session.REF_MODES and self.ref_point is None:  # point de référence (largeur, hauteur)
            first = sightings[0]
            elev = first.get("elev") or 0.0
            if elev > -0.5:  # visée au-dessus de l'horizon ou presque : pas de sol touché
                return "null"
            lon, lat = triangulation.offset(first["lon"], first["lat"], first["heading"],
                                            self._camera_height() / math.tan(math.radians(-elev)))
        else:
            return "null"
        p = self._project(lon, lat)
        return json.dumps([[p["yaw"], p["pitch"]]])

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
