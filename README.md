# Mesures Panoramax (web-measures)

Application web de mesure sur les photos de rue [Panoramax](https://panoramax.fr), sans
installer QGIS : hauteur d'un objet, largeur d'une chaussée, distance entre deux points, à
préparer ou vérifier depuis le bureau.

Ses calculs viennent du plugin QGIS
[Visionneuse Panoramax](https://github.com/medlab-code/visionneuse_panoramax), et sont validés sur
des photos imajbox 360 HD à position RTK (Pouilly-en-Auxois, Montbard, Semur-en-Auxois…).

![Mesures Panoramax : hauteur d'un objet (1,10 m ± 0,04 m) à Venarey-les-Laumes, visionneuse, carte et résultats](docs/demo.jpg)

## Principe

Les mesures s'appuient sur des **points triangulés** : un même point est visé depuis au moins
deux photos, et sa position est l'intersection des visées. La profondeur vient de la
triangulation, et non du terrain ni de la hauteur de caméra.

La précision dépend donc de la position et du cap des photos : les mesures sont fiables sur
des photos à **position GPS RTK vérifiée** (voyant RTK vert). Ailleurs, elles restent
possibles, mais la page prévient qu'elles seront probablement incohérentes.

## Grandes fonctions

- **Mesures sur les photos**, guidées pas à pas : hauteur d'un objet, largeur perpendiculaire à la
  chaussée, distance et points libres, relevé d'objets en couche SIG. Chaque résultat porte son
  incertitude.
- **Mesures automatiques** : hauteur de chute sur un pont (nuage LiDAR HD), chute et dévers des
  bords de route (« Profils »), pente en long, analyse fine du nuage LiDAR.
- **Bird Eye** (essai) : la photo 360° reprojetée au sol sur la carte, pour mesurer des longueurs
  vues du dessus. Le véhicule peut être masqué par les photos voisines, l'inclinaison est calée
  automatiquement, et la carte se capture en PNG.
- **Carte** : fonds IGN (plan, orthophotos, PCRS, modèle de hauteur…), filaire des photos, points de
  repère des routes, cadastre, couche importée (GeoJSON, Shapefile, GeoPackage), recherche de lieux et requêteur
  route + PR. Elle peut être agrandie ou détachée dans une autre fenêtre.
- **Vidéo d'un itinéraire** : tracé sur la carte, photos choisies le long de la route, modes
  Brouillon, Présentation et Revue détaillée, compteurs et effets en option.
- **Résultats** : gardés dans le navigateur, export CSV et GeoJSON, fiches PDF, mesure exportée
  rouvrable, points recalables, calage de l'inclinaison des photos.

## Démarrage

Prendre l'archive « Source code (zip) » de la dernière version (page *Releases*) et la
décompresser, puis double-cliquer sur `index.html` (Edge, Chrome, Firefox) : ni installation ni
serveur, mais une connexion à internet (bibliothèques, Pyodide, services de l'IGN et de
Panoramax). La page peut aussi être servie par n'importe quel serveur web statique :

```
python3 -m http.server 8765    # puis http://127.0.0.1:8765/
```

À la première ouverture, l'instance Panoramax de l'IGN et les photos du conseil départemental
de la Côte-d'Or sont choisies par défaut : elles remplissent les prérequis des mesures. Le mode
d'emploi complet est dans [docs/GUIDE.md](docs/GUIDE.md).

## Précision

Les mesures de hauteur sont validées sur des objets connus. Sur deux photos RTK distantes de 5 m
(Pouilly-en-Auxois) :

| Mesure | Résultat | Attendu |
|---|---|---|
| Hauteur | 3,46 m ± 0,11 m | 3,464 m |
| Largeur | 8,00 m ± 0,23 m | 8 m |
| Distance entre deux points | 3,60 m ± 0,24 m | 3,606 m |

Les largeurs, les chutes de pont, les dévers et l'analyse fine du LiDAR attendent encore une
comparaison à des relevés sur place. Essais détaillés et limites : [docs/GUIDE.md](docs/GUIDE.md),
rubrique « Précision ».

## Documentation

| Document | Contenu |
|---|---|
| [docs/GUIDE.md](docs/GUIDE.md) | Mode d'emploi détaillé, précision et essais, organisation du code, choix techniques |
| [docs/CALCULS.md](docs/CALCULS.md) | Calcul de chaque mesure |
| [docs/BIRDEYE.md](docs/BIRDEYE.md) | Construction de la vue Bird Eye et ses recalages |
| [docs/MESURES.md](docs/MESURES.md) | Modèle de caméra et moteur de calcul repris du plugin |
| [docs/VERSIONS.md](docs/VERSIONS.md) | Historique des versions |
| [LICENCES-TIERCES.md](LICENCES-TIERCES.md) | Bibliothèques, données et services tiers |

## Version

**0.7.7** (13/11/2026) : Bird Eye (vue du dessus, mesures, véhicule masqué, capture PNG), hauteur
d'un objet en mode de départ, requêteur plus rapide, raccords de séquences en vidéo, cadastre
teinté. Détail et versions précédentes : [docs/VERSIONS.md](docs/VERSIONS.md).

## Licence

GPL v2 ou ultérieure (fichier `LICENSE`), comme le plugin dont les calculs sont repris. Bibliothèques, données et
services tiers, avec leurs licences et les mentions à garder : `LICENCES-TIERCES.md`.
