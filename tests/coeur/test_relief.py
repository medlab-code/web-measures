# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Tests de relief.py : diagnostic du relief LiDAR HD, porté de `diagnoseRelief` de src/dessus.js (ticket #67).

Scènes synthétiques à réponse connue : les mêmes grilles que tests/essai-dessus.html (plan, trous, rupture, bruit, pente forte), mêmes
conclusions ; et les constantes du diagnostic, relues dans src/dessus.js, qui doivent être celles d'ici."""

import os
import re
import unittest

from support import module

relief = module("core.relief")
JS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "src", "dessus.js")


def diagnose(f, heading=0.0, under=None):
    """Diagnostic d'un relief z = f(est, nord) (None : pas d'altitude), lu aux nœuds de la zone utile du cap `heading`."""
    return relief.diagnose(heading, [f(e, n) for e, n, _, _ in relief.zone_offsets(heading)], under)


class Constants(unittest.TestCase):
    def test_same_as_dessus_js(self):
        """Seuils et zone utile : ceux de src/dessus.js (toute modification se fait des deux côtés)."""
        with open(JS, encoding="utf-8") as f:
            code = f.read()

        def js(name):
            return float(re.search(r"\b%s = ([0-9.]+)" % name, code).group(1))

        for name in ("RELIEF_MIN_VALID", "RELIEF_MAX_RMS", "RELIEF_MAX_SLOPE", "RELIEF_MAX_BREAK", "RELIEF_ALONG", "RELIEF_ACROSS", "STEP", "REACH"):
            self.assertEqual(getattr(relief, name), js(name), name)


class Diagnosis(unittest.TestCase):
    def test_zone(self):
        """Zone utile : 12 m devant, ±3 m de large, maille de 1 m ; cap nord : 13 lignes de 7 points."""
        self.assertEqual(len(relief.zone_offsets(0.0)), 13 * 7)
        along = [a for _, _, a, _ in relief.zone_offsets(90.0)]
        self.assertTrue(all(0 <= a <= 12 for a in along))
        self.assertEqual(len(relief.zone_points(5.0, 47.0, 0.0)), 91)

    def test_plane(self):
        d = diagnose(lambda e, n: 100 + 0.03 * n + 0.01 * e)
        self.assertEqual(d["valid"], 1.0)
        self.assertLess(d["rms"], 1e-6)
        self.assertAlmostEqual(d["slope"], 3.16, delta=0.05)
        self.assertEqual(d["reasons"], [])

    def test_holes(self):
        d = diagnose(lambda e, n: None if (e + n) % 3 == 0 or e % 4 == 0 else 100.0)
        self.assertLess(d["valid"], 0.9)
        self.assertTrue(any(r.startswith("grille partielle") for r in d["reasons"]))

    def test_break(self):
        d = diagnose(lambda e, n: 100 + (0.1 * (n - 6) if n > 6 else 0))
        self.assertAlmostEqual(d["rupture"], 5.7, delta=0.7)
        self.assertTrue(any(r.startswith("rupture de pente") for r in d["reasons"]))

    def test_rough(self):
        d = diagnose(lambda e, n: 100 + (0.25 if (e * 7 + n * 3) % 2 else -0.25))
        self.assertTrue(any(r.startswith("relief irrégulier") for r in d["reasons"]))

    def test_steep(self):
        d = diagnose(lambda e, n: 100 + 0.09 * n)
        self.assertEqual(len(d["reasons"]), 1)
        self.assertTrue(d["reasons"][0].startswith("pente forte"))

    def test_heading(self):
        """Le plan est lu dans le sens du cap : une pente vers l'est vue cap est ou cap nord donne la même valeur, la zone tourne."""
        d = diagnose(lambda e, n: 100 + 0.03 * e, heading=90.0)
        self.assertAlmostEqual(d["slope"], 3.0, delta=0.05)
        self.assertEqual(d["reasons"], [])

    def test_deck_ignored(self):
        """Points sous l'emprise d'un pont écartés : ni comptés, ni ajustés."""
        nodes = relief.zone_offsets(0.0)
        f = lambda e, n: 100.0 + (5.0 if n > 8 else 0.0)  # tablier à 5 m au-dessus, sous l'emprise
        with_deck = relief.diagnose(0.0, [f(e, n) for e, n, _, _ in nodes], None)
        without = relief.diagnose(0.0, [f(e, n) for e, n, _, _ in nodes], [n > 8 for _, n, _, _ in nodes])
        self.assertTrue(with_deck["reasons"])
        self.assertEqual(without["reasons"], [])
        self.assertAlmostEqual(without["valid"], 1.0)

    def test_summary(self):
        s = relief.summary(diagnose(lambda e, n: 100.0))
        self.assertEqual(set(s), {"valid", "rms", "slope", "rupture", "reasons"})
        self.assertEqual(s["reasons"], [])


if __name__ == "__main__":
    unittest.main()
