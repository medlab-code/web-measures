# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Tests de trace.py : tracé en plan (alignements, clothoïdes, arcs) ajusté sur des positions.

Les routes sont synthétiques : une suite de morceaux (longueur, courbure au début, courbure à la fin),
intégrée finement, échantillonnée tous les 5 m comme des photos, avec du bruit sur les positions
(0,03 m : RTK ; 1 m : sans RTK). Le calcul demande numpy : ces tests sont sautés sans lui.
"""

import importlib.util
import math
import unittest

from support import module

trace = module("core.trace")
HAS_NUMPY = importlib.util.find_spec("numpy") is not None

# Alignement, clothoïde, arc de 150 m à gauche, clothoïde, alignement, clothoïde, arc de 400 m à droite, clothoïde, alignement
SCENE = [(100, 0, 0), (60, 0, 1 / 150), (120, 1 / 150, 1 / 150), (60, 1 / 150, 0), (100, 0, 0),
         (80, 0, -1 / 400), (200, -1 / 400, -1 / 400), (80, -1 / 400, 0), (100, 0, 0)]


def road(pieces, step=5.0, noise=0.03, seed=1, heading=0.3):
    """Positions tous les `step` m d'une route faite de `pieces`, et sa longueur."""
    import numpy as np

    ds = 0.02
    x, y, th = [0.0], [0.0], heading
    for length, k0, k1 in pieces:
        n = int(length / ds)
        for i in range(n):
            th += (k0 + (k1 - k0) * (i + 0.5) / n) * ds
            x.append(x[-1] + math.cos(th) * ds)
            y.append(y[-1] + math.sin(th) * ds)
    s = np.arange(len(x)) * ds
    at = np.arange(0, s[-1], step)
    rng = np.random.default_rng(seed)
    px = np.interp(at, s, x) + rng.normal(0, noise, len(at))
    py = np.interp(at, s, y) + rng.normal(0, noise, len(at))
    return list(zip(px, py)), float(s[-1])


def arcs(result, longer=0.0):
    """Arcs de plus de `longer` m et de rayon sous 1 500 m (au-delà : bruit de courbure aux bouts de la route)."""
    return [e for e in result["elements"] if e["type"] == "arc" and e["length"] > longer and e["radius"] < 1500]


@unittest.skipUnless(HAS_NUMPY, "numpy absent")
class TestTrace(unittest.TestCase):
    def test_rtk_scene_elements_and_radii(self):
        """RTK : les deux arcs, leur sens et leur rayon à 4 % près, des alignements aux deux bouts et au milieu."""
        points, _ = road(SCENE)
        r = trace.fit(points)
        a = arcs(r, 40)
        self.assertEqual([e["sense"] for e in a], ["gauche", "droite"])
        self.assertAlmostEqual(a[0]["radius"], 150, delta=6)
        self.assertAlmostEqual(a[1]["radius"], 400, delta=16)
        types = [e["type"] for e in r["elements"]]
        self.assertEqual((types[0], types[-1]), ("droite", "droite"))
        self.assertIn("clothoide", types)
        mid = [e for e in r["elements"] if e["type"] == "droite" and 300 < e["s0"] < 450]
        self.assertTrue(mid, types)
        self.assertLess(r["rms"], 0.1)

    def test_clothoid_parameter(self):
        """La clothoïde d'entrée de l'arc de 150 m (60 m, A² = R·L = 9 000) : A à 10 % près."""
        points, _ = road(SCENE)
        r = trace.fit(points)
        ramps = [e for e in r["elements"] if e["type"] == "clothoide" and e["sense"] == "gauche" and e["k1"] > e["k0"]]
        self.assertTrue(ramps)
        a = ramps[-1]["parameter"]
        self.assertAlmostEqual(a, math.sqrt(150 * 60), delta=0.15 * math.sqrt(150 * 60))

    def test_straight_road(self):
        points, _ = road([(400, 0, 0)])
        r = trace.fit(points)
        self.assertEqual(arcs(r, 30), [])
        self.assertTrue(all(e["type"] != "arc" or e["radius"] > 1500 for e in r["elements"]))
        self.assertLess(r["rms"], 0.1)

    def test_pure_arcs_all_radii_and_senses(self):
        for radius in (60, 100, 250, 800):
            for sign in (1, -1):
                with self.subTest(radius=radius, sense=sign):
                    length = max(150, min(300, radius * 1.2))
                    points, _ = road([(60, 0, 0), (length, sign / radius, sign / radius), (60, 0, 0)])
                    a = arcs(trace.fit(points), 40)
                    self.assertEqual(len(a), 1)
                    self.assertAlmostEqual(a[0]["radius"], radius, delta=0.06 * radius)
                    self.assertEqual(a[0]["sense"], "gauche" if sign > 0 else "droite")

    def test_mirror_gives_opposite_senses(self):
        points, _ = road(SCENE)
        mirrored = [(x, -y) for x, y in points]
        a, b = arcs(trace.fit(points), 40), arcs(trace.fit(mirrored), 40)
        self.assertEqual([e["sense"] for e in b], ["droite", "gauche"])
        self.assertAlmostEqual(a[0]["radius"], b[0]["radius"], delta=3)

    def test_reverse_direction(self):
        """Parcours en sens inverse : mêmes rayons, sens de virage opposés, dans l'ordre inverse."""
        points, _ = road(SCENE)
        a, b = arcs(trace.fit(points), 40), arcs(trace.fit(points[::-1]), 40)
        self.assertEqual([e["sense"] for e in b], ["gauche", "droite"])
        self.assertAlmostEqual(b[0]["radius"], a[1]["radius"], delta=0.05 * a[1]["radius"])

    def test_noisy_positions_without_rtk(self):
        """1 m de bruit : l'arc de 150 m est retrouvé à 12 % près, sans arcs parasites ni virage de sens contraire."""
        points, _ = road(SCENE, noise=1.0)
        r = trace.fit(points)
        a = arcs(r, 40)
        self.assertTrue(a)
        self.assertEqual(a[0]["sense"], "gauche")
        self.assertAlmostEqual(a[0]["radius"], 150, delta=18)
        self.assertLess(r["rms"], 1.3)
        self.assertEqual([e for e in arcs(r, 0) if e["sense"] == "droite" and e["radius"] < 100], [])

    def test_length_not_inflated_by_noise(self):
        """La somme des cordes entre positions bruitées dépasse la longueur de la route de 4 % (1 m de bruit tous
        les 5 m) : la longueur ajustée doit rester à 1 % du vrai tracé."""
        points, length = road(SCENE, noise=1.0)
        r = trace.fit(points)
        self.assertAlmostEqual(r["length"], length, delta=0.015 * length)

    def test_duplicates_and_too_short(self):
        points, _ = road(SCENE)
        doubled = [p for p in points for _ in (0, 1)]
        self.assertEqual([e["sense"] for e in arcs(trace.fit(doubled), 40)], ["gauche", "droite"])
        self.assertIsNone(trace.fit(points[:2]))
        self.assertIsNone(trace.fit([(0, 0), (3, 0), (6, 0)]))  # moins de KNOT m


if __name__ == "__main__":
    unittest.main()
