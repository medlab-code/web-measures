# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Session de mesure, indépendante de l'affichage : ce que la page (py/web_app.App, qui en hérite)
relie à sa visionneuse, à sa carte et à son panneau.

- points de référence et relevé d'objets : visées cliquées dans les photos, triangulées
  (tools.Triangulator) ;
- hauteur : sommet (et pied) cliqués dans la photo → mesure (measures.MeasureTool) calée sur
  le point de référence (Measure.anchor) ;
- recalage d'un point (clic sur sa croix, nouvelle visée, flèches du clavier), consignes,
  repères de la visionneuse (photo affichée, projetés sur les autres photos), points à cadrer
  sur la carte ;
- calages : inclinaison, cap et position (tools.CalibrationTool) ;
- photo affichée : précision GPS vérifiée (precision.PrecisionChecker), inclinaison
  automatique (autotilt.TiltChecker), axe de la séquence entre les photos voisines.

L'hôte appelle les méthodes de Session (clics en radians dans le repère de la photo, comme
les donnent les visionneuses) ; elles renvoient le texte à afficher, ou des données Python
simples (listes, dictionnaires). Quand une lecture réseau ou un calcul aboutit après coup,
Session appelle notify() pour que l'hôte se redessine. Le dessin sur la carte passe par les
new_item des outils, que l'hôte remplace (ou par ses propres sous-classes des outils, passées
au constructeur).
"""

import math
import traceback

from . import autotilt, calibration, geometry, host, measures, metadata, precision, roads, tools, triangulation

GROUND_MODES = ("height",)  # mesures appuyées sur un point de référence
CALIBRATION_MODES = ("tilt",)  # calage du cap (« heading ») : plus d'entrée dans la page depuis le 16/10/2026
MODES = GROUND_MODES + ("tri",) + CALIBRATION_MODES
REF_MODES = ("height",)  # mesures appuyées sur un point de référence triangulé
NUDGE = 0.01  # pas (m) d'un point de hauteur déplacé aux flèches du clavier
VERTICAL_LENGTH = 12.0  # m : verticale tracée au-dessus du point de référence d'une hauteur
NUDGE_WORDS = {"left": "vers la gauche", "right": "vers la droite", "up": "en s'éloignant",
               "down": "en se rapprochant"}
# Triangulation et mesures qui s'y appuient : acceptées hors RTK, mais signalées
RTK_WARNING = (" ⚠ Photo sans position GPS RTK vérifiée : mesure probablement incohérente "
               "(la triangulation demande des positions précises).")
# Fenêtre d'avertissement, une fois par séquence sans RTK vérifié (voir Session.take_rtk_alert)
RTK_ALERT = ("La localisation des images de cette séquence est trop imprécise pour fonctionner. "
             "Un GPS avec corrections RTK est requis.")
# Photo sur un pont d'après la BD TOPO : proposition de cocher « Sur un pont » (voir take_bridge_alert)
BRIDGE_ALERT = ("D'après la BD TOPO de l'IGN, cette photo est prise sur un pont{}. Le modèle de terrain "
                "(LiDAR HD, RGE ALTI) y donne le "
                "terrain sous l'ouvrage, plusieurs mètres sous le tablier : les mesures seraient fausses. "
                "Cocher « Sur un pont » (sol tiré des photos au lieu du modèle de terrain) ?")
BRIDGE_ASKED_RADIUS = 200.0  # m : pas de nouvelle proposition près d'un pont déjà proposé
# Photo sortie du pont, case cochée : proposition de la décocher (voir take_bridge_alert)
BRIDGE_LEFT_ALERT = ("D'après la BD TOPO de l'IGN, cette photo n'est plus sur un pont. Décocher « Sur un pont » "
                     "pour utiliser de nouveau le modèle de terrain (LiDAR HD, RGE ALTI), plus précis hors "
                     "des ponts ?")


class Session:
    def __init__(self, notify=None, tool=None, triangulator=None, calibrator=None, calibration_store=None,
                 precision_checker=None, tilt_checker=None):
        """notify : fonction de l'hôte, appelée quand une lecture réseau ou un calcul aboutit
        après coup. tool, triangulator, calibrator : outils de l'hôte (sous-classes de
        measures.MeasureTool, tools.Triangulator, tools.CalibrationTool qui dessinent sur sa
        carte), sinon ceux du cœur ; calibration_store : calage de l'hôte (calibration.Calibration) ;
        precision_checker, tilt_checker : vérificateurs de l'hôte, partagés pour ne pas refaire ses
        requêtes (precision.PrecisionChecker, autotilt.TiltChecker)."""
        self.notify = notify or (lambda: None)
        self.calibration = calibration_store if calibration_store is not None else calibration.Calibration()
        self.roads = roads.RoadAxisProvider()
        self.precision = precision_checker if precision_checker is not None else precision.PrecisionChecker()
        self.tilts = tilt_checker if tilt_checker is not None else autotilt.TiltChecker()
        self.roads.ready = self._roads_ready
        if getattr(self.tilts, "roads", None) is None:
            self.tilts.roads = self.roads  # LiDAR sous l'emprise d'un pont voisin écarté (autotilt.TiltChecker)
        self.tool = tool if tool is not None else measures.MeasureTool(None)
        self.tool.calibration = self.calibration
        self.triangulator = triangulator if triangulator is not None else tools.Triangulator()
        self.triangulator.AIM = "Cliquez sur l'objet dans la photo"
        self.triangulator.AIM_AGAIN = "cliquez sur le même objet"
        self.triangulator.ground_lookup = self._ground_lookup  # sol (LiDAR HD, RGE ALTI) au point visé
        self.triangulator.ground_changed = lambda: self.notify()
        self.ground_cache = {}  # (lon, lat) arrondis -> (altitude du sol ou None, incertitude, source)
        self.bridge = False  # « Sur un pont » : LiDAR HD ignoré (voir set_bridge)
        self.calibrator = (calibrator if calibrator is not None
                           else tools.CalibrationTool(self.calibration, self.current_ids))
        self.mode = "height"
        self.tool.set_mode("height")
        self.item = None  # fiche STAC de la photo affichée
        # Fiches des photos affichées (id -> fiche) : leurs visées et leurs clics se recalculent
        # quand leur calage ou leur précision change (voir _recompute)
        self.photo_items = {}
        self.quality = None  # vérification de sa précision (voir precision.PrecisionChecker)
        self.neighbours = {}  # fiches des photos voisines (axe de la séquence) : id -> fiche
        self.message = ""
        self.points = []  # points triangulés gardés : (lon, lat, attributs)
        self.named = 0  # points gardés depuis le début : nom du suivant (A, B… voir _point_name)
        # Hauteur : point de référence triangulé (lon, lat, uncertainty, name, sequences), validé : les
        # mesures suivantes s'y appuient, depuis n'importe quelle photo, jusqu'au prochain
        # (new_reference) ; None : à trianguler d'abord
        self.ref_point = None
        # Hauteur : point de référence sélectionné (aucune hauteur ne s'y appuie encore), à recaler
        # sur sa verticale
        self.ref_sel = False
        # Hauteur faite depuis le point de référence : seuls ses points s'ajustent (sur la verticale)
        # jusqu'à « Nouvelle mesure depuis A » (new_measure)
        self.measure_done = False
        self.point_views = {}  # nom d'un point gardé -> {photo : [cap, élévation] de sa visée (radians)}
        self._handles = []  # clés des poignées de la carte, dans l'ordre de handles()
        self.calibration_version = 0  # augmente à chaque changement du calage (à enregistrer)
        self.active = False  # bouton « Mesure » : clics dans la photo pour mesurer
        self.rtk_alerted = set()  # séquences sans RTK déjà signalées par une fenêtre (take_rtk_alert)
        self.bridge_asked = []  # (lon, lat) des photos où « Sur un pont » a été proposé (take_bridge_alert)
        self._bridge_waiting = False  # tronçons BD TOPO en lecture pour take_bridge_alert
        self._bridge_waiting_items = {}  # photo -> fiche STAC dont le marquage « sur un pont » attend les tronçons BD TOPO (mark_bridge)
        self.bridge_left_asked = False  # case cochée : sortie du pont déjà proposée (take_bridge_alert)
        self.epoch = 0  # change quand les clics en cours sont abandonnés
        # Hauteur : photo de la première visée du point de référence, sur laquelle la
        # mesure se fera ; l'hôte y revient après la validation (take_goto)
        self.ref_photo = None
        self.goto = None  # photo à afficher, demandée une fois à l'hôte (voir take_goto)
        # Cadrage à faire sur la photo de référence après une validation (take_frame) : "reference"
        # (le point A), ou None
        self.frame_request = None

    def current_ids(self):
        item = self.item or {}
        return item.get("id"), item.get("collection")

    def _active(self):
        """Outil du mode : MeasureTool, Triangulator ou CalibrationTool."""
        if self._aiming():
            return self.triangulator
        if self.mode in CALIBRATION_MODES:
            if self.calibrator.mode != self.mode:
                self.calibrator.set_mode(self.mode)
            return self.calibrator
        self.tool.set_mode(self.mode)
        return self.tool

    def _aiming(self):
        """Les clics dans la photo sont-ils des visées de triangulation ? En triangulation, en
        hauteur tant que le point de référence n'est pas validé."""
        return self.mode == "tri" or (self.mode in REF_MODES and self.ref_point is None)

    def _calibration_changed(self, pics=None):
        """Calage changé (des photos pics, de toutes si None) : à enregistrer, et ce qui en
        dépend recalculé."""
        self.calibration_version += 1
        self._recompute(pics)

    def _ground_lookup(self, lon, lat, done):
        """Altitude du sol au point (lon, lat) : MNT LiDAR HD, sinon RGE ALTI (voir
        precision.fetch_terrain). done(z, incertitude (m), source), z None hors couverture ou
        service injoignable (alors non gardée : redemandée la fois suivante)."""
        key = (round(lon, 6), round(lat, 6))
        if key in self.ground_cache:
            done(*self.ground_cache[key])
            return

        def got(ground, source, error):
            if error:
                done(None, None, None)
                return
            z = (ground or [None])[0]
            sigma = triangulation.RGE_ALTI_ERROR if source == "RGE ALTI" else triangulation.LIDAR_ERROR
            self.ground_cache[key] = (z, sigma, source)
            if len(self.ground_cache) > 500:
                self.ground_cache.pop(next(iter(self.ground_cache)))
            done(z, sigma, source)

        precision.fetch_terrain([(lon, lat)], got)

    def _ref_ground(self, asks=0):
        """Point de référence au sol en 3D : altitude du MNT LiDAR HD lue à sa position (sauf
        déjà lue tout près), puis le point et ses mesures recalés avec elle (voir
        tools.Triangulator._ask_ground, son équivalent pendant les visées)."""
        ref = self.ref_point
        if not ref or ref.get("moved") or self.bridge or asks >= tools.GROUND_ASKS:
            return
        try:
            r = tools.solve_on_ground(ref["sightings"], True, ref.get("ground_z"))
        except triangulation.TriangulationError:
            return
        gz = ref.get("ground_z")
        if r["method"] != "3d" or (gz and tools._metres(gz[:2], (r["lon"], r["lat"])) < tools.GROUND_REUSE):
            return
        lon, lat = r["lon"], r["lat"]

        def got(z, sigma=None, source=None):
            if z is None or self.ref_point is not ref or ref.get("moved"):
                return
            ref["ground_z"] = (lon, lat, z, sigma or triangulation.LIDAR_ERROR, source or precision.TERRAINS[0][0])
            self._recompute(set(), force_reference=True)
            self._ref_ground(asks + 1)
            self.notify()

        self._ground_lookup(lon, lat, got)

    def _recompute(self, pics=None, force_reference=False):
        """Visées, point de référence et mesures recalculés depuis leurs directions brutes, avec
        le calage et la précision actuels des photos pics (toutes si None) : le résultat ne
        dépend pas de l'ordre dans lequel arrivent les clics, la vérification RTK et les calages
        (automatiques ou faits à la main avant ou après)."""
        def touched(pic):
            return pics is None or pic in pics

        try:
            if any([self._resight(s) for s in self.triangulator.sightings if touched(s["pic"])]):
                self.triangulator.recompute()
            clicked = self._reclick(touched)
            moved = self._recompute_reference(touched, force_reference)
            for m in self.tool.measures():
                if m in clicked or (moved and m in moved):
                    if m.reference is not None:  # hauteur calée sur un point triangulé
                        ref = m.reference
                        if self.ref_point and ref["name"] == self.ref_point["name"]:
                            self._anchor_on(m, self.ref_point)
                        else:  # point de référence précédent : calage gardé
                            m.anchor(ref["lon"], ref["lat"], ref["uncertainty"], ref["name"])
                    else:
                        m.compute()
            if moved is not None and not force_reference:
                self._ref_ground()  # altitude LiDAR à relire si le point s'est éloigné
        except Exception:
            traceback.print_exc()

    def _resight(self, s):
        """Visée s recalculée depuis sa direction brute (calage, précision de sa photo). Retourne
        True si elle a pu l'être."""
        item = self.photo_items.get(s["pic"])
        if item is None or not s.get("raw"):
            return False
        new = tools.photo_sighting(item, s["raw"][0], s["raw"][1], self.calibration, self.precision.known(item))
        if new is None:
            return False
        view = s.get("view")
        s.clear()
        s.update(new)
        if view is not None:
            s["view"] = view
        return True

    CLICK_KEYS = ("yaw", "elev", "lon", "lat", "gps", "gps_accuracy", "accuracy")

    def _reclick(self, touched):
        """Clics des mesures sur les photos touchées recalculés depuis leur direction brute.
        Retourne les mesures dont un clic a changé."""
        out = []
        for m in self.tool.measures():
            changed = False
            for c in m.clicks:
                item = self.photo_items.get(c.get("pic"))
                if item is None or not c.get("raw") or not touched(c.get("pic")):
                    continue
                new = tools.photo_click(item, c["raw"][0], c["raw"][1], self.calibration, self.precision.known(item),
                                        c.get("pos"), c.get("axis"))
                if new is not None:
                    c.update({k: new[k] for k in self.CLICK_KEYS})
                    changed = True
            if changed:
                out.append(m)
        return out

    def _recompute_reference(self, touched, force=False):
        """Point de référence dont une visée a été recalculée (ou force : son altitude LiDAR
        vient d'arriver) : triangulé à nouveau, ses hauteurs recalées sur lui.
        Laissé tel quel s'il a été déplacé à la main.
        Retourne ses mesures (à recalculer), ou None s'il n'a pas bougé."""
        ref = self.ref_point
        if not ref or ref.get("moved"):
            return None
        if not any([self._resight(s) for s in ref.get("sightings", []) if touched(s["pic"])]) and not force:
            return None
        try:
            r = tools.solve_on_ground(ref["sightings"], True, self._lidar_z(ref))
        except triangulation.TriangulationError:
            return None
        ref.update(lon=r["lon"], lat=r["lat"], uncertainty=r["uncertainty"], cov=r.get("cov"))
        for k, (_, _, v) in enumerate(self.points):  # son point gardé (export) suit
            if v["nom"] == ref["name"]:
                self.points[k] = (ref["lon"], ref["lat"], v)
        return [m for m in self._heights() if (m.reference or {}).get("name") == ref["name"]]

    # Réglages ------------------------------------------------------------------------
    def set_active(self, on):
        """Bouton « Mesure » : activé, les clics dans la photo mesurent (l'inclinaison de la
        photo est calculée au premier clic, voir _check_tilt) ; désactivé, les mesures en cours
        sont terminées (les mesures réussies restent affichées), comme dans le plugin. Les
        visées de la triangulation restent : on peut désactiver la mesure pour aller viser
        depuis une autre photo."""
        self.active = bool(on)
        self.message = ""
        if not self.active:
            self._clear_measures(keep_sightings=True)
        return self.status()

    def _check_tilt(self):
        """Inclinaison automatique de la photo affichée, en mesure ou en calage seulement, lancée
        au premier clic sur la photo et non à son arrivée : le calcul (photo HD, recherche des
        verticales) occupe le processeur quelques secondes et ferait saccader la vue pendant qu'on
        cherche l'objet ; les clics faits avant son résultat sont recalculés à son arrivée
        (_recompute). Le relevé d'objets et la mesure sur la carte (mode « tri » du cœur) s'en
        passent (calcul long évité ; sans elle, les visées comptent surtout par leur cap)."""
        if self.active and self.item and self.mode != "tri":
            pic = self.item.get("id")
            before = self.calibration.auto.get(pic)
            self.tilts.check(self.item, self.calibration, lambda: self._on_tilt(pic, before))

    def set_mode(self, mode):
        if mode not in MODES:
            return self.status()
        self._clear_measures()
        self.mode = mode
        self.ref_point = None
        self.measure_done = False
        self.ref_sel = False
        self.message = ""
        self._active()
        return self.status()

    def _clear_measures(self, keep_sightings=False):
        """Termine les mesures en cours (réussies, elles restent affichées) ; le calage déjà
        fait est conservé (comme le plugin à un changement de mode)."""
        self.epoch += 1
        if not keep_sightings:
            self.triangulator.clear()
        self.tool.finish()
        self.calibrator.reset()

    def set_camera_height(self, value):
        self.tool.set_camera_height(float(value))
        return self.status()

    def set_bridge(self, value):
        """« Sur un pont » : le MNT LiDAR HD donne le terrain sous l'ouvrage (la voie franchie,
        plusieurs mètres plus bas), pas le tablier. Les points au sol se calent alors sur le sol
        tiré des photos (altitude GPS des caméras moins leur hauteur) et l'inclinaison automatique
        se passe de la pente LiDAR. Les altitudes déjà lues sont gardées : décocher les reprend."""
        if value and not self.bridge:
            self.bridge_left_asked = False  # nouvelle sortie à proposer
        self.bridge = bool(value)
        self.triangulator.lidar = self.calibration.lidar = not self.bridge
        self._recompute(force_reference=True)
        self.triangulator.recompute()
        self._ref_ground()
        return self.status()

    def _lidar_z(self, point):
        """Altitude LiDAR HD lue au point triangulé (lon, lat, z), ou None (pas lue, ou sur un pont)."""
        return None if self.bridge else point.get("ground_z")

    def set_api_url(self, url):
        """Instance Panoramax choisie : recherches du cœur (précision GPS, trajectoire)."""
        host.api_url = url
        self.neighbours = {}

    # Photo affichée ------------------------------------------------------------------
    def set_picture(self, item):
        """Photo affichée dans la visionneuse : sa fiche STAC."""
        self.item = item
        pic = item.get("id")
        self.photo_items[pic] = item
        if len(self.photo_items) > 500:  # les plus anciennes, sans visée ni clic récents
            self.photo_items.pop(next(iter(self.photo_items)))
        self._mark_bridge()
        self.quality = self.precision.known(item)
        before = self.quality
        self.precision.check(item, lambda res: self._on_precision(pic, res, before))
        for rel in ("prev", "next"):  # voisines : axe de la séquence
            nid = metadata.id_from_href(metadata.item_link(item, rel))
            if nid and nid not in self.neighbours:
                host.fetch_json("{}/search?ids={}".format(host.api_url, nid),
                                    lambda data, error, nid=nid: self._on_neighbour(nid, data))
        return self.status()

    def _on_neighbour(self, nid, data):
        features = (data or {}).get("features") or []
        if features:
            self.neighbours[nid] = features[0]
            if len(self.neighbours) > 200:
                self.neighbours.pop(next(iter(self.neighbours)))

    def _axis(self, item):
        def neighbour(rel):
            return self.neighbours.get(metadata.id_from_href(metadata.item_link(item, rel)))
        return metadata.sequence_axis(item, neighbour("prev"), neighbour("next"))

    def _on_precision(self, pic, res, before=None):
        """Précision de la séquence de la photo pic arrivée : visées et clics faits avant sur ses
        photos recalculés (altitude RTK, sol LiDAR, précision vérifiée)."""
        if res is not before:
            sequence = (self.photo_items.get(pic) or {}).get("collection")
            self._recompute({p for p, it in self.photo_items.items() if it.get("collection") == sequence} | {pic})
        if pic == (self.item or {}).get("id"):  # photo encore affichée
            self.quality = res
        self.notify()

    def _on_tilt(self, pic, before=None):
        """Inclinaison automatique arrivée : clics, visées et point de référence de la photo
        recalculés (voir _recompute). Rien si elle n'a pas changé (check rappelle aussi sans
        calcul : photo déjà calée, non 360°, sans cap) : ni calage réenregistré, ni affichage refait."""
        if self.calibration.auto.get(pic) == before:
            return
        self._calibration_changed({pic})
        self.notify()

    def _heading(self):
        """Cap du centre de l'image (degrés) : EXIF précis, sinon view:azimuth."""
        precise = metadata.precise_heading(self.item)
        return precise if precise is not None else (metadata.item_heading(self.item) or 0.0)

    # Clics -------------------------------------------------------------------------------
    def click(self, yaw, pitch):
        """Clic dans la photo affichée : direction dans le repère de la photo (radians, cap
        relatif au centre de l'image, comme le donne la visionneuse)."""
        if not self.active:
            return self.status()
        if not self.item:
            self.message = "Photo en cours de chargement : cliquez à nouveau."
            return self.status()
        self._check_tilt()
        if self._aiming():
            return self.aim(yaw, pitch)
        raw_yaw = (math.degrees(yaw) + self._heading()) % 360
        click = tools.photo_click(self.item, raw_yaw, math.degrees(pitch), self.calibration, self.quality,
                                  [yaw, pitch], self._axis(self.item))
        if click is None:
            self.message = "Position de la photo inconnue."
            return self.status()
        self.message = ""
        tool = self._active()
        if self.mode == "height" and self.ref_sel:  # point de référence recalé sur sa verticale
            self.ref_sel = False
            dz = self._recale_ref_foot(pitch)
            self.message = ("Pied au point de référence {} recalé de {} cm sur sa verticale, sur cette photo.").format(
                self.ref_point["name"], measures._num(abs(dz) * 100, 0))
            return self.status()
        if self.mode == "height" and tool.selected is not None and \
                click.get("pic") != tool.selected[0].clicks[0].get("pic"):
            self.message = ("Ce point se recale par un clic sur la photo de sa mesure (le pied et le sommet "
                            "y sont visés ensemble) ; ici, flèches ↑ ↓ : 1 cm ; Entrée pour terminer.")
            return self.status()
        if self.mode == "height" and tool.selected is None and (
                tool.current is None or len(tool.current.clicks) >= tool.current.needed()):
            near = self._height_near(click)
            if near is not None:  # clic sur la croix d'un pied ou d'un sommet : sélectionné
                tool.selected = near
                return self.status()
            if self._ref_near(click):  # croix du point de référence seule : sélectionnée
                self.ref_sel = True
                return self.status()
            if self._locked():  # pas d'autre hauteur sans « Nouvelle mesure depuis A »
                self.message = self._locked_text()
                return self.status()
        if self.mode == "height":
            return self._height_click(click)
        tool.add_click(click)  # calage de l'inclinaison ou du cap
        self._after_calibration(tool)
        return self.status()

    def _height_click(self, click):
        """Hauteur, étape 2 : le sommet (le pied est la visée du point de référence faite
        depuis cette photo), sinon le pied puis le sommet, ou la nouvelle visée du point
        sélectionné. Sans profil du terrain : calée sur le point de référence, la hauteur n'en
        dépend pas."""
        tool = self.tool
        selected = tool.selected
        reaimed = selected is not None
        if not reaimed and (tool.current is None or len(tool.current.clicks) >= tool.current.needed()):
            foot = self._reference_foot()
            if foot is not None:
                tool.add_click(foot)
        text = tool.add_click(click)
        self.message = text if reaimed else ""  # point recalé : son résultat ; sinon la suite (status)
        if reaimed:
            self._sync_ref_foot(*selected)
        self._anchor_height()
        return self.status()

    def _sync_ref_foot(self, m, index):
        """Pied d'une hauteur appuyée sur le point de référence recalé à la main (flèches, clic) :
        gardé comme pied du point de référence sur cette photo (ref["feet"]), pour que les
        hauteurs suivantes depuis lui (« Nouvelle mesure depuis A ») partent du pied corrigé."""
        ref = self.ref_point
        if index != 0 or not ref or (m.reference or {}).get("name") != ref["name"] or not m.result:
            return
        p = m.viewer_marks()["points"][0]  # pied tel que la photo de la mesure le voit maintenant
        if p["yaw"] is not None and p["pitch"] is not None:
            ref.setdefault("feet", {})[m.clicks[0].get("pic")] = [p["yaw"], p["pitch"]]

    def select_point(self, yaw, pitch):
        """Clic droit dans la photo : sélectionne le point de hauteur dont la croix
        est sous le clic, depuis n'importe quelle photo, pour le recaler (clic gauche, flèches du
        clavier, Entrée pour terminer)."""
        if not self.active or not self.item or self.mode not in REF_MODES:
            return self.status()
        click = tools.photo_click(self.item, (math.degrees(yaw) + self._heading()) % 360, math.degrees(pitch),
                                  self.calibration, self.quality, [yaw, pitch], self._axis(self.item))
        if click is None:
            return self.status()
        self.message = ""
        self.tool.selected = self._height_near(click)
        self.ref_sel = self.tool.selected is None and self._ref_near(click)
        found = self.tool.selected is not None or self.ref_sel
        if not found:
            self.message = "Aucune croix de mesure sous le clic droit."
        return self.status()

    def _locked_text(self):
        return ("Hauteur mesurée depuis le point {0} : cliquez une de ses croix pour l'ajuster (nouveau clic sur "
                "la photo de la mesure, ou flèches ↑ ↓ : 1 cm sur la verticale ; Entrée pour terminer). Autre "
                "hauteur depuis ce point : « Nouvelle mesure depuis {0} » ; autre point : « Nouveau point de "
                "référence ».").format(self.ref_point["name"])

    def camera_of(self, item, quality, sequence_only=False, mount=True):
        """Hauteur de caméra de la photo item au-dessus du sol : (m, source, incertitude en m), dans l'ordre :
        - écart altitude RTK moins sol LiDAR HD, pris pour la hauteur de la caméra (source « altitude GPS » : une borne, pas une hauteur mesurée ; quality : vérification de la position ; sequence_only : sur la
          séquence seulement, pas la photo seule de précision déclarée, prise au-dessus du sol sous elle) ;
        - calée pour la séquence ;
        - monture connue du véhicule (_mount_height, mount=False : sans elle) ;
        - le réglage « Hauteur de caméra » (source None).
        Les mesures (hauteur, points triangulés) n'en dépendent pas : elle sert aux repères et objets posés
        au sol, au relevé sur une seule photo, au tablier d'un pont et à l'export. MeasureTool.camera_info, côté
        mesures, ne connaît que les deux dernières sources (calée, réglage)."""
        q = quality or {}
        h = q.get("height")
        if (q.get("count") if sequence_only else q.get("precise")) and q.get("lidar") is True and h is not None \
                and measures.CAMERA_RANGE[0] <= h <= measures.CAMERA_RANGE[1]:
            return h, "altitude GPS", q.get("spread") or measures.CAMERA_ERRORS["altitude GPS"]
        cam = self.calibration.camera((item or {}).get("collection"))
        if cam:
            return cam["height"], "calée", cam["sigma"]
        known = self._mount_height(item or {}) if mount else None
        if known:
            return known[0], "monture", known[1]
        return self.tool.camera_height, None, measures.CAMERA_ERRORS[None]

    def _mount_height(self, item):
        """Monture connue du véhicule de la photo : (hauteur en m, incertitude en m), ou None (la page la connaît
        pour le CD21 : web_app.App._mount_height)."""
        return None

    def _camera_height(self, mount=True):
        """Hauteur de caméra de la photo affichée (camera_of)."""
        return self.camera_of(self.item, self.quality, mount=mount)[0]

    def _view_of(self, bearing, elev):
        """Direction vraie (cap, élévation en degrés) vue dans la photo affichée, calage compris
        (inclinaison, cap) : {yaw, pitch (radians, repère de la photo), abs_yaw, elev (degrés, bruts)}."""
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        yaw, pitch = self.calibration.uncorrect(self.item.get("id"), self.item.get("collection"), bearing % 360, elev,
                                                lon, lat)
        return {"yaw": math.radians((yaw - self._heading() + 540) % 360 - 180), "pitch": math.radians(pitch),
                "abs_yaw": yaw % 360, "elev": pitch}

    def _project(self, plon, plat, height=None):
        """Repère dans la photo affichée d'un point de la carte, au sol supposé plat (hauteur de
        caméra height, sinon celle de la photo, voir _camera_height), calage de la photo compris :
        {yaw, pitch (radians, repère de la photo), abs_yaw, elev (degrés)}."""
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        x, y = triangulation._local(plon, plat, lon, lat)
        bearing = math.degrees(math.atan2(x, y))
        height = self._camera_height() if height is None else height
        elev = -math.degrees(math.atan2(height, max(math.hypot(x, y), 0.5)))
        return self._view_of(bearing, elev)

    def _free_mark_point(self, k):
        """Repère du point gardé n° k dans la photo affichée : là où il a été visé depuis elle,
        sinon projeté au sol."""
        lon, lat, values = self.points[k]
        view = self.point_views.get(values["nom"], {}).get(self.item.get("id"))
        point = {"yaw": view[0], "pitch": view[1]} if view else self._project(lon, lat)
        return dict(point, pic=self.item.get("id"))

    def _free_marks(self):
        """Points gardés seuls (relevé d'objets), dans la photo affichée. Les points de référence des
        hauteurs sont montrés par elles."""
        refs = {(m.reference or {}).get("name") for m in self._heights()}
        if self.ref_point:
            refs.add(self.ref_point["name"])
        marks = []
        for k, (_, _, values) in enumerate(self.points):
            if values["nom"] not in refs:
                marks.append({"points": [self._free_mark_point(k)], "label": ""})
        return marks

    def _reference_mark(self):
        """Croix du point de référence validé dans la photo affichée : là où il a été visé depuis
        cette photo, sinon projeté au sol. None dès qu'une mesure s'y appuie (sa croix le montre)."""
        ref, pic = self.ref_point, self.item.get("id")
        if self.mode == "height" and any((m.reference or {}).get("name") == ref["name"] for m in self._heights()):
            return None  # le pied des hauteurs qui s'y appuient le montre
        view = self._ref_view(pic)
        if view is not None:
            point = {"yaw": view[0], "pitch": view[1]}
        else:
            point = self._project(ref["lon"], ref["lat"])
        return {"points": [dict(point, pic=pic, sel=self.ref_sel)], "label": "", "beside": False}  # sélectionnée : ref_sel

    def _heights(self):
        return [m for m in self.tool.done if m.kind == "height" and m.result]

    def _height_points(self, m):
        """Repères du pied et du sommet d'une hauteur dans la photo affichée : [{yaw, pitch
        (radians, repère de la photo), abs_yaw, elev (degrés)}]. Sur la photo de la mesure, là
        où ils ont été visés ; sur les autres, projetés depuis leur position 3D, la caméra
        supposée à l'altitude de celle de la mesure (repères seulement)."""
        pic = (self.item or {}).get("id")
        if pic == m.clicks[0].get("pic"):
            return [{"yaw": p["yaw"], "pitch": p["pitch"], "abs_yaw": p["abs_yaw"], "elev": p["elev"]}
                    for p in m.viewer_marks()["points"]]
        pts, _, origin, _ = m.points()
        c0 = m.clicks[0]
        z0 = measures._ground_z(m.clicks)[c0.get("pic")]
        cam_z = geometry.camera(c0, self.tool.camera_for(c0), origin, z0)[0][2]
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        cx, cy = triangulation._local(lon, lat, *origin)
        heading, out = self._heading(), []
        for x, y, z in pts:
            bearing = math.degrees(math.atan2(x - cx, y - cy))
            elev = math.degrees(math.atan2(z - cam_z, max(math.hypot(x - cx, y - cy), 0.5)))
            out.append({"yaw": math.radians((bearing - heading + 540) % 360 - 180), "pitch": math.radians(elev),
                        "abs_yaw": bearing % 360, "elev": elev})
        return out

    def _ref_near(self, click):
        """Hauteur : clic sur la croix du point de référence, quand aucune hauteur ne s'y appuie
        (sinon c'est le pied de celles-ci) ?"""
        mark = self._reference_mark() if self.mode == "height" and self.ref_point and self.item else None
        if not mark:
            return False
        p = mark["points"][0]  # comparé au clic brut (voir _nearest)
        point = {"abs_yaw": (math.degrees(p["yaw"]) + self._heading()) % 360, "elev": math.degrees(p["pitch"])}
        return self._nearest(click, [(None, [point])]) is not None

    def _height_near(self, click):
        """(hauteur, n° de point) dont le repère est le plus près du clic sur la photo
        affichée (à moins de measures.SELECT_ANGLE degrés), ou None."""
        return self._nearest(click, [(m, self._height_points(m)) for m in self._heights()])

    def _nearest(self, click, candidates):
        raw = click.get("raw") or [click["yaw"], click["elev"]]
        best, best_d = None, measures.SELECT_ANGLE
        for m, points in candidates:
            for index, p in enumerate(points):
                dyaw = (raw[0] - p["abs_yaw"] + 540) % 360 - 180
                d = math.hypot(dyaw * math.cos(math.radians(raw[1])), raw[1] - p["elev"])
                if d < best_d:
                    best, best_d = (m, index), d
        return best

    def nudge_point(self, key):
        """Flèches du clavier sur le point sélectionné (key : "left", "right", "up", "down"),
        qui reste sélectionné : hauteur, pied ou sommet monté (↑) ou descendu (↓) de 1 cm."""
        if key not in NUDGE_WORDS or not self.item:
            return self.status()
        if self.mode == "height" and self.ref_sel:
            if key in ("up", "down"):
                self._nudge_ref_foot(NUDGE if key == "up" else -NUDGE)
                self.message = "Pied au point de référence {} {} de 1 cm sur cette photo.".format(
                    self.ref_point["name"], "monté" if key == "up" else "descendu")
            else:
                self.message = "← → sans effet : le point de référence reste sur sa verticale."
            self.message += " Flèches ↑ ↓ : encore 1 cm ; clic : recaler ; Entrée : terminer."
            return self.status()
        if self.mode == "height" and self.tool.selected is not None:
            m, index = self.tool.selected
            if key in ("up", "down"):
                m.lift(index, NUDGE if key == "up" else -NUDGE)
                self._sync_ref_foot(m, index)
                self.message = (m.error + " " if m.error else "") + (m.status() if m.result else "")
            else:
                self.message = "← → sans effet sur une hauteur : ↑ ↓ montent ou descendent le point."
            self.message += " Flèches ↑ ↓ : encore 1 cm ; clic : recaler ; Entrée : terminer."
        return self.status()

    def finish_point(self):
        """Touche Entrée : fin du calage du point sélectionné (hauteur), qui
        redevient un point ordinaire ; le résultat de sa mesure s'affiche."""
        if self.ref_sel:
            self.ref_sel = False
            self.message = ""
            return self.status()
        if self.mode == "height" and self.tool.selected is not None:
            m = self.tool.selected[0]
            self.tool.cancel_selection()
            self.message = m.status() if m.result else ""
        return self.status()

    def new_reference(self):
        """Hauteur : « Nouveau point de référence » ; les hauteurs déjà faites restent."""
        self.epoch += 1  # pied cliqué en attente de son profil : abandonné
        self.tool.clear()
        self.triangulator.clear()
        self.ref_point = None
        self.measure_done = False
        self.ref_sel = False
        self.message = ""
        return self.status()

    def new_measure(self):
        """« Nouvelle mesure depuis A » : la hauteur faite reste, le clic suivant (sommet) en donne
        une autre depuis le même point de référence."""
        self.tool.cancel_selection()
        self.measure_done = False
        self.ref_sel = False
        self.message = ""
        return self.status()

    def _locked(self):
        """Hauteur faite depuis le point de référence (et toujours là) : les clics ne
        servent plus qu'à ajuster ses points, jusqu'à new_measure."""
        ref = self.ref_point
        if not self.measure_done or ref is None:
            return False
        return self.mode == "height" and any((m.reference or {}).get("name") == ref["name"] for m in self._heights())

    def _ref_view(self, pic):
        """Hauteur : [cap, élévation] (radians, repère de la photo pic) du pied au point de
        référence : recalé sur cette photo (ref["feet"]), sinon sa visée depuis elle, ou None."""
        ref = self.ref_point or {}
        if pic in ref.get("feet", {}):
            return ref["feet"][pic]
        seen = next((s for s in ref.get("sightings", []) if s["pic"] == pic and s.get("view")), None)
        return list(seen["view"]) if seen else None

    def _ref_distance(self):
        """Distance horizontale (m) de la photo affichée au point de référence."""
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        return max(math.hypot(*triangulation._local(self.ref_point["lon"], self.ref_point["lat"], lon, lat)), 0.5)

    def _recale_ref_foot(self, pitch):
        """Hauteur : pied au point de référence recalé sur la photo affichée, à l'élévation pitch
        (radians), sur sa verticale (le cap ne change pas) ; les hauteurs suivantes depuis cette
        photo partent de là."""
        ref, pic = self.ref_point, self.item.get("id")
        mark = self._reference_mark()
        yaw = mark["points"][0]["yaw"] if mark else self._project(ref["lon"], ref["lat"])["yaw"]
        old = self._ref_view(pic)
        ref.setdefault("feet", {})[pic] = [yaw, pitch]
        dz = (math.tan(pitch) - math.tan(old[1] if old else self._project(ref["lon"], ref["lat"])["pitch"])) \
            * self._ref_distance()
        return dz

    def _nudge_ref_foot(self, dz):
        """Hauteur : pied au point de référence monté (dz > 0) ou descendu de dz m sur la photo
        affichée."""
        ref, pic = self.ref_point, self.item.get("id")
        view = self._ref_view(pic)
        if view is None:
            p = self._project(ref["lon"], ref["lat"])
            view = [p["yaw"], p["pitch"]]
        d = self._ref_distance()
        ref.setdefault("feet", {})[pic] = [view[0], math.atan((d * math.tan(view[1]) + dz) / d)]

    def _reference_foot(self):
        """Hauteur : clic du pied pris dans la visée du point de référence faite depuis la photo
        affichée (le pied est le point triangulé), ou recalé sur elle ; None sinon."""
        view = self._ref_view((self.item or {}).get("id")) if self.ref_point else None
        if view is None:
            return None
        yaw, pitch = view
        return tools.photo_click(self.item, (math.degrees(yaw) + self._heading()) % 360, math.degrees(pitch),
                                 self.calibration, self.quality, [yaw, pitch], self._axis(self.item))

    def _anchor_height(self):
        """Hauteur terminée : calée sur le point de référence, qui reste pour les suivantes."""
        m = self.tool.current
        if self.mode != "height" or self.ref_point is None or m is None or not m.result or m.reference:
            return
        ref = self.ref_point
        self._anchor_on(m, ref)
        if m.error:
            self.message = m.error
            return
        self.message = (m.status() + self._rtk_warning(ref["sequences"] + [c.get("sequence") for c in m.clicks])
                        + " Pour l'ajuster, cliquez une de ses croix. Autre hauteur depuis ce point : « Nouvelle "
                          "mesure depuis {} ».".format(ref["name"]))
        self.measure_done = True
        self.tool.finish()  # mesure terminée : affichée avec les autres pendant les visées suivantes

    def _anchor_on(self, m, ref):
        """Hauteur m calée sur le point de référence ref : pied sur la visée du pied de sa photo
        (là où il a été cliqué, ou visé pour la triangulation), à la profondeur du point
        triangulé. Avec trois visées ou plus, le point triangulé est un compromis qui s'écarte un
        peu de chacune : le pied reste là où on l'a mis sur la photo de la mesure, la hauteur ne
        dépendant que de sa distance."""
        c = m.clicks[0]
        x, y = triangulation._local(ref["lon"], ref["lat"], c["lon"], c["lat"])
        a = math.radians(c["yaw"])
        t = x * math.sin(a) + y * math.cos(a)  # profondeur du point le long de la visée du pied
        lon, lat = (ref["lon"], ref["lat"]) if t < 0.5 else \
            triangulation._geographic(t * math.sin(a), t * math.cos(a), c["lon"], c["lat"])
        m.anchor(lon, lat, ref["uncertainty"], ref["name"])

    def _after_calibration(self, tool):
        if tool is not self.calibrator:
            return
        self._calibration_changed()

    def aim(self, yaw, pitch):
        """Triangulation : visée de la direction cliquée (radians, dans le repère de la photo)."""
        if not self.active:
            return self.status()
        if not self.item:
            self.message = "Aucune photo affichée : impossible de viser."
            return self.status()
        sighting = tools.photo_sighting(self.item, (math.degrees(yaw) + self._heading()) % 360,
                                        math.degrees(pitch), self.calibration, self.quality)
        if sighting is None:
            self.message = "Position de la photo inconnue : impossible de viser."
            return self.status()
        self.message = ""
        sighting["view"] = [yaw, pitch]  # repère de la visée dans la photo (viewer_marks)
        replaced = any(s["pic"] == sighting["pic"] for s in self.triangulator.sightings)
        if self.mode in REF_MODES and not self.triangulator.sightings:
            self.ref_photo = sighting["pic"]  # photo de référence : la mesure s'y fera
        self.triangulator.ground = self.mode in REF_MODES  # bord de chaussée, pied : au sol
        self.triangulator.add(sighting)
        if replaced:  # une visée par photo : un second clic (le sommet ?) remplace la première
            self.message = "Visée de cette photo remplacée : une seule visée par photo. "
            if self.mode == "height":
                self.message += ("Étape 1 : visez le pied de l'objet depuis une autre photo (flèches pour changer "
                                 "de photo), puis « Valider le point triangulé » ; le pied et le sommet se cliquent ensuite.")
            else:
                self.message += "Changez de photo (flèches) pour viser le même objet d'un autre point de vue."
            self.message += self._rtk_warning([s.get("sequence") for s in self.triangulator.sightings])
        return self.status()

    def keep_point(self):
        """Garde le point triangulé (exporté avec les mesures), puis repart de zéro."""
        values = self.triangulator.attributes()
        if values is None:
            self.message = self.triangulator.error or "Il faut au moins deux visées qui se croisent."
            return self.status()
        r = self.triangulator.result
        sightings = self.triangulator.sightings
        sequences = [s.get("sequence") for s in sightings]
        warning = self._rtk_warning(sequences)
        name = _point_name(self.named)
        self.named += 1
        values = dict({"nom": name}, **values, commentaire="")
        self.points.append((r["lon"], r["lat"], values))
        self.point_views[name] = {s["pic"]: s["view"] for s in sightings if s.get("view")}
        ground_z = self.triangulator.ground_z  # sol LiDAR lu au point, avant que clear ne l'oublie
        self.triangulator.clear()
        if self.mode in REF_MODES:  # point de référence, sans distance au précédent
            if self.ref_photo and self.ref_photo != (self.item or {}).get("id"):
                self.goto = self.ref_photo  # retour sur la photo de référence pour la mesure
            self.frame_request = "reference"  # vue cadrée sur A (take_frame)
            self.ref_point = {"lon": r["lon"], "lat": r["lat"], "uncertainty": r["uncertainty"], "cov": r.get("cov"), "name": name,
                              "sequences": sequences, "sightings": list(sightings),
                              "ground_z": ground_z}  # sol LiDAR au point, s'il est lu
            self._ref_ground()  # sinon demandé maintenant
            self.message = ("Point de référence {} validé (±{} m) : c'est le pied. Cliquez maintenant le sommet "
                            "de l'objet, depuis cette photo ou une autre de la triangulation (à choisir sur la "
                            "carte).").format(name, measures._num(r["uncertainty"])) + warning
            return self.status()
        self.message = "Point {} gardé (±{} m).".format(name, measures._num(r["uncertainty"])) + warning
        return self.status()

    def move_handle(self, index, lon, lat):
        """Poignée n° index (voir handles) glissée sur la carte en (lon, lat)."""
        if not 0 <= index < len(self._handles):
            return self.status()
        try:
            self.message = self.tool.move_handle(self._handles[index], float(lon), float(lat))
        except Exception:
            traceback.print_exc()
            self.message = "Recalage impossible."
        return self.status()

    def clear(self):
        """« Effacer » : sélection d'un point, mesure en cours, visées, ou calage du mode."""
        self.message = ""
        tool = self._active()
        if tool is self.tool and tool.cancel_selection():
            return self.status()
        if self.ref_sel:
            self.ref_sel = False
            return self.status()
        self.epoch += 1
        nothing_aimed = tool is self.triangulator and not self.triangulator.sightings
        nothing_clicked = tool is self.tool and self.mode in REF_MODES and (
            self.tool.current is None or not self.tool.current.clicks)
        if nothing_aimed or nothing_clicked:  # rien en cours : le dernier point posé
            return self._undo_point()
        tool.clear()
        if tool is self.calibrator:
            self._calibration_changed()
        return self.status()

    def _undo_point(self):
        """« Effacer » sans rien en cours : retire le dernier point posé. Hauteur : la
        dernière mesure depuis le point de référence (son sommet), puis, sans mesure, le point de référence lui-même ; relevé d'objets : le dernier point
        gardé."""
        if self.mode == "tri":
            if self.points:
                self._drop_kept(len(self.points) - 1)
            return self.status()
        ref = self.ref_point
        if ref is None:
            return self.status()
        mates = [m for m in self._heights() if (m.reference or {}).get("name") == ref["name"]]
        if mates:
            self.delete_result("mesure", id(mates[-1]))
            self.measure_done = False
            self.message = "Sommet effacé : cliquez-le à nouveau."
            return self.status()
        k = next((k for k, (_, _, v) in enumerate(self.points) if v["nom"] == ref["name"]), None)
        if k is not None:
            self._drop_kept(k)
        self.ref_point, self.ref_sel, self.measure_done = None, False, False
        self.message = "Point de référence {} effacé : visez-le à nouveau.".format(ref["name"])
        return self.status()

    def _drop_kept(self, k):
        """Retire le point gardé n° k ; si c'était le dernier nommé, sa lettre resservira."""
        name = self.points[k][2]["nom"]
        self.delete_result("point", k)
        self.point_views.pop(name, None)
        if name == _point_name(self.named - 1):
            self.named -= 1

    def clear_all(self):
        self.epoch += 1
        self.frame_request = None
        self.triangulator.clear()
        self.tool.clear_all()
        self.calibrator.reset()
        self.points, self.named = [], 0
        self.point_views = {}
        self.ref_point = None
        self.measure_done = False
        self.ref_sel = False
        self.message = ""
        return self.status()

    def _mark_bridge(self):
        """Marque la photo affichée comme sur un pont (voir mark_bridge)."""
        if self.item:
            self.mark_bridge(self.item)

    def mark_bridge(self, item):
        """Marque la photo item (fiche STAC) comme sur un pont (BD TOPO, roads.on_bridge), dès son ouverture et même hors mesure :
        Calibration.set_bridge_photo écarte alors son LiDAR (inclinaison et modèle de séquence). Vaut pour la photo affichée comme
        pour ses voisines (vue du dessus). Retourne vrai ou faux ; None pendant la lecture des tronçons (marque inchangée, refaite
        à leur arrivée, _roads_ready) ; BD TOPO injoignable : marque inchangée."""
        pic = item.get("id")
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        except (KeyError, TypeError, ValueError):
            return False
        axis = self._axis(item)
        sec = self.roads.bridge(lon, lat, metadata.item_heading(item) if axis is None else axis)
        if sec is roads.PENDING:
            self._bridge_waiting_items[pic] = item
            return None
        self._bridge_waiting_items.pop(pic, None)
        if sec is not None:
            self.calibration.set_bridge_photo(pic, bool(sec))
        return pic in self.calibration.bridge_pics

    def _roads_ready(self):
        waiting, self._bridge_waiting_items = self._bridge_waiting_items, {}
        if waiting:
            for item in waiting.values():
                self.mark_bridge(item)
            self.notify()
        changed = self._bridge_waiting  # pont à proposer peut-être
        self._bridge_waiting = False
        if changed:
            self.notify()

    # Affichage -----------------------------------------------------------------------
    def status(self):
        """Texte de la mesure (consigne ou résultat)."""
        if not self.active:
            return self.message or "Choisissez un outil de mesure dans la visionneuse (hauteur, relevé, calage) ou « Mesurer sur la carte »."
        if self.message:
            return self.message
        if self.mode == "height" and self.ref_sel:
            return ("Point de référence {} sélectionné : cliquez la position exacte du pied sur cette photo (il "
                    "reste sur sa verticale), ou flèches du clavier ↑ ↓ : 1 cm ; Entrée pour terminer.").format(
                self.ref_point["name"])
        if self.mode == "height" and self.tool.selected is not None:
            return ("{} de la hauteur sélectionné : cliquez sa position exacte sur la photo de la mesure, ou "
                    "flèches du clavier ↑ ↓ : 1 cm ; Entrée pour terminer.").format(
                "Pied" if self.tool.selected[1] == 0 else "Sommet")
        if self.mode == "tilt":
            return self._calibration_text()
        text = self._active().status()
        sequences = []
        if self._aiming():
            sequences = [s.get("sequence") for s in self.triangulator.sightings]
        if self.mode == "height" and self.ref_point is None:
            text = ("Hauteur, étape 1/2 : visez le pied de l'objet depuis au moins deux photos (une visée par "
                    "photo, flèches pour changer de photo). " + text)
            if self.triangulator.result is not None:
                text += " Puis « Valider le point triangulé »."
        elif self._locked():
            text = self._locked_text()
            sequences = self.ref_point["sequences"]
        elif self.mode == "height":
            current = self.tool.current
            if (current is None or len(current.clicks) >= current.needed()) and self._reference_foot() is not None:
                text = ("Cliquez le sommet de l'objet : le pied est le point {} visé depuis cette photo.").format(
                    self.ref_point["name"])
            elif current is None or len(current.clicks) >= current.needed():
                text = ("Cette photo n'a pas servi à viser le point : cliquez le pied puis le sommet, ou passez sur "
                        "une photo de la triangulation (seul le sommet y est à cliquer).")
            text = "Hauteur, étape 2/2 (point {}) : {}".format(self.ref_point["name"], text)
            current = self.tool.current
            sequences = self.ref_point["sequences"] + [c.get("sequence") for c in (current.clicks if current else [])]
        return text + self._rtk_warning(sequences)

    def _name_marks(self, marks):
        """Étiquettes des noms des points triangulés dans la photo affichée, sans croix (« name ») :
        point de référence des hauteurs, à sa croix (repère du point de référence
        en cours, point 0 de ses mesures) ; points gardés du relevé d'objets. side : côté de la
        croix opposé à la mesure (« left », « right », « above », « below »), pour ne pas la
        masquer ; dessous par défaut (une hauteur monte).
        Points d'arrivée des hauteurs (sommets) : nommés dans l'étiquette de leur
        mesure (« end » de viewer_marks), pas ici."""
        pic = self.item.get("id")
        at = {}  # nom -> (repère, repère de l'autre bout de la mesure ou None)
        ref = self.ref_point
        if ref is not None and self.active and self.mode in REF_MODES:
            mark = self._reference_mark()
            if mark:
                at[ref["name"]] = (mark["points"][0], None)
        ends = set()  # points d'arrivée des hauteurs (sommets) : nommés dans leur étiquette
        starts = {(ref or {}).get("name")} | {
            (m.reference or {}).get("name") for m in self._heights()}  # points de départ : nommés à part
        for m in self._heights():
            if m.reference and m.reference.get("name"):
                points = self._height_points(m)
                at.setdefault(m.reference["name"], (points[0], points[1] if len(points) > 1 else None))
                if len(points) > 1:
                    ends.add(self._end_name(m)["name"])
        for k, (_, _, values) in enumerate(self.points):
            if values["nom"] not in at and values["nom"] not in ends:
                at[values["nom"]] = (self._free_mark_point(k), None)
        # Traits des mesures de la photo : un nom qui tombe à l'intérieur de l'un d'eux (sommet
        # d'une hauteur plus courte sous une plus haute) est
        # mis sur le côté du trait, pas dessus
        lines = [[q for q in m["points"] if q.get("pic", pic) == pic and q.get("yaw") is not None]
                 for m in marks if m.get("label") and not m.get("name")]
        lines = [(q[0], q[-1]) for q in lines if len(q) >= 2]
        return [{"points": [dict(p, pic=pic, sel=False)], "label": name, "name": True,
                 "side": _beside_line(p, lines) or _away(p, other)}
                for name, (p, other) in at.items() if name and p is not None and (name not in ends or name in starts)]

    def _end_name(self, m):
        """Point d'arrivée d'une hauteur (sommet) : {"name", "provisional"}, ou None (hauteur sans
        point de référence nommé)."""
        if m.reference and m.reference.get("name"):
            return {"name": self._provisional_name(m), "provisional": True}
        return None

    def _provisional_name(self, m):
        """Nom provisoire du sommet d'une hauteur (lettre suivante des points gardés), donné une fois."""
        if not getattr(m, "provisional_name", None):
            m.provisional_name = _point_name(self.named)
            self.named += 1
        return m.provisional_name

    def _calibration_text(self):
        """Consigne du calage de l'inclinaison, étape par étape, avec ce qui est déjà fait."""
        tool, pic = self.calibrator, (self.item or {}).get("id")
        prefix = (tool.error + " ") if tool.error else ""
        waiting = len(tool.clicks)
        done = len(self.calibration.verticals.get(pic, []))
        if waiting:
            return prefix + ("Calage de l'inclinaison, objet {} : cliquez maintenant son sommet, le plus haut "
                             "possible sur la même verticale (zoomez pour être précis).").format(done + 1)
        if done == 0:
            return prefix + ("Calage de l'inclinaison, objet 1 sur 2 : cliquez le pied d'un objet bien vertical "
                             "(poteau, angle de façade, montant de panneau), au ras du sol, puis son sommet.")
        if done == 1:
            return prefix + ("1 objet calé : l'inclinaison n'est corrigée qu'en partie. Objet 2 sur 2 : cliquez le "
                             "pied puis le sommet d'un autre objet vertical, à environ 90° du premier dans la "
                             "photo (sur le côté si le premier est devant).")
        tilt = self.calibration.tilt(pic, photo_only=True) or {}  # le calage fait à la main, pas la vue du dessus
        sigma = " (±{}°)".format(measures._num(tilt["sigma"], 2)) if tilt.get("sigma") is not None else ""
        return prefix + ("Inclinaison calée sur {} objets{} : c'est fait pour cette photo. Un objet de plus "
                         "l'affine ; sinon, passez à un mode de mesure.").format(done, sigma)

    def _rtk_warning(self, sequences):
        """RTK_WARNING si l'une des séquences n'a pas de position RTK vérifiée (vérification
        terminée), sinon ""."""
        for sequence in dict.fromkeys(s for s in sequences if s):
            res = self.precision.known({"collection": sequence})
            if res is not None and not res.get("precise"):
                return RTK_WARNING
        return ""

    def state(self):
        """État de la photo affichée (dictionnaire) : ligne de qualité, calage, hauteur de caméra
        proposée, raisons du mode dégradé…"""
        item, pic = self.item, (self.item or {}).get("id")
        lon = lat = None
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        except (KeyError, TypeError, ValueError):
            pass
        suggestion = precision.camera_suggestion(self.quality) if item else None
        tilt = tools.tilt_state(self.calibration, pic, bool(pic) and self.tilts.pending(pic))
        sequence = (item or {}).get("collection")
        return ({
            "quality": precision.state_text(self.quality, metadata.item_accuracy(item), tilt) if item else "",
            "computed": precision.computed_text(self.quality) if item else "",  # précision GPS calculée
            "calibration": tools.calibration_text(self.calibration, pic, sequence, lon, lat) if item else "",
            "camera": [round(suggestion[0], 2), suggestion[1]] if suggestion else None,
            "point": self.triangulator.result is not None,
            "aiming": self._aiming(),
            "point_sel": self.ref_sel or (
                self.mode == "height" and self.tool.selected is not None),
            # bouton « Nouvelle mesure depuis A » : nom du point de référence, ou None
            "new_measure": self.ref_point["name"] if self._locked() else None,
            "active": self.active,
            "lights": self._lights(pic) if item else [],
            "guide": self.guide(),
        })

    # Visées guidées (hauteur) -----------------------------------------------------
    def take_frame(self):
        """Points à cadrer dans la vue ([[cap, élévation]] en radians, repère de la photo), une
        seule fois, quand la photo de référence est affichée après une validation : le point A
        (point de référence validé). None sinon, ou tant que la photo affichée n'est pas celle de référence."""
        request = self.frame_request
        if request is None or not self.item or self.item.get("id") != self.ref_photo:
            return None
        self.frame_request = None
        mark = self._reference_mark() if self.ref_point else None
        points = mark["points"] if mark else []
        return [[p["yaw"], p["pitch"]] for p in points if p.get("yaw") is not None] or None

    def take_goto(self):
        """Photo à afficher (identifiant), demandée une seule fois, ou None : la photo de
        référence, après la validation du point (voir keep_point)."""
        goto, self.goto = self.goto, None
        return goto

    def _neighbour(self, pic, rel):
        """Photo précédente (rel "prev") ou suivante ("next") de pic dans sa séquence, d'après
        sa fiche (photo déjà affichée), ou None."""
        item = self.photo_items.get(pic)
        return metadata.id_from_href(metadata.item_link(item, rel)) if item else None

    def guide(self):
        """Visées guidées du point de référence : {"reference" : photo de référence, "choices" :
        [{"id", "label", "title", "lon", "lat"}]} (photos à proposer pour la visée suivante, avec
        leur position si elle est connue : l'hôte montre de quel côté de la vue elles sont), ou None.

        La photo précédente et la suivante de la référence ; une fois la deuxième
        visée faite sur l'une, l'autre pour une troisième, de l'autre côté. La validation
        reste manuelle ; les flèches permettent toujours un autre choix."""
        if not (self.active and self.mode in REF_MODES and self._aiming() and self.ref_photo):
            return None
        sighted = [s["pic"] for s in self.triangulator.sightings]
        if self.ref_photo not in sighted:
            return None
        ref, others = self.ref_photo, [p for p in sighted if p != self.ref_photo]
        choices = []

        def offer(pic, label, title):
            if pic and pic not in sighted:
                feature = self.photo_items.get(pic) or self.neighbours.get(pic) or {}
                try:  # position, pour que l'hôte montre de quel côté de la vue elle se trouve
                    lon, lat = (float(v) for v in feature["geometry"]["coordinates"][:2])
                except (KeyError, TypeError, ValueError):
                    lon = lat = None
                choices.append({"id": pic, "label": label, "title": title, "lon": lon, "lat": lat})

        # Rang des photos autour de la référence (négatif : avant elle dans la séquence), pour
        # nommer chaque photo proposée par rapport à celle qui est affichée
        rank = {ref: 0}

        def label(pic, third, fallback):
            here = rank.get((self.item or {}).get("id"))
            step = None if here is None or pic not in rank else rank[pic] - here
            if step in (-1, 1):
                text = "photo précédente" if step < 0 else "photo suivante"
            elif step in (-2, 2):
                text = "2 photos en arrière" if step < 0 else "2 photos en avant"
            else:
                text = fallback
            return "3e visée : " + text if third else text[0].upper() + text[1:]

        prev, nxt = self._neighbour(ref, "prev"), self._neighbour(ref, "next")
        rank.update({p: k for p, k in ((prev, -1), (nxt, 1)) if p})
        if not others:
            offer(prev, label(prev, False, "photo précédente"),
                  "Viser le même pied depuis la photo précédente de la séquence")
            offer(nxt, label(nxt, False, "photo suivante"),
                  "Viser le même pied depuis la photo suivante de la séquence")
        elif len(others) == 1 and others[0] in (prev, nxt):
            other = prev if others[0] == nxt else nxt
            offer(other, label(other, True, "de l'autre côté de la référence"),
                  "Facultatif : viser aussi le pied de l'autre côté de la photo de référence")
        return {"reference": ref, "choices": choices}


    def _lights(self, pic):
        """Voyants de la visionneuse : [(nom, état)], état « ok », « non » ou « attente »."""
        res = self.quality

        def light(value):
            return "attente" if value is None else ("ok" if value else "non")

        calibrated = self.calibration.tilt(pic)
        if calibrated and not calibrated.get("fallback"):  # roulis par défaut de la campagne seul : pas une inclinaison calée
            tilt = "ok"
        else:
            tilt = "attente" if self.tilts.pending(pic) else "non"
        return [("RTK", light(res["precise"] if res else None)),
                (precision.terrain_name(res), light(res["lidar"] if res else None)),
                ("Inclinaison", tilt)]

    def viewer_marks(self):
        """Repères de la photo affichée (liste) : pour chaque mesure, points (cap et élévation
        dans le repère de la photo, radians), libellé, point sélectionné."""
        pic = (self.item or {}).get("id")
        # Hauteurs : visibles depuis toutes les photos (voir _height_points)
        marks = [self.tool._marks(m) for m in self.tool.done if not (m.kind == "height" and m.result)]
        if self.item:
            # Hauteurs : étiquette au point d'arrivée (sommet), avec son nom
            # (« end », provisoire ou non) et les noms des deux bouts (« names »)
            for m in self._heights():
                end = self._end_name(m)
                marks.append({"points": [dict(p, pic=pic, sel=self.tool.selected == (m, k))
                                         for k, p in enumerate(self._height_points(m))],
                              "label": m.label(), "beside": True, "end": end,
                              "names": [n for n in [(m.reference or {}).get("name"), end and end["name"]] if n]})
        if self.item:  # relevé d'objets : points gardés, depuis toutes les photos
            marks += self._free_marks()
        if self.active and self._aiming():  # visées faites depuis cette photo
            marks = marks + [{"points": [{"pic": s["pic"], "yaw": s["view"][0], "pitch": s["view"][1]}
                                         for s in self.triangulator.sightings if "view" in s], "sighting": True}]
        elif self.active and self.mode in GROUND_MODES:  # mesure ou calage en cours
            marks = marks + [self.tool.viewer_marks()]
        elif self.active and self.mode in CALIBRATION_MODES:
            marks = marks + [self.calibrator.viewer_marks()]
        if self.active and self.mode in REF_MODES and self.ref_point and self.item:
            marks = marks + [m for m in [self._reference_mark()] if m]
        if self.item:  # noms des points triangulés (A, B…) à côté de leur croix
            marks = marks + self._name_marks(marks)
        if self.active and self.mode == "height" and self.ref_point and self.item:  # de même
            marks = [self._vertical_mark()] + marks
        if self.active and self.item and self._aiming() and self.mode == "tri":
            # Visées faites depuis les autres photos, tracées dans celle-ci : l'objet visé est sur
            # leur trait (ligne épipolaire), ce qui fixe la profondeur de la visée suivante
            marks = [self._epipolar_mark(s) for s in self.triangulator.sightings if s["pic"] != pic] + marks
        out = []
        for m in marks:
            points = [p for p in m["points"] if p.get("pic") == pic and p.get("yaw") is not None]
            if points:
                out.append({"points": [[p["yaw"], p["pitch"], bool(p.get("sel"))] for p in points],
                            "label": m.get("label", ""), "beside": m.get("beside", False),
                            "sighting": m.get("sighting", False), "guide": m.get("guide", False),
                            "vertical": m.get("vertical", False), "name": m.get("name", False),
                            "epipolar": m.get("epipolar", False),
                            "side": m.get("side", ""), "provisional": m.get("provisional", False),
                            "end": m.get("end"), "names": m.get("names", [])})
        return out

    def focus(self):
        """Points à montrer ensemble sur la carte ([[lon, lat]]) pendant une mesure :
        photo affichée, photos des visées en cours et leur point, point de référence de la
        hauteur, mesure en cours ou dernière terminée (points et photos)."""
        if not self.active or self.mode in CALIBRATION_MODES:
            return []
        pts = []
        try:
            pts.append([float(v) for v in self.item["geometry"]["coordinates"][:2]])
        except (KeyError, TypeError, ValueError):
            pass
        pts += [[s["lon"], s["lat"]] for s in self.triangulator.sightings]
        if self.triangulator.result:
            pts.append([self.triangulator.result["lon"], self.triangulator.result["lat"]])
        if self.mode in REF_MODES and self.ref_point:
            pts.append([self.ref_point["lon"], self.ref_point["lat"]])
        if self.mode in GROUND_MODES:
            m = self.tool.current or (self.tool.done[-1] if self.tool.done else None)
            if m is not None and m.result:
                pts += [list(p) for p in m.result["picks"]] + [[c["lon"], c["lat"]] for c in m.clicks]
        return pts

    def _vertical_mark(self):
        """Hauteur : verticale vraie passant par le point de référence, dans la photo affichée
        (repère de la visionneuse, tracé vert) : depuis la croix du pied (là où il a été visé
        depuis cette photo, sinon projeté au sol) jusqu'à VERTICAL_LENGTH m au-dessus. Tracée
        dans le monde puis ramenée dans la photo par le calage (inclinaison, cap) : sur une photo
        penchée et calée, elle suit les objets verticaux et non le bord de l'image."""
        item, cal = self.item, self.calibration
        pic, sequence = item.get("id"), item.get("collection")
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        heading = self._heading()
        view = self._ref_view(pic)
        if view is None:
            p = self._project(self.ref_point["lon"], self.ref_point["lat"])
            view = [p["yaw"], p["pitch"]]
        # Pied dans le monde : cap et élévation vrais ; la verticale garde ce cap
        bearing, elev = cal.correct(pic, sequence, (math.degrees(view[0]) + heading) % 360,
                                    math.degrees(view[1]), lon, lat)
        d = self._ref_distance()
        z0 = d * math.tan(math.radians(max(-89.0, min(89.0, elev))))
        points = []
        for k in range(25):
            e = math.degrees(math.atan2(z0 + k * VERTICAL_LENGTH / 24, d))
            yaw, pitch = cal.uncorrect(pic, sequence, bearing, e, lon, lat)
            points.append({"pic": pic, "yaw": math.radians((yaw - heading + 540) % 360 - 180),
                           "pitch": math.radians(pitch)})
        return {"points": points, "guide": True, "vertical": True}

    def _epipolar_mark(self, s):
        """Visée s, faite depuis une autre photo, tracée dans la photo affichée : sa demi-droite
        dans l'espace (cap et inclinaison corrigés du calage, caméras à la hauteur de celle de la
        photo affichée au-dessus d'un sol plat), de 0,5 m jusqu'un peu au-delà du sol qu'elle
        touche (80 m au plus). L'objet visé est sur ce trait."""
        lon, lat = (float(v) for v in self.item["geometry"]["coordinates"][:2])
        height = self._camera_height()
        sx, sy = triangulation._local(s["lon"], s["lat"], lon, lat)
        a, e = math.radians(s["heading"]), math.radians(s.get("elev") or 0.0)
        reach = 80.0 if e >= -0.002 else min(80.0, height / -math.tan(e) * 1.2 + 1.0)
        points = []
        for k in range(41):  # 41 points : reprojetés par la visionneuse à chaque image
            t = 0.5 * (reach / 0.5) ** (k / 40)  # pas plus serrés près de la caméra de la visée
            x, y = sx + t * math.sin(a), sy + t * math.cos(a)
            z = t * math.tan(e)  # hauteur par rapport aux caméras
            d = math.hypot(x, y)
            if d < 0.5:
                continue
            view = self._view_of(math.degrees(math.atan2(x, y)), math.degrees(math.atan2(z, d)))
            points.append({"pic": self.item.get("id"), "yaw": view["yaw"], "pitch": view["pitch"]})
        return {"points": points, "guide": True, "epipolar": True}

    def handles(self):
        """Poignées déplaçables sur la carte : [[lon, lat]], repérées par leur rang pour
        move_handle. Seulement en mesure, comme dans le plugin."""
        handles = self.tool.handles() if self.active and self.mode in GROUND_MODES else []
        self._handles = [key for key, _, _ in handles]
        return [[lon, lat] for _, lon, lat in handles]

    def results(self):
        """Mesures terminées et points gardés, pour la liste des résultats de l'hôte."""
        out = [{"id": id(m), "kind": "mesure", "text": m.label(), "comment": getattr(m, "comment", "")}
               for m in self.tool.measures() if m.result]
        out += [{"id": i, "kind": "point", "text": "Point {} ±{} m".format(
                    v["nom"], measures._num(v["incert_m"], 2)), "comment": v.get("commentaire", "")}
                for i, (_, _, v) in enumerate(self.points)]
        return out

    def delete_result(self, kind, ident):
        """Efface un résultat de la liste : mesure (et son dessin), point triangulé (les
        autres gardent leur nom)."""
        if kind == "mesure":
            tool = self.tool
            for m in tool.measures():
                if id(m) == ident:
                    if tool.selected is not None and tool.selected[0] is m:
                        tool.selected = None
                    m.remove()
                    if m is tool.current:
                        tool.current = None
                    else:
                        tool.done.remove(m)
                    self.message = "Mesure effacée."
                    break
        elif kind == "point" and 0 <= ident < len(self.points):
            name = self.points[ident][2]["nom"]
            del self.points[ident]
            self.message = "Point {} effacé.".format(name)
        return self.status()

    def take_rtk_alert(self):
        """RTK_ALERT à afficher en fenêtre d'avertissement, une seule fois par séquence : mesure
        activée sur une photo dont la vérification a conclu à l'absence de position RTK ; None
        sinon (vérification en cours ou sans conclusion, RTK vérifié, séquence déjà signalée,
        mesure désactivée)."""
        res, item = self.quality, self.item or {}
        if not self.active or res is None or res.get("precise") or res.get("transient"):
            return None  # transient : service en panne pendant la vérification, pas de conclusion
        sequence = item.get("collection") or item.get("id")
        if sequence in self.rtk_alerted:
            return None
        self.rtk_alerted.add(sequence)
        return RTK_ALERT

    def take_bridge_alert(self):
        """Proposition à afficher en fenêtre, en mesure, d'après la BD TOPO (roads.on_bridge) :
        {"check": True, "text": BRIDGE_ALERT} (réponse oui : set_bridge(True)) sur une photo prise
        sur un pont, case « Sur un pont » décochée, pont pas encore proposé (à BRIDGE_ASKED_RADIUS m
        près) ; {"check": False, "text": BRIDGE_LEFT_ALERT} (réponse oui : leave_bridge()) case
        cochée, sur une photo à plus de roads.BRIDGE_LEFT m de tout tronçon en pont (les photos
        d'approche visent encore le tablier), une fois par sortie ; None sinon. Pendant la lecture
        des tronçons : None, et notify() à leur arrivée pour redemander."""
        item = self.item or {}
        if not self.active or not item or (self.bridge and self.bridge_left_asked):
            return None
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        except (KeyError, TypeError, ValueError):
            return None
        if self.bridge:
            sec = self.roads.bridge(lon, lat, None, roads.BRIDGE_LEFT)
            self._bridge_waiting = sec is roads.PENDING
            if sec is not False:  # sur un pont ou tout près, lecture en cours, BD TOPO injoignable
                return None
            self.bridge_left_asked = True
            return {"check": False, "text": BRIDGE_LEFT_ALERT}
        if any(tools._metres(p, (lon, lat)) < BRIDGE_ASKED_RADIUS for p in self.bridge_asked):
            return None
        axis = self._axis(item)
        sec = self.roads.bridge(lon, lat, metadata.item_heading(item) if axis is None else axis)
        self._bridge_waiting = sec is roads.PENDING
        if not sec or sec is roads.PENDING:
            return None
        self.bridge_asked.append((lon, lat))
        return {"check": True, "text": BRIDGE_ALERT.format(" ({})".format(sec["name"]) if sec.get("name") else "")}

    def leave_bridge(self):
        """Sortie du pont acceptée : case décochée, et les ponts déjà proposés pourront l'être de
        nouveau (on peut y revenir)."""
        self.bridge_asked = []
        return self.set_bridge(False)

    def set_comment(self, kind, ident, text):
        """Commentaire d'une mesure ou d'un point gardé (champ « commentaire » de l'export)."""
        if kind == "point":
            if 0 <= ident < len(self.points):
                self.points[ident][2]["commentaire"] = text
            return
        for m in self.tool.measures():  # rangé sur la mesure : effacée, son commentaire disparaît avec elle
            if id(m) == ident:
                m.comment = text

    def has_results(self):
        return bool(self.points) or any(m.result for m in self.tool.measures())


def _point_name(n):
    """Nom du n-ième point gardé (0 : A) : A … Z, puis AA, AB…, comme les colonnes d'un tableur."""
    name = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        name = chr(65 + r) + name
    return name


ON_LINE = math.radians(0.5)  # écart au trait d'une mesure en deçà duquel un nom serait dessus


def _beside_line(p, lines):
    """Côté du nom de la croix p quand elle est à l'intérieur d'un des traits lines ([(début,
    fin)], repères {yaw, pitch}) : « right » pour un trait plutôt vertical, « below » pour un
    trait plutôt horizontal ; None si elle n'est sur aucun (ou à un de leurs bouts)."""
    if p.get("yaw") is None:
        return None
    k = math.cos(p["pitch"])
    for a, b in lines:
        ax = ((a["yaw"] - p["yaw"] + math.pi) % (2 * math.pi) - math.pi) * k
        bx = ((b["yaw"] - p["yaw"] + math.pi) % (2 * math.pi) - math.pi) * k
        ay, by = a["pitch"] - p["pitch"], b["pitch"] - p["pitch"]
        dx, dy = bx - ax, by - ay
        length2 = dx * dx + dy * dy
        if length2 < ON_LINE ** 2:
            continue
        t = -(ax * dx + ay * dy) / length2  # position de p le long du trait (0 : début, 1 : fin)
        ends = ON_LINE / math.sqrt(length2)
        if ends < t < 1 - ends and abs(ax * dy - ay * dx) / math.sqrt(length2) < ON_LINE:
            return "right" if abs(dy) > abs(dx) else "below"
    return None


def _away(p, other):
    """Côté de la croix p opposé au point other (repères {yaw, pitch} de la photo, radians) :
    « left », « right », « above » ou « below » ; « below » sans other."""
    if other is None or other.get("yaw") is None or p.get("yaw") is None:
        return "below"
    dyaw = ((p["yaw"] - other["yaw"] + math.pi) % (2 * math.pi) - math.pi) * math.cos(p["pitch"])
    dpitch = p["pitch"] - other["pitch"]
    if abs(dyaw) >= abs(dpitch):
        return "right" if dyaw > 0 else "left"  # le cap croît vers la droite de l'écran
    return "above" if dpitch > 0 else "below"
