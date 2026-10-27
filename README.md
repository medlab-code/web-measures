# Mesures Panoramax (web-measures)

Application web de mesure sur les photos de rue [Panoramax](https://panoramax.fr), sans
installer QGIS : hauteur d'un objet, largeur d'une chaussée, distance entre deux points, à
préparer ou vérifier depuis le bureau.

Elle reprend les calculs du plugin QGIS
[Visionneuse Panoramax](https://github.com/medlab-code/visionneuse_panoramax), validés sur
des photos imajbox 360 HD à position RTK (Pouilly-en-Auxois, Montbard, Semur-en-Auxois…).

![Mesures Panoramax : hauteur et largeur depuis des points triangulés, à Châteauneuf](docs/demo.jpg)

## Principe

Toutes les mesures s'appuient sur des **points triangulés** : un même point est visé depuis
au moins deux photos, et sa position est l'intersection des visées. La profondeur vient
ainsi de la triangulation, et non plus du terrain ni de la hauteur de caméra, auxquels les
mesures sur une seule photo étaient trop sensibles.

La précision dépend donc de celle de la position et du cap des photos : les mesures sont
fiables sur des photos à **position GPS RTK vérifiée** (voyant RTK vert). Ailleurs, elles
restent possibles, mais la page prévient qu'elles seront probablement incohérentes.

## Utilisation

**Télécharger** : prendre l'archive `web-measures-X.Y.Z.zip` de la dernière version
(page *Releases* du dépôt) et la décompresser ; elle ne contient que la page et ses fichiers.

**Ouvrir la page** : double-cliquer sur `index.html` suffit (Edge, Chrome, Firefox), sans
installation ni serveur ; une connexion à internet est nécessaire (bibliothèques, Pyodide et
services). Elle peut aussi être publiée sur n'importe quel serveur web statique, ou servie
localement :

```
python3 -m http.server 8765    # puis http://127.0.0.1:8765/
```

**Première utilisation** : l'instance Panoramax de l'IGN et les photos du conseil
départemental de la Côte-d'Or sont choisies par défaut, car elles remplissent les prérequis
des mesures (précision RTK, modèle de terrain IGN : LiDAR HD, ou RGE ALTI là où il n'est pas encore publié) ; une fenêtre l'explique. On peut changer ces
réglages dans « Filtre » (instance comprise), et les choix sont ensuite gardés. Une
première photo s'ouvre (Clos de Vougeot, D974), tournée vers l'ouest.

**Le panneau** (sous la mini-carte) : une ligne d'état (calcul, chargement, échecs ; le texte entier
d'un clic), puis les onglets **Résultats** (en tête, le nombre de points et de mesures, exportés ou non, et les exports CSV et
GeoJSON ; chaque point de référence avec ses mesures dessous, fiche PDF, commentaire par ✎), **Photo** (en tête, date,
producteur et caméra, étoile des favoris, identifiant à copier ; position : précision GPS, sol, inclinaison
et calage, chacun avec son voyant ; détails ; « Aller à une photo » par son identifiant ou un lien ; export et
import du calage), **Favoris**
(photos favorites, export et import) et **Couche**, avec le nombre de résultats et de
favoris sur l'onglet ; en bas, les boutons **Filtre** (instance Panoramax, filtre des photos ; point orange quand un filtre est actif),
**Réglages** (hauteur de caméra, thème, options) et **Services**. La consigne de
mesure est dans la carte d'étape de la visionneuse. Thème jour ou nuit : comme le système par défaut, ou choisi
dans Réglages. Une section
s'affiche à la fois ; la dernière choisie est rouverte à la visite suivante.

**La carte** : fonds Plan IGN, orthophoto, ortho-express, PCRS, OpenStreetMap, et
**orthophoto avec noms** : noms des lieux et des rues, voies, avec les numéros de route dans
des cartouches dessinés comme ceux de l'IISR (rouge pour les autoroutes et nationales, jaune
pour les départementales, cyan pour les métropolitaines, vert pour les européennes), limites
des départements (bleu), de la métropole (vert) et des communes (tirets noirs). Les
autoroutes et nationales paraissent dès le zoom 7, les départementales dès le zoom 10, les
autres voies dès le zoom 15. Les points de repère sont dessinés en bornes (tête à la couleur
du réseau, numéro du PR), à côté de la voie, avec ce fond seulement. Le filaire Panoramax, semi-transparent, se
masque par sa case à cocher.

**Choisir une photo** : cliquer sur le filaire orange de la carte (photo la plus proche) ; la
photo s'ouvre dans la visionneuse officielle Panoramax. Les flèches de la visionneuse passent
aux photos voisines, et le **lecteur de séquence** en bas de la visionneuse la fait défiler en
avant ou en arrière (chaque appui sur un sens : 1x, 2x, 4x, 8x, 16x). On peut aussi y aller
par le **requêteur route + PR**, ou coller l'**identifiant** d'une photo (ou un lien
Panoramax) dans « Aller à la photo » ; « 📋 Copier » sous l'identifiant de la photo affichée
le copie, pour la passer à un collègue.

**Mesurer** : bouton « Mesure », puis le mode. Pendant la mesure, une carte d'étape en bas à gauche de
la visionneuse donne la mesure et ses étapes (pied puis sommet, premier bord puis bord opposé), l'état
(triangulation ou mesure en cours) et la consigne ; le haut de la photo et les flèches restent libres. Le
bouton **« ✔ Valider le point triangulé »** y apparaît, avec un halo,
dès que les visées donnent un point (deux visées qui se croisent).

**Prise de mesure guidée** :

1. La photo de la première visée est la **photo de référence** : la mesure se fera sur elle ;
   choisir celle d'où l'objet se voit le mieux.
2. Des boutons sous la consigne proposent les photos à viser ensuite : en hauteur, la
   précédente et la suivante de la référence, puis celle de l'autre côté pour une 3e visée ;
   en largeur, en avançant vers le point. Ils sont nommés par rapport à la photo affichée
   (« photo précédente », « 2 photos en arrière »…), avec une flèche selon leur direction dans
   la vue (◀ ▶ ▲ ▼).
3. Les visées déjà faites depuis les autres photos sont tracées en trait plein vert dans la
   photo, à partir de 2 m de la caméra qui les a faites : l'objet visé est sur leur trait, il suffit de cliquer là où il croise la bordure (en
   hauteur, le bon montant parmi des objets semblables). La vue de chaque nouvelle photo est
   tournée vers le point visé, et un trait vertical au centre de la vue suit le même cap que le
   trait de la mini-carte, pour repérer dans la photo un objet vu sur la carte.
4. Après « Valider le point triangulé », la page revient sur la photo de référence et cadre la
   vue sur le point.

Une visée qui s'écarte nettement des autres est signalée (autre objet visé ?). Quand les
visées sont presque alignées et les photos RTK, le point est triangulé en 3D (inclinaison des
visées, sol LiDAR HD lu au point). Si la vérification RTK ou l'inclinaison automatique arrivent
après les clics, tout est recalculé : une mesure peut changer d'elle-même une ou deux secondes
après.

- **Hauteur d'un objet**
  1. Viser le **pied** de l'objet depuis au moins deux photos (un clic par photo, flèches
     pour changer de photo), puis « Valider le point triangulé » : c'est le point de référence,
     et le pied de la hauteur.
  2. Cliquer seulement le **sommet**, depuis une photo qui a servi à la visée : le pied est la
     visée faite depuis elle, à la profondeur du point triangulé. Depuis une autre photo,
     cliquer le pied puis le sommet.

  Une fois la hauteur faite, les clics ne servent plus qu'à l'ajuster (clic sur une de ses
  croix, puis nouveau clic sur la photo de la mesure ou flèches ↑ ↓ : 1 cm sur la verticale).
  Le point de référence se recale de même dès qu'il est validé, sur sa verticale (seule
  l'élévation du clic compte). Pour une autre hauteur depuis le même point, depuis n'importe
  quelle photo, cliquer « ↺ Nouvelle mesure depuis A » dans la visionneuse (elle repart du pied
  recalé, s'il l'a été) ; pour un autre point, « Nouveau point de référence ». Une verticale
  verte le repère dans la photo, tracée selon le calage de l'inclinaison. Sur la photo de la
  première hauteur depuis ce point, le sommet des suivantes est pris sur le prolongement de sa
  ligne (pied–sommet), au plus près du clic : le réticule y glisse, avec un trait jaune en
  travers (un clic sur une croix la sélectionne toujours).
- **Largeur perpendiculaire à la chaussée**
  1. Viser le **premier bord** (pied de bordure, marquage…) depuis au moins deux photos, puis
     « Valider le point triangulé ». La page trace la **droite de mesure**, perpendiculaire à l'axe de
     la route en ce point (BD TOPO, sinon trajectoire de la séquence), en bleu dans la photo
     et sur la carte.
  2. Cliquer le **bord opposé** sur la photo de référence (ou une photo prise quelques mètres
     avant ou après le point, pas juste en face) : seule la direction du clic compte, le bord
     est là où elle coupe la droite. Il reçoit la lettre suivante (B…), sur une étiquette
     grise tant qu'il n'est pas triangulé ; l'étiquette de la mesure nomme ses deux points
     (« A↔B 7,50 m ± 0,20 m »). Le sommet d'une hauteur est nommé de même (« A↕C 3,20 m »).
  3. Facultatif, plus précis : **« 🎯 Trianguler le point B »**. Le clic de l'étape 2
     compte comme première visée ; viser le même bord depuis la photo proposée, puis « Valider
     le point triangulé ». Le point garde sa lettre (étiquette bordeaux) ; la largeur devient la
     distance des deux bords triangulés,
     perpendiculaire à l'axe de la route, et la vue revient sur la photo de référence, cadrée
     sur la largeur. Pendant ces visées, les autres photos ne montrent que les visées.

  **Droite tracée sur la carte** (expérimental, case « Droite de mesure tracée sur la carte » des
  réglages, décochée par défaut ; giratoire, carrefour, place, où l'axe automatique se trompe) :
  avant la première visée du premier bord, « 📏 Tracer la droite sur la carte » dans la
  visionneuse, puis, sur la mini-carte, un clic d'un côté de la voie (point de départ, pas un
  point de mesure) : un trait suit la souris, une croix au bout ; un second clic de l'autre côté
  fixe l'orientation (4 m au moins ; Échap annule). La droite est tracée en bleu dans la photo.
  Le premier bord se pose alors d'un clic, sans visées depuis plusieurs photos : là où la
  direction du clic coupe la droite, comme le bord opposé ; le pointeur glisse sur la droite.
  Une photo qui voit la droite presque en enfilade (moins de 10°) est refusée. « Annuler la
  droite » revient à l'axe automatique jusqu'au clic du premier bord. La droite ne sert qu'une
  fois : la largeur suivante reprend l'axe automatique, qui reste celui par défaut. Le résultat
  se lit alors « Largeur le long de la droite tracée sur la carte … depuis le point A · droite
  à 75° (tracée sur la carte, ±2,4°) ».

  Sur une photo qui a servi à viser un bord, sa croix est là où il a été visé, et la droite
  de mesure passe par la croix du premier bord.

  Une fois la largeur faite, les clics ne servent plus qu'à l'ajuster (clic sur une de ses croix, puis nouveau clic ou flèches : 1 cm le long de la droite de mesure). Pour une autre largeur depuis le même point, cliquer « ↺ Nouvelle mesure depuis A » dans la visionneuse.

  À l'étape 2 de la hauteur et de la largeur, les flèches de la visionneuse sont masquées
  (elles gênent les clics de mesure) : on change de photo par la carte.
- **Hauteur de chute sur un pont** (automatique, sans clic) : sur une photo prise sur un pont
  de la BD TOPO, le nom du pont, ce qu'il franchit et la hauteur de chute la plus grande sur
  toute sa longueur s'affichent en haut à gauche de la visionneuse (pas pendant la lecture de
  la séquence). Calcul :
  - **tablier** : altitude GPS des photos de la séquence prises sur le pont, convertie en
    altitude NGF, moins la hauteur de caméra ; pour chaque point, la photo la plus proche ;
  - **dessous** : modèle de terrain LiDAR HD (RGE ALTI en secours) lu en travers du pont, à 1,
    3, 6 et 10 m au-delà du bord de la chaussée (largeur BD TOPO, sinon 6 m), des deux côtés,
    tous les 2 m (plus espacé sur un long pont) ; sous le tablier, le modèle de terrain est
    interpolé à sa hauteur : le fond se lit à l'écart ;
  - **hauteur** : la plus grande différence entre les deux, avec son incertitude (altitude RTK,
    tablier tiré des photos : dévers, bordure ; terrain) ; l'infobulle dit où elle est. Au-dessus de l'eau, c'est le
    niveau de l'eau le jour du relevé LiDAR, pas le fond.

  Pas de valeur sans position RTK vérifiée (l'altitude du tablier serait fausse de plusieurs
  mètres) ; « non mesurée » sous 0,5 m (terrain non distingué du tablier : végétation, buse) ;
  « calcul impossible » avec sa cause (service injoignable, pas d'altitude GPS sur le pont, pas
  de modèle de terrain). Un creux sans rapport avec ce que franchit le pont, à moins de 10 m de
  la chaussée (fossé profond), augmente la valeur.
- **Chute et dévers des bords de route** (bouton « Dévers » de la barre du haut, ticket #31) :
  sur une photo hors pont, à moins de 15 m d'une route de la BD TOPO, un appui sur « Dévers »
  affiche en haut à gauche, pour chaque côté (vu dans le sens de la photo) qui descend d'au
  moins 0,5 m, la hauteur de chute et le dévers du bord. La réglette à côté du bouton fixe la
  distance examinée au-delà de la chaussée (2 à 30 m, 10 m par défaut) ; après l'avoir changée,
  un nouvel appui refait le calcul. Le bouton est grisé sur un pont (hauteur de chute du pont),
  pendant la lecture et quand le calcul est déjà fait pour cette photo et cette distance.
  Calcul :
  - **profils** : modèle de terrain LiDAR HD (RGE ALTI en secours) lu en travers de la route à
    −10, −5, 0, +5 et +10 m de la photo le long de la route, des deux côtés, depuis la caméra
    (séquence vérifiée RTK ; sinon depuis l'axe BD TOPO) : un point tous les 0,5 m jusqu'à 3 m
    au-delà du bord BD TOPO, puis 16 points jusqu'à la distance de la réglette au-delà du bord ;
  - **bord de la chaussée** : premier point, à 1,5 m au moins de l'origine, d'où la pente du
    terrain sur 1 m s'écarte de plus de 8 points de celle de la chaussée sous l'origine, dans
    le même sens, sur trois pas de suite (fossé, talus, bordure) ; sans rupture de pente
    (accotement de plain-pied), la demi-largeur BD TOPO (sinon 3 m) ; l'infobulle dit où le bord
    a été trouvé, et comment ;
  - **chute** : la plus grande descente entre le terrain au bord de la chaussée et le point le
    plus bas du profil, avec la distance de ce point (le plus proche du bord, à 5 cm près) ;
    « chute ≥ … au-delà de 10 m du bord » quand le point le plus bas est au bout du profil (le
    terrain descend encore : pousser la réglette) ;
    ne dépend pas de l'altitude GPS : pas besoin de RTK ;
  - **dévers** : la plus forte pente vers le bas entre deux points du profil écartés d'au
    moins 2 m, en % et en degrés.

  Sinon s'affichent « Calcul en cours… », « Aucun bord ne descend de 0,5 m ou plus », « Pas de
  route de la BD TOPO à moins de 15 m » ou « Calcul impossible » avec sa cause.

  Le bouton **« Profil »**, à côté, montre la coupe du terrain que ce calcul a lue (mesure LiDAR
  HD, ou RGE ALTI en secours) : travers de la photo en brun, les quatre autres en pointillés,
  chaussée entre les deux bords trouvés (et comment : rupture de pente ou largeur BD TOPO),
  flèche de la chute et trait rouge du dévers sur le travers où ils ont été mesurés, hauteurs
  exagérées (facteur écrit sous le graphique). « Enregistrer en PNG » en fait une image avec son
  titre et sa légende. Le bouton est grisé tant que « Dévers » n'a rien calculé pour la photo.
- **Mesure libre (points triangulés)** : viser chaque point depuis au moins deux photos, puis
  « Valider le point triangulé » ; à partir du deuxième, la distance horizontale au point précédent
  s'affiche, et la carte se cadre sur le segment.
- **Relevé d'objets (couche SIG)** : viser chaque objet (un arbre d'un alignement, par exemple)
  depuis au moins deux photos, puis « Valider le point triangulé » ; après une seule visée,
  « Garder sur cette seule photo » propose de le poser là où la visée touche le sol, avec sa
  précision (sol supposé plat, plus imprécise que la triangulation : sinon, viser depuis une autre
  photo). « 📍 Placer sur la carte », puis un clic sur la mini-carte, pose un objet sans le viser
  (`nb_visees` 0, ±1 m : précision des orthophotos IGN ; projeté au sol dans les photos). Au premier
  objet, on définit les champs du relevé (nom, type : texte, nombre, date,
  oui/non, liste de valeurs) ; ils reviennent pour chaque objet suivant (✎ dans les résultats pour
  les modifier), avec un commentaire, et d'autres peuvent s'y ajouter en cours de route (vides pour
  les objets déjà relevés) ; un champ texte propose dans une liste les valeurs déjà
  saisies sur les autres objets. Voie, PR et commune de l'objet s'ajoutent d'eux-mêmes.
  **Modèles de champs** : au premier objet, la liste « Modèle » remplit les champs d'un modèle
  enregistré (modifiables ensuite) ; des champs nouveaux (aucun modèle identique) peuvent être
  gardés comme modèle d'une case à cocher, à l'enregistrement de l'objet. Dans l'onglet Couche, le
  bouton ▤ enregistre les colonnes de la couche comme modèle (sans celles que remplit
  l'application, ni la position, ni les colonnes techniques d'un KML converti, casse ignorée ; type
  d'après les valeurs : nombre, oui/non, date AAAA-MM-JJ, liste s'il y a 12 valeurs de 40 caractères
  au plus, chacune deux fois en moyenne, sinon texte). Les modèles restent dans le
  navigateur ; « Exporter » et « Importer » les échangent par un fichier JSON avec un autre poste
  (un modèle importé remplace celui de même nom).
  Le relevé terminé, « Envoyer dans Couche » l'affiche dans l'onglet Couche
  (couleurs et étiquettes selon ses champs, recalage, export GeoJSON ou CSV : colonnes `id`, champs,
  `voie`, `pr`, `commune`, `commentaire`, puis le reste, dont `z_ngf`) ; une couche déjà chargée
  peut être enregistrée avant d'être remplacée. Le relevé reste dans le navigateur d'une séance à
  l'autre jusqu'à « Vider » ; « Tout effacer » ne le retire que depuis ce mode.
  Chaque objet se voit sur toutes les photos à 100 m au plus : là où il a été visé, sinon à son
  altitude (photos RTK : `z_ngf`, exportée), et projeté au sol seulement sans elle.

Repères visuels :

| | Visées (triangulation) | Prise de mesure | Calage |
|---|---|---|---|
| Liseré de la visionneuse | bleu | jaune | orange |
| Étiquette animée, en haut à gauche | « Triangulation en cours » | « Mesure en cours » | — |
| Cercle du pointeur | bleu | jaune (vert si l'inclinaison est calée) | orange |
| Croix | bleues | jaunes | — |

Points, traits et étiquettes restent visibles sur toutes les photos (là où ils ont été
cliqués, ou projetés au sol sur les autres photos). Dans la photo, la droite de mesure d'une
largeur est en tirets bleus, la verticale d'une hauteur en tirets verts ; sur la carte, les
visées de triangulation sont en tirets rouges.

**Effacer** (ou **Ctrl+Z**, aussi dans la carte détachée) : annule le dernier geste
(**Refaire**, Ctrl+Y ou Ctrl+Maj+Z le rétablit, si rien n'a été fait depuis). La
dernière visée seule (les autres restent ; le bord B garde sa première, le clic de la largeur),
le dernier clic de l'objet vertical du calage, la sélection ou la mesure en cours ; sans rien en
cours, le dernier point posé (sommet, bord opposé, puis le point de référence ; en mesure libre,
le dernier point gardé). Quand la photo affichée est à plus de 100 m des mesures, la page propose
de tout effacer pour repartir de zéro. Échap annule le tracé d'une droite sur la carte.

**Fiche PDF** : bouton « 📄 Fiche » d'un point de référence dans les résultats, puis le choix de la
photo : « Cadrage automatique » (ci-dessous) ou « Vue actuelle » (la visionneuse telle qu'affichée,
sans changer de photo : la fenêtre se ferme, on recadre la vue et la mini-carte sous les cadres jaunes de
la photo et de la carte de la fiche, tracés dès l'ouverture de la fenêtre, puis « Valider le cadrage » ; la
mini-carte est alors reprise telle que recadrée), et un titre libre (« point de référence A » par défaut, après
« Fiche de mesure — »). Une page A4
(plusieurs si le tableau ou la méthode ne tiennent pas : leur fin passe sur la page suivante, sous le même
en-tête marqué « (suite) », jamais une ligne seule d'un côté de la coupure)
s'ouvre dans une fenêtre à part et la boîte d'impression du navigateur propose « Enregistrer au
format PDF ». La page contient la photo d'où la plus grande mesure du point a été prise, cadrée
sur ses deux bouts (une hauteur sur 75 % de la hauteur de l'image ; une largeur avec 10 % de
marge, puis dézoomée de deux crans de molette), l'image recentrée sur
la mesure, avec ses repères ; la localisation (sur un pont, son nom et ce qu'il franchit après la
commune) ; le tableau du point et de ses mesures, avec les
commentaires ; la méthode et la précision, en lignes courtes (position de la photo,
puis par mesure ce qui n'est pas dans le tableau : distance et caméra, ou axe et angle de visée,
sans répéter ce qui est déjà dit, ni le nom de la mesure) ; la mini-carte centrée sur le point, les mesures et la photo, au zoom choisi dans la page
(même échelle qu'à l'écran), avec le cône de vue et le nom du fond de carte et de son producteur ; l'identifiant de la photo,
son attribution et son lien Panoramax, aussi en QR code. La mini-carte manque si elle est repliée.

**Couche importée** (onglet « Couche » du panneau : bouton « Importer un fichier… », ou fichier glissé sur
l'onglet) : un fichier GeoJSON, Shapefile (en .zip, ou le
.shp choisi avec son .dbf et son .prj ; reprojeté d'après le .prj) ou GeoPackage (table au choix s'il
en a plusieurs), en WGS 84 ou en Lambert 93 (converti), dessiné sur la mini-carte et dans la photo, à l'altitude du fichier (z, en NGF) ou posé
sur le sol LiDAR HD, lu sous la caméra et sous les objets (lignes redécoupées tous les 5 m pour
suivre le terrain ; à plat à la hauteur de caméra en attendant, ou sans LiDAR) : points en pastilles, lignes et contours des polygones en traits, pour les objets à moins
de 100 m de la photo. Couleur selon une colonne : une couleur par valeur (palette Set1 de ColorBrewer
sans son gris, prolongée de huit couleurs : seize valeurs, les plus fréquentes, puis par ordre alphabétique, les autres et les vides en gris), ou, pour une
colonne numérique d'au moins 11 valeurs, dégradé entre les couleurs du minimum et du maximum choisies
dans la légende (chaque objet prend leur mélange pondéré par sa valeur), étiquette d'une colonne dans la photo, précédée de son intitulé si la case est cochée (« essence : tilleul ») et suivie d'un texte fixe au choix (unité : « 12 cm »), plus une 2e étiquette d'une autre colonne, aux mêmes réglages, sur une 2e ligne, étiquette de la mini-carte (à partir du zoom 16) d'une autre colonne au choix, « id » par défaut (sans tenir compte de la casse), sinon la première, légende (un clic sur une pastille : palette ; « Couleurs par défaut »).
Étiquettes en texte seul, de la couleur de l'objet éclaircie de moitié, liseré noir, jamais recouvertes
par une pastille, placées de l'objet le plus proche de la photo au plus lointain : remontées en cas
de chevauchement, masquées s'il faudrait les remonter de plus d'une fois et demie leur hauteur. Sa fiche, en tête de l'onglet, donne le nombre d'objets, le système de
coordonnées et le nombre d'objets recalés ; son œil masque la couche sans la retirer, ses icônes l'exportent,
la remplacent par un autre fichier ou la retirent. Le dégradé se règle par les pastilles aux deux bouts de sa
barre. Un œil sur chaque valeur de la légende masque ses objets sur la carte et dans la photo (gardé avec
la couche, par colonne ; l'export garde tous les objets). Une couche à la fois, gardée avec ses réglages dans le
navigateur d'une session à l'autre (sauf si elle est trop grosse : un message le dit) ; « Retirer »
l'efface. **Enregistrer** (disquette, grisée tant que rien n'a changé) : les recalages sont réécrits dans le
fichier GeoJSON importé (Chrome, Edge : fichier choisi par « Importer » ou glissé, retrouvé à l'ouverture suivante, en
WGS 84), sans rien demander s'il n'a pas changé depuis l'import ou le dernier enregistrement (sinon : écraser,
enregistrer sous, ou annuler ; effacé ou déplacé : « Enregistrer sous » aussitôt ; le navigateur demande l'autorisation d'écrire une fois par séance) ; sinon (Firefox, Shapefile, GeoPackage, relevé envoyé), « Enregistrer sous » en GeoJSON, puis ce fichier-là.
**Fiche PDF d'un objet** (hors mesure) : clic droit sur sa pastille ou son étiquette dans la
photo (photo cadrée sur l'objet ou vue actuelle, tableau de ses attributs, mini-carte) ; les données
affichées et leur ordre (flèches ou glissé-déposé) se choisissent dans la fenêtre de la fiche et restent pour les objets suivants de la
couche, et le texte ajouté après la valeur de l'étiquette y est repris. **Recalage dans la photo** (hors mesure) : clic sur la pastille ou l'étiquette d'un objet,
puis clic à sa place vue dans la photo, flèches pour l'ajuster (0,05°), Entrée pour finir, Suppr pour
le remettre à sa place calculée ; décalage propre à cette photo, la carte n'est pas modifiée. Gardé
avec la couche ; « Exporter » écrit un GeoJSON (WGS 84) où chaque objet porte ses
recalages (membre `recalages` du Feature, hors attributs, ignoré par QGIS : décalage, position et
séquence de la photo) : importé sur un autre poste, les objets y reviennent à leur place. À l'import,
ou en ouvrant une photo à moins de 30 m d'une photo recalée d'une autre séquence (même voie, autre
sens ou autre passage) sans recalage sur la sienne, une fenêtre propose d'aller sur la photo recalée
(une fois par séquence refusée).

**Résultats gardés** : ils sont enregistrés dans le navigateur à chaque changement ; à
l'ouverture suivante, ceux de la session précédente qui n'ont pas été exportés sont proposés à
l'export (CSV, GeoJSON) ou à l'oubli, et affichés en lecture seule : liste sous les résultats,
traits et points gris sur la carte. Ils ne redeviennent pas des mesures modifiables, et sont
oubliés à la fermeture de cette session-là s'ils n'y ont pas été exportés.

**Revoir une mesure exportée** : le fichier de mesures GeoJSON importé (bouton d'import, flèche vers le haut, de l'onglet
**Résultats**, ou import de l'onglet **Couche**, où il s'affiche) s'ouvre sur la photo d'où la première hauteur ou largeur a été prise, cadrée sur elle,
la mesure dessinée telle qu'elle était à l'écran (colonnes `photo_ref` et `vue_ref`), avec sa valeur
en étiquette (colonne `etiquette`). Un clic sur une autre mesure de la mini-carte la montre de même.
En lecture seule ; les fichiers exportés avant la version 0.6.6 n'ont pas ces colonnes.

**Recaler un point** : **clic** (gauche ou droit) sur sa croix pour le sélectionner, puis :

- clic gauche : nouvelle position (largeur : bord ou point de référence, là où la direction
  du clic coupe la droite de mesure, dont ils ne sortent jamais ; le point de référence se
  recale ainsi dès qu'il est validé ; hauteur : sur la photo de la mesure) ;
- flèches du clavier, par pas de 1 cm : largeur, le long de la droite de mesure (← → dans le
  sens vu sur la photo, ↑ ↓ en s'éloignant ou en se rapprochant de la caméra) ; hauteur,
  ↑ ↓ montent ou descendent le point ;
- **Entrée** pour terminer.

**Caler les photos** (mode « Calage : inclinaison ») : inclinaison calculée automatiquement
d'après les verticales de la photo (en arrière-plan), ou calée à la main : pied puis sommet de
deux objets verticaux, à environ 90° l'un de l'autre. Le calage du cap et de la position
(repères sur la carte) n'est pas proposé : le cap n'entre presque pas dans les hauteurs et les
largeurs, et le cap EXIF des photos de relevé est déjà juste à 0,3° près. Un calage importé
du plugin QGIS qui en contient reste appliqué.

Les consignes de chaque calage disent l'étape en cours et ce qui est déjà fait.

Le calage est gardé d'une visite à l'autre, et peut être exporté ou importé (onglet « Photo »).

**Inclinaison par le terrain hors agglomération** (« Réglages », expérimental, décochée par
défaut) : en rase campagne, les verticales de la photo manquent presque toujours (2 % des photos
calées hors zone d'habitation) et l'inclinaison reste à ±2°. Cochée, quand les verticales
échouent, la page :
1. lit le terrain LiDAR HD sous la caméra sur une grille de ±2,5 m × ±1,5 m (55 points, une
   requête) : sa pente et son dévers ;
2. cherche dans la même séquence des photos de village (zones d'habitation de la BD TOPO à
   moins de 15 km, jusqu'à 3 photos par zone, des plus proches aux plus lointaines) et les cale
   par leurs verticales en arrière-plan, jusqu'à 3 réussies (12 analysées au plus, environ 9 Mo
   chacune ; une fois par séquence) ;
3. en tire le décalage de la fixation de la caméra (inclinaison des références moins leur
   terrain), et l'ajoute au terrain sous la photo.

La ligne d'état dit l'étape (« calcul par le terrain en cours (photos de référence : 2 calées sur
6 analysées) »), puis « inclinaison calée par le terrain, expérimental (±0,6°) », ou la cause d'un
échec (pas de LiDAR HD sous la photo, trop peu de photos de village calées). L'incertitude des
mesures en tient compte. Le roulis du véhicule en virage n'est pas corrigé ; le RGE ALTI n'est
pas utilisé (talus et murs pris pour la route).

**Autour de la mesure** :

- voyants **RTK**, **LiDAR HD** (ou **RGE ALTI** en secours) et **inclinaison** de la photo ;
- fonds de carte : Plan IGN, orthophoto, Ortho-express de l'année de la photo, PCRS de la
  Géoplateforme là où il est publié, OpenStreetMap ; recherche de lieux ; points de repère
  (PR) des routes ; requêteur route + PR (+ distance), à listes qui se réduisent à la frappe ;
- lieu de la photo incrusté en bas à gauche de la visionneuse : route, PR et distance mesurée
  le long du filaire IGN depuis le dernier PR passé, nom de la voie, hameau ou quartier (zone
  d'habitation de la BD TOPO qui contient la photo, sinon la plus proche à moins de 100 m, sauf
  le bourg), commune ; hors route
  départementale, la véloroute suivie et l'écluse la plus proche (chemins de halage) ;
- lecteur de séquence (1x à 16x), date et producteur en bas à droite ;
- carte cadrée automatiquement sur la mesure en cours (mesure libre : sur le segment qui vient
  d'être mesuré) ;
- carte **détachable** dans une fenêtre à part, à placer sur un second écran (bouton « ⧉ » sous
  le zoom, Edge, Chrome et Firefox récents) : elle reste reliée à la page et se déplace à la
  souris ; fermer la fenêtre, ou
  « Remettre la carte ici » dans la colonne, la remet en place ;
- **filtre des photos** (date, type, précision GPS, producteur) et choix de l'**instance**
  Panoramax : les photos écartées ne s'ouvrent pas, ni par la carte ni par les flèches ;
- captures : vue recalculée en Full HD depuis la photo originale, ou visionneuse avec les
  mesures (PNG, copiée dans le presse-papiers) ;
- liste des résultats avec commentaire et effacement de chacun ; **export CSV**
  (point-virgule, virgule décimale) et **GeoJSON** : valeur, incertitude, composantes,
  distance à la photo, hauteur de caméra, axe de la route, photos, date, commentaire, photo
  d'où la mesure a été prise et repères vus dessus (pour la revoir), et attributs des points
  triangulés (visées, croisement, précision GPS).

Fichiers exportés (mesures, captures, favoris, calage, couche) : boîte d'enregistrement du système sous
Chrome et Edge (emplacement et nom au choix, demandés dès le clic pour une capture). Firefox n'en donne
pas l'accès aux pages : le fichier est téléchargé, avec sa boîte si « Toujours vous demander où
enregistrer les fichiers » est coché (Paramètres › Général › Fichiers et applications).

Les calculs sont ceux du plugin, exécutés dans le navigateur par Pyodide (environ 10 Mo au
premier chargement, puis en cache) ; les calculs lourds (inclinaison automatique, capture
Full HD) tournent dans un second Pyodide en arrière-plan. La page vérifie aussi l'accès aux
services depuis le poste (bouton « Services » en bas du panneau).

Pour s'ouvrir en `file://`, la page n'utilise pas de modules JavaScript ni de lecture de
fichiers voisins : scripts ordinaires, et fichiers Python regroupés dans `py/sources.js`.

## Précision

Essais sur deux photos imajbox à position RTK (±0,10 m) de Pouilly-en-Auxois, distantes de
5 m, sur des cibles connues (`tests/essai-rtk.html`, `essai-largeur.html`,
`essai-libre.html`) :

| Mesure | Résultat | Attendu |
|---|---|---|
| Point de référence (visées croisées à 54°) | ±0,17 m | sur la cible |
| Hauteur | 3,46 m ± 0,11 m | 3,464 m |
| Largeur (clic à 40° de la droite de mesure) | 8,00 m ± 0,33 m | 8 m |
| Distance entre deux points | 3,60 m ± 0,24 m | 3,606 m |
| Objet relevé sur une seule photo, à 6 m (`essai-releve.html`) | ±0,2 à 0,8 m selon le calage de l'inclinaison | à moins de 1 m de la cible |

Inclinaison par le terrain (24/10/2026, 7 séquences CD21) : 14 photos témoins hors des villages
de référence, prises en hameau ou en sortie de village à 56 à 67 km/h et calées par leurs
verticales (8 endroits distincts, 5 séquences), comparées à l'inclinaison tirée du terrain et du
décalage appris sur les photos de village de leur séquence (écart quadratique moyen) :

| Méthode | Pente | Dévers |
|---|---|---|
| Sans terrain (inclinaison moyenne des références) | 1,6° | 1,2° |
| Grille du cœur (±1,5 m × ±0,8 m) | 0,6° | 0,8° |
| **Grille large (±2,5 m × ±1,5 m), retenue** | **0,5°** | **0,6°** (0,7° à un témoin par endroit) |
| Grille large + roulis 3°/g, 4,5°/g, 6°/g | 0,5° | 0,6°, 0,7°, 0,9° |

En rase campagne, sans bâtiment, aucune photo n'a d'arêtes verticales : pas de témoin possible
à plus de 70 km/h. Le seul virage témoin (0,3 g) est mieux sans correction du roulis (+0,4°)
qu'avec (−1,1° à 4,5°/g), contrairement aux 16 photos de village du 23/10 : correction retirée.
À confirmer sur des longueurs connues en rase campagne (largeur de voie, tirets de 3 m),
mesurées l'option cochée et décochée.

Hauteur de chute (`tests/navigateur.html`, `tests/essai-ponts.html`, ticket #27), d'après les
profils LiDAR HD relevés autour des ponts : 6,3 m pour le pont de la D111 au-dessus de l'A6 à
Beaune ; 4,3 m pour la D977 bis au-dessus du canal de Bourgogne (tablier à 361,4 m, eau à
357,4 m) ; 1,7 m pour la D114 au-dessus du ruisseau de la Gironde à Barbirey-sur-Ouche (lit
vers 314 m, route à 315,8 m). Le terrain lu à 1 m du bord seulement donnait 2 m et 0 m : il
tombait sur le talus de la culée.

Chute et dévers des bords de route : la chute est une différence de deux altitudes du même
modèle de terrain (±0,1 m en LiDAR HD, ±0,4 m en RGE ALTI). Le dévers est sous-estimé sur un
talus plus court que l'écart de 2 m plus le pas des points (0,67 m pour 10 m examinés) : un
talus fictif de 2 m à 150 % donne 125 %. Sous des arbres ou un mur, le modèle de terrain est
interpolé et adoucit la pente. Le bord de la chaussée vient de la largeur BD TOPO : une
largeur fausse décale la référence. Pas encore comparé à des talus de hauteur connue.

L'incertitude de la largeur vient surtout de l'axe de la route et de la position du point de
référence le long de la route. Sur une séquence RTK vérifiée, l'axe est la direction de la
trajectoire sur ±20 m (±0,5°) quand elle est droite (photos à moins de 10 cm de leur droite,
chaque sens de passage sur sa voie) et concorde à 2° près avec la BD TOPO, sinon le tronçon de
la BD TOPO (±2° supposés ; ±0,48 m à Pouilly avec elle seule), ou la droite tracée sur la carte
(chaque clic à ~0,3 m près : ±2,4° pour une droite de 10 m, ±6° pour 4 m ; premier bord à
±0,17 m à 10 m de la caméra, plus quand la photo voit la droite en biais). Essai
(`tests/essai-largeur.html`) : droite tracée à 10° de la perpendiculaire, premier bord posé
d'un clic sur la cible, bord opposé à 8 m le long de la droite : 7,99 m ± 0,48 m. Un clic depuis une photo plus
éloignée, qui voit la droite plus en face, réduit aussi l'incertitude. Avec un GPS grand public
(±4 m), le point de référence est à plusieurs mètres près, et une hauteur à ±2 à 3 m.

### Limites

- Mesures fiables seulement sur des photos à position RTK vérifiée.
- Points projetés sur les autres photos que celle du clic : sol supposé plat, à la hauteur
  de caméra de la photo (affichage seulement, la mesure n'en dépend pas).
- Triangulation 3D validée sur des cas simulés seulement : à confirmer sur des points
  relevés sur le terrain.
- Incertitude de l'axe de la route (±0,5° pour la trajectoire RTK, ±2° pour la BD TOPO, ±3°
  pour la trajectoire sans RTK) estimée,
  à confirmer sur le terrain.
- Mesures non rechargées à l'ouverture suivante : affichées en lecture seule et proposées à
  l'export pendant la session suivante seulement (dans ce navigateur), puis oubliées.

### Organisation

| Fichier | Rôle |
|---|---|
| `index.html`, `src/style.css` | page et mise en page |
| `src/app.js` | relie carte, visionneuse et calcul : clics, clavier, repères, liseré, filtre |
| `src/carte.js` | carte MapLibre : fonds, filaire, points de repère (PR), mesures, étiquettes, poignées, photo la plus proche |
| `src/calcul.js` | chargement de Pyodide (page et arrière-plan) et des fichiers Python (`py/sources.js`) |
| `src/services.js` | vérification de l'accès aux services |
| `src/recherche.js` | recherche de lieux sur la carte (commune, lieu-dit, voie, adresse) |
| `src/requeteur.js` | requêteur route + PR (+ distance) : routes du département affiché, côté droit par défaut |
| `src/couche.js` | couche importée (GeoJSON, Shapefile par shpjs, GeoPackage par sql.js) : lecture, Lambert 93 en WGS 84, couleur et étiquette selon une colonne |
| `src/lieu.js` | route, point de repère (PR), véloroute, écluse, hameau et commune de la photo, incrustés dans la visionneuse |
| `py/web_app.py` | application de mesure : clics → cœur de calcul → JSON pour la page (points de référence, hauteurs, largeurs, mesure libre, recalages) |
| `py/web_host.py` | accès réseau du cœur par le `fetch` du navigateur |
| `py/web_worker.py` | calculs lourds dans le Pyodide d'arrière-plan |
| `py/geoid.py` | altitude NGF (grille RAF20 de l'IGN) |
| `py/core/` | cœur de calcul du plugin, **copié** par `tools/update-core.sh` (ne pas modifier ici) ; dont `widths.py`, la largeur depuis un point triangulé |
| `py/sources.js` | fichiers Python de `py/` regroupés pour la page (généré par le même script) |
| `tests/navigateur.html` | essai de bout en bout dans un vrai navigateur |
| `tests/essai-rtk.html`, `essai-largeur.html`, `essai-libre.html` | hauteur, largeur, mesure libre sur photos RTK, avec recalages |
| `tests/inclinaison.html` | inclinaison automatique |
| `tests/inclinaison-terrain.html` | inclinaison par le terrain hors agglomération (option) |
| `py/web_terrain.py` | inclinaison par le terrain hors agglomération : grille LiDAR HD, modèle de séquence |
| `tools/serveur-essai.py` | serveur des essais : sert le site et affiche leur journal |

Mettre à jour le cœur : `tools/update-core.sh [dossier du plugin] [révision]` (par défaut
`../visionneuse_panoramax`, branche `dev`) ; la révision copiée est notée dans
`py/core/SOURCE`. À relancer aussi après toute modification d'un fichier Python sous `py/`
(il régénère `py/sources.js`).

## Choix

D'après la feuille de route du plugin (`docs/feuille-de-route.md`, 12/10/2026) :

- **Site statique** : pas d'installation sur des postes verrouillés ; les services publics
  sont appelés directement depuis le navigateur.
- Usage **au bureau** : poste fixe, grand écran, souris, connexion filaire. Pas de tablette
  ni de 4G à prévoir.
- Carte **MapLibre** : filaire Panoramax (mêmes tuiles vectorielles que le plugin), fonds de
  la Géoplateforme IGN, sans clé.
- Visionneuse officielle **`@panoramax/web-viewer`** (licence MIT) intégrée à la page.
- **Cœur de calcul en Python dans le navigateur (Pyodide)** : le même code que le plugin,
  sans portage, et ses tests restent la référence. Le téléchargement initial de Pyodide est
  acceptable au bureau.
- Interface réduite : hauteur, largeur, distance entre points ; calage seulement si
  nécessaire.
- **Indicateur de fiabilité** bien visible, d'après la vérification de la position GPS, la
  présence du LiDAR HD et le calage de l'inclinaison de la photo.
- Export CSV et GeoJSON des mesures ; base partagée plus tard.

## Accès aux services depuis le navigateur

La page liste chaque service et indique s'il répond depuis le poste (proxy, pare-feu, en-têtes
CORS). Vérifié le 13/10/2026 depuis un poste personnel, avec Chrome :

| Service | Usage | Depuis un navigateur |
|---|---|---|
| Panoramax : recherche, tuiles, photos (`api.panoramax.xyz`, `panoramax.ign.fr`) | filaire, photos, métadonnées | accessible |
| Géoplateforme IGN : WMTS | Plan IGN, orthophoto | accessible |
| Géoplateforme IGN : altimétrie | LiDAR HD, ou RGE ALTI en secours, sous les photos et au point visé (vérification de la position RTK, sol au point, inclinaison automatique) | accessible |
| Géoplateforme IGN : WMS (`wms-r`) | PCRS | accessible |
| Géoplateforme IGN : WFS | BD TOPO (axe de la route, route, PR, hameau et commune de la photo, PR sur la carte, département du requêteur), ADMIN EXPRESS (limites administratives, contour de la commune cherchée) | accessible |
| Géoplateforme IGN : tuiles vectorielles (TMS) | Plan IGN (routes numérotées, noms), BD TOPO (voies) | accessible |
| Géoplateforme IGN : géocodage | recherche de lieux (autocomplétion) | accessible |
| Stockage des photos Panoramax (S3 OVH, derrière `panoramax.ign.fr`) | photos HD : capture Full HD, inclinaison automatique | accessible |
| PROJ (`cdn.proj.org`) | grille du géoïde : altitude NGF, hauteur de caméra d'après le GPS | accessible |

**À refaire depuis le poste des utilisateurs** (proxy ou pare-feu d'entreprise) : ouvrir la page et relever la liste.

## Étapes

1. ~~Séparer le cœur de calcul de QGIS~~, dans le plugin : paquet `core/` sans import QGIS,
   services de l'hôte (réseau, altitude NGF, décodage d'image) installés par l'application.
2. ~~Maquette~~ : visionneuse officielle, cœur dans Pyodide, largeur, longueur et hauteur,
   recalage sur la carte, export CSV et GeoJSON.
3. ~~Indicateur de fiabilité, inclinaison automatique, triangulation~~ : voyants RTK, LiDAR
   HD et inclinaison, inclinaison automatique en arrière-plan, mesure libre entre points
   triangulés.
4. ~~Mesures appuyées sur un point triangulé~~ (16/10/2026) : hauteur et largeur depuis un
   point de référence, recalage au clic et au clavier ; longueur sur une seule photo
   et calage de la hauteur de caméra retirés.
5. ~~Mini-carte détachable sur un second écran~~ (ticket #13).
6. ~~Première version publiée~~ : 0.1.0 (17/10/2026).
7. Essais sur le terrain avec les agents (postes Edge, photos RTK).

### Pour plus tard

- **Export pour un inventaire** : tableur, une ligne par mesure (route, PR + abscisse, type,
  valeur ± incertitude, lien vers la photo Panoramax, date).
- **Contrôle d'une largeur sur l'image vue du ciel**, quand le PCRS (image à 5 cm) sera publié
  en Côte-d'Or (absent le 22/10/2026, vérifié à Pouilly-en-Auxois) : cliquer les deux bords sur
  la mini-carte, puis comparer avec la largeur mesurée sur la photo ; un écart supérieur aux
  incertitudes signale un mauvais bord visé ou un axe faux. Environ ±0,1 m avec le PCRS
  (±0,3 m avec l'orthophoto à 20 cm). L'axe de la route n'en vaut pas la peine : la trajectoire
  RTK le donne déjà à ±0,5°.
- **Inclinaison par le terrain en rase campagne** (ticket #29) : option expérimentale en place
  (voir « Utilisation » et « Précision »). Reste à la valider sur des longueurs connues en rase
  campagne, à plus de 70 km/h, où aucune photo n'a d'arêtes verticales, et à revoir le roulis en
  virage sur plus de virages (le 23/10, 16 photos de village le disaient utile à 3 à 6°/g ; le
  24/10, le seul virage témoin le contredisait). Essais du 23/10 sur 7 séquences : les
  verticales calent 41 % des photos en zone d'habitation, 2 % hors zone ; le modèle par le
  terrain du cœur n'est accepté que sur 2 séquences sur 7 ; le tangage au freinage n'a pas
  d'effet mesurable.

## Versions

- **0.6.9-3** (27/10/2026) : bouton « Profil » à la hauteur du bouton « Dévers ».
- **0.6.9-2** (27/10/2026) : page d'essai `tests/essai-lidar.html` : lecture à la volée du nuage
  de points LiDAR HD (COPC) autour de la caméra et profil en travers (altitude, intensité), piste
  pour le bord de chaussée de « Dévers » ; application inchangée.
- **0.6.9-1** (27/10/2026) : « Dévers » : profils lus depuis la caméra (séquence vérifiée RTK,
  sinon depuis l'axe BD TOPO), bord de la chaussée trouvé par rupture de pente du terrain (sinon
  largeur BD TOPO) ; bouton « Profil » : coupe du terrain en travers de la route (chaussée, bords,
  chute, dévers, mesure LiDAR HD), titre avec route, PR et commune, enregistrable en PNG ;
  mini-carte sans les longueurs des mesures ; fenêtre « Enregistrer » remise en ordre.
- **0.6.9** (26/10/2026) : chute et dévers des bords de route hors pont (#31) : bouton « Dévers »
  de la barre du haut et réglette de la distance examinée (2 à 30 m), terrain LiDAR HD en travers
  de la route, côtés vus dans le sens de la photo, sans besoin de RTK.
- **0.6.8** (26/10/2026) : relevé d'objets, modèles de champs (#33) : liste « Modèle » au premier
  objet, champs nouveaux gardés comme modèle d'une case à cocher, colonnes d'une couche de l'onglet
  Couche enregistrées comme modèle, échange des modèles par fichier (exporter, importer) ; fenêtres
  sur la visionneuse gardées dans son cadre, avec défilement (Plus tard et Enregistrer toujours
  visibles) ; fiche PDF trop longue continuée sur les pages suivantes (#32) ; équerre unique
  (favicon, bouton Mesure) ; couche importée : vert par défaut, z = 0 des exports KML traité comme absent.
- **0.6.7** (25/10/2026) : onglet Résultats, bouton d'import des mesures en icône seule : le titre
  « Mesures de la séance » n'est plus coupé.
- **0.6.6** (25/10/2026) : mesures revues sur leur photo (export : colonnes `photo_ref`, `vue_ref`,
  `etiquette` ; « Importer » de l'onglet Résultats : photo de la mesure ouverte et cadrée, mesure
  dessinée telle qu'à l'écran, clic sur une mesure de la mini-carte pour la revoir) ; couche : 2e
  étiquette sur une 2e ligne ; position de la photo en croix bleue sur la mini-carte et la fiche ;
  bulles « Clic gauche : recaler le point » et « Clic droit : fiche de l'objet » après 2 s sur un objet.
- **0.6.5** (25/10/2026) : encadré du pont, « Au-dessus de … » en bleu (bleu de la visée) au lieu du jaune.
- **0.6.4** (25/10/2026) : fiche d'objet, la pastille d'un objet recalé dans la photo est dessinée à sa
  place recalée (seule l'étiquette y était) ; les valeurs masquées dans la légende n'y figurent plus.
- **0.6.3** (25/10/2026) : Effacer, Refaire et Tout effacer au fond des autres boutons, avec un liseré
  jaune, vert ou rouge au lieu d'un fond coloré.
- **0.6.2** (25/10/2026) : relevé d'objets. Nouveau mode « Relevé d'objets (couche SIG) » : chaque objet
  visé depuis plusieurs photos (triangulé), gardé sur une seule photo (précision proposée avant), ou posé
  d'un clic sur la mini-carte ; dessiné sur toutes les photos à son altitude. Champs définis au premier
  objet (texte, nombre, date, oui/non, liste), d'autres ajoutables ensuite, valeurs déjà saisies proposées,
  commentaire ; voie, PR et commune ajoutés ; colonnes `id`, champs, lieu, commentaire, puis le reste.
  Relevé gardé d'une séance à l'autre, « Envoyer dans Couche » (couche chargée enregistrable avant) et
  « Vider ». Couche : « Enregistrer » dans le fichier GeoJSON importé (Chrome, Edge ; sans rien demander
  s'il n'a pas changé), export CSV, colonnes techniques d'un relevé hors des listes, étiquette avec
  l'intitulé du champ et un texte après la valeur, étiquette de la carte à part (« id » par défaut),
  fiche PDF d'un objet par clic droit dans la photo (données choisies et ordonnées, gardées avec la
  couche). Fiche : cadres de la photo et de la mini-carte tracés, « Vue actuelle » recadrable avant de
  valider, mini-carte centrée en hauteur. Mini-carte : PR et bornes avec le fond « orthophoto avec noms »
  seulement, étiquettes de la couche agrandies. Firefox : nom du fichier demandé à chaque export.
- **0.6.1** (25/10/2026) : interface refaite. Panneau : ligne d'état toujours visible ; onglets
  Résultats (en-tête avec exports, un bloc par point de référence et ses mesures), Photo (fiche, position
  à voyants, détails, « Aller à une photo », calage), Favoris (commune et voie en gras, photo affichée
  entourée) et Couche (accueil, fichier glissé, fiche avec œil et actions, légende sur deux colonnes, œil
  par valeur, dégradé en barre, seize couleurs, palette agrandie) ; en bas, Filtre (« Filtres appliqués »,
  instance), Réglages (interrupteurs, options expérimentales à part) et Services (bilan, point rouge si
  l'un ne répond pas). Thème jour et nuit, comme le système ou choisi. Boutons grisés quand ils sont
  sans effet. Exports par la boîte d'enregistrement du système (Chrome, Edge). Barre du haut en cartes.
  Visionneuse : carte d'étape en bas à gauche pendant la mesure (étapes, état, consigne, boutons), haut de
  la photo et flèches libres ; question du pont non modale ; étiquettes de mesure en pilules.
- **0.6.0** (25/10/2026) : couche importée. Couleurs : pastilles de la légende sous « Couleur
  selon », palette au clic (fenêtre flottante), « Couleurs par défaut » ; une couleur par valeur en
  palette Set1 (les huit plus fréquentes) ; colonne numérique d'au moins 11 valeurs en dégradé
  entre les couleurs du minimum et du maximum choisies dans la légende ; nombres sans séparateur
  des milliers sous 10 000 (années). Étiquettes en texte seul, couleur de l'objet éclaircie de
  moitié, liseré noir ; sur la mini-carte, écartées de l'axe de la voie. Recalage d'un objet dans
  la photo (clic sur l'objet, clic à sa place, flèches, Entrée ; Suppr le remet), sans toucher à la
  carte, gardé avec la couche ; « Exporter » : GeoJSON avec les recalages, pour un autre poste ;
  photo recalée d'une autre séquence de la voie proposée. Exports (mesures, captures, favoris,
  calage, couche) par la boîte d'enregistrement du système sous Chrome et Edge.
- **0.5.3** (24/10/2026) : couche importée (section « Couche ») : GeoJSON, Shapefile (.zip, ou .shp
  avec .dbf et .prj) ou GeoPackage, en WGS 84 ou Lambert 93 ; sur la mini-carte et, à son
  altitude ou posée sur le sol LiDAR HD, dans la photo ; couleur selon une colonne (par valeur ou
  dégradé) avec légende, étiquette d'une colonne (écartées, masquées au-delà d'une fois et demie
  leur hauteur, transparentes à 25 %) ; case « Afficher la couche » ; gardée d'une session à
  l'autre. Fiche PDF : choix « Cadrage automatique » ou « Vue actuelle », titre libre, couche
  affichée comprise.
- **0.5.2** (24/10/2026) : commune de la photo, département du requêteur et contour de la commune
  cherchée lus sur la Géoplateforme (geo.api.gouv.fr, très lent, n'est plus utilisé) ; hameau
  retenu jusqu'à 100 m de sa zone d'habitation. Bouton « Refaire » (Ctrl+Y) ; Effacer, Refaire et
  Tout effacer centrés sous le mode, colorés (jaune, vert, rouge), grisés sans effet possible ;
  « Avec les mesures » grisé sans mesure sur la photo ; icône appareil photo, alignée, pour les
  deux captures. Fiche PDF : pont et ce qu'il franchit après la commune, ligne de position sans
  l'inclinaison, pied allégé. Encadré du pont : une ligne chacune, « Au-dessus de… » en jaune.
  Favicon sans graduations.
- **0.5.1** (24/10/2026) : fiche PDF par point de référence (bouton « 📄 Fiche » des résultats,
  impression du navigateur) : photo de la mesure cadrée sur elle, tableau des points et des
  mesures, méthode et précision en bref, mini-carte au zoom de la page avec le cône de vue, lien
  Panoramax et QR code. « Effacer » et Ctrl+Z annulent le dernier geste, Ctrl+Y le rétablit ;
  résultats gardés dans le navigateur, ceux de la session précédente non exportés affichés et
  proposés à l'export. Hauteurs suivantes depuis un point prises sur l'axe de la première
  (réticule glissant, trait jaune) ; sommet affiché au cap du clic. Largeur sur une droite tracée :
  texte adapté. Localisation : hameau ou quartier avant la commune, route et commune en gras.
  Police Inter (JetBrains Mono pour les identifiants), titre agrandi, trait des mesures épaissi.
- **0.5.0** (24/10/2026) : traits de la visionneuse dessinés en WebGL (visée zoomée bien plus
  fluide) ; visées des autres photos en trait plein vert, tracées aussi en hauteur, avec un trait
  vertical au centre de la vue (#26). Résultats : une entrée par point de référence, ses mesures
  dessous (#30). Hauteur de chute sur un pont : terrain lu de 1 à 10 m du bord du tablier, causes
  d'échec affichées (#27). Inclinaison : calcul dès « Mesure », raison de l'échec, messages sous les
  boutons sans les déplacer (#29). Options expérimentales des réglages, décochées par défaut :
  inclinaison par le terrain hors agglomération (#29) et droite de mesure de la largeur tracée sur
  la mini-carte (#28). Filtrage anisotrope à 16x ; réglages chacun sur sa ligne.
- **0.4.1** (22/10/2026) : dans la visionneuse, une mesure faite n'apparaît plus que sur sa photo
  (sur les autres, projetée, elle paraissait décalée) ; mesure libre : points et distances là où ils
  ont été visés. Favicon en forme d'équerre.
- **0.4.0** (22/10/2026) : case « Filtrage anisotrope » dans les réglages (8x, décochée par défaut) :
  moins de crénelage et de scintillement des détails fins vus de loin. Étoile des favoris dessinée,
  alignée sur l'étiquette du lieu quelle que soit la police.
- **0.3.7** (22/10/2026) : favoris, une puce devant chaque nom, alignée sur sa première ligne
  (noms sur deux lignes).
- **0.3.6** (22/10/2026) : dès la 3e visée d'un point, la vue de la photo ouverte se tourne vers le
  point déjà triangulé. Favoris : export dans un fichier et import (sur un autre poste ou navigateur).
- **0.3.5** (22/10/2026) : sur un pont, son nom tiré des ouvrages d'art de la BD TOPO quand la route
  ne le nomme pas (« Pont Joly (D954) »), et dessous ce qu'il franchit : « Au-dessus de l'Armançon »,
  « du canal de Bourgogne », « de l'A6 ». Vérification RTK d'une séquence prise sur un pont : autres
  portions de la séquence cherchées par rang (le LiDAR donne le terrain sous le tablier). Favoris :
  photos gardées dans le navigateur, nommées « commune – voie – PR – pont », étoile dans la
  visionneuse comme dans un navigateur.
- **0.3.4** (22/10/2026) : axe de la route tiré de la trajectoire RTK de la séquence quand elle est
  droite et concorde avec la BD TOPO (±0,5° au lieu de ±2°) ; incertitude attendue du point affichée
  sur les boutons des photos proposées pour la visée suivante ; rappel de zoomer quand un clic de
  mesure est fait trop peu zoomé ; largeur : le réticule reste sur la droite de mesure quand un
  clic poserait le bord, et la première visée du bord B part du bord posé sur la droite. Calage du
  cap et de la position retiré. Visite guidée en trois bulles à la première ouverture ; photo par
  défaut sur le château de Semur-en-Auxois. Lecture rapide façon K2000 (barres à 4x et plus, photo
  à 16x), désactivable dans les réglages.
- **0.3.3** (22/10/2026) : cache des informations géographiques (routes, PR, ponts, altitudes,
  communes) gardé dans le navigateur 3 mois (50 Mo au plus) : plus rapide, et toujours là quand
  un service ne répond pas ; taille et bouton « Vider le cache » dans « Accès aux services ».
- **0.3.2** (22/10/2026) : largeur, le bord cliqué se pose sur la droite de mesure dans la
  direction du clic (seule la direction compte) : croix, trait et valeur concordent ; un cercle
  jaune glisse sur la droite sous le pointeur pour montrer où le bord se posera.
- **0.3.1** (22/10/2026) : services qui ne répondent pas (panne, erreur, plus de 10 s sans
  réponse) signalés discrètement sous les voyants de la visionneuse, jusqu'à leur réponse
  suivante. Recherche de lieu : la carte part tout de suite vers le lieu choisi (elle attendait
  le contour de la commune, d'un service parfois muet) ; Entrée tapée avant les suggestions
  prend la première. Pont : « Pont de l'A38 » (élision devant une voyelle).
- **0.3.0** (22/10/2026) : sur un pont, en haut à gauche de la visionneuse, nom du pont (BD TOPO)
  et hauteur de chute la plus grande sur toute sa longueur (tablier d'après l'altitude GPS RTK,
  terrain sous le pont d'après le LiDAR HD ou le RGE ALTI ; pas de valeur sans RTK vérifié).
  Calage de l'inclinaison : pied et sommet de l'objet vertical affichés (croix rouge clair,
  trait bleu clair), déplaçables, puis « ✔ Valider l'objet vertical ». Visées suivantes du
  point de référence et du bord B : la vue se tourne vers le point, zoom gardé. « Nouveau point
  de référence » dans la visionneuse, en hauteur seulement, à côté de « Nouvelle mesure depuis
  A » ; barre de contrôle réorganisée.
- **0.2.17** (19/10/2026) : « Mesures loin d'ici » : « Tout effacer » en rouge, « Garder » en
  vert ; fenêtre « Première utilisation » présentée comme les alertes, centrée sur la visionneuse.
- **0.2.16** (19/10/2026) : fenêtres « Mesures loin d'ici » et « Mesurer la distance ? »
  présentées comme les alertes RTK et pont : centrées sur la visionneuse, cadre orange, boutons
  au centre (refus en rouge, acceptation en vert).
- **0.2.15** (19/10/2026) : étiquette du lieu, moins de requêtes à la Géoplateforme : tronçons
  et sections de PR lus par zone (environ 300 × 440 m) et PR par section, gardés pour les
  photos suivantes ; requêtes en file, deux à la fois, et refus HTTP 429 retentés après une pause.
- **0.2.14** (19/10/2026) : étiquette du lieu (en bas à gauche de la visionneuse) avec la route
  et le PR de nouveau : quand la Géoplateforme refusait la requête des tronçons (requêtes en
  rafale, HTTP 429), seule la commune restait, gardée pour la session ; la description
  incomplète n'est plus gardée et elle est redemandée.
- **0.2.13** (19/10/2026) : fiche de la photo, « Précision GPS annoncée » suivie sur la même
  ligne de la précision calculée (vérification RTK sur le sol LiDAR HD ou RGE ALTI, ou pourquoi
  elle manque). Voyants RTK et LiDAR HD (ou RGE ALTI) affichés aussi hors du mode mesure ; celui
  de l'inclinaison reste en mesure. Cœur du plugin Visionneuse Panoramax (branche dev, 5f25212).
- **0.2.12** (19/10/2026) : RGE ALTI en secours là où le LiDAR HD n'est pas encore publié
  (vérification RTK, sol au point visé, inclinaison automatique ; source affichée) : plus de
  fausse alerte « GPS RTK requis » sur ces secteurs. « Sur un pont » coupe aussi le RGE ALTI.
  Sol relu au point qui converge (le point allait et venait quand le sol le déplaçait de plus
  d'1 m). Cœur du plugin Visionneuse Panoramax (branche dev, 005c49b).
- **0.2.11** (19/10/2026) : pendant la lecture de la séquence, la carte suit le tracé des
  photos image par image, à une vitesse qui ne change que progressivement (plus suivie si on la
  déplace à la main). Fenêtres « Photo sur un pont », « Sortie du pont » et « Position GPS trop
  imprécise » centrées sur la visionneuse, boutons centrés, Oui vert et Non rouge.
- **0.2.10** (19/10/2026) : pendant la lecture de la séquence, la carte glisse à vitesse
  constante d'une photo à la suivante au lieu d'avancer par à-coups (animation freinée coupée
  par chaque photo) ; lieu, PCRS et ortho-express mis à jour à l'arrêt de la lecture.
- **0.2.9** (19/10/2026) : lecture rapide de la séquence (2x à 16x) rétablie sur l'instance
  IGN : la liste des photos était demandée au stockage de ses images, qui la refuse ; elle
  l'est maintenant à l'instance (lien de la séquence, ou instance d'origine depuis le
  méta-catalogue), avec repli en lecture 1x si aucune ne répond.
- **0.2.8** (19/10/2026) : sur la carte, étiquette d'une largeur ou d'une distance posée à
  côté du trait (horizontale, perpendiculairement au trait), et non plus au-dessus de son
  milieu, où elle cachait le bord B sur un trait court ou oblique. Sortie d'un pont : case
  « Sur un pont » cochée et photo à plus de 30 m de tout pont de la BD TOPO, une fenêtre
  propose de la décocher (une fois par sortie). Cœur du plugin Visionneuse Panoramax
  (branche dev, 6939bdf).
- **0.2.7** (19/10/2026) : mesures sur un pont (ticket #16). Case « Sur un pont » dans la
  barre du haut : le LiDAR HD, qui donne le terrain sous l'ouvrage (5 à 6 m sous le tablier
  sur les ponts de la RD111 et de la RD18 au-dessus de l'A6), n'est plus utilisé ; les points
  au sol se calent sur le sol tiré des photos et l'inclinaison automatique se passe de la
  pente LiDAR. Quand la photo est sur un tronçon en pont de la BD TOPO, une fenêtre propose
  de cocher la case (une fois par pont). Cœur du plugin Visionneuse Panoramax (branche dev,
  d3e620f).
- **0.2.6** (18/10/2026) : inclinaison automatique calculée au premier clic sur la photo, et
  non plus dès son arrivée (le calcul faisait saccader la vue pendant qu'on cherchait
  l'objet). Cœur du plugin Visionneuse Panoramax (branche dev, 0c227ca).
- **0.2.5** (18/10/2026) : rotation de la vue plus fluide : cône de vue dessiné en image
  tournée sur la carte (la carte ne se redessine plus à chaque image), écartement des
  étiquettes recalculé au zoom et à l'arrêt seulement, traits de la visée à 41 points. Cœur
  du plugin Visionneuse Panoramax (branche dev, 425f5ad).
- **0.2.4** (18/10/2026) : étiquette d'une hauteur ou d'une largeur au point d'arrivée (à
  droite du sommet, sous le bord), ouverte par le nom de ce point en pastille ; étiquettes qui
  se chevauchent écartées vers le bas, l'ordre gardé, avec un trait de renvoi (photo et
  captures) ; nom posé sur le trait d'une autre mesure mis à côté ; mention « projet
  personnel – POC ». Cœur du plugin Visionneuse Panoramax (branche dev, a2da3fb).
- **0.2.3** (18/10/2026) : sommet d'une hauteur nommé (lettre suivante, étiquette grise),
  l'étiquette de la mesure nomme ses deux points (« A↕C 3,20 m »). Cœur du plugin
  Visionneuse Panoramax (branche dev, 383e216).
- **0.2.2** (18/10/2026) : étiquettes des mesures dans la photo agrandies (+25 %), sur fond
  bleu, avec les noms de leurs points (« A↔B 7,50 m ± 0,20 m ») ; bord cliqué d'une largeur
  nommé (lettre suivante, étiquette grise tant qu'il n'est pas triangulé) et bouton
  « Trianguler le point B ». Cœur du plugin Visionneuse Panoramax (branche dev, f95a7bf).
- **0.2.1** (18/10/2026) : fond « orthophoto avec noms » (noms des lieux et des rues, voies
  avec les numéros de route dans des cartouches de l'IISR, limites des départements, de la
  métropole et des communes) ; points de repère dessinés en bornes, posées hors de la voie ;
  filaire Panoramax semi-transparent, avec une case pour le masquer ; mention « Version test,
  projet personnel, non officiel » sous le titre ; logo Panoramax retiré. Cœur du plugin
  Visionneuse Panoramax 1.5.0.
- **0.2.0** (18/10/2026) : prise de mesure guidée (photo de référence, photos voisines
  proposées, visées des autres photos tracées dans la photo, trait vertical du cap, retour et
  vue cadrée sur la photo de référence) ; bord opposé d'une largeur triangulé ; triangulation
  3D des points au sol quand les visées sont presque alignées (sol LiDAR HD lu au point) ;
  recalcul quand la vérification RTK ou un calage arrivent après les clics ; « Effacer » du
  dernier point, remise à zéro loin des mesures ; lecteur de séquence (1x à 16x) ; distance
  au PR mesurée le long du filaire depuis le dernier PR ; véloroute et écluse dans le lieu de
  la photo ; identifiant de photo à copier et accès par identifiant ; instance IGN et
  photos du CD21 par défaut ; carte détachée déplaçable à la souris. Cœur du plugin
  Visionneuse Panoramax 1.5.0.
- **0.1.3** (17/10/2026) : requêteur route + PR (+ distance) sous la recherche de lieux, à
  listes qui se réduisent à la frappe ; photo ouverte dans le sens des PR croissants. Distance
  au PR mesurée le long du filaire IGN depuis le dernier PR passé, sans mise à l'échelle (plus
  de 1 000 m possible). Lecteur de séquence en bas de la visionneuse : lecture en arrière,
  pause/reprise, lecture en avant, à 1x, 2x, 4x, 8x ou 16x (une photo sur 2 à 16). Verticale
  de la hauteur tracée selon le calage de l'inclinaison de la photo ; lieu de la photo pris
  hors sentiers et escaliers ; points des photos plus petits sur la carte. Cœur du plugin
  Visionneuse Panoramax 1.4.3.
- **0.1.2** (17/10/2026) : nettoyage du cœur de calcul (profil du terrain, RGE ALTI et façade
  du cadastre retirés) ; « Accès aux services » vérifie l'altimétrie IGN sur le LiDAR HD.
  Cœur du plugin Visionneuse Panoramax 1.4.2.
- **0.1.1** (17/10/2026) : fenêtre d'avertissement, une fois par séquence pendant la mesure,
  quand la position des photos n'est pas vérifiée RTK (« Un GPS avec corrections RTK est
  requis ») ; capture de l'application dans le README. Cœur du plugin Visionneuse Panoramax
  (dev, commit e6132b0).
- **0.1.0** (17/10/2026) : première version publiée. Hauteur, largeur perpendiculaire à la
  chaussée et mesure libre, toutes appuyées sur des points triangulés ; mesure faite ajustable
  seulement le long de la droite de mesure ou de la verticale, autre mesure par « Nouvelle
  mesure depuis A » ; nom des points dans la visionneuse ; voyants RTK, LiDAR HD et
  inclinaison ; calage de l'inclinaison et du cap ; carte détachable ; exports CSV et
  GeoJSON ; captures. Cœur de calcul du plugin Visionneuse Panoramax, branche
  `triangulation` (commit ac1f560).

## Licence

GPL v2 ou ultérieure (fichier `LICENSE`), comme le plugin dont les calculs sont repris.
