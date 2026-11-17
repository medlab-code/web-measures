<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Mode profil : pistes d'améliorations et d'optimisations

Liste du 17/11/2026. Elle couvre les boutons « Profils » et « Graphiques », la fenêtre du profil (`src/profil.js`), le calcul des
bords, de la chute et du dévers (`py/web_chutes.py`) et l'« Analyse fine » du nuage LiDAR HD (`src/nuage.js`, `src/reglages.js`).
Elle vient de la lecture de ces fichiers et des journaux des essais, sans mesure nouvelle sauf P5. **À réanalyser avec Opus le
jeudi 19/11/2026** (l'auteur) : vérifier chaque constat avant de s'y fier.

Ordre proposé : P1, P2, P3, P4, P5, P6. P5 a été faite puis retirée le 17/11/2026 (voir ci-dessous).

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
