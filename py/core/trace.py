# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Tracé en plan d'une route (alignements, clothoïdes, arcs) ajusté sur une suite de positions.

Méthode des logiciels de tracé routier (restitution d'un tracé existant : droites, clothoïdes,
cercles, courbure continue), à partir des positions des photos d'une séquence.

1. Modèle : la courbure κ(s) (1/R, positive vers la gauche) est linéaire par morceaux entre des
   nœuds tous les KNOT m. Le cap en est l'intégrale, la position l'intégrale du cap : la
   trajectoire est définie par κ aux nœuds et par la pose de départ (x0, y0, cap0). Une
   clothoïde est une rampe de κ, un arc un palier, une droite un palier à zéro.
2. Départ : lissage linéaire des positions (spline de Whittaker : moindres carrés avec pénalité sur la
   dérivée seconde de la trajectoire, longueur d'onde SMOOTH), dont on tire cap et courbure. Le
   problème du modèle est non convexe (la position est l'intégrale double de κ) : sur des positions
   bruitées, un départ à courbure nulle s'enlise dans un minimum local à plusieurs mètres des
   positions. Le lissage, convexe, donne un départ proche de la solution.
   Ajustement : moindres carrés non linéaires (Levenberg-Marquardt, jacobien numérique) de la
   distance entre le modèle et chaque position, plus une pénalité REG sur la dérivée seconde de κ
   (stabilise les parties où les photos sont rares ou bruitées).
3. Découpage de κ(s) en éléments : Douglas-Peucker sur la courbe (s, κ) à la tolérance KAPPA_TOL,
   classement de chaque morceau (droite, arc, clothoïde), raccords brusques absorbés, morceaux voisins
   regroupés en un arc quand leur courbure forme un plateau (_plateaus), voisins semblables fondus.

Ce que l'ajustement ne sait pas : la trajectoire est celle du véhicule, pas l'axe de la chaussée
(décalage d'une voie : le rayon de l'axe est R ± 1,5 à 2 m selon le sens) ; hors RTK (±4 m), la
courbure des petits rayons est incertaine ; un virage de moins de ~2 photos de long n'est pas vu.

Calculs numpy seuls. Coordonnées métriques locales (est, nord) : voir triangulation._local.
"""

import math
from itertools import pairwise

KNOT = 8.0  # m : écart des nœuds de courbure (à 15 m, l'écart au modèle restait à 0,9 m sur une route de village aux virages de 30 à 100 m de rayon)
FINE = 1.0  # m : pas d'intégration du modèle
REG = 30.0  # poids final de la pénalité sur la dérivée seconde de κ (m, car κ en 1/m)
REG_PER_M2 = 3.0e6  # pénalité par m² de variance du bruit des positions : plus elles sont bruitées, plus κ est lissé
SMOOTH = 20.0  # m : longueur d'onde du lissage de départ (voir _start)
GRID = 2.5  # m : pas du lissage de départ
KAPPA_TOL = 2.5e-4  # 1/m : tolérance du découpage (R = 4 000 m)
STRAIGHT_R = 4000.0  # m : plus grand que cela, droite
FLAT = 0.2  # un morceau est un arc si sa courbure varie de moins de 20 % de sa valeur moyenne (l'ajustement la laisse dériver de 10 % sur un arc)
CURVE_R = 500.0  # m : sous ce rayon (|κ| > 1/CURVE_R), la route est en courbe
CURVE_MIN = 12.0  # m : longueur minimale d'une courbe
CURVE_GAP = 10.0  # m : deux portions de même sens plus proches que cela ne font qu'une courbe
MIN_LENGTH = 6.0  # m : un morceau plus court est absorbé par son voisin
PLATEAU = 0.25  # des morceaux voisins forment un arc si les courbures à leurs extrémités restent à ± 25 % de leur moyenne (à 40 %, les bouts des clothoïdes sont pris dans l'arc : rayon + 4 %)
PLATEAU_LENGTH = 25.0  # m : longueur minimale d'un arc regroupé
MIN_RAMP = 15.0  # m : une clothoïde plus courte est un raccord brusque, absorbé par son voisin (le raccord de l'ARP fait 6 R^0,4, soit 44 m à 150 m de rayon)
END_WEIGHT = 1.0  # poids de la pénalité sur l'écart de κ entre les deux premiers (et derniers) nœuds, en fraction de REG (κ y est mal observé)
ITER = 40  # itérations au plus de chaque passage


def _np():
    import numpy as np

    return np


def _cumtrapz(np, f, s):
    return np.concatenate([[0.0], np.cumsum((f[1:] + f[:-1]) / 2 * np.diff(s))])


def _clean(np, points, min_gap=0.5):
    """Positions sans doublon (écart d'au moins min_gap m), et leur abscisse curviligne."""
    pts = [points[0]]
    for p in points[1:]:
        if math.hypot(p[0] - pts[-1][0], p[1] - pts[-1][1]) >= min_gap:
            pts.append(p)
    pts = np.asarray(pts, float)
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
    return pts, s


def _noise(np, pts, s):
    """Écart type (m) du bruit des positions, d'après les dérivées troisièmes de la suite (photos régulières,
    espacées de 2,5 à 12 m) : 20 σ² par axe en moyenne pour un bruit blanc. La dérivée seconde mêlerait la
    courbure au bruit (un virage de 60 m de rayon donne 0,4 m tous les 5 m) ; la troisième, presque nulle sur un
    arc, ne garde que lui. Quart inférieur des valeurs (chi² à 2 degrés de liberté : 0,575 × la moyenne ÷ 2),
    pour ne pas compter les à-coups. Au moins 1 cm."""
    step = np.diff(s)
    a, b, c = step[:-2], step[1:-1], step[2:]
    ok = (a > 2.5) & (c < 12) & (a < 12) & (b > 2.5) & (b < 12) & (c > 2.5) & (abs(a - b) < 0.3 * b) & (abs(c - b) < 0.3 * b)
    if ok.sum() < 5:
        return 0.01
    third = pts[3:] - 3 * pts[2:-1] + 3 * pts[1:-2] - pts[:-3]
    sq = (third ** 2).sum(axis=1)[ok]
    return max(0.01, math.sqrt(float(np.percentile(sq, 25)) / (20 * 0.575)))


def _project(np, curve, curve_s, pts):
    """Abscisse de chaque position `pts` sur la ligne brisée `curve` (abscisses `curve_s`) : pied de la
    perpendiculaire au segment le plus proche. La somme des cordes entre positions bruitées surestime la
    longueur (1 m de bruit tous les 5 m : + 4 %), et le modèle compenserait par des oscillations."""
    a, b = curve[:-1], curve[1:]
    ab = b - a
    length2 = np.maximum((ab ** 2).sum(axis=1), 1e-12)
    out = np.empty(len(pts))
    for i, p in enumerate(pts):
        t = np.clip(((p - a) * ab).sum(axis=1) / length2, 0.0, 1.0)
        foot = a + ab * t[:, None]
        j = int(((foot - p) ** 2).sum(axis=1).argmin())
        out[i] = curve_s[j] + t[j] * (curve_s[j + 1] - curve_s[j])
    return out


def _start(np, pts, s):
    """Départ : lissage de Whittaker des positions rééchantillonnées tous les GRID m. Retourne la ligne lissée
    z, son abscisse curviligne zs (somme de ses pas : juste, contrairement à celle des cordes bruitées), le
    cap et la courbure au milieu de chaque pas, et ces abscisses de milieu."""
    grid = np.arange(0.0, s[-1] + GRID / 2, GRID)
    n = len(grid)
    xy = np.stack([np.interp(grid, s, pts[:, 0]), np.interp(grid, s, pts[:, 1])], axis=1)
    lam = (SMOOTH / GRID) ** 4 / 16.0
    d = np.zeros((n - 2, n))
    for i in range(n - 2):
        d[i, i:i + 3] = (1.0, -2.0, 1.0)
    z = np.linalg.solve(np.eye(n) + lam * d.T @ d, xy)
    step = np.diff(z, axis=0)
    zs = np.concatenate([[0.0], np.cumsum(np.hypot(step[:, 0], step[:, 1]))])
    theta = np.unwrap(np.arctan2(step[:, 1], step[:, 0]))
    mid = (zs[1:] + zs[:-1]) / 2
    return z, zs, theta, np.gradient(theta, mid), mid


class _Model:
    """Trajectoire de courbure linéaire par morceaux entre les nœuds `knots` (abscisses)."""

    def __init__(self, np, knots, s_points):
        self.np = np
        self.knots = knots
        self.fine = np.arange(0.0, knots[-1] + FINE / 2, FINE)
        self.s_points = s_points

    def curve(self, params):
        """(x, y, cap) sur la grille fine."""
        np = self.np
        x0, y0, th0 = params[:3]
        kappa = np.interp(self.fine, self.knots, params[3:])
        th = th0 + _cumtrapz(np, kappa, self.fine)
        return x0 + _cumtrapz(np, np.cos(th), self.fine), y0 + _cumtrapz(np, np.sin(th), self.fine), th

    def residuals(self, params, pts, reg=REG):
        np = self.np
        x, y, _ = self.curve(params)
        mx = np.interp(self.s_points, self.fine, x)
        my = np.interp(self.s_points, self.fine, y)
        k = params[3:]
        smooth = math.sqrt(reg) * (k[2:] - 2 * k[1:-1] + k[:-2]) if len(k) > 2 else np.zeros(0)
        ends = math.sqrt(reg * END_WEIGHT) * np.array([k[1] - k[0], k[-1] - k[-2]])
        return np.concatenate([mx - pts[:, 0], my - pts[:, 1], smooth, ends])


def _levenberg_marquardt(np, model, pts, params, reg):
    steps = np.concatenate([[1e-4, 1e-4, 1e-6], np.full(len(params) - 3, 1e-7)])
    lam = 1e-3
    r = model.residuals(params, pts, reg)
    cost = float(r @ r)
    for _ in range(ITER):
        jac = np.empty((len(r), len(params)))
        for j, h in enumerate(steps):
            q = params.copy()
            q[j] += h
            jac[:, j] = (model.residuals(q, pts, reg) - r) / h
        a, g = jac.T @ jac, jac.T @ r
        improved = False
        for _ in range(8):
            try:
                delta = np.linalg.solve(a + lam * np.diag(np.diag(a) + 1e-12), -g)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            q = params + delta
            rq = model.residuals(q, pts, reg)
            c = float(rq @ rq)
            if c < cost:
                params, r, cost, lam, improved = q, rq, c, max(lam / 3, 1e-9), True
                break
            lam *= 5
        if not improved or float(np.max(np.abs(delta / (steps * 1e3 + 1e-12)))) < 1e-3 and cost - c < 1e-9:
            break
    return params


def _douglas_peucker(s, k, tol):
    """Indices des sommets de la ligne brisée (s, k) qui s'écarte de moins de tol (en κ) de l'originale."""
    keep = {0, len(s) - 1}
    stack = [(0, len(s) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        line = k[a] + (k[b] - k[a]) * (s[a + 1:b] - s[a]) / (s[b] - s[a])
        dev = abs(k[a + 1:b] - line)
        i = int(dev.argmax())
        if dev[i] > tol:
            m = a + 1 + i
            keep.add(m)
            stack += [(a, m), (m, b)]
    return sorted(keep)


def _piece(s0, s1, k0, k1):
    """Élément (droite, arc ou clothoïde) du morceau de κ(s) qui va de (s0, k0) à (s1, k1)."""
    length = s1 - s0
    mean = (k0 + k1) / 2
    el = {"s0": s0, "s1": s1, "length": length, "k0": k0, "k1": k1}
    if max(abs(k0), abs(k1)) < 1.5 / STRAIGHT_R:
        el["type"] = "droite"
    elif abs(k1 - k0) <= max(FLAT * abs(mean), KAPPA_TOL):
        el["type"] = "arc"
        el["radius"] = 1 / abs(mean)
    else:
        el["type"] = "clothoide"
        el["parameter"] = math.sqrt(length / abs(k1 - k0))  # A, avec A² = R·L
    if el["type"] != "droite":
        el["sense"] = "gauche" if mean > 0 else "droite"
    return el


def _plateaus(np, pieces, s, k):
    """Regroupe en un arc les morceaux voisins dont la courbure forme un plateau. Sous un bruit de 1 m, la
    courbure d'un arc oscille autour de sa valeur : le découpage la coupe en plusieurs morceaux (arcs courts,
    clothoïdes), alors que la courbure de l'ensemble reste près de sa moyenne. Une clothoïde d'entrée, qui part
    de zéro, n'en fait pas partie : ses extrémités sont trop loin de la moyenne."""
    out, i = [], 0
    while i < len(pieces):
        best = None
        for j in range(len(pieces) - 1, i, -1):
            m = (s >= pieces[i]["s0"]) & (s <= pieces[j]["s1"])
            seg = k[m]
            mean = float(np.mean(seg))
            if abs(mean) < 1.5 / STRAIGHT_R or pieces[j]["s1"] - pieces[i]["s0"] < PLATEAU_LENGTH:
                continue
            ends = [abs(e) for q in pieces[i:j + 1] for e in (q["k0"], q["k1"])]
            same_sign = all(e * mean > 0 for q in pieces[i:j + 1] for e in (q["k0"], q["k1"]))
            if same_sign and min(ends) >= (1 - PLATEAU) * abs(mean) and max(ends) <= (1 + PLATEAU) * abs(mean):
                best = (j, mean)
                break
        if best and best[0] > i:
            j, mean = best
            first, last = pieces[i], pieces[j]
            out.append({"type": "arc", "s0": first["s0"], "s1": last["s1"], "length": last["s1"] - first["s0"],
                        "k0": mean, "k1": mean, "radius": 1 / abs(mean), "sense": "gauche" if mean > 0 else "droite"})
            i = j + 1
        else:
            out.append(pieces[i])
            i += 1
    return out


def _curves(np, s, k):
    """Courbes de κ(s) : portions où |κ| dépasse 1/CURVE_R, de sens constant, d'au moins CURVE_MIN m. Chacune :
    s0, s1, length, sense, r_min (rayon au plus serré, m), r_typ (rayon à la courbure médiane), angle (degrés,
    rotation totale du cap), cut (coupée par le bord de la suite : le début ou la fin est en dehors). Sur une
    route de village, la courbure change sans cesse : le découpage en arcs et clothoïdes idéaux (_elements)
    varie d'un réglage à l'autre, la courbure elle-même non (corrélation de 0,99 entre KNOT = 6 et 12 m)."""
    runs, i, n = [], 0, len(s)
    while i < n:
        if abs(k[i]) > 1 / CURVE_R:
            sign = k[i] > 0
            j = i
            while j < n and abs(k[j]) > 1 / CURVE_R and (k[j] > 0) == sign:
                j += 1
            runs.append([i, j - 1, sign])
            i = j
        else:
            i += 1
    merged = []
    for run in runs:
        if merged and merged[-1][2] == run[2] and s[run[0]] - s[merged[-1][1]] < CURVE_GAP:
            merged[-1][1] = run[1]
        else:
            merged.append(run)
    out = []
    for a, b, sign in merged:
        length = float(s[b] - s[a])
        if length < CURVE_MIN:
            continue
        seg = abs(k[a:b + 1])
        angle = abs(float(np.sum((k[a:b] + k[a + 1:b + 1]) / 2 * np.diff(s[a:b + 1]))))
        out.append({"s0": float(s[a]), "s1": float(s[b]), "length": length, "sense": "gauche" if sign else "droite",
                    "r_min": 1 / float(seg.max()), "r_typ": 1 / float(np.median(seg)), "angle": math.degrees(angle),
                    "cut": bool(a == 0 or b == n - 1)})
    return out


def _elements(np, s, k):
    """Découpe κ(s) en éléments (voir le haut du fichier)."""
    cuts = _douglas_peucker(s, k, KAPPA_TOL)
    # Une clothoïde qui traverse zéro (courbe en S) est coupée au passage par zéro
    marks = []
    for a, b in pairwise(cuts):
        marks.append(s[a])
        if k[a] * k[b] < 0 and abs(k[a]) > 1 / STRAIGHT_R and abs(k[b]) > 1 / STRAIGHT_R:
            marks.append(s[a] + (s[b] - s[a]) * k[a] / (k[a] - k[b]))
    marks.append(s[cuts[-1]])
    def kz(x):
        return float(np.interp(x, s, k))

    pieces = [_piece(x0, x1, kz(x0), kz(x1)) for x0, x1 in pairwise(marks) if x1 - x0 > 1e-6]
    # Morceaux trop courts : absorbés par le plus long voisin
    changed = True
    while changed and len(pieces) > 1:
        changed = False
        for i, p in enumerate(pieces):
            if p["length"] < MIN_LENGTH or (p["type"] == "clothoide" and p["length"] < MIN_RAMP):
                j = i - 1 if i > 0 and (i == len(pieces) - 1 or pieces[i - 1]["length"] >= pieces[i + 1]["length"]) else i + 1
                lo, hi = min(i, j), max(i, j)
                a, b = pieces[lo], pieces[hi]
                pieces[lo:hi + 1] = [_piece(a["s0"], b["s1"], kz(a["s0"]), kz(b["s1"]))]
                changed = True
                break
    pieces = _plateaus(np, pieces, s, k)
    # Voisins de même nature (droites, arcs de même rayon, rampes de même pente) : fondus
    out = [pieces[0]]
    for p in pieces[1:]:
        q = out[-1]
        same = q["type"] == p["type"] and q["type"] != "clothoide"
        if q["type"] == "clothoide" == p["type"] and q["sense"] == p["sense"]:  # même rampe, coupée par la tolérance du découpage
            sq, sp = (q["k1"] - q["k0"]) / q["length"], (p["k1"] - p["k0"]) / p["length"]
            same = sq * sp > 0 and 0.5 < sp / sq < 2.0
        if same and q["type"] == "clothoide":
            out[-1] = _piece(q["s0"], p["s1"], kz(q["s0"]), kz(p["s1"]))
            continue
        if same and q["type"] == "arc":
            same = q["sense"] == p["sense"] and abs(1 / q["radius"] - 1 / p["radius"]) < FLAT * 1 / q["radius"]
        if same:
            out[-1] = _piece(q["s0"], p["s1"], kz(q["s0"]), kz(p["s1"]))
            if out[-1]["type"] == "arc":  # rayon d'après la courbure moyenne du morceau fondu
                m = (s >= q["s0"]) & (s <= p["s1"])
                out[-1]["radius"] = 1 / abs(float(np.mean(k[m])))
        else:
            out.append(p)
    return out


def fit(points):
    """Tracé en plan des positions `points` [(x, y)] en m (une suite ordonnée, dans le sens de la marche).

    Retourne {"curves": [...] (voir _curves), "elements": [...], "curve": (abscisses, x, y de la courbe ajustée, pas de
    1 m), "s": abscisses des nœuds, "kappa": courbure aux nœuds, "rms": distance
    quadratique moyenne (m) des positions au modèle, "length": longueur (m)}. Chaque élément : type
    ("droite", "arc", "clothoide"), s0, s1, length (m), k0, k1 (1/m, positive vers la gauche), sense
    ("gauche"/"droite"), radius (arc, m) ou parameter (clothoïde, A en m). None si moins de 3 positions
    ou moins de KNOT m de long. Au plus quelques kilomètres par appel (lissage de départ : matrice pleine)."""
    np = _np()
    if len(points) < 3:
        return None
    pts, chord = _clean(np, points)
    if len(pts) < 3 or chord[-1] < KNOT:
        return None
    reg = max(REG, REG_PER_M2 * _noise(np, pts, chord) ** 2)
    z, zs, theta, kappa, mid = _start(np, pts, chord)
    s = _project(np, z, zs, pts)
    count = max(3, round(zs[-1] / KNOT) + 1)
    knots = np.linspace(0.0, zs[-1], count)
    params = np.concatenate([[z[0, 0], z[0, 1], theta[0] - kappa[0] * mid[0]], np.interp(knots, mid, kappa)])
    for _ in range(3):  # ajustement, puis abscisses reprises sur la courbe ajustée, et ainsi de suite
        model = _Model(np, knots, s)
        params = _levenberg_marquardt(np, model, pts, params, reg)
        x, y, _ = model.curve(params)
        s = _project(np, np.stack([x, y], axis=1), model.fine, pts)
    model = _Model(np, knots, s)
    r = model.residuals(params, pts)[:2 * len(pts)]
    fine_k = np.interp(model.fine, knots, params[3:])
    x, y, _ = model.curve(params)
    return {"elements": _elements(np, model.fine, fine_k), "curves": _curves(np, model.fine, fine_k),
            "curve": (model.fine, x, y), "s": knots, "kappa": params[3:],
            "rms": float(math.sqrt(float(r @ r) / len(pts))), "length": float(knots[-1])}


def plan(coords):
    """Tracé en plan des positions `coords` [[lon, lat]] (une suite ordonnée), pour la carte : courbes et éléments,
    chacun avec sa géométrie [[lon, lat]] (un point tous les 2 m) ; None si la suite est trop courte. Résultat
    en types JSON (appelé en arrière-plan : web_worker.call)."""
    from .triangulation import _geographic, _local

    lon0, lat0 = coords[0]
    result = fit([_local(lon, lat, lon0, lat0) for lon, lat in coords])
    if not result:
        return None
    fine_s, xs, ys = result["curve"]

    def geometry(s0, s1):
        picks = [i for i in range(len(fine_s)) if s0 - 1e-6 <= fine_s[i] <= s1 + 1e-6][::2]
        return [list(_geographic(float(xs[i]), float(ys[i]), lon0, lat0)) for i in picks]

    for item in result["curves"] + result["elements"]:
        item["coords"] = geometry(item["s0"], item["s1"])
    return {"curves": result["curves"], "elements": result["elements"], "length": result["length"], "rms": result["rms"],
            "photos": len(coords)}
