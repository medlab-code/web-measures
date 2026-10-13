# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Services du navigateur pour le cœur de calcul (voir core/host.py), dans Pyodide.

Réseau : fetch du navigateur (pyodide.http.pyfetch), en tâche asyncio ; le rappel est
appelé à l'arrivée de la réponse, comme avec QgsNetworkAccessManager dans le plugin.
Pas encore d'altitude NGF (grille du géoïde RAF20 : à venir) ni de décodage des photos
(inclinaison automatique : étape suivante) : les valeurs par défaut du cœur s'appliquent.
"""

import asyncio
import traceback

from pyodide.http import pyfetch

from core import host

API_URL = "https://api.panoramax.xyz/api"


class Reply:
    """Requête en cours : abort() l'abandonne sans appeler son rappel."""

    def __init__(self, task):
        self.task = task

    def abort(self):
        self.task.cancel()


async def _get(url, callback, as_json, timeout_ms):
    try:
        request = pyfetch(url)
        response = await (asyncio.wait_for(request, timeout_ms / 1000.0) if timeout_ms else request)
        if not response.ok:
            result = (None, "HTTP {}".format(response.status))
        elif as_json:
            result = (await response.json(), None)
        else:
            result = (await response.bytes(), None)
    except asyncio.CancelledError:
        return  # abandonnée (voir Reply.abort)
    except asyncio.TimeoutError:
        result = (None, "pas de réponse en {:.0f} s".format(timeout_ms / 1000.0))
    except Exception as exc:  # réseau, CORS, JSON illisible
        result = (None, str(exc) or exc.__class__.__name__)
    try:
        callback(*result)
    except Exception:
        traceback.print_exc()  # erreur du rappel : signalée dans la console, pas avalée


def fetch(url, callback, prefer_cache=False, timeout_ms=None):
    return Reply(asyncio.ensure_future(_get(url, callback, False, timeout_ms)))


def fetch_json(url, callback, prefer_cache=False, timeout_ms=None):
    return Reply(asyncio.ensure_future(_get(url, callback, True, timeout_ms)))


def install():
    host.install(fetch=fetch, fetch_json=fetch_json, api_url=API_URL)
