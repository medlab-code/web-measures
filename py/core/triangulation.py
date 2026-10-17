# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Position d'un objet par intersection de visées (triangulation).

Chaque visée part de la position d'une photo dans une direction (cap absolu,
0 = nord, sens horaire). Le point retenu est celui qui minimise la somme
pondérée des carrés des distances aux demi-droites de visée (moindres carrés) :
deux visées suffisent, chaque visée supplémentaire améliore et contrôle le
résultat. Le poids d'une visée est l'inverse du carré de son écart latéral
probable, qui cumule l'erreur de visée (croissante avec la distance) et la
précision de la position GPS de la photo : une visée lointaine ou une photo mal
positionnée compte moins.

Visées en 3D : quand toutes les photos ont une altitude de caméra vérifiée (RTK), chaque
visée garde aussi son inclinaison (élévation corrigée du calage) et devient une demi-droite
dans l'espace. Des photos prises les unes derrière les autres voient l'objet sous des
inclinaisons différentes : la profondeur, mal fixée par les seuls caps quand les visées sont
presque parallèles, l'est alors par les inclinaisons. Pour un point au sol (ground=True :
bord de chaussée, pied d'un objet), l'altitude du sol, tirée de celle des caméras moins leur
hauteur au-dessus du sol LiDAR, fixe encore la profondeur. Chaque visée pèse selon ses erreurs
latérale (cap, GPS) et verticale (inclinaison, altitude).

Calcul dans un plan tangent local (quelques centaines de mètres au plus) :
l'erreur due à la projection est négligeable devant la précision du GPS.
Module sans dépendance à QGIS, pour pouvoir être testé seul.
"""

import math

EARTH_RADIUS = 6371008.8
HEADING_ERROR = 1.0  # erreur de visée supposée (degrés) pour l'incertitude affichée
# Matériel de relevé (GPS corrigé à SURVEY_ACCURACY m ou mieux, cap EXIF au centième) :
# sur les photos imajbox à position RTK, le cap suit la trajectoire à 0,33° près (écart-type).
SURVEY_HEADING_ERROR = 0.5
SURVEY_ACCURACY = 2.0
MIN_ANGLE = 3.0  # en dessous, les visées sont jugées parallèles
MAX_DISTANCE = 500.0  # au-delà, le résultat n'a plus de sens avec des photos de rue
GPS_ACCURACY = 3.0  # précision GPS supposée (m) quand la photo ne l'indique pas
GPS_WARNING = 5.0  # au-delà, la position des photos limite nettement la précision du point
ITERATIONS = 4  # les poids dépendent des distances, donc du point : quelques passes suffisent
# Visées en 3D (voir solve3d)
ELEV_ERROR = 2.0  # erreur d'inclinaison d'une photo dont l'inclinaison n'est pas calée (degrés)
CLICK_ERROR = 0.1  # erreur de pointé d'un clic dans la photo (degrés)
ALT_ERROR = 0.05  # erreur relative de l'altitude des caméras d'une position vérifiée (m)
GROUND_ERROR = 0.10  # écart du sol au point visé à celui tiré des photos : dévers, bordure (m)
WEAK_ANGLE = 15.0  # croisement en dessous duquel, en plan, la profondeur devient imprécise (degrés)


class TriangulationError(ValueError):
    """Visées inexploitables (message destiné à l'utilisateur)."""


def _local(lon, lat, lon0, lat0):
    """Coordonnées métriques (est, nord) autour de (lon0, lat0)."""
    return (EARTH_RADIUS * math.radians(lon - lon0) * math.cos(math.radians(lat0)),
            EARTH_RADIUS * math.radians(lat - lat0))


def _geographic(x, y, lon0, lat0):
    return (lon0 + math.degrees(x / (EARTH_RADIUS * math.cos(math.radians(lat0)))),
            lat0 + math.degrees(y / EARTH_RADIUS))


def offset(lon, lat, heading, distance):
    """Point situé à `distance` mètres de (lon, lat) dans la direction `heading`."""
    a = math.radians(heading)
    return _geographic(distance * math.sin(a), distance * math.cos(a), lon, lat)


def crossing_angle(h1, h2):
    """Angle entre deux droites de visée, ramené entre 0 et 90°."""
    a = abs(h1 - h2) % 180.0
    return min(a, 180.0 - a)


def heading_error(sighting):
    """Erreur de visée supposée (degrés) : celle du recalage du cap s'il y en a un
    ("heading_error", voir calibration.py), plus faible pour le matériel de relevé."""
    if sighting.get("heading_error") is not None:
        return float(sighting["heading_error"])
    accuracy = sighting.get("accuracy")
    if sighting.get("precise") and accuracy is not None and accuracy <= SURVEY_ACCURACY:
        return SURVEY_HEADING_ERROR
    return HEADING_ERROR


def _sigma(distance, accuracy, error=HEADING_ERROR):
    """Écart latéral probable d'une visée (m) : erreur de visée et position GPS."""
    lateral = max(distance, 0.0) * math.tan(math.radians(error))
    return max(math.hypot(lateral, accuracy), 0.05)


def _normal(rays, weights):
    """Normales pondérées  Σ w (I - d dᵀ) : (a11, a12, a22, b1, b2)."""
    a11 = a12 = a22 = b1 = b2 = 0.0
    for (px, py, dx, dy), w in zip(rays, weights):
        m11, m12, m22 = w * (1 - dx * dx), w * (-dx * dy), w * (1 - dy * dy)
        a11 += m11
        a12 += m12
        a22 += m22
        b1 += m11 * px + m12 * py
        b2 += m12 * px + m22 * py
    return a11, a12, a22, b1, b2


def _distances(rays, x, y):
    """Position du point le long de chaque visée (m)."""
    return [(x - px) * dx + (y - py) * dy for px, py, dx, dy in rays]


def _inverse3(m):
    """Inverse d'une matrice 3 × 3 (liste de lignes), ou None si elle est singulière."""
    (a, b, c), (d, e, f), (g, h, i) = m
    co = [[e * i - f * h, c * h - b * i, b * f - c * e],
          [f * g - d * i, a * i - c * g, c * d - a * f],
          [d * h - e * g, b * g - a * h, a * e - b * d]]
    det = a * co[0][0] + b * co[1][0] + c * co[2][0]
    if abs(det) < 1e-12:
        return None
    return [[v / det for v in row] for row in co]


def _major_axis(c11, c12, c22):
    """Demi grand axe (racine de la plus grande valeur propre) d'une covariance 2 × 2."""
    half = (c11 + c22) / 2.0
    return math.sqrt(max(half + math.sqrt(max(half * half - (c11 * c22 - c12 * c12), 0.0)), 0.0))


def _ground_at(sightings, x, y, origin):
    """Altitude du sol au point (x, y) : celle sous les photos, prolongée le long de leur
    alignement (pente de la route), ou leur moyenne si elles sont trop proches."""
    pts = [(*_local(s["lon"], s["lat"], *origin), s["ground"]) for s in sightings]
    a = max(((p, q) for p in pts for q in pts), key=lambda pq: math.hypot(pq[1][0] - pq[0][0], pq[1][1] - pq[0][1]))
    (x1, y1, z1), (x2, y2, z2) = a
    length = math.hypot(x2 - x1, y2 - y1)
    if length < 1.0:
        return sum(p[2] for p in pts) / len(pts)
    t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / length ** 2
    return z1 + t * (z2 - z1)


def solve3d(sightings, ground=False):
    """Intersection des visées dans l'espace (voir l'en-tête du module). sightings : comme
    solve, avec en plus "elev" (inclinaison corrigée, degrés), "alt" (altitude de la caméra,
    m), "elev_error" (incertitude de l'inclinaison calée, degrés, ou None) et, pour ground,
    "ground" (altitude du sol sous la photo, m). Retourne (x, y, z, covariance 3 × 3, distances
    horizontales, repère (lon0, lat0)) ou None si les visées ne fixent pas le point."""
    lon0 = sum(s["lon"] for s in sightings) / len(sightings)
    lat0 = sum(s["lat"] for s in sightings) / len(sightings)
    rays = []
    for s in sightings:
        px, py = _local(s["lon"], s["lat"], lon0, lat0)
        h, e = math.radians(s["heading"]), math.radians(s["elev"])
        d = (math.sin(h) * math.cos(e), math.cos(h) * math.cos(e), math.sin(e))
        side = (math.cos(h), -math.sin(h), 0.0)  # écart latéral, horizontal
        up = (d[1] * side[2] - d[2] * side[1], d[2] * side[0] - d[0] * side[2], d[0] * side[1] - d[1] * side[0])
        elev_error = math.hypot(s["elev_error"] if s.get("elev_error") is not None else ELEV_ERROR, CLICK_ERROR)
        accuracy = GPS_ACCURACY if s.get("accuracy") is None else float(s["accuracy"])
        rays.append(((px, py, float(s["alt"])), d, side, up, heading_error(s), accuracy, elev_error))
    point = None
    for _ in range(ITERATIONS):
        a = [[0.0] * 3 for _ in range(3)]
        b = [0.0] * 3
        for p, d, side, up, herr, acc, eerr in rays:
            t = 10.0 if point is None else max(sum((point[k] - p[k]) * d[k] for k in range(3)), 0.5)
            w_side = 1.0 / _sigma(t, acc, herr) ** 2
            w_up = 1.0 / max(math.hypot(t * math.tan(math.radians(eerr)), ALT_ERROR), 0.01) ** 2
            for i in range(3):
                for j in range(3):
                    m = w_side * side[i] * side[j] + w_up * up[i] * up[j]
                    a[i][j] += m
                    b[i] += m * p[j]
        if ground:  # altitude du point : celle du sol tirée des photos
            z = _ground_at(sightings, *(point[:2] if point else (0.0, 0.0)), (lon0, lat0))
            a[2][2] += 1.0 / GROUND_ERROR ** 2
            b[2] += z / GROUND_ERROR ** 2
        inv = _inverse3(a)
        if inv is None:
            return None
        point = [sum(inv[i][j] * b[j] for j in range(3)) for i in range(3)]
    # Distance horizontale du point à chaque photo, le long de la visée
    distances = [((point[0] - p[0]) * d[0] + (point[1] - p[1]) * d[1]) / max(math.hypot(d[0], d[1]), 1e-9)
                 for p, d, *_ in rays]
    return point[0], point[1], point[2], inv, distances, (lon0, lat0)


def usable3d(sightings, ground=False):
    """Les visées se prêtent-elles au calcul 3D : inclinaison et altitude de caméra connues
    pour toutes (et sol sous la photo pour un point au sol) ?"""
    keys = ("elev", "alt", "ground") if ground else ("elev", "alt")
    return all(s.get(k) is not None for s in sightings for k in keys)


def solve(sightings, ground=False):
    """Intersection des visées.

    sightings : liste de dicts avec au moins "lon", "lat", "heading", et
    éventuellement "accuracy" (précision de la position GPS en m, None si inconnue)
    "precise" (cap au centième de degré), "heading_error" (voir heading_error) et
    "sequence" (erreurs communes aux photos d'une même séquence).
    Retourne un dict : lon, lat, distances (m, une par visée), angle (° de
    croisement le plus favorable), rms (écart moyen des visées au point, m),
    uncertainty (rayon d'incertitude en m pour l'erreur de visée de chaque photo et la
    précision GPS), gps (précision GPS la moins bonne, m), gps_assumed (vrai si
    au moins une photo n'indique pas sa précision, GPS_ACCURACY est alors supposé).
    En 3D (voir solve3d, usable3d) : aussi z (altitude du point, m) ; method vaut "3d" ou
    "plan". ground : point au sol (sa profondeur se fixe aussi par l'altitude du sol).
    Lève TriangulationError si les visées ne permettent pas de conclure.
    """
    if len(sightings) < 2:
        raise TriangulationError("Il faut au moins deux visées.")
    lon0 = sum(s["lon"] for s in sightings) / len(sightings)
    lat0 = sum(s["lat"] for s in sightings) / len(sightings)

    angle = max(crossing_angle(a["heading"], b["heading"])
                for i, a in enumerate(sightings) for b in sightings[i + 1:])
    if usable3d(sightings, ground):
        found = solve3d(sightings, ground)
        if found is not None:
            return _result3d(sightings, found, angle)
    if angle < MIN_ANGLE:
        raise TriangulationError(
            "Visées presque parallèles ({:.0f}°) : visez l'objet depuis une photo plus "
            "décalée sur le côté.".format(angle))

    rays, accuracies, errors = [], [], []
    for s in sightings:
        px, py = _local(s["lon"], s["lat"], lon0, lat0)
        h = math.radians(s["heading"])
        rays.append((px, py, math.sin(h), math.cos(h)))
        accuracies.append(s.get("accuracy"))
        errors.append(heading_error(s))
    gps_assumed = any(a is None for a in accuracies)
    accuracies = [GPS_ACCURACY if a is None else float(a) for a in accuracies]

    # Normales  Σ w (I - d dᵀ) X = Σ w (I - d dᵀ) P ; première passe sans pondération,
    # puis poids recalculés à partir des distances au point trouvé.
    weights = [1.0] * len(rays)
    for _ in range(ITERATIONS):
        a11, a12, a22, b1, b2 = _normal(rays, weights)
        det = a11 * a22 - a12 * a12
        if abs(det) < 1e-9 * max(a11 + a22, 1e-12) ** 2:
            raise TriangulationError("Visées parallèles : impossible de les croiser.")
        x = (a22 * b1 - a12 * b2) / det
        y = (a11 * b2 - a12 * b1) / det
        weights = [1.0 / _sigma(t, acc, e) ** 2 for t, acc, e in zip(_distances(rays, x, y), accuracies, errors)]

    distances = _distances(rays, x, y)
    residuals = [abs((x - px) * dy - (y - py) * dx) for px, py, dx, dy in rays]  # écart perpendiculaire
    if min(distances) < 0.5:
        raise TriangulationError(
            "Les visées ne se croisent pas devant les photos : vérifiez que vous visez "
            "bien le même objet.")
    if max(distances) > MAX_DISTANCE:
        raise TriangulationError(
            "Point trouvé à plus de {:.0f} m : visées trop peu sécantes ou objets "
            "différents.".format(MAX_DISTANCE))

    # Incertitude : chaque visée est décalée latéralement d'environ _sigma (erreur de cap
    # et position GPS). Covariance du point = (Σ w (I - d dᵀ))⁻¹, w = 1 / décalage² ;
    # on garde le grand axe.
    weights = [1.0 / _sigma(t, acc, e) ** 2 for t, acc, e in zip(distances, accuracies, errors)]
    c11, c12, c22, _, _ = _normal(rays, weights)
    cdet = c11 * c22 - c12 * c12
    if cdet > 0:
        # Valeurs propres de l'inverse = inverses des valeurs propres : on prend la plus petite
        half = (c11 + c22) / 2.0
        smallest = half - math.sqrt(max(half * half - cdet, 0.0))
        uncertainty = 1.0 / math.sqrt(smallest) if smallest > 0 else float("inf")
    else:
        uncertainty = float("inf")

    # Photos d'une même séquence : leur décalage de position GPS et leur erreur de cap (fixation
    # de la caméra) sont presque les mêmes ; ils déplacent le point d'un bloc et ne se compensent
    # pas entre visées. L'incertitude ne descend pas sous cette part commune.
    sequences = {s.get("sequence") for s in sightings}
    if len(sequences) == 1 and None not in sequences:
        n = len(sightings)
        common = math.hypot(sum(accuracies) / n,
                            sum(distances) / n * math.tan(math.radians(sum(errors) / n)))
        uncertainty = max(uncertainty, common)

    lon, lat = _geographic(x, y, lon0, lat0)
    return {
        "lon": lon,
        "lat": lat,
        "z": None,
        "method": "plan",
        "distances": distances,
        "angle": angle,
        "rms": math.sqrt(sum(r * r for r in residuals) / len(residuals)),
        "uncertainty": uncertainty,
        "gps": max(accuracies),
        "gps_assumed": gps_assumed,
    }


def _result3d(sightings, found, angle):
    """Résultat de solve pour l'intersection dans l'espace (voir solve3d)."""
    x, y, z, cov, distances, (lon0, lat0) = found
    if min(distances) < 0.5:
        raise TriangulationError(
            "Les visées ne se croisent pas devant les photos : vérifiez que vous visez "
            "bien le même objet.")
    if max(distances) > MAX_DISTANCE:
        raise TriangulationError(
            "Point trouvé à plus de {:.0f} m : visées trop peu sécantes ou objets "
            "différents.".format(MAX_DISTANCE))
    accuracies = [GPS_ACCURACY if s.get("accuracy") is None else float(s["accuracy"]) for s in sightings]
    uncertainty = _major_axis(cov[0][0], cov[0][1], cov[1][1])
    sequences = {s.get("sequence") for s in sightings}
    if len(sequences) == 1 and None not in sequences:  # part commune aux photos d'une séquence (voir solve)
        n = len(sightings)
        uncertainty = max(uncertainty, sum(accuracies) / n)
    residuals = []
    for s in sightings:
        px, py = _local(s["lon"], s["lat"], lon0, lat0)
        h, e = math.radians(s["heading"]), math.radians(s["elev"])
        d = (math.sin(h) * math.cos(e), math.cos(h) * math.cos(e), math.sin(e))
        v = (x - px, y - py, z - float(s["alt"]))
        t = sum(v[k] * d[k] for k in range(3))
        residuals.append(math.sqrt(max(sum(c * c for c in v) - t * t, 0.0)))
    lon, lat = _geographic(x, y, lon0, lat0)
    return {
        "lon": lon,
        "lat": lat,
        "z": z,
        "method": "3d",
        "distances": distances,
        "angle": angle,
        "rms": math.sqrt(sum(r * r for r in residuals) / len(residuals)),
        "uncertainty": uncertainty,
        "gps": max(accuracies),
        "gps_assumed": any(s.get("accuracy") is None for s in sightings),
    }

