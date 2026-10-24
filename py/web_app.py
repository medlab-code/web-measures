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
_core_axis_error = widths.axis_error


def _axis_error(source):
    """widths.axis_error, avec l'axe tiré de la trajectoire RTK."""
    return AXIS_ERROR_RTK if source and source.startswith(RTK_SOURCE) else _core_axis_error(source)


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
        self.bdtopo = {}  # (couche BD TOPO, maille) -> objets lus (voir _bdtopo)
        self.tilt_reasons = {}  # photo -> raison de l'échec de l'inclinaison automatique (ticket #29)
        self.tilts.run = self._run_tilt

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
        pris pour un échec)."""
        return [(name, "avant" if name == "Inclinaison" and light == "non" and not self._tilt_final() else light)
                for name, light in super()._lights(pic)]

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
        return self.tilt_reasons.get(pic, web_tilt.FEW_EDGES)

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
            else:
                how = "par {} ({})".format("les verticales de la photo" if source == "verticales" else "le terrain", sigma)
            return "inclinaison calée " + how, False
        if pic and self.tilts.pending(pic):
            return "inclinaison : calcul en cours…", False
        reason = self._tilt_reason()
        if not self._tilt_final():
            return "inclinaison " + reason, False
        return "inclinaison non calée (±{}°) : {}".format(
            measures._num(calibration.UNCALIBRATED, 0), reason), True

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

    def _widths(self):
        found = super()._widths()
        return [m for m in found if m.clicks[1].get("pic") == self._here()] if self.here_only else found

    def _free_mark_point(self, k):
        """Point gardé de la mesure libre : seulement là où il a été visé (sans repère ailleurs)."""
        if self.here_only and self._here() not in self.point_views.get(self.points[k][2]["nom"], {}):
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

    def viewer_marks(self):
        marks = self._filtered(super().viewer_marks)
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
            name = self.points[r["id"]][2]["nom"]
            if name in under or name == current:
                out += [r] + under.pop(name, [])
        for subs in under.values():
            orphans += [dict(r, sous=False) for r in subs]
        return json.dumps(out + orphans)

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
                # shortcut: tablier à l'altitude de la photo la plus proche (photos tous les ~5 m) ;
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
