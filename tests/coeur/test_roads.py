# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Tests de roads.py : tronçons de la BD TOPO (lecture, pont sous la photo).

Les tronçons sont placés en mètres (est, nord) autour de support.LON0/LAT0 ;
les services sont simulés."""

import unittest
from unittest import mock

from support import module, point

roads = module("core.roads")


def section(*pts, name="D16", level=None):
    props = {"cpx_numero": name} if level is None else {"cpx_numero": name, "position_par_rapport_au_sol": level}
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "LineString", "coordinates": [list(point(*p)) for p in pts]}}


class Parse(unittest.TestCase):
    def test_parse(self):
        data = {"features": [
            {"properties": {"nom_collaboratif_gauche": "R RENE LAFORGE"},
             "geometry": {"type": "MultiLineString", "coordinates": [[[5, 47], [5.001, 47]], [[5, 47.001]]]}},
            {"properties": {}, "geometry": {"type": "Point", "coordinates": [5, 47]}},
            {"properties": {}, "geometry": None}]}
        sections = roads.parse_sections(data)
        self.assertEqual([s["name"] for s in sections], ["R RENE LAFORGE"])  # ligne d'un seul point ignorée
        self.assertEqual(roads.parse_sections(None), [])


class Bridge(unittest.TestCase):
    # Pont nord-sud de 40 m (D111) au-dessus d'une autoroute est-ouest, accès au niveau du sol
    FEATURES = [section((0, -100), (0, -20), name="D111", level="0"),
                section((0, -20), (0, 20), name="D111", level="1"),
                section((-100, 0), (100, 0), name="A6", level="0")]

    def bridge(self, at, axis):
        return roads.on_bridge(roads.parse_sections({"features": self.FEATURES}), *point(*at), axis)

    def test_on_deck(self):
        self.assertEqual(self.bridge((1.5, 5.0), 0.0)["name"], "D111")
        self.assertEqual(self.bridge((1.5, 5.0), 180.0)["name"], "D111")  # dans l'autre sens
        self.assertIsNotNone(self.bridge((1.5, 5.0), None))  # sens inconnu
        self.assertIsNotNone(self.bridge((0.0, -25.0), 0.0))  # en arrivant sur le pont

    def test_not_on_deck(self):
        self.assertIsNone(self.bridge((0.0, -60.0), 0.0))  # sur l'accès, au sol
        self.assertIsNone(self.bridge((3.0, -1.5), 90.0))  # dessous, sur l'autoroute
        self.assertIsNone(self.bridge((12.0, 5.0), 0.0))  # chemin parallèle, à côté


class FakeServices:
    def __init__(self, sections=(), down=False):
        self.sections, self.down = list(sections), down
        self.pending, self.calls = [], 0

    def __call__(self, url, callback, **kwargs):
        self.calls += 1
        if self.down:
            self.pending.append(lambda: callback(None, "délai dépassé"))
        else:
            self.pending.append(lambda: callback({"features": self.sections}, None))

    def answer(self):
        while self.pending:
            self.pending.pop(0)()


class Provider(unittest.TestCase):
    def setUp(self):
        self.provider = roads.RoadAxisProvider()
        self.ready = []
        self.provider.ready = lambda: self.ready.append(1)

    def bridge(self, services, at=(0.0, 5.0)):
        with mock.patch.object(roads.host, "fetch_json", services):
            return self.provider.bridge(*point(*at), None)

    def test_read_once_then_cache(self):
        services = FakeServices(sections=Bridge.FEATURES)
        self.assertEqual(self.bridge(services), roads.PENDING)
        self.assertEqual(self.bridge(services), roads.PENDING)  # une seule lecture en cours
        services.answer()
        self.assertEqual(self.ready, [1])
        self.assertEqual(self.bridge(services)["name"], "D111")
        self.assertEqual(self.bridge(services, at=(3.0, 8.0))["name"], "D111")  # même maille
        self.assertFalse(self.bridge(services, at=(12.0, 5.0)))  # chemin à côté : pas de pont
        self.assertEqual(services.calls, 1)

    def test_failure_retried_later(self):
        services = FakeServices(down=True)
        self.bridge(services)
        services.answer()
        self.assertIsNone(self.bridge(services))  # panne : inconnu
        self.assertEqual(services.calls, 1)  # pas de nouvel essai tout de suite
        with mock.patch.object(roads.time, "monotonic", lambda: 1e12):
            self.assertEqual(self.bridge(FakeServices()), roads.PENDING)  # plus tard : nouvel essai


if __name__ == "__main__":
    unittest.main()
