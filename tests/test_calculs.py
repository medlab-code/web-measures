# SPDX-License-Identifier: GPL-2.0-or-later
# © Cédric COCHART
"""Essais rapides des calculs propres à l'application (py/web_app.py), sans navigateur ni réseau :
python3 -m unittest discover -s tests (quelques secondes). Pyodide est remplacé par un faux module."""

import math
import re
import sys
import json
import types
import unittest
from pathlib import Path

for name in ("pyodide", "pyodide.ffi", "pyodide.http"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["pyodide.ffi"].to_js = lambda *a, **k: None
sys.modules["pyodide.http"].pyfetch = None
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))

import web_app  # noqa: E402
from core import host, precision, triangulation  # noqa: E402

HOST = {name: getattr(host, name) for name in host.SERVICES}  # cœur sans hôte : pas de réseau, calcul immédiat

App = web_app.App
app = App.__new__(App)  # seulement les constantes de la classe


def crossings(z, width=3.0, along=(-10, -5, 0, 5, 10), between=None):
    """Travers d'une plateforme de ±width m tous les 0,5 m, altitude z(x, le long) ; x positif à droite."""
    drawn = []
    for a in along:
        for name, sign in (("gauche", -1), ("droit", 1)):
            offsets = [k * 0.5 for k in range(int(width / 0.5) + 1)]
            drawn.append({"le_long": a, "cote": name, "bord": width, "separateur": between if sign == 1 else None,
                          "points": [[o, z(sign * o, a)] for o in offsets]})
    return drawn


class LongueurCarte(unittest.TestCase):
    """Longueurs mesurées sur la vue du dessus : liste des résultats, effacement, retour, export."""

    def test_cycle(self):
        a = App(lambda *args: None)
        a.set_mode("carte")
        self.assertEqual((a.mode, a.map_mode, a._can_undo()), ("tri", True, False))
        a.add_map_length(5.0, 47.0, 5.0001, 47.0, 7.6, 0.38, "p,q")
        a.add_map_length(5.0, 47.0, 5.0, 47.0001, 11.1, 0.56, "p")
        rows = [r for r in json.loads(a.results()) if r["kind"] == "longueur"]
        self.assertEqual([r["text"] for r in rows], ["↔ 7,60 m ± 0,38 m (carte)", "↔ 11,10 m ± 0,56 m (carte)"])
        a.set_comment("longueur", 1, "bord à bord")
        records = [attrs for _, attrs in a._records() if attrs["type"].startswith("longueur")]
        self.assertEqual([(r["valeur_m"], r["photo_ref"], r["commentaire"]) for r in records], [(7.6, "p", ""), (11.1, "p", "bord à bord")])
        self.assertIn("longueur sur la carte", a.export_csv())
        self.assertEqual(sum(f["properties"]["label"] == "7,60 m" for f in json.loads(a.map_geojson())["features"]), 1)
        a.undo()  # Effacer : la dernière
        self.assertEqual([v["valeur_m"] for v in a.map_lengths], [7.6])
        a.redo()  # Refaire
        self.assertEqual(len(a.map_lengths), 2)
        a.add_map_length(5.0, 47.0, 5.001, 47.0, 75.8, None, "")  # bout hors de la vue : fond de carte seul
        self.assertEqual(json.loads(a.results())[-1]["text"], "↔ 75,80 m hors vue (carte)")
        self.assertEqual([(attrs["type"], attrs["incert_m"]) for _, attrs in a._records()][-1],
                         ("longueur sur la carte (hors vue du dessus)", None))
        a.undo()
        a.delete_result("longueur", 0)
        self.assertEqual([v["valeur_m"] for v in a.map_lengths], [11.1])
        a.clear_all()
        self.assertEqual((a.map_lengths, a.has_results()), ([], False))


class SurfaceCarte(unittest.TestCase):
    """Surface tracée sur la carte (App.add_map_area) : un carré de 10 m de côté."""

    def test_carre(self):
        a = App(lambda *args: None)
        a.set_mode("carte")
        lon, lat = 5.0, 47.0
        x, y = triangulation._geographic(10.0, 0.0, lon, lat), triangulation._geographic(10.0, 10.0, lon, lat)
        z = triangulation._geographic(0.0, 10.0, lon, lat)
        a.add_map_area(json.dumps([[lon, lat], list(x), list(y), list(z)]))
        row = [r for r in json.loads(a.results()) if r["kind"] == "longueur"][0]
        self.assertEqual(row["text"], "▱ 100,0 m² (carte)")
        (ends, attrs), = [rec for rec in a._records() if rec[1]["type"] == "surface sur la carte"]
        self.assertEqual((attrs["surface_m2"], attrs["valeur_m"], ends[0], ends[-1]), (100.0, 40.0, ends[0], ends[0]))
        self.assertIn("100,0 m²", [f["properties"]["label"] for f in json.loads(a.map_geojson())["features"]])
        a.undo()
        self.assertEqual(a.map_lengths, [])


class VueDessus(unittest.TestCase):
    """Pose de la photo pour la vue du dessus (App.birdeye_pose)."""

    def app_on(self, field_of_view):
        class Cal:
            auto = {}
            position = staticmethod(lambda *a: None)
            pose = staticmethod(lambda *a: {"offset": 1.5})
            tilt = staticmethod(lambda pic: {"up": (0.0, 0.1, 0.99), "sigma": 0.2})
            camera = staticmethod(lambda seq: None)

        class Tilts:
            pending = staticmethod(lambda pic: False)

        a = App.__new__(App)
        a.calibration, a.tilts, a.quality = Cal, Tilts, {"precise": True, "lidar": True, "height": 2.4, "spread": 0.02}
        a.item = {"id": "p", "collection": "s", "geometry": {"coordinates": [5.0, 47.0, 300.0]},
                  "properties": {"view:azimuth": 40, "pers:interior_orientation": {"field_of_view": field_of_view}}}
        a.birdeye_items, a.birdeye_checks = [dict(a.item, id="v", geometry={"coordinates": [5.0, 47.00005]})], (Tilts,)
        a.fall_cells, a.tool = {web_app.roads._cell(5.0, 47.0): []}, types.SimpleNamespace(camera_height=2.1)
        a.birdeye_loose, a.birdeye_far_items = {}, []
        return a

    def test_defaut_de_roulis(self):
        """Défaut de roulis de la caméra (ROLL_DEFECTS) : CD21, campagne 2025 seulement ; ni avant, ni après, ni ailleurs."""
        a = App.__new__(App)
        photo = lambda producer, date: {"providers": [{"id": producer}], "properties": {"datetime": date}}
        self.assertEqual(a._roll_defect(photo(App.FLEET_PRODUCER, "2025-07-03T10:53:25Z")), -1.0)
        for producer, date in ((App.FLEET_PRODUCER, "2024-12-31T23:00:00Z"), (App.FLEET_PRODUCER, "2026-01-02T09:00:00Z"),
                               ("autre", "2025-07-03T10:53:25Z")):
            self.assertEqual(a._roll_defect(photo(producer, date)), 0.0)
        self.assertEqual(a._roll_defect({}), 0.0)  # sans producteur ni date

    def test_pose(self):
        pose = json.loads(self.app_on(360).birdeye_pose())
        self.assertEqual((pose["lon"], pose["heading"], pose["offset"], pose["height"]), (5.0, 40.0, 1.5, 2.4))
        self.assertEqual((pose["up"], pose["sigma"], pose["height_sigma"]), ([0.0, 0.1, 0.99], 0.2, 0.05))
        self.assertEqual([(n["pic"], n["lat"], n["relative_sigma"]) for n in pose["neighbours"]], [("v", 47.00005, 0.05)])

    def test_voisines_a_deux_pas(self):
        """Photos à deux pas (birdeye_far) : leur pose à part (far), sans inclinaison attendue ; aucune par défaut."""
        a = self.app_on(360)
        self.assertEqual(json.loads(a.birdeye_pose())["far"], [])
        a.birdeye_far(json.dumps([dict(a.item, id="w", geometry={"coordinates": [5.0, 47.0001]})]))
        far = json.loads(a.birdeye_pose())["far"]
        self.assertEqual([(p["pic"], p["lat"], p["pending"]) for p in far], [("w", 47.0001, False)])

    def test_flotte_cd21(self):
        """Photo du CD21 (producteur) signalée à la vue du dessus (hauteur par monture) ; autre producteur : non."""
        a = self.app_on(360)
        self.assertFalse(json.loads(a.birdeye_pose())["fleet"])
        a.item["providers"] = [{"id": App.FLEET_PRODUCER, "roles": ["producer"]}]
        self.assertTrue(json.loads(a.birdeye_pose())["fleet"])
        self.assertIsNone(json.loads(a.birdeye_pose())["mount"])  # sans date : pas de monture
        a.item.setdefault("properties", {})["datetime"] = "2025-07-07T05:56:32Z"
        self.assertEqual(json.loads(a.birdeye_pose())["mount"], 2.07)  # monture d'après la date, hors pont aussi

    def test_hors_360(self):
        self.assertEqual(self.app_on(90).birdeye_pose(), "null")

    def test_pont(self):
        """Pont à portée de la vue (dessus ou dessous) : signalé, hauteur de caméra hors sol LiDAR (le réglage) ;
        plus loin, rien ne change."""
        def pose_with(east):  # tronçon en pont, nord-sud, à east m à l'est de la photo
            a = self.app_on(360)
            lon = 5.0 + east / (6378137 * math.cos(math.radians(47.0))) * 180 / math.pi
            a.fall_cells[web_app.roads._cell(5.0, 47.0)] = [{"level": 1, "line": [[lon, 46.999], [lon, 47.001]]}]
            return json.loads(a.birdeye_pose())
        near, far = pose_with(10), pose_with(40)
        self.assertEqual((near["bridge"], near["height"], near["neighbours"][0]["height"]), (True, 2.1, 2.1))
        self.assertEqual((far["bridge"], far["height"]), (False, 2.4))

    def test_pont_monture_cd21(self):
        """CD21 sur un pont, hauteur de séquence inconnue : monture d'après la date de prise de vue, pas le réglage
        (1,90 m par défaut : bandes de passage piéton à 0,44 m, f2a245d0 et 7dcdccf9) ; date hors campagne : le réglage."""
        def pose_on(date):
            a = self.app_on(360)
            a.item["providers"] = [{"id": App.FLEET_PRODUCER}]
            a.item.setdefault("properties", {})["datetime"] = date
            a.fall_cells[web_app.roads._cell(5.0, 47.0)] = [{"level": 1, "line": [[5.0, 46.999], [5.0, 47.001]]}]
            return json.loads(a.birdeye_pose())
        self.assertEqual([(p["height"], p["height_sigma"]) for p in (pose_on("2025-05-28T05:40:22Z"), pose_on("2025-07-07T05:56:32Z"))],
                         [(1.93, App.MOUNT_SIGMA), (2.07, App.MOUNT_SIGMA)])
        self.assertEqual(pose_on("2024-05-28T05:40:22Z")["height"], 2.1)

    def test_verticales_moins_sures(self):
        """Verticales refusées pour les mesures (±0,42° > autotilt.MAX_SIGMA) : renvoyées à part par
        web_tilt.estimate, et prises par la vue du dessus faute d'inclinaison retenue (giratoire b47b4351,
        08/11/2026 : roulis du véhicule penché en virage, que la pente de la route ignore)."""
        import web_tilt
        loose = {"up": (0.0, -0.052, 0.9986), "tilt": 3.0, "count": 73, "sigma": 0.42, "auto": True}
        calls = []
        saved = web_tilt.host.decode_band, web_tilt.autotilt.segments, web_tilt.autotilt.fit
        web_tilt.host.decode_band = lambda *a: ("bande", 0, 1, 1)
        web_tilt.autotilt.segments = lambda *a: []
        web_tilt.autotilt.fit = lambda pairs: calls.append(1) or (None if len(calls) == 1 else loose)
        try:
            res = web_tilt.estimate(b"", 0.0)
        finally:
            web_tilt.host.decode_band, web_tilt.autotilt.segments, web_tilt.autotilt.fit = saved
        self.assertEqual((res["reason"], res["loose"]["sigma"]), (web_tilt.FEW_EDGES, 0.42))
        a = self.app_on(360)
        a.calibration.tilt = staticmethod(lambda pic: None)
        a.birdeye_loose = {"p": res["loose"]}
        pose = json.loads(a.birdeye_pose())
        self.assertEqual((pose["up"], pose["sigma"]), ([0.0, -0.052, 0.9986], 0.42))
        a.calibration.tilt = staticmethod(lambda pic: {"up": (0.0, -0.016, 0.9999), "sigma": 0.5})  # relais par le terrain
        self.assertEqual(json.loads(a.birdeye_pose())["sigma"], 0.42)
        a.calibration.tilt = staticmethod(lambda pic: {"up": (0.0, 0.0, 1.0), "sigma": 0.2})  # calage plus sûr : gardé
        self.assertEqual(json.loads(a.birdeye_pose())["sigma"], 0.2)

    def test_voisine_sans_inclinaison(self):
        """Analyse d'une voisine finie sans inclinaison (verticales et LiDAR en échec) : la page est
        prévenue, sinon la vue l'attend sans fin (D33, 08/11/2026)."""
        class Checker:
            def check(self, item, cal, done):
                done()

        a = self.app_on(360)
        a.birdeye_checks, calls = (Checker(),), []
        a.notify = lambda: calls.append(1)
        a.birdeye_neighbours(json.dumps(a.birdeye_items))
        self.assertEqual(calls, [1])


class Plateforme(unittest.TestCase):
    """Dévers de la plateforme (web_app.platform_slope, ticket #38)."""

    def test_un_seul_sens(self):
        out = web_app.platform_slope(crossings(lambda x, a: -0.03 * x))
        self.assertEqual(out["type"], "sens")
        self.assertAlmostEqual(out["pente"], 3.0)

    def test_toit(self):
        out = web_app.platform_slope(crossings(lambda x, a: -0.025 * abs(x)))
        self.assertEqual((out["type"], out["pente"]), ("toit", 2.5))
        self.assertLess(out["gauche"], 0)
        self.assertGreater(out["droite"], 0)

    def test_toit_dissymetrique_et_cuvette(self):
        self.assertEqual(web_app.platform_slope(crossings(lambda x, a: -(0.05 if x > 0 else -0.01) * x))["type"], "demi")
        self.assertEqual(web_app.platform_slope(crossings(lambda x, a: 0.025 * abs(x)))["type"], "demi")

    def test_travers_trop_differents(self):
        out = web_app.platform_slope(crossings(lambda x, a: -0.01 * a * x))  # de -10 % à +10 %
        self.assertEqual(out, {"type": "indetermine"})
        toit = web_app.platform_slope(crossings(lambda x, a: -(0.025 + (0.01 if a > 0 else 0) * a) * abs(x)))
        self.assertEqual(toit, {"type": "indetermine"})

    def test_trop_peu_de_travers(self):
        self.assertEqual(web_app.platform_slope(crossings(lambda x, a: 0.0, along=(0, 5))), {"type": "indetermine"})

    def test_chaussees_separees(self):
        # une chaussée plate, l'autre à 2,5 %, séparateur surélevé de 1 à 2 m : exclu du calcul
        z = lambda x, a: 1.0 if 1 < x < 2 else (0.0 if x <= 1 else -0.025 * (x - 2))
        out = web_app.platform_slope(crossings(z, width=10.0, between=[1.0, 2.0]))
        self.assertEqual(out["type"], "demi")
        self.assertAlmostEqual(out["gauche"], 0.0)
        self.assertAlmostEqual(out["droite"], 2.5)


class Carrefours(unittest.TestCase):
    """Profil en long : seules les voies carrossables nommées sont citées (App._chained, ticket #38)."""

    def voie(self, name, **props):
        lon, lat = 5.0, 47.0
        return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[lon, lat], [lon, lat + 0.001]]},
                "properties": dict({"cpx_numero": name, "nature": "Route à 1 chaussée", "prive": False,
                                    "acces_vehicule_leger": "Libre"}, **props)}

    def cites(self, *features):
        road = lambda a, b: {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[a, 47.0], [b, 47.0]]},
                             "properties": {"cpx_numero": "D1", "nature": "Route à 1 chaussée"}}
        sections = web_app.roads.parse_sections({"features": [road(4.999, 5.0), road(5.0, 5.001), *features]})
        line = [web_app.triangulation._local(p[0], p[1], 5.0, 47.0) for p in sections[0]["line"]]
        _, ends, _ = app._chained(line, sections[0], sections, 5.0, 47.0)
        return [name for _, kind, names in ends if kind == "carrefour" for name in names]

    def test_voies_citees(self):
        self.assertEqual(self.cites(self.voie("R DE LA RUEE")), ["R DE LA RUEE"])
        self.assertEqual(self.cites(self.voie("D18", nature="Route à 2 chaussées")), ["D18"])

    def test_voies_ecartees(self):
        for props in ({"nature": "Route empierrée"}, {"nature": "Chemin"}, {"nature": "Sentier"}, {"nature": "Escalier"}, {"prive": True},
                      {"acces_vehicule_leger": "Restreint aux ayants droit"}):
            self.assertEqual(self.cites(self.voie("VOIE", **props)), [], props)

    def test_chemin_classe_route(self):
        # photo 9b97c187 : « CHE DE L ARGENTALET », 3,5 m, en « Route à 1 chaussée » ; seul le nom le dit chemin
        for name in ("CHE DE L ARGENTALET", "CHEM DES VIGNES", "CHEMIN DU LAVOIR"):
            self.assertEqual(self.cites(self.voie(None, nom_collaboratif_gauche=name)), [], name)
        self.assertEqual(self.cites(self.voie(None, nom_collaboratif_gauche="RTE DE VILLERIN")), ["RTE DE VILLERIN"])
        self.assertEqual(self.cites(self.voie(None, nom_collaboratif_gauche="CHEMINOTS")), ["CHEMINOTS"])
        self.assertEqual(self.cites(self.voie("D70", nom_collaboratif_gauche="CHE DE DIJON")), ["D70"])  # numérotée : gardée


class BordsChausseesSeparees(unittest.TestCase):
    """Route à chaussées séparées : chaque profil porte l'axe de l'autre chaussée de son côté (autre_axe), lu par
    l'analyse fine (src/nuage.js) pour borner le bord ; il valait celui du dernier travers lu, pour tous."""

    def test_autre_axe_par_travers(self):
        lon, lat = 5.0, 47.0
        calc = App.__new__(App)
        calc.edges, calc.paved, calc.paved_redo = {}, {}, {}
        calc.notify = lambda: None

        def terrain(points, done):  # plat, séparateur surélevé de 4 à 7 m, talus au-delà de l'autre chaussée
            local = [web_app.triangulation._local(p[0], p[1], lon, lat) for p in points]
            done([(0.2 if 4.0 < x < 7.0 else 0.0) - 0.5 * max(0.0, abs(x - 5.5) - 12.0) for x, _ in local],
                 web_app.triangulation.LIDAR_NAME, None)
        calc._terrain = terrain
        key = ("photo", 10, True)
        calc._compute_edges(key, [(0.0, -200.0), (0.0, 200.0)], 200.0, 6.0, 0.0, lon, lat,
                            twin=[([(11.0, -200.0), (11.0, 200.0)], 7.0)])
        profils = calc.edges[key]["profile"]["profils"]
        twin_side = [e for e in profils if e["separateur"]]
        other_side = [e for e in profils if not e["separateur"]]
        self.assertTrue(twin_side and other_side)
        self.assertTrue(all(e["autre_axe"] == 11.0 for e in twin_side), sorted({e["autre_axe"] for e in twin_side}))
        self.assertTrue(all(e["autre_axe"] is None for e in other_side))


class BordsEnrobe(unittest.TestCase):
    """Chute et dévers relus depuis les bords d'enrobé de l'analyse fine (App.use_paved_edges, ticket #38)."""

    def test_relecture_depuis_l_enrobe(self):
        lon, lat = 5.0, 47.0
        calc = App.__new__(App)
        calc.edges, calc.paved, calc.paved_redo = {}, {}, {}
        calc.notify = lambda: None
        reads = []

        def terrain(points, done):  # plat jusqu'à 6 m de l'axe, puis talus à 50 %
            reads.append(1)
            local = [web_app.triangulation._local(p[0], p[1], lon, lat) for p in points]
            done([-0.5 * max(0.0, abs(x) - 6.0) for x, _ in local], web_app.triangulation.LIDAR_NAME, None)
        calc._terrain = terrain
        key = ("photo", 10, False)
        calc._compute_edges(key, [(0.0, -200.0), (0.0, 200.0)], 200.0, 6.0, 0.0, lon, lat)
        before = calc.edges[key]["profile"]
        fall = before["resultats"]["droit"]["chute"][0]
        self.assertAlmostEqual(next(e for e in before["profils"] if e["cote"] == "droit")["bord"], 6.0, delta=1.0)
        calc.use_paved_edges(json.dumps(before["repere"]), json.dumps({"droit": 8.0}))
        after = calc.edges[key]["profile"]
        droit = [e for e in after["profils"] if e["cote"] == "droit"]
        self.assertTrue(droit and all(e["bord"] == 8.0 and e["enrobe"] for e in droit), [(e["bord"], e["enrobe"]) for e in droit])
        # chute comptée depuis le nouveau bord, à son niveau (le talus y a déjà descendu de 1 m)
        chute = after["resultats"]["droit"]["chute"]
        entry = next(e for e in droit if e["le_long"] == chute[3])
        # point du terrain le plus proche du bord
        start = min(o for o, _ in entry["points"] if abs(o - 8.0) == min(abs(q - 8.0) for q, _ in entry["points"]))
        kept = [z for o, z in entry["points"] if start <= o <= start + 10]
        self.assertLess(chute[0], fall)
        self.assertAlmostEqual(chute[0], kept[0] - min(kept), delta=0.01)
        gauche = [e for e in after["profils"] if e["cote"] == "gauche"]
        self.assertTrue(gauche and not any(e["enrobe"] for e in gauche))  # l'autre côté garde son bord
        self.assertEqual(len(reads), 1)  # sans relire le terrain


class BordsTalus(unittest.TestCase):
    """Bord, chute et dévers sur des talus de géométrie connue (App._compute_edges, terrain synthétique sans bruit) : le bord
    tombait 0,5 m avant la rupture (fenêtre de 1 m qui la voit avant d'y arriver), le dévers comptait le plat du haut et du
    fond (talus à 50 % lu à 33 %)."""

    def profile(self, start, slope, depth, kerb=0.0):
        """Plat jusqu'à start m de l'axe, marche de kerb m, talus de pente slope sur depth m de haut, puis fond plat."""
        lon, lat = 5.0, 47.0
        calc = App.__new__(App)
        calc.edges, calc.paved, calc.paved_redo = {}, {}, {}
        calc.notify = lambda: None

        def z(x):
            a = abs(x)
            return 0.0 if a <= start else -kerb - min(depth, (a - start) * slope)
        calc._terrain = lambda points, done: done(
            [z(web_app.triangulation._local(p[0], p[1], lon, lat)[0]) for p in points], web_app.triangulation.LIDAR_NAME, None)
        key = ("photo", 10, False)
        calc._compute_edges(key, [(0.0, -200.0), (0.0, 200.0)], 200.0, 8.0, 0.0, lon, lat)
        profile = calc.edges[key]["profile"]
        bord = next(e for e in profile["profils"] if e["cote"] == "droit" and e["le_long"] == 0)["bord"]
        return bord, profile["resultats"]["droit"]

    def test_bord_a_la_rupture(self):
        for start, slope, depth in ((4.0, 0.5, 1.0), (4.0, 0.2, 1.0), (4.0, 1.0, 2.0), (4.5, 0.5, 3.0)):
            bord, _ = self.profile(start, slope, depth)
            self.assertAlmostEqual(bord, start, delta=0.01, msg=(start, slope, depth))
        for start in (4.1, 4.25, 4.4):  # entre deux points (pas de 0,5 m) : le dernier point de la chaussée
            bord, _ = self.profile(start, 0.5, 1.0)
            self.assertAlmostEqual(bord, 4.0, delta=0.01, msg=start)

    def test_bordure(self):
        bord, r = self.profile(4.0, 0.5, 1.0, kerb=0.15)
        self.assertAlmostEqual(bord, 4.0, delta=0.01)
        self.assertAlmostEqual(r["chute"][0], 1.15, delta=0.01)

    def test_devers_du_talus(self):
        for slope, depth in ((0.5, 1.0), (0.2, 1.0), (1.0, 2.0), (0.5, 3.0)):
            _, r = self.profile(4.0, slope, depth)
            self.assertAlmostEqual(r["chute"][0], depth, delta=0.01)
            self.assertAlmostEqual(r["devers"][0], slope, delta=0.02, msg=(slope, depth))
            self.assertAlmostEqual(r["devers"][4], depth, delta=0.05)  # hauteur du talus (pied à EDGE_FLAT près)


def edges_on(z, width=8.0, twin=None, zone=10):
    """Bords (App._compute_edges) sur un terrain synthétique z(x, y), en m : x vers la droite de la photo, y le long de la
    route (axe x = 0, photo en y = 0) ; twin : autre chaussée [(ligne, largeur)]. Rend self.edges[clé]."""
    lon, lat = 5.0, 47.0
    calc = App.__new__(App)
    calc.edges, calc.paved, calc.paved_redo = {}, {}, {}
    calc.notify = lambda: None
    calc._terrain = lambda points, done: done(
        [z(*web_app.triangulation._local(p[0], p[1], lon, lat)) for p in points], web_app.triangulation.LIDAR_NAME, None)
    key = ("photo", zone, False)
    calc._compute_edges(key, [(0.0, -200.0), (0.0, 200.0)], 200.0, width, 0.0, lon, lat, twin=twin)
    return calc.edges[key]


class BordsCas(unittest.TestCase):
    """Cas types des bords de route sur terrain synthétique (piste P1 de docs/analyses/pistes-profil.md)."""

    TWIN = (([(11.0, -200.0), (11.0, 200.0)], 7.0),)  # autre chaussée à droite, axe à 11 m

    @staticmethod
    def entry(res, side, along=0.0):
        return next(e for e in res["profile"]["profils"] if e["cote"] == side and e["le_long"] == along)

    def test_plain_pied(self):  # pas de rupture : demi-largeur BD TOPO, aucune chute
        res = edges_on(lambda x, y: 0.0)
        for side in ("gauche", "droit"):
            e = self.entry(res, side)
            self.assertEqual((e["bord"], e["relief"], e["voisins"]), (4.0, False, False))
        self.assertEqual(res["profile"]["resultats"], {})
        self.assertIn("largeur BD TOPO", res["title"])

    def test_butte(self):  # le terrain remonte de 1 m : lecture arrêtée, pas de chute
        res = edges_on(lambda x, y: min(1.5, (x - 5.0) * 0.5) if x > 5.0 else 0.0)
        e = self.entry(res, "droit")
        self.assertAlmostEqual(e["bord"], 5.0, delta=0.01)
        self.assertIsNotNone(e["arret"])
        self.assertNotIn("droit", res["profile"]["resultats"])
        self.assertIn("pas de chute avant le terrain qui remonte de 1 m", res["text"])

    def test_descente_jusqu_au_bout(self):  # plus bas au bout du profil : « chute ≥ »
        res = edges_on(lambda x, y: -(x - 4.0) * 0.3 if x > 4.0 else 0.0)
        chute, devers = res["profile"]["resultats"]["droit"]["chute"], res["profile"]["resultats"]["droit"]["devers"]
        self.assertTrue(chute[2])
        self.assertAlmostEqual(devers[0], 0.3, delta=0.01)
        self.assertIn("Côté droit : chute ≥ 3,0 m", res["text"])

    def test_fosse_peu_profond(self):  # 30 cm : sous FALL_MIN, pas de chute
        res = edges_on(lambda x, y: -0.3 if 4.0 < x < 7.0 else 0.0)
        self.assertTrue(self.entry(res, "droit")["relief"])
        self.assertEqual(res["profile"]["resultats"], {})

    def test_bord_loin_des_autres(self):  # rupture à 8 m sur un seul travers, à 4 m ailleurs : ramené à la médiane
        res = edges_on(lambda x, y: -0.5 if x > (8.0 if 2.5 < y < 7.5 else 4.0) else 0.0)
        e = self.entry(res, "droit", 5.0)
        self.assertEqual((e["bord"], e["relief"], e["voisins"]), (4.0, False, True))

    def test_separateur_a_marches(self):  # surélevé ou en creux, de 4 à 7 m : entre les deux marches
        for h in (0.2, -0.2):
            res = edges_on(lambda x, y, h=h: (h if 4.0 < x < 7.0 else 0.0) - 0.5 * max(0.0, abs(x - 5.5) - 12.0), twin=self.TWIN)
            e = self.entry(res, "droit")
            self.assertEqual(e["separateur_relief"], "marches", h)
            self.assertEqual(e["separateur"], [4.25, 6.75], h)  # milieu des pas de 0,5 m où le terrain saute
            self.assertAlmostEqual(e["bord"], 17.5, delta=0.01)  # bord extérieur de l'autre chaussée

    def test_glissieres_dos_a_dos(self):  # pic d'un point (assise des glissières) : séparateur en bosse
        res = edges_on(lambda x, y: (0.1 if 5.4 < x < 5.6 else 0.0) - 0.5 * max(0.0, abs(x - 5.5) - 12.0), twin=self.TWIN)
        e = self.entry(res, "droit")
        self.assertEqual((e["separateur_relief"], e["separateur"]), ("bosse", [5.1, 5.9]))

    def test_distance_au_bord_ecrite(self):  # P15 : 0,5 m s'écrivait « 0 m » (arrondi au pair de Python)
        res = edges_on(lambda x, y: -0.6 if x > 4.0 else 0.0)
        self.assertEqual(res["profile"]["resultats"]["droit"]["chute"][1], 0.5)
        self.assertIn("chute 0,6 m (±0,1 m) à 0,5 m du bord", res["text"])
        res = edges_on(lambda x, y: -0.6 if x > 14.0 else 0.0, zone=20)  # 10 m et plus : au mètre, arrondi comme la page
        self.assertEqual(res["profile"]["resultats"]["droit"]["chute"][1], 10.5)
        self.assertIn("à 11 m du bord", res["text"])  # 10,5 : « 10 » au pair, « 11 » dans la légende du graphique


class BordsVoisins(unittest.TestCase):
    """Travers sans rupture de pente ramené au bord médian des autres (App._edge_reads) : d'après les travers voisins, pas
    « rupture de pente » (il était compté comme trouvé dans le relief)."""

    def test_travers_plat_parmi_des_marches(self):
        lon, lat = 5.0, 47.0
        calc = App.__new__(App)
        calc.edges, calc.paved, calc.paved_redo = {}, {}, {}
        calc.notify = lambda: None

        def terrain(points, done):  # à droite, marche de 30 cm à 4 m de l'axe, sauf sur le travers à +5 m (plat)
            local = [web_app.triangulation._local(p[0], p[1], lon, lat) for p in points]
            done([-0.3 if x > 4.0 and not 2.5 < y < 7.5 else 0.0 for x, y in local], web_app.triangulation.LIDAR_NAME, None)
        calc._terrain = terrain
        key = ("photo", 10, False)
        calc._compute_edges(key, [(0.0, -200.0), (0.0, 200.0)], 200.0, 8.0, 0.0, lon, lat)
        res = calc.edges[key]
        droit = {e["le_long"]: e for e in res["profile"]["profils"] if e["cote"] == "droit"}
        plat = droit[5.0]
        self.assertEqual((plat["relief"], plat.get("voisins")), (False, True))
        self.assertEqual(plat["bord"], droit[0.0]["bord"])  # position : la médiane des autres (voulue)
        self.assertTrue(all(e["relief"] and not e.get("voisins") for a, e in droit.items() if a != 5.0))
        self.assertIn("relief sur 4 travers sur 5, 1 d'après les travers voisins", res["title"])
        gauche = [e for e in res["profile"]["profils"] if e["cote"] == "gauche"]  # plat partout : largeur BD TOPO
        self.assertTrue(gauche and not any(e["relief"] or e.get("voisins") for e in gauche))


class Creux(unittest.TestCase):
    """Profil en long : tablier des ponts (App._bridged)."""

    def test_gorge_plus_large_que_le_pont(self):
        # route plate, brèche de 8 m de profondeur ; pont BD TOPO absent : plongée de plus de 20 %
        pts = [(d, 0.0) for d in range(-10, 12, 2)] + [(12, -6), (14, -8), (16, -7), (18, -5), (20, -3), (22, -1),
                                                         (24, 0.1), (26, 0.2)]
        out, dips = app._bridged(pts)
        self.assertEqual(dips, [(10, 24)])  # appuis en haut des parois
        self.assertTrue(all(z >= -0.01 for _, z in out))

    def test_creux_peu_profond_sous_un_pont(self):
        # vallon suivi par la route, petit creux (11 %) sous un pont BD TOPO plus court que la brèche (92e3faf1)
        z = {-42: 2.15, -40: 2.05, -38: 1.9, -36: 1.6, -34: 1.3, -32: 1.05, -30: 0.9, -28: 1.3, -26: 1.4, -24: 1.3}
        pts = sorted(z.items()) + [(d, 1.2 - 0.05 * (d + 22)) for d in range(-22, 12, 2)] \
            + [(d, -0.4 + 0.06 * (d - 10)) for d in range(12, 52, 2)]
        out, dips = app._bridged(pts, [(-37, -31)])
        self.assertEqual(dips, [(-38, -26)])
        self.assertEqual(dict(out)[0], dict(pts)[0])  # le vallon de la route reste tel quel
        self.assertEqual(app._bridged(pts)[1], [])  # sans pont ni plongée : pas de creux

    def test_creux_ouvert_au_bout(self):
        pts = [(-4, -6), (-2, -3), (0, 0), (2, 0), (4, 0.1)]
        self.assertEqual(app._bridged(pts)[0], [(0, 0), (2, 0), (4, 0.1)])


class Route(unittest.TestCase):
    """Route prolongée par les tronçons voisins de même nom (App._chained)."""

    LON, LAT = 5.0, 47.3

    def section(self, name, *xy, level=0):
        k = 1 / (111320 * math.cos(math.radians(self.LAT)))
        return {"name": name, "level": level, "drivable": True, "line": [(self.LON + x * k, self.LAT + y / 111320) for x, y in xy]}

    def test_prolongement_fin_et_carrefour(self):
        photo = self.section("D16", (-20, 0), (0, 0))
        suite = self.section("D16", (0, 0), (30, 0))
        branche = self.section("D16", (0, 0), (0, 40))  # autre branche de la D16 à 90° : pas prise
        voie = self.section("D18", (30, 0), (30, 50))  # la D16 s'arrête sur la D18
        line, ends, works = app._chained([(-20, 0), (0, 0)], photo, [photo, suite, branche, voie], self.LON, self.LAT)
        self.assertAlmostEqual(line[-1][0], 30, delta=0.5)
        kinds = {(round(p[0]), kind): names for p, kind, names in ends}
        self.assertEqual(kinds[(30, "fin")], ["D18"])
        self.assertEqual(works, [])


class Selection(unittest.TestCase):
    """Croix sous le clic : décidée par la page en pixels (App._nearest, cross_hit)."""

    def test_croix_vue_par_la_page(self):
        a = App.__new__(App)
        click = {"raw": [100.0, -10.0]}
        far = [("hauteur", [{"abs_yaw": 104.0, "elev": -10.0}])]  # à 4° (environ 3,9° sur la sphère)
        a.cross_hit = None
        self.assertIsNone(a._nearest(click, far))  # sans la page : 1° au plus
        a.cross_hit = True
        self.assertEqual(a._nearest(click, far), ("hauteur", 0))  # la page a vu la croix (zoom fort)
        a.cross_hit = False
        self.assertIsNone(a._nearest(click, [("hauteur", [{"abs_yaw": 100.2, "elev": -10.0}])]))  # à 0,2° : pas vue
        a._picks = []  # pick_points : les candidats sont relevés, rien n'est choisi
        self.assertIsNone(a._nearest(click, far))
        self.assertEqual(a._picks, far[0][1])
        a._picks = None
        self.assertIsNone(a._with_cross(True, lambda: None))
        self.assertIsNone(a.cross_hit)  # remise à zéro après le clic


class Terrain(unittest.TestCase):
    """Lecture du terrain par paquets (App._terrain) : une seule source pour tout le profil."""

    def test_sources_melees_relues_en_rge_alti(self):
        precision, host = web_app.precision, web_app.host
        sources = iter(["LiDAR HD", "RGE ALTI"])  # 2e paquet : un point manquait en LiDAR HD
        old = precision.fetch_terrain, host.fetch_json
        asked = []
        precision.fetch_terrain = lambda pts, done: done([100.0] * len(pts), next(sources), None)
        host.fetch_json = lambda url, done, timeout_ms=None: (asked.append(url), done(
            {"elevations": [{"z": 99.5}] * (url.split("lon=")[1].split("&")[0].count("|") + 1)}, None))
        try:
            a = App.__new__(App)
            got = []
            a._terrain([(5.0 + k * 1e-5, 47.0) for k in range(a.FALL_POINTS + 10)], lambda *r: got.append(r))
        finally:
            precision.fetch_terrain, host.fetch_json = old
        zs, source, error = got[0]
        self.assertEqual(source, "RGE ALTI")
        self.assertEqual(len(asked), 2)  # les deux paquets relus en RGE ALTI
        self.assertTrue(all(z == 99.5 for z in zs) and len(zs) == a.FALL_POINTS + 10)

    def test_reponse_incomplete_pas_decalee(self):
        precision = web_app.precision
        old = precision.fetch_terrain
        precision.fetch_terrain = lambda pts, done: done([100.0] * (len(pts) - 1), "LiDAR HD", None)  # une altitude perdue
        try:
            a, got = App.__new__(App), []
            a._terrain([(5.0, 47.0), (5.0001, 47.0)], lambda *r: got.append(r))
        finally:
            precision.fetch_terrain = old
        self.assertEqual(got[0][0], [None, None])


class Pannes(unittest.TestCase):
    """Échec d'un service : pas gardé pour la session, redemandé après FALL_RETRY s (App._bdtopo)."""

    def test_bdtopo_redemandee(self):
        host, asked = web_app.host, []
        old = host.fetch_json
        host.fetch_json = lambda url, done, timeout_ms=None: (asked.append(url), done(None, "HTTP 503"))
        try:
            a = App.__new__(App)
            a.bdtopo, a.bdtopo_retry, a.notify = {}, {}, lambda: None
            self.assertEqual(a._bdtopo("construction_lineaire", (0, 0)), [])
            self.assertEqual(a._bdtopo("construction_lineaire", (0, 0)), [])  # pas tout de suite
            a.bdtopo_retry[("construction_lineaire", (0, 0))] = 0.0  # délai écoulé
            a._bdtopo("construction_lineaire", (0, 0))
        finally:
            host.fetch_json = old
        self.assertEqual(len(asked), 2)


class Tablier(unittest.TestCase):
    """Hauteur de chute : altitude du tablier entre les photos du pont (web_app._deck_at)."""

    def test_pont_pente_interpole(self):
        # pont de 40 m en pente de 5 % (photos tous les 10 m, rangs désordonnés) : bord à 4 m de l'axe, à mi-chemin
        decks = [(20, 0, 101.0, 3), (0, 0, 100.0, 1), (10, 0, 100.5, 2), (30, 0, 101.5, 4), (40, 0, 102.0, 5)]
        self.assertAlmostEqual(web_app._deck_at(decks, 15, 4), 100.75)
        self.assertAlmostEqual(web_app._deck_at(decks, 33, -4), 101.65)
        self.assertAlmostEqual(web_app._deck_at(decks, -5, 4), 100.0)  # avant la première photo : la sienne

    def test_une_seule_photo(self):
        self.assertEqual(web_app._deck_at([(0, 0, 250.0, 7)], 12, 3), 250.0)


class ChuteLidar(unittest.TestCase):
    """Hauteur de chute par le nuage LiDAR (App.use_bridge_lidar)."""

    def app(self):
        a = App.__new__(App)
        a.lidar_falls = {}
        a.status = lambda: None
        return a

    def test_reponses(self):
        a = self.app()
        a.use_bridge_lidar("p", json.dumps({"height": 5.234, "below": "eau"}))
        self.assertIn("max : 5,2 m (±0,1 m), LiDAR", a.lidar_falls["p"]["text"])
        self.assertIn("l'eau", a.lidar_falls["p"]["title"])
        a.use_bridge_lidar("bas", json.dumps({"height": 0.2, "below": "sol"}))
        self.assertIn("non mesurée", a.lidar_falls["bas"]["text"])
        a.use_bridge_lidar("vide", json.dumps({"keys": {}}))  # tablier, rien de lu dessous
        self.assertIn("non mesurée", a.lidar_falls["vide"]["text"])

    def test_secours_par_le_gps(self):
        a = self.app()
        a.use_bridge_lidar("sans", json.dumps({"none": True}))
        self.assertEqual(a.lidar_falls["sans"], {})  # pas de nouvel essai
        a.use_bridge_lidar("panne", json.dumps({"error": True}))
        self.assertNotIn("text", a.lidar_falls["panne"])
        self.assertIn("retry_at", a.lidar_falls["panne"])


class CameraPont(unittest.TestCase):
    """Hauteur de caméra du tablier (App._fall_camera) : séquence, sinon calée, sinon la monture du CD21 d'après la date,
    sinon le réglage accepté."""

    def app(self, quality, calibrated=None, item=None):
        a = App.__new__(App)
        a.quality, a.item = quality, item or {"collection": "s"}
        a.calibration = types.SimpleNamespace(camera=lambda seq: calibrated)
        a.tool = types.SimpleNamespace(camera_height=1.9)
        return a

    def test_ordre(self):
        self.assertEqual(self.app({"count": 20, "lidar": True, "height": 2.02, "spread": 0.02})._fall_camera()[:2],
                         (2.02, "séquence"))
        declared = {"count": 0, "lidar": True, "height": 3.1}  # photo de précision déclarée : sol sous elle
        self.assertEqual(self.app(declared, {"height": 1.95, "sigma": 0.1})._fall_camera()[:2], (1.95, "calée"))
        a = self.app(declared)
        self.assertIsNone(a._fall_camera())  # à demander
        a.use_fall_setting = App.use_fall_setting.__get__(a)
        a.fall_setting = True
        self.assertEqual(a._fall_camera()[:2], (1.9, "réglage"))

    def test_monture(self):
        """Photo du CD21 sans hauteur mesurée ni calée (sur un pont, 13/11/2026) : la monture de sa date, sans rien demander ;
        aussi pour les objets posés au sol, et dans l'export ; pas pour la vue du dessus (mount=False)."""
        declared = {"count": 0, "precise": True, "lidar": False, "height": None}
        item = {"collection": "s", "providers": [{"id": App.FLEET_PRODUCER}], "properties": {"datetime": "2025-08-01T10:00:00Z"}}
        a = self.app(declared, item=item)
        self.assertEqual(a._fall_camera(), (2.07, "monture", App.MOUNT_SIGMA))
        self.assertEqual(a._camera_height(), 2.07)
        self.assertEqual(a._camera_height(mount=False), 1.9)
        item["properties"]["datetime"] = "2025-06-01T10:00:00Z"
        self.assertEqual(a.camera_of(item, declared)[:2], (1.93, "monture"))
        other = dict(item, providers=[{"id": "autre"}])
        self.assertIsNone(self.app(declared, item=other)._fall_camera())  # autre producteur : à demander, comme avant


class Parcours(unittest.TestCase):
    """Mesures de bout en bout dans App, comme les pages d'essai du navigateur (essai-libre, essai-rtk, essai-largeur,
    essai-releve, navigateur) mais sans réseau : deux photos 360° à 6 m l'une de l'autre sur une route nord-sud, sol plat, caméra
    à 1,9 m ; les clics visent des points connus (cap et élévation en radians, repère de la photo)."""

    CAMERA = 1.9
    NORTH = {"p1": 0.0, "p2": 6.0}
    A, B = (5.0, 3.0, 0.0), (5.0, 7.0, 0.0)  # au sol, à 5 m à l'est (est, nord, z en m)

    def setUp(self):
        self.app = App(lambda *args: None)
        host.install(**HOST)  # App installe le réseau du navigateur : retiré

    def tearDown(self):
        host.install(**HOST)

    def show(self, pic):
        lon, lat = triangulation._geographic(0.0, self.NORTH[pic], 5.0415, 47.3220)
        self.app.set_picture(json.dumps({
            "id": pic, "collection": "s1", "type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"view:azimuth": 0, "datetime": "2026-01-01T00:00:00Z",
                           "pers:interior_orientation": {"field_of_view": 360}}, "links": []}))
        self.app.set_active(True)

    def aim(self, pic, t, pitch=None):
        """Clic depuis la photo pic vers t (est, nord, z), ou à l'élévation pitch."""
        dx, dy = t[0], t[1] - self.NORTH[pic]
        return self.app.click(math.atan2(dx, dy), math.atan2(t[2] - self.CAMERA, math.hypot(dx, dy)) if pitch is None else pitch)

    def sighted(self, t, pitch=None):
        """Visées de t depuis les deux photos, puis point gardé (bouton « Valider »)."""
        for pic in ("p1", "p2"):
            self.show(pic)
            self.aim(pic, t, pitch)
        return self.app.keep_point()

    def metres(self, text):
        return float(re.search(r"(\d+,\d+) m", text).group(1).replace(",", "."))

    def test_distance_libre(self):
        self.app.set_mode("tri")
        self.sighted(self.A)
        self.assertIn("Distance A–B : 4,00 m", self.sighted(self.B))
        values = [f["properties"]["valeur_m"] for f in json.loads(self.app.export_geojson())["features"]
                  if f["properties"]["type"].startswith("distance")]
        self.assertEqual(len(values), 1)
        self.assertAlmostEqual(values[0], 4.0, delta=0.02)

    def test_hauteur_depuis_A(self):
        a = self.app
        a.set_mode("height")
        self.assertIn("c'est le pied", self.sighted(self.A, pitch=-0.35))  # pied : visées à -0,35 rad
        foot = [f for f in json.loads(a.map_geojson())["features"] if f["properties"]["kind"] == "triangule"][-1]
        d = math.hypot(*triangulation._local(*foot["geometry"]["coordinates"], *triangulation._geographic(0.0, 6.0, 5.0415, 47.3220)))
        cross = next(m for m in json.loads(a.viewer_marks()) if len(m["points"]) == 1
                     and not m.get("guide") and not m.get("sighting") and not m.get("vertical"))
        a.click(*cross["points"][0][:2], True)  # clic sur la croix de A : sélection, Entrée : désélection
        self.assertTrue(json.loads(a.state())["point_sel"])
        a.finish_point()
        self.assertFalse(json.loads(a.state())["point_sel"])
        status = self.aim("p2", self.A, pitch=0.3)  # sommet
        self.assertTrue(status.startswith("Hauteur :"), status)
        self.assertAlmostEqual(self.metres(status), d * (math.tan(0.3) + math.tan(0.35)), delta=0.02)
        self.show("p1")
        self.aim("p1", self.A, pitch=0.2)  # hauteur faite : autre clic refusé
        self.assertEqual(sum(r["text"].startswith("↕") for r in json.loads(a.results())), 1)
        a.new_measure()  # « Nouvelle mesure depuis A »
        self.assertTrue(self.aim("p1", self.A, pitch=0.2).startswith("Hauteur :"))

    def test_largeur_depuis_A(self):
        a = self.app
        a.set_mode("road")
        self.assertIn("Cliquez maintenant le bord opposé", self.sighted(self.A))
        self.show("p1")
        status = self.aim("p1", (-3.0, 3.0, 0.0), pitch=-0.3)  # seule la direction du clic compte
        self.assertTrue(status.startswith("Largeur perpendiculaire à la chaussée"), status)
        self.assertAlmostEqual(self.metres(status), 8.0, delta=0.02)
        widths = lambda: [m for m in json.loads(a.viewer_marks()) if m["label"].startswith("↔")]
        self.aim("p1", (-7.0, 3.0, 0.0), pitch=-0.3)  # autre clic refusé : une seule largeur
        self.assertEqual(len(widths()), 1)
        a.new_measure()
        self.assertAlmostEqual(self.metres(self.aim("p1", (-7.0, 3.0, 0.0), pitch=-0.3)), 12.0, delta=0.02)
        listed = json.loads(a.results())  # liste : point de référence, puis ses largeurs nommées (#30)
        self.assertEqual(listed[0]["kind"], "point")
        self.assertTrue(all(r.get("sous") and re.match(r"^↔ [A-Z] ", r["text"]) for r in listed[1:]), listed)
        self.assertEqual(len(listed), 3)

    def test_releve(self):
        a = self.app
        a.set_mode("releve")
        self.sighted(self.A)
        a.set_releve(0, json.dumps({"distance_bord_m": 2.4, "essence": "tilleul"}))
        self.show("p2")
        self.aim("p2", self.B)  # une seule visée : gardé sur cette photo
        self.assertGreater(json.loads(a.state())["single_m"], 0)
        a.keep_single()
        a.set_releve(1, json.dumps({"distance_bord_m": 3, "essence": "chêne", "etat": "penché"}))
        first, second = json.loads(a.export_geojson(True))["features"]
        self.assertEqual((first["properties"]["distance_bord_m"], first["properties"]["essence"], first["properties"]["nb_visees"]),
                         (2.4, "tilleul", 2))
        self.assertEqual((second["properties"]["etat"], second["properties"]["nb_visees"], first["properties"].get("etat")),
                         ("penché", 1, None))
        target = triangulation._geographic(self.B[0], self.B[1], 5.0415, 47.3220)
        self.assertLess(math.hypot(*triangulation._local(*second["geometry"]["coordinates"], *target)), 0.05)
        self.assertEqual(json.loads(a.export_geojson())["features"], [])  # mesures sans les objets relevés
        a.set_mode("tri")
        a.clear_all()  # « Tout effacer » hors relevé : objets relevés gardés
        self.assertEqual(len(json.loads(a.export_geojson(True))["features"]), 2)

    def test_couche(self):
        """Couche importée : point et ligne proches projetés dans la photo (à plat, sans LiDAR HD), point lointain écarté."""
        a = self.app
        self.show("p1")
        here = lambda east, north: list(triangulation._geographic(east, north, 5.0415, 47.3220))
        self.assertEqual(a.set_overlay(json.dumps([
            {"id": 0, "geometry": {"type": "Point", "coordinates": here(5.0, 3.0)}},
            {"id": 1, "geometry": {"type": "LineString", "coordinates": [here(5.0, 3.0), here(0.0, 3.0)]}},
            {"id": 2, "geometry": {"type": "Point", "coordinates": here(500.0, 0.0)}}])), 3)
        marks = json.loads(a.overlay_marks())
        self.assertEqual([(m["id"], m["kind"]) for m in marks], [(1, "ligne"), (0, "point")])  # du plus proche au plus loin
        yaw, pitch = marks[1]["points"][0]
        self.assertAlmostEqual(yaw, math.atan2(5.0, 3.0), places=6)
        self.assertAlmostEqual(pitch, -math.atan2(self.CAMERA, math.hypot(5.0, 3.0)), places=6)
        a.set_overlay("[]")
        self.assertEqual(a.overlay_marks(), "[]")

    def test_couche_attend_le_sol_de_la_camera(self):
        """Couche : rien de dessiné tant que le sol de la caméra se lit (pas de saut) ; sans réponse, objets à plat."""
        a, host = self.app, web_app.host
        waiting, old = [], host.fetch_json
        host.fetch_json = lambda url, done, timeout_ms=None: waiting.append((done, timeout_ms))
        try:
            self.show("p1")
            here = lambda east, north: list(triangulation._geographic(east, north, 5.0415, 47.3220))
            a.set_overlay(json.dumps([{"id": 0, "geometry": {"type": "Point", "coordinates": here(5.0, 3.0)}}]))
            self.assertEqual(a.overlay_marks(), "[]")
            done, timeout_ms = waiting[-1]
            self.assertEqual(timeout_ms, a.OVERLAY_TIMEOUT_MS)
            done(None, "pas de réponse en 5 s")  # délai dépassé : à plat
            yaw, pitch = json.loads(a.overlay_marks())[0]["points"][0]
            self.assertAlmostEqual(pitch, -math.atan2(self.CAMERA, math.hypot(5.0, 3.0)), places=6)
        finally:
            host.fetch_json = old

    def test_couche_sol_garde_entre_photos(self):
        """Sol LiDAR HD de la couche gardé par sommet : la photo voisine ne relit que sa caméra ; objet sur le sol."""
        a, host = self.app, web_app.host
        asked = []
        old = host.fetch_json
        host.fetch_json = lambda url, done, timeout_ms=None: (asked.append(url), done(
            {"elevations": [{"z": 200.0}] * (url.split("lon=")[1].split("&")[0].count("|") + 1)}, None))
        try:
            self.show("p1")
            here = lambda east, north: list(triangulation._geographic(east, north, 5.0415, 47.3220))
            a.set_overlay(json.dumps([{"id": 0, "geometry": {"type": "LineString", "coordinates": [here(5.0, 3.0), here(5.0, 30.0)]}}]))
            a.overlay_marks()
            first = asked[-1].split("lon=")[1].split("&")[0].count("|") + 1
            self.assertGreater(first, 2)  # caméra et sommets (ligne redécoupée)
            self.show("p2")
            before = len(asked)
            marks = json.loads(a.overlay_marks())
            self.assertEqual(len(asked), before + 1)
            self.assertEqual(asked[-1].split("lon=")[1].split("&")[0].count("|") + 1, 1)  # caméra de p2 seulement
            a.overlay_marks()
            self.assertEqual(len(asked), before + 1)  # tout est connu : plus de lecture
            yaw, pitch = marks[0]["points"][0]  # sol de niveau avec la caméra : comme à plat
            self.assertAlmostEqual(pitch, -math.atan2(self.CAMERA, math.hypot(5.0, 3.0 - 6.0)), places=6)
        finally:
            host.fetch_json = old

    def test_point_au_dessus_du_sol(self):
        """Étiquette de la parcelle visée : point de la carte à 1,50 m du sol (sol de niveau), dans la photo ; à la
        hauteur de la caméra, il est à l'horizon."""
        a = self.app
        self.show("p1")
        at = triangulation._geographic(5.0, 3.0, 5.0415, 47.3220)
        p = json.loads(a.view_point(*at, 1.5))
        self.assertAlmostEqual(p["yaw"], math.atan2(5.0, 3.0), places=6)
        self.assertAlmostEqual(p["pitch"], -math.atan2(self.CAMERA - 1.5, math.hypot(5.0, 3.0)), places=6)
        self.assertAlmostEqual(json.loads(a.view_point(*at, self.CAMERA))["pitch"], 0.0, places=9)
        # Sol lu sous la caméra et sous le point (LiDAR HD) : point 1 m plus bas, étiquette d'autant plus basse
        old, redrawn = precision.fetch_terrain, []
        precision.fetch_terrain = lambda points, done, timeout_ms=None: done([300.0, 299.0], "LiDAR HD", None)
        a.notify = lambda: redrawn.append(1)
        try:
            far = triangulation._geographic(5.0, 3.5, 5.0415, 47.3220)  # autre point : pas encore lu
            p = json.loads(a.view_point(*far, 1.5))
        finally:
            precision.fetch_terrain = old
        self.assertEqual(redrawn, [1])
        self.assertAlmostEqual(p["pitch"], -math.atan2(self.CAMERA - 1.5 + 1.0, math.hypot(5.0, 3.5)), places=6)

    def test_calage_objet_vertical(self):
        """Calage : pied, sommet, sommet sélectionné sur sa croix puis déplacé, validation (navigateur.html)."""
        a = self.app
        a.set_mode("tilt")
        self.show("p1")
        a.click(0.62, -0.12)
        a.click(0.64, 0.35)
        marks = lambda: [m["points"] for m in json.loads(a.viewer_marks()) if m.get("calage")]
        self.assertEqual(marks(), [[[0.62, -0.12, False], [0.64, 0.35, False]]])
        a.click(0.64 + 0.0029, 0.35, False)  # la page n'a pas vu de croix (à 10 px au zoom fort) : pas de sélection
        self.assertFalse(marks()[0][1][2])
        a.click(0.64, 0.35, True)  # sur la croix : sélectionné
        self.assertTrue(marks()[0][1][2])
        a.click(0.625, 0.35)  # nouvelle position
        self.assertEqual(marks()[0][1], [0.625, 0.35, False])
        self.assertIn("1 objet calé", a.validate_tilt())
        self.assertEqual(marks(), [])  # croix effacées après validation
        self.assertEqual(len(json.loads(a.calibration_json())["verticals"]["p1"]), 1)
        other = App(lambda *args: None)  # calage gardé dans le navigateur, relu au chargement
        host.install(**HOST)
        self.assertTrue(other.load_calibration(a.calibration_json()))
        self.assertEqual(json.loads(other.calibration_json())["verticals"], json.loads(a.calibration_json())["verticals"])

    def test_effacer_retablir(self):
        a = self.app
        a.set_mode("tri")
        self.sighted(self.A)
        self.sighted(self.B)
        distances = lambda: [f for f in json.loads(a.export_geojson())["features"] if f["properties"]["type"].startswith("distance")]
        self.assertEqual(len(distances()), 1)
        self.assertEqual(a.undo(), "Point B effacé.")
        self.assertEqual(distances(), [])
        self.assertEqual(a.redo(), "Rétabli.")
        self.assertEqual(len(distances()), 1)

    def test_bandes_triangulees(self):
        """Passage piéton : coins des bandes (0,50 m, de 8 à 11 m devant la première, à 1,5 m au moins de l'axe des
        photos : dans l'axe, visées parallèles) triangulés depuis les deux photos ; largeur de chaque bande au millimètre."""
        self.app.set_mode("tri")
        corners = lambda: [f["geometry"]["coordinates"] for f in json.loads(self.app.map_geojson())["features"]
                           if f["properties"]["kind"] == "triangule"]
        origin = (5.0415, 47.3220)
        for k, left in enumerate((-4.0, -3.0, -2.0, 1.5, 2.5, 3.5)):  # hors de l'axe des photos : visées presque parallèles
            for north in (8.0, 11.0):
                self.sighted((left, north, 0.0))
                a = corners()[-1]
                self.sighted((left + 0.5, north, 0.0))
                b = corners()[-1]
                ea, na = triangulation._local(*a[:2], *origin)
                eb, nb = triangulation._local(*b[:2], *origin)
                self.assertAlmostEqual(eb - ea, 0.5, delta=0.001, msg=f"bande {k}, à {north} m")
                self.assertAlmostEqual(nb - na, 0.0, delta=0.001)
                self.assertAlmostEqual(ea, left, delta=0.002)

    def test_releve_recharge(self):
        """Relevé gardé dans le navigateur (releve_json), remis au rechargement (load_releve)."""
        self.app.set_mode("releve")
        self.sighted(self.A)
        self.app.set_releve(0, json.dumps({"essence": "tilleul"}))
        other = App(lambda *args: None)
        host.install(**HOST)
        other.load_releve(self.app.releve_json())
        self.assertEqual([f["properties"]["essence"] for f in json.loads(other.export_geojson(True))["features"]], ["tilleul"])


if __name__ == "__main__":
    unittest.main()
