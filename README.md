# Mesures Panoramax (web-measures)

Application web de mesure sur les photos de rue [Panoramax](https://panoramax.fr), sans
installer QGIS : largeur d'une chaussée, hauteur d'un objet, longueur,
position d'un objet, à préparer ou vérifier depuis le bureau.

Elle reprend les calculs du plugin QGIS
[Visionneuse Panoramax](https://github.com/medlab-code/visionneuse_panoramax), validés sur
des photos imajbox 360 HD à position RTK (Pouilly-en-Auxois, Montbard, Semur-en-Auxois…).

## État

**Maquette** : on choisit une photo sur la carte (Plan IGN ou orthophoto, filaire
Panoramax) ; elle s'ouvre dans la visionneuse officielle Panoramax, où l'on clique les
points à mesurer :

- **largeur de chaussée** (perpendiculaire à l'axe de la route de la BD TOPO), **longueur**
  et **hauteur** (avec, au choix, la façade du cadastre comme plan de mesure) ;
- résultat avec son **incertitude**, repères dans la photo, trait et étiquette sur la carte ;
- point mal placé : **glisser sa poignée** sur la carte, ou cliquer son repère dans la photo
  puis sa bonne position ;
- **export CSV** (point-virgule, virgule décimale) et **GeoJSON** des mesures terminées.

Les calculs sont ceux du plugin, exécutés dans le navigateur par Pyodide (Python 3.14,
environ 10 Mo au premier chargement, puis en cache). La page vérifie aussi l'accès aux
services depuis le poste (encart « Accès aux services »).

**Ouvrir la page** : double-cliquer sur `index.html` suffit (Edge, Chrome, Firefox), sans
installation ni serveur ; une connexion à internet est nécessaire (bibliothèques, Pyodide et
services). Elle peut aussi être publiée sur n'importe quel serveur web statique, ou servie
localement :

```
python3 -m http.server 8765    # puis http://127.0.0.1:8765/
```

Pour s'ouvrir en `file://`, la page n'utilise pas de modules JavaScript ni de lecture de
fichiers voisins : scripts ordinaires, et fichiers Python regroupés dans `py/sources.js`.

### Limites de la maquette

- **Inclinaison de la photo non calée** : ni calage, ni inclinaison automatique pour
  l'instant ; l'incertitude compte donc ±2° d'inclinaison, d'où des marges de l'ordre de
  ±0,7 m sur une largeur de chaussée.
- **Hauteur de caméra saisie** (1,90 m par défaut) : la proposition d'après l'altitude GPS
  demande l'altitude NGF (grille du géoïde), pas encore disponible ici.
- Mesures perdues en fermant la page : les exporter avant.
- Pas d'indicateur de fiabilité ni de triangulation (étape 3).

### Organisation

| Fichier | Rôle |
|---|---|
| `index.html`, `src/style.css` | page et mise en page |
| `src/app.js` | relie carte, visionneuse et calcul |
| `src/carte.js` | carte MapLibre : fonds, filaire, mesures, poignées, photo la plus proche |
| `src/calcul.js` | chargement de Pyodide et des fichiers Python (`py/sources.js`) |
| `src/services.js` | vérification de l'accès aux services |
| `py/web_app.py` | application de mesure : clics → cœur de calcul → JSON pour la page |
| `py/web_host.py` | accès réseau du cœur par le `fetch` du navigateur |
| `py/core/` | cœur de calcul du plugin, **copié** par `tools/update-core.sh` (ne pas modifier ici) |
| `py/sources.js` | fichiers Python de `py/` regroupés pour la page (généré par le même script) |
| `tests/navigateur.html` | essai de bout en bout dans un vrai navigateur |

Mettre à jour le cœur : `tools/update-core.sh [dossier du plugin] [révision]` (par défaut
`../visionneuse_panoramax`, branche `dev`) ; la révision copiée est notée dans
`py/core/SOURCE`.

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
- Interface réduite : largeur, hauteur, longueur, position ; calage avancé seulement si
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
| Géoplateforme IGN : altimétrie | profil du terrain (LiDAR HD, RGE ALTI) | accessible |
| Géoplateforme IGN : WMS (`wms-r`) | MNS du LiDAR HD (façades) | accessible |
| Géoplateforme IGN : WFS | BD TOPO (axe de la route), cadastre (façades) | accessible |
| Open-Meteo | altitudes de secours | accessible |

**À refaire depuis le poste des utilisateurs** (proxy ou pare-feu d'entreprise) : ouvrir la page et relever la liste.

## Étapes

1. ~~Séparer le cœur de calcul de QGIS~~, dans le plugin : paquet `core/` sans import QGIS,
   services de l'hôte (réseau, altitude NGF, décodage d'image) installés par l'application.
2. ~~Maquette~~ : visionneuse officielle, cœur dans Pyodide, largeur, longueur et hauteur,
   recalage sur la carte, export CSV et GeoJSON.
3. Indicateur de fiabilité, inclinaison automatique, puis triangulation.

## Licence

GPL v2 ou ultérieure (fichier `LICENSE`), comme le plugin dont les calculs sont repris.
