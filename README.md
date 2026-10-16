# Mesures Panoramax (web-measures)

Application web de mesure sur les photos de rue [Panoramax](https://panoramax.fr), sans
installer QGIS : hauteur d'un objet, largeur d'une chaussée, distance entre deux points, à
préparer ou vérifier depuis le bureau.

Elle reprend les calculs du plugin QGIS
[Visionneuse Panoramax](https://github.com/medlab-code/visionneuse_panoramax), validés sur
des photos imajbox 360 HD à position RTK (Pouilly-en-Auxois, Montbard, Semur-en-Auxois…).

## Principe

Toutes les mesures s'appuient sur des **points triangulés** : un même point est visé depuis
au moins deux photos, et sa position est l'intersection des visées. La profondeur vient
ainsi de la triangulation, et non plus du terrain ni de la hauteur de caméra, auxquels les
mesures sur une seule photo étaient trop sensibles.

La précision dépend donc de celle de la position et du cap des photos : les mesures sont
fiables sur des photos à **position GPS RTK vérifiée** (voyant RTK vert). Ailleurs, elles
restent possibles, mais la page prévient qu'elles seront probablement incohérentes.

## Utilisation

**Ouvrir la page** : double-cliquer sur `index.html` suffit (Edge, Chrome, Firefox), sans
installation ni serveur ; une connexion à internet est nécessaire (bibliothèques, Pyodide et
services). Elle peut aussi être publiée sur n'importe quel serveur web statique, ou servie
localement :

```
python3 -m http.server 8765    # puis http://127.0.0.1:8765/
```

**Choisir une photo** : cliquer sur le filaire orange de la carte (photo la plus proche) ; la
photo s'ouvre dans la visionneuse officielle Panoramax. Les flèches de la visionneuse passent
aux photos voisines.

**Mesurer** : bouton « 📐 Mesure », puis le mode :

- **Hauteur d'un objet**
  1. Viser le **pied** de l'objet depuis au moins deux photos (un clic par photo, flèches
     pour changer de photo), puis « Valider le point » : c'est le point de référence.
  2. Cliquer le **sommet**, depuis une photo qui a servi à la visée : le pied est la visée
     faite depuis elle. Depuis une autre photo, cliquer le pied puis le sommet.

  Le même point de référence sert à plusieurs hauteurs, depuis n'importe quelle photo,
  jusqu'à « Nouveau point de référence ». Une verticale verte le repère dans la photo.
- **Largeur perpendiculaire à la chaussée**
  1. Viser le **premier bord** (pied de bordure, marquage…) depuis au moins deux photos, puis
     « Valider le point ». La page trace la **droite de mesure**, perpendiculaire à l'axe de
     la route en ce point (BD TOPO, sinon trajectoire de la séquence), en bleu dans la photo
     et sur la carte.
  2. Cliquer le **bord opposé** depuis une photo prise quelques mètres avant ou après le
     point, pas juste en face : seule la direction du clic compte, le bord est là où elle
     coupe la droite.

  Chaque clic donne une largeur depuis le même point, jusqu'à « Nouveau point de référence ».
- **Mesure libre (points triangulés)** : viser chaque point depuis au moins deux photos, puis
  « Valider le point » ; à partir du deuxième, la distance horizontale au point précédent
  s'affiche, et la carte se cadre sur le segment.

Repères visuels : liseré et étiquette animée **bleus** pendant les visées, **jaunes** pendant
la prise de mesure ; croix bleues pour les visées, jaunes pour les points de mesure. Points,
traits et étiquettes restent visibles sur toutes les photos (là où ils ont été cliqués, ou
projetés au sol sur les autres photos).

**Recaler un point** : **clic droit** sur sa croix pour le sélectionner, puis :

- clic gauche : nouvelle position (bord d'une largeur : nouvelle direction ; point de
  référence d'une largeur : visée de plus, il est retriangulé ; hauteur : sur la photo de la
  mesure) ;
- flèches du clavier, par pas de 1 cm : largeur, le long de la droite de mesure (← → dans le
  sens vu sur la photo, ↑ ↓ en s'éloignant ou en se rapprochant de la caméra) ; hauteur,
  ↑ ↓ montent ou descendent le point ;
- **Entrée** pour terminer.

**Caler les photos** (modes « Calage ») :

- **inclinaison** : calculée automatiquement d'après les verticales de la photo (en arrière-
  plan), ou calée à la main sur des objets verticaux ;
- **cap et position** : repères cliqués dans la photo puis sur la carte. La triangulation
  n'est jamais meilleure que le cap et la position des photos : à 20 m, 1° d'erreur de cap
  décale une visée de 35 cm.

Le calage est gardé d'une visite à l'autre, et peut être exporté ou importé (« Réglages »).

**Autour de la mesure** :

- voyants **RTK**, **LiDAR HD** et **inclinaison** de la photo ;
- fonds de carte : Plan IGN, orthophoto, Ortho-express de l'année de la photo, PCRS de la
  Géoplateforme là où il est publié, OpenStreetMap ; recherche de lieux ; points de repère
  (PR) des routes ; route, PR et commune de la photo incrustés dans la visionneuse ;
- carte cadrée automatiquement sur la mesure en cours ;
- **filtre des photos** (date, type, précision GPS, producteur) et choix de l'**instance**
  Panoramax : les photos écartées ne s'ouvrent pas, ni par la carte ni par les flèches ;
- captures : vue recalculée en Full HD depuis la photo originale, ou visionneuse avec les
  mesures (PNG, copiée dans le presse-papiers) ;
- liste des résultats avec commentaire et effacement de chacun ; **export CSV**
  (point-virgule, virgule décimale) et **GeoJSON**.

Les calculs sont ceux du plugin, exécutés dans le navigateur par Pyodide (environ 10 Mo au
premier chargement, puis en cache) ; les calculs lourds (inclinaison automatique, capture
Full HD) tournent dans un second Pyodide en arrière-plan. La page vérifie aussi l'accès aux
services depuis le poste (encart « Accès aux services »).

Pour s'ouvrir en `file://`, la page n'utilise pas de modules JavaScript ni de lecture de
fichiers voisins : scripts ordinaires, et fichiers Python regroupés dans `py/sources.js`.

## Précision

Essais sur deux photos imajbox à position RTK (±0,10 m) de Pouilly-en-Auxois, distantes de
5 m, sur des cibles connues (`tests/essai-rtk.html`, `essai-largeur.html`,
`essai-libre.html`) :

| Mesure | Résultat | Attendu |
|---|---|---|
| Point de référence (visées croisées à 54°) | ±0,17 m | sur la cible |
| Hauteur | 3,46 m ± 0,11 m | 3,464 m |
| Largeur (clic à 40° de la droite de mesure) | 8,00 m ± 0,48 m | 8 m |
| Distance entre deux points | 3,60 m ± 0,24 m | 3,606 m |

L'incertitude de la largeur vient surtout de l'axe de la route (±2° supposés pour la
BD TOPO) et de la position du point de référence le long de la route : un clic depuis une
photo plus éloignée, qui voit la droite plus en face, la réduit. Avec un GPS grand public
(±4 m), le point de référence est à plusieurs mètres près, et une hauteur à ±2 à 3 m.

### Limites

- Mesures fiables seulement sur des photos à position RTK vérifiée.
- Points projetés sur les autres photos que celle du clic : sol supposé plat, à la hauteur
  de caméra du réglage (affichage seulement, la mesure n'en dépend pas).
- Incertitude de l'axe de la route (±2° pour la BD TOPO, ±3° pour la trajectoire) estimée,
  à confirmer sur le terrain.
- Mesures perdues en fermant la page : les exporter avant.
- Mini-carte détachable sur un second écran : à faire (ticket #13).

### Organisation

| Fichier | Rôle |
|---|---|
| `index.html`, `src/style.css` | page et mise en page |
| `img/panoramax.svg` | logo Panoramax (repris de la visionneuse Panoramax, licence MIT) |
| `src/app.js` | relie carte, visionneuse et calcul : clics, clavier, repères, liseré, filtre |
| `src/carte.js` | carte MapLibre : fonds, filaire, points de repère (PR), mesures, étiquettes, poignées, photo la plus proche |
| `src/calcul.js` | chargement de Pyodide (page et arrière-plan) et des fichiers Python (`py/sources.js`) |
| `src/services.js` | vérification de l'accès aux services |
| `src/recherche.js` | recherche de lieux sur la carte (commune, lieu-dit, voie, adresse) |
| `src/lieu.js` | route, point de repère (PR) et commune de la photo, incrustés dans la visionneuse |
| `py/web_app.py` | application de mesure : clics → cœur de calcul → JSON pour la page (points de référence, hauteurs, largeurs, mesure libre, recalages) |
| `py/web_host.py` | accès réseau du cœur par le `fetch` du navigateur |
| `py/web_worker.py` | calculs lourds dans le Pyodide d'arrière-plan |
| `py/geoid.py` | altitude NGF (grille RAF20 de l'IGN) |
| `py/core/` | cœur de calcul du plugin, **copié** par `tools/update-core.sh` (ne pas modifier ici) ; dont `widths.py`, la largeur depuis un point triangulé |
| `py/sources.js` | fichiers Python de `py/` regroupés pour la page (généré par le même script) |
| `tests/navigateur.html` | essai de bout en bout dans un vrai navigateur |
| `tests/essai-rtk.html`, `essai-largeur.html`, `essai-libre.html` | hauteur, largeur, mesure libre sur photos RTK, avec recalages |
| `tests/inclinaison.html`, `etiquettes.html` | inclinaison automatique ; placement des étiquettes |
| `tools/serveur-essai.py` | serveur des essais : sert le site et affiche leur journal |

Mettre à jour le cœur : `tools/update-core.sh [dossier du plugin] [révision]` (par défaut
`../visionneuse_panoramax`, branche `dev`) ; la révision copiée est notée dans
`py/core/SOURCE`. À relancer aussi après toute modification d'un fichier Python sous `py/`
(il régénère `py/sources.js`).

## Choix

D'après la feuille de route du plugin (`docs/feuille-de-route.md`, 12/10/2026) :

- **Site statique** : pas d'installation sur des postes verrouillés ; les services publics
  sont appelés directement depuis le navigateur.
- Usage **au bureau** : poste fixe, grand écran, souris, connexion filaire. Pas de tablette
  ni de 4G à prévoir.
- Carte **MapLibre** : filaire Panoramax (mêmes tuiles vectorielles que le plugin), fonds de
  la Géoplateforme IGN, sans clé.
- Visionneuse officielle **`@panoramax/web-viewer`** (licence MIT) intégrée à la page.
- **Cœur de calcul en Python dans le navigateur (Pyodide)** : le même code que le plugin,
  sans portage, et ses tests restent la référence. Le téléchargement initial de Pyodide est
  acceptable au bureau.
- Interface réduite : hauteur, largeur, distance entre points ; calage seulement si
  nécessaire.
- **Indicateur de fiabilité** bien visible, d'après la vérification de la position GPS, la
  présence du LiDAR HD et le calage de l'inclinaison de la photo.
- Export CSV et GeoJSON des mesures ; base partagée plus tard.

## Accès aux services depuis le navigateur

La page liste chaque service et indique s'il répond depuis le poste (proxy, pare-feu, en-têtes
CORS). Vérifié le 13/10/2026 depuis un poste personnel, avec Chrome :

| Service | Usage | Depuis un navigateur |
|---|---|---|
| Panoramax : recherche, tuiles, photos (`api.panoramax.xyz`, `panoramax.ign.fr`) | filaire, photos, métadonnées | accessible |
| Géoplateforme IGN : WMTS | Plan IGN, orthophoto | accessible |
| Géoplateforme IGN : altimétrie | profil du terrain (LiDAR HD, RGE ALTI) | accessible |
| Géoplateforme IGN : WMS (`wms-r`) | MNS du LiDAR HD (façades) | accessible |
| Géoplateforme IGN : WFS | BD TOPO (axe de la route, route et PR de la photo, PR sur la carte), cadastre (façades) | accessible |
| Géoplateforme IGN : géocodage | recherche de lieux (autocomplétion) | accessible |
| geo.api.gouv.fr | commune de la photo | accessible |
| Open-Meteo | altitudes de secours | accessible |

**À refaire depuis le poste des utilisateurs** (proxy ou pare-feu d'entreprise) : ouvrir la page et relever la liste.

## Étapes

1. ~~Séparer le cœur de calcul de QGIS~~, dans le plugin : paquet `core/` sans import QGIS,
   services de l'hôte (réseau, altitude NGF, décodage d'image) installés par l'application.
2. ~~Maquette~~ : visionneuse officielle, cœur dans Pyodide, largeur, longueur et hauteur,
   recalage sur la carte, export CSV et GeoJSON.
3. ~~Indicateur de fiabilité, inclinaison automatique, triangulation~~ : voyants RTK, LiDAR
   HD et inclinaison, inclinaison automatique en arrière-plan, mesure libre entre points
   triangulés.
4. ~~Mesures appuyées sur un point triangulé~~ (16/10/2026) : hauteur et largeur depuis un
   point de référence, recalage au clic droit et au clavier ; longueur sur une seule photo
   et calage de la hauteur de caméra retirés.
5. Essais sur le terrain avec les agents (postes, photos RTK) ; mini-carte détachable
   (ticket #13).

## Licence

GPL v2 ou ultérieure (fichier `LICENSE`), comme le plugin dont les calculs sont repris.
