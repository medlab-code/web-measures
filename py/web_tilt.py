# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Inclinaison automatique avec la raison d'un échec (ticket #29), sans toucher au cœur.

autotilt.estimate ne dit pas pourquoi il échoue : estimate refait son calcul et, s'il échoue,
le refait sans les seuils de autotilt.fit (nombre de segments, incertitude, inclinaison
maximale) pour savoir lequel a refusé. Calculé dans le Pyodide d'arrière-plan
(web_host.run_task), qui a numpy.
"""

import math

from core import autotilt, calibration, host

FEW_EDGES = "pas assez d'arêtes verticales dans la photo"  # raison la plus courante (campagne)
# Vue du dessus : verticales refusées pour les mesures (incertitude au-delà de autotilt.MAX_SIGMA) mais gardées jusqu'à
# LOOSE_SIGMA (degrés), mieux que la pente de la route (±1°, sans le véhicule penché en virage). Giratoire b47b4351
# (08/11/2026) : 73 segments à ±0,42°, roulis de 3,0° contre 0,95° par la route ; largeur 8,06 m pour 8,0 m mesurés
# sur le terrain (9,08 m par la route).
LOOSE_SIGMA = 0.5


def estimate(data, azimuth):
    """Comme autotilt.estimate, mais un échec rend {"reason": texte court} au lieu de None, avec
    "loose" ({up, sigma}) si les verticales passent à LOOSE_SIGMA près (vue du dessus seulement)."""
    band = host.decode_band(data, autotilt.WIDTH, autotilt.ELEV_MIN, autotilt.ELEV_MAX)
    if band is None:
        return {"reason": "photo HD illisible"}
    pairs = autotilt.segments(*band, azimuth)
    res = autotilt.fit(pairs, azimuth)
    if res:
        return res
    limits = autotilt.MIN_SEGMENTS, autotilt.MAX_SIGMA, calibration.MAX_TILT
    autotilt.MIN_SEGMENTS, autotilt.MAX_SIGMA, calibration.MAX_TILT = 3, math.inf, 90.0
    try:
        loose = autotilt.fit(pairs, azimuth)
    finally:
        autotilt.MIN_SEGMENTS, autotilt.MAX_SIGMA, calibration.MAX_TILT = limits
    # Dans l'ordre des refus de autotilt.fit ; arêtes trop peu nombreuses ou trop imprécises : même
    # texte pour l'utilisateur
    if loose is not None and loose["count"] >= limits[0] and loose["sigma"] <= limits[1]:
        return {"reason": "inclinaison trouvée trop forte"}
    if loose is not None and loose["count"] >= limits[0] and loose["sigma"] <= LOOSE_SIGMA and loose["tilt"] <= limits[2]:
        return {"reason": FEW_EDGES, "loose": {"up": list(loose["up"]), "sigma": loose["sigma"], "count": loose["count"],
                                                     **{k: loose.get(k) for k in autotilt.QUALITY}}}
    return {"reason": FEW_EDGES}

