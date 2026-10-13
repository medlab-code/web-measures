# Mesures Panoramax (web-measures)

Application web de mesure sur les photos de rue [Panoramax](https://panoramax.fr), pour
les agents qui n'utilisent pas QGIS : largeur d'une chaussée, hauteur d'un objet, longueur,
position d'un objet, à préparer ou vérifier depuis le bureau.

Elle reprend les calculs du plugin QGIS
[Visionneuse Panoramax](https://github.com/medlab-code/visionneuse_panoramax), validés sur
les photos du conseil départemental de la Côte-d'Or (caméra imajbox, position RTK).

## État

Première page seulement : carte (Plan IGN ou orthophoto, filaire Panoramax), photo la plus
proche d'un clic, et **vérification des services** appelés depuis le navigateur. Aucune
mesure encore.

```
python3 -m http.server 8765    # puis http://127.0.0.1:8765/
```

Un serveur web statique suffit : pas de compilation, pas de serveur applicatif. La page
s'ouvre mal en `file://` (les modules JavaScript y sont bloqués).

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
| OpenTopoData | altitudes de secours | **inutilisable** : pas d'en-tête CORS |

**À refaire depuis un poste d'agent** du département : ouvrir la page et relever la liste.

## Étapes

1. **Séparer le cœur de calcul de QGIS**, dans le plugin : un paquet sans import QGIS qui
   reçoit une fonction d'accès réseau en paramètre. Déjà indépendants : `triangulation`,
   `geometry`, `ground`, `calibration`. À découpler : `terrain`, `precision`, `roads`,
   `buildings`, `autotilt` (réseau et décodage d'image par QGIS) et la logique de
   `measure_tool` (mêlée au dessin sur la carte).
2. **Maquette** : visionneuse officielle, cœur dans Pyodide, largeur et hauteur, export
   CSV et GeoJSON.
3. Indicateur de fiabilité, inclinaison automatique, puis triangulation.

## Licence

GPL v2 ou ultérieure (fichier `LICENSE`), comme le plugin dont les calculs sont repris.
