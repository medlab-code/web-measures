# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Tronçons de la BD TOPO (service WFS de la Géoplateforme, sans clé) : pont sous la photo, et, pour la page,
voies, carrefours et tronçon le plus proche.

Les tronçons sont lus par maille d'environ 100 m, une fois par session ; une panne n'est pas
gardée (nouvel essai après RETRY s). Ces tronçons disent si une photo est prise sur un
pont (on_bridge) : le MNT LiDAR HD y donne le terrain sous l'ouvrage, pas le tablier.
"""

import math
import time
from urllib.parse import urlencode

from . import host, triangulation

WFS_URL = "https://data.geopf.fr/wfs/ows"
LAYER = "BDTOPO_V3:troncon_de_route"
CELL = 0.001  # degré (~100 m) : maille de lecture des tronçons
MARGIN = 30.0  # m autour de la maille : tronçons proches d'un point du bord de la maille
MAX_DISTANCE = 15.0  # m entre un point et le tronçon qui le longe
TANGENT = 10.0  # m de part et d'autre : direction locale du tronçon
RETRY = 30.0  # s avant de réinterroger un service en panne
PENDING = "pending"  # résultat de lookup quand une lecture est en cours
BRIDGE_REACH = 8.0  # m entre la photo et un tronçon en pont : demi-chaussée et précision GPS
BRIDGE_ANGLE = 30.0  # degrés au plus entre le tronçon en pont et le sens de la séquence
BRIDGE_LEFT = MARGIN  # m : photo sortie du pont, aucun tronçon en pont plus près (photos d'approche)
# Natures de la BD TOPO retenues comme voies carrossables : routes revêtues, ni route empierrée, chemin, sentier, piste cyclable ou escalier
DRIVABLE_NATURES = {"Route à 1 chaussée", "Route à 2 chaussées", "Rond-point", "Bretelle", "Type autoroutier"}
CLOSED_ACCESS = {"Restreint aux ayants droit", "Physiquement impossible"}  # accès des véhicules légers : voie non ouverte
# Chemins nommés que la BD TOPO classe en « Route à 1 chaussée » (« CHE DE L ARGENTALET ») : seul leur nom les distingue
PATH_NAMES = {"CHE", "CHEM", "CHEMIN"}


def _axis_diff(a, b):
    """Écart entre deux directions de droite (modulo 180°)."""
    d = abs((a - b) % 180)
    return min(d, 180 - d)


def _cell(lon, lat):
    return int(math.floor(lon / CELL)), int(math.floor(lat / CELL))


def wfs_url(cell):
    """URL des tronçons de route de la maille (et de MARGIN m autour)."""
    lon0, lat0 = cell[0] * CELL, cell[1] * CELL
    dlat = MARGIN / 111320.0
    dlon = MARGIN / (111320.0 * math.cos(math.radians(lat0 + CELL / 2)))
    return WFS_URL + "?" + urlencode({
        "SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature", "TYPENAMES": LAYER,
        "OUTPUTFORMAT": "application/json", "SRSNAME": "EPSG:4326", "COUNT": 500,
        "BBOX": "{:.7f},{:.7f},{:.7f},{:.7f},urn:ogc:def:crs:EPSG::4326".format(
            lat0 - dlat, lon0 - dlon, lat0 + CELL + dlat, lon0 + CELL + dlon)})


def parse_sections(data):
    """Tronçons d'une réponse WFS (GeoJSON) : liste de dicts line ([(lon, lat)]), name, level
    (position par rapport au sol : 1 ou plus sur un pont, -1 en tunnel), drivable (voie carrossable ouverte, ni privée,
    ni chemin d'après son nom s'il n'a pas de numéro)."""
    out = []
    for feat in (data or {}).get("features") or []:
        geom = feat.get("geometry") or {}
        props = feat.get("properties") or {}
        lines = geom.get("coordinates") or []
        if geom.get("type") == "LineString":
            lines = [lines]
        elif geom.get("type") != "MultiLineString":
            continue
        name = props.get("cpx_numero") or props.get("nom_collaboratif_gauche") or props.get("nature") or ""
        try:
            level = int(props.get("position_par_rapport_au_sol") or 0)
        except (TypeError, ValueError):
            level = 0
        for line in lines:
            try:
                pts = [(float(c[0]), float(c[1])) for c in line]
            except (TypeError, ValueError, IndexError):
                continue
            if len(pts) >= 2:
                out.append({"line": pts, "name": str(name), "level": level,
                            "drivable": props.get("nature") in DRIVABLE_NATURES and not props.get("prive")
                            and props.get("acces_vehicule_leger") not in CLOSED_ACCESS
                            and str(name).split(" ")[0] not in PATH_NAMES})
    return out


def _project(line, x, y):
    """(distance, abscisse curviligne) du point de la polyligne le plus proche de (x, y)."""
    best, s = (float("inf"), 0.0), 0.0
    for (ax, ay), (bx, by) in zip(line, line[1:]):
        length = math.hypot(bx - ax, by - ay)
        if length == 0:
            continue
        t = max(0.0, min(1.0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length ** 2))
        d = math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay))
        if d < best[0]:
            best = (d, s + t * length)
        s += length
    return best


def _at(line, s):
    """Point de la polyligne à l'abscisse curviligne s (bornée)."""
    acc = 0.0
    for (ax, ay), (bx, by) in zip(line, line[1:]):
        length = math.hypot(bx - ax, by - ay)
        if length > 0 and acc + length >= s:
            t = max(0.0, (s - acc) / length)
            return ax + t * (bx - ax), ay + t * (by - ay)
        acc += length
    return line[-1]


def on_bridge(sections, lon, lat, axis=None, reach=BRIDGE_REACH):
    """Tronçon en pont (dict de parse_sections) sous la photo prise en (lon, lat) : à moins de
    reach m et, si l'axe de la séquence est connu, dans son sens (à BRIDGE_ANGLE° près :
    une photo prise sous le pont, sur la voie franchie, n'est pas dessus). None sinon."""
    for sec in sections:
        if sec.get("level", 0) <= 0:
            continue
        line = [triangulation._local(p[0], p[1], lon, lat) for p in sec["line"]]
        d, s = _project(line, 0.0, 0.0)
        if d > reach:
            continue
        a, b = _at(line, s - TANGENT), _at(line, s + TANGENT)
        if axis is not None and math.hypot(b[0] - a[0], b[1] - a[1]) >= 1.0 and \
                _axis_diff(math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])), axis) > BRIDGE_ANGLE:
            continue
        return sec
    return None


class RoadAxisProvider:
    """Tronçons de la BD TOPO au point demandé (voir le module), avec lectures en cache : bridge est
    synchrone, il rend le résultat si les données sont là, PENDING si une lecture vient d'être
    lancée (ready() sera appelé à son arrivée)."""

    def __init__(self):
        self._sections = {}  # maille -> tronçons
        self._pending = set()
        self._failed = {}  # clé -> heure de la panne
        self.ready = None  # appelé quand une lecture arrive

    def bridge(self, lon, lat, axis=None, reach=BRIDGE_REACH):
        """Tronçon en pont sous la photo (voir on_bridge), False s'il n'y en a pas, None si la
        BD TOPO est injoignable, ou PENDING pendant la lecture (ready() sera appelé à son
        arrivée). reach : au plus MARGIN (tronçons lus autour de la maille)."""
        cell = _cell(lon, lat)
        sections = self._get(("bdtopo", cell), self._sections, cell, lambda: wfs_url(cell), parse_sections)
        if sections is PENDING or sections is None:
            return sections
        return on_bridge(sections, lon, lat, axis, reach) or False

    def _get(self, key, cache, cache_key, url, parse):
        """Données en cache, PENDING (lecture lancée ou en cours), ou None (panne récente)."""
        if cache_key in cache:
            return cache[cache_key]
        if key in self._pending:
            return PENDING
        if time.monotonic() - self._failed.get(key, -RETRY) < RETRY:
            return None
        self._pending.add(key)

        def done(data, error):
            self._pending.discard(key)
            if error:
                self._failed[key] = time.monotonic()
            else:
                cache[cache_key] = parse(data)
            if self.ready is not None:
                self.ready()

        host.fetch_json(url(), done, timeout_ms=15000)
        return PENDING if key in self._pending else self._get(key, cache, cache_key, url, parse)
