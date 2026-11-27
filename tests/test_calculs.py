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
import web_chutes  # noqa: E402
import web_profils  # noqa: E402
from core import calibration, host, precision, roads, triangulation  # noqa: E402

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
            auto_off = set()
            position = staticmethod(lambda *a: None)
            pose = staticmethod(lambda *a: {"offset": 1.5})
            tilt = staticmethod(lambda pic, photo_only=False: {"up": (0.0, 0.1, 0.99), "sigma": 0.2})
            camera = staticmethod(lambda seq: None)
            @classmethod
            def set_bridge_photo(cls, pic, on):
                (cls.bridge_pics.add if on else cls.bridge_pics.discard)(pic)

        Cal.bridge_pics = set()

        class Tilts:
            pending = staticmethod(lambda pic, photo_only=False: False)

        a = App.__new__(App)
        a.calibration, a.tilts, a.quality = Cal, Tilts, {"precise": True, "lidar": True, "height": 2.4, "spread": 0.02}
        a.item = {"id": "p", "collection": "s", "geometry": {"coordinates": [5.0, 47.0, 300.0]},
                  "properties": {"view:azimuth": 40, "pers:interior_orientation": {"field_of_view": field_of_view}}}
        a.birdeye_items, a.birdeye_checks = [dict(a.item, id="v", geometry={"coordinates": [5.0, 47.00005]})], (Tilts,)
        a.fall_cells, a.fall_retry, a.fall_error, a.tool = {roads._cell(5.0, 47.0): []}, {}, {}, types.SimpleNamespace(camera_height=2.1)
        a.roads, a.neighbours, a._bridge_waiting_items = roads.RoadAxisProvider(), {}, {}
        a.roads._sections[roads._cell(5.0, 47.0)] = []  # tronçons BD TOPO de la maille : aucun
        a.birdeye_loose, a.birdeye_far_items = {}, []
        return a

    def test_defaut_de_roulis(self):
        """Défaut de roulis de la caméra (profil de campagne) : CD21, campagne 2025 seulement ; ni avant, ni après, ni ailleurs."""
        a = App.__new__(App)
        photo = lambda producer, date: {"providers": [{"id": producer}], "properties": {"datetime": date}}
        self.assertEqual(a._roll_defect(photo(App.FLEET_PRODUCER, "2025-07-03T10:53:25Z")), 1.0)  # penché à droite de 1° (convention du véhicule)
        for producer, date in ((App.FLEET_PRODUCER, "2024-12-31T23:00:00Z"), (App.FLEET_PRODUCER, "2026-01-02T09:00:00Z"),
                               ("autre", "2025-07-03T10:53:25Z")):
            self.assertEqual(a._roll_defect(photo(producer, date)), 0.0)
        self.assertEqual(a._roll_defect({}), 0.0)  # sans producteur ni date

    def test_profils_de_campagne(self):
        """Table des profils datés (#70) : valide ; contrôle qui détecte champ manquant et chevauchement ; profil par producteur et date
        (monture basse jusqu'au 23/06/2025, haute dès le 24/06, valeurs inchangées) ; rien ailleurs."""
        profiles = web_profils.CAMPAIGN_PROFILES
        self.assertEqual(web_profils.check_profiles(profiles), [])
        broken = [dict(profiles[0], first="2025-03-01"), dict(profiles[1], first="2025-03-01")]  # deux périodes du même producteur se chevauchent
        self.assertTrue(any("chevauchent" in p for p in web_profils.check_profiles(broken)))
        self.assertTrue(any("champ manquant (height)" in p for p in web_profils.check_profiles([{**profiles[0], "height": None}])))
        self.assertTrue(any("n'est pas avant" in p for p in web_profils.check_profiles([dict(profiles[0], end="2025-01-01")])))
        a = App.__new__(App)
        photo = lambda producer, date: {"providers": [{"id": producer}], "properties": {"datetime": date}}
        low, high = (a._profile(photo(App.FLEET_PRODUCER, d)) for d in ("2025-06-23T12:39:00Z", "2025-06-24T12:12:00Z"))
        self.assertEqual((low["id"], low["height"], low["roll"]), ("cd21-2025-clio5-basse", 1.93, 1.0))
        self.assertEqual((high["id"], high["height"], high["roll"], high["height_sigma"], high["roll_sigma"]), ("cd21-2025-clio5-haute", 2.07, 1.0, 0.04, 1.0))
        self.assertEqual(a._mount_height(photo(App.FLEET_PRODUCER, "2025-06-23T12:39:00Z")), (1.93, 0.04))
        self.assertEqual(a._fleet_mount(photo(App.FLEET_PRODUCER, "2025-06-24T00:00:00Z")), 2.07)
        for producer, date in (("autre", "2025-07-03T10:53:25Z"), (App.FLEET_PRODUCER, "2024-12-31T23:00:00Z"), (App.FLEET_PRODUCER, "2026-01-01T00:00:00Z")):
            self.assertIsNone(web_profils.profile_of(photo(producer, date)))
        self.assertIsNone(web_profils.profile_of({}))
        info = a._profile_info(photo(App.FLEET_PRODUCER, "2025-08-01T10:00:00Z"))
        self.assertEqual((info["label"], info["first"], info["end"]), ("CD21 2025, Clio 5, monture haute", "2025-06-24", "2026-01-01"))

    def test_roulis_vehicule_convention(self):
        """Roulis du véhicule : positif = penché à droite ; le cœur a la convention inverse (verticale penchée à droite = caméra à gauche),
        changée en un seul endroit (roulis_vehicule_depuis_camera). Le défaut CD21 2025 (+1°) donne la même verticale qu'avant (-1° du cœur)."""
        from web_pose import roulis_vehicule_depuis_camera as convert
        self.assertEqual((convert(1.0), convert(-0.5), convert(None)), (-1.0, 0.5, None))
        self.assertEqual(repr(convert(0.0)), "0.0")  # pas de -0.0
        # véhicule penché à droite de 1° : la verticale vraie paraît penchée de 1° vers la gauche sur la photo (roulis du cœur -1°)
        up = calibration.up_from_components(0.0, convert(web_profils.CAMPAIGN_PROFILES[0]["roll"]), 90.0)
        self.assertAlmostEqual(calibration.tilt_components(up, 90.0)[1], -1.0, places=9)
        # le panneau de calage rend le roulis dans la convention du véhicule : verticale vue penchée de 0,5° à droite = véhicule à gauche
        self.assertAlmostEqual(convert(calibration.tilt_components(calibration.up_from_components(1.0, 0.5, 0.0), 0.0)[1]), -0.5, places=9)

    def test_pose(self):
        pose = json.loads(self.app_on(360).birdeye_pose())
        self.assertEqual((pose["lon"], pose["heading"], pose["offset"], pose["height"]), (5.0, 40.0, 1.5, 2.4))
        self.assertEqual((pose["up"], pose["sigma"], pose["height_sigma"]), ([0.0, 0.1, 0.99], 0.2, 0.05))
        self.assertEqual([(n["pic"], n["lat"], n["relative_sigma"]) for n in pose["neighbours"]], [("v", 47.00005, 0.05)])

    def test_pose_impossible(self):
        """birdeye_impossible : vrai pour la photo affichée sans pose (pas 360°), faux avec pose ou pour une autre photo."""
        flat, ok = self.app_on(90), self.app_on(360)
        self.assertEqual(flat.birdeye_pose(), "null")
        self.assertTrue(flat.birdeye_impossible("p"))
        self.assertFalse(flat.birdeye_impossible("autre"))  # autre photo affichée : pose pas encore prête
        self.assertFalse(ok.birdeye_impossible("p"))

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
        # second véhicule dès le 24/06/2025 (hauteur lue 2,04 m le 25/06 : f533e240-7d37-40ef-babc-1d37140dc5d2, 2,10 m le 27/06)
        for date, mount in (("2025-06-23T12:39:00Z", 1.93), ("2025-06-24T12:12:00Z", 2.07), ("2025-06-25T09:34:30Z", 2.07)):
            a.item["properties"]["datetime"] = date
            self.assertEqual(json.loads(a.birdeye_pose())["mount"], mount, date)

    def test_hors_360(self):
        self.assertEqual(self.app_on(90).birdeye_pose(), "null")

    def test_pont(self):
        """Photo marquée sur un pont par le cœur (tronçon en pont à 8 m au plus, dans le sens de la séquence) : signalée, hauteur de
        caméra hors sol LiDAR (le réglage), voisine marquée de même ; photo non marquée à 18 m d'un pont (remblai) : pas de
        sol plat, terrain LiDAR gardé, avec l'emprise du pont à écarter (deck)."""
        def pose_with(side, start=-20.0, end=20.0):  # tronçon en pont parallèle au cap de la photo (40°), side m à droite, de start à end m en long
            a = self.app_on(360)
            h = math.radians(40.0)
            line = [list(triangulation._geographic(side * math.cos(h) + t * math.sin(h), -side * math.sin(h) + t * math.cos(h), 5.0, 47.0))
                    for t in (start, end)]
            a.roads._sections[roads._cell(5.0, 47.0)] = [{"level": 1, "line": line}]
            return json.loads(a.birdeye_pose())
        near = pose_with(2)
        self.assertEqual((near["bridge"], near["height"], near["neighbours"][0]["height"], near["deck"]), (True, 2.1, 2.1, []))
        shoulder = pose_with(10)  # à 10 m de l'axe : hors de la portée de 8 m du cœur (non marquée), mais sol plat (15 m, voir test_sol_plat_pres_d_un_pont)
        self.assertEqual((shoulder["bridge"], shoulder["height"], shoulder["neighbours"][0]["height"]), (False, 2.4, 2.4))
        self.assertEqual(shoulder["deck"], [])
        shoulder = pose_with(18)  # à 18 m : relief gardé, avec l'emprise du pont à écarter
        self.assertEqual((shoulder["bridge"], shoulder["flat"], len(shoulder["deck"])), (False, False, 1))
        self.assertEqual(shoulder["deck_half"], roads.DECK_HALF_WIDTH)
        mixed = pose_with(5)  # photo dessus, sa voisine à 8,6 m de l'axe : hauteur seulement pour la photo marquée
        self.assertEqual((mixed["bridge"], mixed["height"], mixed["neighbours"][0]["height"]), (True, 2.1, 2.4))
        ahead = pose_with(0.0, 20.0, 60.0)  # pont commençant 20 m devant la photo, dans l'axe : approche, pas dessus
        self.assertEqual((ahead["bridge"], ahead["height"], len(ahead["deck"])), (False, 2.4, 1))
        crossing = pose_with(0.0, -20.0, 20.0)
        self.assertEqual(crossing["bridge"], True)

    def test_sol_plat_pres_d_un_pont(self):
        """Pont BD TOPO à 15 m au plus de la photo à vol d'oiseau (avant, sur ou après, tablier le plus proche) : sol supposé plat
        (flat), sans marquage « sur un pont » au-delà de 8 m, sans emprise à écarter ; à 30 m : relief gardé."""
        def pose_with(side, start=-20.0, end=20.0):
            a = self.app_on(360)
            h = math.radians(40.0)
            line = [list(triangulation._geographic(side * math.cos(h) + t * math.sin(h), -side * math.sin(h) + t * math.cos(h), 5.0, 47.0))
                    for t in (start, end)]
            a.roads._sections[roads._cell(5.0, 47.0)] = [{"level": 1, "line": line}]
            return json.loads(a.birdeye_pose())
        on = pose_with(2)
        self.assertEqual((on["bridge"], on["flat"], on["deck"], on["flat_radius"]), (True, True, [], roads.BRIDGE_FLAT_RADIUS))
        side = pose_with(10)  # remblai à 10 m de l'axe : non marqué, mais pont à moins de 15 m
        self.assertEqual((side["bridge"], side["flat"], side["deck"]), (False, True, []))
        before = pose_with(0.0, 12.0, 50.0)  # pont commençant 12 m devant la photo
        self.assertEqual((before["bridge"], before["flat"]), (False, True))
        after = pose_with(0.0, -50.0, -12.0)  # pont fini 12 m derrière
        self.assertEqual(after["flat"], True)
        far = pose_with(30)
        self.assertEqual((far["bridge"], far["flat"]), (False, False))
        self.assertEqual(pose_with(0.0, 20.0, 60.0)["flat"], False)  # tablier à 20 m devant : relief
        self.assertEqual(self.app_on(360).birdeye_pose().count('"flat": false'), 1)  # aucun pont : relief

    def test_pont_detecte_dans_la_ligne_d_etat(self):
        """Mode « sur un pont » activé d'après la BD TOPO : la ligne « Position » le dit (« sur un pont (détecté) »), pas sinon."""
        a = App.__new__(App)
        a.bridge = False
        self.assertEqual(a._bridge_note("Position GPS vérifiée (±0,10 m)"), "Position GPS vérifiée (±0,10 m)")
        a.bridge = True
        self.assertEqual(a._bridge_note("Position GPS vérifiée (±0,10 m)"), "Position GPS vérifiée (±0,10 m) · sur un pont (détecté)")

    def test_pont_monture_cd21(self):
        """CD21 sur un pont, hauteur de séquence inconnue : monture d'après la date de prise de vue, pas le réglage
        (1,90 m par défaut : bandes de passage piéton à 0,44 m, f2a245d0-aeea-4249-ba9c-fad83b442a23 et
        7dcdccf9-3c52-4c54-bc5b-de72740a7967) ; date hors campagne : le réglage."""
        def pose_on(date):
            a = self.app_on(360)
            a.item["providers"] = [{"id": App.FLEET_PRODUCER}]
            a.item.setdefault("properties", {})["datetime"] = date
            h = math.radians(40.0)
            line = [list(triangulation._geographic(t * math.sin(h), t * math.cos(h), 5.0, 47.0)) for t in (-20.0, 20.0)]
            a.roads._sections[roads._cell(5.0, 47.0)] = [{"level": 1, "line": line}]
            return json.loads(a.birdeye_pose())
        self.assertEqual([(p["height"], p["height_sigma"]) for p in (pose_on("2025-05-28T05:40:22Z"), pose_on("2025-07-07T05:56:32Z"))],
                         [(1.93, 0.04), (2.07, 0.04)])
        self.assertEqual(pose_on("2024-05-28T05:40:22Z")["height"], 2.1)
        low, high = pose_on("2025-05-28T05:40:22Z"), pose_on("2025-07-07T05:56:32Z")  # montures et profil transmis à la vue (src/dessus.js)
        self.assertEqual((low["mounts"], low["mount_sigma"], low["profile"]["id"]), ([1.93, 2.07], 0.04, "cd21-2025-clio5-basse"))
        self.assertEqual(high["profile"]["label"], "CD21 2025, Clio 5, monture haute")
        self.assertIsNone(pose_on("2024-05-28T05:40:22Z")["profile"])

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
        web_tilt.autotilt.fit = lambda pairs, heading=None: calls.append(1) or (None if len(calls) == 1 else loose)
        try:
            res = web_tilt.estimate(b"", 0.0)
        finally:
            web_tilt.host.decode_band, web_tilt.autotilt.segments, web_tilt.autotilt.fit = saved
        self.assertEqual((res["reason"], res["loose"]["sigma"]), (web_tilt.FEW_EDGES, 0.42))
        a = self.app_on(360)
        a.calibration.tilt = staticmethod(lambda pic, photo_only=False: None)
        a.birdeye_loose = {"p": res["loose"]}
        pose = json.loads(a.birdeye_pose())
        self.assertEqual((pose["up"], pose["sigma"]), ([0.0, -0.052, 0.9986], 0.42))
        a.calibration.tilt = staticmethod(lambda pic, photo_only=False: {"up": (0.0, -0.016, 0.9999), "sigma": 0.5})  # relais par le terrain
        self.assertEqual(json.loads(a.birdeye_pose())["sigma"], 0.42)
        a.calibration.tilt = staticmethod(lambda pic, photo_only=False: {"up": (0.0, 0.0, 1.0), "sigma": 0.2})  # calage plus sûr : gardé
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
        sections = roads.parse_sections({"features": [road(4.999, 5.0), road(5.0, 5.001), *features]})
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
        key = ("photo", 17, False)  # réglette depuis le milieu : 10 m au-delà du bord une fois le droit à 8 m (gauche à 6)
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
        key = ("photo", 14, False)  # réglette depuis le milieu : 10 m au-delà des bords à ±4 m
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
            self.assertFalse(r["devers"][5])

    def test_mur(self):  # mur de 2 m (P18) : paroi quasi verticale, pas de pourcentage
        _, r = self.profile(4.0, 20.0, 2.0)
        self.assertAlmostEqual(r["chute"][0], 2.0, delta=0.01)
        self.assertTrue(r["devers"][5])


def edges_on(z, width=8.0, twin=None, zone=14, axis_x=None, ends=([], None, [])):  # zone depuis le milieu : 10 m au-delà de bords à ±4 m
    """Bords (App._compute_edges) sur un terrain synthétique z(x, y), en m : x vers la droite de la photo, y le long de la
    route (photo en y = 0) ; axe BD TOPO en x = 0, profil depuis l'axe ; axis_x : axe en x = axis_x, profil depuis la
    caméra (séquence RTK), en x = 0 ; twin : autre chaussée [(ligne, largeur)]. Rend self.edges[clé]."""
    lon, lat = 5.0, 47.0
    calc = App.__new__(App)
    calc.edges, calc.paved, calc.paved_redo = {}, {}, {}
    calc.notify = lambda: None
    calc._terrain = lambda points, done: done(
        [z(*web_app.triangulation._local(p[0], p[1], lon, lat)) for p in points], web_app.triangulation.LIDAR_NAME, None)
    key = ("photo", zone, axis_x is not None)
    ax = axis_x or 0.0
    calc._compute_edges(key, [(ax, -200.0), (ax, 200.0)], 200.0, width, 0.0, lon, lat, twin=twin, ends=ends)
    return calc.edges[key]


class BordsCarrefour(unittest.TestCase):
    """Carrefour avec une voie nommée près de la photo : bords signalés peu sûrs (D16 d946f2cf-cddc-4476-a414-35aee429c05a)."""

    def test_carrefour_proche(self):
        res = edges_on(lambda x, y: 0.0, ends=([((0.0, 6.0), "carrefour", ["D18"])], "D16", []))
        self.assertEqual({k: v for k, v in res["profile"]["carrefour"].items() if k != "texte"}, {"d": 6.0, "avec": ["D18"]})
        self.assertTrue(res["profile"]["carrefour"]["texte"].startswith("Carrefour avec la D18 6 m devant"))
        self.assertTrue(res["text"].startswith("Carrefour avec la D18 6 m devant : bords peu sûrs"), res["text"])

    def test_carrefour_loin_ou_fin(self):
        for ends in ([((0.0, -20.0), "carrefour", ["D18"])], [((0.0, 3.0), "fin", ["D18"])]):
            res = edges_on(lambda x, y: 0.0, ends=(ends, "D16", []))
            self.assertIsNone(res["profile"]["carrefour"], ends)
            self.assertNotIn("Carrefour", res["text"])


class BordsCas(unittest.TestCase):
    """Cas types des bords de route sur terrain synthétique (piste P1 de docs/analyses/pistes-profil.md)."""

    TWIN = (([(11.0, -200.0), (11.0, 200.0)], 7.0),)  # autre chaussée à droite, axe à 11 m

    @staticmethod
    def entry(res, side, along=0.0):
        return next(e for e in res["profile"]["profils"] if e["cote"] == side and e["le_long"] == along)

    def test_plain_pied(self):  # pas de rupture : demi-largeur type, aucune chute
        res = edges_on(lambda x, y: 0.0)
        for side in ("gauche", "droit"):
            e = self.entry(res, side)
            self.assertEqual((e["bord"], e["relief"], e["voisins"]), (4.0, False, False))
        self.assertEqual(res["profile"]["resultats"], {})
        self.assertIn("largeur type", res["title"])

    def test_butte(self):  # le terrain remonte de 1 m : lecture arrêtée, pas de chute
        res = edges_on(lambda x, y: min(1.5, (x - 5.0) * 0.5) if x > 5.0 else 0.0)
        e = self.entry(res, "droit")
        self.assertAlmostEqual(e["bord"], 5.0, delta=0.01)
        self.assertIsNotNone(e["arret"])
        self.assertNotIn("droit", res["profile"]["resultats"])
        self.assertIn("pas de chute avant le terrain qui remonte de 1 m", res["text"])

    def test_reglette_depuis_le_milieu(self):  # descente de 30 % dès 4 m : réglette à 8 m du milieu, lue jusqu'à 4 m du bord
        res = edges_on(lambda x, y: -(x - 4.0) * 0.3 if x > 4.0 else 0.0, zone=8)
        self.assertIn("Côté droit : chute ≥ 1,2 m", res["text"])

    def test_mur_sous_la_route(self):  # P18 : mur de 2 m, écrit sans pourcentage
        res = edges_on(lambda x, y: -2.0 if x > 4.1 else 0.0)
        self.assertIn("Côté droit : chute 2,0 m", res["text"])
        self.assertIn("paroi quasi verticale (mur, enrochement) sur 2,0 m de haut", res["text"])
        self.assertNotIn("dévers du talus", res["text"])

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


class BordsBombement(unittest.TestCase):
    """Profil depuis la caméra, dans sa voie à 1,75 m à droite de l'axe : de l'autre côté, la recherche du bord franchit le
    sommet du bombement ou le changement de dévers d'une voie à l'autre, qu'elle prenait pour le bord (piste P16 ; D104
    a04557c8-3b4d-4184-8b3e-ff7ed9fa4197, D70 229abfcd-868c-4eca-bfc1-3979ca94d28f)."""

    @staticmethod
    def left(res):
        return next(e for e in res["profile"]["profils"] if e["cote"] == "gauche" and e["le_long"] == 0)

    @staticmethod
    def ditch(z_road, edge, axis=-1.75):
        """Terrain : chaussée z_road(x) jusqu'à edge m de l'axe (en x = axis) des deux côtés, puis fossé de 1 m à 50 %."""
        def z(x, y):
            a = abs(x - axis)
            if a <= edge:
                return z_road(x)
            top = z_road(axis + edge if x > axis else axis - edge)
            return top - min(1.0, (a - edge) * 0.5)
        return z

    def test_toit(self):  # 4,5 % de chaque côté du sommet : bord gauche au vrai bord, à 5,5 m de la caméra (2 m avant)
        res = edges_on(self.ditch(lambda x: -0.045 * abs(x + 1.75), 3.75), width=7.5, axis_x=-1.75)
        self.assertEqual((self.left(res)["bord"], self.left(res)["relief"]), (5.5, True))
        self.assertIn("gauche", res["profile"]["resultats"])
        self.assertAlmostEqual(res["profile"]["resultats"]["gauche"]["chute"][0], 1.0, delta=0.05)

    def test_devers_par_voie(self):  # même sens, 1 % sous la caméra, 9,5 % sur l'autre voie (D70 : 3 et 8 à 11 %)
        res = edges_on(self.ditch(lambda x: 0.01 * x if x > -1.75 else -0.0175 + 0.095 * (x + 1.75), 3.75), width=7.5, axis_x=-1.75)
        self.assertEqual(self.left(res)["bord"], 5.5)

    def test_route_etroite(self):  # 5 m, voies de 2,5 m, caméra à 1,5 m de l'axe : bombement franchi, bord à 4 m
        res = edges_on(self.ditch(lambda x: -0.045 * abs(x + 1.5), 2.5, axis=-1.5), width=5.0, axis_x=-1.5)
        self.assertEqual(self.left(res)["bord"], 4.0)

    # D70 229abfcd-868c-4eca-bfc1-3979ca94d28f : 5 m BD TOPO, 12 m réels, fossé en V court : bord à 7,5 m
    def test_plus_large_que_la_bd_topo(self):
        def z(x, y):
            a = abs(x + 1.5)
            if a <= 6.0:
                return -0.045 * a
            return -0.27 - (0.6 * (a - 6.0) / 0.75 if a <= 6.75 else max(0.0, 0.6 - (a - 6.75) * 0.5))
        res = edges_on(z, width=5.0, axis_x=-1.5)
        self.assertEqual(self.left(res)["bord"], 7.5)

    # Travers relevés (MNT LiDAR HD, côté opposé à la caméra), bord d'enrobé de l'analyse fine : D24
    # 556607c2-418b-4878-848b-c9eaa438f820 (4,11 m), D17
    # ab10b6f3-30af-4a2f-a950-1e6930dd4555 (3,49 m) ; le bord du relief tombait sur la chaussée (1,5 et 2 m)
    D24 = ((0, 197.95), (0.5, 197.96), (1, 198.02), (1.5, 198.02), (2, 198.1), (2.5, 198.1), (3, 198.12), (3.5, 198.09), (4, 198.13),
           (4.5, 198.11), (5, 198.03), (5.5, 197.86), (6, 197.36), (6.5, 197.36), (7, 197.5), (7.5, 197.53), (8, 197.53), (8.5, 197.54),
           (9, 197.54), (9.5, 197.51), (10, 197.5), (10.5, 197.52), (11, 197.52), (11.62, 197.51))
    D17 = ((0, 504.82), (0.5, 504.84), (1, 504.81), (1.5, 504.81), (2, 504.81), (2.5, 504.76), (3, 504.76), (3.5, 504.72), (4, 504.72),
           (4.5, 504.59), (5, 504.43), (5.5, 504.24), (6, 503.89), (6.5, 503.89), (7, 503.86), (7.5, 503.89), (8, 503.85), (8.5, 503.82),
           (9.12, 503.83), (9.75, 503.82), (10.38, 503.78), (11, 503.79), (11.62, 503.72))

    def test_travers_releves(self):
        for points, axis, half, paved in ((self.D24, 2.32, 2.75, 4.11), (self.D17, 0.78, 2.0, 3.49)):
            offsets, z = [p[0] for p in points], [p[1] for p in points]
            reach = half + axis + app.EDGE_SEARCH
            before = app._edge_border(z, offsets, reach)  # sans l'axe : bombement pris pour le bord
            after = app._edge_border(z, offsets, reach, 0.0, axis)
            self.assertLess(offsets[before], paved - 1.0)
            self.assertGreaterEqual(offsets[after], paved - 0.25, (points[0], offsets[after]))

    def test_voie_unique(self):  # 3 m, caméra sur l'axe, accotement à 10 % sur 1,5 m puis fossé : le bord reste au bord
        def z(x, y):  # (près de l'axe, sur une seule voie, la rupture n'est pas prise pour un bombement)
            a = abs(x)
            return 0.0 if a <= 1.5 else -0.1 * (a - 1.5) if a <= 3.0 else -0.15 - min(1.0, (a - 3.0) * 0.5)
        res = edges_on(z, width=3.0, axis_x=0.0)
        self.assertEqual(self.left(res)["bord"], 1.5)

    def test_sans_bombement(self):  # chaussée plate : rien ne change, bord à 5,5 m
        res = edges_on(self.ditch(lambda x: 0.0, 3.75), width=7.5, axis_x=-1.75)
        self.assertEqual(self.left(res)["bord"], 5.5)


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
        gauche = [e for e in res["profile"]["profils"] if e["cote"] == "gauche"]  # plat partout : largeur type
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

    def test_troncons_redemandes(self):
        # tronçons d'une maille en échec : plus « BD TOPO injoignable » jusqu'au rechargement de la page
        host, asked = web_app.host, []
        old = host.fetch_json
        host.fetch_json = lambda url, done, timeout_ms=None: (asked.append(url), done(None, "HTTP 503"))
        try:
            a = App.__new__(App)
            a.fall_cells, a.fall_retry, a.fall_error, a.notify = {}, {}, {}, lambda: None
            self.assertIsNone(a._fall_sections(5.0, 47.0))
            self.assertIsNone(a._fall_sections(5.0, 47.0))  # pas tout de suite
            a.fall_retry[next(iter(a.fall_retry))] = 0.0  # délai écoulé
            a._fall_sections(5.0, 47.0)
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


class ChuteTablier(unittest.TestCase):
    """Hauteur de chute sans points classés pont dans le nuage (App._compute_fall) : bord du tablier dans le relief quand le
    MNT LiDAR HD le contient (tablier classé sol : D114 sur le ruisseau de la Gironde, photo
    e375c98e-31c5-426a-ba93-c63ac344d675), sinon la demi-largeur type (la largeur BD TOPO n'est plus lue)."""

    def fall(self, z):
        lon, lat = 5.0, 47.0
        geo = lambda x, y: web_app.triangulation._geographic(x, y, lon, lat)
        chain = [{"line": [geo(0.0, -15.0), geo(0.0, 15.0)], "level": 1, "width": 7.0, "importance": "3",
                  "nature": "Route à 1 chaussée", "name": "D1"}]
        photos = {"features": [{"collection": "c", "geometry": {"coordinates": list(geo(0.0, y))},
                                "properties": {"geovisio:rank_in_collection": k, "exif": {"Exif.GPSInfo.GPSAltitude": "101.9"}}}
                               for k, y in enumerate((-10.0, 0.0, 10.0))]}
        saved = host.fetch_json, host.ngf_altitude
        host.fetch_json = lambda url, done, *a, **k: done(photos, None)
        host.ngf_altitude = lambda lon, lat, altitude: altitude  # tablier : 101,9 − 1,9 = 100 m
        self.addCleanup(lambda: (setattr(host, "fetch_json", saved[0]), setattr(host, "ngf_altitude", saved[1])))
        calc = App.__new__(App)
        calc.falls = {}
        calc.notify = lambda: None
        calc._terrain = lambda points, done: done(
            [z(web_app.triangulation._local(p[0], p[1], lon, lat)[0]) for p in points], web_app.triangulation.LIDAR_NAME, None)
        key = ("c", (0.0, 0.0), (1.9, "séquence", 0.05))
        calc._compute_fall(key, chain, {"collection": "c"}, lon, lat)
        return calc.falls[key]

    def test_tablier_dans_le_mnt(self):  # tablier à 4 m de l'axe, rive à 0,5 m sous lui, chenal de 4 m étroit juste au-delà
        def z(x):
            a = abs(x)
            return 100.0 if a <= 4.0 else 96.0 if 4.75 < a < 5.25 else 99.5 if a <= 4.75 else 99.0
        res = self.fall(z)
        self.assertIn("max : 4,0 m", res["text"])  # au bord + 1 m (5 m) ; demi-largeur BD TOPO + 1 m (4,5 m) : 1 m seulement
        self.assertIn("trouvés dans le relief", res["title"])

    def test_tablier_absent_du_mnt(self):  # MNT au fond franchi : demi-largeur type (6 m en importance 3), 2 m de chute
        res = self.fall(lambda x: 98.0)
        self.assertIn("max : 2,0 m", res["text"])
        self.assertIn("demi-largeur type", res["title"])


class LibelleDuPont(unittest.TestCase):
    """Libellé du pont et de ce qu'il franchit (App.status, App._crossed) : numéro de route sans doublon, cours d'eau
    sans nom omis s'il y en a de nommés, énumération « a, b et c »."""

    def test_numero_sans_doublon(self):
        n = web_chutes._numero
        self.assertEqual(n("D905/D905"), "D905")
        self.assertEqual(n("D905/D980"), "D905/D980")
        self.assertEqual(n("D905"), "D905")
        self.assertEqual(web_chutes._road_label("D905/D905"), "la D905")

    def test_enumeration(self):
        e = web_chutes._enumerate
        self.assertEqual(e(["du canal", "de l'Armançon", "de la Brenne"]), "du canal, de l'Armançon et de la Brenne")
        self.assertEqual(e(["a", "b"]), "a et b")
        self.assertEqual(e(["a"]), "a")

    def crossed(self, names):
        lon, lat = 5.0, 47.0
        geo = lambda x, y: web_app.triangulation._geographic(x, y, lon, lat)
        chain = [{"line": [geo(0.0, -30.0), geo(0.0, 30.0)], "level": 1}]
        rivers = [{"geometry": {"type": "LineString", "coordinates": [list(geo(-20.0, 5.0 * k)), list(geo(20.0, 5.0 * k))]},
                   "properties": {"cpx_toponyme_de_cours_d_eau": name, "position_par_rapport_au_sol": "0"}}
                  for k, name in enumerate(names)]
        calc = App.__new__(App)
        calc._bdtopo = lambda layer, cell: rivers if layer == "troncon_hydrographique" else []
        return calc._crossed(chain, [], lon, lat)

    def test_cours_d_eau(self):
        self.assertEqual(self.crossed(["Canal de Bourgogne", None, "l'Armançon", None]),
                         "Au-dessus du canal de Bourgogne et de l'Armançon")
        self.assertEqual(self.crossed([None, None]), "Au-dessus d'un cours d'eau")
        self.assertEqual(self.crossed(["Canal de Bourgogne", "l'Armançon", "la Brenne", "l'Armançon"]),
                         "Au-dessus du canal de Bourgogne, de l'Armançon et de la Brenne")


class LargeurType(unittest.TestCase):
    """Largeur type de chaussée par importance BD TOPO (App._road_width, piste P17)."""

    def test_largeurs(self):
        w = App.__new__(App)._road_width
        self.assertEqual(w({"importance": "2"}), 7.0)
        self.assertEqual(w({"importance": "4"}), 5.5)
        self.assertEqual(w({"importance": "2", "nature": "Route à 2 chaussées"}), 7.0)
        self.assertEqual(w({"importance": "9"}), 6.0)


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
        self.assertEqual(a._fall_camera(), (2.07, "monture", 0.04))
        self.assertEqual(a._camera_height(), 2.07)
        self.assertEqual(a._camera_height(mount=False), 1.9)
        item["properties"]["datetime"] = "2025-06-01T10:00:00Z"
        self.assertEqual(a.camera_of(item, declared)[:2], (1.93, "monture"))
        other = dict(item, providers=[{"id": "autre"}])
        self.assertIsNone(self.app(declared, item=other)._fall_camera())  # autre producteur : à demander, comme avant


class SourcesPage(unittest.TestCase):
    """Fichiers que la page charge (src/calcul.js) : ticket #62, plus de py/sources.js."""

    def test_liste_des_fichiers_python_de_la_page(self):
        racine = Path(__file__).resolve().parent.parent
        code = (racine / "src" / "calcul.js").read_text(encoding="utf-8")
        bloc = re.search(r"const PY_FILES = \[(.*?)\];", code, re.DOTALL).group(1)
        listes = sorted(re.findall(r'"([^"]+\.py)"', bloc))
        presents = sorted(str(f.relative_to(racine / "py")) for f in (racine / "py").rglob("*.py"))
        # Tous les fichiers de py/ sont chargés, aucune exception
        self.assertEqual(listes, presents)


class GrilleGeoide(unittest.TestCase):
    """Grille du géoïde servie avec le site (ticket #62) : le fichier est là et se décode, sans réseau."""

    def test_fichier_local_decode(self):
        from geoid import URL, Grid
        self.assertEqual(URL, "donnees/fr_ign_RAF20.tif")
        grille = Grid((Path(__file__).resolve().parent.parent / URL).read_bytes())
        self.assertTrue(40 < grille.undulation(5.04, 47.32) < 55)  # Dijon : environ 48 m


class Parcours(unittest.TestCase):
    """Mesures de bout en bout dans App, comme les pages d'essai du navigateur (essai-rtk, essai-largeur,
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

    def show(self, pic, date="2026-01-01T00:00:00Z", producer=None):
        lon, lat = triangulation._geographic(0.0, self.NORTH[pic], 5.0415, 47.3220)
        self.app.set_picture(json.dumps({
            "id": pic, "collection": "s1", "type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "providers": [{"id": producer}] if producer else [],
            "properties": {"view:azimuth": 0, "datetime": date,
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

    def test_confiance_inclinaison_des_mesures(self):
        """Chaque mesure garde la confiance de l'inclinaison de sa photo : mention dans les résultats, colonnes des exports ;
        la route annoncée par la vue du dessus (champ route, même quand les verticales priment) sert de témoin."""
        a = self.app
        a.set_mode("height")
        self.sighted(self.A, pitch=-0.35)
        self.aim("p2", self.A, pitch=0.3)
        a.calibration.auto["p2"] = {"sequence": "s1", "heading": 0.0, "lidar": None, "verticals": {
            "up": calibration.up_from_components(1.0, 0.5, 0.0), "count": 4, "sigma": 0.3}}
        a._calibration_changed({"p2"})
        mention = next(r["confiance"] for r in json.loads(a.results()) if r["kind"] == "mesure")
        self.assertEqual(mention, "inclinaison non vérifiable")  # verticales seules : une seule famille
        self.assertIn(";non_verifiable;", a.export_csv())
        route = {"up": list(calibration.up_from_components(3.0, 0.5, 0.0)), "sigma": 0.5}
        a.birdeye_tilt_set("p2", json.dumps({"up": None, "sigma": 0.3, "route": route, "height": None, "ground": None}))
        feature = json.loads(a.export_geojson())["features"][0]["properties"]
        self.assertEqual(feature["confiance_inclinaison"], "desaccord")
        self.assertIsNone(feature["profil"])  # photo hors campagne connue ; colonne ajoutée en dernier (#70)
        header = a.export_csv().splitlines()[0].split(";")
        self.assertEqual(header[header.index("ecart_roulis") + 1], "profil")  # juste après les colonnes précédentes : rien de décalé
        self.assertAlmostEqual(feature["ecart_tangage"], 2.0, delta=0.05)
        self.assertEqual(next(r["confiance"] for r in json.loads(a.results()) if r["kind"] == "mesure"), "inclinaison en désaccord")
        self.assertEqual(json.loads(a.calage_manuel())["confidence"]["state"], "desaccord")

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
        host.fetch_json = lambda url, done, timeout_ms=None: done({"features": []}, None) if "lon=" not in url else (
            asked.append(url), done({"elevations": [{"z": 200.0}] * (url.split("lon=")[1].split("&")[0].count("|") + 1)}, None))
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
        kept = lambda: [f for f in json.loads(a.map_geojson())["features"] if f["properties"]["kind"] == "triangule"]
        self.assertEqual(len(kept()), 2)
        self.assertEqual(a.undo(), "Point B effacé.")
        self.assertEqual(len(kept()), 1)
        self.assertEqual(a.redo(), "Rétabli.")
        self.assertEqual(len(kept()), 2)

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

    def test_droite_nez(self):
        """Droite au sol devant le nez (App.nose_line) : sol plat, photo non inclinée, cap 0 : un point à x m à droite de l'axe,
        d m devant, est au cap atan2(x, d) et à l'élévation -atan(H / hypot(x, d)) ; positif = à droite."""
        self.show("p1")
        line = json.loads(self.app.nose_line(5.0))
        self.assertEqual((line["d"], line["hauteur"], line["roulis_campagne"]), (5.0, self.CAMERA, 0.0))
        offsets = [p[0] for p in line["points"]]
        self.assertEqual((offsets[0], offsets[-1], len(offsets)), (-12.0, 12.0, 481))
        for x, yaw, pitch in line["points"]:
            self.assertAlmostEqual(yaw, math.atan2(x, 5.0), delta=1e-5)
            self.assertAlmostEqual(pitch, -math.atan(self.CAMERA / math.hypot(x, 5.0)), delta=1e-5)
        here = self.app.item["geometry"]["coordinates"][:2]
        a = triangulation._local(*line["lonlat"][0], *here)
        b = triangulation._local(*line["lonlat"][1], *here)
        self.assertAlmostEqual(math.hypot(*a), math.hypot(12.0, 5.0), delta=0.02)
        self.assertAlmostEqual(math.hypot(*b), math.hypot(12.0, 5.0), delta=0.02)
        axis = math.radians(self.app._nose_axis())
        along = (b[0] - a[0]) * math.sin(axis) + (b[1] - a[1]) * math.cos(axis)  # droite perpendiculaire à l'axe
        self.assertLess(abs(math.degrees(math.asin(along / math.hypot(b[0] - a[0], b[1] - a[1])))), 1.0)
        self.assertGreater(next(p[1] for p in line["points"] if p[0] == 3.0), 0)  # à droite : cap relatif positif
        self.assertEqual(json.loads(self.app.nose_line())["d"], 4.5)  # défaut hors CD21
        self.assertIn("error", json.loads(App(lambda *args: None).nose_line()))  # sans photo
        host.install(**HOST)

    def test_droite_nez_rotation(self):
        """Rotation à la main de la droite : 0° identique à l'ancien résultat ; 30° (sens trigonométrique vu du dessus) autour du
        point au droit de la caméra : ce point ne bouge pas, le côté droit avance de x·sin 30°, la droite a la direction tournée."""
        self.show("p1")
        base = json.loads(self.app.nose_line(5.0))
        self.assertEqual(json.loads(self.app.nose_line(5.0, 0.0)), base)
        turned = json.loads(self.app.nose_line(5.0, 30.0))
        self.assertEqual(turned["points"][240], base["points"][240])  # x = 0
        c, s = math.cos(math.radians(30)), math.sin(math.radians(30))
        for x in (4.0, -4.0):
            k = 240 + round(x / 0.05)
            _, yaw, pitch = turned["points"][k]
            right, forward = x * c, 5.0 + x * s
            self.assertAlmostEqual(yaw, math.atan2(right, forward), delta=1e-5)
            self.assertAlmostEqual(pitch, -math.atan(self.CAMERA / math.hypot(right, forward)), delta=1e-5)
        here = self.app.item["geometry"]["coordinates"][:2]
        a = triangulation._local(*turned["lonlat"][0], *here)
        b = triangulation._local(*turned["lonlat"][1], *here)
        axis = math.radians(self.app._nose_axis())
        along = (b[0] - a[0]) * math.sin(axis) + (b[1] - a[1]) * math.cos(axis)  # avancée du côté droit, vers l'avant
        self.assertAlmostEqual(math.degrees(math.asin(along / math.hypot(b[0] - a[0], b[1] - a[1]))), 30.0, delta=1.0)
        self.assertEqual(json.loads(self.app.nose_line(5.0, 90.0))["points"], json.loads(self.app.nose_line(5.0, 45.0))["points"])

    def test_droite_nez_relief(self):
        """Droite au nez sur le relief LiDAR HD : pente en long de 5 % (vers l'avant, cap 0) et dévers de 2 % (vers l'est) ; un point
        à x m à droite, d m devant, a un sol à dz = 0,05 d + 0,02 x au-dessus de celui de la caméra : élévation -atan2(H - dz, distance
        horizontale), cap inchangé. Relief en lecture : sol plat jusqu'à son arrivée, droite alors refaite ; relief indisponible :
        sol plat (ancien résultat)."""
        self.show("p1")
        flat = json.loads(self.app.nose_line(5.0))
        self.assertEqual((flat["sol"], flat["sol_sigma"], flat["sol_en_lecture"]), ("plat (relief indisponible)", None, False))
        self.assertNotIn("sol_dz", flat)
        here = self.app.item["geometry"]["coordinates"][:2]
        waiting, old = [], web_app.precision.fetch_terrain

        def terrain(points, done):  # MNT synthétique : 100 m + 5 % vers le nord + 2 % vers l'est ; la réponse arrive plus tard
            def east_north(p):
                return triangulation._local(p[0], p[1], *here)
            waiting.append(lambda: done([100.0 + 0.05 * east_north(p)[1] + 0.02 * east_north(p)[0] for p in points], "LiDAR HD", None))

        web_app.precision.fetch_terrain = terrain
        try:
            self.app.nose_ground.clear()
            first = json.loads(self.app.nose_line(5.0))
            self.assertTrue(first["sol_en_lecture"])
            self.assertEqual(first["points"], flat["points"])  # en attendant : sol plat
            waiting.pop()()
            line = json.loads(self.app.nose_line(5.0))
        finally:
            web_app.precision.fetch_terrain = old
        self.assertEqual((line["sol"], line["sol_sigma"], line["sol_en_lecture"]), ("LiDAR HD", 0.08, False))
        for x, yaw, pitch in line["points"]:
            dz = 0.05 * 5.0 + 0.02 * x
            self.assertAlmostEqual(yaw, math.atan2(x, 5.0), delta=1e-5)
            self.assertAlmostEqual(pitch, -math.atan2(self.CAMERA - dz, math.hypot(x, 5.0)), delta=2e-4)
        self.assertGreater(max(abs(a[2] - b[2]) for a, b in zip(flat["points"], line["points"])), 0.03)  # 25 cm sur 1,9 m
        dz = dict(line["sol_dz"])
        self.assertAlmostEqual(dz[-3.0], 0.25 - 0.06, delta=0.01)
        self.assertAlmostEqual(dz[4.0], 0.25 + 0.08, delta=0.01)
        host.install(**HOST)

    def test_droite_nez_verticales(self):
        """Droite au nez : la verticale lue dans la photo (verticales à seuil élargi de la vue du dessus, birdeye_loose) change la
        projection de la droite ; sans elle, rien de changé (source « aucune »)."""
        self.show("p1")
        before = json.loads(self.app.nose_line(5.0))
        self.assertEqual(before["inclinaison_source"], "aucune")
        r = math.tan(math.radians(-3.5))
        norm = math.sqrt(1 + r * r)
        self.app.birdeye_loose["p1"] = {"up": [r / norm, 0.0, 1 / norm], "sigma": 0.3}  # cap 0 : penchée de 3,5° vers l'ouest
        after = json.loads(self.app.nose_line(5.0))
        self.assertEqual((after["inclinaison_source"], after["inclinaison_sigma"]), ("verticales (seuil élargi)", 0.3))
        gap = max(abs(a[2] - b[2]) for a, b in zip(before["points"], after["points"]))
        self.assertGreater(gap, 0.02)  # pitch à 12 m de côté : environ 3,5° x sin(angle) = plusieurs centièmes de radian
        host.install(**HOST)

    def test_droite_nez_vue_du_dessus(self):
        """Droite au nez : l'inclinaison tirée de la route par la vue du dessus (birdeye_tilt_set) passe avant les verticales, pour sa
        photo seulement ; « réglée à la main » signalé ; « null » la retire ; rien de changé (faux) si la valeur est la même."""
        self.show("p1")
        r = math.tan(math.radians(-3.5))
        norm = math.sqrt(1 + r * r)
        self.app.birdeye_loose["p1"] = {"up": [r / norm, 0.0, 1 / norm], "sigma": 0.3}
        loose = json.loads(self.app.nose_line(5.0))
        r = math.tan(math.radians(2.0))
        norm = math.sqrt(1 + r * r)
        tilt = json.dumps({"up": [r / norm, 0.0, 1 / norm], "sigma": 0.8, "manual": False})
        self.assertTrue(self.app.birdeye_tilt_set("p1", tilt))
        self.assertFalse(self.app.birdeye_tilt_set("p1", tilt))
        self.assertFalse(self.app.birdeye_tilt_set("autre", "null"))
        line = json.loads(self.app.nose_line(5.0))
        self.assertEqual((line["inclinaison_source"], line["inclinaison_sigma"]), ("vue du dessus", 0.8))
        self.assertGreater(max(abs(a[2] - b[2]) for a, b in zip(loose["points"], line["points"])), 0.02)
        self.assertTrue(self.app.birdeye_tilt_set("p1", tilt.replace("false", "true")))
        self.assertEqual(json.loads(self.app.nose_line(5.0))["inclinaison_source"], "vue du dessus (réglée à la main)")
        self.assertTrue(self.app.birdeye_tilt_set("p1", "null"))  # vue du dessus revenue aux verticales
        self.assertEqual(json.loads(self.app.nose_line(5.0)), loose)
        self.app.birdeye_tilt_set("p2", tilt)  # une autre photo : sans effet sur celle-ci
        self.assertEqual(json.loads(self.app.nose_line(5.0)), loose)
        host.install(**HOST)

    def test_droite_nez_hauteur_et_sol_de_la_vue_du_dessus(self):
        """Droite au nez : la hauteur de la couche de la vue du dessus (monture, parallaxe) passe avant l'altitude GPS, et son terrain
        lissé remplace le MNT brut (écart de largeur de 7 % : 1,80 m au lieu de 1,93 m, creux de la chaussée) ; sans elle, rien ne change
        pour les autres photos."""
        self.show("p1")
        before = json.loads(self.app.nose_line(5.0))
        lon, lat = self.app.item["geometry"]["coordinates"][:2]
        n = 31
        z = [0.0] * (n * n)
        for j in range(n):
            for i in range(n):
                z[j * n + i] = 0.02 * (i - 15)  # sol qui monte de 2 cm par mètre vers l'est
        tilt = {"up": None, "sigma": 0.5, "manual": False, "height": 1.93, "height_sigma": 0.04,
                "ground": {"lon": lon, "lat": lat, "n": n, "step": 1.0, "z": z, "ref": 0.0}}
        self.assertTrue(self.app.birdeye_tilt_set("p1", json.dumps(tilt)))
        line = json.loads(self.app.nose_line(5.0))
        self.assertEqual((line["hauteur"], line["hauteur_source"], line["sigma_h"]), (1.93, "vue du dessus", 0.04))
        self.assertEqual(line["sol"], "LiDAR HD (vue du dessus)")
        self.assertFalse(line["sol_en_lecture"])
        dz = {x: v for x, v in line["sol_dz"]}
        self.assertAlmostEqual(dz[3.0] - dz[-3.0], 0.12 * abs(math.sin(math.radians(self.app._nose_axis() + 90))), delta=0.02)
        self.assertEqual(json.loads(self.app.nose_line(5.0))["inclinaison_source"], before["inclinaison_source"])  # up absent : pas de route
        self.assertTrue(self.app.birdeye_tilt_set("p1", "null"))
        self.assertEqual(json.loads(self.app.nose_line(5.0))["hauteur"], before["hauteur"])
        host.install(**HOST)

    @staticmethod
    def _up(roll):
        """Verticale penchée de roll° vers la droite d'un cap nord (comme groundUp de src/dessus.js)."""
        r = math.tan(math.radians(roll))
        norm = math.sqrt(1 + r * r)
        return [r / norm, 0.0, 1 / norm]

    def test_ordre_inclinaison(self):
        """Un seul ordre d'inclinaison (Calibration.tilt) pour les mesures et la droite au nez, un cas par rang : 1 réglage de la
        vue du dessus, 2 clics, 3 verticales, 4 LiDAR, 5 verticales à seuil élargi, 6 roulis par défaut de la campagne seul, 7 rien."""
        a, cal, pic = self.app, self.app.calibration, "p1"
        source = lambda: (cal.tilt(pic) or {}).get("source")
        self.show(pic)
        self.assertEqual((cal.tilt(pic), source()), (None, None))  # 7 : rien (UNCALIBRATED)
        self.show(pic, "2025-07-03T10:53:25Z", App.FLEET_PRODUCER)
        t = cal.tilt(pic)  # 6 : roulis par défaut de la campagne seul (+1°, penché à droite ; -1° pour le cœur), tangage inconnu
        self.assertEqual((t["source"], t["sigma"], t["fallback"]), ("roulis de campagne", calibration.UNCALIBRATED, True))
        for got, want in zip(t["up"], self._up(-1.0)):
            self.assertAlmostEqual(got, want, places=6)
        a._set_loose(pic, {"up": self._up(2.0), "sigma": 0.4})  # 5 : verticales à seuil élargi, avant le roulis par défaut de la campagne
        self.assertEqual((source(), cal.tilt(pic)["sigma"]), ("verticales (seuil élargi)", 0.4))
        self.assertNotIn("fallback", cal.tilt(pic))
        core = a._core_auto_tilt
        a._core_auto_tilt = lambda p: calibration.tilt_entry(self._up(-0.5), 0.6, "lidar")  # 4 : LiDAR, avant le seuil élargi
        self.assertEqual(source(), "lidar")
        a._core_auto_tilt = core
        cal.auto[pic] = {"sequence": "s1", "heading": 0.0, "verticals": {"up": self._up(1.0), "count": 5, "sigma": 0.2}, "lidar": None}
        self.assertEqual((source(), cal.tilt(pic)["sigma"]), ("verticales", 0.2))  # 3
        cal.add_vertical(pic, (10.0, -11.3), (10.0, 21.8))
        self.assertEqual(source(), "clics + verticales")  # 2 : un objet complété par les verticales
        cal.add_vertical(pic, (100.0, -11.3), (100.0, 21.8))
        self.assertEqual(source(), "clics")  # 2 : deux objets
        self.assertTrue(a.birdeye_tilt_set(pic, json.dumps({"up": self._up(3.0), "sigma": 0.8, "manual": False})))  # 1
        self.assertEqual((source(), cal.tilt(pic)["sigma"]), ("vue du dessus", 0.8))
        a.birdeye_tilt_set(pic, json.dumps({"up": self._up(3.0), "sigma": 0.8, "manual": True}))
        self.assertEqual(source(), "vue du dessus (réglée à la main)")
        self.assertEqual(cal.tilt(pic, photo_only=True)["source"], "clics")  # la vue du dessus ne relit pas son propre réglage
        a.birdeye_tilt_set(pic, "null")
        cal.clear_tilt(pic)
        del cal.auto[pic]
        a.birdeye_loose.clear()
        self.assertEqual(cal.tilt(pic, photo_only=True), None)  # photo seule : ni roulis par défaut de la campagne ni seuil élargi
        self.assertEqual(source(), "roulis de campagne")
        self.show(pic)  # même photo hors campagne : rien
        self.assertIsNone(cal.tilt(pic))

    @staticmethod
    def _share(cross, share=0.7):
        """Part du dévers en roulis du véhicule (degrés, positif : à droite) : route qui monte vers la droite -> penché à gauche."""
        return -math.degrees(math.atan(share * math.tan(math.radians(cross))))

    def _lidar(self, pic, cross, source="LiDAR HD"):
        self.app.calibration.auto[pic] = {"sequence": "s1", "heading": 0.0, "verticals": None, "lidar": [0.0, cross], "lidar_source": source}
        self.app.calibration._tilts.clear()  # (l'arrivée réelle passe par set_auto, qui prévient)

    def _roll_of(self, pic):
        """Roulis du véhicule (degrés, positif : à droite) retenu au rang 6, lu dans la verticale du cœur (cap nord, convention du cœur)."""
        t = self.app.calibration.tilt(pic)
        return None if t is None else (t["source"], round(-math.degrees(math.atan2(t["up"][0], t["up"][2])), 9))

    def test_roulis_par_defaut_devers(self):
        """Rang 6 : défaut de campagne + 70 % du dévers du LiDAR HD (route qui monte à droite de 2° : véhicule penché à gauche, roulis
        négatif) ; le dévers est écarté sur un pont et avec le terrain RGE ALTI ; rangs 1 à 5 inchangés."""
        a, cal, pic = self.app, self.app.calibration, "p1"
        want = self._share(2.0)
        self.assertAlmostEqual(want, -1.4, delta=0.01)  # penché à gauche : négatif
        self.show(pic, "2025-07-03T10:53:25Z", App.FLEET_PRODUCER)
        self.assertEqual(self._roll_of(pic), ("roulis de campagne", 1.0))  # sans dévers : le défaut seul
        self._lidar(pic, 2.0)
        source, roll = self._roll_of(pic)
        self.assertEqual(source, "roulis de campagne")
        self.assertAlmostEqual(roll, 1.0 + want, places=6)  # CD21 2025 : défaut + part du dévers
        self.assertAlmostEqual(a._roll_default(a.item, pic), 1.0 + want, places=9)
        self.assertTrue(cal.tilt(pic)["fallback"])
        self.assertEqual(cal.tilt(pic)["sigma"], calibration.UNCALIBRATED)
        self.assertEqual(a._roll_label(a.item), "roulis par défaut (70 % du dévers + campagne 2025)")
        cal.set_bridge_photo(pic, True)  # pont : le sol sous l'ouvrage n'est pas la route
        self.assertEqual(self._roll_of(pic), ("roulis de campagne", 1.0))
        self.assertEqual(a._roll_label(a.item), "roulis par défaut de la campagne 2025 seul")
        cal.set_bridge_photo(pic, False)
        self._lidar(pic, 2.0, "RGE ALTI")  # terrain RGE ALTI : trop grossier pour le dévers
        self.assertEqual(self._roll_of(pic), ("roulis de campagne", 1.0))
        self._lidar(pic, 2.0, None)  # entrée d'une version précédente : source inconnue
        self.assertEqual(self._roll_of(pic), ("roulis de campagne", 1.0))
        self._lidar(pic, 2.0, "RGE ALTI")
        self.assertIn("terrain RGE ALTI", a._roll_why(a.item))
        self._lidar(pic, 2.0)
        a._set_loose(pic, {"up": self._up(2.0), "sigma": 0.4})  # 5 : verticales à seuil élargi, avant le rang 6
        self.assertEqual(self._roll_of(pic)[0], "verticales (seuil élargi)")
        self.assertAlmostEqual(self._roll_of(pic)[1], -2.0, places=6)  # inchangé : le dévers n'y est pas ajouté
        a.birdeye_loose.clear()

    def test_roulis_par_defaut_hors_campagne(self):
        """Hors CD21 : défaut 0, la part du dévers seule ; sans dévers disponible, rien (rang 7)."""
        a, cal, pic = self.app, self.app.calibration, "p1"
        self.show(pic)
        self.assertIsNone(cal.tilt(pic))
        self._lidar(pic, 2.0)
        source, roll = self._roll_of(pic)
        self.assertEqual(source, "roulis de campagne")
        self.assertAlmostEqual(roll, self._share(2.0), places=6)
        self.assertEqual(a._roll_label(a.item), "roulis par défaut (70 % du dévers)")
        self._lidar(pic, -2.0)  # route qui monte à gauche : penché à droite, positif
        self.assertAlmostEqual(self._roll_of(pic)[1], -self._share(2.0), places=6)
        self._lidar(pic, 2.0, "RGE ALTI")
        self.assertIsNone(cal.tilt(pic))
        self._lidar(pic, 2.0)
        cal.set_bridge_photo(pic, True)
        self.assertIsNone(cal.tilt(pic))
        text = a._tilt_line()[0]
        self.assertNotIn("dévers", text)

    def test_roulis_par_defaut_verticales_et_clics(self):
        """Verticales de la photo (rang 3) : le dévers n'est pas ajouté ; clics à la main + rang 6 : le roulis par défaut sert de repère
        (« clics + roulis de campagne »)."""
        cal, pic = self.app.calibration, "p1"
        self.show(pic, "2025-07-03T10:53:25Z", App.FLEET_PRODUCER)
        self._lidar(pic, 2.0)
        cal.auto[pic]["verticals"] = {"up": self._up(1.0), "count": 5, "sigma": 0.2}
        cal._tilts.clear()
        self.assertEqual(self._roll_of(pic)[0], "verticales")
        self.assertAlmostEqual(self._roll_of(pic)[1], -1.0, places=6)  # _up(1) : verticale à droite = caméra à droite, roulis véhicule -1
        cal.auto[pic]["verticals"] = None
        cal._tilts.clear()
        cal.add_vertical(pic, (10.0, -11.3), (10.0, 21.8))  # un objet à la main, complété par le rang suivant : le roulis par défaut
        self.assertEqual(cal.tilt(pic)["source"], "clics + roulis de campagne")

    def test_calage_manuel_panneau(self):
        """Panneau du calage manuel : rapport, traits numérotés, retrait d'une verticale, aberrantes, purge."""
        a, cal, pic = self.app, self.app.calibration, "p1"
        self.show(pic)
        self.assertIsNone(json.loads(a.calage_manuel())["manual"])
        for yaw in (0.0, 70.0, 140.0, 210.0):
            cal.add_vertical(pic, (yaw, -11.3), (yaw, 21.8))
        cal.add_vertical(pic, (35.0, -11.3), (38.0, 21.8))  # tracée de travers
        report = json.loads(a.calage_manuel())["manual"]
        self.assertEqual(report["count"], 5)
        self.assertEqual(report["outliers"], [4])
        a.calage_panel(True, 4, -1)
        marks = [m for m in json.loads(a.viewer_marks()) if m.get("trace")]
        self.assertEqual([(m["label"], m["sel"]) for m in marks], [("1", False), ("2", False), ("3", False), ("4", False), ("5", True)])
        self.assertEqual(marks[4]["trace"], App.CALAGE_COLORS["aberrante"])
        y, p = (marks[0]["points"][6][0], marks[0]["points"][6][1])
        self.assertEqual(a.calage_pick(y, p), 0)  # clic sur le trait 1
        self.assertEqual(a.calage_pick(y + 0.5, p), -1)  # loin de tout trait
        version = a.calibration_version
        a.calage_drop_outliers()
        self.assertEqual(len(cal.verticals[pic]), 4)
        self.assertGreater(a.calibration_version, version)  # recalcul et enregistrement
        a.calage_remove(0)
        self.assertEqual(len(cal.verticals[pic]), 3)
        a.calage_purge_photo()
        self.assertNotIn(pic, cal.verticals)
        cal.add_vertical(pic, (10.0, -11.3), (10.0, 21.8))
        cal.add_vertical("p2", (10.0, -11.3), (10.0, 21.8))
        a.calage_purge_all()
        self.assertEqual(cal.verticals, {})
        self.assertIsNone(cal.tilt(pic))

    def test_calage_auto_reinitialiser(self):
        """Panneau : verticales automatiques comptées, « Réinitialiser » les ignore (le LiDAR prend le relais), « Rétablir »."""
        a, cal, pic = self.app, self.app.calibration, "p1"
        self.show(pic)
        up = calibration.up_from_components(1.0, 0.5, 0.0)
        cal.auto[pic] = {"sequence": "s1", "heading": 0.0, "verticals": {"up": list(up), "count": 7, "sigma": 0.2}, "lidar": None}
        info = json.loads(a.calage_manuel())
        self.assertIsNone(info["auto"]["fragile"])  # ancienne entrée, sans indicateurs de qualité
        text, alert = a._tilt_line()
        self.assertNotIn("fragile", text)
        quality = {"edges": 5, "gap": 200.0, "sigma_pitch": 0.1, "sigma_roll": 0.05, "fragile": True, "fragile_reason": "peu d'arêtes distinctes"}
        cal.set_auto(pic, calibration._auto_entry({**cal.auto[pic], "verticals": {"up": list(up), "count": 7, "sigma": 0.2, **quality}}))
        auto = json.loads(a.calage_manuel())["auto"]
        self.assertEqual((auto["edges"], auto["segments"], auto["gap"], auto["fragile_reason"]), (5, 7, 200.0, "peu d'arêtes distinctes"))
        self.assertIn(", fragile : peu d'arêtes distinctes", a._tilt_line()[0])
        cal.auto[pic]["verticals"] = {"up": list(up), "count": 7, "sigma": 0.2}
        info = json.loads(a.calage_manuel())
        self.assertEqual((info["retained"]["source"], info["auto"]["count"], info["auto"]["available"], info["auto"]["off"]),
                         ("verticales", 7, True, False))
        self.assertAlmostEqual(info["retained"]["pitch"], 1.0, places=2)
        self.assertAlmostEqual(info["retained"]["roll"], -0.5, places=2)  # verticale vue à droite : véhicule penché à gauche
        version = a.calibration_version
        a.calage_auto_off(True)
        self.assertGreater(a.calibration_version, version)
        info = json.loads(a.calage_manuel())
        self.assertTrue(info["auto"]["off"])
        self.assertIsNone(info["retained"])  # ni LiDAR ni roulis par défaut de la campagne ici : rien
        again = calibration.Calibration()
        again.load(json.loads(a.calibration_json()))  # gardé avec le calage
        self.assertEqual(again.auto_off, {pic})
        a.calage_auto_off(False)
        self.assertEqual(json.loads(a.calage_manuel())["retained"]["source"], "verticales")

    def test_ordre_inclinaison_ligne_etat(self):
        """Ligne d'état : la source (vue du dessus, seuil élargi, roulis par défaut de la campagne seul) et son incertitude."""
        a, pic = self.app, "p1"
        self.show(pic, "2025-07-03T10:53:25Z", App.FLEET_PRODUCER)
        a.tilts.pending = lambda p: False
        a.set_active(False)
        text, alert = a._tilt_line()  # verticales pas encore cherchées : pas « non calée »
        self.assertIn("calculée à l'activation de la mesure", text)
        self.assertNotIn("non calée", text)
        self.assertFalse(alert)
        self.assertNotIn("ok", [v for n, v in a._lights(pic) if n == "Inclinaison"])
        a.tilt_reasons[pic] = "pas assez de bords"  # calcul fait, sans résultat
        text, alert = a._tilt_line()
        self.assertIn("non calée : roulis par défaut de la campagne 2025 seul", text)
        self.assertIn("roulis par défaut de la campagne 2025 seul", text)
        self.assertIn("±2,0°", text)
        self.assertTrue(alert)
        self.assertNotIn("ok", [v for n, v in a._lights(pic) if n == "Inclinaison"])  # pas une inclinaison calée
        a._set_loose(pic, {"up": self._up(2.0), "sigma": 0.4})
        self.assertEqual(a._tilt_line(), ("inclinaison calée par les verticales de la photo, seuil élargi (±0,4°)", False))
        a.birdeye_tilt_set(pic, json.dumps({"up": self._up(3.0), "sigma": 0.8, "manual": False}))
        self.assertEqual(a._tilt_line(), ("inclinaison calée dans la vue du dessus (±0,8°)", False))
        a.birdeye_tilt_set(pic, json.dumps({"up": self._up(3.0), "sigma": 0.8, "manual": True}))
        self.assertEqual(a._tilt_line()[0], "inclinaison calée dans la vue du dessus (à la main) (±0,8°)")

    def test_mesures_suivent_la_vue_du_dessus(self):
        """Les mesures déjà faites (ici une visée) se recalculent quand la vue du dessus change l'inclinaison de la photo (comme à
        l'arrivée de l'inclinaison automatique), et reprennent leur valeur quand elle la retire."""
        a = self.app
        a.set_mode("height")
        self.show("p1")
        self.aim("p1", self.A)
        sight = lambda: (a.triangulator.sightings[0]["heading"], a.triangulator.sightings[0]["elev"])
        before = sight()
        a.birdeye_tilt_set("p1", json.dumps({"up": self._up(4.0), "sigma": 0.8, "manual": False}))
        self.assertNotEqual(sight(), before)
        a.birdeye_tilt_set("p1", "null")
        self.assertEqual(sight(), before)

    def test_droite_nez_roulis_campagne(self):
        """Droite au nez, photo du CD21 en 2025 sans autre inclinaison : roulis par défaut de la campagne seul (-1°), comme avant l'ordre unique
        (verticale penchée de -1° vers la droite du cap, untilt inverse) ; source et incertitude annoncées."""
        self.show("p1", "2025-07-03T10:53:25Z", App.FLEET_PRODUCER)
        line = json.loads(self.app.nose_line(5.0))
        self.assertEqual((line["inclinaison_source"], line["inclinaison_sigma"], line["roulis_campagne"]),
                         ("roulis de campagne", calibration.UNCALIBRATED, 1.0))  # véhicule penché de 1° à droite
        up = self._up(-1.0)  # la verticale du cœur : penchée de 1° à gauche
        for x, yaw, pitch in line["points"][::40]:
            bearing, elev = math.degrees(math.atan2(x, 5.0)), -math.degrees(math.atan2(line["hauteur"], math.hypot(x, 5.0)))
            want_yaw, want_pitch = calibration.untilt(up, bearing % 360, elev, inverse=True)
            self.assertAlmostEqual(yaw, math.radians((want_yaw + 540) % 360 - 180), delta=1e-5)
            self.assertAlmostEqual(pitch, math.radians(want_pitch), delta=1e-5)

    def test_droite_nez_profondeur(self):
        """Droite glissée en profondeur : distance bornée par le nez (près) et par le nez + écart à la photo suivante + 1 m (loin),
        nez + 6 m sans suivante connue ; le centre de la droite est à la distance demandée, perpendiculaire à l'axe ; les
        décalages latéraux restent des mètres (la table des points ne change pas de décalages)."""
        self.show("p1")
        line = json.loads(self.app.nose_line(9.0))
        self.assertEqual((line["d_min"], line["d_max"], line["d"]), (4.5, 10.5, 9.0))  # sans suivante : nez + 6 m
        self.assertEqual(json.loads(self.app.nose_line(2.0))["d"], 4.5)  # plus près que le nez : butée
        self.assertEqual(json.loads(self.app.nose_line(99.0))["d"], 10.5)
        self.assertEqual(json.loads(self.app.nose_line())["d"], 4.5)
        for x, yaw, pitch in line["points"][::60]:
            self.assertAlmostEqual(yaw, math.atan2(x, 9.0), delta=1e-5)
            self.assertAlmostEqual(pitch, -math.atan(self.CAMERA / math.hypot(x, 9.0)), delta=1e-5)
        here = self.app.item["geometry"]["coordinates"][:2]
        a = triangulation._local(*line["lonlat"][0], *here)
        b = triangulation._local(*line["lonlat"][1], *here)
        self.assertAlmostEqual(((a[1] + b[1]) / 2), 9.0, delta=0.05)  # centre à 9 m devant (cap 0)
        lon, lat = triangulation._geographic(0.0, 7.0, *here)  # suivante à 7 m : butée lointaine 4,5 + 7 + 1
        self.app.item["links"] = [{"rel": "next", "href": "http://x/items/n1"}]
        self.app.neighbours["n1"] = {"id": "n1", "geometry": {"type": "Point", "coordinates": [lon, lat]}}
        line = json.loads(self.app.nose_line(50.0))
        self.assertAlmostEqual(line["d_max"], 12.5, delta=0.05)
        self.assertAlmostEqual(line["d"], line["d_max"], delta=1e-9)

    def test_droite_nez_virage(self):
        """Droite au nez dans un virage : séquence sur un cercle de 20 m de rayon, photos tous les 5 m ; la droite est radiale
        (perpendiculaire à la trajectoire) là où elle est tracée, pas à la photo (écart de 13° avec l'ancien calcul)."""
        radius, step = 20.0, 5.0
        origin = (5.0415, 47.3220)

        def feature(k):
            a = k * step / radius  # angle parcouru (rad), sens horaire vu de dessus : cap = a
            lon, lat = triangulation._geographic(radius * (1 - math.cos(a)), radius * math.sin(a), *origin)
            links = [{"rel": "prev", "href": "http://x/items/c%d" % (k - 1)}, {"rel": "next", "href": "http://x/items/c%d" % (k + 1)}]
            return {"id": "c%d" % k, "collection": "s1", "type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {"view:azimuth": math.degrees(a) % 360, "datetime": "2026-01-01T00:00:00Z",
                                   "pers:interior_orientation": {"field_of_view": 360}}, "links": links}
        for k in range(-1, 2):  # précédente et suivante seulement : θ1 se déduit de la corde
            self.app.neighbours["c%d" % k] = feature(k)
        self.app.set_picture(json.dumps(feature(0)))
        self.app.set_active(True)
        line = json.loads(self.app.nose_line())
        d = line["d"]
        theta0 = self.app._nose_axis()
        self.assertAlmostEqual(theta0, 0.0, delta=0.5)
        here = self.app.item["geometry"]["coordinates"][:2]
        a = triangulation._local(*line["lonlat"][0], *here)
        b = triangulation._local(*line["lonlat"][1], *here)
        direction = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))  # direction de la droite (est = 0°, sens trigonométrique)
        centre = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        self.assertAlmostEqual(math.hypot(centre[0], centre[1] - d), 0.0, delta=0.05)  # centre à d devant la photo
        radial = math.degrees(math.atan2(centre[1], centre[0] - radius))  # du centre de l'anneau (à l'est) au centre de la droite
        diff = abs((direction - radial + 90) % 180 - 90)  # écart modulo 180° entre la droite et le rayon
        self.assertLess(diff, 2.0)
        self.assertAlmostEqual(abs(line["virage"]), math.degrees(d / radius), delta=2.0)  # 13° environ
        # ancien calcul : droite perpendiculaire à l'axe de la photo (est-ouest), soit 13° du rayon
        self.assertGreater(abs((0.0 - radial + 90) % 180 - 90), 10.0)

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
