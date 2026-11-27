# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Application de mesure dans le navigateur : la session de mesure du cœur
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
from web_chutes import Chutes, _WAY_KINDS, _deck_at, platform_slope  # noqa: F401 (essais)
from web_nez import Nez
from web_pose import Pose, roulis_vehicule_depuis_camera
from core import (autotilt, calibration, capture, filters, host, measures, metadata, precision, session, tools,
                  triangulation)
from core.session import GROUND_MODES, MODES  # noqa: F401 (modes de la page)


# Relevé : objet posé sur une seule photo (App.releve_single), si la visée descend assez sous l'horizon
SINGLE_MIN_ELEV = 2.0  # degrés : objet à 70 m au plus pour une caméra à 2,5 m
# Objet relevé posé d'un clic sur la mini-carte (App.keep_map) : précision des orthophotos IGN (environ 1 m)
MAP_PLACE_ERROR = 1.0  # m
# Visées des autres photos tracées dans la photo affichée (Session._epipolar_mark) : sans leurs premiers
# mètres, vus très en biais, projetés à des milliers de pixels hors de l'écran et redessinés à chaque
# image par la visionneuse (lenteur, surtout zoomé)
EPIPOLAR_START = 2.0  # m depuis la caméra de la visée
EPIPOLAR_NEAR = 3.0  # m au moins de la caméra de la photo affichée
def _length_text(value, sigma):
    """« 7,60 m ± 0,38 m », ou « 7,60 m hors vue » (longueur sur le fond de carte seul, voir App.add_map_length)."""
    return "{} m {}".format(measures._num(value, 2), "hors vue" if sigma is None else "± {} m".format(measures._num(sigma, 2)))


def _area_text(area):
    """« 123,4 m² » (surface sur la carte, voir App.add_map_area)."""
    return "{} m²".format(measures._num(area, 1))


def _segment_gap(x, y, x1, y1, x2, y2):
    """Distance (degrés, plan yaw-pitch, yaw ramené à l'écart le plus court) du point (x, y) au segment (x1, y1)-(x2, y2)."""
    def wrap(a):
        return (a + 180) % 360 - 180
    k = math.cos(math.radians(y))
    px, py = wrap(x - x1) * k, y - y1
    sx, sy = wrap(x2 - x1) * k, y2 - y1
    length2 = sx * sx + sy * sy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, (px * sx + py * sy) / length2))
    return math.hypot(px - t * sx, py - t * sy)


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
    """Visées de la triangulation sur la carte : voir tools.Triangulator.new_item."""

    def __init__(self):
        self.rays, self.point = [], None
        self.removed = False

    def set_data(self, rays, point):
        self.rays, self.point = list(rays), point

    def remove(self):
        self.removed = True


class RankPrecisionChecker(precision.PrecisionChecker):
    """Vérification de la position RTK (voir precision.PrecisionChecker) dont les autres portions de la
    séquence, essayées quand celle de la photo échoue, sont prises par rang : RANK_STEP photos avant et
    après. Le cœur les cherche parmi les 100 photos de la séquence les plus proches, toutes au même
    endroit quand elle y passe plusieurs fois : sur un pont (le LiDAR donne le terrain sous le tablier),
    aucune autre portion n'était essayée et toute la séquence restait non vérifiée."""
    RANK_STEP = 150

    def __init__(self):
        super().__init__()
        self._items = {}  # séquence -> photo dont la vérification a été demandée (rang, adresse de la séquence)

    def _check_sequence(self, item, sequence, lon, lat, done):
        self._items[sequence] = item
        super()._check_sequence(item, sequence, lon, lat, done)

    def _other_portions(self, sequence, lon, lat, failed, done):
        item = self._items.get(sequence) or {}
        links = {l.get("rel"): l.get("href") or "" for l in item.get("links") or []}
        base = links.get("collection", "")
        if base.startswith(web_host.API_URL):  # le méta-catalogue ignore les rangs : instance d'origine (« via »)
            base = links.get("via") and "{}/api/collections/{}".format(links["via"].rstrip("/"), sequence)
        rank = (item.get("properties") or {}).get("geovisio:rank_in_collection")
        if not base or not isinstance(rank, int):
            return super()._other_portions(sequence, lon, lat, failed, done)
        ranks = [r for r in (rank + self.RANK_STEP, rank - self.RANK_STEP) if r >= 1]
        tried, unread = [0], [0]

        def next_portion():
            if not ranks:
                plural = "s" if tried[0] > 1 else ""
                done(dict(failed, reason="{} ; {} autre{p} portion{p} de la séquence non vérifiée{p}".format(
                    failed["reason"], tried[0], p=plural)) if tried[0]
                     else dict(failed, transient=True) if unread[0] else failed)  # rien lu : à refaire plus tard
                return
            r = ranks.pop(0)

            def got_item(data, error):
                if error:  # au-delà de la fin de la séquence (HTTP 404), ou instance injoignable
                    unread[0] += 1
                    next_portion()
                    return
                feats = (data or {}).get("features") or []
                try:
                    clon, clat = (float(v) for v in feats[0]["geometry"]["coordinates"][:2])
                except (IndexError, KeyError, TypeError, ValueError):
                    next_portion()  # au-delà de la fin de la séquence
                    return

                def got(kind, value):
                    if kind in ("photos", "ground"):
                        done(dict(failed, transient=True))
                    elif kind == "result" and value["precise"]:
                        done(dict(value, reason="{}, à {:.0f} m de la photo (même séquence)".format(
                            value["reason"], round(precision._metres((clon, clat), (lon, lat)), -1))))
                    else:
                        tried[0] += 1
                        next_portion()

                self._portion(sequence, clon, clat, got)

            host.fetch_json("{}/items?limit=1&startAfterRank={}".format(base.rstrip("/"), r - 1), got_item)

        next_portion()


class App(Pose, Chutes, Nez, session.Session):
    def __init__(self, notify, remote=None, api_url=web_host.API_URL):
        web_host.install(remote, api_url)
        if remote is not None:
            autotilt.HAS_NUMPY = True  # verticales calculées dans le Pyodide d'arrière-plan, qui a numpy
        super().__init__(notify, precision_checker=RankPrecisionChecker())
        self.mode = "height"  # mode de départ : première option de la liste Mode (index.html)
        self.tool.set_mode(self.mode)
        self.items, self.rays = [], []
        self.tool.new_item = self._new_item
        self.triangulator.new_item = self._new_rays
        self.photo_filter = filters.PhotoFilter()
        self.aim_frame = False  # photo affichée pas encore tournée vers le point à viser (take_aim_frame)
        # Calage de l'inclinaison : pied et sommet de l'objet vertical cliqués, gardés ici jusqu'à
        # « Valider l'objet vertical » (le cœur cale dès le second clic, sans laisser les voir ni
        # les déplacer) ; indice de la croix sélectionnée pour être déplacée, ou None
        self.tilt_clicks, self.tilt_sel = [], None
        # Panneau « Calage manuel » (src/calage.js) : ouvert (verticales de la photo tracées, numérotées), verticale choisie
        # ou survolée dans sa liste (numéros à partir de 0, de la photo calage_pic)
        self.calage_open, self.calage_pic, self.calage_sel, self.calage_hover = False, None, None, None
        self.fall_cells = {}  # maille -> tronçons BD TOPO avec leur largeur (hauteur de chute, voir fall)
        self.falls = {}  # (séquence, pont) -> hauteur de chute calculée (dict text, title) ou en cours
        self.lidar_falls = {}  # tronçon du pont -> réponse du nuage LiDAR (use_bridge_lidar)
        self.edges = {}  # (photo, largeur examinée) -> chute et dévers des bords de route (voir _edges)
        self.paved = {}  # repère du profil -> bords d'enrobé de l'analyse fine (use_paved_edges)
        self.paved_redo = {}  # repère du profil -> (clé de self.edges, calcul à refaire sans relire le terrain)
        self.edges_asked = {}  # photo -> largeur examinée au dernier appui sur « Profils »
        self.long_tracks = {}  # photo -> trajectoire de la caméra autour d'elle (_track_line), None pendant la lecture
        self.edge_zone = self.EDGE_ZONE
        self.bdtopo = {}  # (couche BD TOPO, maille) -> objets lus (voir _bdtopo)
        self.fall_error = {}  # maille -> raison du dernier échec de lecture des tronçons (dite dans le message)
        self.fall_retry = {}  # maille -> instant du nouvel essai après un échec de lecture des tronçons
        self.bdtopo_retry = {}  # (couche BD TOPO, maille) -> instant du nouvel essai après un échec
        # Longueurs mesurées sur la vue du dessus (src/dessus.js), mode « carte » : rien à viser dans la photo
        # Longueurs et surfaces de la carte : {"ends": [[lon, lat], …] (2 points ; une surface : son contour ouvert),
        # "valeur_m" (une surface : son périmètre), "incert_m", "photos", "commentaire", "surface_m2" (surfaces seules)}
        self.map_lengths = []
        self.map_mode = False
        self.redo_stack, self.redo_key = [], None  # états d'avant chaque « Effacer » (Ctrl+Y, voir redo)
        self.overlay = []  # couche importée : (n° de l'objet, "point" ou "ligne", [(lon, lat, z)]), voir set_overlay
        self.overlay_ground = {}  # (lon, lat) -> altitude LiDAR HD ou None (absente), sommets et caméras (_overlay_ground)
        self.overlay_asked = set()  # (lon, lat) dont l'altitude est en cours de lecture
        self.point_ground = {}  # (lon, lat caméra, lon, lat point) -> (z caméra, z point) ou None (_point_ground)
        self.nose_ground = {}  # (lon, lat, axe, direction, d) -> (source, sigma, [(décalage, dz)]), {} en lecture, None indisponible (_nose_ground)
        self.nose_ground_last = None  # (caméra et distance, relief) du dernier relief lu : sert pendant le glissement de la rotation
        self.tilt_reasons = {}  # photo -> raison de l'échec de l'inclinaison automatique (ticket #29)
        self.birdeye_loose = {}  # photo -> verticales refusées pour les mesures, gardées pour la vue du dessus (web_tilt.LOOSE_SIGMA)
        self.birdeye_ground = {}  # photo -> ce que la vue du dessus applique : {up, sigma, manual, height, height_sigma, ground} (birdeye_tilt_set)
        self.tilts.run = self._run_tilt
        # Inclinaison par le terrain hors agglomération, expérimentale (option, voir web_terrain)
        self.terrain_relay = False
        self.relay_tilts = {}  # photo -> inclinaison par le terrain (dict comme Calibration.auto_tilt)
        self.birdeye_items, self.birdeye_checks = [], (autotilt.TiltChecker(), autotilt.TiltChecker())  # voir birdeye_neighbours
        for checker in self.birdeye_checks:
            checker.roads = self.roads  # LiDAR sous l'emprise d'un pont voisin écarté
        self.birdeye_far_items = []  # voir birdeye_far
        self.relay_pending = {}  # photo -> étape du calcul en cours
        self.relay_failed = {}  # photo -> raison de l'échec
        self.relay_models = {}  # séquence -> références, modèle (web_terrain.model), raison d'un échec
        self._core_auto_tilt = self.calibration.auto_tilt
        self.calibration.auto_tilt = self._auto_tilt
        # Sources d'inclinaison de l'hôte, rangées par Calibration.tilt (ordre unique : voir sa docstring)
        self.calibration.ground_tilt = self._ground_tilt
        self.calibration.loose_tilt = self._loose_tilt
        self.calibration.route_tilt = self._route_tilt
        self.calibration.campaign_tilt = self._campaign_tilt
        # Relevé d'objets (mode "releve" de la page) : le mode « tri » du cœur (points gardés), chacun gardé avec les champs saisis par l'utilisateur (values["releve"])
        self.releve = False

    # Données pour la page (JSON) -------------------------------------------------------
    def set_picture(self, item_json):
        """Photo affichée dans la visionneuse : sa fiche STAC (texte JSON)."""
        self.aim_frame = True
        return super().set_picture(json.loads(item_json))

    def set_active(self, on):
        """Bouton « Mesure » : l'inclinaison automatique de la photo est calculée dès l'activation,
        pas au premier clic comme dans le cœur (_check_tilt), qui la lance encore au premier clic
        sur une autre photo."""
        super().set_active(on and not self.map_mode)  # mesure sur la carte : clics dans la photo sans effet
        self._check_tilt()  # rien hors mesure, en relevé (voir _check_tilt) ou si déjà calculée
        return self.status()

    def state(self):
        out = dict(super().state(), tilt_ready=self._tilt_pending() and len(self.tilt_clicks) == 2)
        out["tilt_reason"] = self._tilt_reason()
        # Effacer, Refaire, Tout effacer : grisés quand ils n'auraient pas d'effet
        single = self.releve_single()  # relevé : objet sur cette seule photo, à proposer avec sa précision
        out["single_m"] = round(single[2], 2) if single else None
        out.update(can_undo=self._can_undo(), can_redo=bool(self.redo_stack) and self._redo_state() == self.redo_key,
                   can_clear=self._can_clear())
        if self.item:  # inclinaison de la ligne d'état : textes du web (_tilt_line), pas ceux du cœur
            text, alert = self._tilt_line()
            quality = precision.state_text(self.quality, metadata.item_accuracy(self.item), (text, False))
            out["quality"] = "⚠ " + quality if alert and not quality.startswith("⚠") else quality
            out["quality"] = self._bridge_note(out["quality"])
            out["camera_used"] = self._camera_used(self.item)
        return json.dumps(out)

    def _bridge_note(self, quality):
        """Ligne « Position » + « sur un pont (détecté) » quand le mode « sur un pont » est actif (activé tout seul d'après la BD TOPO,
        take_bridge_alert) : dit à l'utilisateur pourquoi le sol vient des photos et non du modèle de terrain."""
        return quality + " · sur un pont (détecté)" if self.bridge else quality

    # Confiance de l'inclinaison des mesures (Calibration.confidence) : état de la photo du premier clic, gardé sur la mesure
    CONFIDENCE_TEXT = {"confirmee": "inclinaison confirmée", "desaccord": "inclinaison en désaccord",
                       "non_verifiable": "inclinaison non vérifiable", "pont": "pont : inclinaison non vérifiable"}

    def _recompute(self, pics=None, force_reference=False):
        super()._recompute(pics, force_reference)
        self._stamp_confidence(pics)

    def _stamp_confidence(self, pics=None):
        """Garde sur chaque mesure terminée la confiance de l'inclinaison de sa photo (m.confiance : etat, ecart_tangage,
        ecart_roulis) : prise quand la mesure est lue pour la première fois (faite à l'instant), refaite quand l'inclinaison de
        sa photo change (la mesure est alors recalculée avec la nouvelle). pics : photos dont le calage a changé (None : toutes ;
        vide : seulement les mesures encore sans état). Sans état calculable (cap ou inclinaison inconnus), l'ancien est gardé.
        Une mesure sur la carte ne dépend pas de l'inclinaison : elle n'en a pas."""
        for m in self.tool.measures():
            if not m.result or not m.clicks:
                continue
            pic = m.clicks[0].get("pic")
            if getattr(m, "confiance", None) and pics is not None and pic not in pics:
                continue
            got = self.tilt_confidence_of(pic)
            if got:
                m.confiance = {"etat": got["state"], "ecart_tangage": got["d_pitch"], "ecart_roulis": got["d_roll"]}

    # Mesures faites : seulement sur leur photo (ticket #24) ---------------------------------------
    # Projetées sur les autres photos, elles y paraissent décalées. Le cœur les montre partout :
    # le filtre ne vaut que pour les repères de la visionneuse et la sélection des croix, pas pour
    # la carte ni les résultats.
    here_only = False

    def _here(self):
        return (self.item or {}).get("id")

    def _heights(self):
        heights = super()._heights()
        return [m for m in heights if m.clicks[0].get("pic") == self._here()] if self.here_only else heights

    def _height_points(self, m):
        """Session._height_points, mais sur la photo de la mesure, chaque point au cap où il a été cliqué :
        calée sur le point de référence, la hauteur décale son sommet sur le côté quand le pied change de
        profondeur (même écart latéral en mètres, vu de plus près ou de plus loin), alors que sa valeur ne
        dépend que de l'élévation ; les hauteurs suivantes resteraient hors de la ligne de la première."""
        pts = super()._height_points(m)
        if (self.item or {}).get("id") == m.clicks[0].get("pic"):
            for p, c in zip(pts, m.clicks):
                pos, raw = c.get("pos") or [None, None], c.get("raw")
                if pos[0] is not None:
                    p["yaw"] = pos[0]
                    if raw:
                        p["abs_yaw"] = raw[0] % 360
            _keep_view(m, pts)
        return pts

    def _free_mark_point(self, k):
        """Point gardé du relevé : seulement là où il a été visé (sans repère ailleurs). Objet
        relevé : sur toutes les photos, projeté au sol, à OVERLAY_REACH m au plus (comme la couche)."""
        lon, lat, values = self.points[k]
        if "releve" in values and self.item:
            camera = [float(v) for v in self.item["geometry"]["coordinates"][:2]]
            x, y = triangulation._local(lon, lat, *camera)
            if math.hypot(x, y) <= self.OVERLAY_REACH:
                view = self.point_views.get(values["nom"], {}).get(self._here())
                alt = (host.ngf_altitude(*camera, metadata.item_altitude(self.item))
                       if (self.quality or {}).get("precise") else None)
                if view is None and values.get("z_ngf") is not None and alt is not None:
                    # à son altitude, vue depuis la caméra de cette photo (RTK) : pas ramené au sol
                    seen = self._view_of(math.degrees(math.atan2(x, y)),
                                         math.degrees(math.atan2(values["z_ngf"] - alt, max(math.hypot(x, y), 0.5))))
                    return {"pic": self._here(), "yaw": seen["yaw"], "pitch": seen["pitch"]}
                return super()._free_mark_point(k)  # visé d'ici, sinon projeté au sol
        if self.here_only and self._here() not in self.point_views.get(values["nom"], {}):
            return {"pic": self._here(), "yaw": None, "pitch": None}
        return super()._free_mark_point(k)

    def _free_marks(self):
        # distance : seulement sur une photo d'où ses deux points ont été visés
        return [m for m in super()._free_marks() if all(p["yaw"] is not None for p in m["points"])]

    def _filtered(self, method, *args):
        self.here_only = True
        try:
            return method(*args)
        finally:
            self.here_only = False

    def _height_near(self, click):
        return self._filtered(super()._height_near, click)

    # Croix sous le clic : la page le sait en pixels (CROSS_PX autour de la croix, quel que soit le zoom), le calcul
    # seulement en degrés (measures.SELECT_ANGLE : une centaine de pixels quand on zoome). cross_hit : True, False, ou
    # None (pas d'information : essais, plugin) ; quand la page a vu une croix, la plus proche à CROSS_REACH° au plus
    CROSS_REACH = 10.0
    cross_hit = None

    _picks = None  # liste : _nearest y relève ses candidats au lieu de chercher (pick_points)

    def pick_points(self):
        """JSON [[cap, élévation]] (radians, repère de la photo) des croix qu'un clic sélectionnerait dans le mode en cours :
        celles que cherche _nearest (hauteurs et point de référence), ou celles du calage de l'inclinaison. La
        page les teste en pixels (on_cross) : une croix d'un autre mode ou de visée ne compte pas."""
        if not (self.active and self.item) or self._aiming():
            return "[]"
        if self.mode == "tilt":
            return json.dumps([list(c["pos"][:2]) for c in self.tilt_clicks if self._tilt_pending()])
        self._picks, probe = [], {"raw": [0.0, 0.0]}
        try:
            if self.mode == "height":
                self._height_near(probe)
                self._ref_near(probe)
            picks = self._picks
        finally:
            self._picks = None
        heading = self._heading()
        return json.dumps([[math.radians((p["abs_yaw"] - heading + 540) % 360 - 180), math.radians(p["elev"])]
                           for p in picks if p.get("abs_yaw") is not None and p.get("elev") is not None])

    def _nearest(self, click, candidates):
        if self._picks is not None:
            self._picks += [p for _, points in candidates for p in points]
            return None
        if self.cross_hit is None:
            return super()._nearest(click, candidates)
        if not self.cross_hit:
            return None
        raw = click.get("raw") or [click["yaw"], click["elev"]]  # comme Session._nearest, à CROSS_REACH° au plus
        best, best_d = None, self.CROSS_REACH
        for m, points in candidates:
            for index, p in enumerate(points):
                dyaw = (raw[0] - p["abs_yaw"] + 540) % 360 - 180
                d = math.hypot(dyaw * math.cos(math.radians(raw[1])), raw[1] - p["elev"])
                if d < best_d:
                    best, best_d = (m, index), d
        return best

    def _with_cross(self, on_cross, method, *args):
        """method(*args), la croix sous le clic connue de la page (on_cross, ou None)."""
        self.cross_hit = None if on_cross is None else bool(on_cross)
        try:
            return method(*args)
        finally:
            self.cross_hit = None

    def select_point(self, yaw, pitch, on_cross=None):
        return self._with_cross(on_cross, super().select_point, yaw, pitch)

    def _epipolar_mark(self, s):
        """Session._epipolar_mark raccourcie : de EPIPOLAR_START m (pas 0,5 m) depuis la caméra de la visée
        jusqu'un peu au-delà du sol touché (80 m au plus), sans les points à moins de EPIPOLAR_NEAR m de
        la caméra affichée (caméras à la hauteur de celle-ci, au-dessus d'un sol plat)."""
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        height = self._camera_height()
        sx, sy = triangulation._local(s["lon"], s["lat"], lon, lat)
        a, e = math.radians(s["heading"]), math.radians(s.get("elev") or 0.0)
        reach = 80.0 if e >= -0.002 else min(80.0, height / -math.tan(e) * 1.2 + 1.0)
        reach = max(reach, EPIPOLAR_START * 1.5)
        points = []
        for k in range(41):  # pas plus serrés près de la caméra de la visée
            t = EPIPOLAR_START * (reach / EPIPOLAR_START) ** (k / 40)
            x, y, z = sx + t * math.sin(a), sy + t * math.cos(a), t * math.tan(e)
            d = math.hypot(x, y)
            if d < EPIPOLAR_NEAR:
                continue
            view = self._view_of(math.degrees(math.atan2(x, y)), math.degrees(math.atan2(z, d)))
            points.append({"pic": self.item.get("id"), "yaw": view["yaw"], "pitch": view["pitch"]})
        return {"points": points, "guide": True, "epipolar": True}

    def viewer_marks(self):
        marks = self._filtered(super().viewer_marks)
        if self.active and self.item and self.mode == "height" and self._aiming():
            # Visées des autres photos tracées aussi en hauteur (le cœur : relevé) :
            # le pied visé est sur leur trait, même parmi des objets semblables (ticket #26)
            pic = self.item.get("id")
            lines = [self._epipolar_mark(s)["points"] for s in self.triangulator.sightings if s["pic"] != pic]
            marks = [{"points": [[p["yaw"], p["pitch"], False] for p in pts], "label": "", "guide": True,
                      "epipolar": True} for pts in lines if pts] + marks
        marks += self._calage_marks()
        if self._tilt_pending():  # objet vertical en cours (croix et trait du calage), effacé une fois validé
            marks.append({"points": [c["pos"] + [k == self.tilt_sel] for k, c in enumerate(self.tilt_clicks)],
                          "label": "", "calage": True})
        return json.dumps(marks)

    def focus(self):
        return json.dumps(super().focus())

    def handles(self):
        return json.dumps(super().handles())

    def results(self):
        """Liste des résultats (ticket #30) : une entrée par point de référence, ses hauteurs
        dessous (« sous »), nommées par leur point d'arrivée : « ↕ B 3,77 m ± 0,12 m ».
        Les autres points gardés et les distances n'y figurent pas (ils restent exportés)."""
        rows = super().results()
        self._stamp_confidence(set())  # mesures faites depuis la dernière lecture : leur état de confiance, au moment où elles sont faites
        measures_by_id = {id(m): m for m in self.tool.measures()}
        for r in rows:
            m = measures_by_id.get(r["id"]) if r["kind"] == "mesure" else None
            if m is not None and getattr(m, "confiance", None):
                r["confiance"] = self.CONFIDENCE_TEXT[m.confiance["etat"]]
        under = {}  # nom du point de référence -> lignes de ses mesures
        orphans = []  # mesure sans point de référence gardé : gardée visible, à la fin
        for r in rows:
            m = measures_by_id.get(r["id"]) if r["kind"] == "mesure" else None
            if m is None:
                continue
            end = self._end_name(m)
            if end:
                r = dict(r, text="{}{} {}".format(r["text"][:2], end["name"], r["text"][2:]))
            ref = (m.reference or {}).get("name")
            under.setdefault(ref, []).append(dict(r, sous=True))
        current = (self.ref_point or {}).get("name")
        out = []
        for r in rows:
            if r["kind"] != "point":
                continue
            lon, lat, values = self.points[r["id"]]
            name = values["nom"]
            if "releve" in values:  # objet relevé : son nom, sa précision et son premier champ
                first = next((v for v in values["releve"].values() if v not in (None, "")), None)
                where = "sur la carte" if values["nb_visees"] == 0 else "±{} m".format(measures._num(values["incert_m"], 2))
                r = dict(r, releve=True, lonlat=[lon, lat], text="Objet {} {}{}".format(
                    name, where, "" if first is None else " — {}".format(_field_text(first))))
                out.append(r)
            elif name in under or name == current:
                out += [r] + under.pop(name, [])
        for subs in under.values():
            orphans += [dict(r, sous=False) for r in subs]
        lengths = [{"id": k, "kind": "longueur",
                    "text": ("▱ {} (carte)".format(_area_text(v["surface_m2"])) if "surface_m2" in v
                             else "↔ {} (carte)".format(_length_text(v["valeur_m"], v["incert_m"]))),
                    "comment": v["commentaire"]} for k, v in enumerate(self.map_lengths)]
        return json.dumps(out + orphans + lengths)

    # Fiche PDF d'un point de référence (src/fiche.js, makeFiche) ------------------------------------
    def _fiche_measures(self, name):
        """Hauteurs faites depuis le point de référence nommé name."""
        return [m for m in self.tool.measures() if m.result and (m.reference or {}).get("name") == name]

    def fiche(self, k):
        """JSON de la fiche du point gardé n° k et de ses mesures : nom, position, lignes du tableau
        (point, mesure, valeur, incertitude, commentaire), textes de méthode (ceux des mesures),
        photo de la plus grande mesure (celle de la fiche) et emprise de la mini-carte (points,
        mesures et caméra de cette photo)."""
        lon, lat, values = self.points[int(k)]
        name = values["nom"]
        found = self._fiche_measures(name)

        # Le point de référence (triangulé), puis pour chaque mesure son sommet (cliqué sur la photo)
        # et, dessous, la mesure elle-même
        rows = [{"kind": "point", "point": name, "mesure": "Point de référence, triangulé", "valeur": "",
                 "incert": "± {} m".format(measures._num(values["incert_m"], 2)),
                 "commentaire": values.get("commentaire", "")}]
        texts, lonlats = [], [(lon, lat)]
        for m in found:
            r, end = m.result, self._end_name(m)
            end_name = end["name"] if end else "?"
            rows.append({"kind": "point", "point": end_name, "valeur": "", "incert": "", "commentaire": "",
                         "mesure": "Sommet, cliqué sur la photo"})
            rows.append({"kind": "mesure", "point": "{} ↕ {}".format(name, end_name),
                         "mesure": "Hauteur entre {} et {}".format(name, end_name),
                         "valeur": "{} m".format(measures._num(r["value"], 2)),
                         "incert": "± {} m".format(measures._num(r["uncertainty"], 2)),
                         "commentaire": getattr(m, "comment", "")})
            texts.append(self._fiche_note(m, rows[-1]["point"]))
            lonlats += [tuple(p) for p in r["points"]]
        largest = max(found, key=lambda m: m.result["value"], default=None)
        if largest is not None:
            pic = largest.clicks[0].get("pic")  # photo d'où elle a été prise
        else:
            pic = next(iter(self.point_views.get(name, {})), None) or values.get("photos", "").split(",")[0] or None
        item = self.photo_items.get(pic) if pic else None
        if item is not None:
            lonlats.append(tuple(float(v) for v in item["geometry"]["coordinates"][:2]))
        xs, ys = [p[0] for p in lonlats], [p[1] for p in lonlats]
        return json.dumps({"name": name, "lon": lon, "lat": lat, "rows": rows, "texts": _without_repeats(texts), "photo": pic,
                           "kind": largest.kind if largest is not None else None,
                           "bounds": [[min(xs), min(ys)], [max(xs), max(ys)]]}, ensure_ascii=False)

    def _fiche_note(self, m, label):
        """(label, morceaux) de la ligne courte de « Méthode et précision » pour la hauteur m (fiche) : ce
        qui n'est pas dans le tableau (distance de l'objet, hauteur de caméra)."""
        item = self.photo_items.get(m.clicks[0].get("pic"))
        height, source, _ = self.camera_of(item, self.precision.known(item)) if item else (self.tool.camera_height, None, 0)
        parts = ["objet à {} m de la photo".format(measures._num(m.result["ranges"][0], 1)),
                 "caméra à {} m ({})".format(measures._num(height, 2), self.CAMERA_LABELS.get(source, "réglage"))]
        return label, parts

    def fiche_frame(self, k):
        """JSON [[cap, élévation]] (radians, repère de la photo affichée) des bouts de la plus grande
        mesure du point gardé n° k, pour cadrer la photo de la fiche ; [] s'il n'y en a pas ici."""
        name = self.points[int(k)][2]["nom"]
        found = self._fiche_measures(name)
        largest = max(found, key=lambda m: m.result["value"], default=None)
        if largest is None or not self.item:
            return "[]"
        pts = self._height_points(largest)
        return json.dumps([[p["yaw"], p["pitch"]] for p in pts if p["yaw"] is not None])

    # Relevé d'objets (mode "releve") ------------------------------------------------------------
    def keep_point(self):
        """Relevé : point triangulé gardé comme objet ; la page demande
        ensuite ses champs (set_releve)."""
        if not self.releve:
            return super().keep_point()
        n, r, sightings = len(self.points), self.triangulator.result, list(self.triangulator.sightings)
        super().keep_point()
        if len(self.points) > n:
            self._releve_kept(_aimed_z(r, sightings))
        return self.status()

    def _releve_kept(self, z=None):
        """Dernier point gardé devenu objet relevé ; z : altitude NGF du point visé (m) ou None."""
        values = self.points[-1][2]
        values["id"] = 1 + max((v.get("id") or 0 for _, _, v in self.points[:-1]), default=0)  # n° d'objet, croissant
        self._releve_name(values)
        values["z_ngf"] = None if z is None else round(z, 2)
        values["releve"] = {}
        how = "posé sur la carte" if values["nb_visees"] == 0 else "gardé (±{} m)".format(measures._num(values["incert_m"], 2))
        self.message = "Objet {} {} : renseignez ses champs, puis visez l'objet suivant.".format(values["nom"], how)

    def _check_tilt(self):
        """Relevé : inclinaison de la photo calculée comme en mesure (le cœur s'en passe en mesure
        libre), car un objet posé sur une seule photo en dépend (voir releve_single)."""
        if self.releve and self.active and self.item:
            pic = self.item.get("id")
            before = self.calibration.auto.get(pic)
            self.tilts.check(self.item, self.calibration, lambda: self._on_tilt(pic, before))
            return
        super()._check_tilt()

    def releve_single(self):
        """Relevé, une seule visée faite depuis la photo affichée : (lon, lat, incertitude en m,
        distance en m) du point où elle touche le sol, ou None (autre photo, visée trop près de
        l'horizon). Incertitude : somme quadratique de la visée (AIM_ERROR) et de l'inclinaison de la
        photo (calée, sinon UNCALIBRATED) en élévation et en cap, du cap de la séquence, de la hauteur
        de caméra et de la position GPS de la photo."""
        # shortcut: sol supposé plat entre la caméra et l'objet ; prendre le LiDAR HD au point si l'écart gêne
        sightings = self.triangulator.sightings
        if not self.releve or len(sightings) != 1 or not self.item or sightings[0]["pic"] != self.item.get("id"):
            return None
        s = sightings[0]
        elev = -(s.get("elev") or 0.0)
        if elev < SINGLE_MIN_ELEV:
            return None
        h, _, sigma_h = self.camera_of(self.item, self.quality)  # hauteur et incertitude de la même source (calée, monture, écart RTK − sol, réglage)
        tilt = self.calibration.tilt(s["pic"])
        sigma_tilt = tilt["sigma"] if tilt and tilt.get("sigma") is not None else calibration.UNCALIBRATED
        e = math.radians(elev)
        d = h / math.tan(e)
        sigma_e = math.radians(math.hypot(calibration.AIM_ERROR, sigma_tilt))
        sigma_az = math.radians(math.hypot(calibration.AIM_ERROR, sigma_tilt, s.get("heading_error") or 0.0))
        gps = s["accuracy"] or triangulation.GPS_ACCURACY
        unc = math.sqrt((h / math.sin(e) ** 2 * sigma_e) ** 2 + (sigma_h / math.tan(e)) ** 2
                        + (d * sigma_az) ** 2 + gps ** 2)
        lon, lat = triangulation.offset(s["lon"], s["lat"], s["heading"], d)
        return lon, lat, unc, d

    def keep_single(self):
        """Relevé : garde l'objet visé sur la seule photo affichée (voir releve_single)."""
        single = self.releve_single()
        if single is None:
            return self.status()
        lon, lat, unc, d = single
        s = self.triangulator.sightings[0]
        name = session._point_name(self.named)
        self.named += 1
        self.points.append((lon, lat, {
            "nom": name, "nb_visees": 1, "angle": None, "incert_m": round(unc, 2), "ecart_m": None,
            "dist_max_m": round(d, 1), "gps_m": round(s["accuracy"] or triangulation.GPS_ACCURACY, 1), "photos": s["pic"],
            "date_mesure": datetime.now().isoformat(timespec="seconds"), "commentaire": ""}))
        self.point_views[name] = {s["pic"]: s["view"]} if s.get("view") else {}
        self.triangulator.clear()
        self._releve_kept(None if s.get("alt") is None else s["alt"] - self._camera_height())  # au sol
        return self.status()

    def clear_releve(self):
        """« Vider le relevé » : objets relevés retirés, les points des mesures restent."""
        for k in reversed([k for k, (_, _, v) in enumerate(self.points) if "releve" in v]):
            self.point_views.pop(self.points[k][2]["nom"], None)
            self.delete_result("point", k)
        self.message = "Relevé vidé : le prochain objet commencera un nouveau relevé, avec ses champs."
        return self.status()

    def _releve_name(self, values):
        """Objet relevé nommé par son id (carte, photo, résultats, fiche) au lieu d'une lettre ; la
        lettre prise resservira aux points des mesures."""
        old, new = values["nom"], str(values["id"])
        if old == new:
            return
        self.point_views[new] = self.point_views.pop(old, {})
        values["nom"] = new
        if old == session._point_name(self.named - 1):
            self.named -= 1

    def keep_map(self, lon, lat):
        """Relevé : objet posé d'un clic sur la mini-carte, sans visée (nb_visees 0, précision MAP_PLACE_ERROR,
        altitude inconnue) ; dans les photos, projeté au sol."""
        if not self.releve:
            return self.status()
        self.points.append((float(lon), float(lat), {
            "nom": session._point_name(self.named), "nb_visees": 0, "angle": None, "incert_m": MAP_PLACE_ERROR, "ecart_m": None,
            "dist_max_m": None, "gps_m": None, "photos": "", "date_mesure": datetime.now().isoformat(timespec="seconds"),
            "commentaire": ""}))
        self.named += 1
        self._releve_kept()
        return self.status()

    def set_releve(self, k, text):
        """Champs saisis de l'objet relevé n° k (JSON {nom du champ: valeur}, dans l'ordre du formulaire)."""
        k = int(k)
        if 0 <= k < len(self.points) and "releve" in self.points[k][2]:
            self.points[k][2]["releve"] = json.loads(text)
        return self.status()

    def clear_all(self):
        """« Tout effacer » : hors du mode relevé, les objets relevés restent (exportés à part)."""
        kept = [] if self.releve else [p for p in self.points if "releve" in p[2]]
        views, named = {p[2]["nom"]: self.point_views.get(p[2]["nom"], {}) for p in kept}, self.named
        super().clear_all()
        self.map_lengths = []
        if kept:
            self.points, self.point_views, self.named = kept, views, named
        return self.status()

    def has_results(self):
        """Mesures et points triangulés à exporter (les objets relevés à part : has_releve)."""
        return bool(self.map_lengths) or any("releve" not in v for _, _, v in self.points) or any(
            m.result for m in self.tool.measures())

    def has_releve(self):
        return any("releve" in v for _, _, v in self.points)

    def releve_json(self):
        """Objets relevés, à garder dans le navigateur entre deux séances (load_releve)."""
        return json.dumps({"named": self.named, "points": [
            [lon, lat, v, self.point_views.get(v["nom"], {})] for lon, lat, v in self.points if "releve" in v]},
            ensure_ascii=False)

    def load_releve(self, text):
        """Objets relevés de la séance précédente (releve_json), ajoutés aux points gardés."""
        data = json.loads(text or "null") or {}
        for lon, lat, values, views in data.get("points", []):
            values.setdefault("id", 1 + max((v.get("id") or 0 for _, _, v in self.points), default=0))
            self.points.append((lon, lat, values))
            self.point_views[values["nom"]] = views
            self._releve_name(values)  # relevé gardé avant la numérotation : lettre remplacée
        self.named = max(self.named, data.get("named", 0))
        return self.status()

    def take_frame(self):
        return json.dumps(super().take_frame())

    def take_bridge_alert(self):
        return json.dumps(super().take_bridge_alert())

    # Panneau « Calage manuel » : jugement des verticales de la photo (calibration.vertical_report) --------------------
    CALAGE_PICK = 1.5  # degrés : clic dans la photo à moins de cette distance d'une verticale = la choisir dans le panneau
    CALAGE_COLORS = {"bon": "#8ee8ff", "douteux": "#ffb74d", "aberrante": "#ff5252", None: "#8ee8ff"}

    def _calage_pic(self):
        return (self.item or {}).get("id")

    def _calage_report(self):
        pic = self._calage_pic()
        return self.calibration.vertical_report(pic, self._heading()) if pic else None

    def calage_manuel(self):
        """JSON du calage de la photo affichée, pour le voyant et le panneau : manual (verticales tracées à la main : count, tilt,
        toward, sigma, partial, pitch, roll, scale, rows (angle, deviation, effect, verdict), outliers, doubtful ; null sans
        verticale), retained (inclinaison retenue par Calibration.tilt : source, sigma, pitch, roll ; null sans inclinaison) et auto
        (calcul automatique par les verticales de la photo : available, off (écarté par l'utilisateur), count (null au seuil élargi),
        loose, et sa propre inclinaison : pitch, roll, sigma, segments, et les indicateurs de qualité edges, gap, sigma_pitch, sigma_roll, fragile, fragile_reason : null sur les anciennes entrées) et confidence (confiance de l'inclinaison retenue, voir
        tilt_confidence_of ; null sans inclinaison), roll_label et profile (profil de campagne de la photo affichée : id, label, first, end, method, provenance ; null sans profil)."""
        pic = self._calage_pic()
        out = {"manual": None, "retained": None, "confidence": None, "roll_label": self._roll_label(self.item), "profile": self._profile_info(self.item), "auto": {"available": False, "off": False, "count": None, "loose": False}}
        if not pic:
            return json.dumps(out)
        report = self._calage_report()
        if report is not None:
            tilt, rows = report["tilt"], report["rows"]
            out["manual"] = {
                "count": report["count"], "tilt": tilt["tilt"], "toward": tilt["toward"], "sigma": tilt["sigma"],
                "partial": tilt["partial"], "pitch": report["pitch"], "roll": roulis_vehicule_depuis_camera(report["roll"]), "scale": report["scale"],
                "rows": rows, "outliers": report["outliers"],
                "doubtful": [i for i, r in enumerate(rows) if r["verdict"] == "douteux"]}
        got = self.calibration.tilt(pic)
        if got:
            pitch, roll = calibration.tilt_components(got["up"], self._heading())
            out["retained"] = {"source": got["source"], "sigma": got["sigma"], "pitch": pitch, "roll": roulis_vehicule_depuis_camera(roll),
                               "count": got.get("count")}
        out["confidence"] = self.tilt_confidence_of(pic, self.item)  # indicateur de confiance (Calibration.confidence)
        entry = self.calibration.auto.get(pic) or {}
        found = entry.get("verticals")
        loose = self.birdeye_loose.get(pic)
        out["auto"] = {"available": bool(found or loose), "off": pic in self.calibration.auto_off,
                       "count": found["count"] if found else None, "loose": not found and bool(loose)}
        own = found or loose  # sa propre inclinaison, retenue ou non
        if own:
            pitch, roll = calibration.tilt_components(own["up"], self._heading())
            out["auto"].update(pitch=pitch, roll=roulis_vehicule_depuis_camera(roll), sigma=own["sigma"],
                               **{k: own.get(k) for k in ("edges", "gap", "sigma_pitch", "sigma_roll", "fragile", "fragile_reason")})
            out["auto"]["segments"] = own.get("count")
        return json.dumps(out)

    def calage_auto_off(self, off):
        """« Réinitialiser » (off vrai) : le calcul automatique par les verticales est ignoré pour la photo, l'inclinaison passe à la
        source suivante ; « Rétablir le calcul automatique » (off faux)."""
        pic = self._calage_pic()
        if not pic:
            return self.status()
        self.calibration.set_auto_off(pic, off)
        self._calibration_changed({pic})
        self.message = "Calcul automatique des verticales {}.".format("ignoré pour cette photo" if off else "rétabli")
        return self.status()

    def calage_panel(self, opened, select=None, hover=None):
        """Panneau ouvert ou fermé ; select : verticale choisie (None : aucune), hover : verticale survolée dans la liste."""
        self.calage_open = bool(opened)
        self.calage_pic = self._calage_pic()
        self.calage_sel = None if select is None or select < 0 else int(select)
        self.calage_hover = None if hover is None or hover < 0 else int(hover)
        return self.status()

    def calage_pick(self, yaw, pitch):
        """Numéro (à partir de 0) de la verticale de la photo la plus proche du clic (yaw, pitch en radians, repère de la
        photo) à CALAGE_PICK° au plus, sinon -1."""
        best, here = -1, math.inf
        for k, points in enumerate(self._calage_lines()):
            for (y1, p1), (y2, p2) in zip(points, points[1:]):
                d = _segment_gap(math.degrees(yaw), math.degrees(pitch), math.degrees(y1), math.degrees(p1),
                                 math.degrees(y2), math.degrees(p2))
                if d < here:
                    best, here = k, d
        return best if here <= self.CALAGE_PICK else -1

    def calage_remove(self, index):
        """Retire la verticale n° index de la photo : inclinaison et ce qui en dépend recalculés."""
        return self._calage_remove([int(index)], "Verticale {} retirée.".format(int(index) + 1))

    def calage_drop_outliers(self):
        """Retire les verticales jugées aberrantes de la photo."""
        report = self._calage_report()
        found = report["outliers"] if report else []
        if not found:
            return self.status()
        return self._calage_remove(found, "{} verticale{} aberrante{} retirée{}.".format(
            len(found), *(("s",) * 3 if len(found) > 1 else ("",) * 3)))

    def calage_purge_photo(self):
        """Retire toutes les verticales de la photo (comme ↶ en mode calage)."""
        pic = self._calage_pic()
        return self._calage_remove(list(range(len(self.calibration.verticals.get(pic, [])))), "Calage manuel de la photo retiré.")

    def calage_purge_all(self):
        """Retire les verticales de toutes les photos (confirmé par la page)."""
        count = self.calibration.clear_all_tilts()
        self.calage_sel = self.calage_hover = None
        if count:
            self._calibration_changed()
            self.message = "Calage manuel de toutes les photos retiré ({} verticale{}).".format(count, "s" if count > 1 else "")
        return self.status()

    def _calage_remove(self, indices, message):
        pic = self._calage_pic()
        if not pic or not indices:
            return self.status()
        try:
            self.calibration.remove_verticals(pic, indices)
        except calibration.CalibrationError as exc:
            self.message = "Verticale non retirée : {}".format(exc)
            return self.status()
        self.calage_sel = self.calage_hover = None
        self._calibration_changed({pic})
        self.message = message
        return self.status()

    def _calage_lines(self):
        """Verticales de la photo affichée tracées dans son repère : une liste de points (yaw, pitch en radians) par
        verticale, sur l'arc de grand cercle du pied au sommet cliqués (directions brutes)."""
        pic = self._calage_pic()
        if not pic or not self.item:
            return []
        heading, lines = self._heading(), []
        for bottom, top in self.calibration.verticals.get(pic, []):
            a, b, points = calibration.vector(*bottom), calibration.vector(*top), []
            for k in range(13):
                t = k / 12
                yaw, elev = calibration.angles(calibration._unit(tuple(a[i] * (1 - t) + b[i] * t for i in range(3))))
                points.append((math.radians((yaw - heading + 540) % 360 - 180), math.radians(elev)))
            lines.append(points)
        return lines

    def _calage_marks(self):
        """Traits des verticales de la photo, numérotés, tant que le panneau est ouvert : couleur du verdict, plus épais
        pour la verticale choisie ou survolée."""
        if not self.calage_open or not self.item:
            return []
        report = self._calage_report()
        if report is None:
            return []
        same = self.calage_pic == self._calage_pic()
        marks = []
        for k, points in enumerate(self._calage_lines()):
            on = same and k in (self.calage_sel, self.calage_hover)
            marks.append({"points": [[y, p, False] for y, p in points], "label": str(k + 1), "beside": True,
                          "trace": self.CALAGE_COLORS.get(report["rows"][k]["verdict"]), "sel": on})
        return marks

    # Calage de l'inclinaison : objet vertical validé par un bouton -----------------------------
    TILT_NEAR = 1.5  # degrés : clic sur une croix de l'objet en cours (sélection pour la déplacer)

    def _tilt_pending(self):
        """Objet vertical en cours sur la photo affichée (calage de l'inclinaison)."""
        return bool(self.active and self.mode == "tilt" and self.item and self.tilt_clicks
                    and self.tilt_clicks[0]["pic"] == self.item.get("id"))

    def status(self):
        text = super().status()
        if self.releve:
            text = "Relevé d'objets : " + text
        return text

    # Couche importée (GeoJSON, src/couche.js) : objets dans la photo, à leur altitude (z du fichier,
    # NGF) ou posés sur le sol LiDAR HD, lu sous la caméra et sous leurs sommets (lignes redécoupées
    # tous les OVERLAY_STEP m pour suivre le terrain) ; dessinés une fois le sol de la caméra lu (pas de saut), chaque
    # objet une fois ses sommets lus ; à plat à la hauteur de caméra sans LiDAR ou sans réponse en OVERLAY_TIMEOUT_MS ----------
    OVERLAY_REACH = 100.0  # m : objets dessinés dans la photo s'ils ont un sommet à cette distance
    OVERLAY_STEP = 5.0  # m : pas des lignes, pour suivre le terrain entre leurs sommets
    OVERLAY_CHUNK = 150  # points par requête d'altitude (longueur de l'adresse)
    POINT_GROUND_MAX = 200  # couples (caméra, point) dont l'altitude est gardée (view_point)
    OVERLAY_TIMEOUT_MS = 5000  # ms : sans réponse, sol supposé de niveau avec la caméra (objets à plat)
    OVERLAY_MAX = 900  # points d'altitude au plus demandés par photo (sommets pas encore lus)

    def set_overlay(self, text):
        """Couche importée, JSON [{id, geometry}] en WGS 84, z éventuel en NGF (vide : retirée) : points,
        et lignes (contours des polygones compris), multi-géométries éclatées en parties."""
        self.overlay, self.overlay_ground, self.overlay_asked = [], {}, set()
        for f in json.loads(text or "[]"):
            g, i = f.get("geometry") or {}, f.get("id")
            kind, coords = g.get("type", ""), g.get("coordinates") or []
            if kind == "Point":
                parts = [[coords]]
            elif kind == "MultiPoint":
                parts = [[p] for p in coords]
            elif kind == "LineString":
                parts = [coords]
            elif kind in ("MultiLineString", "Polygon"):
                parts = coords
            elif kind == "MultiPolygon":
                parts = [ring for poly in coords for ring in poly]
            else:
                parts = []
            for part in parts:
                # z = 0 : « pas d'altitude » des exports KML (altitudeMode clampToGround), posé sur le sol
                pts = [(float(p[0]), float(p[1]), float(p[2]) if len(p) > 2 and p[2] else None)
                       for p in part if len(p) >= 2]
                if pts:
                    line = not kind.endswith("Point")
                    self.overlay.append((i, "ligne" if line else "point", _densified(pts, self.OVERLAY_STEP) if line else pts))
        return len(self.overlay)

    def view_point(self, lon, lat, up):
        """JSON {yaw, pitch} (radians, repère de la photo affichée, calage compris) du point de la carte (lon, lat) à up m
        au-dessus du sol ; null sans photo. Sol lu sur le LiDAR HD (RGE ALTI s'il manque) sous la caméra et sous le point :
        la caméra est à _camera_height au-dessus du sien. En attendant la lecture (redessin à son arrivée), ou sans
        altitude, sol supposé de niveau avec celui de la caméra. Sert à l'étiquette de la parcelle cadastrale visée,
        à 1,50 m du sol à la limite de la parcelle et du domaine public."""
        if not self.item:
            return "null"
        here_lon, here_lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        lon, lat = float(lon), float(lat)
        x, y = triangulation._local(lon, lat, here_lon, here_lat)
        ground = self._point_ground(here_lon, here_lat, lon, lat)  # (sol caméra, sol du point) ou None
        drop = self._camera_height() - float(up) + (ground[0] - ground[1] if ground else 0.0)
        v = self._view_of(math.degrees(math.atan2(x, y)), -math.degrees(math.atan2(drop, max(math.hypot(x, y), 0.5))))
        return json.dumps({"yaw": v["yaw"], "pitch": v["pitch"]})

    def _point_ground(self, here_lon, here_lat, lon, lat):
        """Altitudes du sol (LiDAR HD, sinon RGE ALTI) sous la caméra et sous le point : (z caméra, z point), ou None
        (lecture en cours, ou altitude manquante). Une lecture par couple de points, gardée ; redessin à l'arrivée."""
        key = tuple(round(v, 7) for v in (here_lon, here_lat, lon, lat))
        if key in self.point_ground:
            return self.point_ground[key]
        self.point_ground[key] = None
        if len(self.point_ground) > self.POINT_GROUND_MAX:  # les plus anciennes oubliées
            del self.point_ground[next(iter(self.point_ground))]

        def done(zs, source, error):
            if not error and zs and len(zs) == 2 and None not in zs:
                self.point_ground[key] = (zs[0], zs[1])
                self.notify()

        precision.fetch_terrain([(here_lon, here_lat), (lon, lat)], done)
        return self.point_ground.get(key)  # réponse déjà là (lecture en cache) : prise tout de suite

    def overlay_marks(self):
        """JSON [{id, kind, points: [[cap, élévation]], dist}] (radians, repère de la photo affichée ;
        dist : distance en m de la caméra au sommet le plus proche) des parties de la couche importée
        qui ont un sommet à OVERLAY_REACH m de la photo, de la plus proche à la plus lointaine."""
        if not self.item or not self.overlay:
            return "[]"
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        k = math.cos(math.radians(lat))
        reach = self.OVERLAY_REACH / 111320.0
        near = [(i, kind, pts) for i, kind, pts in self.overlay
                if any(abs(p[1] - lat) < reach and abs(p[0] - lon) * k < reach for p in pts)]
        ground = self._overlay_ground(lon, lat, near)  # {(lon, lat): z}, sol sous la caméra en (lon, lat)
        if (lon, lat) not in ground:  # sol de la caméra en cours de lecture : rien, plutôt qu'à plat puis un saut
            return "[]"
        height, base = self._camera_height(), ground[(lon, lat)]
        out = []
        for i, kind, pts in near:
            if any((p[0], p[1]) in self.overlay_asked for p in pts):  # sommet en cours de lecture : dessiné à son arrivée
                continue
            views, dist = [], None
            for plon, plat, z in pts:
                z = z if z is not None else ground.get((plon, plat))
                x, y = triangulation._local(plon, plat, lon, lat)
                drop = height + base - z if base is not None and z is not None else height  # sinon : à plat
                v = self._view_of(math.degrees(math.atan2(x, y)), -math.degrees(math.atan2(drop, max(math.hypot(x, y), 0.5))))
                views.append([v["yaw"], v["pitch"]])
                dist = math.hypot(x, y) if dist is None else min(dist, math.hypot(x, y))
            out.append({"id": i, "kind": kind, "points": views, "dist": round(dist, 1)})
        out.sort(key=lambda o: o["dist"])
        return json.dumps(out)

    def _overlay_ground(self, lon, lat, near):
        """Altitudes LiDAR HD sous la caméra et sous les sommets proches sans z (à une fois et demie OVERLAY_REACH) :
        {(lon, lat): z}, gardées pour toute la couche (les objets ne bougent pas : photo suivante de la séquence sans
        relecture) ; seuls les points pas encore lus sont demandés, OVERLAY_MAX au plus par photo. Absente : None."""
        k, reach = math.cos(math.radians(lat)), 1.5 * self.OVERLAY_REACH / 111320.0
        known, asked = self.overlay_ground, self.overlay_asked
        points = [p for p in dict.fromkeys([(lon, lat)] + [
            (p[0], p[1]) for _, _, pts in near for p in pts
            if p[2] is None and abs(p[1] - lat) < reach and abs(p[0] - lon) * k < reach])
            if p not in known and p not in asked][:self.OVERLAY_MAX]
        if not points:
            return known
        asked.update(points)
        chunks = [points[n:n + self.OVERLAY_CHUNK] for n in range(0, len(points), self.OVERLAY_CHUNK)]

        def got(chunk):
            def done(data, error):
                if known is not self.overlay_ground:  # couche changée entre-temps : réponse jetée
                    return
                z = None if error else precision._ground(data)
                # sans réponse (OVERLAY_TIMEOUT_MS) ou en erreur : à plat ; shortcut: pas relu avant le prochain import
                known.update(zip(chunk, z if z and len(z) == len(chunk) else [None] * len(chunk)))
                asked.difference_update(chunk)
                self.notify()  # objets de ce paquet dessinés
            return done

        for chunk in chunks:
            host.fetch_json(precision.lidar_url(chunk, precision.LIDAR_RESOURCE), got(chunk), timeout_ms=self.OVERLAY_TIMEOUT_MS)
        return known

    # Hauteurs suivantes depuis le point de référence, sur l'axe de la première -------------------
    # Une fois une hauteur faite depuis A sur la photo affichée (ligne A–C), le sommet des suivantes
    # (« Nouvelle mesure depuis A ») est pris sur le prolongement de cette ligne, au plus près du clic :
    # même objet, même verticale. La page y tient le réticule, avec un trait jaune en travers.

    def height_axis(self):
        """JSON [[cap, élévation] du pied, [cap, élévation] du sommet] (radians, repère de la photo) de
        la première hauteur depuis le point de référence prise sur la photo affichée, quand le
        prochain clic donnera le sommet d'une autre hauteur depuis lui ; sinon null."""
        return json.dumps(self._height_axis())

    def _height_axis(self):
        ref, tool = self.ref_point, self.tool
        if not (self.active and self.item and self.mode == "height" and ref) or self._aiming() or self._locked() \
                or self.ref_sel or tool.selected is not None:
            return None
        if tool.current is not None and len(tool.current.clicks) < tool.current.needed():
            return None
        pic = self.item.get("id")
        first = next((m for m in self._heights() if (m.reference or {}).get("name") == ref["name"]
                      and m.clicks[0].get("pic") == pic), None)
        if first is None:
            return None
        foot, top = self._height_points(first)[:2]
        if foot["yaw"] is None or top["yaw"] is None:
            return None
        return [[foot["yaw"], foot["pitch"]], [top["yaw"], top["pitch"]]]

    def click(self, yaw, pitch, on_cross=None):
        """Clic dans la photo ; on_cross : la page a vu une croix sous le pointeur (CROSS_PX), ou None (en degrés)."""
        return self._with_cross(on_cross, self._click, yaw, pitch)

    def _click(self, yaw, pitch):
        axis = self._height_axis() if self.mode == "height" else None
        if axis:
            click = tools.photo_click(self.item, (math.degrees(yaw) + self._heading()) % 360, math.degrees(pitch),
                                      self.calibration, self.quality, [yaw, pitch], self._axis(self.item))
            if click is not None and self._height_near(click) is None and not self._ref_near(click):
                # pas sur une croix : ramené sur l'axe, et plus une sélection (le pied, A et les sommets depuis A sont
                # sur l'axe : le point ramené tomberait près d'eux)
                yaw, pitch = _on_axis(axis, yaw, pitch)
                self.cross_hit = False
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
        reach = self.TILT_NEAR if self.cross_hit is None else self.CROSS_REACH if self.cross_hit else 0.0
        gaps = [(math.hypot(math.degrees(c["pos"][0] - yaw), math.degrees(c["pos"][1] - pitch)), k)
                for k, c in enumerate(self.tilt_clicks)]
        near = [k for d, k in sorted(gaps) if d < reach]
        if near:
            self.tilt_sel = near[0]
        elif len(self.tilt_clicks) < 2:
            self.tilt_clicks.append(click)
        else:
            self.message = ("Pied et sommet déjà placés : cliquez une de leurs croix pour la déplacer, puis "
                            "« ✔ Valider l'objet vertical » (« Effacer » retire son dernier clic).")
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

    # État remis par Ctrl+Y : listes copiées (les objets gardés tels quels : « Effacer » ne fait que
    # les retirer), sauf le calage du cap et de la position (CalibrationTool), non rétabli
    REDO_ATTRS = ("points", "named", "point_views", "ref_point", "measure_done",
                  "ref_sel", "tilt_clicks", "tilt_sel", "map_lengths")

    def _snapshot(self):
        snap = {k: getattr(self, k, None) for k in self.REDO_ATTRS}
        for k in ("points", "tilt_clicks", "map_lengths"):
            snap[k] = list(snap[k])
        snap["point_views"] = dict(snap["point_views"])
        tool = self.tool
        snap["tool"] = (list(tool.done), tool.current, tool.selected, list(self.triangulator.sightings))
        return snap

    def _redo_state(self):
        """Empreinte de ce que les gestes changent : un geste fait depuis le dernier « Effacer »
        rend Ctrl+Y sans objet."""
        tool, current = self.tool, self.tool.current
        return (len(self.points), len(tool.done), id(current), len(current.clicks) if current else 0,
                len(self.triangulator.sightings), id(self.ref_point), len(self.tilt_clicks), self.mode,
                self.measure_done, len(self.map_lengths))

    def redo(self):
        """Ctrl+Y (ou Ctrl+Maj+Z) : rétablit ce que le dernier « Effacer » a retiré, si rien n'a été fait
        depuis."""
        if not self.redo_stack or self._redo_state() != self.redo_key:
            self.redo_stack, self.redo_key = [], None
            self.message = "Rien à rétablir."
            return self.status()
        snap = self.redo_stack.pop()
        done, current, selected, sightings = snap.pop("tool")
        for k, v in snap.items():
            setattr(self, k, v)
        tool = self.tool
        tool.done, tool.current, tool.selected = done, current, selected
        for m in tool.measures():
            m._draw()  # dessin sur la carte retiré par l'effacement
        self.triangulator.sightings = list(sightings)
        if sightings:
            self.triangulator.recompute()
        else:
            self.triangulator.clear()
        self.redo_key = self._redo_state()
        self.message = "Rétabli."
        return self.status()

    def undo(self):
        before = self._redo_state()
        snap = None if self.active and self._active() is self.calibrator else self._snapshot()
        stack = self.redo_stack if self.redo_key == before else []
        text = self._undo()
        if snap is not None and self._redo_state() != before:  # quelque chose a été retiré
            stack.append(snap)
        self.redo_stack, self.redo_key = stack, self._redo_state()
        return text

    def _can_undo(self):
        """« Effacer » aurait-il un effet ? (mêmes cas que _undo et Session.clear)"""
        if self.map_mode:  # mesure sur la carte : la dernière longueur
            return bool(self.map_lengths)
        if self.mode == "tilt":  # objet vertical en cours, ou inclinaison calée à la main de la photo
            pic = (self.item or {}).get("id")
            return bool(self._tilt_pending() or self.calibrator.clicks or (pic and pic in self.calibration.verticals))
        tool = self.tool
        if self.triangulator.sightings or self.ref_sel \
                or tool.selected is not None or (tool.current is not None and tool.current.clicks):
            return True
        return bool(self.points) if self.mode == "tri" else self.ref_point is not None

    def _can_clear(self):
        """« Tout effacer » aurait-il un effet ?"""
        return bool(self.points or self.map_lengths or self.tool.measures() or self.triangulator.sightings
                    or self.ref_point is not None or self.tilt_clicks or self.calibrator.clicks)

    def _undo(self):
        """« Effacer » et Ctrl+Z : annule le dernier geste. Visées : la dernière seule ; objet vertical du calage : son dernier clic ; sinon comme Session.clear
        (sélection, mesure en cours, puis dernier point posé)."""
        if self.map_mode:
            if self.map_lengths:
                self.map_lengths.pop()
                self.message = "Dernière mesure sur la carte effacée."
            return self.status()
        if self._tilt_pending() and self.tilt_clicks:
            self.tilt_clicks.pop()
            self.tilt_sel = None
            self.message = "Dernier clic de l'objet vertical annulé."
            return self.status()
        sightings = self.triangulator.sightings
        if self.active and self._active() is self.triangulator and sightings:
            sightings.pop()
            if sightings:
                self.triangulator.recompute()
            else:
                self.triangulator.clear()
            self.message = "Dernière visée annulée ({} restante{}).".format(len(sightings), "s" if len(sightings) > 1 else "")
            return self.status()
        return self.clear()

    def clear(self):
        if self._tilt_pending():
            self.tilt_clicks, self.tilt_sel = [], None
            self.message = "Objet vertical abandonné."
            return self.status()
        return super().clear()


    def set_mode(self, mode):
        self.tilt_clicks, self.tilt_sel = [], None
        self.releve = mode == "releve"
        self.map_mode = mode == "carte"  # mesure sur la carte : le cœur reste en mode « tri », inactif
        return super().set_mode("tri" if self.releve or self.map_mode else mode)

    def add_map_length(self, lon1, lat1, lon2, lat2, value, sigma, photos):
        """Longueur mesurée sur la vue du dessus (deux clics sur la carte) : valeur et incertitude (m) calculées par
        la page (src/dessus.js), photos qui ont fourni l'image (séparées par des virgules). Incertitude None : un bout
        hors de la vue, longueur sur le fond de carte seul (contrôle rapide de cohérence)."""
        sigma = float(sigma) if isinstance(sigma, (int, float)) else None  # null de la page : JsNull, pas None
        self.map_lengths.append({"ends": [[lon1, lat1], [lon2, lat2]], "valeur_m": float(value), "incert_m": sigma,
                                 "photos": photos, "commentaire": ""})
        self.message = "Longueur sur la carte : {}.".format(_length_text(value, sigma))
        return self.status()

    def add_map_area(self, ring):
        """Surface tracée sur la carte (≥ 3 sommets, texte JSON [[lon, lat], …], contour ouvert) : aire (m²) et périmètre (m)
        sur le plan local du premier sommet. Pas d'incertitude (fond de carte ou image du dessus, sans calcul d'erreur)."""
        pts = json.loads(ring)
        local = [triangulation._local(lon, lat, *pts[0]) for lon, lat in pts]
        pairs = list(zip(local, local[1:] + local[:1]))
        area = abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in pairs)) / 2
        self.map_lengths.append({"ends": pts, "valeur_m": sum(math.hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in pairs),
                                 "incert_m": None, "photos": "", "commentaire": "", "surface_m2": area})
        self.message = "Surface sur la carte : {}.".format(_area_text(area))
        return self.status()

    def delete_result(self, kind, ident):
        if kind == "longueur":
            if 0 <= ident < len(self.map_lengths):
                del self.map_lengths[ident]
                self.message = "Longueur effacée."
            return self.status()
        return super().delete_result(kind, ident)

    def set_comment(self, kind, ident, text):
        if kind == "longueur":
            if 0 <= ident < len(self.map_lengths):
                self.map_lengths[ident]["commentaire"] = text
            return
        super().set_comment(kind, ident, text)

    def take_aim_frame(self):
        """Visées guidées : repère dans la photo affichée ([[cap, élévation]] en radians, JSON) du
        point à viser : triangulé par les visées déjà faites (dès la 3e visée), sinon tel qu'il est
        placé avant de l'être (voir _provisional_point). Une seule fois par photo affichée, et
        seulement si elle n'a pas encore servi à le viser ; null sinon. Propre à la page (pas dans
        le cœur)."""
        if not self.aim_frame or not self.active or not self.item:
            return "null"
        self.aim_frame = False
        sightings = self.triangulator.sightings
        if not sightings or any(s["pic"] == self.item.get("id") for s in sightings):
            return "null"
        r = self.triangulator.result
        if r:  # point triangulé : son altitude, si elle est connue, donne l'élévation depuis cette caméra
            lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
            alt = host.ngf_altitude(lon, lat, metadata.item_altitude(self.item)) \
                if (self.quality or {}).get("precise") else None
            z = r.get("z")
            p = self._project(r["lon"], r["lat"], alt - z if alt is not None and z is not None else None)
        else:
            target = self._provisional_point()
            if target is None:
                return "null"
            p = self._project(*target)
        return json.dumps([[p["yaw"], p["pitch"]]])

    def _provisional_point(self):
        """Point visé tel qu'il est placé avant d'être triangulé (lon, lat), ou None : le point de
        référence là où la première visée touche le sol plat."""
        sightings = self.triangulator.sightings
        if not sightings or self.mode not in session.REF_MODES or self.ref_point is not None:
            return None
        first = sightings[0]
        elev = first.get("elev") or 0.0
        if elev > -0.5:  # visée au-dessus de l'horizon ou presque : pas de sol touché
            return None
        return triangulation.offset(first["lon"], first["lat"], first["heading"],
                                    self._camera_height() / math.tan(math.radians(-elev)))

    def guide(self):
        """Visées guidées (voir Session.guide), chaque photo proposée avec « expect » : incertitude
        du point (m) une fois visé aussi depuis elle, d'après une visée simulée vers le point triangulé
        (ou provisoire), et « now » : celle d'aujourd'hui (None avec une seule visée)."""
        guide = super().guide()
        tri = self.triangulator
        r = tri.result
        target = (r["lon"], r["lat"], r.get("z")) if r else self._provisional_point()
        if not guide or target is None or not tri.sightings:
            return guide
        lon, lat = target[:2]
        z = target[2] if len(target) > 2 else tri.sightings[0].get("ground")
        base = tri.sightings[-1]  # même séquence : précision GPS, cap, hauteur de caméra
        for choice in guide["choices"]:
            if choice["lon"] is None:
                continue
            x, y = triangulation._local(lon, lat, choice["lon"], choice["lat"])
            dist = math.hypot(x, y)
            alt = base.get("alt")
            sim = dict(base, pic=choice["id"], lon=choice["lon"], lat=choice["lat"],
                       heading=math.degrees(math.atan2(x, y)) % 360, raw=None, gps=[choice["lon"], choice["lat"]],
                       elev=None if alt is None or z is None or dist < 0.5 else math.degrees(math.atan2(z - alt, dist)))
            try:
                res = tools.solve_on_ground(tri.sightings + [sim], tri.ground, tri.ground_z if tri.lidar else None)
            except triangulation.TriangulationError:
                continue
            choice["expect"], choice["now"] = res["uncertainty"], r["uncertainty"] if r else None
        return guide

    # Dessin ------------------------------------------------------------------------------
    def _new_item(self):
        item = WebItem()
        self.items.append(item)
        return item

    def _new_rays(self):
        item = RaysItem()
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
            if len(item.points) >= 2:  # sans étiquette : pas de longueur sur la carte (demande de l'utilisateur)
                add("mesure", "LineString", [list(p) for p in item.points])
            for p in item.points:
                add("point", "Point", list(p))
        self.rays = [r for r in self.rays if not r.removed]
        for item in self.rays:
            for lon, lat, elon, elat in item.rays:
                add("visee", "LineString", [[lon, lat], [elon, elat]])
            if item.point:
                add("cible", "Point", list(item.point))
        for lon, lat, values in self.points:
            add("triangule", "Point", [lon, lat], values["nom"])  # nom seul : pas d'incertitude sur la carte
        for v in self.map_lengths:  # longueur sur la carte : trait et valeur, comme une mesure
            if "surface_m2" in v:  # surface : contour fermé, valeur au centre (genre « surface » : étiquette seule)
                add("mesure", "LineString", v["ends"] + v["ends"][:1])
                add("surface", "Point", [sum(p[i] for p in v["ends"]) / len(v["ends"]) for i in (0, 1)], _area_text(v["surface_m2"]))
            else:
                add("mesure", "LineString", v["ends"], "{} m".format(measures._num(v["valeur_m"], 2)))
            for p in v["ends"]:
                add("point", "Point", p)
        return json.dumps({"type": "FeatureCollection", "features": features})

    # Export ------------------------------------------------------------------------------
    def _records(self, releve=False):
        """Mesures terminées et points triangulés : (géométrie [(lon, lat)], attributs), comme
        pour l'export ; releve : les objets relevés seuls, leurs champs en colonnes."""
        if releve:
            kept = [(lon, lat, values) for lon, lat, values in self.points if "releve" in values]
            # Champs ajoutés en cours de relevé : à leur place, vides pour les objets d'avant
            names = list(dict.fromkeys(k for _, _, v in kept for k in v["releve"] if k not in RELEVE_PLACE))
            return [([(lon, lat)], _releve_attrs(values, names)) for lon, lat, values in kept]
        out = []
        self._stamp_confidence(set())
        for m in self.tool.measures():
            r = m.result
            if not r:
                continue
            d = r["decomposition"]
            ends = r["points"] if len(r["points"]) >= 2 else r["picks"]
            # Hauteur de caméra de la photo du premier clic, pour information (la mesure n'en dépend pas) ; photo oubliée
            # (plus de 500 vues depuis) : le réglage
            item = self.photo_items.get(m.clicks[0].get("pic"))
            height, source, _ = self.camera_of(item, self.precision.known(item)) if item else (self.tool.camera_height, None, 0)

            def num(value, digits=3):
                return None if value is None else round(value, digits)

            out.append((ends, {
                "type": measures.KIND_NAMES[m.kind],
                "surface": measures.SURFACE_NAMES.get(m.surface, m.surface),
                "valeur_m": num(r["value"]), "incert_m": num(r["uncertainty"]),
                "horiz_m": num(d["horizontal"]), "vert_m": num(d["vertical"]),
                "long_route_m": num(d["along"]), "travers_m": num(d["across"]),
                "dist_photo_m": num(max(r["ranges"]), 1), "camera_m": num(height, 2),
                "camera_calee": self.CAMERA_CODES.get(source, 0),
                "recales": len(m.overrides),
                "photos": ",".join(dict.fromkeys(c.get("pic") or "" for c in m.clicks)),
                "date_mesure": datetime.now().isoformat(timespec="seconds"),
                "commentaire": getattr(m, "comment", ""),
                # Pour la revoir à l'import (src/choix.js, reviewMeasure) : photo d'où elle a été prise (celle
                # de la fiche) et repères tels que dessinés dessus ([[cap, élévation]] en radians, texte JSON)
                "photo_ref": m.clicks[0].get("pic"),
                "vue_ref": json.dumps(m.view_ref) if getattr(m, "view_ref", None) else None,
                "etiquette": m.label()[2:],  # sans le symbole
                "confiance_inclinaison": (getattr(m, "confiance", None) or {}).get("etat"),
                "ecart_tangage": num((getattr(m, "confiance", None) or {}).get("ecart_tangage"), 2),
                "ecart_roulis": num((getattr(m, "confiance", None) or {}).get("ecart_roulis"), 2),
                "profil": (self._profile(item) or {}).get("id") if item else None,  # profil de campagne de la photo (web_profils), en dernier
            }))
        for lon, lat, values in self.points:
            if "releve" not in values:  # objets relevés : export à part, gardés à part dans le navigateur
                out.append(([(lon, lat)], dict({"type": "point triangulé"}, **values)))
        for v in self.map_lengths:
            if "surface_m2" in v:  # contour fermé ; périmètre en valeur_m
                out.append(([tuple(p) for p in v["ends"] + v["ends"][:1]], {
                    "type": "surface sur la carte", "surface_m2": round(v["surface_m2"], 2), "valeur_m": round(v["valeur_m"], 3),
                    "date_mesure": datetime.now().isoformat(timespec="seconds"), "commentaire": v["commentaire"]}))
                continue
            out.append(([tuple(p) for p in v["ends"]], {
                "type": "longueur sur la carte ({})".format("vue du dessus" if v["incert_m"] is not None else "hors vue du dessus"),
                "valeur_m": round(v["valeur_m"], 3), "incert_m": None if v["incert_m"] is None else round(v["incert_m"], 3),
                "horiz_m": round(v["valeur_m"], 3), "photos": v["photos"],
                "photo_ref": v["photos"].split(",")[0] or None, "date_mesure": datetime.now().isoformat(timespec="seconds"),
                "commentaire": v["commentaire"]}))
        return out

    def export_geojson(self, releve=False):
        features = [{"type": "Feature", "properties": attrs,
                     "geometry": ({"type": "LineString", "coordinates": [list(p) for p in ends]} if len(ends) >= 2
                                  else {"type": "Point", "coordinates": list(ends[0])})}
                    for ends, attrs in self._records(releve)]
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

    def caption(self):
        """Cartouche d'attribution de la vue (obligation des licences Panoramax) : auteur, date,
        catégorie de la licence."""
        if not self.item:
            return "Panoramax"
        return capture.caption_for(self.item, None)


def _view_heading(item, yaw):
    """Cap (degrés) du centre de la vue : la visionneuse s'oriente sur view:azimuth."""
    return (math.degrees(yaw) + (metadata.item_heading(item) or 0.0)) % 360


RELEVE_PLACE = ("voie", "pr", "commune")  # lieu de l'objet, ajouté par la page à ses champs


def _releve_attrs(values, names):
    """Colonnes d'un objet relevé : id, champs de l'utilisateur (names, dans l'ordre de leur création ;
    None s'il n'en a pas la valeur), lieu, commentaire, puis le reste des attributs du point (sans
    « nom », qui reprend l'id, ni « type », laissé à l'utilisateur)."""
    fields = values["releve"]
    out = {"id": values.get("id")}
    out.update((k, fields.get(k)) for k in names)
    out.update((k, fields.get(k, "")) for k in RELEVE_PLACE)
    out["commentaire"] = values.get("commentaire", "")
    out.update((k, v) for k, v in values.items() if k not in ("id", "nom", "releve", "commentaire"))
    return out


def _aimed_z(r, sightings):
    """Altitude NGF (m) du point triangulé r : celle de la triangulation 3D, sinon la moyenne des
    visées dont la caméra a son altitude (alt + distance × tangente de l'inclinaison) ; None sans."""
    if r is None:
        return None
    if r.get("z") is not None:
        return r["z"]
    zs = [s["alt"] + d * math.tan(math.radians(s.get("elev") or 0.0))
          for s, d in zip(sightings, r["distances"]) if s.get("alt") is not None]
    return sum(zs) / len(zs) if zs else None


def _field_text(value):
    """Valeur d'un champ d'objet relevé pour la fiche : oui/non, nombre à virgule, texte."""
    if isinstance(value, bool):
        return "oui" if value else "non"
    if isinstance(value, float):
        return str(value).replace(".", ",")
    return "" if value is None else str(value)


def _csv(value):
    if value is None:
        return ""
    if isinstance(value, float):
        return repr(round(value, 7)).replace(".", ",")
    text = str(value)
    return '"' + text.replace('"', '""') + '"' if any(c in text for c in ';"\n') else text


def _without_repeats(notes):
    """Lignes des mesures d'un même point (fiche, voir App._fiche_note), sans leur nom (« ↔ B ») ni
    les morceaux déjà écrits plus haut (même caméra, même axe) ; une mesure sans rien de nouveau n'a
    pas de ligne."""
    seen, out = set(), []
    for _, parts in notes:
        fresh = [p for p in parts if p not in seen]
        seen.update(parts)
        if fresh:
            text = " · ".join(fresh)
            out.append(text[0].upper() + text[1:])
    return out


def _keep_view(m, points):
    """Repères de la mesure m tels que dessinés sur sa photo ([[cap, élévation]], radians), gardés pour l'export."""
    if all(p.get("yaw") is not None for p in points):
        m.view_ref = [[round(p["yaw"], 5), round(p["pitch"], 5)] for p in points]


def _densified(pts, step):
    """Ligne [(lon, lat, z ou None)] redécoupée tous les step m au plus (z interpolé s'il est connu aux
    deux bouts) : elle suit le terrain entre ses sommets."""
    out = [pts[0]]
    for (lon1, lat1, z1), (lon2, lat2, z2) in zip(pts, pts[1:]):
        x, y = triangulation._local(lon2, lat2, lon1, lat1)
        n = min(200, int(math.hypot(x, y) // step))
        for j in range(1, n + 1):
            t = j / (n + 1)
            out.append((lon1 + t * (lon2 - lon1), lat1 + t * (lat2 - lat1),
                        z1 + t * (z2 - z1) if z1 is not None and z2 is not None else None))
        out.append((lon2, lat2, z2))
    return out


def _on_axis(axis, yaw, pitch):
    """(cap, élévation) en radians du point du grand cercle passant par les deux directions de axis
    (droite dans la vue) le plus proche de (yaw, pitch)."""
    def vec(y, p):
        return (math.cos(p) * math.sin(y), math.sin(p), math.cos(p) * math.cos(y))
    a, c, v = vec(*axis[0]), vec(*axis[1]), vec(yaw, pitch)
    n = (a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0])
    norm = math.sqrt(sum(k * k for k in n))
    if norm < 1e-9:
        return yaw, pitch
    d = sum(vk * nk for vk, nk in zip(v, n)) / norm
    w = [vk - d * nk / norm for vk, nk in zip(v, n)]
    length = math.sqrt(sum(k * k for k in w))
    return math.atan2(w[0], w[2]), math.asin(max(-1.0, min(1.0, w[1] / length)))
