# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Tests de core/session.py : enchaînement des mesures appuyées sur des points triangulés,
comme dans l'application web et le plugin (clics en radians dans le repère de la photo).

Scène : deux photos 360° à 6 m l'une de l'autre sur une route nord-sud (cap 0°), cible à
5 m à l'est entre les deux ; sol plat, caméra à 1,9 m. Les clics visent des points connus.
"""

import math
import unittest

from support import distance, module, point

session = module("core.session")

CAMERA = 1.9


def photo(pic, north):
    lon, lat = point(0.0, north)
    return {"id": pic, "collection": "s1", "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"view:azimuth": 0, "datetime": "2026-01-01T00:00:00Z",
                           "pers:interior_orientation": {"field_of_view": 360}},
            "links": []}


def direction(from_north, target):
    """(cap relatif à l'image, élévation) en radians, de la photo vers target (est, nord, z)."""
    dx, dy, dz = target[0], target[1] - from_north, target[2] - CAMERA
    return math.atan2(dx, dy), math.atan2(dz, math.hypot(dx, dy))


class Base(unittest.TestCase):
    def setUp(self):
        self.s = session.Session()
        self.s.set_camera_height(CAMERA)
        self.p1, self.p2 = photo("p1", 0.0), photo("p2", 6.0)
        self.s.set_active(True)

    def aim(self, item, north, target):
        self.s.set_picture(item)
        return self.s.click(*direction(north, target))


def linked(*specs):
    """Photos d'une même séquence, reliées par leurs liens prev/next : specs (id, nord)."""
    items = [photo(pic, north) for pic, north in specs]
    for k, item in enumerate(items):
        for rel, other in (("prev", items[k - 1] if k else None), ("next", items[k + 1] if k + 1 < len(items) else None)):
            if other:
                item["links"].append({"rel": rel, "href": "https://x/api/collections/s1/items/" + other["id"]})
    return items


class TiltOnClick(Base):
    """Inclinaison automatique lancée au premier clic sur la photo, pas à son arrivée (le calcul
    ferait saccader la vue pendant qu'on cherche l'objet)."""

    def test_started_by_click(self):
        asked = []
        self.s.tilts.check = lambda item, cal, done=None: asked.append(item["id"])
        self.s.set_mode("road")
        self.s.set_picture(self.p1)
        self.assertEqual(asked, [])  # arrivée sur la photo : rien
        self.s.click(*direction(0.0, (4.0, 9.0, 0.0)))
        self.assertEqual(asked, ["p1"])
        self.s.set_picture(self.p2)
        self.assertEqual(asked, ["p1"])


class Epipolar(Base):
    """Visées des autres photos tracées dans la photo affichée (largeur, mesure libre)."""

    def test_target_on_the_line(self):
        edge = (4.0, 9.0, 0.0)
        self.s.set_mode("road")
        self.aim(self.p1, 0.0, edge)
        self.s.set_picture(self.p2)
        lines = [m for m in self.s.viewer_marks() if m["epipolar"]]
        self.assertEqual(len(lines), 1)
        yaw, pitch = direction(6.0, edge)  # le bord vu de la seconde photo : sur le trait
        pts = lines[0]["points"]

        def to_segment(p, q):  # écart (radians) du bord au segment pq du trait
            dx, dy = q[0] - p[0], q[1] - p[1]
            t = max(0.0, min(1.0, ((yaw - p[0]) * dx + (pitch - p[1]) * dy) / (dx * dx + dy * dy or 1)))
            return math.hypot(p[0] + t * dx - yaw, p[1] + t * dy - pitch)

        self.assertLess(min(to_segment(p, q) for p, q in zip(pts, pts[1:])), math.radians(0.1))
        self.s.set_picture(self.p1)  # sur la photo de la visée : pas de trait
        self.assertFalse(any(m["epipolar"] for m in self.s.viewer_marks()))
        self.s.set_mode("height")  # hauteur : pas de trait
        self.aim(self.p1, 0.0, edge)
        self.s.set_picture(self.p2)
        self.assertFalse(any(m["epipolar"] for m in self.s.viewer_marks()))


class UndoLastPoint(Base):
    """« Effacer » sans rien en cours : le dernier point posé (sommet, bord, A, point gardé)."""

    def test_height_then_reference(self):
        foot = (5.0, 3.0, 0.0)
        self.s.set_mode("height")
        self.aim(self.p1, 0.0, foot)
        self.aim(self.p2, 6.0, foot)
        self.s.keep_point()
        self.s.click(*direction(6.0, (5.0, 3.0, 4.0)))
        self.assertEqual(len(self.s._heights()), 1)
        self.assertIn("Sommet effacé", self.s.clear())
        self.assertEqual(self.s._heights(), [])
        self.assertTrue(self.s.click(*direction(6.0, (5.0, 3.0, 3.0))).startswith("Hauteur : 3,00 m"))  # sommet recliqué
        self.s.clear()
        self.assertIn("Point de référence A effacé", self.s.clear())  # plus de mesure : A
        self.assertIsNone(self.s.ref_point)
        self.assertEqual(self.s.points, [])
        self.assertTrue(self.s._aiming())
        self.aim(self.p1, 0.0, foot)
        self.aim(self.p2, 6.0, foot)
        self.s.keep_point()
        self.assertEqual(self.s.ref_point["name"], "A")  # lettre réutilisée

    def test_free_measure(self):
        self.s.set_mode("tri")
        for target in ((5.0, 3.0, 0.0), (5.0, 8.0, 0.0)):
            self.aim(self.p1, 0.0, target)
            self.aim(self.p2, 6.0, target)
            self.s.keep_point()
        self.assertEqual((len(self.s.points), len(self.s.links)), (2, 1))
        self.assertIn("Point B effacé", self.s.clear())
        self.assertEqual((len(self.s.points), len(self.s.links)), (1, 0))
        self.aim(self.p1, 0.0, (5.0, 3.0, 0.0))
        self.s.clear()  # visée en cours : seulement elle
        self.assertEqual(len(self.s.points), 1)


class WidthReference(Base):
    """Largeur : croix A et droite de mesure là où A a été visé (croix bleue de la visée)."""

    def test_cross_where_aimed(self):
        # Bord visé 15 cm sous le sol supposé (caniveau) : la projection au sol plat tomberait à
        # côté ; la croix A reste sur la visée, et la droite de mesure passe par elle
        edge = (4.0, 9.0, -0.15)
        self.s.set_mode("road")
        self.aim(self.p1, 0.0, edge)
        self.aim(self.p2, 6.0, edge)
        self.s.keep_point()
        ref = self.s.ref_point
        ref["road"] = {"axis": 0.0, "source": "BD TOPO"}  # pas de lecture réseau dans les tests
        self.s.set_picture(self.p2)
        aimed = direction(6.0, edge)
        mark = self.s._reference_mark()["points"][0]
        self.assertAlmostEqual(mark["yaw"], aimed[0], places=6)
        self.assertAlmostEqual(mark["pitch"], aimed[1], places=6)
        flat = self.s._project(ref["lon"], ref["lat"])
        self.assertGreater(abs(flat["pitch"] - aimed[1]), math.radians(0.3))  # projection : à côté
        guide = self.s._guide_mark(ref["road"])["points"]
        near = min(guide, key=lambda p: math.hypot(p["yaw"] - aimed[0], p["pitch"] - aimed[1]))
        self.assertLess(math.hypot(near["yaw"] - aimed[0], near["pitch"] - aimed[1]), math.radians(0.3))
        ref["moved"] = True  # déplacé à la main le long de la droite : projection
        self.assertAlmostEqual(self.s._reference_mark()["points"][0]["pitch"], flat["pitch"], places=6)


class NameSide(unittest.TestCase):
    """Nom d'une croix posée sur le trait d'une autre mesure : à côté du trait."""

    def test_beside_line(self):
        beside = module("core.session")._beside_line
        r = math.radians
        vertical = ({"yaw": 0.0, "pitch": 0.0}, {"yaw": 0.0, "pitch": r(20)})
        horizontal = ({"yaw": 0.0, "pitch": 0.0}, {"yaw": r(20), "pitch": 0.0})
        self.assertEqual(beside({"yaw": 0.0, "pitch": r(10)}, [vertical]), "right")
        self.assertEqual(beside({"yaw": r(10), "pitch": 0.0}, [horizontal]), "below")
        self.assertIsNone(beside({"yaw": 0.0, "pitch": r(20)}, [vertical]))  # bout du trait
        self.assertIsNone(beside({"yaw": r(3), "pitch": r(10)}, [vertical]))  # à côté


class EdgeB(Base):
    """Largeur : bord B triangulé à son tour, après le clic simple."""

    def width(self):
        a, b = (4.0, 9.0, 0.0), (-3.5, 9.6, 0.0)  # bords opposés, la route nord-sud (axe 0°)
        self.s.set_mode("road")
        self.aim(self.p1, 0.0, a)
        self.aim(self.p2, 6.0, a)
        self.s.keep_point()
        self.s.ref_point["road"] = {"axis": 0.0, "source": "BD TOPO"}  # pas de lecture réseau
        self.s.set_picture(self.p1)
        yaw, pitch = direction(0.0, b)
        self.s.click(yaw + math.radians(1.5), pitch)  # clic simple un peu à côté du bord
        return a, b

    def test_offer_then_triangulate(self):
        a, b = self.width()
        m = self.s._widths()[0]
        clicked = m.result["value"]
        self.assertEqual(self.s.state()["edge_b"], "B")  # bouton proposé après le clic simple, avec la lettre
        self.s.start_edge_b()
        state = self.s.state()
        self.assertTrue(state["edge_b_aiming"] and state["aiming"])
        self.assertFalse(state["edge_b"])
        self.assertIsNone(state["new_measure"])
        self.assertIn("passez à la photo suivante", self.s.status().lower())
        # Le clic rapide est déjà la première visée, depuis la photo de la mesure
        self.assertEqual([s["pic"] for s in self.s.triangulator.sightings], ["p1"])
        self.assertEqual(self.s.state()["guide"]["reference"], "p1")
        self.assertTrue(any(m["sighting"] for m in self.s.viewer_marks()))
        self.aim(self.p1, 0.0, b)  # visée refaite sur le bord exact (elle remplace le clic)
        self.s.set_picture(self.p2)
        # Autre photo : seulement les visées (et le trait de celle de la photo de la mesure)
        self.assertTrue(all(m["sighting"] or m["epipolar"] for m in self.s.viewer_marks()))
        self.aim(self.p2, 6.0, b)
        marks = self.s.viewer_marks()
        self.assertTrue(marks and all(m["sighting"] or m["epipolar"] for m in marks))  # sans droite ni largeur
        self.s.keep_point()
        self.assertEqual(self.s.take_goto(), "p1")  # retour sur la photo de référence
        self.assertIsNone(self.s.take_frame())  # pas encore sur la photo de référence
        self.s.set_picture(self.p1)
        frame = self.s.take_frame()  # largeur entière : A et B
        self.assertEqual(len(frame), 2)
        on_line = direction(0.0, (b[0], a[1], 0.0))  # B ramené sur la droite passant par A (#37)
        self.assertAlmostEqual(frame[1][0], on_line[0], places=6)
        self.assertIsNone(self.s.take_frame())  # une seule fois
        marks = self.s.viewer_marks()
        self.assertTrue(any(m["guide"] for m in marks))  # droite de mesure de retour
        # Une seule croix pour B : celle de la largeur, sur la droite de mesure, pas là où B a été visé (#37)
        width = next(mk for mk in marks if mk["label"].startswith("↔"))
        self.assertAlmostEqual(width["points"][1][0], on_line[0], places=6)
        self.assertAlmostEqual(width["points"][1][1], on_line[1], places=6)
        self.assertGreater(abs(width["points"][1][0] - direction(0.0, b)[0]), 0.01)
        lone = [mk for mk in marks if not mk["label"] and not mk["guide"] and not mk["name"] and not mk["sighting"]]
        self.assertEqual(lone, [])  # pas de croix « B » à part (point gardé)
        self.assertIsNotNone(m.edge_b)
        self.assertEqual(m.edge_b["name"], "B")
        self.assertAlmostEqual(m.result["value"], 7.5, places=2)  # 4 − (−3,5), perpendiculaire à l'axe
        self.assertNotAlmostEqual(clicked, m.result["value"], places=2)
        self.assertIn("entre les points triangulés A et B", m.status())
        self.assertEqual([v["nom"] for _, _, v in self.s.points], ["A", "B"])
        self.assertFalse(self.s.state()["edge_b"])  # déjà triangulé
        triangulation = module("core.triangulation")
        bx, by = triangulation._local(*m.result["points"][1], *point(0.0, 0.0))
        self.assertAlmostEqual(by, 9.0, places=2)  # B ramené sur la droite passant par A

    def test_provisional_name(self):
        # Bord cliqué : nom provisoire (lettre suivante), gardé quand le bord est triangulé
        a, b = self.width()
        ends = lambda: [(mk["end"], mk["names"]) for mk in self.s.viewer_marks() if mk["end"]]
        # Nom du bord dans l'étiquette de la largeur, pas à part
        self.assertEqual(ends(), [({"name": "B", "provisional": True}, ["A", "B"])])
        self.assertEqual([mk["label"] for mk in self.s.viewer_marks() if mk["name"]], ["A"])
        self.s.start_edge_b()
        self.aim(self.p2, 6.0, b)
        self.s.keep_point()
        self.s.set_picture(self.p1)
        self.assertEqual(ends(), [({"name": "B", "provisional": False}, ["A", "B"])])  # même lettre, triangulé
        self.assertEqual([mk["label"] for mk in self.s.viewer_marks() if mk["name"]], ["A"])  # B dans l'étiquette
        self.assertEqual([v["nom"] for _, _, v in self.s.points], ["A", "B"])
        self.assertEqual(self.s.named, 2)  # point suivant : C

    def test_undo_triangulated_edge(self):
        # « Effacer » après le bord triangulé : la largeur et son point B gardé partent ensemble
        a, b = self.width()
        self.s.start_edge_b()
        self.aim(self.p2, 6.0, b)
        self.s.keep_point()
        self.assertEqual([v["nom"] for _, _, v in self.s.points], ["A", "B"])
        self.assertIn("Bord opposé effacé", self.s.clear())
        self.assertEqual(self.s._widths(), [])
        self.assertEqual([v["nom"] for _, _, v in self.s.points], ["A"])

    def test_cancel_keeps_click(self):
        self.width()
        m = self.s._widths()[0]
        value = m.result["value"]
        self.s.start_edge_b()
        self.aim(self.p1, 0.0, (-3.5, 9.6, 0.0))
        self.assertIn("abandonnée", self.s.clear())
        self.assertIsNone(m.edge_b)
        self.assertEqual(m.result["value"], value)
        self.assertTrue(self.s.state()["edge_b"])  # de nouveau proposé


class Guided(Base):
    """Visées guidées : photo de référence, voisines proposées, retour après validation."""

    def test_height(self):
        before, ref, after = linked(("avant", -6.0), ("ref", 0.0), ("apres", 6.0))
        foot = (5.0, 0.0, 0.0)
        self.s.set_mode("height")
        self.assertIsNone(self.s.state()["guide"])
        self.aim(ref, 0.0, foot)
        guide = self.s.state()["guide"]
        self.assertEqual(guide["reference"], "ref")
        self.assertEqual([c["id"] for c in guide["choices"]], ["avant", "apres"])
        self.assertEqual([c["label"] for c in guide["choices"]], ["Photo précédente", "Photo suivante"])
        self.aim(after, 6.0, foot)
        self.assertEqual([c["id"] for c in self.s.state()["guide"]["choices"]], ["avant"])  # de l'autre côté
        # Nommée par rapport à la photo affichée (la suivante de la référence) : 2 photos en arrière
        self.assertEqual(self.s.state()["guide"]["choices"][0]["label"], "3e visée : 2 photos en arrière")
        self.s.set_picture(ref)  # revenu sur la référence : c'est la précédente
        self.assertEqual(self.s.state()["guide"]["choices"][0]["label"], "3e visée : photo précédente")
        self.s.set_picture(photo("ailleurs", 30.0))  # photo hors de la séquence proche
        self.assertEqual(self.s.state()["guide"]["choices"][0]["label"], "3e visée : de l'autre côté de la référence")
        self.s.set_picture(after)
        self.aim(before, -6.0, foot)
        self.assertEqual(self.s.state()["guide"]["choices"], [])
        self.s.keep_point()  # validé depuis la dernière photo visée
        self.assertEqual(self.s.take_goto(), "ref")  # retour sur la photo de référence
        self.assertIsNone(self.s.take_frame())
        self.s.set_picture(ref)
        frame = self.s.take_frame()  # vue cadrée sur A
        self.assertEqual(len(frame), 1)
        self.assertAlmostEqual(frame[0][0], direction(0.0, foot)[0], places=6)
        self.assertIsNone(self.s.take_goto())  # une seule fois
        self.assertIsNone(self.s.state()["guide"])

    def test_width_goes_towards_the_point(self):
        # Bord visé devant (vers le nord, sens de la séquence) : photos suivantes, jamais en arrière
        p0, p1, p2, p3 = linked(("p0", 0.0), ("p1", 5.0), ("p2", 10.0), ("p3", 15.0))
        edge = (3.0, 13.0, 0.0)
        self.s.set_mode("road")
        self.aim(p1, 5.0, edge)
        self.assertEqual([c["id"] for c in self.s.state()["guide"]["choices"]], ["p2"])
        self.assertEqual(self.s.state()["guide"]["choices"][0]["label"], "Photo suivante")
        self.aim(p2, 10.0, edge)
        self.assertEqual([c["id"] for c in self.s.state()["guide"]["choices"]], ["p3"])
        self.assertEqual(self.s.state()["guide"]["choices"][0]["label"], "3e visée : photo suivante")
        self.s.set_picture(p1)  # revenu sur la référence
        self.assertEqual(self.s.state()["guide"]["choices"][0]["label"], "3e visée : 2 photos en avant")
        # Visé vers l'arrière : on remonte la séquence
        self.s.clear_all()
        self.aim(p2, 10.0, (3.0, -2.0, 0.0))
        self.assertEqual([c["id"] for c in self.s.state()["guide"]["choices"]], ["p1"])


class Height(Base):
    def test_reference_then_top(self):
        foot, top = (5.0, 3.0, 0.0), (5.0, 3.0, 4.0)
        self.s.set_mode("height")
        self.assertTrue(self.s._aiming())
        self.aim(self.p1, 0.0, foot)
        text = self.aim(self.p2, 6.0, foot)
        self.assertIn("2 visées", text)
        self.assertIn("Valider le point triangulé", text)
        self.assertIn("Point de référence A validé", self.s.keep_point())
        self.assertFalse(self.s._aiming())
        names = lambda: [(m["label"], len(m["points"])) for m in self.s.viewer_marks() if m["name"]]
        self.assertEqual(names(), [("A", 1)])  # nom du point de référence à côté de sa croix
        # Seul le sommet se clique : le pied est la visée faite depuis cette photo
        text = self.s.click(*direction(6.0, top))
        self.assertTrue(text.startswith("Hauteur : 4,00 m"), text)
        self.assertIn("calée sur le point triangulé A", text)
        # A toujours au pied, une fois la hauteur faite ; sommet nommé B (provisoire) dans
        # l'étiquette de la hauteur
        self.assertEqual(names(), [("A", 1)])
        self.assertEqual([m["side"] for m in self.s.viewer_marks() if m["name"]], ["below"])  # sous le pied
        self.assertEqual([(m["end"], m["names"]) for m in self.s.viewer_marks() if m["end"]],
                         [({"name": "B", "provisional": True}, ["A", "B"])])
        # Hauteur faite : un autre clic ne mesure pas, seules ses croix s'ajustent
        self.assertEqual(self.s.state()["new_measure"], "A")
        text = self.s.click(*direction(6.0, (5.0, 3.0, 2.0)))
        self.assertTrue(text.startswith("Hauteur mesurée depuis le point A"), text)
        self.assertEqual(len(self.s._heights()), 1)
        # « Nouvelle mesure depuis A » : le même point sert à une autre hauteur, depuis l'autre photo
        self.s.new_measure()
        self.assertIsNone(self.s.state()["new_measure"])
        self.s.set_picture(self.p1)
        text = self.s.click(*direction(0.0, (5.0, 3.0, 2.5)))
        self.assertTrue(text.startswith("Hauteur : 2,50 m"), text)
        self.assertEqual(len(self.s._heights()), 2)
        self.assertEqual([m["end"]["name"] for m in self.s.viewer_marks() if m["end"]], ["B", "C"])
        self.assertEqual(sum(1 for m in self.s.viewer_marks() if m.get("vertical")), 1)

    def test_new_measure_keeps_corrected_foot(self):
        # Pied de la hauteur relevé à la main (↑ ×3) : « Nouvelle mesure depuis A » repart du pied
        # corrigé, sans seconde croix au pied
        foot = (5.0, 3.0, 0.0)
        self.s.set_mode("height")
        self.aim(self.p1, 0.0, foot)
        self.aim(self.p2, 6.0, foot)
        self.s.keep_point()
        self.s.click(*direction(6.0, (5.0, 3.0, 4.0)))
        first = self.s._heights()[0]
        self.s.click(*direction(6.0, foot))  # clic sur la croix du pied : sélectionné
        self.assertEqual(self.s.tool.selected, (first, 0))
        for _ in range(3):
            self.s.nudge_point("up")
        self.s.finish_point()
        self.assertTrue(self.s.message.startswith("Hauteur : 3,97 m"), self.s.message)
        self.s.new_measure()
        self.s.click(*direction(6.0, (5.0, 3.0, 2.0)))
        second = self.s._heights()[1]
        self.assertTrue(second.result["value"] > 1.96 and second.result["value"] < 1.98, second.result["value"])
        foot1, foot2 = first.viewer_marks()["points"][0], second.viewer_marks()["points"][0]
        self.assertAlmostEqual(foot1["yaw"], foot2["yaw"], places=6)  # une seule croix au pied
        self.assertAlmostEqual(foot1["pitch"], foot2["pitch"], places=6)

    def test_select_and_lift(self):
        foot, top = (5.0, 3.0, 0.0), (5.0, 3.0, 4.0)
        self.s.set_mode("height")
        self.aim(self.p1, 0.0, foot)
        self.aim(self.p2, 6.0, foot)
        self.s.keep_point()
        self.s.click(*direction(6.0, top))
        # Clic sur la croix du sommet : sélectionné ; ↑ ↑ : 2 cm ; Entrée : terminé
        self.s.click(*direction(6.0, top))
        self.assertTrue(self.s.state()["point_sel"])
        self.s.nudge_point("up")
        self.s.nudge_point("up")
        text = self.s.finish_point()
        self.assertTrue(text.startswith("Hauteur : 4,02 m"), text)
        self.assertFalse(self.s.state()["point_sel"])


    def test_vertical_follows_tilt(self):
        # Photo p2 penchée de 4°, inclinaison calée : la verticale verte passe par la croix du
        # pied et suit un vrai objet vertical vu par la caméra penchée, pas le bord de l'image
        calibration = module("core.calibration")
        up = calibration.vector(60.0, 86.0)  # verticale vraie dans le repère de la caméra penchée

        def seen(target):
            yaw, elev = direction(6.0, target)
            return calibration.untilt(up, math.degrees(yaw), math.degrees(elev), inverse=True)

        def tilted(target):
            yaw, elev = seen(target)
            return math.radians((yaw + 180) % 360 - 180), math.radians(elev)

        for k, east in enumerate((5.0, -5.0)):  # deux objets verticaux pour le calage
            self.s.calibration.add_vertical("p2", seen((east, 3.0 + 4 * k, 0.0)), seen((east, 3.0 + 4 * k, 3.0)))
        foot = (5.0, 3.0, 0.0)
        self.s.set_mode("height")
        self.aim(self.p1, 0.0, foot)
        self.s.set_picture(self.p2)
        self.s.click(*tilted(foot))
        self.s.keep_point()
        line = next(m for m in self.s.viewer_marks() if m.get("vertical"))["points"]
        self.assertAlmostEqual(line[0][0], tilted(foot)[0], places=6)  # depuis la croix du pied
        self.assertAlmostEqual(line[0][1], tilted(foot)[1], places=6)
        for z in (1.0, 2.5, 4.0):  # points du vrai objet vertical : sur la ligne tracée
            yaw, pitch = tilted((5.0, 3.0, z))
            k = min(range(len(line) - 1), key=lambda i: abs(line[i][1] - pitch))
            (y0, p0, _), (y1, p1, _) = line[k], line[k + 1]
            t = (pitch - p0) / (p1 - p0)
            self.assertAlmostEqual(y0 + t * (y1 - y0), yaw, delta=math.radians(0.05))
        self.assertGreater(abs(line[-1][0] - line[0][0]), math.radians(0.5))  # penchée dans l'image

    def assert_foot_on_ray(self, height, ref):
        """Pied de la hauteur sur la visée du pied de sa photo, à la profondeur du point ref."""
        triangulation = module("core.triangulation")
        c = height.clicks[0]
        foot = height.overrides[0][:2]
        self.assertEqual((height.reference["lon"], height.reference["lat"]), foot)
        a = math.radians(c["yaw"])
        fx, fy = triangulation._local(*foot, c["lon"], c["lat"])
        rx, ry = triangulation._local(ref["lon"], ref["lat"], c["lon"], c["lat"])
        self.assertLess(abs(fx * math.cos(a) - fy * math.sin(a)), 1e-6)  # sur la visée
        self.assertAlmostEqual(fx * math.sin(a) + fy * math.cos(a), rx * math.sin(a) + ry * math.cos(a), places=6)

    def test_three_sightings_foot_where_aimed(self):
        # Trois visées : le point triangulé est un compromis ; le pied de la hauteur reste là où il
        # a été visé sur la photo de la mesure (cas de la rambarde de Commarin)
        p3 = photo("p3", 12.0)
        foot = (5.0, 3.0, 0.0)
        self.s.set_mode("height")
        self.aim(self.p1, 0.0, foot)
        self.aim(self.p2, 6.0, foot)
        self.s.set_picture(p3)
        yaw, pitch = direction(12.0, foot)
        text = self.s.click(yaw + math.radians(2.0), pitch)  # troisième visée un peu à côté
        self.assertIn("écart des visées", text)
        self.s.set_picture(self.p1)
        self.s.keep_point()
        self.s.click(*direction(0.0, (5.0, 3.0, 2.0)))
        height = self.s._heights()[0]
        self.assert_foot_on_ray(height, self.s.ref_point)
        mark = next(m for m in self.s.viewer_marks() if m["label"].startswith("↕"))
        self.assertAlmostEqual(mark["points"][0][0], direction(0.0, foot)[0], places=6)  # croix du pied : la visée

    def test_sighting_on_another_object(self):
        # Troisième visée sur un autre objet (poteau voisin à 2,5 m), photos RTK (±0,1 m) :
        # avertissement ; avec une précision GPS inconnue (3 m supposés), l'écart reste normal
        def rtk(item):
            item["properties"]["quality:horizontal_accuracy"] = 0.1
            return item
        p1, p2, p3 = rtk(photo("p1", 0.0)), rtk(photo("p2", 6.0)), rtk(photo("p3", 12.0))
        self.s.set_mode("height")
        self.aim(p1, 0.0, (5.0, 3.0, 0.0))
        self.aim(p2, 6.0, (5.0, 3.0, 0.0))
        self.s.set_picture(p3)
        text = self.s.click(*direction(12.0, (5.0, 5.5, 0.0)))
        self.assertIn("vise peut-être un autre objet", text)
        self.s.clear_all()
        self.aim(self.p1, 0.0, (5.0, 3.0, 0.0))
        self.aim(self.p2, 6.0, (5.0, 3.0, 0.0))
        self.s.set_picture(photo("p3", 12.0))
        self.assertNotIn("autre objet", self.s.click(*direction(12.0, (5.0, 5.5, 0.0))))

    def tilt(self, pic, toward):
        """Inclinaison automatique de pic arrivée (3° vers toward)."""
        calibration = module("core.calibration")
        self.s.calibration.set_auto(pic, {"sequence": "s1", "heading": 0.0, "lidar": None,
                                          "verticals": {"up": list(calibration.vector(toward, 87.0)),
                                                        "count": 6, "sigma": 0.2}})
        self.s._on_tilt(pic, None)

    def reference_and_height(self):
        self.s.set_mode("height")
        self.aim(self.p1, 0.0, (5.0, 3.0, 0.0))
        self.aim(self.p2, 6.0, (5.0, 3.0, 0.0))
        self.s.keep_point()

    def test_reference_follows_auto_tilt(self):
        # Inclinaison automatique de p2 arrivée après la validation de A, puis après une hauteur
        # appuyée sur A : A retriangulé à chaque fois, la hauteur recalée sur lui
        self.reference_and_height()
        ref = self.s.ref_point
        start = (ref["lon"], ref["lat"])
        self.tilt("p2", 90.0)
        moved = (ref["lon"], ref["lat"])
        self.assertGreater(distance(start, moved), 0.01)
        self.assertEqual(self.s.points[0][:2], moved)  # point gardé (export) aussi
        self.s.click(*direction(6.0, (5.0, 3.0, 4.0)))  # hauteur appuyée sur A
        height = self.s._heights()[0]
        self.tilt("p2", 270.0)
        self.assertGreater(distance(moved, (ref["lon"], ref["lat"])), 0.01)
        self.assert_foot_on_ray(height, ref)  # pied recalé sur le nouveau A
        clicks = [c for c in height.clicks if c["pic"] == "p2"]
        self.assertTrue(clicks)
        for c in clicks:  # clics recorrigés de l'inclinaison
            self.assertNotAlmostEqual(c["elev"], c["raw"][1], places=3)

    def test_reference_moved_by_hand_stays(self):
        self.reference_and_height()
        ref = self.s.ref_point
        ref["moved"] = True  # recalé à la main (largeur : le long de la droite de mesure)
        start = (ref["lon"], ref["lat"])
        self.tilt("p2", 90.0)
        self.assertEqual((ref["lon"], ref["lat"]), start)

    def test_manual_calibration_after_measure(self):
        # Inclinaison calée à la main après la hauteur : clics et A recalculés, comme pour
        # l'inclinaison automatique (comme App.merge_calibration pour un calage importé)
        self.reference_and_height()
        self.s.click(*direction(6.0, (5.0, 3.0, 4.0)))
        height, ref = self.s._heights()[0], self.s.ref_point
        start, value = (ref["lon"], ref["lat"]), height.result["value"]
        calibration = module("core.calibration")
        up = calibration.vector(45.0, 86.0)
        for yaw in (30.0, 120.0):  # deux objets verticaux vus par la caméra penchée
            bottom = calibration.untilt(up, yaw, -10.0, inverse=True)
            top = calibration.untilt(up, yaw, 15.0, inverse=True)
            self.s.calibration.add_vertical("p2", bottom, top)
        self.s._calibration_changed()
        self.assertGreater(distance(start, (ref["lon"], ref["lat"])), 0.01)
        self.assertNotAlmostEqual(height.result["value"], value, places=3)

    def test_precision_after_sightings(self):
        # Vérification RTK arrivée après les visées : elles prennent l'altitude des caméras et
        # le sol LiDAR, le point passe en 3D
        from unittest import mock
        tools = module("core.tools")
        self.s.set_mode("height")
        foot = (3.0, 20.0, 0.0)  # loin devant : visées presque alignées (3,6°), calcul 3D utile
        self.aim(self.p1, 0.0, foot)
        self.aim(self.p2, 6.0, foot)
        self.assertEqual(self.s.triangulator.result["method"], "plan")
        res = {"precise": True, "accuracy": 0.1, "lidar": True, "height": CAMERA, "reason": "", "count": 9,
               "spread": 0.02, "transient": False}
        self.s.precision._results["s1"] = res
        with mock.patch.object(tools.host, "ngf_altitude", lambda lon, lat, h: 300.0 + CAMERA):
            self.s._on_precision("p2", res, None)
        r = self.s.triangulator.result
        self.assertEqual(r["method"], "3d")
        self.assertAlmostEqual(r["z"], 300.0, places=2)
        self.assertLess(distance((r["lon"], r["lat"]), point(3.0, 20.0)), 0.01)
        self.assertEqual(self.s.triangulator.sightings[0]["accuracy"], 0.1)

    def test_lidar_ground_arrives_late(self):
        # Photos RTK : la réponse du LiDAR au point arrive après la validation de A et après la
        # hauteur ; A est recalculé avec elle et la hauteur recalée sur lui
        from unittest import mock
        tools = module("core.tools")
        pending = []
        res = {"precise": True, "accuracy": 0.1, "lidar": True, "height": CAMERA, "reason": "", "count": 9,
               "spread": 0.02, "transient": False}
        self.s.precision._results["s1"] = res
        foot = (3.0, 20.0, 0.0)  # loin devant : visées presque alignées, calcul 3D
        with mock.patch.object(tools.host, "ngf_altitude", lambda lon, lat, h: 300.0 + CAMERA), \
                mock.patch.object(session.host, "fetch_json", lambda url, cb, **kw: pending.append(cb)):
            self.s.set_mode("height")
            self.aim(self.p1, 0.0, foot)
            self.aim(self.p2, 6.0, foot)
            self.assertEqual(self.s.triangulator.result["ground_source"], "photos")
            self.s.keep_point()
            ref = self.s.ref_point
            self.s.click(*direction(6.0, (3.0, 20.0, 4.0)))
            height = self.s._heights()[0]
            before = (ref["lon"], ref["lat"])
            self.assertTrue(pending)
            for cb in pending:  # le sol LiDAR au point : 20 cm plus haut que celui des photos
                cb({"elevations": [{"z": 300.2}]}, None)
        self.assertIsNotNone(ref["ground_z"])
        self.assertAlmostEqual(ref["ground_z"][2], 300.2)
        self.assertGreater(distance(before, (ref["lon"], ref["lat"])), 0.05)
        self.assert_foot_on_ray(height, ref)

    def ground_by_resource(self, lidar, rge, order):
        """Visées d'un pied loin devant (3D) sur photos RTK ; sol au point : lidar, rge (altitudes,
        None hors couverture) ; réponses du réseau dans l'ordre order (« fifo », « lifo »)."""
        from unittest import mock
        from urllib.parse import parse_qs, urlsplit
        tools, precision = module("core.tools"), module("core.precision")
        pending = []

        def fetch(url, cb, **kw):
            q = parse_qs(urlsplit(url).query)
            z = lidar if q.get("resource", [""])[0] == precision.LIDAR_RESOURCE else rge
            pending.append(lambda: cb({"elevations": [z if z is not None else -99999] * len(q["lat"][0].split("|"))}
                                      if "lat" in q else {"features": []}, None))
        res = {"precise": True, "accuracy": 0.1, "lidar": True, "height": CAMERA, "reason": "", "count": 9,
               "spread": 0.02, "transient": False}
        self.s.precision._results["s1"] = res
        foot = (3.0, 20.0, 0.0)
        with mock.patch.object(tools.host, "ngf_altitude", lambda lon, lat, h: 300.0 + CAMERA), \
                mock.patch.object(session.host, "fetch_json", fetch):
            self.s.set_mode("road")
            self.aim(self.p1, 0.0, foot)
            self.aim(self.p2, 6.0, foot)
            self.s.keep_point()
            for _ in range(50):
                if not pending:
                    break
                pending.pop(0 if order == "fifo" else -1)()
        return self.s.ref_point

    def test_ground_converges(self):
        # Sol LiDAR 30 cm sous celui des photos : le point recule de plus de GROUND_REUSE m, l'altitude
        # relue à sa nouvelle position le garde là, quel que soit l'ordre des réponses
        tools = module("core.tools")
        far = []
        for order in ("fifo", "lifo"):
            self.setUp()
            ref = self.ground_by_resource(299.7, None, order)
            far.append((ref["lon"], ref["lat"]))
            self.assertGreater(distance(far[-1], point(3.0, 20.0)), tools.GROUND_REUSE, order)
            self.assertLess(distance((ref["ground_z"][0], ref["ground_z"][1]), far[-1]), tools.GROUND_REUSE, order)
        self.assertLess(distance(*far), 0.05)

    def test_rge_alti_without_lidar(self):
        # LiDAR HD pas publié au point : RGE ALTI, moins sûr, dit dans le texte du point
        tri = module("core.triangulation")
        ref = self.ground_by_resource(None, 299.7, "fifo")
        self.assertEqual(ref["ground_z"][3:], (tri.RGE_ALTI_ERROR, "RGE ALTI"))
        self.assertGreater(distance((ref["lon"], ref["lat"]), point(3.0, 20.0)), 0.5)
        r = module("core.tools").solve_on_ground(ref["sightings"], True, ref["ground_z"])
        self.assertEqual(r["ground_name"], "RGE ALTI")

    def test_bridge_ignores_rge_alti(self):
        self.s.set_bridge(True)
        ref = self.ground_by_resource(None, 294.0, "fifo")
        self.assertIsNone(ref.get("ground_z"))
        self.assertLess(distance((ref["lon"], ref["lat"]), point(3.0, 20.0)), 0.01)

    def test_bridge_ignores_lidar(self):
        # Sur un pont, le MNT LiDAR donne la voie franchie, 6 m sous le tablier : A reste sur le
        # sol tiré des photos, sans relire le LiDAR ; l'altitude lue est gardée pour quand on décoche
        from unittest import mock
        tools = module("core.tools")
        pending = []
        res = {"precise": True, "accuracy": 0.1, "lidar": True, "height": CAMERA, "reason": "", "count": 9,
               "spread": 0.02, "transient": False}
        self.s.precision._results["s1"] = res
        foot = (3.0, 20.0, 0.0)
        with mock.patch.object(tools.host, "ngf_altitude", lambda lon, lat, h: 300.0 + CAMERA), \
                mock.patch.object(session.host, "fetch_json", lambda url, cb, **kw: pending.append(cb)):
            self.s.set_mode("road")
            self.aim(self.p1, 0.0, foot)
            self.aim(self.p2, 6.0, foot)
            self.s.keep_point()
            ref = self.s.ref_point
            for cb in pending:
                cb({"elevations": [{"z": 294.0}]}, None)
            self.assertAlmostEqual(ref["ground_z"][2], 294.0)
            far = (ref["lon"], ref["lat"])
            self.assertGreater(distance(far, point(3.0, 20.0)), 5.0)  # A rejeté loin derrière
            pending.clear()
            self.s.set_bridge(True)
            self.assertLess(distance((ref["lon"], ref["lat"]), point(3.0, 20.0)), 0.01)
            self.assertFalse(pending)  # pas de nouvelle lecture du LiDAR
            self.assertAlmostEqual(ref["ground_z"][2], 294.0)  # gardée
            self.s.set_bridge(False)
            self.assertTrue(self.s.triangulator.lidar and self.s.calibration.lidar)
            self.assertEqual(self.s._lidar_z(ref), ref["ground_z"])

    def test_bridge_ignores_lidar_tilt(self):
        cal = self.s.calibration
        cal._models["s1"] = {"offset": (0.0, 0.0), "sigma": 0.3, "count": 9}
        cal.auto["p1"] = {"sequence": "s1", "heading": 0.0, "verticals": None, "lidar": [2.0, 0.0]}
        self.assertEqual(cal.tilt("p1")["source"], "lidar")
        self.s.set_bridge(True)
        self.assertIsNone(cal.tilt("p1"))
        self.s.set_bridge(False)
        self.assertEqual(cal.tilt("p1")["source"], "lidar")

    def test_reference_recaled_on_its_vertical(self):
        # Pied A recalé depuis la visionneuse avant la hauteur : il ne quitte pas sa verticale
        foot = (5.0, 3.0, 0.0)
        self.s.set_mode("height")
        self.aim(self.p1, 0.0, foot)
        self.aim(self.p2, 6.0, foot)
        self.s.keep_point()
        self.s.click(*direction(6.0, foot))  # clic sur la croix de A : sélectionné
        self.assertTrue(self.s.state()["point_sel"])
        self.assertTrue(any(p[2] for m in self.s.viewer_marks() for p in m["points"]))
        # Clic un peu à côté, 10 cm plus haut : seule l'élévation compte, le cap reste celui de A
        yaw, pitch = direction(6.0, (5.0, 3.0, 0.10))
        text = self.s.click(yaw + 0.01, pitch)
        self.assertIn("recalé de 10 cm sur sa verticale", text)
        self.s.click(*direction(6.0, (5.0, 3.0, 0.10)))
        self.assertTrue(self.s.state()["point_sel"])
        self.s.nudge_point("left")  # sans effet
        self.s.nudge_point("down")
        self.s.finish_point()
        self.assertFalse(self.s.state()["point_sel"])
        text = self.s.click(*direction(6.0, (5.0, 3.0, 4.0)))
        self.assertTrue(text.startswith("Hauteur : 3,91 m"), text)


class RtkAlert(Base):
    def test_once_per_sequence(self):
        self.s.set_picture(self.p1)
        self.s.quality = None
        self.assertIsNone(self.s.take_rtk_alert())  # vérification en cours
        self.s.quality = {"precise": False, "lidar": None, "transient": True}
        self.assertIsNone(self.s.take_rtk_alert())  # service en panne : pas de conclusion
        self.s.quality = {"precise": False, "lidar": True}  # conclusion : pas de RTK
        self.assertIn("Un GPS avec corrections RTK est requis", self.s.take_rtk_alert())
        self.assertIsNone(self.s.take_rtk_alert())  # déjà signalée
        self.s.set_picture(self.p2)  # même séquence
        self.s.quality = {"precise": False, "lidar": True}
        self.assertIsNone(self.s.take_rtk_alert())
        other = dict(self.p2, collection="s2")
        self.s.set_picture(other)
        self.s.quality = {"precise": True, "lidar": True}
        self.assertIsNone(self.s.take_rtk_alert())  # RTK vérifié
        self.s.quality = {"precise": False, "lidar": True}
        self.s.set_active(False)
        self.assertIsNone(self.s.take_rtk_alert())  # hors mesure : rien
        self.s.set_active(True)
        self.assertIsNotNone(self.s.take_rtk_alert())


class BridgeAlert(Base):
    def setUp(self):
        super().setUp()
        roads = module("core.roads")
        bridge = {"type": "Feature", "properties": {"cpx_numero": "D111", "position_par_rapport_au_sol": "1"},
                  "geometry": {"type": "LineString", "coordinates": [list(point(0.0, -20.0)), list(point(0.0, 30.0))]}}
        for p in (self.p1, self.p2):
            cell = roads._cell(*p["geometry"]["coordinates"])
            self.s.roads._sections[cell] = roads.parse_sections({"features": [bridge]})
        self.far = photo("p3", 100.0)  # 70 m après le pont
        self.near = photo("p4", 45.0)  # 15 m après : photo d'approche, qui vise encore le tablier
        for p in (self.far, self.near):
            cell = roads._cell(*p["geometry"]["coordinates"])
            self.s.roads._sections.setdefault(cell, roads.parse_sections({"features": [bridge]}))

    def test_once_per_bridge(self):
        self.s.set_picture(self.p1)
        alert = self.s.take_bridge_alert()
        self.assertTrue(alert["check"])
        self.assertIn("pont (D111)", alert["text"])
        self.assertIsNone(self.s.take_bridge_alert())  # déjà proposé
        self.s.set_picture(self.p2)  # même pont, 6 m plus loin
        self.assertIsNone(self.s.take_bridge_alert())

    def test_not_when_checked_or_inactive(self):
        self.s.set_picture(self.p1)
        self.s.set_active(False)
        self.assertIsNone(self.s.take_bridge_alert())  # hors mesure
        self.s.set_active(True)
        self.s.set_bridge(True)
        self.assertIsNone(self.s.take_bridge_alert())  # déjà coché
        self.s.set_bridge(False)
        self.assertIsNotNone(self.s.take_bridge_alert())

    def test_leaving_bridge(self):
        self.s.set_picture(self.p1)
        self.s.take_bridge_alert()
        self.s.set_bridge(True)  # « Oui »
        self.assertIsNone(self.s.take_bridge_alert())  # encore sur le pont
        self.s.set_picture(self.near)
        self.assertIsNone(self.s.take_bridge_alert())  # trop près du pont
        self.s.set_picture(self.far)
        alert = self.s.take_bridge_alert()
        self.assertFalse(alert["check"])
        self.assertIn("n'est plus sur un pont", alert["text"])
        self.assertIsNone(self.s.take_bridge_alert())  # une fois par sortie
        self.s.leave_bridge()  # « Oui »
        self.assertFalse(self.s.bridge)
        self.s.set_picture(self.p1)  # retour sur le même pont : proposé de nouveau
        self.assertTrue(self.s.take_bridge_alert()["check"])

    def test_leaving_refused(self):
        self.s.set_bridge(True)
        self.s.set_picture(self.far)
        self.assertFalse(self.s.take_bridge_alert()["check"])  # « Non » : la case reste cochée
        self.s.set_picture(self.p1)
        self.s.set_picture(self.far)
        self.assertIsNone(self.s.take_bridge_alert())  # pas de nouvelle proposition
        self.s.set_bridge(False)
        self.s.set_bridge(True)  # cochée de nouveau : une nouvelle sortie sera proposée
        self.assertFalse(self.s.take_bridge_alert()["check"])

    def test_not_on_ground(self):
        for cell in self.s.roads._sections:
            self.s.roads._sections[cell] = []  # aucun tronçon en pont
        self.s.set_picture(self.p1)
        self.assertIsNone(self.s.take_bridge_alert())


class Width(Base):
    def test_locked_until_new_measure(self):
        # Bord A à 5 m à l'est, route nord-sud : droite de mesure est-ouest à 3 m au nord
        a = (5.0, 3.0, 0.0)
        self.s.set_mode("road")
        self.aim(self.p1, 0.0, a)
        self.aim(self.p2, 6.0, a)
        self.s.keep_point()
        self.assertIsNone(self.s.state()["new_measure"])
        text = self.s.click(*direction(6.0, (-3.0, 3.0, 0.0)))
        self.assertIn("Nouvelle mesure depuis A", text)
        self.assertEqual(self.s.state()["new_measure"], "A")
        # Vue vers le sud depuis (0, 6) : A (est) à gauche de B (ouest), son nom à sa gauche
        # A seul à part ; le bord cliqué, nom provisoire, dans l'étiquette de la largeur
        self.assertEqual([(m["label"], m["side"]) for m in self.s.viewer_marks() if m["name"]], [("A", "left")])
        self.assertEqual([m["end"] for m in self.s.viewer_marks() if m["end"]], [{"name": "B", "provisional": True}])
        # Autre clic hors des croix : pas d'autre largeur, consigne d'ajustement
        text = self.s.click(*direction(6.0, (-6.0, 3.0, 0.0)))
        self.assertTrue(text.startswith("Largeur mesurée depuis le point A"), text)
        self.assertEqual(len(self.s._widths()), 1)
        # Les points restent ajustables : croix du bord, flèche, Entrée
        self.s.click(*direction(6.0, (-3.0, 3.0, 0.0)))
        self.assertTrue(self.s.state()["point_sel"])
        self.s.nudge_point("up")
        self.s.finish_point()
        self.assertEqual(len(self.s._widths()), 1)
        # « Nouvelle mesure depuis A » : le clic suivant donne une seconde largeur
        self.s.new_measure()
        self.assertIsNone(self.s.state()["new_measure"])
        self.s.click(*direction(6.0, (-6.0, 3.0, 0.0)))
        self.assertEqual(len(self.s._widths()), 2)
        self.assertEqual(self.s.state()["new_measure"], "A")
        # Nouveau point de référence : plus de verrou
        self.s.new_reference()
        self.assertIsNone(self.s.state()["new_measure"])


    def test_reference_recaled_on_the_line(self):
        # A visé à (5, 3), route nord-sud : droite de mesure y = 3. Recalé depuis la visionneuse,
        # A glisse sur la droite (jamais retriangulé ailleurs), avant comme après la largeur
        a = (5.0, 3.0, 0.0)
        self.s.set_mode("road")
        self.aim(self.p1, 0.0, a)
        self.aim(self.p2, 6.0, a)
        self.s.keep_point()
        ref = self.s.ref_point
        self.s.set_picture(self.p1)  # photo à (0, 0) : voit la droite assez en biais
        self.s.click(*direction(0.0, a))  # clic sur la croix de A : sélectionné
        self.assertTrue(self.s.state()["point_sel"])
        self.assertTrue(any(p[2] for m in self.s.viewer_marks() for p in m["points"]))
        # Clic visant (10, 5), hors de la droite : A va où la visée la coupe, en (6, 3)
        text = self.s.click(*direction(0.0, (10.0, 5.0, 0.0)))
        self.assertIn("le long de la droite de mesure", text)
        self.assertFalse(self.s.state()["point_sel"])
        self.assertLess(distance((ref["lon"], ref["lat"]), point(6.0, 3.0)), 0.01)
        self.assertEqual(self.s.points[0][:2], (ref["lon"], ref["lat"]))  # le point gardé suit
        # Largeur depuis A recalé, puis A recalé : la largeur suit, le bord reste
        self.s.click(*direction(0.0, (-3.0, 3.0, 0.0)))
        self.assertAlmostEqual(self.s._widths()[0].result["value"], 9.0, places=2)
        self.s.select_point(*direction(0.0, (6.0, 3.0, 0.0)))
        self.assertEqual(self.s.width_sel[1], 0)
        self.s.click(*direction(0.0, (5.0, 3.0, 0.0)))
        self.assertAlmostEqual(self.s._widths()[0].result["value"], 8.0, places=2)
        # Au clavier : 1 cm le long de la droite
        self.s.select_point(*direction(0.0, (5.0, 3.0, 0.0)))
        self.s.nudge_point("up")
        self.s.finish_point()
        self.assertAlmostEqual(abs(self.s._widths()[0].result["value"] - 8.0), 0.01, places=4)
        self.assertLess(distance((ref["lon"], ref["lat"]), point(5.0, 3.0)), 0.02)


class FreeMeasure(Base):
    def test_distance_between_points(self):
        a, b = (5.0, 3.0, 0.0), (5.0, 7.0, 0.0)
        self.s.set_mode("tri")
        for target in (a, b):
            self.aim(self.p1, 0.0, target)
            self.aim(self.p2, 6.0, target)
            text = self.s.keep_point()
        self.assertIn("Distance A–B : 4,00 m", text)
        self.assertEqual(sorted(m["label"] for m in self.s.viewer_marks() if m["name"]), ["A", "B"])
        self.assertEqual([r["kind"] for r in self.s.results()], ["point", "point", "distance"])
        # Carte cadrée sur le segment qui vient d'être mesuré
        self.assertEqual(self.s.focus()[-1], "segment")

    def test_one_sighting_per_photo(self):
        self.s.set_mode("tri")
        self.aim(self.p1, 0.0, (5.0, 3.0, 0.0))
        text = self.aim(self.p1, 0.0, (5.0, 3.0, 2.0))
        self.assertIn("Visée de cette photo remplacée", text)
        self.assertEqual(len(self.s.triangulator.sightings), 1)


if __name__ == "__main__":
    unittest.main()
