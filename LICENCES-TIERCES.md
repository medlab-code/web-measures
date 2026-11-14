<!-- SPDX-FileCopyrightText: 2026 Cédric COCHART -->
<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# Licences tierces et mentions

Mesures Panoramax (web-measures) © 2026 Cédric COCHART, sous licence GPL v2 ou ultérieure (fichier `LICENSE`).

L'application n'embarque aucun code tiers : les bibliothèques ci-dessous sont chargées par le navigateur depuis
jsDelivr (`cdn.jsdelivr.net`), aux versions épinglées indiquées, et les données sont lues auprès de leurs services.
Leurs licences s'appliquent à elles seules ; toutes autorisent l'usage commercial, à condition d'en garder les
mentions. Relevé du 01/11/2026 (déclarations du registre npm et fichiers de licence des projets).

## Bibliothèques

| Bibliothèque | Version | Licence | Titulaire | Usage |
| --- | --- | --- | --- | --- |
| [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) | 5.24.0 | BSD-3-Clause | contributeurs MapLibre (et Mapbox, code d'origine) | carte |
| [Panoramax web-viewer](https://gitlab.com/panoramax/clients/web-viewer) | 5.3.1 | MIT | équipe Panoramax | visionneuse des photos |
| [Pyodide](https://github.com/pyodide/pyodide) | 314.0.7 | MPL-2.0 | contributeurs Pyodide | Python dans le navigateur (cœur de calcul) |
| [NumPy](https://numpy.org) (dans Pyodide) | 2.4.6 | BSD-3-Clause | développeurs NumPy | calculs |
| [Pillow](https://python-pillow.org) (dans Pyodide) | 12.2.0 | MIT-CMU (HPND) | Jeffrey A. Clark et contributeurs | images |
| [laz-perf](https://github.com/hobuinc/laz-perf) | 0.0.7 | Apache-2.0 | Hobu, Inc. | nuage LiDAR HD (LAZ / COPC) |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | 5.2.1 | MIT | Vanilagy | export vidéo MP4 |
| [sql.js](https://github.com/sql-js/sql.js) | 1.13.0 | MIT (SQLite : domaine public) | contributeurs sql.js | lecture des GeoPackage |
| [shpjs](https://github.com/calvinmetcalf/shapefile-js) | 6.1.0 | MIT | Calvin Metcalf | lecture des Shapefile |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 1.4.4 | MIT | Kazuhiko Arase | codes QR |
| [Inter](https://fontsource.org/fonts/inter) (Fontsource) | 5.3.0 | SIL OFL 1.1 | Rasmus Andersson | police |
| [JetBrains Mono](https://fontsource.org/fonts/jetbrains-mono) (Fontsource) | 5.3.0 | SIL OFL 1.1 | JetBrains | police à chasse fixe |

Inclus dans le paquet de la visionneuse Panoramax, sous leurs propres licences : Photo Sphere Viewer (MIT),
Lit (BSD-3-Clause), PMTiles (BSD-3-Clause), Font Awesome Free (icônes CC BY 4.0, code MIT), Atkinson Hyperlegible
Next (SIL OFL 1.1), iconify-icon et JSON5 (MIT), MapLibre GL JS. Inclus dans shpjs : proj4js (MIT).

Licences mentionnées (textes de référence) : [MIT](https://opensource.org/license/mit),
[BSD-3-Clause](https://opensource.org/license/bsd-3-clause), [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0),
[MPL-2.0](https://www.mozilla.org/MPL/2.0/), [HPND / MIT-CMU](https://github.com/python-pillow/Pillow/blob/main/LICENSE),
[SIL OFL 1.1](https://openfontlicense.org), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fr).

## Données et services

| Source | Données | Licence |
| --- | --- | --- |
| IGN, Géoplateforme (`data.geopf.fr`) | BD TOPO (tronçons, PR, ponts, zones d'habitation, communes), ADMIN EXPRESS, LiDAR HD (MNT, MNH, nuages COPC), RGE ALTI, Parcellaire Express (cadastre), orthophotographies, Plan IGN | [Licence Ouverte Etalab 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/) : réutilisation libre, y compris commerciale, en citant « IGN » et la date de mise à jour |
| PROJ (`cdn.proj.org`) | grille du géoïde RAF20 de l'IGN (altitudes NGF) | Licence Ouverte Etalab 2.0 |
| Panoramax (`api.panoramax.xyz`, `panoramax.ign.fr`…) | photos, séquences | celle de chaque photo, donnée par son instance (Licence Ouverte pour l'IGN et le CD21 ; d'autres instances : CC BY-SA 4.0…) ; citer l'auteur |
| OpenFreeMap (`tiles.openfreemap.org`) | fond de carte OpenStreetMap (tuiles vectorielles OpenMapTiles) | données [ODbL](https://www.openstreetmap.org/copyright) « © les contributeurs d'OpenStreetMap » ; schéma OpenMapTiles (BSD, CC-BY) ; service gratuit, sans clé ni garantie |

Conditions d'usage des services, à respecter en plus des licences : la Géoplateforme limite les requêtes (5 par
seconde et par adresse IP pour l'altimétrie) ; OpenFreeMap est un service gratuit, financé par des dons,
sans garantie de disponibilité.
