# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Tests de core/widths.py : largeur perpendiculaire à la route depuis un point triangulé.

Scène : route nord-sud (axe 0°), point triangulé A à 5 m à l'est et 10 m au nord de l'origine ;
la droite de mesure est donc la ligne est-ouest y = 10. Bord opposé B à 3 m à l'ouest (x = -3),
soit 8 m de largeur. Les clics sont calculés depuis des positions connues de la caméra.
"""

import math
import unittest

from support import bearing, distance, module, point

measures = module("core.measures")
widths = module("core.widths")
geometry = module("core.geometry")

BDTOPO = {"axis": 0.0, "source": "BD TOPO, RUE"}
TRACK = {"axis": 0.0, "source": "séquence"}


class FakeItem:
    def __init__(self, canvas):
        self.data = None

    def set_data(self, *data):
        self.data = data

    def remove(self):
        pass


def edge(uncertainty=0.1):
    lon, lat = point(5.0, 10.0)
    return {"lon": lon, "lat": lat, "uncertainty": uncertainty, "name": "A"}


def click(camera=(0.0, 0.0), target=(-3.0, 10.0), accuracy=0.1, precise=True, elev_error=0.3):
    """Clic sur le sol en target (est, nord) depuis la caméra en camera."""
    lon, lat = point(*camera)
    yaw = bearing((lon, lat), point(*target))
    return {"pic": "p1", "lon": lon, "lat": lat, "yaw": yaw, "elev": -10.0, "raw": [yaw, -10.0],
            "pos": [0.1, -0.2], "accuracy": accuracy, "precise": precise, "sequence": "s1", "elev_error": elev_error}


class Base(unittest.TestCase):
    def setUp(self):
        self.tool = measures.MeasureTool(None)
        self.tool.new_item = lambda: FakeItem(None)
        self.tool.camera_height = 1.9


class Cross(unittest.TestCase):
    def test_intersection(self):
        (x, y), t, s, angle = widths.cross((5.0, 10.0), 0.0, (0.0, 0.0), math.degrees(math.atan2(-3.0, 10.0)))
        self.assertAlmostEqual(x, -3.0, places=6)
        self.assertAlmostEqual(y, 10.0, places=6)
        self.assertAlmostEqual(t, -8.0, places=4)
        self.assertAlmostEqual(s, math.hypot(3.0, 10.0), places=6)
        self.assertAlmostEqual(angle, math.degrees(math.atan2(10.0, 3.0)), places=6)

    def test_parallel_sighting_refused(self):
        # Photo juste en face de A : la visée du bord opposé longe la droite de mesure
        with self.assertRaises(geometry.GeometryError):
            widths.cross((5.0, 10.0), 0.0, (0.0, 10.0), 270.0)

    def test_line_behind(self):
        with self.assertRaises(geometry.GeometryError):
            widths.cross((5.0, 10.0), 0.0, (0.0, 20.0), 30.0)


class Width(Base):
    def test_value_and_marks(self):
        m = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click())
        self.assertIsNone(m.error)
        self.assertAlmostEqual(m.result["value"], 8.0, places=4)
        self.assertLess(m.result["uncertainty"], 0.3)
        self.assertIn("8,00 m", m.status())
        self.assertIn("point triangulé A", m.status())
        self.assertEqual(m.label()[:1], "↔")
        self.assertEqual(m.picks(), [])
        b = m.result["points"][1]
        self.assertLess(distance(b, point(-3.0, 10.0)), 1e-3)
        # Repères de la visionneuse : A et B sur la photo du clic
        marks = m.viewer_marks()["points"]
        self.assertEqual([p["pic"] for p in marks], ["p1", "p1"])
        self.assertAlmostEqual(marks[0]["abs_yaw"], bearing(point(0.0, 0.0), point(5.0, 10.0)), places=6)

    def test_uncertainty_across_the_road(self):
        """#3 de l'audit : l'erreur du point, surtout le long de la route, ne pèse qu'en travers."""
        along = dict(edge(0.5), cov=(0.01, 0.0, 0.25))  # ±0,1 m en travers (est), ±0,5 m le long (nord)
        wide = dict(edge(0.5))  # sans covariance : ±0,5 m dans toutes les directions
        m = widths.PerpendicularWidth(self.tool, along, BDTOPO, click())
        iso = widths.PerpendicularWidth(self.tool, wide, BDTOPO, click())
        self.assertLess(m.result["uncertainty"], iso.result["uncertainty"])
        b = {"lon": point(-3.0, 10.0)[0], "lat": point(-3.0, 10.0)[1], "uncertainty": 0.5,
             "cov": (0.01, 0.0, 0.25), "name": "B", "sightings": []}
        m.set_edge_b(b)
        self.assertLess(m.result["uncertainty"], 0.2)  # hypot(0,1, 0,1) et un peu d'axe, pas hypot(0,5, 0,5)

    def test_sight_disagreement_counts(self):
        """Visées d'un bord tombées à deux endroits : l'incertitude le dit, pour A comme pour B."""
        def sight(north, target_north):
            lon, lat = point(0.0, north)
            x, d = 5.0, target_north - north
            return {"lon": lon, "lat": lat, "heading": math.degrees(math.atan2(x, d)),
                    "elev": -math.degrees(math.atan2(2.0, math.hypot(x, d))), "alt": 2.0, "elev_error": 0.3}
        # Les visées touchent le bord à x = 5 ; leur croisement, décalé en travers, est à x = 5,8
        lon, lat = point(5.8, 10.0)
        off = dict(edge(), lon=lon, lat=lat, sightings=[sight(0, 10), sight(5, 12)], ground_z=(lon, lat, 0.0))
        alone = dict(edge(), lon=lon, lat=lat)  # le même point, sans visées
        def uncertainty(a):
            return widths.PerpendicularWidth(self.tool, a, BDTOPO, click()).result["uncertainty"]
        self.assertGreater(uncertainty(off), uncertainty(alone) + 0.5)
        self.assertAlmostEqual(uncertainty(dict(off, moved=True)), uncertainty(alone), places=6)  # déplacé à la main
        m = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click())
        m.set_edge_b(dict(alone, name="B", sightings=[]))
        before = m.result["uncertainty"]
        m.set_edge_b(dict(off, name="B"))
        self.assertGreater(m.result["uncertainty"], before + 0.5)

    def test_axis_barely_matters_for_a_click(self):
        """La droite tourne avec l'axe et le clic la suit jusqu'au bord vu : seul le cosinus compte."""
        bd = widths.PerpendicularWidth(self.tool, edge(0.001), BDTOPO, click()).result["uncertainty"]
        track = widths.PerpendicularWidth(self.tool, edge(0.001), TRACK, click()).result["uncertainty"]
        self.assertLess(track - bd, 0.01)

    def test_uncalibrated_tilt_counts(self):
        calibrated = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click()).result["uncertainty"]
        free = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click(elev_error=None)).result["uncertainty"]
        self.assertGreater(free, calibrated + 0.1)

    def test_same_sequence_gps_counts_less(self):
        apart = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click(accuracy=1.0)).result["uncertainty"]
        same = widths.PerpendicularWidth(self.tool, dict(edge(), sequences=["s1"]), BDTOPO, click(accuracy=1.0)).result["uncertainty"]
        self.assertLess(same, apart)

    def test_click_is_an_estimate(self):
        m = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click())
        self.assertTrue(m.label().startswith("↔ ≈ "))
        self.assertIn("Estimation", m.status())
        lon, lat = point(-3.0, 10.0)
        m.set_edge_b({"lon": lon, "lat": lat, "uncertainty": 0.1, "name": "B", "sightings": []})
        self.assertFalse(m.label().startswith("↔ ≈"))
        self.assertNotIn("Estimation", m.status())

    def test_barely_grazing_click_refused(self):
        """Visée à 10,2° : l'incertitude était infinie (« ± inf m ») ; elle est refusée, comme sous 10°."""
        m = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click(camera=(0.0, 10.54)))
        self.assertIsNone(m.result)
        self.assertIn("rasante", m.error)
        ok = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click(camera=(0.0, 10.7)))
        self.assertLess(ok.result["uncertainty"], 5.0)

    def test_terrain_and_camera_height_without_effect(self):
        m = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click())
        self.tool.camera_height = 2.5
        m.compute()
        self.assertAlmostEqual(m.result["value"], 8.0, places=4)

    def test_uncertainty_sources(self):
        base = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click()).result["uncertainty"]
        # Point de référence moins précis, axe de la séquence, GPS grand public : plus incertain
        for m in (widths.PerpendicularWidth(self.tool, edge(1.0), BDTOPO, click()),
                  widths.PerpendicularWidth(self.tool, edge(), TRACK, click()),
                  widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click(accuracy=3.0, precise=False))):
            self.assertGreater(m.result["uncertainty"], base)
        # Visée plus en biais (photo plus proche de la droite) : plus incertain
        oblique = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click(camera=(0.0, 9.0)))
        self.assertAlmostEqual(oblique.result["value"], 8.0, places=4)
        self.assertGreater(oblique.result["uncertainty"], base)
        self.assertIn("rasante", oblique.status())

    def test_refused_click(self):
        m = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click(camera=(0.0, 10.0)))
        self.assertIsNone(m.result)
        self.assertIn("parallèle", m.error)

    def test_reaim(self):
        m = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click())
        m.reaim(1, click(target=(-4.0, 10.0)))
        self.assertAlmostEqual(m.result["value"], 9.0, places=4)
        # Depuis une autre photo : repère de A recalculé pour elle
        other = dict(click(camera=(0.0, 20.0), target=(-4.0, 10.0)), pic="p2")
        m.reaim(1, other)
        self.assertAlmostEqual(m.result["value"], 9.0, places=4)
        marks = m.viewer_marks()["points"]
        self.assertEqual([p["pic"] for p in marks], ["p2", "p2"])
        self.assertAlmostEqual(marks[0]["abs_yaw"], bearing(point(0.0, 20.0), point(5.0, 10.0)), places=6)
        # Visée refusée : la largeur reste celle d'avant
        m.reaim(1, dict(click(camera=(0.0, 10.0)), pic="p3"))
        self.assertIn("parallèle", m.error)
        self.assertAlmostEqual(m.result["value"], 9.0, places=4)
        m.reaim(0, click())
        self.assertIn("point de référence", m.error)

    def test_nudge(self):
        # Bord décalé de 3 cm puis ramené de 1 cm : 8,02 m, repère déplacé dans la photo
        m = widths.PerpendicularWidth(self.tool, edge(), BDTOPO, click())
        for step in (0.01, 0.01, 0.01, -0.01):
            m.nudge(step)
        self.assertAlmostEqual(m.result["value"], 8.02, places=4)
        self.assertLess(distance(m.result["points"][1], point(-3.02, 10.0)), 1e-3)
        self.assertIn("décalé de 2 cm", m.status())
        dyaw, _ = m.result["shifts"][1]
        self.assertLess(dyaw, 0.0)  # bord poussé vers l'ouest : vu plus à gauche
        # Jamais au-delà du point de référence ; une nouvelle visée annule le décalage
        m.nudge(-20.0)
        self.assertAlmostEqual(m.result["value"], widths.MIN_WIDTH, places=6)
        m.reaim(1, click())
        self.assertAlmostEqual(m.result["value"], 8.0, places=4)
        self.assertEqual(m.side(), -1.0)

    def test_move_edge(self):
        a = edge()
        widths.move_edge(a, 0.0, -0.5)  # 50 cm vers l'ouest
        self.assertLess(distance((a["lon"], a["lat"]), point(4.5, 10.0)), 1e-3)
        m = widths.PerpendicularWidth(self.tool, a, BDTOPO, click())
        self.assertAlmostEqual(m.result["value"], 7.5, places=4)

    def test_guide(self):
        a, b = widths.guide(edge(), 0.0)
        self.assertLess(distance(a, point(-10.0, 10.0)), 1e-3)
        self.assertLess(distance(b, point(20.0, 10.0)), 1e-3)


if __name__ == "__main__":
    unittest.main()
