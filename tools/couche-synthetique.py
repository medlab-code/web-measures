#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Couche synthétique d'objets de la route et de ses abords, pour essayer l'onglet « Couche » : D977bis entre
Commarin et le hameau des Bordes (Vandenesse-en-Auxois), environ 3 km couverts par les photos du CD21 (2025).

Objets inventés (positions et attributs tirés au hasard, graine fixe), placés par rapport à l'axe de la route de la
BD TOPO (chaussée de 5,50 m) : avaloirs, panneaux, poteaux, arbres, glissières, passages piétons, îlots. Ils ne
correspondent pas aux objets visibles dans les photos.

    tools/couche-synthetique.py [nombre d'objets ponctuels, 90 par défaut] > tests/donnees/couche-synthetique.geojson

Réseau : BD TOPO (WFS de la Géoplateforme). Plus d'objets (essai de charge) : passer un nombre plus grand."""
import json
import random
import sys
import urllib.request

from pyproj import Transformer
from shapely import Point
from shapely.geometry import shape
from shapely.ops import linemerge

ROAD = "D977BIS"
BBOX = "47.228,4.625,47.262,4.660"  # lat, lon (WFS 2.0, EPSG:4326)
START, END = (4.649263, 47.256704), (4.632732, 47.234542)  # Commarin (village), les Bordes
HALF = 2.75  # m : demi-largeur de chaussée (BD TOPO : 5,50 m)

POLICE = ["AB4", "AB3a", "B14", "A1a", "A1b", "A13b", "A14", "B3", "B0", "EB10", "EB20", "C3"]
DIRECTION = ["D21a", "D29", "D42", "D43", "EB12", "Dc29", "D61"]
ESSENCES = ["chêne pédonculé", "frêne commun", "érable champêtre", "tilleul", "noyer", "charme", "merisier", "peuplier"]
ETATS = ["bon", "bon", "bon", "moyen", "moyen", "mauvais", "mort"]

to_l93 = Transformer.from_crs(4326, 2154, always_xy=True).transform
to_wgs = Transformer.from_crs(2154, 4326, always_xy=True).transform


def axis():
    """Axe de la D977bis (Lambert 93), abscisses (m) des deux bouts du tronçon et de Commarin sur lui."""
    url = ("https://data.geopf.fr/wfs/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=BDTOPO_V3:troncon_de_route"
           f"&outputFormat=application/json&srsName=EPSG:4326&bbox={BBOX},urn:ogc:def:crs:EPSG::4326&count=1000")
    with urllib.request.urlopen(url, timeout=60) as response:
        features = json.load(response)["features"]
    parts = [[to_l93(*c[:2]) for c in shape(f["geometry"]).coords] for f in features if f["properties"].get("cpx_numero") == ROAD]
    line = linemerge(parts)
    if line.geom_type != "LineString":
        sys.exit(f"{ROAD} : axe en plusieurs morceaux ({len(line.geoms)})")
    a, b = (line.project(Point(to_l93(*p))) for p in (START, END))
    return line, min(a, b), max(a, b), a


def at(line, s, offset):
    """Point (Lambert 93) à l'abscisse s, décalé de offset m (positif : à droite dans le sens de la ligne)."""
    p, q = line.interpolate(s), line.interpolate(min(s + 1.0, line.length))
    if q.distance(p) < 1e-6:
        p, q = line.interpolate(s - 1.0), p
    dx, dy = q.x - p.x, q.y - p.y
    n = (dx * dx + dy * dy) ** 0.5
    here = line.interpolate(s)
    return here.x + offset * dy / n, here.y - offset * dx / n


def wgs(points):
    return [[round(v, 7) for v in to_wgs(x, y)] for x, y in points]


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 90
    rng = random.Random(21)
    line, first, last, village = axis()
    inward = 1 if village == first else -1  # de Commarin vers les Bordes
    out = []

    def add(kind, geometry, **props):
        out.append({"type": "Feature", "properties": {"id": len(out) + 1, "type": kind, **props}, "geometry": geometry})

    def point(s, offset):
        return {"type": "Point", "coordinates": wgs([at(line, s, offset)])[0]}

    side = lambda: rng.choice((-1, 1))
    shares = {"avaloir": 0.12, "panneau": 0.25, "poteau": 0.25, "arbre": 0.38}
    for kind, share in shares.items():
        for _ in range(round(count * share)):
            s = rng.uniform(first, last)
            if kind == "avaloir":
                add(kind, point(s, side() * (HALF + 0.3)))
            elif kind == "panneau":
                police = rng.random() < 0.6
                d = rng.randint(50, 200)  # cm : du bord de chaussée au bord du panneau
                add(kind, point(s, side() * (HALF + d / 100 + 0.3)), categorie="police" if police else "directionnelle",
                    code=rng.choice(POLICE if police else DIRECTION), support_fusible="oui" if rng.random() < 0.4 else "non",
                    distance_bord_cm=d)
            elif kind == "poteau":
                add(kind, point(s, side() * (HALF + rng.uniform(1.5, 5))),
                    reseau=rng.choices(("télécom", "électricité", "autre"), (5, 4, 1))[0])
            else:
                d = rng.randint(100, 800)  # cm : du bord de chaussée à l'axe du tronc
                add(kind, point(s, side() * (HALF + d / 100)), essence=rng.choice(ESSENCES), etat_phyto=rng.choice(ETATS),
                    distance_bord_cm=d)
    for _ in range(max(2, count // 30)):  # glissières : 60 à 160 m, à 0,60 m du bord
        s, length, o = rng.uniform(first, last - 160), rng.uniform(60, 160), side() * (HALF + 0.6)
        steps = int(length // 10) + 1
        add("glissière", {"type": "LineString", "coordinates": wgs([at(line, s + k * length / steps, o) for k in range(steps + 1)])},
            materiau=rng.choice(("métal", "mixte")))
    for s in (village + inward * 40, village + inward * 180):  # passages piétons dans Commarin : 4 m de large, d'un bord à l'autre
        ring = [at(line, s, -HALF), at(line, s, HALF), at(line, s + 4, HALF), at(line, s + 4, -HALF)]
        add("passage piéton", {"type": "Polygon", "coordinates": [wgs([*ring, ring[0]])]})
    for s in (village + inward * 25, village + inward * (last - first - 30)):  # îlots, aux deux bouts en goutte d'eau, 12 m, sur le bord droit élargi
        ring = [at(line, s, HALF + 0.5), at(line, s + 4, HALF + 1.5), at(line, s + 12, HALF + 0.8), at(line, s + 6, HALF + 0.4)]
        add("îlot", {"type": "Polygon", "coordinates": [wgs([*ring, ring[0]])]})
    json.dump({"type": "FeatureCollection", "name": "couche-synthetique", "features": out}, sys.stdout, ensure_ascii=False, indent=1)
    print()


if __name__ == "__main__":
    main()
