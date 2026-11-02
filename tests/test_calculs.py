# SPDX-License-Identifier: GPL-2.0-or-later
# © Cédric COCHART
"""Essais rapides des calculs propres à l'application (py/web_app.py), sans navigateur ni réseau :
python3 -m unittest discover -s tests (moins d'une seconde). Pyodide est remplacé par un faux module."""

import math
import sys
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
        return {"name": name, "level": level, "line": [(self.LON + x * k, self.LAT + y / 111320) for x, y in xy]}

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
