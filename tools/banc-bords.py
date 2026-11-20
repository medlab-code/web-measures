#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Banc hors ligne des bords de route (pistes P2 et P16 de docs/analyses/pistes-profil.md).

Rejoue le calcul des bords (App._edge_reads de py/web_chutes.py) sur les profils relevés par tests/essai-bords-nuage.html,
avec les réglages actuels ou des variantes, et compare le bord du travers de la photo au bord d'enrobé de l'analyse fine :
un bord du relief à plus de 0,25 m en deçà de l'enrobé tombe sur la chaussée (une erreur) ; au-delà, l'accotement.

    tools/banc-bords.py /tmp/web-measures-essais/essai-bords-nuage-lot=*.log [-v] [NOM=valeur…]

NOM : une constante de la classe (STEP_Z=0.08, CROWN_NEAR=1.5…). -v : liste les côtés en erreur. La catégorie de la route
(importance et nature BD TOPO, pour la largeur type, voir App._road_width) est lue à la Géoplateforme une fois par photo
et gardée dans ~/.cache/web-measures-banc-bords.json. Les chaussées séparées (bord au-delà de l'autre chaussée) sont
écartées du décompte, et le bord d'enrobé remplacé par la valeur vérifiée à la main sur les côtés de REFERENCES.
"""

import itertools
import json
import math
import os
import re
import statistics
import sys
import time
import types
import urllib.parse
import urllib.request
from pathlib import Path

for _name in ("pyodide", "pyodide.ffi", "pyodide.http"):
    sys.modules.setdefault(_name, types.ModuleType(_name))
sys.modules["pyodide.ffi"].to_js = lambda *a, **k: None
sys.modules["pyodide.http"].pyfetch = None
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))

import web_app

CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "web-measures-banc-bords.json"
HEADERS = {"User-Agent": "web-measures-essai"}
# Côtés où le bord d'enrobé de l'analyse fine est faux, vérifiés à la main (photo, vue du dessus) : (identifiant complet,
# côté) → (bord vrai en m depuis l'origine, à la lecture du relief près, raison) ; il remplace le bord d'enrobé
REFERENCES = {
    ("082893e5-f336-441b-8d28-0eecdbae1dde", "droit"): (
        1.0, "D8, 3 voies (tourne-à-gauche central) : trottoir tout près du véhicule, caniveau à +1 m ; l'analyse fine "
        "compte le trottoir en enrobé et ce qui suit, jusqu'à 8,8 m (auteur, 19/11/2026)"),
    ("6eea86cc-4c40-4395-9686-2418892bfa82", "droit"): (
        1.25, "M996, chaussée bordurée des deux côtés, îlot peint, environ 7 m (vue du dessus) : bordure de 5 cm à 1-1,5 m "
        "sur 2 travers sur 5, puis trottoir jusqu'à 5 m ; analyse fine à 10,5 m, en contrebas (auteur, 19/11/2026)"),
    ("6eea86cc-4c40-4395-9686-2418892bfa82", "gauche"): (
        5.5, "M996 : caniveau à 5-5,5 m puis bordure de 6 à 8 cm sur les 5 travers ; analyse fine à 6,75 m (auteur, 19/11/2026)"),
    ("20a5b40f-ab06-40ab-97e1-b3f74032bec7", "droit"): (
        4.5, "M70, ville, 2 voies à bordures fines (profil depuis l'axe, caméra à ~2,3 m à droite au GPS) : bordure proche "
        "du flanc droit du véhicule, caniveau à 4,5 m puis marche de 4 cm et large trottoir ; analyse fine à 7,6 m "
        "(auteur, 19/11/2026)"),
    ("20a5b40f-ab06-40ab-97e1-b3f74032bec7", "gauche"): (
        2.1, "M70 : bordure fine (bosse de 3 cm vers 2,5 m) contre la voie de tramway enherbée ; analyse fine à 2,1 m, juste "
        "(auteur, 19/11/2026)"),
    ("c6c065fa-90ad-40bd-a5f1-513c72e7400b", "droit"): (
        2.0, "D70, sortie d'agglomération : 2 voies, enrobé d'environ 7 m (vue du dessus), puis larges accotements en gravier "
        "jusqu'aux murs et haies ; bord au milieu de la descente vers l'accotement plus bas (1,5-2,5 m) ; analyse fine à "
        "4,5 m, gravier compté en enrobé (auteur, 19/11/2026)"),
    ("c6c065fa-90ad-40bd-a5f1-513c72e7400b", "gauche"): (
        5.0, "D70 : fin de la pente de la chaussée vers 5 m sur les 5 travers (7 m avec le côté droit), puis accotement en "
        "gravier presque plat jusqu'à 11 m ; analyse fine à 7,2 m (auteur, 19/11/2026)"),
    ("f533e240-7d37-40ef-babc-1d37140dc5d2", "droit"): (
        1.75, "D119M, rue bordurée de 5,80 m (vue du dessus) : caniveau à 1-1,5 m, marche de 4 à 7 cm, trottoir d'environ "
        "2,5 m puis mur de clôture (terrain 1,7 m plus bas derrière) ; analyse fine à 1,95 m, juste (auteur, 19/11/2026)"),
    ("f533e240-7d37-40ef-babc-1d37140dc5d2", "gauche"): (
        4.0, "D119M : bordure de 8 à 10 cm à 4,0 m sur 4 travers sur 5, trottoir d'environ 1,7 m, talus enherbé d'environ "
        "3,5 m, clôture, voies SNCF ; analyse fine à 8,1 m, trottoir compté en enrobé (auteur, 19/11/2026)"),
    ("b3978b33-2ceb-4ef3-bd51-09d25e505015", "droit"): (
        2.0, "D16, profil depuis la caméra : bord du relief à 2,0 m juste ; analyse fine à 3,4 m par la bordure de P21, "
        "retirée (auteur, 20/11/2026)"),
    ("5331221f-7a1f-4ace-b4de-9cf94a57e4d2", "droit"): (
        0.7, "D28E, profil depuis la caméra : bord sous le flanc droit du véhicule (Clio d'environ 1,70 m, caméra au milieu : "
        "flanc à 0,85 m, qui déborde du bord) ; relief à 3,5 m (pas de bord avant EDGE_NEAR, "
        "1,5 m), bordure de P21 à 2,9 m (auteur, 20/11/2026)"),
}


def _get(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
                return json.load(r)
        except (OSError, ValueError):  # ValueError : réponse vide ou illisible (service surchargé), passagère
            if attempt == 2:
                raise
            time.sleep(2)
    return None


def _category(lon, lat):
    """Importance et nature du tronçon BD TOPO le plus proche de (lon, lat), à 6 m au plus, ou {}."""
    d = 0.0002
    query = urllib.parse.urlencode({
        "SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature", "TYPENAMES": "BDTOPO_V3:troncon_de_route",
        "OUTPUTFORMAT": "application/json", "SRSNAME": "EPSG:4326",
        "BBOX": f"{lat - d},{lon - d},{lat + d},{lon + d},urn:ogc:def:crs:EPSG::4326"})
    kx, ky, best = 111320 * math.cos(math.radians(lat)), 111320, None
    for feat in _get("https://data.geopf.fr/wfs/ows?" + query).get("features") or []:
        geom = feat["geometry"]
        for line in geom["coordinates"] if geom["type"] == "MultiLineString" else [geom["coordinates"]]:
            for (x0, y0, *_), (x1, y1, *_) in itertools.pairwise(line):
                ax, ay, bx, by = (x0 - lon) * kx, (y0 - lat) * ky, (x1 - lon) * kx, (y1 - lat) * ky
                vx, vy = bx - ax, by - ay
                t = max(0.0, min(1.0, -(ax * vx + ay * vy) / ((vx * vx + vy * vy) or 1.0)))
                dist = math.hypot(ax + t * vx, ay + t * vy)
                if best is None or dist < best[0]:
                    best = (dist, feat["properties"])
    if not best or best[0] > 6:
        return {}
    return {"importance": str(best[1].get("importance") or ""), "nature": best[1].get("nature")}


def categories(ids):
    """Catégorie de la route sous chaque photo (identifiant complet), lue une fois puis gardée."""
    known = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    for pid in ids:
        if pid in known or len(pid) < 36:  # identifiant complet seulement (anciens relevés : 8 caractères)
            continue
        feats = _get("https://panoramax.ign.fr/api/search?" + urllib.parse.urlencode({"ids": pid})).get("features") or []
        known[pid] = _category(*feats[0]["geometry"]["coordinates"][:2]) if feats else {}
        CACHE.write_text(json.dumps(known, ensure_ascii=False))
    return known


def photos(paths):
    """Lignes « BORDS » complètes (profils et analyse fine) des journaux paths."""
    for path in paths:
        with open(path, encoding="utf-8", errors="ignore") as lines:
            for line in lines:
                if line.startswith("BORDS "):
                    d = json.loads(line[6:])
                    if d.get("profils") and d.get("nuage"):
                        yield d


def run(paths, settings, verbose=False):
    """Côtés comparés au bord d'enrobé : [{id, côté, bord, relief, enrobé, opposé (à la caméra), chaussées séparées}]."""
    app = web_app.App.__new__(web_app.App)
    for name, value in settings.items():
        setattr(app, name, value)
    data = list(photos(paths))
    cats = categories([d["id"] for d in data])
    sides, rows = (("droit", -1), ("gauche", 1)), []
    for d in data:
        half = app._road_width(cats.get(d["id"]) or {}) / 2
        profiles, ground = [], []
        for e in d["profils"]:
            # axe BD TOPO de ce côté (m depuis l'origine) ; profil depuis l'axe : 0
            axis_off = (d["axe"] if e["cote"] == "droit" else -d["axe"]) if d["origine"] == "caméra" else 0.0
            beyond = e["autre_axe"] or 0.0
            guess = max(app.EDGE_NEAR, half + axis_off) if not beyond else beyond + app.ROAD_TWIN / 2
            reach = guess + app.EDGE_SEARCH + (app.TWIN_SEARCH if beyond else 0)
            between = tuple(e["separateur"]) if e["separateur"] else None
            axis = axis_off if 2 * half >= app.CROWN_WIDTH else None
            profiles.append((e["le_long"], e["cote"], guess, [p[0] for p in e["points"]], beyond, between, reach, axis))
            ground += [p[1] for p in e["points"]]
        read, _ = app._edge_reads(profiles, ground, sides, {})
        for r in read:
            paved = (d["nuage"].get("bords") or {}).get(r[1])
            if r[0] != 0 or not paved or paved["quoi"] != "enrobé":
                continue
            fixed = REFERENCES.get((d["id"], r[1]))
            rows.append({"id": d["id"], "route": d.get("route"), "cote": r[1], "bord": r[3][r[5]] if r[5] is not None else r[2],
                         "relief": r[5] is not None, "enrobe": fixed[0] if fixed else paved["x"], "twin": bool(r[9]),
                         "verifie": bool(fixed),
                         "oppose": d["origine"] == "caméra" and (r[1] == "gauche") == (d["axe"] < 0),
                         "axe": d["origine"] != "caméra"})
    every = [r for r in rows if not r["twin"]]
    far = [r for r in every if r["verifie"] and r["bord"] - r["enrobe"] > 1.0]  # seulement sur référence vérifiée
    inside = [r for r in every if r["bord"] - r["enrobe"] < -0.25]
    relief = [r for r in every if r["relief"]]
    print(f"{settings or 'réglages actuels'} : {len(data)} photos, {len(every)} côtés (hors chaussées séparées) ; "
          f"bord sur l'enrobé : {len(inside)} ({100 * len(inside) // max(1, len(every))} %), dont "
          f"{sum(r['oppose'] for r in inside)} du côté opposé à la caméra ; repli sur la largeur type : {len(every) - len(relief)} ; "
          f"écart médian au bord d'enrobé (relief) : {statistics.median([r['bord'] - r['enrobe'] for r in relief] or [0]):+.2f} m ; "
          f"références vérifiées : {sum(r['verifie'] for r in every)}, bord à plus de 1 m au-delà : {len(far)}")
    if verbose:
        for r in sorted(inside, key=lambda r: r["bord"] - r["enrobe"]) + far:
            print(f"   {r['id']} {r['route'] or '?':8} {r['cote']:6} {'axe' if r['axe'] else 'opposé' if r['oppose'] else 'caméra':7} "
                  f"{'relief' if r['relief'] else 'type':6} bord {r['bord']:.2f} / {'vérifié' if r['verifie'] else 'enrobé'} {r['enrobe']:.2f}")
    return rows


if __name__ == "__main__":
    args = sys.argv[1:]
    # réglage : NOM=valeur (majuscules) ; les journaux portent aussi un « = » (essai-bords-nuage-lot=….log)
    settings = [a for a in args if re.fullmatch(r"[A-Z_]+=.*", a)]
    run([a for a in args if a not in settings and a != "-v"],
        {k: float(v) for k, v in (a.split("=", 1) for a in settings)}, "-v" in args)
