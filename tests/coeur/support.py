# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Chargement des modules du cœur de calcul (py/core) sans Pyodide, et outils des scènes de test."""

import importlib
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "py"))


class _StubMeta(type):
    def __getattr__(cls, name):
        return Stub()


class Stub(metaclass=_StubMeta):
    """Objet factice : tout attribut, appel ou sous-classe est accepté."""

    def __init__(self, *args, **kwargs):
        pass

    def __call__(self, *args, **kwargs):
        return Stub()

    def __getattr__(self, name):
        return Stub()


def module(name):
    return importlib.import_module(name)


triangulation = module("core.triangulation")

LON0, LAT0 = 5.0415, 47.3220  # Dijon


def point(east, north, lon0=LON0, lat0=LAT0):
    """(lon, lat) du point situé à (est, nord) mètres de (lon0, lat0)."""
    return triangulation._geographic(east, north, lon0, lat0)


def bearing(frm, to):
    """Cap (degrés) de frm vers to, deux (lon, lat)."""
    x, y = triangulation._local(to[0], to[1], frm[0], frm[1])
    return math.degrees(math.atan2(x, y)) % 360


def distance(a, b):
    return math.hypot(*triangulation._local(b[0], b[1], a[0], a[1]))
