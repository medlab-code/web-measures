# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Inclinaison par le terrain hors agglomération, expérimentale (ticket #29), sans toucher au cœur.

Quand les verticales de la photo manquent (rase campagne), l'inclinaison de la caméra est prise
égale à la pente et au dévers du terrain sous elle (MNT LiDAR HD), plus le décalage de sa fixation
sur le véhicule :

- terrain : plan ajusté sur une grille de GRID_ALONG × GRID_ACROSS m autour de la caméra (plus
  large que celle du cœur, calibration.LIDAR_GRID : moins sensible aux bordures et aux bosses) ;
- décalage : appris sur des photos de la même séquence calées par leurs verticales (références,
  prises en zone d'habitation, où les verticales réussissent).

Mesures du 24/10/2026 (README, « Précision ») : 14 photos témoins hors des villages de référence
(hameaux, sorties de village, 56 à 67 km/h), calées par leurs verticales : dévers à ±0,6°, pente
à ±0,5° (±1,2° et ±1,6° sans terrain ; ±0,8° et ±0,6° avec la grille du cœur). Le roulis en virage
n'est pas corrigé : la correction tirée des photos de village (3 à 6°/g) aggravait le seul virage
témoin (0,3 g : +0,4° d'écart sans elle, −1,1° avec). LiDAR HD seul : le RGE ALTI prend talus et
murs pour la route.
"""

import math

from core import calibration

GRID_ALONG = [k * 0.5 for k in range(-5, 6)]  # m en avant de la caméra : −2,5 à +2,5
GRID_ACROSS = [-1.5, -0.8, 0.0, 0.8, 1.5]  # m à droite
MIN_REFS = 3  # photos de référence calées pour apprendre le décalage
SIGMA_MIN = 0.6  # degrés : incertitude au moins égale à l'écart mesuré sur les témoins (dévers)


def grid_points(lon, lat, heading):
    """Points du sol où lire le LiDAR HD : grille GRID_ALONG × GRID_ACROSS (en avant, à droite)."""
    out = []
    for along in GRID_ALONG:
        p = calibration.offset(lon, lat, heading, along) if along else (lon, lat)
        for right in GRID_ACROSS:
            out.append(calibration.offset(p[0], p[1], heading + 90, right) if right else p)
    return out


def slopes(z):
    """(pente en long, dévers) en degrés du plan ajusté sur les altitudes de grid_points (grille
    symétrique : moyennes pondérées indépendantes ; mêmes signes que calibration.lidar_slopes)."""
    cells = [(a, c) for a in GRID_ALONG for c in GRID_ACROSS]
    sa = sum(a * h for (a, _), h in zip(cells, z)) / sum(a * a for a, _ in cells)
    sc = sum(c * h for (_, c), h in zip(cells, z)) / sum(c * c for _, c in cells)
    return math.degrees(math.atan(sa)), math.degrees(math.atan(sc))


def residual(entry):
    """(avant, droite) en degrés : inclinaison de la caméra moins terrain (fixation)."""
    return entry["forward"] - entry["slopes"][0], entry["right"] - entry["slopes"][1]


def model(refs):
    """Décalage de la fixation (avant, droite), son incertitude sigma (degrés) et le nombre de
    références, d'après les références calées de la séquence (dicts forward, right, slopes) ; None
    s'il y en a moins de MIN_REFS."""
    if len(refs) < MIN_REFS:
        return None
    res = [residual(r) for r in refs]
    n = len(res)
    mf, mr = sum(r[0] for r in res) / n, sum(r[1] for r in res) / n
    spread = math.sqrt(sum((r[0] - mf) ** 2 + (r[1] - mr) ** 2 for r in res) / (2 * max(n - 1, 1)))
    return {"offset": (mf, mr), "sigma": max(spread, SIGMA_MIN), "count": n}


def predict(m, slope, heading):
    """Inclinaison de la caméra (dict comme calibration.Calibration.auto_tilt) d'après le modèle m
    et le terrain sous la photo (slopes)."""
    f = slope[0] + m["offset"][0]
    r = slope[1] + m["offset"][1]
    up = calibration.up_from_components(f, r, heading)
    return {"up": up, "tilt": math.degrees(math.acos(min(1.0, up[2]))),
            "toward": math.degrees(math.atan2(up[0], up[1])) % 360, "residual": None, "partial": False,
            "count": m["count"], "sigma": m["sigma"], "source": "terrain web"}


if __name__ == "__main__":  # contrôles : plan incliné retrouvé, modèle et prédiction cohérents
    z = [0.05 * a - 0.02 * c for a in GRID_ALONG for c in GRID_ACROSS]
    s = slopes(z)
    assert abs(s[0] - math.degrees(math.atan(0.05))) < 1e-9 and abs(s[1] - math.degrees(math.atan(-0.02))) < 1e-9
    refs = [{"forward": 1.0 + k * 0.1, "right": 0.5, "slopes": (k * 0.1, 0.0)} for k in range(3)]
    m = model(refs)
    assert abs(m["offset"][0] - 1.0) < 1e-9 and abs(m["offset"][1] - 0.5) < 1e-9 and m["sigma"] == SIGMA_MIN
    t = predict(m, (2.0, 1.0), 30.0)
    f, r = calibration.tilt_components(t["up"], 30.0)
    assert abs(f - 3.0) < 1e-6 and abs(r - 1.5) < 1e-6
    print("web_terrain : contrôles réussis")
