<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Mode profil : pistes d'améliorations et d'optimisations

Liste du 17/11/2026. Elle couvre les boutons « Profils » et « Graphiques », la fenêtre du profil (`src/profil.js`), le calcul des
bords, de la chute et du dévers (`py/web_chutes.py`) et l'« Analyse fine » du nuage LiDAR HD (`src/nuage.js`, `src/reglages.js`).
Elle vient de la lecture de ces fichiers et des journaux des essais, sans mesure nouvelle sauf P5. **Réanalysée avec Opus le
jeudi 19/11/2026** : voir « Réanalyse du 19/11/2026 » en fin de document (constats vérifiés, mesures sur terrain synthétique,
pistes P7 à P13 et G1 à G9, nouvel ordre).

Ordre proposé le 17/11 : P1, P2, P3, P4, P5, P6. P5 a été faite puis retirée le 17/11/2026 (voir ci-dessous).

**P1. Tests rapides sur des profils synthétiques.** *Avancée le 19/11/2026 : banc `edges_on` dans `tests/test_calculs.py`, classes `BordsTalus` (P7, P8), `BordsVoisins` (P10) et `BordsCas` (plain-pied, butte, descente jusqu'au bout, fossé de 30 cm, bord loin des autres, séparateur à marches surélevé et en creux, glissières dos à dos, distance écrite). Les 7 cas types passaient déjà : le calcul s'y comporte comme voulu. Reste : les cas réels difficiles (bombement fort, fossé en V, accotement en pente douce) quand P14 touchera aux seuils.*
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

**P3. Faire de la largeur d'enrobé un vrai résultat.** *Écartée par l'auteur le 19/11/2026.*
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

**P5. Analyse fine : lire moins de blocs.** *Faite puis retirée le 17/11/2026 à la demande de l'auteur ; remise le 19/11/2026 après la réanalyse (voir « Ce que deviennent P1 à P6 »). Même résultat sur les 3 photos de `essai-nuage` (points du sol, bords et largeur d'enrobé, séparateur, eau, plateforme) ; requêtes 18 → 11, 26 → 11, 15 → 9, durée 19 → 11 s, 28 → 11 s, 15 → 9 s (A38 61dd94c4-e5d1-4eb0-9762-73a72f18b5cb, RD903bis 1640bc3f-e948-4239-a4c1-548dd748a16d, RD700 067e83ca-a3d8-4f2a-bbe6-0c10df70fc96).*
- **Avant** : elle lit les blocs qui touchent un carré de 68 m de côté. `download` attend 1,1 s entre deux requêtes : 12 à 28 s
  pour 12 à 26 requêtes (journaux de `tests/essai-nuage.html`).
- **Problème** : seule une bande sert (±34 m en travers, ±5 m le long de la route : travers voisins `PAVED_STEPS` et `STRIP`).
- **Piste** : ne garder que les blocs qui touchent cette bande, tournée dans le sens de la route (`Nuage.stripTest`).
- **Gain** : moins de requêtes, donc moins de secondes.
- **Fait puis retiré** (17/11/2026, commits 1ea0270 et 7910c5b ; code : `Nuage.stripTest`, `nodesIn(tile, box, strip)`). **Vérifié** le même jour, ancien et nouveau code chacun sur un
  cache vide, l'objet complet rendu par `Nuage.analyse` comparé (cases, lignes, herbe, séparateur, bords, largeur, végétation, eau) :
  identique sur 5 photos. Requêtes 26 → 11, 15 → 11, 15 → 10, 24 → 16, 12 → 12 ; durée 28 → 11 s, 16 → 11 s, 16 → 10 s, 26 → 18 s,
  12 → 12 s ; octets lus −56 %, −29 %, −32 %, −26 %, 0 (RD903bis, A38 66d45404-a22d-4b07-8bc8-1f3edcdf1b8a, RD 1074, D33, petite RD). Pas de gain quand la route
  traverse peu de blocs hors de la bande. Deux photos non comparées d'un code à l'autre (échec réseau ponctuel d'un côté, délai de
  l'autre) : A38 61dd94c4-e5d1-4eb0-9762-73a72f18b5cb et RD700, où seuls les points du sol et la largeur d'enrobé l'ont été (essai-nuage, mêmes valeurs).
  Contrôle de la bande dans `tests/essai-nuage.html` (retiré avec le code ; à retrouver dans 1ea0270).
- **Point à surveiller** : le niveau de blocs lus dépend du plus profond trouvé (`deepest`), maintenant calculé dans la bande et non
  dans le carré ; si le carré avait un bloc plus profond hors de la bande, l'ancien code lisait des blocs plus profonds, le nouveau des
  blocs un niveau plus haut. Aucun écart vu sur ces 5 photos.

**P6. Analyse fine automatique à l'ouverture des graphiques.** *Écartée par l'auteur le 19/11/2026.*
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
  bord du relief). *Début le 19/11/2026 sur les 3 photos communes à `essai-bords` et `essai-nuage` : le bord du relief est au-delà
  de l'enrobé (accotement compris) de 0,2 à 7 m, sauf à droite de l'A38 61dd94c4-e5d1-4eb0-9762-73a72f18b5cb (relief 3,0 m, enrobé 4,8 m : rupture de dévers
  sur la bande d'arrêt d'urgence, cas noté dans `nuage.js`). Le bord du relief n'est donc pas le bord d'enrobé : P2 vérifie qu'il
  n'est pas dedans (une erreur) ; elle ne valide pas le dévers, qu'il faudrait comparer à des talus mesurés.*
  *Faite le 19/11/2026 sur les 33 photos des pages d'essai (page temporaire, bords du calcul puis analyse fine sans les
  réinjecter) : 10 sur un pont, 4 sans BD TOPO (service injoignable), 2 identifiants inconnus ; 17 photos, 24 côtés où les deux
  bords existent (relief et enrobé).*
  - *14 côtés sur 24 : bord du relief au bord de l'enrobé ou au-delà (accotement), jusqu'à 7 m sur les chaussées séparées (herbe
    plate jusqu'au talus, comptée dans la plateforme).*
  - *4 côtés à 0,8-1 m en deçà de l'enrobé (D977BIS 1108ca14-6669-49e8-a26a-955becc79e81 et cd8cf3a0-6567-40f0-8805-94172a5dfc3c à gauche, D1074 6d99cba2-2284-4215-a3fb-1fd390353005 et D700 d63ace61-7261-4acb-93f9-788aed29cb23 à droite) :
    le terrain y fait une marche ou un caniveau, le bord du relief est à son pied ; l'enrobé du nuage compte sa partie en pente.
    Plausible des deux côtés.*
  - *2 côtés A38 (61dd94c4-e5d1-4eb0-9762-73a72f18b5cb à droite, 66d45404-a22d-4b07-8bc8-1f3edcdf1b8a à gauche, 0,8-0,9 m) : rupture de dévers sur la bande d'arrêt d'urgence.*
  - *3 côtés de l'autre côté de l'axe que la caméra : D70 229abfcd-868c-4eca-bfc1-3979ca94d28f à gauche (bord à 2 m, enrobé à 6,5 m : 3 % sous la caméra,
    8 % sur l'autre voie), D104 a04557c8-3b4d-4184-8b3e-ff7ed9fa4197 à gauche (2 m contre 3 m : sommet du bombement), D119M f533e240-7d37-40ef-babc-1d37140dc5d2 à gauche (4 m contre
    8,1 m, points non relus). La recherche du bord franchit l'axe et prend le changement de dévers d'une voie à l'autre pour le
    bord : voir P16.*
  - *1 côté à 0,45 m en deçà (D119M f533e240-7d37-40ef-babc-1d37140dc5d2 à droite).*
  - *Bord BD TOPO (rien dans le relief) : 3 côtés, tous dans l'enrobé, de 0,3 à 2 m (largeurs BD TOPO trop faibles) : voir P17.*
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

**P8. Dévers du talus sous-estimé.** *Faite le 19/11/2026 : haut avancé tant que le pas descend de moins de 5 %, pied au premier point à 5 cm du plus bas (`_taluses`, `EDGE_FLAT`), test `BordsTalus`. Terrain synthétique : dévers exact (50, 20, 100 %) ; avec 3 à 5 cm de bruit, 52 % pour 50 %, 22 % pour 20 %, 101 % pour 100 % (avant 39 %, 20 %, 75 %). Photos de `essai-bords` : chutes inchangées, dévers de 3 à 26 points plus forts (RD903bis 1640bc3f-e948-4239-a4c1-548dd748a16d : 25 → 51 % sans analyse fine, 34 → 47 % avec ; la droite du talus va maintenant de la cassure au pied, vérifié sur l'image du profil).*
- **Avant** : `_taluses` prend la pente moyenne du haut au pied ; le haut est au plus tôt le bord (P7), le pied est le point le plus
  bas jusqu'au bout de la dernière fenêtre de 2 m en pente.
- **Problème** : sur terrain exact, un talus de 1 m à 50 % sort à 33 %, à 20 % sort à 17 %, à 100 % (2 m) sort à 67 %, et un
  talus de 3 m à 50 % sort à 41 à 45 %. Le plat avant le haut (P7) et le plat du fond après le pied sont comptés dans la longueur.
  C'est la valeur qui dit si un talus est dangereux : elle est minorée.
- **Piste** : haut = dernier point avant la descente (après correction P7), pied = premier point à 5 cm du plus bas (comme la
  chute), ou droite ajustée sur le cœur du talus (pentes ≥ `EDGE_CORE` de la plus forte). Cas tests : les quatre talus ci-dessus.
- **Gain** : dévers juste à quelques points près sur talus net.

**P9. Chute surestimée par le bruit du terrain.** *Mesurée le 19/11/2026, pas de correction. Bruit réel du MNT LiDAR HD sur chaussée (grille de 12 × 12 points tous les 0,5 m sous 3 photos d'essai, 1640bc3f-e948-4239-a4c1-548dd748a16d, 61dd94c4-e5d1-4eb0-9762-73a72f18b5cb, 067e83ca-a3d8-4f2a-bbe6-0c10df70fc96) : 0,7 à 1,0 cm d'un point au suivant, 1,0 à 1,5 cm d'écart à un plan. À ce bruit, la chute d'un fossé de 1 m sort à 1,03-1,04 m (au plus 1,09 m), 1,06 m à 2 cm : sous l'incertitude affichée (±0,1 m) et l'arrondi au décimètre. Le maximum (« cas le plus défavorable ») est gardé. Hors chaussée, le terrain varie de 3 à 5 cm d'un point au suivant (médiane, voir P14) : en partie du relief réel (sillons,
mottes), qui compte dans une chute ; si c'était du bruit, la chute serait majorée de 10 à 15 cm. À trancher seulement avec des
fossés mesurés sur le terrain.*
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

**P11. Calcul des bords refait à chaque rafraîchissement.** *Mesurée le 19/11/2026, pas de changement : dans la page (Chrome, Pyodide), `fall_json` prend 1 ms une fois le profil calculé (Pouilly cd8cf3a0-6567-40f0-8805-94172a5dfc3c, RD903bis 1640bc3f-e948-4239-a4c1-548dd748a16d), 13 ms sur l'A38 61dd94c4-e5d1-4eb0-9762-73a72f18b5cb (chaussées séparées, beaucoup de tronçons) ; 9 à 13 000 caractères relus en moins de 0,1 ms. Moins d'une image d'écran, à chaque clic seulement.*
- **Avant** : `refresh` appelle `fall_json` à chaque fois (`app.js:701`). Sur une photo dont le profil est calculé, `_edges` refait
  la fusion des 9 mailles, la projection de tous les tronçons, `_chained`, la liste des autres chaussées et `_water_across`, puis
  le profil (environ 350 points) passe en JSON et est relu par la page.
- **Problème** : travail répété à chaque clic et à chaque réponse réseau, dans Pyodide. Non mesuré.
- **Piste** : mesurer d'abord (durée de `fall_json` dans la page) ; si elle compte, garder la route choisie et l'eau par photo.
- **Gain** : à chiffrer.

**P12. Analyse fine : points du sol gardés pour rien.** *Faite le 19/11/2026 (`SOIL_ALONG`, `nuage.js`) : résultat identique sur les 3 photos de `essai-nuage`.*
- **Avant** : `soil` (`nuage.js:292`) garde tous les points du sol des blocs lus (carré de 68 m), puis les parcourt 5 fois
  (`PAVED_STEPS`, ligne 364) pour n'en garder que ceux à ±5 m le long de la route.
- **Problème** : mémoire et 5 parcours d'environ 7 fois trop de points (68 m lus contre 10 m utiles).
- **Piste** : filtrer à l'ajout (`|le long| ≤ max(PAVED_STEPS) + STRIP`). Résultat identique par construction.
- **Gain** : à mesurer ; moins utile si P5 revient.

**P13. Un seul point hors LiDAR HD et tout passe en RGE ALTI.** *Comptée le 19/11/2026 : aucun profil en RGE ALTI dans les journaux de `essai-bords` (12 chutes, toutes à ±0,1 m : LiDAR HD) ; la Côte-d'Or est couverte. Rien à faire tant qu'aucun cas n'est vu.*
- **Avant** : `fetch_terrain` passe un paquet en RGE ALTI s'il manque un point LiDAR ; `_terrain` relit alors tout en RGE ALTI.
- **Problème** : altitudes à ±0,30 m au lieu de ±0,08 m, pas de dévers de plateforme, pour un point au bout d'un travers.
  Fréquence inconnue (bords de la couverture LiDAR HD).
- **Piste** : compter ces cas dans les essais avant de décider ; écarter les points manquants s'ils sont loin du bord.
- **Gain** : précision gardée près des limites de couverture.

**P14. Seuils pensés pour un bruit de ±5 cm.** *Mesurée le 19/11/2026, seuils gardés. Terrain le long de lignes parallèles à
la route (20 points tous les 0,5 m), sous les 10 photos de `essai-bords`, écart d'un point au suivant (médiane des photos) :
1,1 et 0,9 cm à 2 m de part et d'autre (chaussée), 3,0 et 4,7 cm à 6 m, 0,8 à 5,2 cm à 10 et 14 m, avec des pointes de 10 à
28 cm (fossés, talus, sillons : ce n'est pas que du bruit). Les seuils (marche de 5 cm, pic de 4 cm, écart de pente de 8 points
sur trois pas) agissent au bord, là où la chaussée cède la place à l'accotement : sur la chaussée ils ont de la marge (6 fois le
bruit), juste au-delà ils sont au niveau du terrain. Plus fins, ils trouveraient des marches dans l'accotement. Rien à gagner sans
cas réel d'une bordure manquée.*
- **Avant** : `EDGE_HOLD` (trois pas), `STEP_Z` (5 cm), `PEAK_Z` (4 cm) et les commentaires de `docs/CALCULS.md` (« bruit du
  MNT ±5 cm ») supposent un bruit de 5 cm.
- **Problème** : mesuré à 0,7-1 cm sur chaussée (P9). Les seuils sont donc prudents : une bordure basse ou un séparateur
  étroit peuvent passer inaperçus.
- **Piste** : mesurer aussi le bruit hors chaussée (herbe, fossés), puis essayer des seuils plus fins sur `essai-bords` et
  `essai-passages`, avec P2 comme référence.
- **Gain** : bordures et séparateurs plus fins trouvés, à vérifier.

**P15. Distance au bord mal arrondie.** *Faite le 19/11/2026 (test `BordsCas.test_distance_au_bord_ecrite`).*
- **Avant** : la distance de la chute (ou de l'arrêt) au bord était écrite au mètre, arrondie au pair par Python (0,5 → « 0 »,
  10,5 → « 10 ») dans l'encadré, et au-dessus par la page (10,5 → « 11 ») dans la légende du graphique.
- **Problème** : « chute de 0,6 m à 0 m du bord » ; encadré et légende en désaccord. Fréquent : les points sont tous les 0,5 m.
- **Piste** : au décimètre sous 10 m, au mètre au-delà, arrondi au plus proche des deux côtés (`_distance`, `dist`).
- **Gain** : distances justes et identiques partout.

**P16. Bord pris au sommet du bombement, de l'autre côté de l'axe.** *Faite le 19/11/2026 (`_edge_border`, `_crown_slope`,
`_edge_step(sharp)`, tests `BordsBombement`, dont deux travers relevés). Mise au point sur un banc hors ligne : profils complets
(5 travers, 2 côtés) et bord d'enrobé de l'analyse fine relevés pour 66 photos (33 des pages d'essai, 33 tirées au hasard sur toute
la Côte-d'Or par type de voie : chaussées séparées A6, A31, A36, A39, D8 ; réseau principal ; secondaire ; local ; petites voies),
rejoués avec des variantes de réglages. 42 photos complètes (6 sur une autre instance Panoramax, 10 sur un pont, réponses de l'IGN
manquantes), 61 côtés hors chaussées séparées. Bords sur l'enrobé (à plus de 0,25 m en deçà) : 28 (45 %) avant, 25 (40 %) après,
aucun côté dégradé. Écartés : la marche « nette » partout (séparateur de la D1074 perdu, bords côté caméra de la RD903bis et de la
RD700 reculés à 2 m : bordures et séparateurs sont adoucis par le MNT) ; une marche de 8 cm au lieu de 5 (34 % sur le banc, mais
mêmes pertes sur `essai-bords`). Restent sur l'enrobé : des marches de 6-7 cm dans l'autre voie (D70 229abfcd-868c-4eca-bfc1-3979ca94d28f, D965 67e087a0-ba74-42a4-b71f-2d063492b72e :
ornières, joints ou reprises, nettes et réelles), des bombements à plus de 1,25 m de l'axe BD TOPO (D115, D70 8d02bc6c-a3a9-444e-b005-e24f8a52177f : axe mal
placé), et 10 replis BD TOPO (P17). Vérifiée le 20/11/2026 : sans autre rupture après le bombement, le bord retombe
sur lui, près de l'axe. Essai « pas de bord, largeur type à la place » sur le banc (68 côtés, largeurs types prudentes de P17) :
2 côtés seulement bougent, les autres sont déjà ramenés à la médiane des travers voisins ; D16
b3978b33-2ceb-4ef3-bd51-09d25e505015 droit 2,00 → 2,50 m (enrobé 3,38, lu par la bordure de P21 ; 2,00 m juste, vérifié
par l'auteur le 20/11 : moins bien), D114 dc5520e1-ba0d-4690-97ec-b19282935ff9
gauche 2,00 → 4,63 m (enrobé 2,35 : moins bien ; axe BD TOPO décalé, la « rupture près de l'axe » était le vrai bord).
Les deux côtés se dégraderaient : gardé tel quel. Références du banc : enrobé de l'analyse fine relevé le 19/11 avec la bordure et le gravier (P21), sauf les
côtés vérifiés.*
- **Avant** : profil depuis la caméra (séquence RTK) : du côté opposé à sa voie, la recherche du bord part de la caméra, avec la
  pente de sa voie comme référence, et traverse l'axe.
- **Problème** : au sommet du bombement, ou là où le dévers change d'une voie à l'autre, la pente s'écarte de plus de 8 points de
  la référence : bord trouvé sur la chaussée (P2 : 3 côtés sur 24, jusqu'à 4,5 m en deçà de l'enrobé). La plateforme est trop
  étroite, chute et dévers partent du milieu de la route.
- **Piste** : quand une rupture est suivie d'une pente de chaussée (moins de 8-10 %, régulière sur 2 m) et qu'une autre rupture
  vient avant la fin de la recherche, la première est un bombement : reprendre la référence après elle et chercher la suivante.
  Cas tests : toit à 2,5 et 4 %, dévers différents par voie ; vérification sur les 24 côtés de P2.
- **Gain** : bord juste du côté opposé, le plus souvent faux aujourd'hui quand le bombement est marqué.

**P17. Largeur BD TOPO trop faible quand le relief ne dit rien.** *Mesurée sur le banc de P16 : 7 replis sur 61 côtés, de 2 m en deçà de l'enrobé en
médiane (jusqu'à 9 m : M996 6eea86cc-4c40-4395-9686-2418892bfa82, 10,5 m d'enrobé). Faite le 19/11/2026 selon la règle de l'auteur (« la BD TOPO n'est pas
fiable pour les largeurs, elle sert juste à qualifier en grandes catégories ») : la largeur BD TOPO n'est qu'une valeur par
importance (7, 5,5, 4 m), trop faible ; remplacée dans les bords de route par une largeur type par importance, médiane de l'enrobé
mesuré (9 m en 1-2, 6,5 m en 3, 6 m en 4, 3,5 m en 5, 7 m par chaussée séparée ; `_road_width`), pour la portée de la recherche,
le repli et l'autre chaussée. Banc : replis 7 → 4, bords sur l'enrobé 25 → 23 sur 61 (valeurs tirées des mêmes photos : un peu
flatteur). Le repli s'appelle « largeur type ». Reste à montrer qu'il est une hypothèse (G3). La chute sur les ponts prend aussi la largeur type quand le MNT ne contient pas le tablier (P20). Valeurs ramenées le 20/11/2026 à 7 m (importance 1 et 2), 6 m (3), 5,5 m (4), 3,5 m (5) : les médianes de l'analyse fine comptaient trottoirs et gravier (P21) ; à refaire sur des largeurs vérifiées.*
- **Avant** : sans rupture de pente, le bord est à la demi-largeur BD TOPO.
- **Problème** : P2 : 3 côtés sur 3 dans l'enrobé, de 0,3 à 2 m (largeurs BD TOPO souvent celles de la seule chaussée).
- **Piste** : à mesurer sur plus de cas avant de choisir (marge fixe, ou inviter à l'analyse fine, déjà proposée par G3).
- **Gain** : bord de repli moins souvent sur la chaussée.

**P18. Mur de soutènement lu comme un talus.** *Faite le 19/11/2026 : au-delà de 150 % (`WALL_SLOPE`), « paroi quasi verticale (mur, enrochement) » avec sa hauteur, sans pourcentage ; « paroi » sur le graphique (tests `BordsTalus.test_mur`, `BordsCas.test_mur_sous_la_route`). Reconnaître un mur d'un enrochement demanderait le nuage de l'analyse fine (largeur de la transition, classe des points) : à essayer sur des murs connus.*
- **Avant** : sous la route, un mur est un talus très raide : « dévers du talus 400 % (76°) » sur terrain synthétique (mur vertical
  de 2 m), au plus 76° au pas de 0,5 m ; le MNT, qui adoucit les parois, en ferait 100 à 200 %.
- **Problème** : le chiffre laisse croire à une pente mesurée ; on ne distingue pas un mur d'un enrochement raide. La chute (hauteur)
  reste juste. Au-dessus de la route (déblai), le mur arrête la lecture : « pas de chute », juste.
- **Piste** : au-delà d'environ 150 % (56°), écrire « paroi quasi verticale (mur, enrochement) » sans pourcentage ; repère sur le
  graphique.
- **Gain** : pas de fausse précision sur les murs.

**P19. Glissière ignorée.**
- **Avant** : le MNT n'a que le sol ; une glissière au bord ne change rien au calcul : la chute derrière elle est annoncée comme sans
  protection. Son assise (bosse de quelques centimètres) déplace au plus le bord de 0,5 m (terrain synthétique).
- **Problème** : pour un audit de sécurité, une chute derrière une glissière n'est pas une chute libre.
- **Piste** : dans l'analyse fine, points hors sol (classe à vérifier : non classés ou « sursol pérenne ») alignés le long du bord à
  0,5-1 m de haut : « glissière probable » près de la chute. D'abord vérifier leur classe sur des glissières connues (A38, RD700
  067e83ca-a3d8-4f2a-bbe6-0c10df70fc96).
- **Mesuré le 20/11/2026** (nuage LiDAR HD, 60 × 60 m autour de l'A38 61dd94c4-e5d1-4eb0-9762-73a72f18b5cb et de la RD700
  067e83ca-a3d8-4f2a-bbe6-0c10df70fc96 ; `pdal translate <url_npl> --readers.copc.threads=1 --readers.copc.bounds=…`) :
  aucune classe propre aux glissières, ni « sursol pérenne » (64) : classe 1 (non classé) à gauche sur les deux routes, 3 et 4
  (végétation basse et moyenne) pour 75 % de la glissière droite de l'A38. Hauteur lue 0,35 à 0,43 m au-dessus du sol (p10-p90
  0,2 à 0,6 m : le laser voit la face de la lame, pas sa hauteur réelle). 0,7 à 1,8 point par mètre, discontinue sur la RD700
  (tranches de 5 m vides) ; à l'A38 gauche, deux lignes à 1 m l'une de l'autre. Ce qui la distingue de la végétation : la forme,
  pas la classe (95 à 100 % des points dans une bande de 0,6 m en travers, contre 17 à 39 % pour les talus et haies voisins, plus
  hauts, 0,6 à 1 m, et plus denses, 5 à 19 points par mètre). Un muret de béton au pied d'un talus (RD700 droite) a la même
  forme ; seule l'intensité l'en sépare (environ 1 700 contre 200 à 500 pour l'acier). Pour la chute, la distinction est
  inutile : un muret retient aussi (« dispositif de retenue probable »).
- **Avant de coder** : deux glissières et un muret ne suffisent pas pour régler des seuils (leçon de P21). Il faut un lot de
  photos vérifiées : une dizaine avec glissière ou muret, une dizaine sans (haie, herbe haute, clôture au bord), réglage sur
  une moitié et jugement sur l'autre.
- **Gain** : la chute dit si elle est protégée.

**P20. Bord du tablier d'après la BD TOPO (chute sur un pont, voie de secours).** *Faite le 19/11/2026, à la demande de l'auteur
(« la largeur du tablier doit être calculée dans la couche LiDAR »).*
- **Avant** : sans points classés pont dans le nuage, le dessous était lu à 1, 3, 6 et 10 m au-delà de la demi-largeur BD TOPO.
- **Problème** : largeur BD TOPO non fiable. Sur le pont de la D114 (ruisseau de la Gironde, photo
  e375c98e-31c5-426a-ba93-c63ac344d675), le nuage n'a aucun point classé pont : le tablier y est classé sol (surface plate au
  niveau de la route, parapet en points non classés), donc compris dans le MNT.
- **Fait** : coupes en travers tous les 0,5 m ; si le terrain sous l'axe est au niveau du tablier (GPS, 0,5 m près), bord du
  tablier trouvé dans le relief comme un bord de route, sinon demi-largeur type. Le calcul par le nuage (points classés pont)
  passe toujours avant et lit le tablier lui-même. Test `ChuteTablier` (chenal étroit au pied du tablier : 4,0 m, 1,0 m avant) ;
  `essai-ponts` : D114, bords trouvés dans le relief sur 14 coupes sur 16, chute 1,8 m (1,7 m avant).

**P21. Analyse fine : trottoir et gravier comptés en enrobé.** *Essayée le 19/11/2026 (bordure lue à l'altitude du sol,
gravier sombre), retirée le 20/11/2026 : largeur d'enrobé moins bonne qu'avant à l'usage (auteur).*
- **Avant** : le bord d'enrobé de l'analyse fine ne lit que l'intensité du retour laser (première bande 2,2 fois plus claire).
  Vérifié à la main sur 5 photos (9 côtés, vue du dessus) : il déborde dans les 5 cas, de 2 à 9 m (D8
  082893e5-f336-441b-8d28-0eecdbae1dde, M996 6eea86cc-4c40-4395-9686-2418892bfa82, M70 20a5b40f-ab06-40ab-97e1-b3f74032bec7,
  D119M f533e240-7d37-40ef-babc-1d37140dc5d2 : trottoir en enrobé ; D70 c6c065fa-90ad-40bd-a5f1-513c72e7400b : gravier).
- **Problème** : c'est la référence du banc des bords (tools/banc-bords.py) et des largeurs types de P17 ; la page reprend aussi
  ces bords pour la plateforme, la chute et le dévers.
- **Essai retiré** : bordure (point bas puis remontée d'au moins 4 cm qui tient sur 1 m, altitude médiane des points du sol par
  case de 0,25 m) et gravier (bande à 1,25 fois l'enrobé jusqu'aux abords), bord de chaque travers le plus proche des deux.
  Écart au vrai bord 30 → 2,5 m, mais sur les 9 côtés qui ont servi au réglage ; presque chaque condition visait une photo
  (gravier : D70 c6c065fa-90ad-40bd-a5f1-513c72e7400b ; ligne blanche : RD903bis 1640bc3f-e948-4239-a4c1-548dd748a16d ; voie
  plus claire : D1074 6d99cba2-2284-4215-a3fb-1fd390353005 ; 2 m de l'axe : M70 f85566ac-8b7a-46a2-a9c2-4df0a3fa6e20) ; 17
  autres côtés rapprochés de 0,1 à 1,8 m sans vérification, dont 1 faux sur 3 regardés ; le gravier n'était gardé qu'à 0,5 m
  du bord du relief, auquel le banc le compare ; « le plus proche des deux » laisse gagner toute fausse bordure (4 cm, près du
  bruit d'une case).
- **Piste, si reprise** : vérifier d'abord à la main un lot de côtés qui ne sert pas au réglage, et juger dessus ; pas de
  condition propre à une photo ; bord de l'enrobé indépendant du bord du relief.
- **Gain** : bord d'enrobé juste en ville (trottoirs) ; banc et largeurs types sur une référence fiable.

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
5. ~~P5, P12~~ (faites le 19/11/2026).
6. G4, G5, G6, puis G7, G8, G9 (P3 et P6 écartées par l'auteur ; P11, P13 et P14 mesurées le 19/11/2026 : rien à faire).
