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
- le terrain : MNT LiDAR HD de l'IGN, lu sur une grille de 1 m sur ±15 m (`readTerrain`), sinon un plan horizontal.
  **Près d'un pont** (tronçon BD TOPO en pont à moins de 20 m, photo dessus ou dessous, `App._near_bridge`), le MNT
  est écarté : il donne le sol sous le tablier, ou la brèche sous la photo. Sol plat, pas d'inclinaison tirée de la
  route ni de tangage lu sur les raccords, hauteur de caméra de la séquence ou réglée (pas RTK moins sol LiDAR) ;
- avec l'interrupteur **« Véhicule masqué »** (éteint par défaut), les photos précédente et suivante de la séquence,
  chacune avec sa propre pose : elles comblent le sol sous le véhicule et ses reflets, et entraînent les raccords
  (§ 4.3), le tangage lu sur les raccords (§ 4.1) et la hauteur lue entre photos (§ 4.2). Éteint, la photo affichée
  seule : véhicule visible, rien à lire de plus.

**Calcul (`render`, WebGL) :**

1. Un maillage de 31 × 31 points (pas de 1 m) suit le terrain sur ±15 m autour de la caméra, **lissé sur 2 m**
   (`smoothTerrain` : écarts au plan moyen lissés par une gaussienne). Le MNT s'écarte d'une surface lisse de 1 à 3 cm
   d'un mètre à l'autre ; une bosse `Δz` sous un point à `d` de la caméra le déplace de `d × Δz / H`, soit 8 cm à 5 m :
   sans lissage, les lignes droites ondulent. La pente, le dévers et le bombement restent ; un dos-d'âne ou un caniveau
   est adouci.
2. La caméra est posée à sa hauteur au-dessus du plan de la route sous le véhicule (moyenne du terrain sur
   ±2,5 m en long et ±1,5 m en travers, `groundLevel`), plutôt que sur un seul point du maillage.
3. Pour chaque pixel de l'image, le shader calcule le rayon de la caméra au point du sol, le tourne dans le repère de
   la photo (cap et inclinaison, même rotation que `Calibration.uncorrect`), en déduit les coordonnées dans la photo
   équirectangulaire et y lit la couleur.
4. L'image affichée est **découpée à ±8 m de l'axe de la route**, bords droits, parallèles à la route : rien de plus loin de la route.
5. Au-delà de 10 m, l'image est grisée : 0,6° d'inclinaison y déplacent déjà un point d'environ 50 cm (§ 3).

**Résolution :** l'image affichée fait 2 048 px pour 30 m, soit 1,5 cm par pixel ; l'interrupteur « Haute résolution »
la porte à 4 096 px (0,7 cm par pixel : grain et bords de ligne plus nets près de la caméra, quelques secondes de plus).
La carte se zoome jusqu'à 0,6 cm par pixel. La photo est plus fine jusqu'à 10 m : un de ses pixels couvre au sol 0,2 cm en travers et 0,5 cm le
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

**Conséquences :** l'inclinaison domine loin de la caméra, d'où le grisé au-delà de 10 m et la zone idéale en face de la
caméra (±4 m en long, ±8 m en travers), où le tangage pèse le moins. Chaque recalage ci-dessous s'attaque à une de ces
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
   Pour Bird Eye seulement, des verticales refusées pour les mesures (au-delà de ±0,25°) sont gardées jusqu'à
   ±0,5° (`web_tilt.LOOSE_SIGMA`) : elles voient le véhicule penché en virage, que la route ignore. Giratoire
   b47b4351 : roulis de 3,0° contre 0,95° par la route, bord extérieur à 8 m ramené de 1,3 m. Une photo déjà
   analysée lors d'une séance précédente (calage gardé) est réanalysée une fois pour cela.
2. **Sinon, la route** : le véhicule est supposé posé sur le plan ajusté au MNT sous lui (`groundUp`). Le tangage suit
   la pente entière ; le roulis ne suit qu'une part du dévers, réglable (« Roulis », 70 % par défaut : environ 40 %
   sur la RD 1074, 75 à 100 % sur l'A38). Le tangage ajoute le défaut de fixation de la caméra (−0,4 à +0,6° selon
   les séquences).
3. **Tangage lu sur les raccords** (`learnPitch`) : une erreur de tangage de la photo affichée paraît, dans le
   recalage des raccords (§ 4.3), comme une échelle de signe opposé sur la voisine avant et sur l'arrière (environ
   ±4,8 % pour 1°). Leur différence donne le tangage de la vue ; il est retenu par photo dans le navigateur et
   **appliqué à cette photo** (`pitchFor`) : il bouge sur une bosse ou un creux, que le plan de la route sous le véhicule
   ne suit pas (choix de l'auteur, 09/11/2026). La vue est refaite s'il change de 0,1° ou plus, trois fois au plus ;
   une lecture au-delà de ±2° est écartée. Une photo affichée sans le sien (pas de voisine devant et derrière) prend
   la médiane des photos vues de la séquence (fixation de la caméra) ; une voisine pas encore lue prend celui de la
   photo affichée (avec la médiane, qui compte la photo affichée, les raccords repartaient sans fin). Essai du
   08/11/2026 sur 30 vues : stable par séquence (+0,45 à +0,57°, +0,27 à +0,49°, −0,13 à −0,38° sur trois
   séquences), proche de 0 sur les vues calées par leurs verticales ; à +0,4° sur une vue, les écarts bruts aux
   raccords passent de 14,9 et 11,4 cm à 9,5 et 2,7 cm.
4. Le curseur « Tangage », réglé à la main, prime ; avec le roulis, il est **retenu par séquence** dans le navigateur. Le calage du tangage sur l'orthophoto (lignes de peinture,
   20 cm) a été retiré : trop peu précis (0,1° trouvé là où l'œil voyait 0,5° sur la D33).

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
   **Photos du CD21** (imajbox sur Clio 5, deux montures ; la caméra ne bouge plus une fois montée) : la séquence prend la
   **monture** la plus proche de sa hauteur lue, 1,93 ou 2,07 m (±4 cm), même lue avec l'inclinaison de la route quand les
   photos n'ont pas de verticales (les deux concordent au cm près là où elles existent). Relevé du 08/11/2026 sur 36 vues :
   1,90 à 1,95 m du 28/05 au 23/06/2025, 2,05 à 2,07 m le 03/07 (2,15 le 07/07, dispersé en octobre) ; l'altitude RTK moins
   le sol reste vers 2,05-2,10 m tout du long (antenne fixe, caméra plus basse sur la première monture).
   Retenue par photo dans le navigateur (`web-measures/dessus-parallaxes`) : la médiane sert à toute la séquence, même
   vue photo seule, avant l'altitude RTK moins le sol. Giratoire b47b4351 : 1,94 m par le décalage, 2,06 m par le RTK
   (15 photos, 2,04 à 2,09 m) ; largeur entre lignes de 8,0 m sur le terrain, environ 8,2 m avec 1,94 m, 8,7 m avec
   2,06 m. Refaite quand les verticales des voisines arrivent.

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
   0,5 %). L'échelle est tenue serrée : deux photos de la même caméra ont la même hauteur, et le long de la route une
   échelle se confond presque avec un décalage (lignes parallèles). Plus lâche (3 %), l'ajustement trouvait parfois
   85 cm et 11 % là où 3 cm et 2 % suffisaient : juste au raccord, l'image tordue au-delà (a9fd217d, 08/11/2026). Sur
   34 vues : 61 raccords recalés sur 68 au lieu de 59, écart final médian inchangé (2,4 cm).
7. **Contrôle :** l'ajustement se fait hors de la zone du raccord (±1,5 m), et l'écart est mesuré au raccord, sur des
   blocs qu'il n'a pas vus. La correction n'est gardée que si l'écart médian y baisse et si elle reste plausible
   (1,2 m, 3°, 6 %). Sinon la voisine reste telle quelle.
8. La voisine est dessinée au point déplacé (shader) ; la barre d'état indique l'écart avant et après.

**Pourquoi un modèle physique plutôt qu'une déformation libre (type Thin Plate Spline) :** les erreurs viennent de
quelques causes lisses (pose de la caméra). Six termes les décrivent, se vérifient au raccord et s'extrapolent
correctement plus loin ; une déformation libre recalerait aussi le bruit et ne dirait pas laquelle des deux photos a
raison.

**Résultats (essai du 07/11/2026) :** écart médian au raccord de 10,8 à 2,9 cm sur 38 raccords de route, de 17,6 à
3,9 cm sur 14 en agglomération, tous améliorés. Un premier recalage, par les seules lignes en long, faisait 8,3 à
3,6 cm sur route et rien en ville : il a été remplacé.

**Fondu (avec « Véhicule masqué » ; la case « Raccords fondus » a été retirée le 09/11/2026, `renderBlended`) :** le même sol paraît plus clair sur une photo que sur
l'autre selon l'angle au soleil, d'où des taches en ellipse autour des raccords (le gain global entre photos n'est que de
1 à 3 %). Fondu en deux bandes : chaque photo rendue seule, sans son véhicule ; sa luminosité lente (256 px pour 30 m,
floutée sur environ 1 m) est mélangée selon les zones gagnantes floutées, le détail fin reste celui de la photo choisie,
le raccord reste net. Essai du 08/11/2026 : ellipses effacées sur la D33 du 04/07 et a9fd217d, atténuées en ville ; un
fondu simple de ±60 cm dans le shader n'y faisait presque rien. Environ 1,8 s de plus par image (calcul en JavaScript).

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
vérifié, sinon 30 cm), plus 3,5 % de sa part en travers de la route (vue trop étroite en travers : bandes de passages
piétons du CD21, 0,483 m pour 0,50 m sur 10 sites, compté dans l'incertitude plutôt que corrigé, `ACROSS_BIAS`), sans
descendre sous 5 % de la longueur (écart constaté à l'orthophoto). Le mieux est de mesurer
en face de la caméra (±4 m). Un bout hors de la vue se mesure sur le fond de carte seul, sans incertitude.

**Incertitude selon la situation** (`measureError`) : inclinaison tirée de la route dans un virage, incertitude majorée du
penchement probable du véhicule (0,5° par m/s² d'accélération latérale, photos précédente et suivante) ; hauteur par
l'altitude RTK moins le sol, au moins ±10 cm (12 cm d'écart avec le décalage entre photos sur le giratoire b47b4351) ;
mesure à cheval sur deux photos, au moins l'écart mesuré à leurs raccords (après recalage, sinon d'origine).

## 6. Session et réglages gardés

- Dans le navigateur : roulis et tangage réglés à la main, par séquence (`web-measures/dessus-reglages`), tangage lu sur
  les raccords, par photo (`web-measures/dessus-tangages`), hauteurs vérifiées par séquence
  (`web-measures/dessus-hauteurs`).
- Dans la session : Bird Eye éteinte puis rallumée sur la même photo revient sans rien refaire ; pour les photos déjà
  vues, terrain, hauteur lue, raccords et position sont repris (les photos elles-mêmes sont relues).

## 7. Essais

- `tests/essai-dessus.html` : scène de synthèse à réponse connue (sol en dévers, caméra penchée), sans réseau ;
  panoramas de synthèse en 2 048 px (marges intactes : trait à 0,6 cm pour 4 cm tolérés), environ 7 s.
- `tests/essai-dessus-reference.html` : photos de référence du CD21 (A38, RD 1074, D33, petite RD, village, passage
  piéton en ville, D33 au GPS décalé), avec le réseau ; vérifie l'état affiché, la hauteur, les raccords et la
  position, et dépose les vues dans `tests/captures/`.
  `#rapide` : 3 photos seulement (A38, ville, D33 du 04/07 : chacune porte un contrôle propre), pendant la mise au
  point ; les 7 avant une fusion. Durée de chaque étape dans le journal (page, vue).
- `tools/essais.sh birdeye` : les deux, environ 1 min (processeur graphique, cache HTTP gardé) ; avant : 5 min.
