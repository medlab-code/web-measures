# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Altitude NGF-IGN69 dans le navigateur : grille RAF20 de l'IGN (ondulation du géoïde),
comme PROJ dans le plugin (voir altitude.py du plugin).

La grille est celle que PROJ télécharge (cdn.proj.org, GeoTIFF de 340 Ko, licence
ouverte Etalab) : 421 × 381 nœuds, 1/30° × 0,025°, France métropolitaine. Lue ici sans
GDAL : tuiles compressées (deflate), prédicteur des flottants (TIFF, prédicteur 3).
"""

import struct
import zlib
from itertools import accumulate

URL = "https://cdn.proj.org/fr_ign_RAF20.tif"
GEOID_RANGE = (30.0, 70.0)  # écart plausible entre ellipsoïde et NGF-IGN69 en France (m), comme le plugin


class GeoidError(ValueError):
    pass


def _tags(data):
    bo = "<" if data[:2] == b"II" else ">"
    if data[2:4] != (b"*\x00" if bo == "<" else b"\x00*"):
        raise GeoidError("pas un fichier TIFF")
    off = struct.unpack(bo + "I", data[4:8])[0]
    n = struct.unpack(bo + "H", data[off:off + 2])[0]
    sizes, formats = {2: 1, 3: 2, 4: 4, 11: 4, 12: 8}, {3: "H", 4: "I", 11: "f", 12: "d"}
    tags = {}
    for i in range(n):
        entry = off + 2 + 12 * i
        tag, kind, count = struct.unpack(bo + "HHI", data[entry:entry + 8])
        size = sizes.get(kind, 1) * count
        if size <= 4:
            raw = data[entry + 8:entry + 8 + size]
        else:
            start = struct.unpack(bo + "I", data[entry + 8:entry + 12])[0]
            raw = data[start:start + size]
        fmt = formats.get(kind)
        tags[tag] = raw if fmt is None else struct.unpack(bo + fmt * count, raw)
    return bo, tags


class Grid:
    """Grille d'ondulation du géoïde (m), interpolée linéairement entre les nœuds."""

    def __init__(self, data):
        bo, t = _tags(data)
        self.cols, self.rows = t[256][0], t[257][0]
        if t[258][0] != 32 or t[339][0] != 3 or t[277][0] != 1:
            raise GeoidError("format de grille inattendu (flottants 32 bits, une bande)")
        compression, predictor = t[259][0], t.get(317, (1,))[0]
        if compression not in (1, 8) or predictor not in (1, 3):
            raise GeoidError("compression de grille non prise en charge")
        if t.get(34735) and dict(zip(t[34735][4::4], t[34735][7::4])).get(1025) != 2:
            raise GeoidError("grille attendue aux nœuds (PixelIsPoint)")
        self.dx, self.dy = t[33550][0], t[33550][1]
        self.lon0, self.lat0 = t[33922][3], t[33922][4]
        tw, th = t[322][0], t[323][0]
        across = (self.cols + tw - 1) // tw
        self.values = [[0.0] * self.cols for _ in range(self.rows)]
        for k, (start, size) in enumerate(zip(t[324], t[325])):
            raw = data[start:start + size]
            if compression == 8:
                raw = zlib.decompress(raw)
            ty, tx = divmod(k, across)
            for r in range(th):
                row = ty * th + r
                if row >= self.rows:
                    break
                line = raw[r * tw * 4:(r + 1) * tw * 4]
                if predictor == 3:  # octets différenciés, rangés par plan (poids fort d'abord)
                    line = bytes(v & 0xFF for v in accumulate(line))
                    line = bytes(b for i in range(tw) for b in (line[i], line[tw + i], line[2 * tw + i],
                                                                 line[3 * tw + i]))
                    values = struct.unpack(">" + "f" * tw, line)
                else:
                    values = struct.unpack(bo + "f" * tw, line)
                for c in range(tw):
                    col = tx * tw + c
                    if col < self.cols:
                        self.values[row][col] = values[c]

    def undulation(self, lon, lat):
        """Ondulation du géoïde (m) au point, ou None hors de la grille."""
        x, y = (lon - self.lon0) / self.dx, (self.lat0 - lat) / self.dy
        if not (0 <= x <= self.cols - 1 and 0 <= y <= self.rows - 1):
            return None
        i, j = min(int(x), self.cols - 2), min(int(y), self.rows - 2)
        fx, fy = x - i, y - j
        v = self.values
        return ((v[j][i] * (1 - fx) + v[j][i + 1] * fx) * (1 - fy)
                + (v[j + 1][i] * (1 - fx) + v[j + 1][i + 1] * fx) * fy)


def ngf_altitude(grid, lon, lat, ellipsoidal):
    """Altitude NGF-IGN69 (m) d'un point d'altitude ellipsoïdale, ou None (pas de grille, hors
    de France, valeur invraisemblable)."""
    if grid is None or ellipsoidal is None:
        return None
    n = grid.undulation(float(lon), float(lat))
    if n is None or not GEOID_RANGE[0] <= n <= GEOID_RANGE[1]:
        return None
    return float(ellipsoidal) - n
