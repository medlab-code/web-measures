# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Calculs lourds de la page, dans un second Pyodide en arrière-plan (Web Worker, voir
src/calcul.js) : la page reste fluide pendant l'analyse d'une photo HD.

- call : fonction d'un module du cœur (inclinaison automatique : autotilt.estimate),
  demandée par web_host.run_task ;
- capture : capture HD de la vue (core/capture.py), en JPEG.

Les photos sont décodées par Pillow : réduites dès le décodage (mise à l'échelle du JPEG),
comme QImageReader dans le plugin.
"""

import base64
import importlib
import io
import json

from core import host

try:
    from pyodide.ffi import JsProxy
except ImportError:  # hors du navigateur (essais)
    JsProxy = ()

CAPTURE_WIDTH = 6144  # largeur de travail de la photo source d'une capture (HD imajbox : 12 288)


def _open(data, width, gray=False):
    """Image Pillow réduite à environ `width` de large dès le décodage ; gray : décodée
    directement en niveaux de gris (JPEG : luminance seule, plus rapide)."""
    from PIL import Image

    img = Image.open(io.BytesIO(_python(data)))
    w, h = img.size
    mode = "L" if gray else (img.mode if img.mode in ("L", "RGB") else "RGB")
    if w > width or gray:
        img.draft(mode, (min(width, w), round(min(width, w) * h / w)))
    return img


def decode_band(data, width, elev_min, elev_max):
    """Voir core/host.py : photo équirectangulaire en niveaux de gris, réduite et rognée."""
    import numpy as np
    from PIL import Image

    try:
        img = _open(data, width, gray=True)
    except Exception:
        return None
    full_w, full_h = img.size
    if full_w < 2 * full_h - 2:
        return None  # pas une photo équirectangulaire
    w = min(width, full_w)
    h = round(w * full_h / full_w)
    img = img.convert("L")
    if img.size != (w, h):
        img = img.resize((w, h), Image.Resampling.BILINEAR)
    row0, row1 = int((90 - elev_max) / 180 * h), int((90 - elev_min) / 180 * h)
    band = np.asarray(img.crop((0, row0, w, row1)), dtype=np.float32)
    return band, row0, h, w


def _python(value):
    """Valeur venue du navigateur en Python : octets (Uint8Array) en bytes, tableaux en listes."""
    if isinstance(value, JsProxy):
        value = value.to_py()
    return bytes(value) if isinstance(value, (memoryview, bytearray)) else value


def _plain(value):
    """Résultat converti en types JSON (numpy compris)."""
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if hasattr(value, "tolist"):
        return value.tolist()
    return value


def call(module, name, args):
    """module.name(*args) ; résultat en texte JSON."""
    function = getattr(importlib.import_module(module), name)
    args = [_python(a) for a in _python(args)]
    return json.dumps(_plain(function(*args)))


def capture(data, azimuth, is360, heading, pitch, vfov, photo_hfov, up):
    """Capture HD de la vue (voir core/capture.py) : JPEG en base64, ou "" si la photo est
    illisible. Les cartouches (attribution, localisation) sont ajoutés par la page, avec les
    polices du navigateur (accents compris)."""
    import numpy as np
    from PIL import Image

    from core import capture as calc

    try:
        img = _open(data, CAPTURE_WIDTH).convert("RGB")
    except Exception:
        return ""
    is360 = bool(is360) or img.size[0] >= 1.9 * img.size[1]
    up = list(_python(up)) if up else None
    out = calc.render_view(np.asarray(img), azimuth, is360, heading, pitch, vfov,
                           None if is360 else photo_hfov, up=up)
    view = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")
    buf = io.BytesIO()
    view.save(buf, "JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode("ascii")


host.install(decode_band=decode_band)
