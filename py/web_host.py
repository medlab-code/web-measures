# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Services du navigateur pour le cœur de calcul (voir core/host.py), dans Pyodide.

- Réseau : fetch du navigateur (pyodide.http.pyfetch), en tâche asyncio ; le rappel est
  appelé à l'arrivée de la réponse, comme avec QgsNetworkAccessManager dans le plugin.
- Altitude NGF : grille RAF20 de l'IGN (voir geoid.py), chargée par load_geoid.
- Calculs lourds (inclinaison automatique, capture HD) : dans un second Pyodide, en
  arrière-plan (Web Worker, voir src/calcul.js), qui décode aussi les photos (Pillow).
"""

import asyncio
import json
import traceback

from pyodide.ffi import to_js
from pyodide.http import pyfetch

import geoid
from core import host

API_URL = "https://api.panoramax.xyz/api"
# Service d'altimétrie de l'IGN : il refuse les rafales (HTTP 429). Ses requêtes partent une à
# une, espacées, et un refus est retenté après une pause.
THROTTLED = "data.geopf.fr/altimetrie/"
SPACING = 0.25  # s entre deux requêtes au service
RETRIES = (1.0, 3.0)  # pauses (s) avant de retenter après un refus
_throttle = None  # verrou des requêtes au service (créé dans la boucle asyncio)

_local_run = host.run_task  # calcul sur place, sans arrière-plan (valeur par défaut du cœur)
_geoid = None  # grille RAF20, une fois chargée
_remote = None  # fonction JS (module, fonction, arguments) -> promesse du résultat (texte JSON)


class Reply:
    """Requête en cours : abort() l'abandonne sans appeler son rappel."""

    def __init__(self, task):
        self.task = task

    def abort(self):
        self.task.cancel()


async def _fetch(url, timeout_ms):
    request = pyfetch(url)
    return await (asyncio.wait_for(request, timeout_ms / 1000.0) if timeout_ms else request)


async def _fetch_throttled(url, timeout_ms):
    global _throttle
    if _throttle is None:
        _throttle = asyncio.Lock()
    for pause in RETRIES + (None,):
        async with _throttle:
            response = await _fetch(url, timeout_ms)
            await asyncio.sleep(SPACING)
        if response.status != 429 or pause is None:
            return response
        await asyncio.sleep(pause)


async def _get(url, callback, as_json, timeout_ms):
    try:
        response = await (_fetch_throttled if THROTTLED in url else _fetch)(url, timeout_ms)
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


def ngf_altitude(lon, lat, ellipsoidal):
    return geoid.ngf_altitude(_geoid, lon, lat, ellipsoidal)


async def _run(function, args, done):
    try:
        args = [to_js(a) if isinstance(a, (bytes, bytearray)) else a for a in args]
        text = await _remote(function.__module__, function.__name__, to_js(args))
        result = json.loads(text) if text else None
    except Exception:
        traceback.print_exc()
        result = None
    done(result)


def run_task(function, args, done):
    """function(*args) dans le Pyodide d'arrière-plan (fonction d'un module du cœur, arguments
    et résultat simples : nombres, textes, octets, listes, dicts), puis done(résultat ou None)."""
    if _remote is None:
        _local_run(function, args, done)
    else:
        asyncio.ensure_future(_run(function, args, done))


async def load_geoid():
    """Charge la grille du géoïde (altitude NGF) ; sans elle, pas d'altitude GPS de la caméra."""
    global _geoid
    try:
        response = await pyfetch(geoid.URL)
        if response.ok:
            _geoid = geoid.Grid(await response.bytes())
    except Exception:
        traceback.print_exc()
    return _geoid is not None


def install(remote=None, api_url=API_URL):
    """remote : exécution en arrière-plan (voir run_task), ou None (pas d'arrière-plan)."""
    global _remote
    _remote = remote
    host.install(fetch=fetch, fetch_json=fetch_json, ngf_altitude=ngf_altitude, run_task=run_task,
                 api_url=api_url)
