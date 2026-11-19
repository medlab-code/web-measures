<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Mode profil : pistes d'améliorations et d'optimisations

Liste du 17/11/2026. Elle couvre les boutons « Profils » et « Graphiques », la fenêtre du profil (`src/profil.js`), le calcul des
bords, de la chute et du dévers (`py/web_chutes.py`) et l'« Analyse fine » du nuage LiDAR HD (`src/nuage.js`, `src/reglages.js`).
Elle vient de la lecture de ces fichiers et des journaux des essais, sans mesure nouvelle sauf P5. **Réanalysée avec Opus le
jeudi 19/11/2026** : voir « Réanalyse du 19/11/2026 » en fin de document (constats vérifiés, mesures sur terrain synthétique,
pistes P7 à P13 et G1 à G9, nouvel ordre).

Ordre proposé le 17/11 : P1, P2, P3, P4, P5, P6. P5 a été faite puis retirée le 17/11/2026 (voir ci-dessous).

**P1. Tests rapides sur des profils synthétiques.**
- **Avant** : seuls `platform_slope` et un cas de pont sont testés en Python (`tests/test_calculs.py`). Les fonctions qui décident
  des bords (`_edge_border`, `_edge_separator`, `_taluses`, `_long_profile`) ne sont vérifiées que par les essais du navigateur
  (réseau, plusieurs minutes).
- **Problème** : un changement de seuil ne se vérifie pas vite, et rien ne protège les seuils actuels.
- **Piste** : construire des travers à réponse connue (fossé, bordure, talus, plain-pied, séparateur, glissières dos à dos) et les
  tester comme `tests/coeur/`.
- **Gain** : mise au point en secondes.

**P2. Mesurer la qualité réelle, avec l'analyse fine comme référence.**
- **Avant** : `docs/analyses/detection-bords-devers.md` annonce 85–92 % de cas traités, mais ce sont des estimations (document
  généré, aucune mesure sur un jeu de photos).
- **Problème** : on ne sait pas sur quelles routes le MNT seul se trompe.
- **Piste** : sur 20 à 30 photos variées, comparer les bords du MNT à ceux de l'intensité LiDAR (analyse fine). L'écart donne un
  taux de réussite chiffré et les cas qui échouent.
- **Gain** : des chiffres au lieu d'estimations ; filet pour P1.

**P3. Faire de la largeur d'enrobé un vrai résultat.**
- **Avant** : elle n'apparaît que dans le texte de la légende (« Largeur d'enrobé : X m ± Y »). Exports du profil : PNG et PDF
  seulement (d'après la lecture de `src/profil.js` et `src/reglages.js`).
- **Problème** : pas réutilisable dans QGIS ni un tableur.
- **Piste** : la ranger dans l'onglet Résultats avec son incertitude, l'exporter en CSV et GeoJSON avec les bords gauche et droit,
  la chute et le dévers ; ajouter le profil en CSV (x, z par travers).
- **Gain** : donnée exploitable hors de la page.

**P4. Signaler les bords peu sûrs.**
- **Avant** : l'origine d'un bord (« fin de l'enrobé », « rupture de pente », « largeur BD TOPO ») n'est lue qu'en infobulle.
- **Problème** : un bord qui retombe sur la largeur BD TOPO, donc une hypothèse, a la même allure qu'un bord mesuré.
- **Piste** : une marque visible sur le graphique, avec l'invitation à lancer l'analyse fine seulement dans ce cas.
- **Gain** : on voit quand le chiffre est une hypothèse.

**P5. Analyse fine : lire moins de blocs.** *Faite puis retirée le 17/11/2026 à la demande de l'auteur (à reprendre après la réanalyse avec Opus du 19/11/2026).*
- **Avant** : elle lit les blocs qui touchent un carré de 68 m de côté. `download` attend 1,1 s entre deux requêtes : 12 à 28 s
  pour 12 à 26 requêtes (journaux de `tests/essai-nuage.html`).
- **Problème** : seule une bande sert (±34 m en travers, ±5 m le long de la route : travers voisins `PAVED_STEPS` et `STRIP`).
- **Piste** : ne garder que les blocs qui touchent cette bande, tournée dans le sens de la route (`Nuage.stripTest`).
- **Gain** : moins de requêtes, donc moins de secondes.
- **Fait puis retiré** (17/11/2026, commits 1ea0270 et 7910c5b ; code : `Nuage.stripTest`, `nodesIn(tile, box, strip)`). **Vérifié** le même jour, ancien et nouveau code chacun sur un
  cache vide, l'objet complet rendu par `Nuage.analyse` comparé (cases, lignes, herbe, séparateur, bords, largeur, végétation, eau) :
  identique sur 5 photos. Requêtes 26 → 11, 15 → 11, 15 → 10, 24 → 16, 12 → 12 ; durée 28 → 11 s, 16 → 11 s, 16 → 10 s, 26 → 18 s,
  12 → 12 s ; octets lus −56 %, −29 %, −32 %, −26 %, 0 (RD903bis, A38 66d45404, RD 1074, D33, petite RD). Pas de gain quand la route
  traverse peu de blocs hors de la bande. Deux photos non comparées d'un code à l'autre (échec réseau ponctuel d'un côté, délai de
  l'autre) : A38 61dd94c4 et RD700, où seuls les points du sol et la largeur d'enrobé l'ont été (essai-nuage, mêmes valeurs).
  Contrôle de la bande dans `tests/essai-nuage.html` (retiré avec le code ; à retrouver dans 1ea0270).
- **Point à surveiller** : le niveau de blocs lus dépend du plus profond trouvé (`deepest`), maintenant calculé dans la bande et non
  dans le carré ; si le carré avait un bloc plus profond hors de la bande, l'ancien code lisait des blocs plus profonds, le nouveau des
  blocs un niveau plus haut. Aucun écart vu sur ces 5 photos.

**P6. Analyse fine automatique à l'ouverture des graphiques.**
- **Avant** : un clic sur « Analyse fine » à chaque profil.
- **Problème** : un clic de plus, mais lancée sans demande elle consommerait du réseau.
- **Piste** : une case « Analyse fine automatique », décochée par défaut.
- **Gain** : un clic de moins pour qui s'en sert à chaque photo.

## Réanalyse du 19/11/2026

Lecture complète de `src/profil.js`, de la fenêtre (`index.html`, `src/reglages.js`), des fonctions de bords de
`py/web_chutes.py` (`_edges` à `_terrain`) et de la lecture du nuage (`src/nuage.js`, `analyse`). Les constats chiffrés viennent
du banc de terrain synthétique des tests (`_compute_edges` avec `_terrain` remplacé, comme `BordsEnrobe` dans
`tests/test_calculs.py`) : géométrie exacte, puis bruit gaussien indépendant d'un point à l'autre. Rien n'a été modifié dans le code.

### Ce que deviennent P1 à P6

- **P1** : l'« Avant » est en partie dépassé. `tests/test_calculs.py` essaie déjà `_compute_edges` de bout en bout sur terrain
  synthétique (`BordsChausseesSeparees`, `BordsEnrobe`), mais rien ne vérifie la position du bord, la chute, le dévers ni le
  consensus. La piste reste la première à faire : ce banc vient de montrer P7, P8, P9 et P10.
- **P2** : toujours valable, et devient la référence pour valider P7 et P8 sur des routes réelles (bord d'enrobé du nuage contre
  bord du relief).
- **P3** : confirmé (largeur d'enrobé seulement dans la légende, exports PNG et PDF seulement).
- **P4** : l'« Avant » est inexact : l'origine du bord est aussi écrite sur le graphique, sous « bord » (`profil.js:378`). Reste vrai
  qu'une hypothèse a la même allure qu'une mesure ; repris dans G3. Et l'étiquette peut être fausse (P10).
- **P5** : le « point à surveiller » n'est pas un risque de perte. Dans un nuage COPC, chaque niveau de la hiérarchie porte une
  partie des points (les niveaux fins ajoutent du détail, ils ne remplacent pas les autres). Avec la bande, les blocs gardés sont
  ceux de niveau ≥ (le plus profond de la bande) − 1, alors que le carré gardait ceux de niveau ≥ (le plus profond du carré) − 1 :
  dans la bande, le nouveau code lit les mêmes blocs que l'ancien, et parfois un niveau plus grossier en plus, donc au moins autant
  de points. La piste peut revenir telle quelle (annuler 306eae1).
- **P6** : inchangée.

### Calcul : nouvelles pistes

**P7. Bord placé trop près de l'axe.** *Faite le 19/11/2026 : le bord avance d'un pas si ce pas suit encore la pente de la chaussée (`_edge_border`), test `BordsTalus`. Terrain synthétique : bord exact (avant −0,5 m). Photos de `essai-bords` : 2 côtés sur 14 avancent de 0,5 m, les autres ne bougent pas (le MNT réel arrondit les ruptures). Avec un bruit de 5 cm d'un point à l'autre, le bord partirait encore 1,2 m trop tôt (déclenché par le bruit) ; mais le bruit réel du MNT LiDAR HD est bien plus faible (voir P9) et, à 1 à 1,5 cm, le bord tombe à 5 cm près.*
- **Avant** : `_edge_border` prend le premier point d'où la pente sur 1 m s'écarte de celle de la chaussée. Cette fenêtre de 1 m
  « voit » la rupture avant d'y arriver.
- **Problème** : mesuré sur terrain exact (rupture à 4,0 / 4,1 / 4,25 / 4,4 m, talus de 20 à 100 %) : bord trouvé de 0,25 à
  0,9 m trop tôt, le plus souvent 0,5 m. Même avec une bordure de 15 cm (la marche est à 4,0 m, le bord sort à 3,5 m : la règle de
  pente passe avant celle de la marche). La plateforme est donc trop étroite d'environ 1 m (les deux côtés), et chute et dévers
  partent d'un point encore sur la chaussée.
- **Piste** : une fois la rupture trouvée en i, reculer jusqu'au dernier point dont la pente sur un pas (0,5 m) est encore celle de
  la chaussée, ou prendre l'intersection des droites de la chaussée et du talus. Une marche trouvée dans le mètre qui suit l'emporte sur la rupture de pente. Vérifier sur
  routes réelles avec P2 (le MNT lisse les ruptures : l'écart réel peut différer).
- **Gain** : largeur de plateforme juste à ±0,25 m près au lieu d'un biais de −1 m.

**P8. Dévers du talus sous-estimé.** *Faite le 19/11/2026 : haut avancé tant que le pas descend de moins de 5 %, pied au premier point à 5 cm du plus bas (`_taluses`, `EDGE_FLAT`), test `BordsTalus`. Terrain synthétique : dévers exact (50, 20, 100 %) ; avec 3 à 5 cm de bruit, 52 % pour 50 %, 22 % pour 20 %, 101 % pour 100 % (avant 39 %, 20 %, 75 %). Photos de `essai-bords` : chutes inchangées, dévers de 3 à 26 points plus forts (RD903bis 1640bc3f : 25 → 51 % sans analyse fine, 34 → 47 % avec ; la droite du talus va maintenant de la cassure au pied, vérifié sur l'image du profil).*
- **Avant** : `_taluses` prend la pente moyenne du haut au pied ; le haut est au plus tôt le bord (P7), le pied est le point le plus
  bas jusqu'au bout de la dernière fenêtre de 2 m en pente.
- **Problème** : sur terrain exact, un talus de 1 m à 50 % sort à 33 %, à 20 % sort à 17 %, à 100 % (2 m) sort à 67 %, et un
  talus de 3 m à 50 % sort à 41 à 45 %. Le plat avant le haut (P7) et le plat du fond après le pied sont comptés dans la longueur.
  C'est la valeur qui dit si un talus est dangereux : elle est minorée.
- **Piste** : haut = dernier point avant la descente (après correction P7), pied = premier point à 5 cm du plus bas (comme la
  chute), ou droite ajustée sur le cœur du talus (pentes ≥ `EDGE_CORE` de la plus forte). Cas tests : les quatre talus ci-dessus.
- **Gain** : dévers juste à quelques points près sur talus net.

**P9. Chute surestimée par le bruit du terrain.** *Mesurée le 19/11/2026, pas de correction. Bruit réel du MNT LiDAR HD sur chaussée (grille de 12 × 12 points tous les 0,5 m sous 3 photos d'essai, 1640bc3f, 61dd94c4, 067e83ca) : 0,7 à 1,0 cm d'un point au suivant, 1,0 à 1,5 cm d'écart à un plan. À ce bruit, la chute d'un fossé de 1 m sort à 1,03-1,04 m (au plus 1,09 m), 1,06 m à 2 cm : sous l'incertitude affichée (±0,1 m) et l'arrondi au décimètre. Le maximum (« cas le plus défavorable ») est gardé. À revoir seulement si le bruit hors chaussée (herbe, sous les arbres) se révélait bien plus fort.*
- **Avant** : la chute est le plus grand écart entre le bord et le point le plus bas, sur tous les points et les 5 travers (« le
  cas le plus défavorable »).
- **Problème** : fossé de 1 m à fond plat, 100 tirages par niveau de bruit : chute moyenne 1,09 m (bruit de 3 cm), 1,15 m
  (5 cm), 1,24 m (8 cm), jusqu'à 1,46 m. Le maximum choisit le point le plus bruité. L'incertitude affichée (±0,11 m) ne couvre pas
  ce biais. Borne haute : le vrai bruit du MNT est en partie lissé d'un point à l'autre.
- **Piste** : altitude du fond lissée (moyenne des points à 5 cm du plus bas, ou sur 1 m), et deuxième plus forte chute des 5
  travers (ou la médiane) plutôt que la plus forte ; garder le maximum en information.
- **Gain** : chute juste à ±10 cm au lieu d'un biais de +10 à +25 cm.

**P10. Bord ramené à la médiane étiqueté « rupture de pente ».** *Position voulue (l'auteur, 19/11/2026). Faite le 19/11/2026 : 3e état « travers voisins » (champ `voisins` des profils, étiquette sous « bord », ligne de légende, compte dans l'infobulle), CALCULS.md § 8.2 et GUIDE.md accordés, test `BordsVoisins`. Dans les journaux de `essai-bords`, 5 côtés sur 12 ont 1 ou 2 travers d'après les voisins.*
- **Avant** : `_edge_reads` (lignes 1155-1156) donne à un travers sans rupture le bord médian des autres ; `_edge_falls`
  (ligne 1173) le compte alors comme trouvé dans le relief.
- **Problème** : « rupture de pente » sur le graphique et « relief sur 4 travers sur 4 » dans l'infobulle quand un travers est plat
  (vérifié : 3 travers à marche de 30 cm, 1 plat). `docs/CALCULS.md` § 8.2 et `docs/GUIDE.md` disent « demi-largeur BD TOPO ».
- **Piste** : un 3e état « d'après les travers voisins » (graphique, infobulle, compte), documentation accordée, test qui échoue
  sur le code actuel.
- **Gain** : on sait d'où vient chaque bord.

**P11. Calcul des bords refait à chaque rafraîchissement.**
- **Avant** : `refresh` appelle `fall_json` à chaque fois (`app.js:701`). Sur une photo dont le profil est calculé, `_edges` refait
  la fusion des 9 mailles, la projection de tous les tronçons, `_chained`, la liste des autres chaussées et `_water_across`, puis
  le profil (environ 350 points) passe en JSON et est relu par la page.
- **Problème** : travail répété à chaque clic et à chaque réponse réseau, dans Pyodide. Non mesuré.
- **Piste** : mesurer d'abord (durée de `fall_json` dans la page) ; si elle compte, garder la route choisie et l'eau par photo.
- **Gain** : à chiffrer.

**P12. Analyse fine : points du sol gardés pour rien.**
- **Avant** : `soil` (`nuage.js:292`) garde tous les points du sol des blocs lus (carré de 68 m), puis les parcourt 5 fois
  (`PAVED_STEPS`, ligne 364) pour n'en garder que ceux à ±5 m le long de la route.
- **Problème** : mémoire et 5 parcours d'environ 7 fois trop de points (68 m lus contre 10 m utiles).
- **Piste** : filtrer à l'ajout (`|le long| ≤ max(PAVED_STEPS) + STRIP`). Résultat identique par construction.
- **Gain** : à mesurer ; moins utile si P5 revient.

**P13. Un seul point hors LiDAR HD et tout passe en RGE ALTI.**
- **Avant** : `fetch_terrain` passe un paquet en RGE ALTI s'il manque un point LiDAR ; `_terrain` relit alors tout en RGE ALTI.
- **Problème** : altitudes à ±0,30 m au lieu de ±0,08 m, pas de dévers de plateforme, pour un point au bout d'un travers.
  Fréquence inconnue (bords de la couverture LiDAR HD).
- **Piste** : compter ces cas dans les essais avant de décider ; écarter les points manquants s'ils sont loin du bord.
- **Gain** : précision gardée près des limites de couverture.

**P14. Seuils pensés pour un bruit de ±5 cm.**
- **Avant** : `EDGE_HOLD` (trois pas), `STEP_Z` (5 cm), `PEAK_Z` (4 cm) et les commentaires de `docs/CALCULS.md` (« bruit du
  MNT ±5 cm ») supposent un bruit de 5 cm.
- **Problème** : mesuré à 0,7-1 cm sur chaussée (P9). Les seuils sont donc prudents : une bordure basse ou un séparateur
  étroit peuvent passer inaperçus.
- **Piste** : mesurer aussi le bruit hors chaussée (herbe, fossés), puis essayer des seuils plus fins sur `essai-bords` et
  `essai-passages`, avec P2 comme référence.
- **Gain** : bordures et séparateurs plus fins trouvés, à vérifier.

### Graphique et fenêtre : pistes

**G1. Exagération visible.**
- **Avant** : « Hauteurs à l'échelle » cochée à chaque ouverture (voulu) ; le facteur (×3…) n'est écrit que dans la légende.
- **Problème** : à l'échelle, environ 23 px par mètre : une bordure de 15 cm fait 3,5 px. Exagéré, rien sur le graphique ne le dit.
- **Piste** : « ×3 » écrit sur le graphique, près de l'axe des hauteurs ; dernier choix retenu.
- **Gain** : on lit les petits reliefs sans se tromper d'échelle.

**G2. Clé de lecture visible.**
- **Avant** : légende repliée à chaque ouverture (voulu), une dizaine de paragraphes.
- **Problème** : couleurs et tirets sans clé au premier regard.
- **Piste** : une rangée de pastilles sous le graphique (sol, travers voisins, chute, dévers, bord, eau, végétation), seulement pour
  ce qui est dessiné ; le texte reste replié.
- **Gain** : graphique lisible seul, aussi dans le PNG.

**G3. Hypothèses distinctes des mesures.** (reprend P4)
- **Avant** : un bord BD TOPO ou d'après les voisins a le même trait qu'un bord trouvé.
- **Problème** : on prend une hypothèse pour une mesure.
- **Piste** : trait du bord plus pâle et en tirets longs pour « largeur BD TOPO » et « d'après les travers voisins » (P10), et
  l'invitation à l'analyse fine dans ce cas seulement.
- **Gain** : le doute se voit.

**G4. Valeurs au survol.**
- **Avant** : aucune interaction sur le graphique.
- **Problème** : pour lire une distance ou une hauteur, il faut compter les graduations.
- **Piste** : réticule au survol : distance au bord, hauteur par rapport à la plateforme ; mise en évidence d'une chute ou d'un
  dévers et de sa ligne dans la légende.
- **Gain** : lecture directe, sans légende.

**G5. Où est le travers.**
- **Avant** : la fenêtre est modale et couvre la photo ; le travers n'est dessiné ni sur la carte ni sur la photo.
- **Problème** : difficile de relier « talus à droite à 3 m » à ce qu'on voit.
- **Piste** : tracer le travers de la photo (et les bords trouvés) sur la carte pendant que la fenêtre est ouverte, puis sur la photo.
- **Gain** : le graphique se relie au terrain.

**G6. Commandes regroupées.**
- **Avant** : neuf commandes sur une rangée (deux interrupteurs, analyse fine, légende, loupe, PNG, PDF, 2e page, fermer).
- **Problème** : rangée qui passe sur deux lignes, sans ordre visible.
- **Piste** : trois groupes : Affichage (échelle, végétation, légende, loupe), Analyse fine, Enregistrer (PNG, PDF, 2e page).
- **Gain** : on trouve plus vite.

**G7. Profil en long plus lisible.**
- **Avant** : 102 px de haut sous le travers ; sa légende n'est que sur la 2e page du PDF.
- **Problème** : ponts, carrefours et pente maximale serrés ; repères sans lien avec les travers à ±5 et ±10 m.
- **Piste** : hauteur adaptée, marques des 5 travers sur l'axe des distances, sa ligne de légende dans la fenêtre aussi.
- **Gain** : les deux graphiques se lisent ensemble.

**G8. Contraste et couleurs.**
- **Avant** : travers voisins à 45 % d'opacité, travers mesurés à 55 % ; herbe et végétation en deux verts proches ; chute orange
  et dévers rouge.
- **Problème** : traits pâles, couleurs proches pour un œil daltonien.
- **Piste** : vérifier les contrastes en thème clair et sombre ; motif en plus de la couleur (pointillés pour l'herbe).
- **Gain** : lisible pour tous, à l'écran et en PDF.

**G9. Largeur des étiquettes mesurée.**
- **Avant** : `declutter` estime la largeur (0,56 × taille par caractère) : le SVG n'est pas encore dans la page.
- **Problème** : chevauchements ou écarts inutiles selon la police.
- **Piste** : écarter les étiquettes après l'insertion (`getComputedTextLength`).
- **Gain** : modeste ; à faire avec G2.

### Retirés à la vérification

- Optimisation de `drawVegetation` (deux boucles imbriquées) : 256 cases au plus (±32 m, cases de 0,25 m), moins d'une
  milliseconde.
- Pentes du profil en long manquantes après `_bridged` : les distances restent sur la grille de 2 m, les fenêtres de 10 m existent.
- Médiane basse des bords : voulue (« le bord le plus proche »).
- Texte trop petit : seulement en fenêtre étroite (la fenêtre va jusqu'à 52rem) ; la version mobile est figée.

### Ordre proposé

1. ~~P10~~ (fait le 19/11/2026, avec le premier test du banc synthétique : début de P1).
2. ~~P7 et P8~~ (faits le 19/11/2026 ; reste la vérification sur routes réelles, P2).
3. ~~P9~~ (mesurée le 19/11/2026 : biais de 3 à 6 cm, pas de correction).
4. G1, G2, G3.
5. P5 (annuler 306eae1), P12.
6. G4, G5, G6, puis P3, G7, G8, G9, P6, P11 et P13 selon les mesures.
