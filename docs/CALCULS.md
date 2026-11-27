<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Calculs des mesures

Ce document explique, mode par mode, comment l'application calcule ce qu'elle affiche, avec
les seuils retenus et ce qui limite la précision. Le mode d'emploi est dans le
[guide](GUIDE.md) (« Utilisation »), et les essais chiffrés dans sa partie « Précision ».
Les calculs communs avec le plugin QGIS (triangulation, inclinaison, vérification RTK) sont
détaillés dans [`MESURES.md`](MESURES.md) (repris du plugin Visionneuse Panoramax), sections 0, 2.7,
4.4 et 6.1 bis. Ici, ils sont résumés. Les calculs propres à l'application (pont, « Profils »,
analyse fine, relevé, compteurs de la vidéo) sont décrits en entier.

Code : cœur de calcul dans `py/core/` (tests : `tests/coeur/`), calculs propres à
l'application dans `py/web_app.py` (chutes et dévers : `py/web_chutes.py`), analyse fine du nuage dans `src/nuage.js`, dessin du profil
dans `src/profil.js`, vidéo du parcours dans `src/video.js` (dévers de la vidéo : `readDevers` dans
`src/parcours.js`).

## 1. Ce qui sert à tous les modes

Les calculs se font en mètres dans un **plan tangent local** (est, nord) autour d'une photo ou
d'un point. Le passage des degrés GPS aux mètres suit l'**ellipsoïde WGS 84** : rayon du
parallèle vers l'est, rayon de courbure du méridien vers le nord, à la latitude du point
(`_local`, `_geographic` de `core/triangulation.py`, `toLocal`, `toLonLat` de `src/dessus.js`).
Jusqu'au 14/11/2026, une sphère de 6 371 km faussait les longueurs de 0,3 % en est-ouest et de
0,05 % en nord-sud vers 47° N (3 cm sur une largeur de 10 m) ; la vue du dessus était étirée
d'autant en est-ouest sur la carte.

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
déplace d'environ 37 cm un point au sol à 6 m. L'inclinaison automatique est calculée en
arrière-plan à l'activation de « Mesure » pour la photo affichée, puis au premier clic sur une
autre photo (`App.set_active`, `_check_tilt`) ; la vue du dessus et la largeur dans la
visionneuse la lancent à l'affichage (`birdeye_request`).

**Un seul ordre de priorité**, défini à un endroit, `Calibration.tilt` (`py/core/calibration.py`),
pour les mesures (hauteur, relevé, visées) comme pour la largeur dans la visionneuse
(§ 8.8). Les sources propres à la page (rangs 1, 5 et 6) sont fournies par `App`
(`_ground_tilt`, `_loose_tilt`, `_campaign_tilt`, `py/web_pose.py`) et rangées par les crochets
`ground_tilt`, `loose_tilt`, `campaign_tilt` de `Calibration` :

1. **réglage de la vue du dessus pour cette photo** (`birdeye_ground`, `App.birdeye_tilt_set` :
   tangage et roulis réglés ou calés sur la route dans la vue du dessus ; elle ne l'annonce que
   si elle ne lit pas les verticales de la photo). Il contient déjà le roulis par défaut de la campagne 2025 : il
   n'est pas ajouté une seconde fois. Source « vue du dessus » ou « vue du dessus (réglée à la
   main) » ;
2. **calage à la main** : pied et sommet de deux objets verticaux à environ 90° l'un de l'autre
   (« clics »). Avec un seul objet, il est complété par la source suivante de la liste (« clics +
   verticales », « clics + lidar », « clics + verticales (seuil élargi) » ou « clics + roulis de
   campagne ») ;
3. **verticales de la photo** : arêtes verticales (façades, poteaux) repérées entre 3 et 45°
   au-dessus de l'horizon, puis moindres carrés avec rejet des arêtes penchées. Le résultat est
   retenu avec 40 segments au moins et une incertitude sous 0,25° (±0,05 à 0,25°)  ;
   **indicateurs de qualité** (`autotilt.fit`, sans effet sur l'estimation ni sur les refus ; ticket #66) : `edges` (arêtes
   distinctes : pieds regroupés en grappes de 1,5° au plus (`EDGE_MERGE`), distinct du compte à 0,3° du σ), `gap` (plus grand secteur d'azimut sans arête, degrés), `sigma_pitch` et `sigma_roll`
   (incertitude par axe : covariance σ²·A⁻¹ de la verticale, avec le facteur √(segments/arêtes) du σ global, projetée sur les
   axes de `calibration.tilt_components` : avant (sin h, cos h), droite (cos h, −sin h), h = cap de la photo ; des arêtes
   seulement devant et derrière contraignent le roulis, pas le tangage), et `fragile` avec sa raison : secteur sans arête
   au-delà de 150° (« verticales d'un seul côté »), moins de 8 arêtes (« peu d'arêtes distinctes »), ou incertitude par
   axe au-delà de 0,15° (« incertitude élevée sur le tangage / le roulis »). Seuils `FRAGILE_GAP`, `FRAGILE_EDGES`,
   `FRAGILE_SIGMA` : provisoires, à caler sur des photos de référence. Gardés avec les verticales de la photo (absents des
   anciennes entrées : affichage inchangé) et renvoyés aussi au seuil élargi ;
4. **LiDAR sous le véhicule** (pente et dévers du MNT LiDAR HD, plus le décalage de la fixation
   appris sur la séquence, § 6.1 bis de `docs/MESURES.md`) ; ou, option expérimentale quand les
   verticales manquent, **terrain hors agglomération** : pente et dévers du MNT LiDAR HD sous la
   caméra (grille de ±2,5 m × ±1,5 m, 55 points), plus le décalage de la fixation appris sur des
   photos de village de la même séquence, calées par leurs verticales (3 au plus, 12 analysées
   au plus). Précision environ ±0,6° ;
   **Photo sur un pont** (depuis le 22/11/2026) : le LiDAR décrit le sol sous l'ouvrage, pas le tablier. La photo est marquée à son
   ouverture, même hors mesure (`Session._mark_bridge`, BD TOPO `roads.on_bridge`, `Calibration.bridge_pics`, enregistré avec le
   calage) : son LiDAR (brut, modèle de la séquence et option « terrain hors agglomération ») n'est jamais retenu au rang 4, et elle
   n'entre pas dans le modèle LiDAR de sa séquence (`Calibration.lidar_model` : son écart verticales − LiDAR serait aberrant). Ses
   verticales (rangs 2, 3, 5) restent valables ; sans elles, la chaîne passe aux rangs 5 et 6, ou à rien. Auparavant, seul le mode
   « sur un pont » de la mesure (`set_bridge`, proposé en mesure seulement) écartait le LiDAR : une photo regardée hors mesure gardait
   un tangage LiDAR de +3° sur le tablier (2eed13c0-cb03-437f-9752-2f3b6b0d0478, 7dcdccf9-3c52-4c54-bc5b-de72740a7967) ;
5. **verticales à seuil élargi** (`birdeye_loose`, source « verticales (seuil élargi) ») : les
   verticales de la photo, refusées pour les mesures parce que leur incertitude dépasse
   `autotilt.MAX_SIGMA`, mais à `web_tilt.LOOSE_SIGMA` (0,5°) près. Gardées, avec leur
   incertitude, et affichées (« seuil élargi ») : mieux que rien. Auparavant la largeur dans la
   visionneuse les préférait au LiDAR quand leur incertitude était plus faible ; elles passent
   maintenant après lui ;
6. **roulis par défaut seul** (`_roll_default` de `py/web_pose.py`, source « roulis de campagne » en interne), en degrés, véhicule penché à droite
   positif : **défaut de campagne** (champ `roll` du profil de campagne daté, `py/web_profils.py`, par exemple +1° pour le CD21 en 2025) **moins la part du dévers**, `−atan(ROLL_SHARE · tan(dévers))`
   avec `ROLL_SHARE` = 0,7 et le dévers du LiDAR HD sous la photo (`auto[pic]["lidar"][1]`, positif : droite plus haute ; route qui monte vers la
   droite : véhicule penché à gauche, roulis négatif, comme `groundUp`). Le dévers n'est pris que si le sol vient du LiDAR HD (`lidar_source`
   de l'entrée `auto`, pas RGE ALTI ni une entrée sans source) et que la photo n'est pas sur un pont ; sinon le défaut de campagne seul. S'applique aussi
   en ville et hors campagne (défaut 0 : la part du dévers seule) ; rien (rang 7) si le roulis par défaut vaut 0 sans dévers. Ce sont les rangs 1 à 5 qui priment :
   jamais de double application du dévers (le LiDAR du rang 4 le contient déjà à 100 %, les verticales le mesurent). La verticale est vue penchée de ce roulis
   vers la gauche du cap (signe changé pour le cœur, voir la convention du roulis ci-dessus), le
   tangage est inconnu ; incertitude de tangage `UNCALIBRATED` (2°), au moins celle du roulis
   (champ `roll_sigma` du profil, ±1° d'une photo à l'autre ; `ROLL_SIGMA_DEFAULT` sans profil). **Tangage de la campagne** (depuis le 27/11/2026) : au lieu d'un tangage nul,
   le rang 6 donne le tangage du profil (`pitch`, `pitch_sigma`, `_pitch_default` de `py/web_pose.py`, 0 sans profil ; degrés, positif : caméra relevée vers l'avant par
   rapport à la route, comme la réglette de la vue du dessus) : CD21 monture basse (2025 et 2026) +0,7 ± 0,3°, monture haute +0,2 ± 0,3°. La pente de la route n'est pas lue à ce rang :
   l'incertitude de tangage reste `UNCALIBRATED` (au moins `pitch_sigma`). Sans profil, rien ne change. Ce tangage n'est **jamais ajouté** à un tangage lu (rangs 1 à 5 :
   raccords, verticales, clics, LiDAR du rang 4, qui contient déjà le décalage de fixation appris sur la séquence, réglage à la main). Mire des flèches de rabattement thermocollées
   (27/11/2026, 17 photos de 8 flèches, cote IISR 6,00 m) : avec un tangage lu sur les raccords ou les verticales la flèche sort à 6,00 ± 0,1 m ; sans tangage lu (route seule),
   il manquait +0,7° (+0,65, +0,69, +0,83° sur 3 photos). Ce n'est pas une inclinaison calée : le
   voyant « Inclinaison » reste rouge ou jaune et la ligne d'état dit « roulis par défaut (70 % du dévers + campagne 2025), tangage inconnu » (ou, avec un profil qui donne un tangage, « … tangage +0,7° de la campagne (profil, ±0,3°) » ; ou « … (70 % du dévers) » hors campagne, ou « … de la campagne 2025 seul (dévers
   écarté : photo sur un pont, terrain RGE ALTI…) »). Le défaut de campagne 2025 a été estimé avec 70 % du dévers : il reste valable ;
7. **rien** : photo non inclinée, incertitude `UNCALIBRATED` (2°).

**Convention du roulis** : dans l'application (`src/dessus.js`, profils de campagne, panneau de calage, lignes d'état, encart de la droite), le roulis du
véhicule est positif quand il est penché à **droite** (côté droit plus bas, vu dans le sens de la marche), négatif à gauche. Le cœur
(`Calibration.tilt_components`, `up_from_components`, `d_roll`, repris du plugin QGIS) a la convention d'une rotation de caméra, opposée :
positif quand la verticale vraie paraît penchée vers la droite, soit la caméra penchée à gauche. Le signe est changé en un seul endroit,
`roulis_vehicule_depuis_camera` (`py/web_pose.py`, sa propre inverse), appliqué aux frontières : roulis rendu au panneau de calage et
écart `d_roll` de la confiance (cœur vers véhicule), défaut de la campagne donné au cœur par le rang 6 (véhicule vers cœur). Le calcul
de la route de `groundUp` (`src/dessus.js`) est écrit dans la convention du véhicule : une route qui monte vers la droite penche le
véhicule à gauche (roulis dû au dévers négatif).

La vue du dessus lit, pour ses propres calculs, ce que la photo donne elle-même
(`Calibration.tilt(pic, photo_only=True)` : rangs 2 à 4) : elle ajoute elle-même le roulis de
campagne et ne relit pas son propre réglage.

Quand l'inclinaison change (automatique arrivée, verticales à seuil élargi arrivées, réglage de
la vue du dessus modifié), tout est recalculé : une mesure peut changer d'elle-même une ou
deux secondes après.

**Calcul automatique écarté** (`Calibration.auto_off`, « Réinitialiser » du panneau « Calage manuel ») : pour une photo, les rangs 3
(verticales de la photo) et 5 (verticales à seuil élargi) sont sautés, le rang 4 (LiDAR, qui reste valable) puis le roulis par défaut de la campagne 2025
prennent le relais ; les verticales à la main (rang 2) et la vue du dessus (rang 1) ne changent pas. Gardé avec le calage (`auto_off`,
liste de photos), repris par l'import et la fusion. Les verticales à la main complètes (au moins deux objets non alignés) passent déjà
devant le calcul automatique ; une seule verticale le complète (« clics + verticales »).

**Jugement des verticales tracées à la main** (`calibration.vertical_report`, panneau « Calage manuel », docs/GUIDE.md) : un
écart automatique ne s'applique à aucune mesure, il sert seulement à signaler (et, sur demande, à retirer) les verticales qui
contredisent les autres. Chaque verticale définit un plan (caméra, pied, sommet) qui doit contenir la verticale vraie ; son écart
est l'angle entre ce plan et un *consensus* : la meilleure verticale vraie tirée d'une paire de verticales (somme des écarts tronqués
à 3 × 0,3°), réajustée sur les verticales qui s'y accordent. L'écart à l'inclinaison de toutes les verticales serait trompeur : une
verticale fausse la tire vers elle et fait paraître fausses les bonnes (essai à 5 verticales dont une de 3° : avec elle, les bonnes
s'écartent de 1,4 à 2,4° ; avec le consensus, de 0°). Échelle = max(0,3°, 1,4826 × médiane des écarts) ; douteuse au-delà de 2
échelles, aberrante au-delà de 3 (constantes `JUDGE_FLOOR`, `DOUBT_FACTOR`, `OUTLIER_FACTOR`). Jugement à partir de 3 verticales (la
plus éloignée seule peut être douteuse), complet à 4 (`JUDGE_MIN`). L'effet d'une verticale est l'angle entre l'inclinaison avec et
sans elle.

**Confiance de l'inclinaison** (`Calibration.tilt_sources`, `tilt_confidence`, `Calibration.confidence` ; 22/11/2026). Une
inclinaison n'est sûre que si une source indépendante la retrouve. Seules deux familles le sont : **image** (verticales à la
main, verticales automatiques, verticales à seuil élargi) et **terrain** (LiDAR HD par le modèle de la séquence, route de la
vue du dessus = LiDAR + 0,7 × dévers + défaut de campagne). Le LiDAR brut n'est pas un témoin (sans le décalage de monture
appris sur la séquence) ; le roulis par défaut de la campagne 2025 est une constante, pas un témoin (famille « constante » ; « mixte » : clics
complétés par le terrain, aucun témoin). `tilt_sources(pic, heading)` rend toutes les sources disponibles de la photo (nom,
famille, `up`, `sigma`, tangage et roulis), pas seulement la retenue. Le **LiDAR modèle est calculé sans la photo** (leave-one-out :
`lidar_model` des autres photos de la séquence) : avec elle, son décalage verticales − LiDAR contiendrait ses propres verticales
et les redonnerait, sans les vérifier. La route est celle que la vue du dessus annonce (`birdeye_tilt_set`, champ `route`),
**même quand les verticales priment** (src/dessus.js, `announceTilt`) ; sans vue du dessus ouverte sur la photo, elle manque.
`tilt_confidence(sources, retained, bridge)` (fonction pure) compare la source retenue au meilleur témoin (plus petite
incertitude) de l'AUTRE famille : accord si |Δtangage| ≤ min(1,0°, max(0,5°, 2·√(σ₁² + σ₂²))) ET |Δroulis| ≤ min(1,2°, max(0,7°,
2·√(σ₁² + σ₂²))) (`TILT_AGREE_PITCH`, `TILT_AGREE_ROLL`, `TILT_AGREE_K`, plafonds `TILT_AGREE_PITCH_MAX`, `TILT_AGREE_ROLL_MAX` : au-delà,
l'accord ne garantit plus une mesure utile ; sans eux, la route à ±1° ouvrirait le seuil à 2° ; planchers d'après l'étude de 33 photos : écart médian image/terrain 0,2 à
0,3° en tangage, 0,33 à 0,37° en roulis, au plus 1,07° et 3,08°). États : `confirmee`, `desaccord`, `non_verifiable` (une seule
famille, ou seulement une constante), `pont` (photo de `bridge_pics` : état propre même avec des verticales, le terrain y
décrivant le sol sous l'ouvrage). Hôte : `App.tilt_confidence_of`, recalculée à chaque changement d'inclinaison ; chaque mesure
garde l'état de la photo de son premier clic (`m.confiance`), refait si l'inclinaison de cette photo change. Limites : une mesure
sur plusieurs photos ne garde que l'état de la première ; la route manque tant que la vue du dessus n'a pas calé la photo ; un
accord prouve la cohérence de deux sources, pas leur exactitude.

### 1.4 Terrain

**MNT LiDAR HD** de l'IGN (sol nu à 50 cm, ±0,1 m ; ponts et ouvrages retirés), sinon
**RGE ALTI** (1 m, ±0,4 m) là où il n'est pas encore publié. Les altitudes d'un même calcul
viennent toutes de la même source : lues par paquets de 160 points, elles sont toutes relues en
RGE ALTI dès qu'un paquet a dû y passer (un point manquant en LiDAR HD). Le MNT sert à vérifier la position
(§ 1.2), à l'inclinaison (§ 1.3), à fixer l'altitude d'un point au sol triangulé en 3D (§ 2) et à
tous les profils (§ 7 à 9). Les tronçons de route, ponts, cours d'eau et zones d'habitation
viennent de la **BD TOPO** (WFS de la Géoplateforme).

### 1.5 Profils de campagne datés (#70)

Ce que l'on sait d'une campagne de prise de vue vit dans une table unique, `CAMPAIGN_PROFILES` (`py/web_profils.py`), une fiche par
producteur, véhicule, caméra et période : `id`, `label` (nom court affiché), `producer`, `vehicle`, `camera`, `first` (premier jour
inclus), `end` (jour de fin exclu), `height` et `height_sigma` (hauteur de caméra, m), `roll` et `roll_sigma` (défaut de roulis et
dispersion, degrés ; positif : véhicule penché à droite), `pitch` et `pitch_sigma` (tangage, `None` : inconnu), `method` et
`provenance` (comment les valeurs ont été obtenues). `profile_of(item)` donne le premier profil dont le producteur figure dans les
fournisseurs (`providers`) de la photo et dont la période contient sa date de prise de vue (la date seule, sans l'heure) ; `None`
sinon. Le profil s'applique tout seul, sans choix : hauteur de la monture (`_fleet_mount`, `_mount_height`), défaut de roulis
(`_roll_defect`, § 1.3 rang 6) et son incertitude (`_campaign_tilt`), libellé du roulis par défaut (`_roll_label`, l'année vient de
`first`). `check_profiles` (champ manquant, `first` non antérieur à `end`, chevauchement de deux périodes d'un même producteur) est
exécuté à l'import du module : une table invalide empêche le chargement. Sans profil : hauteur et roulis de campagne inchangés
(réglage, 0°, incertitude `ROLL_SIGMA_DEFAULT` de 1°). Le profil appliqué est dit dans l'étiquette de la vue du dessus
(« Profil : … (du 24/06/2025 au 31/12/2025) »), dans le panneau de calage (« Profil : … ») et dans la colonne `profil` de l'export.
Trois fiches aujourd'hui : CD21 2025 Clio 5, monture basse (du 01/01 au 23/06/2025, 1,93 m ±0,04, roulis +1,0° ±1,0), monture
haute (du 24/06 au 31/12/2025, 2,07 m ±0,04, roulis +1,0° ±1,0) et CD21 2026, monture basse (probable) (du 01/01 au 11/06/2026, fin
exclue au 12/06 : seul le 11/06/2026 est observé, séquence 7d66f208-acb4-46f6-bb23-65d8717557a7 ; 1,93 m ±0,05, roulis +1,0° ±1,0
repris de 2025, non mesuré en 2026 ; véhicule inconnu ; à étendre quand d'autres séquences 2026 seront publiées). Le montage
(ventouses pour la monture basse, barres de toit pour la haute) n'est qu'une hypothèse, sans certitude (auteur), notée dans la
provenance. Les montures possibles du CD21 hors campagne connue (`pose.mounts`) sont les hauteurs distinctes des fiches du producteur
(1,93 et 2,07 m, sans doublon) ; l'incertitude de la monture (`pose.mount_sigma`) est celle de la fiche de la photo (±0,04 m en 2025, ±0,05 m en 2026) ; hors campagne connue, `fleet_height_sigma`, la plus grande des fiches du producteur (±0,05 m).

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

## 4. Largeur perpendiculaire à la chaussée (retirée)

Mode retiré le 21/11/2026 (droite de mesure perpendiculaire à l'axe de la route, bord opposé cliqué ou
triangulé, option « Droite de mesure tracée sur la carte »). La largeur se mesure par le bouton ↔ de la
visionneuse (§ 8.8). La numérotation des sections est gardée.

## 5. Mesure libre (retirée)

Distance horizontale entre deux points triangulés successifs : retirée le 20/11/2026, remplacée par
la mesure sur la carte (longueur et surface). La triangulation (§ 2) reste celle des hauteurs
et du relevé d'objets.

## 6. Relevé d'objets

Chaque objet est placé d'une de ces trois façons :

- **triangulé** (§ 2) : la façon normale ;
- **sur une seule photo** (« Garder sur cette seule photo ») : là où la visée touche le sol,
  supposé plat à la hauteur de caméra sous la photo (calée, sinon monture du CD21 d'après la date, sinon
  altitude RTK moins sol LiDAR, sinon le réglage : `Session.camera_of`, ordre unique depuis le 27/11/2026, #59 : l'écart RTK − sol n'est qu'une
  borne, il saute aussi à la rupture de monture du 24/06/2025, 1,93 → 2,11 m, et surestime d'environ 5 cm la hauteur après elle, avec
  10 cm de dispersion ; l'incertitude de la visée suit la source : `camera_of`). Les mesures qui dépendent de la hauteur de caméra (`MeasureTool.camera_full`, par le crochet `Session._click_camera`) et le profil en long (`etat.cameraUsed`) prennent la même hauteur, pour la photo de chacun de leurs clics ; le réglage n'est lu qu'en dernier rang (source `None`, champ actif), sinon grisé. La visée doit descendre d'au moins 2° sous
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
du terrain. L'écart moyen d'une feuille aux raccords avec ses voisines (`dst_raccor`, qualité du
géoréférencement de la BD Parcellaire) vaut 1,5 m en médiane en Côte-d'Or, et plus de 5,8 m pour un
quart des feuilles. Les feuilles au-delà de 2 m étaient cernées de tirets sur la carte jusqu'au
15/11/2026 : retirées, à la demande de l'auteur.

La projection dans la photo a été essayée puis abandonnée (30/10/2026). À Pouilly-en-Auxois, la
limite apparaissait au-dessus du sol au pied des façades. Trois causes y concourent : le plan du
cadastre (0,46 m de décalage avec les bâtiments de la BD TOPO), le sol interpolé sous les
bâtiments (0,8 m plus bas que le trottoir) et l'inclinaison de la photo, calculée alors seulement au
premier clic (depuis le 20/11/2026 : à l'activation de « Mesure » pour la photo affichée).

## 7. Hauteur de chute sur un pont

**Mode « sur un pont » automatique** (depuis le 20/11/2026, plus de case ni de question). Critère « sur le pont » (`roads.on_bridge`) : un tronçon
de la BD TOPO de niveau supérieur à 0 (franchissement) à 8 m au plus de la photo (demi-chaussée et précision GPS), et, l'axe de la séquence
étant connu, orienté dans son sens à 30° près (une photo prise dessous, sur la voie franchie, n'est pas dessus ; un chemin parallèle à plus de 8 m non
plus). En mesure, ce critère active le mode (`set_bridge(True)` : sol tiré des photos au lieu du modèle de terrain, inclinaison sans la pente du
terrain), dit « sur un pont (détecté) » dans la ligne « Position ». Sortie : photo à plus de 30 m (`roads.BRIDGE_LEFT`) de tout tronçon en pont (les
photos d'approche visent encore le tablier : pas de bascule avant). Les tronçons sont lus par le réseau (WFS) : le critère est réévalué à chaque
rafraîchissement, donc à leur arrivée. Un pont seulement proche n'active pas ce mode. La vue du dessus a son propre critère, plus large, pour le modèle de sol seulement (depuis le 26/11/2026) : pont à 15 m au plus à vol d'oiseau (`roads.BRIDGE_FLAT_RADIUS`, `roads.flat_ground`, distance au tablier le plus proche, tout sens), sol supposé plat à la hauteur de caméra au lieu du relief ; voir § Vue du dessus.

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
  caméra est celle **calée** pour la séquence, sinon pour une photo du CD21 la **monture d'après la date** (1,93 m jusqu'au
  23/06/2025, 2,07 m ensuite, ±4 cm, profil de campagne de `py/web_profils.py`, comme la vue du dessus), sinon celle **mesurée sur la
  séquence** vérifiée (médiane de l'altitude RTK moins le sol LiDAR, photos du pont écartées : une borne, voir § 6). Une photo de précision
  déclarée n'a que sa propre hauteur, prise au-dessus du sol sous elle : sur un pont, le fond
  franchi. Le réglage « Hauteur de caméra » ne sert alors que si l'utilisateur l'accepte (bouton de
  l'encadré du pont).
- **Dessous** : MNT lu en travers du pont, un point tous les 0,5 m depuis l'axe BD TOPO, et pris à
  1, 3, 6 et 10 m au-delà du **bord du tablier**, des deux côtés. Ce bord se lit dans la couche
  LiDAR : quand le MNT contient le tablier (classé sol dans le nuage : petits ponts, comme la D114
  sur le ruisseau de la Gironde, photo e375c98e-31c5-426a-ba93-c63ac344d675), le terrain sous
  l'axe est au niveau du tablier (0,5 m près) et le bord se trouve comme celui d'une route (§ 8.2) ;
  sinon (MNT au fond franchi), demi-largeur type de la route (§ 8.2), jamais la largeur BD TOPO,
  qui n'est pas fiable. Un travers tous les 2 m le long du pont (plus espacé sur un long pont),
  6 requêtes au plus. Sous un tablier absent du MNT, celui-ci est interpolé à sa hauteur : le
  fond se lit à l'écart. Le terrain lu à 1 m seulement tombait sur le talus de la culée. Avec des
  points classés pont, le calcul par le nuage (ci-dessus) passe avant et lit le tablier lui-même.
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

Ce calcul se lance d'un appui sur le bouton « Profil en travers » de la visionneuse, sur une photo hors pont, à moins de 15 m
d'une route de la BD TOPO. Il ne dépend pas de l'altitude GPS et n'a donc pas besoin du RTK.

### 8.1 Profils lus

La route est celle du tronçon BD TOPO au sol le plus proche parmi ceux orientés comme la route
parcourue, à 45° près (sens de la trajectoire de la caméra au droit de la photo, sinon son cap) :
à un carrefour, la voie qui croise peut passer plus près. Elle est prolongée par les tronçons voisins de même
nom (lus jusqu'à 60 m autour de la photo, mailles voisines comprises). Le MNT est lu en travers à
**−10, −5, 0, +5 et +10 m** de la photo le long de la route, des deux côtés. Les travers partent
de la caméra (séquence vérifiée RTK), sinon de l'axe BD TOPO. Un point est lu tous les **0,5 m**
jusqu'où la chute peut être lue (réglette de 2 à 30 m, 10 m par défaut, plus la moitié de la zone de recherche du
bord, 3 m au-delà du bord type, § ci-dessous) ; avant le 20/11/2026, 16 points seulement au-delà de la zone de
recherche, espacés de 1,9 m à 30 m. Chute, dévers et graphique s'arrêtent à la distance de la réglette du
milieu de la chaussée (entre les deux bords du travers), 1 m au moins au-delà du bord (choix de l'auteur,
20/11/2026 : ce qui est dessiné est ce qui est mesuré).

### 8.2 Bord de la chaussée

Sur chaque travers, à 1,5 m au moins de l'origine, le bord est le premier point :

- où la pente sur 1 m s'écarte de plus de **8 points** de celle de la chaussée sous l'origine,
  dans le même sens, sur **trois pas de suite** (fossé, talus). Un seul pas tiendrait du bruit
  du MNT (±5 cm), et le bombement fait environ 5 points ;
- ou à une **marche** de 5 cm ou plus sur 0,5 m qui tient sur 1,5 m (bordure, accotement plus
  bas).

La pente sur 1 m voit la rupture jusqu'à 1 m avant elle : le bord avance d'un pas (0,5 m) si la
pente de ce pas est encore celle de la chaussée (8 points près). C'est le dernier point de la
chaussée ; avant, le bord tombait 0,5 m trop tôt (jusqu'à 0,9 m), la plateforme était donc trop
étroite d'environ 1 m (terrain synthétique, `BordsTalus`).

Depuis la caméra (séquence RTK), la recherche du bord du côté opposé à sa voie franchit l'axe : le
sommet du bombement, ou le changement de dévers d'une voie à l'autre, y fait une rupture de pente.
Une rupture ou une marche à **1,25 m** au plus de l'axe BD TOPO, suivie d'une pente de chaussée
(10 % au plus, qui tient à 8 points près sur **1,5 m**), est prise pour lui : la pente qui suit
devient la référence et la recherche continue, 3 m plus loin que d'ordinaire (chaussées souvent
plus larges que leur type), au pas de 0,5 m ; une marche n'y compte que si elle est plus nette que les
pas voisins (moins de la moitié de son saut : une pente soutenue de plus de 10 % ou un défaut de
la chaussée font aussi 5 cm par pas). Sans autre rupture ensuite, le bord est cette première
rupture. Seulement sur une chaussée de 4 m au moins de largeur type (deux voies possibles). Sur 61 côtés
de 42 photos réparties en Côte-d'Or, comparés au bord d'enrobé de l'analyse fine, 28 bords
tombaient sur l'enrobé, 25 depuis, sans aucun côté dégradé (`BordsBombement`).

Sans rupture de pente (accotement de plain-pied), le bord est à la demi-**largeur type** de la
catégorie de la route (importance BD TOPO) : 7 m (importance 1 et 2), 6 m (3), 5,5 m (4), 3,5 m
(5), 7 m par chaussée d'une route à chaussées séparées, 6 m sinon. La largeur de chaussée de la
BD TOPO n'est pas fiable : une valeur par catégorie, trop faible (7 m en importance 2 pour 7,6 à
17,3 m d'enrobé mesurés par l'analyse fine, 5,5 m en 3 pour 5,4 à 9,7 m, 4 m en 4 pour 3,7 à
11 m ; 42 photos de Côte-d'Or) ; les médianes mesurées (9 m en 1-2, 6,5 m en 3, 6 m en 4) comptaient à tort trottoirs et gravier (P21) : le 20/11/2026,
valeurs prudentes choisies par l'auteur, à refaire sur des largeurs vérifiées à la main. Ce bord
reste une hypothèse : « largeur type » sur le graphique. Dès que 3 travers au moins d'un côté trouvent leur bord dans le relief, leur
**médiane** (basse : le bord le plus proche) sert aux autres : un travers sans rupture de pente, ou
dont le bord est à plus de **3 m** d'elle, y est ramené. Ce bord est dit « d'après les travers
voisins » (graphique, infobulle) : il n'a pas été trouvé dans le relief de ce travers.

### 8.3 Chaussées séparées et séparateur

L'autre chaussée est reconnue à son tronçon BD TOPO : même nom, au sol, parallèle (à 30° près), son axe
à 4 à 40 m en travers et en face du point, pas au bout d'un tronçon décalé. De ce côté, le bord
est cherché au-delà de son axe et jusqu'à 9 m au-delà de son bord type (7 m par chaussée). La pente de référence est prise sous cet axe. La plateforme
comprend le séparateur et l'autre chaussée.

Le **séparateur de chaussée** est cherché :

1. entre deux **marches** de sens contraires (surélevé : montée puis descente ; en creux :
   l'inverse), large de 0,5 à 10 m, son milieu à 4 m au plus de celui que donnent les largeurs
   types, et recoupé d'un travers à l'autre (médiane, 3 m) ;
2. à défaut, à une **bosse étroite** (1 ou 2 points, 4 cm au-dessus des voisins) au même endroit
   sur deux travers au moins : l'assise de glissières dos à dos ou d'un muret, que le MNT ne garde
   pas ;
3. sinon d'après la **BD TOPO** (milieu entre les deux chaussées, de largeur type).

Le profil dit d'où il vient : « (relief) », « (BD TOPO) » ou « (nuage LiDAR) » (§ 10).

### 8.4 Chute et dévers

- **Chute** : la plus grande descente entre le terrain au bord de la chaussée et le point le
  plus bas du profil. La distance donnée est celle du point le plus bas le plus proche du bord, à
  5 cm près. La lecture s'arrête là où le terrain remonte de **1 m** au-dessus du bord (talus,
  butte) : ce qu'il y a derrière n'est pas une chute. Si le point le plus bas est au bout du
  profil, la valeur est « chute ≥ … » : pousser la réglette. Un côté est affiché s'il descend de
  0,5 m au moins.
  Prise au plus bas, elle est majorée par le bruit du MNT : 3 à 4 cm au bruit mesuré sur chaussée
  (moins de 1 cm d'un point au suivant), 6 cm à 2 cm de bruit (fossé synthétique de 1 m, 200 tirages),
  sous l'incertitude affichée. Le plus bas est gardé : c'est le cas le plus défavorable.
- **Dévers** : pente moyenne du talus le plus raide (0,5 m de haut au moins) avant cet arrêt,
  sur les cinq travers, de son haut à son pied (hauteur divisée par largeur), en % et en degrés.
  Le talus est la partie d'une descente (pente lue sur 2 m d'au moins 10 %) dont la pente vaut au
  moins le **tiers** de la plus forte. Cela écarte l'accotement en pente douce au-dessus et la
  queue du pied. Les pentes sur 2 m débordent sur le plat du haut et du fond : le haut avance tant
  que le pas suivant descend de moins de 5 %, le pied est le premier point à **5 cm** du plus bas.
  Sans cela, un talus de 1 m à 50 % se lisait 33 % (terrain synthétique, `BordsTalus` dans
  `tests/test_calculs.py`). Au-delà de **150 %** (56°), le dévers s'écrit « paroi quasi verticale
  (mur, enrochement) », avec sa hauteur et sans pourcentage : le MNT adoucit les parois (un mur de
  2 m y fait 100 à 200 %) et le pas de 0,5 m plafonne la pente lue à 400 % (76°) ; le chiffre serait
  une fausse précision. La chute, elle, reste juste.

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

### 8.8 Largeur dans la visionneuse (expérimental ; ex-« Bords sur la photo »)

Droite au sol tracée dans la photo (`App.nose_line`, `py/web_nez.py`), que l'utilisateur ajuste aux bords (`src/nez.js`).
- **Droite** : centre à `d` m devant la caméra sur son axe (cap entre les photos voisines, sinon cap de la photo), orientée
  perpendiculairement à la direction du trajet *à cet endroit* : interpolation angulaire (écart ramené à ±180°) entre l'axe à la photo
  (θ0) et l'axe à la photo suivante (θ1), θ = θ0 + t·(θ1 − θ0), t = `d` / distance entre les deux photos (bornée à [0, 1]). θ1 vient de
  la seule photo suivante : sur un arc de cercle, l'axe à la suivante est le symétrique de θ0 par rapport à la corde photo → suivante,
  θ1 = θ0 + 2·(c − θ0), c = cap de la corde (écarts ramenés à ±180°), |θ1 − θ0| borné à 45° ; θ0 si la suivante manque, est à moins de 1 m
  ou à plus de 20 m. Dans un giratoire de 20 m de rayon, la
  route a tourné de 13° entre la photo et la droite : sans cela elle serait oblique d'autant par rapport au rayon de l'anneau. Un
  écart de plus de 3° est rendu dans `virage` (degrés, pas encore affiché). Points de -12 à +12 m tous les 0,05 m, positifs à droite. En ligne droite (θ = θ0), un point de décalage `x` est au cap `atan2(x, d)` de l'axe et à
  l'élévation `-atan2(H − dz, hypot(x, d))` à sol plat (`dz` = 0 ; relief : voir **Sol**) (sinon, avec δ = θ − θ0 : à `x·cos δ` à droite et `d − x·sin δ` devant la caméra) ; `d` = 4,4 m (monture 1,93 m), 4,8 m (2,07 m), 4,5 m sinon, soit le capot de
  `src/dessus.js` (OUTLINES) plus 0,3 m. Direction rendue dans le repère de la photo par `Session._view_of` : calage compris
  (cap de la séquence, inclinaison calée ou lue).
- **Distance de la droite (glissement en profondeur)** : `nose_line(distance, …)` reçoit la distance `d` du centre de la droite devant la
  caméra (0 ou `None` : au nez). Butées (`Nez._nose_range`) : `d_min` = distance du nez (ci-dessus) ; `d_max` = `d_min` + écart réel entre
  la photo et la suivante de la séquence (distance des positions, `_nose_gap`, 1 à 20 m, comme pour l'axe) + 1 m de recouvrement
  (`NOSE_OVERLAP`), soit `d_min` + 6 m (`NOSE_FAR_DEFAULT`) si la suivante n'est pas connue ; `d` est ramenée à [`d_min`, `d_max`] et rendue
  avec elles (`d`, `d_min`, `d_max`). Tout le reste (axe à `d`, virage, relief lu à `d`, élévations, extrémités sur la carte) se calcule comme ci-dessus
  à cette distance ; la droite reste perpendiculaire à l'axe (la rotation est un autre réglage). Côté `src/nez.js`, les décalages
  latéraux des poignées restent en mètres quand `d` change (la largeur est la même différence, recalculée avec les `σ` de la distance),
  et la place des poignées dans l'image (`anchors`) est relue sur la nouvelle droite. Pendant le glissement le relief n'est pas relu
  (le dernier lu pour cette caméra sert, `_nose_ground` avec `read` faux), il l'est au relâchement ; aucun calage Bird Eye n'est lancé :
  l'inclinaison est celle que Python lit (calée si elle l'est). **Incertitude** : `commonErrors` utilise déjà `d` : l'erreur de tangage sur la
  largeur `(s₂ − s₁)·d·δ/H` est proportionnelle à `d` (δ = 0,5° ; H = 1,93 m ; 8 m de largeur : 0,16 m à 4,5 m, 0,36 m à 10 m). Couleur : droite
  rouge fluo (`#ff1f3d`) tant que la photo n'est pas calée par Bird Eye (`Dessus.calibrated` ou calage de ce déplacement), verte fluo (`#39ff14`)
  ensuite, même règle sur la carte (propriété `couleur`). Poignée de profondeur (double flèche ⇕ sous la droite, `Traits` `double`) : sa place le long de la droite (`along`, en mètres, entre les poignées latérales, par défaut leur milieu) est indépendante de la mesure et gardée quand la droite glisse ; sur la photo, la distance suit l'élévation du pointeur (modèle de sol plat autour de
  l'élévation de la poignée, recalculé à chaque mouvement) et le mouvement horizontal déplace `along` ; sur la carte, écart du pointeur à la poignée le long du cap (distance) et le long de la droite (`along`). L'étiquette de largeur est décollée de 26 px au-dessus de la droite (la flèche est dessous) ; si elle sortait de la vue en haut, elle passe sous la flèche.
- **Rotation à la main** (`rotation` de `App.nose_line`, degrés, ±45°, 0° par défaut, remise à 0° au changement de photo) : la droite
  tourne autour de son point au droit de la caméra (x = 0, à `d` devant), dans le plan du sol ; rotation positive = sens trigonométrique vu du
  dessus (le côté droit avance vers l'avant). Direction de la droite = perpendiculaire au trajet tournée de la rotation : écart au cap de la
  caméra δ = (θ − θ0) − rotation, mêmes formules qu'en virage (`x·cos δ` à droite, `d − x·sin δ` devant), positions au sol, élévations (avec
  `dz` du MNT), extrémités géographiques et tracé de la carte suivent. Le relief est lu le long de la droite tournée, à l'angle arrondi
  à 0,5° (cache par angle) ; pendant le glissement (`relief` faux) aucune lecture : le relief déjà lu à l'angle précédent sert, puis il est
  relu au relâchement, la droite restant affichée. **Incertitude** : inchangée, l'angle est choisi par l'utilisateur ; la largeur est
  mesurée le long de la droite tournée, et une erreur d'angle α sur sa perpendicularité aux bords donne une largeur × (1/cos α − 1) en trop
  (1° : 0,015 %, 5° : 0,4 %, 10° : 1,5 %).
- **Carte** : `lonlat` rend les extrémités (-12 et +12 m) de la droite à partir de la position recalée de la photo si la séquence l'est ;
  la droite étant droite, tout décalage s'en déduit par interpolation linéaire. Les décalages des poignées sont continus : interpolation
  linéaire entre points consécutifs de la table, au point le plus proche du pointeur à l'écran.
- **Hauteur** `H` (`Nez._nose_height`) et son incertitude `σH`, dans l'ordre de la vue du dessus (`layerOf`) : 1) celle que la vue du
  dessus **annonce** pour la photo (`height`, `height_sigma` de `App.birdeye_tilt_set`, avec l'inclinaison : calée, monture CD21, parallaxe
  entre photos ou RTK ; source « vue du dessus ») ; 2) sans calage Bird Eye, `Session.camera_of` : calée, **monture** du véhicule d'après la date
  (1,93 ou 2,07 m, ±0,04 m), altitude GPS moins sol LiDAR, réglage (1,90 m par défaut). Depuis le 27/11/2026 (#59) c'est l'ordre de toutes
  les mesures : l'écart RTK − sol n'est qu'une borne (il saute aussi au 24/06/2025, 1,93 → 2,11 m, et surestime d'environ 5 cm la hauteur
  après). Sur la photo
  8625c7ff-90c1-4865-b936-fd8952ac908f, l'altitude GPS moins le sol donnait 1,80 m contre 1,93 m (monture, parallaxe 1,92 m) : 7 % de
  largeur en moins (48 cm sur 6 m de bords à ±3 m).
- **Sol, quand la vue du dessus a calé la photo** : le terrain **lissé** de sa couche (maillage de 1 m, lissé sur 2 m le long de la
  route, 31 × 31 points, `ground` de `birdeye_tilt_set` ; `Nez._birdeye_ground_dz`), interpolé bilinéairement comme `terrainAt`
  de `src/dessus.js`, `dz` = terrain au point moins le sol sous la caméra (`ref`, plan de la route sous le véhicule : `groundLevel`),
  sans lecture ni attente (source « LiDAR HD (vue du dessus) »). Le MNT brut au pas de 0,5 m (creux de la chaussée, caniveaux)
  rapprochait les bords de 12 cm sur 6 m. Avec la hauteur ci-dessus, la largeur ↔ de bords à ±3 m est celle de la vue du dessus
  (6,000 m, contre 6,564 m avant : écart de 7 %). Sans calage, ce qui suit.
- **Sol sans calage Bird Eye** : le relief du **MNT LiDAR HD** (pas de 0,5 m, repli RGE ALTI : `precision.fetch_terrain`, comme le profil et la vue du
  dessus), lu en une requête à la caméra et tous les 0,5 m le long de la droite (49 points, `Nez._nose_ground`), gardé par droite. La
  droite reste définie en positions horizontales `(d, y)` ; chaque point a un écart de sol `dz(y)` = altitude du MNT au point moins
  altitude du MNT sous la caméra (relatif : pas de souci de géoïde), interpolé linéairement entre les points lus, et il est vu à
  l'élévation `−atan2(H − dz, distance horizontale)` au lieu de `−atan2(H, …)`. Les distances des bords restent les positions
  horizontales lues sur les poignées. La lecture est asynchrone (hôte JS) : tant que le relief n'est pas arrivé (`sol_en_lecture`), la droite
  n'est pas tracée (voir plus bas, position définitive) ; passé le délai, elle est posée sur un sol plat. MNT absent ou en erreur : sol plat, source « plat (relief indisponible) », sans erreur. Source rendue dans `sol`, écarts dans
  `sol_dz`, incertitude du MNT dans `sol_sigma` (0,08 m LiDAR HD, 0,30 m RGE ALTI ; absente à plat). L'encart donne la source et l'écart
  de sol aux deux poignées. Effet : une pente en long de 5 % met le point à 4,4 m à 22 cm au-dessus du sol de la caméra, soit 11 cm de
  hauteur apparente en moins sur 1,93 m.
- **Inclinaison de la photo** (`Nez._nose_tilt`, qui lit `Calibration.tilt` : l'ordre unique des mesures et de la droite, § 1.3) :
  d'abord celle que **la vue du dessus** applique à cette photo quand elle la tire de
  la route (`groundTilt` de `src/dessus.js` : pente de la route sous le véhicule, part du dévers prise en roulis (70 %, plus un roulis réglé à la main en degrés, positif : penché à droite ; la part du dévers est affichée en degrés signés au-dessus de la réglette), tangage lu sur les
  raccords ou les lignes, ou réglé à la main, roulis par défaut de la campagne 2025 ; `layerOf`, `groundUp`) : `src/dessus.js` l'annonce à
  la page à chaque image (`Dessus.onTilt`), `App.birdeye_tilt_set` la garde par photo (les 20 dernières), la droite est refaite
  quand elle change (même vue du dessus ouverte après la droite) **et les mesures déjà faites sur la photo sont recalculées**. Même convention que `Calibration.tilt` (verticale vraie vue de la
  caméra, `[est, nord, haut]`), sans conversion : mêmes signes, aucun roulis par défaut de la campagne 2025 ajouté en plus (déjà dedans). Incertitude :
  celle de la vue du dessus (route et virage, `LEAN`). Source « vue du dessus », ou « vue du dessus (réglée à la main) » si le tangage ou
  le roulis l'est. Quand la vue du dessus lit les verticales de la photo, elle n'annonce rien et la suite
  s'applique : calée à la main (« clics »), puis verticales calculées sur la photo HD, sinon pente et dévers du LiDAR, puis les verticales à seuil
  élargi (`birdeye_loose`, incertitude jusqu'à 0,5°, `web_tilt.LOOSE_SIGMA`, « verticales (seuil élargi) »), enfin le **roulis par défaut de la campagne 2025** seul
  (profil de campagne, champ `roll` : +1° pour le CD21 en 2025, véhicule penché à droite, plus 70 % du dévers du LiDAR HD hors pont, même effet que dans `groundUp` de
  `src/dessus.js`, qui reçoit la part par `roll_share` de la pose ; source « roulis de campagne », tangage inconnu ou celui du profil de campagne, incertitude 2°), sinon rien (« aucune »). Le roulis par défaut n'est ajouté que seul (rang 6) : jamais aux
  verticales, au LiDAR ni au réglage de la vue du dessus, qui le contient déjà. La droite est projetée comme les mesures (`Session._view_of`).
  **Calage Bird Eye au déplacement d'une poignée** (`src/nez.js` : `needCalage`, `calibrated`, `reanchor` ; `Dessus.update(…, silent)` et
  `Dessus.onCalibrated` dans `src/dessus.js` ; `updateBirdeye` dans `src/resultats.js`). Le calcul de la droite en Python n'est pas
  modifié : il lisait déjà l'inclinaison de la vue du dessus quand elle existe (rang 1, ci-dessus), mais seulement si la vue avait été
  allumée. Désormais, au premier déplacement d'une poignée latérale sur une photo, la vue est calculée sans être affichée (terrain LiDAR,
  inclinaison par la route ou verticales, tangage lu sur les lignes ; ni voisines, ni position sur l'orthophoto, qui sont des réglages
  d'affichage) et annonce son inclinaison comme à l'ordinaire (`Dessus.onTilt` → `birdeye_tilt_set`) ; le calage est « fait » quand plus
  rien n'est en cours (`calage: { ok }` de la vue, repris avec `computed` : une photo déjà calée, par la vue allumée ou par un déplacement
  antérieur, n'attend pas). Dès la **première lecture des lignes** (première passe de `learnLines`) le calage est signalé « fait »
  (`Dessus.onCalibrated(pic, ok, final = faux)`) : la largeur s'affiche aussitôt ; les passes suivantes (tangage, au plus 4 en tout)
  se poursuivent en arrière-plan (la vue reste calculée, `calageFor` gardé jusqu'au signal final), chaque nouveau tangage est annoncé
  (`onTilt` → `nez.changed`) et la largeur est recalculée sans repasser par « en cours » (poignées replacées sur l'image, `reanchor`).
  Pose Bird Eye pas encore prête au déplacement (photo tout juste affichée) : attente de sa pose, puis calage, avec le message « en cours ».
  À l'**activation** de l'outil, le terrain (`readGrid`, en cache) et le panorama (`Dessus.prefetch`) de la photo sont lus à l'avance, sans
  calage : celui-ci ne part qu'au déplacement d'une poignée latérale. Sans inclinaison de route ni verticales (`ok` faux) ou sans pose Bird Eye possible (photo hors 360°, sans cap ni position :
  `App.birdeye_impossible`, connu dès la demande, sans attente), ou, comme filet seulement, au-delà de 90 s (« trop long ») : largeur sans
  calage, avec message. Les grilles d'altitude lues en POST sont gardées d'une session à l'autre dans le cache géographique de `app.js`
  (clé synthétique `adresse#post-empreinte du corps` : position, portée et pas identiques), comme les réponses GET : rechargement sans requête
  d'altimétrie. Pendant le calage aucune largeur n'est affichée. À la fin les poignées déplacées à la main sont **replacées sur
  leur point de l'image** : le décalage en mètres d'une poignée est celui du point le plus proche, en direction (yaw, pitch) de la
  photo, de la droite recalculée avec l'inclinaison calée (`offsetOfDirection`), car l'inclinaison change la correspondance entre un pixel
  et sa position au sol ; la largeur est la différence des deux décalages. La poignée jamais déplacée garde sa distance en mètres.
  Les verticales sont demandées par `birdeye_request` à l'affichage de la droite : même
  calcul, mêmes résultats gardés par photo que la vue du dessus avec « Calage par les verticales » (aucun calcul en double) ; elles
  arrivent après la première réponse (`inclinaison_en_calcul`) : la droite n'est tracée qu'à leur arrivée, poignées gardées. Source rendue dans `inclinaison_source`.
  Position définitive (`src/nez.js`, `shown`) : la droite, les poignées, l'étiquette et le tracé de la carte ne sont affichés
  que lorsque plus rien n'est attendu (`voisines` vrai, `sol_en_lecture` faux, `inclinaison_en_calcul` faux), ou après 12 s d'attente au
  plus (repli : meilleure droite disponible, l'encart dit ce qui manque). Une nouvelle attente (photo changée, clics de verticales) masque
  de nouveau la droite jusqu'à sa position définitive, poignées gardées. Les poignées ne se croisent pas : écart minimal de 0,10 m ; elles sont libres de part et d'autre de la caméra (trottoir, voie seule).
  **Incertitude de la largeur** : une seule règle, quel que soit le côté des bords. Les erreurs d'inclinaison, de roulis et de hauteur de la caméra sont communes aux deux bords : l'erreur de largeur due à chacune est `|f(s2) − f(s1)|` (différence signée des effets sur les deux bords, `s` négatif à gauche) ; l'altitude du MNT, lue en deux points, est indépendante par bord (quadrature) ; σ largeur = racine de la somme des carrés de tout (formules de `f` ci-dessous). L'étiquette de la photo et l'encart donnent la même valeur (arrondie au 0,05 m supérieur).
  Pourquoi : la droite est lue en distance latérale du bord ; une bande parallèle à l'axe, vue à travers un roulis ou un tangage faux,
  est lue à une autre place de la droite. Giratoire d'efbcbcd8-2ecb-4ea8-a731-a7ab55960e63 (RTK, verticales à ±0,30° : roulis -3,5°, tangage
  +0,5°, `d` = 4,4 m, `H` = 1,93 m) pour deux bandes à -2,5 m et +5,5 m (largeur 8,00 m) : roulis supposé -1° → bords lus à -2,24 et +6,26 m
  (8,50 m) ; verticale 0° (route plate) → -2,16 et +6,68 m (8,85 m) ; verticales → 8,00 m. L'erreur croît avec la distance (côté le
  plus loin) et le tangage joue aussi (±3° : de 6,9 à 8,9 m).
- **Incertitude d'un bord** à `s` m de l'axe (signé) : erreur latérale `f(s)` lue pour chaque source commune, au premier ordre. Le pixel fixe le rayon
  `(d, s, −H)` (devant, à droite, vers le bas) ; la vraie caméra est tournée ou plus haute, le rayon coupe le sol vrai et la position latérale devient `y'` :
  - **inclinaison** (tangage `δi` = 0,5°, rotation autour de l'axe latéral) : rayon `(d − δH, s, −H − δd)`, il touche le sol à l'échelle `H/(H + δd)` : `f = −s·d·δi/H` (le bord à `s = 0` n'est pas déplacé latéralement ; la droite, elle, avance ou recule de `(H² + d²)·δi/H`, sans effet sur une bande parallèle à l'axe) ;
  - **roulis restant** (`δr` = 0,5°, rotation autour de l'axe avant) : `y' = (s + δr·H)·H/(H − s·δr)` : `f = δr·(H + s²/H)` ;
  - **hauteur de caméra** (`σH`, sol vrai à `H + e`) : `f = s·σH/H` ;
  - **MNT** (indépendant par bord) : `σz` = précision (`sol_sigma`, 0,08 m LiDAR HD, 0,30 m RGE ALTI), sol de la caméra et du point lus ensemble, d'où √2 : `s·√2·σz/H`, absent à sol plat.

  Un bord seul : `σ = √( f_i² + f_r² + f_h² + (s·√2·σz/H)² )`. Largeur : `σ = √( (f_i(s2) − f_i(s1))² + (f_r(s2) − f_r(s1))² + (f_h(s2) − f_h(s1))² + (s1·√2·σz/H)² + (s2·√2·σz/H)² )`, arrondie au-dessus à 0,05 m. Vérifié par différences finies (reprojection avec l'erreur appliquée, `H` = 1,93 m, `d` = 4,4 m) : écarts de l'ordre de 1 à 2 % (termes du second ordre). Correction par rapport à la version précédente : l'inclinaison était comptée comme un décalage latéral constant `(H² + d²)·δi/H` (c'est le déplacement avant-arrière de la droite) ; le roulis n'avait pas son terme constant `δr·H` (sans effet sur la largeur).
  Estimation de départ, pas encore comparée à des bords relevés sur place.

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
- **Carrefour près de la photo** : un carrefour (même définition) à **12 m** au plus de la photo le long de la route
  est aussi signalé en tête des résultats des bords (« Carrefour avec … : bords peu sûrs ») : les travers vont jusqu'à
  ±10 m et la voie qui arrive a quelques mètres de large ; la chaussée s'y élargit, le bord n'y est pas continu, et ni
  le relief ni l'analyse fine n'y ont de bonne réponse (D16 d946f2cf-cddc-4476-a414-35aee429c05a, 20/11/2026).
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
  végétation renvoie beaucoup l'infrarouge, les gravillons et le béton 2 à 3 fois seulement ;
  second critère, pour l'herbe qui a de la hauteur : bande non revêtue d'au moins 1 m dont la part
  médiane de points de végétation par case de 0,25 m atteint **25 %** (cases d'au moins 8 points). Un
  point est « de végétation » s'il a plusieurs retours (NumberOfReturns > 1) ou s'il est classé 3, 4 ou 5
  à 0,5 m au plus au-dessus du sol de la case. Relevés du 20/11/2026 : 0 % sur l'enrobé, 29 à 78 % sur
  l'herbe de D119E (droit dès +2,75 m) et de D33 (dès +4,25 m). Les deux règles donnent la même bande.
  L'herbe rase d'un relevé d'hiver (0,6 à 1,9 fois l'enrobé, sans retours multiples) reste invisible au
  nuage : le LiDAR HD n'a pas de couleur.

Ce que l'analyse en tire :

- **Bord de chaussée** : le bord de la bande d'enrobé. N'est appliqué que si l'option « Bord d'enrobé (expérimental) » est cochée (décochée par défaut) : les relevés du 19-20/11/2026 l'ont trouvé souvent trop loin (accotements, trottoirs en enrobé comptés dans la chaussée). Décochée, la page ne transmet pas les bords au calcul Python (`use_paved_edges` avec aucun bord : retour aux bords du relief, sans relire le terrain), ne dessine pas le tiret et n'affiche pas la largeur d'enrobé ; le séparateur du nuage reste appliqué. Sur 5 travers de ±1 m à −4, −2, 0, +2 et +4 m
  le long de la route, chacun avec sa propre intensité d'enrobé : début de la première bande
  d'au moins 1 m dont chaque case est au moins **2,2 fois** plus claire que l'enrobé (ni une ligne
  blanche, ni une reprise d'enrobé), ou au plus **0,8 fois** aussi claire (terre ou sable d'un chemin
  raccordé, plus sombre qu'un enduit clair : D119E 1d23f3f9-f4b7-4d2e-8658-500a748ccecc, 0,5 à 0,8 fois
  sur 2 m) et restée à **15 cm** près au niveau de la case qui la précède (un fond de fossé humide est
  sombre aussi, mais plus bas), placé à mi-hauteur entre l'enrobé et ces abords et interpolé
  entre deux cases. **Bordure** : un trottoir en enrobé renvoie comme la chaussée (même intensité) ;
  l'altitude médiane des points du sol, case par case, montre alors sa bordure. Depuis un point bas
  (caniveau, pas plus haut à 2 cm près que le mètre qui le précède), le sol remonte d'au moins
  **4 cm** en 0,75 m au plus, ne redescend pas sur le mètre suivant (bosse, rebord d'ornière), et le
  niveau moyen de ce mètre dépasse de 4 cm celui du mètre avant le point bas, pente montante de la
  chaussée déduite (un dévers qui monte n'a pas de point bas). Garde contre les fossés : le point bas
  n'est pas à plus de **15 cm** sous le mètre qui le précède (un caniveau n'est qu'à quelques centimètres
  sous la chaussée), et le mètre après la remontée reste plat à **8 cm** près (dessus d'un trottoir ; la
  berge d'un fossé continue de monter). Le bord est au milieu du plus grand
  saut d'une case à la suivante ; pas plus près que 2 m de l'axe quand le profil part de l'axe, ni
  du côté d'une autre chaussée sans séparateur trouvé. Chaque travers garde le plus proche des deux
  bords (intensité, bordure). Relevé du 19/11/2026 sur 9 côtés vérifiés à la main (photo, vue du
  dessus) : écart total au vrai bord 30 → 7 m (D8, M996, D119M : trottoir compté en enrobé jusqu'à
  9 m de trop) ; les accotements en gravier sombre (D70) restent comptés en enrobé. Garde ajoutée le
  20/11/2026 (bordure trouvée au fond d'un fossé, 4c1c91d9-5c70-48d4-8962-b71c33dfe227) : bordures des côtés
  vérifiés inchangées, une fausse bordure en moins (D16 b3978b33-2ceb-4ef3-bd51-09d25e505015, 3,4 m pour 2,0).
  Le bord est la médiane des travers, si au moins 3 le trouvent. La **largeur
  d'enrobé** (légende) est la médiane des largeurs des travers, ± 1,48 fois leur écart médian (0,1 m
  au moins) ; du côté du séparateur, elle s'arrête à lui. Les surlargeurs revêtues et bandes
  d'arrêt d'urgence en font partie. Ces bords remplacent alors celui du § 8.2, sur tous les travers et
  au même écart de l'origine : **plateforme**, son **dévers** (§ 8.7), **chute** et **dévers du talus**
  (§ 8.4) se relisent depuis eux, dans le graphique.
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
  adresse IP ; au-delà, il répond HTTP 429 et bloque 5 s. Toutes les requêtes à ce service passent par
  une file unique (`altiFetch`, `src/app.js` : au plus une requête toutes les 220 ms, et un refus bloque
  la file pendant `Retry-After`, 5 s si l'en-tête n'est pas lisible : CORS ne l'expose pas). Les altitudes sont demandées par
  150 points (10 photos) à **2,5 requêtes par seconde au plus**, et après un refus on attend la fin
  du blocage (5,5 s) avant de redemander, jusqu'à 12 fois. (Le terrain de la vue du dessus, lui, se lit en
  **une seule requête POST** de 2 601 points : 1 à 2 s ; voir `docs/BIRDEYE.md` § 2.) C'est **lent** : 1 min environ pour
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
| Objet sur une seule photo, à 6 m | ±0,2 à 0,8 m | inclinaison, sol supposé plat |
| Objet placé sur la carte | ±1 m | orthophoto |
| Chute (pont, bords de route) | ±0,1 m LiDAR HD, ±0,4 m RGE ALTI | MNT ; sur un pont, nuage LiDAR HD, sinon altitude RTK |
| Dévers | pas des points (0,5 m près du bord, 0,6 m à 10 m, 1,9 m à 30 m) | talus court, MNT interpolé sous arbres et murs |
| Pente en long | MNT ±0,1 m sur 100 m | tablier des ponts interpolé en droite, creux sans pont BD TOPO ni plongée de 20 % non comblés, ponts de plus de 40 m en pente douce |
| Bord, séparateur (nuage) | 0,25 m | cases du nuage, marquage effacé |
| Accélération latérale (vidéo) | courbure à 4 % près en RTK sur un virage de 200 m ; dévers ±2 % au plus (MNT ±0,08 m par point, 15 points sur 3 m ; moins si ses erreurs sont liées) | lissage sur 30 m (virages de moins de 30 m sous-estimés), GPS hors RTK, ponts |

Avec un GPS grand public (±4 m), le point de référence est à plusieurs mètres près, et une
hauteur à ±2 à 3 m. Les essais et leurs valeurs attendues sont dans le guide (docs/GUIDE.md, « Précision »).

## Vue du dessus (essai, branche `birdeye`)

Explication d'ensemble (construction de l'image, recalages, pourquoi et comment) : `docs/BIRDEYE.md`. Ici, le
détail et les chiffres des essais.

Le sol de la photo 360° est reprojeté sur la mini-carte, à ±15 m de la caméra (`src/dessus.js`) : un
maillage de 1 m suit le MNT LiDAR HD lissé sur 2 m le long de la route et 0,5 m en travers (sinon un plan horizontal), posé à la hauteur de caméra sous la
photo. Lissage (`smoothTerrain`, 08/11/2026) : sur l'A38 (`f9f83571`), le MNT s'écarte d'une surface lisse de 1,7 cm
(écart type, 5 cm au plus) sous la chaussée, et la rive, à 5 m de la caméra, ondulait de 3,5 cm (13,7 au plus) ; lissé,
0,4 cm (0,8 au plus). Largeurs entre lignes comparées à l'orthophoto (22 vues, 2 500 largeurs) : écart médian 1,93 %
sans lissage, 1,85 % avec ; variation d'une même largeur le long de la route 0,49 puis 0,29 %. Lissage seulement le long de la route depuis le 14/11/2026 : lissés aussi en travers, le bombement et les caniveaux d'une rue (1 m de large, 15 à 19 cm de creux) disparaissaient, et les bouts des bandes d'un passage piéton à 5 m dérivaient de 30 cm (`57c93b75-964f-4645-9a9f-5a9000d549ca`, ville : écart au LiDAR brut de 4,5 à 2,6 cm, écart milieu-caniveau de 11 à 2,5 cm). L'inclinaison et la hauteur de la route sous le véhicule, et le tangage lu sur les lignes, gardent le lissage sur 2 m dans les deux sens. Chaque point y reçoit le pixel qui le voit, inclinaison et cap de la séquence compris
(rotation identique à `Calibration.uncorrect`). Image affichée de 2 048 px (1,5 cm par pixel, carte zoomable
jusqu'à 0,6 cm par pixel) ; les calculs (hauteur, raccords, position) gardent 1 024 px. La photo (12 288 px de large)
est plus fine jusqu'à 10 m : un pixel couvre au sol 0,2 cm en travers et 0,5 cm le long à 4 m, 0,5 et 2,6 cm à 10 m
(caméra à 2,05 m) ; les voisines, chargées à 6 144 px, deux fois plus. Cette vue sert à la mesure sur la carte (« longueur ») : un segment de droite tracé en deux clics sur la
carte, mise pour cela à la place et à la taille de la visionneuse (et inversement). Aucun point n'est ramené
sur une perpendiculaire à la route. La longueur rejoint les résultats de la séance (`App.add_map_length`,
`py/web_app.py`), avec son incertitude (`shownError`) et les photos qui ont fourni ses deux bouts. Un bout hors
de la vue : longueur sur le fond de carte seul, sans incertitude, marquée « hors vue », pour un contrôle rapide de
cohérence (orthophoto).
Zone idéale d'une largeur : ±4 m en face de la caméra (axe :
trajectoire entre les photos voisines, à défaut cap de la photo), sur ±8 m en travers, là où le tangage
pèse le moins (essai du 08/11 sur les lignes peintes, vue lissée contre orthophoto : écart de largeur 1,2 à
1,5 % jusqu'à 4 m en long, 2 % au-delà ; pas de dégradation en travers jusqu'à 9 m). L'incertitude affichée
vaut au moins 5 % de la longueur (écart à l'orthophoto, plus bas). Les 3,5 % qu'elle comptait en plus en travers
(bandes de passages piétons à 0,483 m pour 0,50 m) venaient du roulis de la caméra, corrigé depuis le 13/11/2026
(roulis par défaut de la campagne 2025, ci-dessous).

Les photos précédente et suivante complètent l'image sous le véhicule seulement : hors du masque du véhicule de la
photo affichée, celle-ci n'est pas retouchée. Masque au plus près (09/11/2026) : contour du véhicule dans le panorama,
lu sur 12 photos de la séquence pour le CD21 (`readOutline`, marge de 1,5°, forme symétrique sans encoche ; à défaut
celui de la monture, `OUTLINES`), sinon ellipse au sol de ±5,8 m en long et ±2,9 m en travers.
Dessous, la voisine où l'erreur due à l'inclinaison est la plus faible, comptée trois fois près de son propre véhicule
(`SHADE`, ombre portée et reflets) ; une voisine sans inclinaison ne sert qu'à défaut d'une autre. Chacune a sa position, sa hauteur et son
inclinaison, posées sur le même terrain. Une distance entre deux points de photos différentes
additionne l'erreur de chaque point et leur position relative (5 cm en RTK vérifié, sinon 30 cm).

Avec « Véhicule masqué » (éteint par défaut : la photo affichée seule), raccords recalés (`alignJoin` et
`blockShifts`, `src/dessus.js`) : une voisine qui ne
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
plausibles (1,2 m, 3°, 6 %). La voisine est alors dessinée au point déplacé ; la principale ne bouge pas, et son
erreur d'échelle reste à caler (tangage). Pas de recalage sans assez de sol net en commun.

Essai hors application du 07/11/2026 : écart médian au raccord de 10,8 à 2,9 cm sur 38 raccords de route (A38,
RD 1074, D33), de 17,6 à 3,9 cm sur 14 en agglomération (passage piéton, village), tous améliorés ; 6 paires de
village sur 20 sans assez de sol commun. Il remplace un recalage par les seules lignes en long (8,3 à 3,6 cm sur la
route, rien en ville). Sur les photos de référence (`tests/essai-dessus-reference.html`) : A38 5,3 → 1,6 et
7,3 → 3,2 cm, passage piéton (d946f2cf-cddc-4476-a414-35aee429c05a) 5,0 → 2,9 et 16,5 → 2,8 cm.

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
hauteur de caméra et l'écart du sol (2 cm sur LiDAR, 10 cm sur sol plat). Cet écart est corrélé entre deux points proches
(gaussienne de portée 2 m, `GROUND_CORRELATION` : le terrain est lissé sur 2 m) : sur une courte distance, il agit comme une
échelle (`L × Δz / H`) ; compté indépendamment à chaque bout jusqu'au 13/11/2026, il donnait 7 à 13 cm pour une bande de
passage piéton de 0,50 m vue à 5 m (2,5 à 5 cm depuis, plancher de 5 % compris). Les objets en relief
s'étalent : seuls les points réellement au sol sont à leur place.

Scène de synthèse (`tests/essai-dessus.html`, sol en dévers de 3 %, caméra penchée) : traits de
peinture retrouvés à moins de 4 cm, aussi sous le véhicule et par-delà le raccord entre photos. Pas encore de comparaison à des longueurs mesurées sur le terrain.

Sans verticale à lire (rase campagne), l'inclinaison vient de la route : le véhicule est supposé posé sur le
plan ajusté au MNT sur ±2,5 m en long et ±1,5 m en travers. L'A38 penche d'environ 2,5 % en travers et 1,2 %
en long, ce qui expliquait l'écart entre tirets devant et derrière. Les verticales gardent la priorité.
Le roulis ne suit qu'une part du dévers (70 %, fixe, `ROLL_SHARE` de `py/web_pose.py` repris par `src/dessus.js` ; elle sert aussi au roulis par défaut des mesures hors vue du dessus, rang 6 du § 1.3 ; l'option d'essai « Roulis » y ajoute un roulis en degrés, ±2°, 0° par défaut, positif : penché à droite, côté droit plus bas ; `groundUp` compte positif vers la gauche, d'où `gs = 0,7 × dévers + tan(défaut de campagne − réglage)`) : sur la RD 1074
(`81049c82-2ea6-481f-b0d0-a6a1864e5ea0`, véhicule dans la voie de droite), l'écart entre lignes de rive vaut 6,37 m sans roulis et 6,90 m
avec tout le dévers, pour 6,58 m sur l'orthophoto (environ 40 % du dévers) ; sur l'A38, environ 75 %. Le roulis
déplace surtout la ligne la plus éloignée de la caméra, d'où l'impression d'un milieu étiré. Le tangage suit la
pente entière (tirets de 3 m retrouvés devant et derrière).
Défaut de roulis par défaut de la campagne 2025 (profil de campagne daté, `CAMPAIGN_PROFILES` de `py/web_profils.py` : producteur, période, degrés), ajouté au roulis
tiré du dévers (`groundUp`) : CD21, campagne 2025, +1° (véhicule penché à droite). Une erreur de roulis δ fait varier la largeur d'une bande de
passage piéton (0,50 m) comme 1 + 2 s δ / H (s : écart en travers à la caméra, H : hauteur de caméra) : la pente des
largeurs en travers donne δ, indépendamment de l'échelle. Sur 25 passages piétons (13/11/2026), roulis restant
+0,98° en médiane par la route (23 vues), −0,08° par les verticales (15 vues), sans lien avec le dévers ; −1° le
ramène près de 0 (+1,08 → +0,12° et +0,26 → −0,27° sur deux sites). La triangulation des coins des bandes redonne
0,499 m (25 largeurs, ±5 cm par coin). À mesurer pour chaque campagne ou producteur.
Option d'essai « Tangage » : tangage ajouté à la pente (défaut de fixation de la caméra, ±2°). Sur la D33
(`dbdaa47b-6e4d-4416-b352-ab324cb14735`, 20/06/2025), la chaussée se resserre vers l'avant sans réglage (environ 5 % sur 12 m) ; à l'œil, le
meilleur roulis vaut 45 % du dévers sur la RD 1074 et 100 % sur l'A38, pour des dévers voisins (2,5 et 3 %).
Tangage réglé à l'œil par l'auteur : de -0,2 à +0,5° selon la séquence, sans règle par période, mais identique
(+0,2°) sur deux portions de l'A38 d'une même séquence. Roulis et tangage sont donc retenus par séquence, dans le
navigateur (`web-measures/dessus-reglages`) ; la barre d'état l'indique (« réglé à la main »). Sans réglage, le
tangage est lu sur les raccords (`learnPitch`, voir docs/BIRDEYE.md § 4.1 ; deux recalages appliqués seulement, écart
au raccord sous 5 cm, `JOIN_GOOD`) : échelle de la voisine avant moins celle de
l'arrière, environ 9,6 % pour 1° de tangage ; retenu et appliqué par photo (`web-measures/dessus-tangages`) : il bouge
sur une bosse ou un creux, que le plan de la route ne suit pas ; médiane de la séquence pour une photo sans le sien.

Photo marquée sur un pont par le cœur (`Session.mark_bridge`, BD TOPO à 8 m au plus dans le sens de la séquence : le même critère que pour
les mesures ; avant le 22/11/2026 la vue du dessus détectait elle-même un pont à moins de 20 m, dessus ou dessous), la vue se passe du terrain
LiDAR HD : le MNT n'a pas le tablier (sol sous le pont). Tablier supposé plan et horizontal
(maillage à plat, `deck`) : inclinaison par la route (tangage de la séquence et roulis par défaut de la campagne 2025 seulement,
±1,5° pour la pente du tablier, jusqu'à 3 %). Hauteur de caméra : pour le CD21, sa monture d'après la date
(profil de campagne, `py/web_profils.py` : 1,93 m avant le 24/06/2025, 2,07 m ensuite, ±0,04 m) ; autres photos, lue entre photos sur les
verticales, sinon calée pour la séquence, sinon le réglage. Avant le 13/11/2026 : sol plat sans inclinaison et 1,90 m par défaut, bandes
de passage piéton à 0,44 m au lieu de 0,50 (f2a245d0-aeea-4249-ba9c-fad83b442a23, Pont de France ; 7dcdccf9-3c52-4c54-bc5b-de72740a7967, D977 bis). Pont de France à Auxonne (bbf7a0be-f532-4362-afb4-114268317258) : tangage lu sur les raccords à
-1,2° avec le MNT, raccords 33,5 → 1,3 cm sur sol plat.
**Sol supposé plat près d'un pont (depuis le 26/11/2026)** : pont BD TOPO à 15 m au plus de la photo à vol d'oiseau (`roads.flat_ground`, tablier le plus proche, tout sens) : plan horizontal à la hauteur de caméra à la place du relief (`pose.flat`) ; incertitude de sol `FLAT_SIGMA` = 0,1 m, inclinaison et mesures inchangées. Le remblai à moins de 15 m du tablier y passe ; le cas suivant ne vaut plus qu'au-delà.
Photo non marquée près d'un ouvrage (remblai en pente qui mène au tablier, 7dcdccf9-3c52-4c54-bc5b-de72740a7967 : LiDAR +3,2° de tangage, juste ;
le sol plat donnait 0°) : le terrain LiDAR est gardé ; ses points sous l'emprise de l'ouvrage (tronçon BD TOPO en pont orienté comme la
séquence, à moins de `roads.DECK_HALF_WIDTH` = 6 m de l'axe, entre ses extrémités : `roads.deck_mask`, `pose.deck`) sont écartés, car ils
décrivent le sol sous le tablier. Vue du dessus : maillage rempli par un tablier horizontal à l'altitude de la culée (terrain LiDAR au bord de l'emprise, côté photo, le long de l'axe), indisponible s'il en reste moins
de 60 %. Même écart (sans palier : plan ajusté sur les points gardés) dans le cœur, pour la grille `LIDAR_GRID` de l'inclinaison (`TiltChecker`, `calibration.lidar_slopes` : plan ajusté sur
les points gardés, aucune pente s'il en reste moins de `LIDAR_MIN_KEEP` = 10 sur 15) et pour le terrain web (`web_terrain.slopes`) : avec la portée
de 8 m du marquage, ces grilles étroites (±1,7 m, ±2,9 m) n'atteignent l'emprise que d'une photo à la culée non encore marquée.
Le calage du tangage sur l'orthophoto (lignes de peinture repérées sur elle et sur chaque photo, essai du 07/11/2026)
a été retiré le 08/11/2026 au profit du tangage lu sur les raccords. Tangage lu aussi sur les lignes et les bords de la route
d'une photo seule (`linesPitch`, 13/11/2026) : une erreur δ change l'échelle en travers de 1 + a δ / H à la distance a le
long ; ajustement commun des lignes s_i(a) = p_i (1 + κ a) + q a + c a², δ = atan(κ H), sur ±25 m avec le terrain LiDAR HD de
cette portée, seulement faute de tangage lu sur les raccords ; voir docs/BIRDEYE.md § 4.1
(ordre : raccords de la photo, lignes de la séquence, raccords de la séquence, réglage à la main). Option « Position calée sur l'orthophoto » (décochée par défaut depuis le 20/11/2026, à cocher dans les réglages de la vue du dessus ; `locate` et `orthoShift`) :
dès la photo principale prête, son profil en travers de la chaussée (6 m de part et d'autre, 9e décile le long, hors
véhicule) est corrélé à celui de l'orthophoto, sur ±1,2 m ; au-delà de 30 cm d'écart, la vue s'y pose (décalée en
travers), sinon la position GPS est gardée. Un appariement ligne à ligne ne convient pas ici :
herbe et bordures donnent des pics sur l'orthophoto (14 « lignes » sur la D33), la médiane des écarts tombait à
0,17 m pour 0,71 m. En cas d'écart, le GPS est à suspecter avant l'orthophoto : au même endroit de la D33, la
séquence du 04/07/2025 (photo 6c6e4972-f565-4198-84fe-24ab72d95398, « RTK vérifié ») est décalée de 0,71 à 0,75 m en travers, translation pure,
alors que celle du 20/06/2025 tombe sur l'orthophoto à 5 cm près. Écart trouvé sur les autres photos de référence :
A38 0,11 m, RD 1074 0,19 m, D33 0,02 m, petite RD sans peinture 0,31 m (calée, de justesse : bords d'enrobé seuls),
village sans accord (position gardée). Limite : un décalage de plus de 1,2 m serait pris pour celui d'une autre ligne. Le calage du tangage sur l'orthophoto trouvait, sur 6 photos réglées à l'œil par l'auteur (07/11/2026), 0 / +0,1 / +0,4
/ +0,2 / -0,2 / +0,2° pour +0,5 / +0,5 / +0,2 / +0,2 / -0,2 / 0°.

Photos du CD21 : hauteur de la monture d'après la date de prise de vue (profil de campagne, `py/web_profils.py`, 1,93 ou 2,07 m), avant toute
autre sauf une hauteur calée pour la séquence (voir docs/BIRDEYE.md § 4.2 ; ordre de `Session.camera_of`, #59). Autres photos, hauteur de caméra par séquence : médiane des hauteurs vérifiées (GPS RTK moins sol) des photos vues de la séquence, dès
3 photos, gardée dans le navigateur (`web-measures/dessus-hauteurs`) ; une même séquence de l'A38 allait de 1,83 à
2,36 m d'une photo à l'autre. Chaque caméra est posée à cette hauteur au-dessus du plan de la route sous le véhicule
(moyenne du terrain sur ±2,5 m x ±1,5 m), plutôt que sur un seul point du maillage.

Raccords entre photos (D33, `fb158480-3fc0-4382-ba1d-d5c962f81c71`) : des marches de 10 cm sur la rive (4,2 m de la caméra) et 3 à 5 cm sur l'axe
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
