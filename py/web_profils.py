# SPDX-FileCopyrightText: 2026 Cédric COCHART
# SPDX-License-Identifier: GPL-2.0-or-later
"""Profils de campagne datés (ticket #70) : ce que l'on sait d'une campagne de prise de vue (producteur, véhicule, caméra, période)
pour poser la caméra : hauteur, roulis, tangage. Une table unique, CAMPAIGN_PROFILES ; le profil d'une photo est le premier
dont le producteur figure dans ses fournisseurs (providers) et dont la période contient sa date de prise de vue (profile_of). Rien à
choisir : le profil s'applique tout seul, et la vue du dessus, le panneau de calage et l'export disent lequel.

Champs d'une fiche :
- id, label : identifiant stable (colonne « profil » de l'export) et nom court affichable ;
- producer : identifiant du producteur (providers[*].id de la photo) ; vehicle, camera : textes ;
- first : premier jour inclus, end : jour de fin exclu (AAAA-MM-JJ, la date de prise de vue seule est comparée) ;
- height, height_sigma : hauteur de la caméra au-dessus du sol et son incertitude (m) ;
- roll, roll_sigma : défaut de roulis (degrés ajoutés au roulis tiré du dévers ; convention de l'application : positif = véhicule
  penché à droite, voir web_pose.roulis_vehicule_depuis_camera) et sa dispersion d'une photo à l'autre (degrés) ;
- pitch, pitch_sigma : défaut de tangage de la caméra par rapport à la route (degrés ; convention de la réglette de tangage de la vue du
  dessus : positif = caméra relevée vers l'avant) et son incertitude (degrés) ; None (tous deux) : inconnu, rien appliqué. Appliqué
  seulement faute de tangage lu (raccords, verticales, clics, réglage à la main) : voir web_pose._pitch_default ;
- method, provenance : comment les valeurs ont été obtenues, d'où elles viennent."""

FLEET_PRODUCER = "8f943f10-a781-4e03-a18c-de035be6f6f8"  # CD21 : imajbox sur Clio 5 puis Captur

HEIGHT_SIGMA_DEFAULT = 0.04  # m : incertitude de la hauteur d'un véhicule sans profil à lire (producteur sans fiche)
ROLL_SIGMA_DEFAULT = 1.0  # degrés : dispersion du roulis d'une photo à l'autre sans profil (docs/BIRDEYE.md : ±1°)

REQUIRED = ("id", "label", "producer", "vehicle", "camera", "first", "end", "height", "height_sigma", "roll", "roll_sigma",
            "method", "provenance")  # pitch et pitch_sigma : facultatifs (None : tangage inconnu), mais ensemble

# CD21, imajbox 360 HD sur sangle (la même partout), 2025 et 2026. La hauteur de la caméra suit le VÉHICULE, pas un montage (constat de
# l'auteur et étude des véhicules du 27/11/2026, #75 : toit visible au bas des panoramas, reflets dans les vitrines, hauteur par
# parallaxe) : Clio 5 blanche (1,93 m) jusqu'au 23/06/2025 et le 11/06/2026 ; Captur bleu (2,07 m) du 24/06 au 08/07/2025 (aucune prise
# de vue le 09/07) ; Captur bicolore (2019, 2,07 m) dès le 10/07/2025, jusqu'à la fin de 2025 (prises de vue jusqu'au 09/10/2025).
# Un seul véhicule par jour. Le 16/06/2025, la sangle était calée par une paire de chaussures (« dispositif large »), sans effet
# mesuré sur la hauteur. Hauteurs de caméra lues entre photos : 1,90 à 1,95 m du 28/05 au 23/06/2025, 2,04 m le 25/06 et 2,10 m le
# 27/06, 2,05 à 2,07 m le 03/07. Les bords du véhicule sautent de -27,1° à -26,0° au changement du 24/06. Limites au jour (la date de
# prise de vue seule est comparée) ; dates de montage non disponibles (prises de vue d'un prestataire). Hauteur prioritaire sur celle
# lue entre photos, qui se joue à quelques cm du seuil entre les deux hauteurs, et seule sur un pont (sinon 1,90 m par défaut :
# bandes de passage piéton à 0,44 m au lieu de 0,50, f2a245d0-aeea-4249-ba9c-fad83b442a23 et 7dcdccf9-3c52-4c54-bc5b-de72740a7967,
# 13/11/2026).
# Roulis : mesuré le 13/11/2026 sur des passages piétons (tests/passages-pietons.js), 23 vues : roulis restant de +0,98° en médiane
# (verticale vue penchée vers la droite, soit caméra penchée à gauche), sans lien avec le dévers ni avec le véhicule, nul avec les
# verticales ; le véhicule penché de 1° à droite ramène ce roulis près de 0 : +1° (avant le 26/11/2026, même effet noté -1° dans la
# convention du cœur). Estimé avec 70 % du dévers en roulis du véhicule (web_pose.ROLL_SHARE) ; dispersion ±1° d'une photo à l'autre.
# Tangage : voir _CD21_PITCH_*. Les deux Captur ont les valeurs de la hauteur haute (2,07 ± 0,04, +0,2 ± 0,3, roulis +1,0 ± 1,0).
_CD21_HEIGHT_METHOD = "hauteur lue entre photos (parallaxe) et bords du véhicule dans le panorama ; véhicule d'après la date de prise de vue"
_CD21_ROLL_METHOD = "roulis restant mesuré sur 23 vues de passages piétons (médiane +0,98°) avec 70 % du dévers, arrondi à +1,0°"
_CD21_PITCH_BASSE = ("tangage lu sur les raccords entre photos de 17 photos de 8 flèches de rabattement (mire du 27/11/2026, cote 6,00 m) : "
                     "médiane par hauteur de caméra, +0,5 à +0,9° ; +0,7° trouvé aussi à la main par l'auteur (réglette Bird Eye) ; "
                     "sans tangage lu, 3 photos manquent +0,65, +0,69 et +0,83° pour retrouver 6,00 m")
_CD21_PITCH_HAUTE = ("tangage lu sur les raccords entre photos de 2 flèches de rabattement seulement (mire du 27/11/2026) : 0,0 à +0,5°, "
                     "moins sûr que pour la Clio 5, confirmation à la main à faire")
_CD21_PROVENANCE = ("mesures du 28/05 au 03/07/2025 et du 13/11/2026 (tests/passages-pietons.js, docs/BIRDEYE.md § 4.1) ; étude des "
                    "véhicules du 27/11/2026 (toit au bas des panoramas, reflets dans les vitrines, parallaxe ; #75) ; dates de montage "
                    "non disponibles ; une seule sangle pour tous les véhicules (le 16/06/2025, paire de chaussures sous la sangle, "
                    "sans effet mesuré sur la hauteur)")

CAMPAIGN_PROFILES = (
    {"id": "cd21-2025-clio5-blanche", "label": "CD21 2025, Clio 5 blanche", "producer": FLEET_PRODUCER,
     "vehicle": "Clio 5 blanche", "camera": "imajbox 360 HD, sur sangle",
     "first": "2025-01-01", "end": "2025-06-24", "height": 1.93, "height_sigma": 0.04, "roll": 1.0, "roll_sigma": 1.0,
     "pitch": 0.7, "pitch_sigma": 0.3, "method": _CD21_HEIGHT_METHOD + " ; " + _CD21_ROLL_METHOD + " ; " + _CD21_PITCH_BASSE,
     "provenance": _CD21_PROVENANCE + " ; tangage : flèches du 27/11/2026"},
    {"id": "cd21-2025-captur-bleu", "label": "CD21 2025, Captur bleu", "producer": FLEET_PRODUCER,
     "vehicle": "Captur bleu (1re génération probable)", "camera": "imajbox 360 HD, sur sangle",
     "first": "2025-06-24", "end": "2025-07-10", "height": 2.07, "height_sigma": 0.04, "roll": 1.0, "roll_sigma": 1.0,
     "pitch": 0.2, "pitch_sigma": 0.3, "method": _CD21_HEIGHT_METHOD + " ; " + _CD21_ROLL_METHOD + " ; " + _CD21_PITCH_HAUTE,
     "provenance": _CD21_PROVENANCE + " ; du 24/06 au 08/07/2025 (aucune prise de vue le 09/07) ; tangage : flèches du 27/11/2026"},
    {"id": "cd21-2025-captur-bicolore", "label": "CD21 2025, Captur bicolore (2019)", "producer": FLEET_PRODUCER,
     "vehicle": "Captur bicolore (2019)", "camera": "imajbox 360 HD, sur sangle",
     "first": "2025-07-10", "end": "2026-01-01", "height": 2.07, "height_sigma": 0.04, "roll": 1.0, "roll_sigma": 1.0,
     "pitch": 0.2, "pitch_sigma": 0.3, "method": _CD21_HEIGHT_METHOD + " ; " + _CD21_ROLL_METHOD + " ; " + _CD21_PITCH_HAUTE,
     "provenance": _CD21_PROVENANCE + " ; prises de vue du 10/07 au 09/10/2025 ; le 10/07/2025, premier jour du véhicule, tangage "
                   "décalé d'environ -0,6° (9 photos de 4 flèches de rabattement, même avec lecture sur les raccords), donc incertain "
                   "ce jour-là ; normal ensuite (15/07, octobre) : caméra probablement repositionnée après le premier jour ; "
                   "tangage : flèches du 27/11/2026"},
    # 2026 : une seule séquence publiée (11/06/2026), d'où une fin au 12/06 (fin exclue) ; à étendre quand d'autres séquences 2026
    # seront publiées. Mêmes niveaux que la Clio 5 blanche 2025 ; roulis non mesuré en 2026, repris de 2025.
    {"id": "cd21-2026-clio5-blanche", "label": "CD21 2026, Clio 5 blanche", "producer": FLEET_PRODUCER,
     "vehicle": "Clio 5 blanche", "camera": "imajbox 360 HD, sur sangle",
     "first": "2026-01-01", "end": "2026-06-12", "height": 1.93, "height_sigma": 0.05, "roll": 1.0, "roll_sigma": 1.0,
     "pitch": 0.7, "pitch_sigma": 0.3,
     "method": "hauteur lue entre photos (parallaxe, 33 photos le 11/06/2026) : médiane 1,929 m, IC 95 % [1,888 ; 1,940] ; écart RTK − sol "
               "médiane 1,94 m (69 photos) ; mêmes niveaux que la Clio 5 blanche 2025 ; roulis non mesuré en 2026, repris de 2025 ; "
               "tangage de la Clio 5 blanche 2025, repris (même véhicule)",
     "provenance": "étude du 27/11/2026, séquence 7d66f208-acb4-46f6-bb23-65d8717557a7 (11/06/2026, nord de Dijon) ; seule séquence 2026 "
                   "publiée ; véhicule reconnu par l'auteur (Clio 5 blanche, caméra à 1,94 m mesurée) ; dates de montage inconnues ; "
                   "une seule sangle pour tous les véhicules (#75)"},
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
        if (p.get("pitch") is None) != (p.get("pitch_sigma") is None):
            problems.append(f"{name} : pitch et pitch_sigma vont ensemble (tous deux renseignés, ou tous deux None)")
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


def pitch_of(profile):
    """(tangage par défaut, incertitude) en degrés du profil, convention de la réglette de tangage (positif : caméra relevée vers
    l'avant, relatif à la route) ; (0.0, None) sans profil ni tangage connu."""
    if not profile or profile.get("pitch") is None:
        return 0.0, None
    return float(profile["pitch"]), float(profile["pitch_sigma"])


def fleet_height_sigma(producer, profiles=CAMPAIGN_PROFILES):
    """Incertitude (m) de la hauteur d'un véhicule du producteur, hors campagne connue : la plus grande de ses profils, ou
    HEIGHT_SIGMA_DEFAULT."""
    return max((p["height_sigma"] for p in producer_profiles(producer, profiles)), default=HEIGHT_SIGMA_DEFAULT)


_PROBLEMS = check_profiles(CAMPAIGN_PROFILES)
if _PROBLEMS:
    raise ValueError("Table CAMPAIGN_PROFILES invalide (py/web_profils.py) : " + " ; ".join(_PROBLEMS))
