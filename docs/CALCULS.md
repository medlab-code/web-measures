<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Calculs des mesures

Ce document explique, mode par mode, comment l'application calcule ce qu'elle affiche, avec
les seuils retenus et ce qui limite la précision. Le mode d'emploi est dans le
[README](../README.md) (« Utilisation »), et les essais chiffrés dans sa partie « Précision ».
Les calculs communs avec le plugin QGIS (triangulation, inclinaison, vérification RTK) sont
détaillés dans `docs/MESURES.md` du plugin
[Visionneuse Panoramax](https://github.com/medlab-code/visionneuse_panoramax), sections 0, 2.7,
4.4 et 6.1 bis. Ici, ils sont résumés. Les calculs propres à l'application (pont, « Dévers »,
analyse fine, relevé) sont décrits en entier.

Code : cœur du plugin dans `py/core/` (copie, ne pas modifier ici), calculs propres à
l'application dans `py/web_app.py`, analyse fine du nuage dans `src/nuage.js`, dessin du profil
dans `src/profil.js`.

## 1. Ce qui sert à tous les modes

### 1.1 D'un clic à une visée

Un clic dans la photo 360° donne une direction depuis la caméra. Elle est tirée du **cap EXIF**
(juste à 0,3° près sur les photos de relevé, alors que le `view:azimuth` de Panoramax est
arrondi) et corrigée par l'**inclinaison** de la photo (§ 1.3). La position de la caméra est
celle du GPS de la photo.

### 1.2 Position vérifiée (voyant RTK)

Panoramax annonce souvent une précision générique. La séquence est jugée précise à **±0,10 m**
si l'EXIF déclare 0,20 m ou moins. Sinon, il faut une position corrigée (`GPSDifferential`) et
une hauteur de caméra constante sur les photos voisines (jusqu'à 20, à moins de 60 m). Cette
hauteur vaut l'altitude GPS, convertie en NGF-IGN69 par la grille RAF20, moins le sol LiDAR HD.
Elle est jugée constante si son écart-type est d'au plus 20 cm sur 8 photos au moins, si elle
est la même à 15 cm près sur les deux moitiés de la portion et si elle reste plausible (0,5 à
4 m). Si la portion autour de la photo est refusée, deux autres portions de la séquence sont
essayées.

Sans position vérifiée, les mesures restent possibles mais sont signalées comme probablement
incohérentes. La hauteur de chute d'un pont n'est pas calculée.

### 1.3 Inclinaison de la photo

Les panoramas ne sont pas mis à niveau : la caméra penche de 1 à 3° avec le véhicule, et 1°
déplace d'environ 37 cm un point au sol à 6 m. L'inclinaison est calculée en arrière-plan au
premier clic sur la photo :

1. **verticales de la photo** : arêtes verticales (façades, poteaux) repérées entre 3 et 45°
   au-dessus de l'horizon, puis moindres carrés avec rejet des arêtes penchées. Le résultat est
   retenu avec 40 segments au moins et une incertitude sous 0,25° (±0,05 à 0,25°) ;
2. **calage à la main** : pied et sommet de deux objets verticaux à environ 90° l'un de l'autre ;
3. **terrain hors agglomération** (option expérimentale, quand les verticales manquent) : pente
   et dévers du MNT LiDAR HD sous la caméra (grille de ±2,5 m × ±1,5 m, 55 points), plus le
   décalage de la fixation de la caméra. Ce décalage est appris sur des photos de village de la
   même séquence, calées par leurs verticales (3 au plus, 12 analysées au plus). Précision
   environ ±0,6°.

Quand l'inclinaison arrive après les clics, tout est recalculé : une mesure peut changer d'elle-même
une ou deux secondes après.

### 1.4 Terrain

**MNT LiDAR HD** de l'IGN (sol nu à 50 cm, ±0,1 m ; ponts et ouvrages retirés), sinon
**RGE ALTI** (1 m, ±0,4 m) là où il n'est pas encore publié. Le MNT sert à vérifier la position
(§ 1.2), à l'inclinaison (§ 1.3), à fixer l'altitude d'un point au sol triangulé en 3D (§ 2) et à
tous les profils (§ 7 à 9). Les tronçons de route, ponts, cours d'eau et zones d'habitation
viennent de la **BD TOPO** (WFS de la Géoplateforme).

## 2. Point triangulé

Toutes les mesures partent d'un **point triangulé** : le même point visé depuis au moins deux
photos. Sa position est l'intersection des visées par moindres carrés pondérés :

```
Σ wᵢ (I − uᵢ uᵢᵀ) X = Σ wᵢ (I − uᵢ uᵢᵀ) Pᵢ        wᵢ = 1 / σᵢ²,   σᵢ² = (tᵢ · tan εᵢ)² + aᵢ²
```

Dans cette formule, `tᵢ` est la distance de la photo au point, `εᵢ` l'erreur de visée et `aᵢ`
la précision de position de la photo. Une visée lointaine ou une photo mal placée compte moins.

- **Refus** : visées presque parallèles (moins de 3°), point derrière une photo ou à plus de
  500 m. **Signalé** : croisement sous 15°, GPS moins bon que ±5 m, et, dès trois visées, une
  visée à plus de 3 fois son erreur attendue des autres (autre objet visé ?).
- **En 3D** : si toutes les photos ont une altitude vérifiée et que les visées se croisent sous
  20° (photos en file, point loin devant), chaque visée garde son inclinaison. L'altitude d'un
  point au sol est alors contrainte par le MNT lu au point (±8 cm). Au-delà de 20°, le calcul en
  plan suffit.
- **Incertitude** : grand axe de l'ellipse d'erreur. Elle ne descend pas sous la part commune
  aux photos d'une même séquence (même décalage GPS, même erreur de cap), que plus de visées ne
  compensent pas.
- **Géométrie** : l'erreur vaut à peu près `σ / sin θ` (θ : angle de croisement). Viser avec au
  moins 30° de croisement, depuis des photos proches.

Ailleurs que sur leurs photos de visée, les points sont projetés au sol supposé plat, à la
hauteur de caméra de la photo. Cela ne sert qu'à l'affichage : la mesure n'en dépend pas.

## 3. Hauteur d'un objet

Le point triangulé est le **pied**. Sur une photo qui a servi à le viser, le pied est placé sur
la visée de cette photo, à la profondeur du point triangulé. Le **sommet** est cliqué sur la même
photo, dans le plan vertical qui passe par le pied :

```
hauteur = d · (tan e_sommet − tan e_pied)
```

où `d` est la distance horizontale de la caméra au pied et `e` l'élévation de chaque clic. Ni
le terrain ni la hauteur de caméra n'interviennent. L'incertitude combine l'inclinaison de la
photo, la visée des clics et la position du pied, déplacé d'un bloc avec le sommet. Les flèches
↑ ↓ recalent le sommet par pas de 1 cm sur la verticale.

## 4. Largeur perpendiculaire à la chaussée

Le premier bord `A` est triangulé. La **droite de mesure** passe par `A`, perpendiculairement à
l'axe de la route en `A`. Cet axe est pris, dans l'ordre :

1. sur la **trajectoire RTK** de la séquence sur ±20 m (±0,5°), si elle est droite (photos à
   moins de 10 cm de leur droite) et qu'elle concorde à 2° près avec la BD TOPO ;
2. sinon sur le **tronçon BD TOPO** qui longe la trajectoire (±2° supposés) ;
3. sinon sur la **trajectoire sans RTK** (±3°) ;
4. ou sur la **droite tracée sur la carte** (option expérimentale : giratoire, carrefour). Chaque
   clic est précis à 0,3 m près environ, soit ±2,4° pour une droite de 10 m et ±6° pour 4 m (4 m
   au moins). Le premier bord se pose alors d'un clic, là où sa visée coupe la droite, qui doit
   être vue à plus de 10°.

Le **bord opposé** `B` est là où la direction horizontale du clic coupe la droite : seule la
direction compte. Un clic à moins de 10° de la droite est refusé, et signalé rasant sous 25°.
La largeur vaut `|AB|`. Si `B` est triangulé à son tour (« Trianguler le point B »), la largeur
devient `|(B − A) · u|`, `u` étant perpendiculaire à l'axe : `B` peut être un peu avant ou après
`A`. L'incertitude combine, en somme quadratique, la position de `A` (et de `B`), l'axe, le cap
du clic et la position de la photo. L'axe et la position de `A` le long de la route pèsent le
plus.

## 5. Mesure libre

Distance horizontale entre deux points triangulés successifs. Les incertitudes des deux points
se combinent.

## 6. Relevé d'objets

Chaque objet est placé d'une de ces trois façons :

- **triangulé** (§ 2) : la façon normale ;
- **sur une seule photo** (« Garder sur cette seule photo ») : là où la visée touche le sol,
  supposé plat à la hauteur de caméra sous la photo. La visée doit descendre d'au moins 2° sous
  l'horizon, soit 70 m au plus pour une caméra à 2,5 m. L'incertitude vient surtout de
  l'inclinaison : ±0,2 à 0,8 m pour un objet à 6 m selon son calage ;
- **sur la carte** (« Placer sur la carte ») : le clic sur la mini-carte, à ±1 m (précision des
  orthophotos IGN), sans visée (`nb_visees` 0).

La voie, le PR et la commune sont ceux de la BD TOPO et des PR au point. `z_ngf` est l'altitude
du point triangulé en 3D, ou du sol à la verticale des photos RTK. Elle sert à dessiner l'objet
sur les autres photos, à 100 m au plus.

Une **couche importée** est dessinée à l'altitude de son fichier (z, en NGF). Sinon, elle est
posée sur le MNT lu sous la caméra et sous chaque objet (lignes redécoupées tous les 5 m). Ce
n'est qu'un affichage. Le **recalage dans la photo** est un décalage angulaire propre à la photo
(pas de 0,05°). La position de l'objet sur la carte ne change pas.

## 7. Hauteur de chute sur un pont

Ce calcul est automatique sur une photo prise sur un pont de la BD TOPO. Les tronçons en pont
qui se touchent à 1 m près forment un seul ouvrage.

- **Tablier** : altitude GPS des photos de la séquence prises sur le pont, convertie en NGF,
  moins la hauteur de caméra. En chaque point, la photo la plus proche est retenue.
- **Dessous** : MNT lu en travers du pont, à 1, 3, 6 et 10 m au-delà du bord de la chaussée
  (largeur BD TOPO, sinon 6 m), des deux côtés. Un travers tous les 2 m le long du pont (plus
  espacé sur un long pont), 160 points au plus : une seule requête. Sous le tablier, le MNT
  est interpolé à sa hauteur : le fond se lit à l'écart. Le terrain lu à 1 m seulement tombait
  sur le talus de la culée.
- **Hauteur** : la plus grande différence entre les deux, avec son incertitude (altitude RTK,
  tablier tiré des photos, terrain). Au-dessus de l'eau, c'est le niveau de l'eau le jour du
  relevé LiDAR.

Rien n'est affiché sans position RTK vérifiée : l'altitude du tablier serait fausse de plusieurs
mètres. Sous 0,5 m, la valeur est « non mesurée » (végétation, buse). Un fossé profond à moins
de 10 m de la chaussée peut augmenter la valeur.

## 8. « Dévers » : profil en travers

Ce calcul se lance d'un appui sur le bouton « Dévers », sur une photo hors pont, à moins de 15 m
d'une route de la BD TOPO. Il ne dépend pas de l'altitude GPS et n'a donc pas besoin du RTK.

### 8.1 Profils lus

La route est celle du tronçon BD TOPO le plus proche, prolongée par les tronçons voisins de même
nom (lus jusqu'à 60 m autour de la photo, mailles voisines comprises). Le MNT est lu en travers à
**−10, −5, 0, +5 et +10 m** de la photo le long de la route, des deux côtés. Les travers partent
de la caméra (séquence vérifiée RTK), sinon de l'axe BD TOPO. Un point est lu tous les **0,5 m**
jusqu'à 3 m au-delà du bord BD TOPO, puis 16 points jusqu'à la distance de la réglette au-delà
du bord (2 à 30 m, 10 m par défaut).

### 8.2 Bord de la chaussée

Sur chaque travers, à 1,5 m au moins de l'origine, le bord est le premier point :

- où la pente sur 1 m s'écarte de plus de **8 points** de celle de la chaussée sous l'origine,
  dans le même sens, sur **trois pas de suite** (fossé, talus). Un seul pas tiendrait du bruit
  du MNT (±5 cm), et le bombement fait environ 5 points ;
- ou à une **marche** de 5 cm ou plus sur 0,5 m qui tient sur 1,5 m (bordure, accotement plus
  bas).

Sans rupture de pente (accotement de plain-pied), le bord est à la demi-largeur BD TOPO
(sinon 3 m). Un bord d'un travers à plus de **3 m de la médiane** des bords trouvés de ce côté
est ramené à elle.

### 8.3 Chaussées séparées et séparateur

L'autre chaussée est reconnue à son tronçon BD TOPO : même nom, au sol, parallèle (à 30° près), son axe
à 4 à 40 m en travers et en face du point, pas au bout d'un tronçon décalé. De ce côté, le bord
est cherché au-delà de son axe et jusqu'à 9 m au-delà de son bord BD TOPO, car les largeurs BD
TOPO sont souvent trop faibles. La pente de référence est prise sous cet axe. La plateforme
comprend le séparateur et l'autre chaussée.

Le **séparateur de chaussée** est cherché :

1. entre deux **marches** de sens contraires (surélevé : montée puis descente ; en creux :
   l'inverse), large de 0,5 à 10 m, son milieu à 4 m au plus de celui que donnent les largeurs
   BD TOPO, et recoupé d'un travers à l'autre (médiane, 3 m) ;
2. à défaut, à une **bosse étroite** (1 ou 2 points, 4 cm au-dessus des voisins) au même endroit
   sur deux travers au moins : l'assise de glissières dos à dos ou d'un muret, que le MNT ne garde
   pas ;
3. sinon d'après la **BD TOPO** (milieu entre les deux chaussées).

Le profil dit d'où il vient : « (relief) », « (BD TOPO) » ou « (nuage LiDAR) » (§ 10).

### 8.4 Chute et dévers

- **Chute** : la plus grande descente entre le terrain au bord de la chaussée et le point le
  plus bas du profil. La distance donnée est celle du point le plus bas le plus proche du bord, à
  5 cm près. La lecture s'arrête là où le terrain remonte de **1 m** au-dessus du bord (talus,
  butte) : ce qu'il y a derrière n'est pas une chute. Si le point le plus bas est au bout du
  profil, la valeur est « chute ≥ … » : pousser la réglette. Un côté est affiché s'il descend de
  0,5 m au moins.
- **Dévers** : pente moyenne du talus le plus raide (0,5 m de haut au moins) avant cet arrêt,
  sur les cinq travers, de son haut à son pied (hauteur divisée par largeur), en % et en degrés.
  Le talus est la partie d'une descente (pente lue sur 2 m d'au moins 10 %) dont la pente vaut au
  moins le **tiers** de la plus forte. Cela écarte l'accotement en pente douce au-dessus et la
  queue du pied.

### 8.5 Eau

Cours d'eau de la BD TOPO croisés par le travers de la photo, sur 45 m de part et d'autre : les
tronçons fictifs et souterrains sont écartés. Les surfaces d'eau traversées (canal, plan d'eau)
sont dessinées sur le terrain : le MNT y donne la surface de l'eau le jour du relevé.

### 8.6 Caméra

La caméra est dessinée à sa hauteur (réglage « Hauteur de caméra ») au-dessus du sol sous
l'origine, seulement quand les hauteurs sont à l'échelle.

## 9. « Dévers » : pente en long

- **Ligne suivie** : la **trajectoire de la caméra** (photos de la même séquence, de rangs qui
  se suivent, un trou d'une photo admis), orientée dans le sens de la photo. C'est là où le
  véhicule a roulé, virage à un carrefour compris. À défaut, l'axe BD TOPO prolongé (§ 8.1) : à
  un nœud, le tronçon qui continue le plus dans l'alignement (60° au plus), à la même distance
  de l'axe que l'origine, car l'axe peut s'écarter de la voie de quelques mètres.
- **Lecture** : MNT tous les **2 m** sur **±50 m**. Le 0 est le sol sous la caméra.
- **Fin de la route** : là où aucun tronçon de la même route ne continue, le profil s'arrête
  (« fin de la D16 »), même si la caméra a continué sur une autre route. Les pentes ne portent
  que sur la partie gardée.
- **Carrefours** : « carrefour avec D18 » là où une voie **nommée** (numéro ou nom) se raccorde
  à la route, placé le long de la route. Deux raccordements de la même voie à moins de 30 m
  (îlot séparateur) font un seul carrefour, au milieu. Les voies sans numéro ni nom ne sont pas
  mentionnées.
- **Creux et ponts** : le MNT n'a pas les ponts, il donne le fond franchi. Le tronçon BD TOPO en
  pont est souvent plus court que la brèche, ou absent. Une route ne plonge pas de plus de 15 % :
  là où le terrain plonge de plus de **20 %** d'un point au suivant, il est remplacé par une droite
  (le tablier, à peu près, en tirets). Elle va du bord jusqu'au point où le terrain revient au
  niveau de la route (pas plus bas qu'une pente de 20 % depuis le bord), puis jusqu'en haut de la
  remontée. Le creux est nommé « pont » s'il recouvre un pont de la route, sinon « creux du terrain
  (pont ?) ». Les deux sens sont parcourus : un creux ouvert au bout du profil (pas d'autre bord) y
  est coupé.
- **Tunnels** de la route (BD TOPO) : le MNT y donne le dessus, remplacé par la droite d'une tête
  à l'autre. Un tunnel au bout du profil n'a qu'une tête : rien n'est dessiné dessus.
- **Pentes** : pente moyenne par les moindres carrés (montée ou descente dans le sens de la
  photo) et pente la plus forte sur **10 m**.

## 10. Analyse fine : nuage LiDAR HD

Elle se lance à la demande (bouton « Analyse fine » du profil) et lit le **nuage de points LiDAR
HD** de l'IGN (dalles COPC, trouvées par le WFS des métadonnées). Les blocs utiles sont lus à la
volée, une requête par seconde au plus : une vingtaine de secondes, 1 à 2 Mo. Les points sont
gardés sur ±1 m le long de la route autour du travers de la photo, ±32 m en travers, en cases de
0,25 m.

L'**intensité** du retour laser des points classés sol (classe 2) distingue les surfaces. Le
laser est en proche infrarouge :

- **enrobé** : sombre, sous 1,6 fois l'intensité sous l'origine ;
- **ligne blanche** : bande étroite (0,75 m au plus) au moins 3 fois plus claire que l'enrobé ;
- **surface non revêtue** (herbe, gravillons, béton) : bande d'au moins 1 m plus claire que
  l'enrobé ;
- **herbe au sol** : bande non revêtue en moyenne **3,5 fois** plus claire que l'enrobé. La
  végétation renvoie beaucoup l'infrarouge, les gravillons et le béton 2 à 3 fois seulement.

Ce que l'analyse en tire :

- **Bord de chaussée** : la ligne de rive, c'est-à-dire la ligne blanche au début de la première
  bande non revêtue, ou la dernière avant elle. Les lignes à moins de 1,2 m de l'axe d'une
  chaussée sont des lignes entre voies et sont écartées. Sans ligne de rive, le bord est la fin
  de l'enrobé. Les lignes blanches ne sont cherchées que sur la plateforme.
- **Séparateur** : la bande non revêtue entre les deux chaussées (0,5 à 12 m, glissières
  comprises, que le MNT ne voit pas), son milieu à 2 m au plus de celui du § 8.3, qu'elle
  remplace.
- **Végétation haute** : plus haut point des classes 3 à 5 (herbe haute, arbustes, arbres) à
  ±0,25 m près. La ligne est lissée sur ±1 m. La légende dit où elle commence de chaque côté, et
  sa hauteur au-dessus du sol au moment du relevé LiDAR (2021 à 2024 : fauchage, élagage ou
  repousse depuis).
- **Eau** : points de la classe 9, à leur altitude (niveau du jour du relevé). Souvent absents,
  car l'eau renvoie mal le laser.

Précision : celle du nuage (±0,1 m en altitude) et des cases (0,25 m en travers).

## 11. Récapitulatif de la précision

| Calcul | Ordre de grandeur | Ce qui la limite |
|---|---|---|
| Point triangulé (RTK, croisement de 54°) | ±0,17 m | croisement, cap, GPS |
| Hauteur | ±0,1 m | inclinaison, position du pied |
| Largeur | ±0,3 à 0,5 m | axe de la route, position de `A` le long de la route |
| Distance libre | ±0,25 m | les deux points |
| Objet sur une seule photo, à 6 m | ±0,2 à 0,8 m | inclinaison, sol supposé plat |
| Objet placé sur la carte | ±1 m | orthophoto |
| Chute (pont, bords de route) | ±0,1 m LiDAR HD, ±0,4 m RGE ALTI | MNT ; sur un pont, altitude RTK |
| Dévers | pas des points (0,5 m près du bord, 0,6 m à 10 m, 1,9 m à 30 m) | talus court, MNT interpolé sous arbres et murs |
| Pente en long | MNT ±0,1 m sur 100 m | tablier des ponts interpolé en droite, creux de moins de 20 % non comblés |
| Bord, séparateur (nuage) | 0,25 m | cases du nuage, marquage effacé |

Avec un GPS grand public (±4 m), le point de référence est à plusieurs mètres près, et une
hauteur à ±2 à 3 m. Les essais et leurs valeurs attendues sont dans le README (« Précision »).
