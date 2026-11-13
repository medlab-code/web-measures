<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Versions

Historique des versions publiées (tag `vX.Y.Z` et release GitHub), de la plus récente à la plus ancienne.

- **0.7.7** (13/11/2026) : **Bird Eye** (vue du dessus, essai) : la photo 360° reprojetée au sol sur la carte, d'un clic sur le faucon (carte en grand ou détachée), réglages d'essai dans un panneau sur la carte ; « Mesurer une longueur » sur cette vue, mesure rangée avec les autres résultats ; « Véhicule masqué » (photos voisines sous le véhicule, contour du véhicule lu sur la séquence, raccords recalés et fondus) ; terrain LiDAR HD lissé, tablier plat près d'un pont ; inclinaison par les verticales en ville, par la route ailleurs, avec le défaut de roulis de la campagne CD21 2025 (−1°) ; hauteur de caméra du CD21 d'après la date (monture) ; tangage lu sur les raccords (photos à deux pas comprises), sinon sur les lignes et les bords de la route jusqu'à 25 m, réglage à la main en dernier (« Forcer le réglage à la main ») ; position calée sur l'orthophoto, « Haute résolution », « Bords gardés » (vue entière), messages repliables, bouton 📷 de capture de la carte en PNG (vue, mesures, échelle, sources). Mode de départ « Hauteur d'un objet ». Requêteur route + PR : photo ouverte dès le point connu, vol de la carte écourté. Lieu de la photo : route suivie ou la plus importante à un croisement, PR lu sur la section voisine. Vidéo : raccord de séquences par avancée zoomée et fondu court (#44), grille des formats, avancement de la stabilisation. Cadastre : parcelles numérotées teintées, domaine public sans teinte, feuilles mal raccordées cernées de tirets. Essais : code commun, attentes de condition (essai complet environ 7 → 5 min), parcours de mesure de bout en bout sans navigateur, essai des passages piétons.
- **0.7.6** (06/11/2026) : onglet Vidéo réorganisé en trois temps : « Tracer sur la carte » (clics enchaînés, départ, arrivée, étapes), photos cherchées d'elles-mêmes avec un bandeau des séquences (raccords, dates, repères sur la carte), modes Brouillon, Présentation et Revue détaillée, options repliées par thème (Compteurs, Allure, Réglages qualité, Effets spéciaux) ; « Parcourir » et l'image animée WebP retirés. Mode Présentation : 400 km/h en ligne droite par défaut, grandes courbes moins freinées, vitesse de la courbe atteinte environ 2 s avant son entrée, départ, arrivée et transitions plus rapides. Cap de la vue recalé sur l'axe de la route hors des virages, arrondi du cap des photos lissé. Croisements et ouvrages d'art cherchés seulement si l'option qui s'en sert est cochée. Hauteur de chute d'un pont : méthode affichée (LiDAR ou RTK). Essais du parcours et de la vidéo non relancés pour cette version.
- **0.7.5** (06/11/2026) : mesures : largeur, incertitude en travers de la route seulement, bord cliqué estimé (« ≈ »), visée trop rasante refusée, réticule calé sur le trait d'une visée déjà faite (Maj : visée libre) ; zones de clic réduites, croix à 8 px, trait de visée à 12 px (#43). Hauteur de chute d'un pont par le nuage LiDAR HD : une seule valeur par pont, sans GPS ni hauteur de caméra, altitude GPS en secours. Profils (#38) : boutons « Profils » et « Graphiques », légende pliable, dévers de la plateforme, hauteur de la canopée, carrefours avec les seules voies carrossables, noms hors du terrain ; analyse fine : bord et largeur d'enrobé, profil relu depuis eux. Visionneuse : bouton de plein écran, captures centrées (#39). Parcours gardés : instance et producteur remis à la réouverture (#40). Vidéo : option Brouillon (image SD, 960 × 540), H.265 et 1080p ou 720p au choix, H.264 à 80 Mbit/s, case « Haute qualité » retirée (#42), stabilisation du tangage et du roulis par comparaison des images SD, petite planète environ 3 fois plus rapide.
- **0.7.4** (02/11/2026) : fiches PDF des objets (onglet Couche), « Cadrage type » : le décalage de photos dans la séquence, réglé sur le 1er objet (photos avant ou après la sienne), est de nouveau repris pour chaque objet (perdu depuis le 30/10).
- **0.7.3** (01/11/2026) : vidéo du parcours refondue. Photos choisies le long de l'itinéraire de la Géoplateforme (Valhalla sur la BD TOPO), étapes 📍 pour imposer un passage, trajectoire virtuelle sur ce tracé (cap dans l'axe de la route, sans arrêt ni balayage aux raccords) ; séquences choisies sur tout le parcours d'un coup, par le sens (vers l'avant), puis la proximité des dates et le moins de changements ; raccords discrets (là où les photos se recouvrent, couleurs accordées, fondu sur tout l'écart, léger flou). Modes « Présentation de l'itinéraire » (allure selon les virages, changements d'allure rapides, arrêts, ralentissements aux croisements et ouvrages d'art retouchables, aperçu animé sur la mini-carte, tracé coloré selon la vitesse) et « Revue détaillée » ; options actuelles repliées en « Options avancées » ; titre soigné (carton en haut, texte libre, rappel en incrustation). Petite planète sur un tronçon tracé ou sur tout le parcours, transition réglable, tonneau pendant la transition. « Corrections de luminosité » (photos isolées ratées par la caméra). « Avancée simulée » retirée. Calcul : vidéo écrite au fur et à mesure dans le fichier (longs parcours sans manque de mémoire), titre et compteurs posés par la carte graphique (un tiers de temps en moins), plus de ralentissement en fin de vidéo, tuiles des photos de la recherche corrigées (vidéo noire). Services : délai maximal et nouveaux essais, cache géographique à 500 Mo ; repères loin du parcours ignorés. `LICENCES-TIERCES.md` (licences des bibliothèques, données et services).
- **0.7.2** (31/10/2026) : vidéo du parcours : compteurs sans battement qui gardent les pics (accélération ressentie lissée sur un quart de seconde, affichée jusqu'à son pic et redescendant par 20 mG au moins ; vitesse max ARP la plus basse sur 30 m, remontant par 5 km/h au moins) ; cadres aux coins arrondis ; cadre « Vitesse » de la largeur de « V max ARP ».
- **0.7.1** (31/10/2026) : vidéo du parcours : options « Accélération latérale » (accélération ressentie en millièmes de g, v² / rayon moins le dévers lu sur le LiDAR HD, chiffre vert, jaune ou rouge selon les rayons de l'ARP du SETRA) et « Vitesse max ARP » (plus haute vitesse où le virage reste vert, moyennée sur 20 m, au-dessus du compteur de vitesse) ; lecture du dévers lente, limitée à ce qu'accepte la Géoplateforme (5 requêtes/s), avec attente après un refus ; serveur d'images bloqué : nouveaux essais, avertissement au bout de 30 s (Attendre ou Annuler la vidéo), arrêt au bout de 5 min ; panoramique au changement de séquence remplacé par un cap lissé sur ± 40 m et un flou au raccord ; options réordonnées, aucune cochée par défaut. Calculs : `docs/CALCULS.md` § 11.
- **0.7.0** (31/10/2026) : vidéo MP4 du parcours (onglet « Parcours » renommé « Vidéo ») : hyperlapse calculé depuis les tuiles HD, sans lire le parcours (1080p, 30 images/s, H.264, sinon VP9), vitesse simulée de 30 km/h à Mach 2 et part des photos, avancée simulée dans une maquette ou simple fondu ; options : exposition accordée aux changements de séquence, flou cinétique, haute qualité (débit 80 Mbit/s, lent), rampe de vitesse, titre, compteurs PR et de vitesse, panoramique au changement de séquence, regard aux croisements, point d'intérêt (cible du relevé, zone tracée, zoom, tonneau), tonneaux, petite planète, tour d'horizon ; bifurcation lisse vers la séquence de l'arrivée, épingles de départ et d'arrivée ; onglet « Parcours » : parcours gardés avec tous leurs réglages, rouverts d'un clic, export et import (un seul ou la liste), pastille des effets de communication, bouton ↺ RAZ ; fiches PDF des objets : choix des objets retenus
- **0.6.16** (29/10/2026) : fond de carte « Modèle Numérique de Hauteur » (estompage du MNH issu du LiDAR HD, IGN) ; profil en travers : droites du dévers sous les textes et la végétation, étiquettes sans parenthèses (précisions en légende), légende du profil en long avec lui en 2e page du PDF ; loupe du profil : la fenêtre ne dépasse plus de la visionneuse.
- **0.6.15** (29/10/2026) : croix, réticule glissant, étiquettes des mesures et noms des points dessinés en WebGL avec les traits (affichage bien plus fluide ; la couche importée reste en repères HTML) ; vignette et photo des fiches tirées de cette même surcouche, identiques à l'écran ; nom provisoire d'un bord pas encore triangulé en gris.
- **0.6.14** (29/10/2026) : profil en travers enregistré en PDF (page A4 paysage, lieu de la photo comme l'encart de la visionneuse, légende en petits caractères ; profil en long en 2e page au choix) ; hauteur de chute d'un pont : hauteur de caméra mesurée sur la séquence, sinon calée, sinon le réglage « Caméra à » seulement si on l'accepte, incertitude selon cette source ; terrain d'une seule source (LiDAR HD ou RGE ALTI) par calcul ; « Dévers » sur le tronçon orienté comme la route parcourue ; croix sélectionnée sous le clic à 12 px près (hauteur, largeur, calage) ; requêtes limitées à 30 s et échecs des services redemandés ; cadastre : section et numéro des parcelles en tuiles vectorielles, 25 % plus grands ; cœur de calcul repris du plugin, avec ses tests (`tests/coeur/`).
- **0.6.13** (30/10/2026) : cadastre sur la mini-carte (#36, réglage « Cadastre sur la carte », décoché par défaut) : parcelles du Parcellaire Express dès le zoom 15, bornes de limite de propriété et section au-dessus du numéro de parcelle dès le zoom 17, feuilles cadastrales mal raccordées (écart moyen aux raccords de plus de 2 m) en orange ; essais rapides des calculs sans navigateur (`tests/test_calculs.py`) ; téléchargement par l'archive des sources de la release.
- **0.6.12** (30/10/2026) : profil en long, tablier des ponts : creux du terrain comblé par une corde appuyée en haut des parois, s'il recouvre un pont de la BD TOPO (souvent plus court que la brèche) ou plonge de plus de 20 % (pont absent de la BD TOPO), un vallon suivi par la route restant tel quel ; étiquettes liserées, écartées l'une de l'autre et des tabliers, repères de fin et de carrefour en gras ; document `docs/CALCULS.md` : calculs de chaque mode, seuils et précision.
- **0.6.11** (29/10/2026) : profil en long (±50 m, le long de la trajectoire de la caméra, sinon de l'axe BD TOPO prolongé), avec pente moyenne et la plus forte sur 10 m, fin de la route et carrefours avec les voies nommées, ponts et tunnels (tablier interpolé) ; caméra à sa hauteur (réglage) dans les deux profils, « Hauteurs à l'échelle » cochée à chaque ouverture ; tronçons BD TOPO lus jusqu'à 60 m autour de la photo, prolongement de la route dans l'alignement.
- **0.6.10** (28/10/2026) : « Analyse fine » du profil (nuage LiDAR HD de l'IGN, barre d'avancement) : bords de chaussée (ligne de rive), séparateur de chaussée (bande non revêtue, glissières comprises), lignes blanches, herbe au sol, hauteur de la végétation (case « Végétation »), surface de l'eau ; eau de la BD TOPO dès « Dévers » ; autres travers transparents ; repère « fin de lecture » retiré ; fenêtre du profil : boutons immobiles quand on actionne les cases.
- **0.6.9-14** (28/10/2026) : « Dévers » : séparateur de chaussée étroit sans marches (glissières dos à dos, muret) reconnu à sa bosse dans le relief, au même endroit sur deux travers au moins (RD700 à Varois-et-Chaignot).
- **0.6.9-13** (28/10/2026) : « Dévers » : séparateur de chaussée trouvé dans le relief (entre deux marches du terrain, sinon d'après la BD TOPO, origine écrite sur le profil), bord de chaussée aussi à une marche du terrain (bordure), bord extérieur de l'autre chaussée cherché plus loin, travers recoupés entre eux ; autre chaussée mieux reconnue (tronçon dans le prolongement écarté). Essais sur l'A38, la RD903bis, la D1074 et la RD700.
- **0.6.9-12** (27/10/2026) : « Dévers » sur route à chaussées séparées (#34) : plateforme jusqu'au bord extérieur de l'autre chaussée, séparateur de chaussée marqué sur le profil (petite barre verticale) ; loupe du profil (graphique agrandi sans la légende) ; étiquettes du profil écartées l'une de l'autre et liserées.
- **0.6.9-11** (27/10/2026) : réglage « Bornes des PR sur la carte » valable pour tous les fonds de carte (coché : bornes partout ; décoché : nulle part).
- **0.6.9-10** (27/10/2026) : fiches PDF de tous les objets de la couche en un seul PDF, cadrage automatique ou cadrage type (zoom, hauteur de vue et décalage dans la séquence réglés sur le 1er objet), photos d'une même séquence ; capture après le chargement des tuiles de la visionneuse ; réglage « Bornes des PR sur la carte ».
- **0.6.9-9** (27/10/2026) : fiche PDF quasi instantanée sous Chrome et Edge : préparée dans une petite fenêtre à part, la page restant visible (dans un onglet, elle passait en arrière-plan et la capture attendait).
- **0.6.9-8** (27/10/2026) : fiche PDF en « Vue actuelle » prête en moins d'une seconde (attente de 8 s de la mini-carte supprimée).
- **0.6.9-7** (27/10/2026) : profil : « plateforme » au lieu de « chaussée » entre les deux bords.
- **0.6.9-6** (27/10/2026) : profil : la case « Hauteurs à l'échelle » n'est plus grisée (cochée
  sur un profil, elle restait cochée et grisée sur un profil déjà à l'échelle, sans pouvoir être
  décochée).
- **0.6.9-5** (27/10/2026) : profil : case « Hauteurs à l'échelle » pour revenir de l'exagération
  des hauteurs à la même échelle que les distances.
- **0.6.9-4** (27/10/2026) : « Dévers » : lecture arrêtée là où le terrain remonte de 1 m
  au-dessus du bord (talus, butte : derrière, ce n'est pas une chute) ; dévers = pente moyenne du
  talus le plus raide, de son haut à son pied, et non plus la pente la plus forte sur 2 m ;
  profil : fin de lecture marquée, talus en droite rouge sur son travers, tracé en trait plein.
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
  communes) gardé dans le navigateur 3 mois (500 Mo au plus) : plus rapide, et toujours là quand
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
