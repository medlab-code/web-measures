<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- © Cédric COCHART -->

# Guide d'utilisation détaillé

Mode d'emploi complet de Mesures Panoramax, essais chiffrés, organisation du code et choix techniques. Présentation
courte : [README](../README.md) ; calculs : [CALCULS.md](CALCULS.md) ; vue Bird Eye : [BIRDEYE.md](BIRDEYE.md).

## Utilisation

**Télécharger** : prendre l'archive « Source code (zip) » de la dernière version (page
*Releases* du dépôt) et la décompresser ; seuls `index.html`, `src/` et `py/` servent à la page
(`tests/`, `tools/` et `docs/` peuvent être ignorés).

**Sur téléphone** : `mobile.html`, version de consultation (sans le calcul ni les mesures) : photo en
haut, carte en bas, partage réglé par la poignée entre les deux ; recherche de lieux et requêteur route +
PR au-dessus ; Plan IGN et OpenStreetMap en tuiles vectorielles (texte net, agrandi de 30 %) ; bouton ⚙ des réglages : fond de carte (1. Orthophoto + (par défaut) ; 2. Plan IGN ; 3. Orthophoto ; 4. Ortho-express (année de la photo) ; 5. LiDAR MNT ; 6. LiDAR MNS ; 7. LiDAR MNH ; 8. OpenFreeMap), filaire Panoramax, bornes des PR, cadastre (parcelle visée en vert, son
étiquette dans la photo, caméra supposée à 1,90 m au-dessus d'un sol de niveau), filtre des photos (instance,
producteur, date de début ; mêmes réglages que la page principale), lien « version complète » dans les réglages ; bouton appareil photo : capture de la vue avec l'étiquette et les
cartouches, partagée par le téléphone (sinon téléchargée).

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
producteur et caméra, bouton « Ajouter » aux favoris, identifiant à copier ; position : précision GPS, sol, inclinaison
et calage, chacun avec son voyant ; détails ; « Photo aléatoire » (photo tirée au hasard de l'instance choisie parmi celles qui passent le filtre : producteur, date, type, précision GPS ; une séquence au hasard, puis une photo au hasard dans sa durée) ; « Aller à une photo » par son identifiant ou un lien ; export et
import du calage), **Favoris**
(photos favorites, export et import), **Couche**, **Vidéo** et **Parcours** (parcours gardés), avec le nombre de
résultats, de favoris et de parcours sur l'onglet ; en bas, les boutons **Filtre** (instance Panoramax, filtre des photos ; point orange quand un filtre est actif),
**Réglages** (hauteur de caméra, thème, options) et **Services**. La consigne de
mesure est dans la carte d'étape de la visionneuse. Thème jour ou nuit : comme le système par défaut, ou choisi
dans Réglages. « Taille des boutons et étiquettes » (Réglages › Affichage : normale, grande ×1,25 par défaut, très grande ×1,5 ; gardée dans le navigateur, effet
immédiat) grossit d'un bloc les boutons du haut de la visionneuse, les trois pastilles du bas et les boutons de la carte ; les tracés et étiquettes
de mesure dessinés sur la photo n'en changent pas. Une section
s'affiche à la fois ; la dernière choisie est rouverte à la visite suivante.

**La carte** : le fond se choisit dans le panneau du bouton en forme de carte pliée (en bas à droite de la carte, ancien « i »), au-dessus des attributions ; fonds Plan IGN (tuiles vectorielles, texte net ; dès le zoom 16, parcelles cadastrales en jaune léger, rues et chemins du domaine public en blanc, cadastre allumé ou non), orthophoto, ortho-express, LiDAR HD de l'IGN en ombrage (MNT : le sol nu ; MNS : sol, bâtiments et végétation ; MNH : hauteur du
sursol, bâtiments, arbres, haies, talus ; jusqu'au zoom 18, là où le LiDAR HD est publié), OpenStreetMap (tuiles vectorielles d'OpenFreeMap, texte net), et
**orthophoto avec noms** (« Orthophoto + », le fond par défaut ; le fond choisi est gardé dans le navigateur) : noms des lieux et des rues, voies, avec les numéros de route dans
des cartouches dessinés comme ceux de l'IISR (rouge pour les autoroutes et nationales, jaune
pour les départementales, cyan pour les métropolitaines, vert pour les européennes), limites
des communes (tirets noirs). Les limites des départements (bleu) et des métropoles (vert) sont sur tous les fonds. Les
autoroutes et nationales paraissent dès le zoom 7, les départementales dès le zoom 10, les
autres voies dès le zoom 15. Les points de repère sont dessinés en bornes (tête à la couleur
du réseau, numéro du PR), à côté de la voie, sur tous les fonds, ou sur aucun selon « Bornes des PR sur la carte »
(Réglages, Affichage). Le filaire Panoramax, semi-transparent, se
masque par le bouton « filaire » de l'étiquette verticale de la carte (sous le bouton Bird Eye ; enfoncé : visible ; choix mémorisé).
La carte reste toujours orientée nord en haut : plus de rotation (ni clic droit glissé, ni deux doigts, ni clavier), plus de boussole dans la colonne de boutons de la carte ni d'inclinaison. Sur la carte, le clic droit sert au geste de rotation de la droite de ↔ (voir « Largeur dans la visionneuse »).

**Choisir une photo** : cliquer sur le filaire orange de la carte (photo la plus proche ; « Recherche de la photo… » s'affiche au centre de la visionneuse pendant la recherche, comme « Tirage d'une photo… » pour « Photo aléatoire ») ; la
photo s'ouvre dans la visionneuse officielle Panoramax. Les flèches de navigation au sol de la visionneuse (ellipse violette) servent à naviguer hors mesure ; elles sont
masquées pendant les mesures (visée comprise) et pendant la largeur dans la visionneuse, où le
**lecteur de séquence** en bas de la visionneuse passe aux photos voisines et fait défiler la séquence en
avant ou en arrière (chaque appui sur un sens : 1x, 2x, 4x, 8x, 16x). On peut aussi y aller
par le **requêteur route + PR**, ou coller l'**identifiant** d'une photo (ou un lien
Panoramax) dans « Aller à la photo » ; « 📋 Copier » sous l'identifiant de la photo affichée
le copie, pour la passer à un collègue.

**Plein écran** : le bouton en haut à droite de la visionneuse (quatre coins vers l'extérieur, vers l'intérieur en plein écran, à la suite des deux
boutons de capture ; grisé sans photo) affiche la photo sur tout l'écran, sans
la barre du haut, la carte ni le panneau ; à nouveau, ou `Échap`, pour revenir. Les boutons de capture et de plein écran y restent, presque
transparents, et les boutons, voyants, lieu et lecteur s'effacent après 3 s de souris immobile : une capture d'écran
reste propre. Une mesure en cours s'y poursuit, avec sa carte d'étape ; pour en lancer une autre, quitter le plein écran.
`Échap` y quitte d'abord le plein écran : un second appui annule le trait en cours.

**Outils de mesure dans la visionneuse** (hauteur, profil en travers, largeur, relevé d'objets, calage de l'inclinaison) : cinq boutons bascule, en haut à gauche de la visionneuse, sous ou à côté des curseurs de luminosité
et de contraste (dans l'ordre : ↔ « Largeur » ; ↕ « Hauteur » : mesure de hauteur d'un objet ; équerre « Calage de l'inclinaison » ; courbe « Profil en travers » : chute, dévers et coupe du terrain ; épingle « Relevé d'objets »). Un appui lance la fonction, un second l'arrête ; une seule est active à la fois (en lancer une arrête les autres) ; chacun est grisé quand
la fonction ne peut pas s'appliquer (pas de photo, photo non 360° pour la largeur, pont ou lecture pour le profil). Détails de la hauteur et du profil : « Mesurer » et « Chute et dévers des bords de route » plus bas.

**Largeur dans la visionneuse** (expérimental, piste P22 étape 1) : le bouton à droite des curseurs de luminosité et de contraste, en haut à
gauche de la visionneuse (grisé sans photo 360°), trace une droite au sol, en rouge tant que la photo n'est pas calée par Bird Eye puis en vert (sans liseré) (elle n'apparaît qu'une fois sa position définitive : photos voisines, verticales et relief arrivés, au plus 12 s ; l'encart affiche « Calcul de la droite… » en attendant), entre les deux poignées seulement (elle s'allonge et se raccourcit en direct avec elles ; les poignées glissent sur toute la portée de la droite), juste devant le nez du véhicule, perpendiculaire à
la trajectoire de la séquence à l'endroit de la droite (dans un virage ou un giratoire, la direction de la photo suivante est prise en compte) (à 4,4 m de la caméra pour la monture basse du CD21, 4,8 m pour la haute, 4,5 m ailleurs : le sol y
est visible, hors capot), avec deux poignées, à gauche et à droite : de courts traits verticaux rouges (28 px à l'écran quel que soit le zoom, sans liseré ; sur la carte, 19,5 px), et, au milieu de la droite, au-dessus d'elle, la largeur entre les deux poignées avec son incertitude (« ↔ 7,40 m ± 0,10 m », même étiquette que les largeurs mesurées, mise à jour en direct, même incertitude que l'encart) ; les positions des bords ne sont que dans l'encart (« Bord gauche 1,20 m à droite » : une poignée peut passer de l'autre côté de la caméra). Elles partent des bords du
profil en travers de la photo s'il y en a un, sinon de 3 m de part et d'autre. Faire glisser une poignée le long de la droite
jusqu'au bord de la route (les poignées sont libres de part et d'autre de la caméra, par exemple pour mesurer un trottoir ou une seule voie, mais ne se croisent pas : 0,10 m d'écart au moins ; la visionneuse ne tourne pas tant qu'on tient une poignée, à 10 px du trait ; le curseur devient une main ;
le glissement est continu, sans saut, précis au fort zoom) : un encart au bas de la photo lit en direct la distance de chaque bord à la
caméra et la largeur, au centimètre, avec leur incertitude (arrondie à 0,05 m). La droite et ses deux bords (petits traits rouges perpendiculaires à la droite, de taille constante à l'écran) sont aussi
tracés sur la carte, pour vérifier qu'elle est perpendiculaire à la route. Rien n'est
retenu ni reporté dans le graphique ou les résultats ; un second appui sur le bouton retire tout. Tant que ↔ est actif, la navigation depuis la visionneuse est désactivée (boutons de lecture ◀◀ ▶ ▶▶ grisés, flèches au sol, clic au sol, touches sans effet) : la photo ne change que par un clic sur la carte, et l'outil reste actif sur la nouvelle photo (droite refaite à sa position par défaut, calage relancé aussitôt) ; rotation de la vue et zoom restent permis. **Calage Bird Eye dès l'ouverture** : dès l'activation de l'outil, puis à chaque nouvelle photo (sans attendre un déplacement), la photo est calée comme le fait la vue Bird Eye (inclinaison tirée de la route sur le LiDAR HD ou verticales, tangage lu sur les lignes de la route, roulis par défaut de la campagne 2025), sans afficher la vue (case Bird Eye non cochée, rien sur la carte). Tant que le calage dure (quelques secondes, sans bloquer la page), la droite n'est **pas tracée** : seule l'animation d'attente « Calage de la largeur… » (icône ↔, ondes jaunes, étape en cours dessous ; ondes figées si le système demande de réduire les animations) est montrée au centre de la visionneuse, poignées, droite, molette et bouton « Remettre perpendiculaire » sans effet ; l'encart dit « Calage Bird Eye en cours… » et aucune largeur n'est affichée. L'animation laisse place à une coche verte quand tout est prêt, ou à une croix rouge si le calage est impossible. Dès que tout est prêt, la droite prend sa forme et sa couleur définitives, sans geste de l'utilisateur. Dès la première lecture de l'inclinaison (quelques secondes), la largeur est recalculée avec la photo calée et affichée, puis légèrement ajustée si le tangage change encore pendant la fin du calage ; le relief et le panorama de la photo sont lus à l'avance : les poignées gardent leur place dans l'image (leur distance en mètres est relue sur la droite calée). Les déplacements suivants, sur la même photo, ne recalent plus ; le calage est gardé et partagé avec la vue Bird Eye (si elle est allumée ensuite sur cette photo, elle est prête plus vite, et si elle l'a déjà calée, la largeur n'attend pas). Si la photo ne permet pas le calage (pas de pose Bird Eye, calcul en échec ou plus de 90 s ; une pose impossible est connue aussitôt, sans attendre), la largeur est donnée sans calage, avec le message « Calage Bird Eye impossible ici : largeur sans calage ». Changer de photo ou quitter l'outil pendant le calage : la largeur n'est plus attendue, le calage se termine pour la photo.

Photo suivante : la droite est
refaite (masquée le temps du calcul), les poignées déjà déplacées restent où elles sont. L'encart rappelle, discrètement, l'inclinaison utilisée, la même que celle des mesures (un seul ordre, `docs/CALCULS.md` § 1.3) : celle de la vue du dessus quand elle tire l'inclinaison de la route pour cette photo (calage automatique du tangage, ou tangage et roulis réglés à la main : « vue du dessus » ou « vue du dessus (réglée à la main) » ; la droite est refaite à chaque réglage, même si la vue du dessus est ouverte après, et les mesures déjà faites sur la photo sont recalculées), sinon celle calée à la main, sinon les verticales de la photo (calculées à l'ouverture, comme pour la vue du dessus ; la droite n'est affichée qu'à leur arrivée), sinon celle lue sous le véhicule (LiDAR), sinon les verticales à seuil élargi (« verticales (seuil élargi) », incertitude plus grande), sinon le roulis par défaut de la campagne 2025 seul (tangage inconnu, ±2°). Précision : voir `docs/CALCULS.md` § 8.8 ; l'incertitude de la largeur prend en différence, entre les deux bords, les erreurs communes (inclinaison, roulis, hauteur de la caméra), quel que soit leur côté ; elle
compte aussi le relief : la droite est posée sur le MNT LiDAR HD (RGE ALTI à défaut) lu sous la caméra et le long de la droite (pente en long, dévers) ; si le relief est indisponible, le sol est supposé plat (l'encart l'indique). L'encart donne la source du sol et son écart aux deux poignées (par exemple « sol LiDAR HD : −8 cm à gauche, +3 cm à droite »).

**Loupe, molette et échelle pour régler finement un bord** : au survol d'une poignée des bords, le curseur devient ↔ (`ew-resize`). **Pendant son glissement**, une loupe ronde (pastille de 180 px, liseré blanc, ombre) s'ouvre à côté du pointeur (et reste après le relâchement tant que la poignée est survolée) : la photo y est agrandie trois fois autour du point visé, avec la droite, la poignée (sa tige coupée au milieu pour laisser voir le point), un réticule fin, et dessous « bord gauche : 3,21 m » (distance du bord à la caméra, celle de l'encart ; « à droite » ajouté si la poignée a passé la caméra). **Molette au survol d'une poignée** : elle la déplace le long de la droite d'un pixel de la photo affichée par cran (le pas en mètres suit donc le zoom de la visionneuse : plus fin quand on zoome), vers la droite de l'écran en roulant vers le haut, vers la gauche vers le bas, pour les deux poignées (le sens est celui de l'écran, même si la droite est tournée ou si une poignée a passé la caméra) ; même pas à chaque cran quelle que soit la vitesse, fractions de cran pour un pavé tactile ; mêmes limites que le glissement ; la largeur, l'étiquette et l'encart se mettent à jour comme au glissement, et la loupe reste ouverte, à sa place, tant que le pointeur survole la poignée (après un glissement comme après la molette ; elle se ferme 0,3 s après la sortie ; le simple survol sans glissement ni molette ne l'ouvre pas). La molette ailleurs zoome la visionneuse comme d'habitude (et reste sur la poignée tant qu'elle tourne). **Barre d'échelle** au bas de la loupe : longueur ronde au sol (de 1 cm à 10 m : 1, 2, 5, 10, 20, 50 cm, 1, 2, 5, 10 m ; la plus grande qui tient dans 90 px de la loupe), mesurée à la distance du bord, le long de la droite (échelle locale du sol, pas celle de l'écran). **Placement** : le côté est choisi une seule fois, à l'ouverture de la loupe (début du glissement ou premier cran), puis gardé : la loupe suit le point sans sauter, ne bouge pas pendant les crans de molette, et ne change de côté (en glissant en 0,15 s) que si elle ne peut plus rester là (sortie de la visionneuse, point visé couvert), le nouveau côté étant gardé à son tour. Au choix : la loupe reste au-dessus de la droite tant qu'elle le peut (toute la pastille au-dessus du tracé, même incliné ; elle recouvre plutôt une étiquette ou l'encart que de passer dessous), et ne passe dessous que si aucune place au-dessus n'est possible ; au-dessus du pointeur par défaut ; elle passe dessous, à droite ou à gauche (ou en diagonale) quand elle sortirait de la visionneuse ou recouvrirait l'autre poignée, l'étiquette de largeur, la barre d'outils ou les bandeaux, et ne couvre jamais le point visé. L'agrandissement s'adapte au zoom de la visionneuse : ×3 au plus, réduit (jusqu'à ×1) pour qu'un pixel natif de la photo ne soit pas agrandi de plus de ×1,5 (sinon l'image serait pixellisée) ; tant que la tuile pleine résolution de la zone n'est pas arrivée, la loupe garde sa dernière image nette ou affiche « chargement… » plutôt que l'aperçu flou. L'image de la loupe est tirée de la scène de la visionneuse redessinée en plein format sur le seul carré agrandi (la finesse est celle de la photo chargée à ce zoom) ; les poignées restent aussi dessinées sur la photo.

**Faire glisser la droite en profondeur** : ni croix ni flèche (rien ne gêne la mesure des petits objets) : la droite elle-même se saisit, dans une bande invisible de ±8 px de part et d'autre (près des deux poignées rouges, celles-ci sont prioritaires). Au survol la droite s'épaissit (4,5 px au lieu de 2,5) et le curseur devient ↕ ; l'encart rappelle les gestes (« glisser : profondeur · clic droit glissé (ou Maj) : rotation · double clic : perpendiculaire »). **Clic gauche maintenu et glissé** : la droite avance ou recule, dans la visionneuse comme sur la carte (sur la carte, le long du cap ; mêmes gestes sur la droite de la carte, prolongements compris) ; le point saisi suit le pointeur. Pendant le glissement un aperçu rapide est tracé (calcul géométrique, sans relire le relief) ; au relâchement la droite se fixe et le relief est relu à la nouvelle distance (l'encart dit « relief en lecture… »). Un simple clic (moins de 5 px de déplacement) ne change rien. Tant que le clic est tenu, la vue panoramique ne tourne pas, la carte ne se déplace pas ; hors de la droite, la vue tourne normalement. L'étiquette de la largeur est décollée de la droite, au-dessus d'elle. La droite reste perpendiculaire à l'axe du véhicule (la rotation est le clic droit, ci-dessous). Butées : près, la distance du nez (capot : 4,4 m, 4,8 m ou 4,5 m) ; au loin, la distance du nez plus l'écart réel jusqu'à la photo suivante de la séquence (souvent 5 m) plus 1 m de recouvrement, soit nez + 6 m si la photo suivante n'est pas connue : au-delà, la droite serait mieux lue sur la photo suivante. Les poignées latérales gardent leur écart en mètres pendant le glissement, la largeur est recalculée aussitôt (l'étiquette de la photo et l'encart donnent « à 12,4 m », la distance de la droite devant la caméra ; sur la carte, le point de mesure est à cette distance). Glisser en profondeur ne relance pas le calage Bird Eye : le calcul prend la photo calée si elle l'est, sinon l'inclinaison dont on dispose. **Couleur de la droite** : verte quand la photo est calée par Bird Eye ; rouge seulement si le calage est impossible ici (mesure sans calage, donc moins sûre : le message habituel le dit) ; pendant le calage, ni l'une ni l'autre : le tracé d'attente gris défile ; elle reste verte si on la fait glisser ensuite. Même règle sur la carte. Comme le reste de cet outil, la distance n'est pas retenue (ni résultats ni export) : elle n'est lue qu'à l'écran.

**Tourner la droite** : dans une courbe ou un giratoire, la direction du trajet n'est pas parallèle aux bords. **Clic droit maintenu sur la droite et glissé** horizontalement (le menu contextuel du navigateur est bloqué) la tourne autour du droit de la caméra, dans le plan du sol, de 0,1° par pixel, vers la droite dans le sens des aiguilles d'une montre, jusqu'à ±45° ; **Maj + clic gauche glissé** fait la même chose (pavés tactiles, Mac, souris sans bouton droit). Tenir **Alt** pendant le glissement rend la rotation dix fois plus fine (0,01° par pixel ; l'ancien Maj est pris par l'équivalent du clic droit ; Alt est lu pendant le glissement, car au début du clic certains gestionnaires de fenêtres de Linux le gardent pour déplacer la fenêtre). Les poignées rouges gardent leur décalage le long de la droite tournée. Pendant le glissement, aperçu rapide : la droite d'avant reste en pointillés fins, la rotation en cours (« tournée de 3,2° vers la gauche ») s'ajoute à l'étiquette de largeur ; au relâchement la droite se fixe, les pointillés disparaissent et le relief est relu à l'angle choisi (l'encart indique « relief en lecture… », la droite reste affichée). L'encart ajoute « tournée de 3,2° vers la gauche » (sens trigonométrique vu du dessus, rotation positive) ou « vers la droite » ; rien à 0°. **Double clic sur la droite** (photo ou carte) ou le bouton « Remettre perpendiculaire au trajet » (grisé à 0°) la redresse (la visionneuse ne zoome ni ne navigue, la carte ne zoome pas, la droite ne bouge pas pendant le double clic) ; la rotation est aussi remise à 0° au changement de photo (la courbure change). La largeur lue est mesurée le long de la droite tournée. Sur la carte, les gestes sont les mêmes (clic droit ou Maj + clic gauche glissé, Alt pour la finesse, double clic).

**Vidéo d'un itinéraire** : onglet **« Vidéo »** du panneau, en trois temps.

**1. Tracer.** « 📍 Tracer sur la carte » enchaîne les clics sur la mini-carte : le départ, l'arrivée, puis les étapes
éventuelles ; `Échap` ou un second appui termine (un nouveau tracé remplace l'ancien). Ou bien la route, le PR de départ
(+ distance) et le PR d'arrivée (+ distance), choisis dans des listes comme dans le requêteur, ou chacun par son 📍 ; le point
cliqué est gardé tel quel et les champs se remplissent d'après la route et le PR trouvés là (la route déjà saisie d'abord : à
un carrefour, l'autre route ne la remplace pas) ; retaper un PR revient au PR. Les points sont marqués sur la carte (départ
vert, arrivée rouge, étapes bleues, en épingles).

**2. Vérifier.** Les photos sont cherchées d'elles-mêmes dès que départ et arrivée sont connus, de nouveau si le tracé change,
avec une barre d'avancement (croisements et ouvrages d'art : seulement si l'option qui s'en sert est cochée, ou en la cochant). Un bandeau donne la longueur, le nombre de photos et leurs dates : vert pour une seule séquence ;
orange s'il y a des changements de séquence, avec le PR et les dates de chacun, un bouton « Voir » qui y centre la carte et un
repère orange sur le tracé.

**3. Choisir le mode et enregistrer.** « Brouillon » (vérifier vite le trajet : allure de la présentation, image 960 × 540, titre
et compteur de vitesse), « Présentation » ou « Revue détaillée » (vitesse fixe, accélération latérale et V max ARP ; dévers lu
sur le LiDAR HD à l'enregistrement, environ 1 min de plus). Cliquer sur un mode rétablit tous ses réglages (les textes du titre
et les endroits posés restent) ; toute autre retouche est signalée « Réglages modifiés ». « 🎬 Enregistrer la vidéo » affiche la
durée de la vidéo ; « ▶ Aperçu », « ☆ Garder » et « ↺ Effacer » suivent. Les autres réglages sont dans la liste repliée
« Options », par thème : Compteurs, Allure, Réglages qualité, Effets spéciaux ; ce qui ne s'applique pas au mode est grisé.

**Choix des photos** : elles sont choisies le long de l'itinéraire routier de la Géoplateforme (Valhalla sur la BD TOPO, en voiture, le
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
image, hors de la visionneuse : 1080p, 720p ou 480p au choix (voir « Format »), 30 images par seconde, H.264 à 80 Mbit/s
en 1080p, 40 en 720p, 20 en 480p (environ 10 Mo par seconde de vidéo en 1080p, moins si le poste n'atteint pas ce débit ; à 30 Mbit/s, image en blocs sous Windows). Firefox sous Linux, en français, annonce le
H.264 sans réussir à l'encoder (bug Mozilla 2085549 : niveau « 3,1 » écrit avec une virgule ; lancé avec
`LC_NUMERIC=C`, il l'encode) : VP9, à 20 Mbit/s en 1080p, pris alors d'office, de qualité voisine, calcul environ quatre fois plus long, fichier lu
par Chrome, Firefox et VLC, peut-être pas par PowerPoint, une seconde d'arrêt au début et à la fin. Deux listes à côté du bouton : la vitesse
simulée (de 30 à 720 km/h, 90 par défaut, puis Mach 1 et Mach 2 : 1 235 et 2 470 km/h, vitesse du son au niveau de
la mer ; des photos y sont sautées) et la part des photos de la séquence prises (1/1, 1/2, 1/4, 1/8 ;
chaque choix indique l'écart obtenu, par exemple « une tous les 10 m »).  S'affichent aussi le nombre de photos retenues, la durée de la vidéo et le nombre de photos
par seconde ; au-delà de 30 photos par seconde (une par image), des photos sont sautées. Mode « Présentation » (à l'ouverture : compteurs PR et vitesse et titre ; ni accélération, ni V max ARP, ni flou
ou corrections de luminosité ; la vitesse simulée et la rampe, grisées, y sont remplacées par l'« Allure » : très vite dans les
lignes droites, 400 km/h par défaut, de 50 à 600 ; dans les virages, vitesse selon le rayon R, d'après la rotation du cap
lissé sur ± 10 m : celle où la vue tourne à la réglette « Virages, rotation », 12 °/s par défaut, de 4 à 40, multipliée par
1 + R / 300 m pour ne pas freiner les grandes courbes (par défaut, environ 45 km/h à 50 m de rayon, 100 à 100 m, 240 à 200 m), atteinte
environ 2 s avant l'entrée de la courbe pour voir ce que voit le conducteur en approchant ; jamais sous « Au plus bas », 15 km/h par
défaut ; arrêt de 0,5 s sur la première et la dernière vue ; changements d'allure rapides, pas réalistes : la vitesse varie
d'un facteur 2,7 en « Transitions » au plus, 0,5 s par défaut, de 0,25 à 3 (400 → 147 km/h en 0,5 s ; 8 m/s² au moins près de l'arrêt) ;
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
Les options ci-dessous sont repliées sous « Options » ; chacune a sa case. « Corrections de luminosité » (décochée) : la luminosité de chaque photo est mesurée sur sa vignette (tout le tour
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
et d'autre, rouge, vert et bleu), puis revient peu à peu à sa propre exposition sur 100 m ; la dernière photo de la séquence quittée est écartée (souvent déjà engagée là où
cette séquence quitte le parcours) si la suivante reste devant ; l'écart entre les deux photos du raccord est traversé en 0,8 s au plus (section
sans photos : le compteur garde la vitesse d'avant), et sur cet écart la vue avance dans la photo quittée par un zoom progressif (jusqu'à 2 fois) centré sur la
direction de la photo suivante, puis passe à celle-ci par un fondu court sur les 4 derniers mètres (30 % de la traversée au moins) : le mouvement continue et l'image double ne dure qu'un instant
(raccord à 15 m d'écart : 0,3 s au lieu de 1,1 s figée). « Rampe de vitesse » (décochée, grisée en Présentation) : la vitesse choisie devient celle des lignes droites ; la
vidéo ralentit dans les virages et aux carrefours (facteur 1 / (1 + rotation du cap / 1,5° par mètre), la rotation
au-delà de 1° par mètre, virage marqué, comptant double ; jusqu'à 35 % au plus bas : virage de 30 m de rayon à 37 %), part et s'arrête en douceur sur 50 m, sans à-coup (vitesse lissée sur ± 15 m) ; la durée affichée en
tient compte. Sur la D115D (1,1 km, rayon de 95 m au plus serré), la vitesse varie de 76 à 100 % et la vidéo passe
de 47,5 à 53 s à 90 km/h. « Titre » (cochée, thème Compteurs) : carton au début,
cadre sombre en haut au centre, un peu écarté du bord, souligné d'un trait ambre, titre en gras et sous-titre plus clair
centrés, descendu en fondu à l'entrée (0,3 à 0,9 s), effacé en fondu de 4 à 4,6 s ; texte libre (80 caractères) et sous-titre libre, ou,
laissés vides, la route et les PR de départ et d'arrivée, et la date des photos ; « Rappel en incrustation » (décoché) :
le titre en petit en haut à gauche ensuite, jusqu'à la fin ; champs grisés sans titre. « Compteur PR » (cochée à l'ouverture) : en bas à gauche, la route et
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
grande courbe). Calcul, seuils de l'ARP et exemples détaillés : [`docs/CALCULS.md`](CALCULS.md),
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
« n° 3 · premier champ »), triangulé avec le bouton « Relevé d'objets » de la visionneuse ; sans objet, la liste est grisée et invite à en
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
sur tout le tronçon ; image SD des photos une fois la vue assez ouverte (moitié de la transition), tuiles réduites avant : calcul environ 3 fois plus rapide ; interrupteur « Tonneau pendant la transition » : un tour complet de roulis pendant l'enroulement,
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
fondu, la ligne des collines aussi un peu (photos qui ne penchent pas pareil). « Format » : grille VP9, H.264, H.265 × 1080p, 720p, 480p, chaque choix testé sur le poste (une image encodée) à la première ouverture de l'onglet : vert, encodeur matériel ; jaune, encodeur logiciel, plus lent ; grisé, pas disponible (H.265 : 30 Mbit/s en 1080p, fichier pas lu par
tous les lecteurs, pas d'encodeur logiciel). Si l'encodeur refuse finalement le format choisi, le premier autre format qui encode est pris, dit à la fin du calcul. Toute la grille est grisée en brouillon. Le VP8 n'est pas proposé : il n'entre pas dans un fichier MP4. « Brouillon (rapide) » (décochée) : image SD
de chaque photo au lieu de ses tuiles HD, vidéo en 960 × 540, à 7,5 Mbit/s, pour vérifier un parcours et ses effets avant le calcul final ;
image floue (panneaux et marquage lointain illisibles) ; seuls restent le titre, le compteur de vitesse et les variations de vitesse automatiques (allure, ralentissements, rampe), le reste est grisé et ignoré.
« Stabilisation » (cochée, sauf en brouillon ; une étape avant la première image, avec son avancement dans la barre d'état) : les photos ne donnent ni tangage ni roulis ; le décalage entre deux photos voisines est mesuré sur leur image SD et les petits
sauts sont retirés du tangage et du roulis (au plus 2° par photo, variations sur plus de 40 m gardées) ; cap non corrigé par les images (le décor proche fausse la mesure), mais, avec ou sans l'option, l'arrondi au degré du cap des photos est lissé sur ± 60 m dans chaque séquence ; le cap de la vue suit la direction de l'axe de la route sur la plus longue portion, jusqu'à ± 150 m, qui s'écarte de moins de 1 m de sa corde : fixe en ligne droite malgré les petits coudes du tracé BD TOPO, il revient à ± 15 m dans les virages (± 30 m à 450 m de rayon, ± 60 m à 1 800 m) ; une image SD de plus à télécharger par photo. Chaque photo est vue de sa propre caméra et passe à la suivante par un fondu enchaîné
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

« ↺ Effacer » (onglet Vidéo) remet le parcours et ses réglages à zéro : départ et arrivée effacés, options et réglettes
à leur valeur par défaut, endroits des tonneaux, planètes et tours retirés, zone du point d'intérêt effacée ; le filtre
des photos et les parcours gardés ne changent pas. Grisé quand tout est déjà à zéro et pendant le calcul.

**Parcours gardés** (onglet Parcours) : « ☆ Garder » (onglet Vidéo, dès que départ et arrivée sont saisis) garde le
parcours avec tous ses réglages : départ et arrivée (route, PR et distances, points sur la carte), vitesse, part des
photos, toutes les options et leurs réglettes, endroits des tonneaux, des petites planètes et des tours d'horizon, zone et cible du point
d'intérêt, filtre de date des photos, instance choisie et producteur de la photo affichée au moment de garder. Rouvert, le parcours
remet cette instance et ce producteur dans le filtre (« Tous » s'il n'en avait pas ; un parcours gardé avant cette version les laisse
tels quels) ; plus aucune photo de ce producteur à son départ ni à son arrivée : le filtre producteur est retiré, et le parcours se fait avec les photos qui restent ; instance
inconnue d'un fichier importé : l'instance choisie reste, avec un message. Nommé d'après la route et les PR, daté ; pastille jaune si au moins un effet « communication » est activé (tonneau,
petite planète, point d'intérêt, regard aux croisements, tour d'horizon), verte sinon ; gardé dans ce navigateur. Un clic sur
son nom le rouvre dans l'onglet Vidéo (vidéo à préparer), ⤓ l'exporte seul (fichier JSON à envoyer à un collègue),
× le retire ; rouvert, la ligne est entourée et « ☆ Garder » devient « ☆ Gardé » (grisé) ; modifié, « ☆ Enregistrer… »
propose de l'enregistrer dans ce parcours ou d'en créer un nouveau (l'ancien reste tel quel) ; en tête, export de toute la liste et import (la liste ou un seul, ajoutés à ceux-ci ; fichier venu
d'ailleurs : seuls les réglages connus sont repris). Cible du point d'intérêt : l'objet du relevé au même endroit,
sinon celle du parcours, proposée en plus dans la liste « Cible » (« parcours gardé »). Les autres filtres
(instance, producteur…) ne sont pas gardés.

**Mesurer** : un bouton de la visionneuse (↕ hauteur, épingle relevé d'objets, équerre calage) entre en mesure dans son mode ; la mesure sur la carte se lance par « Mesurer sur la carte ». Il n'y a plus de bouton « Mesure » ni de liste « Mode » à l'écran (commandes cachées, pilotées par ces boutons). Pendant la mesure, une carte d'étape en bas à gauche de
la visionneuse donne la mesure et ses étapes (pied puis sommet), l'état
(triangulation ou mesure en cours) et la consigne ; le haut de la photo et le lecteur de séquence restent libres. Le
bouton **« ✔ Valider le point triangulé »** y apparaît, avec un halo,
dès que les visées donnent un point (deux visées qui se croisent).

**Prise de mesure guidée** :

1. La photo de la première visée est la **photo de référence** : la mesure se fera sur elle ;
   choisir celle d'où l'objet se voit le mieux.
2. Des boutons sous la consigne proposent les photos à viser ensuite : en hauteur, la
   précédente et la suivante de la référence, puis celle de l'autre côté pour une 3e visée. Ils sont nommés par rapport à la photo affichée
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

- **Hauteur d'un objet** (bouton **↕ « Hauteur »**, en haut de la visionneuse, avec luminosité, contraste et largeur : il
  lance la mesure en mode hauteur, mode à l'ouverture de la page, et un second appui l'arrête ; grisé sans photo. Une seule de ces
  fonctions (hauteur, profil en travers, largeur, relevé, calage) est active à la fois : en lancer une arrête les autres ; un bouton de
  mode pressé pendant une mesure dans un autre mode change de mode sans sortir de la mesure)
  1. Viser le **pied** de l'objet depuis au moins deux photos (un clic par photo, lecteur
     de séquence ou carte pour changer de photo), puis « Valider le point triangulé » : c'est le point de référence,
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
  **Visées suivantes** : à moins de 12 pixels du trait vert de la visée déjà faite, le
  réticule s'y cale, pour retomber au même endroit d'un bord ou d'un montant, qui n'a pas de repère le long de son
  tracé ; la touche Maj le libère. De préférence, viser un repère net (fin de tiret, joint, regard).
  Sur une photo calée, avec le sol LiDAR HD, si les visées touchent le sol à plus de 0,6 m l'une de l'autre,
  un avertissement propose d'en réviser une, et ce désaccord s'ajoute au « ± ».

  Le sommet reçoit la lettre suivante des points gardés (B…), sur une étiquette grise tant qu'il est
  provisoire ; l'étiquette de la mesure nomme ses deux points (« A↕C 3,20 m »).

  *Historique (21/11/2026) :* le mode « Largeur perpendiculaire à la chaussée » (droite de mesure
  perpendiculaire à l'axe de la route, bord opposé, droite tracée sur la carte) a été retiré. La largeur
  d'une chaussée se mesure par le bouton ↔ « Largeur dans la visionneuse » (droite au nez du véhicule).

  Pendant les mesures (visée et étape 2 comprises), les flèches au sol de la visionneuse sont masquées
  (elles gênent les clics de mesure) : on change de photo par le lecteur de séquence ou la carte ; elles reviennent hors mesure.
- **Mode « sur un pont »** (automatique, sans case ni question depuis le 20/11/2026 : l'ancienne case « Sur un pont » et sa fenêtre sont
  retirées) : sur une photo prise SUR un pont de la BD TOPO (tronçon en pont à 8 m au plus de la photo et orienté comme la séquence, à
  30° près), en mesure, le mode s'active tout seul : le sol vient des photos (altitude GPS des caméras moins leur hauteur) et non du modèle de
  terrain, qui donne le terrain sous l'ouvrage. La ligne « Position » du panneau écrit alors « sur un pont (détecté) ». Il se désactive tout seul à
  plus de 30 m de tout pont. Une photo seulement près d'un pont (à plus de 8 m, ou sur la voie franchie, dessous, dont le sens diffère) ne
  l'active pas. **Marque par photo, dès l'ouverture** (même hors mesure, depuis le 22/11/2026) : une photo sur un pont est repérée à son
  ouverture ; son LiDAR (pente et dévers du sol sous l'ouvrage) n'est jamais retenu pour l'inclinaison (la chaîne passe aux verticales à
  seuil élargi, puis au roulis par défaut de la campagne 2025) ni appris par le modèle LiDAR de la séquence ; ses verticales restent valables. La vue du dessus (Bird Eye) suit le même marquage, photo par photo : « sol supposé plat » seulement sur le tablier, jamais sur le remblai qui y mène (7dcdccf9-3c52-4c54-bc5b-de72740a7967 : tangage du relief, +3,2°, au lieu de 0°). Les tronçons arrivent par le réseau : l'état suit à leur arrivée, à chaque changement de photo.
- **Hauteur de chute sur un pont** (automatique, sans clic) : sur une photo prise sur un pont
  de la BD TOPO, le nom du pont, ce qu'il franchit et la hauteur de chute la plus grande sur
  toute sa longueur s'affichent en haut à gauche de la visionneuse (pas pendant la lecture de
  la séquence), suivie de la méthode qui l'a donnée (« LiDAR » ou « RTK »). Calcul par le nuage LiDAR HD, une fois par pont, même valeur sur toutes ses photos, sans GPS ni hauteur de caméra :
  plus grande différence entre le tablier (points classés pont, altitude de chaque case de 2 m, parapets écartés) et le sol ou l'eau
  sous lui et jusqu'à 10 m de son bord ; lecture de quelques secondes à une demi-minute selon la longueur (au-dessus de l'eau :
  niveau au relevé, seulement là où le laser a renvoyé des points d'eau, sinon la berge). Sans points classés pont, ou nuage illisible,
  en secours :
  - **tablier** : altitude GPS des photos de la séquence prises sur le pont, convertie en
    altitude NGF, moins la hauteur de caméra (mesurée sur la séquence vérifiée, sinon calée, sinon
    pour une photo du CD21 la monture d'après la date, 1,93 ou 2,07 m à ±4 cm ; à défaut, le réglage
    « Caméra à », seulement après un appui sur le bouton de l'encadré : une photo de précision
    déclarée n'a que sa hauteur au-dessus du fond franchi) ; pour chaque point,
    interpolée entre les deux photos consécutives les plus proches (pont long et pentu) ;
  - **dessous** : modèle de terrain LiDAR HD (RGE ALTI en secours) lu en travers du pont, à 1,
    3, 6 et 10 m au-delà du bord du tablier, des deux côtés, tous les 2 m (plus espacé sur un
    long pont) ; le bord du tablier est lu dans le relief quand le modèle de terrain contient le
    tablier (petits ponts, tablier classé sol dans le nuage LiDAR), sinon à la demi-largeur type
    de la route (pas la largeur BD TOPO, qui n'est pas fiable) ; l'infobulle dit lequel ; sous un
    tablier absent du modèle de terrain, celui-ci est interpolé à sa hauteur : le fond se lit à
    l'écart ;
  - **hauteur** : la plus grande différence entre les deux, avec son incertitude (altitude RTK,
    tablier tiré des photos : dévers, bordure ; terrain) ; l'infobulle dit où elle est. Au-dessus de l'eau, c'est le
    niveau de l'eau le jour du relevé LiDAR, pas le fond.

  Dans ce secours, pas de valeur sans position RTK vérifiée (l'altitude du tablier serait fausse de plusieurs
  mètres) ; « non mesurée » sous 0,5 m (terrain non distingué du tablier : végétation, buse) ;
  « calcul impossible » avec sa cause (service injoignable, pas d'altitude GPS sur le pont, pas
  de modèle de terrain). Un creux sans rapport avec ce que franchit le pont, à moins de 10 m de
  la chaussée (fossé profond), augmente la valeur.
- **Chute et dévers des bords de route** (bouton « Profil en travers », en haut de la visionneuse, avec luminosité, contraste,
  hauteur et largeur ; ticket #31) :
  sur une photo hors pont, à moins de 15 m d'une route de la BD TOPO (orientée comme la route parcourue, à 45°
  près : à un carrefour, pas la voie qui croise), un appui sur « Profil en travers »
  calcule (une animation d'attente « Profil en travers… » s'affiche au centre de la visionneuse pendant le calcul et
  laisse place au graphique ; l'étiquette en haut à gauche ne s'affiche que pour dire pourquoi le calcul n'a pas abouti : service
  injoignable, pas de route à moins de 15 m… ; l'animation montre alors une croix rouge) puis trace le profil en travers, qui donne pour chaque côté (vu dans le sens de la photo)
  qui descend d'au moins 0,5 m la hauteur de chute et le dévers du bord. La réglette « Jusqu'à » de la fenêtre du profil (en haut à droite, avant la croix de fermeture ; grisée pendant le calcul) fixe la
  distance examinée de part et d'autre du milieu de la chaussée (5 à 30 m par pas de 5 m, flèches du clavier comprises, 10 m par défaut ; 1 m au moins au-delà
  de chaque bord) : chute, dévers et graphique s'arrêtent là ; la changer, fenêtre ouverte, refait aussitôt le calcul
  de la photo ; fenêtre fermée, le prochain appui sur le bouton. Le bouton est grisé sur un pont (hauteur de chute du pont)
  et pendant la lecture ; enfoncé pendant le calcul (un second appui l'abandonne) et tant que la fenêtre du profil est ouverte ; quand le calcul
  est déjà fait pour cette photo et cette distance, un appui rouvre la fenêtre sans recalculer. Tant qu'elle est ouverte, la carte trace le travers de la photo, ses deux bords, le pied de la chute et le talus (mêmes couleurs que le graphique ; le travers voisin qui porte la chute, en gris ; les autres travers du profil, sans chute ni dévers retenus, tracés comme lui, en trait plein gris) ; tout disparaît à la fermeture. À 12 m au plus d'un carrefour
  avec une voie nommée (le long de la route), le graphique le signale (« Carrefour : bords peu sûrs », en orange en haut à droite, aussi dans le PNG et le PDF),
  la phrase entière (« Carrefour avec la D18 6 m devant : bords peu sûrs ») en tête de sa légende ; la chaussée s'y élargit et le bord
  n'y est pas continu, le calcul n'a pas de bonne réponse.
  Calcul :
  - **profils** : modèle de terrain LiDAR HD (RGE ALTI en secours) lu en travers de la route à
    −10, −5, 0, +5 et +10 m de la photo le long de la route, des deux côtés, depuis la caméra
    (séquence vérifiée RTK ; sinon depuis l'axe BD TOPO) : un point tous les 0,5 m jusqu'où la chute
    peut être lue ;
  - **bord de la chaussée** : premier point, à 1,5 m au moins de l'origine, d'où la pente du
    terrain sur 1 m s'écarte de plus de 8 points de celle de la chaussée sous l'origine, dans
    le même sens, sur trois pas de suite (fossé, talus), ou d'où le terrain fait une marche de 5 cm
    ou plus sur 0,5 m qui tient sur 1,5 m (bordure, accotement plus bas), avancé d'un pas si ce
    pas suit encore la pente de la chaussée (le dernier point de la chaussée) ; depuis la caméra, le
    sommet du bombement (ou le changement de dévers d'une voie à l'autre), à 1,25 m de l'axe au plus,
    n'est pas pris pour le bord ; sans rupture de pente
    (accotement de plain-pied), la demi-largeur type de la catégorie de la route (importance BD TOPO :
    7 m en importance 1 et 2, 6 m en 3, 5,5 m en 4, 3,5 m en 5 (valeurs prudentes du 20/11/2026) ; la largeur BD TOPO elle-même n'est pas
    fiable) ; l'infobulle dit où le bord
    a été trouvé, et comment ; dès 3 travers trouvés dans le relief d'un côté, un travers sans
    rupture de pente, ou au bord à plus de 3 m de leur médiane (une marche dans la chaussée, un bord
    flou), y est ramené : bord « d'après les travers voisins » ; **chaussées séparées**
    (autoroute, voie express : un tronçon BD TOPO par sens, de même nom, parallèle, son axe à 4 à
    40 m en travers, ticket #34) : du côté de l'autre chaussée, le bord est cherché au-delà de son
    axe et jusqu'à 9 m après son bord type (7 m par chaussée), pente de référence sous cet axe, sinon
    son bord extérieur type ; la plateforme comprend le séparateur de
    chaussée et l'autre chaussée ; **séparateur de chaussée** : entre deux marches de sens
    contraires (surélevé : montée puis descente ; en creux : l'inverse), large de 0,5 à 10 m, au
    milieu à 4 m au plus de celui que donnent les largeurs types, recoupé d'un travers à l'autre ;
    à défaut, une bosse étroite (1 ou 2 points, 4 cm au-dessus des voisins : assise de glissières dos
    à dos ou de muret, que le terrain LiDAR ne garde pas) au même endroit sur deux travers au moins ;
    sinon d'après la BD TOPO ;
  - **chute** : la plus grande descente entre le terrain au bord de la chaussée et le point le
    plus bas du profil, avec la distance de ce point (le plus proche du bord, à 5 cm près), écrite
    au décimètre sous 10 m, au mètre au-delà ;
    « chute ≥ … au-delà de 10 m du bord » quand le point le plus bas est au bout du profil (le
    terrain descend encore : pousser la réglette) ;
    la lecture s'arrête là où le terrain remonte de 1 m au-dessus du bord (talus, butte) : ce
    qu'il y a derrière n'est pas une chute (« pas de chute avant le terrain qui remonte… ») ;
    ne dépend pas de l'altitude GPS : pas besoin de RTK ;
  - **dévers** : pente moyenne du talus le plus raide (0,5 m de haut au moins) avant cet arrêt,
    sur les cinq travers, de son haut à son pied (hauteur divisée par largeur), en % et en degrés,
    avec sa hauteur ; le talus est la partie d'une descente (pente lue sur 2 m d'au moins 10 %)
    dont la pente vaut au moins le tiers de la plus forte : ni l'accotement en pente douce
    au-dessus, ni la queue du pied ; son haut est le dernier point avant la descente, son pied
    le premier point à 5 cm du plus bas ; au-delà de 150 % (56°), « paroi quasi verticale (mur,
    enrochement) » avec sa hauteur, sans pourcentage (le MNT adoucit les murs : le chiffre ne
    serait pas une mesure).

  Sinon s'affichent « Aucun bord ne descend de 0,5 m ou plus », « Pas de
  route de la BD TOPO à moins de 15 m » ou « Calcul impossible » avec sa cause.

  - **pente en long** : terrain (même modèle) lu tous les 2 m sur ±50 m autour de la photo, le long de la
    **trajectoire de la caméra** (photos de la même séquence, de rangs qui se suivent : là où elle a roulé, virage
    à un carrefour compris) ; à défaut, le long de l'axe BD TOPO prolongé par les tronçons voisins de la même route (lus jusqu'à
    60 m autour de la photo ; à un nœud, celui qui continue le plus dans l'alignement, à 60° près),
    à la même distance de l'axe que l'origine (l'axe peut s'écarter de la voie de quelques mètres) ;
    repères de la BD TOPO, placés le long de la route : « fin de la D16 » là où elle s'arrête (aucun tronçon de la
    même route ne continue : le profil s'arrête là aussi, même si la caméra a continué sur une autre route, et les
    pentes ne portent que sur la partie gardée), « carrefour avec D18 » là où une voie carrossable nommée (numéro ou nom) s'y
    raccorde (deux raccordements de la même voie à moins de 30 m, comme autour d'un îlot séparateur : un seul
    carrefour, au milieu), noms au-dessus du graphique, reliés au profil par un trait pointillé ; les voies sans numéro ni nom, les routes empierrées, chemins (nature BD TOPO, ou nom en « CHE » sans numéro, même classé route), sentiers et voies privées ou réservées aux ayants droit ne sont pas mentionnés ; ponts : le MNT y donne le fond
    franchi ; un creux (corde de 40 m au plus à plus de 0,1 m au-dessus du terrain, appuyée en haut des parois) est
    remplacé par cette corde s'il recouvre un pont de la BD TOPO ou si le terrain y plonge de plus de 20 % (une route :
    15 % au plus), un vallon que la route suit restant tel quel (le tablier, à peu près, en tirets « pont (tablier interpolé) », ou
    « creux du terrain (pont ?) » hors des ponts de la BD TOPO, souvent plus courts que la brèche), pentes comprises ;
    creux ouvert au bout du profil : coupé ; tunnels de la route (BD TOPO) : le dessus remplacé par la droite d'une tête
    à l'autre ; pente moyenne par les moindres
    carrés (montée ou descente dans le sens de la photo) et pente la plus forte sur 10 m ;
    un graphique (profil en long, environ 160 px de haut) sous le profil en travers, repris dans l'image PNG : bande pâle de −10 à +10 m
    autour de la photo, graduée aux 5 travers du graphique du dessus (la photo en trait plus marqué) ; les 10 m les plus raides en violet épais,
    étiquetés (« 8,5 % sur 10 m ») ; carrefours, fins de route et ponts nommés au-dessus du cadre, reliés par un pointillé à leur point du
    terrain (un repère hors de la bande n'a jamais son nom au-dessus d'elle) ; une ligne de légende dessous, reprise dans le PNG et sur la
    2e page du PDF.

  La fenêtre du **profil en travers**, ouverte par le même bouton dès que le calcul est rendu, montre la coupe du terrain que ce calcul a lue (mesure LiDAR
  HD, ou RGE ALTI en secours), sur la distance de la réglette de part et d'autre du milieu de la chaussée (1 m au moins
  au-delà de chaque bord), là même où chute et dévers sont lus : travers de la photo en brun, les quatre autres en pointillés,
  plateforme entre les deux bords trouvés (et comment : rupture de pente, travers voisins ou largeur type ; un bord mesuré a un
  trait plein, un bord supposé, de largeur type ou d'après les travers voisins, des tirets longs et l'étiquette « bord supposé »), milieu du
  séparateur de chaussée sur une route à chaussées séparées (petite barre verticale ; la légende dit s'il a
  été trouvé dans le relief ou placé d'après la BD TOPO), flèche
  de la chute et droite rouge du talus (haut → pied) sur le travers où ils ont été mesurés,
  une clé de lecture d'une ou deux lignes sous le graphique (échantillon et mot pour chaque élément dessiné seulement : terrain, plateforme, bord mesuré ou supposé, chute, dévers, eau, herbe, végétation…, aussi dans le PNG et le PDF), valeurs au survol ou au toucher du graphique en travers (trait vertical, point sur le terrain de la photo et étiquette : distance à la caméra ou à l'axe, position par rapport au bord, hauteur par rapport à la plateforme ; une flèche de chute ou une droite de dévers proche du pointeur est mise en évidence avec son côté dans la légende ; rien de cela dans le PNG ni le PDF), hauteurs exagérées (facteur écrit sous le graphique et, en haut à gauche, « Hauteurs ×N » sur le graphique, donc aussi dans le PNG et le PDF) ; la case « Hauteurs à l'échelle » (cochée à chaque
  ouverture, grisée quand les hauteurs sont déjà à l'échelle sur ce travers) les remet à l'échelle des distances, caméra dessinée à sa hauteur (réglage « Hauteur de caméra »), masquée quand
  les hauteurs sont exagérées. Les commandes sous le graphique sont en trois groupes : « Affichage » (« Hauteurs à
  l'échelle », « Végétation », légende, loupe), « Nuage LiDAR » (« Analyse fine », interrupteur « Bord d'enrobé (expérimental) ») et « Enregistrer » (PNG, PDF, 2e page),
  et une croix en haut à droite ferme la fenêtre. « PNG » en fait une image
  avec son titre et sa légende ; « PDF » met le graphique et la légende (en petits caractères, sur deux
  colonnes) sur une page A4 paysage, en vectoriel, sous le lieu de la photo (route, PR, commune), à enregistrer en PDF
  dans la boîte d'impression ; « Profil en long (2e page) » (choix retenu) y ajoute une page pour le profil en long ; la loupe agrandit le graphique (sans la légende) au mieux sur la
  grande zone (que la visionneuse ou la carte y soit, la fenêtre s'y met toujours) ; la légende est repliée à chaque ouverture, « Déplier la légende » l'affiche (le PNG et le PDF la gardent). Le fond du
  graphique descend à 1 m sous le point le plus bas du terrain si le haut du terrain (sans la caméra ni la végétation) reste alors dans
  la moitié basse du cadre, sinon à 0,3 m ; la place libre est en haut, pour la végétation. Le graphique et la
  légende donnent le **dévers de la plateforme** (LiDAR HD seulement), arrondi au point : un chiffre si elle penche d'un seul sens, sinon un
  par demi-chaussée, avec la pente moyenne pour un toit symétrique, ou « non déterminé » si les travers diffèrent trop. Sur une route à une
  chaussée, un toit reste difficile à reconnaître (voir `docs/CALCULS.md`, 8.7) : ce chiffre n'a pas été comparé à des mesures de terrain. Le bouton « Analyse fine » de la fenêtre n'est proposé que pour un profil calculé.

  **« Analyse fine »** (fenêtre du profil) : lit le nuage de points LiDAR HD de l'IGN (dalles COPC, à la volée,
  1 requête par seconde au plus : une vingtaine de secondes, 1 à 2 Mo ; morceaux gardés dans le cache des informations
  géographiques, relus sans attente) sur ±1 m le long de la route au travers
  de la photo. L'intensité du retour laser des points du sol distingue l'enrobé (sombre), les lignes blanches
  (bandes étroites très claires, 2 fois plus que leurs voisines au moins) et les surfaces non revêtues (herbe, gravillons, béton : larges et claires).
  **Bord de chaussée** (tiret court ; **option « Bord d'enrobé (expérimental) »**, décochée par défaut, grisée tant que l'analyse fine n'est pas faite, choix retenu d'une session à l'autre : décochée, ni le bord d'enrobé ni la bordure ne déplacent les bords de chaussée, qui restent ceux du relief, et ni le tiret ni la largeur d'enrobé ne s'affichent, le reste de l'analyse (séparateur, lignes blanches, herbe, végétation, eau) étant gardé ; les relevés des 19 et 20/11/2026 les ont trouvés souvent trop loin, accotements et trottoirs en enrobé comptés dans la chaussée ; cochée, ce qui suit) : le bord de la bande d'enrobé, médiane de 5 travers sur ±5 m autour de la photo :
  début de la première bande d'1 m ou plus, 2,2 fois plus claire que l'enrobé au moins, ou 0,8 fois aussi claire au plus et à plat (terre d'un chemin raccordé, plus sombre qu'un enduit clair ; pas un fond de fossé, plus bas), à mi-hauteur entre les deux ; ou, plus près, la bordure d'un trottoir en enrobé (même intensité que la chaussée), lue à l'altitude des points du sol : remontée d'au moins 4 cm en 0,75 m après le caniveau, qui tient sur 1 m, presque à plat (pas le fond d'un fossé ni sa berge : « bordure » dans la légende) ; la légende donne la largeur
  d'enrobé et sa dispersion entre travers ; la plateforme, son dévers, la chute et le dévers du talus se relisent alors depuis ces bords. Sans ces abords clairs (village, béton), à défaut : la ligne de rive, ligne blanche au début de la première bande non revêtue
  d'1 m ou plus, ou la dernière avant elle, hors des lignes entre voies (à moins de 1,2 m de l'axe d'une
  chaussée), sinon la fin de l'enrobé du seul travers de la photo. **Séparateur de chaussée** : la bande non revêtue entre les deux
  chaussées (glissières comprises, que le terrain seul ne voit pas), à 2 m au plus de celui du calcul, qu'elle
  remplace (« nuage LiDAR »). Les lignes blanches sont dessinées en petits carrés blancs ; une ligne à tirets absente du travers de la photo (vide entre deux tirets) est reprise si au moins 2 des 5 travers la voient. Le bouton est grisé
  pendant la lecture et une fois l'analyse faite pour ce profil. **Pointillé vert clair** : herbe au sol (classée « sol »
  par l'IGN) : bande non revêtue d'1 m au moins, en moyenne 3,5 fois plus claire que l'enrobé (le laser, en proche
  infrarouge, est très renvoyé par la végétation ; gravillons et béton : 2 à 3 fois), ou dont au moins 25 % des points (médiane des cases de 0,25 m) sont de la végétation (retours multiples, ou classe végétation près du sol : herbe haute). L'herbe rase d'un relevé d'hiver reste invisible au nuage : le LiDAR HD n'a pas de couleur. La case « Végétation » (cochée par défaut, choix retenu, grisée tant que l'analyse fine
  n'a pas été faite) montre ou masque le pointillé
  vert clair et la ligne verte. **Ligne verte** : hauteur maximale de la
  végétation (points classés herbe haute, arbustes et arbres par l'IGN), plus haut point à ±0,25 m près, coupée en
  haut du graphique (hauteurs à l'échelle : « canopée +18 m » si elle en sort, sa hauteur au-dessus de la plateforme) ; la légende dit, de chaque côté, où elle commence et sa hauteur au-dessus du sol (relevé LiDAR
  de 2021 à 2024 : fauchage, élagage ou repousse depuis). **Eau** : dès le calcul du profil en travers, cours d'eau de la BD
  TOPO croisés par le travers de la photo (triangle bleu nommé ; tronçons fictifs et souterrains écartés) et surfaces
  d'eau traversées (canal, plan d'eau : bande bleue posée sur le terrain, qui est sur l'eau au niveau de sa surface), sur 45 m de part et d'autre ; avec l'analyse
  fine, surface de l'eau lue dans le nuage (points classés eau par l'IGN, ligne bleue à leur altitude, au niveau du
  jour du relevé ; souvent absente : l'eau renvoie mal le laser). Pendant la lecture du nuage, une barre d'avancement
  (animée tant que le nombre de blocs à lire n'est pas connu, puis remplie bloc par bloc, pourcentage à côté). Essai : `tests/essai-nuage.html` (`#photos=<id>,…` : d'autres photos, sans contrôle de
  position ; canal de Bourgogne : 3b8811e4).
- **Mesure libre par triangulation** : retirée le 20/11/2026 (remplacée par la mesure sur la carte :
  longueur et surface, voir « Mesure sur la carte »).
- **Relevé d'objets (couche SIG)** (bouton épingle de la visionneuse, qui entre en mesure en mode relevé ; un second appui l'arrête) : viser chaque objet (un arbre d'un alignement, par exemple)
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
  l'autre jusqu'à « Vider » ; « Tout effacer » (corbeille, en haut de la visionneuse) ne le retire que depuis ce mode.
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
cliqués, ou projetés au sol sur les autres photos). Dans la photo, la verticale d'une hauteur
est en tirets verts ; sur la carte, les
visées de triangulation sont en tirets rouges.

**Effacer** (bouton ↶ en haut de la visionneuse, à droite des outils de mesure, ou **Ctrl+Z**, aussi dans la carte détachée) : annule le dernier geste
(**Refaire**, bouton ↷, Ctrl+Y ou Ctrl+Maj+Z le rétablit, si rien n'a été fait depuis). La
dernière visée seule (les autres restent),
le dernier clic de l'objet vertical du calage, la sélection ou la mesure en cours ; sans rien en
cours, le dernier point posé (sommet, puis le point de référence ; en relevé d'objets,
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
s'ouvre dans une fenêtre à part (pendant la préparation, l'animation « Préparation de la fiche… » y est montrée au centre : icône de document, ondes, étape et pourcentage d'avancement dessous) et la boîte d'impression du navigateur propose « Enregistrer au
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
du Parcellaire Express (IGN) sur la mini-carte dès le zoom 16, chaque parcelle numérotée teintée d'orange clair (le domaine public,
voirie et cours d'eau, n'a pas de parcelle : il reste sans teinte), bornes de limite de propriété et étiquette de chaque parcelle (section au-dessus du numéro, « B » pour la
section 0B) dès le zoom 17, en tuiles vectorielles de l'IGN (nettes à tout zoom) ; plan numérisé : limites indicatives. La parcelle que regarde la photo est allumée en vert (contour et
fond) : la première que coupe la ligne de cap en partant de la caméra, à 50 m au plus (parcelles lues autour de la caméra au
WFS du cadastre : son étiquette reste dans la visionneuse quel que soit le zoom de la mini-carte) ; elle suit la vue quand on la
tourne, rien n'est allumé en vert dans l'axe d'une rue (domaine public) ni avec Bird Eye (pas de ligne de cap). La
parcelle où se tient la caméra (cour, chemin privé), s'il y en a une, est allumée en jaune, et jamais en vert. Dans la
visionneuse, la section et le numéro de la parcelle verte s'affichent comme sur la mini-carte (section au-dessus du numéro, en violet), centrés à 1,50 m du sol au milieu
de la partie de la parcelle vue directement : milieu du segment qui joint ses limites gauche et droite, là où la visée
cesse de la rencontrer en premier (parcelle voisine, domaine public, ou rien à moins de 50 m) ; sol lu sur le LiDAR HD (MNT à 50 cm du
service d'altimétrie de l'IGN, RGE ALTI s'il manque ; pas le nuage de points) sous ce point et sous la caméra, calage de
la photo compris ; de niveau avec celui de la caméra le temps de la lecture. L'étiquette reste à ce point tant que la
vue balaie la même parcelle. Une croix fine et transparente marque le centre de la vue (la ligne de cap) tant que le
cadastre est coché, pour viser les parcelles. Réglage « Parcelle visée dans la visionneuse » (coché par défaut, grisé sans
le cadastre) : décoché, ni étiquette ni croix dans la visionneuse, le cadastre reste sur la carte. Limites indicatives. Pas de projection dans la photo : un
essai l'a montrée trop imprécise au pied des façades (plan, sol interpolé sous les bâtiments, inclinaison de la photo).

**Couche importée** (onglet « Couche » du panneau : bouton « Importer un fichier… », ou fichier glissé sur
l'onglet) : un fichier GeoJSON, Shapefile (en .zip, ou le
.shp choisi avec son .dbf et son .prj ; reprojeté d'après le .prj) ou GeoPackage (table au choix s'il
en a plusieurs) ou CSV (tableur : séparateur « ; », tabulation ou « , », virgule décimale acceptée, UTF-8 ou Windows-1252
d'Excel ; position en colonnes X et Y, lon et lat, longitude et latitude…, reconnues par leur nom, ou en WKT dans une
colonne `wkt` comme dans l'export CSV ; nombres reconnus sauf les codes commençant par 0 ; lignes sans position
écartées), en WGS 84 ou en Lambert 93 (converti, reconnu d'après les valeurs pour un CSV), dessiné sur la mini-carte et dans la photo, à l'altitude du fichier (z, en NGF) ou posé
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
navigateur d'une session à l'autre (IndexedDB, jusqu'à des centaines de Mo ; sans place, un message le dit) ; « Retirer »
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
puis clic à sa place vue dans la photo, qui le pose et finit le recalage (le clic suivant ne le bouge plus) ; pour
l'ajuster, clic sur l'objet, flèches (0,05°), Entrée pour finir ; un second clic sur l'objet choisi le désélectionne ; Suppr pour le remettre à sa place calculée ; décalage propre à cette photo, la carte n'est pas modifiée. Gardé
avec la couche ; « Exporter » écrit un GeoJSON (WGS 84) où chaque objet porte ses
recalages (membre `recalages` du Feature, hors attributs, ignoré par QGIS : décalage, position et
séquence de la photo) : importé sur un autre poste, les objets y reviennent à leur place. À l'import,
ou en ouvrant une photo à moins de 30 m d'une photo recalée d'une autre séquence (même voie, autre
sens ou autre passage) sans recalage sur la sienne, une fenêtre propose d'aller sur la photo recalée
(une fois par séquence refusée).

**Filtre par attribut** (onglet Couche, sous « Fiches PDF ») : une colonne, une condition (=, ≠, <, >, vide, non
vide) et une valeur ; les objets hors filtre ne sont plus ni sur la carte, ni dans la photo, ni dans le tableau du
parcours (◀ / ▶ compris), ni cochés pour les fiches PDF de tous les objets. Nombres comparés en nombres (virgule
acceptée), textes sans tenir compte des majuscules ; « ≠ » garde les objets sans valeur (« verif ≠ vérifié » : ceux
pas encore vus). Nombre d'objets gardés affiché dessous ; filtre gardé avec la couche, « Effacer » le retire.
L'export garde tous les objets.

**Parcours des objets** (rubrique repliable de l'onglet Couche) : tableau des objets (nom, colonne de l'étiquette,
statut), trié par un clic sur un intitulé et filtré par la recherche (identifiant ou n'importe quel attribut). Un clic
sur une ligne, ou ◀ / ▶ dans l'ordre du tableau, ouvre la photo de l'objet (celle de son recalage, sinon la plus
proche) tournée vers lui. Son statut (« vérifié », « à revoir », « absent » : arbre abattu, panneau déposé…) et un commentaire s'écrivent dans les colonnes `verif`
et `verif_note`, ajoutées à la couche au premier statut : gardées avec elle, enregistrées et exportées comme ses autres
colonnes, et proposées pour la couleur ou l'étiquette. **Modification de la couche**, dans la même rubrique : les attributs de l'objet
choisi (ligne du tableau, ou clic sur l'objet dans la photo) se modifient sous son statut (vide : sans valeur ; nombre
si la colonne en a déjà, virgule acceptée ; texte : les valeurs des autres objets sont proposées en liste, une valeur
nouvelle peut être tapée ; nombre : rien de proposé ; colonne oui / non : case à cocher). « Supprimer l'objet » le retire après confirmation ; « ＋ Ajouter un objet »
pose un point d'un clic sur la mini-carte (Échap annule), puis ses attributs se saisissent ; une colonne « id » reçoit
d'elle-même le plus grand numéro existant + 1 (« 012 » → « 013 » ; vide si aucun id n'est un nombre). Gardé avec la couche ; le
fichier ne change qu'à « Enregistrer ».

**Résultats gardés** : ils sont enregistrés dans le navigateur à chaque changement ; à
l'ouverture suivante, ceux de la session précédente qui n'ont pas été exportés sont proposés à
l'export (CSV, GeoJSON) ou à l'oubli, et affichés en lecture seule : liste sous les résultats,
traits et points gris sur la carte. Ils ne redeviennent pas des mesures modifiables, et sont
oubliés à la fermeture de cette session-là s'ils n'y ont pas été exportés.

**Revoir une mesure exportée** : le fichier de mesures GeoJSON importé (bouton d'import, flèche vers le haut, de l'onglet
**Résultats**, ou import de l'onglet **Couche**, où il s'affiche) s'ouvre sur la photo d'où la première hauteur a été prise, cadrée sur elle,
la mesure dessinée telle qu'elle était à l'écran (colonnes `photo_ref` et `vue_ref`), avec sa valeur
en étiquette (colonne `etiquette`). Un clic sur une autre mesure de la mini-carte la montre de même.
En lecture seule ; les fichiers exportés avant la version 0.6.6 n'ont pas ces colonnes.

**Recaler un point** : **clic** (gauche ou droit) sur sa croix pour le sélectionner (à 8 pixels près, quel que
soit le zoom ; ailleurs, le clic est un point de mesure), puis :

- clic gauche : nouvelle position (hauteur : sur la photo de la mesure ; le point de référence
  se recale de même dès qu'il est validé, sur sa verticale) ;
- flèches du clavier, par pas de 1 cm : hauteur, ↑ ↓ montent ou descendent le point ;
- **Entrée** pour terminer.

**Caler les photos** (bouton équerre « Calage de l'inclinaison » de la visionneuse, qui entre en mesure en mode calage) : inclinaison calculée automatiquement
d'après les verticales de la photo (en arrière-plan), ou calée à la main : pied puis sommet de
deux objets verticaux, à environ 90° l'un de l'autre. Le calage du cap et de la position
(repères sur la carte) n'est pas proposé : le cap n'entre presque pas dans les hauteurs, et le cap EXIF des photos de relevé est déjà juste à 0,3° près. Un calage importé
du plugin QGIS qui en contient reste appliqué.

Les consignes de chaque calage disent l'étape en cours et ce qui est déjà fait.

Le calage est gardé d'une visite à l'autre, et peut être exporté ou importé (onglet « Photo »).

**Calage manuel : voyant, panneau, retrait** : **le panneau s'ouvre de lui-même dès que le mode calage est lancé** (bouton équerre enfoncé), même sans verticale (il dit alors quoi cliquer), se met à jour à chaque verticale validée, reste ouvert si elles sont toutes retirées, et se ferme à la sortie du mode ; ouvert par la pastille (hors mode calage, seul moyen de l'ouvrir), il reste ouvert à la sortie du mode et se ferme quand la photo n'a plus de verticale. Les clics le traversent (sauf sur ses boutons, lignes et en-tête) : il ne gêne pas la pose des verticales. Sur le bouton équerre, une pastille indique le nombre de verticales tracées à la main
sur la photo affichée : verte quand elles s'accordent, orange quand l'une est douteuse ou aberrante ; absente sans verticale. Elle
est recalculée à chaque changement de photo, ajout ou retrait. Un clic sur la pastille (le clic sur le bouton lui-même lance toujours
le calage) ouvre, sous la barre, le panneau « Calage manuel : n verticales » : l'inclinaison retenue (roulis et tangage, avec leur
incertitude ; « partielle » avec une seule verticale), puis un tableau : numéro, angle de la verticale (angle de son plan avec la
verticale de la caméra), écart au consensus des autres verticales, effet (de combien l'inclinaison changerait sans elle) et verdict
« bon », « douteux » ou « aberrante » (en rouge). Avec 2 verticales, « non jugée » (l'inclinaison passe exactement par les deux) ; à 3,
seule la plus éloignée peut être douteuse ; à 4 et plus, le jugement est complet. **Critère** : écart de chaque verticale à la
verticale vraie sur laquelle s'accordent le plus de verticales (le consensus : elle ne se laisse pas tirer par une verticale fausse),
comparé à 1,4826 × la médiane des écarts, jamais moins de 0,3° ; douteuse au-delà de 2 fois cette échelle, aberrante au-delà de 3
fois (0,6° et 0,9° au minimum). Le panneau le rappelle en degrés. 🗑 retire la verticale de sa ligne : l'inclinaison, la droite ↔
et la vue du dessus sont recalculées comme après un ajout, et le calage gardé dans le navigateur est mis à jour. « Écarter les
aberrantes » (grisé sans aberrante) les retire toutes, « Purger la photo » (grisé sans verticale) retire toutes celles de la photo.
**Calcul automatique** : quand l'inclinaison retenue vient des verticales détectées automatiquement dans l'image (« verticales », ou
« verticales (seuil élargi) », moins sûres), la pastille est bleue avec « A » et le panneau dit « Inclinaison calculée
automatiquement : n verticales détectées, roulis x° ±σ, tangage y° » (seulement leur nombre, pas de tableau ; elle vient en tête du panneau, sous son titre « Calage de l'inclinaison », avec le bouton « Réinitialiser », dès qu'un calcul automatique existe pour la photo, retenu ou non ; écarté, ce bloc passe en bas du panneau avec « Rétablir le calcul automatique » ; pas de nombre au seuil
élargi). Les verticales tracées à la main passent devant (deux verticales, ou une seule qui complète l'automatique) : le panneau dit
« Verticales à la main : elles remplacent le calcul automatique ». Seule l'inclinaison de la vue du dessus de la photo (réglée par la vue
du dessus elle-même) passe devant les verticales à la main. **Réinitialiser** ignore le calcul automatique pour cette photo (comme
pour les deux rangs « verticales » : la source suivante de l'ordre prend le relais, LiDAR HD, roulis par défaut de la campagne 2025 ou rien) ; la pastille
est alors grisée et barrée, le bouton devient « Rétablir le calcul automatique ». Le choix est gardé par photo avec le calage (navigateur,
export, import) ; inclinaison, droite ↔ et vue du dessus sont recalculées. Quand l'inclinaison vient d'une autre source (vue du dessus,
LiDAR HD, terrain, roulis par défaut de la campagne 2025 seul), le panneau le dit simplement, sans réinitialisation.
Panneau ouvert, les verticales sont tracées sur la photo, numérotées, de la couleur de leur verdict ; survoler une ligne épaissit sa
verticale, cliquer une ligne (ou le trait d'une verticale dans la photo, hors mesure) la choisit. **Réglages › Calage manuel › Purger
tout** retire les verticales de toutes les photos, après confirmation (grisé sans verticale gardée) ; le calage automatique, les
hauteurs de caméra et le cap ne sont pas touchés.

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

- plus de voyants en haut à droite de la visionneuse (RTK, LiDAR HD, inclinaison retirés) : précision RTK et modèle de terrain restent
  dans la liste « Position » du panneau, l'inclinaison est dite par le message de la carte d'étape ;
- fonds de carte, choisis dans le panneau du bouton en forme de carte pliée (ancien « i ») de la carte : 1. Orthophoto + (par défaut) ; 2. Plan IGN ; 3. Orthophoto ; 4. Ortho-express (année de la photo) ; 5. LiDAR MNT ; 6. LiDAR MNS ; 7. LiDAR MNH ; 8. OpenFreeMap ; recherche de lieux ; points de repère
  (PR) des routes ; requêteur route + PR (+ distance), à listes qui se réduisent à la frappe ;
- lieu de la photo incrusté en bas à gauche de la visionneuse : route, PR et distance mesurée
  le long du filaire IGN depuis le dernier PR passé, nom de la voie précédé du numéro de l'adresse
  la plus proche dans la même rue (à 40 m au plus, base adresse nationale ; approximatif : le côté
  pair ou impair peut être celui d'en face ; sans numéro si aucune adresse de cette rue), hameau ou quartier (zone
  d'habitation de la BD TOPO qui contient la photo, sinon la plus proche à moins de 100 m, sauf
  le bourg), commune ; hors route
  départementale, la véloroute suivie et l'écluse la plus proche (chemins de halage) ;
- bas de la visionneuse, trois pastilles de même style que les boutons du haut : lieu à gauche, lecteur de séquence (1x à 16x) au centre,
  attribution (date et producteur) à droite ;
- carte cadrée automatiquement sur la mesure en cours ;
- carte **détachable** dans une fenêtre à part, à placer sur un second écran (bouton de la fenêtre à part, sous
  l'échange des vues, Edge, Chrome et Firefox récents) : elle reste reliée à la page et se déplace à la
  souris ; fermer la fenêtre, ou
  « Remettre la carte ici » dans la colonne, la remet en place ;
- **filtre des photos** (date, type, précision GPS, producteur) et choix de l'**instance**
  Panoramax : les photos écartées ne s'ouvrent pas, ni par la carte ni par les flèches ;
- captures, deux boutons en forme d'appareil photo en haut à droite de la visionneuse, à gauche du plein écran (« Image seule » : appareil photo ;
  « Avec annotations » : appareil photo marqué d'une mesure) : vue recalculée en Full HD depuis la photo originale, ou visionneuse avec ses
  annotations (« Avec annotations » : mesures, largeur dans la visionneuse (droite, repères et valeur), étiquette de la parcelle visée, objets de la couche ;
  PNG, copiée dans le presse-papiers), active dès qu'une annotation est affichée. « Image seule » est active dès qu'une photo est ouverte et que le calcul
  en arrière-plan est prêt (un moment après le chargement de la page). Pendant l'export, le bouton est grisé (infobulle « Capture en cours… ») et ne peut pas
  être relancé, et une animation « Capture… » (icône du bouton, ondes jaunes) s'affiche au centre de la visionneuse ; à la fin, une coche verte la remplace un
  instant et la ligne d'état donne le fichier écrit ; en cas d'échec, croix rouge, message sur la
  visionneuse et dans la ligne d'état. L'export garde ses propres copies (photo, vue, localisation relues au clic) : fermer la visionneuse ou changer
  de photo ne le gêne pas ; fermer l'onglet pendant l'export demande confirmation ;
- liste des résultats avec commentaire et effacement de chacun ; **export CSV**
  (point-virgule, virgule décimale) et **GeoJSON** : valeur, incertitude, composantes,
  distance à la photo, hauteur de caméra, axe de la route, photos, date, commentaire, photo
  d'où la mesure a été prise et repères vus dessus (pour la revoir), et attributs des points
  triangulés (visées, croisement, précision GPS).

Fichiers exportés (mesures, captures, favoris, calage, couche) : boîte d'enregistrement du système sous
Chrome et Edge (emplacement et nom au choix, demandés dès le clic pour une capture). Firefox n'en donne
pas l'accès aux pages : le fichier est téléchargé, avec sa boîte si « Toujours vous demander où
enregistrer les fichiers » est coché (Paramètres › Général › Fichiers et applications). Noms proposés : la sorte,
la route et le PR de la photo affichée pour les mesures, et la date du jour (« mesures D974 PR12 2026-11-15.csv »,
« calage 2026-11-15.json », « favoris … », « parcours … », « modeles-releve … ») ; la couche garde le nom de son fichier.

**Import commun** : un fichier glissé n'importe où sur la page, ou choisi par n'importe quel bouton d'import, est
reconnu par son contenu et rangé à sa place : couche (GeoJSON, mesures exportées comprises, Shapefile, GeoPackage,
CSV), parcours, modèles de champs, calage ou favoris, avec le message habituel de chacun. Plusieurs fichiers de
sortes différentes peuvent être glissés ensemble. Un fichier JSON non reconnu est signalé (par le bouton d'une sorte :
son message d'erreur habituel).

**Dossier de travail** (Réglages › Dossier de travail) : « Exporter le dossier… » écrit en un seul fichier tout le
travail gardé dans ce navigateur : couche et ses réglages (recalages, statuts, couleurs, étiquettes, filtre), relevé et
ses champs, calage, parcours gardés, favoris, modèles de champs et photo ouverte (« dossier D905 PR12
2026-11-15.json ») ; grisé tant qu'il n'y a rien à y mettre. Importé (bouton, ou fichier glissé sur la page), une
fenêtre liste ses parties, chacune avec une case et ce qu'elle fera : la couche et le relevé remplacent les vôtres
(décochés par défaut si vous en avez déjà), le calage complète le vôtre, parcours, favoris et modèles s'ajoutent, la
photo se rouvre. Les mesures n'y sont pas : elles ne pourraient revenir qu'en lecture seule, sans intérêt (le second
bord d'une largeur s'affichait seul) ; elles s'exportent à part (Résultats), et viendront dans le dossier quand elles
pourront être reprises modifiables. Les réglages personnels (thème, fond de carte…) ne sont pas repris.

Les calculs (cœur Python repris du plugin Visionneuse Panoramax) sont exécutés dans le navigateur par Pyodide (environ 10 Mo au
premier chargement, puis en cache) ; les calculs lourds (inclinaison automatique, capture
Full HD) tournent dans un second Pyodide en arrière-plan. La page vérifie aussi l'accès aux
services depuis le poste (bouton « Services » en bas du panneau).

Pour s'ouvrir en `file://`, la page n'utilise pas de modules JavaScript ni de lecture de
fichiers voisins : scripts ordinaires, et fichiers Python regroupés dans `py/sources.js`.

### Mesure sur la carte : longueur et surface (essai, branche `birdeye`)

« Bird Eye » (vue du dessus, allumée par le bouton faucon de la carte : au sommet de l'étiquette verticale (sans bouton de capture) quand la carte est à sa place, à droite de « Mesurer sur la carte » quand elle est en grand ou détachée)
reprojette le sol de la photo sur la mini-carte, pour la photo affichée seulement (une autre photo l'éteint : rien
n'est calculé sans le demander) ; ses réglages
d'essai sont dans un panneau repliable sur la carte en grand ou détachée ; « Haute résolution » double la finesse de l'image
(0,7 cm par pixel, quelques secondes de plus). Le bouton d'échange (deux flèches) de la carte échange la carte et la visionneuse, chacune à la place et à la taille
de l'autre (la visionneuse, à la petite place, ne garde que la pastille de localisation : curseurs, outils, captures, lecteur, producteur, voyants et carte d'étape sont masqués ; tout revient quand les vues reprennent leur place ; à l'échange, dans les deux sens, rien ne s'arrête : outil et mesures en cours ou terminées (hauteur, relevé, calage, largeur ↔ avec sa droite, profil, mesure sur la carte) gardent leurs tracés sur la photo et sur la carte, redessinés à la nouvelle taille ; Bird Eye est conservé, avec ses réglages ; une mesure sur la carte ne bloque rien dans la visionneuse (réticule, flèches, lecteur) ; carte en grand ou détachée : annuler, refaire et tout effacer sont repris sur la carte, sous les boutons de mesure) ; la carte en grand, comme la carte détachée, propose alors « Mesurer sur la carte », avec une liste d'outil : longueur ou surface. La mesure se fait sur la vue Bird Eye si elle est allumée, sinon sur le fond de carte
seul (« hors vue », sans incertitude) : Bird Eye n'est pas nécessaire. **Surface** : un clic par sommet, le contour se referme en recliquant le dernier
sommet (ou le premier, après trois sommets) ; surface (m²) et périmètre, sans incertitude, rangés avec les autres résultats ; Effacer retire le
dernier sommet, Échap tout le tracé. **Longueur** : un clic pose le départ, le trait suit le pointeur avec sa longueur, un second clic la garde dans les
résultats, comme les autres mesures (Effacer, Refaire, commentaire, export). Pour une largeur, viser de préférence en
face de la caméra, à ±4 m (±5 % au mieux, inclinaison lue sur les façades ou, à défaut, sur la pente de la route, avec le défaut de roulis de la
caméra mesuré pour la campagne : CD21 2025, +1° (véhicule penché à droite), d'après les passages piétons). Sur une photo prise sur un pont (celle des mesures), le LiDAR HD (sol sous le
tablier) est écarté : tablier supposé plan et horizontal (±1,5° d'inclinaison par la route). Une photo juste avant le pont, sur le remblai
qui y mène, garde le relief LiDAR (pente comprise), sauf sous l'ouvrage lui-même. Photos du CD21 : hauteur de
caméra de sa monture d'après la date de prise de vue (1,93 m avant le 24/06/2025, 2,07 m ensuite) ; autres photos : lue entre
photos sur les façades, sinon altitude RTK moins sol. Hors de la vue, la
longueur est mesurée sur le fond de carte seul, sans incertitude (« hors vue »), pour un contrôle rapide. Échap retire
le départ. Sans façade pour caler l'inclinaison, le tangage de fixation de la caméra est lu sur les raccords entre photos
voisines (« Véhicule masqué » allumé ; celui de la photo, qui suit une bosse ou un creux), sinon, en cas d'échec des raccords ou sans eux, sur les lignes et les bords de la route jusqu'à 25 m, qui s'écartent devant et se resserrent derrière quand le tangage est faux (terrain LiDAR HD lu sur 25 m ; médiane des photos vues de la séquence dès 3, sinon la photo seule), sinon médiane des raccords de la séquence ; le curseur « Tangage » ne sert qu'en dernier, faute de tangage lu (grisé sinon), ou avec « Forcer le réglage à la main » ; au-dessus du curseur « Roulis », la ligne « Part du dévers » donne le roulis tiré du dévers de la route sous la caméra (70 % du dévers), en degrés signés (« +0,84° » ; positif : côté droit plus bas, vu dans le sens de la marche ; « — » sans LiDAR HD) ; les curseurs « Roulis » (ajouté à ce roulis) et « Tangage » recalent la vue à la main (« Calage par les verticales » : coché d'office en zone d'habitation, la photo calée sur ses verticales quand elle en a ; ailleurs, inclinaison par la route),
réglage retenu pour toute la séquence, dans ce navigateur. Le bouton appareil photo (carte en grand ou détachée seulement, à droite du faucon ; absent de la carte à sa place, trop petite pour cela) télécharge une image PNG (`carte-<identifiant de la photo>-<date>.png`) de la carte entière telle qu'affichée : fond, filaire, tracés et étiquettes des mesures, vue Bird Eye si elle est allumée ; sans les contrôles (boutons, recherche, requêteur, filigrane, échelle, attribution « i », pastilles et messages de Bird Eye), sauf la mention des sources, en petit et translucide en bas à droite de l'image. Le bouton carte pliée, à sa droite (grisé de même), télécharge la vue Bird Eye seule, géoréférencée pour un SIG (QGIS…) : GeoTIFF en Lambert 93 (EPSG:2154), 30 m de côté, transparent hors de la vue, sans fond de carte ni mesures, posé exactement comme sur la carte (position calée sur l'orthophoto comprise si l'option est cochée) ; il s'ouvre en le glissant dans QGIS. Les messages de Bird Eye, en bas de la carte en grand ou détachée, se masquent par le bouton à icône d'oiseau « Informations Bird Eye », à leur droite, au-dessus du « i » des sources (jaune quand elles sont affichées ; choix retenu dans le navigateur) : ils cachent le bas de la vue. « Bords gardés » (éteint par défaut) garde toute la vue sur 15 m autour de la caméra au lieu de la couper à 8 m de part et d'autre de l'axe de la route (bas-côtés, trottoirs et façades, déformés et grisés au-delà de 10 m). « Véhicule masqué » (éteint par défaut) recompose la vue avec les photos précédente et suivante pour cacher le véhicule : masque au plus près de son contour (lu une fois sur 12 photos de la séquence pour le CD21, environ 5 Mo ; cône de la vue retiré de la carte), photo affichée intacte hors du masque, voisines seulement dessous ; il recale chaque
photo voisine sur la photo affichée, par corrélation du sol commun (marquages, passages piétons, grain), pour effacer
les marches aux raccords, et accorde leur luminosité à celle de la photo affichée (plus de taches claires ou sombres autour des raccords) ; la barre d'état indique l'écart avant et après. « Sans cache (essais) » oublie ce que Bird Eye a retenu et recalcule tout à chaque photo, même déjà vue. « Position calée sur l'orthophoto » (essai, décoché par défaut depuis le 20/11/2026 : à cocher pour l'activer) pose la vue sur l'orthophoto
quand ses lignes s'en écartent de plus de 30 cm en travers : le GPS est alors suspecté avant l'orthophoto. La vue montre aussi la chaussée cachée par les arbres sur l'orthophoto. Construction de
la vue et recalages : `docs/BIRDEYE.md` ; chiffres des essais : `docs/CALCULS.md`.

## Précision

**État de la validation (05/11/2026)** : les mesures de hauteur sont validées sur des objets connus. Les retours
de terrain sont encore attendus pour les mesures de largeur, les hauteurs de chute de pont, les dévers et les
largeurs de chaussée LiDAR (analyse fine) : ces valeurs n'ont pas encore été comparées à des relevés sur place.

**Largeur dans la visionneuse : l'incertitude grandit avec la distance de la droite** (poignée de profondeur) : une erreur d'inclinaison (tangage) δ sur la photo déplace un bord latéral de s de `s·d·δ/H` (d : distance de la droite, H : hauteur de la caméra), donc la largeur de `(s₂ − s₁)·d·δ/H` ; l'incertitude de la largeur croît en gros comme distance / hauteur × erreur d'inclinaison (à ±0,5°, d = 10 m, H = 1,93 m et 8 m de largeur : environ 0,36 m contre 0,16 m à 4,5 m), et le roulis et la hauteur n'en dépendent pas. L'étiquette et l'encart donnent l'incertitude de la droite à sa distance du moment. Au-delà de 5 à 6 m du nez, la photo suivante, plus près des bords, les lit mieux. **Accord avec la vue du dessus** : une fois la photo calée par Bird Eye (vue ouverte ou calage silencieux), la droite prend la hauteur de caméra et le terrain lissé de la vue du dessus : la largeur de mêmes bords est la même dans les deux, à 1 cm près (avant : 7 % de moins sur la photo 8625c7ff-90c1-4865-b936-fd8952ac908f, 6,00 m contre 6,56 m). Sans calage, la hauteur est la monture du véhicule (CD21) avant l'altitude GPS, le sol le MNT brut ; la largeur est alors moins sûre de quelques pour cent.

**Confiance de l'inclinaison** (22/11/2026) : l'inclinaison retenue pour une photo est confrontée à une source indépendante (image :
verticales ; terrain : LiDAR HD de la séquence, route de la vue du dessus ; méthode dans `docs/CALCULS.md` § 1.3). Où on la voit :
- **panneau « Calage manuel »**, en tête : « Confiance de l'inclinaison : confirmée » (vert : les deux sources s'accordent),
  « désaccord : tangage 0,9° / roulis 1,6° entre verticales et LiDAR (retenue : verticales) » (orange : écart au-delà de la tolérance,
  à prendre avec prudence ; la source dite « retenue » est celle qui sert aux mesures ; tolérance : au moins 0,5° en tangage et 0,7° en
  roulis, qui suit l'incertitude des sources sans dépasser 1,0° et 1,2°), « non vérifiable : une seule source (LiDAR) » (gris : rien pour confirmer, pas forcément faux), « pont : inclinaison
  non vérifiable » (gris : sur un pont le LiDAR décrit le sol sous l'ouvrage). Sans verticale ni calcul automatique, la pastille du
  bouton de calage montre « i » (grise, orange en désaccord) pour ouvrir le panneau ; sinon la pastille garde son sens (verticales),
  sans couleur de confiance ;
- **onglet Résultats** : sous chaque mesure, « inclinaison confirmée / non vérifiable / en désaccord / pont : inclinaison non
  vérifiable », telle qu'au moment de la mesure (mise à jour si l'inclinaison de sa photo change) ;
- **exports CSV et GeoJSON** : colonnes `confiance_inclinaison` (`confirmee`, `desaccord`, `non_verifiable`, `pont`), `ecart_tangage`
  et `ecart_roulis` (degrés, témoin moins retenue ; vides sans témoin) ; rien pour les mesures sur la carte ;
- **largeur ↔** : l'encart de lecture ajoute « (confirmée) », « (non vérifiable) » ou « (désaccord : tangage…, roulis…) » à la source de
  l'inclinaison. La route de la vue du dessus ne sert de témoin qu'une fois la vue calée sur la photo.

**Inclinaison utilisée** : un seul ordre pour les mesures et la largeur dans la visionneuse (20/11/2026) : réglage de la
vue du dessus pour la photo, calage à la main, verticales de la photo, LiDAR sous le véhicule, verticales à seuil élargi, roulis de
la campagne seul (tangage inconnu, ±2°), rien (±2°). Elle est calculée à l'entrée en mesure pour la photo affichée,
puis au premier clic sur une autre photo (pendant le calcul, une animation « Calcul de l'inclinaison… » s'affiche au centre de la visionneuse : icône de niveau à bulle, ondes jaunes, coche verte à l'arrivée du résultat, croix rouge si le calcul n'en donne pas ; le message du haut dit seulement d'attendre avant de mesurer) ; la ligne d'état en donne la source et l'incertitude (par exemple « inclinaison calée
dans la vue du dessus (±0,8°) », « inclinaison non calée : roulis par défaut de la campagne 2025 seul, tangage inconnu (±2,0°) », affichée seulement quand le calcul a été fait sans résultat ; avant, « inclinaison calculée à l'activation de la mesure ; roulis par défaut de la campagne 2025 en attendant »). Voir
`docs/CALCULS.md` § 1.3. Les mesures déjà faites sur une photo se recalculent quand son inclinaison change (arrivée des
verticales, réglage de la vue du dessus).

Essais sur deux photos imajbox à position RTK (±0,10 m) de Pouilly-en-Auxois, distantes de
5 m, sur des cibles connues (`tests/essai-rtk.html`) :

| Mesure | Résultat | Attendu |
|---|---|---|
| Point de référence (visées croisées à 54°) | ±0,17 m | sur la cible |
| Hauteur | 3,46 m ± 0,11 m | 3,464 m |
| ~~Distance entre deux points~~ (mesure libre, retirée le 20/11/2026) | 3,60 m ± 0,24 m | 3,606 m |
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
profils LiDAR HD relevés autour des ponts : 6,4 m pour le pont de la D111 au-dessus de l'A6 à
Beaune ; 4,2 m pour la D977 bis au-dessus du canal de Bourgogne (tablier à 361,4 m, eau à
357,4 m) ; tablier interpolé entre les photos du pont depuis le 02/11/2026 (avant : photo la plus proche, 6,3 et
4,3 m) ; 1,7 m pour la D114 au-dessus du ruisseau de la Gironde à Barbirey-sur-Ouche (lit
vers 314 m, route à 315,8 m). Le terrain lu à 1 m du bord seulement donnait 2 m et 0 m : il
tombait sur le talus de la culée. En secours par l'altitude GPS, l'erreur de la hauteur de caméra passe
telle quelle dans la chute : la monture du CD21 d'après la date (±4 cm, 15/11/2026) remplace le réglage
de 1,90 m (±15 cm), soit jusqu'à 17 cm de mieux sur les photos de la monture haute (2,07 m).

Hauteur de caméra : la mesure de hauteur n'en dépend pas (essai du 15/11/2026 :
mêmes valeurs et incertitudes avec 1,90, 2,07 et 2,50 m) ; elle sert au tablier d'un pont (secours GPS),
au relevé sur une seule photo et aux objets posés au sol. Dans l'ordre : altitude RTK moins sol LiDAR HD,
calée pour la séquence, monture du CD21 d'après la date, réglage. Colonne `camera_m` de l'export : celle
de la photo du premier clic ; `camera_calee` : 0 réglage, 1 calée, 2 altitude GPS, 3 monture.

Chute et dévers des bords de route : la chute est une différence de deux altitudes du même
modèle de terrain (±0,1 m en LiDAR HD, ±0,4 m en RGE ALTI). Le dévers est une pente moyenne,
du haut au pied du talus : le haut et le pied sont placés au pas des points près (0,5 m près
du bord, 0,6 m au-delà pour 10 m examinés, 1,9 m pour 30 m), ce qui pèse sur un talus court.
Le MNT LiDAR HD varie de moins de 1 cm d'un point au suivant sur une chaussée (mesuré sous trois
photos d'essai) : à ce bruit, sur des talus synthétiques de 20 à 100 %, le bord tombe à 5 cm près,
le dévers à 1 point près, et la chute est majorée de 3 à 4 cm (le point le plus bas est pris
au plus bas du bruit), sous l'incertitude affichée.
Sous des arbres ou un mur, le modèle de terrain est interpolé et adoucit la pente. Le bord de
la chaussée vient d'une rupture de pente du terrain, sinon des travers voisins ou de la largeur
BD TOPO. Pas encore
comparé à des talus de hauteur connue.

Pente en long (`tests/essai-bords.html`, photos 732c2c09, cd5e947c, d148d430 et 70b78dc8) : profils
cohérents avec la route vue sur la photo, arrêt à la fin de la D16, un seul carrefour autour d'un
îlot séparateur, tablier d'un pont interpolé, y compris quand le pont de la BD TOPO est plus court
que la brèche du terrain (70b78dc8 : 86 % sur 10 m avant correction, 4,7 % après), ou en creux peu profond sur un
ruisseau (92e3faf1). Le MNT donne la pente à quelques dixièmes de point près
sur 100 m ; sur un pont, le tablier est une droite d'une culée à l'autre, sans sa courbure.

Analyse fine (`tests/essai-nuage.html`, A38, RD903bis, D1074, RD700) : séparateur placé à la case du nuage près (0,25 m).
Largeur d'enrobé : trouvée sur 7 photos sur 9, à ±0,1 ou ±0,2 m entre travers voisins (village, faible contraste : règle à défaut), jamais comparée à des mesures de terrain. L'herbe du séparateur de l'A38 n'est pas reconnue, et l'eau
du nuage n'a été vue sur aucune photo d'essai.

Avec un GPS grand public
(±4 m), le point de référence est à plusieurs mètres près, et une hauteur à ±2 à 3 m.

### Limites

- Mesures fiables seulement sur des photos à position RTK vérifiée.
- Points projetés sur les autres photos que celle du clic : sol supposé plat, à la hauteur
  de caméra de la photo (affichage seulement, la mesure n'en dépend pas).
- Triangulation 3D validée sur des cas simulés seulement : à confirmer sur des points
  relevés sur le terrain.
- Mesures non rechargées à l'ouverture suivante : affichées en lecture seule et proposées à
  l'export pendant la session suivante seulement (dans ce navigateur), puis oubliées.

### Organisation

| Fichier | Rôle |
|---|---|
| `docs/analyses/` | notes d'analyse (novembre 2026) : détection des bords en « Dévers », critique de `MESURES.md`, limites structurelles ; pistes, pas des descriptions du code |
| `docs/CALCULS.md` | calculs de chaque mode, seuils et précision |
| `index.html`, `src/style.css` | page et mise en page |
| `src/app.js` | socle de la page : services, état partagé (`etat`), calcul, filtre des photos, enregistrement des fichiers ; branche les fichiers ci-dessous (`X.init`) |
| `src/reglages.js` | réglages de l'affichage gardés dans le navigateur (fond, filaire, PR, cadastre…) et fenêtre du profil en travers |
| `src/resultats.js` | résultats des mesures, carte et visionneuse échangées, boutons de la carte (longueur, Bird Eye, capture, export) |
| `src/choix.js` | choix de la photo sur la carte, photo affichée, carte détachée, droite et longueur tracées, objets recalés ou posés |
| `src/favoris.js` | photo loin des mesures, aller à une photo, favoris |
| `src/objets.js` | couche importée dans la page : réglages, filtre, tableau des objets, recalages, export ; import commun des fichiers |
| `src/visionneuse.js` | visionneuse : cap et champ de la vue, chargement des photos, flèches, clics |
| `src/mesure.js` | prise de mesure : boutons de mesure de la visionneuse et commandes cachées « Mesure » et « Mode », visées et réticule, visées guidées |
| `src/releve.js` | relevé d'objets, dossier de travail, modèles de champs, import des calages |
| `src/disposition.js` | disposition de la page : hauteur de la carte, largeur de la colonne (poignées, repli), plein écran de la visionneuse |
| `src/parcours.js` | lecture de la séquence (1x à 16x) et onglet « Vidéo » : parcours, effets posés sur la carte, point d'intérêt, parcours gardés, calcul de la vidéo |
| `src/fiche.js` | captures de la visionneuse (« Image seule », « Avec annotations ») et fiches PDF des points et des objets de la couche |
| `src/carte.js` | carte MapLibre : fonds, filaire, points de repère (PR), mesures, étiquettes, poignées, photo la plus proche |
| `src/traits.js` | surcouche des mesures dans la visionneuse, en WebGL : traits, croix, réticule glissant, étiquettes des mesures et noms des points (la couche importée reste en repères HTML) |
| `src/attente.js`, `src/attente.css` | animation d'attente au centre d'une zone (visionneuse ou carte) : pastille avec l'icône de l'action, ondes, message et étape, coche ou croix à la fin |
| `src/calcul.js` | chargement de Pyodide (page et arrière-plan) et des fichiers Python (`py/sources.js`) |
| `src/services.js` | vérification de l'accès aux services |
| `src/recherche.js` | recherche de lieux sur la carte (commune, lieu-dit, voie, adresse) |
| `src/requeteur.js` | requêteur route + PR (+ distance) : routes du département affiché, côté droit par défaut |
| `src/couche.js` | couche importée (GeoJSON, Shapefile par shpjs, GeoPackage par sql.js, CSV) : lecture, Lambert 93 en WGS 84, couleur et étiquette selon une colonne |
| `src/lieu.js` | route, point de repère (PR), véloroute, écluse, hameau et commune de la photo, incrustés dans la visionneuse |
| `py/web_app.py` | application de mesure : clics → cœur de calcul → JSON pour la page (points de référence, hauteurs, relevé d'objets, recalages) |
| `py/web_chutes.py` | hauteurs de chute et dévers : sur un pont, et sur les bords de route (profils, séparateur, analyse fine) ; base de `App` |
| `py/web_pose.py` | pose de la caméra : inclinaison automatique (raison d'un échec), inclinaison par le terrain, monture et défaut de roulis, pose de la vue du dessus ; base de `App` |
| `py/web_host.py` | accès réseau du cœur par le `fetch` du navigateur |
| `py/web_worker.py` | calculs lourds dans le Pyodide d'arrière-plan |
| `py/geoid.py` | altitude NGF (grille RAF20 de l'IGN) |
| `py/core/` | cœur de calcul (repris du plugin) : triangulation, calage, précision, mesures |
| `py/sources.js` | fichiers Python de `py/` regroupés pour la page (généré par `tools/sources.sh`) |
| `tests/coeur/` | tests du cœur de calcul : scènes synthétiques à réponse connue (lancés avec `tests/test_calculs.py`) |
| `tests/essai-cadastre.html` | cadastre sur la mini-carte (PNG dans le journal) |
| `tests/essai-profil-pdf.html` | profil en travers en PDF : la feuille tient sur une page (sa page HTML dans le journal) |
| `tests/test_calculs.py` | essais rapides des calculs, sans navigateur ni réseau (`python3 -m unittest discover -s tests`, quelques secondes avec `tests/coeur/`) |
| `tests/navigateur.html` | essai de bout en bout dans un vrai navigateur |
| `tests/commun.js` | code commun des pages d'essai : journal, attentes de condition, contrôles et bilan (« contrôles : n réussis ») |
| `tests/essai-rtk.html` | hauteur sur photos RTK, avec recalages |
| `tests/essai-calage.html` | calage de l'inclinaison : croix sélectionnée à 8 px près, au zoom fort |
| `tests/essai-profil.html` | fond du graphique du profil en travers, sur des profils synthétiques (sans réseau) : 1 m ou 0,3 m sous le point le plus bas |
| `tests/inclinaison-terrain.html` | inclinaison par le terrain hors agglomération (option) |
| `py/web_terrain.py` | inclinaison par le terrain hors agglomération : grille LiDAR HD, modèle de séquence |
| `tools/serveur-essai.py` | serveur des essais : sert le site et affiche leur journal |
| `tools/essais.sh` | lanceur des essais (`rapide`, `birdeye`, `complet`, `video` ou pages) : durée et bilan par page |

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
- Interface réduite : hauteur, largeur, distance sur la carte ; calage seulement si
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
| Géoplateforme IGN : WMTS | orthophoto | accessible |
| Géoplateforme IGN : altimétrie | LiDAR HD, ou RGE ALTI en secours, sous les photos et au point visé (vérification de la position RTK, sol au point, inclinaison automatique) | accessible |
| Géoplateforme IGN : WFS | BD TOPO (axe de la route, route, PR, hameau et commune de la photo, PR sur la carte, département du requêteur), ADMIN EXPRESS (limites administratives, contour de la commune cherchée) | accessible |
| Géoplateforme IGN : tuiles vectorielles (TMS) | Plan IGN (fond, routes numérotées, noms), BD TOPO (voies) | accessible |
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
   triangulés (retirée le 20/11/2026, remplacée par la mesure sur la carte).
4. ~~Mesures appuyées sur un point triangulé~~ (16/10/2026) : hauteur et largeur depuis un
   point de référence, recalage au clic et au clavier ; longueur sur une seule photo
   et calage de la hauteur de caméra retirés.
5. ~~Mini-carte détachable sur un second écran~~ (ticket #13).
6. ~~Première version publiée~~ : 0.1.0 (17/10/2026).
7. Essais sur le terrain avec les agents (postes Edge, photos RTK).

### Pour plus tard

- **Export pour un inventaire** : tableur, une ligne par mesure (route, PR + abscisse, type,
  valeur ± incertitude, lien vers la photo Panoramax, date), à partager avec des collègues sans QGIS ni
  l'application. Second bouton CSV, l'export complet (`export_csv`, `py/web_app.py`) restant pour QGIS et les
  réimports. Revu le 15/11/2026, ce qui manque à l'export actuel :
  - route et PR + abscisse : absents. La page les lit à l'ouverture d'une photo (`Lieu.describe`) ; pour une
    mesure prise plus tôt, à garder au moment de la mesure ou à relire à l'export ;
  - lien vers la photo : seuls ses identifiants sont écrits (`photos`, `photo_ref`), pas d'adresse cliquable ;
  - date : `date_mesure` est le jour de la mesure, pas la date de prise de la photo ;
  - lisibilité : une vingtaine de colonnes aujourd'hui, dont beaucoup de techniques (`horiz_m`, `camera_calee`,
    `vue_ref`, `recales`, `lon1`…`lat2`).
- **Contrôle d'une largeur sur l'image vue du ciel**, quand le PCRS (image à 5 cm) sera publié
  en Côte-d'Or (absent le 22/10/2026, vérifié à Pouilly-en-Auxois) : cliquer les deux bords sur
  la mini-carte, puis comparer avec la largeur mesurée sur la photo ; un écart supérieur aux
  incertitudes signale un mauvais bord visé ou un axe faux. Environ ±0,1 m avec le PCRS
  (±0,3 m avec l'orthophoto à 20 cm). L'axe de la route n'en vaut pas la peine : la trajectoire
  RTK le donne déjà à ±0,5°. Le fond PCRS de la carte a été retiré le 16/11/2026 (pas encore publié ici) : à remettre
  avec cette piste (commit « Fond PCRS retiré », couche choisie par le graphe de mosaïquage de l'ANCT).
- **Inclinaison par le terrain en rase campagne** (ticket #29) : option expérimentale en place
  (voir « Utilisation » et « Précision »). Reste à la valider sur des longueurs connues en rase
  campagne, à plus de 70 km/h, où aucune photo n'a d'arêtes verticales, et à revoir le roulis en
  virage sur plus de virages (le 23/10, 16 photos de village le disaient utile à 3 à 6°/g ; le
  24/10, le seul virage témoin le contredisait). Essais du 23/10 sur 7 séquences : les
  verticales calent 41 % des photos en zone d'habitation, 2 % hors zone ; le modèle par le
  terrain du cœur n'est accepté que sur 2 séquences sur 7 ; le tangage au freinage n'a pas
  d'effet mesurable.
