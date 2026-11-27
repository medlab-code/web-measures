# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Diagnostic du relief LiDAR HD sous la route (ticket #67), porté de `diagnoseRelief` de src/dessus.js.

Il dit si le terrain devant la caméra est assez net pour y prendre la pente de la route : le rang 6 de Calibration.tilt
(« route (LiDAR HD) + profil », py/web_pose.py) ne s'applique que s'il ne trouve rien d'anormal. Mêmes seuils que la vue du dessus
(constantes ci-dessous, vérifiées contre src/dessus.js par tests/test_calculs.py : toute modification se fait des deux côtés).

Lu sur les altitudes brutes, dans la zone utile : la chaussée devant la caméra, RELIEF_ALONG m en long dans le sens du cap, ± RELIEF_ACROSS m
en travers, sur les nœuds d'une maille de STEP m alignée sur l'est et le nord (comme la grille de la vue du dessus). Un plan est ajusté sur la
zone : « écart au plan » = résidus de cet ajustement, pas une précision du MNT. Seuils provisoires, à caler.

Différence avec la vue du dessus : la part de points reçus (`valid`) est comptée sur les nœuds de la zone utile seulement, la vue du dessus
la comptant sur toute sa grille (±15 m) ; l'écart au plan, la pente et la rupture sont calculés sur les mêmes nœuds, donc identiques.
"""

import math

from .triangulation import _geographic

STEP = 1.0  # m : maille du terrain (STEP de src/dessus.js)
REACH = 15.0  # m : portée de la grille de la vue du dessus (REACH de src/dessus.js)
RELIEF_ALONG = 12.0  # m : zone utile, en long devant la caméra
RELIEF_ACROSS = 3.0  # m : zone utile, de part et d'autre
RELIEF_MIN_VALID = 0.9  # part des points reçus (grille partielle en deçà) ; provisoire, à caler
RELIEF_MAX_RMS = 0.10  # m : écart quadratique au plan (relief irrégulier au-delà) ; provisoire, à caler
RELIEF_MAX_SLOPE = 8.0  # % : pente du plan (pente forte au-delà) ; provisoire, à caler
RELIEF_MAX_BREAK = 2.0  # degrés : écart entre les pentes de la moitié proche et de la moitié lointaine (rupture au-delà) ; provisoire, à caler
MIN_FIT = 6  # points au moins pour ajuster un plan (comme dans la vue du dessus)


def zone_offsets(heading):
    """Nœuds (est, nord) en mètres autour de la caméra, de la maille STEP, dans la zone utile du cap `heading` (degrés) : liste de
    (est, nord, en long, en travers). En long positif devant la caméra, en travers positif à sa droite."""
    h = math.radians(heading)
    f = (math.sin(h), math.cos(h))
    n = int(round(REACH / STEP))
    out = []
    for j in range(-n, n + 1):
        for i in range(-n, n + 1):
            e, nn = i * STEP, j * STEP
            along, across = e * f[0] + nn * f[1], e * f[1] - nn * f[0]
            if 0 <= along <= RELIEF_ALONG and abs(across) <= RELIEF_ACROSS:
                out.append((e, nn, along, across))
    return out


def zone_points(lon, lat, heading):
    """Points (lon, lat) du sol où lire le LiDAR HD, dans l'ordre de zone_offsets."""
    return [_geographic(e, n, lon, lat) for e, n, _, _ in zone_offsets(heading)]


def _plane(points):
    """Plan z = a + b·x + c·y des moindres carrés sur [(x, y, z)] : (a, b, c), ou None sans assez de points ou de répartition."""
    if len(points) < MIN_FIT:
        return None
    m = [[0.0] * 3 for _ in range(3)]
    v = [0.0] * 3
    for x, y, z in points:
        row = (1.0, x, y)
        for r in range(3):
            v[r] += row[r] * z
            for c in range(3):
                m[r][c] += row[r] * row[c]
    a = [m[r] + [v[r]] for r in range(3)]  # élimination de Gauss avec pivot
    for col in range(3):
        pivot = max(range(col, 3), key=lambda r: abs(a[r][col]))
        if abs(a[pivot][col]) < 1e-12:
            return None
        a[col], a[pivot] = a[pivot], a[col]
        for r in range(3):
            if r != col:
                k = a[r][col] / a[col][col]
                a[r] = [x - k * y for x, y in zip(a[r], a[col])]
    return tuple(a[r][3] / a[r][r] for r in range(3))


def diagnose(heading, z, under=None):
    """Diagnostic du relief devant la caméra : z, altitudes lues aux nœuds de zone_offsets(heading) (None : pas d'altitude) ;
    under : pour chaque nœud, vrai s'il est sous l'emprise d'un pont voisin (écarté, comme dans la vue du dessus). Rend {valid (part
    reçue), rms (m), slope (%), rupture (degrés, ou None), reasons (textes, vide si rien d'anormal)}."""
    nodes = zone_offsets(heading)
    asked = got = 0
    zone = ([], [])  # moitié proche, moitié lointaine : (en travers, en long, z)
    for k, (_, _, along, across) in enumerate(nodes):
        if under is not None and under[k]:
            continue
        asked += 1
        if z[k] is None:
            continue
        got += 1
        zone[0 if along < RELIEF_ALONG / 2 else 1].append((across, along, z[k]))
    out = {"valid": got / asked if asked else 0.0, "rms": None, "slope": None, "rupture": None, "reasons": []}
    every = zone[0] + zone[1]
    plane = _plane(every)
    if plane:
        res = [v - plane[0] - plane[1] * x - plane[2] * y for x, y, v in every]
        out["rms"] = math.sqrt(sum(r * r for r in res) / len(res))
        out["slope"] = 100.0 * math.hypot(plane[1], plane[2])
        near, far = _plane(zone[0]), _plane(zone[1])
        if near and far:
            out["rupture"] = abs(math.degrees(math.atan(far[2]) - math.atan(near[2])))
    reasons = out["reasons"]
    if out["valid"] < RELIEF_MIN_VALID:
        reasons.append("grille partielle ({} %)".format(round(100 * out["valid"])))
    if out["rms"] is None:
        reasons.append("relief non lisible")  # trop peu de points pour un plan : la vue du dessus ne dit rien, ici on ne s'y fie pas
    elif out["rms"] > RELIEF_MAX_RMS:
        reasons.append("relief irrégulier ({} cm)".format(round(100 * out["rms"])))
    if out["slope"] is not None and out["slope"] > RELIEF_MAX_SLOPE:
        reasons.append("pente forte ({} %)".format(round(out["slope"])))
    if out["rupture"] is not None and out["rupture"] > RELIEF_MAX_BREAK:
        reasons.append("rupture de pente ({:.1f}°)".format(out["rupture"]).replace(".", ","))
    return out


def summary(diagnosis):
    """Diagnostic gardé dans l'inclinaison automatique de la photo (Calibration.auto, « relief ») : valeurs arrondies et raisons."""
    def r(v, d):
        return None if v is None else round(v, d)
    return {"valid": r(diagnosis["valid"], 3), "rms": r(diagnosis["rms"], 4), "slope": r(diagnosis["slope"], 2),
            "rupture": r(diagnosis["rupture"], 2), "reasons": list(diagnosis["reasons"])}
