# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Pose de la caméra, sortie de web_app.py : inclinaison automatique (raison d'un échec, ticket #29), inclinaison par le
terrain hors agglomération (expérimentale, web_terrain), monture et défaut de roulis du producteur, pose de la vue du
dessus (src/dessus.js : photo affichée, voisines, photos à deux pas). Pose est une base de web_app.App : ses méthodes
lisent l'état de l'application (self)."""

import json
import math
from urllib.parse import urlencode

import web_host
import web_profils
import web_terrain
import web_tilt
from core import autotilt, calibration, host, measures, metadata, precision, roads


def _inside(point, ring):
    """Point (lon, lat) dans le polygone ring ([[lon, lat]]) ? Règle du nombre de croisements."""
    x, y, inside = float(point[0]), float(point[1]), False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        (x1, y1), (x2, y2) = a[:2], b[:2]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def roulis_vehicule_depuis_camera(roll):
    """Roulis (degrés) changé de convention, à la frontière entre le cœur et le reste de l'application (seul endroit).
    Cœur (core/calibration.py : tilt_components, up_from_components, d_roll, repris du plugin QGIS) : positif = la verticale vraie
    paraît penchée vers la droite sur la photo, soit la caméra penchée à GAUCHE. Application (src/dessus.js, profils de campagne, panneau
    de calage, ligne d'état) : positif = véhicule penché à DROITE, côté droit plus bas, vu dans le sens de la marche. Les deux
    conventions sont opposées : la fonction est sa propre inverse (véhicule vers cœur comme cœur vers véhicule). None reste None."""
    return None if roll is None else 0.0 - roll  # 0.0 - x : pas de -0.0


class Pose:
    """Inclinaison et pose de la caméra (voir web_app.App)."""

    # Inclinaison automatique : raison d'un échec (ticket #29) -----------------------------------
    def _run_tilt(self, function, args, done):
        """Calcul des verticales demandé par autotilt.TiltChecker (à la place de autotilt.estimate) :
        web_tilt.estimate, dont la raison d'un échec est gardée pour la photo analysée."""
        pic = self.tilts.current

        def got(res):
            if res and res.get("loose"):
                self._set_loose(pic, res["loose"])
            if res is None or "reason" in res:
                self.tilt_reasons[pic] = (res or {}).get("reason", "calcul des verticales indisponible")
                res = None
            done(res)
            if res is None and self.terrain_relay and (self.item or {}).get("id") == pic:
                self._relay(self.item)

        web_host.run_task(web_tilt.estimate, args, got)

    def _tilt_tried(self, pic):
        """Inclinaison automatique de la photo déjà calculée (ou abandonnée), dans cette session ou
        une précédente (calage conservé) ? Le cœur ne la lance qu'au premier clic (_check_tilt)."""
        return pic in self.calibration.auto or pic in self.tilt_reasons

    def _tilt_final(self):
        """Photo affichée sans inclinaison automatique à attendre : calcul fait, ou impossible."""
        return self._tilt_tried((self.item or {}).get("id")) or not autotilt.is_360(self.item or {})

    def _lights(self, pic):
        """Voyants du cœur ; inclinaison pas encore calculée : « avant » (jaune), pas « non » (rouge,
        pris pour un échec) ; calcul par le terrain en cours : « attente »."""
        def light_of(name, light):
            if name != "Inclinaison" or light != "non":
                return light
            return "attente" if pic in self.relay_pending else "non" if self._tilt_final() else "avant"
        return [(name, light_of(name, light)) for name, light in super()._lights(pic)]

    def _tilt_reason(self):
        """Pourquoi la photo affichée n'a pas d'inclinaison, ou None (calée, en cours) : raison de
        l'échec, ou moment du calcul s'il n'est pas encore fait (voir _tilt_final)."""
        item, pic = self.item or {}, (self.item or {}).get("id")
        tilt = self.calibration.tilt(pic) if pic else None
        if not pic or (tilt and not tilt.get("fallback")) or self.tilts.pending(pic):
            return None
        if not autotilt.is_360(item):
            return "photo non 360°"
        if not self._tilt_tried(pic):
            if self.mode == "tri":
                return "pas calculée dans ce mode"
            return "calculée au premier clic sur la photo" if self.active else "calculée à l'activation de la mesure"
        reason = self.tilt_reasons.get(pic, web_tilt.FEW_EDGES)
        if self.terrain_relay and pic in self.relay_failed:
            reason += " ; par le terrain : " + self.relay_failed[pic]
        return reason

    def _verticals_fragile(self, pic):
        """Raison courte si les verticales automatiques de la photo sont fragiles (autotilt.fit), sinon None."""
        v = (self.calibration.auto.get(pic) or {}).get("verticals")
        return (v or {}).get("fragile_reason") if (v or {}).get("fragile") else None

    def _tilt_line(self):
        """(texte, alerte) de l'inclinaison dans la ligne d'état. Un seul vocabulaire (ticket #29) :
        « calée » (par les verticales de la photo, par le terrain, à la main) ou « non calée », avec
        l'incertitude ; « calcul » pour ce qui est en cours ou à venir."""
        pic = (self.item or {}).get("id")
        tilt = self.calibration.tilt(pic) if pic else None
        if tilt and tilt.get("fallback"):
            fallback, tilt = tilt, None
        else:
            fallback = None
        if tilt:
            sigma = "±{}°".format(measures._num(max(tilt["sigma"], 0.1), 1))
            source = tilt["source"]
            if source.startswith("vue du dessus"):
                how = f"dans la vue du dessus{' (à la main)' if 'main' in source else ''} ({sigma})"
            elif source.endswith("(seuil élargi)"):
                how = f"{'à la main et ' if source.startswith('clics') else ''}par les verticales de la photo, seuil élargi ({sigma})"
            elif source == "clics":
                how = "à la main ({} objet{}, {})".format(tilt["count"], "s" if tilt["count"] > 1 else "", sigma)
            elif source == "clics + roulis de campagne":
                how = f"à la main, avec le {self._roll_label(self.item)} ({sigma})"
            elif source.startswith("clics + "):
                how = "à la main et par {} ({})".format(
                    "les verticales de la photo" if source.endswith("verticales") else "le terrain", sigma)
            elif source == "terrain web":
                how = "par le terrain, expérimental ({})".format(sigma)
            else:
                how = "par {} ({})".format("les verticales de la photo" if source == "verticales" else "le terrain", sigma)
                if source == "verticales" and self._verticals_fragile(pic):
                    how += ", fragile : " + self._verticals_fragile(pic)
            return "inclinaison calée " + how, False
        if pic and self.tilts.pending(pic):
            return "inclinaison : calcul en cours…", False
        if pic in self.relay_pending:
            return "inclinaison : calcul par le terrain en cours ({})…".format(self.relay_pending[pic]), False
        if fallback and not self._tilt_final():  # verticales pas encore cherchées : pas « non calée »
            return "inclinaison " + self._tilt_reason() + " ; " + self._roll_label(self.item) + self._pitch_known(self.item) + " en attendant", False
        if fallback:  # calcul fait sans résultat : le roulis par défaut de la campagne seul, tangage inconnu
            return f"inclinaison non calée : {self._roll_label(self.item)}{self._roll_why(self.item)}, {self._pitch_label(self.item)} (±{measures._num(fallback['sigma'], 1)}°)", True
        reason = self._tilt_reason()
        if not self._tilt_final():
            return "inclinaison " + reason, False
        return "inclinaison non calée (±{}°) : {}".format(
            measures._num(calibration.UNCALIBRATED, 0), reason), True

    # Inclinaison par le terrain hors agglomération, expérimentale (ticket #29) -------------------
    # Option de la page, décochée par défaut. Quand les verticales de la photo manquent : terrain
    # LiDAR HD sous la caméra (web_terrain), plus le décalage de la fixation, appris sur des photos
    # de la séquence calées par leurs verticales en zone d'habitation.
    RELAY_RADIUS = 15000.0  # m autour de la photo : zones d'habitation (BD TOPO) où chercher les références
    RELAY_ZONE = 300.0  # m autour du centre d'une zone : photos de la séquence candidates
    RELAY_TRIES = 12  # photos de référence analysées au plus par séquence (une photo HD chacune)
    RELAY_PER_ZONE = 3  # photos analysées au plus par zone : le centre du village n'est pas toujours la meilleure
    RELAY_NATURES = ("Lieu-dit habité", "Quartier")

    def set_terrain_relay(self, on):
        """Option « Inclinaison par le terrain hors agglomération » : cochée, calcul lancé pour la photo
        affichée si ses verticales ont déjà échoué ; mesures recalculées dans les deux sens."""
        self.terrain_relay = bool(on)
        if self.terrain_relay and self.item and self.item.get("id") in self.tilt_reasons:
            self._relay(self.item)
        self._calibration_changed()
        self.notify()
        return self.status()

    def _auto_tilt(self, pic):
        """Calibration.auto_tilt : celle du cœur (verticales, modèle LiDAR du cœur), sinon, l'option
        cochée, l'inclinaison par le terrain de la page (jamais sur un pont : LiDAR du sol sous l'ouvrage)."""
        tilt = self._core_auto_tilt(pic)
        if tilt is None and self.terrain_relay and pic not in self.calibration.bridge_pics:
            tilt = self.relay_tilts.get(pic)
        return tilt

    def _relay(self, item):
        """Inclinaison par le terrain de la photo item (fiche STAC) : terrain sous elle, puis modèle de
        sa séquence ; rangée dans relay_tilts, ou la raison de l'échec dans relay_failed."""
        pic = item.get("id")
        if not pic or pic in self.relay_tilts or pic in self.relay_pending:
            return
        self.relay_failed.pop(pic, None)
        self.relay_pending[pic] = "terrain sous la photo"

        def failed(reason):
            self.relay_pending.pop(pic, None)
            self.relay_failed[pic] = reason
            self.notify()

        def got_own(entry, reason):
            if entry is None:
                return failed(reason)
            self.relay_pending[pic] = "photos de référence de la séquence"
            self.notify()
            self._sequence_model(item, lambda m, why: got_model(entry, m, why))

        def got_model(entry, m, reason):
            if m is None:
                return failed(reason)
            self.relay_pending.pop(pic, None)
            self.relay_tilts[pic] = web_terrain.predict(m, entry["slopes"], entry["heading"])
            self._calibration_changed({pic})
            self.notify()

        self._terrain_of(item, got_own)
        self.notify()

    @staticmethod
    def _heading_of(item):
        heading = metadata.precise_heading(item)
        return metadata.item_heading(item) if heading is None else heading

    def birdeye_request(self):
        """Vue du dessus demandée sur la photo affichée : son inclinaison automatique est lancée
        (une fois par photo : Calibration.auto la garde, sinon ce sont les clics qui la relancent)."""
        if self.item and autotilt.is_360(self.item):
            pic = self.item.get("id")
            before = self.calibration.auto.get(pic)
            self.tilts.check(self.item, self.calibration, lambda: self._birdeye_tilt_done(pic, before))
            self._birdeye_relook(self.item)

    def _birdeye_relook(self, item):
        """Photo déjà analysée sans verticales retenues (calage gardé d'une séance précédente : l'analyse
        n'est pas refaite) : refaite une fois pour la vue du dessus, pour ses verticales moins sûres
        (web_tilt.LOOSE_SIGMA)."""
        pic, entry = item.get("id"), self.calibration.auto.get(item.get("id"))
        href = ((item.get("assets") or {}).get("hd") or {}).get("href")
        if not href or entry is None or entry.get("verticals") is not None or pic in self.birdeye_loose:
            return
        self.birdeye_loose[pic] = None  # en cours (ou sans résultat) : pas relancée
        heading = metadata.precise_heading(item)
        heading = metadata.item_heading(item) if heading is None else heading

        def got_estimate(res):
            if res and res.get("loose"):
                self._set_loose(pic, res["loose"])
                self.notify()

        def got_image(data, error):
            if not error and data and heading is not None:
                web_host.run_task(web_tilt.estimate, (bytes(data), float(heading)), got_estimate)

        host.fetch(href, got_image, prefer_cache=True)

    def _birdeye_tilt_done(self, pic, before):
        """Analyse d'une photo de la vue du dessus finie : la page est prévenue même sans inclinaison
        nouvelle (_on_tilt se tait alors : verticales et LiDAR en échec), sinon elle attend la photo
        sans fin."""
        if self.calibration.auto.get(pic) == before:
            self.notify()
        else:
            self._on_tilt(pic, before)

    def birdeye_neighbours(self, items_json):
        """Photos voisines de la vue du dessus (fiches STAC, photo précédente puis suivante) : leur
        inclinaison est lancée à part, chacune son vérificateur (TiltChecker n'en suit qu'une)."""
        self.birdeye_items = json.loads(items_json)

        def runner(pic):
            def got(res, done):
                if res and res.get("loose"):
                    self._set_loose(pic, res["loose"])
                done(None if res is None or "reason" in res else res)
            return lambda function, args, done: web_host.run_task(web_tilt.estimate, args, lambda res: got(res, done))

        for item, checker in zip(self.birdeye_items, self.birdeye_checks):
            pic = item.get("id")
            checker.run = runner(pic)
            before = self.calibration.auto.get(pic)
            checker.check(item, self.calibration, lambda pic=pic, before=before: self._birdeye_tilt_done(pic, before))
            self._birdeye_relook(item)

    def birdeye_far(self, items_json):
        """Photos à deux pas de la vue du dessus (fiches STAC, avant la précédente et après la suivante) : leur raccord à
        la photo affichée sert seulement à lire le tangage (src/dessus.js, learnPitch), inclinées par la route, sans
        inclinaison lancée pour elles."""
        self.birdeye_far_items = json.loads(items_json)

    def _birdeye_of(self, item, pending):
        """Pose d'une photo pour la vue du dessus (voir birdeye_pose), ou None sans position, sans
        cap ou hors 360°."""
        heading = self._heading_of(item)
        if not autotilt.is_360(item) or heading is None:
            return None
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        except (KeyError, TypeError, ValueError):
            return None
        pic, sequence, cal, q = item.get("id"), item.get("collection"), self.calibration, self.quality or {}
        # Ce que la photo donne elle-même (photo_only) : ni le réglage de la vue du dessus, ni le roulis par défaut de la campagne, qu'elle ajoute
        # elle-même (groundUp, src/dessus.js) ; les verticales à seuil élargi sont choisies ci-dessous
        fixed, pose, cam = cal.position(sequence, lon, lat), cal.pose(sequence, lon, lat), cal.camera(sequence)
        tilt = cal.tilt(pic, photo_only=True)
        loose = None if pic in cal.auto_off else self.birdeye_loose.get(pic)  # (écartées par l'utilisateur : aucune) verticales moins sûres : mieux que la pente de la route, ou que le relais par le
        if loose and (not tilt or loose["sigma"] < tilt["sigma"]):  # terrain (±0,5°, sans le véhicule penché en virage)
            tilt = loose
        verified = q.get("precise") and q.get("lidar") is True
        height, source, _ = self.camera_of(item, self.quality, mount=False)  # sans monture : la page la lit dans pose.mount (profil)
        rtk = q.get("height") if verified and q.get("height") is not None \
            and measures.CAMERA_RANGE[0] <= q["height"] <= measures.CAMERA_RANGE[1] else None  # écart RTK − sol de la photo (borne)
        return {"pic": pic, "lon": fixed[0] if fixed else lon, "lat": fixed[1] if fixed else lat,
                "heading": float(heading), "offset": pose["offset"] if pose else 0.0,
                "up": list(tilt["up"]) if tilt else None,
                "sigma": tilt["sigma"] if tilt else calibration.UNCALIBRATED,
                "pending": pending(pic), "height": height, "height_source": source, "rtk_height": rtk,
                "height_sigma": cam["sigma"] if cam else max(q.get("spread") or 0, 0.05) if verified else 0.3,
                "relative_sigma": 0.05 if verified else 0.3,  # position d'une photo à sa voisine (trajectoire)
                "fleet": any(p.get("id") == self.FLEET_PRODUCER for p in item.get("providers") or []),
                "roll_defect": self._roll_defect(item), "roll_share": self.ROLL_SHARE,
                "pitch_default": self._pitch_default(item)[0], "pitch_default_sigma": self._pitch_default(item)[1], "mount": self._fleet_mount(item),
                "mounts": sorted({p["height"] for p in web_profils.producer_profiles(self.FLEET_PRODUCER)}),  # montures possibles du CD21 (hors campagne connue)
                "mount_sigma": (self._mount_height(item) or (None, web_profils.fleet_height_sigma(self.FLEET_PRODUCER)))[1], "profile": self._profile_info(item)}

    def birdeye_impossible(self, pic):
        """Vrai si la photo affichée est `pic` et n'a pas de pose Bird Eye possible (pas 360°, ni cap, ni position) : le calage
        de la largeur n'a alors rien à attendre (src/resultats.js). Faux si une autre photo est affichée (pas encore prête)."""
        return bool(self.item and self.item.get("id") == pic and self._birdeye_of(self.item, lambda _pic: False) is None)

    def birdeye_pose(self):
        """Pose de la photo affichée pour la vue du dessus (src/dessus.js), en JSON : position
        (recalée si la séquence l'est), cap du centre de l'image, correction de cap de la séquence
        (degrés), verticale vraie vue de la caméra (None sans calage) et son incertitude (degrés),
        hauteur de caméra, son incertitude et celle de la position relative entre photos voisines (m) ;
        neighbours : les poses des photos voisines ; far : celles à deux pas (birdeye_far) ; flat : sol supposé plat (pont marqué ou à moins de roads.BRIDGE_FLAT_RADIUS, None en lecture) ; bridge : la photo
        affichée est marquée « sur un pont » par le cœur (mark_bridge, BD TOPO ; None en lecture) : la vue se passe alors du terrain
        LiDAR (tablier supposé plat). Chaque photo marquée (voisines comprises) a une hauteur de caméra sans le sol LiDAR. Photo non
        marquée (remblai, approche) : terrain LiDAR gardé, sauf sous l'emprise d'un pont voisin (deck : axes en mètres autour de
        la photo, deck_half : demi-largeur, roads.DECK_HALF_WIDTH). null si la photo ne convient pas."""
        pose = self._birdeye_of(self.item, self.tilts.pending) if self.item else None
        if pose is None:
            return "null"
        poses = [(self._birdeye_of(item, checker.pending), item) for item, checker in zip(self.birdeye_items, self.birdeye_checks)]
        near = [self._deck_height(p, item) for p, item in poses if p]
        bridge = self.mark_bridge(self.item)  # marquage de la photo par le cœur (BD TOPO) : seul le tablier est supposé plan
        pose = self._deck_height(pose, self.item)
        poses = [(self._birdeye_of(item, lambda pic: False), item) for item in self.birdeye_far_items]
        far = [self._deck_height(p, item) for p, item in poses if p]
        flat = self._flat_ground(pose) if bridge is False else bridge
        deck = [] if flat is not False else self._deck_lines(pose)
        return json.dumps(dict(pose, neighbours=near, far=far, bridge=bridge, flat=flat, flat_radius=roads.BRIDGE_FLAT_RADIUS, deck=deck, deck_half=roads.DECK_HALF_WIDTH))

    def _flat_ground(self, pose):
        """Sol supposé plat sous la photo (pont à roads.BRIDGE_FLAT_RADIUS m ou moins, avant, sur ou après l'ouvrage : le relief
        y donne le fond de la vallée, pas le tablier) : vrai ou faux ; None pendant la lecture des tronçons ou BD TOPO injoignable
        (vue refaite à leur arrivée, comme le marquage « sur un pont »)."""
        sections = self.roads.sections(pose["lon"], pose["lat"])
        if sections is roads.PENDING or sections is None:
            return None
        return roads.flat_ground(sections, pose["lon"], pose["lat"])

    def _deck_height(self, pose, item):
        """Pose d'une photo marquée sur un pont (mark_bridge) : hauteur de caméra sans le sol LiDAR (altitude RTK moins le sol
        sous le pont, ou la brèche sous la photo)."""
        if not self.mark_bridge(item):
            return pose
        cam, mount = self.calibration.camera(item.get("collection")), self._fleet_mount(item)
        return dict(pose, **({"height": cam["height"], "height_sigma": cam["sigma"]} if cam
                             else {"height": mount, "height_sigma": self._mount_height(item)[1]} if mount
                             else {"height": self.tool.camera_height, "height_sigma": 0.3}))

    BIRDEYE_DECK_SCAN = 40.0  # m : emprises de pont transmises à la vue (±25 m de terrain lu sur les lignes, soit 35 m dans les coins)

    def _deck_lines(self, pose):
        """Emprises des ponts voisins d'une photo non marquée (remblai, approche) : axes en mètres (est, nord) autour de la
        photo, dans le sens de sa séquence (roads.deck_lines). La vue de dessus en écarte les points du terrain LiDAR (sol sous
        l'ouvrage) ; liste vide si la BD TOPO n'a pas répondu."""
        sections = self.roads.sections(pose["lon"], pose["lat"])
        if not sections or sections is roads.PENDING:
            return []
        return [[list(p) for p in line] for line in roads.deck_lines(sections, pose["lon"], pose["lat"], pose["heading"],
                                                                      self.BIRDEYE_DECK_SCAN)]

    # Producteur et profils de campagne datés (hauteur de caméra par monture, défaut de roulis : py/web_profils.py, CAMPAIGN_PROFILES)
    FLEET_PRODUCER = web_profils.FLEET_PRODUCER  # CD21 : imajbox sur Clio 5, deux montures (pose « mounts », src/dessus.js)
    # Colonne camera_calee de l'export des mesures : 0 réglage, 1 calée, 2 altitude GPS (measures.CAMERA_SOURCES), 3 monture
    CAMERA_CODES = {**measures.CAMERA_SOURCES, "monture": 3}
    # Provenance de la hauteur de caméra dans les textes (camera_of) : l'altitude GPS est un écart RTK − sol LiDAR, pas une mesure
    CAMERA_LABELS = {"altitude GPS": "écart RTK − sol LiDAR", "calée": "calée", "monture": "monture du CD21 d'après la date", None: "réglage"}

    def _camera_used(self, item):
        """Hauteur de caméra retenue pour la photo (camera_of) à donner à la page : { height, source, text }. Le texte est l'infobulle du
        réglage « Hauteur de caméra » (#59) : d'où vient la hauteur. Le champ n'est actif que si la source est le réglage (None) : tout
        le reste de l'application (mesures de la séquence, profil en long, repères, export) prend cette même hauteur, le réglage
        seulement en dernier rang (et pour la chute sur un pont sans hauteur connue, « Calculer avec le réglage »)."""
        height, source, _ = self.camera_of(item, self.quality)
        profile = self._profile(item) if source == "monture" else None
        origin = {"monture": "profil {}".format(profile["label"]) if profile else "monture", "calée": "calée pour la séquence",
                  "altitude GPS": "écart RTK − sol LiDAR, une borne", None: "réglage"}[source]
        return {"height": round(height, 3), "source": source,
                "text": "Hauteur utilisée pour cette photo : {} m ({}). {}".format(
                    measures._num(height, 2), origin,
                    "Ce réglage sert pour elle : modifiez-le si la hauteur est connue." if source is None
                    else "Ce réglage ne sert pas pour cette photo (grisé) : il ne sert que pour une photo sans hauteur calée, "
                         "de monture connue ni d'écart RTK − sol.")}

    def _profile(self, item):
        """Profil de campagne de la photo à sa date de prise de vue (web_profils.profile_of), ou None."""
        return web_profils.profile_of(item)

    def _fleet_mount(self, item):
        """Hauteur de la monture du CD21 d'après le profil de campagne de la photo (date de prise de vue), ou None."""
        profile = self._profile(item)
        return profile["height"] if profile else None

    def _mount_height(self, item):
        """Monture du CD21 d'après le profil de campagne : (hauteur, incertitude), ou None (voir Session.camera_of)."""
        profile = self._profile(item)
        return (profile["height"], profile["height_sigma"]) if profile else None

    def _roll_defect(self, item):
        """Défaut de roulis (degrés) du profil de campagne de la photo à sa date de prise de vue, ou 0."""
        profile = self._profile(item)
        return profile["roll"] if profile else 0.0

    def _pitch_default(self, item):
        """(tangage par défaut de la caméra en degrés, incertitude ou None) du profil de campagne de la photo, ou (0.0, None) : positif =
        caméra relevée vers l'avant par rapport à la route (convention de la réglette de tangage de src/dessus.js). Appliqué seulement
        quand aucun tangage n'est lu (rang 6 de Calibration.tilt, vue du dessus par la route seule : pose « pitch_default »), jamais
        ajouté à un tangage lu sur les raccords, les verticales ou les clics, ni à un réglage à la main."""
        return web_profils.pitch_of(self._profile(item))

    def _pitch_label(self, item):
        """Tangage du rang 6 en clair : « tangage inconnu », ou « tangage +0,7° de la campagne (profil) » avec un profil qui en donne un."""
        pitch, sigma = self._pitch_default(item)
        if sigma is None:
            return "tangage inconnu"
        return f"tangage {'+' if pitch > 0 else ''}{measures._num(pitch, 1)}° de la campagne (profil, ±{measures._num(sigma, 1)}°)"

    def _pitch_known(self, item):
        """« , tangage +0,7° de la campagne (profil, ±0,3°) » si le profil donne un tangage, sinon « » (texte d'attente de la ligne d'état)."""
        return "" if self._pitch_default(item)[1] is None else ", " + self._pitch_label(item)

    def _profile_info(self, item):
        """Profil de la photo pour la page (pose Bird Eye « profile », panneau de calage) : id, label, first, end (jour exclu),
        method, provenance ; None sans profil."""
        profile = self._profile(item)
        return {k: profile[k] for k in ("id", "label", "first", "end", "method", "provenance")} if profile else None

    # Part du dévers de la route prise en roulis du véhicule (le tangage suit la pente entière) : comme ROLL_SHARE de src/dessus.js, qui la
    # lit dans la pose Bird Eye (roll_share). Le défaut CD21 2025 (profil de campagne, +1°) a été estimé avec 70 % du dévers.
    ROLL_SHARE = 0.7

    def _cross_slope(self, pic):
        """(dévers du LiDAR HD sous la photo en degrés, positif : droite plus haute, ou None ; raison si None). Écarté : pas d'entrée
        automatique, pas de LiDAR, terrain RGE ALTI ou d'origine inconnue (entrée d'une version précédente), photo sur un pont (le sol
        sous l'ouvrage n'est pas la route : Calibration.bridge_pics, case « Sur un pont »)."""
        cal = self.calibration
        entry = cal.auto.get(pic)
        if pic in cal.bridge_pics or not cal.lidar:
            return None, "photo sur un pont"
        if not entry or not entry.get("lidar"):
            return None, "pas de LiDAR sous la photo"
        if entry.get("lidar_source") != "LiDAR HD":
            return None, "terrain RGE ALTI" if entry.get("lidar_source") == "RGE ALTI" else "terrain de source inconnue"
        return float(entry["lidar"][1]), ""

    def _roll_parts(self, item, pic):
        """(défaut de campagne en degrés, roulis dû au dévers en degrés ou None, raison de l'absence du dévers) ; convention du véhicule
        (positif : penché à droite). Le dévers : -atan(ROLL_SHARE * tan(dévers)), une route qui monte vers la droite penche le véhicule à
        gauche (même signe que groundUp de src/dessus.js)."""
        defect = self._roll_defect(item) if item else 0.0
        cross, why = self._cross_slope(pic)
        if cross is None:
            return defect, None, why
        return defect, 0.0 - math.degrees(math.atan(self.ROLL_SHARE * math.tan(math.radians(cross)))), ""

    def _roll_default(self, item, pic):
        """Roulis du véhicule par défaut (degrés, positif : penché à droite) = défaut du profil de campagne + part du dévers du LiDAR
        HD (_roll_parts) ; rang 6 de Calibration.tilt (_campaign_tilt)."""
        defect, share, _ = self._roll_parts(item, pic)
        return defect + (share or 0.0)

    def _roll_label(self, item, pic=None):
        """Nom du roulis par défaut de la photo : « roulis par défaut (70 % du dévers + campagne 2025) » ; sans défaut de campagne, « roulis
        par défaut (70 % du dévers) » ; sans dévers, « roulis par défaut de la campagne 2025 seul » (année de début du profil de campagne
        qui s'applique ; sans entrée, « roulis par défaut de la campagne seul »)."""
        item = item or {}
        pic = pic or item.get("id")
        profile = self._profile(item)
        year = profile["first"][:4] if profile else ""
        share = self._roll_parts(item, pic)[1]
        part = f"{round(self.ROLL_SHARE * 100)} % du dévers"
        if share is None:
            return ("roulis par défaut de la campagne " + year).strip() + " seul"
        return f"roulis par défaut ({part} + campagne {year})" if year else f"roulis par défaut ({part})"

    def _roll_why(self, item):
        """Raison, entre parenthèses, de l'absence du dévers dans le roulis par défaut (voir _cross_slope), ou « »."""
        _, share, why = self._roll_parts(item, (item or {}).get("id"))
        return f" (dévers écarté : {why})" if share is None and why else ""

    # Sources d'inclinaison de l'hôte, rangées par Calibration.tilt (ordre unique des mesures et de la largeur dans la visionneuse)
    def _item_of(self, pic):
        """Fiche de la photo pic : affichée, déjà visée ou cliquée, voisine ou de la vue du dessus ; None sinon."""
        if (self.item or {}).get("id") == pic:
            return self.item
        found = self.photo_items.get(pic) or self.neighbours.get(pic)
        return found or next((i for i in self.birdeye_items + self.birdeye_far_items if i.get("id") == pic), None)

    def _ground_tilt(self, pic):
        """Rang 1 : inclinaison que la vue du dessus applique à la photo (birdeye_tilt_set), roulis par défaut de la campagne compris."""
        ground = self.birdeye_ground.get(pic)
        if not ground or not ground.get("up"):  # sans « up » : la vue du dessus lit les verticales, seuls hauteur et sol sont gardés
            return None
        return calibration.tilt_entry(ground["up"], ground["sigma"],
                                      "vue du dessus (réglée à la main)" if ground["manual"] else "vue du dessus")

    def _route_tilt(self, pic):
        """Route de la vue du dessus pour la photo, annoncée même quand les verticales priment (birdeye_tilt_set, champ route) :
        témoin du terrain pour la confiance de l'inclinaison (Calibration.tilt_sources), jamais retenue par tilt."""
        route = (self.birdeye_ground.get(pic) or {}).get("route")
        if not route:
            return None
        return calibration.tilt_entry(route["up"], route["sigma"],
                                      "vue du dessus (réglée à la main)" if route["manual"] else "vue du dessus")

    CONFIDENCE_KEYS = ("state", "pair", "d_pitch", "d_roll", "limit_pitch", "limit_roll", "available")

    def tilt_confidence_of(self, pic, item=None):
        """Confiance de l'inclinaison retenue de la photo pic (Calibration.confidence) : dict state ("confirmee", "desaccord",
        "non_verifiable", "pont"), pair, d_pitch, d_roll, limit_pitch, limit_roll, available (noms des sources), retained
        (source, sigma, pitch, roll), roulis et d_roll dans la convention du véhicule (positif : penché à droite), ou None sans inclinaison retenue ni cap connu."""
        item = item or self._item_of(pic)
        heading = self._heading_of(item) if item else None
        if heading is None:
            return None
        got = self.calibration.confidence(pic, heading)
        if got:  # roulis du cœur -> véhicule (écart témoin - retenue : même changement de signe)
            got = {**got, "d_roll": roulis_vehicule_depuis_camera(got.get("d_roll"))}
            if got.get("retained"):
                got["retained"] = {**got["retained"], "roll": roulis_vehicule_depuis_camera(got["retained"].get("roll"))}
        return got

    def _loose_tilt(self, pic):
        """Rang 5 : verticales de la photo à l'incertitude plus grande que autotilt.MAX_SIGMA (birdeye_loose)."""
        loose = self.birdeye_loose.get(pic)
        return calibration.tilt_entry(loose["up"], loose["sigma"], "verticales (seuil élargi)") if loose else None

    def _campaign_tilt(self, pic):
        """Rang 6 : roulis par défaut (_roll_default : défaut de campagne + part du dévers du LiDAR HD ; None s'il vaut 0 sans dévers
        disponible, sauf tangage de campagne), tangage de la campagne (_pitch_default, 0 sans profil ; la pente de la route n'y est pas
        lue : incertitude UNCALIBRATED, au moins celle du roulis), le véhicule penché de ce roulis (positif : à
        droite) par rapport au cap de l'axe de la séquence (ou de la photo) ; le cœur le reçoit dans sa convention
        (roulis_vehicule_depuis_camera). Même effet que groundUp de src/dessus.js. Repérée par « fallback » : pas une inclinaison calée ;
        source « roulis de campagne » (famille « constante » : ni témoin du LiDAR, ni témoin contre lui)."""
        item = self._item_of(pic)
        defect, share, _ = self._roll_parts(item, pic)
        profile = self._profile(item)
        pitch, pitch_sigma = self._pitch_default(item)
        if not defect and share is None and not pitch:
            return None
        roll = defect + (share or 0.0)
        axis = self._axis(item)
        axis = self._heading_of(item) if axis is None else axis
        return calibration.tilt_entry(calibration.up_from_components(pitch, roulis_vehicule_depuis_camera(roll), axis or 0.0),
                                      max(calibration.UNCALIBRATED, profile["roll_sigma"] if profile else web_profils.ROLL_SIGMA_DEFAULT, pitch_sigma or 0.0),
                                      "roulis de campagne", fallback=True)

    def _set_loose(self, pic, loose):
        """Verticales à seuil élargi de la photo arrivées : mesures et visées qui en dépendent recalculées (rang 5)."""
        if self.birdeye_loose.get(pic) != loose:
            self.birdeye_loose[pic] = loose
            self._recompute({pic})

    def _terrain_of(self, item, done):
        """Terrain sous la photo item : done({slopes, heading}, None), ou done(None, raison). Grille
        LiDAR HD (web_terrain.grid_points), une requête."""
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
            heading = float(self._heading_of(item))
        except (KeyError, TypeError, ValueError):
            return done(None, "position ou cap de la photo inconnus")
        points = web_terrain.grid_points(lon, lat, heading)

        def got_ground(data, error):
            if error:
                return done(None, "service d'altitude injoignable")
            z = precision._ground(data)
            if not z or len(z) != len(points) or None in z:
                return done(None, "pas de LiDAR HD sous la photo")
            sections = self.roads.sections(lon, lat)
            if sections is roads.PENDING:  # tronçons en lecture : l'emprise d'un pont voisin n'est pas encore connue
                return self.roads.when_ready(lambda: got_ground(data, error))
            if sections:  # points sous l'emprise d'un pont voisin écartés (le terrain y est le sol sous l'ouvrage)
                z = [None if m else h for m, h in zip(roads.deck_mask(sections, lon, lat, heading, points), z)]
            found = web_terrain.slopes(z)
            if found is None:
                return done(None, "LiDAR HD sous l'ouvrage voisin : trop peu de points gardés")
            done({"slopes": found, "heading": heading}, None)

        host.fetch_json(precision.lidar_url(points, precision.LIDAR_RESOURCE), got_ground, timeout_ms=15000)

    def _sequence_model(self, item, done):
        """Modèle de la séquence de item (web_terrain.model) : done(modèle, None) ou done(None, raison).
        Cherché une fois par séquence, les demandes suivantes attendent le même calcul."""
        seq = item.get("collection")
        s = self.relay_models.get(seq)
        if s is None:
            s = self.relay_models[seq] = {"waiting": [done], "refs": [], "tried": 0, "zones": None}
            self._find_refs(item, s)
        elif "waiting" in s:
            s["waiting"].append(done)
        else:
            done(s["model"], s["reason"])

    def _find_refs(self, item, s):
        """Références de la séquence (s, voir _sequence_model) : jusqu'à RELAY_PER_ZONE photos par zone
        d'habitation (réparties dans la zone), des zones les plus proches aux plus lointaines, calées
        par leurs verticales, jusqu'à web_terrain.MIN_REFS réussies ou RELAY_TRIES analysées."""
        lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        seq = item.get("collection")

        def progress():
            text = "photos de référence : {} calée{} sur {} analysée{}".format(
                len(s["refs"]), "s" if len(s["refs"]) > 1 else "", s["tried"], "s" if s["tried"] > 1 else "")
            for p in self.relay_pending:
                self.relay_pending[p] = text
            self.notify()

        def finish(reason):
            s["model"] = web_terrain.model(s["refs"])
            s["reason"] = None if s["model"] else reason
            for cb in s.pop("waiting"):
                cb(s["model"], s["reason"])

        queue = []  # photos de la zone en cours, à analyser

        def next_zone():
            if len(s["refs"]) >= web_terrain.MIN_REFS:
                return finish(None)
            if queue and s["tried"] < self.RELAY_TRIES:
                return analyse(queue.pop(0))
            if s["tried"] >= self.RELAY_TRIES or not s["zones"]:
                return finish("{} photo{} de village calée{} sur {} (il en faut {})".format(
                    len(s["refs"]), "s" if len(s["refs"]) > 1 else "", "s" if len(s["refs"]) > 1 else "",
                    s["tried"], web_terrain.MIN_REFS))
            ring, (clon, clat) = s["zones"].pop(0)
            host.fetch_json(metadata.search_url(clon, clat, self.RELAY_ZONE, 100, seq, host.api_url),
                            lambda data, error: got_photos(ring, clon, clat, data, error), timeout_ms=15000)

        def got_photos(ring, clon, clat, data, error):
            feats = [f for f in ([] if error else (data or {}).get("features") or [])
                     if f.get("collection") == seq and f.get("id") != item.get("id")
                     and _inside(f["geometry"]["coordinates"][:2], ring)]
            feats.sort(key=lambda f: math.hypot(f["geometry"]["coordinates"][0] - clon,
                                                f["geometry"]["coordinates"][1] - clat))
            n = self.RELAY_PER_ZONE
            queue[:] = [feats[k * len(feats) // n] for k in range(n) if k * len(feats) // n < len(feats)]
            queue[:] = [f for k, f in enumerate(queue) if f not in queue[:k]]
            next_zone()

        def analyse(f):
            href = ((f.get("assets") or {}).get("hd") or {}).get("href")
            if not href:
                return next_zone()
            s["tried"] += 1
            progress()
            host.fetch(href, lambda data, error: got_image(f, data, error), prefer_cache=True)

        def got_image(f, data, error):
            if error or not data:
                return next_zone()
            heading = float(self._heading_of(f))
            web_host.run_task(web_tilt.estimate, (bytes(data), heading), lambda res: got_verticals(f, heading, res))

        def got_verticals(f, heading, res):
            if not res or "reason" in res:
                return next_zone()
            forward, right = calibration.tilt_components(res["up"], heading)

            def got_ground(entry, reason):
                if entry is not None:
                    s["refs"].append(dict(entry, forward=forward, right=right))
                    progress()
                next_zone()
            self._terrain_of(f, got_ground)

        def got_zones(data, error):
            if error:
                return finish("BD TOPO injoignable (zones d'habitation)")
            zones = []
            for z in (data or {}).get("features") or []:
                if (z.get("properties") or {}).get("nature") not in self.RELAY_NATURES:
                    continue
                g = z.get("geometry") or {}
                polys = g.get("coordinates") or []
                ring = max((p[0] for p in (polys if g.get("type") == "MultiPolygon" else [polys]) if p), key=len,
                           default=None)
                if ring:
                    c = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
                    zones.append((ring, c))
            zones.sort(key=lambda z: math.hypot((z[1][0] - lon) * math.cos(math.radians(lat)), z[1][1] - lat))
            s["zones"] = zones
            next_zone()

        dlat = self.RELAY_RADIUS / 111320.0
        dlon = dlat / max(math.cos(math.radians(lat)), 0.01)
        url = roads.WFS_URL + "?" + urlencode({
            "SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature", "TYPENAMES": "BDTOPO_V3:zone_d_habitation",
            "OUTPUTFORMAT": "application/json", "SRSNAME": "EPSG:4326", "COUNT": 500,
            "BBOX": "{},{},{},{},urn:ogc:def:crs:EPSG::4326".format(lat - dlat, lon - dlon, lat + dlat, lon + dlon)})
        host.fetch_json(url, got_zones, timeout_ms=20000)
