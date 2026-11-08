# SPDX-License-Identifier: GPL-2.0-or-later
# © Cédric COCHART
"""Essais rapides des calculs propres à l'application (py/web_app.py), sans navigateur ni réseau :
python3 -m unittest discover -s tests (moins d'une seconde). Pyodide est remplacé par un faux module."""

import math
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
        self.assertEqual([(attrs["type"], attrs["incert_m"]) for _, attrs in a._records()][-1], ("longueur sur la carte (hors vue du dessus)", None))
        a.undo()
        a.delete_result("longueur", 0)
        self.assertEqual([v["valeur_m"] for v in a.map_lengths], [11.1])
        a.clear_all()
        self.assertEqual((a.map_lengths, a.has_results()), ([], False))


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
        a.birdeye_loose = {}
        return a

    def test_pose(self):
        pose = json.loads(self.app_on(360).birdeye_pose())
        self.assertEqual((pose["lon"], pose["heading"], pose["offset"], pose["height"]), (5.0, 40.0, 1.5, 2.4))
        self.assertEqual((pose["up"], pose["sigma"], pose["height_sigma"]), ([0.0, 0.1, 0.99], 0.2, 0.05))
        self.assertEqual([(n["pic"], n["lat"], n["relative_sigma"]) for n in pose["neighbours"]], [("v", 47.00005, 0.05)])

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
        start = min(o for o, _ in entry["points"] if abs(o - 8.0) == min(abs(q - 8.0) for q, _ in entry["points"]))  # point du terrain le plus proche du bord
        kept = [z for o, z in entry["points"] if start <= o <= start + 10]
        self.assertLess(chute[0], fall)
        self.assertAlmostEqual(chute[0], kept[0] - min(kept), delta=0.01)
        gauche = [e for e in after["profils"] if e["cote"] == "gauche"]
        self.assertTrue(gauche and not any(e["enrobe"] for e in gauche))  # l'autre côté garde son bord
        self.assertEqual(len(reads), 1)  # sans relire le terrain


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
    """Hauteur de caméra du tablier (App._fall_camera) : séquence, sinon calée, sinon le réglage accepté."""

    def app(self, quality, calibrated=None):
        a = App.__new__(App)
        a.quality, a.item = quality, {"collection": "s"}
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


if __name__ == "__main__":
    unittest.main()
