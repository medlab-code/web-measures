# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Tests de triangulation.py : intersection de visées en plan et dans l'espace."""

import math
import unittest

from support import bearing, distance, module, point

triangulation = module("core.triangulation")
TriangulationError = triangulation.TriangulationError


def sighting(photo, target, **extra):
    s = {"lon": photo[0], "lat": photo[1], "heading": bearing(photo, target)}
    s.update(extra)
    return s


class Projection(unittest.TestCase):
    def test_local_geographic_round_trip(self):
        lon, lat = point(123.4, -56.7)
        x, y = triangulation._local(lon, lat, *point(0, 0))
        self.assertAlmostEqual(x, 123.4, places=6)
        self.assertAlmostEqual(y, -56.7, places=6)

    def test_offset(self):
        origin = point(0, 0)
        for heading, east, north in ((0, 0, 100), (90, 100, 0), (180, 0, -100), (225, -70.7107, -70.7107)):
            x, y = triangulation._local(*triangulation.offset(origin[0], origin[1], heading, 100), *origin)
            self.assertAlmostEqual(x, east, places=3)
            self.assertAlmostEqual(y, north, places=3)

    def test_crossing_angle(self):
        self.assertAlmostEqual(triangulation.crossing_angle(10, 100), 90)
        self.assertAlmostEqual(triangulation.crossing_angle(0, 179), 1)
        self.assertAlmostEqual(triangulation.crossing_angle(350, 10), 20)
        self.assertAlmostEqual(triangulation.crossing_angle(30, 210), 0)


class Solve(unittest.TestCase):
    def setUp(self):
        self.target = point(15, 30)
        self.photos = [point(0, 0), point(20, 0), point(40, 5)]

    def test_two_exact_sightings(self):
        result = triangulation.solve([sighting(p, self.target, accuracy=2) for p in self.photos[:2]])
        self.assertLess(distance((result["lon"], result["lat"]), self.target), 0.001)
        for d, photo in zip(result["distances"], self.photos):
            self.assertAlmostEqual(d, distance(photo, self.target), places=2)
        self.assertLess(result["rms"], 0.001)
        self.assertFalse(result["gps_assumed"])

    def test_three_sightings_and_gps(self):
        sightings = [sighting(p, self.target, accuracy=a) for p, a in zip(self.photos, (2, None, 4))]
        result = triangulation.solve(sightings)
        self.assertLess(distance((result["lon"], result["lat"]), self.target), 0.001)
        self.assertTrue(result["gps_assumed"])
        self.assertEqual(result["gps"], max(4, triangulation.GPS_ACCURACY))

    def test_uncertainty_grows_with_gps_error(self):
        good = triangulation.solve([sighting(p, self.target, accuracy=1) for p in self.photos[:2]])
        bad = triangulation.solve([sighting(p, self.target, accuracy=5) for p in self.photos[:2]])
        self.assertGreater(bad["uncertainty"], good["uncertainty"])

    def test_noisy_sightings_stay_close(self):
        sightings = [sighting(p, self.target, accuracy=2) for p in self.photos]
        for s, noise in zip(sightings, (0.5, -0.5, 0.3)):
            s["heading"] += noise
        result = triangulation.solve(sightings)
        self.assertLess(distance((result["lon"], result["lat"]), self.target), 0.5)
        self.assertGreater(result["rms"], 0.0)

    def test_errors(self):
        target = self.target
        with self.assertRaises(TriangulationError):  # une seule visée
            triangulation.solve([sighting(self.photos[0], target)])
        with self.assertRaises(TriangulationError):  # visées parallèles
            triangulation.solve([{"lon": p[0], "lat": p[1], "heading": 0.0} for p in self.photos[:2]])
        behind = [sighting(p, target) for p in self.photos[:2]]
        for s in behind:
            s["heading"] = (s["heading"] + 180) % 360
        with self.assertRaises(TriangulationError):  # point derrière les photos
            triangulation.solve(behind)
        far = point(10, 800)
        with self.assertRaises(TriangulationError):  # plus de MAX_DISTANCE
            triangulation.solve([sighting(p, far) for p in (point(0, 0), point(100, 0))])


class Solve3d(unittest.TestCase):
    """Rue nord-sud, photos RTK sur l'axe tous les 5 m (caméra à 2,2 m au-dessus d'un sol à
    300 m, montant de 2 %) ; bord de trottoir visé vers l'avant : visées presque alignées."""
    CAM = 2.2

    def ground(self, north):
        return 300.0 + 0.02 * north

    def sightings(self, target, norths=(0.0, 5.0), noise=(), **extra):
        out = []
        for k, north in enumerate(norths):
            photo, z_cam = point(0, north), self.ground(north) + self.CAM
            east, dn = target[0], target[1] - north
            elev = math.degrees(math.atan2(target[2] - z_cam, math.hypot(east, dn)))
            s = {"lon": photo[0], "lat": photo[1], "heading": bearing(photo, point(*target[:2])), "elev": elev,
                 "alt": z_cam, "ground": self.ground(north), "elev_error": 0.2, "accuracy": 0.1,
                 "precise": True, "sequence": "s"}
            if k < len(noise):
                s["heading"] += noise[k][0]
                s["elev"] += noise[k][1]
            s.update(extra)
            out.append(s)
        return out

    def target(self):
        return (3.0, 13.0, self.ground(13.0))  # au sol, 3 m sur le côté

    def test_exact_point(self):
        t = self.target()
        for ground in (False, True):
            r = triangulation.solve(self.sightings(t), ground)
            self.assertEqual(r["method"], "3d")
            self.assertLess(distance((r["lon"], r["lat"]), point(*t[:2])), 0.01)
            self.assertAlmostEqual(r["z"], t[2], places=2)
            self.assertAlmostEqual(r["distances"][0], math.hypot(3, 13), places=1)
            self.assertLess(r["rms"], 0.01)

    def test_depth_better_than_plan(self):
        # Caps faussés de ±0,5° (erreur de visée des photos de relevé), inclinaisons de 0,1° :
        # en plan, le point glisse de plusieurs mètres le long des visées
        t = self.target()
        noise = ((0.5, 0.1), (-0.5, -0.1))
        flat = [dict(s, alt=None) for s in self.sightings(t, noise=noise)]
        plan = triangulation.solve(flat, True)
        self.assertEqual(plan["method"], "plan")
        err_plan = distance((plan["lon"], plan["lat"]), point(*t[:2]))
        r = triangulation.solve(self.sightings(t, noise=noise), True)
        err_3d = distance((r["lon"], r["lat"]), point(*t[:2]))
        self.assertGreater(err_plan, 1.0)
        self.assertLess(err_3d, err_plan / 3)
        self.assertLess(r["uncertainty"], plan["uncertainty"])

    def test_parallel_headings_still_solved(self):
        # Point droit devant, caps identiques : en plan, impossible ; en 3D, les inclinaisons
        # (différentes d'une photo à l'autre) le fixent
        t = (0.0, 15.0, self.ground(15.0))
        r = triangulation.solve(self.sightings(t), True)
        self.assertLess(distance((r["lon"], r["lat"]), point(*t[:2])), 0.05)
        with self.assertRaises(TriangulationError):
            triangulation.solve([dict(s, alt=None) for s in self.sightings(t)], True)

    def test_lidar_at_point(self):
        # Route qui se relève de 30 cm au point visé (dévers, bombement) : le sol prolongé depuis
        # les photos se trompe, l'altitude LiDAR lue au point non
        t = self.target()
        bumped = (t[0], t[1], t[2] + 0.3)
        sightings = self.sightings(bumped)
        photos = triangulation.solve(sightings, True)
        lidar = triangulation.solve(sightings, True, bumped[2])
        self.assertEqual((photos["ground_source"], lidar["ground_source"]), ("photos", "lidar"))
        err = lambda r: distance((r["lon"], r["lat"]), point(*t[:2]))
        self.assertLess(err(lidar), 0.02)
        self.assertGreater(err(photos), 5 * err(lidar))
        # Sans sol sous les photos, l'altitude lue au point suffit au calcul 3D
        self.assertEqual(triangulation.solve([dict(s, ground=None) for s in sightings], True, bumped[2])["method"], "3d")

    def test_ground_error_grows(self):
        # Dispersion de la hauteur de caméra et prolongement au-delà des photos : sol moins sûr
        t = self.target()
        tight = triangulation.solve(self.sightings(t), True)["uncertainty"]
        loose = triangulation.solve(self.sightings(t, ground_spread=0.2), True)["uncertainty"]
        self.assertGreater(loose, tight)
        origin = point(0, 0)
        near = triangulation._ground_at(self.sightings(t), 0.0, 2.5, origin)
        far = triangulation._ground_at(self.sightings(t), 0.0, 30.0, origin)
        self.assertAlmostEqual(near[1], triangulation.GROUND_ERROR)
        self.assertGreater(far[1], near[1])

    def test_common_tilt(self):
        # Inclinaison commune aux photos d'une séquence : comptée dans l'incertitude, bien plus
        # quand l'inclinaison n'est pas calée (tangage de la fixation)
        t = self.target()
        calibrated = triangulation.solve(self.sightings(t), True)
        loose = triangulation.solve(self.sightings(t, elev_error=None), True)
        self.assertGreater(loose["common_tilt"], 10 * calibrated["common_tilt"])
        self.assertGreaterEqual(loose["uncertainty"], loose["common_tilt"])
        # Biais commun réel de 2° sur une photo non calée : l'erreur reste dans l'incertitude
        biased = triangulation.solve(self.sightings(t, noise=((0.0, 2.0), (0.0, 2.0)), elev_error=None), True)
        self.assertLess(distance((biased["lon"], biased["lat"]), point(*t[:2])), loose["uncertainty"])

    def test_strong_crossing_stays_in_plan(self):
        # Visées bien croisées (cas du panneau de Commarin, 32°) : les caps suffisent, calcul en plan
        t = (8.0, 9.0, self.ground(9.0))
        r = triangulation.solve(self.sightings(t), True)
        self.assertGreater(r["angle"], triangulation.STRONG_ANGLE)
        self.assertEqual(r["method"], "plan")

    def test_falls_back_to_plan(self):
        t = self.target()
        sightings = self.sightings(t, norths=(-10.0, 0.0))
        sightings[1]["alt"] = None  # une photo sans altitude vérifiée
        self.assertEqual(triangulation.solve(sightings, True)["method"], "plan")
        sightings = self.sightings(t, norths=(-10.0, 0.0), ground=None)  # pas de sol LiDAR
        self.assertEqual(triangulation.solve(sightings, True)["method"], "plan")
        self.assertEqual(triangulation.solve(sightings, False)["method"], "3d")  # point hors sol


class HeadingError(unittest.TestCase):
    def test_values(self):
        self.assertEqual(triangulation.heading_error({}), triangulation.HEADING_ERROR)
        self.assertEqual(triangulation.heading_error({"precise": True, "accuracy": 1.5}),
                         triangulation.SURVEY_HEADING_ERROR)
        self.assertEqual(triangulation.heading_error({"precise": True, "accuracy": 5}),
                         triangulation.HEADING_ERROR)
        self.assertEqual(triangulation.heading_error({"precise": True, "accuracy": 1, "heading_error": 0.2}), 0.2)



class CommonErrors(unittest.TestCase):
    def test_same_sequence(self):
        """Visées d'une même séquence : erreurs de position et de cap communes, qui ne se
        compensent pas ; plus incertain que les mêmes visées depuis des séquences différentes."""
        target = point(0, 30)
        photos = [point(x, 0) for x in range(-20, 21, 5)]  # neuf photos le long d'une rue
        def sightings(seqs):
            return [{"lon": p[0], "lat": p[1], "heading": bearing(p, target), "accuracy": 2.0, "sequence": s}
                    for p, s in zip(photos, seqs)]
        independent = triangulation.solve(sightings("abcdefghi"))["uncertainty"]
        same = triangulation.solve(sightings("a" * 9))["uncertainty"]
        self.assertGreater(same, independent)
        self.assertGreaterEqual(same, 2.0)  # au moins le décalage GPS commun


if __name__ == "__main__":
    unittest.main()
