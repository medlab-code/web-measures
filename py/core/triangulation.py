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

Visées en 3D, seulement quand elles se croisent sous STRONG_ANGLE (au-delà, les caps fixent
bien le point, et une inclinaison un peu fausse ne ferait que le tirer de côté) : quand toutes
les photos ont une altitude de caméra vérifiée (RTK), chaque
visée garde aussi son inclinaison (élévation corrigée du calage) et devient une demi-droite
dans l'espace. Des photos prises les unes derrière les autres voient l'objet sous des
inclinaisons différentes : la profondeur, mal fixée par les seuls caps quand les visées sont
presque parallèles, l'est alors par les inclinaisons. Pour un point au sol (ground=True :
bord de chaussée, pied d'un objet), l'altitude du sol, tirée de celle des caméras moins leur
hauteur au-dessus du sol LiDAR, fixe encore la profondeur. Chaque visée pèse selon ses erreurs
latérale (cap, GPS) et verticale (inclinaison, altitude).

Calcul dans un plan tangent local (quelques centaines de mètres au plus) :
l'erreur due à la projection est négligeable devant la précision du GPS.
Module sans dépendance, testé seul (tests/coeur/).
"""

import math

# Ellipsoïde WGS 84 (celui des positions GPS) : demi-grand axe (m), carré de l'excentricité
WGS84_A = 6378137.0
WGS84_E2 = 0.00669437999014
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
GROUND_SLOPE_ERROR = 0.02  # erreur de pente du sol prolongé au-delà des photos (m par m)
LIDAR_ERROR = 0.08  # altitude du MNT LiDAR HD lue au point : précision, lissage de la grille de 50 cm (m)
RGE_ALTI_ERROR = 0.30  # altitude du RGE ALTI (1 m), en secours du LiDAR HD : moins précis par endroits (m)
# Part commune de l'erreur d'inclinaison des photos d'une séquence (degrés), qui ne se compense
# pas entre visées : systématique du calage (photo calée), tangage de la fixation sinon
COMMON_TILT = 0.1
# Le calcul 3D ne sert que pour des visées qui se croisent sous STRONG_ANGLE (degrés) : au-delà,
# les caps suffisent, et une inclinaison un peu fausse ne ferait que déplacer le point
STRONG_ANGLE = 20.0
WEAK_ANGLE = 15.0
SIGHT_WARNING = 0.6  # m : désaccord des visées d'un bord en travers de la route au-delà duquel les réviser (voir sight_spread)
LIDAR_NAME = "LiDAR HD"
SPREAD_WARNING = 3.0  # visée écartée du point de plus de 3 fois son erreur attendue : autre objet visé ?  # croisement en dessous duquel, en plan, la profondeur devient imprécise (degrés)


class TriangulationError(ValueError):
    """Visées inexploitables (message destiné à l'utilisateur)."""


def _radii(lat0):
    """Mètres par radian vers l'est (rayon du parallèle) et vers le nord (rayon de courbure du
    méridien) à la latitude lat0, sur l'ellipsoïde WGS 84. Une sphère de rayon moyen (6 371 km)
    faussait les longueurs de 0,3 % en est-ouest et de 0,05 % en nord-sud vers 47° N."""
    s2 = math.sin(math.radians(lat0)) ** 2
    w = 1.0 - WGS84_E2 * s2
    return (WGS84_A / math.sqrt(w) * math.cos(math.radians(lat0)),
            WGS84_A * (1.0 - WGS84_E2) / (w * math.sqrt(w)))


def _local(lon, lat, lon0, lat0):
    """Coordonnées métriques (est, nord) autour de (lon0, lat0), dans le plan tangent à l'ellipsoïde."""
    east, north = _radii(lat0)
    return (east * math.radians(lon - lon0), north * math.radians(lat - lat0))


def _geographic(x, y, lon0, lat0):
    """Inverse de _local."""
    east, north = _radii(lat0)
    return (lon0 + math.degrees(x / east), lat0 + math.degrees(y / north))


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


def projected(point, gx, gy):
    """Écart probable (m) de gx·x + gy·y pour un point triangulé (dict avec "uncertainty" et, s'il en a,
    "cov" : covariance horizontale c11, c12, c22). Sans covariance (point posé d'un clic) : erreur de
    même taille dans toutes les directions."""
    cov = point.get("cov")
    if not cov:
        return point["uncertainty"] * math.hypot(gx, gy)
    return math.sqrt(max(gx * gx * cov[0] + 2 * gx * gy * cov[1] + gy * gy * cov[2], 0.0))


def sight_spread(sightings, lon, lat, ground_z, ux, uy):
    """Désaccord des visées d'un point au sol dans la direction (ux, uy), m : plus grand écart au point
    (lon, lat), dans cette direction, de l'endroit où chaque visée touche le sol. Sur un bord, qui n'a pas de
    repère le long de son tracé, c'est le signe de visées tombées à des endroits différents, que leur
    croisement ne montre pas. ground_z : altitude du sol lue au point (voir solve_on_ground), LiDAR HD
    seulement : l'altitude tirée des visées absorberait leur désaccord, le RGE ALTI est trop imprécis. 0 si les
    visées ne permettent pas d'en juger : moins de deux, sans cette altitude, sans inclinaison calée
    (l'erreur d'inclinaison y dominerait), ou presque à l'horizon."""
    if not ground_z or len(sightings) < 2 or (len(ground_z) > 4 and ground_z[4] != LIDAR_NAME):
        return 0.0
    z = ground_z[2]
    worst = 0.0
    for s in sightings:
        elev, alt = s.get("elev"), s.get("alt")
        if s.get("elev_error") is None or elev is None or alt is None or elev > -0.5 or alt <= z:
            return 0.0
        d, h = (alt - z) / math.tan(math.radians(-elev)), math.radians(s["heading"])
        x, y = _local(s["lon"], s["lat"], lon, lat)
        worst = max(worst, abs((x + d * math.sin(h)) * ux + (y + d * math.cos(h)) * uy))
    return worst


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
    """Altitude du sol au point (x, y) tirée des photos, et son erreur (m) : sol sous les
    photos prolongé le long de leur alignement (pente de la route), ou leur moyenne si elles
    sont trop proches. L'erreur cumule le dévers (GROUND_ERROR), la dispersion de la hauteur
    de caméra de la séquence ("ground_spread", voir precision.verify_heights) et le
    prolongement au-delà des photos."""
    pts = [(*_local(s["lon"], s["lat"], *origin), s["ground"]) for s in sightings]
    spread = max((float(s.get("ground_spread") or 0.0) for s in sightings), default=0.0)
    a = max(((p, q) for p in pts for q in pts), key=lambda pq: math.hypot(pq[1][0] - pq[0][0], pq[1][1] - pq[0][1]))
    (x1, y1, z1), (x2, y2, z2) = a
    length = math.hypot(x2 - x1, y2 - y1)
    if length < 1.0:
        beyond = min(math.hypot(x - p[0], y - p[1]) for p in pts)
        return sum(p[2] for p in pts) / len(pts), math.hypot(GROUND_ERROR, spread, GROUND_SLOPE_ERROR * beyond)
    t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / length ** 2
    beyond = max(0.0, -t, t - 1.0) * length
    return z1 + t * (z2 - z1), math.hypot(GROUND_ERROR, spread, GROUND_SLOPE_ERROR * beyond)


def solve3d(sightings, ground=False, ground_z=None):
    """Intersection des visées dans l'espace (voir l'en-tête du module). sightings : comme
    solve, avec en plus "elev" (inclinaison corrigée, degrés), "alt" (altitude de la caméra,
    m), "elev_error" (incertitude de l'inclinaison calée, degrés, ou None) et, pour ground,
    "ground" (altitude du sol sous la photo, m). ground_z : altitude du sol lue au point (m),
    plus sûre que le sol tiré des photos : nombre (MNT LiDAR HD, ±LIDAR_ERROR) ou (altitude,
    incertitude en m) pour une autre source. Retourne (x, y, z, covariance 3 × 3,
    distances horizontales, repère (lon0, lat0)) ou None si les visées ne fixent pas le point."""
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
        if ground:  # altitude du point : celle du sol, au point (LiDAR) ou tirée des photos
            if isinstance(ground_z, tuple):
                z, sigma = float(ground_z[0]), float(ground_z[1])
            elif ground_z is not None:
                z, sigma = float(ground_z), LIDAR_ERROR
            else:
                z, sigma = _ground_at(sightings, *(point[:2] if point else (0.0, 0.0)), (lon0, lat0))
            a[2][2] += 1.0 / sigma ** 2
            b[2] += z / sigma ** 2
        inv = _inverse3(a)
        if inv is None:
            return None
        point = [sum(inv[i][j] * b[j] for j in range(3)) for i in range(3)]
    # Distance horizontale du point à chaque photo, le long de la visée
    distances = [((point[0] - p[0]) * d[0] + (point[1] - p[1]) * d[1]) / max(math.hypot(d[0], d[1]), 1e-9)
                 for p, d, *_ in rays]
    return point[0], point[1], point[2], inv, distances, (lon0, lat0)


def usable3d(sightings, ground=False, ground_z=None):
    """Les visées se prêtent-elles au calcul 3D : inclinaison et altitude de caméra connues
    pour toutes (et, pour un point au sol sans altitude lue au point, sol sous la photo) ?"""
    keys = ("elev", "alt", "ground") if ground and ground_z is None else ("elev", "alt")
    return all(s.get(k) is not None for s in sightings for k in keys)


def solve(sightings, ground=False, ground_z=None):
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
    spread : plus grand écart d'une visée au point, rapporté à son erreur attendue (cap, GPS).
    En 3D (voir solve3d, usable3d) : aussi z (altitude du point, m), common_tilt (part de
    l'incertitude due à l'inclinaison commune aux photos d'une séquence, m) ; method vaut "3d" ou
    "plan" ; ground_source vaut "lidar" (ground_z, altitude du MNT LiDAR HD lue au point),
    "photos" (sol sous les photos) ou None. ground : point au sol (sa profondeur se fixe aussi
    par l'altitude du sol).
    Lève TriangulationError si les visées ne permettent pas de conclure.
    """
    if len(sightings) < 2:
        raise TriangulationError("Il faut au moins deux visées.")
    lon0 = sum(s["lon"] for s in sightings) / len(sightings)
    lat0 = sum(s["lat"] for s in sightings) / len(sightings)

    angle = max(crossing_angle(a["heading"], b["heading"])
                for i, a in enumerate(sightings) for b in sightings[i + 1:])
    if angle < STRONG_ANGLE and usable3d(sightings, ground, ground_z):
        found = solve3d(sightings, ground, ground_z)
        if found is not None:
            r = _result3d(sightings, found, angle)
            r["ground_source"] = ("lidar" if ground_z is not None else "photos") if ground else None
            r["common_tilt"] = _common_tilt(sightings, found, ground, ground_z)
            r["uncertainty"] = math.hypot(r["uncertainty"], r["common_tilt"])
            return r
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
    spread = max(r / _sigma(t, acc, e) for r, t, acc, e in zip(residuals, distances, accuracies, errors))
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
    cov = None
    if cdet > 0:
        cov = (c22 / cdet, -c12 / cdet, c11 / cdet)
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
        "spread": spread,
        "z": None,
        "method": "plan",
        "ground_source": None,
        "distances": distances,
        "angle": angle,
        "rms": math.sqrt(sum(r * r for r in residuals) / len(residuals)),
        "uncertainty": uncertainty,
        "cov": cov,
        "gps": max(accuracies),
        "gps_assumed": gps_assumed,
    }


def _common_tilt(sightings, found, ground=False, ground_z=None):
    """Déplacement horizontal du point (m) quand l'inclinaison de toutes les visées d'une même
    séquence varie ensemble de ±COMMON_TILT (photo calée) ou ±ELEV_ERROR (non calée) : part
    commune de l'erreur d'inclinaison, que la pondération des visées, qui les suppose
    indépendantes, ne compte pas. Séquences différentes : parts indépendantes, cumulées."""
    x, y = found[0], found[1]
    total = 0.0
    for sequence in {s.get("sequence") for s in sightings}:
        worst = 0.0
        for sign in (-1, 1):
            shifted = [dict(s, elev=s["elev"] + sign * (COMMON_TILT if s.get("elev_error") is not None
                                                        else ELEV_ERROR))
                       if s.get("sequence") == sequence else s for s in sightings]
            moved = solve3d(shifted, ground, ground_z)
            if moved is None:
                return float("inf")
            worst = max(worst, math.hypot(moved[0] - x, moved[1] - y))
        total += worst * worst
    return math.sqrt(total)


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
    spread = max(r / _sigma(t, a, heading_error(s)) for r, t, a, s in zip(residuals, distances, accuracies, sightings))
    lon, lat = _geographic(x, y, lon0, lat0)
    return {
        "lon": lon,
        "lat": lat,
        "spread": spread,
        "z": z,
        "method": "3d",
        "distances": distances,
        "angle": angle,
        "rms": math.sqrt(sum(r * r for r in residuals) / len(residuals)),
        "uncertainty": uncertainty,
        "cov": (cov[0][0], cov[0][1], cov[1][1]),
        "gps": max(accuracies),
        "gps_assumed": any(s.get("accuracy") is None for s in sightings),
    }

