<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Bird Eye : construction de la vue et recalages

La vue Bird Eye (`src/dessus.js`, branche `birdeye`) montre le sol autour de la caméra vu d'en haut, posé sur la carte,
pour y mesurer des longueurs et des largeurs comme sur un plan. Ce document explique comment l'image est construite et
pourquoi chaque recalage existe. Les chiffres détaillés des essais sont dans `docs/CALCULS.md` (section « Vue du
dessus »).

## 1. Principe

Une photo 360° (imajbox 360 HD du CD21, 12 288 × 6 144 px) voit tout le sol autour du véhicule. Si l'on connaît
exactement où est la caméra (position, hauteur) et comment elle est tournée (cap, inclinaison), chaque point du sol
correspond à une direction de visée, donc à un pixel de la photo. La vue se construit à l'envers de la prise de vue :
pour chaque point du sol, on calcule la direction depuis la caméra et on va chercher la couleur dans la photo.

Tout ce qui est **au sol** est alors à sa place, à l'échelle. Ce qui est **en relief** (poteaux, véhicules, façades,
talus) s'étale vers l'extérieur : seule sa base est juste.

## 2. Construction de l'image

**Entrées :**

- la photo et sa pose : position GPS (RTK pour le CD21), cap (EXIF au centième, plutôt que `view:azimuth` arrondi),
  inclinaison (voir § 4.1) et hauteur de caméra (voir § 4.2) ;
- le terrain : MNT LiDAR HD de l'IGN, lu sur une grille de 1 m sur ±15 m (`readTerrain`), sinon un plan horizontal ;
- les photos précédente et suivante de la séquence, chacune avec sa propre pose.

**Calcul (`render`, WebGL) :**

1. Un maillage de 31 × 31 points (pas de 1 m) suit le terrain sur ±15 m autour de la caméra.
2. La caméra est posée à sa hauteur au-dessus du plan de la route sous le véhicule (moyenne du terrain sur
   ±2,5 m en long et ±1,5 m en travers, `groundLevel`), plutôt que sur un seul point du maillage.
3. Pour chaque pixel de l'image, le shader calcule le rayon de la caméra au point du sol, le tourne dans le repère de
   la photo (cap et inclinaison, même rotation que `Calibration.uncorrect`), en déduit les coordonnées dans la photo
   équirectangulaire et y lit la couleur.
4. Au-delà de 10 m, l'image est grisée : 0,6° d'inclinaison y déplacent déjà un point d'environ 50 cm (§ 3).

**Résolution :** l'image affichée fait 2 048 px pour 30 m, soit 1,5 cm par pixel, et la carte se zoome jusqu'à
0,6 cm par pixel. La photo est plus fine jusqu'à 10 m : un de ses pixels couvre au sol 0,2 cm en travers et 0,5 cm le
long à 4 m, 0,5 et 2,6 cm à 10 m. Les calculs (hauteur, raccords, position) travaillent sur une image de 1 024 px,
suffisante et quatre fois moins coûteuse.

**Recomposition de trois photos :** le véhicule cache le sol sous lui, et ses reflets salissent le sol proche. Les
photos voisines, prises environ 5 m avant et après, voient ce sol. Chaque point de l'image prend la photo où l'erreur
attendue est la plus faible (§ 3), avec deux zones à part autour de chaque caméra :

- **le corps du véhicule** (ellipse de ±4,5 m en long, ±2,5 m en travers) : le sol y est caché ; une photo n'y sert
  qu'en dernier recours, quand toutes les photos ont ce point sous leur corps (celle où il est le plus près du bord) ;
- **la bande des reflets** du capot et du coffre (jusqu'à ±5,8 m et ±2,9 m) : la photo y reste utilisable, mais son
  erreur attendue compte trois fois (`REFLECT`). Une voisine proche vue dans ses reflets vaut mieux qu'une photo
  lointaine, pas qu'une autre photo proche sans reflets.

**Pourquoi ces deux zones :** une seule grande ellipse effaçait aussi le sol à 5 m devant la caméra, qui était alors
pris dans la photo précédente, à 10 m, beaucoup moins précise (passage piéton dédoublé d'un mètre en agglomération).

## 3. D'où viennent les erreurs

Pour un point au sol à la distance `d` d'une caméra à la hauteur `H` :

- une erreur d'inclinaison `δ` (radians) le déplace d'environ `(H² + d²) / H × δ` : à 10 m d'une caméra à 2 m, 0,1°
  font 9 cm et 1° près de 90 cm ;
- une erreur de hauteur dans un rapport `k` change l'échelle d'autant : 2 cm sur 2 m font 1 % ;
- un écart du sol réel au terrain `Δz` le déplace de `d × Δz / H` ;
- une erreur de position GPS déplace toute l'image d'autant.

**Conséquences :** l'inclinaison domine loin de la caméra, d'où le grisé au-delà de 10 m et la bande verte en face de la
caméra (±2 m en long, ±8 m en travers), où le tangage pèse le moins. Chaque recalage ci-dessous s'attaque à une de ces
causes.

## 4. Les recalages

Ils s'appliquent dans cet ordre : inclinaison et hauteur d'abord (elles font la géométrie de chaque photo), puis les
raccords entre photos, puis la position de l'ensemble sur la carte.

### 4.1 Inclinaison

**Pourquoi :** c'est la première source d'erreur (§ 3). La caméra suit le véhicule, qui penche avec la route, et sa
fixation peut être un peu de travers.

**Comment :**

1. **Verticales lues sur la photo** (façades, poteaux), quand il y en a : c'est la mesure la plus directe (de l'ordre
   de ±0,1 à 0,2°). Elles ont la priorité.
2. **Sinon, la route** : le véhicule est supposé posé sur le plan ajusté au MNT sous lui (`groundUp`). Le tangage suit
   la pente entière ; le roulis ne suit qu'une part du dévers, réglable (« Roulis », 70 % par défaut : environ 40 %
   sur la RD 1074, 75 à 100 % sur l'A38). Le curseur « Tangage » ajoute le défaut de fixation de la caméra
   (−0,2 à +0,5° selon les séquences).
3. Roulis et tangage sont **retenus par séquence** dans le navigateur : la fixation ne change pas au cours d'une
   séquence.
4. Bouton **« Caler le tangage sur l'orthophoto »** (`calibrate`) : les lignes de peinture sont repérées sur
   l'orthophoto IGN (20 cm) et sur chaque photo dessinée seule ; leur écart de direction donne le tangage en trop. La
   médiane de la photo, de ses voisines et de 4 photos de plus de chaque côté (environ 50 m) s'ajoute au réglage de
   la séquence.

**Limites :** le roulis ne se cale pas sur l'orthophoto (il absorberait tout écart de largeur). En agglomération,
l'inclinaison lue sur les façades peut différer de 1,6° entre deux photos voisines alors que chacune annonce ±0,2° :
c'est ce que corrigent les raccords (§ 4.3).

### 4.2 Hauteur de caméra

**Pourquoi :** elle fixe l'échelle de toute l'image. L'altitude GPS RTK moins le sol LiDAR varie d'une photo à l'autre
(de 1,83 à 2,36 m dans une même séquence de l'A38), alors que la caméra ne bouge pas sur le toit.

**Comment :**

1. **Une hauteur par séquence** : la médiane des hauteurs vérifiées (RTK moins sol) des photos vues, dès 3 photos,
   gardée dans le navigateur.
2. **Hauteur lue sur les photos** (`estimateHeight`) : avec une hauteur fausse dans un rapport `k`, le sol vu par deux
   caméras distantes de `b` se décale de `b (1 − k)`. Ce décalage, cherché par corrélation dans le grain de la
   chaussée entre la photo et ses voisines, donne la hauteur sans orthophoto ni peinture. Gardée si la mesure se
   stabilise (corrélation d'au moins 0,2, hauteur entre 1,5 et 2,6 m) ; médiane de la séquence dans la session.

### 4.3 Raccords entre photos

**Pourquoi :** chaque photo a sa propre pose, avec ses petites erreurs. Là où l'image passe d'une photo à l'autre, une
ligne ou un passage piéton fait une **marche**. Une mesure qui traverse un raccord porte au moins l'erreur de cette
marche.

**Comment (`alignJoin`, `blockShifts`) :** la photo affichée sert de référence et ne bouge pas ; chaque voisine est
recalée sur elle.

1. Les deux photos sont dessinées seules dans le même repère (1 024 px), puis filtrées pour ne garder que le détail
   (grain, bords de peinture, plaques).
2. La zone commune sûre est retenue : opaque dans les deux, hors du véhicule et de ses reflets, à moins de 11 m de
   chaque caméra.
3. Cette zone est découpée en blocs de 1,4 m (tous les 60 cm). Chaque bloc de la photo affichée est cherché dans la
   voisine sur ±1,2 m par **corrélation normée**, calculée par transformée de Fourier.
4. Autour du pic de corrélation, une petite surface ajustée dit dans quelles directions il est net : un bloc qui
   contient une ligne en long ne fixe que le décalage en travers, une plaque ou un passage piéton fixe les deux. Seules
   ces directions sont gardées.
5. Ces décalages sont expliqués par une **erreur de pose de la voisine** : décalage en long et en travers, tangage,
   roulis, lacet et échelle. Pour un point à `u` devant et `v` à gauche de la voisine, l'erreur déplace le sol de
   `tu + t (H² + u²) / H + r u v / H + l v + e u` en long et `tv + t u v / H + r (H² + v²) / H − l u + e v` en travers
   (t tangage, r roulis, l lacet, e échelle). Les six termes sont ajustés aux moindres carrés, les mauvaises
   correspondances écartées.
6. Un **a priori** garde près de 0 un terme mal déterminé quand la zone commune est étroite (écarts types : 0,3 m, 1°,
   3 %).
7. **Contrôle :** l'ajustement se fait hors de la zone du raccord (±1,5 m), et l'écart est mesuré au raccord, sur des
   blocs qu'il n'a pas vus. La correction n'est gardée que si l'écart médian y baisse et si elle reste plausible
   (0,8 m, 3°, 6 %). Sinon la voisine reste telle quelle.
8. La voisine est dessinée au point déplacé (shader) ; la barre d'état indique l'écart avant et après.

**Pourquoi un modèle physique plutôt qu'une déformation libre (type Thin Plate Spline) :** les erreurs viennent de
quelques causes lisses (pose de la caméra). Six termes les décrivent, se vérifient au raccord et s'extrapolent
correctement plus loin ; une déformation libre recalerait aussi le bruit et ne dirait pas laquelle des deux photos a
raison.

**Résultats (essai du 07/11/2026) :** écart médian au raccord de 10,8 à 2,9 cm sur 38 raccords de route, de 17,6 à
3,9 cm sur 14 en agglomération, tous améliorés. Un premier recalage, par les seules lignes en long, faisait 8,3 à
3,6 cm sur route et rien en ville : il a été remplacé.

**Limites :** sans assez de sol net en commun (véhicules garés, trottoirs, reflets), pas de recalage. La photo
affichée garde ses propres erreurs : les raccords disparaissent, pas l'erreur d'échelle de la photo affichée.

### 4.4 Position sur la carte

**Pourquoi :** la position GPS peut être fausse de plusieurs dizaines de centimètres, même « RTK vérifié » : sur la
D33, une séquence du 04/07/2025 est décalée de 0,75 m en travers, alors qu'une autre au même endroit tombe sur
l'orthophoto à 5 cm près. En cas d'écart, le GPS est à suspecter avant l'orthophoto. Ce décalage ne change ni les
longueurs ni les largeurs mesurées dans la vue, mais il fausse la superposition avec la carte et une mesure dont un
bout est hors de la vue.

**Comment (`locate`, `orthoShift`) :** dès la photo affichée prête, le profil en travers de sa chaussée (6 m de part et
d'autre, hors véhicule) est comparé par corrélation à celui de l'orthophoto, sur ±1,2 m. Au-delà de 30 cm d'écart, la
vue est décalée en travers pour s'y poser ; sinon la position GPS est gardée. Option « Position calée sur
l'orthophoto », cochée par défaut.

**Limites :** un décalage de plus de 1,2 m serait pris pour celui d'une autre ligne. Sans peinture (bords d'enrobé
seuls), le calage est moins sûr.

## 5. Mesurer sur la vue

L'outil « Longueur sur la carte » trace un segment en deux clics. Il donne sa longueur et une incertitude qui combine
l'inclinaison sur ses deux axes, la hauteur, l'écart du sol et, entre deux photos, leur position relative (5 cm en RTK
vérifié, sinon 30 cm), sans descendre sous 5 % de la longueur (écart constaté à l'orthophoto). Le mieux est de mesurer
dans la bande verte. Un bout hors de la vue se mesure sur le fond de carte seul, sans incertitude.

## 6. Session et réglages gardés

- Dans le navigateur : roulis et tangage par séquence (`web-measures/dessus-reglages`), hauteurs vérifiées par séquence
  (`web-measures/dessus-hauteurs`).
- Dans la session : Bird Eye éteinte puis rallumée sur la même photo revient sans rien refaire ; pour les photos déjà
  vues, terrain, hauteur lue, raccords et position sont repris (les photos elles-mêmes sont relues).

## 7. Essais

- `tests/essai-dessus.html` : scène de synthèse à réponse connue (sol en dévers, caméra penchée), sans réseau.
- `tests/essai-dessus-reference.html` : photos de référence du CD21 (A38, RD 1074, D33, petite RD, village, passage
  piéton en ville, D33 au GPS décalé), avec le réseau ; vérifie l'état affiché, la hauteur, les raccords et la
  position, et dépose les vues dans `tests/captures/`.
