# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Calage des photos : correction d'inclinaison et recalage du cap.

- Inclinaison (par photo) : une caméra 360 est rarement parfaitement de niveau.
  On clique le pied puis le sommet d'objets verticaux (poteau, angle de façade) :
  chacun impose que la vraie verticale soit dans le plan qui contient la caméra
  et l'objet. Un objet corrige la pente vue de côté dans sa direction ; deux
  objets à peu près à angle droit corrigent l'inclinaison complète. Sans clic,
  l'inclinaison est calculée d'après les verticales de la photo (autotilt.py), ou à
  défaut estimée par la pente et le dévers du LiDAR HD sous le véhicule, quand la
  séquence a montré que la caméra penche avec lui (voir lidar_model).
- Hauteur de caméra (par séquence) : on mesure une longueur connue, au sol
  (trait de marquage, place de stationnement) ou en hauteur (objet de hauteur
  connue). Les longueurs mesurées étant à peu près proportionnelles à la
  hauteur de la caméra, on cherche celle qui redonne la longueur connue.
- Cap et position (par séquence, autour des photos utilisées) : on clique dans
  la photo un repère visible sur la carte, puis ce repère sur la carte. Les
  repères donnent, par relèvement, le décalage de cap et de position GPS des
  photos, chacun gardant son a priori (cap et position d'origine à leur
  précision) : un repère seul corrige surtout le cap, sans jamais le dégrader ;
  trois repères ou plus bien répartis autour de la photo recalent la position.

Directions : (cap absolu en degrés, 0 = nord, sens horaire ; élévation en
degrés). Les corrections s'appliquent dans cet ordre : inclinaison, puis cap.
Calage gardé dans le navigateur (clé « calage », src/app.js) d'une séance à l'autre, jusqu'à
ce qu'il soit refait ou effacé ; exportable et importable (fichier JSON, dossier de travail).
"""

import math

from . import ground
from .triangulation import _local, offset

OBJECT_ERROR = 0.2  # écart d'un objet vertical cliqué à la verticale vraie (degrés : clics, objet)
UNCALIBRATED = 2.0  # inclinaison d'une photo non calée (degrés) : 1 à 3° mesurés sur l'imajbox
MAX_TILT = 10.0  # au-delà, les clics sont sûrement faux (objet penché, pied/sommet inversés)
MIN_SPAN = 3.0  # écart d'élévation minimal entre pied et sommet (degrés)
MAX_LEAN = 30.0  # écart de cap maximal entre pied et sommet d'un même objet vertical
MAX_OFFSET = 20.0  # au-delà, le repère cliqué sur la carte n'est sûrement pas le bon
MIN_LANDMARK = 5.0  # distance minimale du repère (m)
AIM_ERROR = 0.1  # précision d'un clic dans la photo zoomée (degrés)
MAP_ERROR = 0.5  # précision de position du repère sur la carte (m)
DEFAULT_ACCURACY = 3.0  # précision GPS supposée quand la photo ne l'indique pas (m)
SURVEY_PRIOR = 0.5  # précision du cap d'origine, matériel de relevé (degrés)
PRIOR = 3.0  # précision du cap d'origine, autres appareils (boussole, trajectoire GPS)
REACH = 300.0  # portée du recalage (m) autour des photos qui l'ont servi : le GPS dérive au-delà
OUTLIER = 4.0  # un repère qui s'écarte de plus de OUTLIER écarts-types des autres est refusé
# Inclinaison estimée par le LiDAR HD : plan du sol ajusté sous le véhicule, sur une grille de
# LIDAR_ALONG m devant et derrière la caméra et LIDAR_ACROSS m à droite et à gauche (sous les
# roues) ; la grille atténue l'arrondi au centimètre des altitudes du service. Validé à
# Pouilly-en-Auxois (imajbox, 18 photos) : 0,4° d'écart en long et 0,5° en travers avec les
# verticales.
LIDAR_ALONG, LIDAR_ACROSS = 1.5, 0.8
LIDAR_GRID = [(a * LIDAR_ALONG, c * LIDAR_ACROSS) for a in (-1, -0.5, 0, 0.5, 1) for c in (-1, 0, 1)]
LIDAR_MIN_PHOTOS = 3  # photos de la séquence calées par leurs verticales pour valider le modèle
LIDAR_MAX_SIGMA = 0.8  # au-delà, la caméra ne suit pas le véhicule (portée à pied, stabilisée)
LIDAR_MIN_SIGMA = 0.3
# Confiance de l'inclinaison (tilt_confidence) : la source retenue et un témoin de l'autre famille (image / terrain) s'accordent
# quand leurs écarts de tangage et de roulis restent sous max(plancher, TILT_AGREE_K · racine(σ1² + σ2²)). Planchers : écarts
# médians observés entre image et terrain sur 33 photos (étude du 22/11/2026) : tangage 0,2 à 0,3° (au plus 1,07°), roulis 0,33 à
# 0,37° ; le roulis est moins bien connu côté terrain (dévers, défaut de campagne), d'où un plancher plus large.
TILT_AGREE_PITCH = 0.5  # degrés : plancher de l'écart de tangage toléré
TILT_AGREE_ROLL = 0.7  # degrés : plancher de l'écart de roulis toléré
TILT_AGREE_PITCH_MAX = 1.0  # degrés : plafond du seuil de tangage (au-delà, l'accord ne garantit plus une mesure utile)
TILT_AGREE_ROLL_MAX = 1.2  # degrés : plafond du seuil de roulis (même raison : la route seule annonce ±1° et ouvrirait le seuil à 2°)
TILT_AGREE_K = 2.0  # le seuil suit l'incertitude annoncée des deux sources (deux écarts-types)
# Verticales tracées à la main : jugement de chacune (vertical_report). Une verticale fausse tire vers elle l'inclinaison qui sert à la
# juger : l'écart se mesure donc à un consensus robuste, la verticale vraie ajustée sur les verticales qui s'accordent (la meilleure
# des verticales vraies que donne chaque PAIRE de verticales, au sens d'une somme d'écarts tronqués à OUTLIER_FACTOR × JUDGE_FLOOR,
# puis réajustée sur celles qui s'y accordent). L'écart d'une verticale est l'angle entre son plan (caméra, pied, sommet) et ce
# consensus. Échelle de comparaison : 1,4826 × médiane des écarts (la médiane résiste à moins de la moitié de verticales fausses ;
# 1,4826 la met à l'échelle d'un écart-type), jamais sous JUDGE_FLOOR (clics faits à l'écran : OBJECT_ERROR et précision du clic,
# sinon des verticales très concordantes feraient juger « douteuse » la moins bonne). Douteuse au-delà de DOUBT_FACTOR échelles,
# aberrante au-delà de OUTLIER_FACTOR. Il faut JUDGE_MIN verticales pour trancher : avec 2, l'inclinaison passe exactement par les
# deux ; avec 3, les trois écarts sont les trois faces d'un même désaccord, et seule la plus éloignée peut être « douteuse »
# (au-delà de DOUBT_FACTOR × JUDGE_FLOOR), jamais « aberrante ».
JUDGE_FLOOR = 0.3  # degrés
DOUBT_FACTOR, OUTLIER_FACTOR = 2.0, 3.0
JUDGE_MIN = 4
MAD_SCALE = 1.4826


CAMERA_MIN, CAMERA_MAX = 0.3, 6.0  # plage de hauteurs de caméra admises (m)


def _fr(value, digits=1):
    return "{:.{}f}".format(value, digits).replace(".", ",")


class CalibrationError(ValueError):
    """Clics inexploitables (message destiné à l'utilisateur)."""


def vector(yaw, elev):
    """Vecteur unitaire (est, nord, haut) d'une direction."""
    y, e = math.radians(yaw), math.radians(elev)
    return (math.sin(y) * math.cos(e), math.cos(y) * math.cos(e), math.sin(e))


def angles(v):
    """Direction (cap, élévation) d'un vecteur."""
    x, y, z = v
    return math.degrees(math.atan2(x, y)) % 360, math.degrees(math.atan2(z, math.hypot(x, y)))


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _unit(v):
    n = math.sqrt(_dot(v, v))
    return (v[0] / n, v[1] / n, v[2] / n)


def tilt_from_verticals(verticals, prior=None):
    """Verticale vraie dans le repère de la photo, d'après des objets verticaux.

    verticals : liste de ((cap, élév.) du pied, (cap, élév.) du sommet).
    prior : (up, sigma en degrés), inclinaison déjà connue (calcul automatique) qui complète
    les objets cliqués : chaque objet ne corrige que la composante qu'il voit, l'autre reste
    celle de l'a priori.
    Retourne un dict : up (vecteur unitaire), tilt (degrés), toward (cap vers
    lequel le haut de la caméra penche), residual (écart moyen des objets à la
    verticale retenue, degrés, None avec un seul objet), partial (vrai si un
    seul objet ou des objets alignés, sans a priori : seule une composante est corrigée),
    sigma (incertitude, degrés, dans la direction la moins contrainte).
    """
    normals = []
    for bottom, top in verticals:
        if top[1] - bottom[1] < MIN_SPAN:
            raise CalibrationError("Cliquez d'abord le pied, puis le sommet de l'objet vertical, "
                                   "assez haut (au moins {:.0f}° plus haut).".format(MIN_SPAN))
        if abs((top[0] - bottom[0] + 540) % 360 - 180) > MAX_LEAN:
            raise CalibrationError("Le pied et le sommet ne semblent pas appartenir au même objet vertical.")
        normals.append(_unit(_cross(vector(*bottom), vector(*top))))
    # Verticale vraie (a, b, 1) : n·(a, b, 1) = 0 pour chaque objet, moindres carrés.
    # Un léger amortissement donne la plus petite correction compatible quand les objets
    # ne suffisent pas (un seul objet, ou objets dans la même direction).
    # Chaque objet pèse 1 / OBJECT_ERROR² ; l'a priori, 1 / sigma² sur chaque composante.
    w = 1.0 / math.radians(OBJECT_ERROR) ** 2
    a11 = a12 = a22 = r1 = r2 = 0.0
    for nx, ny, nz in normals:
        a11 += w * nx * nx
        a12 += w * nx * ny
        a22 += w * ny * ny
        r1 -= w * nx * nz
        r2 -= w * ny * nz
    seen = (a11, a12, a22)  # information des seuls objets
    if prior is not None:
        pup, psigma = prior
        wp = 1.0 / math.radians(max(psigma, 0.01)) ** 2
        a11, a22 = a11 + wp, a22 + wp
        r1, r2 = r1 + wp * pup[0] / pup[2], r2 + wp * pup[1] / pup[2]
        damp = 0.0
    else:
        damp = 1e-6 * max(a11 + a22, 1e-12)
        a11, a22 = a11 + damp, a22 + damp
    det = a11 * a22 - a12 * a12
    a, b = (a22 * r1 - a12 * r2) / det, (a11 * r2 - a12 * r1) / det
    up = _unit((a, b, 1.0))
    tilt = math.degrees(math.acos(min(1.0, up[2])))
    if tilt > MAX_TILT:
        raise CalibrationError("Inclinaison trouvée de {:.0f}° : objet pas vraiment vertical ou clics "
                               "imprécis. Recommencez sur un autre objet.".format(tilt))
    # Partiel si les plans des objets se coupent mal (objets dans la même direction)
    s11, s12, s22 = seen
    partial = prior is None and (len(normals) < 2 or s11 * s22 - s12 * s12 < 0.1 * ((s11 + s22) / 2) ** 2)
    lam = (a11 + a22) / 2 - math.sqrt(((a11 - a22) / 2) ** 2 + a12 * a12)  # moins contrainte
    residual = None
    if len(normals) > 1:
        residual = math.degrees(math.sqrt(sum(math.asin(min(1.0, abs(_dot(n, up)))) ** 2
                                              for n in normals) / len(normals)))
    sigma = UNCALIBRATED if partial else math.degrees(1.0 / math.sqrt(max(lam, 1e-12)))
    if residual is not None and not partial:
        sigma = max(sigma, residual / math.sqrt(len(normals)))
    return {"up": up, "tilt": tilt, "toward": math.degrees(math.atan2(up[0], up[1])) % 360,
            "residual": residual, "partial": partial, "count": len(normals), "sigma": sigma}


def _median(values):
    values = sorted(values)
    n = len(values)
    return values[n // 2] if n % 2 else (values[n // 2 - 1] + values[n // 2]) / 2


def _normal(vertical):
    bottom, top = vertical
    return _unit(_cross(vector(*bottom), vector(*top)))


def _consensus(verticals, normals):
    """Verticale vraie (vecteur) sur laquelle s'accordent le plus de verticales, ou None sans paire exploitable (voir
    JUDGE_FLOOR) : meilleure paire au sens d'une somme d'écarts tronqués, réajustée sur les verticales qui s'y accordent."""
    cap = OUTLIER_FACTOR * JUDGE_FLOOR

    def gaps(up):
        return [math.degrees(math.asin(min(1.0, abs(_dot(n, up))))) for n in normals]

    best = None
    for i in range(len(verticals)):
        for j in range(i + 1, len(verticals)):
            try:
                pair = tilt_from_verticals([verticals[i], verticals[j]])
            except CalibrationError:
                continue
            if pair["partial"]:
                continue
            score = sum(min(g, cap) ** 2 for g in gaps(pair["up"]))
            if best is None or score < best[0]:
                best = (score, pair["up"])
    if best is None:
        return None
    inliers = [v for v, g in zip(verticals, gaps(best[1])) if g <= cap]
    if len(inliers) > 2:
        try:
            refined = tilt_from_verticals(inliers)
            if not refined["partial"]:
                return refined["up"]
        except CalibrationError:
            pass
    return best[1]


def vertical_report(verticals, heading=None):
    """Jugement des verticales tracées à la main sur une photo (voir JUDGE_FLOOR).

    verticals : liste de ((cap, élév.) du pied, (cap, élév.) du sommet), déjà validée par tilt_from_verticals.
    heading : cap du centre de l'image (degrés), pour donner l'inclinaison en tangage et roulis.
    Retourne un dict : count, tilt (dict de tilt_from_verticals), pitch et roll (degrés, avec heading : la verticale vraie penche
    de pitch vers l'avant et de roll vers la droite ; None sinon), scale (échelle de comparaison, degrés ou None sans jugement),
    rows (une par verticale, dans l'ordre : angle = angle de son plan avec la verticale de la caméra (signé), deviation = écart
    au consensus (degrés, None sans jugement possible), effect = de combien l'inclinaison changerait sans elle (degrés, None si
    c'était la seule), verdict : "bon", "douteux", "aberrante" ou None sans jugement), outliers (indices des aberrantes)."""
    tilt = tilt_from_verticals(verticals)
    n = len(verticals)
    normals = [_normal(v) for v in verticals]
    consensus = _consensus(verticals, normals) if n >= 3 else None
    angles_, deviations, effects = [], [], []
    for i in range(n):
        others = verticals[:i] + verticals[i + 1:]
        angles_.append(math.degrees(math.asin(max(-1.0, min(1.0, normals[i][2])))))
        effect = None
        if others:
            try:
                without = tilt_from_verticals(others)
                effect = math.degrees(math.acos(max(-1.0, min(1.0, _dot(tilt["up"], without["up"])))))
            except CalibrationError:
                pass
        effects.append(effect)
        deviations.append(None if consensus is None else math.degrees(math.asin(min(1.0, abs(_dot(normals[i], consensus))))))
    verdicts, scale = [None] * n, None
    if consensus is not None and n >= JUDGE_MIN:
        scale = max(JUDGE_FLOOR, MAD_SCALE * _median(deviations))
        for i, d in enumerate(deviations):
            verdicts[i] = "aberrante" if d > OUTLIER_FACTOR * scale else "douteux" if d > DOUBT_FACTOR * scale else "bon"
    elif consensus is not None:
        worst = max(range(n), key=lambda i: deviations[i])
        verdicts = ["bon"] * n
        if deviations[worst] > DOUBT_FACTOR * JUDGE_FLOOR:
            verdicts[worst] = "douteux"
    pitch = roll = None
    if heading is not None:
        pitch, roll = tilt_components(tilt["up"], heading)
    rows = [{"angle": angles_[i], "deviation": deviations[i], "effect": effects[i], "verdict": verdicts[i]} for i in range(n)]
    return {"count": n, "tilt": tilt, "pitch": pitch, "roll": roll, "scale": scale, "rows": rows,
            "outliers": [i for i, v in enumerate(verdicts) if v == "aberrante"]}


def tilt_entry(up, sigma, source, **more):
    """Inclinaison de la photo donnée par l'hôte (vue du dessus, verticales à seuil élargi, roulis par défaut de la campagne), sous la forme
    des autres sources (voir Calibration.tilt) : up (verticale vraie vue de la caméra [est, nord, haut]), sigma (degrés)."""
    up = _unit(tuple(float(v) for v in up))
    return dict({"up": up, "tilt": math.degrees(math.acos(min(1.0, up[2]))),
                 "toward": math.degrees(math.atan2(up[0], up[1])) % 360, "residual": None, "partial": False,
                 "count": None, "sigma": float(sigma), "source": source}, **more)


def tilt_components(up, heading):
    """(avant, droite) en degrés : de combien la verticale vraie, vue de la caméra, penche
    vers l'avant (cap `heading`) et vers la droite. Une caméra qui monte une pente de p° voit
    la verticale pencher de p° vers l'avant ; inclinée vers la gauche, vers la droite."""
    h = math.radians(heading)
    return (math.degrees(math.atan2(up[0] * math.sin(h) + up[1] * math.cos(h), up[2])),
            math.degrees(math.atan2(up[0] * math.cos(h) - up[1] * math.sin(h), up[2])))


def up_from_components(forward, right, heading):
    """Verticale vraie (repère de la photo) penchée de forward° vers l'avant et right° vers la
    droite (inverse de tilt_components)."""
    h = math.radians(heading)
    f, r = math.tan(math.radians(forward)), math.tan(math.radians(right))
    return _unit((f * math.sin(h) + r * math.cos(h), f * math.cos(h) - r * math.sin(h), 1.0))


def lidar_points(lon, lat, heading):
    """Points du sol où lire le LiDAR HD : grille LIDAR_GRID (en avant, à droite) autour de
    la caméra."""
    out = []
    for along, right in LIDAR_GRID:
        p = offset(lon, lat, heading, along) if along else (lon, lat)
        out.append(offset(p[0], p[1], heading + 90, right) if right else p)
    return out


def lidar_slopes(z):
    """(pente en long, dévers) en degrés du plan ajusté sur les altitudes des lidar_points
    (grille symétrique : les pentes sont des moyennes pondérées indépendantes). La verticale
    penche vers l'avant en montée, vers la droite quand la droite est plus haute."""
    sa = sum(a * h for (a, _), h in zip(LIDAR_GRID, z)) / sum(a * a for a, _ in LIDAR_GRID)
    sc = sum(c * h for (_, c), h in zip(LIDAR_GRID, z)) / sum(c * c for _, c in LIDAR_GRID)
    return math.degrees(math.atan(sa)), math.degrees(math.atan(sc))


def lidar_model(entries):
    """Modèle de la séquence : la caméra penche-t-elle avec le véhicule ? entries : inclinaisons
    automatiques des photos de la séquence (voir Calibration.auto). Retourne le décalage moyen
    (avant, droite) entre verticales et LiDAR (fixation de la caméra), l'écart-type sigma et le
    nombre de photos, ou None si trop peu de photos le vérifient ou si l'écart est trop grand."""
    diffs = []
    for e in entries:
        v, lidar = e.get("verticals"), e.get("lidar")
        if v and lidar:
            f, r = tilt_components(v["up"], e["heading"])
            diffs.append((f - lidar[0], r - lidar[1]))
    if len(diffs) < LIDAR_MIN_PHOTOS:
        return None
    n = len(diffs)
    mf, mr = sum(d[0] for d in diffs) / n, sum(d[1] for d in diffs) / n
    sigma = math.sqrt(sum((d[0] - mf) ** 2 + (d[1] - mr) ** 2 for d in diffs) / (2 * max(n - 1, 1)))
    if sigma > LIDAR_MAX_SIGMA:
        return None
    return {"offset": (mf, mr), "sigma": max(sigma, LIDAR_MIN_SIGMA), "count": n}


def tilt_family(source):
    """Famille d'une source d'inclinaison d'après son nom (le champ « source » de Calibration.tilt) : "image" (clics à la main,
    verticales, seuil élargi), "terrain" (LiDAR HD, route de la vue du dessus, terrain web), "constante" (roulis par défaut de la campagne :
    pas une mesure de la photo) ou "mixte" (clics complétés par le terrain : ni l'une ni l'autre). Seules deux familles sont
    indépendantes : image et terrain."""
    name = source or ""
    if name.startswith("roulis de campagne"):
        return "constante"
    image, terrain = name.startswith(("clics", "verticales")), any(k in name for k in ("lidar", "vue du dessus", "terrain"))
    if image and terrain:
        return "mixte"
    return "terrain" if terrain else "image"


def tilt_confidence(sources, retained, bridge=False):
    """Confiance de l'inclinaison retenue : fonction pure. sources : toutes les sources disponibles de la photo (voir
    Calibration.tilt_sources : dicts source (nom), family, sigma, pitch, roll en degrés) ; retained : l'inclinaison retenue (dict
    source, sigma, pitch, roll) ou None ; bridge : photo sur un pont. Retourne un dict :
    - state : "pont" (photo sur un pont : le terrain décrit le sol sous l'ouvrage, état propre même avec des verticales),
      "confirmee" (la source retenue et le meilleur témoin de l'AUTRE famille s'accordent), "desaccord", ou "non_verifiable"
      (aucun témoin de l'autre famille : une seule famille disponible, ou seulement une constante) ;
    - pair : (nom retenu, nom du témoin) ou None ; d_pitch, d_roll : écarts signés témoin − retenue ; limit_pitch, limit_roll :
      seuils appliqués (min(plafond, max(plancher, TILT_AGREE_K · racine(σ1² + σ2²)))) ; available : noms des sources disponibles.
    Le meilleur témoin est celui de plus petite incertitude parmi l'autre famille (image ou terrain seulement : le roulis de
    campagne est une constante). Écarts et seuils sont rendus aussi en cas d'accord ou de pont quand un témoin existe."""
    names = [s["source"] for s in sources]
    out = {"state": "non_verifiable", "pair": None, "d_pitch": None, "d_roll": None, "limit_pitch": None, "limit_roll": None,
           "available": names}
    if retained is None:
        return out
    mine = tilt_family(retained.get("source"))
    wanted = {"image": "terrain", "terrain": "image"}.get(mine)
    witnesses = [s for s in sources if s["family"] == wanted and s.get("pitch") is not None and s.get("roll") is not None
                 and s["source"] != retained.get("source")]
    if wanted and retained.get("pitch") is not None and retained.get("roll") is not None and witnesses:
        best = min(witnesses, key=lambda s: s["sigma"])
        spread = TILT_AGREE_K * math.hypot(float(retained.get("sigma") or 0.0), best["sigma"])
        out.update(pair=(retained["source"], best["source"]), d_pitch=best["pitch"] - retained["pitch"],
                   d_roll=best["roll"] - retained["roll"], limit_pitch=min(TILT_AGREE_PITCH_MAX, max(TILT_AGREE_PITCH, spread)),
                   limit_roll=min(TILT_AGREE_ROLL_MAX, max(TILT_AGREE_ROLL, spread)))
        if not bridge:
            agree = abs(out["d_pitch"]) <= out["limit_pitch"] and abs(out["d_roll"]) <= out["limit_roll"]
            out["state"] = "confirmee" if agree else "desaccord"
    if bridge:
        out["state"] = "pont"
    return out


def untilt(up, yaw, elev, inverse=False):
    """Direction corrigée : rotation qui ramène la verticale `up` au zénith. inverse : la
    rotation contraire, d'une direction vraie à la direction vue par la caméra penchée."""
    v = vector(yaw, elev)
    k = (up[1], -up[0], 0.0)  # up × zénith
    s = math.hypot(k[0], k[1])
    if s < 1e-12:
        return yaw % 360, elev
    k = (k[0] / s, k[1] / s, 0.0)
    c = up[2]
    if inverse:
        s = -s
    kxv, kv = _cross(k, v), _dot(k, v)
    r = tuple(v[i] * c + kxv[i] * s + k[i] * kv * (1 - c) for i in range(3))  # Rodrigues
    return angles(r)


def _reference_length(kind, camera_height, clicks):
    """Longueur mesurée (m) avec une hauteur de caméra donnée : distance entre deux
    points au sol ("ground") ou hauteur d'un objet, pied puis sommet ("height")."""
    if kind == "height":
        return ground.measure_height(camera_height, *clicks)["value"]
    ground_z = (clicks[0].get("profile") or ground.flat_profile())[0][1]  # même caméra pour les deux clics
    (_, p, z1), (_, q, z2) = (ground._ground_point(camera_height, c, ground_z) for c in clicks)
    x, y = _local(q[0], q[1], p[0], p[1])
    return math.sqrt(x * x + y * y + (z2 - z1) ** 2)


def _solve_height(kind, clicks, known):
    """Hauteur de caméra qui redonne la longueur connue (dichotomie : la longueur
    mesurée croît avec la hauteur de caméra)."""
    def excess(h):
        try:
            return _reference_length(kind, h, clicks) - known
        except ground.GroundError:
            return float("inf")  # point trop loin : caméra trop haute

    lo, hi = CAMERA_MIN, CAMERA_MAX
    if excess(lo) > 0:
        raise CalibrationError("Longueur mesurée trop grande même avec une caméra à {} m : vérifiez la "
                               "longueur connue et les clics.".format(str(CAMERA_MIN).replace(".", ",")))
    if excess(hi) < 0:
        raise CalibrationError("Longueur mesurée trop petite même avec une caméra à {} m : vérifiez la "
                               "longueur connue et les clics.".format(str(CAMERA_MAX).replace(".", ",")))
    for _ in range(40):
        mid = (lo + hi) / 2.0
        if excess(mid) > 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2.0


def camera_height(kind, clicks, known, tilt_sigma=None):
    """Hauteur de caméra (m) et son incertitude, d'après une longueur connue.

    kind : "ground" (deux clics au sol) ou "height" (pied au sol, puis sommet) ;
    clicks : dicts avec elev (corrigée de l'inclinaison), yaw, lon, lat, profile.
    L'incertitude combine (somme quadratique) l'inclinaison de la photo, commune aux deux
    clics (tilt_sigma degrés, UNCALIBRATED par défaut), et la visée de chaque clic (AIM_ERROR).
    """
    if known <= 0:
        raise CalibrationError("Indiquez la longueur connue.")
    if kind == "height" and clicks[0].get("pic") != clicks[1].get("pic"):
        raise CalibrationError("Le pied et le sommet doivent être cliqués sur la même photo.")
    try:
        h = _solve_height(kind, clicks, known)
    except ground.GroundError as exc:
        raise CalibrationError(str(exc))
    tilt_sigma = UNCALIBRATED if tilt_sigma is None else tilt_sigma
    groups = []
    for north, east in ((tilt_sigma, 0.0), (0.0, tilt_sigma)):
        variants = []
        for sign in (-1, 1):
            up = up_from_components(sign * north, sign * east, 0.0)
            variants.append([dict(c, **dict(zip(("yaw", "elev"), untilt(up, c["yaw"], c["elev"])))) for c in clicks])
        groups.append(variants)
    for i in range(len(clicks)):
        variants = []
        for sign in (-1, 1):
            moved = [dict(c) for c in clicks]
            moved[i]["elev"] += sign * AIM_ERROR
            variants.append(moved)
        groups.append(variants)
    total = 0.0
    for variants in groups:
        worst = 0.0
        for moved in variants:
            try:
                worst = max(worst, abs(_solve_height(kind, moved, known) - h))
            except (CalibrationError, ground.GroundError):
                worst = max(worst, h)  # référence trop loin pour être fiable
        total += worst * worst
    return h, max(math.sqrt(total), 0.005)


class Calibration:
    """Calages : inclinaison par photo ; cap, position et hauteur de caméra par séquence.

    Seules les observations sont conservées (clics et repères) : les corrections en sont
    recalculées. to_dict / load permettent de les enregistrer (dans le navigateur), merge
    d'y ajouter un calage enregistré ailleurs (fichier importé) ;
    `changed`, s'il est défini, est appelé après chaque modification.
    """

    FORMAT = 1  # version du format enregistré

    def __init__(self):
        self.verticals = {}  # pic -> [((cap, élév.) pied, (cap, élév.) sommet)]
        self.landmarks = {}  # séquence -> [dicts : pic, lon, lat, yaw, elev, mlon, mlat, accuracy, prior]
        # séquence -> calages de la hauteur de caméra : dicts kind, known, clicks (clics bruts,
        # recalculés avec le calage actuel, voir camera), ou (hauteur, incertitude) enregistrés
        # par une version précédente (valeur figée)
        self.heights = {}
        self._cameras = {}  # séquence -> hauteur recalculée (cache, vidé à chaque modification)
        # pic -> inclinaison automatique : sequence, heading (cap du centre de l'image),
        # verticals (up, count, sigma : d'après les verticales de la photo, ou None), lidar
        # ((pente, dévers) en degrés sous le véhicule, ou None)
        self.auto = {}
        # photos dont l'utilisateur a écarté le calcul automatique par les verticales (« Réinitialiser » du panneau « Calage
        # manuel ») : tilt passe alors à la source suivante de son ordre (voir auto_tilt, tilt) ; enregistré avec le calage
        self.auto_off = set()
        self._tilts = {}
        # Sources d'inclinaison de l'hôte (pic -> tilt_entry ou None), consultées par tilt dans son ordre unique : le réglage
        # de la vue du dessus pour la photo (en premier), les verticales à seuil élargi, le roulis par défaut de la campagne seul (en dernier)
        self.ground_tilt = None
        self.loose_tilt = None
        self.campaign_tilt = None
        self.route_tilt = None  # route de la vue du dessus annoncée même quand les verticales priment (tilt_sources seulement)
        self._models = {}  # séquence -> lidar_model (cache)
        self.lidar = True  # False sur un pont (case « Sur un pont ») : pente du terrain sous l'ouvrage, pas celle du tablier
        # Photos situées sur un pont d'après la BD TOPO (set_bridge_photo, connu dès l'ouverture de la photo, même hors mesure) :
        # leur LiDAR (brut ou modèle) n'est jamais retenu, et elles n'entrent pas dans le modèle de leur séquence
        self.bridge_pics = set()
        self.changed = None

    def _notify(self):
        self._cameras = {}  # l'inclinaison ou le cap ont pu changer : hauteurs à recalculer
        if self.changed is not None:
            self.changed()

    # Enregistrement --------------------------------------------------------
    def to_dict(self):
        return {
            "format": self.FORMAT,
            "verticals": {pic: [[list(b), list(t)] for b, t in v] for pic, v in self.verticals.items()},
            "landmarks": self.landmarks,
            "heights": {seq: [o if isinstance(o, dict) else list(o) for o in obs] for seq, obs in self.heights.items()},
            "auto": self.auto,
            "auto_off": sorted(self.auto_off),
            "bridge_pics": sorted(self.bridge_pics),
        }

    def load(self, data):
        """Remplace le calage par celui enregistré (dict de to_dict, ou None : calage vide).
        Les entrées illisibles sont ignorées. Ne déclenche pas `changed`."""
        self.verticals, self.landmarks, self.heights, self._tilts = {}, {}, {}, {}
        self.auto, self._models, self._cameras, self.auto_off = {}, {}, {}, set()
        self.bridge_pics = set()
        if not isinstance(data, dict) or data.get("format") != self.FORMAT:
            return
        keys = ("pic", "lon", "lat", "yaw", "elev", "mlon", "mlat", "accuracy", "prior")
        try:
            for pic, verticals in (data.get("verticals") or {}).items():
                verticals = [((float(b[0]), float(b[1])), (float(t[0]), float(t[1]))) for b, t in verticals]
                try:
                    self._tilts[pic] = tilt_from_verticals(verticals)
                    self.verticals[pic] = verticals
                except CalibrationError:
                    pass
            for seq, obs in (data.get("landmarks") or {}).items():
                obs = [{k: (o[k] if k == "pic" else float(o[k])) for k in keys} for o in obs]
                if obs:
                    self.landmarks[seq] = obs
            for seq, obs in (data.get("heights") or {}).items():
                obs = [o for o in (_height_obs(o) for o in obs) if o is not None]
                if obs:
                    self.heights[seq] = obs
            for pic, entry in (data.get("auto") or {}).items():
                entry = _auto_entry(entry)
                if entry:
                    self.auto[pic] = entry
            self.auto_off = {p for p in (data.get("auto_off") or []) if isinstance(p, str)}
            self.bridge_pics = {p for p in (data.get("bridge_pics") or []) if isinstance(p, str)}
        except (TypeError, ValueError, KeyError, IndexError, AttributeError):
            pass  # format abîmé : on garde ce qui a pu être lu

    def merge(self, data):
        """Ajoute le calage enregistré `data` (dict de to_dict) pour les photos et séquences
        qui n'en ont pas encore : le calage en cours, plus récent, l'emporte. Ne déclenche pas
        `changed`. Retourne le nombre de photos et séquences ajoutées."""
        other = Calibration()
        other.load(data)
        added = 0
        for mine, theirs in ((self.verticals, other.verticals), (self.landmarks, other.landmarks),
                             (self.heights, other.heights), (self.auto, other.auto)):
            for key, obs in theirs.items():
                if key not in mine:
                    mine[key] = obs
                    added += 1
        for pic, tilt in other._tilts.items():
            self._tilts.setdefault(pic, tilt)
        self.auto_off |= other.auto_off
        self.bridge_pics |= other.bridge_pics
        self._models, self._cameras = {}, {}
        return added

    # Inclinaison ---------------------------------------------------------
    def add_vertical(self, pic, bottom, top):
        verticals = self.verticals.get(pic, []) + [(bottom, top)]
        result = tilt_from_verticals(verticals)  # lève CalibrationError sans rien garder
        self.verticals[pic], self._tilts[pic] = verticals, result
        self._notify()
        return result

    def tilt(self, pic, photo_only=False):
        """Inclinaison de la photo (dict de tilt_from_verticals, avec sigma en degrés), ou None : l'ordre de priorité UNIQUE des
        mesures dans la visionneuse. Dans l'ordre :
        1. réglée dans la vue du dessus pour cette photo (hôte, `ground_tilt` : "vue du dessus", "vue du dessus (réglée à la
           main)"), qui contient déjà le roulis par défaut de la campagne ;
        2. calée à la main sur deux objets ou plus (source "clics") ; sur un objet, complétée par la suite de la liste
           ("clics + verticales", "clics + lidar"…) ;
        3. calculée d'après les verticales de la photo ("verticales"), sauf si l'utilisateur l'a écartée pour cette photo (auto_off) ;
        4. estimée par le LiDAR HD ("lidar"), jamais sur un pont (case « Sur un pont » ou photo marquée par set_bridge_photo : le
           LiDAR décrit le sol sous l'ouvrage, pas le tablier), ou par le terrain (option de l'hôte : "terrain web") ;
        5. verticales à seuil élargi (hôte, `loose_tilt`, incertitude au-delà de autotilt.MAX_SIGMA : "verticales (seuil
           élargi)"), sauf auto_off comme le rang 3 ;
        6. roulis par défaut de la campagne seul (hôte, `campaign_tilt`, "roulis de campagne") : tangage inconnu, incertitude UNCALIBRATED,
           repérée par "fallback" (pas une inclinaison calée) ;
        7. rien : None (UNCALIBRATED).
        photo_only : seulement ce qui vient de la photo (rangs 2 à 4), sans les sources 1, 5 et 6 de l'hôte (la vue du dessus
        s'appuie sur ce qu'elle ne produit pas elle-même)."""
        if not photo_only:
            ground = self.ground_tilt(pic) if self.ground_tilt else None
            if ground:
                return ground
        manual, auto = self._tilts.get(pic), self.auto_tilt(pic)
        if manual and not manual["partial"]:
            return dict(manual, source="clics")
        if auto is None and not photo_only:
            hooks = [self.campaign_tilt] if pic in self.auto_off else [self.loose_tilt, self.campaign_tilt]  # seuil élargi : verticales
            auto = next((t for t in (hook(pic) for hook in hooks if hook) if t), None)
        if manual:
            if auto is None:
                return dict(manual, source="clics")
            combined = tilt_from_verticals(self.verticals[pic], (auto["up"], auto["sigma"]))
            return dict(combined, source="clics + " + auto["source"])
        return auto

    def tilt_sources(self, pic, heading=None):
        """Toutes les sources d'inclinaison disponibles de la photo, pas seulement la retenue par tilt : liste de dicts
        source (nom), family ("image", "terrain" ou "constante", voir tilt_family), up, sigma (degrés), et pitch, roll (degrés,
        si heading est donné). Sources : clics à la main (complets), verticales de la photo, verticales à seuil élargi (hôte,
        sans verticales), LiDAR HD par le modèle de la séquence, route de la vue du dessus (hôte, ground_tilt ; ou
        route_tilt, la route annoncée même quand les verticales priment), roulis par défaut de la campagne (hôte, constante). Le modèle LiDAR
        est calculé SANS la photo (leave-one-out : son décalage verticales − LiDAR ne contient pas ses propres verticales, sinon
        il les redonnerait et ne les vérifierait pas) ; jamais sur un pont (bridge_pics, case « Sur un pont »). Le LiDAR brut
        n'en est pas une : sans le décalage de monture appris sur la séquence, il n'est pas comparable."""
        out = []

        def add(name, up, sigma):
            entry = {"source": name, "family": tilt_family(name), "up": tuple(up), "sigma": float(sigma), "pitch": None, "roll": None}
            if heading is not None:
                entry["pitch"], entry["roll"] = tilt_components(entry["up"], heading)
            out.append(entry)

        manual = self._tilts.get(pic)
        if manual and not manual["partial"]:
            add("clics", manual["up"], manual["sigma"])
        entry = self.auto.get(pic) or {}
        v = None if pic in self.auto_off else entry.get("verticals")
        if v:
            add("verticales", v["up"], v["sigma"])
        elif pic not in self.auto_off and self.loose_tilt and (loose := self.loose_tilt(pic)):
            add(loose["source"], loose["up"], loose["sigma"])
        if self.lidar and pic not in self.bridge_pics and entry.get("lidar") and entry.get("sequence") is not None:
            model = lidar_model([e for p, e in self.auto.items()
                                 if p != pic and e.get("sequence") == entry["sequence"] and p not in self.bridge_pics])
            if model:
                f, r = entry["lidar"][0] + model["offset"][0], entry["lidar"][1] + model["offset"][1]
                add("lidar", up_from_components(f, r, entry["heading"]), model["sigma"])
        route = (self.route_tilt(pic) if self.route_tilt else None) or (self.ground_tilt(pic) if self.ground_tilt else None)
        if route:
            add(route["source"], route["up"], route["sigma"])
        campaign = self.campaign_tilt(pic) if self.campaign_tilt else None
        if campaign:
            add(campaign["source"], campaign["up"], campaign["sigma"])
        return out

    def confidence(self, pic, heading):
        """Confiance de l'inclinaison retenue de la photo (voir tilt_confidence), ou None sans inclinaison retenue (dict
        retained : source, sigma, pitch, roll de tilt)."""
        got = self.tilt(pic)
        if not got:
            return None
        pitch, roll = tilt_components(got["up"], heading)
        retained = {"source": got["source"], "sigma": got["sigma"], "pitch": pitch, "roll": roll}
        return dict(tilt_confidence(self.tilt_sources(pic, heading), retained, pic in self.bridge_pics), retained=retained)

    def manual_complete(self, pic):
        """Inclinaison calée à la main sur assez d'objets pour se passer du calcul automatique."""
        manual = self._tilts.get(pic)
        return bool(manual) and not manual["partial"]

    def auto_tilt(self, pic):
        """Inclinaison automatique de la photo (verticales, sinon LiDAR HD), ou None."""
        entry = self.auto.get(pic)
        if not entry:
            return None
        v = None if pic in self.auto_off else entry.get("verticals")  # écartées par l'utilisateur : LiDAR ensuite
        if v:
            up = tuple(v["up"])
            return {"up": up, "tilt": math.degrees(math.acos(min(1.0, up[2]))),
                    "toward": math.degrees(math.atan2(up[0], up[1])) % 360, "residual": None, "partial": False,
                    "count": v["count"], "sigma": v["sigma"], "source": "verticales"}
        # Sur un pont (case cochée, ou photo marquée par set_bridge_photo) : le LiDAR décrit le sol sous l'ouvrage, jamais retenu
        model = self.lidar_model(entry.get("sequence")) if self.lidar and pic not in self.bridge_pics else None
        if model and entry.get("lidar"):
            f = entry["lidar"][0] + model["offset"][0]
            r = entry["lidar"][1] + model["offset"][1]
            up = up_from_components(f, r, entry["heading"])
            return {"up": up, "tilt": math.hypot(f, r), "toward": math.degrees(math.atan2(up[0], up[1])) % 360,
                    "residual": None, "partial": False, "count": model["count"], "sigma": model["sigma"],
                    "source": "lidar"}
        return None

    def set_auto(self, pic, entry):
        """Inclinaison automatique de la photo (voir self.auto), enregistrée."""
        self.auto[pic] = entry
        self._models.pop(entry.get("sequence"), None)
        self._notify()

    def lidar_model(self, sequence):
        """Modèle LiDAR de la séquence (voir lidar_model), ou None."""
        if sequence is None:
            return None
        if sequence not in self._models:
            # photos sur un pont écartées : leur LiDAR (sol sous l'ouvrage) fausserait le décalage appris (verticales − LiDAR)
            self._models[sequence] = lidar_model([e for p, e in self.auto.items()
                                                  if e.get("sequence") == sequence and p not in self.bridge_pics])
        return self._models[sequence]

    def set_bridge_photo(self, pic, on):
        """Marque (on vrai) ou démarque la photo comme située sur un pont (BD TOPO, roads.on_bridge) : sa pente LiDAR n'est plus
        retenue (auto_tilt), ni apprise par le modèle de la séquence (lidar_model). Les verticales restent valables."""
        if (pic in self.bridge_pics) != bool(on):
            if on:
                self.bridge_pics.add(pic)
            else:
                self.bridge_pics.discard(pic)
            self._models = {}
            self._notify()

    def set_auto_off(self, pic, off):
        """Écarte (off vrai) ou rétablit le calcul automatique de l'inclinaison par les verticales de la photo : son rang 3 et le rang 5
        (verticales à seuil élargi) de tilt sont sautés, la source suivante prend le relais. Les verticales tracées à la main (rang 2)
        ne sont pas touchées."""
        if (pic in self.auto_off) != bool(off):
            if off:
                self.auto_off.add(pic)
            else:
                self.auto_off.discard(pic)
            self._models = {}
            self._notify()

    def clear_tilt(self, pic):
        self.verticals.pop(pic, None)
        self._tilts.pop(pic, None)
        self._notify()

    def vertical_report(self, pic, heading=None):
        """Jugement des verticales à la main de la photo (voir vertical_report), ou None sans verticale."""
        verticals = self.verticals.get(pic)
        return vertical_report(verticals, heading) if verticals else None

    def remove_verticals(self, pic, indices):
        """Retire les verticales n° `indices` (à partir de 0) de la photo ; l'inclinaison est recalculée avec les autres
        (plus aucune : comme clear_tilt). Lève CalibrationError, sans rien changer, si les restantes ne donnent plus
        d'inclinaison acceptable. Retourne le nombre retiré."""
        verticals = self.verticals.get(pic, [])
        drop = {i for i in indices if 0 <= i < len(verticals)}
        keep = [v for i, v in enumerate(verticals) if i not in drop]
        if not drop:
            return 0
        if not keep:
            self.clear_tilt(pic)
            return len(drop)
        result = tilt_from_verticals(keep)
        self.verticals[pic], self._tilts[pic] = keep, result
        self._notify()
        return len(drop)

    def clear_all_tilts(self):
        """Retire les verticales à la main de toutes les photos. Retourne le nombre de verticales retirées."""
        count = sum(len(v) for v in self.verticals.values())
        self.verticals, self._tilts = {}, {}
        if count:
            self._notify()
        return count

    def untilted(self, pic, yaw, elev):
        t = self.tilt(pic)
        return untilt(t["up"], yaw, elev) if t else (yaw % 360, elev)

    # Hauteur de caméra --------------------------------------------------------
    def add_camera_height(self, sequence, kind, clicks, known):
        """Calage de la hauteur de caméra sur une longueur connue (clics corrigés du calage
        actuel). Les clics bruts sont conservés : la hauteur est recalculée si l'inclinaison ou
        le cap de la photo changent ensuite (voir camera). Plus appelé par la page depuis le 16/10/2026 (calage de la
        hauteur retiré) : décrit la forme des hauteurs gardées, et sert aux essais."""
        h, sigma = camera_height(kind, clicks, known, self._tilt_sigma(clicks[0].get("pic")))
        keep = ("pic", "sequence", "lon", "lat", "gps", "raw", "yaw", "elev", "profile")
        obs = {"kind": kind, "known": float(known),
               "clicks": [{k: c[k] for k in keep if c.get(k) is not None} for c in clicks]}
        self.heights.setdefault(sequence, []).append(obs)
        self._notify()
        return {"height": h, "sigma": sigma}

    def _height_of(self, sequence, obs):
        """(hauteur, incertitude) d'un calage de la hauteur de caméra, avec le calage actuel."""
        if not isinstance(obs, dict):
            return tuple(obs)
        clicks = []
        for c in obs["clicks"]:
            if c.get("raw"):  # direction brute : corrigée du calage actuel
                lon, lat = c.get("gps") or (c["lon"], c["lat"])
                yaw, elev = self.correct(c.get("pic"), sequence, c["raw"][0], c["raw"][1], lon, lat)
            else:  # direction déjà corrigée, figée
                yaw, elev = c["yaw"], c["elev"]
            clicks.append(dict(c, yaw=yaw, elev=elev))
        try:
            return camera_height(obs["kind"], clicks, obs["known"], self._tilt_sigma(clicks[0].get("pic")))
        except (CalibrationError, ground.GroundError):
            return None

    def _tilt_sigma(self, pic):
        """Incertitude (degrés) de l'inclinaison de la photo, UNCALIBRATED sans calage."""
        t = self.tilt(pic) if pic else None
        return t["sigma"] if t and t.get("sigma") is not None else UNCALIBRATED

    def camera(self, sequence):
        """Hauteur de caméra calée de la séquence : dict height, sigma, count, legacy (calages
        d'une version précédente, figés), ou None."""
        obs_list = self.heights.get(sequence) or []
        key = (id(obs_list), len(obs_list))  # calages ajoutés ou remplacés directement
        if self._cameras.get(sequence, (None,))[0] == key:
            return self._cameras[sequence][1]
        values, legacy = [], 0
        for o in obs_list:
            v = self._height_of(sequence, o)
            if v is not None:
                values.append(v)
                legacy += not isinstance(o, dict)
        res = None
        if values:
            sw = sum(1.0 / s ** 2 for _, s in values)
            res = {"height": sum(h / s ** 2 for h, s in values) / sw, "sigma": 1.0 / math.sqrt(sw),
                   "count": len(values), "legacy": legacy}
        self._cameras[sequence] = (key, res)
        return res

    # Cap -------------------------------------------------------------------
    def add_landmark(self, sequence, pic, lon, lat, yaw, elev, mlon, mlat, accuracy, survey):
        """Repère : clic (cap, élév. bruts) depuis la photo en (lon, lat), repère en (mlon, mlat). Plus appelé par la
        page depuis le 16/10/2026 (calage du cap retiré) : décrit la forme des repères gardés, et sert aux essais."""
        obs = {"pic": pic, "lon": lon, "lat": lat, "yaw": yaw, "elev": elev, "mlon": mlon, "mlat": mlat,
               "accuracy": DEFAULT_ACCURACY if accuracy is None else float(accuracy),
               "prior": SURVEY_PRIOR if survey else PRIOR}
        offset, sigma, dist = self._landmark_offset(obs)
        if dist < MIN_LANDMARK:
            raise CalibrationError("Repère à {} m de la photo : choisissez un repère plus éloigné.".format(_fr(dist)))
        # L'écart toléré tient compte du décalage de position GPS possible (repère proche)
        if abs(offset) > MAX_OFFSET + math.degrees(math.atan2(2 * obs["accuracy"], dist)):
            raise CalibrationError("Écart de cap de {:.0f}° : ce n'est sûrement pas le même repère sur la "
                                   "carte et dans la photo.".format(offset))
        others = self.landmarks.get(sequence, [])
        if len(others) >= 3:
            # Contrôle : direction du repère prédite par les autres repères seuls
            pose = self._solve_pose(others)
            yaw, _ = self.untilted(obs["pic"], obs["yaw"], obs["elev"])
            x, y = _local(obs["mlon"], obs["mlat"], obs["lon"], obs["lat"])
            x, y = x - pose["shift"][0], y - pose["shift"][1]
            r = abs((math.degrees(math.atan2(x, y)) - yaw - pose["offset"] + 540) % 360 - 180)
            spread = math.hypot(AIM_ERROR, math.degrees(math.atan2(MAP_ERROR, dist)), pose["sigma"],
                                math.degrees(math.atan2(pose["shift_sigma"], dist)))
            if r > max(1.0, OUTLIER * spread):
                raise CalibrationError("Ce repère s'écarte de {}° de ce que prévoient les précédents : repère "
                                       "mal pointé sur la carte ou dans la photo ?".format(_fr(r)))
        self.landmarks.setdefault(sequence, []).append(obs)
        self._notify()
        return {"offset": offset, "sigma": sigma, "distance": dist}

    def _landmark_offset(self, obs):
        """(décalage de cap, précision, distance) d'un repère seul, avec l'inclinaison actuelle
        et sans recalage de position."""
        yaw, _ = self.untilted(obs["pic"], obs["yaw"], obs["elev"])
        x, y = _local(obs["mlon"], obs["mlat"], obs["lon"], obs["lat"])
        dist = math.hypot(x, y)
        bearing = math.degrees(math.atan2(x, y))
        offset = (bearing - yaw + 540) % 360 - 180
        position = math.degrees(math.atan2(math.hypot(obs["accuracy"], MAP_ERROR), max(dist, 1e-6)))
        return offset, math.hypot(position, AIM_ERROR), dist

    def _solve_pose(self, obs):
        """Relèvement : décalage de cap et de position communs aux photos des repères.

        Moindres carrés (Gauss-Newton) sur (cap, est, nord), chaque inconnue gardant
        son a priori : décalage de cap nul à ±prior, position GPS juste à ±accuracy.
        Un repère corrige surtout le cap ; trois repères ou plus bien répartis autour
        des photos recalent aussi la position.
        """
        lon0 = sum(o["lon"] for o in obs) / len(obs)
        lat0 = sum(o["lat"] for o in obs) / len(obs)
        rows = []
        for o in obs:
            yaw, _ = self.untilted(o["pic"], o["yaw"], o["elev"])
            px, py = _local(o["lon"], o["lat"], lon0, lat0)
            mx, my = _local(o["mlon"], o["mlat"], lon0, lat0)
            dist = max(math.hypot(mx - px, my - py), 1e-6)
            sigma = math.radians(math.hypot(AIM_ERROR, math.degrees(math.atan2(MAP_ERROR, dist))))
            rows.append((px, py, mx, my, math.radians(yaw), 1.0 / sigma ** 2))
        prior = (1.0 / math.radians(obs[0]["prior"]) ** 2,
                 1.0 / obs[0]["accuracy"] ** 2, 1.0 / obs[0]["accuracy"] ** 2)
        p = [0.0, 0.0, 0.0]  # décalage de cap (radians), décalage de position est, nord (m)

        def residuals(p):
            out = []
            for px, py, mx, my, yaw, w in rows:
                dx, dy = mx - px - p[1], my - py - p[2]
                r = (math.atan2(dx, dy) - yaw - p[0] + 3 * math.pi) % (2 * math.pi) - math.pi
                d2 = dx * dx + dy * dy
                out.append((r, (-1.0, -dy / d2, dx / d2), w))
            return out

        for _ in range(10):
            n = [[prior[i] if i == j else 0.0 for j in range(3)] for i in range(3)]
            g = [-prior[i] * p[i] for i in range(3)]
            for r, jac, w in residuals(p):
                for i in range(3):
                    g[i] -= w * jac[i] * r
                    for j in range(3):
                        n[i][j] += w * jac[i] * jac[j]
            cov = _inverse3(n)
            step = [sum(cov[i][j] * g[j] for j in range(3)) for i in range(3)]
            p = [p[i] + step[i] for i in range(3)]
            if max(abs(step[0]) * 1e3, abs(step[1]), abs(step[2])) < 1e-6:
                break
        res = residuals(p)
        # Grand axe de l'ellipse d'incertitude de la position
        a, b, c = cov[1][1], cov[1][2], cov[2][2]
        major = math.sqrt(max((a + c) / 2 + math.sqrt(((a - c) / 2) ** 2 + b * b), 0.0))
        return {
            "offset": math.degrees(p[0]), "sigma": math.degrees(math.sqrt(cov[0][0])),
            "shift": (p[1], p[2]), "shift_sigma": major,
            # Position recalée : trois repères au moins, et nettement mieux connue qu'au GPS
            "positioned": len(obs) >= 3 and major < 0.7 * obs[0]["accuracy"],
            "residual": math.degrees(math.sqrt(sum(r * r for r, _, _ in res) / len(res))),
            "residuals": [math.degrees(r) for r, _, _ in res],
            "count": len(obs), "prior": obs[0]["prior"], "accuracy": obs[0]["accuracy"],
            "photos": [(o["lon"], o["lat"]) for o in obs],
        }

    def pose(self, sequence, lon=None, lat=None):
        """Recalage de la séquence (voir _solve_pose), ou None. Avec (lon, lat), None aussi
        si la photo est à plus de REACH m des photos qui ont servi au recalage : la dérive
        du GPS au fil de la séquence le rendrait faux."""
        obs = self.landmarks.get(sequence) if sequence else None
        if not obs:
            return None
        result = self._solve_pose(obs)
        if lon is not None and lat is not None:
            if min(math.hypot(*_local(lon, lat, plon, plat)) for plon, plat in result["photos"]) > REACH:
                return None
        return result

    # Application -----------------------------------------------------------
    def correct(self, pic, sequence, yaw, elev, lon=None, lat=None):
        """Direction corrigée (inclinaison de la photo, puis cap de la séquence)."""
        yaw, elev = self.untilted(pic, yaw, elev)
        pose = self.pose(sequence, lon, lat)
        if pose:
            yaw = (yaw + pose["offset"]) % 360
        return yaw, elev

    def uncorrect(self, pic, sequence, yaw, elev, lon=None, lat=None):
        """Inverse de correct : direction vue dans la photo (brute) d'une direction vraie."""
        pose = self.pose(sequence, lon, lat)
        if pose:
            yaw = (yaw - pose["offset"]) % 360
        t = self.tilt(pic)
        return untilt(t["up"], yaw, elev, inverse=True) if t else (yaw % 360, elev)

    def position(self, sequence, lon, lat):
        """Position recalée de la photo : (lon, lat, précision en m), ou None si la
        position n'a pas été recalée (moins de trois repères bien répartis)."""
        pose = self.pose(sequence, lon, lat)
        if not pose or not pose["positioned"]:
            return None
        sx, sy = pose["shift"]
        lon, lat = offset(lon, lat, math.degrees(math.atan2(sx, sy)), math.hypot(sx, sy))
        return lon, lat, pose["shift_sigma"]

    def heading_error(self, sequence, lon=None, lat=None):
        """Erreur de visée (degrés) d'une séquence recalée, ou None si elle ne l'est pas."""
        pose = self.pose(sequence, lon, lat)
        return math.hypot(pose["sigma"], AIM_ERROR) if pose else None


def _height_obs(o):
    """Calage de la hauteur de caméra relu (voir Calibration.heights), ou None si illisible."""
    try:
        if isinstance(o, dict):
            clicks = []
            for c in o["clicks"]:
                clicks.append({
                    "pic": c.get("pic"), "sequence": c.get("sequence"),
                    "lon": float(c["lon"]), "lat": float(c["lat"]),
                    "gps": [float(v) for v in c["gps"]] if c.get("gps") else None,
                    "raw": [float(c["raw"][0]), float(c["raw"][1])] if c.get("raw") else None,
                    "yaw": float(c["yaw"]) if c.get("yaw") is not None else None,
                    "elev": float(c["elev"]) if c.get("elev") is not None else None,
                    "profile": [(float(d), float(z)) for d, z in c["profile"]] if c.get("profile") else None})
            if o.get("kind") not in ("ground", "height") or len(clicks) != 2 or float(o["known"]) <= 0:
                return None
            if any(c["raw"] is None and (c["yaw"] is None or c["elev"] is None) for c in clicks):
                return None
            return {"kind": o["kind"], "known": float(o["known"]), "clicks": clicks}
        h, s = float(o[0]), float(o[1])
        return (h, s) if s > 0 else None
    except (TypeError, ValueError, KeyError, IndexError, AttributeError):
        return None


def _auto_entry(entry):
    """Inclinaison automatique relue (voir Calibration.auto), ou None si illisible."""
    try:
        out = {"sequence": entry.get("sequence"), "heading": float(entry["heading"]), "verticals": None,
               "lidar": None}
        v = entry.get("verticals")
        if v:
            up = _unit(tuple(float(c) for c in v["up"]))
            out["verticals"] = {"up": list(up), "count": int(v["count"]), "sigma": float(v["sigma"])}
        if entry.get("lidar"):
            out["lidar"] = [float(entry["lidar"][0]), float(entry["lidar"][1])]
        return out
    except (TypeError, ValueError, KeyError, IndexError, AttributeError, ZeroDivisionError):
        return None


def _inverse3(m):
    """Inverse d'une matrice 3×3 (symétrique définie positive ici)."""
    a, b, c = m[0]
    d, e, f = m[1]
    g, h, i = m[2]
    co = [[e * i - f * h, -(d * i - f * g), d * h - e * g],
          [-(b * i - c * h), a * i - c * g, -(a * h - b * g)],
          [b * f - c * e, -(a * f - c * d), a * e - b * d]]
    det = a * co[0][0] + b * co[0][1] + c * co[0][2]
    return [[co[j][i] / det for j in range(3)] for i in range(3)]
