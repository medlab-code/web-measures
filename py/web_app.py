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
from urllib.parse import urlencode

import web_host
import web_terrain
import web_tilt
from core import (autotilt, calibration, capture, filters, host, measures, metadata, precision, roads, session, tools,
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
    return _title(words)


def _title(words, first=True):
    """Mots en minuscules remis en forme d'un nom : capitales sauf petits mots (_SMALL_WORDS)."""
    def word(w, first):
        if "'" in w:  # d'or -> d'Or
            head, tail = w.split("'", 1)
            return (head.capitalize() if first else head) + "'" + word(tail, False)
        if not first and w in _SMALL_WORDS:
            return w
        return "-".join(part.capitalize() for part in w.split("-"))

    return " ".join(word(w, first and k == 0) for k, w in enumerate(words))


# Voies de la BD TOPO (nom en abréviations, « R DE PARIS ») : nom en clair, avec son article
_STREETS = {"R": "la rue", "AV": "l'avenue", "BD": "le boulevard", "CHE": "le chemin", "CHEM": "le chemin",
            "RTE": "la route", "PL": "la place", "IMP": "l'impasse", "ALL": "l'allée", "QU": "le quai",
            "QUAI": "le quai", "CRS": "le cours", "PROM": "la promenade", "FG": "le faubourg", "VC": "la voie communale"}


def _road_label(name):
    """Route franchie, avec son article : « l'A6 », « la D905 », « la rue de Paris », sinon « une route »."""
    if re.match(r"[A-Z]+\d", name or ""):
        return ("l'" if name[0] in "AEIOUY" else "la ") + name
    words = (name or "").split()
    if len(words) > 1 and name.isupper() and words[0] in _STREETS:
        return _STREETS[words[0]] + " " + _title([w.lower() for w in words[1:]], first=False)
    return "une route"


# Cours d'eau nommés sans article par la BD TOPO (« Canal de Bourgogne ») : genre du nom commun
_WATERS = {"canal": "le", "ruisseau": "le", "bief": "le", "fossé": "le", "fleuve": "le", "torrent": "le",
           "ru": "le", "rû": "le", "bras": "le", "déversoir": "le", "aqueduc": "le", "étang": "le",
           "rivière": "la", "rigole": "la", "noue": "la", "dérivation": "la", "ravine": "la", "source": "la"}


def _water_label(name):
    """Cours d'eau franchi, avec son article : « l'Armançon » (déjà dans la BD TOPO), « le canal de
    Bourgogne », « la rivière … », « l'étang … » ; sans nom commun connu, le nom tel quel."""
    article = re.match(r"(l'|la |le |les )", name, re.IGNORECASE)
    if article:  # article en minuscule en milieu de phrase : « de la Vouge »
        return article.group(1).lower() + name[article.end():]
    first, _, rest = name.partition(" ")
    article = _WATERS.get(first.lower())
    if article is None:
        return name
    noun = first.lower() + (" " + rest if rest else "")
    return ("l'" if noun[0] in "aeiouyéèêh" else article + " ") + noun


def _of(label):
    """« de » devant un nom avec article : de l'Armançon, de la D905, du chemin…, d'une route ; d'Ouche."""
    for article, of in (("le ", "du "), ("les ", "des "), ("un ", "d'un "), ("une ", "d'une ")):
        if label.startswith(article):
            return of + label[len(article):]
    if label[:1].lower() in "aeiouyéèêh" and not label.startswith("l'"):
        return "d'" + label  # nom propre sans article : d'Ouche
    return "de " + label


# Axe de la route tiré de la trajectoire RTK (voir App._road_at_reference) : sur ±20 m, la position
# RTK (quelques cm) n'y compte presque pas ; reste l'écart du véhicule à la route, au plus ~0,2 m
AXIS_ERROR_RTK = 0.5  # degrés
RTK_SOURCE = "trajectoire RTK"
TRACK_STRAIGHT = 0.10  # m : écart type des photos à leur droite au plus (route droite, pas de changement de voie)
TRACK_SPAN = 20.0  # m de trajectoire au moins
TRACK_AGREE = 2.0  # degrés au plus entre la trajectoire et le tronçon de la BD TOPO
# Droite de mesure tracée sur la mini-carte (ticket #28, App.set_measure_line) : son orientation est
# connue à l'angle sous lequel MAP_CLICK m d'erreur sur chaque clic voient la longueur tracée
MAP_SOURCE = "tracé sur la carte"
MAP_LINE_MIN = 4.0  # m au moins entre les deux clics
MAP_CLICK = 0.3  # m : précision d'un clic sur la mini-carte zoomée
MAP_HEADING_ERROR = 0.3  # degrés : cap EXIF des photos de relevé (point A posé sur la droite)
MAP_MIN_ANGLE = 10.0  # degrés au moins entre la visée de A et la droite tracée
# Relevé : objet posé sur une seule photo (App.releve_single), si la visée descend assez sous l'horizon
SINGLE_MIN_ELEV = 2.0  # degrés : objet à 70 m au plus pour une caméra à 2,5 m
# Objet relevé posé d'un clic sur la mini-carte (App.keep_map) : précision des orthophotos IGN (environ 1 m)
MAP_PLACE_ERROR = 1.0  # m
# Visées des autres photos tracées dans la photo affichée (Session._epipolar_mark) : sans leurs premiers
# mètres, vus très en biais, projetés à des milliers de pixels hors de l'écran et redessinés à chaque
# image par la visionneuse (lenteur, surtout zoomé)
EPIPOLAR_START = 2.0  # m depuis la caméra de la visée
EPIPOLAR_NEAR = 3.0  # m au moins de la caméra de la photo affichée
_core_axis_error = widths.axis_error


def _axis_error(source):
    """widths.axis_error, avec l'axe tiré de la trajectoire RTK ou la droite tracée sur la carte."""
    if source and source.startswith(RTK_SOURCE):
        return AXIS_ERROR_RTK
    if source and source.startswith(MAP_SOURCE):  # « tracé sur la carte, ±1,7° »
        return float(source.rsplit("±", 1)[1].rstrip("°").replace(",", "."))
    return _core_axis_error(source)


widths.axis_error = _axis_error  # appelée par les largeurs du cœur


def _straight_track_axis(features, sequence, lon, lat):
    """Direction (degrés, modulo 180) de la trajectoire de la séquence à moins de
    roads.TRACK_RADIUS m de (lon, lat), si elle est droite (TRACK_STRAIGHT) sur TRACK_SPAN m au
    moins ; None sinon. Passages aller et retour (sens de la photo) ajustés chacun sur sa voie,
    avec une direction commune."""
    passes = {}  # sens de roulage -> positions (m)
    first = None
    for feat in (features or {}).get("features") or []:
        heading = metadata.item_heading(feat)
        if feat.get("collection") != sequence or heading is None:
            continue
        try:
            x, y = triangulation._local(*(float(v) for v in feat["geometry"]["coordinates"][:2]), lon, lat)
        except (KeyError, TypeError, ValueError):
            continue
        if math.hypot(x, y) <= roads.TRACK_RADIUS:
            first = heading if first is None else first
            passes.setdefault(math.cos(math.radians(heading - first)) >= 0, []).append((x, y))
    pts = []  # positions centrées sur leur passage
    for group in passes.values():
        mx, my = sum(p[0] for p in group) / len(group), sum(p[1] for p in group) / len(group)
        pts += [(x - mx, y - my) for x, y in group]
    if len(pts) < 5:
        return None
    sxx, syy, sxy = sum(x * x for x, _ in pts), sum(y * y for _, y in pts), sum(x * y for x, y in pts)
    angle = 0.5 * math.atan2(2 * sxy, sxx - syy)  # depuis l'est, sens trigonométrique
    ux, uy = math.cos(angle), math.sin(angle)
    along = [x * ux + y * uy for x, y in pts]
    across = [y * ux - x * uy for x, y in pts]
    if max(along) - min(along) < TRACK_SPAN or math.sqrt(sum(d * d for d in across) / len(pts)) > TRACK_STRAIGHT:
        return None
    return (90.0 - math.degrees(angle)) % 180


def _ign_bridges(data):
    """Ponts nommés de la BD TOPO (constructions linéaires de nature « Pont ») : [(ligne, nom)]."""
    out = []
    for feat in data.get("features") or []:
        props, geom = feat.get("properties") or {}, feat.get("geometry") or {}
        if props.get("nature") == "Pont" and props.get("toponyme"):
            coords = geom.get("coordinates") or []
            for line in coords if geom.get("type") == "MultiLineString" else [coords]:
                out.append(([tuple(p[:2]) for p in line], props["toponyme"]))
    return out


# Natures de la BD TOPO : nom d'une voie sans numéro ni nom (roads.parse_sections) ; ces voies ne sont pas citées aux carrefours
_WAY_KINDS = {"Route à 1 chaussée": "une route", "Route à 2 chaussées": "une route", "Route empierrée": "un chemin empierré",
              "Chemin": "un chemin", "Sentier": "un sentier", "Rond-point": "un rond-point", "Bretelle": "une bretelle",
              "Type autoroutier": "une voie rapide", "Piste cyclable": "une piste cyclable", "Escalier": "un escalier"}


def _crossing(a, b, c, d):
    """Point (x, y) où les segments [a, b] et [c, d] se coupent ou se touchent (sommet commun : la BD TOPO
    en met un au croisement de deux niveaux), ou None (pas de contact, ou parallèles)."""
    den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])
    if not den:
        return None
    t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den
    u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den
    eps = 1e-9
    return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])) if -eps <= t <= 1 + eps and -eps <= u <= 1 + eps else None


def _nearest_name(bridges, lon, lat, reach):
    """Nom du pont le plus proche de (lon, lat), à reach m au plus de sa ligne, ou None."""
    best = None
    for line, name in bridges or []:
        pts = [triangulation._local(p[0], p[1], lon, lat) for p in line]
        for (ax, ay), (bx, by) in zip(pts, pts[1:] or pts):  # distance du point (0, 0) au segment
            t = max(0.0, min(1.0, -(ax * (bx - ax) + ay * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 or 1.0)))
            d = math.hypot(ax + t * (bx - ax), ay + t * (by - ay))
            if d <= reach and (best is None or d < best[0]):
                best = (d, name)
    return best and best[1]


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


class App(session.Session):
    def __init__(self, notify, remote=None, api_url=web_host.API_URL):
        web_host.install(remote, api_url)
        if remote is not None:
            autotilt.HAS_NUMPY = True  # verticales calculées dans le Pyodide d'arrière-plan, qui a numpy
        super().__init__(notify, precision_checker=RankPrecisionChecker())
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
        self.edges = {}  # (photo, largeur examinée) -> chute et dévers des bords de route (voir _edges)
        self.edges_asked = {}  # photo -> largeur examinée au dernier appui sur « Dévers »
        self.long_tracks = {}  # photo -> trajectoire de la caméra autour d'elle (_track_line), None pendant la lecture
        self.edge_zone = self.EDGE_ZONE
        self.bdtopo = {}  # (couche BD TOPO, maille) -> objets lus (voir _bdtopo)
        self.map_line = None  # droite de mesure tracée sur la carte, pour le prochain point A (ticket #28)
        self.redo_stack, self.redo_key = [], None  # états d'avant chaque « Effacer » (Ctrl+Y, voir redo)
        self.overlay = []  # couche importée : (n° de l'objet, "point" ou "ligne", [(lon, lat, z)]), voir set_overlay
        self.overlay_ground = {}  # photo -> {(lon, lat): altitude LiDAR HD} sous la couche (_overlay_ground)
        self.tilt_reasons = {}  # photo -> raison de l'échec de l'inclinaison automatique (ticket #29)
        self.tilts.run = self._run_tilt
        # Inclinaison par le terrain hors agglomération, expérimentale (option, voir web_terrain)
        self.terrain_relay = False
        self.relay_tilts = {}  # photo -> inclinaison par le terrain (dict comme Calibration.auto_tilt)
        self.relay_pending = {}  # photo -> étape du calcul en cours
        self.relay_failed = {}  # photo -> raison de l'échec
        self.relay_models = {}  # séquence -> références, modèle (web_terrain.model), raison d'un échec
        self._core_auto_tilt = self.calibration.auto_tilt
        self.calibration.auto_tilt = self._auto_tilt
        # Relevé d'objets (mode "releve" de la page) : la mesure libre du cœur, sans distance entre les
        # points, chacun gardé avec les champs saisis par l'utilisateur (values["releve"])
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
        super().set_active(on)
        self._check_tilt()  # rien hors mesure, en mesure libre ou si déjà calculée
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
        return json.dumps(out)

    # Inclinaison automatique : raison d'un échec (ticket #29) -----------------------------------
    def _run_tilt(self, function, args, done):
        """Calcul des verticales demandé par autotilt.TiltChecker (à la place de autotilt.estimate) :
        web_tilt.estimate, dont la raison d'un échec est gardée pour la photo analysée."""
        pic = self.tilts.current

        def got(res):
            if res is None or "reason" in res:
                self.tilt_reasons[pic] = (res or {}).get("reason", "calcul des verticales indisponible")
                res = None
            done(res)
            if res is None and self.terrain_relay and (self.item or {}).get("id") == pic:
                self._relay(self.item)

        web_host.run_task(web_tilt.estimate, args, got)

    def _tilt_tried(self, pic):
        """Inclinaison automatique de la photo déjà calculée (ou abandonnée), dans cette session ou
        une précédente (calage conservé) ? Le cœur ne la lance qu'au premier clic (_check_tilt)."""
        return pic in self.calibration.auto or pic in self.tilt_reasons

    def _tilt_final(self):
        """Photo affichée sans inclinaison automatique à attendre : calcul fait, ou impossible."""
        return self._tilt_tried((self.item or {}).get("id")) or not autotilt.is_360(self.item or {})

    def _lights(self, pic):
        """Voyants du cœur ; inclinaison pas encore calculée : « avant » (jaune), pas « non » (rouge,
        pris pour un échec) ; calcul par le terrain en cours : « attente »."""
        def light_of(name, light):
            if name != "Inclinaison" or light != "non":
                return light
            return "attente" if pic in self.relay_pending else "non" if self._tilt_final() else "avant"
        return [(name, light_of(name, light)) for name, light in super()._lights(pic)]

    def _tilt_reason(self):
        """Pourquoi la photo affichée n'a pas d'inclinaison, ou None (calée, en cours) : raison de
        l'échec, ou moment du calcul s'il n'est pas encore fait (voir _tilt_final)."""
        item, pic = self.item or {}, (self.item or {}).get("id")
        if not pic or self.calibration.tilt(pic) or self.tilts.pending(pic):
            return None
        if not autotilt.is_360(item):
            return "photo non 360°"
        if not self._tilt_tried(pic):
            if self.mode == "tri":
                return "pas calculée en mesure libre"
            return "calculée au premier clic sur la photo" if self.active else "calculée à l'activation de la mesure"
        reason = self.tilt_reasons.get(pic, web_tilt.FEW_EDGES)
        if self.terrain_relay and pic in self.relay_failed:
            reason += " ; par le terrain : " + self.relay_failed[pic]
        return reason

    def _tilt_line(self):
        """(texte, alerte) de l'inclinaison dans la ligne d'état. Un seul vocabulaire (ticket #29) :
        « calée » (par les verticales de la photo, par le terrain, à la main) ou « non calée », avec
        l'incertitude ; « calcul » pour ce qui est en cours ou à venir."""
        pic = (self.item or {}).get("id")
        tilt = self.calibration.tilt(pic) if pic else None
        if tilt:
            sigma = "±{}°".format(measures._num(max(tilt["sigma"], 0.1), 1))
            source = tilt["source"]
            if source == "clics":
                how = "à la main ({} objet{}, {})".format(tilt["count"], "s" if tilt["count"] > 1 else "", sigma)
            elif source.startswith("clics + "):
                how = "à la main et par {} ({})".format(
                    "les verticales de la photo" if source.endswith("verticales") else "le terrain", sigma)
            elif source == "terrain web":
                how = "par le terrain, expérimental ({})".format(sigma)
            else:
                how = "par {} ({})".format("les verticales de la photo" if source == "verticales" else "le terrain", sigma)
            return "inclinaison calée " + how, False
        if pic and self.tilts.pending(pic):
            return "inclinaison : calcul en cours…", False
        if pic in self.relay_pending:
            return "inclinaison : calcul par le terrain en cours ({})…".format(self.relay_pending[pic]), False
        reason = self._tilt_reason()
        if not self._tilt_final():
            return "inclinaison " + reason, False
        return "inclinaison non calée (±{}°) : {}".format(
            measures._num(calibration.UNCALIBRATED, 0), reason), True

    # Inclinaison par le terrain hors agglomération, expérimentale (ticket #29) -------------------
    # Option de la page, décochée par défaut. Quand les verticales de la photo manquent : terrain
    # LiDAR HD sous la caméra (web_terrain), plus le décalage de la fixation, appris sur des photos
    # de la séquence calées par leurs verticales en zone d'habitation.
    RELAY_RADIUS = 15000.0  # m autour de la photo : zones d'habitation (BD TOPO) où chercher les références
    RELAY_ZONE = 300.0  # m autour du centre d'une zone : photos de la séquence candidates
    RELAY_TRIES = 12  # photos de référence analysées au plus par séquence (une photo HD chacune)
    RELAY_PER_ZONE = 3  # photos analysées au plus par zone : le centre du village n'est pas toujours la meilleure
    RELAY_NATURES = ("Lieu-dit habité", "Quartier")

    def set_terrain_relay(self, on):
        """Option « Inclinaison par le terrain hors agglomération » : cochée, calcul lancé pour la photo
        affichée si ses verticales ont déjà échoué ; mesures recalculées dans les deux sens."""
        self.terrain_relay = bool(on)
        if self.terrain_relay and self.item and self.item.get("id") in self.tilt_reasons:
            self._relay(self.item)
        self._calibration_changed()
        self.notify()
        return self.status()

    def _auto_tilt(self, pic):
        """Calibration.auto_tilt : celle du cœur (verticales, modèle LiDAR du cœur), sinon, l'option
        cochée, l'inclinaison par le terrain de la page."""
        tilt = self._core_auto_tilt(pic)
        if tilt is None and self.terrain_relay:
            tilt = self.relay_tilts.get(pic)
        return tilt

    def _relay(self, item):
        """Inclinaison par le terrain de la photo item (fiche STAC) : terrain sous elle, puis modèle de
        sa séquence ; rangée dans relay_tilts, ou la raison de l'échec dans relay_failed."""
        pic = item.get("id")
        if not pic or pic in self.relay_tilts or pic in self.relay_pending:
            return
        self.relay_failed.pop(pic, None)
        self.relay_pending[pic] = "terrain sous la photo"

        def failed(reason):
            self.relay_pending.pop(pic, None)
            self.relay_failed[pic] = reason
            self.notify()

        def got_own(entry, reason):
            if entry is None:
                return failed(reason)
            self.relay_pending[pic] = "photos de référence de la séquence"
            self.notify()
            self._sequence_model(item, lambda m, why: got_model(entry, m, why))

        def got_model(entry, m, reason):
            if m is None:
                return failed(reason)
            self.relay_pending.pop(pic, None)
            self.relay_tilts[pic] = web_terrain.predict(m, entry["slopes"], entry["heading"])
            self._calibration_changed({pic})
            self.notify()

        self._terrain_of(item, got_own)
        self.notify()

    @staticmethod
    def _heading_of(item):
        heading = metadata.precise_heading(item)
        return metadata.item_heading(item) if heading is None else heading

    def _terrain_of(self, item, done):
        """Terrain sous la photo item : done({slopes, heading}, None), ou done(None, raison). Grille
        LiDAR HD (web_terrain.grid_points), une requête."""
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
            heading = float(self._heading_of(item))
        except (KeyError, TypeError, ValueError):
            return done(None, "position ou cap de la photo inconnus")
        points = web_terrain.grid_points(lon, lat, heading)

        def got_ground(data, error):
            if error:
                return done(None, "service d'altitude injoignable")
            z = precision._ground(data)
            if not z or len(z) != len(points) or None in z:
                return done(None, "pas de LiDAR HD sous la photo")
            done({"slopes": web_terrain.slopes(z), "heading": heading}, None)

        host.fetch_json(precision.lidar_url(points, precision.LIDAR_RESOURCE), got_ground, timeout_ms=15000)

    def _sequence_model(self, item, done):
        """Modèle de la séquence de item (web_terrain.model) : done(modèle, None) ou done(None, raison).
        Cherché une fois par séquence, les demandes suivantes attendent le même calcul."""
        seq = item.get("collection")
        s = self.relay_models.get(seq)
        if s is None:
            s = self.relay_models[seq] = {"waiting": [done], "refs": [], "tried": 0, "zones": None}
            self._find_refs(item, s)
        elif "waiting" in s:
            s["waiting"].append(done)
        else:
            done(s["model"], s["reason"])

    def _find_refs(self, item, s):
        """Références de la séquence (s, voir _sequence_model) : jusqu'à RELAY_PER_ZONE photos par zone
        d'habitation (réparties dans la zone), des zones les plus proches aux plus lointaines, calées
        par leurs verticales, jusqu'à web_terrain.MIN_REFS réussies ou RELAY_TRIES analysées."""
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        seq = item.get("collection")

        def progress():
            text = "photos de référence : {} calée{} sur {} analysée{}".format(
                len(s["refs"]), "s" if len(s["refs"]) > 1 else "", s["tried"], "s" if s["tried"] > 1 else "")
            for p in self.relay_pending:
                self.relay_pending[p] = text
            self.notify()

        def finish(reason):
            s["model"] = web_terrain.model(s["refs"])
            s["reason"] = None if s["model"] else reason
            for cb in s.pop("waiting"):
                cb(s["model"], s["reason"])

        queue = []  # photos de la zone en cours, à analyser

        def next_zone():
            if len(s["refs"]) >= web_terrain.MIN_REFS:
                return finish(None)
            if queue and s["tried"] < self.RELAY_TRIES:
                return analyse(queue.pop(0))
            if s["tried"] >= self.RELAY_TRIES or not s["zones"]:
                return finish("{} photo{} de village calée{} sur {} (il en faut {})".format(
                    len(s["refs"]), "s" if len(s["refs"]) > 1 else "", "s" if len(s["refs"]) > 1 else "",
                    s["tried"], web_terrain.MIN_REFS))
            ring, (clon, clat) = s["zones"].pop(0)
            host.fetch_json(metadata.search_url(clon, clat, self.RELAY_ZONE, 100, seq, host.api_url),
                            lambda data, error: got_photos(ring, clon, clat, data, error), timeout_ms=15000)

        def got_photos(ring, clon, clat, data, error):
            feats = [f for f in ([] if error else (data or {}).get("features") or [])
                     if f.get("collection") == seq and f.get("id") != item.get("id")
                     and _inside(f["geometry"]["coordinates"][:2], ring)]
            feats.sort(key=lambda f: math.hypot(f["geometry"]["coordinates"][0] - clon,
                                                f["geometry"]["coordinates"][1] - clat))
            n = self.RELAY_PER_ZONE
            queue[:] = [feats[k * len(feats) // n] for k in range(n) if k * len(feats) // n < len(feats)]
            queue[:] = [f for k, f in enumerate(queue) if f not in queue[:k]]
            next_zone()

        def analyse(f):
            href = ((f.get("assets") or {}).get("hd") or {}).get("href")
            if not href:
                return next_zone()
            s["tried"] += 1
            progress()
            host.fetch(href, lambda data, error: got_image(f, data, error), prefer_cache=True)

        def got_image(f, data, error):
            if error or not data:
                return next_zone()
            heading = float(self._heading_of(f))
            web_host.run_task(web_tilt.estimate, (bytes(data), heading), lambda res: got_verticals(f, heading, res))

        def got_verticals(f, heading, res):
            if not res or "reason" in res:
                return next_zone()
            forward, right = calibration.tilt_components(res["up"], heading)

            def got_ground(entry, reason):
                if entry is not None:
                    s["refs"].append(dict(entry, forward=forward, right=right))
                    progress()
                next_zone()
            self._terrain_of(f, got_ground)

        def got_zones(data, error):
            if error:
                return finish("BD TOPO injoignable (zones d'habitation)")
            zones = []
            for z in (data or {}).get("features") or []:
                if (z.get("properties") or {}).get("nature") not in self.RELAY_NATURES:
                    continue
                g = z.get("geometry") or {}
                polys = g.get("coordinates") or []
                ring = max((p[0] for p in (polys if g.get("type") == "MultiPolygon" else [polys]) if p), key=len,
                           default=None)
                if ring:
                    c = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
                    zones.append((ring, c))
            zones.sort(key=lambda z: math.hypot((z[1][0] - lon) * math.cos(math.radians(lat)), z[1][1] - lat))
            s["zones"] = zones
            next_zone()

        dlat = self.RELAY_RADIUS / 111320.0
        dlon = dlat / max(math.cos(math.radians(lat)), 0.01)
        url = roads.WFS_URL + "?" + urlencode({
            "SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature", "TYPENAMES": "BDTOPO_V3:zone_d_habitation",
            "OUTPUTFORMAT": "application/json", "SRSNAME": "EPSG:4326", "COUNT": 500,
            "BBOX": "{},{},{},{},urn:ogc:def:crs:EPSG::4326".format(lat - dlat, lon - dlon, lat + dlat, lon + dlon)})
        host.fetch_json(url, got_zones, timeout_ms=20000)

    def fall_json(self):
        """Hauteur de chute (voir fall), en JSON : demandée par la page hors lecture de la séquence
        (sinon une lecture BD TOPO par maille de 100 m traversée)."""
        return json.dumps(self.fall())

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

    def _widths(self):
        found = super()._widths()
        return [m for m in found if m.clicks[1].get("pic") == self._here()] if self.here_only else found

    def _free_mark_point(self, k):
        """Point gardé de la mesure libre : seulement là où il a été visé (sans repère ailleurs). Objet
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

    def _width_near(self, click):
        return self._filtered(super()._width_near, click)

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
        if self.item and json.loads(self.axis_state())["drawn"]:
            marks.insert(0, self._line_mark())  # droite tracée sur la carte, avant le point A
        if self.active and self.item and self.mode == "height" and self._aiming():
            # Visées des autres photos tracées aussi en hauteur (le cœur : largeur, mesure libre) :
            # le pied visé est sur leur trait, même parmi des objets semblables (ticket #26)
            pic = self.item.get("id")
            lines = [self._epipolar_mark(s)["points"] for s in self.triangulator.sightings if s["pic"] != pic]
            marks = [{"points": [[p["yaw"], p["pitch"], False] for p in pts], "label": "", "guide": True,
                      "epipolar": True} for pts in lines if pts] + marks
        if self._tilt_pending():  # objet vertical en cours (croix et trait du calage), effacé une fois validé
            marks.append({"points": [c["pos"] + [k == self.tilt_sel] for k, c in enumerate(self.tilt_clicks)],
                          "label": "", "calage": True})
        return json.dumps(marks)

    def focus(self):
        return json.dumps(super().focus())

    def handles(self):
        return json.dumps(super().handles())

    def results(self):
        """Liste des résultats (ticket #30) : une entrée par point de référence, ses hauteurs et
        largeurs dessous (« sous »), nommées par leur point d'arrivée : « ↕ B 3,77 m ± 0,12 m ».
        Les autres points gardés et les distances n'y figurent pas (ils restent exportés)."""
        rows = super().results()
        measures_by_id = {id(m): m for m in self.tool.measures()}
        under = {}  # nom du point de référence -> lignes de ses mesures
        orphans = []  # mesure sans point de référence gardé : gardée visible, à la fin
        for r in rows:
            m = measures_by_id.get(r["id"]) if r["kind"] == "mesure" else None
            if m is None:
                continue
            end = self._end_name(m)
            if end:
                r = dict(r, text="{}{} {}".format(r["text"][:2], end["name"], r["text"][2:]))
            ref = (getattr(m, "edge", None) or getattr(m, "reference", None) or {}).get("name")  # largeur : bord A
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
        return json.dumps(out + orphans)

    # Fiche PDF d'un point de référence (src/app.js, makeFiche) ------------------------------------
    def _fiche_measures(self, name):
        """Hauteurs et largeurs faites depuis le point de référence nommé name."""
        return [m for m in self.tool.measures() if m.result
                and (getattr(m, "edge", None) or getattr(m, "reference", None) or {}).get("name") == name]

    def fiche(self, k):
        """JSON de la fiche du point gardé n° k et de ses mesures : nom, position, lignes du tableau
        (point, mesure, valeur, incertitude, commentaire), textes de méthode (ceux des mesures),
        photo de la plus grande mesure (celle de la fiche) et emprise de la mini-carte (points,
        mesures et caméra de cette photo)."""
        lon, lat, values = self.points[int(k)]
        name = values["nom"]
        found = self._fiche_measures(name)
        kept = {v["nom"]: v for _, _, v in self.points}

        def point_row(v, what):  # point gardé (A, ou le bord B triangulé) : sa ligne, comme A
            how = "posé sur la droite tracée sur la carte" if v.get("nb_visees") == 1 else "triangulé"
            return {"kind": "point", "point": v["nom"], "mesure": "{}, {}".format(what, how), "valeur": "",
                    "incert": "± {} m".format(measures._num(v["incert_m"], 2)), "commentaire": v.get("commentaire", "")}

        # Le point de référence, puis pour chaque mesure son point d'arrivée (comme A s'il est
        # triangulé, sinon cliqué sur la photo) et, dessous, la mesure elle-même
        rows = [point_row(values, "Point de référence")]
        texts, lonlats = [], [(lon, lat)]
        for m in found:
            r, end = m.result, self._end_name(m)
            height = m.kind == "height"
            end_name = end["name"] if end else "?"
            if end_name in kept and not height:
                rows.append(point_row(kept[end_name], "Bord opposé"))
            else:
                rows.append({"kind": "point", "point": end_name, "valeur": "", "incert": "", "commentaire": "",
                             "mesure": "Sommet, cliqué sur la photo" if height else "Bord opposé, cliqué sur la photo"})
            rows.append({"kind": "mesure", "point": "{} {} {}".format(name, "↕" if height else "↔", end_name),
                         "mesure": "{} entre {} et {}".format("Hauteur" if height else "Largeur", name, end_name),
                         "valeur": "{} m".format(measures._num(r["value"], 2)),
                         "incert": "± {} m".format(measures._num(r["uncertainty"], 2)),
                         "commentaire": getattr(m, "comment", "")})
            texts.append(self._fiche_note(m, rows[-1]["point"]))
            lonlats += [tuple(p) for p in r["points"]]
        largest = max(found, key=lambda m: m.result["value"], default=None)
        if largest is not None:
            pic = largest.clicks[0 if largest.kind == "height" else 1].get("pic")  # photo d'où elle a été prise
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
        """(label, morceaux) de la ligne courte de « Méthode et précision » pour la mesure m (fiche) : ce
        qui n'est pas dans le tableau. Hauteur : distance de l'objet, hauteur de caméra ; largeur : axe,
        angle de visée."""
        if m.kind == "height":
            height, source = self.tool.camera_info(m.clicks[0], measures._ground_z(m.clicks)[m.clicks[0].get("pic")])
            parts = ["objet à {} m de la photo".format(measures._num(m.result["ranges"][0], 1)),
                     "caméra à {} m{}".format(measures._num(height, 2), " ({})".format(source) if source else "")]
        else:
            axis = (m.road or {}).get("source", "")
            if axis.startswith(MAP_SOURCE):
                parts = ["droite tracée sur la carte ({})".format(axis.split(", ", 1)[-1])]
            else:
                parts = ["axe de la route : {}".format(axis)]
            if m.angle is not None:
                parts.append("visée à {}° de la droite{}".format(
                    measures._num(m.angle, 0), " (rasante)" if m.angle < widths.GRAZING_ANGLE else ""))
        return label, parts

    def fiche_frame(self, k):
        """JSON [[cap, élévation]] (radians, repère de la photo affichée) des bouts de la plus grande
        mesure du point gardé n° k, pour cadrer la photo de la fiche ; [] s'il n'y en a pas ici."""
        name = self.points[int(k)][2]["nom"]
        found = self._fiche_measures(name)
        largest = max(found, key=lambda m: m.result["value"], default=None)
        if largest is None or not self.item:
            return "[]"
        pts = (self._height_points if largest.kind == "height" else self._width_points)(largest)
        return json.dumps([[p["yaw"], p["pitch"]] for p in pts if p["yaw"] is not None])

    # Relevé d'objets (mode "releve") ------------------------------------------------------------
    def keep_point(self):
        """Relevé : point triangulé gardé comme objet, sans distance au précédent ; la page demande
        ensuite ses champs (set_releve)."""
        if not self.releve:
            return super().keep_point()
        n, r, sightings = len(self.points), self.triangulator.result, list(self.triangulator.sightings)
        self.last_free = None
        super().keep_point()
        self.last_free = None
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
        h = self._camera_height()
        q = self.quality or {}
        cam = self.calibration.camera(self.item.get("collection"))
        sigma_h = (measures.CAMERA_ERRORS["altitude GPS"] if q.get("precise") and q.get("lidar") is True
                   else cam["sigma"] if cam else measures.CAMERA_ERRORS[None])
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
        if kept:
            self.points, self.point_views, self.named = kept, views, named
        return self.status()

    def has_results(self):
        """Mesures, points triangulés ou distances à exporter (les objets relevés à part : has_releve)."""
        return bool(self.links) or any("releve" not in v for _, _, v in self.points) or any(
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

    def status(self):
        text = super().status()
        if self.releve:
            text = text.replace("Mesure libre (distance au point gardé précédent)", "Relevé d'objets")
        return _map_line_text(text) if MAP_SOURCE in text else text

    # Couche importée (GeoJSON, src/couche.js) : objets dans la photo, à leur altitude (z du fichier,
    # NGF) ou posés sur le sol LiDAR HD, lu sous la caméra et sous leurs sommets (lignes redécoupées
    # tous les OVERLAY_STEP m pour suivre le terrain) ; à plat à la hauteur de caméra en attendant ou
    # sans LiDAR ----------------------------------------------------------------------------------
    OVERLAY_REACH = 100.0  # m : objets dessinés dans la photo s'ils ont un sommet à cette distance
    OVERLAY_STEP = 5.0  # m : pas des lignes, pour suivre le terrain entre leurs sommets
    OVERLAY_CHUNK = 150  # points par requête d'altitude (longueur de l'adresse)
    OVERLAY_MAX = 900  # points d'altitude au plus par photo

    def set_overlay(self, text):
        """Couche importée, JSON [{id, geometry}] en WGS 84, z éventuel en NGF (vide : retirée) : points,
        et lignes (contours des polygones compris), multi-géométries éclatées en parties."""
        self.overlay, self.overlay_ground = [], {}
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
        height, base = self._camera_height(), ground.get((lon, lat))
        out = []
        for i, kind, pts in near:
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
        """Altitudes LiDAR HD sous la caméra et sous les sommets proches sans z (OVERLAY_MAX au plus, à
        une fois et demie OVERLAY_REACH) : {(lon, lat): z}, lues une fois par photo ({} en attendant)."""
        pic = self.item.get("id")
        if pic in self.overlay_ground:
            return self.overlay_ground[pic]
        self.overlay_ground[pic] = {}
        k, reach = math.cos(math.radians(lat)), 1.5 * self.OVERLAY_REACH / 111320.0
        points = [(lon, lat)] + list(dict.fromkeys(
            (p[0], p[1]) for _, _, pts in near for p in pts
            if p[2] is None and abs(p[1] - lat) < reach and abs(p[0] - lon) * k < reach))[:self.OVERLAY_MAX]
        found, overlay = {}, self.overlay
        chunks = [points[n:n + self.OVERLAY_CHUNK] for n in range(0, len(points), self.OVERLAY_CHUNK)]
        left = [len(chunks)]

        def got(chunk):
            def done(data, error):
                z = None if error else precision._ground(data)
                if z and len(z) == len(chunk):
                    found.update((p, h) for p, h in zip(chunk, z) if h is not None)
                left[0] -= 1
                if not left[0] and self.overlay is overlay:  # toutes lues : couche redessinée
                    self.overlay_ground[pic] = found
                    self.notify()
            return done

        for chunk in chunks:
            host.fetch_json(precision.lidar_url(chunk, precision.LIDAR_RESOURCE), got(chunk), timeout_ms=15000)
        return self.overlay_ground[pic]

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

    def click(self, yaw, pitch):
        axis = self._height_axis() if self.mode == "height" else None
        if axis:
            click = tools.photo_click(self.item, (math.degrees(yaw) + self._heading()) % 360, math.degrees(pitch),
                                      self.calibration, self.quality, [yaw, pitch], self._axis(self.item))
            if click is not None and self._height_near(click) is None:  # pas sur une croix (sélection)
                yaw, pitch = _on_axis(axis, yaw, pitch)
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
    REDO_ATTRS = ("points", "links", "named", "last_free", "point_views", "ref_point", "measure_done", "width_sel",
                  "ref_sel", "b_aiming", "proposal", "tilt_clicks", "tilt_sel", "map_line")

    def _snapshot(self):
        snap = {k: getattr(self, k, None) for k in self.REDO_ATTRS}
        for k in ("points", "links", "tilt_clicks"):
            snap[k] = list(snap[k])
        snap["point_views"] = dict(snap["point_views"])
        tool = self.tool
        snap["tool"] = (list(tool.done), tool.current, tool.selected, list(self.triangulator.sightings))
        return snap

    def _redo_state(self):
        """Empreinte de ce que les gestes changent : un geste fait depuis le dernier « Effacer »
        rend Ctrl+Y sans objet."""
        tool, current = self.tool, self.tool.current
        return (len(self.points), len(self.links), len(tool.done), id(current), len(current.clicks) if current else 0,
                len(self.triangulator.sightings), id(self.ref_point), len(self.tilt_clicks), self.mode,
                id(self.b_aiming), self.measure_done)

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
        if self.mode == "tilt":  # objet vertical en cours, ou inclinaison calée à la main de la photo
            pic = (self.item or {}).get("id")
            return bool(self._tilt_pending() or self.calibrator.clicks or (pic and pic in self.calibration.verticals))
        tool = self.tool
        if self.b_aiming is not None or self.triangulator.sightings or self.width_sel is not None or self.ref_sel \
                or tool.selected is not None or (tool.current is not None and tool.current.clicks):
            return True
        return bool(self.points) if self.mode == "tri" else self.ref_point is not None

    def _can_clear(self):
        """« Tout effacer » aurait-il un effet ?"""
        return bool(self.points or self.links or self.tool.measures() or self.triangulator.sightings
                    or self.ref_point is not None or self.tilt_clicks or self.calibrator.clicks)

    def _undo(self):
        """« Effacer » et Ctrl+Z : annule le dernier geste. Visées : la dernière seule (le bord B garde sa première,
        le clic de la mesure) ; objet vertical du calage : son dernier clic ; sinon comme Session.clear
        (sélection, mesure en cours, puis dernier point posé)."""
        if self._tilt_pending() and self.tilt_clicks:
            self.tilt_clicks.pop()
            self.tilt_sel = None
            self.message = "Dernier clic de l'objet vertical annulé."
            return self.status()
        sightings = self.triangulator.sightings
        if self.active and self._active() is self.triangulator and len(sightings) > (1 if self.b_aiming else 0):
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


    # Droite de mesure tracée sur la mini-carte (ticket #28) ---------------------------------------
    # Giratoire, carrefour, place : avant la première visée de A, la droite de mesure est tracée sur
    # la carte (deux clics, en travers de la voie) au lieu d'être perpendiculaire à l'axe calculé. A
    # se pose alors d'un clic, là où sa direction coupe la droite (comme le bord B), sans visées.

    def axis_state(self):
        """Droite tracée, pour la page (JSON) : tracé possible (largeur, avant la première visée de A),
        droite tracée en attente du point A (annulable), et ses deux points [[lon, lat], [lon, lat]]."""
        waiting = bool(self.active and self.mode == "road" and self.ref_point is None and self.b_aiming is None)
        line = self.map_line if waiting else None
        return json.dumps({"can": waiting and not self.triangulator.sightings and line is None,
                           "drawn": line is not None, "line": line and line["ends"]})

    def set_measure_line(self, lon1, lat1, lon2, lat2):
        """Droite de mesure tracée par deux clics sur la mini-carte : A et B seront posés dessus."""
        if not json.loads(self.axis_state())["can"]:
            self.message = "La droite se trace en largeur, avant la première visée du premier bord."
            return self.status()
        x, y = triangulation._local(lon2, lat2, lon1, lat1)
        span = math.hypot(x, y)
        if span < MAP_LINE_MIN:
            self.message = ("Droite non tracée : {} m entre les deux clics ; tracez-la sur {} m au moins, en travers "
                            "de la voie.").format(measures._num(span, 1), measures._num(MAP_LINE_MIN, 0))
            return self.status()
        error = math.degrees(math.atan2(MAP_CLICK * math.sqrt(2), span))
        self.map_line = {"ends": [[lon1, lat1], [lon2, lat2]], "bearing": math.degrees(math.atan2(x, y)) % 360,
                         "error": error}
        self.message = ("Droite de mesure tracée (±{}°) : cliquez le premier bord sur la droite bleue de la photo ; "
                        "seule la direction du clic compte. « Annuler la droite » pour revenir à l'axe "
                        "automatique.").format(measures._num(error, 1))
        return self.status()

    def cancel_measure_line(self):
        self.map_line = None
        self.message = "Droite tracée annulée : droite de mesure perpendiculaire à l'axe automatique."
        return self.status()

    def set_mode(self, mode):
        self.tilt_clicks, self.tilt_sel = [], None
        self.map_line = None
        self.releve = mode == "releve"
        return super().set_mode("tri" if self.releve else mode)

    def aim(self, yaw, pitch):
        if self.mode == "road" and self.map_line is not None and self.ref_point is None and self.b_aiming is None:
            return self._point_on_line(yaw, pitch)
        return super().aim(yaw, pitch)

    def _line_mark(self):
        """Droite tracée dans la photo affichée (comme Session._guide_mark : sol plat à la hauteur de
        caméra), prolongée de 5 m de chaque côté."""
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        (lon1, lat1), (lon2, lat2) = self.map_line["ends"]
        (x1, y1), (x2, y2) = triangulation._local(lon1, lat1, lon, lat), triangulation._local(lon2, lat2, lon, lat)
        span = math.hypot(x2 - x1, y2 - y1)
        ux, uy = (x2 - x1) / span, (y2 - y1) / span
        height, points = self._camera_height(), []
        for k in range(41):
            t = -5.0 + k * (span + 10.0) / 40
            x, y = x1 + t * ux, y1 + t * uy
            d = math.hypot(x, y)
            if d >= 1.0:
                view = self._view_of(math.degrees(math.atan2(x, y)), -math.degrees(math.atan2(height, d)))
                points.append([view["yaw"], view["pitch"], False])
        return {"points": points, "label": "", "guide": True}

    def _point_on_line(self, yaw, pitch):
        """Point A posé là où la direction du clic coupe la droite tracée (sur la carte, à plat) : point
        de référence de la largeur, comme Session.keep_point, la droite tracée pour droite de mesure."""
        if not self.item:
            self.message = "Aucune photo affichée."
            return self.status()
        s = tools.photo_sighting(self.item, (math.degrees(yaw) + self._heading()) % 360, math.degrees(pitch),
                                 self.calibration, self.quality)
        if s is None:
            self.message = "Position de la photo inconnue : impossible de poser le point."
            return self.status()
        line = self.map_line
        lon0, lat0 = line["ends"][0]
        cx, cy = triangulation._local(s["lon"], s["lat"], lon0, lat0)
        h, b = math.radians(s["heading"]), math.radians(line["bearing"])
        dx, dy, ux, uy = math.sin(h), math.cos(h), math.sin(b), math.cos(b)
        det = ux * dy - dx * uy  # sinus de l'angle entre la visée et la droite
        if abs(det) < math.sin(math.radians(MAP_MIN_ANGLE)):
            self.message = ("Visée presque parallèle à la droite tracée : cliquez depuis une photo prise quelques "
                            "mètres avant ou après, qui la voit plus en travers.")
            return self.status()
        t = (cx * uy - cy * ux) / det  # distance de la caméra au point, le long de la visée
        if t <= 0:
            self.message = "La direction du clic ne coupe pas la droite tracée devant la caméra."
            return self.status()
        u = (cx + t * dx) * ux + (cy + t * dy) * uy  # abscisse du point sur la droite
        plon, plat = triangulation._geographic(u * ux, u * uy, lon0, lat0)
        # Le long de la droite : position de la caméra et cap, vus sous l'angle de la visée
        sigma = math.hypot(s["accuracy"], t * math.radians(MAP_HEADING_ERROR)) / abs(det)
        name = session._point_name(self.named)
        self.named += 1
        values = {"nom": name, "nb_visees": 1, "angle": round(math.degrees(math.asin(min(1.0, abs(det)))), 1),
                  "incert_m": round(sigma, 2), "ecart_m": 0.0, "dist_max_m": round(t, 1),
                  "gps_m": round(s["accuracy"], 1), "photos": s["pic"],
                  "date_mesure": datetime.now().isoformat(timespec="seconds"), "commentaire": ""}
        self.points.append((plon, plat, values))
        s["view"] = [yaw, pitch]
        self.point_views[name] = {s["pic"]: [yaw, pitch]}
        self.triangulator.clear()
        self.ref_photo = s["pic"]
        self.ref_point = {"lon": plon, "lat": plat, "uncertainty": sigma, "name": name,
                          "sequences": [s.get("sequence")], "sightings": [s], "ground_z": None,
                          "road": {"axis": (line["bearing"] + 90) % 360,
                                   "source": "{}, ±{}°".format(MAP_SOURCE, measures._num(line["error"], 1))}}
        self.map_line = None
        self._ref_ground()
        self.message = ("Point {} posé sur la droite tracée (±{} m). Cliquez maintenant le bord opposé, au sol, sur "
                        "la droite bleue : seule la direction du clic compte.").format(name, measures._num(sigma))
        self.message += self._rtk_warning([s.get("sequence")])
        return self.status()

    def _road_at_reference(self):
        """Axe de la route au point de référence (voir Session) ; sur une séquence RTK vérifiée, la
        direction de la trajectoire à la place de celle du tronçon de la BD TOPO (±2°), quand elle est
        droite et concorde avec lui.
        shortcut: vérification RTK pas encore arrivée au point de référence : BD TOPO gardée ; reprendre
        l'axe à son arrivée si des largeurs prises juste après l'ouverture d'une photo restent en BD TOPO."""
        super()._road_at_reference()
        ref = self.ref_point
        road = ref.get("road")
        if not road or not road["source"].startswith("BD TOPO") or not (self.quality or {}).get("precise"):
            return
        seq = (self.item or {}).get("collection")
        key = (seq, roads._cell(ref["lon"], ref["lat"]))  # cache des trajectoires du cœur
        track = self.roads._get(("track",) + key, self.roads._tracks, key, lambda: metadata.search_url(
            ref["lon"], ref["lat"], roads.TRACK_RADIUS + 10, 20, seq, host.api_url), lambda data: data)
        if track is roads.PENDING:
            ref["road"] = None  # repris par _roads_ready
            return
        axis = _straight_track_axis(track, seq, ref["lon"], ref["lat"])
        if axis is None or roads._axis_diff(axis, road["axis"]) > TRACK_AGREE:
            return
        if math.cos(math.radians(axis - road["axis"])) < 0:
            axis += 180  # sens du tronçon gardé
        ref["road"] = {"axis": axis % 360, "source": RTK_SOURCE + ", contrôlée par la " + road["source"]}

    # Hauteur de chute sur un pont (ticket #15) ---------------------------------------------
    # m au-delà du bord de la chaussée, de chaque côté : du pied du garde-corps jusqu'au fond, à
    # l'écart du tablier (le MNT, interpolé sous lui, y descend en pente douce : ticket #27)
    FALL_SIDES = (1.0, 3.0, 6.0, 10.0)
    FALL_STEP = 2.0  # m entre deux travers le long du pont (plus si le pont est long)
    FALL_POINTS = 160  # points au plus : une seule requête au service d'altimétrie
    FALL_MIN = 0.5  # m : en dessous, terrain non distingué du tablier (végétation, buse)
    FALL_WIDTH = 6.0  # m : largeur de chaussée supposée quand la BD TOPO ne la donne pas
    FALL_TOUCH = 1.0  # m : tronçons en pont bout à bout (un pont coupé en plusieurs tronçons)
    FALL_RETRY = 60.0  # s avant de refaire un calcul qui a échoué (service injoignable)
    FALL_NO_RTK = ("Hauteur de chute non calculée : la position GPS de cette séquence n'est pas vérifiée RTK. "
                   "L'altitude du tablier, tirée de l'altitude GPS de la caméra, serait fausse de plusieurs mètres.")

    def fall(self):
        """Photo prise sur un pont (BD TOPO) : hauteur de chute la plus grande sur toute la longueur du
        pont ({text, title}), son explication sans RTK vérifié, ou l'attente de son calcul ; hors d'un
        pont, chute et dévers des bords de la route (_edges, ticket #31). Tablier : altitude GPS RTK (NGF) moins hauteur de caméra, aux photos de la séquence
        prises sur le pont (la plus proche de chaque point) ; dessous : MNT LiDAR HD (RGE ALTI en
        secours), le point le plus bas en travers du pont, de 1 à 10 m au-delà du bord de la chaussée
        des deux côtés (FALL_SIDES : sous le tablier, le MNT est interpolé à sa hauteur)."""
        item = self.item or {}
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        except (KeyError, TypeError, ValueError):
            return None
        sections = self._fall_sections(lon, lat)
        if sections is None and item.get("id") in self.edges_asked:
            return {"text": "Bords de route\nCalcul impossible (BD TOPO injoignable)", "title": "", "edges": True}
        if not sections or sections is roads.PENDING:
            return None
        axis = self._axis(item)
        sec = roads.on_bridge(sections, lon, lat, metadata.item_heading(item) if axis is None else axis)
        if sec is None:
            return self._edges(item, sections, lon, lat)
        chain = self._bridge_chain(sections, sec)
        # Nom du pont (BD TOPO), et sa route : « Pont de France (D905) », sinon « Pont de la D111 »,
        # « Pont de l'A38 » (élision devant une voyelle)
        name = next((c["bridge_name"] for c in chain if c.get("bridge_name")), None) or self._named_bridge(lon, lat)
        road = next((c["name"] for c in chain if re.match(r"[A-Z]+\d", c.get("name") or "")), None)
        of_road = road and ("Pont de l'" if road[0] in "AEIOUY" else "Pont de la ") + road
        bridge = "{} ({})".format(name, road) if name and road else name or of_road or "Pont"
        over = self._crossed(chain, sections, lon, lat)  # « Au-dessus de l'Armançon », sous le nom
        bridge += "\n" + over if over else ""
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
        TOPO n'a pas répondu (shortcut: pas de nouvel essai avant le rechargement de la page ;
        réessayer après roads.RETRY s si des pannes de la Géoplateforme privent de hauteur de chute)."""
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

    BRIDGE_REACH = 25.0  # m au plus entre la photo et le pont nommé (bord du tablier)
    CROSS_END = 2.0  # m : contact aussi près d'un bout du pont, raccordement et non franchissement

    def _named_bridge(self, lon, lat):
        """Nom du pont le plus proche de la photo (BRIDGE_REACH m au plus) quand le tronçon ne le nomme pas
        (il porte le nom de la rue) : ouvrage « Pont » de la BD TOPO (constructions linéaires), une requête
        par maille comme les tronçons ; None sinon, pendant la lecture ou si la BD TOPO n'a pas répondu."""
        found = self._bdtopo("construction_lineaire", roads._cell(lon, lat))
        return _nearest_name(_ign_bridges({"features": found or []}), lon, lat, self.BRIDGE_REACH)

    def _bdtopo(self, layer, cell):
        """Objets GeoJSON d'une couche de la BD TOPO dans la maille (et MARGIN m autour), lus comme les
        tronçons : liste, None pendant la lecture, [] si la BD TOPO n'a pas répondu (pas de nouvel essai)."""
        key = (layer, cell)
        if key not in self.bdtopo:
            self.bdtopo[key] = None

            def done(data, error):
                self.bdtopo[key] = [] if error else (data or {}).get("features") or []
                if self.bdtopo[key]:
                    self.notify()

            host.fetch_json(roads.wfs_url(cell).replace("troncon_de_route", layer), done, timeout_ms=15000)
        return self.bdtopo[key]

    def _crossed(self, chain, sections, lon, lat):
        """Ce que le pont (chain) franchit, d'après la BD TOPO : cours d'eau, sinon voies ferrées et routes
        plus basses, dont la ligne croise la sienne ; « Au-dessus de l'Armançon », « Au-dessus de la voie
        ferrée et de la D905 », ou None (rien trouvé, ou lecture en cours)."""
        cell, level = roads._cell(lon, lat), max(c["level"] for c in chain)
        deck = [[triangulation._local(p[0], p[1], lon, lat) for p in c["line"]] for c in chain]
        ends = [p for seg in deck for p in (seg[0], seg[-1])]
        ends = [p for p in ends if sum(math.hypot(p[0] - q[0], p[1] - q[1]) < self.FALL_TOUCH for q in ends) == 1]

        def crosses(line):  # contact avec le pont ailleurs qu'à ses bouts (routes qui s'y raccordent)
            pts = [triangulation._local(p[0], p[1], lon, lat) for p in line]
            for seg in deck:
                for a, b in zip(seg, seg[1:]):
                    for c, d in zip(pts, pts[1:]):
                        x = _crossing(a, b, c, d)
                        if x and all(math.hypot(x[0] - e[0], x[1] - e[1]) > self.CROSS_END for e in ends):
                            return True
            return False

        def lines(feat):
            geom = feat.get("geometry") or {}
            coords = geom.get("coordinates") or []
            return coords if geom.get("type") == "MultiLineString" else [coords]

        def below(feat):
            try:
                return int((feat.get("properties") or {}).get("position_par_rapport_au_sol") or 0) < level
            except (TypeError, ValueError):
                return True

        labels = []
        for feat in self._bdtopo("troncon_hydrographique", cell) or []:
            if below(feat) and any(crosses(line) for line in lines(feat)):
                name = (feat.get("properties") or {}).get("cpx_toponyme_de_cours_d_eau")
                labels.append(_water_label(name) if name else "un cours d'eau")
        if not labels:  # cours d'eau franchi : lui seul (routes et voies ferrées des berges en plus)
            for feat in self._bdtopo("troncon_de_voie_ferree", cell) or []:
                if below(feat) and any(crosses(line) for line in lines(feat)):
                    labels.append("la voie ferrée")
            labels += [_road_label(sec["name"]) for sec in sections
                       if sec["level"] < level and sec not in chain and crosses(sec["line"])]
        labels = list(dict.fromkeys(labels))
        return "Au-dessus " + " et ".join(_of(x) for x in labels) if labels else None

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
        step = max(self.FALL_STEP, 2 * len(self.FALL_SIDES) * total / self.FALL_POINTS)
        samples = []  # (x, y) en travers du pont, des deux côtés, en m depuis la photo
        for c, line in zip(chain, lines):
            length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(line, line[1:]))
            edge = (c["width"] or self.FALL_WIDTH) / 2
            n = max(1, round(length / step))
            for k in range(n + 1):
                s = k * length / n
                (x, y), a, b = roads._at(line, s), roads._at(line, s - 1.0), roads._at(line, s + 1.0)
                t = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
                nx, ny = -(b[1] - a[1]) / t, (b[0] - a[0]) / t
                samples += [(x + side * (edge + d) * nx, y + side * (edge + d) * ny)
                            for side in (-1, 1) for d in self.FALL_SIDES]
        reach = max(math.hypot(x, y) for x, y in samples) + 10.0

        def failed(reason="service injoignable", retry=True):
            self.falls[key] = {"text": "Hauteur de chute : calcul impossible ({})".format(reason), "title": "",
                               "retry_at": time.monotonic() + self.FALL_RETRY if retry else float("inf")}
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
                return failed("pas d'altitude GPS de la séquence sur le pont")  # grille du géoïde pas encore lue ?
            precision.fetch_terrain([triangulation._geographic(x, y, lon, lat) for x, y in samples],
                                    lambda ground, source, error: got_ground(decks, ground, source, error))

        def got_ground(decks, ground, source, error):
            if error:
                return failed()
            best = None
            for (x, y), z in zip(samples, ground or []):
                if z is None:
                    continue
                # shortcut: tablier à l'altitude de la photo la plus proche (photos tous les ~5 m) ;
                # interpoler entre les photos si des ponts longs et pentus le demandent
                deck = min(decks, key=lambda d: math.hypot(d[0] - x, d[1] - y))[2]
                if best is None or deck - z > best[0]:
                    best = (deck - z, math.hypot(x, y))
            if best is None:
                return failed("pas de modèle de terrain sous le pont", retry=False)
            if best[0] < self.FALL_MIN:
                self.falls[key] = {"text": "Hauteur de chute non mesurée : le terrain sous le pont ne se distingue "
                                           "pas du tablier (végétation, buse ?)", "title": ""}
                return self.notify()
            terrain = triangulation.RGE_ALTI_ERROR if source == "RGE ALTI" else triangulation.LIDAR_ERROR
            sigma = math.hypot(precision.VERIFIED_ACCURACY, triangulation.GROUND_ERROR, terrain)
            self.falls[key] = {
                "text": "Hauteur de chute max : {} m (±{} m)".format(measures._num(best[0], 1), measures._num(sigma, 1)),
                "title": ("Plus grande hauteur entre le tablier (altitude GPS RTK moins hauteur de caméra) et le "
                          "terrain sous le pont ({}), le long des deux bords jusqu'à {} m de la chaussée, à {} m de la photo. Au-dessus de "
                          "l'eau : niveau au relevé, pas le fond.").format(
                    source, measures._num(self.FALL_SIDES[-1], 0), measures._num(best[1], 0))}
            self.notify()

        host.fetch_json(metadata.search_url(lon, lat, reach, 100, item.get("collection"), host.api_url), got_photos)

    # Hauteur de chute et dévers des bords de route, hors pont (ticket #31) -----------------------
    # Calcul lancé seulement par le bouton « Dévers » de la page (request_edges), pour la photo
    # affichée. Travers de part et d'autre de la route, à EDGE_ALONG m de la photo le long du tronçon,
    # depuis la caméra (séquence vérifiée RTK ; sinon l'axe BD TOPO) jusqu'à edge_zone m au-delà du bord
    # de la chaussée (réglette de la page) ; terrain MNT LiDAR HD (RGE ALTI en secours). Bord : rupture de
    # pente du terrain (EDGE_BREAK), sinon la demi-largeur BD TOPO. Référence : le terrain au bord, pas
    # l'altitude GPS.
    EDGE_ZONE = 10.0  # m au-delà du bord de la chaussée examinés par défaut
    EDGE_ALONG = (-10.0, -5.0, 0.0, 5.0, 10.0)  # m le long de la route, depuis la photo
    EDGE_WINDOW = 2.0  # m en travers : pente lue entre deux points au moins aussi écartés (bruit du MNT ±5 cm)
    EDGE_TALUS = 0.10  # pente vers le bas (sur EDGE_WINDOW m) d'une descente : en dessous, plat
    EDGE_CORE = 1 / 3  # talus : partie de la descente dont la pente vaut au moins ce rapport de sa pente la plus forte
    EDGE_STEP = 0.5  # m entre deux points du profil, de l'origine jusqu'à EDGE_SEARCH m après le bord BD TOPO
    EDGE_SEARCH = 3.0  # m au-delà du bord BD TOPO où la rupture de pente est encore cherchée
    EDGE_BREAK = 0.08  # écart de pente sur 1 m à celle de la chaussée sous l'origine : bord (bombement : ~0,05)
    EDGE_HOLD = 3  # pas consécutifs où l'écart doit tenir : un seul pas de 1 m tient du bruit du MNT (±5 cm)
    EDGE_NEAR = 1.5  # m : pas de bord plus près de l'origine (le véhicule occupe sa voie ; demi-voie sur l'axe)
    EDGE_FAR = 16  # points au-delà, jusqu'à edge_zone m
    EDGE_RISE = 1.0  # m : terrain remonté d'autant au-dessus du bord (talus, butte) : lecture arrêtée, derrière n'est pas une chute
    # Chaussées séparées (autoroute, voie express : un tronçon BD TOPO par sens, ticket #34) : tronçon de même nom, au sol,
    # parallèle (TWIN_ANGLE° près), son axe à TWIN_MIN à TWIN_REACH m de celui de la photo en travers ; de son côté, la
    # plateforme va jusqu'au bord extérieur de l'autre chaussée (séparateur de chaussée, ou terre-plein central, compris)
    TWIN_MIN, TWIN_REACH, TWIN_ANGLE = 4.0, 40.0, 30.0
    TWIN_LENGTHWISE = 2.0  # m : axe de l'autre chaussée en travers du point, pas au bout d'un tronçon décalé le long
    TWIN_SEARCH = 6.0  # m de plus où le bord extérieur de l'autre chaussée est cherché (largeurs BD TOPO souvent trop
    # faibles sur ces routes : 5 m pour deux voies)
    # Marche du terrain (bordure, séparateur surélevé ou en creux) : au moins STEP_Z m sur un pas de EDGE_STEP m, et encore
    # STEP_HOLD m sur trois pas (pas un seul point du MNT qui saute, ±5 cm)
    STEP_Z, STEP_HOLD = 0.05, 0.04
    SEPARATOR_WIDTH = (0.5, 10.0)  # m : largeurs possibles d'un séparateur de chaussée trouvé dans le relief
    SEPARATOR_NEAR = 4.0  # m au plus entre son milieu et celui que donne la BD TOPO
    # Profil en long : terrain sur ±LONG_REACH m le long du tronçon, tous les LONG_STEP m ; pente moyenne (moindres carrés)
    # et la plus forte sur LONG_WINDOW m
    LONG_REACH, LONG_STEP, LONG_WINDOW = 50, 2, 10
    LONG_JUNCTION = 30.0  # m : repères de carrefour avec la même voie plus proches : un seul carrefour (îlot séparateur)
    EDGE_CONSENSUS = 3.0  # m : bord (ou séparateur) d'un travers plus loin de la médiane des autres : ramené à elle
    # Séparateur étroit sans marches (glissières dos à dos, muret : le MNT n'en garde que l'assise) : pic de 1 ou 2 points au
    # moins PEAK_Z m au-dessus des points voisins, au même endroit (PEAK_SPREAD m près) sur PEAK_TRAVERS travers au moins
    PEAK_Z, PEAK_SPREAD, PEAK_TRAVERS, PEAK_HALF = 0.04, 1.0, 2, 0.4

    def set_edge_zone(self, metres):
        """Réglette du bouton « Dévers » : largeur (m) lue au-delà du bord de la chaussée au prochain appui
        (le résultat déjà affiché reste celui de sa largeur)."""
        self.edge_zone = float(metres)
        self.notify()

    def request_edges(self):
        """Bouton « Dévers » : calcul pour la photo affichée et la largeur de la réglette (voir _edges)."""
        if self.item:
            self.edges_asked[self.item.get("id")] = self.edge_zone
            self.notify()

    def edges_ready(self):
        """Le bouton « Dévers » aurait un effet : photo affichée, pas déjà calculée à cette largeur."""
        return bool(self.item) and self.edges_asked.get(self.item.get("id")) != self.edge_zone

    def _edges(self, item, sections, lon, lat):
        """Photo hors pont où le bouton « Dévers » a été pressé : chute et dévers des deux bords de la route
        la plus proche (roads.MAX_DISTANCE m au plus), {text, title, edges}, l'attente du calcul ou sa raison
        d'échouer ; None sans appui sur le bouton pour cette photo."""
        zone = self.edges_asked.get(item.get("id"))
        if zone is None:
            return None

        def told(text):
            return {"text": "Bords de route\n" + text, "title": "", "edges": True}

        # Tronçons des mailles voisines aussi (±LONG_REACH m et plus) : la route prolongée (_chained) sort de la maille de la
        # photo ; doublons (un tronçon lu dans deux mailles) fusionnés
        reach = self.LONG_REACH + 10.0
        dlat, dlon = reach / 111320.0, reach / (111320.0 * math.cos(math.radians(lat)))
        merged, seen = [], set()
        for cell in {roads._cell(lon + i * dlon, lat + j * dlat) for i in (-1, 0, 1) for j in (-1, 0, 1)}:
            more = sections if cell == roads._cell(lon, lat) else self._fall_sections(cell[0] * roads.CELL + 1e-9, cell[1] * roads.CELL + 1e-9)
            if more is roads.PENDING:
                return told("Calcul en cours…")
            for sec in more or []:
                tag = (sec.get("name"), sec.get("level"), tuple(sec["line"][0]), tuple(sec["line"][-1]))
                if tag not in seen:
                    seen.add(tag)
                    merged.append(sec)
        sections = merged

        near = None
        for sec in sections:
            if sec.get("level", 0) != 0:
                continue  # pont ou tunnel
            line = [triangulation._local(p[0], p[1], lon, lat) for p in sec["line"]]
            d, s = roads._project(line, 0.0, 0.0)
            if d <= roads.MAX_DISTANCE and (near is None or d < near[0]):
                near = (d, s, line, sec)
        if near is None:
            return told("Pas de route de la BD TOPO à moins de {} m de la photo".format(
                measures._num(roads.MAX_DISTANCE, 0)))
        _, s, line, sec = near
        line, ends, works = self._chained(line, sec, sections, lon, lat)  # prolongé par les tronçons voisins de la même route
        s = roads._project(line, 0.0, 0.0)[1]
        # Autres chaussées possibles (voir TWIN_REACH) : [(tronçon en mètres locaux, largeur)], vérifiées travers par
        # travers (_compute_edges) : un tronçon voisin de la même chaussée, dans son prolongement, n'en est pas une
        twin = []
        for other in sections:
            if other is sec or other.get("level", 0) != 0 or not sec.get("name") or other.get("name") != sec.get("name"):
                continue
            other_line = [triangulation._local(p[0], p[1], lon, lat) for p in other["line"]]
            if roads._project(other_line, 0.0, 0.0)[0] <= self.TWIN_REACH:
                twin.append((other_line, other["width"]))
        camera = bool(self.quality and self.quality.get("precise"))  # position RTK : profils depuis la caméra
        key = (item.get("id"), zone, camera)
        res = self.edges.get(key)
        if res is None or time.monotonic() >= res.get("retry_at", float("inf")):
            track = self._track_line(item, lon, lat)  # profil en long le long de la trajectoire de la caméra
            if track is None:
                return told("Calcul en cours…")
            res = self.edges[key] = {"text": "Calcul en cours…", "title": ""}
            self._compute_edges(key, line, s, sec["width"], metadata.item_heading(item), lon, lat, twin, track,
                                (ends, sec.get("name"), works))
        road = sec.get("name") if re.match(r"[A-Z]+\d", sec.get("name") or "") else None
        profile = res.get("profile")
        if profile:  # eau de la BD TOPO sur le travers de la photo (lue à part : None pendant la lecture)
            profile = dict(profile, eau=self._water_across(res["frame"], lon, lat))
        return {"text": "Bords de route" + (" ({})".format(road) if road else "") + "\n" + res["text"],
                "title": res["title"], "edges": True, "profile": profile, "road": road}

    CHAIN_TURN = 60.0  # degrés de déviation au plus d'un tronçon à l'autre en prolongeant la route
    CHAIN_REACH, CHAIN_TOUCH = 60.0, 2.0  # m ajoutés au plus de chaque côté ; bouts de tronçons qui se touchent

    def _chained(self, line, sec, sections, lon, lat):
        """Ligne du tronçon de la photo (mètres locaux) prolongée à chaque bout par les tronçons au sol de la même route
        (même nom) qui s'y raccordent, jusqu'à CHAIN_REACH m de plus : le profil en long et les travers ne s'arrêtent pas
        au bout du tronçon. Un seul voisin pris par bout (le premier trouvé) ; sans nom ou sans voisin, la ligne telle quelle.
        Rend aussi les points remarquables de cette route : [(point, "fin" ou "carrefour", voies nommées qui s'y raccordent)],
        « fin » au bout de la ligne prolongée (la route s'arrête, ou continue sous un autre nom), « carrefour » là où une
        voie nommée (numéro ou nom, pas une simple nature) s'y raccorde sans l'interrompre. Les tronçons en pont ou en tunnel
        de la route en font partie : leurs bouts sont rendus à part, [(niveau, bout, bout)] (le MNT y est le fond franchi
        ou le dessus du tunnel, pas la chaussée)."""
        touch = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1]) <= self.CHAIN_TOUCH
        if not sec.get("name"):
            return line, [], []
        others = [[triangulation._local(p[0], p[1], lon, lat) for p in o["line"]] for o in sections
                  if o is not sec and o.get("name") == sec["name"]]
        levels = [o.get("level", 0) for o in sections if o is not sec and o.get("name") == sec["name"]]
        works = []  # ouvrages de la route : (niveau, bout, bout)
        foreign = [(o.get("name") or "", [triangulation._local(p[0], p[1], lon, lat) for p in (o["line"][0], o["line"][-1])])
                   for o in sections if o.get("level", 0) == 0 and o.get("name") != sec["name"]]
        joints = [line[0], line[-1]]  # bouts des tronçons de la route mis bout à bout
        out = list(line)
        for at_end in (True, False):
            added, used = 0.0, set()
            while added < self.CHAIN_REACH:
                tip, back = (out[-1], out[-2]) if at_end else (out[0], out[1])
                way = (tip[0] - back[0], tip[1] - back[1])  # sens de la route en sortant par ce bout
                # le tronçon qui la continue le plus dans l'alignement (à un nœud, plusieurs tronçons du même nom peuvent
                # partir : l'autre branche d'une intersection, un pont…), à moins de CHAIN_TURN° de déviation
                best = None
                for k, o in enumerate(others):
                    if k in used or not (touch(o[0], tip) or touch(o[-1], tip)):
                        continue
                    o = o if touch(o[0], tip) else o[::-1]  # part du bout touché
                    v = (o[1][0] - o[0][0], o[1][1] - o[0][1])
                    turn = (way[0] * v[0] + way[1] * v[1]) / ((math.hypot(*way) * math.hypot(*v)) or 1.0)
                    if turn >= math.cos(math.radians(self.CHAIN_TURN)) and (best is None or turn > best[0]):
                        best = (turn, k, o)
                if best is None:
                    break
                _, k, o = best
                used.add(k)
                if levels[k]:
                    works.append((levels[k], o[0], o[-1]))
                joints.append(o[-1])
                o = o[1:]
                added += sum(math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip([tip] + o, o))
                out = out + o if at_end else o[::-1] + out
        ends = []
        for j in joints:
            names = sorted({n for n, tips in foreign if n and n not in _WAY_KINDS and any(touch(t, j) for t in tips)})
            if touch(j, out[0]) or touch(j, out[-1]):  # bout de la ligne prolongée : la route s'arrête là
                ends.append((j, "fin", names))
            elif names:
                ends.append((j, "carrefour", names))
        return out, ends, works

    WATER_REACH = 45.0  # m de part et d'autre de l'origine du travers où l'eau de la BD TOPO est cherchée

    def _water_across(self, frame, lon, lat):
        """Eau de la BD TOPO sur le travers de la photo (frame : origine et unité vers la droite, mètres locaux) : cours
        d'eau croisés ({"x", "nom", "nature"}) et plans ou surfaces d'eau traversés ({"de", "a", "nature"}), en m vers la
        droite ; None pendant la lecture. Souterrains et tronçons fictifs (à travers un lac) écartés."""
        ox, oy, rx, ry = frame
        a, b = (ox - self.WATER_REACH * rx, oy - self.WATER_REACH * ry), (ox + self.WATER_REACH * rx, oy + self.WATER_REACH * ry)
        cell = roads._cell(lon, lat)
        lines, surfaces = self._bdtopo("troncon_hydrographique", cell), self._bdtopo("surface_hydrographique", cell)
        if lines is None or surfaces is None:
            return None
        across = lambda p: round((p[0] - ox) * rx + (p[1] - oy) * ry, 1)

        def kept(props):
            try:
                return int(props.get("position_par_rapport_au_sol") or 0) >= 0 and not props.get("fictif")
            except (TypeError, ValueError):
                return not props.get("fictif")

        def cuts(ring):  # abscisses où le travers coupe la ligne (ou l'anneau) ring, en lon, lat
            pts = [triangulation._local(q[0], q[1], lon, lat) for q in ring]
            return [across(x) for c, d in zip(pts, pts[1:]) for x in [_crossing(a, b, c, d)] if x]

        out = []
        for feat in lines:
            props, geom = feat.get("properties") or {}, feat.get("geometry") or {}
            if not kept(props):
                continue
            coords = geom.get("coordinates") or []
            for line in coords if geom.get("type") == "MultiLineString" else [coords]:
                for x in cuts(line):
                    out.append({"x": x, "nom": props.get("cpx_toponyme_de_cours_d_eau"), "nature": props.get("nature")})
        for feat in surfaces:
            props, geom = feat.get("properties") or {}, feat.get("geometry") or {}
            if not kept(props):
                continue
            coords = geom.get("coordinates") or []
            xs = sorted(x for poly in (coords if geom.get("type") == "MultiPolygon" else [coords]) for ring in poly
                        for x in cuts(ring))
            # shortcut: traversées prises deux à deux ; un bout du travers dans l'eau laisse une traversée seule, écartée
            out += [{"de": xs[k], "a": xs[k + 1], "nature": props.get("nature")} for k in range(0, len(xs) - 1, 2)]
        return out

    def _track_line(self, item, lon, lat):
        """Trajectoire de la caméra autour de la photo : positions des photos de la même séquence, de rangs qui se suivent
        (un trou d'une photo admis), en mètres locaux, dans le sens de la photo, la photo à (0, 0) ; [] si moins de 3
        photos ou rang inconnu (profil en long sur l'axe BD TOPO) ; None pendant la lecture."""
        key = item.get("id")
        if key in self.long_tracks:
            return self.long_tracks[key]
        self.long_tracks[key] = None
        seq, rank0 = item.get("collection"), (item.get("properties") or {}).get("geovisio:rank_in_collection")

        def done(data, error):
            out = []
            if not error and seq is not None and isinstance(rank0, int):
                at = {rank0: (0.0, 0.0)}
                for feat in (data or {}).get("features") or []:
                    rank = (feat.get("properties") or {}).get("geovisio:rank_in_collection")
                    try:
                        if feat.get("collection") == seq and isinstance(rank, int) and rank != rank0:
                            at[rank] = triangulation._local(*(float(v) for v in feat["geometry"]["coordinates"][:2]), lon, lat)
                    except (KeyError, TypeError, ValueError):
                        continue
                ranks = [rank0]
                for step in (1, -1):  # de proche en proche, un trou d'une photo admis
                    r = rank0
                    while True:
                        r = next((r + step * g for g in (1, 2) if r + step * g in at), None)
                        if r is None:
                            break
                        ranks.append(r)
                ranks.sort()
                out = [at[r] for r in ranks]
                heading, k = metadata.item_heading(item), ranks.index(rank0)
                if len(out) >= 3 and heading is not None:
                    a, b = out[max(0, k - 1)], out[min(len(out) - 1, k + 1)]
                    if abs((math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) - heading + 180) % 360 - 180) > 90:
                        out = out[::-1]  # dans le sens de la photo
                else:
                    out = []
            self.long_tracks[key] = out
            self.notify()

        host.fetch_json(metadata.search_url(lon, lat, self.LONG_REACH + 15, 100, seq, host.api_url), done)
        return None

    def _compute_edges(self, key, line, s, width, heading, lon, lat, twin=None, track=None, ends=([], None, [])):
        """Calcul des bords (voir _edges), rangé dans self.edges[key], puis notify() ; twin : autre chaussée
        (tronçon, largeur) d'une route à chaussées séparées, ou None."""
        _, zone, camera = key
        half = (width or self.FALL_WIDTH) / 2

        def across(x, y, nx, ny, along_x, along_y):
            """Axe de l'autre chaussée sur le travers du point (x, y) de l'axe : (décalage en m le long de la normale,
            demi-largeur) de la plus proche, ou None (pas d'autre chaussée, pas parallèle, pas en travers, trop près ou
            trop loin)."""
            best = None
            for other, other_width in twin or []:
                _, s2 = roads._project(other, x, y)
                (qx, qy), p, q = roads._at(other, s2), roads._at(other, s2 - 1.0), roads._at(other, s2 + 1.0)
                t = math.hypot(q[0] - p[0], q[1] - p[1]) or 1.0
                cos = abs(((q[0] - p[0]) * along_x + (q[1] - p[1]) * along_y) / t)
                offset = (qx - x) * nx + (qy - y) * ny
                lengthwise = abs((qx - x) * along_x + (qy - y) * along_y)  # bout d'un tronçon dans le prolongement
                if (cos >= math.cos(math.radians(self.TWIN_ANGLE)) and lengthwise <= self.TWIN_LENGTHWISE
                        and self.TWIN_MIN <= abs(offset) <= self.TWIN_REACH and (best is None or abs(offset) < abs(best[0]))):
                    best = (offset, (other_width or self.FALL_WIDTH) / 2)
            return best

        def frame(at):  # point de l'axe et normale à gauche du sens du tronçon, à l'abscisse at
            (x, y), p, q = roads._at(line, at), roads._at(line, at - 1.0), roads._at(line, at + 1.0)
            t = math.hypot(q[0] - p[0], q[1] - p[1]) or 1.0
            return x, y, -(q[1] - p[1]) / t, (q[0] - p[0]) / t

        x, y, nx, ny = frame(s)
        shift = -(x * nx + y * ny) if camera else 0.0  # origine à gauche de l'axe (m) : la caméra est en (0, 0)
        a, b = roads._at(line, s - roads.TANGENT), roads._at(line, s + roads.TANGENT)
        course = math.degrees(math.atan2(b[0] - a[0], b[1] - a[1]))  # sens du tronçon
        forward = heading is None or abs((course - heading + 180) % 360 - 180) <= 90
        sides = (("droit", -1), ("gauche", 1)) if forward else (("droit", 1), ("gauche", -1))
        # Repère du travers de la photo pour l'analyse fine (src/nuage.js) : son origine et le point à 1 m à droite
        right = dict(sides)["droit"]
        across0 = (x + shift * nx, y + shift * ny, right * nx, right * ny)  # pour l'eau de la BD TOPO (_water_across)
        frame0 = [triangulation._geographic(x + shift * nx + k * right * nx, y + shift * ny + k * right * ny, lon, lat)
                  for k in (0, 1)]
        profiles = []  # (travers, côté, bord BD TOPO depuis l'origine, distances depuis l'origine), travers après travers
        samples = []
        for along in self.EDGE_ALONG:
            # shortcut: _at borne aux bouts de la ligne prolongée (_chained) : au-delà, les travers s'y superposent
            x, y, nx, ny = frame(s + along)
            other = across(x, y, nx, ny, ny, -nx)  # sens du tronçon : normale tournée d'un quart de tour à droite
            for name, sign in sides:
                guess = max(self.EDGE_NEAR, half - sign * shift)
                beyond, between = 0.0, None  # autre chaussée de ce côté : bord cherché au-delà de son axe (m depuis
                # l'origine) ; séparateur de chaussée d'après la BD TOPO, du bord de la chaussée de la photo à celui de l'autre
                if other and other[0] * sign > 0:
                    beyond = sign * other[0] - sign * shift
                    if beyond - other[1] > guess:
                        between = (guess, beyond - other[1])
                    guess = beyond + other[1]
                reach = guess + self.EDGE_SEARCH + (self.TWIN_SEARCH if beyond else 0)  # bord cherché jusque-là
                near = [k * self.EDGE_STEP for k in range(int(reach / self.EDGE_STEP) + 1)]
                offsets = near + [near[-1] + zone * k / self.EDGE_FAR for k in range(1, self.EDGE_FAR + 1)]
                profiles.append((along, name, guess, offsets, beyond, between, reach))
                samples += [(x + (shift + sign * o) * nx, y + (shift + sign * o) * ny) for o in offsets]

        # Profil en long, d > 0 dans le sens de la photo : le long de la trajectoire de la caméra (track, _track_line : là où
        # elle a roulé, sol sous elle) ; sans elle, sur l'axe BD TOPO prolongé par les tronçons voisins (_chained), à la même
        # distance de l'axe que l'origine (l'axe peut s'écarter de la voie de quelques mètres) ; borné aux bouts
        if track and len(track) >= 3:
            k0 = track.index((0.0, 0.0))
            cum = [0.0]
            for p, q in zip(track, track[1:]):
                cum.append(cum[-1] + math.hypot(q[0] - p[0], q[1] - p[1]))
            cum = [c - cum[k0] for c in cum]
            lengthwise = [d for d in range(-self.LONG_REACH, self.LONG_REACH + 1, self.LONG_STEP) if cum[0] <= d <= cum[-1]]
            for d in lengthwise:
                j = max(1, next((j for j in range(1, len(cum)) if cum[j] >= d), len(cum) - 1))
                t = (d - cum[j - 1]) / ((cum[j] - cum[j - 1]) or 1.0)
                samples.append((track[j - 1][0] + t * (track[j][0] - track[j - 1][0]), track[j - 1][1] + t * (track[j][1] - track[j - 1][1])))
            followed = "trajectoire de la caméra"
        else:
            ahead = 1 if forward else -1
            length = sum(math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip(line, line[1:]))
            lengthwise = [d for d in range(-self.LONG_REACH, self.LONG_REACH + 1, self.LONG_STEP) if 0 <= s + ahead * d <= length]
            for d in lengthwise:
                px, py, qx, qy = frame(s + ahead * d)
                samples.append((px + shift * qx, py + shift * qy))
            followed = "axe BD TOPO"

        def along_of(p):  # distance d'une fin de tronçon le long de la route BD TOPO (la caméra a pu couper le carrefour)
            return (1 if forward else -1) * (roads._project(line, p[0], p[1])[1] - s)

        def slope(z, offsets, i, span):  # pente vers le bas en s'éloignant, de i au premier point à span m au moins
            j = next((j for j in range(i + 1, len(offsets)) if offsets[j] - offsets[i] >= span - 1e-6), None)
            return None if j is None or z[i] is None or z[j] is None else (z[i] - z[j]) / (offsets[j] - offsets[i])

        def step(z, offsets, i):
            """Marche du terrain juste après le point i (voir STEP_Z) : +1 en montant, -1 en descendant, 0 sinon."""
            if i < 1 or i + 2 >= len(offsets) or offsets[i + 1] - offsets[i] > self.EDGE_STEP + 1e-6:
                return 0
            if None in (z[i - 1], z[i], z[i + 1], z[i + 2]):
                return 0
            jump, held = z[i + 1] - z[i], z[i + 2] - z[i - 1]
            if abs(jump) >= self.STEP_Z and abs(held) >= self.STEP_HOLD and jump * held > 0:
                return 1 if jump > 0 else -1
            return 0

        def border(z, offsets, reach, beyond=0.0):
            """Indice du bord : premier point, à EDGE_NEAR m au moins de l'origine (chaussées séparées : au-delà de
            l'axe de l'autre chaussée, à beyond m), d'où la pente sur 1 m s'écarte de plus de EDGE_BREAK de celle de
            la chaussée sous l'origine (ou sous l'axe de l'autre), dans le même sens sur EDGE_HOLD pas, ou d'où le
            terrain marque une marche (bordure, accotement plus bas : STEP_Z), jusqu'à reach m ; sinon None (le bord BD
            TOPO)."""
            start = min(range(len(offsets)), key=lambda k: abs(offsets[k] - beyond))
            road = slope(z, offsets, start, 1.0)
            for i in range(start + 1, len(offsets)):
                if road is None or offsets[i] > reach:
                    break
                if offsets[i] < max(self.EDGE_NEAR, beyond) - 1e-6:
                    continue
                if step(z, offsets, i):
                    return i
                d = [slope(z, offsets, k, 1.0) for k in range(i, i + self.EDGE_HOLD)]
                if None not in d and (all(v - road > self.EDGE_BREAK for v in d) or all(road - v > self.EDGE_BREAK for v in d)):
                    return i
            return None

        def peaks(z, offsets, between, beyond):
            """Pics étroits (voir PEAK_Z) avant l'axe de l'autre chaussée, à SEPARATOR_NEAR m au plus du milieu BD TOPO
            du séparateur : leurs positions en m depuis l'origine."""
            mid, out = (between[0] + between[1]) / 2, []
            for k in range(1, len(offsets) - 2):
                if offsets[k] >= beyond or abs(offsets[k] - mid) > self.SEPARATOR_NEAR:
                    continue
                if offsets[k + 1] - offsets[k] > self.EDGE_STEP + 1e-6 or None in z[k - 1:k + 3]:
                    continue
                if z[k] - z[k - 1] >= self.PEAK_Z and z[k] - z[k + 1] >= self.PEAK_Z:
                    out.append(offsets[k])
                elif (abs(z[k + 1] - z[k]) < self.PEAK_Z and z[k] - z[k - 1] >= self.PEAK_Z
                      and z[k + 1] - z[k + 2] >= self.PEAK_Z):  # deux points de large
                    out.append((offsets[k] + offsets[k + 1]) / 2)
            return out

        def separator(z, offsets, between, beyond):
            """Séparateur de chaussée trouvé dans le relief : (début, fin) en m depuis l'origine, entre deux marches de
            sens contraires (surélevé : montée puis descente ; en creux : l'inverse), avant l'axe de l'autre chaussée,
            large de SEPARATOR_WIDTH, au milieu le plus proche de celui de la BD TOPO (between, SEPARATOR_NEAR m au
            plus) ; None sinon."""
            steps = []  # (m depuis l'origine, sens), une seule par suite de marches de même sens
            for i in range(len(offsets)):
                if offsets[i] >= beyond:
                    break
                k = step(z, offsets, i)
                if k and not (steps and steps[-1][1] == k and offsets[i] - steps[-1][2] <= self.EDGE_STEP + 1e-6):
                    steps.append((offsets[i] + self.EDGE_STEP / 2, k, offsets[i]))
                elif k:
                    steps[-1] = steps[-1][:2] + (offsets[i],)
            mid, best = (between[0] + between[1]) / 2, None
            for (a, ka, _), (b, kb, _) in zip(steps, steps[1:]):
                if ka == kb or not self.SEPARATOR_WIDTH[0] <= b - a <= self.SEPARATOR_WIDTH[1]:
                    continue
                gap = abs((a + b) / 2 - mid)
                if gap <= self.SEPARATOR_NEAR and (best is None or gap < best[0]):
                    best = (gap, a, b)
            return best and best[1:]

        def got_ground(ground, source, error):
            if error or not source:
                self.edges[key] = {"text": "Calcul impossible ({})".format(
                    "service injoignable" if error else "pas de modèle de terrain ici"), "title": "",
                    "retry_at": time.monotonic() + self.FALL_RETRY if error else float("inf")}
                return self.notify()
            # côté -> [(chute, à m du bord, bout du profil, travers),
            #          (dévers, haut du talus à m du bord, travers, pied du talus à m du bord, hauteur du talus)],
            # bords [(m depuis l'origine, relief)] ; drawn : profils pour le graphique de la page (bouton « Profil »)
            found = {name: [None, None] for name, _ in sides}
            borders = {name: [] for name, _ in sides}
            stops = {name: [] for name, _ in sides}  # côté -> distances au bord où le terrain remonte de EDGE_RISE
            drawn = []
            start = 0
            twins = {name: 0 for name, _ in sides}  # côté -> travers où l'autre chaussée est comprise
            # 1er passage : bord et séparateur de chaque travers ; puis, côté par côté, ceux qui s'écartent de la médiane
            # des travers trouvés dans le relief (une marche dans l'autre chaussée, un bord flou) y sont ramenés
            read = []
            for along, name, guess, offsets, beyond, between, reach in profiles:
                z = ground[start:start + len(offsets)]
                start += len(offsets)
                if z[0] is None:
                    continue
                twins[name] += beyond > 0
                found_sep = between and separator(z, offsets, between, beyond)
                i = border(z, offsets, reach, beyond)
                read.append([along, name, guess, offsets, z, i, found_sep or between, "marches" if found_sep else None,
                             peaks(z, offsets, between, beyond) if between else []])
            for name, _ in sides:
                mine = [r for r in read if r[1] == name]
                edges = sorted(r[3][r[5]] for r in mine if r[5] is not None)
                seps = [r[6] for r in mine if r[7]]
                if not seps:  # pas de séparateur à deux marches : un pic étroit qui revient d'un travers à l'autre
                    tops = sorted(p for r in mine for p in r[8])
                    groups = [[q for q in tops if abs(q - p) <= self.PEAK_SPREAD] for p in tops]
                    group = max(groups, key=len, default=[])
                    if len({r[0] for r in mine if any(abs(q - p) <= self.PEAK_SPREAD for q in group for p in r[8])}) >= self.PEAK_TRAVERS:
                        top = group[len(group) // 2]
                        seps = [(top - self.PEAK_HALF, top + self.PEAK_HALF)]
                        for r in mine:
                            if r[6]:
                                r[6], r[7] = seps[0], "bosse"
                med = edges[(len(edges) - 1) // 2] if len(edges) >= 3 else None  # médiane basse : le bord le plus proche
                sep_med = [sorted(v[k] for v in seps)[len(seps) // 2] for k in (0, 1)] if seps else None
                for r in mine:
                    if med is not None and (r[5] is None or abs(r[3][r[5]] - med) > self.EDGE_CONSENSUS):
                        r[5] = min(range(len(r[3])), key=lambda k: abs(r[3][k] - med))
                    if sep_med and r[6] and (not r[7] or max(abs(r[6][k] - sep_med[k]) for k in (0, 1)) > self.EDGE_CONSENSUS):
                        r[6], r[7] = sep_med, "marches"
            for along, name, guess, offsets, z, i, between, sep_relief, _ in read:
                relief = i is not None
                if not relief:
                    i = min(range(len(offsets)), key=lambda k: abs(offsets[k] - guess))
                borders[name].append((offsets[i], relief))
                entry = {"le_long": along, "cote": name, "bord": offsets[i], "relief": relief, "arret": None,
                         "separateur": [round(v, 2) for v in between] if between else None,
                         "autre_axe": round(beyond, 2) if beyond else None,  # axe de l'autre chaussée, m depuis l'origine
                         "separateur_relief": sep_relief if between else None,  # "marches", "bosse" ou None (BD TOPO)
                         "points": [[round(o, 2), round(v, 2)] for o, v in zip(offsets, z) if v is not None]}
                drawn.append(entry)
                kept = [k for k in range(i, len(offsets)) if offsets[k] - offsets[i] <= zone + 1e-6]
                zz, oo = [z[k] for k in kept], [offsets[k] - offsets[i] for k in kept]
                if zz[0] is None:
                    continue
                # Terrain qui remonte de EDGE_RISE au-dessus du bord : lecture arrêtée (on ne passe pas la butte)
                cut = next((k for k, v in enumerate(zz) if v is not None and v - zz[0] >= self.EDGE_RISE), None)
                end = oo[-1]  # bout du profil : le terrain y descend peut-être encore
                if cut is not None:
                    stops[name].append(oo[cut])
                    entry["arret"] = round(offsets[i] + oo[cut], 2)
                    zz, oo, end = zz[:cut], oo[:cut], float("inf")
                # point le plus bas le plus proche du bord (à 5 cm près) : le pied du talus
                low = max(((zz[0] - v, o) for v, o in zip(zz, oo) if v is not None),
                          key=lambda c: (round(c[0] / 0.05), -c[1]))
                if found[name][0] is None or low[0] > found[name][0][0]:
                    found[name][0] = low + (end, along)
                # Dévers : pente moyenne du talus le plus raide (FALL_MIN m de haut au moins), du haut au pied,
                # tous travers confondus (le cas le plus défavorable), et non la pente la plus forte sur
                # 2 m (un détail). Talus : pentes sur EDGE_WINDOW m d'au moins EDGE_TALUS, resserrées autour de la plus
                # forte sur celles d'au moins EDGE_CORE fois elle (sans l'accotement en pente douce ni la queue du pied)
                slopes = [slope(zz, oo, j, self.EDGE_WINDOW) or 0 for j in range(len(oo))]
                k = 0
                while k < len(oo):
                    if slopes[k] < self.EDGE_TALUS:
                        k += 1
                        continue
                    first = k
                    while k < len(oo) and slopes[k] >= self.EDGE_TALUS:
                        k += 1
                    steep = max(range(first, k), key=lambda j: slopes[j])
                    floor = max(self.EDGE_TALUS, self.EDGE_CORE * slopes[steep])
                    top, end = steep, steep + 1
                    while top > first and slopes[top - 1] >= floor:
                        top -= 1
                    while end < k and slopes[end] >= floor:
                        end += 1
                    # pied : bout de la dernière fenêtre en pente, le point le plus bas jusque-là
                    last = next((j for j in range(end - 1, len(oo)) if oo[j] - oo[end - 1] >= self.EDGE_WINDOW - 1e-6),
                                len(oo) - 1)
                    foot = min((j for j in range(top, last + 1) if zz[j] is not None), key=lambda j: zz[j])
                    height = zz[top] - zz[foot]
                    mean = height / (oo[foot] - oo[top]) if foot > top else 0
                    if height >= self.FALL_MIN and (found[name][1] is None or mean > found[name][1][0]):
                        found[name][1] = (mean, oo[top], along, oo[foot], height)
            # Profil en long (derniers points lus) : pente moyenne, montée > 0 dans le sens de la photo, et la plus forte
            pts = [(d, v) for d, v in zip(lengthwise, ground[len(ground) - len(lengthwise):]) if v is not None] if lengthwise else []
            # Fin de la route de la photo et carrefours avec une voie nommée, le long d'elle ; au-delà d'une fin, pas de profil
            # (la caméra a pu continuer sur une autre route)
            cuts = []
            for p, kind, names in ends[0]:
                d = round(along_of(p), 1)
                if -self.LONG_REACH - 1 <= d <= self.LONG_REACH + 1 and all(abs(d - e["d"]) > 1 for e in cuts):
                    cuts.append({"d": d, "type": kind, "voie": ends[1], "avec": names})
            # Carrefour à îlot séparateur : la voie qui arrive y est faite d'un tronçon par sens, qui touchent la route en deux
            # points proches ; un seul repère au milieu (LONG_JUNCTION m au plus entre eux, même voie)
            cuts.sort(key=lambda e: e["d"])
            merged = []
            for e in cuts:
                last = merged[-1] if merged else None
                if (last and e["type"] == last["type"] == "carrefour" and set(e["avec"]) & set(last["avec"])
                        and e["d"] - last["d0"] <= self.LONG_JUNCTION):
                    last["d"] = round((last["d0"] + e["d"]) / 2, 1)
                    last["avec"] = sorted(set(last["avec"]) | set(e["avec"]))
                else:
                    merged.append(dict(e, d0=e["d"]))
            cuts = [{k: v for k, v in e.items() if k != "d0"} for e in merged]
            for e in cuts:
                if e["type"] == "fin":
                    pts = [(d, v) for d, v in pts if (d <= e["d"] + 1e-6 if e["d"] > 0 else d >= e["d"] - 1e-6)]
            cuts = [e for e in cuts if pts and pts[0][0] - 1 <= e["d"] <= pts[-1][0] + 1]
            # Ponts et tunnels de la route : le MNT y donne le fond franchi (ou le dessus du tunnel) ; terrain remplacé par la
            # droite d'une culée à l'autre (le tablier, à peu près), pente comprise
            spans = []
            for level, a, b in ends[2]:
                lo, hi = sorted((along_of(a), along_of(b)))
                before = [(d, v) for d, v in pts if d <= lo + 1e-6]
                after = [(d, v) for d, v in pts if d >= hi - 1e-6]
                if not pts or hi < pts[0][0] or lo > pts[-1][0]:
                    continue
                if before and after:
                    (d0, z0), (d1, z1) = before[-1], after[0]
                    pts = [(d, z0 + (z1 - z0) * (d - d0) / ((d1 - d0) or 1.0)) if d0 < d < d1 else (d, v) for d, v in pts]
                else:  # ouvrage au bout du profil, une seule culée : pas de terrain dessus
                    pts = [(d, v) for d, v in pts if not lo < d < hi]
                spans.append({"de": round(lo, 1), "a": round(hi, 1), "type": "pont" if level > 0 else "tunnel"})
            grade = None
            if len(pts) >= 5:
                md, mz = sum(d for d, _ in pts) / len(pts), sum(v for _, v in pts) / len(pts)
                mean = sum((d - md) * (v - mz) for d, v in pts) / (sum((d - md) ** 2 for d, _ in pts) or 1.0)
                windows = [((b[1] - a[1]) / (b[0] - a[0]), a[0], b[0]) for k, a in enumerate(pts) for b in pts[k + 1:]
                           if abs(b[0] - a[0] - self.LONG_WINDOW) < 1e-6]  # (pente, de, à) sur LONG_WINDOW m
                steep = max(windows, key=lambda c: abs(c[0]), default=None)
                grade = {"points": [[d, round(v, 2)] for d, v in pts], "pente": round(100 * mean, 1), "suivi": followed,
                         "fins": sorted(cuts, key=lambda e: e["d"]), "ouvrages": spans,
                         "max": [round(100 * steep[0], 1), steep[1], steep[2]] if steep else None}
            terrain = triangulation.RGE_ALTI_ERROR if source == "RGE ALTI" else triangulation.LIDAR_ERROR
            sigma = math.hypot(terrain, terrain)  # deux altitudes du même MNT
            origin = "la caméra" if camera else "l'axe BD TOPO"
            lines, seen, shown = [], [], {}
            for name, _ in sides:
                if borders[name]:
                    by_relief = sum(r for _, r in borders[name])
                    seen.append("côté {} à {} m de {} ({}{})".format(
                        name, measures._num(sorted(o for o, _ in borders[name])[len(borders[name]) // 2], 1), origin,
                        "relief sur {} travers sur {}".format(by_relief, len(borders[name])) if by_relief
                        else "largeur BD TOPO", ", au-delà du séparateur de chaussée ({}) et de l'autre chaussée".format(
                            "trouvé dans le relief" if any(e.get("separateur_relief") for e in drawn if e["cote"] == name)
                            else "d'après la BD TOPO") if twins[name] else ""))
                fall, slope_max = found[name]
                stop = sorted(stops[name])[len(stops[name]) // 2] if stops[name] else None
                if fall is None or fall[0] < self.FALL_MIN:
                    if stop is not None:
                        lines.append("Côté {} : pas de chute avant le terrain qui remonte de {} m, à {} m du bord".format(
                            name, measures._num(self.EDGE_RISE, 0), measures._num(stop, 0)))
                    continue
                beyond = fall[1] >= fall[2] - 1e-6  # le plus bas au bout du profil : le terrain descend encore
                text = "Côté {} : chute {}{} m (±{} m) {} {} m du bord".format(
                    name, "≥ " if beyond else "", measures._num(fall[0], 1), measures._num(sigma, 1),
                    "au-delà de" if beyond else "à", measures._num(fall[1], 0))
                if slope_max and slope_max[0] > 0:
                    text += ", dévers du talus {} % ({}°) sur {} m de haut".format(
                        measures._num(100 * slope_max[0], 0), measures._num(math.degrees(math.atan(slope_max[0])), 0),
                        measures._num(slope_max[4], 1))
                lines.append(text)
                shown[name] = {"chute": [round(fall[0], 2), round(fall[1], 2), beyond, fall[3]],
                               "devers": [round(slope_max[0], 3), round(slope_max[1], 2), slope_max[2],
                                          round(slope_max[3], 2), round(slope_max[4], 2)]
                               if slope_max and slope_max[0] > 0 else None}
            self.edges[key] = {
                "frame": across0,
                "profile": {"origine": "caméra" if camera else "axe", "source": source, "erreur": round(sigma, 2),
                            "repere": [[round(v, 8) for v in p] for p in frame0],
                            "axe": round(-shift * right, 2),  # axe de la chaussée de la photo, en m vers la droite
                            "zone": zone, "fenetre": self.EDGE_WINDOW, "remontee": self.EDGE_RISE, "profils": drawn,
                            "resultats": shown, "arrets": {name: sorted(v)[len(v) // 2] for name, v in stops.items() if v},
                            "en_long": grade},
                "text": ("\n".join(lines) or "Aucun bord ne descend de {} m ou plus jusqu'à {} m".format(
                    measures._num(self.FALL_MIN, 1), measures._num(zone, 0))) + ("\nPente en long : {} de {} % sur {} m{}".format(
                        "montée" if grade["pente"] >= 0 else "descente", measures._num(abs(grade["pente"]), 1),
                        measures._num(grade["points"][-1][0] - grade["points"][0][0], 0),
                        ", jusqu'à {} % sur {} m".format(measures._num(abs(grade["max"][0]), 1), self.LONG_WINDOW)
                        if grade["max"] else "") if grade else ""),
                "title": ("Terrain ({}) en travers de la route, depuis {} jusqu'à {} m au-delà du bord de la chaussée, "
                          "sur ±{} m le long de la route ; côtés vus dans le sens de la photo. Bord : rupture de pente "
                          "ou marche du terrain (bordure), sinon largeur BD TOPO (ou {} m supposés) ; chaussées séparées : "
                          "bord extérieur de l'autre chaussée, séparateur de chaussée compris (entre deux marches du "
                          "terrain, sinon d'après la BD TOPO). Chute : plus grande descente sous le "
                          "terrain du bord, lue jusqu'à ce que le terrain remonte de {} m au-dessus du bord (talus, "
                          "butte). Dévers : pente moyenne du talus le plus raide, de son haut à son pied (pente sur {} m "
                          "repassée sous {} %). Bords trouvés : {}.").format(
                    source, origin, measures._num(zone, 0), measures._num(self.EDGE_ALONG[-1], 0),
                    measures._num(self.FALL_WIDTH, 0), measures._num(self.EDGE_RISE, 0), measures._num(self.EDGE_WINDOW, 0),
                    measures._num(100 * self.EDGE_TALUS, 0), " ; ".join(seen) or "aucun")}
            self.notify()

        self._terrain([triangulation._geographic(x, y, lon, lat) for x, y in samples], got_ground)

    def _terrain(self, points, done):
        """precision.fetch_terrain par paquets de FALL_POINTS points (une requête chacun), l'un après l'autre ;
        done(altitudes, source, erreur), source RGE ALTI dès qu'un paquet en vient (la moins précise)."""
        out, sources = [], set()

        def step(start):
            def got(ground, source, error):
                if error or not source:
                    return done(None, source, error)
                out.extend(ground)
                sources.add(source)
                if start + self.FALL_POINTS < len(points):
                    return step(start + self.FALL_POINTS)
                done(out, "RGE ALTI" if "RGE ALTI" in sources else source, None)

            precision.fetch_terrain(points[start:start + self.FALL_POINTS], got)

        step(0)

    # Largeur : bord sur la droite de mesure (ticket #18) ----------------------------------------
    def _width_points(self, m):
        """Repères d'une largeur (voir Session._width_points), le bord cliqué (pas triangulé) posé sur la
        droite de mesure dans la direction du clic, là où le calcul le place : seule la direction du clic
        compte (widths.PerpendicularWidth), sa hauteur dans la photo non. Croix, trait et valeur
        concordent ; la sélection d'une croix (Session._width_near) la cherche là aussi."""
        points = super()._width_points(m)
        pic = (self.item or {}).get("id")
        if pic is not None and pic == m.clicks[1].get("pic") and m.edge_b is None:
            anchor = self._aim_anchor() if m.edge is self.ref_point else None  # comme la droite tracée
            points[1] = self._project(*m.result["points"][1], anchor[2] if anchor else None)
        if pic is not None and pic == m.clicks[1].get("pic"):
            _keep_view(m, points)
        return points

    def start_edge_b(self):
        """Trianguler le bord B (voir Session.start_edge_b) : la première visée est le bord tel qu'il est
        posé sur la droite de mesure (direction du clic, élévation de la droite), pas l'élévation du
        clic, qui ne compte pas : croix bleue sur la croix B, visée 3D cohérente."""
        m = self._edge_b_candidate()
        out = super().start_edge_b()
        tri = self.triangulator
        if m is None or self.b_aiming is not m or len(tri.sightings) != 1 \
                or (self.item or {}).get("id") != m.clicks[1].get("pic"):
            return out
        p = self._width_points(m)[1]
        s = tri.sightings[0]
        s["raw"] = [p["abs_yaw"], p["elev"]]
        if self._resight(s):
            s["view"] = [p["yaw"], p["pitch"]]
        return self.status()

    def take_aim_frame(self):
        """Visées guidées : repère dans la photo affichée ([[cap, élévation]] en radians, JSON) du
        point à viser : triangulé par les visées déjà faites (dès la 3e visée), sinon tel qu'il est
        placé avant de l'être (voir _provisional_point). Une seule fois par photo affichée, et
        seulement si elle n'a pas encore servi à le viser ; null sinon. Propre à la page (pas dans
        le cœur du plugin)."""
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
        """Point visé tel qu'il est placé avant d'être triangulé (lon, lat), ou None : le bord B
        d'une largeur là où l'a mis le clic de la mesure, ou le point de référence là où la
        première visée touche le sol plat."""
        sightings = self.triangulator.sightings
        if self.b_aiming is not None:
            return tuple(self.b_aiming.result["points"][1])
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
            if len(item.points) >= 2:  # sans étiquette : pas de longueur sur la carte (demande de l'utilisateur)
                add("mesure", "LineString", [list(p) for p in item.points])
            for p in item.points:
                add("point", "Point", list(p))
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
        for i, j, values in self.links:  # distance entre deux points gardés : trait rouge, sans longueur
            add("distance", "LineString", [list(self.points[i][:2]), list(self.points[j][:2])])
        return json.dumps({"type": "FeatureCollection", "features": features})

    # Export ------------------------------------------------------------------------------
    def _records(self, releve=False):
        """Mesures terminées et points triangulés : (géométrie [(lon, lat)], attributs), comme
        les couches du plugin ; releve : les objets relevés seuls, leurs champs en colonnes."""
        if releve:
            kept = [(lon, lat, values) for lon, lat, values in self.points if "releve" in values]
            # Champs ajoutés en cours de relevé : à leur place, vides pour les objets d'avant
            names = list(dict.fromkeys(k for _, _, v in kept for k in v["releve"] if k not in RELEVE_PLACE))
            return [([(lon, lat)], _releve_attrs(values, names)) for lon, lat, values in kept]
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
                # Pour la revoir à l'import (src/app.js, reviewMeasure) : photo d'où elle a été prise (celle
                # de la fiche) et repères tels que dessinés dessus ([[cap, élévation]] en radians, texte JSON)
                "photo_ref": m.clicks[0 if m.kind == "height" else 1].get("pic"),
                "vue_ref": json.dumps(m.view_ref) if getattr(m, "view_ref", None) else None,
                "etiquette": "{} m ± {} m".format(measures._num(r["value"], 2), measures._num(r["uncertainty"], 2)),
            }))
        for lon, lat, values in self.points:
            if "releve" not in values:  # objets relevés : export à part, gardés à part dans le navigateur
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

    def caption(self, yaw):
        """Cartouche d'attribution de la vue (obligation des licences Panoramax) : auteur, date,
        catégorie de la licence ; sans le cap (yaw, gardé pour la page, ne sert plus)."""
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


def _map_line_text(text):
    """Texte de la largeur (widths.PerpendicularWidth.status) prise sur une droite tracée sur la carte
    (ticket #28) : ni perpendiculaire à la chaussée, ni depuis un point triangulé (A posé d'un clic)."""
    on_line = r"(?=[^.]*" + re.escape(MAP_SOURCE) + ")"
    text = re.sub("Largeur perpendiculaire à la chaussée" + on_line, "Largeur le long de la droite tracée sur la carte", text)
    text = re.sub("depuis le point triangulé " + on_line, "depuis le point ", text)
    text = re.sub("entre les points triangulés " + on_line, "entre les points ", text)
    return re.sub(r"axe (\d+)° \(" + re.escape(MAP_SOURCE),  # axe : perpendiculaire à la droite
                  lambda m: "droite à {}° (tracée sur la carte".format((int(m.group(1)) + 90) % 180), text)


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


def _inside(point, ring):
    """Point (lon, lat) dans le polygone ring ([[lon, lat]]) ? Règle du nombre de croisements."""
    x, y, inside = float(point[0]), float(point[1]), False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        (x1, y1), (x2, y2) = a[:2], b[:2]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside
