# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Profils de campagne datés (ticket #70) : ce que l'on sait d'une campagne de prise de vue (producteur, véhicule, caméra, période)
pour poser la caméra : hauteur, roulis, bientôt tangage. Une table unique, CAMPAIGN_PROFILES ; le profil d'une photo est le premier
dont le producteur figure dans ses fournisseurs (providers) et dont la période contient sa date de prise de vue (profile_of). Rien à
choisir : le profil s'applique tout seul, et la vue du dessus, le panneau de calage et l'export disent lequel.

Champs d'une fiche :
- id, label : identifiant stable (colonne « profil » de l'export) et nom court affichable ;
- producer : identifiant du producteur (providers[*].id de la photo) ; vehicle, camera : textes ;
- first : premier jour inclus, end : jour de fin exclu (AAAA-MM-JJ, la date de prise de vue seule est comparée) ;
- height, height_sigma : hauteur de la caméra au-dessus du sol et son incertitude (m) ;
- roll, roll_sigma : défaut de roulis (degrés ajoutés au roulis tiré du dévers ; convention de l'application : positif = véhicule
  penché à droite, voir web_pose.roulis_vehicule_depuis_camera) et sa dispersion d'une photo à l'autre (degrés) ;
- pitch, pitch_sigma : tangage (None : inconnu, rien appliqué) ;
- method, provenance : comment les valeurs ont été obtenues, d'où elles viennent."""

FLEET_PRODUCER = "8f943f10-a781-4e03-a18c-de035be6f6f8"  # CD21 : imajbox sur Clio 5

HEIGHT_SIGMA_DEFAULT = 0.04  # m : incertitude de la hauteur d'une monture sans profil à lire (producteur sans fiche)
ROLL_SIGMA_DEFAULT = 1.0  # degrés : dispersion du roulis d'une photo à l'autre sans profil (docs/BIRDEYE.md : ±1°)

REQUIRED = ("id", "label", "producer", "vehicle", "camera", "first", "end", "height", "height_sigma", "roll", "roll_sigma",
            "method", "provenance")  # pitch et pitch_sigma : présents, mais None tant que le tangage n'est pas mesuré

# CD21, imajbox sur Clio 5, 2025. Hauteurs de caméra : relevées du 28/05 au 23/06/2025 (basse, 1,90 à 1,95 m lus entre photos) et
# dès le 24/06 (haute, 2,04 m le 25/06 et 2,10 m le 27/06 lus entre photos, 2,05 à 2,07 m le 03/07). Changement de véhicule : carrosserie
# claire jusqu'au 23/06 12:39, bleue dès le 24/06 12:12, les bords du véhicule sautent de -27,1° à -26,0°. shortcut: limite au jour
# (24/06, la date de prise de vue seule est comparée) faute de l'heure du changement entre le 23/06 12:39 et le 24/06 12:12
# (dates de montage non disponibles : prises de vue d'un prestataire). Hauteur prioritaire sur celle lue entre photos, qui se joue à
# quelques cm du seuil entre les deux montures, et seule sur un pont (sinon 1,90 m par défaut : bandes de passage piéton à 0,44 m
# au lieu de 0,50, f2a245d0-aeea-4249-ba9c-fad83b442a23 et 7dcdccf9-3c52-4c54-bc5b-de72740a7967, 13/11/2026).
# Roulis : mesuré le 13/11/2026 sur des passages piétons (tests/passages-pietons.js), 23 vues : roulis restant de +0,98° en médiane
# (verticale vue penchée vers la droite, soit caméra penchée à gauche), sans lien avec le dévers ni avec la monture, nul avec les
# verticales ; le véhicule penché de 1° à droite ramène ce roulis près de 0 : +1° (avant le 26/11/2026, même effet noté -1° dans la
# convention du cœur). Estimé avec 70 % du dévers en roulis du véhicule (web_pose.ROLL_SHARE) ; dispersion ±1° d'une photo à l'autre.
_CD21_HEIGHT_METHOD = "hauteur lue entre photos (parallaxe) et bords du véhicule dans le panorama ; monture d'après la date de prise de vue"
_CD21_ROLL_METHOD = "roulis restant mesuré sur 23 vues de passages piétons (médiane +0,98°) avec 70 % du dévers, arrondi à +1,0°"
_CD21_PROVENANCE = "mesures du 28/05 au 03/07/2025 et du 13/11/2026 (tests/passages-pietons.js, docs/BIRDEYE.md § 4.1) ; dates de montage non disponibles"

CAMPAIGN_PROFILES = (
    {"id": "cd21-2025-clio5-basse", "label": "CD21 2025, Clio 5, monture basse", "producer": FLEET_PRODUCER,
     "vehicle": "Clio 5 à carrosserie claire", "camera": "imajbox, monture basse",
     "first": "2025-01-01", "end": "2025-06-24", "height": 1.93, "height_sigma": 0.04, "roll": 1.0, "roll_sigma": 1.0,
     "pitch": None, "pitch_sigma": None, "method": _CD21_HEIGHT_METHOD + " ; " + _CD21_ROLL_METHOD, "provenance": _CD21_PROVENANCE},
    {"id": "cd21-2025-clio5-haute", "label": "CD21 2025, Clio 5, monture haute", "producer": FLEET_PRODUCER,
     "vehicle": "Clio 5 à carrosserie bleue", "camera": "imajbox, monture haute",
     "first": "2025-06-24", "end": "2026-01-01", "height": 2.07, "height_sigma": 0.04, "roll": 1.0, "roll_sigma": 1.0,
     "pitch": None, "pitch_sigma": None, "method": _CD21_HEIGHT_METHOD + " ; " + _CD21_ROLL_METHOD, "provenance": _CD21_PROVENANCE},
)


def check_profiles(profiles):
    """Liste des problèmes de la table (textes) : champ manquant, première date non antérieure à la fin, deux périodes qui se
    chevauchent pour un même producteur. Vide si la table est valide."""
    problems, seen = [], set()
    for k, p in enumerate(profiles):
        name = p.get("id") or f"fiche {k + 1}"
        missing = [f for f in REQUIRED if p.get(f) in (None, "")]
        if missing:
            problems.append(f"{name} : champ manquant ({', '.join(missing)})")
        if p.get("id") in seen:
            problems.append(f"{name} : identifiant en double")
        seen.add(p.get("id"))
        if not missing and p["first"] >= p["end"]:
            problems.append(f"{name} : le premier jour ({p['first']}) n'est pas avant la fin ({p['end']})")
    for k, a in enumerate(profiles):
        for b in profiles[k + 1:]:
            if all(q.get(f) not in (None, "") for q in (a, b) for f in ("producer", "first", "end")) and a["producer"] == b["producer"] \
                    and a["first"] < b["end"] and b["first"] < a["end"]:
                problems.append(f"{a.get('id')} et {b.get('id')} : périodes qui se chevauchent")
    return problems


def _date_of(item):
    return str(((item or {}).get("properties") or {}).get("datetime") or "")[:10]


def profile_of(item, profiles=CAMPAIGN_PROFILES):
    """Profil de campagne de la photo (fiche STAC) : le premier dont le producteur est l'un de ses fournisseurs et dont la période
    contient sa date de prise de vue (premier jour inclus, jour de fin exclu) ; None sinon."""
    date = _date_of(item)
    producers = {p.get("id") for p in (item or {}).get("providers") or []}
    return next((p for p in profiles if p["producer"] in producers and p["first"] <= date < p["end"]), None)


def producer_profiles(producer, profiles=CAMPAIGN_PROFILES):
    """Profils d'un producteur, dans l'ordre de la table."""
    return [p for p in profiles if p["producer"] == producer]


def fleet_height_sigma(producer, profiles=CAMPAIGN_PROFILES):
    """Incertitude (m) de la hauteur d'une monture du producteur, hors campagne connue : la plus grande de ses profils, ou
    HEIGHT_SIGMA_DEFAULT."""
    return max((p["height_sigma"] for p in producer_profiles(producer, profiles)), default=HEIGHT_SIGMA_DEFAULT)


_PROBLEMS = check_profiles(CAMPAIGN_PROFILES)
if _PROBLEMS:
    raise ValueError("Table CAMPAIGN_PROFILES invalide (py/web_profils.py) : " + " ; ".join(_PROBLEMS))
