<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Calculs des mesures

Ce document explique, mode par mode, comment l'application calcule ce qu'elle affiche, avec
les seuils retenus et ce qui limite la précision. Le mode d'emploi est dans le
[README](../README.md) (« Utilisation »), et les essais chiffrés dans sa partie « Précision ».
Les calculs communs avec le plugin QGIS (triangulation, inclinaison, vérification RTK) sont
détaillés dans [`MESURES.md`](MESURES.md) (repris du plugin Visionneuse Panoramax), sections 0, 2.7,
4.4 et 6.1 bis. Ici, ils sont résumés. Les calculs propres à l'application (pont, « Profils »,
analyse fine, relevé, compteurs de la vidéo) sont décrits en entier.

Code : cœur de calcul dans `py/core/` (tests : `tests/coeur/`), calculs propres à
l'application dans `py/web_app.py`, analyse fine du nuage dans `src/nuage.js`, dessin du profil
dans `src/profil.js`, vidéo du parcours dans `src/video.js` (dévers de la vidéo : `readDevers` dans
`src/app.js`).

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
**RGE ALTI** (1 m, ±0,4 m) là où il n'est pas encore publié. Les altitudes d'un même calcul
viennent toutes de la même source : lues par paquets de 160 points, elles sont toutes relues en
RGE ALTI dès qu'un paquet a dû y passer (un point manquant en LiDAR HD). Le MNT sert à vérifier la position
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
direction compte. Un clic à moins de 10° de la droite est refusé, de même qu'un clic à peine au-dessus (jusqu'à 11° environ) : une erreur de cap ou de position le ferait passer dessous, l'incertitude n'est pas évaluable. Il est signalé rasant sous 25°.
La largeur vaut `|AB|`. Le clic se pose là où la droite, dessinée à plat à la hauteur de `A`,
croise le bord vu : si le sol de `B` n'est pas à cette hauteur (dévers, bordure), la largeur est
faussée d'environ `écart latéral caméra-B × Δh / (H + Δh)`, `H` étant la hauteur de la caméra
au-dessus de `A`. Cette largeur est donc une estimation, notée « ≈ ». Si `B` est triangulé à son tour (« Trianguler le point B »), la largeur
devient `|(B − A) · u|`, `u` étant perpendiculaire à l'axe : `B` peut être un peu avant ou après
`A`, et il est dessiné ramené sur la droite. L'incertitude ne compte l'erreur des points qu'en travers de la route, d'après leur covariance
(`triangulation.projected`). Triangulé : `√(uᵀΣ_A u + uᵀΣ_B u)`, plus l'axe. Cliqué : réponse de
la largeur à un déplacement de `A` selon sa covariance, cap du clic, position de la photo (moitié
de sa précision si elle est de la séquence de `A` : la part commune s'annule), inclinaison (±2°
sans calage), plus `|t|·(1/cos δ − 1)` pour l'axe, car le clic suit la droite jusqu'au bord vu.
S'y ajoute le désaccord des visées de chaque point (`triangulation.sight_spread`) : plus grand
écart en travers au point de l'endroit où chaque visée touche le sol, à l'altitude LiDAR HD lue
au point (celle du calcul absorberait le désaccord). Il n'est évalué que sur des photos calées ;
au-delà de 0,6 m, le texte des visées propose d'en réviser une. Le dévers n'y est pas compté.

Visées suivantes : à moins de 12 pixels du trait d'une visée déjà faite, le réticule s'y cale
(touche Maj : visée libre), car un bord n'a pas de repère le long de son tracé. 0,5 m d'écart le
long du bord donne environ 0,4 m d'erreur sur la largeur (simulation : photos à 10 et 5 m).

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

### 6.1 Cadastre (mini-carte)

Le **Parcellaire Express** (IGN) est un plan numérisé : ses limites peuvent être à plusieurs mètres
du terrain. Une feuille cadastrale est teintée d'orange quand son écart moyen aux raccords avec ses
voisines (`dst_raccor`, qualité du géoréférencement de la BD Parcellaire) dépasse **2 m**. En
Côte-d'Or, cet écart vaut 1,5 m en médiane, et plus de 5,8 m pour un quart des feuilles. C'est un
indice, pas un écart mesuré au terrain.

La projection dans la photo a été essayée puis abandonnée (30/10/2026). À Pouilly-en-Auxois, la
limite apparaissait au-dessus du sol au pied des façades. Trois causes y concourent : le plan du
cadastre (0,46 m de décalage avec les bâtiments de la BD TOPO), le sol interpolé sous les
bâtiments (0,8 m plus bas que le trottoir) et l'inclinaison de la photo, calculée seulement au
premier clic.

## 7. Hauteur de chute sur un pont

Ce calcul est automatique sur une photo prise sur un pont de la BD TOPO. La méthode qui a donné la valeur est affichée à sa
suite : « LiDAR » ou « RTK ».

**Par le nuage LiDAR HD** (`Nuage.bridgeFall`, une fois par pont, sans GPS ni hauteur de caméra), quand il y a des points
classés pont (classe 17) à 15 m au plus de la photo :

- **Tablier** : cases de 2 m d'au moins 3 points classés pont, altitude médiane de la case, reliées à 12 m près (le canal de
  Bourgogne a 8 m sans point classé au milieu du pont). La lecture suit le tablier, au-delà du tronçon BD TOPO s'il le faut.
  La rangée de bord est écartée (parapets, flancs).
- **Dessous** : sol (classe 2 ; deuxième point le plus bas de la case, pour écarter un point aberrant) ou eau (classe 9 ;
  médiane de la case), sous le tablier et jusqu'à 10 m de son bord.
- **Hauteur** : la plus grande différence sur tout le tablier, chaque case avec sa propre altitude (pont bombé), identique sur
  toutes les photos du pont. Incertitude : deux lectures LiDAR. Au-dessus de l'eau, c'est le niveau le jour du relevé, et
  seulement si des points d'eau existent à cet endroit (le laser en renvoie peu) : sinon la berge, donc un peu moins. Sous
  0,5 m, la valeur est « non mesurée ». Un fossé profond à moins de 10 m peut augmenter la valeur.

**Par l'altitude GPS, en secours** (pas de points classés pont, ou nuage illisible). Les tronçons en pont
qui se touchent à 1 m près forment un seul ouvrage.

- **Tablier** : altitude GPS des photos de la séquence prises sur le pont, convertie en NGF,
  moins la hauteur de caméra. En chaque point, l'altitude est interpolée entre les deux photos
  consécutives (rangs dans la séquence) dont le segment passe au plus près (pont long et pentu ; une
  seule photo : son altitude ; `web_app._deck_at`). La hauteur de
  caméra est celle **mesurée sur la séquence** vérifiée (médiane de l'altitude RTK moins le sol
  LiDAR, photos du pont écartées), sinon celle **calée** pour la séquence. Une photo de précision
  déclarée n'a que sa propre hauteur, prise au-dessus du sol sous elle : sur un pont, le fond
  franchi. Le réglage « Caméra à » ne sert alors que si l'utilisateur l'accepte (bouton de
  l'encadré du pont).
- **Dessous** : MNT lu en travers du pont, à 1, 3, 6 et 10 m au-delà du bord de la chaussée
  (largeur BD TOPO, sinon 6 m), des deux côtés. Un travers tous les 2 m le long du pont (plus
  espacé sur un long pont), 160 points au plus : une seule requête. Sous le tablier, le MNT
  est interpolé à sa hauteur : le fond se lit à l'écart. Le terrain lu à 1 m seulement tombait
  sur le talus de la culée.
- **Hauteur** : la plus grande différence entre les deux. Incertitude : hauteur mesurée sur la
  séquence, le biais vertical du GPS s'annule (tablier = altitude moins (altitude moins sol)) et
  restent la dispersion de cette hauteur, le sol sous les photos et le terrain sous le pont ;
  hauteur calée ou réglage, l'altitude RTK compte (0,10 m), avec l'incertitude de la hauteur
  (calage, ou 0,15 m pour le réglage). Au-dessus de l'eau, c'est le niveau de l'eau le jour du
  relevé LiDAR.

Dans ce secours, rien n'est affiché sans position RTK vérifiée : l'altitude du tablier serait fausse de plusieurs
mètres. Sous 0,5 m, la valeur est « non mesurée » (végétation, buse). Un fossé profond à moins
de 10 m de la chaussée peut augmenter la valeur.

## 8. « Profils » : profil en travers

Ce calcul se lance d'un appui sur le bouton « Profils », sur une photo hors pont, à moins de 15 m
d'une route de la BD TOPO. Il ne dépend pas de l'altitude GPS et n'a donc pas besoin du RTK.

### 8.1 Profils lus

La route est celle du tronçon BD TOPO au sol le plus proche parmi ceux orientés comme la route
parcourue, à 45° près (sens de la trajectoire de la caméra au droit de la photo, sinon son cap) :
à un carrefour, la voie qui croise peut passer plus près. Elle est prolongée par les tronçons voisins de même
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

### 8.7 Dévers de la plateforme

Sur chaque travers, une droite des moindres carrés est ajustée sur la plateforme entière et sur
chaque moitié (coupée au milieu entre les bords, ou de part et d'autre du séparateur, exclu), puis
les pentes sont moyennées sur les travers, trois au moins. Sur une chaussée, seules des moitiés de
sens opposés d'au moins 0,8 point chacune donnent deux chiffres ; sur des chaussées séparées, aussi
un écart d'au moins 1 point entre elles. Elles forment un toit si chacune descend vers son bord :
pente moyenne affichée si leurs pentes diffèrent de 1 point au plus. Sinon, un seul chiffre, celui
de la plateforme entière. Au-delà de 1 point d'écart type entre travers sur la valeur utilisée, le
dévers est « non déterminé ». Rien en RGE ALTI, trop imprécis. Affichage arrondi au point.

Essai du 05/11/2026 sur 31 photos LiDAR HD, sans mesure de terrain (stabilité, pas exactitude) :
écart médian entre travers de 0,55 point sur la plateforme entière d'une chaussée, 1,17 point par
moitié, soit trop pour reconnaître sûrement un toit à 2,5 % sur 6 m (2,2 cm d'écart à une droite,
2,1 cm de résidu médian) ; 0,1 à 0,8 point par moitié sur des chaussées séparées. Les bords sont ceux
de la détection (§ 8.2), accotement parfois compris, sans l'analyse fine.

## 9. « Profils » : pente en long

- **Ligne suivie** : la **trajectoire de la caméra** (photos de la même séquence, de rangs qui
  se suivent, un trou d'une photo admis), orientée dans le sens de la photo. C'est là où le
  véhicule a roulé, virage à un carrefour compris. À défaut, l'axe BD TOPO prolongé (§ 8.1) : à
  un nœud, le tronçon qui continue le plus dans l'alignement (60° au plus), à la même distance
  de l'axe que l'origine, car l'axe peut s'écarter de la voie de quelques mètres.
- **Lecture** : MNT tous les **2 m** sur **±50 m**. Le 0 est le sol sous la caméra.
- **Fin de la route** : là où aucun tronçon de la même route ne continue, le profil s'arrête
  (« fin de la D16 »), même si la caméra a continué sur une autre route. Les pentes ne portent
  que sur la partie gardée.
- **Carrefours** : « carrefour avec D18 » là où une voie **carrossable** et **nommée** (numéro ou nom) se raccorde
  à la route, placé le long de la route (nom au-dessus du graphique, relié par un trait pointillé). Deux raccordements de la même voie à moins de 30 m
  (îlot séparateur) font un seul carrefour, au milieu. Les voies sans numéro ni nom ne sont pas
  mentionnées, ni, d'après la BD TOPO, les routes empierrées, chemins, sentiers, pistes cyclables et
  escaliers, les voies privées ou réservées aux ayants droit. La BD TOPO ne distingue pas les voies
  communales : le tri se fait sur la nature et l'accès, et sur le nom pour les chemins classés « Route à 1 chaussée »
  (« CHE DE L ARGENTALET ») : un nom en « CHE » sans numéro n'est pas mentionné, même s'il est revêtu.
- **Creux et ponts** : le MNT n'a pas les ponts, il donne le fond franchi. Le tronçon BD TOPO en
  pont est souvent plus court que la brèche, ou absent. Au-dessus de chaque point, on cherche la
  **corde** la plus haute tendue entre deux points du terrain distants de **40 m** au plus. Là où
  elle passe à plus de **0,1 m** au-dessus du terrain, il y a un creux. Sa corde est celle qui
  passe au-dessus du point le plus profond, resserrée tant que le point suivant est encore sur
  elle (à 0,1 m près) : ses appuis sont les culées, en haut des parois. Le creux n'est comblé (la
  corde remplace le terrain, en tirets) que s'il recouvre un **pont de la BD TOPO** (« pont
  (tablier interpolé) ») ou contient une **plongée de plus de 20 %** d'un point au suivant, alors
  qu'une route ne dépasse pas 15 % (« creux du terrain (pont ?) »). Un vallon que la route suit
  elle-même n'est ni l'un ni l'autre : il reste tel quel. Une plongée de plus de 20 % qui reste
  (creux de plus de 40 m) est comblée du bord jusqu'au retour au niveau de la route. Un creux
  ouvert au bout du profil (pas d'autre bord) y est coupé.
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
- **ligne blanche** : bande étroite (0,75 m au plus) au moins 3 fois plus claire que l'enrobé et
  2 fois plus claire que ses cases voisines ;
- **surface non revêtue** (herbe, gravillons, béton) : bande d'au moins 1 m plus claire que
  l'enrobé ;
- **herbe au sol** : bande non revêtue en moyenne **3,5 fois** plus claire que l'enrobé. La
  végétation renvoie beaucoup l'infrarouge, les gravillons et le béton 2 à 3 fois seulement.

Ce que l'analyse en tire :

- **Bord de chaussée** : le bord de la bande d'enrobé. Sur 5 travers de ±1 m à −4, −2, 0, +2 et +4 m
  le long de la route, chacun avec sa propre intensité d'enrobé : début de la première bande
  d'au moins 1 m dont chaque case est au moins **2,2 fois** plus claire que l'enrobé (ni une ligne
  blanche, ni une reprise d'enrobé), placé à mi-hauteur entre l'enrobé et ces abords et interpolé
  entre deux cases. Le bord est la médiane des travers, si au moins 3 le trouvent. La **largeur
  d'enrobé** (légende) est la médiane des largeurs des travers, ± 1,48 fois leur écart médian (0,1 m
  au moins) ; du côté du séparateur, elle s'arrête à lui. Les surlargeurs revêtues et bandes
  d'arrêt d'urgence en font partie. Ces bords remplacent alors celui du § 8.2, sur tous les travers et
  au même écart de l'origine : **plateforme**, son **dévers** (§ 8.7), **chute** et **dévers du talus**
  (§ 8.4) se relisent depuis eux, dans le graphique et dans l'encadré.
- **À défaut** (abords trop peu clairs : village, béton) : sur le seul travers de la photo, la
  ligne de rive, c'est-à-dire la ligne blanche au début de la première bande non revêtue, ou la
  dernière avant elle. Les lignes à moins de 1,2 m de l'axe d'une chaussée sont des lignes entre
  voies et sont écartées. Sans ligne de rive, le bord est la fin de l'enrobé. Les lignes blanches
  ne sont cherchées que sur la plateforme.
- **Lignes blanches à tirets** : le travers de la photo (±1 m le long de la route, soit 2 m) peut
  tomber entre deux tirets (f478a847 : tirets tous les 6,5 m environ, 4 m de vide à la photo). Une ligne
  absente de ce travers est reprise si elle se voit sur au moins 2 des 5 travers de −4 à +4 m, à
  0,5 m près d'un travers à l'autre, et seulement sur la chaussée (hors séparateur), à sa position au
  travers le plus proche de la photo. Elle sert au dessin et à la ligne de rive ci-dessus, pas
  au bord d'enrobé. Limite : une ligne à tirets très espacés (10 m de vide) peut encore échapper.
- **Séparateur** : la bande non revêtue entre les deux chaussées (0,5 à 12 m, glissières
  comprises, que le MNT ne voit pas), son milieu à 2 m au plus de celui du § 8.3, qu'elle
  remplace.
- **Végétation haute** : plus haut point des classes 3 à 5 (herbe haute, arbustes, arbres) à
  ±0,25 m près. La ligne est lissée sur ±1 m. La légende dit où elle commence de chaque côté, et
  sa hauteur au-dessus du sol au moment du relevé LiDAR (2021 à 2024 : fauchage, élagage ou
  repousse depuis). Hauteurs à l'échelle, si elle sort du cadre : « canopée +18 m », plus haut point
  de la ligne de ce côté au-dessus de la plateforme ; rien avec les hauteurs exagérées.
- **Eau** : points de la classe 9, à leur altitude (niveau du jour du relevé). Souvent absents,
  car l'eau renvoie mal le laser.

Précision : celle du nuage (±0,1 m en altitude) et des cases (0,25 m en travers). Essai du
05/11/2026 sur 9 photos, sans mesure de terrain (stabilité, pas exactitude) : largeur d'enrobé sur 7
(D70 8,7 m, A38 9,4 m, RD903bis 5,2 m, RD700 6,5 m, Pouilly 6,5 m, deux autres 10,4 et 12,4 m), à
±0,1 ou ±0,2 m entre travers ; sur les 2 autres (village, faible contraste), pas de largeur et règle à
défaut sur un côté ou les deux. Une reprise d'enrobé ou un accotement gravillonné peut déplacer le bord :
la largeur reste à comparer au terrain.

## 11. Vidéo : accélération latérale et vitesse max ARP

Deux options de la vidéo du parcours (onglet « Vidéo »), indépendantes du compteur de vitesse :
« Accélération latérale » (cadre « Accél. ressentie », en mG, à gauche du compteur de vitesse) et
« Vitesse max ARP » (cadre « V max ARP », en km/h, au-dessus du compteur de vitesse). Les deux utilisent la même courbure, le même dévers et les mêmes seuils.
Code : `laterals`, `insideDevers`, `lateralColor`, `arpSpeeds` et `drawOverlay` dans `src/video.js`.

### 11.1 Vitesse

La vitesse est celle de la **vidéo**, image par image (`speeds`) : vitesse choisie, rampe de
vitesse, ralentissements aux carrefours et au point d'intérêt, arrêts du tour d'horizon, lissée
sur ±4 images comme une aiguille. Ce n'est **pas** la vitesse du véhicule de prise de vue : la
question posée est « que ressentirait-on à cette vitesse dans ce virage ? ».

### 11.2 Courbure

- **Trajectoire** : positions GPS des photos, reliées en ligne brisée ; abscisse curviligne `x`.
- **Cap lissé** `course(x)` : direction de la corde de `x - 15 m` à `x + 15 m`. Sur un cercle,
  cette corde est exactement parallèle à la tangente en `x` : le cap n'est pas biaisé.
  Au raccord de deux séquences, la corde passe à ±40 m jusqu'à 40 m du raccord, puis revient à
  ±15 m sur les 40 m suivants (les deux trajectoires sont décalées de quelques décimètres à
  quelques mètres).
- **Courbure** κ = |cap(x + 5 m) − cap(x − 5 m)| / 10 m, en radians par mètre (1/R). Le
  sens du virage est le signe de cette différence (positif : à droite).

Conséquence du lissage sur 30 m de corde : les virages de moins de **30 m** de rayon environ
(épingles, giratoires) sont sous-estimés. Sur une trajectoire RTK (±2 cm), la courbure d'un
virage de 200 m est juste à 4 % près environ. Hors RTK (±4 m, mais erreur commune aux photos
voisines), elle varie davantage d'une image à l'autre : ce n'est pas vérifié sur une vraie séquence.

### 11.3 Dévers

- **Lecture** (`readDevers`, quand l'une des deux options est cochée, à la préparation ou au
  calcul) : MNT **LiDAR HD** du service d'altimétrie de la Géoplateforme
  (`ign_lidar_hd_mnt_mono_wld`, 50 cm, ±0,08 m), **jamais le RGE ALTI** (7,7° d'écart quadratique
  sur le dévers, voir ticket #29). Une couche WMTS n'aurait servi à rien : c'est une image colorée,
  pas des altitudes.
- **Débit** : le calcul altimétrique de la Géoplateforme accepte 5 requêtes par seconde et par
  adresse IP ; au-delà, il répond HTTP 429 et bloque 5 s. Les altitudes sont donc demandées par
  150 points (10 photos) à **2,5 requêtes par seconde au plus**, et après un refus on attend la fin
  du blocage (5,5 s) avant de redemander, jusqu'à 12 fois. C'est **lent** : 1 min environ pour
  5 km de parcours (une photo tous les 5 m), avec l'avancement dans l'aide de l'option et dans la
  ligne d'état pendant la préparation. Sans cette limite, l'essai de la D115D perdait le dévers de
  156 photos sur 226 (refus en rafale).
- **Grille** : 15 points autour de la caméra, à −1,5, −0,75, 0, +0,75 et +1,5 m en travers et à
  −1,5, 0 et +1,5 m le long du cap lissé. C'est la voie où roule le véhicule (3 m environ).
- **Pente en travers** : plan des moindres carrés, `pente = Σ c·z / Σ c²` (c : décalage en
  travers ; la grille est symétrique). Elle est gardée en fraction, **positive si la droite est
  plus basse** (`photo.devers`). Si une seule des 15 altitudes manque, le dévers de la photo est
  inconnu.
- **Vers l'intérieur** (`insideDevers`) : dévers de la photo interpolé entre les deux photos qui
  encadrent l'image, puis signé selon le virage : tel quel dans un virage à droite, opposé dans un
  virage à gauche. Positif, il aide à tourner ; négatif (chaussée en toit, dévers à contre-sens),
  il gêne.
- **Aide de l'option** : « Conforme au classement de l'ARP » si le dévers est lu sous toutes les
  photos ; sinon le nombre de photos où il manque (dévers compté nul là, « approché ») ; « non
  conforme à l'ARP » s'il n'a pas pu être lu du tout.

Limites : sur un **pont**, le MNT donne le terrain sous le tablier (dévers faux, à écarter si des
viaducs en virage comptent) ; un véhicule garé ou un mur bas est retiré du MNT et interpolé.

### 11.4 Accélération latérale ressentie

- **Accélération** : `a = v² · κ` (v en m/s), en millièmes de g : `mg = 1000 · a / 9,81`.
- **Ressentie** (chiffre affiché) : `|a / g − d|` en mG, `d` étant le dévers vers l'intérieur.
  En ligne droite (`a = 0`), c'est la pente en travers : une chaussée en toit à 2,5 % donne
  25 mG. Sans dévers lu, `d = 0` : le chiffre est l'accélération brute.
- **Couleur** : selon le frottement transversal mobilisé `f = a / g − d` (même grandeur, avec son
  signe), comparé aux seuils de l'ARP à la vitesse de l'image (§ 11.5).
- **Affichage sans battement, pics gardés** : accélération et dévers moyennés sur ±8 images (±0,27 s) avant le calcul du chiffre et de sa couleur. Le chiffre **monte aussitôt**
  jusqu'au pic, à l'unité près, et ne redescend que d'au moins **20 mG** à la fois : il ne bat pas
  entre deux valeurs voisines, et la valeur la plus forte du virage s'affiche telle quelle.

Exemples à 90 km/h (25 m/s) : virage de 200 m, `a = 3,1 m/s²`, 319 mG ; déversé à 5 % vers
l'intérieur, 269 mG ressentis, `f = 0,269`, rouge (seuil du rayon minimal à 90 km/h : 0,128).
Virage de 800 m déversé à 5 % : 80 mG d'accélération, 30 mG ressentis, `f = 0,030`, vert.

### 11.5 Seuils de l'ARP

Source : *Aménagement des Routes Principales*, guide technique du SETRA, août 1994, chapitre 3,
§ 3.1 a (p. 63, rayons minimal et non déversé) et § 3.1 d (p. 66, rayon au dévers minimal). L'ARP
ne donne **pas de coefficient de frottement** : il donne des **rayons** par catégorie de route.

| Catégorie | R 60 | T 80 et R 80 | T 100 |
|---|---|---|---|
| Rayon minimal Rm (dévers 7 %) | 120 m | 240 m | 425 m |
| Rayon au dévers minimal Rdm (dévers 2,5 %) | 450 m | 650 m | 900 m |
| Rayon non déversé Rnd (chaussée en toit, 2,5 % vers l'extérieur) | 600 m | 900 m | 1 300 m |

Entre Rdm et Rm, le dévers varie linéairement en 1/R de 2,5 % à 7 % (note de la p. 66). En
dessous de Rnd, la courbe est obligatoirement déversée vers l'intérieur (note de la p. 63).

Le **frottement transversal mobilisé** se tire de l'équilibre d'un véhicule dans un virage de
rayon R à la vitesse V (km/h) sur un dévers d : `V² / (127 · R) = f + d`, soit
`f = V² / (127 · R) − d` (127 = 3,6² × 9,81). On le calcule à la vitesse de chaque catégorie :

| Vitesse | 60 km/h | 80 km/h | 100 km/h |
|---|---|---|---|
| f au rayon non déversé (`d = −0,025`) | 0,072 | 0,081 | 0,086 |
| f au rayon minimal (`d = 0,07`) | 0,166 | 0,140 | 0,115 |

Classement de chaque image (`lateralColor`) :

- **vert** : `f` ne dépasse pas celui du rayon non déversé. Le virage se prend à cette vitesse
  sans demander plus au pneu qu'un virage que l'ARP admet sans dévers : confortable ;
- **jaune** : `f` entre les deux. L'ARP l'admet à condition que le virage soit bien déversé :
  pas très bon ;
- **rouge** : `f` dépasse celui du rayon minimal. Plus serré que ce que l'ARP admet à cette
  vitesse, même avec 7 % de dévers : hors limites.

Entre 60 et 100 km/h, les seuils sont interpolés linéairement en vitesse. En dessous de 60 km/h
et au-dessus de 100 km/h, ils restent ceux de 60 et de 100 km/h : l'ARP ne va pas plus bas
(R 60 est sa plus petite catégorie) ni plus haut (autoroutes et routes express à deux chaussées
exclues ; elles relèvent de l'ICTAAL, non repris ici). À 130 km/h, ce sont donc les seuils de
100 km/h.

### 11.6 Vitesse max ARP

Pour chaque image (`arpSpeeds`) : la plus haute vitesse entière V (km/h) pour laquelle l'image
serait **verte**, avec la même courbure κ et le même dévers d. On essaie V = 1, 2, 3… tant que
`1000 · (V / 3,6)² · κ / 9,81` reste vert à la vitesse V (les seuils dépendent eux aussi de V).
Ce calcul est fait mètre par mètre le long du parcours ; l'image affiche **la plus basse sur
30 m** (±15 m autour d'elle) : le point critique du virage s'annonce 15 m avant et reste affiché
15 m après. Le chiffre **descend aussitôt** jusqu'à ce creux, au km/h près, et ne remonte que d'au
moins **5 km/h** à la fois (pas de battement). À 150 km/h ou plus (ligne droite, grande courbe), le
cadre affiche « — ». Le dévers inconnu compte pour nul. Le cadre « V max ARP » est au-dessus du
compteur de vitesse.

| Rayon | sans dévers | 2,5 % | 5 % | 7 % |
|---|---|---|---|---|
| 100 m | 30 km/h | 35 | 39 | 42 |
| 200 m | 42 km/h | 49 | 55 | 60 |
| 400 m | 60 km/h | 72 | 81 | 88 |
| 800 m | 93 km/h | 107 | 118 | 127 |

Le vert est exigeant : un virage de 200 m déversé à 7 % (au-dessus du rayon minimal de R 60,
120 m) n'est vert que jusqu'à 60 km/h, jaune de 61 à 74 km/h, rouge dès 75 km/h. La vitesse max
ARP n'est donc **pas** une vitesse limite réglementaire ni une vitesse conseillée : c'est la
vitesse de confort au sens des rayons non déversés de l'ARP.

Vérifié sans réseau sur des virages synthétiques (`tests/essai-video.html` : 665 mG dans un
virage de 200 m à 130 km/h, dévers vers l'intérieur selon le sens du virage, couleurs à
90 km/h, vitesse max de 42 km/h sans dévers dans le virage de 200 m). Lecture du dévers essayée
sur la D115D à Aloxe-Corton (`tests/essai-video.html#long` : dévers lu sous toutes les photos,
moins de 10 %, vers l'intérieur dans les virages marqués).

## 12. Récapitulatif de la précision

| Calcul | Ordre de grandeur | Ce qui la limite |
|---|---|---|
| Point triangulé (RTK, croisement de 54°) | ±0,17 m | croisement, cap, GPS |
| Hauteur | ±0,1 m | inclinaison, position du pied |
| Largeur | ±0,3 à 0,5 m | axe de la route, position de `A` le long de la route |
| Distance libre | ±0,25 m | les deux points |
| Objet sur une seule photo, à 6 m | ±0,2 à 0,8 m | inclinaison, sol supposé plat |
| Objet placé sur la carte | ±1 m | orthophoto |
| Chute (pont, bords de route) | ±0,1 m LiDAR HD, ±0,4 m RGE ALTI | MNT ; sur un pont, nuage LiDAR HD, sinon altitude RTK |
| Dévers | pas des points (0,5 m près du bord, 0,6 m à 10 m, 1,9 m à 30 m) | talus court, MNT interpolé sous arbres et murs |
| Pente en long | MNT ±0,1 m sur 100 m | tablier des ponts interpolé en droite, creux sans pont BD TOPO ni plongée de 20 % non comblés, ponts de plus de 40 m en pente douce |
| Bord, séparateur (nuage) | 0,25 m | cases du nuage, marquage effacé |
| Accélération latérale (vidéo) | courbure à 4 % près en RTK sur un virage de 200 m ; dévers ±2 % au plus (MNT ±0,08 m par point, 15 points sur 3 m ; moins si ses erreurs sont liées) | lissage sur 30 m (virages de moins de 30 m sous-estimés), GPS hors RTK, ponts |

Avec un GPS grand public (±4 m), le point de référence est à plusieurs mètres près, et une
hauteur à ±2 à 3 m. Les essais et leurs valeurs attendues sont dans le README (« Précision »).

## Vue du dessus (essai, branche `birdeye`)

Explication d'ensemble (construction de l'image, recalages, pourquoi et comment) : `docs/BIRDEYE.md`. Ici, le
détail et les chiffres des essais.

Le sol de la photo 360° est reprojeté sur la mini-carte, à ±15 m de la caméra (`src/dessus.js`) : un
maillage de 1 m suit le MNT LiDAR HD lissé sur 2 m (sinon un plan horizontal), posé à la hauteur de caméra sous la
photo. Lissage (`smoothTerrain`, 08/11/2026) : sur l'A38 (`f9f83571`), le MNT s'écarte d'une surface lisse de 1,7 cm
(écart type, 5 cm au plus) sous la chaussée, et la rive, à 5 m de la caméra, ondulait de 3,5 cm (13,7 au plus) ; lissé,
0,4 cm (0,8 au plus). Largeurs entre lignes comparées à l'orthophoto (22 vues, 2 500 largeurs) : écart médian 1,93 %
sans lissage, 1,85 % avec ; variation d'une même largeur le long de la route 0,49 puis 0,29 %. Chaque point y reçoit le pixel qui le voit, inclinaison et cap de la séquence compris
(rotation identique à `Calibration.uncorrect`). Image affichée de 2 048 px (1,5 cm par pixel, carte zoomable
jusqu'à 0,6 cm par pixel) ; les calculs (hauteur, raccords, position) gardent 1 024 px. La photo (12 288 px de large)
est plus fine jusqu'à 10 m : un pixel couvre au sol 0,2 cm en travers et 0,5 cm le long à 4 m, 0,5 et 2,6 cm à 10 m
(caméra à 2,05 m) ; les voisines, chargées à 6 144 px, deux fois plus. Cette vue sert à la « longueur sur la carte » : un segment de droite tracé en deux clics sur la
carte, mise pour cela à la place et à la taille de la visionneuse (et inversement). Aucun point n'est ramené
sur une perpendiculaire à la route. La longueur rejoint les résultats de la séance (`App.add_map_length`,
`py/web_app.py`), avec son incertitude (`shownError`) et les photos qui ont fourni ses deux bouts. Un bout hors
de la vue : longueur sur le fond de carte seul, sans incertitude, marquée « hors vue », pour un contrôle rapide de
cohérence (orthophoto). « Bande verte seule » ne dessine que la bande de la zone idéale.
Une bande verte transparente marque la zone idéale d'une largeur : ±4 m en face de la caméra (axe :
trajectoire entre les photos voisines, à défaut cap de la photo), sur ±8 m en travers, là où le tangage
pèse le moins (essai du 08/11 sur les lignes peintes, vue lissée contre orthophoto : écart de largeur 1,2 à
1,5 % jusqu'à 4 m en long, 2 % au-delà ; pas de dégradation en travers jusqu'à 9 m). L'incertitude affichée
vaut au moins 5 % de la longueur (écart à l'orthophoto, plus bas).

Les photos précédente et suivante complètent l'image : chaque point prend la photo où l'erreur due à
l'inclinaison est la plus faible ; une voisine sans inclinaison ne sert donc qu'à combler. Le véhicule (relevé sur
l'imajbox du CD21) compte en deux parts : son corps (±4,5 m en long, ±2,5 m en travers), où le sol est caché, pris en
dernier recours seulement (là où toutes les photos l'ont sous le corps, celle où il est le plus près du bord) ; et la
bande des reflets du capot et du coffre (jusqu'à ±5,8 m et ±2,9 m), où la photo reste prise, son erreur attendue
comptée trois fois (`REFLECT`). Sans cette bande, un point à 5 m devant la caméra, sous la voisine suivante, venait de
la photo précédente vue à 10 m (passage piéton dédoublé d'un mètre en agglomération, 07/11/2026). Chacune a sa position, sa hauteur et son
inclinaison, posées sur le même terrain. Une distance entre deux points de photos différentes
additionne l'erreur de chaque point et leur position relative (5 cm en RTK vérifié, sinon 30 cm).

Option « Raccords recalés » (cochée par défaut, `alignJoin` et `blockShifts`, `src/dessus.js`) : une voisine qui ne
s'accorde pas avec la principale fait une marche au raccord. Les deux photos sont dessinées seules (3 cm par pixel),
filtrées en passe-haut ; dans leur zone commune sûre (hors véhicule et reflets, à moins de 11 m de chaque caméra), des
blocs de 48 px (1,4 m), tous les 20 px, sont cherchés de l'une à l'autre sur ±40 px par corrélation normée (transformée
de Fourier) : grain, marquages, plaques. Une quadrique ajustée autour du pic donne les directions où il est net : une
ligne en long ne fixe que le travers, un passage piéton ou une plaque les deux. Le déplacement d'un point du sol
(u devant, v à gauche de la voisine, hauteur H) dû à une petite erreur de sa pose vaut, en long,
`tu + t (H² + u²) / H + r u v / H + l v + e u` et, en travers, `tv + t u v / H + r (H² + v²) / H - l u + e v`
(t tangage, r roulis, l lacet, e échelle, tu et tv décalage). Ces six termes sont ajustés aux moindres carrés,
mauvaises correspondances écartées, avec un a priori qui garde près de 0 un terme mal déterminé (écarts types 0,3 m,
1°, 0,5 % : même caméra, même hauteur ; plus lâche, l'échelle se confondait avec le décalage le long de la
route et tordait l'image au-delà du raccord), **hors de la zone du raccord** (±1,5 m) : l'écart y est mesuré avant
et après, sur des blocs que
l'ajustement n'a pas vus. La correction est gardée si l'écart médian baisse et qu'elle reste dans des bornes
plausibles (0,8 m, 3°, 6 %). La voisine est alors dessinée au point déplacé ; la principale ne bouge pas, et son
erreur d'échelle reste à caler (tangage). Pas de recalage sans assez de sol net en commun.

Essai hors application du 07/11/2026 : écart médian au raccord de 10,8 à 2,9 cm sur 38 raccords de route (A38,
RD 1074, D33), de 17,6 à 3,9 cm sur 14 en agglomération (passage piéton, village), tous améliorés ; 6 paires de
village sur 20 sans assez de sol commun. Il remplace un recalage par les seules lignes en long (8,3 à 3,6 cm sur la
route, rien en ville). Sur les photos de référence (`tests/essai-dessus-reference.html`) : A38 5,3 → 1,6 et
7,3 → 3,2 cm, passage piéton (d946f2cf) 5,0 → 2,9 et 16,5 → 2,8 cm.

La hauteur de caméra est lue sur les photos elles-mêmes. Avec une hauteur fausse dans un rapport `k`, le
sol projeté depuis deux caméras distantes de `b` se décale de `b (1 - k)` : ce décalage, cherché par
corrélation dans le grain de la chaussée, donne la hauteur, indépendamment de l'orthophoto et de la
peinture. Il faut le terrain et l'inclinaison des deux photos ; une mesure n'est gardée que si elle se
stabilise (corrélation d'au moins 0,2, entre 1,5 et 2,6 m). La valeur retenue est la médiane des
mesures de la séquence dans la session ; sans mesure valable, l'image garde la hauteur RTK moins sol.
Sur 28 paires de 11 séquences de 2025 : environ 1,92 m du 21/05 au 09/06, environ 2,05 m du 26/06 au
10/07. Cette méthode mesure l'échelle en long ; plusieurs sites donnent environ 8 % de plus d'après
l'orthophoto, en travers, sans explication à ce jour.

L'erreur sur un point au sol à la distance `d` vaut environ `(H² + d²) / H × δ` pour une erreur
d'inclinaison `δ` (radians), et `d × Δz / H` pour un écart de sol `Δz`. L'image est donc grisée
au-delà de 10 m. L'incertitude affichée (un écart-type) combine l'inclinaison sur ses deux axes, la
hauteur de caméra et l'écart du sol (2 cm sur LiDAR, 10 cm sur sol plat). Les objets en relief
s'étalent : seuls les points réellement au sol sont à leur place.

Scène de synthèse (`tests/essai-dessus.html`, sol en dévers de 3 %, caméra penchée) : traits de
peinture retrouvés à moins de 4 cm, aussi sous le véhicule et par-delà le raccord entre photos. Pas encore de comparaison à des longueurs mesurées sur le terrain.

Sans verticale à lire (rase campagne), l'inclinaison vient de la route : le véhicule est supposé posé sur le
plan ajusté au MNT sur ±2,5 m en long et ±1,5 m en travers. L'A38 penche d'environ 2,5 % en travers et 1,2 %
en long, ce qui expliquait l'écart entre tirets devant et derrière. Les verticales gardent la priorité.
Le roulis ne suit qu'une part du dévers (option d'essai « Roulis », 70 % par défaut) : sur la RD 1074
(`81049c82`, véhicule dans la voie de droite), l'écart entre lignes de rive vaut 6,37 m sans roulis et 6,90 m
avec tout le dévers, pour 6,58 m sur l'orthophoto (environ 40 % du dévers) ; sur l'A38, environ 75 %. Le roulis
déplace surtout la ligne la plus éloignée de la caméra, d'où l'impression d'un milieu étiré. Le tangage suit la
pente entière (tirets de 3 m retrouvés devant et derrière).
Option d'essai « Tangage » : tangage ajouté à la pente (défaut de fixation de la caméra, ±2°). Sur la D33
(`dbdaa47b`, 20/06/2025), la chaussée se resserre vers l'avant sans réglage (environ 5 % sur 12 m) ; à l'œil, le
meilleur roulis vaut 45 % du dévers sur la RD 1074 et 100 % sur l'A38, pour des dévers voisins (2,5 et 3 %).
Tangage réglé à l'œil par l'auteur : de -0,2 à +0,5° selon la séquence, sans règle par période, mais identique
(+0,2°) sur deux portions de l'A38 d'une même séquence. Roulis et tangage sont donc retenus par séquence, dans le
navigateur (`web-measures/dessus-reglages`) ; la barre d'état l'indique (« réglé à la main »). Sans réglage, le
tangage est lu sur les raccords (`learnPitch`, voir docs/BIRDEYE.md § 4.1) : échelle de la voisine avant moins celle de
l'arrière, environ 9,6 % pour 1° de tangage commun ; retenu par photo (`web-measures/dessus-tangages`), médiane par
séquence.

Le calage du tangage sur l'orthophoto (lignes de peinture repérées sur elle et sur chaque photo, essai du 07/11/2026)
a été retiré le 08/11/2026 au profit du tangage lu sur les raccords. Option « Position calée sur l'orthophoto » (cochée par défaut, `locate` et `orthoShift`) :
dès la photo principale prête, son profil en travers de la chaussée (6 m de part et d'autre, 9e décile le long, hors
véhicule) est corrélé à celui de l'orthophoto, sur ±1,2 m ; au-delà de 30 cm d'écart, la vue s'y pose (décalée en
travers), sinon la position GPS est gardée. Un appariement ligne à ligne ne convient pas ici :
herbe et bordures donnent des pics sur l'orthophoto (14 « lignes » sur la D33), la médiane des écarts tombait à
0,17 m pour 0,71 m. En cas d'écart, le GPS est à suspecter avant l'orthophoto : au même endroit de la D33, la
séquence du 04/07/2025 (photo 6c6e4972, « RTK vérifié ») est décalée de 0,71 à 0,75 m en travers, translation pure,
alors que celle du 20/06/2025 tombe sur l'orthophoto à 5 cm près. Écart trouvé sur les autres photos de référence :
A38 0,11 m, RD 1074 0,19 m, D33 0,02 m, petite RD sans peinture 0,31 m (calée, de justesse : bords d'enrobé seuls),
village sans accord (position gardée). Limite : un décalage de plus de 1,2 m serait pris pour celui d'une autre ligne. Le calage du tangage sur l'orthophoto trouvait, sur 6 photos réglées à l'œil par l'auteur (07/11/2026), 0 / +0,1 / +0,4
/ +0,2 / -0,2 / +0,2° pour +0,5 / +0,5 / +0,2 / +0,2 / -0,2 / 0°.

Hauteur de caméra par séquence : médiane des hauteurs vérifiées (GPS RTK moins sol) des photos vues de la séquence, dès
3 photos, gardée dans le navigateur (`web-measures/dessus-hauteurs`) ; une même séquence de l'A38 allait de 1,83 à
2,36 m d'une photo à l'autre. Chaque caméra est posée à cette hauteur au-dessus du plan de la route sous le véhicule
(moyenne du terrain sur ±2,5 m x ±1,5 m), plutôt que sur un seul point du maillage.

Raccords entre photos (D33, `fb158480`) : des marches de 10 cm sur la rive (4,2 m de la caméra) et 3 à 5 cm sur l'axe
(1,6 m) viennent du tangage. Au raccord, la principale voit le point devant elle et la voisine derrière la sienne :
une erreur de tangage δ change leurs échelles en travers en sens opposés, d'environ 2 x 2,6 m x δ / H x s. Elles
disparaissent entre +0,3 et +0,5° (réglage à l'œil de l'auteur : +0,5° ; calage sur l'orthophoto : +0,1°).

Validation (07/11/2026, A38, 20 photos CD21 prises une à une, relevé automatique ; tirets de norme 3 m et 15 cm),
sans puis avec cette inclinaison : tirets à 4-9 m devant 3,29 puis 2,98 m, derrière 2,72 puis 3,03 m ; écart médian
à 3 m (4-14 m) 0,40 puis 0,21 m ; largeur 15,2 cm environ avant comme après. Écart entre lignes de rive comparé à
l'orthophoto IGN (écart médian par photo) : en face de la caméra 3,9 puis 2,7 %, à 4-6 m 4,2 puis 1,9 %, à 6-10 m
5,2 puis 2,4 %. Non validé hors autoroute, en virage ni sur un toit de chaussée marqué ; le MNT ignore les ponts.

L'orthophoto sert d'étalon pour un écart de plusieurs mètres : la période des tirets varie de moins de 0,1 % entre les
vols de 2017, 2020, 2023 et 2025, alors qu'elle va de 12,82 à 13,11 m selon le site (13 m en norme). Le marquage étant
repeint chaque année, l'écart entre lignes change un peu d'un vol à l'autre. Elle ne convient pas pour une largeur de
peinture (15 cm, pixel de 20 cm).

Essais à la main de l'auteur (07/11/2026, petite route départementale, en agglomération et en rase campagne) :
la chaussée de la vue se raccorde plutôt bien à celle de l'orthophoto. Elle montre aussi la chaussée cachée par
les arbres sur l'orthophoto.

Photos de référence de la vue du dessus (CD21, choisies par l'auteur), à reprendre pour chaque changement :

| Cas | Photo | Séquence, date |
|---|---|---|
| A38, autoroute | `66d45404-a22d-4b07-8bc8-1f3edcdf1b8a` | `5bab4dc2`, 03/07/2025 |
| RD 1074 | `6f585daf-8e96-448d-9efb-2523927bc8c9` | `59d37636`, 07/07/2025 |
| D33, route propre, rives et axe marqués | `dbdaa47b-6e4d-4416-b352-ab324cb14735` | `a88c160e`, 20/06/2025 |
| Petite RD sans rive, axe en « éclair » souvent effacé | `894c3f0f-3d30-486b-b0f9-c7e6505d8d03` | `61b3aa24`, 10/06/2025 |
| Petite route de village | `e2d81cb7-f303-4cbf-93d7-8a2dbbc7c2b7` | `3e1d703f`, 28/05/2025 |

Essai répétable : `tests/essai-dessus-reference.html` (avec le réseau, quelques minutes) note pour chacune l'état
affiché, la hauteur de caméra et celle lue sur le décalage entre photos, l'inclinaison retenue, et dépose la vue
recomposée dans `tests/captures/` (hors dépôt) pour comparer d'un changement à l'autre. Premier passage
(07/11/2026) : 23 contrôles sur 23 ; hauteur et décalage d'accord à 1,4-2,2 % là où le décalage se mesure
(pas sur l'A38 ni au village).
