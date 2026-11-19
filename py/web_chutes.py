# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Hauteurs de chute et dévers, sortis de web_app.py : sur un pont (ticket #15) et sur les bords de route hors pont
(ticket #31), avec leurs utilitaires (ponts de la BD TOPO, profil de la plateforme, noms des voies et de l'eau).
Chutes est une base de web_app.App : ses méthodes lisent l'état de l'application (self)."""

import json
import math
import re
import time

from core import host, measures, metadata, precision, roads, tools, triangulation


# Mots laissés en minuscules dans un nom remis en forme (sauf au début) : « Pont de France »
_SMALL_WORDS = {"de", "du", "des", "la", "le", "les", "et", "en", "sur", "sous", "aux", "à"}


def _bridge_name(text):
    """Nom de pont tiré du nom d'un tronçon BD TOPO en majuscules (« PONT DE FRANCE » -> « Pont de
    France »), ou None s'il ne nomme pas un ouvrage (nom de la rue qui passe dessus)."""
    words = (text or "").strip().lower().split()
    if not words or words[0] not in ("pont", "viaduc", "passerelle"):
        return None
    return _title(words)


def _title(words, first=True):
    """Mots en minuscules remis en forme d'un nom : capitales sauf petits mots (_SMALL_WORDS)."""
    def word(w, first):
        if "'" in w:  # d'or -> d'Or
            head, tail = w.split("'", 1)
            return (head.capitalize() if first else head) + "'" + word(tail, False)
        if not first and w in _SMALL_WORDS:
            return w
        return "-".join(part.capitalize() for part in w.split("-"))

    return " ".join(word(w, first and k == 0) for k, w in enumerate(words))


# Voies de la BD TOPO (nom en abréviations, « R DE PARIS ») : nom en clair, avec son article
_STREETS = {"R": "la rue", "AV": "l'avenue", "BD": "le boulevard", "CHE": "le chemin", "CHEM": "le chemin",
            "RTE": "la route", "PL": "la place", "IMP": "l'impasse", "ALL": "l'allée", "QU": "le quai",
            "QUAI": "le quai", "CRS": "le cours", "PROM": "la promenade", "FG": "le faubourg", "VC": "la voie communale"}


def _road_label(name):
    """Route franchie, avec son article : « l'A6 », « la D905 », « la rue de Paris », sinon « une route »."""
    if re.match(r"[A-Z]+\d", name or ""):
        return ("l'" if name[0] in "AEIOUY" else "la ") + name
    words = (name or "").split()
    if len(words) > 1 and name.isupper() and words[0] in _STREETS:
        return _STREETS[words[0]] + " " + _title([w.lower() for w in words[1:]], first=False)
    return "une route"


# Cours d'eau nommés sans article par la BD TOPO (« Canal de Bourgogne ») : genre du nom commun
_WATERS = {"canal": "le", "ruisseau": "le", "bief": "le", "fossé": "le", "fleuve": "le", "torrent": "le",
           "ru": "le", "rû": "le", "bras": "le", "déversoir": "le", "aqueduc": "le", "étang": "le",
           "rivière": "la", "rigole": "la", "noue": "la", "dérivation": "la", "ravine": "la", "source": "la"}


def _water_label(name):
    """Cours d'eau franchi, avec son article : « l'Armançon » (déjà dans la BD TOPO), « le canal de
    Bourgogne », « la rivière … », « l'étang … » ; sans nom commun connu, le nom tel quel."""
    article = re.match(r"(l'|la |le |les )", name, re.IGNORECASE)
    if article:  # article en minuscule en milieu de phrase : « de la Vouge »
        return article.group(1).lower() + name[article.end():]
    first, _, rest = name.partition(" ")
    article = _WATERS.get(first.lower())
    if article is None:
        return name
    noun = first.lower() + (" " + rest if rest else "")
    return ("l'" if noun[0] in "aeiouyéèêh" else article + " ") + noun


def _of(label):
    """« de » devant un nom avec article : de l'Armançon, de la D905, du chemin…, d'une route ; d'Ouche."""
    for article, of in (("le ", "du "), ("les ", "des "), ("un ", "d'un "), ("une ", "d'une ")):
        if label.startswith(article):
            return of + label[len(article):]
    if label[:1].lower() in "aeiouyéèêh" and not label.startswith("l'"):
        return "d'" + label  # nom propre sans article : d'Ouche
    return "de " + label


def _distance(metres, whole=False):
    """Distance au bord écrite : au décimètre sous 10 m, au mètre au-delà (ou si whole), arrondie au plus proche comme dans
    la page (profil.js, dist) : « 0,5 m » et non « 0 m », « 11 m » pour 10,5 et non « 10 m » (format arrondit au pair)."""
    digits = 0 if whole or metres >= 9.95 else 1
    return measures._num(math.floor(metres * 10 ** digits + 0.5) / 10 ** digits, digits)


def _line_slope(points):
    """Pente (%, positive si le terrain descend vers les x croissants) de la droite des moindres carrés, ou None sous 3 points."""
    if len(points) < 3:
        return None
    mx, mz = sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)
    sxx = sum((p[0] - mx) ** 2 for p in points)
    return -100 * sum((p[0] - mx) * (p[1] - mz) for p in points) / sxx if sxx else None


def _spread(values):
    """Écart type des valeurs."""
    mean = sum(values) / len(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / len(values))


PLATFORM_MIN_CROSSINGS = 3  # travers exploitables au moins


PLATFORM_SPREAD = 1.0  # points : écart entre travers au-delà duquel le dévers n'est pas déterminé


PLATFORM_SIDE_MIN = 0.8  # points : moitiés de sens opposés seulement si chacune penche au moins de cela


PLATFORM_TWIN_GAP = 1.0  # points : chaussées séparées : un chiffre par chaussée dès cet écart


PLATFORM_ROOF_GAP = 1.0  # points : toit symétrique, pente moyenne affichée, jusqu'à cet écart entre ses deux pentes


def platform_slope(drawn):
    """Dévers de la plateforme (ticket #38) d'après les travers du profil (entrées de App._compute_edges), en %, positif
    s'il descend vers la droite : droite ajustée sur chaque moitié (chaque chaussée, séparateur exclu) et sur l'ensemble,
    moyennées sur les travers. Retourne {"type": ...} : "sens" (pente), "toit" (pente moyenne, gauche, droite), "demi"
    (gauche, droite) ou "indetermine" : travers trop différents (voir docs/CALCULS.md, 8.7)."""
    crossings = {}
    for entry in drawn:
        sign = -1 if entry["cote"] == "gauche" else 1
        c = crossings.setdefault(entry["le_long"], {"points": set(), "edges": {}, "between": None})
        c["points"].update((sign * o, z) for o, z in entry["points"])
        c["edges"][entry["cote"]] = sign * entry["bord"]
        if entry.get("separateur"):
            c["between"] = sorted(sign * v for v in entry["separateur"])
    whole, left, right, twin = [], [], [], False
    for c in crossings.values():
        if len(c["edges"]) < 2:
            continue
        low, high = c["edges"]["gauche"], c["edges"]["droit"]
        twin = twin or bool(c["between"])
        a, b = c["between"] or ((low + high) / 2, (low + high) / 2)
        points = [p for p in c["points"] if low <= p[0] <= high]
        slopes = (_line_slope([p for p in points if p[0] <= a or p[0] >= b]), _line_slope([p for p in points if p[0] <= a]),
                  _line_slope([p for p in points if p[0] >= b]))
        if None not in slopes:
            whole.append(slopes[0])
            left.append(slopes[1])
            right.append(slopes[2])
    if len(whole) < PLATFORM_MIN_CROSSINGS:
        return {"type": "indetermine"}
    mean = lambda values: sum(values) / len(values)
    s, g, d = mean(whole), mean(left), mean(right)
    opposed = g * d < 0 and min(abs(g), abs(d)) >= PLATFORM_SIDE_MIN
    if opposed or (twin and abs(g - d) >= PLATFORM_TWIN_GAP):
        if max(_spread(left), _spread(right)) > PLATFORM_SPREAD:
            return {"type": "indetermine"}
        sides = {"gauche": round(g, 2), "droite": round(d, 2)}
        if opposed and g < 0 < d and abs(abs(g) - abs(d)) <= PLATFORM_ROOF_GAP:  # chaque moitié descend vers son bord
            return dict(sides, type="toit", pente=round((abs(g) + abs(d)) / 2, 2))
        return dict(sides, type="demi")
    if _spread(whole) > PLATFORM_SPREAD:
        return {"type": "indetermine"}
    return {"type": "sens", "pente": round(s, 2)}


def _ign_bridges(data):
    """Ponts nommés de la BD TOPO (constructions linéaires de nature « Pont ») : [(ligne, nom)]."""
    out = []
    for feat in data.get("features") or []:
        props, geom = feat.get("properties") or {}, feat.get("geometry") or {}
        if props.get("nature") == "Pont" and props.get("toponyme"):
            coords = geom.get("coordinates") or []
            for line in coords if geom.get("type") == "MultiLineString" else [coords]:
                out.append(([tuple(p[:2]) for p in line], props["toponyme"]))
    return out


# Natures de la BD TOPO : nom d'une voie sans numéro ni nom (roads.parse_sections) ; ces voies ne sont pas citées aux carrefours
_WAY_KINDS = {"Route à 1 chaussée": "une route", "Route à 2 chaussées": "une route", "Route empierrée": "un chemin empierré",
              "Chemin": "un chemin", "Sentier": "un sentier", "Rond-point": "un rond-point", "Bretelle": "une bretelle",
              "Type autoroutier": "une voie rapide", "Piste cyclable": "une piste cyclable", "Escalier": "un escalier"}


def _deck_at(decks, x, y):
    """Altitude du tablier en (x, y) (repère local, m) d'après les photos de la séquence prises sur le pont, decks
    [(x, y, altitude, rang)] : point ramené sur le segment le plus proche entre deux photos consécutives (rangs) et
    altitude interpolée entre elles (pont long et pentu) ; une seule photo : son altitude."""
    path = sorted(decks, key=lambda d: d[3])
    if len(path) == 1:
        return path[0][2]
    best = None
    for a, b in zip(path, path[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        u = max(0.0, min(1.0, ((x - a[0]) * dx + (y - a[1]) * dy) / ((dx * dx + dy * dy) or 1.0)))
        d = math.hypot(a[0] + u * dx - x, a[1] + u * dy - y)
        if best is None or d < best[0]:
            best = (d, a[2] + u * (b[2] - a[2]))
    return best[1]


def _crossing(a, b, c, d):
    """Point (x, y) où les segments [a, b] et [c, d] se coupent ou se touchent (sommet commun : la BD TOPO
    en met un au croisement de deux niveaux), ou None (pas de contact, ou parallèles)."""
    den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])
    if not den:
        return None
    t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den
    u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den
    eps = 1e-9
    return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])) if -eps <= t <= 1 + eps and -eps <= u <= 1 + eps else None


def _nearest_name(bridges, lon, lat, reach):
    """Nom du pont le plus proche de (lon, lat), à reach m au plus de sa ligne, ou None."""
    best = None
    for line, name in bridges or []:
        pts = [triangulation._local(p[0], p[1], lon, lat) for p in line]
        for (ax, ay), (bx, by) in zip(pts, pts[1:] or pts):  # distance du point (0, 0) au segment
            t = max(0.0, min(1.0, -(ax * (bx - ax) + ay * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 or 1.0)))
            d = math.hypot(ax + t * (bx - ax), ay + t * (by - ay))
            if d <= reach and (best is None or d < best[0]):
                best = (d, name)
    return best and best[1]


class Chutes:
    """Chutes sur un pont et bords de route (voir web_app.App)."""

    # Hauteur de chute sur un pont (ticket #15) ---------------------------------------------
    # m au-delà du bord de la chaussée, de chaque côté : du pied du garde-corps jusqu'au fond, à
    # l'écart du tablier (le MNT, interpolé sous lui, y descend en pente douce : ticket #27)
    FALL_SIDES = (1.0, 3.0, 6.0, 10.0)
    FALL_STEP = 2.0  # m entre deux travers le long du pont (plus si le pont est long)
    FALL_POINTS = 160  # points par requête au service d'altimétrie (longueur de l'adresse ; voir _terrain)
    FALL_MIN = 0.5  # m : en dessous, terrain non distingué du tablier (végétation, buse)
    FALL_WIDTH = 6.0  # m : largeur de chaussée supposée quand la BD TOPO ne la donne pas
    FALL_TOUCH = 1.0  # m : tronçons en pont bout à bout (un pont coupé en plusieurs tronçons)
    FALL_RETRY = 60.0  # s avant de refaire un calcul qui a échoué (service injoignable)
    FALL_LIDAR_REACH = 10.0  # m : dessous cherché à cette distance du tablier (DECK_REACH de src/nuage.js)
    FALL_NO_RTK = ("Hauteur de chute non calculée : la position GPS de cette séquence n'est pas vérifiée RTK. "
                   "L'altitude du tablier, tirée de l'altitude GPS de la caméra, serait fausse de plusieurs mètres.")

    def fall(self):
        """Photo prise sur un pont (BD TOPO) : hauteur de chute la plus grande sur toute la longueur du
        pont ({text, title}), son explication sans RTK vérifié, ou l'attente de son calcul ; hors d'un
        pont, chute et dévers des bords de la route (_edges, ticket #31). D'abord le nuage LiDAR HD (Nuage.bridgeFall, lu par la
        page : champ « lidar » ; use_bridge_lidar), même valeur sur tout le pont, sans GPS. Sans points classés pont, ou nuage
        illisible : tablier = altitude GPS RTK (NGF) moins hauteur de caméra, aux photos de la séquence
        prises sur le pont (la plus proche de chaque point) ; dessous : MNT LiDAR HD (RGE ALTI en
        secours), le point le plus bas en travers du pont, de 1 à 10 m au-delà du bord de la chaussée
        des deux côtés (FALL_SIDES : sous le tablier, le MNT est interpolé à sa hauteur)."""
        item = self.item or {}
        try:
            lon, lat = (float(v) for v in item["geometry"]["coordinates"][:2])
        except (KeyError, TypeError, ValueError):
            return None
        sections = self._fall_sections(lon, lat)
        if sections is None and item.get("id") in self.edges_asked:
            return {"text": "Bords de route\nCalcul impossible (BD TOPO injoignable)", "title": "", "edges": True}
        if not sections or sections is roads.PENDING:
            return None
        axis = self._axis(item)
        sec = roads.on_bridge(sections, lon, lat, metadata.item_heading(item) if axis is None else axis)
        if sec is None:
            return self._edges(item, sections, lon, lat)
        chain = self._bridge_chain(sections, sec)
        # Nom du pont (BD TOPO), et sa route : « Pont de France (D905) », sinon « Pont de la D111 »,
        # « Pont de l'A38 » (élision devant une voyelle)
        name = next((c["bridge_name"] for c in chain if c.get("bridge_name")), None) or self._named_bridge(lon, lat)
        road = next((c["name"] for c in chain if re.match(r"[A-Z]+\d", c.get("name") or "")), None)
        of_road = road and ("Pont de l'" if road[0] in "AEIOUY" else "Pont de la ") + road
        bridge = "{} ({})".format(name, road) if name and road else name or of_road or "Pont"
        over = self._crossed(chain, sections, lon, lat)  # « Au-dessus de l'Armançon », sous le nom
        bridge += "\n" + over if over else ""
        lidar_key = "{:.6f},{:.6f}".format(*min(p for c in chain for p in c["line"]))
        lidar = self.lidar_falls.get(lidar_key)
        if lidar is None or time.monotonic() >= lidar.get("retry_at", float("inf")):
            return {"text": bridge + "\nHauteur de chute : lecture du nuage LiDAR HD…", "title": "",
                    "lidar": {"key": lidar_key, "lon": lon, "lat": lat, "chain": [list(p[:2]) for c in chain for p in c["line"]]}}
        if "text" in lidar:
            return {"text": bridge + "\n" + lidar["text"], "title": lidar["title"]}
        if self.quality is None:
            return {"text": bridge + "\nHauteur de chute : vérification de la position GPS en cours…", "title": ""}
        if not self.quality.get("precise"):
            return {"text": bridge + "\n" + self.FALL_NO_RTK, "title": ""}
        camera = self._fall_camera()
        if camera is None:  # ni mesurée ni calée : le réglage, seulement si l'utilisateur l'accepte
            return {"text": bridge + "\nHauteur de chute : hauteur de caméra inconnue sur ce pont", "title": self.FALL_ASK,
                    "ask": "Calculer avec « Caméra à » ({} m)".format(measures._num(self.tool.camera_height, 2))}
        key = (item.get("collection"), min(p for c in chain for p in c["line"]), camera)
        res = self.falls.get(key)
        if res is None or time.monotonic() >= res.get("retry_at", float("inf")):
            res = self.falls[key] = {"text": "Hauteur de chute : calcul en cours…", "title": ""}
            self._compute_fall(key, chain, item, lon, lat)
        return {"text": bridge + "\n" + res["text"], "title": res["title"]}

    def use_bridge_lidar(self, key, answer):
        """Réponse de Nuage.bridgeFall pour le pont key (JSON) : { height, below } ; { none } : pas de points classés pont, ou
        { error } : nuage illisible (nouvel essai après FALL_RETRY s) ; dans ces deux cas, la méthode par l'altitude GPS."""
        found = json.loads(answer)
        if found.get("error"):
            self.lidar_falls[key] = {"retry_at": time.monotonic() + self.FALL_RETRY}
        elif found.get("none"):
            self.lidar_falls[key] = {}
        elif found.get("height") is None or found["height"] < self.FALL_MIN:
            self.lidar_falls[key] = {"text": "Hauteur de chute non mesurée : le terrain sous le pont ne se distingue "
                                             "pas du tablier (végétation, buse ?)", "title": ""}
        else:
            sigma = math.hypot(triangulation.LIDAR_ERROR, triangulation.LIDAR_ERROR)
            self.lidar_falls[key] = {
                "text": "Hauteur de chute max : {} m (±{} m), LiDAR".format(measures._num(found["height"], 1), measures._num(sigma, 1)),
                "title": ("Plus grande hauteur entre le tablier (points du nuage LiDAR HD classés pont) et {} sous le pont "
                          "ou à côté, jusqu'à {} m du tablier ; même valeur sur tout le pont. Au-dessus de l'eau : niveau "
                          "au relevé, pas le fond.").format("l'eau" if found["below"] == "eau" else "le sol",
                                                           measures._num(self.FALL_LIDAR_REACH, 0))}
        return self.status()

    # Hauteur de caméra du tablier : mesurée sur la séquence vérifiée (médiane de l'altitude RTK moins le sol LiDAR, photos du
    # pont écartées), sinon calée pour la séquence. Une photo de précision déclarée n'a que sa propre hauteur, altitude moins
    # le sol sous elle : sur un pont, le fond franchi (plausible encore sur un pont bas) ; le réglage « Caméra à » prend sa
    # place, seulement si l'utilisateur l'accepte (use_fall_setting)
    FALL_ASK = ("La hauteur de caméra n'est ni mesurée sur la séquence (précision déclarée dans la photo : sa hauteur est "
                "prise au-dessus du sol sous elle, ici le fond franchi) ni calée. Le calcul peut utiliser le réglage "
                "« Caméra à » : la hauteur de chute en dépend directement.")
    fall_setting = False  # l'utilisateur accepte le réglage « Caméra à » pour la hauteur de chute

    def _fall_camera(self):
        """(hauteur de caméra en m, sa source, son incertitude en m) pour le tablier, ou None (à demander) : mesurée sur la
        séquence, calée, monture du CD21 d'après la date, sinon le réglage si l'utilisateur l'accepte (camera_of)."""
        h, source, sigma = self.camera_of(self.item, self.quality, sequence_only=True)
        if source is None and not self.fall_setting:
            return None
        return round(h, 3), {"altitude GPS": "séquence", None: "réglage"}.get(source, source), sigma

    def use_fall_setting(self):
        """Bouton de l'encadré du pont : la hauteur de chute utilise le réglage « Caméra à » (pour la session)."""
        self.fall_setting = True
        return self.status()

    def _fall_sections(self, lon, lat):
        """Tronçons BD TOPO de la maille du point, avec leur largeur de chaussée (« width », m ou None),
        lus ici : ceux du cœur (roads) ne la gardent pas. roads.PENDING pendant la lecture, None si la BD
        TOPO n'a pas répondu (shortcut: pas de nouvel essai avant le rechargement de la page ;
        réessayer après roads.RETRY s si des pannes de la Géoplateforme privent de hauteur de chute)."""
        cell = roads._cell(lon, lat)
        if cell in self.fall_cells:
            return self.fall_cells[cell]
        self.fall_cells[cell] = roads.PENDING

        def done(data, error):
            out = None
            if not error:
                out = []
                for feat in (data or {}).get("features") or []:
                    props = feat.get("properties") or {}
                    try:
                        width = float(props.get("largeur_de_chaussee"))
                    except (TypeError, ValueError):
                        width = None
                    out += [dict(sec, width=width if width and width > 0 else None,
                                 bridge_name=_bridge_name(props.get("nom_collaboratif_gauche")))
                            for sec in roads.parse_sections({"features": [feat]})]
            self.fall_cells[cell] = out
            self.notify()

        host.fetch_json(roads.wfs_url(cell), done, timeout_ms=15000)
        return self.fall_cells[cell]

    BRIDGE_REACH = 25.0  # m au plus entre la photo et le pont nommé (bord du tablier)
    CROSS_END = 2.0  # m : contact aussi près d'un bout du pont, raccordement et non franchissement

    def _named_bridge(self, lon, lat):
        """Nom du pont le plus proche de la photo (BRIDGE_REACH m au plus) quand le tronçon ne le nomme pas
        (il porte le nom de la rue) : ouvrage « Pont » de la BD TOPO (constructions linéaires), une requête
        par maille comme les tronçons ; None sinon, pendant la lecture ou si la BD TOPO n'a pas répondu."""
        found = self._bdtopo("construction_lineaire", roads._cell(lon, lat))
        return _nearest_name(_ign_bridges({"features": found or []}), lon, lat, self.BRIDGE_REACH)

    def _bdtopo(self, layer, cell):
        """Objets GeoJSON d'une couche de la BD TOPO dans la maille (et MARGIN m autour), lus comme les
        tronçons : liste, None pendant la lecture, [] si la BD TOPO n'a pas répondu (nouvel essai FALL_RETRY s après)."""
        key = (layer, cell)
        if key not in self.bdtopo or time.monotonic() >= self.bdtopo_retry.get(key, float("inf")):
            self.bdtopo[key] = None
            self.bdtopo_retry.pop(key, None)

            def done(data, error):
                self.bdtopo[key] = [] if error else (data or {}).get("features") or []
                if error:
                    self.bdtopo_retry[key] = time.monotonic() + self.FALL_RETRY
                if self.bdtopo[key]:
                    self.notify()

            host.fetch_json(roads.wfs_url(cell).replace("troncon_de_route", layer), done, timeout_ms=15000)
        return self.bdtopo[key]

    def _crossed(self, chain, sections, lon, lat):
        """Ce que le pont (chain) franchit, d'après la BD TOPO : cours d'eau, sinon voies ferrées et routes
        plus basses, dont la ligne croise la sienne ; « Au-dessus de l'Armançon », « Au-dessus de la voie
        ferrée et de la D905 », ou None (rien trouvé, ou lecture en cours)."""
        cell, level = roads._cell(lon, lat), max(c["level"] for c in chain)
        deck = [[triangulation._local(p[0], p[1], lon, lat) for p in c["line"]] for c in chain]
        ends = [p for seg in deck for p in (seg[0], seg[-1])]
        ends = [p for p in ends if sum(math.hypot(p[0] - q[0], p[1] - q[1]) < self.FALL_TOUCH for q in ends) == 1]

        def crosses(line):  # contact avec le pont ailleurs qu'à ses bouts (routes qui s'y raccordent)
            pts = [triangulation._local(p[0], p[1], lon, lat) for p in line]
            for seg in deck:
                for a, b in zip(seg, seg[1:]):
                    for c, d in zip(pts, pts[1:]):
                        x = _crossing(a, b, c, d)
                        if x and all(math.hypot(x[0] - e[0], x[1] - e[1]) > self.CROSS_END for e in ends):
                            return True
            return False

        def lines(feat):
            geom = feat.get("geometry") or {}
            coords = geom.get("coordinates") or []
            return coords if geom.get("type") == "MultiLineString" else [coords]

        def below(feat):
            try:
                return int((feat.get("properties") or {}).get("position_par_rapport_au_sol") or 0) < level
            except (TypeError, ValueError):
                return True

        labels = []
        for feat in self._bdtopo("troncon_hydrographique", cell) or []:
            if below(feat) and any(crosses(line) for line in lines(feat)):
                name = (feat.get("properties") or {}).get("cpx_toponyme_de_cours_d_eau")
                labels.append(_water_label(name) if name else "un cours d'eau")
        if not labels:  # cours d'eau franchi : lui seul (routes et voies ferrées des berges en plus)
            for feat in self._bdtopo("troncon_de_voie_ferree", cell) or []:
                if below(feat) and any(crosses(line) for line in lines(feat)):
                    labels.append("la voie ferrée")
            labels += [_road_label(sec["name"]) for sec in sections
                       if sec["level"] < level and sec not in chain and crosses(sec["line"])]
        labels = list(dict.fromkeys(labels))
        return "Au-dessus " + " et ".join(_of(x) for x in labels) if labels else None

    def _bridge_chain(self, sections, first):
        """Tronçons en pont bout à bout avec first : le pont entier."""
        chain = [first]
        grown = True
        while grown:
            grown = False
            ends = [p for c in chain for p in (c["line"][0], c["line"][-1])]
            for sec in sections:
                if sec["level"] > 0 and sec not in chain and any(
                        tools._metres(p, q) < self.FALL_TOUCH for p in (sec["line"][0], sec["line"][-1]) for q in ends):
                    chain.append(sec)
                    grown = True
        return chain

    def _compute_fall(self, key, chain, item, lon, lat):
        """Calcul de la hauteur de chute du pont (chain), rangé dans self.falls[key], puis notify() ; key[2] : hauteur de
        caméra (_fall_camera)."""
        camera, camera_source, camera_error = key[2]
        lines = [[triangulation._local(p[0], p[1], lon, lat) for p in c["line"]] for c in chain]
        total = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for line in lines for a, b in zip(line, line[1:]))
        step = max(self.FALL_STEP, 2 * len(self.FALL_SIDES) * total / self.FALL_POINTS)
        samples = []  # (x, y) en travers du pont, des deux côtés, en m depuis la photo
        for c, line in zip(chain, lines):
            length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(line, line[1:]))
            edge = (c["width"] or self.FALL_WIDTH) / 2
            n = max(1, round(length / step))
            for k in range(n + 1):
                s = k * length / n
                (x, y), a, b = roads._at(line, s), roads._at(line, s - 1.0), roads._at(line, s + 1.0)
                t = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
                nx, ny = -(b[1] - a[1]) / t, (b[0] - a[0]) / t
                samples += [(x + side * (edge + d) * nx, y + side * (edge + d) * ny)
                            for side in (-1, 1) for d in self.FALL_SIDES]
        reach = max(math.hypot(x, y) for x, y in samples) + 10.0

        def failed(reason="service injoignable", retry=True):
            self.falls[key] = {"text": "Hauteur de chute : calcul impossible ({})".format(reason), "title": "",
                               "retry_at": time.monotonic() + self.FALL_RETRY if retry else float("inf")}
            self.notify()

        def got_photos(data, error):
            if error:
                return failed()
            decks = []  # (x, y, altitude du tablier) aux photos de la séquence prises sur le pont
            for feat in (data or {}).get("features") or []:
                try:
                    plon, plat = (float(v) for v in feat["geometry"]["coordinates"][:2])
                except (KeyError, TypeError, ValueError):
                    continue
                ngf = host.ngf_altitude(plon, plat, metadata.item_altitude(feat))
                if ngf is None or feat.get("collection") != item.get("collection") or \
                        roads.on_bridge(chain, plon, plat) is None:
                    continue
                rank = (feat.get("properties") or {}).get("geovisio:rank_in_collection")
                decks.append(triangulation._local(plon, plat, lon, lat) + (ngf - camera, rank if isinstance(rank, int) else 0))
            if not decks:
                return failed("pas d'altitude GPS de la séquence sur le pont")  # grille du géoïde pas encore lue ?
            self._terrain([triangulation._geographic(x, y, lon, lat) for x, y in samples],
                          lambda ground, source, error: got_ground(decks, ground, source, error))

        def got_ground(decks, ground, source, error):
            if error:
                return failed()
            best = None
            for (x, y), z in zip(samples, ground or []):
                if z is None:
                    continue
                deck = _deck_at(decks, x, y)
                if best is None or deck - z > best[0]:
                    best = (deck - z, math.hypot(x, y))
            if best is None:
                return failed("pas de modèle de terrain sous le pont", retry=False)
            if best[0] < self.FALL_MIN:
                self.falls[key] = {"text": "Hauteur de chute non mesurée : le terrain sous le pont ne se distingue "
                                           "pas du tablier (végétation, buse ?)", "title": ""}
                return self.notify()
            terrain = triangulation.RGE_ALTI_ERROR if source == "RGE ALTI" else triangulation.LIDAR_ERROR
            # Mesurée sur la séquence : tablier = altitude RTK moins (altitude RTK moins sol LiDAR) des photos voisines, le
            # biais vertical du GPS s'annule ; restent la dispersion de cette hauteur et le sol sous ces photos. Calée ou
            # réglage : l'altitude RTK elle-même compte (VERIFIED_ACCURACY), avec l'incertitude de la hauteur
            if camera_source == "séquence":
                sigma = math.hypot(camera_error, triangulation.LIDAR_ERROR, terrain)
            else:
                sigma = math.hypot(precision.VERIFIED_ACCURACY, camera_error, terrain)
            self.falls[key] = {
                "text": "Hauteur de chute max : {} m (±{} m), RTK".format(measures._num(best[0], 1), measures._num(sigma, 1)),
                "title": ("Plus grande hauteur entre le tablier (altitude GPS RTK moins hauteur de caméra) et le "
                          "terrain sous le pont ({}), le long des deux bords jusqu'à {} m de la chaussée, à {} m de la photo. Au-dessus de "
                          "l'eau : niveau au relevé, pas le fond. Hauteur de caméra : {} m ({}).").format(
                    source, measures._num(self.FALL_SIDES[-1], 0), measures._num(best[1], 0), measures._num(camera, 2),
                    {"séquence": "mesurée sur la séquence", "calée": "calée pour la séquence",
                     "monture": "monture du CD21 d'après la date", "réglage": "réglage « Caméra à »"}[camera_source])}
            self.notify()

        host.fetch_json(metadata.search_url(lon, lat, reach, 100, item.get("collection"), host.api_url), got_photos)

    # Hauteur de chute et dévers des bords de route, hors pont (ticket #31) -----------------------
    # Calcul lancé seulement par le bouton « Profils » de la page (request_edges), pour la photo
    # affichée. Travers de part et d'autre de la route, à EDGE_ALONG m de la photo le long du tronçon,
    # depuis la caméra (séquence vérifiée RTK ; sinon l'axe BD TOPO) jusqu'à edge_zone m au-delà du bord
    # de la chaussée (réglette de la page) ; terrain MNT LiDAR HD (RGE ALTI en secours). Bord : rupture de
    # pente du terrain (EDGE_BREAK), sinon la médiane des travers voisins (EDGE_CONSENSUS), sinon la demi-largeur
    # BD TOPO. Référence : le terrain au bord, pas l'altitude GPS.
    EDGE_ZONE = 10.0  # m au-delà du bord de la chaussée examinés par défaut
    EDGE_ALONG = (-10.0, -5.0, 0.0, 5.0, 10.0)  # m le long de la route, depuis la photo
    EDGE_WINDOW = 2.0  # m en travers : pente lue entre deux points au moins aussi écartés (bruit du MNT ±5 cm)
    EDGE_TALUS = 0.10  # pente vers le bas (sur EDGE_WINDOW m) d'une descente : en dessous, plat
    EDGE_CORE = 1 / 3  # talus : partie de la descente dont la pente vaut au moins ce rapport de sa pente la plus forte
    EDGE_FLAT = 0.05  # m : pied du talus, et point le plus bas de la chute, le plus proche du bord à cela près du plus bas
    EDGE_STEP = 0.5  # m entre deux points du profil, de l'origine jusqu'à EDGE_SEARCH m après le bord BD TOPO
    EDGE_SEARCH = 3.0  # m au-delà du bord BD TOPO où la rupture de pente est encore cherchée
    EDGE_BREAK = 0.08  # écart de pente sur 1 m à celle de la chaussée sous l'origine : bord (bombement : ~0,05)
    EDGE_HOLD = 3  # pas consécutifs où l'écart doit tenir : un seul pas de 1 m tient du bruit du MNT (±5 cm)
    EDGE_NEAR = 1.5  # m : pas de bord plus près de l'origine (le véhicule occupe sa voie ; demi-voie sur l'axe)
    EDGE_FAR = 16  # points au-delà, jusqu'à edge_zone m
    PAVED_REDO_MAX = 50  # profils gardés avec leur terrain, pour use_paved_edges sans relecture
    EDGE_RISE = 1.0  # m : terrain remonté d'autant au-dessus du bord (talus, butte) : lecture arrêtée, derrière n'est pas une chute
    # Chaussées séparées (autoroute, voie express : un tronçon BD TOPO par sens, ticket #34) : tronçon de même nom, au sol,
    # parallèle (TWIN_ANGLE° près), son axe à TWIN_MIN à TWIN_REACH m de celui de la photo en travers ; de son côté, la
    # plateforme va jusqu'au bord extérieur de l'autre chaussée (séparateur de chaussée, ou terre-plein central, compris)
    TWIN_MIN, TWIN_REACH, TWIN_ANGLE = 4.0, 40.0, 30.0
    TWIN_LENGTHWISE = 2.0  # m : axe de l'autre chaussée en travers du point, pas au bout d'un tronçon décalé le long
    TWIN_SEARCH = 6.0  # m de plus où le bord extérieur de l'autre chaussée est cherché (largeurs BD TOPO souvent trop
    # faibles sur ces routes : 5 m pour deux voies)
    # Marche du terrain (bordure, séparateur surélevé ou en creux) : au moins STEP_Z m sur un pas de EDGE_STEP m, et encore
    # STEP_HOLD m sur trois pas (pas un seul point du MNT qui saute, ±5 cm)
    STEP_Z, STEP_HOLD = 0.05, 0.04
    SEPARATOR_WIDTH = (0.5, 10.0)  # m : largeurs possibles d'un séparateur de chaussée trouvé dans le relief
    SEPARATOR_NEAR = 4.0  # m au plus entre son milieu et celui que donne la BD TOPO
    # Profil en long : terrain sur ±LONG_REACH m le long du tronçon, tous les LONG_STEP m ; pente moyenne (moindres carrés)
    # et la plus forte sur LONG_WINDOW m
    LONG_REACH, LONG_STEP, LONG_WINDOW = 50, 2, 10
    LONG_JUNCTION = 30.0  # m : repères de carrefour avec la même voie plus proches : un seul carrefour (îlot séparateur)
    # Creux du profil en long : le MNT n'a pas les ponts (fond franchi), et le tronçon BD TOPO en pont est souvent plus court
    # que la brèche, ou absent ; une route ne plonge pas de plus de DIP_SLOPE (15 % au plus), le terrain qui le fait est sous
    # un ouvrage, comblé d'un bord à l'autre (_bridged)
    DIP_SLOPE = 0.2
    # Tablier : enveloppe haute du terrain, cordes de DIP_SPAN m au plus (le fond d'un creux plus large n'est pas un pont) ;
    # gardée là où elle passe à plus de DIP_TOL m du terrain et recouvre un pont de la route ou une plongée de DIP_SLOPE
    DIP_SPAN, DIP_TOL = 40.0, 0.1
    EDGE_CONSENSUS = 3.0  # m : bord (ou séparateur) d'un travers plus loin de la médiane des autres : ramené à elle
    # Séparateur étroit sans marches (glissières dos à dos, muret : le MNT n'en garde que l'assise) : pic de 1 ou 2 points au
    # moins PEAK_Z m au-dessus des points voisins, au même endroit (PEAK_SPREAD m près) sur PEAK_TRAVERS travers au moins
    PEAK_Z, PEAK_SPREAD, PEAK_TRAVERS, PEAK_HALF = 0.04, 1.0, 2, 0.4

    def set_edge_zone(self, metres):
        """Réglette du bouton « Profils » : largeur (m) lue au-delà du bord de la chaussée au prochain appui
        (le résultat déjà affiché reste celui de sa largeur)."""
        self.edge_zone = float(metres)
        self.notify()

    def request_edges(self):
        """Bouton « Profils » : calcul pour la photo affichée et la largeur de la réglette (voir _edges)."""
        if self.item:
            self.edges_asked[self.item.get("id")] = self.edge_zone
            self.notify()

    def edges_ready(self):
        """Le bouton « Profils » aurait un effet : photo affichée, pas déjà calculée à cette largeur."""
        return bool(self.item) and self.edges_asked.get(self.item.get("id")) != self.edge_zone

    def _edges(self, item, sections, lon, lat):
        """Photo hors pont où le bouton « Profils » a été pressé : chute et dévers des deux bords de la route
        la plus proche (roads.MAX_DISTANCE m au plus), {text, title, edges}, l'attente du calcul ou sa raison
        d'échouer ; None sans appui sur le bouton pour cette photo."""
        zone = self.edges_asked.get(item.get("id"))
        if zone is None:
            return None

        def told(text):
            return {"text": "Bords de route\n" + text, "title": "", "edges": True}

        # Tronçons des mailles voisines aussi (±LONG_REACH m et plus) : la route prolongée (_chained) sort de la maille de la
        # photo ; doublons (un tronçon lu dans deux mailles) fusionnés
        reach = self.LONG_REACH + 10.0
        dlat, dlon = reach / 111320.0, reach / (111320.0 * math.cos(math.radians(lat)))
        merged, seen = [], set()
        for cell in {roads._cell(lon + i * dlon, lat + j * dlat) for i in (-1, 0, 1) for j in (-1, 0, 1)}:
            corner = (cell[0] * roads.CELL + 1e-9, cell[1] * roads.CELL + 1e-9)
            more = sections if cell == roads._cell(lon, lat) else self._fall_sections(*corner)
            if more is roads.PENDING:
                return told("Calcul en cours…")
            for sec in more or []:
                tag = (sec.get("name"), sec.get("level"), tuple(sec["line"][0]), tuple(sec["line"][-1]))
                if tag not in seen:
                    seen.add(tag)
                    merged.append(sec)
        sections = merged

        # Route de la photo : le tronçon au sol le plus proche parmi ceux orientés comme la route parcourue (à ROAD_TURN°
        # près, sens de la trajectoire de la caméra au droit de la photo, sinon son cap) ; à un carrefour, la voie qui
        # croise peut passer plus près ; aucun ainsi orienté : le plus proche
        track = self.long_tracks.get(item.get("id"))
        heading = metadata.item_heading(item)
        if track and len(track) >= 2:
            k0 = track.index((0.0, 0.0))
            p, q = track[max(0, k0 - 1)], track[min(len(track) - 1, k0 + 1)]
            heading = math.degrees(math.atan2(q[0] - p[0], q[1] - p[1]))
        near, aligned = None, None
        for sec in sections:
            if sec.get("level", 0) != 0:
                continue  # pont ou tunnel
            line = [triangulation._local(p[0], p[1], lon, lat) for p in sec["line"]]
            d, s = roads._project(line, 0.0, 0.0)
            if d > roads.MAX_DISTANCE:
                continue
            a, b = roads._at(line, s - roads.TANGENT), roads._at(line, s + roads.TANGENT)
            course = math.degrees(math.atan2(b[0] - a[0], b[1] - a[1]))
            if near is None or d < near[0]:
                near = (d, s, line, sec)
            if (heading is None or roads._axis_diff(course, heading) <= self.ROAD_TURN) and (aligned is None or d < aligned[0]):
                aligned = (d, s, line, sec)
        near = aligned or near
        if near is None:
            return told("Pas de route de la BD TOPO à moins de {} m de la photo".format(
                measures._num(roads.MAX_DISTANCE, 0)))
        _, s, line, sec = near
        line, ends, works = self._chained(line, sec, sections, lon, lat)  # prolongé par les tronçons voisins de la même route
        s = roads._project(line, 0.0, 0.0)[1]
        # Autres chaussées possibles (voir TWIN_REACH) : [(tronçon en mètres locaux, largeur)], vérifiées travers par
        # travers (_compute_edges) : un tronçon voisin de la même chaussée, dans son prolongement, n'en est pas une
        twin = []
        for other in sections:
            if other is sec or other.get("level", 0) != 0 or not sec.get("name") or other.get("name") != sec.get("name"):
                continue
            other_line = [triangulation._local(p[0], p[1], lon, lat) for p in other["line"]]
            if roads._project(other_line, 0.0, 0.0)[0] <= self.TWIN_REACH:
                twin.append((other_line, other["width"]))
        camera = bool(self.quality and self.quality.get("precise"))  # position RTK : profils depuis la caméra
        key = (item.get("id"), zone, camera)
        res = self.edges.get(key)
        if res is None or time.monotonic() >= res.get("retry_at", float("inf")):
            track = self._track_line(item, lon, lat)  # profil en long le long de la trajectoire de la caméra
            if track is None:
                return told("Calcul en cours…")
            if track is False:  # pas de repli silencieux sur l'axe BD TOPO : nouvel essai plus tard
                res = self.edges[key] = {"text": "Calcul impossible (service injoignable)", "title": "",
                                         "retry_at": time.monotonic() + self.FALL_RETRY}
            else:
                res = self.edges[key] = {"text": "Calcul en cours…", "title": ""}
                self._compute_edges(key, line, s, sec["width"], metadata.item_heading(item), lon, lat, twin, track,
                                    (ends, sec.get("name"), works))
        road = sec.get("name") if re.match(r"[A-Z]+\d", sec.get("name") or "") else None
        profile = res.get("profile")
        if profile:  # eau de la BD TOPO sur le travers de la photo (lue à part : None pendant la lecture)
            profile = dict(profile, eau=self._water_across(res["frame"], lon, lat))
        return {"text": "Bords de route" + (" ({})".format(road) if road else "") + "\n" + res["text"],
                "title": res["title"], "edges": True, "profile": profile, "road": road}

    ROAD_TURN = 45.0  # degrés au plus entre le tronçon de la photo et la route parcourue (_edges)
    CHAIN_TURN = 60.0  # degrés de déviation au plus d'un tronçon à l'autre en prolongeant la route
    CHAIN_REACH, CHAIN_TOUCH = 60.0, 2.0  # m ajoutés au plus de chaque côté ; bouts de tronçons qui se touchent

    def _bridged(self, pts, bridges=()):
        """Profil en long [(d, z)] sans ses creux (le MNT n'a pas les ponts : il donne le fond franchi).
        1. Enveloppe haute du terrain par des cordes de DIP_SPAN m au plus : là où elle passe à plus de DIP_TOL m au-dessus,
        un creux, dont les bouts (le terrain touche la corde) sont les culées ; gardé s'il recouvre un pont de la route
        (bridges : [(de, à)], souvent plus court que la brèche) ou une plongée de plus de DIP_SLOPE d'un point au suivant
        (pont absent de la BD TOPO).
        2. Plongée de plus de DIP_SLOPE qui reste : droite du bord jusqu'au point où le terrain revient au niveau de la route
        (pas plus bas que DIP_SLOPE depuis le bord), poussé jusqu'en haut de la remontée ; dans les deux sens, un creux
        ouvert au bout du profil (pas d'autre bord) y est coupé.
        Rend (profil, [(de, à)] des creux comblés)."""
        slope, out, dips = self.DIP_SLOPE, list(pts), []
        top = [(z, None) for _, z in out]  # plus haute corde au-dessus de chaque point : (altitude, (bout, bout))
        for i, (da, za) in enumerate(out):
            for j in range(i + 2, len(out)):
                db, zb = out[j]
                if db - da > self.DIP_SPAN:
                    break
                for k in range(i + 1, j):
                    z = za + (zb - za) * (out[k][0] - da) / (db - da)
                    if z > top[k][0]:
                        top[k] = (z, (i, j))
        lift = [t - z for (t, _), (_, z) in zip(top, out)]
        steep = lambda a, b: abs(out[b][1] - out[a][1]) > slope * (out[b][0] - out[a][0])
        k = 1
        while k < len(out) - 1:
            if lift[k] <= self.DIP_TOL:
                k += 1
                continue
            core = k
            while k < len(out) - 1 and lift[k] > self.DIP_TOL:
                k += 1
            # creux : la corde la plus haute au-dessus de son point le plus profond, d'une culée (appui) à l'autre
            deep = max(range(core, k), key=lambda m: lift[m])
            a, b = top[deep][1]
            # appuis rapprochés tant que le point suivant est sur la corde (à DIP_TOL près) : la route, pas encore le creux
            on = lambda m, a, b: out[m][1] >= (out[a][1] + (out[b][1] - out[a][1]) * (out[m][0] - out[a][0])
                                               / (out[b][0] - out[a][0])) - self.DIP_TOL
            while a + 1 < deep and on(a + 1, a, b):
                a += 1
            while b - 1 > deep and on(b - 1, a, b):
                b -= 1
            lo, hi = out[a][0], out[b][0]
            if any(b0 <= hi and b1 >= lo for b0, b1 in bridges) or any(steep(m, m + 1) for m in range(a, b)):
                (da, za), (db, zb) = out[a], out[b]
                out = out[:a + 1] + [(d, za + (zb - za) * (d - da) / (db - da)) for d, _ in out[a + 1:b]] + out[b:]
                lift[a:b] = [0.0] * (b - a)
                dips.append((lo, hi))
                k = max(k, b)
        for rev in (False, True):
            if rev:
                out = [(-d, v) for d, v in reversed(out)]
            k = 0
            while k < len(out) - 1:
                (da, za), (db, zb) = out[k], out[k + 1]
                if za - zb <= slope * (db - da):
                    k += 1
                    continue
                j = next((j for j in range(k + 2, len(out)) if out[j][1] >= za - slope * (out[j][0] - da)), None)
                if j is None:
                    out = out[:k + 1]
                    break
                while j < len(out) - 1 and out[j + 1][1] - out[j][1] > slope * (out[j + 1][0] - out[j][0]):
                    j += 1
                d1, z1 = out[j]
                out = out[:k + 1] + [(d, za + (z1 - za) * (d - da) / (d1 - da)) for d, _ in out[k + 1:j]] + out[j:]
                dips.append((-d1, -da) if rev else (da, d1))
                k = j
            if rev:
                out = [(-d, v) for d, v in reversed(out)]
        return out, dips

    def _chained(self, line, sec, sections, lon, lat):
        """Ligne du tronçon de la photo (mètres locaux) prolongée à chaque bout par les tronçons au sol de la même route
        (même nom) qui s'y raccordent, jusqu'à CHAIN_REACH m de plus : le profil en long et les travers ne s'arrêtent pas
        au bout du tronçon. Un seul voisin pris par bout (le premier trouvé) ; sans nom ou sans voisin, la ligne telle quelle.
        Rend aussi les points remarquables de cette route : [(point, "fin" ou "carrefour", voies nommées qui s'y raccordent)],
        « fin » au bout de la ligne prolongée (la route s'arrête, ou continue sous un autre nom), « carrefour » là où une
        voie carrossable nommée (numéro ou nom, pas une simple nature ; roads.parse_sections) s'y raccorde sans
        l'interrompre. Les tronçons en pont ou en tunnel de la route en font partie : leurs bouts sont rendus à part,
        [(niveau, bout, bout)] (le MNT y est le fond franchi ou le dessus du tunnel, pas la chaussée)."""
        touch = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1]) <= self.CHAIN_TOUCH
        if not sec.get("name"):
            return line, [], []
        others = [[triangulation._local(p[0], p[1], lon, lat) for p in o["line"]] for o in sections
                  if o is not sec and o.get("name") == sec["name"]]
        levels = [o.get("level", 0) for o in sections if o is not sec and o.get("name") == sec["name"]]
        works = []  # ouvrages de la route : (niveau, bout, bout)
        foreign = [(o.get("name") or "", [triangulation._local(p[0], p[1], lon, lat) for p in (o["line"][0], o["line"][-1])])
                   for o in sections if o.get("level", 0) == 0 and o.get("name") != sec["name"] and o.get("drivable")]
        joints = [line[0], line[-1]]  # bouts des tronçons de la route mis bout à bout
        out = list(line)
        for at_end in (True, False):
            added, used = 0.0, set()
            while added < self.CHAIN_REACH:
                tip, back = (out[-1], out[-2]) if at_end else (out[0], out[1])
                way = (tip[0] - back[0], tip[1] - back[1])  # sens de la route en sortant par ce bout
                # le tronçon qui la continue le plus dans l'alignement (à un nœud, plusieurs tronçons du même nom peuvent
                # partir : l'autre branche d'une intersection, un pont…), à moins de CHAIN_TURN° de déviation
                best = None
                for k, o in enumerate(others):
                    if k in used or not (touch(o[0], tip) or touch(o[-1], tip)):
                        continue
                    o = o if touch(o[0], tip) else o[::-1]  # part du bout touché
                    v = (o[1][0] - o[0][0], o[1][1] - o[0][1])
                    turn = (way[0] * v[0] + way[1] * v[1]) / ((math.hypot(*way) * math.hypot(*v)) or 1.0)
                    if turn >= math.cos(math.radians(self.CHAIN_TURN)) and (best is None or turn > best[0]):
                        best = (turn, k, o)
                if best is None:
                    break
                _, k, o = best
                used.add(k)
                if levels[k]:
                    works.append((levels[k], o[0], o[-1]))
                joints.append(o[-1])
                o = o[1:]
                added += sum(math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip([tip] + o, o))
                out = out + o if at_end else o[::-1] + out
        ends = []
        for j in joints:
            names = sorted({n for n, tips in foreign if n and n not in _WAY_KINDS and any(touch(t, j) for t in tips)})
            if touch(j, out[0]) or touch(j, out[-1]):  # bout de la ligne prolongée : la route s'arrête là
                ends.append((j, "fin", names))
            elif names:
                ends.append((j, "carrefour", names))
        return out, ends, works

    WATER_REACH = 45.0  # m de part et d'autre de l'origine du travers où l'eau de la BD TOPO est cherchée

    def _water_across(self, frame, lon, lat):
        """Eau de la BD TOPO sur le travers de la photo (frame : origine et unité vers la droite, mètres locaux) : cours
        d'eau croisés ({"x", "nom", "nature"}) et plans ou surfaces d'eau traversés ({"de", "a", "nature"}), en m vers la
        droite ; None pendant la lecture. Souterrains et tronçons fictifs (à travers un lac) écartés."""
        ox, oy, rx, ry = frame
        a, b = (ox - self.WATER_REACH * rx, oy - self.WATER_REACH * ry), (ox + self.WATER_REACH * rx, oy + self.WATER_REACH * ry)
        cell = roads._cell(lon, lat)
        lines, surfaces = self._bdtopo("troncon_hydrographique", cell), self._bdtopo("surface_hydrographique", cell)
        if lines is None or surfaces is None:
            return None
        across = lambda p: round((p[0] - ox) * rx + (p[1] - oy) * ry, 1)

        def kept(props):
            try:
                return int(props.get("position_par_rapport_au_sol") or 0) >= 0 and not props.get("fictif")
            except (TypeError, ValueError):
                return not props.get("fictif")

        def cuts(ring):  # abscisses où le travers coupe la ligne (ou l'anneau) ring, en lon, lat
            pts = [triangulation._local(q[0], q[1], lon, lat) for q in ring]
            return [across(x) for c, d in zip(pts, pts[1:]) for x in [_crossing(a, b, c, d)] if x]

        out = []
        for feat in lines:
            props, geom = feat.get("properties") or {}, feat.get("geometry") or {}
            if not kept(props):
                continue
            coords = geom.get("coordinates") or []
            for line in coords if geom.get("type") == "MultiLineString" else [coords]:
                for x in cuts(line):
                    out.append({"x": x, "nom": props.get("cpx_toponyme_de_cours_d_eau"), "nature": props.get("nature")})
        for feat in surfaces:
            props, geom = feat.get("properties") or {}, feat.get("geometry") or {}
            if not kept(props):
                continue
            coords = geom.get("coordinates") or []
            xs = sorted(x for poly in (coords if geom.get("type") == "MultiPolygon" else [coords]) for ring in poly
                        for x in cuts(ring))
            # shortcut: traversées prises deux à deux ; un bout du travers dans l'eau laisse une traversée seule, écartée
            out += [{"de": xs[k], "a": xs[k + 1], "nature": props.get("nature")} for k in range(0, len(xs) - 1, 2)]
        return out

    def _track_line(self, item, lon, lat):
        """Trajectoire de la caméra autour de la photo : positions des photos de la même séquence, de rangs qui se suivent
        (un trou d'une photo admis), en mètres locaux, dans le sens de la photo, la photo à (0, 0) ; [] si moins de 3
        photos ou rang inconnu (profil en long sur l'axe BD TOPO) ; None pendant la lecture ; False si Panoramax n'a pas
        répondu (relue à l'appel suivant)."""
        key = item.get("id")
        if self.long_tracks.get(key, False) is not False:
            return self.long_tracks[key]
        self.long_tracks[key] = None
        seq, rank0 = item.get("collection"), (item.get("properties") or {}).get("geovisio:rank_in_collection")

        def done(data, error):
            out = []
            if not error and seq is not None and isinstance(rank0, int):
                at = {rank0: (0.0, 0.0)}
                for feat in (data or {}).get("features") or []:
                    rank = (feat.get("properties") or {}).get("geovisio:rank_in_collection")
                    try:
                        if feat.get("collection") == seq and isinstance(rank, int) and rank != rank0:
                            at[rank] = triangulation._local(*(float(v) for v in feat["geometry"]["coordinates"][:2]), lon, lat)
                    except (KeyError, TypeError, ValueError):
                        continue
                ranks = [rank0]
                for step in (1, -1):  # de proche en proche, un trou d'une photo admis
                    r = rank0
                    while True:
                        r = next((r + step * g for g in (1, 2) if r + step * g in at), None)
                        if r is None:
                            break
                        ranks.append(r)
                ranks.sort()
                out = [at[r] for r in ranks]
                heading, k = metadata.item_heading(item), ranks.index(rank0)
                if len(out) >= 3 and heading is not None:
                    a, b = out[max(0, k - 1)], out[min(len(out) - 1, k + 1)]
                    if abs((math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) - heading + 180) % 360 - 180) > 90:
                        out = out[::-1]  # dans le sens de la photo
                else:
                    out = []
            self.long_tracks[key] = False if error else out
            self.notify()

        host.fetch_json(metadata.search_url(lon, lat, self.LONG_REACH + 15, 100, seq, host.api_url), done)
        return None

    def _compute_edges(self, key, line, s, width, heading, lon, lat, twin=None, track=None, ends=([], None, [])):
        """Calcul des bords (voir _edges), rangé dans self.edges[key], puis notify() ; twin : autre chaussée
        (tronçon, largeur) d'une route à chaussées séparées, ou None. Étapes : travers à lire (_edge_profiles), profil en
        long (_long_samples), puis, le terrain lu, bords et séparateurs (_edge_reads) et chutes et dévers (_edge_falls)."""
        _, zone, camera = key
        x, y, nx, ny = self._line_frame(line, s)
        shift = -(x * nx + y * ny) if camera else 0.0  # origine à gauche de l'axe (m) : la caméra est en (0, 0)
        a, b = roads._at(line, s - roads.TANGENT), roads._at(line, s + roads.TANGENT)
        course = math.degrees(math.atan2(b[0] - a[0], b[1] - a[1]))  # sens du tronçon
        forward = heading is None or abs((course - heading + 180) % 360 - 180) <= 90
        sides = (("droit", -1), ("gauche", 1)) if forward else (("droit", 1), ("gauche", -1))
        # Repère du travers de la photo pour l'analyse fine (src/nuage.js) : son origine et le point à 1 m à droite
        right = dict(sides)["droit"]
        across0 = (x + shift * nx, y + shift * ny, right * nx, right * ny)  # pour l'eau de la BD TOPO (_water_across)
        frame0 = [triangulation._geographic(x + shift * nx + k * right * nx, y + shift * ny + k * right * ny, lon, lat)
                  for k in (0, 1)]
        frame_key = tuple(tuple(round(v, 8) for v in p) for p in frame0)
        profiles, samples = self._edge_profiles(line, s, (width or self.FALL_WIDTH) / 2, zone, shift, sides, twin)
        lengthwise, long_samples, followed = self._long_samples(line, s, shift, forward, track)
        samples += long_samples

        def along_of(p):  # distance d'une fin de tronçon le long de la route BD TOPO (la caméra a pu couper le carrefour)
            return (1 if forward else -1) * (roads._project(line, p[0], p[1])[1] - s)

        def got_ground(ground, source, error):
            if error or not source:
                self.edges[key] = {"text": "Calcul impossible ({})".format(
                    "service injoignable" if error else "pas de modèle de terrain ici"), "title": "",
                    "retry_at": time.monotonic() + self.FALL_RETRY if error else float("inf")}
                return self.notify()
            if len(self.paved_redo) >= self.PAVED_REDO_MAX:
                self.paved_redo.clear()
            self.paved_redo[frame_key] = (key, lambda: got_ground(ground, source, None))
            paved = self.paved.get(frame_key, {})
            read, twins = self._edge_reads(profiles, ground, sides, paved)
            found, borders, stops, drawn = self._edge_falls(read, sides, paved, zone)
            # Profil en long (derniers points lus) : pente moyenne, montée > 0 dans le sens de la photo, et la plus forte
            pts = [(d, v) for d, v in zip(lengthwise, ground[len(ground) - len(lengthwise):]) if v is not None] if lengthwise else []
            grade = self._long_profile(pts, ends, along_of, followed)
            terrain = triangulation.RGE_ALTI_ERROR if source == "RGE ALTI" else triangulation.LIDAR_ERROR
            sigma = math.hypot(terrain, terrain)  # deux altitudes du même MNT
            origin = "la caméra" if camera else "l'axe BD TOPO"
            lines, seen, shown = self._edges_sides(sides, borders, found, stops, drawn, twins, sigma, origin)
            self.edges[key] = {
                "frame": across0,
                "profile": {"origine": "caméra" if camera else "axe", "source": source, "erreur": round(sigma, 2),
                            "repere": [[round(v, 8) for v in p] for p in frame0],
                            "axe": round(-shift * right, 2),  # axe de la chaussée de la photo, en m vers la droite
                            "zone": zone, "fenetre": self.EDGE_WINDOW, "remontee": self.EDGE_RISE, "profils": drawn,
                            "plateforme": platform_slope(drawn) if source == triangulation.LIDAR_NAME else None,  # RGE ALTI trop imprécis
                            "resultats": shown, "arrets": {name: sorted(v)[len(v) // 2] for name, v in stops.items() if v},
                            "en_long": grade},
                "text": ("\n".join(lines) or "Aucun bord ne descend de {} m ou plus jusqu'à {} m".format(
                    measures._num(self.FALL_MIN, 1), measures._num(zone, 0))) + ("\nPente en long : {} de {} % sur {} m{}".format(
                        "montée" if grade["pente"] >= 0 else "descente", measures._num(abs(grade["pente"]), 1),
                        measures._num(grade["points"][-1][0] - grade["points"][0][0], 0),
                        ", jusqu'à {} % sur {} m".format(measures._num(abs(grade["max"][0]), 1), self.LONG_WINDOW)
                        if grade["max"] else "") if grade else ""),
                "title": self._edges_title(source, origin, zone, seen)}
            self.notify()

        self._terrain([triangulation._geographic(x, y, lon, lat) for x, y in samples], got_ground)

    @staticmethod
    def _line_frame(line, at):
        """Point de l'axe et normale à gauche du sens du tronçon, à l'abscisse at : (x, y, nx, ny)."""
        (x, y), p, q = roads._at(line, at), roads._at(line, at - 1.0), roads._at(line, at + 1.0)
        t = math.hypot(q[0] - p[0], q[1] - p[1]) or 1.0
        return x, y, -(q[1] - p[1]) / t, (q[0] - p[0]) / t

    def _twin_across(self, twin, x, y, nx, ny, along_x, along_y):
        """Axe de l'autre chaussée (twin, voir _compute_edges) sur le travers du point (x, y) de l'axe : (décalage en m le
        long de la normale, demi-largeur) de la plus proche, ou None (pas d'autre chaussée, pas parallèle, pas en travers,
        trop près ou trop loin)."""
        best = None
        for other, other_width in twin or []:
            _, s2 = roads._project(other, x, y)
            (qx, qy), p, q = roads._at(other, s2), roads._at(other, s2 - 1.0), roads._at(other, s2 + 1.0)
            t = math.hypot(q[0] - p[0], q[1] - p[1]) or 1.0
            cos = abs(((q[0] - p[0]) * along_x + (q[1] - p[1]) * along_y) / t)
            offset = (qx - x) * nx + (qy - y) * ny
            lengthwise = abs((qx - x) * along_x + (qy - y) * along_y)  # bout d'un tronçon dans le prolongement
            if (cos >= math.cos(math.radians(self.TWIN_ANGLE)) and lengthwise <= self.TWIN_LENGTHWISE
                    and self.TWIN_MIN <= abs(offset) <= self.TWIN_REACH and (best is None or abs(offset) < abs(best[0]))):
                best = (offset, (other_width or self.FALL_WIDTH) / 2)
        return best

    def _edge_profiles(self, line, s, half, zone, shift, sides, twin):
        """Travers à lire (EDGE_ALONG), de chaque côté : (profils [(le long, côté, bord BD TOPO depuis l'origine, distances
        depuis l'origine, axe de l'autre chaussée, séparateur BD TOPO, portée)], points à lire (m, repère de la photo))."""
        profiles = []
        samples = []
        for along in self.EDGE_ALONG:
            # shortcut: _at borne aux bouts de la ligne prolongée (_chained) : au-delà, les travers s'y superposent
            x, y, nx, ny = self._line_frame(line, s + along)
            other = self._twin_across(twin, x, y, nx, ny, ny, -nx)  # sens du tronçon : normale tournée d'un quart de tour à droite
            for name, sign in sides:
                guess = max(self.EDGE_NEAR, half - sign * shift)
                beyond, between = 0.0, None  # autre chaussée de ce côté : bord cherché au-delà de son axe (m depuis
                # l'origine) ; séparateur de chaussée d'après la BD TOPO, du bord de la chaussée de la photo à celui de l'autre
                if other and other[0] * sign > 0:
                    beyond = sign * other[0] - sign * shift
                    if beyond - other[1] > guess:
                        between = (guess, beyond - other[1])
                    guess = beyond + other[1]
                reach = guess + self.EDGE_SEARCH + (self.TWIN_SEARCH if beyond else 0)  # bord cherché jusque-là
                near = [k * self.EDGE_STEP for k in range(int(reach / self.EDGE_STEP) + 1)]
                offsets = near + [near[-1] + zone * k / self.EDGE_FAR for k in range(1, self.EDGE_FAR + 1)]
                profiles.append((along, name, guess, offsets, beyond, between, reach))
                samples += [(x + (shift + sign * o) * nx, y + (shift + sign * o) * ny) for o in offsets]
        return profiles, samples

    def _long_samples(self, line, s, shift, forward, track):
        """Profil en long, d > 0 dans le sens de la photo : le long de la trajectoire de la caméra (track, _track_line : là
        où elle a roulé, sol sous elle) ; sans elle, sur l'axe BD TOPO prolongé par les tronçons voisins (_chained), à la
        même distance de l'axe que l'origine (l'axe peut s'écarter de la voie de quelques mètres) ; borné aux bouts.
        Rend (distances d, points à lire, ce qui a été suivi)."""
        samples = []
        if track and len(track) >= 3:
            k0 = track.index((0.0, 0.0))
            cum = [0.0]
            for p, q in zip(track, track[1:]):
                cum.append(cum[-1] + math.hypot(q[0] - p[0], q[1] - p[1]))
            cum = [c - cum[k0] for c in cum]
            lengthwise = [d for d in range(-self.LONG_REACH, self.LONG_REACH + 1, self.LONG_STEP) if cum[0] <= d <= cum[-1]]
            for d in lengthwise:
                j = max(1, next((j for j in range(1, len(cum)) if cum[j] >= d), len(cum) - 1))
                t = (d - cum[j - 1]) / ((cum[j] - cum[j - 1]) or 1.0)
                (x0, y0), (x1, y1) = track[j - 1][:2], track[j][:2]
                samples.append((x0 + t * (x1 - x0), y0 + t * (y1 - y0)))
            return lengthwise, samples, "trajectoire de la caméra"
        ahead = 1 if forward else -1
        length = sum(math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip(line, line[1:]))
        lengthwise = [d for d in range(-self.LONG_REACH, self.LONG_REACH + 1, self.LONG_STEP) if 0 <= s + ahead * d <= length]
        for d in lengthwise:
            px, py, qx, qy = self._line_frame(line, s + ahead * d)
            samples.append((px + shift * qx, py + shift * qy))
        return lengthwise, samples, "axe BD TOPO"

    @staticmethod
    def _edge_slope(z, offsets, i, span):
        """Pente vers le bas en s'éloignant, de i au premier point à span m au moins (None sans altitude)."""
        j = next((j for j in range(i + 1, len(offsets)) if offsets[j] - offsets[i] >= span - 1e-6), None)
        return None if j is None or z[i] is None or z[j] is None else (z[i] - z[j]) / (offsets[j] - offsets[i])

    def _edge_step(self, z, offsets, i):
        """Marche du terrain juste après le point i (voir STEP_Z) : +1 en montant, -1 en descendant, 0 sinon."""
        if i < 1 or i + 2 >= len(offsets) or offsets[i + 1] - offsets[i] > self.EDGE_STEP + 1e-6:
            return 0
        if None in (z[i - 1], z[i], z[i + 1], z[i + 2]):
            return 0
        jump, held = z[i + 1] - z[i], z[i + 2] - z[i - 1]
        if abs(jump) >= self.STEP_Z and abs(held) >= self.STEP_HOLD and jump * held > 0:
            return 1 if jump > 0 else -1
        return 0

    def _edge_border(self, z, offsets, reach, beyond=0.0):
        """Indice du bord : premier point, à EDGE_NEAR m au moins de l'origine (chaussées séparées : au-delà de
        l'axe de l'autre chaussée, à beyond m), d'où la pente sur 1 m s'écarte de plus de EDGE_BREAK de celle de
        la chaussée sous l'origine (ou sous l'axe de l'autre), dans le même sens sur EDGE_HOLD pas, ou d'où le
        terrain marque une marche (bordure, accotement plus bas : STEP_Z), jusqu'à reach m ; sinon None (le bord BD
        TOPO). La pente sur 1 m voit la rupture jusqu'à 1 m avant elle : le bord avance d'un pas tant que la pente de
        ce pas reste celle de la chaussée (à EDGE_BREAK près), soit le dernier point de la chaussée (0,5 m plus tôt
        sinon : piste P7 de docs/analyses/pistes-profil.md)."""
        slope = self._edge_slope
        start = min(range(len(offsets)), key=lambda k: abs(offsets[k] - beyond))
        road = slope(z, offsets, start, 1.0)
        for i in range(start + 1, len(offsets)):
            if road is None or offsets[i] > reach:
                break
            if offsets[i] < max(self.EDGE_NEAR, beyond) - 1e-6:
                continue
            if self._edge_step(z, offsets, i):
                return i
            d = [slope(z, offsets, k, 1.0) for k in range(i, i + self.EDGE_HOLD)]
            if None not in d and (all(v - road > self.EDGE_BREAK for v in d) or all(road - v > self.EDGE_BREAK for v in d)):
                # dans la fenêtre de 1 m, un point au plus encore sur la chaussée (pas de EDGE_STEP m)
                j = i + 1
                if (j < len(offsets) and offsets[j] - offsets[i] <= self.EDGE_STEP + 1e-6 and offsets[j] <= reach
                        and z[i] is not None and z[j] is not None
                        and abs((z[i] - z[j]) / (offsets[j] - offsets[i]) - road) <= self.EDGE_BREAK):
                    return j
                return i
        return None

    def _edge_peaks(self, z, offsets, between, beyond):
        """Pics étroits (voir PEAK_Z) avant l'axe de l'autre chaussée, à SEPARATOR_NEAR m au plus du milieu BD TOPO
        du séparateur : leurs positions en m depuis l'origine."""
        mid, out = (between[0] + between[1]) / 2, []
        for k in range(1, len(offsets) - 2):
            if offsets[k] >= beyond or abs(offsets[k] - mid) > self.SEPARATOR_NEAR:
                continue
            if offsets[k + 1] - offsets[k] > self.EDGE_STEP + 1e-6 or None in z[k - 1:k + 3]:
                continue
            if z[k] - z[k - 1] >= self.PEAK_Z and z[k] - z[k + 1] >= self.PEAK_Z:
                out.append(offsets[k])
            elif (abs(z[k + 1] - z[k]) < self.PEAK_Z and z[k] - z[k - 1] >= self.PEAK_Z
                  and z[k + 1] - z[k + 2] >= self.PEAK_Z):  # deux points de large
                out.append((offsets[k] + offsets[k + 1]) / 2)
        return out

    def _edge_separator(self, z, offsets, between, beyond):
        """Séparateur de chaussée trouvé dans le relief : (début, fin) en m depuis l'origine, entre deux marches de
        sens contraires (surélevé : montée puis descente ; en creux : l'inverse), avant l'axe de l'autre chaussée,
        large de SEPARATOR_WIDTH, au milieu le plus proche de celui de la BD TOPO (between, SEPARATOR_NEAR m au
        plus) ; None sinon."""
        steps = []  # (m depuis l'origine, sens), une seule par suite de marches de même sens
        for i in range(len(offsets)):
            if offsets[i] >= beyond:
                break
            k = self._edge_step(z, offsets, i)
            if k and not (steps and steps[-1][1] == k and offsets[i] - steps[-1][2] <= self.EDGE_STEP + 1e-6):
                steps.append((offsets[i] + self.EDGE_STEP / 2, k, offsets[i]))
            elif k:
                steps[-1] = steps[-1][:2] + (offsets[i],)
        mid, best = (between[0] + between[1]) / 2, None
        for (a, ka, _), (b, kb, _) in zip(steps, steps[1:]):
            if ka == kb or not self.SEPARATOR_WIDTH[0] <= b - a <= self.SEPARATOR_WIDTH[1]:
                continue
            gap = abs((a + b) / 2 - mid)
            if gap <= self.SEPARATOR_NEAR and (best is None or gap < best[0]):
                best = (gap, a, b)
        return best and best[1:]

    def _edge_reads(self, profiles, ground, sides, paved):
        """Bord et séparateur de chaque travers lus sur le terrain (ground, dans l'ordre des profils) : 1er passage travers par
        travers, puis, côté par côté, ceux qui s'écartent de la médiane des travers trouvés dans le relief (une marche dans
        l'autre chaussée, un bord flou) y sont ramenés, comme ceux sans rupture de pente (bord d'après les travers
        voisins, pas trouvé dans leur relief) ; analyse fine (paved) : le bord de l'enrobé l'emporte. Rend (lectures [le
        long, côté, bord BD TOPO, distances, altitudes, indice du bord, séparateur, son origine, pics, axe de l'autre
        chaussée, bord ramené à la médiane], nombre de travers par côté où l'autre chaussée est comprise)."""
        twins = {name: 0 for name, _ in sides}  # côté -> travers où l'autre chaussée est comprise
        read = []
        start = 0
        for along, name, guess, offsets, beyond, between, reach in profiles:
            z = ground[start:start + len(offsets)]
            start += len(offsets)
            if z[0] is None:
                continue
            twins[name] += beyond > 0
            found_sep = between and self._edge_separator(z, offsets, between, beyond)
            i = self._edge_border(z, offsets, reach, beyond)
            read.append([along, name, guess, offsets, z, i, found_sep or between, "marches" if found_sep else None,
                         self._edge_peaks(z, offsets, between, beyond) if between else [], beyond, False])
        for name, _ in sides:
            mine = [r for r in read if r[1] == name]
            edges = sorted(r[3][r[5]] for r in mine if r[5] is not None)
            seps = [r[6] for r in mine if r[7]]
            if not seps:  # pas de séparateur à deux marches : un pic étroit qui revient d'un travers à l'autre
                tops = sorted(p for r in mine for p in r[8])
                groups = [[q for q in tops if abs(q - p) <= self.PEAK_SPREAD] for p in tops]
                group = max(groups, key=len, default=[])
                if len({r[0] for r in mine if any(abs(q - p) <= self.PEAK_SPREAD for q in group for p in r[8])}) >= self.PEAK_TRAVERS:
                    top = group[len(group) // 2]
                    seps = [(top - self.PEAK_HALF, top + self.PEAK_HALF)]
                    for r in mine:
                        if r[6]:
                            r[6], r[7] = seps[0], "bosse"
            med = edges[(len(edges) - 1) // 2] if len(edges) >= 3 else None  # médiane basse : le bord le plus proche
            sep_med = [sorted(v[k] for v in seps)[len(seps) // 2] for k in (0, 1)] if seps else None
            for r in mine:
                if med is not None and (r[5] is None or abs(r[3][r[5]] - med) > self.EDGE_CONSENSUS):
                    r[5], r[10] = min(range(len(r[3])), key=lambda k: abs(r[3][k] - med)), True
                if sep_med and r[6] and (not r[7] or max(abs(r[6][k] - sep_med[k]) for k in (0, 1)) > self.EDGE_CONSENSUS):
                    r[6], r[7] = sep_med, "marches"
                if name in paved:  # analyse fine : le bord de l'enrobé remplace celui du relief
                    r[5] = min(range(len(r[3])), key=lambda k: abs(r[3][k] - paved[name]))
        return read, twins

    def _edge_falls(self, read, sides, paved, zone):
        """Chute et dévers de chaque côté depuis les bords lus (_edge_reads), jusqu'à zone m du bord. Rend (côté ->
        [(chute, à m du bord, bout du profil, travers), (dévers, haut du talus à m du bord, travers, pied du talus à m du
        bord, hauteur du talus)], bords [(m depuis l'origine, relief, d'après les travers voisins)], côté -> distances au
        bord où le terrain remonte de EDGE_RISE, profils pour le graphique de la page (bouton « Graphiques »))."""
        found = {name: [None, None] for name, _ in sides}
        borders = {name: [] for name, _ in sides}
        stops = {name: [] for name, _ in sides}
        drawn = []
        for along, name, guess, offsets, z, i, between, sep_relief, _, beyond, moved in read:
            relief = i is not None and not moved  # trouvé dans le relief de ce travers, pas ramené à la médiane des autres
            if i is None:
                i = min(range(len(offsets)), key=lambda k: abs(offsets[k] - guess))
            borders[name].append((offsets[i], relief, moved))
            entry = {"le_long": along, "cote": name, "bord": round(paved.get(name, offsets[i]), 2), "relief": relief,
                     "voisins": moved, "enrobe": name in paved, "arret": None,
                     "separateur": [round(v, 2) for v in between] if between else None,
                     "autre_axe": round(beyond, 2) if beyond else None,  # axe de l'autre chaussée, m depuis l'origine
                     "separateur_relief": sep_relief if between else None,  # "marches", "bosse" ou None (BD TOPO)
                     "points": [[round(o, 2), round(v, 2)] for o, v in zip(offsets, z) if v is not None]}
            drawn.append(entry)
            kept = [k for k in range(i, len(offsets)) if offsets[k] - offsets[i] <= zone + 1e-6]
            zz, oo = [z[k] for k in kept], [offsets[k] - offsets[i] for k in kept]
            if zz[0] is None:
                continue
            # Terrain qui remonte de EDGE_RISE au-dessus du bord : lecture arrêtée (on ne passe pas la butte)
            cut = next((k for k, v in enumerate(zz) if v is not None and v - zz[0] >= self.EDGE_RISE), None)
            end = oo[-1]  # bout du profil : le terrain y descend peut-être encore
            if cut is not None:
                stops[name].append(oo[cut])
                entry["arret"] = round(offsets[i] + oo[cut], 2)
                zz, oo, end = zz[:cut], oo[:cut], float("inf")
            # point le plus bas le plus proche du bord (à 5 cm près) : le pied du talus
            low = max(((zz[0] - v, o) for v, o in zip(zz, oo) if v is not None),
                      key=lambda c: (round(c[0] / self.EDGE_FLAT), -c[1]))
            if found[name][0] is None or low[0] > found[name][0][0]:
                found[name][0] = low + (end, along)
            # Dévers : pente moyenne du talus le plus raide (FALL_MIN m de haut au moins), du haut au pied,
            # tous travers confondus (le cas le plus défavorable), et non la pente la plus forte sur
            # 2 m (un détail). Talus : pentes sur EDGE_WINDOW m d'au moins EDGE_TALUS, resserrées autour de la plus
            # forte sur celles d'au moins EDGE_CORE fois elle (sans l'accotement en pente douce ni la queue du pied)
            slopes = [self._edge_slope(zz, oo, j, self.EDGE_WINDOW) or 0 for j in range(len(oo))]
            for mean, top, foot, height in self._taluses(zz, oo, slopes):
                if height >= self.FALL_MIN and (found[name][1] is None or mean > found[name][1][0]):
                    found[name][1] = (mean, top, along, foot, height)
        return found, borders, stops, drawn

    def _edges_sides(self, sides, borders, found, stops, drawn, twins, sigma, origin):
        """Bords, chutes et dévers de chaque côté (voir _compute_edges) : (lignes du texte, bords trouvés pour l'infobulle,
        résultats par côté pour le graphique de la page)."""
        lines, seen, shown = [], [], {}
        for name, _ in sides:
            if borders[name]:
                by_relief = sum(r for _, r, _ in borders[name])
                by_others = sum(m for _, _, m in borders[name])  # ramenés à la médiane des autres travers
                seen.append("côté {} à {} m de {} ({}{}{})".format(
                    name, measures._num(sorted(o for o, _, _ in borders[name])[len(borders[name]) // 2], 1), origin,
                    "relief sur {} travers sur {}".format(by_relief, len(borders[name])) if by_relief
                    else "largeur BD TOPO", f", {by_others} d'après les travers voisins" if by_others else "",
                    ", au-delà du séparateur de chaussée ({}) et de l'autre chaussée".format(
                        "trouvé dans le relief" if any(e.get("separateur_relief") for e in drawn if e["cote"] == name)
                        else "d'après la BD TOPO") if twins[name] else ""))
            fall, slope_max = found[name]
            stop = sorted(stops[name])[len(stops[name]) // 2] if stops[name] else None
            if fall is None or fall[0] < self.FALL_MIN:
                if stop is not None:
                    lines.append("Côté {} : pas de chute avant le terrain qui remonte de {} m, à {} m du bord".format(
                        name, measures._num(self.EDGE_RISE, 0), _distance(stop)))
                continue
            beyond = fall[1] >= fall[2] - 1e-6  # le plus bas au bout du profil : le terrain descend encore
            text = "Côté {} : chute {}{} m (±{} m) {} {} m du bord".format(
                name, "≥ " if beyond else "", measures._num(fall[0], 1), measures._num(sigma, 1),
                "au-delà de" if beyond else "à", _distance(fall[1], whole=beyond))  # au-delà : le bout du profil, au mètre
            if slope_max and slope_max[0] > 0:
                text += ", dévers du talus {} % ({}°) sur {} m de haut".format(
                    measures._num(100 * slope_max[0], 0), measures._num(math.degrees(math.atan(slope_max[0])), 0),
                    measures._num(slope_max[4], 1))
            lines.append(text)
            shown[name] = {"chute": [round(fall[0], 2), round(fall[1], 2), beyond, fall[3]],
                           "devers": [round(slope_max[0], 3), round(slope_max[1], 2), slope_max[2],
                                      round(slope_max[3], 2), round(slope_max[4], 2)]
                           if slope_max and slope_max[0] > 0 else None}
        return lines, seen, shown

    def _edges_title(self, source, origin, zone, seen):
        """Infobulle des bords : méthode, puis les bords trouvés (seen)."""
        return ("Terrain ({}) en travers de la route, depuis {} jusqu'à {} m au-delà du bord de la chaussée, "
                "sur ±{} m le long de la route ; côtés vus dans le sens de la photo. Bord : rupture de pente "
                "ou marche du terrain (bordure), sinon largeur BD TOPO (ou {} m supposés) ; dès 3 travers trouvés "
                "dans le relief, un travers sans rupture ou au bord à plus de {} m de leur médiane prend cette "
                "médiane (d'après les travers voisins) ; chaussées séparées : "
                "bord extérieur de l'autre chaussée, séparateur de chaussée compris (entre deux marches du "
                "terrain, sinon d'après la BD TOPO). Chute : plus grande descente sous le "
                "terrain du bord, lue jusqu'à ce que le terrain remonte de {} m au-dessus du bord (talus, "
                "butte). Dévers : pente moyenne du talus le plus raide, de son haut à son pied (pente sur {} m "
                "repassée sous {} %). Bords trouvés : {}.").format(
            source, origin, measures._num(zone, 0), measures._num(self.EDGE_ALONG[-1], 0),
            measures._num(self.FALL_WIDTH, 0), measures._num(self.EDGE_CONSENSUS, 0), measures._num(self.EDGE_RISE, 0),
            measures._num(self.EDGE_WINDOW, 0),
            measures._num(100 * self.EDGE_TALUS, 0), " ; ".join(seen) or "aucun")

    def _long_profile(self, pts, ends, along_of, followed):
        """Profil en long de la route sous la photo (pts : [(d en m dans le sens de la photo, altitude)]) : fins de la route
        et carrefours avec une voie nommée (ends, voir _chained), creux et ponts comblés (_bridged), tunnels ; pente moyenne
        et la plus forte sur LONG_WINDOW m. None avec moins de 5 points. along_of(p) : position d'un point le long de la route."""
        # Fin de la route de la photo et carrefours avec une voie nommée, le long d'elle ; au-delà d'une fin, pas de profil
        # (la caméra a pu continuer sur une autre route)
        cuts = []
        for p, kind, names in ends[0]:
            d = round(along_of(p), 1)
            if -self.LONG_REACH - 1 <= d <= self.LONG_REACH + 1 and all(abs(d - e["d"]) > 1 for e in cuts):
                cuts.append({"d": d, "type": kind, "voie": ends[1], "avec": names})
        # Carrefour à îlot séparateur : la voie qui arrive y est faite d'un tronçon par sens, qui touchent la route en deux
        # points proches ; un seul repère au milieu (LONG_JUNCTION m au plus entre eux, même voie)
        cuts.sort(key=lambda e: e["d"])
        merged = []
        for e in cuts:
            last = merged[-1] if merged else None
            if (last and e["type"] == last["type"] == "carrefour" and set(e["avec"]) & set(last["avec"])
                    and e["d"] - last["d0"] <= self.LONG_JUNCTION):
                last["d"] = round((last["d0"] + e["d"]) / 2, 1)
                last["avec"] = sorted(set(last["avec"]) | set(e["avec"]))
            else:
                merged.append(dict(e, d0=e["d"]))
        cuts = [{k: v for k, v in e.items() if k != "d0"} for e in merged]
        for e in cuts:
            if e["type"] == "fin":
                pts = [(d, v) for d, v in pts if (d <= e["d"] + 1e-6 if e["d"] > 0 else d >= e["d"] - 1e-6)]
        cuts = [e for e in cuts if pts and pts[0][0] - 1 <= e["d"] <= pts[-1][0] + 1]
        # Creux (ponts, même absents de la BD TOPO) : terrain remplacé par la droite d'un bord à l'autre (le tablier, à peu
        # près), pente comprise ; nommés « pont » s'ils recouvrent un pont de la route
        bridges = [sorted((along_of(a), along_of(b))) for level, a, b in ends[2] if level > 0]
        pts, dips = self._bridged(pts, bridges)
        spans = [{"de": round(lo, 1), "a": round(hi, 1),
                  "type": "pont" if any(b0 <= hi and b1 >= lo for b0, b1 in bridges) else "creux"} for lo, hi in dips]
        # Tunnels de la route : le MNT y donne le dessus, remplacé par la droite d'une tête à l'autre
        for level, a, b in ends[2]:
            lo, hi = sorted((along_of(a), along_of(b)))
            before = [(d, v) for d, v in pts if d <= lo + 1e-6]
            after = [(d, v) for d, v in pts if d >= hi - 1e-6]
            if level > 0 or not pts or hi < pts[0][0] or lo > pts[-1][0]:
                continue
            if before and after:
                (d0, z0), (d1, z1) = before[-1], after[0]
                pts = [(d, z0 + (z1 - z0) * (d - d0) / ((d1 - d0) or 1.0)) if d0 < d < d1 else (d, v) for d, v in pts]
            else:  # tunnel au bout du profil, une seule tête : pas de terrain dessus
                pts = [(d, v) for d, v in pts if not lo < d < hi]
            spans.append({"de": round(lo, 1), "a": round(hi, 1), "type": "tunnel"})
        grade = None
        if len(pts) >= 5:
            md, mz = sum(d for d, _ in pts) / len(pts), sum(v for _, v in pts) / len(pts)
            mean = sum((d - md) * (v - mz) for d, v in pts) / (sum((d - md) ** 2 for d, _ in pts) or 1.0)
            windows = [((b[1] - a[1]) / (b[0] - a[0]), a[0], b[0]) for k, a in enumerate(pts) for b in pts[k + 1:]
                       if abs(b[0] - a[0] - self.LONG_WINDOW) < 1e-6]  # (pente, de, à) sur LONG_WINDOW m
            steep = max(windows, key=lambda c: abs(c[0]), default=None)
            grade = {"points": [[d, round(v, 2)] for d, v in pts], "pente": round(100 * mean, 1), "suivi": followed,
                     "fins": sorted(cuts, key=lambda e: e["d"]), "ouvrages": spans,
                     "max": [round(100 * steep[0], 1), steep[1], steep[2]] if steep else None}
        return grade

    def _taluses(self, zz, oo, slopes):
        """Talus d'un travers, depuis le bord : [(pente moyenne, haut et pied en m du bord, hauteur)]. Talus : pentes sur
        EDGE_WINDOW m (slopes, une par point) d'au moins EDGE_TALUS, resserrées autour de la plus forte sur celles d'au moins
        EDGE_CORE fois elle (sans l'accotement en pente douce ni la queue du pied). Les fenêtres de EDGE_WINDOW m débordent
        sur le plat du haut et du fond : le haut avance tant que le pas suivant descend de moins de EDGE_TALUS / 2, le pied
        est le premier point à EDGE_FLAT m du plus bas (jusqu'au bout de la dernière fenêtre en pente) ; sinon le talus
        compte ces plats et sa pente est minorée (50 % lu à 33 % : piste P8 de docs/analyses/pistes-profil.md)."""
        out, k = [], 0
        while k < len(oo):
            if slopes[k] < self.EDGE_TALUS:
                k += 1
                continue
            first = k
            while k < len(oo) and slopes[k] >= self.EDGE_TALUS:
                k += 1
            steep = max(range(first, k), key=lambda j: slopes[j])
            floor = max(self.EDGE_TALUS, self.EDGE_CORE * slopes[steep])
            top, end = steep, steep + 1
            while top > first and slopes[top - 1] >= floor:
                top -= 1
            while end < k and slopes[end] >= floor:
                end += 1
            last = next((j for j in range(end - 1, len(oo)) if oo[j] - oo[end - 1] >= self.EDGE_WINDOW - 1e-6), len(oo) - 1)
            foot = min((j for j in range(top, last + 1) if zz[j] is not None), key=lambda j: zz[j])
            foot = next(j for j in range(top, foot + 1) if zz[j] is not None and zz[j] <= zz[foot] + self.EDGE_FLAT)
            while (top + 1 < foot and zz[top] is not None and zz[top + 1] is not None
                   and zz[top] - zz[top + 1] < self.EDGE_TALUS / 2 * (oo[top + 1] - oo[top])):
                top += 1
            height = zz[top] - zz[foot]
            out.append((height / (oo[foot] - oo[top]) if foot > top else 0, oo[top], oo[foot], height))
        return out

    def _terrain(self, points, done):
        """precision.fetch_terrain par paquets de FALL_POINTS points (une requête chacun), l'un après l'autre ;
        done(altitudes, source, erreur). Une seule source pour des altitudes comparées entre elles : chaque paquet choisit
        la sienne (LiDAR HD, RGE ALTI s'il y manque un point) ; si l'un est passé en RGE ALTI, tous sont relus en RGE ALTI."""
        out, sources = [], []
        chunks = [points[k:k + self.FALL_POINTS] for k in range(0, len(points), self.FALL_POINTS)]

        def step(k):
            def got(ground, source, error):
                if error or not source:
                    return done(None, source, error)
                out.extend(ground if len(ground) == len(chunks[k]) else [None] * len(chunks[k]))  # incomplète : pas décalée
                sources.append(source)
                if k + 1 < len(chunks):
                    return step(k + 1)
                if len(set(sources)) == 1:
                    return done(out, source, None)
                relay(0, [])  # sources mêlées

            precision.fetch_terrain(chunks[k], got)

        def relay(k, zs):  # tous les paquets en RGE ALTI
            def got(data, error):
                if error:
                    return done(None, None, error)
                z = precision._ground(data) if data else []
                zs.extend(z if len(z) == len(chunks[k]) else [None] * len(chunks[k]))  # réponse incomplète : pas décalée
                if k + 1 < len(chunks):
                    return relay(k + 1, zs)
                done(zs, "RGE ALTI", None)

            host.fetch_json(precision.lidar_url(chunks[k], precision.RGE_RESOURCE), got, timeout_ms=precision.TIMEOUT_MS)

        step(0)

    def use_paved_edges(self, frame, edges):
        """Bords d'enrobé de l'analyse fine (src/nuage.js) pour le profil de repère frame (JSON de profile.repere) : edges,
        en JSON, m depuis l'origine par côté (« gauche », « droit »). Plateforme, dévers, chute et dévers du talus de ce
        profil se relisent depuis eux, sur tous les travers, sans nouvelle lecture du terrain s'il vient d'être calculé."""
        frame = tuple(tuple(p) for p in json.loads(frame))
        self.paved[frame] = json.loads(edges)
        redo = self.paved_redo.get(frame)
        for key, res in list(self.edges.items()):  # autre largeur examinée : recalculée à la demande
            profile = res.get("profile")
            if profile and tuple(tuple(p) for p in profile["repere"]) == frame and (not redo or key != redo[0]):
                del self.edges[key]
        if redo:
            redo[1]()

    def fall_json(self):
        """Hauteur de chute (voir fall), en JSON : demandée par la page hors lecture de la séquence
        (sinon une lecture BD TOPO par maille de 100 m traversée)."""
        return json.dumps(self.fall())
