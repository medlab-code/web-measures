# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Outils de mesure, hors MeasureTool
(voir measures.py) :

- photo_click : clic dans la photo affichée, converti en direction corrigée du calage,
  avec la position (recalée), sa précision et l'axe de la route ;
- Triangulator : visées d'un objet depuis plusieurs photos ;
- CalibrationTool : clics de calage (inclinaison, cap et position, hauteur de caméra) ;
- calibration_text, tilt_state : textes du calage et de l'inclinaison de la photo.

Le dessin sur la carte vient de l'hôte (new_item), comme pour MeasureTool.
"""

import math
from datetime import datetime

from . import host, metadata, precision, triangulation
from .calibration import REACH, CalibrationError
from .measures import NullItem, _num

LONE_RAY = 60.0  # longueur (m) d'une visée tant qu'elle n'en croise aucune autre


def photo_click(item, yaw, elev, cal, quality=None, pos=None, axis=None):
    """Clic dans la photo `item` (fiche STAC) : direction brute yaw/elev (degrés, cap absolu),
    corrigée du calage `cal`. quality : vérification de la précision de la photo (voir
    precision.PrecisionChecker), ou None ; pos : position du clic dans le repère de la photo
    (radians, visionneuse web) ; axis : axe de la séquence (voir metadata.sequence_axis), à
    défaut l'orientation de la photo. Retourne le clic (dict) ou None sans position."""
    try:
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
    except (KeyError, TypeError, ValueError):
        return None
    axis_source = "séquence"
    if axis is None:
        axis, axis_source = metadata.item_heading(item), "orientation de la photo"
    pic, sequence = item.get("id", ""), item.get("collection")
    cyaw, celev = cal.correct(pic, sequence, float(yaw), float(elev), lon, lat)
    accuracy = _accuracy(item, quality)
    fixed = cal.position(sequence, lon, lat)  # position recalée par les repères de la séquence
    clon, clat, caccuracy = fixed if fixed else (lon, lat, accuracy)
    tilt = cal.tilt(pic)
    return {"pic": pic, "lon": clon, "lat": clat,
            "gps": [lon, lat], "gps_accuracy": accuracy,
            "yaw": cyaw, "elev": celev, "raw": [float(yaw) % 360, float(elev)],
            "sequence": sequence, "accuracy": caccuracy,
            "precise": metadata.precise_heading(item) is not None,
            "elev_error": tilt["sigma"] if tilt else None,
            "axis": axis, "axis_source": axis_source, "pos": pos}


def photo_sighting(item, heading, pitch, cal, quality=None):
    """Visée de triangulation depuis la photo `item` : cap brut du centre de la vue (degrés,
    cap précis de la photo compris) et son inclinaison, corrigés du calage. Retourne la visée
    (dict, voir triangulation.solve) ou None sans position. Position vérifiée précise (quality)
    : aussi l'altitude NGF de la caméra ("alt") et, si le LiDAR HD a donné le sol sous la photo,
    l'altitude de ce sol ("ground"), pour la triangulation en 3D (voir triangulation.solve3d)."""
    try:
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
    except (KeyError, TypeError, ValueError):
        return None
    pic, sequence = item.get("id", ""), item.get("collection")
    heading_raw = heading
    heading, elev = cal.correct(pic, sequence, float(heading), float(pitch), lon, lat)
    fixed = cal.position(sequence, lon, lat)
    clon, clat, accuracy = fixed if fixed else (lon, lat, _accuracy(item, quality))
    alt = ground = spread = None
    if quality and quality["precise"]:
        alt = host.ngf_altitude(lon, lat, metadata.item_altitude(item))
        if alt is not None and quality.get("lidar") is True and quality.get("height") is not None:
            ground = alt - quality["height"]  # hauteur de caméra médiane de la séquence
            spread = quality.get("spread")  # sa dispersion d'une photo à l'autre
    tilt = cal.tilt(pic)
    return {"pic": pic, "sequence": sequence, "lon": clon, "lat": clat, "heading": heading,
            "accuracy": accuracy, "precise": metadata.precise_heading(item) is not None,
            "heading_error": cal.heading_error(sequence, lon, lat),
            "elev": elev, "alt": alt, "ground": ground, "ground_spread": spread,
            "elev_error": tilt["sigma"] if tilt else None,
            "raw": [float(heading_raw) % 360, float(pitch)], "gps": [lon, lat]}


def _accuracy(item, quality):
    """Précision de la position de la photo : vérifiée (quality), sinon celle des métadonnées."""
    if quality and quality["precise"] and quality["accuracy"] is not None:
        return quality["accuracy"]
    return metadata.item_accuracy(item)


def tilt_state(cal, pic, pending=False):
    """(texte, manquante) : inclinaison de la photo pic, pour la ligne d'état (voir
    precision.state_text). pending : inclinaison automatique en cours de calcul."""
    tilt = cal.tilt(pic) if pic else None
    if tilt:
        if tilt["source"] == "clics":
            return "inclinaison calée à la main", False
        if tilt["source"].startswith("clics + "):
            return "inclinaison calée à la main et automatiquement (±{:.1f}°)".format(
                max(tilt["sigma"], 0.1)).replace(".", ","), False
        how = "verticales de la photo" if tilt["source"] == "verticales" else "pente et dévers du terrain IGN"
        return "inclinaison calée ({}, ±{:.1f}°)".format(how, max(tilt["sigma"], 0.1)).replace(".", ","), False
    if pending:
        return "inclinaison en cours de calcul…", False
    return "inclinaison non calée", True


def calibration_text(cal, pic, sequence, lon, lat):
    """Calage de la photo et de la séquence affichées (texte, vide sans calage)."""
    parts = []
    tilt = cal.tilt(pic) if pic else None
    if tilt and tilt.get("source", "clics") == "clics":
        parts.append("inclinaison {:.1f}° corrigée{} ({} objet{})".format(
            tilt["tilt"], " en partie" if tilt["partial"] else "", tilt["count"],
            "s" if tilt["count"] > 1 else "").replace(".", ","))
    elif tilt and tilt["source"].startswith("clics + "):
        parts.append("inclinaison {:.1f}° corrigée ({} objet{} cliqué{}, complété{} par {}, ±{:.1f}°)".format(
            tilt["tilt"], tilt["count"], *(("s", "s", "s") if tilt["count"] > 1 else ("", "", "")),
            "les verticales de la photo" if tilt["source"].endswith("verticales") else "le terrain IGN",
            max(tilt["sigma"], 0.1)).replace(".", ","))
    elif tilt and tilt["source"] == "verticales":
        parts.append("inclinaison {:.1f}° corrigée automatiquement ({} verticales de la photo, ±{:.1f}°)".format(
            tilt["tilt"], tilt["count"], max(tilt["sigma"], 0.1)).replace(".", ","))
    elif tilt:
        parts.append("inclinaison {:.1f}° estimée par la pente et le dévers du terrain IGN (±{:.1f}°, modèle vérifié "
                     "sur {} photos de la séquence)".format(tilt["tilt"], tilt["sigma"], tilt["count"]).replace(".", ","))
    camera = cal.camera(sequence) if sequence else None
    if camera:
        text = "caméra à {:.2f} m (±{:.2f} m, {} référence{})".format(
            camera["height"], camera["sigma"], camera["count"], "s" if camera["count"] > 1 else "").replace(".", ",")
        if camera.get("legacy"):
            text += (", dont {} d'une version précédente, sans l'inclinaison automatique : refaites le calage"
                     .format(camera["legacy"]))
        parts.append(text)
    pose = cal.pose(sequence, lon, lat) if sequence else None
    if pose:
        text = "cap {:+.2f}° (±{:.2f}°)".format(pose["offset"], pose["sigma"])
        if pose["positioned"]:
            sx, sy = pose["shift"]
            text += ", position décalée de {:.2f} m vers {:.0f}° (±{:.2f} m)".format(
                math.hypot(sx, sy), math.degrees(math.atan2(sx, sy)) % 360, pose["shift_sigma"])
        text += " · {} repère{}".format(pose["count"], "s" if pose["count"] > 1 else "")
        if pose["count"] > 3:
            text += ", écart {:.2f}°".format(pose["residual"])
        parts.append(text.replace(".", ","))
    elif sequence and cal.landmarks.get(sequence):
        parts.append("recalage de la séquence hors de portée (photo à plus de {:.0f} m des repères)".format(
            REACH))
    return "Calage : " + " · ".join(parts) if parts else ""


GROUND_REUSE = 1.0  # m : altitude LiDAR lue gardée tant que le point en reste à moins de cette distance
GROUND_ASKS = 3  # lectures successives au plus pour un même jeu de visées


def _metres(a, b):
    """Distance (m) entre deux (lon, lat)."""
    return math.hypot(*triangulation._local(b[0], b[1], a[0], a[1]))


def solve_on_ground(sightings, ground, ground_z):
    """triangulation.solve, avec l'altitude du sol lue au point ground_z (lon, lat, z, incertitude
    en m, source : « LiDAR HD » ou « RGE ALTI » ; (lon, lat, z) : LiDAR HD) si elle l'a été à moins
    de GROUND_REUSE m du point trouvé avec le sol tiré des photos ou de celui qu'elle donne : une
    altitude lue ailleurs, avant un changement des visées, ne sert pas. Le second cas fait
    converger les relectures (tools.Triangulator._ask_ground) : un sol qui déplace le point de
    plus de GROUND_REUSE m, relu à sa nouvelle position, resservait sinon une fois sur deux (le
    point allait et venait). Le résultat dit sa source ("ground_name")."""
    r = triangulation.solve(sightings, ground)
    if not (ground and ground_z and r["method"] == "3d"):
        return r
    z = (ground_z[2], ground_z[3]) if len(ground_z) > 3 else ground_z[2]
    on = triangulation.solve(sightings, ground, z)
    if min(_metres(ground_z[:2], (p["lon"], p["lat"])) for p in (r, on)) >= GROUND_REUSE:
        return r
    on["ground_name"] = ground_z[4] if len(ground_z) > 4 else precision.TERRAINS[0][0]
    return on


class Triangulator:
    """Visées en cours et point d'intersection. Le dessin des visées sur la carte vient de
    l'hôte (new_item), l'enregistrement aussi (attributes donne les valeurs)."""

    # Consignes de visée (reprises du plugin, réticule et bouton « Viser ») ; dans la page, un clic sur l'objet
    AIM = "Placez le réticule sur l'objet puis « Viser »"
    AIM_AGAIN = "visez le même objet puis « Viser » à nouveau"

    def __init__(self):
        self.sightings = []  # dicts : pic, lon, lat, heading, accuracy, precise (voir photo_sighting)
        self.ground = False  # point visé au sol (bord de chaussée, pied) : voir triangulation.solve
        self.result = None
        self.error = None
        self.item = None
        # Point au sol en 3D : altitude du sol lue à sa position, (lon, lat, z, incertitude, source)
        # ou None. ground_lookup(lon, lat, done(z ou None, incertitude, source)) est fourni par
        # l'hôte (session) ; ground_changed()
        # est appelé quand elle arrive après coup et a déplacé le point.
        self.ground_z = None
        self.ground_lookup = None
        self.ground_changed = lambda: None
        self._ground_ticket = None
        self.across = lambda: None  # direction en travers de la route (est, nord) quand un bord est visé, ou None
        self.lidar = True  # False sur un pont : sol tiré des photos (voir session.Session.set_bridge)

    def new_item(self):
        """Dessin des visées et du point sur la carte : set_data(visées [(lon, lat, lon, lat)],
        point (lon, lat) ou None), remove(). Remplacé par l'hôte."""
        return NullItem()

    # ------------------------------------------------------------------
    def add(self, sighting):
        """Ajoute une visée (remplace celle déjà faite depuis la même photo)."""
        self.sightings = [s for s in self.sightings if s["pic"] != sighting["pic"]] + [sighting]
        self._compute()
        return self.status()

    def clear(self):
        self.sightings, self.result, self.error = [], None, None
        self.ground_z, self._ground_ticket = None, None
        self._draw()

    def recompute(self):
        """Point recalculé après un changement des visées (calage ou précision arrivés après
        coup, voir session.Session._recompute)."""
        self._compute()

    def remove(self):
        if self.item is not None:
            self.item.remove()
            self.item = None

    def _compute(self, asks=0):
        self.result, self.error = None, None
        if len(self.sightings) >= 2:
            try:
                self.result = solve_on_ground(self.sightings, self.ground, self.ground_z if self.lidar else None)
            except triangulation.TriangulationError as exc:
                self.error = str(exc)
        self._draw()
        self._ask_ground(asks)

    def _ask_ground(self, asks=0):
        """Point au sol trouvé en 3D : altitude du MNT LiDAR HD lue à sa position (sauf si elle
        l'a déjà été à moins de GROUND_REUSE m), puis point recalculé avec elle. Relue si le
        point s'est encore déplacé, au plus GROUND_ASKS fois de suite."""
        r = self.result
        if not (self.ground and self.lidar and r and r["method"] == "3d" and self.ground_lookup) \
                or asks >= GROUND_ASKS:
            return
        if self.ground_z and _metres(self.ground_z[:2], (r["lon"], r["lat"])) < GROUND_REUSE:
            return
        ticket = self._ground_ticket = object()
        lon, lat = r["lon"], r["lat"]

        def got(z, sigma=triangulation.LIDAR_ERROR, source=precision.TERRAINS[0][0]):
            if ticket is not self._ground_ticket or z is None:
                return  # visées changées entre-temps, ou pas de modèle de terrain ici
            self.ground_z = (lon, lat, z, sigma, source)
            self._compute(asks + 1)
            self.ground_changed()

        self.ground_lookup(lon, lat, got)

    def _draw(self):
        if self.item is None:
            if not self.sightings:
                return
            self.item = self.new_item()
        rays = []
        for i, s in enumerate(self.sightings):
            length = self.result["distances"][i] * 1.15 + 3 if self.result else LONE_RAY
            end = triangulation.offset(s["lon"], s["lat"], s["heading"], length)
            rays.append((s["lon"], s["lat"]) + end)
        self.item.set_data(rays, (self.result["lon"], self.result["lat"]) if self.result else None)

    # ------------------------------------------------------------------
    def status(self):
        n = len(self.sightings)
        if n == 0:
            return "{}. Recommencez depuis une autre photo, sur le côté de l'objet.".format(self.AIM)
        if n == 1:
            return "1 visée. Changez de photo, {}.".format(self.AIM_AGAIN)
        if self.error:
            return "{} visées : {}".format(n, self.error)
        r = self.result
        text = "{} visées : point à {} m · croisement {}° · incertitude ±{} m".format(
            n, " / ".join(_num(d) for d in r["distances"]), _num(r["angle"], 0), _num(r["uncertainty"]))
        if n > 2:
            text += " · écart des visées {} m".format(_num(r["rms"]))
            if r["spread"] > triangulation.SPREAD_WARNING:
                text += (" ⚠ Une visée s'écarte nettement des autres : elle vise peut-être un autre objet (un "
                         "poteau voisin, par exemple). Revisez-la depuis sa photo : la nouvelle visée remplace "
                         "l'ancienne")
        across = self.across() if self.ground else None
        spread = triangulation.sight_spread(self.sightings, r["lon"], r["lat"], self.ground_z, *across) if across else 0.0
        if spread > triangulation.SIGHT_WARNING:
            text += (" ⚠ Les visées ne tombent pas au même endroit du bord (±{} m en travers) : revisez-en une, "
                     "sur le trait vert ou sur un repère net, au besoin depuis une photo plus proche").format(_num(spread, 2))
        text += " · GPS ±{} m".format(_num(r["gps"]))
        if r["gps_assumed"]:
            text += " (précision inconnue pour certaines photos : {} m supposés)".format(
                _num(triangulation.GPS_ACCURACY, 0))
        if r["method"] == "3d":
            text += " · profondeur fixée aussi par l'inclinaison des visées (altitudes RTK{})".format(
                {"lidar": ", sol {} au point".format(r.get("ground_name", precision.TERRAINS[0][0])),
                 "photos": ", sol tiré des photos"}.get(r["ground_source"], ""))
        elif r["angle"] < triangulation.WEAK_ANGLE:
            text += (". ⚠ Visées presque alignées ({}°) : le point est imprécis dans la profondeur, il peut "
                     "glisser de plusieurs mètres le long de la visée. Visez l'objet quand il est sur le côté de "
                     "la photo, depuis une photo prise avant lui et une autre après").format(_num(r["angle"], 0))
        if r["gps"] > triangulation.GPS_WARNING:
            text += (". Position GPS des photos imprécise (±{} m) : visez depuis des photos mieux "
                     "positionnées, ou d'autres séquences.".format(_num(r["gps"])))
        return text

    def attributes(self):
        """Attributs du point triangulé (export des mesures), ou None sans résultat."""
        r = self.result
        if r is None:
            return None
        return {
            "nb_visees": len(self.sightings),
            "angle": round(r["angle"], 1),
            "incert_m": round(r["uncertainty"], 2),
            "ecart_m": round(r["rms"], 2),
            "dist_max_m": round(max(r["distances"]), 1),
            "gps_m": round(r["gps"], 1),
            "photos": ",".join(s["pic"] for s in self.sightings),
            "date_mesure": datetime.now().isoformat(timespec="seconds"),
        }


class CalibrationTool:
    """Clics de calage de l'inclinaison (voir core/calibration.py) : pied et sommet d'objets verticaux. Les calages
    du cap (repères cliqués dans la photo puis sur la carte) et de la hauteur de caméra (longueur connue), repris
    du plugin, n'ont plus d'entrée dans la page depuis le 16/10/2026 : seuls leurs calages gardés ou importés
    servent encore (calibration.Calibration)."""

    def __init__(self, calibration, current):
        self.calibration = calibration
        self.current = current  # () -> (photo, séquence) affichées
        self.mode = "tilt"
        self.clicks = []  # clics en attente (dicts de tools.photo_click)
        self.error = None
        self.last = None  # résultat du dernier calage (texte)

    def set_mode(self, mode):
        self.mode = mode
        self.reset()

    def add_click(self, click, notice=None):  # notice : comme MeasureTool.add_click, sans usage ici
        self.error, self.last = None, None
        if self.clicks and self.clicks[0]["pic"] != click["pic"]:
            self.clicks = []  # le sommet doit être sur la même photo que le pied
        self.clicks.append(click)
        if len(self.clicks) == 2:
            bottom, top = (tuple(c["raw"]) for c in self.clicks)
            self.clicks = []
            try:
                r = self.calibration.add_vertical(click["pic"], bottom, top)
            except CalibrationError as exc:
                self.error = str(exc)
            else:
                self.last = "Inclinaison de la photo : {}° vers {}°{}.".format(
                    _num(r["tilt"], 2), _num(r["toward"], 0),
                    "" if r["residual"] is None else ", écart des objets {}°".format(_num(r["residual"], 2)))
                if r["partial"]:
                    self.last += (" Correction partielle : cliquez un autre objet vertical, à environ 90° "
                                  "du premier, pour corriger toute l'inclinaison.")
        return self.status()

    def reset(self):
        """Abandonne les clics en attente (le calage déjà fait est conservé)."""
        self.clicks, self.error, self.last = [], None, None

    def clear(self):
        """Efface l'inclinaison calée de la photo affichée."""
        pic, _ = self.current()
        if pic:
            self.calibration.clear_tilt(pic)
        self.reset()

    def viewer_marks(self):
        points = []
        for c in self.clicks:
            pos = c.get("pos") or [None, None]
            points.append({"pic": c.get("pic"), "yaw": pos[0], "pitch": pos[1],
                           "abs_yaw": c["raw"][0], "elev": c["raw"][1]})
        return {"points": points, "label": "", "beside": True}

    def status(self):
        text = (self.error or self.last or "") + (" " if self.error or self.last else "")
        if len(self.clicks) == 1:
            return text + "Cliquez le sommet du même objet."
        return text + ("Cliquez le pied puis le sommet d'un objet bien vertical (poteau, angle de façade). "
                       "Deux objets à environ 90° l'un de l'autre corrigent toute l'inclinaison de la photo.")
