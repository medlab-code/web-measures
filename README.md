# Mesures Panoramax (web-measures)

Application web de mesure sur les photos de rue [Panoramax](https://panoramax.fr), sans
installer QGIS : hauteur d'un objet, largeur d'une chaussée, distance entre deux points, à
préparer ou vérifier depuis le bureau.

Ses calculs viennent du plugin QGIS
[Visionneuse Panoramax](https://github.com/medlab-code/visionneuse_panoramax) (qui ne garde depuis que la
visionneuse), validés sur
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

Les calculs de chaque mode (point triangulé, hauteur, largeur, relevé, chute sur un pont,
« Dévers », pente en long, analyse fine du nuage LiDAR) sont expliqués dans
[docs/CALCULS.md](docs/CALCULS.md).

## Utilisation

**Télécharger** : prendre l'archive « Source code (zip) » de la dernière version (page
*Releases* du dépôt) et la décompresser ; seuls `index.html`, `src/` et `py/` servent à la page
(`tests/`, `tools/` et `docs/` peuvent être ignorés).

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
(photos favorites, export et import), **Couche**, **Vidéo** et **Parcours** (parcours gardés), avec le nombre de
résultats, de favoris et de parcours sur l'onglet ; en bas, les boutons **Filtre** (instance Panoramax, filtre des photos ; point orange quand un filtre est actif),
**Réglages** (hauteur de caméra, thème, options) et **Services**. La consigne de
mesure est dans la carte d'étape de la visionneuse. Thème jour ou nuit : comme le système par défaut, ou choisi
dans Réglages. Une section
s'affiche à la fois ; la dernière choisie est rouverte à la visite suivante.

**La carte** : fonds Plan IGN, orthophoto, ortho-express, PCRS, Modèle Numérique de Hauteur (LiDAR HD : estompage de la hauteur du
sursol : bâtiments, arbres, haies, talus), OpenStreetMap, et
**orthophoto avec noms** : noms des lieux et des rues, voies, avec les numéros de route dans
des cartouches dessinés comme ceux de l'IISR (rouge pour les autoroutes et nationales, jaune
pour les départementales, cyan pour les métropolitaines, vert pour les européennes), limites
des départements (bleu), de la métropole (vert) et des communes (tirets noirs). Les
autoroutes et nationales paraissent dès le zoom 7, les départementales dès le zoom 10, les
autres voies dès le zoom 15. Les points de repère sont dessinés en bornes (tête à la couleur
du réseau, numéro du PR), à côté de la voie, sur tous les fonds, ou sur aucun selon « Bornes des PR sur la carte »
(Réglages, Affichage). Le filaire Panoramax, semi-transparent, se
masque par sa case à cocher.

**Choisir une photo** : cliquer sur le filaire orange de la carte (photo la plus proche) ; la
photo s'ouvre dans la visionneuse officielle Panoramax. Les flèches de la visionneuse passent
aux photos voisines, et le **lecteur de séquence** en bas de la visionneuse la fait défiler en
avant ou en arrière (chaque appui sur un sens : 1x, 2x, 4x, 8x, 16x). On peut aussi y aller
par le **requêteur route + PR**, ou coller l'**identifiant** d'une photo (ou un lien
Panoramax) dans « Aller à la photo » ; « 📋 Copier » sous l'identifiant de la photo affichée
le copie, pour la passer à un collègue.

**Parcourir une route** : onglet **« Vidéo »** du panneau : la
route, le PR de départ (+ distance) et le PR d'arrivée (+ distance), choisis dans des listes
comme dans le requêteur, la vitesse (1x, 2x par défaut, 4x ou 8x : une photo tous les 5, 10, 20 ou 40 m
pour les photos du CD21) et le regard ; puis **« ▶ Parcourir »**. Départ et arrivée peuvent aussi se
choisir sur la mini-carte : **📍** puis un clic (Échap : annuler) ; le point cliqué est gardé tel
quel et les champs se remplissent d'après la route et le PR trouvés là (la route déjà saisie
d'abord : à un carrefour, l'autre route ne la remplace pas) ; retaper un PR revient au PR. Les deux points sont marqués sur
la carte (départ vert, arrivée rouge, en épingles) ; la photo la plus proche du départ, prise dans le sens du parcours (le filtre
s'applique : « Depuis » pour choisir une campagne), défile jusqu'à l'arrivée, où la lecture
s'arrête. Chaque photo attend que les tuiles HD de la vue soient chargées (4 s au plus) : vue
nette, mais une quinzaine de tuiles par photo (de l'ordre de 200 Mo par kilomètre en 2x, 100 Mo en 4x) et une
lecture qui ralentit sur un réseau lent. **Regard dans l'axe** : la vue reste dans l'axe du véhicule, y compris dans les
virages (la caméra, parfois montée de biais, est redressée de son écart médian avec la
trajectoire), et elle est abaissée ou relevée de la pente de la route (altitudes GPS des photos
sur ± 20 m) : les panoramas ne sont pas mis à niveau et penchent avec le véhicule ; l'horizon
reste ainsi en place. Le roulis (dévers) n'est pas corrigé. **Regard libre** : le parcours s'arrête
d'abord sur la photo de départ, le temps d'orienter la vue (bandeau « ▶ Partir » en haut de la
visionneuse) ; elle est ensuite gardée tout le long. Le parcours prend d'abord une séquence qui passe à moins de 40 m du départ et à l'arrivée (au
plus 10 m plus loin que la plus proche : une route voisine n'y passe pas), et
s'arrête à la photo d'arrivée. S'il n'y en a pas, il en est prévenu au départ (bandeau
« ▶ Partir » : les photos peuvent différer, date, lumière, sens de prise de vue) : il part sur
la séquence qui va vers l'arrivée et bifurque sur une séquence qui passe à l'arrivée (tracé lu
sur 500 m de part et d'autre) quand elle passe à 30 m : au saut le plus lisse (moindre virage,
quitte à sauter jusqu'à 30 m au lieu des 5 m d'une séquence), pas tant que la séquence lue suit
ce tracé vers l'arrivée. À défaut, là où elle s'écarte de l'arrivée (40 m de plus qu'au plus près) ou
finit, il se rebranche à cet endroit sur une autre séquence qui y va (une qui passe à l'arrivée
d'abord, sinon d'après le cap de la caméra) ; les vues prises sur la branche quittée ne vont pas
dans l'export. Sans séquence pour continuer, il s'arrête en le disant. Pause et
reprise par le lecteur ; une autre photo choisie (carte, requêteur) y met fin.
**« WebP animé »**, dans le même onglet, exporte le dernier parcours (largeur de la vue, 1 280 px
au plus ; 0,4 s par vue, fondu enchaîné de 0,14 s entre deux vues, en boucle ; environ 15 Mo par
kilomètre à 970 px) :
chaque vue est gardée pendant la lecture, l'export ne recharge rien. Grisé pendant la lecture,
sans parcours et dans Safari, qui n'encode pas le WebP.
**Vidéo du départ à l'arrivée** (même onglet), sans lire le parcours dans la visionneuse :
« 🎬 Préparer la vidéo » cherche ses photos : elles sont choisies le long de l'itinéraire routier de la Géoplateforme (Valhalla sur la BD TOPO, en voiture, le
plus rapide) du départ à l'arrivée par les étapes (une étape impose un passage que l'itinéraire n'aurait pas pris) : tous
les 5 m, les photos à moins de 12 m prises dans le sens de la marche, ou dans l'autre sens (lues à rebours : l'arrière du
véhicule se retrouve à l'avant de la vidéo ; leur nombre est affiché sous les listes) ; la séquence de chaque pas est
choisie sur tout le parcours d'un coup (programmation dynamique), par ordre d'importance : le sens (vers l'avant, à
rebours seulement faute d'autres photos), puis la proximité dans le temps des séquences enchaînées et le moins de
changements (un changement vaut 1, plus 1 par 90 jours d'écart entre les deux séquences) ; un passage sans photo est
sauté ; trajectoire virtuelle : chaque photo retenue est ramenée sur le tracé de l'itinéraire (le point le plus
proche), qui donne l'avancée et le cap de la vidéo (l'axe de la route, y compris aux changements de séquence : pas
d'arrêt, de recul ni de balayage latéral, la vitesse continue) ; photos à plus de 6 m du tracé (autre voie, mal
placées) retirées ; léger flou au raccord de deux séquences (4 vues moyennées) (essais : `tests/essai-chassagne.html`, croisement de la D113A à Chassagne-Montrachet et grand détour de la D906
jusqu'au PR 75 + 645 : 3 séquences, aucune photo à rebours ; `tests/essai-boucle.html`, D906 du PR 84 + 220 au
PR 76 + 900 : une séquence, sans les boucles sur la RD 33). Sans réponse du service d'itinéraire, ou sans photo le long,
recherche de proche en proche (même choix de séquences que la lecture ; plusieurs séquences au départ : celle qui fait
le moins de changements). Il prévient
aussi, dans la ligne d'état en orange et sous les listes, si le
parcours passe d'une séquence à l'autre (dates des séquences ; les photos peuvent différer) ; « 🎬 Enregistrer la
vidéo » demande le fichier puis la calcule (deux clics : le navigateur n'ouvre la boîte d'enregistrement que juste
après un clic). Changer le départ ou l'arrivée oblige à la préparer de nouveau. La vidéo est calculée image par
image, hors de la visionneuse : 1920 × 1080 (1280 × 720 si le poste n'encode pas le 1080p), 30 images par seconde, H.264 à 30 Mbit/s
(environ 3 Mo par seconde de vidéo ; 10 Mbit/s donnaient une image floue). Firefox sous Linux, en français, annonce le
H.264 sans réussir à l'encoder (bug Mozilla 2085549 : niveau « 3,1 » écrit avec une virgule ; lancé avec
`LC_NUMERIC=C`, il l'encode) : VP9 à 20 Mbit/s, de qualité voisine, calcul environ quatre fois plus long, fichier lu
par Chrome, Firefox et VLC, peut-être pas par PowerPoint, une seconde d'arrêt au début et à la fin. Deux listes à côté du bouton : la vitesse
simulée (de 30 à 720 km/h, 90 par défaut, puis Mach 1 et Mach 2 : 1 235 et 2 470 km/h, vitesse du son au niveau de
la mer ; des photos y sont sautées) et la part des photos de la séquence prises (1/1, 1/2, 1/4, 1/8 ;
chaque choix indique l'écart obtenu, par exemple « une tous les 10 m »).  S'affichent aussi le nombre de photos retenues, la durée de la vidéo et le nombre de photos
par seconde ; au-delà de 30 photos par seconde (une par image), des photos sont sautées. Liste « Mode » : « Présentation de
l'itinéraire » (à l'ouverture : compteurs PR et vitesse et titre ; ni accélération, ni V max ARP, ni haute qualité, flou
ou corrections de luminosité ; la vitesse simulée et la rampe, grisées, y sont remplacées par l'« Allure » : vite dans les
lignes droites, 150 km/h par défaut, de 50 à 300 ; dans les virages, vitesse telle que la vue ne tourne pas plus vite que
la réglette « Virages, rotation », 12 °/s par défaut, de 4 à 40, d'après la rotation du cap lissé sur ± 10 m : courbe
large, un peu plus lent, virage serré, beaucoup ; jamais sous « Au plus bas », 30 km/h par défaut ; départ, arrivée et
arrêts en douceur ; changements d'allure rapides, pas réalistes : la vitesse varie d'un facteur 2,7 en « Transitions »
au plus, 1 s par défaut, de 0,5 à 3 (150 → 55 km/h en 1 s, 150 → 30 km/h en 1,6 s ; 3 m/s² au moins près de l'arrêt) ;
vitesse lissée sur ± 8 m ; réglettes provisoires, à affiner ;
« Arrêts » : aux endroits choisis sur la mini-carte (📍, repère rouge, à moins de 30 m du parcours), la vidéo ralentit,
s'arrête le temps choisi, 3 s par défaut, de 1 à 10, et repart); « Croisements et ouvrages d'art » (décochée) : à la préparation (ou en la cochant), repères orange posés
d'eux-mêmes sur les croisements de routes revêtues de la BD TOPO (départementales, voies communales, giratoires ; pas les
chemins ni les routes empierrées) et sur les tronçons hors du sol (ponts, passages supérieurs, tunnels), à moins de 15 m
des photos, un par 30 m ; la vidéo y passe à la vitesse choisie (50 km/h par défaut, de 20 à 90) sur ± 15 m, freinage et
reprise progressifs ; clic sur un repère : retiré, 📍 : un point ajouté ; gardés avec le parcours, retirés à la
préparation s'ils sont à plus de 30 m du nouveau tracé. Bouton « ▶ Aperçu » (la vidéo préparée) : sans calculer la
vidéo, un repère ambre parcourt le tracé sur la mini-carte en temps réel, à l'allure de la vidéo (virages, arrêts, regards
aux croisements, point d'intérêt, tours d'horizon), avec sa vitesse et le temps écoulé ; second clic : arrêt. Le tracé de
la vidéo préparée est coloré selon la vitesse (tronçons de 10 m : bleu à 20 km/h, vert à 60, jaune à 100, rouge à 150 et
plus) et suit chaque changement de réglage ou « Revue détaillée » (compteurs PR, vitesse, accélération latérale et
V max ARP, sans rampe) ; le choix coche ou décoche ces options, retouchables ensuite, et une ligne d'aide le résume.
Les options ci-dessous sont repliées sous « Options avancées », sauf le titre ; chacune a sa case. « Corrections de luminosité » (décochée) : la luminosité de chaque photo est mesurée sur sa vignette (tout le tour
d'horizon, sans le ciel ni le toit du véhicule ; rouge, vert et bleu séparément), six à la fois à la préparation, et gardée
dans le navigateur (un second rendu du même parcours ne recharge rien ; une photo toutes les 0,2 s : environ 30 Kio par
photo, 50 Mo pour 5 km la première fois). Une photo isolée que la caméra a ratée (25 à 85 % plus claire ou plus sombre
que ses voisines dans une forêt) est ramenée sur la médiane des photos de sa séquence prises à ± 0,6 s, si elle s'en
écarte de plus de 22 % (même gain sur les trois couleurs : la teinte ne change pas) : la vidéo ne clignote plus, et les vrais changements du décor (clairière, champ) sont gardés.
Ne sont pas corrigés : la surexposition qui dure 2 à 3 s à la sortie de l'ombre (la caméra s'adapte lentement ; une
médiane plus large l'atténue mais assombrit aussi le décor des forêts) et le ciel brûlé sous les arbres (perdu dans la
photo). Raccords de séquence, avec ou sans l'option, pour qu'ils se voient le moins possible : la séquence suivante est
choisie là où ses photos et celles de la précédente sont au même endroit (un mètre d'écart compte comme un tiers de
changement de séquence) ; une autre campagne pouvant être bien plus claire ou plus sombre (juillet 2025 : 1,5 fois plus
clair que mai au carrefour RD18 / D115D), la nouvelle séquence est ramenée sur la précédente (3 photos mesurées de part
et d'autre, rouge, vert et bleu), puis revient peu à peu à sa propre exposition sur 100 m ; le fondu entre les deux
photos du raccord occupe tout leur écart (et non sa moitié centrale), sans flou ajouté. « Rampe de vitesse » (décochée, grisée en Présentation) : la vitesse choisie devient celle des lignes droites ; la
vidéo ralentit dans les virages et aux carrefours (facteur 1 / (1 + rotation du cap / 1,5° par mètre), la rotation
au-delà de 1° par mètre, virage marqué, comptant double ; jusqu'à 35 % au plus bas : virage de 30 m de rayon à 37 %), part et s'arrête en douceur sur 50 m, sans à-coup (vitesse lissée sur ± 15 m) ; la durée affichée en
tient compte. Sur la D115D (1,1 km, rayon de 95 m au plus serré), la vitesse varie de 76 à 100 % et la vidéo passe
de 47,5 à 53 s à 90 km/h. « Titre » (cochée, au-dessus des options avancées) : carton au début,
cadre sombre en haut au centre, un peu écarté du bord, souligné d'un trait ambre, titre en gras et sous-titre plus clair
centrés, descendu en fondu à l'entrée (0,3 à 0,9 s), effacé en fondu de 4 à 4,6 s ; texte libre (80 caractères) et sous-titre libre, ou,
laissés vides, la route et les PR de départ et d'arrivée, et la date des photos ; « Rappel en incrustation » (décoché) :
le titre en petit en haut à gauche ensuite, jusqu'à la fin ; champs grisés sans titre. Aperçu : `tests/apercu-titre.html`. « Compteur PR » (cochée à l'ouverture) : en bas à gauche, la route et
le PR ; les mètres défilent en continu, en rouleaux comme un compteur kilométrique (interpolés image par image entre
les photos ; au passage d'un PR, l'ancien va jusqu'à son bout, puis le nouveau). Le PR de chaque photo est cherché à
la préparation, sur la route du parcours (autre route après une bifurcation : cherchée une fois), avec les sections
et PR de la BD TOPO déjà gardés en cache. « Compteur de vitesse » (cochée à l'ouverture) : en bas à droite, dans le même cadre,
la vitesse de la vidéo à chaque instant en km/h (rampe, ralentissements, arrêts du tour d'horizon), lissée sur un
quart de seconde comme une aiguille ; chiffres en rouleaux, zéros de tête masqués. « Accélération latérale » (décochée) : en bas à droite, à gauche du compteur
de vitesse s'il est affiché, l'accélération latérale ressentie (« Accél. ressentie »), en millièmes de g (mG) :
a / g - dévers en valeur absolue (en ligne droite, la pente en travers de la chaussée ; dévers compté nul s'il manque),
pic du virage affiché tel quel (le chiffre monte aussitôt et ne redescend que de 20 mG au moins : pas de battement),
a = v² × courbure, la courbure étant la rotation du cap lissé sur 10 m (trajectoire lissée sur ± 15 m : les
virages de moins de 30 m de rayon environ sont sous-estimés). Chiffre coloré selon le frottement transversal mobilisé
f = a / g - dévers (dévers vers l'intérieur du virage), comparé à celui des rayons de l'ARP (SETRA, août 1994, § 3.1) à
cette vitesse (ramenée entre 60 et 100 km/h, les catégories R 60, T 80 et R 80, T 100) : vert jusqu'au rayon non déversé
Rnd (600, 900, 1 300 m, chaussée en toit à 2,5 % : f = 0,072, 0,081, 0,086), jaune jusqu'au rayon minimal Rm (120, 240,
425 m, dévers de 7 % : f = 0,166, 0,140, 0,116), rouge au-delà. Dévers lu sur le MNT LiDAR HD (service d'altimétrie de
la Géoplateforme ; pas le RGE ALTI, trop grossier ; lent, car le service n'accepte que 5 requêtes par seconde : 1 min
environ pour 5 km, avancement affiché) : plan ajusté sur 15 points à ± 1,5 m autour de la caméra, en cochant
l'option ou à la préparation ; l'aide de l'option dit si les couleurs sont conformes à l'ARP (dévers lu partout) ou
approchées (dévers compté nul là où il manque). Sur un pont, le LiDAR donne le terrain sous le tablier : dévers faux. « Vitesse max ARP » (décochée) : en bas à
droite, au-dessus du compteur de vitesse, la plus haute vitesse à laquelle le virage resterait vert (même calcul, même
dévers, seuil du rayon non déversé de l'ARP à cette vitesse), la plus basse sur 30 m (point critique du virage, affiché tel quel ; le chiffre ne remonte que de 5 km/h au moins) ; « — » à 150 km/h ou plus (ligne droite,
grande courbe). Calcul, seuils de l'ARP et exemples détaillés : [`docs/CALCULS.md`](docs/CALCULS.md),
§ 11. Au raccord de deux séquences, le cap de la vue est lissé plus
largement à moins de 40 m (± 40 m au lieu de ± 15 m, retour en douceur sur les 40 m suivants : le décalage des deux
trajectoires ne fait pas de coup de volant ; 1,5 m de décalage : cap écarté de 1,1° au lieu de 2,9°) et le fondu d'une séquence à l'autre est toujours flouté (flou cinétique, même décoché) pour masquer
leurs différences. Le panoramique au changement de séquence (tour complet sur le raccord) a été retiré. « Regard aux croisements » (décochée) : à l'approche d'un carrefour avec une
route revêtue (BD TOPO : route à une ou deux chaussées, rond-point, bretelle, type autoroutier ; pas les chemins de
vigne), la vue se tourne en 0,8 s vers la voie croisée, dans son axe dès 0,9 s avant le carrefour (anticipation), et
le reste au niveau du carrefour (cap de la
voie à 10 m du carrefour, 120° au plus ; voies des deux côtés : la gauche jusqu'au passage, puis la droite), puis
revient dans l'axe du parcours par le même mouvement, deux fois plus vite (un seul regard pour des carrefours à moins
de 60 m, giratoire) ; pour avoir le temps de voir la voie, la vidéo ralentit pendant tout le regard (freinage et
reprise en 1,5 s) jusqu'à la « vitesse de regard » (réglette de 30 à 130 km/h, 70 par défaut), en plafond progressif :
v / (1 + (v / V)³)^(1/3), presque rien en dessous (30 → 29 km/h), V au plus au-dessus (90 → 62, 360 → 70 km/h) ; la maquette de la chaussée reste dans l'axe de la route. « Point d'intérêt » (décochée, un seul pour l'instant) : la cible est un objet du relevé (liste « Cible » :
« n° 3 · premier champ »), triangulé dans Mesure → Relevé d'objets ; sans objet, la liste est grisée et invite à en
relever un. Sa position et son altitude NGF font viser juste, jusqu'en hauteur (le sommet d'un clocher si c'est lui
qu'on a visé) ; la caméra : sol sous elle (LiDAR HD, sinon RGE ALTI) plus 2,4 m ; objet sans altitude : sol sous lui.
Zone de l'effet : « ✏ Zone » puis deux clics sur la mini-carte le long de la route (seules les extrémités comptent,
ramenées sur le parcours à 30 m au plus ; la vidéo préparée, la portion du parcours concernée s'affiche en violet ;
clic sur le trait : zone retirée) ; sans trait, 150 m avant et après le passage au plus près. Dans la zone, la vue se
tourne vers la cible en 1 s et la suit (120° au plus), puis revient dans l'axe en 0,5 s. Réglettes : vitesse pendant
l'effet (de 30 à 130 km/h, même plafond progressif que le regard aux croisements, ou « sans ralentir »), zoom max
(× 1 à × 3 ; net jusqu'à × 1,4 environ, les tuiles étant prises en pleine définition) ; interrupteurs « Zoom lié à
la distance » (la cible garde à peu près sa taille : zoom plus fort de loin, × 1 au plus près ; sinon il monte
jusqu'au passage au plus près puis redescend) et « Tonneau au plus près » (durée et alternance des tonneaux).
« Tonneau » (décochée) : aux endroits choisis par 📍 sur la mini-carte (un par clic, repère bleu, un clic
sur le repère le retire ; à moins de 30 m du parcours, sinon la vidéo le refuse avec son numéro), l'image fait un
tour complet de roulis, dans un sens puis dans l'autre d'un tonneau au suivant (ordre du parcours) (durée réglable de 1 à 10 s, 3 s par défaut), lent au
départ et à l'arrivée, pendant que la caméra avance ; titre et compteur restent droits ; activer l'interrupteur sans endroit
lance le choix sur la carte, poser un endroit l'active, retirer le dernier le désactive. « Petite planète » (décochée) :
sur les tronçons tracés sur la mini-carte (📍 puis un clic au début et un à la fin, trait bleu nuit et repère vert
d'eau en son milieu, extrémités à moins de 30 m du parcours, 50 m au moins ; un parcours gardé avant le 01/11 n'a que
l'endroit : 50 m centrés sur lui), la vue descend vers le sol en
s'élargissant jusqu'à 300° (passage continu de la perspective à la projection stéréographique) : le paysage s'enroule
en boule, route vers le haut, et la planète tourne avec la route ; enroulement au début du tronçon et déroulement à
sa fin (réglette « Transition » : 0, 1, 2 ou 3 s, 1 s par défaut, la moitié du tronçon au plus ; 0 : planète d'emblée
sur tout le tronçon ; interrupteur « Tonneau pendant la transition » : un tour complet de roulis pendant l'enroulement,
un autre en sens inverse pendant le déroulement, grisé sans transition ; interrupteur « Tout le parcours » : du départ à l'arrivée, sans tronçon à tracer, 📍 grisé), la
caméra continue d'avancer ; réglette « Rotation » : elle
tourne aussi sur elle-même (de 0, sans, à 90° par seconde, 20 par défaut ; vue revenue droite à la fin) ; tout le tour des photos est chargé sur ces
tronçons (tuiles réduites au tiers). Le toit du véhicule occupe le centre de la planète. « Tour d'horizon » (décochée) : aux endroits
choisis de même (📍, repère brun), la vue fait un tour complet dans le plan de l'horizon pour montrer les espaces
plats, lent au départ et à l'arrivée, sens alterné d'un tour au suivant (réglette de 2 à 20 s, 8 s par défaut) ;
« Arrêt pendant le tour » (coché) : la caméra s'arrête le temps du tour sur la photo la plus proche (image nette, la
vidéo s'allonge d'autant), sinon elle continue d'avancer. Ces
options chargent plus de tuiles aux endroits concernés (tout le tour pour le tour d'horizon). « Flou cinétique »
(décochée par défaut) : chaque
image est la moyenne de 8 vues réparties depuis la position de l'image précédente (obturateur ouvert toute l'image) ;
ce qui défile vite près de la caméra (chaussée, muret, vignes du bord) s'étire dans le sens du mouvement, le lointain
reste net ; calcul plus long (rendu huit fois, sans téléchargement de plus). Moins de photos :
moins de téléchargement (environ 5 Mo de tuiles par photo), mais plus d'écart à combler entre deux photos. Les images viennent des tuiles HD des photos du parcours (seulement celles du champ).
Regard dans l'axe de la trajectoire lissée sur ± 15 m (sans les à-coups du cap de chaque photo), horizon
corrigé de la pente de la route, champ de 80° (le toit du véhicule n'y entre pas). Entre deux photos, la
caméra avance réellement dans une maquette simple de chacune (chaussée plane sur 4 m de part et d'autre
de l'axe, reste du décor sur une sphère de 60 m) : la chaussée défile sans à-coup, puis la photo suivante
prend le relais en fondu. Limites : un objet proche et haut (arbre, poteau) se dédouble pendant le
fondu, la ligne des collines aussi un peu (photos qui ne penchent pas pareil). « Haute qualité (lent) »
(décochée) : toujours en 1920 × 1080, mais débit bien plus élevé (H.264 80 Mbit/s au lieu de 30, VP9 50 au lieu de 20)
pour les détails fins (vignes, graviers, feuillages, fils), photos en pleine définition et vue calculée en double
définition puis réduite (bords sans escalier) ; calcul environ 1,5 à 2 fois plus long (davantage avec un réseau lent),
fichier 2,5 fois plus gros. Chaque photo est vue de sa propre caméra et passe à la suivante par un fondu enchaîné
(l'avancée simulée dans une maquette, retirée le 01/11/2026, faisait sauter le ciel et les côtés). Le calcul prend environ
deux fois la durée de la vidéo si les tuiles sont déjà en cache (« ■ Arrêter » l'interrompt) ; sous Chrome et Edge, la
vidéo est écrite dans le fichier choisi au fur et à mesure (mémoire constante, même pour un long parcours ; arrêt ou
échec : fichier laissé vide), sous Firefox assemblée en mémoire puis téléchargée ; l'avancement s'affiche dans la ligne
d'état, et l'erreur éventuelle y reste. Bibliothèque
mp4-muxer chargée au premier export seulement. Grisé tant que le départ ou l'arrivée manque, pendant la
préparation et le calcul, et dans les navigateurs sans WebCodecs.

Les endroits des effets (arrêts, ralentissements, tonneaux, petites planètes, tours d'horizon) à plus de 30 m du
parcours, repères d'un autre parcours par exemple, sont ignorés par la vidéo (elle n'échoue plus) et nommés dans le
message de fin (« Repères ignorés, à plus de 30 m du parcours : arrêt n° 1 à 791 m »).

« ↺ RAZ » (onglet Vidéo) remet le parcours et ses réglages à zéro : départ et arrivée effacés, options et réglettes
à leur valeur par défaut, endroits des tonneaux, planètes et tours retirés, zone du point d'intérêt effacée ; le filtre
des photos et les parcours gardés ne changent pas. Grisé quand tout est déjà à zéro et pendant le calcul.

**Parcours gardés** (onglet Parcours) : « ☆ Garder » (onglet Vidéo, dès que départ et arrivée sont saisis) garde le
parcours avec tous ses réglages : départ et arrivée (route, PR et distances, points sur la carte), vitesse, part des
photos, toutes les options et leurs réglettes, endroits des tonneaux, des petites planètes et des tours d'horizon, zone et cible du point
d'intérêt, filtre de date des photos. Nommé d'après la route et les PR, daté ; pastille jaune si au moins un effet « communication » est activé (tonneau,
petite planète, point d'intérêt, regard aux croisements, tour d'horizon), verte sinon ; gardé dans ce navigateur. Un clic sur
son nom le rouvre dans l'onglet Vidéo (vidéo à préparer), ⤓ l'exporte seul (fichier JSON à envoyer à un collègue),
× le retire ; rouvert, la ligne est entourée et « ☆ Garder » devient « ☆ Gardé » (grisé) ; modifié, « ☆ Enregistrer… »
propose de l'enregistrer dans ce parcours ou d'en créer un nouveau (l'ancien reste tel quel) ; en tête, export de toute la liste et import (la liste ou un seul, ajoutés à ceux-ci ; fichier venu
d'ailleurs : seuls les réglages connus sont repris). Cible du point d'intérêt : l'objet du relevé au même endroit,
sinon celle du parcours, proposée en plus dans la liste « Cible » (« parcours gardé »). Les autres filtres
(instance, producteur…) ne sont pas gardés.

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
    altitude NGF, moins la hauteur de caméra (mesurée sur la séquence vérifiée, sinon calée ; à
    défaut, le réglage « Caméra à », seulement après un appui sur le bouton de l'encadré : une photo
    de précision déclarée n'a que sa hauteur au-dessus du fond franchi) ; pour chaque point, la
    photo la plus proche ;
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
  sur une photo hors pont, à moins de 15 m d'une route de la BD TOPO (orientée comme la route parcourue, à 45°
  près : à un carrefour, pas la voie qui croise), un appui sur « Dévers »
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
    le même sens, sur trois pas de suite (fossé, talus), ou d'où le terrain fait une marche de 5 cm
    ou plus sur 0,5 m qui tient sur 1,5 m (bordure, accotement plus bas) ; sans rupture de pente
    (accotement de plain-pied), la demi-largeur BD TOPO (sinon 3 m) ; l'infobulle dit où le bord
    a été trouvé, et comment ; un bord d'un travers à plus de 3 m de la médiane des bords trouvés
    de ce côté (une marche dans la chaussée, un bord flou) y est ramené ; **chaussées séparées**
    (autoroute, voie express : un tronçon BD TOPO par sens, de même nom, parallèle, son axe à 4 à
    40 m en travers, ticket #34) : du côté de l'autre chaussée, le bord est cherché au-delà de son
    axe et jusqu'à 9 m après son bord BD TOPO (largeurs souvent trop faibles), pente de référence
    sous cet axe, sinon son bord extérieur BD TOPO ; la plateforme comprend le séparateur de
    chaussée et l'autre chaussée ; **séparateur de chaussée** : entre deux marches de sens
    contraires (surélevé : montée puis descente ; en creux : l'inverse), large de 0,5 à 10 m, au
    milieu à 4 m au plus de celui que donnent les largeurs BD TOPO, recoupé d'un travers à l'autre ;
    à défaut, une bosse étroite (1 ou 2 points, 4 cm au-dessus des voisins : assise de glissières dos
    à dos ou de muret, que le terrain LiDAR ne garde pas) au même endroit sur deux travers au moins ;
    sinon d'après la BD TOPO ;
  - **chute** : la plus grande descente entre le terrain au bord de la chaussée et le point le
    plus bas du profil, avec la distance de ce point (le plus proche du bord, à 5 cm près) ;
    « chute ≥ … au-delà de 10 m du bord » quand le point le plus bas est au bout du profil (le
    terrain descend encore : pousser la réglette) ;
    la lecture s'arrête là où le terrain remonte de 1 m au-dessus du bord (talus, butte) : ce
    qu'il y a derrière n'est pas une chute (« pas de chute avant le terrain qui remonte… ») ;
    ne dépend pas de l'altitude GPS : pas besoin de RTK ;
  - **dévers** : pente moyenne du talus le plus raide (0,5 m de haut au moins) avant cet arrêt,
    sur les cinq travers, de son haut à son pied (hauteur divisée par largeur), en % et en degrés,
    avec sa hauteur ; le talus est la partie d'une descente (pente lue sur 2 m d'au moins 10 %)
    dont la pente vaut au moins le tiers de la plus forte : ni l'accotement en pente douce
    au-dessus, ni la queue du pied.

  Sinon s'affichent « Calcul en cours… », « Aucun bord ne descend de 0,5 m ou plus », « Pas de
  route de la BD TOPO à moins de 15 m » ou « Calcul impossible » avec sa cause.

  - **pente en long** : terrain (même modèle) lu tous les 2 m sur ±50 m autour de la photo, le long de la
    **trajectoire de la caméra** (photos de la même séquence, de rangs qui se suivent : là où elle a roulé, virage
    à un carrefour compris) ; à défaut, le long de l'axe BD TOPO prolongé par les tronçons voisins de la même route (lus jusqu'à
    60 m autour de la photo ; à un nœud, celui qui continue le plus dans l'alignement, à 60° près),
    à la même distance de l'axe que l'origine (l'axe peut s'écarter de la voie de quelques mètres) ;
    repères de la BD TOPO, placés le long de la route : « fin de la D16 » là où elle s'arrête (aucun tronçon de la
    même route ne continue : le profil s'arrête là aussi, même si la caméra a continué sur une autre route, et les
    pentes ne portent que sur la partie gardée), « carrefour avec D18 » là où une voie nommée (numéro ou nom) s'y
    raccorde (deux raccordements de la même voie à moins de 30 m, comme autour d'un îlot séparateur : un seul
    carrefour, au milieu) ; les voies sans numéro ni nom ne sont pas mentionnées ; ponts : le MNT y donne le fond
    franchi ; un creux (corde de 40 m au plus à plus de 0,1 m au-dessus du terrain, appuyée en haut des parois) est
    remplacé par cette corde s'il recouvre un pont de la BD TOPO ou si le terrain y plonge de plus de 20 % (une route :
    15 % au plus), un vallon que la route suit restant tel quel (le tablier, à peu près, en tirets « pont (tablier interpolé) », ou
    « creux du terrain (pont ?) » hors des ponts de la BD TOPO, souvent plus courts que la brèche), pentes comprises ;
    creux ouvert au bout du profil : coupé ; tunnels de la route (BD TOPO) : le dessus remplacé par la droite d'une tête
    à l'autre ; pente moyenne par les moindres
    carrés (montée ou descente dans le sens de la photo) et pente la plus forte sur 10 m ; une ligne de l'encadré,
    et un petit graphique (profil en long) sous le profil en travers, repris dans l'image PNG.

  Le bouton **« Profil »**, à côté, montre la coupe du terrain que ce calcul a lue (mesure LiDAR
  HD, ou RGE ALTI en secours) : travers de la photo en brun, les quatre autres en pointillés,
  plateforme entre les deux bords trouvés (et comment : rupture de pente ou largeur BD TOPO), milieu du
  séparateur de chaussée sur une route à chaussées séparées (petite barre verticale ; la légende dit s'il a
  été trouvé dans le relief ou placé d'après la BD TOPO), flèche
  de la chute et droite rouge du talus (haut → pied) sur le travers où ils ont été mesurés,
  hauteurs exagérées (facteur écrit sous le graphique) ; la case « Hauteurs à l'échelle » (cochée à chaque
  ouverture) les remet à l'échelle des distances, caméra dessinée à sa hauteur (réglage « Hauteur de caméra »), masquée quand
  les hauteurs sont exagérées. « Enregistrer en PNG » en fait une image
  avec son titre et sa légende ; « Enregistrer en PDF » met le graphique et la légende (en petits caractères, sur deux
  colonnes) sur une page A4 paysage, en vectoriel, sous le lieu de la photo (route, PR, commune), à enregistrer en PDF
  dans la boîte d'impression ; « Profil en long (2e page) » (choix retenu) y ajoute une page pour le profil en long ; la loupe agrandit le graphique (sans la légende) au mieux dans la
  visionneuse. Le bouton est grisé tant que « Dévers » n'a rien calculé pour la photo.

  **« Analyse fine »** (fenêtre du profil) : lit le nuage de points LiDAR HD de l'IGN (dalles COPC, à la volée,
  1 requête par seconde au plus : une vingtaine de secondes, 1 à 2 Mo) sur ±1 m le long de la route au travers
  de la photo. L'intensité du retour laser des points du sol distingue l'enrobé (sombre), les lignes blanches
  (bandes étroites très claires) et les surfaces non revêtues (herbe, gravillons, béton : larges et claires).
  **Bord de chaussée** (tiret court) : la ligne de rive, ligne blanche au début de la première bande non revêtue
  d'1 m ou plus, ou la dernière avant elle, hors des lignes entre voies (à moins de 1,2 m de l'axe d'une
  chaussée) ; sinon la fin de l'enrobé. **Séparateur de chaussée** : la bande non revêtue entre les deux
  chaussées (glissières comprises, que le terrain seul ne voit pas), à 2 m au plus de celui du calcul, qu'elle
  remplace (« nuage LiDAR »). Les lignes blanches sont dessinées en petits carrés blancs. Le bouton est grisé
  pendant la lecture et une fois l'analyse faite pour ce profil. **Bande vert clair** : herbe au sol (classée « sol »
  par l'IGN) : bande non revêtue d'1 m au moins, en moyenne 3,5 fois plus claire que l'enrobé (le laser, en proche
  infrarouge, est très renvoyé par la végétation ; gravillons et béton : 2 à 3 fois). La case « Végétation » (cochée par défaut, choix retenu, grisée tant que l'analyse fine
  n'a pas été faite) montre ou masque la bande
  vert clair et la ligne verte. **Ligne verte** : hauteur maximale de la
  végétation (points classés herbe haute, arbustes et arbres par l'IGN), plus haut point à ±0,25 m près, coupée en
  haut du graphique ; la légende dit, de chaque côté, où elle commence et sa hauteur au-dessus du sol (relevé LiDAR
  de 2021 à 2024 : fauchage, élagage ou repousse depuis). **Eau** : dès le calcul « Dévers », cours d'eau de la BD
  TOPO croisés par le travers de la photo (triangle bleu nommé ; tronçons fictifs et souterrains écartés) et surfaces
  d'eau traversées (canal, plan d'eau : bande bleue posée sur le terrain, qui est sur l'eau au niveau de sa surface), sur 45 m de part et d'autre ; avec l'analyse
  fine, surface de l'eau lue dans le nuage (points classés eau par l'IGN, ligne bleue à leur altitude, au niveau du
  jour du relevé ; souvent absente : l'eau renvoie mal le laser). Pendant la lecture du nuage, une barre d'avancement
  (animée tant que le nombre de blocs à lire n'est pas connu, puis remplie bloc par bloc, pourcentage à côté). Essai : `tests/essai-nuage.html` (`#photos=<id>,…` : d'autres photos, sans contrôle de
  position ; canal de Bourgogne : 3b8811e4).
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

**Cadastre** (réglage « Cadastre sur la carte », Réglages › Affichage, décoché par défaut ; ticket #36) : parcelles
du Parcellaire Express (IGN) sur la mini-carte dès le zoom 15, bornes de limite de propriété et étiquette de chaque parcelle (section au-dessus du numéro, « B » pour la
section 0B) dès le zoom 17, en tuiles vectorielles de l'IGN (nettes à tout zoom), feuilles
cadastrales mal raccordées à leurs voisines teintées d'orange (écart moyen aux raccords de plus de 2 m : limites
peut-être décalées, le cadastre étant un plan numérisé). Limites indicatives. Pas de projection dans la photo : un
essai l'a montrée trop imprécise au pied des façades (plan, sol interpolé sous les bâtiments, inclinaison de la photo).

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
couche, et le texte ajouté après la valeur de l'étiquette y est repris. **Fiches PDF de tous les objets** : bouton
« Fiches PDF des N objets » de la couche, un seul PDF, une page par objet. Toutes les photos sont prises dans une même
séquence Panoramax, chaque objet sur la plus proche de cette séquence. « Cadrage automatique » : séquence de la photo du
1er objet. « Cadrage type… » : la photo du 1er objet s'ouvre ; zoom, hauteur de vue et photo (tant de photos avant ou
après dans la séquence, par les flèches de la visionneuse) s'y règlent, puis sont repris pour chaque objet, le cap
tourné vers lui. Un objet sans photo trouvée est sauté et signalé. **Recalage dans la photo** (hors mesure) : clic sur la pastille ou l'étiquette d'un objet,
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

**Recaler un point** : **clic** (gauche ou droit) sur sa croix pour le sélectionner (à 12 pixels près, quel que
soit le zoom ; ailleurs, le clic est un point de mesure), puis :

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
  Géoplateforme là où il est publié, Modèle Numérique de Hauteur (LiDAR HD), OpenStreetMap ; recherche de lieux ; points de repère
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

Les calculs (cœur Python repris du plugin Visionneuse Panoramax) sont exécutés dans le navigateur par Pyodide (environ 10 Mo au
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
modèle de terrain (±0,1 m en LiDAR HD, ±0,4 m en RGE ALTI). Le dévers est une pente moyenne,
du haut au pied du talus : le haut et le pied sont placés au pas des points près (0,5 m près
du bord, 0,6 m au-delà pour 10 m examinés, 1,9 m pour 30 m), ce qui pèse sur un talus court.
Sous des arbres ou un mur, le modèle de terrain est interpolé et adoucit la pente. Le bord de
la chaussée vient d'une rupture de pente du terrain, sinon de la largeur BD TOPO. Pas encore
comparé à des talus de hauteur connue.

Pente en long (`tests/essai-bords.html`, photos 732c2c09, cd5e947c, d148d430 et 70b78dc8) : profils
cohérents avec la route vue sur la photo, arrêt à la fin de la D16, un seul carrefour autour d'un
îlot séparateur, tablier d'un pont interpolé, y compris quand le pont de la BD TOPO est plus court
que la brèche du terrain (70b78dc8 : 86 % sur 10 m avant correction, 4,7 % après), ou en creux peu profond sur un
ruisseau (92e3faf1). Le MNT donne la pente à quelques dixièmes de point près
sur 100 m ; sur un pont, le tablier est une droite d'une culée à l'autre, sans sa courbure.

Analyse fine (`tests/essai-nuage.html`, A38, RD903bis, D1074, RD700) : bords de chaussée et
séparateur placés à la case du nuage près (0,25 m). Un marquage effacé ou une ligne de rive
absente renvoie à la fin de l'enrobé. L'herbe du séparateur de l'A38 n'est pas reconnue, et l'eau
du nuage n'a été vue sur aucune photo d'essai.

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
| `docs/CALCULS.md` | calculs de chaque mode, seuils et précision |
| `index.html`, `src/style.css` | page et mise en page |
| `src/app.js` | relie carte, visionneuse et calcul : clics, clavier, repères, liseré, filtre |
| `src/carte.js` | carte MapLibre : fonds, filaire, points de repère (PR), mesures, étiquettes, poignées, photo la plus proche |
| `src/traits.js` | surcouche des mesures dans la visionneuse, en WebGL : traits, croix, réticule glissant, étiquettes des mesures et noms des points (la couche importée reste en repères HTML) |
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
| `py/core/` | cœur de calcul (repris du plugin) : triangulation, calage, précision, mesures ; dont `widths.py`, la largeur depuis un point triangulé |
| `py/sources.js` | fichiers Python de `py/` regroupés pour la page (généré par `tools/sources.sh`) |
| `tests/coeur/` | tests du cœur de calcul : scènes synthétiques à réponse connue (lancés avec `tests/test_calculs.py`) |
| `tests/essai-cadastre.html` | cadastre sur la mini-carte (PNG dans le journal) |
| `tests/essai-profil-pdf.html` | profil en travers en PDF : la feuille tient sur une page (sa page HTML dans le journal) |
| `tests/test_calculs.py` | essais rapides des calculs, sans navigateur ni réseau (`python3 -m unittest discover -s tests`, quelques secondes avec `tests/coeur/`) |
| `tests/navigateur.html` | essai de bout en bout dans un vrai navigateur |
| `tests/essai-rtk.html`, `essai-largeur.html`, `essai-libre.html` | hauteur, largeur, mesure libre sur photos RTK, avec recalages |
| `tests/inclinaison.html` | inclinaison automatique |
| `tests/essai-calage.html` | calage de l'inclinaison : croix sélectionnée à 12 px près, au zoom fort |
| `tests/inclinaison-terrain.html` | inclinaison par le terrain hors agglomération (option) |
| `py/web_terrain.py` | inclinaison par le terrain hors agglomération : grille LiDAR HD, modèle de séquence |
| `tools/serveur-essai.py` | serveur des essais : sert le site et affiche leur journal |

Après toute modification d'un fichier Python sous `py/` : `tools/sources.sh` (régénère
`py/sources.js`). Tests sans navigateur : `python3 -m unittest discover -s tests`.

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
   services de l'hôte (réseau, altitude NGF, décodage d'image) installés par l'application. Le
   29/10/2026, le cœur et ses tests sont repris ici : le plugin ne garde que la visionneuse (et
   reçoit la recherche de lieu et le requêteur route + PR de l'application).
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

- **0.8.0** (01/11/2026) : vidéo du parcours refondue. Photos choisies le long de l'itinéraire de la Géoplateforme (Valhalla sur la BD TOPO), étapes 📍 pour imposer un passage, trajectoire virtuelle sur ce tracé (cap dans l'axe de la route, sans arrêt ni balayage aux raccords) ; séquences choisies sur tout le parcours d'un coup, par le sens (vers l'avant), puis la proximité des dates et le moins de changements ; raccords discrets (là où les photos se recouvrent, couleurs accordées, fondu sur tout l'écart, léger flou). Modes « Présentation de l'itinéraire » (allure selon les virages, changements d'allure rapides, arrêts, ralentissements aux croisements et ouvrages d'art retouchables, aperçu animé sur la mini-carte, tracé coloré selon la vitesse) et « Revue détaillée » ; options actuelles repliées en « Options avancées » ; titre soigné (carton en haut, texte libre, rappel en incrustation). Petite planète sur un tronçon tracé ou sur tout le parcours, transition réglable, tonneau pendant la transition. « Corrections de luminosité » (photos isolées ratées par la caméra). « Avancée simulée » retirée. Calcul : vidéo écrite au fur et à mesure dans le fichier (longs parcours sans manque de mémoire), titre et compteurs posés par la carte graphique (un tiers de temps en moins), plus de ralentissement en fin de vidéo, tuiles des photos de la recherche corrigées (vidéo noire). Services : délai maximal et nouveaux essais, cache géographique à 500 Mo ; repères loin du parcours ignorés. `LICENCES-TIERCES.md` (licences des bibliothèques, données et services).
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

## Licence

GPL v2 ou ultérieure (fichier `LICENSE`), comme le plugin dont les calculs sont repris. Bibliothèques, données et
services tiers, avec leurs licences et les mentions à garder : `LICENCES-TIERCES.md`.
