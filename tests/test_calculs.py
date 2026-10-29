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


if __name__ == "__main__":
    unittest.main()
