<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Couche SIG : pistes d'améliorations et d'optimisations

Liste du 15/11/2026, mise à jour le même jour : O0, O1, O2, A, B, D (CSV) et E faits, C et F écartées, le reste à faire. Elle couvre l'onglet « Couche » (`src/couche.js`, `src/app.js`), le dessin des
objets dans la photo (`overlay_marks`, `py/web_app.py`) et sur la mini-carte (`Carte.showOverlay`, `src/carte.js`).
Les gains de vitesse de O3 à O5 sont déduits de la lecture du code et des mesures de O0.

Ordre proposé :
1. O3 (A, B, D et E faits, C et F écartées), puis O4 si la carte gêne en pratique ; O5 pas justifié (voir O0).

## Optimisations

**O0. Essai de charge.** *Fait.*
- **Essai** : `tests/essai-charge.html` (`tools/essais.sh essai-charge`, environ 25 s, hors de l'essai complet : il
  donne des chiffres, pas un verdict de vitesse). 5 088 objets (1 Mo) fabriqués en recopiant la couche synthétique
  (`tests/donnees/couche-synthetique.geojson`, 58f51ee) avec un décalage de ±40 m ; 346 parties à moins de 100 m de
  la photo.
- **Mesures du 15/11/2026** (Chrome sans fenêtre, processeur graphique) :
  - `set_overlay` 25 ms ; import complet 0,26 s, gardé dans IndexedDB aussitôt après ;
  - sol LiDAR HD de la première photo : 3 à 6,6 s pour 1 390 altitudes (réseau) ;
  - `overlay_marks` 15 ms par appel ;
  - redessin de la photo (`refresh`) : 52 ms avec la couche, 0,9 ms sans (environ 290 pastilles HTML) ;
  - vue tournée : 60 images/s avec ou sans la couche (plafond de l'écran) ;
  - carte déplacée à chaque image (`jumpTo`, donc étiquettes recalculées à chaque image : pire cas, plus dur qu'un
    glissé à la souris) : 37 images/s avec la couche, 60 sans.
- **Conclusions** :
  - O3 : le redessin de 52 ms se sent à chaque clic (environ trois images à 60 images/s). `overlay_marks` en prend 15 ms (une
    fois par redessin, plus la vignette), le reste vient des pastilles HTML. O3 ne gagne que sur la part Python.
  - O4 : seul ralentissement visible de la carte, mais mesuré dans le pire cas. À refaire à la main avant de s'y mettre.
  - O5 : la rotation reste à 60 images/s ; pas justifié.

**O1. Sol LiDAR gardé par sommet, et non par photo.** *Fait (a0b6887).*
- **Fait** : un seul cache `{(lon, lat): altitude}` pour toute la couche (`overlay_ground`, sommets en cours dans
  `overlay_asked`), seuls les points absents sont demandés (900 au plus par photo). Rien n'est dessiné tant que le sol
  de la caméra se lit, chaque objet une fois ses sommets lus ; sans réponse en 5 s (`OVERLAY_TIMEOUT_MS`), objets à
  plat. Essais dans `tests/test_calculs.py`.
- **Avant** : `overlay_ground` est indexé par photo (`photo -> {(lon, lat): altitude}`). À chaque nouvelle photo, on
  relit l'altitude de tous les sommets à moins de `OVERLAY_REACH` (100 m) : jusqu'à `OVERLAY_MAX` points (900), soit
  6 requêtes de `OVERLAY_CHUNK` (150).
- **Problème** : les objets ne bougent pas, et deux photos voisines d'une séquence ont presque les mêmes objets autour
  d'elles. En attendant les altitudes, les objets sont dessinés à plat, à la hauteur de caméra, puis ils sautent.
- **Piste** : un seul cache `{(lon, lat): altitude}` pour toute la couche, vidé quand la couche change. On ne demande que
  les sommets absents.
- **Gain** : en avançant dans une séquence, il ne reste presque plus de requêtes, et les objets ne sautent plus.
- **Attention** : garder la limite de 900 points par photo, pour les nouveaux sommets seulement.

**O2. Couche gardée dans IndexedDB plutôt que dans `localStorage`.** *Fait.*
- **Fait** : texte de la couche sous la clé « couche-texte » de la base `web-measures` (celle de `fileStore`), écritures
  enchaînées (`overlayWrite`) ; ancienne clé `localStorage` reprise une fois puis vidée ; `localStorage` en repli sans
  IndexedDB. Essais : `essai-libre` (reprise), `essai-rtk` et `essai-releve` (réglages gardés).
- **Avant** : `saveOverlay` écrit tout le GeoJSON dans `localStorage` (clé « couche », `src/app.js`). Au-delà
  d'environ 5 Mo, l'écriture échoue : la couche n'est pas retrouvée à la séance suivante (« trop grosse »).
- **Piste** : la page se sert déjà d'IndexedDB (`fileStore`) pour retrouver le fichier importé. On y range aussi le texte
  de la couche, ce qui porte la limite à des centaines de Mo.
- **Attention** : reprendre une fois l'ancienne clé `localStorage`, puis la retirer.

**O3. Index spatial des objets** (O0 : `overlay_marks` 15 ms pour 5 000 objets, gain modeste).
- **Aujourd'hui** : à chaque redessin de la photo (`overlay_marks`, et aussi pour la vignette), on parcourt tous les
  sommets de toute la couche pour garder ceux à moins de 100 m.
- **Piste** : un découpage en cases de 100 m, construit dans `set_overlay`. On ne parcourt que les 9 cases autour de la
  caméra.
- **Gain** : il ne compte qu'avec une grosse couche, de plusieurs milliers d'objets, ou de longues lignes découpées tous
  les `OVERLAY_STEP` (5 m).

**O4. Étiquettes de la mini-carte dessinées par la carte elle-même** (O0 : 37 images/s au lieu de 60, pire cas).
- **Aujourd'hui** : jusqu'à `OVERLAY_LABEL_MAX` (200) étiquettes, à partir du zoom 16, sont des repères HTML. Elles sont
  recréées après chaque déplacement de la carte, avec `querySourceFeatures` sur les voies et le calcul d'écart aux
  voies (`awayFromRoad`).
- **Piste** : une couche de texte de la carte (`symbol`), tracée par la carte graphique, avec l'anti-chevauchement
  intégré. Les polices de l'IGN sont déjà branchées depuis les fonds vectoriels (0.7.9).
- **Gain** : les étiquettes suivent le déplacement sans recalcul.
- **À perdre** : l'écart aux voies sur mesure. L'anti-chevauchement le remplace en partie.

**O5. Objets dans la photo dessinés par la carte graphique** (O0 : pas justifié, rotation à 60 images/s).
- **Aujourd'hui** : les pastilles et les traits de la couche sont des repères HTML. Les mesures, elles, passent par la
  carte graphique depuis la 0.6.15.
- **Gain** : un affichage plus léger quand beaucoup d'objets sont à moins de 100 m.
- **Coût** : le plus gros travail des optimisations, à ne faire que si O0 montre un ralentissement.

## Améliorations

**A. Parcours de vérification des objets.** *Fait.*
- **Fait** : rubrique repliable « Parcours des objets » de l'onglet Couche (`showObjectTable`, `goToObject`,
  `src/app.js`) : tableau (nom, colonne de l'étiquette, statut) trié par un clic sur un intitulé, recherche dans tous
  les attributs ; ◀ / ▶ dans l'ordre du tableau. La photo est celle de la fiche automatique (recalage, sinon la plus
  proche), tournée vers l'objet dessiné, ou vers sa position s'il est masqué ou à plus de 100 m. Statut et commentaire
  dans les colonnes `verif` et `verif_note` (10 lettres au plus : Shapefile), ajoutées au premier statut : gardées,
  enregistrées, exportées, proposées pour la couleur. Essai : `essai-rtk` (tableau, recherche, vue tournée, statut, ▶).
- **Statuts** : « vérifié », « à revoir », « absent » (arbre abattu, panneau déposé : à retirer dans QGIS par
  `verif = 'absent'`), ou vide (non vérifié).
- **Écart avec la piste** : statut dans les attributs plutôt qu'à côté comme les recalages, pour qu'il arrive dans QGIS
  et le CSV.
- **Tableau des objets** dans l'onglet Couche : triable, avec une recherche par identifiant ou par attribut.
- **Boutons ◀ / ▶ « objet précédent / suivant »** : chacun ouvre la photo la plus proche, tournée vers l'objet. Les
  fonctions existent déjà : `Carte.nearestPhoto`, et la vue tournée comme pour les étiquettes.
- **Colonne de statut** (« vérifié », « à revoir », avec un commentaire), gardée comme les recalages et écrite dans
  l'export.
- **Usage** : passer en revue un inventaire, panneaux ou arbres par exemple, objet par objet, sans le chercher sur la
  carte.

**B. Modifier la couche importée.** *Fait.*
- **Fait** : dans la rubrique « Parcours et modification des objets » (`showObjectAttributes`, `objectEdited`,
  `src/app.js`), un champ par colonne pour l'objet choisi (ligne du tableau, ou clic sur l'objet dans la photo) ; vide :
  null, nombre si la colonne en a déjà ; texte : valeurs des autres objets proposées (`datalist`, valeur nouvelle possible,
  demande de l'auteur du 15/11/2026), nombre : rien, colonne oui / non (booléens ou « oui » / « non ») : case à cocher. « Supprimer l'objet » après confirmation (numéros refaits, couche renvoyée au
  calcul) ; « ＋ Ajouter un objet » : un point posé d'un clic sur la mini-carte, colonne « id » au plus grand
  numéro + 1 (demande de l'auteur du 15/11/2026). Gardé avec la couche, « Enregistrer »
  actif, exporté. Essai : `essai-rtk` (attribut, ajout, suppression).
- **Pas fait** : ajout d'une ligne ou d'un polygone, ajout d'une colonne, déplacement d'un objet sur la carte (le
  recalage reste propre à une photo). Un point visé dans les photos passe toujours par le relevé.
- **Attention** : la suppression vide le cache du sol LiDAR (`set_overlay`) ; les altitudes se relisent.
- **Attributs** : les modifier dans la fiche de l'objet.
- **Objets** : en supprimer, ou en ajouter directement dans la couche. Aujourd'hui, il faut un relevé séparé, puis
  « Envoyer dans Couche ».
- **Enregistrement** : les modifications sont gardées comme les recalages et partent dans l'export.

**C. Projections coniques conformes et autres systèmes.** *Écartée (15/11/2026) : l'auteur ne se sert que du Lambert 93 et
du WGS 84, déjà lus.*
- **Aujourd'hui** : `crsOf` (`src/couche.js`) ne lit que le WGS 84 et le Lambert 93 (2154). Or les collectivités
  exportent souvent en projection conique conforme : CC46 à CC48 pour la Bourgogne (EPSG 3946 à 3948), CC47 pour la
  Côte-d'Or.
- **Piste** : proj4js par jsDelivr, version épinglée. Il lit le système du `.prj`, du GeoPackage
  (`gpkg_spatial_ref_sys`) ou du GeoJSON (`crs`). Il faut d'abord connaître les définitions courantes (RGF93 CC, NTF
  Lambert II étendu).

**D. Import CSV et KML.** *CSV fait ; KML écarté (15/11/2026, à la demande de l'auteur : CSV seulement).*
- **Fait** : `csvLayer` (`src/couche.js`) : séparateur « ; », tabulation ou « , » (le plus fréquent de l'en-tête),
  guillemets, UTF-8 sinon Windows-1252 (Excel) ; position en WKT (colonne `wkt`, `geometry`…, relit l'export CSV des
  lignes et polygones) ou en X et Y (`x`, `lon`, `longitude`, `x_l93`…) ; WGS 84 ou Lambert 93 reconnu d'après les
  valeurs par `Couche.read` ; nombres reconnus (virgule acceptée), sauf les codes commençant par 0 (INSEE, PR) ; lignes
  sans position écartées. Essai : `essai-rtk` (Lambert 93 en X et Y, WKT).
- **CSV** : colonnes X/Y, ou longitude/latitude, reconnues par leur nom, en Lambert 93 ou WGS 84 (C écartée).
- **KML** : export courant de Google Earth et des téléphones.

**E. Filtre par attribut**, au-delà des yeux de la légende. *Fait.*
- **Fait** : liste « Filtre » de l'onglet Couche (colonne, condition =, ≠, <, >, vide, non vide, valeur), un seul
  critère ; test commun `overlayHiddenTest` (`src/app.js`) avec les yeux de la légende, pour la carte, la photo, la
  vignette, le tableau du parcours et les fiches. Nombres comparés en nombres, textes sans majuscules ; « ≠ » garde les
  objets sans valeur. Gardé avec la couche (`filtre`), bilan « n objets sur N ». Essai : `essai-rtk`.
- **Pas fait** : plusieurs critères (ET / OU), « contient » (la recherche du parcours le fait pour le tableau).
- **Exemples** : « hauteur > 3 », « état = mauvais ».
- **Effet** : il s'applique à la carte, à la photo, au tableau de A et aux fiches.

**F. Couche de la Géoplateforme sans fichier.** *Écartée (15/11/2026, à la demande de l'auteur).*
- **Principe** : charger par son service WFS une couche de la BD TOPO autour de la photo, par exemple les bâtiments, les
  murs ou les ponts. `wfs_url` existe déjà dans `py/core`.
- **Attention** : la BD TOPO est trop grossière pour caler la vue du dessus, mais elle suffit pour la consulter.

## Plus lourd, moins prioritaire

- **Plusieurs couches à la fois** : il faudrait une légende, un ordre d'affichage et un relevé par couche.
- **Export en GeoPackage** : il faut écrire du SQLite dans le navigateur. Le GeoJSON et le Shapefile couvrent
  aujourd'hui l'essentiel.
