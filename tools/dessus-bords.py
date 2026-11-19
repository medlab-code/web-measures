#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Vue du dessus (capture de tests/essai-dessus-reference.html, nord en haut, caméra au centre, 1,5 cm par pixel) avec les bords tracés :
dessus-bords.py <identifiant> <capture.png> <sortie.png> <journaux…> ; relief (rouge), analyse fine (vert), vérifié (bleu)."""
import json, math, sys, urllib.request, importlib.util
from PIL import Image, ImageDraw, ImageFont
pid, src, out, logs = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
spec = importlib.util.spec_from_file_location("banc", "/home/med/claude/web-measures/tools/banc-bords.py")
banc = importlib.util.module_from_spec(spec); spec.loader.exec_module(banc)
rec = None
for f in logs:
    for line in open(f, encoding="utf-8", errors="ignore"):
        if line.startswith("BORDS ") and f'"id":"{pid}"' in line:
            d = json.loads(line[6:])
            if d.get("profils"): rec = d
req = urllib.request.Request("https://panoramax.ign.fr/api/search?ids=" + pid, headers={"User-Agent": "web-measures-essai"})
az = math.radians(json.load(urllib.request.urlopen(req, timeout=30))["features"][0]["properties"]["view:azimuth"])
im = Image.open(src).convert("RGB"); W = im.size[0]; px = W / 30.7  # pixels par mètre (±15 m, 1,5 cm/px)
c = W / 2
fwd = (math.sin(az), -math.cos(az))  # image : x à l'est, y vers le sud
right = (math.cos(az), math.sin(az))
dr = ImageDraw.Draw(im)
try: font = ImageFont.truetype("/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf", 34)
except OSError: font = ImageFont.load_default()
def line(off, color, label, along):
    a = (c + px * (off * right[0] - 13 * fwd[0]), c + px * (off * right[1] - 13 * fwd[1]))
    b = (c + px * (off * right[0] + 13 * fwd[0]), c + px * (off * right[1] + 13 * fwd[1]))
    dr.line([a, b], fill=color, width=6)
    t = (c + px * (off * right[0] + along * fwd[0]), c + px * (off * right[1] + along * fwd[1]))
    dr.text(t, label, fill=color, font=font, stroke_width=3, stroke_fill="black")
cam = rec["origine"] == "caméra"
shift = 0.0 if cam else None  # profil depuis l'axe : position de la caméra inconnue, bords non tracés
for side, s in (("droit", 1), ("gauche", -1)):
    r = (rec["relief"] or {}).get(side) or {}
    if shift is None: break
    if r.get("bord") is not None: line(s * r["bord"], (255, 40, 40), f"relief {r['bord']:.2f}", 9)
    b = (rec["nuage"].get("bords") or {}).get(side)
    if b: line(s * b["x"], (40, 230, 40), f"fine {b['x']:.2f}", 4)
    ref = banc.REFERENCES.get((pid, side))
    if ref: line(s * ref[0], (60, 140, 255), f"vérifié {ref[0]:.2f}", -1)
dr.ellipse([c - 12, c - 12, c + 12, c + 12], outline=(255, 255, 0), width=5)
im.resize((1200, 1200)).save(out, quality=85)
print(out, "origine", rec["origine"])
