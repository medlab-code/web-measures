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
- le terrain : MNT LiDAR HD de l'IGN, lu sur une grille de 1 m sur ±15 m (`readTerrain`), sinon un plan horizontal. Une seule
  lecture sert la vue (±15 m) et le tangage sur les lignes (±25 m, 51 × 51 points, même maille et même centre : la grille de 15 m en
  est extraite, chacune lissée à part) : une requête POST de 2 601 points (`fetchGrid`, `chaîne "true"` pour `zonly`), sinon des
  GET de 300 points au plus, gardée en mémoire par position (`readGrid`) ; le calage de la largeur ↔ passe de 21–31 s à 4–8 s ;
  **Photo sur un pont** (marquée par le cœur, `Session.mark_bridge` : tronçon BD TOPO en pont à 8 m au plus dans le sens de la
  séquence, `roads.on_bridge`, comme pour les mesures ; depuis le 22/11/2026 la vue du dessus n'a plus sa propre détection, plus large,
  à 20 m, dessus ou dessous), le MNT est écarté : il donne le sol sous le tablier. Tablier plan et horizontal (`deck`) :
  inclinaison par la route (±1,5°), hauteur lue entre photos sur les verticales, sinon celle de la séquence, puis pour le
  CD21 sa monture d'après la date (profil de campagne, `py/web_profils.py`), puis le réglage (pas RTK moins sol LiDAR) ; une hauteur calée passe avant la monture ; ce choix de hauteur se fait
  photo par photo (une voisine marquée sur un pont, la photo affichée non). **Sol supposé plat près d'un pont** (depuis le 26/11/2026, `pose.flat`, décision unique du cœur : `roads.flat_ground`, constante
  `roads.BRIDGE_FLAT_RADIUS` = 15 m) : tout pont BD TOPO à 15 m au plus de la photo, à vol d'oiseau, distance au tablier le plus proche (avant, sur ou
  après l'ouvrage, sans condition de sens), met la photo sur un plan horizontal à la hauteur de caméra, car le relief (LiDAR HD, RGE ALTI)
  y donne le fond de la vallée ou la rivière. L'inclinaison (roulis, tangage : calage, clics, verticales, défaut) s'applique comme ailleurs, et les mesures de
  la vue du dessus se font sur ce plan ; l'étiquette dit « Sol supposé plat (pont à moins de 15 m) ». Les tronçons arrivent par le réseau : la
  vue est refaite à leur arrivée si le terrain était déjà lu. Le marquage « sur un pont » (8 m) garde en plus hauteur et inclinaison sans LiDAR.
  **Photo non marquée à plus de 15 m d'un pont** (approche, voie franchie dessous) : le terrain LiDAR est gardé, tangage compris (le remblai
  de 7dcdccf9-3c52-4c54-bc5b-de72740a7967, à moins de 15 m du tablier, donnait +3,2° au relief et 0° au sol plat : le plan l'emporte désormais). Seuls les points sous l'emprise de l'ouvrage (`pose.deck` : axe du
  tronçon en pont voisin et orienté comme la séquence, demi-largeur `roads.DECK_HALF_WIDTH` = 6 m, entre ses extrémités) sont écartés
  du maillage (`underDeck`, `fillUnderDeck`) : ils décrivent le sol sous l'ouvrage ; remplacés par un tablier horizontal à l'altitude
  du terrain LiDAR à la culée (côté photo, le long de l'axe ; le remblai garde sa pente, le tablier est un palier), et le terrain est indisponible (« sol supposé plat ») si moins de 60 % des points restent ;
- avec l'interrupteur **« Véhicule masqué »** (éteint par défaut), les photos précédente et suivante de la séquence,
  chacune avec sa propre pose : elles comblent le sol sous le véhicule (masque au plus près, § 2), et entraînent les raccords
  (§ 4.3), le tangage lu sur les raccords (§ 4.1) et la hauteur lue entre photos (§ 4.2). Éteint, la photo affichée
  seule : véhicule visible, rien à lire de plus, et rien de ce qui a été lu avec les voisines n'est appliqué (tangage,
  hauteur entre photos, contour lu : gardés pour la rallumer sans tout refaire) ; la position calée sur l'orthophoto est
  faite pour chaque état de l'interrupteur, chacune gardée.

**Calcul (`render`, WebGL) :**

1. Un maillage de 31 × 31 points (pas de 1 m) suit le terrain sur ±15 m autour de la caméra, **lissé sur 2 m le long de
   la route et 0,5 m en travers** (`smoothTerrain` : écarts au plan moyen lissés par une gaussienne allongée dans le sens
   du cap). Le MNT s'écarte d'une surface lisse de 1 à 3 cm d'un mètre à l'autre ; une bosse `Δz` sous un point à `d` de
   la caméra le déplace de `d × Δz / H`, soit 8 cm à 5 m : sans lissage, les lignes droites ondulent. La pente, le dévers,
   le bombement et les caniveaux restent ; un dos-d'âne est adouci. Lissés aussi en travers (jusqu'au 14/11/2026), le
   bombement et les caniveaux d'une rue disparaissaient : milieu 3 à 5 cm trop bas, caniveaux 7 à 9 cm trop haut, bouts
   des bandes d'un passage piéton à 5 m décalés de 30 cm (`57c93b75-964f-4645-9a9f-5a9000d549ca`). L'inclinaison et la hauteur de la route sous le véhicule (point 2)
   gardent le terrain lissé sur 2 m dans les deux sens, comme le tangage lu sur les lignes : le bombement y penchait le
   plan sous le véhicule (roulis restant de −1,4 à 0,05°, bandes à 0,513 m au lieu de 0,508 m, calage par la route).
2. La caméra est posée à sa hauteur au-dessus du plan de la route sous le véhicule (moyenne du terrain sur
   ±2,5 m en long et ±1,5 m en travers, `groundLevel`), plutôt que sur un seul point du maillage.
3. Pour chaque pixel de l'image, le shader calcule le rayon de la caméra au point du sol, le tourne dans le repère de
   la photo (cap et inclinaison, même rotation que `Calibration.uncorrect`), en déduit les coordonnées dans la photo
   équirectangulaire et y lit la couleur.
4. L'image affichée est **découpée à ±8 m de l'axe de la route**, bords droits, parallèles à la route : rien de plus loin de la route. Interrupteur
   **« Bords gardés »** (éteint par défaut, 13/11/2026) : vue entière sur ±15 m, sans cette découpe.
   Case **« Sol plat »** (éteinte par défaut, 26/11/2026) : la vue et ses mesures se projettent sur le sol plat, sans relief LiDAR HD ni RGE ALTI, comme près d'un pont (imposée à moins de 15 m d'un pont : cochée et grisée).
5. Au-delà de 10 m, l'image est grisée : 0,6° d'inclinaison y déplacent déjà un point d'environ 50 cm (§ 3).

**Résolution :** l'image affichée fait 2 048 px pour 30 m, soit 1,5 cm par pixel ; l'interrupteur « Haute résolution »
la porte à 4 096 px (0,7 cm par pixel : grain et bords de ligne plus nets près de la caméra, quelques secondes de plus).
La carte se zoome jusqu'à 0,6 cm par pixel. La photo est plus fine jusqu'à 10 m : un de ses pixels couvre au sol 0,2 cm en travers et 0,5 cm le
long à 4 m, 0,5 et 2,6 cm à 10 m. Les calculs (hauteur, raccords, position) travaillent sur une image de 1 024 px,
suffisante et quatre fois moins coûteuse.

**Recomposition de trois photos (09/11/2026) :** le véhicule cache le sol sous lui. Les photos voisines, prises environ
5 m avant et après, voient ce sol. Trois règles :

- **masque au plus près du véhicule** : pour les photos du CD21, le contour du véhicule dans le panorama (élévation
  tous les 2,8° d'azimut, marge de 1,5°, environ 10 cm au sol). La caméra est fixe sur le toit : le véhicule occupe
  toujours la même place dans les images d'une séquence. Ce contour est **lu sur la séquence** (`readOutline`, une
  fois, gardé dans le navigateur) : moyenne de 12 photos SD réparties dans la séquence, où le sol est flou et le
  véhicule net ; par colonne, le bord le plus haut assez marqué (45 % du plus fort) dans une bande de ±6° autour des
  contours relevés à la main (`OUTLINES`), au-dessus du logo du CD21 (sinon son bord blanc sur une carrosserie noire
  écrase les autres) : le haut du capot plutôt que l'essuie-glace. Forme d'un véhicule imposée : médiane sur 9
  colonnes, fermeture sur ±4° (une encoche étroite est impossible sur une carrosserie), symétrie gauche-droite (le plus
  haut des deux côtés), jamais sous les contours relevés (même Clio). Les montages diffèrent : rétroviseurs 7 à 9° plus
  près de l'avant le 15/07/2025 (3e222d68) que sur les deux séquences relevées à la main (67e2ef09, 10/06/2025 ;
  5bab4dc2, 03/07/2025). Contour pas encore lu : celui de sa monture (hauteurs des profils, `py/web_profils.py`), sinon les deux relevés réunis.
  Autres producteurs : ellipse de ±5,8 m en long, ±2,9 m en travers ;
- **la photo affichée n'est pas retouchée hors de ce masque** : elle passe devant tout, même là où une voisine serait
  plus précise ; le fondu des raccords ne la touche pas non plus ;
- **sous le masque seulement, les voisines**, recalées sur la photo affichée (raccords, § 7) : celle où l'erreur
  attendue (§ 3) est la plus faible ; près de son propre véhicule (ellipse ci-dessus : ombre portée, reflets), cette
  erreur compte trois fois (`SHADE`). Sol caché sur toutes les photos : le véhicule en dernier recours, pas de trou.

**Pourquoi :** l'ellipse au sol d'avant (corps ±4,5 × ±2,5 m, reflets jusqu'à ±5,8 × ±2,9 m) laissait passer des
morceaux de carrosserie (rétroviseurs, A38) et remplaçait du sol bien vu par la photo affichée ; un contour fixe par
monture en laissait passer sur un autre montage (15/07/2025). Sans la pénalité près
du véhicule des voisines, leur ombre portée faisait des taches sombres (ville d946f2cf-cddc-4476-a414-35aee429c05a). Reste visible : objets en
relief (bordures) coupés au bord du masque, légère différence de teinte dessous.

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
   la pente entière ; le roulis ne suit qu'une part du dévers, fixée à 70 % (environ 40 %
   sur la RD 1074, 75 à 100 % sur l'A38), à quoi s'ajoute un roulis réglable à la main (« Roulis », en degrés, de −2,5 à +2,5°, au pas de 0,05° (molette : un cran, un pas ; le tangage de même),
   0° par défaut, comme le tangage ; positif : penché à droite, côté droit plus bas, convention du véhicule dans tout `src/dessus.js` et `py/web_pose.py`, voir `docs/CALCULS.md` § 1.3). La ligne « Part du dévers » au-dessus de la réglette
   donne le roulis dû au dévers sous la caméra, `−arctan(0,7 × dévers)`, en degrés signés (« +0,84° » ; positif : penché à droite), « — » sans LiDAR HD. Le tangage ajoute le défaut de fixation de la caméra (−0,4 à +0,6° selon
   les séquences) ; depuis le 27/11/2026, ce défaut est celui du profil de campagne (`pitch`, `pitch_sigma`, pose `pitch_default`), valeur de départ de la réglette « Tangage » tant que
   rien n'est lu : +0,7 ± 0,3° (CD21, monture basse), +0,2 ± 0,3° (monture haute), 0 sans profil. Un tangage lu (raccords, lignes) ou réglé à la main le **remplace**
   (les deux sont absolus, relatifs à la route : jamais de somme) ; les réglages déjà enregistrés par les utilisateurs gardent leur sens. L'étiquette dit
   « tangage +0,7° de la campagne (profil) » ; son incertitude s'ajoute (quadrature) à celle de la route tant qu'il est en usage. **Mire des flèches de rabattement** (27/11/2026,
   17 photos de 8 flèches, cote 6,00 m) : avec le tangage lu sur les raccords ou les verticales, la longueur sort à 6,00 ± 0,1 m ; sans tangage lu, il manquait +0,7° (3 photos : +0,65 à +0,83°),
   d'où ce défaut de campagne. La vue du dessus applique cette part (`roll_share` de la pose, 0,7 : `ROLL_SHARE` de `py/web_pose.py`, repris tel quel par `src/dessus.js`) ; les mesures de la visionneuse la prennent aussi, sans verticale ni LiDAR retenu (rang 6, `docs/CALCULS.md` § 1.3), hors pont et avec le LiDAR HD seulement. Le roulis ajoute le **roulis par défaut de la campagne 2025** (profil de campagne, champ `roll` de `CAMPAIGN_PROFILES`, `py/web_profils.py`, par
   producteur et période de prise de vue) : CD21, campagne 2025, +1° (véhicule penché à droite ; −1° dans la convention du cœur, notée ainsi avant le 26/11/2026, même effet). Mesuré le 13/11/2026 sur 25 passages piétons
   (`tests/passages-pietons.js`) : bandes de 0,50 m dans la vue calée par la route puis par les verticales ; une erreur
   de roulis δ y rend la largeur d'une bande proportionnelle à 1 + 2 s δ / H (s : écart en travers à la caméra), d'où
   δ par site. Roulis restant par la route +0,98° en médiane (23 vues ; +0,8° et +1,1° sur les deux montures), sans
   lien avec le dévers (+1,2° − 0,14 × dévers) ; par les verticales −0,08° (15 vues). Les bandes à gauche de la caméra
   (le véhicule roule à droite) en paraissaient étroites : 0,458 m, 0,483 m sur tout le passage (les 3,5 % comptés
   jusque-là « en travers »). Triangulation des coins des bandes (25 largeurs) : 0,499 m. À mesurer de nouveau pour
   chaque campagne ou producteur.
3. **Tangage lu sur les raccords** (`learnPitch`) : une erreur de tangage de la photo affichée paraît, dans le
   recalage des raccords (§ 4.3), comme une échelle de signe opposé sur la voisine avant et sur l'arrière (environ
   ±4,8 % pour 1°). Leur différence donne le tangage de la vue (deux recalages appliqués seulement, § 4.3 : dans une
   courbe serrée, un recalage mal conditionné déformait la vue après coup, 9d92052e, 09/11/2026) ; il est retenu par photo dans le navigateur et
   **appliqué à cette photo** (`pitchFor`) : il bouge sur une bosse ou un creux, que le plan de la route sous le véhicule
   ne suit pas (choix de l'auteur, 09/11/2026). La vue est refaite s'il change de 0,1° ou plus, trois fois au plus ;
   une lecture au-delà de ±2° est écartée. Une photo affichée sans le sien (pas de voisine devant et derrière) prend
   la médiane des photos vues de la séquence (fixation de la caméra) ; une voisine pas encore lue prend celui de la
   photo affichée (avec la médiane, qui compte la photo affichée, les raccords repartaient sans fin). Essai du
   08/11/2026 sur 30 vues : stable par séquence (+0,45 à +0,57°, +0,27 à +0,49°, −0,13 à −0,38° sur trois
   séquences), proche de 0 sur les vues calées par leurs verticales ; à +0,4° sur une vue, les écarts bruts aux
   raccords passent de 14,9 et 11,4 cm à 9,5 et 2,7 cm. Depuis le 13/11/2026, les **photos à deux pas** (avant la
   précédente, après la suivante, environ 10 m ; `birdeye_far`, `readyFar`) sont aussi recalées sur la photo affichée, pour
   le tangage seulement (pas dessinées) : l'échelle de chaque raccord vaut e + 0,9 δ a / H, droite ajustée sur tous les
   raccords appliqués, une photo devant et une derrière au moins. Sur 24 photos (A38, RD 1074, D33) : tangage lu sur 20
   au lieu de 15 (un seul raccord voisin réussi suffit avec une photo à deux pas de l'autre côté), même dispersion (0,13°
   sur l'A38).
   **Repris par les mesures** (depuis le 27/11/2026) : la vue annonce à la page le tangage lu sur les raccords de la photo affichée (`pitch_read`,
   `announceTilt`, `App.birdeye_tilt_set`) et `Calibration.tilt` l'utilise au rang 3 bis, devant le LiDAR : tangage lu + pente du LiDAR HD sous la caméra
   (comme `groundUp`), roulis de la route et du profil, incertitude 0,2° en tangage (`RACCORD_PITCH_SIGMA`, provisoire, § 8.4), sous réserve que la route
   soit lisible (sol LiDAR HD, pas de pont proche, relief non douteux : § 8.4). Seule la lecture sur les raccords de la photo est reprise (pas la médiane de
   la séquence ni les lignes). Les mesures déjà prises sur la photo sont recalculées à l'arrivée de la lecture. Sans lecture ou sans route lisible, l'ordre d'avant.
   Les mesures sans vue du dessus prennent par ailleurs, au rang 6, la même inclinaison que la vue par la route (« route (LiDAR HD) + profil » : pente du LiDAR HD
   sous la caméra + tangage du profil, 70 % du dévers + défaut de roulis ; ±0,5° en tangage, ±1° en roulis, provisoire), mêmes conditions de route lisible
   (`docs/CALCULS.md` § 1.3). La pente est ajustée là sur le plan de 15 points de `LIDAR_GRID` (±1,5 m × ±0,8 m), dans la vue sur le terrain lissé de ±2,5 m × ±1,5 m :
   les deux inclinaisons s'accordent à la précision de la pente près, pas exactement.
4. **Tangage lu sur les lignes et les bords de la route** (`linesPitch`, `learnLines`, depuis le 13/11/2026), sur la photo
   seule, sans voisine : une erreur de tangage δ change l'échelle en travers selon la distance le long, 1 + a δ / H ; deux
   lignes parallèles s'écartent devant et se resserrent derrière (environ 7 % à 8 m pour 1° et 2 m de hauteur, contre
   ±4,8 % par degré sur les raccords). Par tranches de 1 m de 4 à 10 m devant et derrière le véhicule : lignes peintes
   (pics clairs de 6 à 45 cm) et bords de l'enrobé (marche de teinte du profil brut, accotement, herbe), suivis d'une
   tranche à l'autre ; ajustement commun s_i(a) = p_i (1 + κ a) + q a + c a² (q : cap, c : courbe, κ balayé), les pistes
   qui ne s'y accordent pas écartées. Lecture gardée par photo si ses lignes extrêmes sont à 6 m au moins l'une de
   l'autre ; médiane de la séquence dès 3 photos. Synthèse : ±1° retrouvés à 0,02° près (`tests/essai-dessus.html`).
   Séquences de campagne (13/11/2026, 8 photos chacune) : A38 −0,38° en médiane, RD 1074 +0,18°, à 0,2° près des
   raccords ; petite RD sans peinture, par ses bords : +0,19° (−0,46 à +0,87° d'une photo à l'autre) ; D33, lignes à
   moins de 5 m, lectures de −1 à +2° (écartées par le filtre). Carrefours en ville (passages piétons) : lignes non
   parallèles, rien de retenu. Ordre (`autoPitch`) : raccords de la photo, lignes de la séquence (pas d'une photo seule : +1,3° et +1,6°
   sur deux photos là où leur séquence lisait 0 à +0,5°),
   raccords de la séquence.
   **Seulement faute de tangage lu sur les raccords** de la photo (raccords en échec, ou sans « Véhicule masqué » ; demande
   de l'auteur, 13/11/2026), une fois les raccords faits. Lu sur **±25 m** (`LINES_WIDE`, l'équivalent d'un point de fuite)
   avec le terrain LiDAR HD lu sur cette portée (2 601 points, une fois par photo), sinon sur 10 m : 1,5 à 2 fois plus
   stable (A38 −0,36 ± 0,09° contre −0,50 ± 0,16°, raccords −0,3 à −0,4° ; RD 1074 +0,15 ± 0,09° contre +0,17 ± 0,14° ;
   petite RD +0,5 ± 0,37°, raccords +0,5°) ; sur sol plat au-delà de 15 m, décalé de +0,3 à +0,4° (pente lointaine). Sur
   25 m, jusqu'à 20 pistes discordantes écartées (4 sur 10 m). D33 (route de vallée sinueuse, 33 à 55 pistes) : rien de lu
   sur 25 m. Lecture d'une photo seule admise si elle est faite sur 25 m (A38 sans raccords : −0,3°, comme les raccords).
5. Interrupteur « Calage par les verticales » (depuis le 10/11/2026, coché d'office pour une photo en zone d'habitation de la
   BD TOPO, décoché ailleurs : sur 3 essais de l'auteur hors agglomération, la vue était meilleure inclinée par la route, cause à
   chercher ; en ville, à Pouilly-en-Auxois, raccords recalés avec les verticales seulement ; modifiable pour la photo affichée ;
   grisé sans verticales lues ou sans terrain LiDAR HD) : décoché, la photo
   est inclinée par la route, comme sans verticales, roulis et tangage réglables à la main ; coché, par ses verticales.
6. Le curseur « Tangage », réglé à la main, ne sert **qu'en dernier**, faute de tangage lu (curseur grisé tant qu'un tangage
   lu prime, demande de l'auteur, 13/11/2026), sauf « Forcer le réglage à la main » cochée ; avec le roulis et le forçage, il
   est **retenu par séquence** dans le navigateur. Le calage du tangage sur l'orthophoto (lignes de peinture,
   20 cm) a été retiré : trop peu précis (0,1° trouvé là où l'œil voyait 0,5° sur la D33).

**Limites :** le roulis ne se cale pas sur l'orthophoto (trop peu précise : 10 à 30 cm d'écart sur la position des
lignes, essai du 13/11/2026) ; son défaut par campagne se mesure sur les passages piétons. Par la route, le roulis
reste à ±1° d'une photo à l'autre (quartiles du roulis restant : +0,4 à +2,2° avant la correction). En agglomération,
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
   **Photos du CD21** (imajbox sur Clio 5, deux montures ; la caméra ne bouge plus une fois montée) : la **monture**
   d'après la date de prise de vue (profil de campagne, `py/web_profils.py`, 1,93 m avant le 24/06/2025, 2,07 m ensuite, ±4 cm ; changement de véhicule le 23 ou le 24/06) ; hors de ces
   dates, la plus proche de la hauteur lue, même avec l'inclinaison de la route quand les photos n'ont pas de verticales
   (les deux concordent au cm près là où elles existent). La date d'abord depuis le 13/11/2026 : la hauteur lue se joue à
   quelques cm du seuil de 2,00 m (f2a245d0-aeea-4249-ba9c-fad83b442a23, 07/07/2025 : 2,03 ou 1,98 m selon le terrain ; cefbd9bd-419b-4093-ab61-374b9b794c50 à 2,007 m, 09c2e813-8426-49cf-8029-bc2f3d511f40
   à 1,968 m). Sur les 17 passages piétons : bandes par les verticales à 2,6 % de 0,50 m en médiane (3,2 % avant), 13,2 %
   à 95 % (16,2 %) ; par la route, 5,0 % (4,8 %), deux vues de plus, mesurées sur le tablier plat d'un pont. Relevé du 08/11/2026 sur 36 vues :
   1,90 à 1,95 m du 28/05 au 23/06/2025, 2,05 à 2,07 m le 03/07 (2,15 le 07/07, dispersé en octobre) ; l'altitude RTK moins
   le sol reste vers 2,05-2,10 m tout du long (antenne fixe, caméra plus basse sur la première monture). Étude du 27/11/2026 : cet écart
   n'est qu'une borne, il saute aussi au 24/06/2025 (1,93 → 2,11 m) et surestime d'environ 5 cm la hauteur de caméra après cette date
   (dispersion d'environ 10 cm) : il passe après la calée et la monture dans `Session.camera_of` (#59).
   Étude du 27/11/2026, deux montures : 1,94 m puis 2,055 m lues entre photos, rupture le 23/06 (IC 19-30/06) ; écart RTK − sol
   1,93 → 2,11 m. Étude 2026 (séquence 7d66f208-acb4-46f6-bb23-65d8717557a7, 11/06/2026) : 1,929 m en médiane (33 photos, IC 95 % [1,888 ; 1,940]),
   écart RTK − sol 1,94 m (69 photos), mêmes niveaux que la monture basse 2025 : fiche `cd21-2026-monture-basse` (1,93 m ±0,05, roulis repris de 2025).
   **Hauteurs côte à côte** (#59) : l'étiquette d'informations a une ligne « Hauteur : 2,07 m (monture haute) ; lue entre
   photos 2,05 m ; écart RTK − sol 2,09 m (borne) » (`heightLine`) : la hauteur retenue et son origine, puis, seulement si
   elles sont connues et différentes d'elle, la hauteur lue entre photos (avec « Véhicule masqué ») et l'écart RTK − sol de la photo
   (`pose.rtk_height`, borne). Elle passe en orange quand l'une d'elles s'écarte de la hauteur retenue de plus de `HEIGHT_ALERT`. Une hauteur
   calée pour la séquence (`pose.height_source`) passe avant la monture, la lecture entre photos et la médiane RTK de la séquence, comme
   dans `camera_of` ; cette médiane ne garde que les écarts RTK − sol (`pose.rtk_height`), jamais une hauteur calée.
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

**Recalage appliqué seulement s'il est bon** (`JOIN_GOOD`, 09/11/2026) : moins de 5 cm d'écart médian au raccord
après correction, et moins qu'avant. Dans la courbe serrée du 15/07/2025 (9d92052e), 19,7 → 7,4 cm déformait les
lignes de l'axe, visiblement mieux raccordées sans recalage (constat de l'auteur).

**Décalage seul, en repli** (`JOIN_SHIFT_ONLY`) : quand la pose complète est refusée (peu de mesures, zone commune
étroite : angles mal tenus, bc400f2b, 37 mesures, 78 cm et 3° de lacet), le recalage est refait sur le seul décalage.

**Écarts restants** (`bendField`, recalage appliqué seulement) : la pose ajustée est juste en moyenne, pas partout ;
les écarts restants des blocs gardés sont lissés en un champ de déplacement de la voisine (portée 0,8 m, nul loin des
mesures, cases de 0,5 m), appliqué dans le shader, donc sous le véhicule de la photo affichée seulement.

**Résultats (essai du 07/11/2026) :** écart médian au raccord de 10,8 à 2,9 cm sur 38 raccords de route, de 17,6 à
3,9 cm sur 14 en agglomération, tous améliorés. Un premier recalage, par les seules lignes en long, faisait 8,3 à
3,6 cm sur route et rien en ville : il a été remplacé.

**Fondu (avec « Véhicule masqué » ; la case « Raccords fondus » a été retirée le 09/11/2026, `renderBlended`) :** le même sol paraît plus clair sur une photo que sur
l'autre selon l'angle au soleil, d'où des taches en ellipse autour des raccords (le gain global entre photos n'est que de
1 à 3 %). Fondu en deux bandes : chaque photo rendue seule, sans son véhicule ; sa luminosité lente (256 px pour 30 m,
floutée sur environ 1 m) ; les voisines prennent celle de la photo affichée (écart lu là où les deux voient le sol,
étendu sous le véhicule sur environ 3 m), le détail fin reste le leur, le raccord reste net ; la photo affichée
n'est pas retouchée (09/11/2026 ; avant, les deux allaient vers une moyenne). Essai du 08/11/2026 : ellipses effacées sur la D33 du 04/07 et a9fd217d, atténuées en ville ; un
fondu simple de ±60 cm dans le shader n'y faisait presque rien. Calcul par la carte graphique (09/11/2026) : chaque
photo seule rendue dans une texture, sa bande basse lue sur ses niveaux réduits (mipmaps, 256 px) ; écarts de teinte
floutés en JavaScript (256 x 256) ; mélange final dans un shader. 0,14 s par image (0,5 s en JavaScript), 0,27 s en
haute résolution (1,7 s).

**« Sans cache (essais) »** (interrupteur, éteint, pas retenu) : oublie tout ce que Bird Eye a retenu (contours,
tangages, hauteurs, raccords, terrain, vues ; pas les réglages faits à la main) et recommence à chaque photo montrée,
même déjà vue.

**Calculs par la carte graphique :** dessin, masque du véhicule, fondu, et gris et sol sûr des raccords (`readRaster`,
étape 4 du shader : 0,1 s par photo au lieu de 0,26 s). Restent en JavaScript : la recherche des blocs des raccords (FFT de
blocs de 128 px, 0,4 s par voisine ; une recherche directe sur la carte graphique demanderait des milliards de lectures,
bien plus lente sur un poste sans accélération graphique), le contour du véhicule (petit, une fois par séquence), la
hauteur entre photos (0,1 s).

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
l'orthophoto » : décochée par défaut (décision du 20/11/2026), à cocher dans le panneau de réglages de la vue du dessus ; non retenue d'une session à l'autre.

**Limites :** un décalage de plus de 1,2 m serait pris pour celui d'une autre ligne. Sans peinture (bords d'enrobé
seuls), le calage est moins sûr.

## 5. Mesurer sur la vue

L'outil « Longueur » de la mesure sur la carte trace un segment en deux clics (l'outil « Surface » trace un contour, sans incertitude : aire et périmètre sur le plan local du premier sommet, `App.add_map_area`). Bird Eye n'est pas nécessaire : sans elle, mesure sur le fond de carte seul. Il donne sa longueur et une incertitude qui combine
l'inclinaison sur ses deux axes, la hauteur, l'écart du sol (corrélé entre deux points proches : sur une courte distance,
une erreur d'échelle) et, entre deux photos, leur position relative (5 cm en RTK
vérifié, sinon 30 cm), sans descendre sous 5 % de la longueur (écart constaté à l'orthophoto). Le mieux est de mesurer
en face de la caméra (±4 m). Un bout hors de la vue se mesure sur le fond de carte seul, sans incertitude.

**Incertitude selon la situation** (`measureError`) : inclinaison tirée de la route dans un virage, incertitude majorée du
penchement probable du véhicule (0,5° par m/s² d'accélération latérale, photos précédente et suivante) ; hauteur par
l'altitude RTK moins le sol, au moins ±10 cm (12 cm d'écart avec le décalage entre photos sur le giratoire b47b4351) ;
mesure à cheval sur deux photos, au moins l'écart mesuré à leurs raccords (après recalage, sinon d'origine).

## 6. Session et réglages gardés

- Dans le navigateur : roulis et tangage réglés à la main (en degrés), par séquence (`web-measures/dessus-reglages`, clé `rollDeg` ; l'ancienne clé `roll`, en part du dévers, est ignorée), tangage lu sur
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
- `tests/essai-passages.html` : passages piétons de l'auteur (`tests/passages-pietons.js`, bandes de 0,50 m), avec le
  réseau : vue calée par la route puis par les verticales, largeur des bandes et roulis restant (§ 4.1) ; contrôle la
  largeur médiane (0,50 m ± 2 %) et le roulis restant médian (sous 0,5°), qui protègent le défaut de roulis de la
  campagne ; journalise l'écart de chaque bande à l'incertitude affichée. Orientation des bandes cherchée à ±4° de l'axe
  de la route (sur ±45°, des rangées en biais faussaient la largeur de 6 à 15 %). 17 photos mesurables sur 25, environ
  6 min (`tools/essais.sh passages`) ; `#rapide` : 6 photos, ±4 % et 0,6°, environ 2 min.
- `tools/essais.sh birdeye` : synthèse, références `#rapide` et passages `#rapide`, environ 3 min 30 (processeur
  graphique, cache HTTP gardé).

## 8. Constantes

Les constantes ci-dessous sont celles de `src/dessus.js` et des fichiers `py/` qui pilotent la vue du dessus ; les numéros
de ligne sont ceux du dépôt au 26/11/2026 (`grep -n <NOM>` les retrouve). **À ne pas confondre :** la *résolution de la
source* (MNT LiDAR HD de l'IGN à 50 cm, la seule source de relief lue par la vue ; le RGE ALTI 1 m ne sert qu'à d'autres calculs,
par exemple `py/core/precision.py`, jamais à la projection de la vue) et le *pas d'échantillonnage de l'application*
(`STEP`, 1 m : une maille sur deux du MNT, lissée ensuite). Un « sigma » **réglé empiriquement** (résidu observé sur des
essais) n'est pas une précision du MNT : c'est la part d'incertitude que l'application affiche, tirée de nos mesures.
Colonne « Origine » : *mesure* (relevé ou essai daté), *réglage empirique*, *donnée du fournisseur*, *choix d'affichage*,
*non documentée* (aucune trace dans les commentaires ni dans l'historique).

### 8.1 Grille et relief

| Constante (fichier:ligne) | Valeur | Unité | Rôle | Origine | Effet d'une modification |
|---|---|---|---|---|---|
| `REACH` (`dessus.js:23`) | 15 | m | Portée de la vue (carré de ±15 m autour de la caméra) | choix d'affichage | Plus grand : vue plus large, mais sol de plus en plus faux (l'inclinaison domine) et lectures LiDAR plus nombreuses |
| `STEP` (`dessus.js:25`) | 1 | m | Pas d'échantillonnage du terrain (le MNT LiDAR HD lui-même est à 50 cm) | choix technique (commentaire : « LiDAR HD à 50 cm, toit de la chaussée compris ») | Plus petit : plus de points par requête (requête POST d'environ 2 600 points pour ±25 m) ; plus grand : bombement et caniveaux mal suivis |
| `TERRAIN_SMOOTH` (`dessus.js:428`) | 2 | m | Lissage gaussien du terrain le long de la route (le MNT s'écarte d'une surface lisse de 1 à 3 cm d'un mètre à l'autre) | mesure (essai du 07/11/2026, A38 : écart de la rive 3,5 → 0,4 cm) | Plus petit : lignes qui ondulent ; plus grand : bosses et creux réels effacés |
| `TERRAIN_SMOOTH_ACROSS` (`dessus.js:428`) | 0,5 | m | Lissage en travers (bombement et caniveaux gardés) | mesure (essai du 14/11/2026, ville 57c93b75 : écart au LiDAR brut 4,5 → 2,6 cm) ; 2 m laissait le milieu 3 à 5 cm trop bas | Plus grand : caniveaux et bombement effacés, bandes de passage piéton qui dérivent ; plus petit : bruit du MNT laissé |
| `DECK_KEEP` (`dessus.js:343`) | 0,6 | part | Part minimale des points du terrain qui doit rester hors de l'emprise d'un pont, sinon terrain indisponible | réglage empirique (non documentée plus avant) | Plus grand : terrain refusé plus souvent près d'un ouvrage ; plus petit : tablier reconstitué sur trop peu de points |
| `ALTI_CHUNK` (`dessus.js:30`) | 300 | points | Points par requête d'altitude en GET (secours du POST) | donnée du fournisseur (longueur d'adresse : environ 6,5 Ko) | Trop grand : adresse refusée |
| `MIN_KEEP` (`web_terrain.py:43`) | 0,7 | part | Part de la grille du plan de route qui doit rester quand des points sous un pont sont écartés | réglage empirique (non documentée plus avant) | Plus grand : plan de route refusé plus souvent près d'un pont |
| `GRID_ALONG` (`web_terrain.py:27`) | −2,5 à +2,5 par 0,5 | m | Points en long de la grille où le LiDAR est lu pour le plan de la route (avec `GRID_ACROSS`) | réglage empirique (ajusté sur ±2,5 m en long et ±1,5 m en travers, comme `groundSlopes`) | Plus étendue : plan moins local, pente moyennée sur plus de route |
| `GRID_ACROSS` (`web_terrain.py:28`) | −1,5 ; −0,8 ; 0 ; 0,8 ; 1,5 | m | Idem, en travers | idem | Idem |
| `LIDAR_ALONG`, `LIDAR_ACROSS` (`core/calibration.py:55`) | 1,5 ; 0,8 | m | Grille du plan de route sous les roues pour le roulis par défaut (dévers du LiDAR HD) | mesure (Pouilly-en-Auxois, 18 photos : 0,4° en long et 0,5° en travers contre les verticales) ; la grille atténue l'arrondi au centimètre du service | Plus large : roulis moyenné sur plus de chaussée ; plus étroite : arrondi du service moins atténué |
| `RELIEF_ALONG`, `RELIEF_ACROSS` (`dessus.js`, `diagnoseRelief`) | 12 ; 3 | m | Zone utile du diagnostic du relief : chaussée devant la caméra (en long dans le sens du cap, ± en travers) | choix de conception (#67) ; provisoire, à caler | Plus grand : plan moyenné sur plus de terrain |
| `RELIEF_MIN_VALID` (`dessus.js`) | 0,9 | part | En deçà, « grille partielle » (points reçus / points demandés) | provisoire, à caler | Plus grand : alerte plus souvent |
| `RELIEF_MAX_RMS` (`dessus.js`) | 0,10 | m | Au-delà, « relief irrégulier » (écart quadratique au plan de la zone utile) | provisoire, à caler | Plus petit : alerte plus souvent |
| `RELIEF_MAX_SLOPE` (`dessus.js`) | 8 | % | Au-delà, « pente forte » (pente du plan de la zone utile) | provisoire, à caler | Idem |
| `RELIEF_MAX_BREAK` (`dessus.js`) | 2 | degré | Au-delà, « rupture de pente » (écart entre les pentes des moitiés proche et lointaine) | provisoire, à caler | Idem |

#### Diagnostic du relief (#67)

La vue du dessus dit, dans son étiquette d'information, si le relief LiDAR HD sur lequel elle projette est plausible (aucune
projection, mesure ni incertitude n'en dépend). `diagnoseRelief` lit la grille brute, avant lissage : part des points reçus
(sous l'emprise d'un pont, écartés, ils ne comptent pas), puis, sur la zone utile (12 m devant la caméra, ± 3 m), un plan
`z = a·x + b·y + c` ajusté par moindres carrés : écart quadratique et médiane des écarts absolus, pente du plan, et rupture de
pente (écart entre les pentes des moitiés proche et lointaine, en degrés). Ligne normale : « Relief LiDAR HD : 98 % des points,
écart au plan 3 cm » ; si un seuil (tableau 8.1) est franchi, en orange : « Relief douteux : grille partielle (62 %) », « relief
irrégulier (14 cm) », « pente forte (9 %) » ou « rupture de pente (3,1°) ». Sur sol plat (pont à moins de 15 m ou option) : pas de
diagnostic, le relief n'est pas utilisé. L'écart au plan n'est **pas** une précision du MNT : une chaussée bombée ou en dévers
s'en écarte de quelques centimètres sans que le MNT soit faux.

### 8.2 Incertitudes

Valeurs affichées, combinées dans `uncertainty` et `measureError` (voir § 3 et § 5).

| Constante (fichier:ligne) | Valeur | Unité | Rôle | Origine | Effet d'une modification |
|---|---|---|---|---|---|
| `LIDAR_SIGMA` (`dessus.js:89`) | 0,02 | m | Écart-type de l'écart du sol réel au terrain lu, sur LiDAR HD (résidu, **pas** la précision du MNT, que `py/core/triangulation.py` donne à 8 cm : `LIDAR_ERROR`) | réglage empirique, introduit avec la première vue (540eaa3), « résidu LiDAR » ; chiffre repris dans `docs/CALCULS.md` ; justification détaillée non documentée | Plus grand : incertitude de longueur plus large (échelle et courbure) ; plus petit : incertitude sous-estimée |
| `FLAT_SIGMA` (`dessus.js:89`) | 0,1 | m | Idem sur sol supposé plat (aussi valeur initiale tant que le terrain n'est pas lu) | réglage empirique (non documentée plus avant) | Idem |
| `GROUND_CORRELATION` (`dessus.js:90`) | 2 | m | Portée de la corrélation de l'écart du sol entre deux points (deux points proches bougent ensemble) | choix de modèle (4aa832c, 13/11/2026 : 9 cm → 2,5 à 5 cm sur une bande de 0,50 m) ; commentaire du code : « terrain lissé sur 2 m » | Plus grand : incertitude de longueur plus faible sur courte distance ; plus petit : erreurs du sol comptées indépendantes à chaque bout |
| `GROUND_SIGMA` (`dessus.js:79`) | 1 | degré | Incertitude d'inclinaison déduite de la route (sans verticales), sur LiDAR | réglage empirique (voir `docs/CALCULS.md`) | Plus grand : incertitude de mesure plus large, grisé inchangé |
| `DECK_SIGMA` (`dessus.js:88`) | 1,5 | degré | Idem sur un pont (tablier supposé plan, pente jusqu'à 3 %, 1,7°) | réglage empirique (e9801fc) ; commentaire : pente de tablier jusqu'à 3 %, soit 1,7° | Idem |
| `LEAN` (`dessus.js:259`) | 0,5 | degré par m/s² | Penchement du véhicule en virage, ajouté à l'incertitude (5° par g), sans corriger la vue | mesure (giratoire b47b4351, 4,4 m/s² : bord à 8 m décalé de 1,3 m) | Plus grand : incertitude majorée en virage ; ne change pas l'image |
| `HEIGHT_SIGMA` (`dessus.js:75`) | 0,05 | m | Écart-type de la hauteur de caméra lue sur le décalage entre photos voisines | mesure (essai de 28 paires) | Plus grand : incertitude de hauteur plus large |
| `HEIGHT_ALERT` (`dessus.js`, avant `GROUND_SIGMA`) | 0,15 | m | Écart de la hauteur lue entre photos, ou de l'écart RTK − sol, à la hauteur retenue au-delà duquel la ligne « Hauteur » de l'étiquette passe en orange (`heightLine`) | choix provisoire (#59) : environ 2 σ d'une photo (dispersion de 8 à 9 cm par photo pour la hauteur lue, 10 cm pour l'écart RTK − sol, études du 27/11/2026) | Plus petit : plus d'alertes ; plus grand : écarts réels tus |
| `RTK_SIGMA` (`dessus.js:78`) | 0,1 | m | Plancher de l'écart-type de la hauteur par l'altitude RTK moins le sol | mesure (12 cm d'écart avec le décalage entre photos au giratoire b47b4351, alors que l'écart interne n'est que de 2 cm) | Plus petit : hauteur RTK présentée plus sûre qu'elle n'est |
| `height_sigma` des profils (`web_profils.py:41`) ; `HEIGHT_SIGMA_DEFAULT` (`web_profils.py:20`) | 0,04 | m | Écart-type de la hauteur par monture du CD21 (la page le lit dans la pose : `mount_sigma`) | non documentée (valeur non justifiée ; les hauteurs lues sont dans le commentaire de `CAMPAIGN_PROFILES`) | Plus grand : hauteur par monture moins crédible |
| `MEASURED` (`dessus.js:74`) | 0,05 | part de la longueur | Plancher de l'incertitude affichée d'une longueur (écart constaté à l'orthophoto) | mesure (essais du 08/11/2026, `docs/CALCULS.md`) | Plus petit : incertitude affichée parfois sous l'écart réellement constaté |
| `roll_sigma` des profils (`web_profils.py:41`) ; `ROLL_SIGMA_DEFAULT` (`web_profils.py:21`) | 1,0 | degré | Dispersion du roulis d'une photo à l'autre dans une campagne (incertitude du défaut de campagne) | mesure (±1° sur 23 vues, § 4.1) | Plus petit : roulis de campagne présenté plus sûr qu'il n'est |
| `SIGMA_MIN` (`web_terrain.py:30`) | 0,6 | degré | Incertitude au moins égale à l'écart mesuré sur les témoins du décalage de terrain (dévers) | réglage empirique (non documentée plus avant) | Plus petit : décalage de terrain jugé plus précis |
| `LIDAR_MAX_SIGMA`, `LIDAR_MIN_SIGMA` (`core/calibration.py:58-59`) | 0,8 ; 0,3 | degré | Plafond au-delà duquel le modèle du LiDAR est refusé (caméra qui ne suit pas le véhicule) ; plancher de l'incertitude | réglage empirique (non documentée plus avant) | Plafond plus bas : modèle refusé plus souvent |

### 8.3 Sol plat, ponts et monture

| Constante (fichier:ligne) | Valeur | Unité | Rôle | Origine | Effet d'une modification |
|---|---|---|---|---|---|
| `BRIDGE_FLAT_RADIUS` (`core/roads.py:27`) | 15 | m | Distance à vol d'oiseau au tablier (BD TOPO) en deçà de laquelle la vue suppose le sol plat (le relief y donne le fond de la vallée) | décision du cœur (aaea47c, 26/11/2026) ; valeur non justifiée | Plus grand : sol plat plus souvent imposé ; plus petit : relief du fond de vallée projeté sur la route |
| `BRIDGE_REACH` (`core/roads.py:26`) | 8 | m | Distance entre la photo et un tronçon en pont pour la marquer « sur un pont » (demi-chaussée et précision GPS) | réglage empirique, justifié par la demi-chaussée et le GPS (pas de mesure citée) | Plus grand : photos d'approche marquées sur un pont |
| `BRIDGE_ANGLE` (`core/roads.py:28`) | 30 | degré | Écart maximal entre le tronçon en pont et le sens de la séquence | non documentée | Plus petit : ponts croisés écartés ; plus grand : pont perpendiculaire retenu |
| `BRIDGE_LEFT` (`core/roads.py:33`) | 30 (= `MARGIN`) | m | Distance à tout tronçon en pont au-delà de laquelle la case « Sur un pont » est proposée à décocher | choix de conception (maille de lecture BD TOPO) | Plus petit : alerte plus tôt |
| `DECK_HALF_WIDTH` (`core/roads.py:32`) | 6 | m | Demi-largeur d'emprise d'un pont de part et d'autre de l'axe (chaussée, trottoirs, garde-corps) | réglage empirique ; la largeur BD TOPO « n'est pas fiable » (mémoire du projet) | Plus grand : plus de points LiDAR écartés autour de l'ouvrage |
| `BIRDEYE_DECK_SCAN` (`web_pose.py:354`) | 40 | m | Distance à laquelle les emprises de pont sont transmises à la vue (±25 m de terrain lu, 35 m dans les coins) | non documentée (le commentaire cite ±25 m de terrain lu sur les lignes, `LINES_WIDE`) | Plus petit : tablier hors liste pour un terrain lu plus large |
| `height` des profils (`CAMPAIGN_PROFILES`, `web_profils.py:41` ; la page lit `pose.mounts` et `pose.mount`, `dessus.js:2264`) | 1,93 jusqu'au 23/06/2025 ; 2,07 dès le 24/06/2025 | m | Hauteur de la caméra du CD21 par date de prise de vue (prioritaire sur la hauteur lue entre photos, seule sur un pont) | mesure (changement de véhicule, bords du véhicule de −27,1° à −26,0°, hauteurs lues 2,04 à 2,10 m) ; limite au jour faute d'heure du changement | Une erreur de 5 cm sur 2 m fait 2,5 % d'échelle |
| `MIN_HEIGHT`, `MAX_HEIGHT` (`dessus.js:877`) | 1,5 ; 2,6 | m | Hauteurs de caméra plausibles pour une lecture entre photos | réglage empirique (non documentée plus avant) | Plus large : lectures aberrantes acceptées |
| `MIN_NCC` (`dessus.js:877`) | 0,2 | corrélation | Corrélation minimale d'une lecture de hauteur | réglage empirique (non documentée plus avant) | Plus bas : hauteurs lues sur des raccords peu corrélés |
| `HEIGHTS_MIN` (`dessus.js:1623`) | 3 | photos | Lectures de hauteur nécessaires pour garder la médiane d'une séquence | réglage empirique (non documentée plus avant) | Plus petit : hauteur de séquence moins sûre |

### 8.4 Inclinaison (tangage et roulis)

| Constante (fichier:ligne) | Valeur | Unité | Rôle | Origine | Effet d'une modification |
|---|---|---|---|---|---|
| `ROLL_SHARE` (`web_pose.py:400`) / `ROLL_SHARE_DEFAULT` (`dessus.js:1683`) | 0,7 | part du dévers | Part du dévers de la route prise en roulis du véhicule (le tangage suit la pente entière) ; la page lit celle de la pose (`roll_share`) | réglage empirique, repris de la vue du dessus (d69c60e) ; le défaut de campagne a été estimé avec cette part | Change le roulis par défaut de toutes les photos ; le défaut du profil de campagne (`roll`, +1°) devrait être réestimé |
| `roll` des profils (`CAMPAIGN_PROFILES`, `web_profils.py:41`) | CD21, 2025 : +1,0 | degré | Défaut de roulis ajouté au roulis tiré du dévers, par producteur et période | mesure (23 vues de passage piéton, 13/11/2026 : +0,98° en médiane) | Décale tous les roulis de la campagne |
| `pitch`, `pitch_sigma` des profils (`CAMPAIGN_PROFILES`, `web_profils.py`) | CD21 basse (2025, 2026) : +0,7 ± 0,3 ; haute : +0,2 ± 0,3 | degré | Tangage par défaut de la caméra relatif à la route, appliqué faute de tangage lu (réglette de départ, rang 6) ; 0 sans profil | mesure (mire des flèches du 27/11/2026 : médiane des tangages lus sur les raccords par monture, +0,7° confirmé à la main sur la basse ; haute : 2 flèches seulement) | Change les mesures sans tangage lu (0,7° de tangage : de l'ordre du décimètre sur une flèche de 6 m) ; la valeur de la monture haute est à confirmer |
| `ROUTE_PITCH_SIGMA` (`web_pose.py`, `Pose`) | 0,5 | degré | Incertitude du tangage du rang 6 « route (LiDAR HD) + profil » des mesures (pente LiDAR sous la caméra + tangage du profil), sans vue du dessus ; **provisoire** | mires du 27/11/2026 (flèches de rabattement : route seule + tangage du profil, écart résiduel de 0,3 à 0,4°) | Plus petit : mesures plus sûres d'elles-mêmes, mais l'incertitude d'une inclinaison est un seul nombre (l'axe le moins sûr, le roulis) : sans effet seul |
| `ROUTE_ROLL_SIGMA` (`web_pose.py`, `Pose`) | 1,0 | degré | Incertitude du roulis de ce même rang 6 (70 % du dévers + défaut de roulis du profil) ; donne aussi l'incertitude d'ensemble de l'inclinaison ; **provisoire** | mires du 27/11/2026 (passages piétons : roulis à ±1°) | Plus petit : mesures sur route seule plus sûres d'elles-mêmes (moins d'erreur annoncée) |
| `RACCORD_PITCH_SIGMA` (`web_pose.py`, `Pose`) | 0,2 | degré | Incertitude du tangage lu sur les raccords, rang 3 bis des mesures (`_seam_tilt`) ; **provisoire** | mires du 27/11/2026 (flèches de rabattement : tangage lu sur les raccords juste à 0,1 à 0,2°) | Plus petit : mesures plus sûres d'elles-mêmes (l'incertitude d'ensemble reste celle du roulis tant que `ROUTE_ROLL_SIGMA` est plus grande) |
| `RELIEF_MIN_VALID`, `RELIEF_MAX_RMS`, `RELIEF_MAX_SLOPE`, `RELIEF_MAX_BREAK`, `RELIEF_ALONG`, `RELIEF_ACROSS` (`py/core/relief.py`, mêmes valeurs que `dessus.js:420` à `:424`, vérifiées par `tests/coeur/test_relief.py`) | 0,9 ; 0,10 ; 8 ; 2 ; 12 ; 3 | part, m, %, degré, m, m | Diagnostic du relief (#67) : au-delà, le rang 6 « route » des mesures ne s'applique pas (il revient au roulis de campagne) | provisoires, à caler (comme dans la vue du dessus) | Plus petits : route écartée plus souvent ; plus grands : route admise sur un relief douteux |
| `ROLL_PITCH_LIMIT` (`dessus.js:1683`) | 2,5 | degré | Bornes d'un réglage de roulis ou de tangage retenu d'une session précédente | non documentée | Plus petit : anciens réglages rognés |
| `PITCH_MAX` (`dessus.js:1708`) | 2 | degré | Tangage lu (raccords, lignes) au-delà duquel la lecture est écartée | réglage empirique (lectures aberrantes) | Plus petit : lectures valides écartées |
| `PITCH_STEP` (`dessus.js:1707`) | 0,1 | degré | Écart de tangage en deçà duquel la vue n'est pas refaite | non documentée (à titre indicatif, 0,1° font 9 cm à 10 m, § 3) | Plus petit : vues refaites plus souvent |
| `PITCH_PASSES` (`dessus.js:1708`) | 3 | passes | Nombre maximal de vues refaites par photo après relecture du tangage | choix technique | Plus grand : plus de recalculs, convergence plus fine |
| `LINES_SPREAD` (`dessus.js:1718`) | 6 | m | Écart minimal des lignes extrêmes pour garder un tangage lu sur les lignes | mesure (D33 : lignes à 4,9 à 5,6 m, lectures de −0,7 à +2,2° ; A38 et RD 1074 à 6,5 m : à 0,2° des raccords) | Plus petit : lectures peu sûres retenues |
| `LINES_SEQUENCE` (`dessus.js:1718`) | 3 | photos | Lectures sur les lignes nécessaires pour utiliser la médiane de la séquence | mesure (une photo seule s'est trompée de plus de 1° : RD 1074, D33) | Plus petit : photo isolée crue |
| `LINES_WIDE` (`dessus.js:1718`) | 25 | m | Portée du terrain lu pour le tangage sur les lignes (une seule lecture pour toutes les portées) | mesure (pas sur 10 m : à plus de 1° deux fois) | Plus petit : lecture moins sensible au tangage ; plus grand : bruit du MNT |
| `LINE_BIN`, `LINE_FAR`, `LINE_GAP`, `LINE_MIN`, `LINE_FIT` (`dessus.js:1103`) | 1 ; 10 ; 0,25 ; 3 ; 0,04 | m, m, m, tranches, m | Tranche, portée, écart de suivi, tranches minimales par ligne, écart admis à l'ajustement (peintures) | réglage empirique (non documentée plus avant) | Plus strict : moins de lignes retenues, lecture plus sûre ; plus lâche : lignes parasites |
| `EDGE_HALF`, `EDGE_MIN`, `EDGE_FIT` (`dessus.js:1130`) | 5 ; 40 ; 0,06 | colonnes de 2 cm, somme RVB, m | Bords d'enrobé sans peinture : pente de lecture, marche minimale, écart admis | réglage empirique (demande de l'auteur, 13/11/2026 ; valeurs non documentées) | Idem |

### 8.5 Raccords entre photos et position

| Constante (fichier:ligne) | Valeur | Unité | Rôle | Origine | Effet d'une modification |
|---|---|---|---|---|---|
| `SEAM` (`dessus.js:1224`) | 1,5 | m | Demi-zone du raccord où l'ajustement est vérifié | réglage empirique (non documentée plus avant) | Plus large : vérification moins locale |
| `BLOCK`, `SEARCH`, `BLOCK_STEP` (`dessus.js:1225`) | 48 ; 40 ; 20 | px de 3 cm | Côté d'un bloc, recherche de part et d'autre, pas des blocs | réglage empirique (essai du 07/11/2026, 38 raccords de route et 14 en ville) | Recherche plus grande : décalages plus grands retrouvés, plus de faux pics |
| `JOIN_REACH` (`dessus.js:1226`) | 11 | m | Portée au-delà de laquelle une photo est trop floue pour s'y fier | réglage empirique (non documentée plus avant) | Plus grand : sol flou utilisé dans les raccords |
| `JOIN_GOOD` (`dessus.js:1229`) | 0,05 | m | Écart au raccord après recalage au-delà duquel le recalage n'est pas appliqué | mesure (courbe serrée du 15/07/2025, 9d92052e : 19,7 → 7,4 cm, mieux sans recalage ; route et ville 2 à 4 cm) | Plus grand : recalages douteux appliqués |
| `JOIN_PRIOR` (`dessus.js:1263`) | σ a priori 0,3 m, 0,3 m, 1°, 1°, 0,005, 1° pour une pénalité de 0,02 | m, m, rad, rad, échelle, rad | Poids a priori de chaque terme de la pose relative d'une voisine (décalages, tangage, lacet, échelle, roulis) | réglage empirique (a9fd217d, 08/11/2026 : échelle tenue serrée car confondue avec le décalage) | Plus lâche : image tordue au-delà du raccord |
| `JOIN_LIMIT` (`dessus.js:1264`) | 1,2 ; 1,2 ; 3° ; 3° ; 0,06 ; 3° | m, m, rad, rad, échelle, rad | Correction refusée au-delà (1,2 m = portée de la recherche) | mesure (GPS décalé de 1 m le long, D33 du 04/07/2025) | Plus petit : vraies dérives GPS refusées |
| `BEND`, `BEND_SIGMA`, `BEND_PRIOR` (`dessus.js:1233`) | 60 ; 1,2 ; 0,02 | cases, m, poids | Champ de déplacement de la voisine : cases sur la vue, portée, poids d'un déplacement nul | réglage empirique (bc400f2b, 09/11/2026 : axe rompu de quelques cm au bord du masque) | Portée plus grande : champ plus lisse, écarts locaux mal repris |
| `LINE_BAND`, `LINE_SEARCH`, `LINE_WINDOW`, `LINE_PEAK`, `LINE_REACH` (`dessus.js:1456`) | 0,5 ; 0,15 ; 0,4 ; 4 ; 13 | m, m, m, écarts médians, m | Calage des lignes au bord du masque du véhicule : bande lue, recherche, fenêtre, seuil de pic, portée | réglage empirique (idée de l'auteur, 09/11/2026 ; `LINE_REACH` : le bord du masque d'un côté n'est vu que par la voisine à 10 m, bc400f2b) | Idem |
| `ALONG`, `SIDE`, `GRID`, `CAR_GAP`, `ROAD` (`dessus.js:984`) | 12 ; 8 ; 0,05 ; 3,2 ; 6 | m | Repère de la route pour le calage sur l'orthophoto : demi-longueur, demi-largeur, pas, trou du véhicule, demi-chaussée | réglage empirique (non documentée plus avant) | Repère plus large : plus de lignes mais plus de fond |
| `SHIFT_MIN` (`dessus.js:1588`) | 0,3 | m | Écart en deçà duquel la position GPS est gardée (lignes repérées à quelques cm, orthophoto à 20 cm) | donnée du fournisseur (résolution de l'orthophoto : 20 cm) | Plus petit : bruit d'orthophoto pris pour un décalage |

### 8.6 Affichage et mesure

| Constante (fichier:ligne) | Valeur | Unité | Rôle | Origine | Effet d'une modification |
|---|---|---|---|---|---|
| `SURE` (`dessus.js:24`) | 10 | m | Distance au-delà de laquelle la vue est grisée | mesure (0,6° d'inclinaison y déplacent déjà un point de 45 cm) ; choix d'affichage | Plus grand : zone non grisée plus étendue, moins sûre |
| `BEST` (`dessus.js:73`) | 4 en long ; 8 en travers | m | Zone idéale d'une largeur, en face de la caméra (demi-longueur, demi-largeur) | mesure (essai du 08/11 : écart à l'orthophoto ≤ 1,5 % jusqu'à 4 m en long, 2 % au-delà) | Plus grand : mesures conseillées moins précises |
| `SHADE` (`dessus.js:70`) | 3 | facteur | Facteur d'erreur attendue des voisines près de leur propre véhicule (ombre et reflets) | réglage empirique (ville d946f2cf, 09/11/2026 : taches sombres sinon) | Plus petit : taches sombres ; plus grand : sol de voisines évité trop tôt |
| `CAR` (`dessus.js:66`) | long 5,8 ; large 2,9 ; avant 0 | m | Ellipse au sol du véhicule inconnu (toit, capot, reflets) | réglage empirique (ancienne ellipse ±4,5 × ±2,5 m, reflets jusqu'à ±5,8 × ±2,9 m) | Plus grande : sol caché plus loin du véhicule |
| `OUTLINES`, `EITHER`, `LOWEST` (`dessus.js:36`, 56-57) | tableau d'élévations par colonne, tous les 2,8° | degré | Contour du véhicule dans le panorama par monture (marge de 1,5° comprise) | mesure (relevé à la main du 09/11/2026 sur la médiane de 16 photos d'une séquence, `shortcut` : à refaire si la monture ou le véhicule change) | Contour trop bas : carrosserie visible ; trop haut : sol sacrifié |
| `OUTLINE_PHOTOS`, `OUTLINE_BAND`, `OUTLINE_EDGE`, `OUTLINE_FLOOR`, `OUTLINE_MARGIN` (`dessus.js:64`) | 12 ; 6 ; 0,45 ; −47 ; 1,5 | photos, degré, part, degré, degré | Lecture du contour du véhicule sur la séquence elle-même : nombre de photos, bande autour du contour relevé, seuil de bord, plancher (logo du CD21 à −48,3°), marge | réglage empirique (autre montage du 15/07/2025, 3e222d68) ; `OUTLINE_FLOOR` : mesure (haut du logo à −48,3°) | Plancher trop bas : le logo écrase les bords |
| `SIZE` (`dessus.js:26`) | 1024 | px | Côté de l'image des calculs (hauteur, raccords, position), 3 cm par pixel | choix technique (compromis vitesse et finesse) | Plus grand : calculs plus fins mais plus longs |
| `SHOWN_SIZE`, `FINE_SIZE` (`dessus.js:29`) | 2048 ; 4096 | px | Côté de l'image affichée (1,5 cm par pixel) et de la « Haute résolution » (0,7 cm) | choix d'affichage (zoom 24 de la carte) | Plus grand : plus de mémoire graphique |
| `LOW`, `LOW_SIGMA`, `FILL_SIGMA` (`dessus.js:749`) | 256 ; 1 ; 3 | px, m, m | Raccord fondu : bande basse des voisines, flou, étendue sous le véhicule | réglage empirique (non documentée plus avant) | Flou plus grand : teinte moins locale |
| `CLOSE_PX` (`dessus.js:1587`) | 10 | px | Clic à cette distance d'un sommet = surface refermée | choix d'affichage | Interface seulement |

### 8.7 Techniques (sans effet sur la géométrie)

Sans enjeu pour une mesure, non détaillées : `NEAR_LIMIT` (`dessus.js:71`, largeur des photos voisines, 6144 px, mémoire
graphique), `WGS84_A` et `WGS84_E2` (`dessus.js:22`, ellipsoïde des positions GPS, identiques à `py/core/triangulation.py`),
`ELEVATION_URL`, `LIDAR_RESOURCE`, `ORTHO_URL`, `ORTHO_LAYER`, `*_KEY` (clés `localStorage`), `IMAGE_ID`, `LINE_ID`,
`DEFAULT_ROLL`, `DEFAULT_PITCH`, et, côté Python, `TIMEOUT_MS`, `SPACING` et `RETRIES` (`web_host.py`, cadence des
requêtes), `RELAY_*` (recherche de photos de référence, sans effet sur la projection).
