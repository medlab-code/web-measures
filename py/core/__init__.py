# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Cœur de calcul de web-measures, exécuté dans le navigateur par Pyodide (repris du plugin
QGIS « Visionneuse Panoramax », qui n'en a plus depuis le 29/10/2026).

Triangulation, points 3D, terrain, précision GPS, calages, inclinaison automatique, axe de
la route et mesures : du Python pur (numpy en option, pour l'inclinaison automatique). Ce qui
dépend de la page (réseau, altitude NGF, décodage d'une photo, tâches de fond) passe par
host.py, que py/web_host.py remplit au démarrage. Essais sans réseau : tests/coeur/.
"""
