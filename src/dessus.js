// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Vue du dessus : le sol de la photo 360° reprojeté sur la mini-carte. Chaque point du terrain
// (MNT LiDAR HD, sinon plan horizontal) reçoit le pixel de la photo la plus proche qui le voit, compte
// tenu de la hauteur de la caméra, de son inclinaison et du cap (voir App.birdeye_pose). Les photos
// précédente et suivante couvrent le sol caché par le véhicule. Seuls les points réellement au sol
// sont à leur place : poteaux et autres objets s'étalent.

import { Attente } from "./attente.js";
import { Lieu } from "./lieu.js";
import { Nuage } from "./nuage.js";
import { Services } from "./services.js";
import { Video } from "./video.js";

// Convention du roulis du véhicule, dans tout ce fichier et dans le code qui lui parle (py/web_pose.py : profils de campagne, pose.roll_defect) :
// positif = véhicule penché à DROITE (côté droit plus bas, vu dans le sens de la marche), négatif = à gauche. Le cœur de calcul
// (py/core/calibration.py, repris du plugin QGIS) a la convention inverse ; elle est changée en un seul endroit, côté Python
// (roulis_vehicule_depuis_camera, py/web_pose.py), jamais ici. Voir docs/CALCULS.md.

const Dessus = (() => {
  const WGS84_A = 6378137, WGS84_E2 = 0.00669437999014;  // ellipsoïde des positions GPS, comme py/core/triangulation.py
  const REACH = 15;  // m : portée de la vue
  const SURE = 10;  // m : grisé au-delà (0,6° d'inclinaison y déplacent déjà un point de 45 cm)
  const MARGE_ZONE = 0.5;  // m : marge au-delà de la zone mesurable par « Largeur dans la visionneuse » (option « Limiter à la zone mesurable »)
  const STEP = 1;  // m : maille du terrain (LiDAR HD à 50 cm, toit de la chaussée compris)
  const SIZE = 1024;  // px : côté de l'image des calculs (hauteur, raccords, position), soit 3 cm par pixel
  // px : côté de l'image affichée, 1,5 cm par pixel ; la photo est plus fine jusqu'à 10 m (12 288 px : 0,5 cm en travers et
  // 2,6 cm le long à 10 m, 0,2 et 0,5 cm à 4 m), les voisines (NEAR_LIMIT) deux fois moins
  const SHOWN_SIZE = 2048, FINE_SIZE = 4096;  // FINE_SIZE : « Haute résolution », 0,7 cm par pixel (zoom 24 de la carte)
  const ALTI_CHUNK = 300;  // points par requête d'altitude en GET, si le POST échoue (longueur de l'adresse : environ 6,5 Ko)
  // Contour du véhicule dans le panorama, par hauteur de caméra (hauteurs de py/web_profils.py) : élévation (degrés) sous laquelle le véhicule cache le sol,
  // tous les 2,8° depuis l'arrière (bord du panorama), avant au milieu ; marge de 1,5° comprise (environ 10 cm au sol ; à 1°, des bords de
  // carrosserie des voisines restaient visibles). Relevé le
  // 09/11/2026 sur la médiane de 16 photos d'une séquence (1,93 m, Clio 5 blanche : 67e2ef09, 10/06/2025 ; 2,07 m, Captur bleu : 5bab4dc2, 03/07/2025). Le Captur bicolore (dès le 10/07/2025,
  // même hauteur) prend le contour 2,07 du Captur bleu, sans relevé à lui (#75).
  // shortcut: relevé à la main sur deux séquences, à refaire si le véhicule change
  const OUTLINES = {
    1.93: [
      -26.7, -26.8, -26.8, -26.8, -26.9, -27.1, -27.2, -27.5, -27.8, -28.3, -28.8, -29.7, -30.6, -31.5, -32.3, -33.1, -33.9,
      -34.7, -35.5, -36.4, -37.3, -38.1, -38.8, -39.5, -40.2, -41.0, -41.8, -42.5, -43.2, -43.9, -44.6, -45.1, -45.5, -45.7,
      -45.9, -45.8, -45.7, -45.5, -45.3, -45.0, -44.6, -44.1, -43.6, -42.8, -42.0, -41.3, -40.6, -36.2, -33.7, -33.0, -33.0,
      -33.0, -32.3, -31.5, -30.6, -28.3, -26.0, -25.7, -25.3, -25.2, -25.1, -25.1, -25.1, -25.1, -25.1, -25.3, -25.5, -25.7,
      -25.8, -26.2, -26.5, -27.2, -27.8, -28.7, -29.7, -30.8, -32.0, -32.5, -32.9, -33.0, -33.6, -35.0, -37.3, -38.3, -39.4,
      -40.2, -41.1, -41.9, -42.7, -43.2, -43.8, -44.2, -44.6, -45.0, -45.3, -45.5, -45.7, -45.7, -45.7, -45.5, -45.3, -44.9,
      -44.5, -44.0, -43.6, -43.0, -42.4, -41.6, -40.8, -39.9, -39.0, -38.1, -37.1, -36.0, -35.0, -33.8, -32.7, -31.4, -30.1,
      -29.0, -27.9, -27.4, -26.9, -26.8, -26.7, -26.7, -26.7, -26.7],
    2.07: [
      -24.3, -24.3, -24.3, -24.4, -24.4, -24.5, -24.5, -25.2, -25.8, -26.9, -27.9, -29.5, -31.1, -32.4, -33.7, -34.8, -35.9,
      -36.7, -37.6, -38.5, -39.4, -40.2, -41.1, -41.9, -42.7, -43.2, -43.8, -44.5, -45.2, -45.4, -45.7, -45.8, -45.9, -45.8,
      -45.7, -45.4, -45.2, -44.8, -44.5, -43.9, -43.4, -42.7, -42.0, -41.3, -40.6, -35.3, -34.6, -33.2, -33.2, -33.2, -33.4,
      -32.8, -32.3, -31.3, -30.2, -27.9, -25.7, -25.4, -25.1, -25.0, -25.0, -24.9, -24.8, -24.8, -24.8, -24.8, -24.8, -24.9,
      -25.0, -25.1, -25.3, -26.4, -27.6, -29.3, -31.1, -32.0, -32.9, -33.2, -33.6, -33.7, -34.1, -36.2, -40.2, -40.9, -41.5,
      -42.1, -42.7, -43.2, -43.8, -44.2, -44.6, -45.0, -45.3, -45.5, -45.7, -45.8, -45.9, -45.8, -45.7, -45.5, -45.3, -44.9,
      -44.5, -43.9, -43.4, -42.7, -42.0, -41.4, -40.8, -40.0, -39.2, -38.2, -37.3, -36.3, -35.3, -34.1, -32.9, -30.7, -28.5,
      -26.7, -25.0, -24.6, -24.3, -24.3, -24.3, -24.3, -24.3, -24.3],
  };
  const EITHER = OUTLINES[1.93].map((e, k) => Math.max(e, OUTLINES[2.07][k]));  // hauteur pas encore connue : les deux
  const LOWEST = OUTLINES[1.93].map((e, k) => Math.min(e, OUTLINES[2.07][k]));
  // Contour lu sur la séquence elle-même (readOutline), d'abord : d'autres montages existent (15/07/2025, 3e222d68 : caméra plus
  // en arrière, rétroviseurs 7 à 9° plus près de l'avant). Moyenne de OUTLINE_PHOTOS photos SD de la séquence : le sol y est
  // flou, le véhicule net. Par colonne, le bord le plus haut assez marqué (OUTLINE_EDGE fois le plus fort) entre OUTLINE_BAND
  // degrés au-dessus et au-dessous des contours relevés et OUTLINE_FLOOR (logo du CD21 sous le véhicule) : le haut du capot
  // plutôt que l'essuie-glace. Gardé par séquence dans ce navigateur (OUTLINES_KEY).
  // OUTLINE_FLOOR : au-dessus du haut du logo (-48,3°), dont le bord blanc sur la carrosserie noire écraserait les autres
  const OUTLINE_PHOTOS = 12, OUTLINE_BAND = 6, OUTLINE_EDGE = 0.45, OUTLINE_FLOOR = -47, OUTLINE_MARGIN = 1.5;
  const OUTLINES_KEY = "web-measures/dessus-contours-2";  // -2 : contours lus avant la fermeture finale abandonnés
  const CAR = { ahead: 0, long: 5.8, wide: 2.9 };  // m : ellipse au sol, hors CD21 (véhicule inconnu) : toit, capot et leurs reflets
  // Ombre et reflets du véhicule sur le sol, autour de lui (ellipse CAR) : une voisine y compte son erreur attendue SHADE fois,
  // pour combler le sol caché par le véhicule de la photo affichée (ville d946f2cf-cddc-4476-a414-35aee429c05a,
  // 09/11/2026 : taches sombres sinon)
  const SHADE = 3;
  const NEAR_LIMIT = 6144;  // px : largeur des photos voisines, qui ne servent que près de leur caméra (mémoire graphique)
  // m : zone idéale d'une largeur, en face de la caméra (essai du 08/11 : écart à l'orthophoto ≤ 1,5 % jusqu'à 4 m en long, 2 % au-delà)
  const BEST = { along: 4, wide: 8 };
  const MEASURED = 0.05;  // part de la longueur : incertitude affichée au moins égale à l'écart à l'orthophoto (voir docs/CALCULS.md)
  const HEIGHT_SIGMA = 0.05;  // m : hauteur de caméra lue sur le décalage entre photos voisines (essai de 28 paires)
  // m : hauteur par l'altitude RTK moins le sol, au moins : 12 cm d'écart avec le décalage entre photos sur le giratoire
  // b47b4351 (2,06 contre 1,94 m, stable sur 15 photos), alors que l'écart entre photos de la séquence n'est que de 2 cm
  const RTK_SIGMA = 0.1;
  // m : écart de la hauteur lue entre photos, ou de l'écart RTK − sol, à la hauteur retenue au-delà duquel l'étiquette alerte (heightLine).
  // Provisoire : environ 2 σ d'une photo (la hauteur lue entre photos disperse de 8 à 9 cm par photo, l'écart RTK − sol de 10 cm : études
  // du 27/11/2026, #59) ; à resserrer quand la dispersion d'une campagne sera mieux connue
  const HEIGHT_ALERT = 0.15;
  const GROUND_SIGMA = 1;  // degrés : inclinaison déduite de la route, sans verticales à lire (voir docs/CALCULS.md)
  // Sol supposé plat (pose.flat, décision du cœur : py/core/roads.py, BRIDGE_FLAT_RADIUS) : un pont BD TOPO à 15 m au plus de la
  // photo à vol d'oiseau (avant, sur ou après l'ouvrage), car le relief y donne le fond de la vallée, pas le tablier. Plan
  // horizontal à la hauteur de caméra (voir dropTerrain) ; l'inclinaison de la caméra s'applique comme ailleurs, et les mesures
  // de la vue du dessus s'y font. Photo marquée « sur un pont » (pose.bridge : tronçon BD TOPO en pont à 8 m au plus dans le
  // sens de la séquence) : en plus, hauteur et inclinaison sans LiDAR. Tablier supposé plan et horizontal
  // à la place du terrain LiDAR (voir dropTerrain) : la pente du tablier (jusqu'à 3 %, 1,7°)
  // échappe à l'inclinaison par la route. Une photo non marquée (remblai qui mène au tablier) garde le LiDAR, sauf sous l'emprise
  // de l'ouvrage (pose.deck, voir underDeck)
  const DECK_SIGMA = 1.5;  // degrés
  const LIDAR_SIGMA = 0.02, FLAT_SIGMA = 0.1;  // m : écart du sol au terrain utilisé (résidu LiDAR ; sol supposé plat)
  const GROUND_CORRELATION = 2;  // m : portée de la corrélation de cet écart entre deux points (gaussienne : terrain lissé sur 2 m)
  const ELEVATION_URL = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json";
  const LIDAR_RESOURCE = "ign_lidar_hd_mnt_mono_wld";
  const toRad = Math.PI / 180;
  const IMAGE_ID = "dessus-image", LINE_ID = "dessus-traits";

  /** Rotation (matrice par lignes) d'une direction vraie (est, nord, haut) vers celle vue par la caméra :
   * inverse de Calibration.correct (cap de la séquence, puis inclinaison, voir calibration.untilt). */
  function rotation(pose) {
    const o = pose.offset * toRad, co = Math.cos(o), so = Math.sin(o);
    const heading = [[co, -so, 0], [so, co, 0], [0, 0, 1]];
    const up = pose.up || [0, 0, 1], s = Math.hypot(up[0], up[1]);
    if (s < 1e-12) return heading;
    const kx = up[1] / s, ky = -up[0] / s, c = up[2], t = 1 - c;
    const tilt = [[c + t * kx * kx, t * kx * ky, -s * ky],
                  [t * kx * ky, c + t * ky * ky, s * kx],
                  [s * ky, -s * kx, c]];
    return tilt.map((row) => heading[0].map((_, j) => row[0] * heading[0][j] + row[1] * heading[1][j] + row[2] * heading[2][j]));
  }

  /** Direction brute (cap absolu, élévation, degrés) vue dans la photo d'une direction vraie. */
  function view(east, north, up, pose) {
    const m = rotation(pose), n = Math.hypot(east, north, up);
    const [x, y, z] = m.map((row) => (row[0] * east + row[1] * north + row[2] * up) / n);
    return [((Math.atan2(x, y) / toRad) % 360 + 360) % 360, Math.asin(z) / toRad];
  }

  /** Incertitude (m, un écart-type) de la distance au sol entre deux points (est, nord en m depuis la caméra) :
   * inclinaison sur ses deux axes, hauteur de caméra, écart du sol au terrain utilisé (sigmaGround, m). */
  function uncertainty(a, b, pose, sigmaGround) {
    const H = pose.height, length = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const d = pose.sigma * toRad, L = length(a, b);
    const moved = (p, nx, ny) => {  // point au sol vu après une petite rotation d'axe horizontal (nx, ny)
      const vx = p[0] + d * ny * -H, vy = p[1] - d * nx * -H, vz = -H + d * (nx * p[1] - ny * p[0]);
      return [vx * H / -vz, vy * H / -vz];
    };
    const east = length(moved(a, 1, 0), moved(b, 1, 0)) - L, north = length(moved(a, 0, 1), moved(b, 0, 1)) - L;
    const scale = L * pose.height_sigma / H;
    // écart du sol Δz : un point vu à p s'écarte de p Δz / H. Écarts des deux bouts corrélés à courte distance (terrain lissé
    // sur 2 m, GROUND_CORRELATION) : deux points proches bougent ensemble, la distance change de L Δz / H seulement (l'écart
    // compté indépendamment à chaque bout donnait 9 cm sur une bande de passage piéton de 0,50 m à 5 m, 13/11/2026)
    const u = L ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [0, 0], ua = u[0] * a[0] + u[1] * a[1], ub = u[0] * b[0] + u[1] * b[1];
    const rho = Math.exp(-0.5 * (L / GROUND_CORRELATION) ** 2);
    const ground = Math.sqrt(Math.max(0, ua * ua + ub * ub - 2 * rho * ua * ub)) * sigmaGround / H;
    return Math.hypot(east, north, scale, ground);
  }

  /** Place du point (est, nord, m depuis la caméra) dans l'ellipse du véhicule (CAR), dans l'axe de la photo : sous 1, il est
   * caché. */
  function inCar(east, north, pose) {
    const h = pose.heading * toRad, along = east * Math.sin(h) + north * Math.cos(h), across = east * Math.cos(h) - north * Math.sin(h);
    return ((along - CAR.ahead) / CAR.long) ** 2 + (across / CAR.wide) ** 2;
  }
  /** Élévation du contour du véhicule (OUTLINES) à la place u (0 à 1) dans la largeur du panorama. */
  function outlineAt(outline, u) {
    const x = u * outline.length, k = Math.floor(x) % outline.length;
    return outline[k] + (outline[(k + 1) % outline.length] - outline[k]) * (x - Math.floor(x));
  }
  /** Le point au sol (est, nord, m depuis la caméra) est-il caché par le véhicule ? Contour de la hauteur de caméra (pose.outline), sinon
   * ellipse. Même calcul dans le dessin (FRAGMENT). */
  function hidden(east, north, pose) {
    if (!pose.outline) return inCar(east, north, pose) < 1;
    const [azimuth, elevation] = view(east, north, -pose.height, pose);
    return elevation < outlineAt(pose.outline, (((azimuth - pose.heading) / 360 + 0.5) % 1 + 1) % 1);
  }

  /** Erreur attendue (m) d'un point au sol à la distance d, due à l'inclinaison : sous le véhicule de la photo affichée, c'est
   * la voisine où elle est la plus faible qui fournit le point. Même calcul dans le dessin (FRAGMENT). */
  const tiltError = (d, pose) => (pose.height * pose.height + d * d) / pose.height * pose.sigma * toRad;

  /** Couche qui fournit le point (est, nord, m depuis la caméra principale), comme render : la principale partout où son
   * véhicule ne cache pas le sol (sa photo n'est pas retouchée) ; dessous, la voisine de plus faible erreur attendue (tiltError,
   * SHADE fois près de son véhicule) qui le voit ; à défaut la principale ; null hors de la vue. layers[].at : position de sa caméra. */
  function sourceOf(point, layers, zone = zoneOn ? zoneRect(layers) : null) {
    if (Math.hypot(...point) > REACH || (zone && !inZone(point, zone))) return null;
    const [main, ...others] = layers;
    if (!others.length || !hidden(point[0], point[1], main.pose)) return main;
    let best = main, bestError = Infinity;
    for (const layer of others) {
      const e = point[0] - layer.at[0], n = point[1] - layer.at[1], d = Math.hypot(e, n);
      const error = tiltError(d, layer.pose) * (inCar(e, n, layer.pose) < 1 ? SHADE : 1);
      if (d <= REACH && !hidden(e, n, layer.pose) && error < bestError) [best, bestError] = [layer, error];
    }
    return best;
  }
  /** Rectangle gardé par « Limiter à la zone mesurable », centré sur la caméra de la photo principale (layers[0]) : { axis (axe de la
   * route, roadAxis), along, across } demi-longueur et demi-largeur en m. along : butée lointaine de la droite de « Largeur dans la
   * visionneuse » (pose.width_depth, py/web_nez.py _nose_range) plus MARGE_ZONE, devant comme derrière ; across : portée latérale de
   * la droite (pose.width_reach, NOSE_REACH) plus MARGE_ZONE. null si la pose ne les donne pas. */
  function zoneRect(layers) {
    const { width_depth: along, width_reach: across } = layers[0].pose;
    return along > 0 && across > 0 ? { axis: roadAxis(layers), along: along + MARGE_ZONE, across: across + MARGE_ZONE } : null;
  }
  /** Le point (est, nord, m depuis la caméra principale) est-il dans le rectangle zone ? Même coupure dans le dessin (FRAGMENT, uniform zone). */
  const inZone = (point, zone) => Math.abs(point[0] * zone.axis[0] + point[1] * zone.axis[1]) <= zone.along
    && Math.abs(point[0] * zone.axis[1] - point[1] * zone.axis[0]) <= zone.across;

  /** Axe de la route (vecteur unitaire est, nord) : la trajectoire entre les photos voisines, à défaut le cap de la photo,
   * qui peut s'en écarter de quelques degrés (caméra montée de biais). */
  function roadAxis(layers) {
    const near = layers.slice(1).map((l) => l.at);
    const [e, n] = near.length > 1 ? [near[1][0] - near[0][0], near[1][1] - near[0][1]] : near[0] || [0, 0];
    const length = Math.hypot(e, n), h = layers[0].pose.heading * toRad;
    return length >= 1 ? [e / length, n / length] : [Math.sin(h), Math.cos(h)];
  }

  /** Incertitude d'une distance entre deux points : même photo (uncertainty, les erreurs d'inclinaison se compensent en
   * partie), sinon celle de chaque point dans sa photo et la position relative des deux photos. */
  function measureError(a, b, layers, sigmaGround) {
    const la = sourceOf(a, layers), lb = sourceOf(b, layers);
    const local = (p, l) => [p[0] - l.at[0], p[1] - l.at[1]];
    if (la === lb) return uncertainty(local(a, la), local(b, la), la.pose, sigmaGround);
    const single = (p, { pose }) => {
      const H = pose.height, d = Math.hypot(...p);
      return Math.hypot((H * H + d * d) / H * pose.sigma * toRad, d * pose.height_sigma / H, d * sigmaGround / H);
    };
    // position relative des deux photos : au moins l'écart mesuré à leurs raccords (recalé, sinon d'origine)
    const seam = (l) => (l.seam ? (l.seam.fix ? l.seam.after : l.seam.before) : 0);
    return Math.hypot(single(local(a, la), la), single(local(b, lb), lb), Math.max(la.pose.relative_sigma, Math.hypot(seam(la), seam(lb))));
  }

  /** Incertitude affichée pour une longueur entre a et b : measureError, sans descendre sous l'écart mesuré (MEASURED).
   * (Les 3,5 % comptés en travers jusqu'au 13/11/2026 venaient du roulis de la caméra, désormais corrigé : défaut de roulis du profil de campagne.) */
  const shownError = (a, b, layers, sigmaGround) =>
    Math.max(measureError(a, b, layers, sigmaGround), MEASURED * Math.hypot(b[0] - a[0], b[1] - a[1]));

  /** Mètres par degré vers l'est et vers le nord à la latitude lat, sur l'ellipsoïde WGS 84 (rayon du parallèle, rayon de
   * courbure du méridien ; voir triangulation._radii). Une sphère de 6 371 km étirait la vue de 0,3 % en est-ouest sur la carte. */
  function radii(lat) {
    const w = 1 - WGS84_E2 * Math.sin(lat * toRad) ** 2;
    return [WGS84_A / Math.sqrt(w) * Math.cos(lat * toRad) * toRad, WGS84_A * (1 - WGS84_E2) / (w * Math.sqrt(w)) * toRad];
  }
  const toLocal = (lon, lat, pose) => { const [e, n] = radii(pose.lat); return [e * (lon - pose.lon), n * (lat - pose.lat)]; };
  const toLonLat = (east, north, pose) => { const [e, n] = radii(pose.lat); return [pose.lon + east / e, pose.lat + north / n]; };

  /** Côté (points) d'un maillage de terrain carré (readTerrain : ±REACH m, ou davantage). */
  const meshSide = (terrain) => Math.round(Math.sqrt(terrain.length));
  /** Altitude du terrain (voir readTerrain) à (est, nord, m depuis le centre du maillage), depuis le sol au centre. */
  function terrainAt(terrain, east, north) {
    const n = meshSide(terrain), R = (n - 1) * STEP / 2;
    const x = Math.min(n - 1.001, Math.max(0, (east + R) / STEP)), y = Math.min(n - 1.001, Math.max(0, (north + R) / STEP));
    const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, z = (a, b) => terrain[b * n + a] - terrain[(n * n - 1) / 2];
    return (z(i, j) * (1 - u) + z(i + 1, j) * u) * (1 - v) + (z(i, j + 1) * (1 - u) + z(i + 1, j + 1) * u) * v;
  }

  /** Pentes du plan de la route sous une caméra, ajusté sur ±2,5 m en long et ±1,5 m en travers : [montée devant, montée vers la droite],
   * en pente (tangente, m/m). Une route qui monte vers la droite penche le véhicule à gauche (roulis négatif, voir groundUp). */
  function groundSlopes(terrain, at, heading) {
    const h = heading * toRad, hu = [Math.sin(h), Math.cos(h)];
    let along = 0, side = 0, aa = 0, ss = 0;
    for (let a = -2.5; a <= 2.5; a += 0.5) {
      for (let s = -1.5; s <= 1.5; s += 0.5) {
        const z = terrainAt(terrain, at[0] + a * hu[0] + s * hu[1], at[1] + a * hu[1] - s * hu[0]);
        along += a * z; side += s * z; aa += a * a; ss += s * s;
      }
    }
    return [along / aa, side / ss];
  }

  /** Inclinaison d'une caméra sans verticales à lire, le véhicule étant posé sur la route : verticale vraie vue depuis la caméra
   * (voir rotation), la route sous le véhicule étant un plan ajusté sur ±2,5 m en long et ±1,5 m en travers (groundSlopes). La
   * route monte devant : la caméra regarde vers le haut et voit la verticale penchée vers l'avant. at : position de la caméra
   * (est, nord, m), heading : cap (degrés), rollShare : part du dévers prise en roulis (rollShareOf ; le tangage suit la pente
   * entière, voir docs/CALCULS.md), pitch : tangage ajouté (degrés, positif : caméra relevée vers l'avant), défaut de fixation de
   * la caméra ; roll : roulis ajouté (degrés ; convention du véhicule, en tête de ce fichier : positif = penché à droite), défaut
   * de la caméra par rapport à la route, propre au producteur et à la campagne (pose.roll_defect, profil de campagne, CAMPAIGN_PROFILES dans
   * py/web_pose.py), plus le réglage à la main (rollOffset). Le véhicule posé sur une route qui monte vers la droite est penché à
   * gauche : son roulis dû au dévers est négatif. */
  function groundUp(terrain, at, heading, rollShare = 1, pitch = 0, roll = 0) {
    const h = heading * toRad, hu = [Math.sin(h), Math.cos(h)];
    const [slope, cross] = groundSlopes(terrain, at, heading);
    // tangente du roulis vers la droite : celui du défaut et du réglage, moins la part du dévers (route qui monte à droite : penché à gauche)
    const ga = slope + Math.tan(pitch * toRad), gs = -(Math.tan(roll * toRad) - rollShare * cross);  // gs : montée vers la droite de la verticale vraie
    const east = ga * hu[0] + gs * hu[1], north = ga * hu[1] - gs * hu[0], length = Math.hypot(east, north, 1);
    return [east / length, north / length, 1 / length];
  }

  // Véhicule penché en virage : environ LEAN degrés par m/s² d'accélération latérale (5° par g), que l'inclinaison tirée de
  // la route ignore ; ajouté à son incertitude, sans corriger la vue (giratoire b47b4351, 4,4 m/s² : bord à 8 m décalé de
  // 1,3 m avec la route, juste avec les verticales qui voient 2° de plus). Courbure et vitesse : photos précédente et suivante.
  const LEAN = 0.5;
  /** Accélération latérale (m/s², valeur absolue) au passage de la photo, ou 0 (trajectoire inconnue, arrêt). */
  async function lateralOf(photo, pose, signal) {
    const links = (photo.links || []).filter((l) => l.rel === "prev" || l.rel === "next");
    if (links.length < 2) return 0;
    const items = await Promise.all(links.map((l) => fetch(l.href, { signal }).then((r) => (r.ok ? r.json() : null))));
    const points = [photo, ...items].filter((item) => item?.geometry && item.properties?.datetime)
      .map((item) => ({ at: toLocal(...item.geometry.coordinates.slice(0, 2), pose), t: Date.parse(item.properties.datetime) / 1000 }))
      .sort((p, q) => p.t - q.t);
    if (points.length < 3) return 0;
    const [a, b, c] = points, ab = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]), bc = Math.hypot(c.at[0] - b.at[0], c.at[1] - b.at[1]);
    const ac = Math.hypot(c.at[0] - a.at[0], c.at[1] - a.at[1]), dt = c.t - a.t;
    if (ab < 1 || bc < 1 || ab > 15 || bc > 15 || dt <= 0) return 0;
    const curvature = 2 * Math.abs((b.at[0] - a.at[0]) * (c.at[1] - b.at[1]) - (b.at[1] - a.at[1]) * (c.at[0] - b.at[0])) / (ab * bc * ac);
    return ((ab + bc) / dt) ** 2 * curvature;
  }

  /** Altitude de la route sous une caméra (depuis le sol au centre du maillage) : moyenne du terrain sur ±2,5 m en long et
   * ±1,5 m en travers, la valeur au centre du plan de groundUp. Moins bruitée qu'un seul point du maillage : 2 à 3 cm de trop
   * sous une photo changent son échelle d'environ 1 %, de quoi décaler les lignes aux raccords. */
  function groundLevel(terrain, at, heading) {
    const h = heading * toRad, hu = [Math.sin(h), Math.cos(h)];
    let sum = 0, n = 0;
    for (let a = -2.5; a <= 2.5; a += 0.5) {
      for (let s = -1.5; s <= 1.5; s += 0.5) {
        sum += terrainAt(terrain, at[0] + a * hu[0] + s * hu[1], at[1] + a * hu[1] - s * hu[0]);
        n++;
      }
    }
    return sum / n;
  }

  /** Altitudes brutes LiDAR HD d'une grille carrée de ±reach m (lignes du sud au nord, colonnes d'ouest en est, maille STEP)
   * autour de la photo : en une seule requête POST (2 601 points pour ±25 m : 1 à 2 s, contre 18 requêtes GET de 150 points,
   * une à la fois, que le quota de 5 requêtes/s du service faisait attendre 20 à 30 s) ; si le POST échoue, en GET par blocs de
   * ALTI_CHUNK points (la file de app.js espace les requêtes). Mêmes points, mêmes altitudes dans les deux cas. */
  async function fetchGrid(pose, reach) {
    const n = 2 * reach / STEP + 1, points = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) points.push(toLonLat(-reach + i * STEP, -reach + j * STEP, pose));
    }
    const lon = (list) => list.map((p) => p[0].toFixed(7)).join("|"), lat = (list) => list.map((p) => p[1].toFixed(7)).join("|");
    try {
      const response = await fetch(ELEVATION_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lon: lon(points), lat: lat(points), resource: LIDAR_RESOURCE, zonly: "true" }),  // « true » en chaîne : un booléen donne 400
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const z = (await response.json()).elevations.map(Number);
      if (z.length === points.length) return z;
      throw new Error("réponse incomplète");
    } catch (error) {
      console.warn("Altitudes en une requête impossibles, lues par blocs :", error);
    }
    const z = [];
    for (let k = 0; k < points.length; k += ALTI_CHUNK) {
      const chunk = points.slice(k, k + ALTI_CHUNK);
      const response = await fetch(`${ELEVATION_URL}?lon=${lon(chunk)}&lat=${lat(chunk)}&resource=${LIDAR_RESOURCE}&zonly=true`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      z.push(...(await response.json()).elevations.map(Number));
    }
    return z;
  }
  // Grilles brutes déjà lues (promesses), par position et portée : la même lecture sert la vue (±REACH), le tangage sur les
  // lignes (±LINES_WIDE, qui contient la vue : même maille, même centre) et l'activation de « Largeur dans la visionneuse »
  // (prefetch). Indépendante de l'annulation d'une vue : une lecture lancée n'est pas perdue. Huit au plus.
  const grids = new Map();
  function readGrid(pose, reach) {
    const key = `${pose.lon.toFixed(7)},${pose.lat.toFixed(7)},${reach}`;
    if (!grids.has(key)) {
      if (grids.size >= 8) grids.delete(grids.keys().next().value);
      const promise = fetchGrid(pose, reach);
      promise.catch(() => grids.delete(key));  // échec : relu au prochain appel
      grids.set(key, promise);
    }
    return grids.get(key);
  }

  // Photo non marquée « sur un pont » (remblai, approche) près d'un ouvrage : le MNT LiDAR HD sous l'emprise du tablier (pose.deck,
  // axes du tronçon en pont en mètres autour de la photo, demi-largeur pose.deck_half, voir py/web_pose.py) décrit le sol sous
  // l'ouvrage, pas la route : ces points sont écartés et remplacés par un tablier HORIZONTAL à l'altitude du terrain LiDAR à la
  // culée (bord de l'emprise, le long de l'axe, côté photo) : le remblai garde sa pente, le tablier est un palier (le plan ajusté
  // sur le remblai, prolongé sur le tablier, le relevait de 3 à 4° : vue très déformée, 7dcdccf9-3c52-4c54-bc5b-de72740a7967).
  // Si moins de DECK_KEEP des points restent, le terrain est indisponible (null) plutôt que faux.
  const DECK_KEEP = 0.6;
  /** Indice de l'axe sous l'emprise duquel est le point (x, y) (axes lines, demi-largeur half), -1 sinon : entre les extrémités du
   * tronçon seulement. */
  function inDeck(lines, x, y, half) {
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      for (let k = 1; k < line.length; k++) {
        const [ax, ay] = line[k - 1], [bx, by] = line[k], length2 = (bx - ax) ** 2 + (by - ay) ** 2;
        if (length2 === 0) continue;
        const t = ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length2;
        if (t >= 0 && t <= 1 && Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) <= half) return n;
      }
    }
    return -1;
  }
  /** Pour chaque point du maillage de côté m (±reach m autour de la photo) : indice de l'axe de pont dont il est sous l'emprise,
   * -1 sinon ; null s'il n'y en a aucun. */
  function underDeck(pose, m, reach) {
    if (!pose.deck?.length) return null;
    const out = [];
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) out.push(inDeck(pose.deck, -reach + i * STEP, -reach + j * STEP, pose.deck_half));
    return out.some((n) => n >= 0) ? out : null;
  }
  /** Altitude du terrain (maillage z de côté m, hors emprise) à la culée de l'axe line : extrémité la plus proche de la photo,
   * lue sur l'axe prolongé de 1 à 3 m vers le remblai ; à défaut, les 3 points hors emprise les plus proches de cette extrémité
   * (ou de l'entrée de l'axe dans la zone lue s'il la dépasse). null si rien de valide. */
  function abutmentLevel(z, under, m, reach, line) {
    const first = Math.hypot(...line[0]) <= Math.hypot(...line[line.length - 1]);
    const pts = first ? line : [...line].reverse();
    const [ex, ey] = pts[0], [nx, ny] = pts[1] || pts[0], len = Math.hypot(ex - nx, ey - ny) || 1;
    const at = (x, y) => {  // point hors emprise et valide du maillage le plus proche de (x, y), à moins de 0,7 maille
      const i = Math.round((x + reach) / STEP), j = Math.round((y + reach) / STEP);
      if (i < 0 || j < 0 || i >= m || j >= m) return null;
      const k = j * m + i;
      return under[k] < 0 && z[k] > -1000 ? z[k] : null;
    };
    const along = [1, 2, 3].map((d) => at(ex + (ex - nx) / len * d, ey + (ey - ny) / len * d)).filter((v) => v !== null);
    if (along.length) return along.reduce((a, v) => a + v, 0) / along.length;
    let [qx, qy] = [ex, ey];
    for (const [x, y] of pts) if (Math.abs(x) <= reach && Math.abs(y) <= reach) { [qx, qy] = [x, y]; break; }
    const near = [];
    z.forEach((v, k) => { if (under[k] < 0 && v > -1000) near.push([Math.hypot(-reach + (k % m) * STEP - qx, -reach + Math.floor(k / m) * STEP - qy), v]); });
    near.sort((a, b) => a[0] - b[0]);
    return near.length ? near.slice(0, 3).reduce((a, [, v]) => a + v, 0) / Math.min(3, near.length) : null;
  }
  /** Remplace les points sous l'emprise par le palier horizontal à l'altitude de la culée de leur axe ; faux s'il en reste trop
   * peu hors emprise (DECK_KEEP) ou si une culée n'a pas d'altitude. */
  function fillUnderDeck(z, under, m, reach, lines) {
    if (under.filter((n) => n < 0).length < DECK_KEEP * z.length) return false;
    const levels = lines.map((line) => abutmentLevel(z, under, m, reach, line));
    if (under.some((n) => n >= 0 && levels[n] === null)) return false;
    under.forEach((n, k) => { if (n >= 0) z[k] = levels[n]; });
    return true;
  }

  /** Altitudes LiDAR HD du maillage (lignes du sud au nord, colonnes d'ouest en est), lissées, ou null s'il en manque une ;
   * exception si le service ne répond pas. across : portée du lissage en travers (voir smoothTerrain). Extraites de la grille
   * de ±LINES_WIDE m (readGrid), une seule lecture pour toutes les portées. */
  async function readTerrain(pose, signal, reach = REACH, across = TERRAIN_SMOOTH_ACROSS) {
    const big = Math.max(reach, LINES_WIDE), all = await readGrid(pose, big);
    if (signal?.aborted) throw signal.reason ?? new DOMException("Annulé", "AbortError");
    const n = 2 * big / STEP + 1, m = 2 * reach / STEP + 1, off = (big - reach) / STEP, z = [];
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) z.push(all[(j + off) * n + i + off]);
    const under = underDeck(pose, m, reach);
    if (!z.every((v, k) => v > -1000 || under?.[k] >= 0)) return null;
    if (under && !fillUnderDeck(z, under, m, reach, pose.deck)) return null;
    const mesh = smoothTerrain(z, pose.heading, across);
    mesh.level = smoothTerrain(z, pose.heading, TERRAIN_SMOOTH);  // pour la route sous le véhicule (voir levelOf)
    return mesh;
  }
  // Diagnostic du relief LiDAR HD (ticket #67), sans effet sur la projection ni sur les incertitudes : lu sur la grille brute,
  // avant lissage, dans la zone utile (la chaussée devant la caméra : RELIEF_ALONG m en long dans le sens du cap, ± RELIEF_ACROSS m
  // en travers). « Écart au plan » : résidus d'un plan ajusté sur cette zone, pas une précision du MNT. Seuils provisoires, à caler.
  const RELIEF_ALONG = 12, RELIEF_ACROSS = 3;  // m : zone utile
  const RELIEF_MIN_VALID = 0.9;  // part des points de la grille reçus (grille partielle en deçà) ; provisoire, à caler
  const RELIEF_MAX_RMS = 0.10;  // m : écart quadratique au plan (relief irrégulier au-delà) ; provisoire, à caler
  const RELIEF_MAX_SLOPE = 8;  // % : pente du plan (pente forte au-delà) ; provisoire, à caler
  const RELIEF_MAX_BREAK = 2;  // degrés : écart entre les pentes de la moitié proche et de la moitié lointaine (rupture au-delà) ; provisoire, à caler
  /** Diagnostic d'un maillage brut z (côté m, maille STEP, centre sur la caméra, cap heading en degrés, -1000 et moins : point
   * sans altitude ; under : points sous l'emprise d'un pont, écartés, voir underDeck) : { valid (part reçue), rms, median (m,
   * écart au plan de la zone utile), slope (%), rupture (degrés), reasons (liste de textes, vide si rien d'anormal) }. */
  function diagnoseRelief(z, m, heading, under = null) {
    const h = heading * toRad, f = [Math.sin(h), Math.cos(h)], c = (m - 1) / 2;
    let asked = 0, got = 0;
    const zone = [[], []];  // moitié proche, moitié lointaine : [x, y, z] avec x en travers, y en long (m)
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const k = j * m + i;
        if (under && under[k] >= 0) continue;
        asked++;
        if (!(z[k] > -1000)) continue;
        got++;
        const e = (i - c) * STEP, n = (j - c) * STEP, along = e * f[0] + n * f[1], across = e * f[1] - n * f[0];
        if (along >= 0 && along <= RELIEF_ALONG && Math.abs(across) <= RELIEF_ACROSS) zone[along < RELIEF_ALONG / 2 ? 0 : 1].push([across, along, z[k]]);
      }
    }
    const out = { valid: asked ? got / asked : 0, rms: null, median: null, slope: null, rupture: null, reasons: [] };
    const fit = (points) => (points.length >= 6 ? leastSquares(points.map(([x, y]) => [1, x, y]), points.map((p) => p[2])) : null);
    const all = [...zone[0], ...zone[1]], plane = fit(all);
    if (plane) {
      const res = all.map(([x, y, v]) => v - plane[0] - plane[1] * x - plane[2] * y);
      out.rms = Math.sqrt(res.reduce((t, r) => t + r * r, 0) / res.length);
      out.median = median(res.map(Math.abs));
      out.slope = 100 * Math.hypot(plane[1], plane[2]);
      const near = fit(zone[0]), far = fit(zone[1]);
      if (near && far) out.rupture = Math.abs(Math.atan(far[2]) - Math.atan(near[2])) / toRad;
    }
    const pct = (v) => number(100 * v, 0);
    if (out.valid < RELIEF_MIN_VALID) out.reasons.push(`grille partielle (${pct(out.valid)} %)`);
    if (out.rms > RELIEF_MAX_RMS) out.reasons.push(`relief irrégulier (${number(100 * out.rms, 0)} cm)`);
    if (out.slope > RELIEF_MAX_SLOPE) out.reasons.push(`pente forte (${number(out.slope, 0)} %)`);
    if (out.rupture > RELIEF_MAX_BREAK) out.reasons.push(`rupture de pente (${number(out.rupture, 1)}°)`);
    return out;
  }
  /** Diagnostic du relief LiDAR HD autour de la photo (grille brute en mémoire, voir readGrid) ; exception si le service ne répond pas. */
  async function readRelief(pose) {
    const big = Math.max(REACH, LINES_WIDE), all = await readGrid(pose, big);
    const n = 2 * big / STEP + 1, m = 2 * REACH / STEP + 1, off = (big - REACH) / STEP, z = [];
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) z.push(all[(j + off) * n + i + off]);
    return diagnoseRelief(z, m, pose.heading, underDeck(pose, m, REACH));
  }
  /** Ligne du diagnostic pour l'étiquette : { text, alert }, ou null. */
  function reliefLine(relief) {
    if (!relief) return null;
    if (relief.reasons.length) return { text: `Relief douteux : ${relief.reasons.join(", ")}`, alert: true };
    return { text: `Relief LiDAR HD : ${number(100 * relief.valid, 0)} % des points, écart au plan ${number(100 * relief.rms, 0)} cm`, alert: false };
  }

  /** Date AAAA-MM-JJ en JJ/MM/AAAA, décalée de `days` jours. */
  const frenchDate = (iso, days = 0) => {
    const d = new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000);
    return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
  };
  /** Ligne du profil de campagne appliqué (pose.profile, py/web_profils.py) : { text, title }, ou null sans profil. La fin du profil
   * est un jour exclu : la ligne donne la veille. */
  function profileLine(profile) {
    if (!profile) return null;
    return { text: `Profil : ${profile.label} (du ${frenchDate(profile.first)} au ${frenchDate(profile.end, -1)})`,
      title: `Méthode : ${profile.method}. Provenance : ${profile.provenance}.` };
  }

  /** Ligne des hauteurs de caméra côte à côte pour l'étiquette (#59) : { text, title, alert }. height : hauteur retenue (m) ; origin :
   * son origine (« Captur bleu », « calée pour la séquence »…) ; read : hauteur lue entre photos, ou null (absente, ou déjà celle
   * retenue) ; rtk : écart RTK − sol LiDAR de la photo (une borne), ou null (absent, ou déjà celui retenu). Chaque terme seulement s'il
   * est connu ; alerte quand read ou rtk s'écarte de la hauteur retenue de plus de HEIGHT_ALERT. */
  function heightLine(height, origin, read = null, rtk = null) {
    const parts = [`Hauteur : ${number(height, 2)} m (${origin})`];
    if (read !== null) parts.push(`lue entre photos ${number(read, 2)} m`);
    if (rtk !== null) parts.push(`écart RTK − sol ${number(rtk, 2)} m (borne)`);
    const far = [read, rtk].some((v) => v !== null && Math.abs(v - height) > HEIGHT_ALERT);
    if (far) parts.push(`écart de plus de ${number(100 * HEIGHT_ALERT, 0)} cm à la hauteur retenue`);
    return { text: parts.join(" ; "), alert: far,
      title: "La hauteur lue entre photos disperse de 8 à 9 cm d'une photo à l'autre, l'écart RTK − sol LiDAR de 10 cm ; ce dernier est une borne : "
        + "il surestime d'environ 5 cm la hauteur de caméra après le 24/06/2025 (étude du 27/11/2026)." };
  }

  /** Terrain de l'inclinaison et de la hauteur de la route sous une caméra (groundUp, groundLevel) : lissé aussi en travers.
   * Le bombement gardé y penchait le plan sous le véhicule (une moitié de chaussée) : roulis restant de -1,4 à 0,05° au lieu
   * de 0,08 à 0,9°, bandes de passage piéton à 0,513 m (essai-passages, calage par la route, 14/11/2026). */
  const levelOf = (terrain) => terrain.level || terrain;

  // Le MNT s'écarte d'une surface lisse de 1 à 3 cm d'un mètre à l'autre (5 cm au plus sous la chaussée de l'A38) : une bosse
  // Δz sous un point à d de la caméra le déplace de d Δz / H, soit 8 cm à 5 m, et les lignes ondulent. Lissé sur
  // TERRAIN_SMOOTH (gaussienne) le long de la route, la pente reste. Essai du 07/11/2026 (A38, f9f83571) : écart de la rive
  // à une courbe douce de 3,5 cm (13,7 au plus) à 0,4 cm (0,8 au plus). En travers, TERRAIN_SMOOTH_ACROSS seulement : le
  // bombement et les caniveaux (1 m de large, 15 à 19 cm de creux) se répètent d'un mètre à l'autre ; lissés sur 2 m, ils
  // laissaient le milieu de la chaussée 3 à 5 cm trop bas et les caniveaux 7 à 9 cm trop haut, et les bouts des bandes d'un
  // passage piéton à 5 m dérivaient de 30 cm (57c93b75-964f-4645-9a9f-5a9000d549ca, ville, 14/11/2026 : écart au LiDAR
  // brut 4,5 → 2,6 cm, écart
  // milieu-caniveau 11 → 2,5 cm). Tangage lu sur les lignes (learnLines, ±25 m) : lissage isotrope gardé, à 20 m le bruit du
  // MNT laissé en travers déplace les lignes de 10 cm par cm et la lecture échoue (A38, essai du 14/11/2026)
  const TERRAIN_SMOOTH = 2, TERRAIN_SMOOTH_ACROSS = 0.5;  // m
  /** Maillage lissé : plan moyen gardé tel quel, écarts au plan lissés (pas de biais au bord du maillage), gaussienne allongée
   * dans le sens du cap (degrés) : TERRAIN_SMOOTH le long, acrossSmooth en travers. */
  function smoothTerrain(z, heading, acrossSmooth = TERRAIN_SMOOTH_ACROSS) {
    const n = meshSide(z), xs = [], ys = [], h = heading * toRad, f = [Math.sin(h), Math.cos(h)];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { xs.push(i - (n - 1) / 2); ys.push(j - (n - 1) / 2); }
    const plane = leastSquares(xs.map((x, k) => [1, x, ys[k]]), z), at = (k) => plane[0] + plane[1] * xs[k] + plane[2] * ys[k];
    const r = Math.ceil(2.5 * TERRAIN_SMOOTH / STEP), kernel = [];
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const along = (di * f[0] + dj * f[1]) * STEP, across = (di * f[1] - dj * f[0]) * STEP;
        const w = Math.exp(-0.5 * ((along / TERRAIN_SMOOTH) ** 2 + (across / acrossSmooth) ** 2));
        if (w > 1e-4) kernel.push([di, dj, w]);
      }
    }
    const d = z.map((v, k) => v - at(k));
    return d.map((_, q) => {
      const i = q % n, j = Math.floor(q / n);
      let sum = 0, weight = 0;
      for (const [di, dj, w] of kernel) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < n && jj < n) { sum += d[jj * n + ii] * w; weight += w; }
      }
      return sum / weight + at(q);
    });
  }

  /** Moitié basse du panorama sur un canevas : { canvas, top (part du panorama au-dessus) }. tiles : voir Video.record. */
  async function loadPano(tiles, limit, signal) {
    const { cols, rows, template, image } = tiles, first = Math.floor(rows / 2);
    const jobs = [];
    for (let r = image ? 0 : first; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const url = image || template.replace("{TileCol}", c).replace("{TileRow}", r);
        jobs.push(Video.fetchImage(url, signal).then((bitmap) => ({ bitmap, c, r })));
      }
    }
    const parts = await Promise.all(jobs), { width, height } = parts[0].bitmap;
    const scale = Math.min(1, limit / (cols * width));
    const canvas = document.createElement("canvas");
    const top = image ? 0.5 : first / rows;  // image entière : sa moitié haute reste hors du canevas
    canvas.width = Math.round(cols * width * scale);
    canvas.height = Math.round(rows * height * (1 - top) * scale);
    const context = canvas.getContext("2d");
    for (const { bitmap, c, r } of parts) {
      context.drawImage(bitmap, c * width * scale, (r * height - top * rows * height) * scale, width * scale, height * scale);
      bitmap.close();
    }
    return { canvas, top };
  }

  /** Contour du véhicule (128 élévations, marge comprise, comme OUTLINES) lu sur les photos de la séquence de photo, ou null. */
  async function readOutline(photo, signal) {
    let items = [];
    for (const api of Services.sequenceApis(photo)) {
      try {
        const response = await fetch(`${api}/items?limit=500`, { signal });
        if (response.ok) { items = (await response.json()).features || []; break; }
      } catch (error) { if (signal.aborted) throw error; }
    }
    const urls = items.map((f) => f.assets?.sd?.href).filter(Boolean), step = urls.length / OUTLINE_PHOTOS;
    const picked = urls.length < OUTLINE_PHOTOS ? urls : [...Array(OUTLINE_PHOTOS)].map((_, i) => urls[Math.floor(i * step)]);
    const bitmaps = (await Promise.allSettled(picked.map((url) => Video.fetchImage(url, signal))))
      .filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (signal.aborted) throw new DOMException("Interrompu", "AbortError");
    const W = 1024, H = 512, canvas = new OffscreenCanvas(W, H), context = canvas.getContext("2d");
    let n = 0;
    for (const bitmap of bitmaps) {
      if (bitmap.width === 2 * bitmap.height) {  // panorama entier seulement
        context.globalAlpha = 1 / ++n;  // moyenne au fil des photos (dessin par la carte graphique)
        context.drawImage(bitmap, 0, 0, W, H);
      }
      bitmap.close();
    }
    if (n < OUTLINE_PHOTOS / 2) return null;
    const { data } = context.getImageData(0, 0, W, H), rowOf = (e) => -e * H / 180 - 0.5 + H / 2;
    const rows = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, r0 = Math.max(2, Math.floor(rowOf(outlineAt(EITHER, u) + OUTLINE_BAND)));
      const r1 = Math.min(H - 3, Math.floor(rowOf(Math.max(outlineAt(LOWEST, u) - OUTLINE_BAND, OUTLINE_FLOOR))));
      const grad = [];
      for (let y = r0; y < r1; y++) {  // bord horizontal : écart de couleur entre 2 lignes au-dessus et au-dessous
        const a = 4 * ((y - 2) * W + x), b = 4 * ((y + 2) * W + x);
        grad.push(Math.hypot(data[b] - data[a], data[b + 1] - data[a + 1], data[b + 2] - data[a + 2]));
      }
      const strong = OUTLINE_EDGE * Math.max(...grad);
      rows[x] = r0 + grad.findIndex((v) => v >= strong);
    }
    // Forme d'un véhicule : médiane sur 9 colonnes (bords isolés dans l'herbe) ; fermeture sur ±12 colonnes (4°) : une encoche
    // étroite, impossible sur une carrosserie, est comblée sans gonfler le reste (15/07/2025, 3e222d68 : triangles sombres) ;
    // symétrie gauche-droite : de chaque côté, le plus haut des deux
    const ring = (list, r, pick) => list.map((_, x) => pick(...[...Array(2 * r + 1)].map((__, d) => list[(x + d - r + W) % W])));
    const smooth = rows.map((_, x) => median([...Array(9)].map((__, d) => rows[(x + d - 4 + W) % W])));
    const closed = ring(ring(smooth, 12, Math.min), 12, Math.max);  // lignes : le plus petit est le plus haut
    const shape = closed.map((v, x) => Math.min(v, closed[W - 1 - x]));  // avant au milieu, arrière aux bords : x <-> W - 1 - x
    const outline = [...Array(128)].map((_, k) => {
      const top = Math.min(...[...Array(9)].map((__, d) => shape[(8 * k + d - 4 + W) % W]));
      // côtés : le bas des portières touche presque le logo, hors de la recherche ; 1° au-dessus de son bas au moins ; jamais
      // sous le plus bas des contours relevés (même Clio)
      return Math.round(Math.max(-(top + 0.5 - H / 2) * 180 / H + OUTLINE_MARGIN, OUTLINE_FLOOR + 1, LOWEST[k]) * 10) / 10;
    });
    // fermeture sur ±2 valeurs (±5,6°) : pas d'encoche d'une ou deux valeurs (rétroviseurs, 7e0cd23d), puis symétrie
    const close = (o, pick) => o.map((_, k) => pick(...[-2, -1, 0, 1, 2].map((d) => o[(k + d + 128) % 128])));
    const filled = close(close(outline, Math.max), Math.min);
    return filled.map((v, k) => Math.max(v, filled[(128 - k) % 128]));
  }

  const VERTEX = `#version 300 es
    in vec3 ground;
    out vec3 world;
    uniform float reach;
    void main() { world = ground; gl_Position = vec4(ground.xy / reach, 0.0, 1.0); }`;
  // Chaque photo est dessinée à son tour ; la profondeur (erreur attendue, voir tiltError) garde la plus précise
  const FRAGMENT = `#version 300 es
    precision highp float;
    in vec3 world;
    out vec4 color;
    uniform sampler2D pano;
    uniform mat3 turn;
    uniform vec3 camera;
    const vec2 frameCentre = vec2(0.0);
    uniform vec4 car;  // sin et cos du cap, centre et demi-longueur du véhicule ; demi-largeur à part
    uniform vec4 band;  // axe de la route (est, nord), demi-longueur et demi-largeur de la bande gardée
    uniform vec4 zone;  // « Limiter à la zone mesurable » : axe de la route (est, nord), demi-longueur et demi-largeur du rectangle gardé autour de la photo affichée (zone.z = 0 : sans limite, avec fondu)
    uniform float wide, masked, heading, top, reach, sure, height, sigma, shade;
    uniform float outline[128];  // contour du véhicule dans le panorama (OUTLINES), si hasOutline ; sinon ellipse (car, wide)
    uniform int hasOutline;
    uniform vec4 fix;  // recalage sur la principale (voir alignJoin) : décalage le long et en travers, tangage, lacet
    uniform vec2 fixMore;  // et échelle, roulis
    uniform sampler2D bend;  // écarts restants (est, nord, m) sur ±reach, si hasBend (voir bendField)
    uniform int hasBend;
    // 2 : photo seule sans son véhicule ni son grisé, opaque (voir renderBlended) ; 3 : numéro de la photo gagnante ; 4 : gris et
    // sol sûr pour les raccords (voir readRaster)
    uniform int stage;
    uniform float index, joinReach;
    const float PI = 3.14159265358979;
    void main() {
      vec2 rel = world.xy - camera.xy, f = car.xy, side = vec2(-car.y, car.x);  // repère de la photo : avant, gauche
      float u0 = dot(rel, f), v0 = dot(rel, side);
      vec2 moved = rel
        + (fix.x + fix.z * (height * height + u0 * u0) / height + fix.w * v0 + fixMore.x * u0 + fixMore.y * u0 * v0 / height) * f
        + (fix.y + fix.z * u0 * v0 / height - fix.w * u0 + fixMore.x * v0 + fixMore.y * (height * height + v0 * v0) / height) * side;
      if (hasBend == 1) moved += texture(bend, world.xy / (2.0 * reach) + 0.5).xy;
      vec3 ray = vec3(moved, world.z - camera.z);  // shortcut: altitude du point non déplacée (quelques cm de déplacement)
      float dist = length(ray.xy);
      if (dist > reach || length(world.xy - frameCentre) > reach) discard;  // une voisine ne déborde pas du cercle de la vue
      if (abs(dot(world.xy, band.xy)) > band.z || abs(world.x * band.y - world.y * band.x) > band.w) discard;
      if (zone.z > 0.0 && (abs(dot(world.xy, zone.xy)) > zone.z || abs(world.x * zone.y - world.y * zone.x) > zone.w)) discard;  // hors du rectangle : net, quelle que soit la photo
      vec3 v = normalize(turn * ray);
      float u = (atan(v.x, v.y) - heading) / (2.0 * PI) + 0.5;
      float along = (ray.x * car.x + ray.y * car.y - car.z) / car.w, across = (ray.x * car.y - ray.y * car.x) / wide;
      bool hidden, near = along * along + across * across < 1.0;  // sol caché par le véhicule (voir hidden) ; près de lui (CAR)
      if (hasOutline == 1) {
        float x = fract(u) * 128.0;
        int k = int(x) % 128;
        hidden = degrees(asin(clamp(v.z, -1.0, 1.0))) < mix(outline[k], outline[(k + 1) % 128], fract(x));
      } else {
        hidden = near;
      }
      // photo affichée (index 1) devant tout hors de son véhicule : elle n'est pas retouchée ; voisines sous ce véhicule
      // seulement, la plus précise (erreur attendue, voir sourceOf) ; sol caché partout : en dernier recours, pas de trou
      float error = (height * height + dist * dist) / height * sigma / 50.0 * (near ? shade : 1.0);
      gl_FragDepth = masked > 0.5 && hidden ? 0.99 : index < 1.5 ? 0.0 : 0.01 + 0.49 * min(error, 1.0);
      float a = fract(u), b = fract(u + 0.5) - 0.5;  // la coupure du panorama ne doit pas faire choisir un niveau flou
      float w = ((0.5 - asin(clamp(v.z, -1.0, 1.0)) / PI) - top) / (1.0 - top);
      vec3 c = texture(pano, vec2(fwidth(a) < fwidth(b) ? a : b, w)).rgb;
      // grisé au-delà de sure m de la photo affichée (centre de la vue) : une voisine plus précise peut fournir un point proche
      // d'elle mais à plus de sure m de sa propre caméra (14f7bc5a : taches transparentes à 7 m) ; photo seule : sa caméra
      float far = zone.z > 0.0 ? 0.0 : smoothstep(sure, reach, masked > 0.5 ? length(world.xy - frameCentre) : dist);  // rectangle net : ni grisé ni transparence
      color = vec4(mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), far), 1.0 - 0.5 * far);
      if (stage == 2) { if (hidden || far > 0.02) discard; color.a = 1.0; }
      if (stage == 3) color = vec4(index / 255.0, 0.0, 0.0, 1.0);
      if (stage == 4) color.a = !hidden && dist < joinReach ? 1.0 : 0.0;  // couleur gardée, alpha : sol sûr
    }`;

  let gl = null, program = null;
  function context() {
    if (gl) return gl;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL 2 indisponible");
    program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return gl;
  }

  /** Texture du panorama (le canevas intermédiaire est libéré) : { texture, top }. */
  function panoTexture({ canvas, top }) {
    const g = context(), texture = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, texture);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, canvas);
    g.generateMipmap(g.TEXTURE_2D);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.REPEAT);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    const anisotropy = g.getExtension("EXT_texture_filter_anisotropic");  // le sol lointain est très comprimé en long
    if (anisotropy) g.texParameterf(g.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, 16);
    canvas.width = canvas.height = 0;
    return { texture, top };
  }

  /** Dessine la vue : canevas de size px (SIZE par défaut), nord en haut, ±REACH m autour de la caméra de layers[0].
   * layers : [{ pano, pose }] (photo principale d'abord) ; terrain : altitudes du maillage (voir readTerrain), ou null pour
   * un plan horizontal ; frame : pose de la photo qui centre l'image et le maillage (par défaut, la principale) ; band : axe
   * de la route (vecteur unitaire est, nord) pour ne garder que la bande de la zone idéale (BEST), ou null ; zone : rectangle de
   * zoneRect pour ne garder que lui, net (sans grisé ni transparence), toutes photos confondues, ou null (image affichée seulement,
   * pas les rendus de calcul des raccords, qui gardent leur fondu et leurs zones communes). */
  function render(layers, terrain, frame = layers[0].pose, band = null, size = SIZE, stage = 0, into = null, reach = REACH, zone = null) {
    const g = context();
    if (!into && g.canvas.width !== size) g.canvas.width = g.canvas.height = size;
    g.bindFramebuffer(g.FRAMEBUFFER, into ? into.frame : null);  // into : cible (voir target), sinon le canevas
    // maillage du terrain, sinon plan
    const n = terrain ? meshSide(terrain) : 2 * reach / STEP + 1, R = (n - 1) * STEP / 2, base = terrain ? terrain[(n * n - 1) / 2] : 0;
    const vertices = new Float32Array(3 * n * n);
    for (let j = 0, k = 0; j < n; j++) {
      for (let i = 0; i < n; i++, k++) {
        vertices.set([-R + i * STEP, -R + j * STEP, terrain ? terrain[k] - base : 0], 3 * k);
      }
    }
    const indices = new Uint16Array(6 * (n - 1) * (n - 1));
    for (let j = 0, k = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++, k += 6) {
        const c = j * n + i;
        indices.set([c, c + 1, c + n, c + 1, c + n + 1, c + n], k);
      }
    }
    g.useProgram(program);
    g.viewport(0, 0, size, size);
    g.clearColor(0, 0, 0, 0);
    g.clearDepth(1);
    g.enable(g.DEPTH_TEST);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
    const vertexBuffer = g.createBuffer(), indexBuffer = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, vertexBuffer);
    g.bufferData(g.ARRAY_BUFFER, vertices, g.STATIC_DRAW);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, indexBuffer);
    g.bufferData(g.ELEMENT_ARRAY_BUFFER, indices, g.STATIC_DRAW);
    const place = g.getAttribLocation(program, "ground");
    g.enableVertexAttribArray(place);
    g.vertexAttribPointer(place, 3, g.FLOAT, false, 0, 0);
    const uniform = (name) => g.getUniformLocation(program, name), main = frame;
    g.uniform1f(uniform("reach"), reach);
    g.uniform1f(uniform("sure"), SURE);
    g.uniform1f(uniform("wide"), CAR.wide);
    g.uniform1f(uniform("shade"), SHADE);
    g.uniform1f(uniform("joinReach"), rasterReach);
    g.uniform1f(uniform("masked"), layers.length > 1 ? 1 : 0);  // photo seule : son véhicule plutôt qu'un trou
    g.uniform1i(uniform("stage"), stage);
    // band : axe de la route [est, nord], et demi-longueur, demi-largeur gardées (par défaut la zone idéale, BEST)
    g.uniform4f(uniform("band"), band ? band[0] : 0, band ? band[1] : 1, band ? band[2] ?? BEST.along : 1e6,
      band ? band[3] ?? BEST.wide : 1e6);
    g.uniform1i(uniform("bend"), 1);
    g.uniform4f(uniform("zone"), zone ? zone.axis[0] : 0, zone ? zone.axis[1] : 0, zone ? zone.along : 0, zone ? zone.across : 0);
    for (const [k, { pano, pose, fix, bend }] of layers.entries()) {
      g.uniform1i(uniform("hasBend"), bend ? 1 : 0);
      if (bend) {
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, bendTexture(bend));
        g.activeTexture(g.TEXTURE0);
      }
      g.uniform1f(uniform("index"), k + 1);
      const [tu, tv, pitch, yaw, scale, roll] = fix || [0, 0, 0, 0, 0, 0];
      g.uniform4f(uniform("fix"), tu, tv, pitch, yaw);
      g.uniform2f(uniform("fixMore"), scale, roll);
      const m = rotation(pose), [east, north] = toLocal(pose.lon, pose.lat, main), h = pose.heading * toRad;
      g.uniformMatrix3fv(uniform("turn"), false, [0, 1, 2].flatMap((c) => m.map((row) => row[c])));
      g.uniform3f(uniform("camera"), east, north, (terrain ? groundLevel(levelOf(terrain), [east, north], pose.heading) : 0) + pose.height);
      g.uniform4f(uniform("car"), Math.sin(h), Math.cos(h), CAR.ahead, CAR.long);
      g.uniform1i(uniform("hasOutline"), pose.outline ? 1 : 0);
      if (pose.outline) g.uniform1fv(uniform("outline"), pose.outline);
      g.uniform1f(uniform("height"), pose.height);
      g.uniform1f(uniform("sigma"), pose.sigma * toRad);
      g.uniform1f(uniform("heading"), pose.heading * toRad);
      g.uniform1f(uniform("top"), pano.top);
      g.bindTexture(g.TEXTURE_2D, pano.texture);
      g.drawElements(g.TRIANGLES, indices.length, g.UNSIGNED_SHORT, 0);
    }
    g.deleteBuffer(vertexBuffer);
    g.deleteBuffer(indexBuffer);
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    return g.canvas;
  }

  const bendTextures = new WeakMap();  // champ (bendField) -> texture, faite une fois
  function bendTexture(field) {
    if (!bendTextures.has(field)) {
      const g = context(), texture = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, texture);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA16F, BEND, BEND, 0, g.RGBA, g.FLOAT, field);  // filtrable : bilinéaire
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      bendTextures.set(field, texture);
    }
    return bendTextures.get(field);
  }

  /** Cible de dessin hors du canevas : texture RGBA de size px (avec ses niveaux réduits si levels), profondeur. */
  function target(size, levels = 1) {
    const g = context(), texture = g.createTexture(), frame = g.createFramebuffer(), depth = g.createRenderbuffer();
    g.bindTexture(g.TEXTURE_2D, texture);
    g.texStorage2D(g.TEXTURE_2D, levels, g.RGBA8, size, size);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);  // lue pixel à pixel (texelFetch)
    g.bindRenderbuffer(g.RENDERBUFFER, depth);
    g.renderbufferStorage(g.RENDERBUFFER, g.DEPTH_COMPONENT24, size, size);
    g.bindFramebuffer(g.FRAMEBUFFER, frame);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);
    g.framebufferRenderbuffer(g.FRAMEBUFFER, g.DEPTH_ATTACHMENT, g.RENDERBUFFER, depth);
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    const free = () => { g.deleteTexture(texture); g.deleteFramebuffer(frame); g.deleteRenderbuffer(depth); };
    return { texture, frame, free };
  }

  // Fondu des raccords : la luminosité lente d'une photo dépend de l'angle du soleil, le même sol paraît plus clair sur l'une que
  // sur l'autre. Les voisines, sous le véhicule de la photo affichée, prennent sa bande basse (LOW px, flou de LOW_SIGMA m) :
  // écart de teinte lu là où les deux voient le sol, étendu dessous (FILL_SIGMA m) ; détail fin gardé. La photo affichée n'est
  // pas retouchée.
  const LOW = 256, LOW_SIGMA = 1, FILL_SIGMA = 3;
  let faithful = null;
  /** Relecture des pixels fidèle : Firefox (resistFingerprinting) la remplace par du bruit, d'où des taches de couleur. */
  function readsBack() {
    if (faithful !== null) return faithful;
    const g = context(), px = new Uint8Array(4 * 16 * 16);
    g.clearColor(1 / 255, 120 / 255, 200 / 255, 1);
    g.clear(g.COLOR_BUFFER_BIT);
    g.readPixels(0, 0, 16, 16, g.RGBA, g.UNSIGNED_BYTE, px);
    faithful = px.every((v, k) => v === [1, 120, 200, 255][k % 4]);
    if (!faithful) console.warn("Vue du dessus : relecture des pixels faussée par le navigateur, raccords non fondus");
    return faithful;
  }

  // Mélange final (renderBlended) : image dessinée plus l'écart de teinte de la photo gagnante, si c'est une voisine
  const BLEND_VERTEX = `#version 300 es
    in vec2 corner;
    void main() { gl_Position = vec4(corner, 0.0, 1.0); }`;
  const BLEND = `#version 300 es
    precision highp float;
    out vec4 color;
    uniform sampler2D shown, winner, shift1, shift2;  // shift : écart de teinte de chaque voisine (LOW x LOW, 0-255)
    uniform float scale;  // px de l'image par case basse
    vec3 at(sampler2D grid, vec2 p) {  // bilinéaire entre les centres des cases basses
      vec2 f = clamp(p / scale - 0.5, 0.0, ${LOW - 1}.0), t = f - floor(f);
      ivec2 a = ivec2(floor(f)), b = min(a + 1, ivec2(${LOW - 1}));
      return mix(mix(texelFetch(grid, a, 0).rgb, texelFetch(grid, ivec2(b.x, a.y), 0).rgb, t.x),
                 mix(texelFetch(grid, ivec2(a.x, b.y), 0).rgb, texelFetch(grid, b, 0).rgb, t.x), t.y);
    }
    void main() {
      ivec2 p = ivec2(gl_FragCoord.xy);
      vec4 c = texelFetch(shown, p, 0);
      int l = int(texelFetch(winner, p, 0).r * 255.0 + 0.5);
      vec3 s = l == 2 ? at(shift1, gl_FragCoord.xy) : l == 3 ? at(shift2, gl_FragCoord.xy) : vec3(0.0);
      color = vec4(c.rgb + s / 255.0, c.a);
    }`;
  let blend = null;
  function blendProgram() {
    if (blend) return blend;
    const g = context();
    blend = g.createProgram();
    for (const [type, source] of [[g.VERTEX_SHADER, BLEND_VERTEX], [g.FRAGMENT_SHADER, BLEND]]) {
      const shader = g.createShader(type);
      g.shaderSource(shader, source);
      g.compileShader(shader);
      if (!g.getShaderParameter(shader, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(shader));
      g.attachShader(blend, shader);
    }
    g.linkProgram(blend);
    if (!g.getProgramParameter(blend, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(blend));
    return blend;
  }

  /** Comme render, raccords fondus : tout par la carte graphique, sauf les bandes basses (LOW x LOW), lues et floutées ici.
   * shortcut: deux voisines au plus (précédente et suivante), à étendre si la vue en prend davantage */
  function renderBlended(layers, terrain, frame = layers[0].pose, band = null, size = SIZE, zone = null) {
    if (layers.length < 2 || layers.length > 3 || !readsBack()) return render(layers, terrain, frame, band, size, 0, null, REACH, zone);
    const g = context(), level = Math.log2(size / LOW), k = size / LOW;
    const radius = (sigma) => Math.max(1, Math.round(sigma * LOW / (2 * REACH) / 1.7));  // 3 boîtes : σ ≈ 1,7 r
    const blur = (a, r) => { let b = a; for (let pass = 0; pass < 3; pass++) b = boxBlur(b, r, LOW); return b; };
    // Bande basse de chaque photo seule (hors de son véhicule) : moyenne des pixels vus, par les niveaux réduits de sa texture
    const read = g.createFramebuffer(), px = new Uint8Array(4 * LOW * LOW);
    const low = layers.map((layer) => {
      const alone = target(size, level + 1);
      render([layer], terrain, frame, band, size, 2, alone);
      g.bindTexture(g.TEXTURE_2D, alone.texture);
      g.generateMipmap(g.TEXTURE_2D);
      g.bindFramebuffer(g.FRAMEBUFFER, read);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, alone.texture, level);
      g.readPixels(0, 0, LOW, LOW, g.RGBA, g.UNSIGNED_BYTE, px);  // lignes du sud au nord
      alone.free();
      const seen = new Float32Array(LOW * LOW).map((_, q) => px[4 * q + 3] / 255);
      const m = blur(seen, radius(LOW_SIGMA));
      return [0, 1, 2].map((c) => blur(new Float32Array(LOW * LOW).map((_, q) => px[4 * q + c]), radius(LOW_SIGMA))
        .map((v, q) => (m[q] > 0.05 ? v / m[q] : NaN)));
    });
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.deleteFramebuffer(read);
    // Écart de chaque voisine à la photo affichée, étendu sous le véhicule (moyenne pondérée par les cases où il est lu)
    const shifts = low.slice(1).map((color) => {
      const grid = new Float32Array(4 * LOW * LOW);
      for (let c = 0; c < 3; c++) {
        const known = new Float32Array(LOW * LOW), sum = new Float32Array(LOW * LOW);
        for (let q = 0; q < known.length; q++) {
          const d = low[0][c][q] - color[c][q];
          if (!Number.isNaN(d)) { known[q] = 1; sum[q] = d; }
        }
        const w = blur(known, radius(FILL_SIGMA)), v = blur(sum, radius(FILL_SIGMA));
        for (let q = 0; q < known.length; q++) grid[4 * q + c] = w[q] > 1e-3 ? v[q] / w[q] : 0;
      }
      const texture = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, texture);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, LOW, LOW, 0, g.RGBA, g.FLOAT, grid);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
      return texture;
    });
    const winner = target(size), shown = target(size);
    render(layers, terrain, frame, band, size, 3, winner, REACH, zone);
    render(layers, terrain, frame, band, size, 0, shown, REACH, zone);
    // Mélange sur le canevas
    if (g.canvas.width !== size) g.canvas.width = g.canvas.height = size;
    const program = blendProgram(), corners = g.createBuffer(), place = g.getAttribLocation(program, "corner");
    g.useProgram(program);
    g.viewport(0, 0, size, size);
    g.disable(g.DEPTH_TEST);
    g.bindBuffer(g.ARRAY_BUFFER, corners);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    g.enableVertexAttribArray(place);
    g.vertexAttribPointer(place, 2, g.FLOAT, false, 0, 0);
    [shown.texture, winner.texture, ...shifts, shifts[0]].slice(0, 4).forEach((texture, unit) => {
      g.activeTexture(g.TEXTURE0 + unit);
      g.bindTexture(g.TEXTURE_2D, texture);
    });
    ["shown", "winner", "shift1", "shift2"].forEach((name, unit) => g.uniform1i(g.getUniformLocation(program, name), unit));
    g.uniform1f(g.getUniformLocation(program, "scale"), k);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    g.activeTexture(g.TEXTURE0);
    g.deleteBuffer(corners);
    winner.free();
    shown.free();
    shifts.forEach((texture) => g.deleteTexture(texture));
    return g.canvas;
  }

  // Hauteur de la caméra, lue sur le décalage entre photos voisines ------------------------
  // Avec une hauteur fausse dans un rapport k, le sol projeté depuis deux caméras distantes de b se décale de b(1 - k) : le
  // grain de la chaussée le montre, sans donnée extérieure. L'inclinaison commune aux deux photos s'y annule.
  const MIN_NCC = 0.2, MIN_HEIGHT = 1.5, MAX_HEIGHT = 2.6;  // corrélation exigée d'une mesure et hauteurs plausibles (m)
  const median = (list) => {
    if (!list.length) return undefined;
    const sorted = [...list].sort((a, b) => a - b), k = sorted.length >> 1;
    return sorted.length % 2 ? sorted[k] : (sorted[k - 1] + sorted[k]) / 2;
  };

  /** Flou en boîte (2r + 1 px de côté, bords prolongés), en deux passes à somme glissante (coût indépendant de r) : lignes,
   * puis colonnes, toutes les colonnes ensemble (une somme par colonne, lecture ligne par ligne). Mêmes opérations dans le
   * même ordre que la version à fermetures : résultat identique au bit près. out : tampon de sortie (à fournir, ne doit pas
   * être source), sinon un tableau neuf. */
  let blurMiddle = new Float32Array(0), blurSums = new Float64Array(0);
  function boxBlur(source, r, n = SIZE, out = new Float32Array(source.length)) {
    if (blurMiddle.length < source.length) blurMiddle = new Float32Array(source.length);
    if (blurSums.length < n) blurSums = new Float64Array(n);
    const middle = blurMiddle, sums = blurSums, width = 2 * r + 1, last = n - 1;
    for (let l = 0; l < n; l++) {  // lignes
      const base = l * n;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += source[base + (k < 0 ? 0 : k > last ? last : k)];
      for (let k = 0; k < n; k++) {
        middle[base + k] = sum / width;
        const hi = k + r + 1, lo = k - r;
        sum += source[base + (hi > last ? last : hi)] - source[base + (lo < 0 ? 0 : lo)];
      }
    }
    sums.fill(0, 0, n);  // colonnes
    for (let k = -r; k <= r; k++) {
      const row = (k < 0 ? 0 : k > last ? last : k) * n;
      for (let c = 0; c < n; c++) sums[c] += middle[row + c];
    }
    for (let k = 0; k < n; k++) {
      const hi = (k + r + 1 > last ? last : k + r + 1) * n, lo = (k - r < 0 ? 0 : k - r) * n, row = k * n;
      for (let c = 0; c < n; c++) {
        out[row + c] = sums[c] / width;
        sums[c] += middle[hi + c] - middle[lo + c];
      }
    }
    return out;
  }

  /** Passe-haut d'une image de gris (SIZE x SIZE) : gris moins trois flous de 8 px (presque une gaussienne). Tampons des
   * flous gardés d'un appel à l'autre ; seul le résultat est un tableau neuf. */
  let highA = new Float32Array(0), highB = new Float32Array(0);
  function highPass(gray) {
    if (highA.length < gray.length) { highA = new Float32Array(gray.length); highB = new Float32Array(gray.length); }
    boxBlur(gray, 8, SIZE, highA);
    boxBlur(highA, 8, SIZE, highB);
    boxBlur(highB, 8, SIZE, highA);
    const high = new Float32Array(gray.length);
    for (let k = 0; k < high.length; k++) high[k] = gray[k] - highA[k];
    return high;
  }

  /** Grain du sol vu par une photo seule, dans le repère de frame : détail fin (lignes du sud au nord) et pixels valides. */
  function readGrain(layer, terrain, frame, height) {
    const g = context().canvas.getContext("webgl2"), rgba = new Uint8Array(4 * SIZE * SIZE);
    render([{ pano: layer.pano, pose: { ...layer.pose, height } }], terrain, frame);
    g.readPixels(0, 0, SIZE, SIZE, g.RGBA, g.UNSIGNED_BYTE, rgba);
    const gray = new Float32Array(SIZE * SIZE), valid = new Uint8Array(SIZE * SIZE);
    for (let k = 0; k < gray.length; k++) {
      gray[k] = rgba[4 * k] + rgba[4 * k + 1] + rgba[4 * k + 2];
      valid[k] = rgba[4 * k + 3] > 50 ? 1 : 0;
    }
    const fine = boxBlur(gray, 1), wide = boxBlur(gray, 8);
    return { grain: fine.map((v, k) => v - wide[k]), valid };
  }

  /** Décalage (m, est et nord) du grain de b par rapport à a, cherché le long de u (±2 m, ±0,5 m en travers), sur les pixels
   * keep : { east, north, ncc }, ou null. */
  function parallax(a, b, keep, u) {
    const M = 2 * REACH / SIZE, reach = Math.round(2 / M), side = 2 * reach + 1, scores = new Float32Array(side * side).fill(NaN);
    let best = -Infinity, bx = 0, by = 0;
    for (let qy = -reach; qy <= reach; qy++) {
      for (let qx = -reach; qx <= reach; qx++) {
        if (Math.abs(qx * M * u[1] - qy * M * u[0]) > 0.5) continue;
        let ab = 0, aa = 0, bb = 0;
        for (const k of keep) {
          const i = k + qy * SIZE + qx;
          if (i < 0 || i >= b.valid.length || !b.valid[i]) continue;
          ab += a.grain[k] * b.grain[i];
          aa += a.grain[k] * a.grain[k];
          bb += b.grain[i] * b.grain[i];
        }
        const score = aa && bb ? ab / Math.sqrt(aa * bb) : 0;
        scores[(qy + reach) * side + qx + reach] = score;
        if (score > best) { best = score; bx = qx; by = qy; }
      }
    }
    if (best === -Infinity) return null;
    const at = (x, y) => scores[(y + reach) * side + x + reach];
    const fit = (l, c, r) => (Number.isNaN(l) || Number.isNaN(r) || l - 2 * c + r === 0 ? 0 : (l - r) / (2 * (l - 2 * c + r)));
    const inside = Math.abs(bx) < reach && Math.abs(by) < reach;
    const dx = inside ? fit(at(bx - 1, by), best, at(bx + 1, by)) : 0, dy = inside ? fit(at(bx, by - 1), best, at(bx, by + 1)) : 0;
    return { east: (bx + dx) * M, north: (by + dy) * M, ncc: best };
  }

  /** Hauteurs de caméra (m) lues entre la photo principale et ses voisines, ou null. Chaque mesure est refaite à la hauteur
   * trouvée (partir de trop loin dégrade la corrélation) et gardée si elle se stabilise. Il faut le terrain et l'inclinaison
   * de chaque photo. */
  function estimateHeight(main, others, terrain) {
    if (!terrain || !main.pose.up || main.pose.groundTilt) return null;
    const M = 2 * REACH / SIZE, values = [];
    for (const other of others) {
      if (!other.pose.up || other.pose.groundTilt) continue;
      const [dE, dN] = toLocal(other.pose.lon, other.pose.lat, main.pose), base = Math.hypot(dE, dN);
      if (base < 2 || base > 12) continue;
      const u = [dE / base, dN / base], keep = [];
      for (let j = 0; j < SIZE; j += 4) {
        for (let i = 0; i < SIZE; i += 4) {
          const e = (i + 0.5) * M - REACH, n = (j + 0.5) * M - REACH, al = e * u[0] + n * u[1] - base / 2;
          const ac = Math.abs(e * u[1] - n * u[0]);
          if (ac < 7 && Math.abs(al) < 9 && !hidden(e, n, main.pose) && !hidden(e - dE, n - dN, other.pose)) keep.push(j * SIZE + i);
        }
      }
      let height = main.pose.height, last = null, settled = false;
      for (let pass = 0; pass < 3; pass++) {
        const a = readGrain(main, terrain, main.pose, height), b = readGrain(other, terrain, main.pose, height);
        const seen = keep.filter((k) => a.valid[k]);
        last = parallax(a, b, seen, u);
        if (!last) break;
        const k = 1 - (last.east * u[0] + last.north * u[1]) / base, next = height / k;
        settled = Math.abs(next - height) < 0.02;
        height = next;
        if (settled || height < MIN_HEIGHT || height > MAX_HEIGHT) break;
      }
      if (settled && last.ncc >= MIN_NCC && height >= MIN_HEIGHT && height <= MAX_HEIGHT) values.push(height);
    }
    return values.length ? values : null;
  }

  // Calage sur l'orthophoto (essai) ----------------------------------------------------------------
  // Lignes de peinture repérées à la fois sur l'orthophoto et sur la vue d'une photo seule, dans le repère de la route : leur
  // direction relative donne le cap et le tangage (terme en distance à la caméra), leur position commune le décalage latéral.
  // Le roulis n'est pas calé : il se confond avec un écart de largeur (essai du 07/11/2026, docs/CALCULS.md).
  const ORTHO_URL = "https://data.geopf.fr/wms-r/wms", ORTHO_LAYER = "ORTHOIMAGERY.ORTHOPHOTOS";  // 20 cm, la plus récente
  const GRID = 0.05, ALONG = 12, SIDE = 8, CAR_GAP = 3.2, ROAD = 6;  // m : pas, demi-longueur et demi-largeur du repère, véhicule, chaussée

  /** Orthophoto autour de la pose : fonction (est, nord en m) -> gris (0-765), ou NaN hors image. */
  async function readOrtho(pose, signal) {
    const [w, s] = toLonLat(-REACH - 1, -REACH - 1, pose), [e, n] = toLonLat(REACH + 1, REACH + 1, pose), px = 640;
    const url = `${ORTHO_URL}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&FORMAT=image/jpeg&CRS=EPSG:4326&LAYERS=${ORTHO_LAYER}`
      + `&WIDTH=${px}&HEIGHT=${px}&BBOX=${s},${w},${n},${e}`;  // WMS 1.3.0 en EPSG:4326 : latitude d'abord
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`orthophoto : HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob()), canvas = new OffscreenCanvas(px, px), c = canvas.getContext("2d");
    c.drawImage(bitmap, 0, 0, px, px);
    const data = c.getImageData(0, 0, px, px).data, [x0, y0] = toLocal(w, s, pose), [x1, y1] = toLocal(e, n, pose);
    return (east, north) => {
      const x = (east - x0) / (x1 - x0) * px - 0.5, y = (y1 - north) / (y1 - y0) * px - 0.5;
      if (x < 0 || y < 0 || x >= px - 1 || y >= px - 1) return NaN;
      const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j;
      const g = (a, b) => data[4 * (b * px + a)] + data[4 * (b * px + a) + 1] + data[4 * (b * px + a) + 2];  // gris (R + V + B)
      return (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v;
    };
  }

  /** Vue d'une photo seule (réglages en cours), même convention que readOrtho. */
  function readView(layer, terrain, frame, reach = REACH, size = SIZE) {
    const g = context(), rgba = new Uint8Array(4 * size * size);
    render([layer], terrain, frame, null, size, 0, null, reach);
    g.readPixels(0, 0, size, size, g.RGBA, g.UNSIGNED_BYTE, rgba);  // lignes du sud au nord
    const M = 2 * reach / size;
    return (east, north) => {
      const x = (east + reach) / M - 0.5, y = (north + reach) / M - 0.5;
      if (x < 0 || y < 0 || x >= size - 1 || y >= size - 1) return NaN;
      const i = Math.round(x), j = Math.round(y), k = 4 * (j * size + i);
      return rgba[k + 3] > 100 ? rgba[k] + rgba[k + 1] + rgba[k + 2] : NaN;
    };
  }

  const percentile = (values, q) => {
    const v = values.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : NaN;
  };
  const smooth = (p, r) => p.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(p.length - 1, i + r); k++) if (!Number.isNaN(p[k])) { sum += p[k]; n++; }
    return n ? sum / n : NaN;
  });

  /** Image dans le repère de la route (cap theta, rad) : rangées le long (a), colonnes en travers (s, vers la droite), sans le
   * fond (moyenne glissante sur 0,6 m en travers). */
  function roadFrame(sample, theta, raw = false, along = ALONG) {  // raw : sans retirer le fond (bords de chaussée)
    const ua = [Math.sin(theta), Math.cos(theta)], us = [ua[1], -ua[0]], cols = Math.round(2 * SIDE / 0.02);
    const rows = Math.round(2 * along / GRID);
    const out = [];
    for (let r = 0; r < rows; r++) {
      const a = -along + (r + 0.5) * GRID, row = new Float32Array(cols);
      for (let c = 0; c < cols; c++) {
        const s = -SIDE + (c + 0.5) * 0.02;
        row[c] = sample(a * ua[0] + s * us[0], a * ua[1] + s * us[1]);
      }
      if (raw) { out.push(row); continue; }
      const base = smooth([...row], 15);
      out.push(row.map((v, c) => v - base[c]));
    }
    return out;
  }
  const sideOf = (c) => -SIDE + (c + 0.5) * 0.02, alongOf = (r) => -ALONG + (r + 0.5) * GRID;

  /** Cap de la route (rad) : l'orientation où le profil en travers de l'orthophoto est le plus contrasté (±12° du cap). */
  function roadHeading(ortho, heading) {
    let best = heading * toRad, top = -1;
    for (let d = -12; d <= 12; d += 0.25) {
      const theta = (heading + d) * toRad, ua = [Math.sin(theta), Math.cos(theta)], us = [ua[1], -ua[0]], profile = [];
      for (let s = -SIDE; s <= SIDE; s += 0.04) {
        const v = [];
        for (let a = -ALONG; a <= ALONG; a += 0.5) v.push(ortho(a * ua[0] + s * us[0], a * ua[1] + s * us[1]));
        profile.push(percentile(v, 0.5));
      }
      const base = smooth(profile, 15), d2 = profile.map((v, i) => v - base[i]).filter((v) => !Number.isNaN(v));
      const mean = d2.reduce((t, v) => t + v, 0) / d2.length, variance = d2.reduce((t, v) => t + (v - mean) ** 2, 0) / d2.length;
      if (variance > top) { top = variance; best = theta; }
    }
    return best;
  }

  /** Décalage en travers de la vue sur l'orthophoto (m, vue moins orthophoto, selon us), par corrélation des profils en
   * travers de la chaussée (ROAD de part et d'autre, hors véhicule) : { shift, us, score } ou null (corrélation sous 0,3).
   * Un appariement ligne à ligne se trompe dès que herbe et bordures donnent des pics. shortcut: recherche sur
   * ±1,2 m, moins qu'un écart entre lignes (2,5 m et plus) ; au-delà, le décalage trouvé serait celui d'une autre ligne. */
  function orthoShift(view, ortho, theta) {
    const seen = (a) => Math.abs(a) > CAR_GAP && Math.abs(a) < 11, cols = Math.round(2 * SIDE / 0.02);
    const profile = (frame) => {
      const rows = frame.filter((_, r) => seen(alongOf(r)));
      return smooth(Array.from({ length: cols }, (_, c) => percentile(rows.map((row) => row[c]), 0.9)), 2);
    };
    const pv = profile(roadFrame(view, theta)), po = profile(roadFrame(ortho, theta)), MAX = 60;
    const inside = (c) => Math.abs(sideOf(c)) <= ROAD;
    const score = (lag) => {  // corrélation normée de pv(s) et po(s - lag)
      const pairs = [];
      for (let c = Math.max(0, lag); c < Math.min(cols, cols + lag); c++) {
        if (inside(c) && !Number.isNaN(pv[c]) && !Number.isNaN(po[c - lag])) pairs.push([pv[c], po[c - lag]]);
      }
      if (pairs.length < 200) return -1;
      const ma = pairs.reduce((t, p) => t + p[0], 0) / pairs.length, mb = pairs.reduce((t, p) => t + p[1], 0) / pairs.length;
      const ab = pairs.reduce((t, p) => t + (p[0] - ma) * (p[1] - mb), 0);
      const aa = pairs.reduce((t, p) => t + (p[0] - ma) ** 2, 0), bb = pairs.reduce((t, p) => t + (p[1] - mb) ** 2, 0);
      return aa && bb ? ab / Math.sqrt(aa * bb) : -1;
    };
    const scores = Array.from({ length: 2 * MAX + 1 }, (_, k) => score(k - MAX)), best = scores.indexOf(Math.max(...scores));
    if (scores[best] < 0.3 || best === 0 || best === 2 * MAX) return null;  // au bord : le vrai maximum est plus loin
    const [a, b, c] = [scores[best - 1], scores[best], scores[best + 1]], dk = (a - c) / (2 * (a - 2 * b + c)) || 0;
    const ua = [Math.sin(theta), Math.cos(theta)];
    return { shift: (best - MAX + dk) * 0.02, us: [ua[1], -ua[0]], score: scores[best] };
  }

  // Tangage lu sur les lignes en long d'une photo seule ------------------------------------
  // Une erreur de tangage δ change l'échelle de la vue en travers selon la distance le long : 1 + a δ / H (a : le long, devant
  // positif). Deux lignes parallèles (rives, axe) s'y écartent devant et se resserrent derrière : la pente m de chaque ligne
  // (s = p + m a + c a², s en travers) vaut q + κ p, q commun (cap, courbe), κ = δ / H. Environ 7 % d'écartement à 8 m pour
  // 1° et 2 m de hauteur, contre 4,8 % par degré sur les raccords (learnPitch), et sans voisine. Le roulis change l'échelle
  // en travers sans la faire varier le long : il ne se confond pas avec le tangage.
  // m : tranche, portée, écart de suivi ; tranches par ligne au moins ; écart admis à l'ajustement (m)
  const LINE_BIN = 1, LINE_FAR = 10, LINE_GAP = 0.25, LINE_MIN = 3, LINE_FIT = 0.04;
  /** Lignes claires d'un profil en travers (passe-haut, pas de 2 cm) : { s (m en travers, centre de gravité du pic), w (largeur à
   * mi-hauteur, m) }. */
  function linePeaks(profile) {
    const top = percentile(profile, 0.98), out = [];
    if (!(top > 60)) return out;  // pas de marquage net
    const floor = Math.max(60, 0.4 * top);
    for (let c = 2; c < profile.length - 2; c++) {
      const v = profile[c];
      if (!(v > floor) || !(v >= profile[c - 1]) || !(v > profile[c + 1])) continue;
      let i = c, j = c;
      while (i > 0 && profile[i - 1] > v / 2) i--;
      while (j < profile.length - 1 && profile[j + 1] > v / 2) j++;
      // largeur à mi-hauteur, bords interpolés entre colonnes
      const left = i > 0 ? i - 1 + (v / 2 - profile[i - 1]) / (profile[i] - profile[i - 1]) : i;
      const right = j < profile.length - 1 ? j + (profile[j] - v / 2) / (profile[j] - profile[j + 1]) : j;
      const width = (right - left) * 0.02;
      if (width < 0.06 || width > 0.45) continue;  // ni grain ni zone claire (bande de passage, tache)
      let sum = 0, weight = 0;
      for (let k = i; k <= j; k++) { sum += profile[k] * k; weight += profile[k]; }
      out.push({ s: sideOf(sum / weight), w: width });
      c = j;
    }
    return out;
  }
  // Bords de chaussée (enrobé contre accotement, herbe, gravillons), sans peinture : marche de teinte du profil brut, médiane
  // de la tranche, pente sur ±EDGE_HALF ; flous, mais nombreux le long d'une route (demande de l'auteur, 13/11/2026)
  const EDGE_HALF = 5, EDGE_MIN = 40, EDGE_FIT = 0.06;  // colonnes de 2 cm ; marche minimale (somme RVB) ; écart admis (m)
  /** Bords (m en travers, signe de la marche) d'un profil brut, loin des lignes peintes (paint : leurs positions). */
  function lineEdges(profile, paint) {
    const n = profile.length, p = smooth(profile, 3);
    const g = p.map((_, c) => (c >= EDGE_HALF && c < n - EDGE_HALF ? p[c + EDGE_HALF] - p[c - EDGE_HALF] : NaN));
    const strength = g.map(Math.abs), top = percentile(strength, 0.99), floor = Math.max(EDGE_MIN, 0.5 * top), out = [];
    for (let c = EDGE_HALF + 1; c < n - EDGE_HALF - 1; c++) {
      const v = strength[c];
      if (!(v > floor) || !(v >= strength[c - 1]) || !(v > strength[c + 1])) continue;
      const d = (strength[c - 1] - strength[c + 1]) / (2 * (strength[c - 1] - 2 * v + strength[c + 1])) || 0, s = sideOf(c + d);
      if (!paint.some((x) => Math.abs(x.s - s) < 0.3)) out.push({ s, kind: Math.sign(g[c]) });
      c += EDGE_HALF;
    }
    return out.sort((x, y) => strength[Math.round((y.s + SIDE) / 0.02)] - strength[Math.round((x.s + SIDE) / 0.02)]).slice(0, 4);
  }
  /** Tangage à ajouter à celui de la vue (degrés), lu sur ses lignes en long (sample : readView, theta : cap de la route en
   * rad, height : hauteur de caméra) : { pitch, lines, spread (m entre les lignes extrêmes), rms (m) } ou null (moins de
   * deux lignes vues devant et derrière). */
  function linesPitch(sample, theta, height, far = LINE_FAR) {
    const along = Math.max(ALONG, far + 1), frame = roadFrame(sample, theta, false, along);
    const rawFrame = roadFrame(sample, theta, true, along);
    const per = Math.round(LINE_BIN / GRID), bins = [];
    for (let r0 = 0; r0 + per <= frame.length; r0 += per) {
      const a = -along + (r0 + per / 2) * GRID;
      if (Math.abs(a) - LINE_BIN / 2 < CAR_GAP || Math.abs(a) > far) continue;
      const rows = frame.slice(r0, r0 + per), cols = rows[0].length;
      const profile = smooth(Array.from({ length: cols }, (_, c) => percentile(rows.map((row) => row[c]), 0.75)), 1);
      const paint = linePeaks(profile), raws = rawFrame.slice(r0, r0 + per);
      const edges = lineEdges(Array.from({ length: cols }, (_, c) => percentile(raws.map((row) => row[c]), 0.5)), paint);
      bins.push({ a, peaks: [...paint.map(({ s, w }) => ({ s, w, kind: 0 })), ...edges] });
    }
    // suivi de chaque côté du véhicule, du plus près au plus loin (une ligne peut n'être vue que d'un côté)
    const follow = (side) => {
      const tracks = [];
      for (const { a, peaks } of side) {
        for (const { s, w, kind } of peaks) {  // kind : 0 ligne peinte, ±1 bord (sens de la marche) ; suivis chacun avec les siens
          const guess = (t) => { const [p0, p1] = t.slice(-2); return p1 ? p1.s + (p1.s - p0.s) / (p1.a - p0.a) * (a - p1.a) : p0.s; };
          const best = tracks.map((t) => ({ t, d: Math.abs(guess(t) - s) })).filter(({ t, d }) => t.kind === kind
            && d < LINE_GAP && t.at(-1).a !== a)
            .sort((x, y) => x.d - y.d)[0];
          if (best) best.t.push({ a, s, w }); else tracks.push(Object.assign([{ a, s, w }], { kind }));
        }
      }
      return tracks.filter((t) => t.length >= LINE_MIN);
    };
    let lines = [...follow(bins.filter((b) => b.a > 0)), ...follow(bins.filter((b) => b.a < 0).reverse())];
    // s_i(a) = p_i (1 + κ a) + q a + c a² : à κ donné, linéaire en p_i, q, c ; κ balayé (±3° pour 2 m), puis affiné
    const fit = (set, kappa) => {
      const n = set.length, X = [], y = [];
      set.forEach((t, i) => t.forEach(({ a, s }) => {
        const row = new Array(n + 2).fill(0);
        row[i] = 1 + kappa * a; row[n] = a; row[n + 1] = a * a;
        X.push(row); y.push(s);
      }));
      const x = leastSquares(X, y), res = X.map((row, k) => row.reduce((t, v, j) => t + v * x[j], 0) - y[k]);
      return { p: x.slice(0, n), sse: res.reduce((t, v) => t + v * v, 0), res, count: X.length };
    };
    const search = (set) => {
      let best = null;
      for (let kappa = -0.026; kappa <= 0.026; kappa += 0.0005) {
        const f = fit(set, kappa);
        if (!best || f.sse < best.sse) best = { ...f, kappa };
      }
      for (let kappa = best.kappa - 0.0005; kappa <= best.kappa + 0.0005; kappa += 0.00005) {
        const f = fit(set, kappa);
        if (f.sse < best.sse) best = { ...f, kappa };
      }
      return best;
    };
    let best = null;
    // lignes qui ne s'accordent pas (bord flou, ombre) écartées une à une : 4 au plus sur 10 m, 20 sur 25 m (A38 : 22 pistes)
    for (let pass = 0; pass < (far > LINE_FAR ? 20 : 4) && lines.length >= 2; pass++) {
      best = search(lines);
      let k = 0;
      const rms = lines.map((t) => Math.sqrt(t.reduce((sum) => sum + best.res[k++] ** 2, 0) / t.length));
      const ratio = rms.map((v, i) => v / (lines[i].kind ? EDGE_FIT : LINE_FIT)), worst = ratio.indexOf(Math.max(...ratio));
      if (ratio[worst] < 1) break;
      lines = lines.filter((_, i) => i !== worst);
      best = null;
    }
    if (!best || lines.length < 2) return null;
    const spread = Math.max(...best.p) - Math.min(...best.p);
    if (spread < 1.5) return null;  // lignes trop proches (ligne double) : κ mal déterminé
    return { pitch: -Math.atan(best.kappa * height) / toRad, lines: lines.length, edges: lines.filter((t) => t.kind).length,
      spread, rms: Math.sqrt(best.sse / best.count) };
  }

  // Raccords entre photos, recalés par corrélation --------------------------------------------
  // Une voisine qui ne s'accorde pas avec la principale fait une marche au raccord. Les deux photos sont dessinées seules ;
  // dans leur zone commune sûre (hors véhicule et reflets, à moins de 11 m de chaque caméra), des blocs de 1,4 m sont
  // cherchés de l'une à l'autre par corrélation (grain, marquages, plaques). Un bloc ne donne que les directions où le pic
  // est net : une ligne en long fixe le travers seulement. La pose relative de la voisine (décalage, tangage, roulis,
  // lacet, échelle) est ajustée hors du raccord, vérifiée au raccord. Essai du 07/11/2026 : écart médian au raccord de
  // 10,8 à 2,9 cm sur 38 raccords de route, de 17,6 à 3,9 cm sur 14 en ville (passages piétons), tous améliorés.
  const SEAM = 1.5;  // m : demi-zone du raccord, où l'ajustement est vérifié
  const BLOCK = 48, SEARCH = 40, BLOCK_STEP = 20;  // px (3 cm) : côté d'un bloc, recherche de part et d'autre, pas des blocs
  const JOIN_REACH = 11;  // m : au-delà, photo trop floue pour s'y fier
  // m : écart au raccord après recalage au-delà duquel il n'est pas appliqué (route et ville : 2 à 4 cm ; courbe serrée du
  // 15/07/2025, 9d92052e : 19,7 → 7,4 cm, lignes de l'axe déformées, mieux sans recalage, constat de l'utilisateur 09/11/2026)
  const JOIN_GOOD = 0.05;
  // Écarts restants après le recalage, lissés en un champ de déplacement de la voisine (bendField) : la pose ajustée est
  // juste en moyenne, pas partout (bc400f2b, 09/11/2026 : axe rompu de quelques cm au bord du masque). BEND cases sur la vue,
  // portée BEND_SIGMA m, BEND_PRIOR : poids d'un déplacement nul (loin des mesures, le champ s'éteint)
  const BEND = 60, BEND_SIGMA = 1.2, BEND_PRIOR = 0.02;  // a priori faible : sous le masque, les écarts du bord sont repris

  /** Champ de déplacement (est, nord, m ; BEND x BEND cases, lignes du sud au nord, RGBA) qui annule au mieux les écarts
   * restants points ([{ p, dir, r }] : r, écart le long de dir) : moindres carrés pondérés par case, a priori nul. */
  function bendField(points) {
    const field = new Float32Array(4 * BEND * BEND), cell = 2 * REACH / BEND, far = (3 * BEND_SIGMA) ** 2;
    for (let j = 0; j < BEND; j++) {
      for (let i = 0; i < BEND; i++) {
        const x = -REACH + (i + 0.5) * cell, y = -REACH + (j + 0.5) * cell;
        let a11 = BEND_PRIOR, a12 = 0, a22 = BEND_PRIOR, b1 = 0, b2 = 0;
        for (const { p, dir, r } of points) {
          const d2 = (p[0] - x) ** 2 + (p[1] - y) ** 2;
          if (d2 > far) continue;
          const w = Math.exp(-d2 / (2 * BEND_SIGMA ** 2));
          a11 += w * dir[0] * dir[0]; a12 += w * dir[0] * dir[1]; a22 += w * dir[1] * dir[1];
          b1 += w * dir[0] * r; b2 += w * dir[1] * r;
        }
        const det = a11 * a22 - a12 * a12, k = 4 * (j * BEND + i);
        field[k] = (a22 * b1 - a12 * b2) / det;
        field[k + 1] = (a11 * b2 - a12 * b1) / det;
      }
    }
    return field;
  }
  // A priori sur la pose relative (écarts types : décalage 0,3 m, angles 1°, échelle 0,5 % ; mesures à 2 cm) : un terme mal
  // déterminé par une zone commune étroite reste près de 0. Échelle tenue serrée : même caméra, même hauteur ; le long de
  // la route, elle se confond presque avec le décalage (a9fd217d, 08/11/2026 : 85 cm et 11 % d'un côté, 3 cm et 2 % dans
  // l'autre sens pour le même raccord, l'image tordue au-delà). Au-delà de JOIN_LIMIT, correction refusée (décalage jusqu'à
  // 1,2 m, la portée de la recherche : GPS décalé de 1 m le long entre deux photos sur la D33 du 04/07/2025). Même ordre que
  // les termes de alignJoin : décalages, tangage, lacet, échelle, roulis
  const JOIN_PRIOR = [0.3, 0.3, toRad, toRad, 0.005, toRad].map((s) => (0.02 / s) ** 2);
  const JOIN_LIMIT = [1.2, 1.2, 3 * toRad, 3 * toRad, 0.06, 3 * toRad];
  const JOIN_SHIFT_ONLY = JOIN_PRIOR.map((v, i) => (i < 2 ? v : 1e12));  // décalage seul : les autres termes tenus à 0

  /** Photo seule dessinée (réglages en cours, sans recalage) : gris (0-255) passe-haut, sûr (0/1), lignes du sud au nord. */
  let rasterReach = 11;  // m : portée du sol sûr de readRaster (JOIN_REACH ; LINE_REACH pour les lignes)
  function readRaster(layer, terrain, frame, keepFix = false, reach = JOIN_REACH) {
    rasterReach = reach;
    const g = context(), rgba = new Uint8Array(4 * SIZE * SIZE);
    // gris et sol sûr (hors véhicule, à moins de JOIN_REACH m)
    render([{ ...layer, fix: keepFix ? layer.fix : null, bend: null }], terrain, frame, null, SIZE, 4);
    g.readPixels(0, 0, SIZE, SIZE, g.RGBA, g.UNSIGNED_BYTE, rgba);
    const gray = new Float32Array(SIZE * SIZE), safe = new Uint8Array(SIZE * SIZE);
    for (let k = 0; k < gray.length; k++) {
      gray[k] = (rgba[4 * k] + rgba[4 * k + 1] + rgba[4 * k + 2]) / 3;
      safe[k] = rgba[4 * k + 3] > 127 ? 1 : 0;
    }
    return { high: highPass(gray), safe };
  }

  /** Plan de FFT de taille n (puissance de 2), gardé par taille : paires à échanger (inversion de bits) et rotations de
   * chaque étage, calculées par la même récurrence qu'une rotation recalculée à chaque paquet (mêmes valeurs au bit près),
   * pour le sens direct (cos, sin) et inverse (cos, -sin) ; l'étage de longueur len commence à len / 2 - 1. */
  const fftPlans = new Map();
  function fftPlan(n) {
    let plan = fftPlans.get(n);
    if (plan) return plan;
    const swaps = [];
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) swaps.push(i, j);
    }
    const table = (sign) => {
      const cs = new Float64Array(n), sn = new Float64Array(n);
      for (let len = 2; len <= n; len <<= 1) {
        const a = sign * 2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), o = len / 2 - 1;
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          cs[o + k] = cr; sn[o + k] = ci;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = t;
        }
      }
      return [cs, sn];
    };
    plan = { swaps: Int32Array.from(swaps), forward: table(-1), inverse: table(1) };
    fftPlans.set(n, plan);
    return plan;
  }
  /** Transformée de Fourier en place des n valeurs de re, im (Float64Array) à partir de off, inverse si invert. */
  function fft(re, im, invert, off = 0, n = re.length) {
    const { swaps, forward, inverse } = fftPlan(n), [cs, sn] = invert ? inverse : forward;
    for (let s = 0; s < swaps.length; s += 2) {
      const i = off + swaps[s], j = off + swaps[s + 1], tr = re[i], ti = im[i];
      re[i] = re[j]; im[i] = im[j]; re[j] = tr; im[j] = ti;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, o = half - 1;
      for (let i = off; i < off + n; i += len) {
        for (let k = 0; k < half; k++) {
          const p = i + k, q = p + half, cr = cs[o + k], ci = sn[o + k];
          const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
          re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        }
      }
    }
    if (invert) for (let i = off; i < off + n; i++) { re[i] /= n; im[i] /= n; }
  }
  /** En 2D (côté size, puissance de 2), lignes puis colonnes. rows, cols : seules les rows premières lignes (les autres sont
   * nulles) puis les cols premières colonnes sont transformées ; le reste n'est alors pas à lire. Les colonnes sont
   * transformées toutes ensemble, ligne par ligne (même rotation pour toute une ligne) : mêmes opérations par colonne que
   * la FFT d'une colonne copiée, sans copie. */
  function fft2(re, im, size, invert, rows = size, cols = size) {
    for (let l = 0; l < rows; l++) fft(re, im, invert, l * size, size);
    const { swaps, forward, inverse } = fftPlan(size), [cs, sn] = invert ? inverse : forward;
    for (let s = 0; s < swaps.length; s += 2) {
      const i = swaps[s] * size, j = swaps[s + 1] * size;
      for (let c = 0; c < cols; c++) {
        const tr = re[i + c], ti = im[i + c];
        re[i + c] = re[j + c]; im[i + c] = im[j + c]; re[j + c] = tr; im[j + c] = ti;
      }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1, o = half - 1;
      for (let i = 0; i < size; i += len) {
        for (let k = 0; k < half; k++) {
          const p = (i + k) * size, q = p + half * size, cr = cs[o + k], ci = sn[o + k];
          for (let c = 0; c < cols; c++) {
            const tr = re[q + c] * cr - im[q + c] * ci, ti = re[q + c] * ci + im[q + c] * cr;
            re[q + c] = re[p + c] - tr; im[q + c] = im[p + c] - ti; re[p + c] += tr; im[p + c] += ti;
          }
        }
      }
    }
    if (invert) for (let k = 0; k < size; k++) for (let c = 0; c < cols; c++) { re[k * size + c] /= size; im[k * size + c] /= size; }
  }

  // Quadrique ajustée sur 5 x 5 autour d'un pic : [c, gx, gy, hxx/2, hxy, hyy/2]
  const QUAD = [];
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) QUAD.push([1, x, y, x * x, x * y, y * y]);

  let blockSums = [new Float64Array(0), new Float64Array(0)], blockBuffers = null;
  function blockFields(W) {  // tampons de blockShifts (fenêtre et gabarit combinés, corrélations de la paire), gardés d'un appel à l'autre
    if (blockBuffers?.[0].length !== W * W) blockBuffers = [0, 1, 2, 3].map(() => new Float64Array(W * W));
    return blockBuffers;
  }

  /** Décalages de blocs de la principale (a) dans la voisine (b) : [{ p (est, nord, m), dir, d (m) }].
   * Corrélation croisée par FFT, deux astuces pour les signaux réels : la fenêtre (b) et le gabarit (a) passent ensemble
   * dans une seule FFT complexe (fenêtre + i gabarit, spectres séparés par symétrie), et les corrélations de deux blocs
   * reviennent par une seule FFT inverse (la première en partie réelle, la seconde en partie imaginaire). Par bloc : 1,5 FFT 2D
   * au lieu de 3 ; valeurs égales à celles de trois FFT séparées à quelques 1e-13 près (arrondis). */
  function blockShifts(a, b) {
    const M = 2 * REACH / SIZE, W = BLOCK + 2 * SEARCH, half = BLOCK / 2, out = [], side = 2 * SEARCH + 1;  // W = 128 : puissance de 2
    // Sommes cumulées de la voisine (valeurs et carrés) : normalisation de chaque position en temps constant
    // (tampons gardés : première ligne et première colonne restent nulles, le reste est réécrit)
    if (blockSums[0].length < (SIZE + 1) * (SIZE + 1)) blockSums = [new Float64Array((SIZE + 1) * (SIZE + 1)), new Float64Array((SIZE + 1) * (SIZE + 1))];
    const [S1, S2] = blockSums, [zr, zi, qr, qi] = blockFields(W), c = new Float64Array(side * side), z = new Float64Array(25);
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const v = b.high[j * SIZE + i], k = (j + 1) * (SIZE + 1) + i + 1;
        S1[k] = v + S1[k - 1] + S1[k - SIZE - 1] - S1[k - SIZE - 2];
        S2[k] = v * v + S2[k - 1] + S2[k - SIZE - 1] - S2[k - SIZE - 2];
      }
    }
    const box = (S, x, y) => S[(y + BLOCK) * (SIZE + 1) + x + BLOCK] - S[y * (SIZE + 1) + x + BLOCK]
      - S[(y + BLOCK) * (SIZE + 1) + x] + S[y * (SIZE + 1) + x];
    const share = (safe, x0, y0, n) => {  // part sûre d'un carré de n px
      let s = 0;
      for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) s += safe[y * SIZE + x];
      return s / (n * n);
    };
    // Blocs retenus (assez sûrs, avec de la texture), dans l'ordre de lecture
    const blocks = [];
    for (let cy = SEARCH + half; cy < SIZE - SEARCH - half; cy += BLOCK_STEP) {
      for (let cx = SEARCH + half; cx < SIZE - SEARCH - half; cx += BLOCK_STEP) {
        const x0 = cx - half, y0 = cy - half;
        if (share(a.safe, x0, y0, BLOCK) < 0.95 || share(b.safe, x0 - SEARCH, y0 - SEARCH, W) < 0.95) continue;
        let mean = 0;
        for (let y = 0; y < BLOCK; y++) for (let x = 0; x < BLOCK; x++) mean += a.high[(y0 + y) * SIZE + x0 + x];
        mean /= BLOCK * BLOCK;
        let norm = 0;
        for (let y = 0; y < BLOCK; y++) for (let x = 0; x < BLOCK; x++) { const v = a.high[(y0 + y) * SIZE + x0 + x] - mean; norm += v * v; }
        if (Math.sqrt(norm / (BLOCK * BLOCK)) < 4) continue;  // sans texture
        blocks.push({ cx, cy, x0, y0, mean, norm });
      }
    }
    // Spectre de corrélation d'un bloc (fenêtre fois conjugué du gabarit), tiré du spectre combiné (zr, zi) : pour des
    // signaux réels, X[k] = (Z[k] + conj Z[-k]) / 2 (gabarit, partie imaginaire de Z) et Y[k] = (Z[k] - conj Z[-k]) / 2i
    const spectrum = (k, m, into) => {
      const p = zr[k], q = zi[k], r = zr[m], t = zi[m];
      const gr = (q + t) / 2, gi = (r - p) / 2, fr = (p + r) / 2, fi = (q - t) / 2;  // gabarit g = Z + i·(imag), fenêtre f
      into[0] = gr * fr + gi * fi;
      into[1] = fi * gr - fr * gi;
    };
    const pair = new Float64Array(2);
    const load = (blk) => {  // fenêtre (réelle) et gabarit (imaginaire) du bloc
      const { x0, y0, mean } = blk;
      zi.fill(0);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) zr[y * W + x] = b.high[(y0 - SEARCH + y) * SIZE + x0 - SEARCH + x];
      for (let y = 0; y < BLOCK; y++) for (let x = 0; x < BLOCK; x++) zi[y * W + x] = a.high[(y0 + y) * SIZE + x0 + x] - mean;
    };
    // Pic de corrélation d'un bloc (src : tableau des corrélations, une ligne par W) puis décalage le long des directions plates
    const peaks = (blk, src) => {
      const { cx, cy, x0, y0, norm } = blk;
      let top = -2, ky = 0, kx = 0;
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const px = x0 - SEARCH + x, py = y0 - SEARCH + y, s1 = box(S1, px, py), s2 = box(S2, px, py);
          const v = src[y * W + x] / Math.sqrt(Math.max(s2 - s1 * s1 / (BLOCK * BLOCK), 1e-9) * norm);
          c[y * side + x] = v;
          if (v > top) { top = v; ky = y; kx = x; }
        }
      }
      if (top < 0.4 || kx < 2 || ky < 2 || kx > side - 3 || ky > side - 3) return;
      let n = 0;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) z[n++] = c[(ky + y) * side + kx + x];
      const q = leastSquares(QUAD, z);
      if (!q) return;
      const hxx = 2 * q[3], hxy = q[4], hyy = 2 * q[5], tr2 = (hxx + hyy) / 2, dt = Math.sqrt(((hxx - hyy) / 2) ** 2 + hxy * hxy);
      for (const lam of [tr2 - dt, tr2 + dt]) {
        if (lam > -0.02) continue;  // pic plat dans cette direction
        let e = Math.abs(hxy) > 1e-12 ? [lam - hyy, hxy] : (hxx <= hyy) === (lam === tr2 - dt) ? [1, 0] : [0, 1];  // vecteur propre
        const len = Math.hypot(...e);
        e = [e[0] / len, e[1] / len];
        const ds = -(q[1] * e[0] + q[2] * e[1]) / lam;
        if (Math.abs(ds) > 1.5) continue;
        const shift = (kx - SEARCH) * e[0] + (ky - SEARCH) * e[1] + ds;  // px, colonnes vers l'est, lignes vers le nord
        out.push({ p: [(cx + 0.5) * M - REACH, (cy + 0.5) * M - REACH], dir: e, d: shift * M });
      }
    };
    for (let n = 0; n < blocks.length; n += 2) {
      for (let h = 0; h < 2; h++) {
        if (n + h >= blocks.length) break;  // dernier bloc seul : sa corrélation est réelle, la partie imaginaire reste nulle
        load(blocks[n + h]);
        fft2(zr, zi, W, false);
        for (let ky = 0; ky < W; ky++) {
          for (let kx = 0; kx < W; kx++) {
            const k = ky * W + kx;
            spectrum(k, ((W - ky) & (W - 1)) * W + ((W - kx) & (W - 1)), pair);
            if (h === 0) { qr[k] = pair[0]; qi[k] = pair[1]; } else { qr[k] -= pair[1]; qi[k] += pair[0]; }  // q = P0 + i·P1
          }
        }
      }
      fft2(qr, qi, W, true, W, side);  // seules les side premières colonnes sont lues
      peaks(blocks[n], qr);
      if (n + 1 < blocks.length) peaks(blocks[n + 1], qi);
    }
    return out;
  }

  /** Moindres carrés (lignes X, valeurs y, a priori ridge ajouté à la diagonale), par les équations normales, ou null.
   * Équations accumulées dans un Float64Array (matrice augmentée [XᵀX + ridge | Xᵀy], triangle supérieur puis symétrie),
   * résolues par élimination de Gauss-Jordan à pivot partiel ; pivot < 1e-12 : matrice singulière, null. Appelée des
   * milliers de fois par affichage (tangage lu sur les lignes) : pas de tableaux intermédiaires. */
  function leastSquares(X, y, ridge = null) {
    const n = X[0].length, N = X.length, W = n + 1, A = new Float64Array(n * W);
    for (let k = 0; k < N; k++) {
      const r = X[k], yk = y[k];
      for (let i = 0; i < n; i++) {
        const ri = r[i];
        if (ri === 0) continue;
        const o = i * W;
        for (let j = i; j < n; j++) A[o + j] += ri * r[j];
        A[o + n] += ri * yk;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) A[i * W + j] = A[j * W + i];
      if (ridge) A[i * W + i] += ridge[i];
    }
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r * W + c]) > Math.abs(A[p * W + c])) p = r;
      if (p !== c) for (let k = 0; k < W; k++) { const t = A[c * W + k]; A[c * W + k] = A[p * W + k]; A[p * W + k] = t; }
      if (Math.abs(A[c * W + c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r * W + c] / A[c * W + c];
        if (f !== 0) for (let k = c; k < W; k++) A[r * W + k] -= f * A[c * W + k];
      }
    }
    return Array.from({ length: n }, (_, i) => A[i * W + n] / A[i * W + i]);
  }

  /** Pose relative de la voisine other sur la principale main (rasters : readRaster des deux ; ax : axe de la route) :
   * { fix ([décalage avant, gauche (m), tangage, lacet (rad), échelle, roulis (rad)]) ou null, before, after (écart médian
   * au raccord, m), n (mesures) }, ou null sans assez de mesures. */
  function alignJoin(main, other, rasters, ax) {
    const obs = blockShifts(...rasters), [ce, cn] = other.at, seam = (ce * ax[0] + cn * ax[1]) / 2;
    // Déplacement d'un point dû à une erreur de pose de la voisine (petits angles, sol plan, voir docs/CALCULS.md)
    const h = other.pose.heading * toRad, f = [Math.sin(h), Math.cos(h)], side = [-f[1], f[0]], H = other.pose.height;
    const row = ({ p, dir }) => {
      const de = p[0] - ce, dn = p[1] - cn, u = de * f[0] + dn * f[1], v = de * side[0] + dn * side[1];
      const pu = dir[0] * f[0] + dir[1] * f[1], pv = dir[0] * side[0] + dir[1] * side[1];
      return [pu, pv, (H * H + u * u) / H * pu + u * v / H * pv, v * pu - u * pv, u * pu + v * pv,
        u * v / H * pu + (H * H + v * v) / H * pv];
    };
    const X = obs.map(row), y = obs.map((o) => o.d), test = obs.map((o) => Math.abs(o.p[0] * ax[0] + o.p[1] * ax[1] - seam) < SEAM);
    // Pose complète, sinon décalage seul (JOIN_SHIFT_ONLY) : peu de mesures ou zone commune étroite tiennent mal les angles
    // (bc400f2b, 09/11/2026 : 37 mesures, pose complète à 78 cm et 3° de lacet, voisine brute à 2,4 cm du raccord)
    let found = null;
    for (const prior of [JOIN_PRIOR, JOIN_SHIFT_ONLY]) {
      let keep = test.map((t) => !t), w = null, sd = 0;
      for (let pass = 0; pass < 4 && w !== undefined; pass++) {
        if (keep.filter(Boolean).length < 16) return found;
        w = leastSquares(X.filter((_, k) => keep[k]), y.filter((_, k) => keep[k]), prior) ?? undefined;
        if (!w) break;
        const r = y.map((v, k) => v - X[k].reduce((t, x, i) => t + x * w[i], 0));
        sd = 1.4826 * median(r.filter((_, k) => keep[k]).map(Math.abs)) + 0.005;
        keep = keep.map((on, k) => on && Math.abs(r[k]) < 3 * sd);  // mauvaises correspondances écartées
      }
      if (!w) continue;
      const checked = obs.map((o, k) => [Math.abs(o.d),
        Math.abs(o.d - X[k].reduce((t, x, i) => t + x * w[i], 0))]).filter((_, k) => test[k]);
      if (checked.length < 3) return found;
      const before = median(checked.map((c) => c[0])), after = median(checked.map((c) => c[1]));
      const sane = w.every((v, i) => Math.abs(v) <= JOIN_LIMIT[i]);
      const fix = after < before && after <= JOIN_GOOD && sane ? w : null;
      const rest = obs.map((o, k) => ({ ...o, r: o.d - X[k].reduce((t, x, i) => t + x * w[i], 0) })).filter((o) => Math.abs(o.r) < 3 * sd);
      found = found || { before, after, n: obs.length, w, fix: null, bend: null };  // bilan de la pose complète, si rien n'est gardé
      if (fix) return { fix, bend: bendField(rest), before, after, n: obs.length, w, shiftOnly: prior === JOIN_SHIFT_ONLY };
    }
    return found;
  }

  // Peintures et bords calés au bord du masque (09/11/2026, idée de l'auteur) : le morceau de voisine sous le véhicule de la
  // photo affichée est déformé en travers pour que chaque ligne en long y arrive sur celle de la photo affichée. Écart lu dans
  // une bande de LINE_BAND m juste hors du masque, où les deux photos voient le sol ; lignes : pics du passe-haut de la photo
  // affichée (LINE_PEAK fois l'écart médian), écart cherché à ±LINE_SEARCH m sur ±LINE_WINDOW m ; entre deux lignes,
  // interpolé ; au-delà, celui de la plus proche.
  // LINE_REACH : le bord du masque d'un côté n'est vu que par la voisine de l'autre côté, à 10 m environ (bc400f2b)
  const LINE_BAND = 0.5, LINE_SEARCH = 0.15, LINE_WINDOW = 0.4, LINE_PEAK = 4, LINE_REACH = 13;

  /** Champ de déplacement (comme bendField) qui cale les lignes en long de la voisine other sur celles de la principale au bord
   * du masque, ou null sans ligne. a, b : readRaster de la principale et de la voisine (recalée) ; ax : axe de la route. */
  function lineField(main, other, a, b, ax) {
    const M = 2 * REACH / SIZE, side = [-ax[1], ax[0]], T = Math.round(8 / M);
    const W = Math.round(LINE_WINDOW / M), S = Math.round(LINE_SEARCH / M);
    const field = new Float32Array(4 * BEND * BEND), cell = 2 * REACH / BEND, found = [];
    // Devant et derrière la caméra : le bord avant du masque est souvent comblé par la voisine arrière (la voisine avant a le
    // sien juste là, bc400f2b) ; chaque côté où la voisine voit le sol hors du masque est calé à part
    for (const ahead of [1, -1]) {
      const at = (u, t) => {  // pixel du point à u m le long de la route (côté ahead), t m en travers
        const e = ahead * u * ax[0] + t * side[0], n = ahead * u * ax[1] + t * side[1];
        const i = Math.floor((e + REACH) / M), j = Math.floor((n + REACH) / M);
        return i >= 0 && j >= 0 && i < SIZE && j < SIZE ? j * SIZE + i : -1;
      };
      const profileA = new Float32Array(2 * T), profileB = new Float32Array(2 * T), seen = new Uint8Array(2 * T);
      const edges = new Float32Array(2 * T);
      for (let k = 0; k < 2 * T; k++) {
        const t = (k - T + 0.5) * M;
        let edge = 0;  // bord du masque : premier point vu en partant de la caméra
        while (edge < 8 && hidden(ahead * edge * ax[0] + t * side[0], ahead * edge * ax[1] + t * side[1], main.pose)) edge += 0.05;
        if (edge === 0 || edge >= 8) continue;  // pas de masque à cette distance de l'axe
        edges[k] = edge;
        let sa = 0, sb = 0, n = 0;
        for (let u = edge + 0.05; u < edge + LINE_BAND; u += M) {
          const q = at(u, t);
          if (q < 0 || !a.safe[q] || !b.safe[q]) continue;
          sa += a.high[q]; sb += b.high[q]; n++;
        }
        if (n > 3) { profileA[k] = sa / n; profileB[k] = sb / n; seen[k] = 1; }
      }
      const strong = LINE_PEAK * (median([...profileA].filter((_, k) => seen[k]).map(Math.abs)) || Infinity), lines = [];
      for (let k = W + S; k < 2 * T - W - S; k++) {
        if (!seen[k] || profileA[k] < strong || profileA[k] < profileA[k - 1] || profileA[k] < profileA[k + 1]) continue;
        const score = (d) => {  // ressemblance des deux profils autour de k, B décalé de d
          let v = 0;
          for (let i = -W; i <= W; i++) if (seen[k + i] && seen[k + i + d]) v += profileA[k + i] * profileB[k + i + d];
          return v;
        };
        let best = 0, bestScore = score(0);
        for (let d = -S; d <= S; d++) { const v = score(d); if (v > bestScore) { best = d; bestScore = v; } }
        if (Math.abs(best) === S) continue;  // au bout de la recherche : pas la même ligne
        const l = score(best - 1), c = score(best), r = score(best + 1), sub = (l - r) / (2 * (l - 2 * c + r) || 1);
        lines.push({ t: (k - T + 0.5) * M, d: (best + Math.max(-0.5, Math.min(0.5, sub))) * M, ahead, edge: edges[k] });
      }
      if (!lines.length) continue;
      found.push(...lines);
      // déformation entière au bord du masque, nulle sous la caméra : les deux voisines s'y raccordent déjà entre elles
      const edge = lines.reduce((t, l) => t + l.edge, 0) / lines.length;
      const shiftAt = (t) => {  // écart en travers à t : interpolé entre les lignes, celui de la plus proche au-delà
        if (t <= lines[0].t) return lines[0].d;
        for (let i = 1; i < lines.length; i++) {
          const [a, b] = [lines[i - 1], lines[i]];
          if (t <= b.t) return a.d + (b.d - a.d) * (t - a.t) / (b.t - a.t);
        }
        return lines[lines.length - 1].d;
      };
      for (let j = 0; j < BEND; j++) {
        for (let i = 0; i < BEND; i++) {
          const e = -REACH + (i + 0.5) * cell, n = -REACH + (j + 0.5) * cell;
          const along = ahead * (e * ax[0] + n * ax[1]);
          if (along <= 0) continue;  // l'autre côté de la caméra
          const d = shiftAt(e * side[0] + n * side[1]) * Math.min(1, along / edge), k = 4 * (j * BEND + i);
          field[k] = d * side[0];
          field[k + 1] = d * side[1];
        }
      }
    }
    if (!found.length) return null;
    field.lines = found;  // pour le bilan et les essais
    return field;
  }

  /** Recalage de chaque voisine sur la principale : Map (photo -> fix), et le bilan affiché. */
  async function alignJoins() {
    const mine = shown, [main, ...others] = readyLayers(), key = joinKey(), begun = performance.now();
    mine.joining = true;
    say("Raccords en cours…");
    await new Promise((resolve) => setTimeout(resolve));  // l'image déjà faite s'affiche d'abord
    const joins = new Map(), results = [], farResults = [];
    try {
      if (shown === mine && others.length) {
        const ax = roadAxis([main, ...others]), raster = readRaster(main, mine.terrain, main.pose);
        for (const other of others) {
          await new Promise((resolve) => setTimeout(resolve));
          if (shown !== mine) return;
          const found = alignJoin(main, other, [raster, readRaster(other, mine.terrain, main.pose)], ax);
          // lignes calées au bord du masque, sur la voisine recalée (ou brute) ; à défaut, écarts restants des blocs
          const lines = found
            && lineField(main, other, raster, readRaster({ ...other, fix: found.fix }, mine.terrain, main.pose, true, LINE_REACH), ax);
          if (lines) found.bend = lines;
          if (found?.fix) joins.set(other.pose.pic, found.fix);
          results.push(found);
        }
        for (const other of readyFar()) {  // à deux pas : raccord lu pour le tangage seulement
          await new Promise((resolve) => setTimeout(resolve));
          if (shown !== mine) return;
          farResults.push({ other, r: alignJoin(main, other, [raster, readRaster(other, mine.terrain, main.pose)], ax) });
        }
      }
    } catch (error) {
      console.warn("Raccords de la vue du dessus :", error);  // l'image reste sans recalage
    } finally {
      mine.joining = false;
    }
    if (shown !== mine) return;
    // tangage de la photo changé : raccords refaits avec lui
    if (learnPitch(main, [...others.map((other, k) => ({ other, r: results[k] })), ...farResults])) return showImage();
    const done = results.filter((r) => r?.fix), cm = (v) => number(100 * v, 1);
    mine.joins = { key, map: joins, results, seams: new Map(others.map((o, k) => [o.pose.pic, results[k]])),
      ms: performance.now() - begun };
    mine.joinText = !others.length ? "" : done.length
      ? `raccords recalés ${done.length}/${others.length} (écart ${done.map((r) => `${cm(r.before)} → ${cm(r.after)}`).join(", ")} cm)`
      : `raccords non recalés (${results.some(Boolean) ? "sans gain sûr" : "pas assez de sol net en commun"})`;
    const farDone = farResults.filter(({ r }) => r?.fix).length;
    if (farResults.length) mine.joinText += `, ${farDone}/${farResults.length} à deux pas (tangage)`;
    await showImage();
  }
  // Réglages dont dépend le recalage : à refaire s'ils changent
  const joinKey = () => JSON.stringify([rollOffset, verticalsOn, readyLayers().map((l) => [l.pose.pic, l.pose.height,
    pitchFor(l.pose.pic), l.pose.outline?.reduce((a, b) => a + b, 0)])]);

  // Sur la mini-carte -----------------------------------------------------------------------
  // shown : { pic, sequence, height, estimated, estimating, key, pose, features, panos (photo -> texture), loading, terrain,
  // sigmaGround, terrainFailed, url }
  let map = null, shown = null;
  // Image décalée en travers pour se poser sur l'orthophoto (option d'essai, décochée par défaut, voir locate) : le GPS est à suspecter avant elle
  // (D33 : séquence du 04/07/2025 décalée de 0,75 m, celle du 20/06/2025 sur l'orthophoto à 2 cm près)
  const withPosition = () => positionOn && !shown?.silent;
  let positionOn = false;  // désactivé par défaut (décision de l'auteur, 20/11/2026) ; case « Position calée sur l'orthophoto »
  const CLOSE_PX = 10;  // px : clic à cette distance d'un sommet de la surface en cours = surface refermée
  const SHIFT_MIN = 0.3;  // m : écart en deçà duquel la position GPS est gardée (lignes repérées à quelques cm, orthophoto à 20 cm)
  // Photos voisines (interrupteur « Véhicule masqué », éteint par défaut) : lues, analysées, dessinées sous le véhicule et
  // recalées sur la principale (alignJoin), tangage de la séquence lu sur les raccords ; sinon la photo affichée seule
  let neighboursOn = false;
  // Calage sans affichage (silent, pour « Largeur dans la visionneuse » : Dessus.update(…, silent)) : mêmes calculs que Bird Eye (terrain,
  // verticales, tangage lu sur les lignes), sans voisines ni position sur l'orthophoto (réglages d'affichage), sans image sur la carte
  const withNeighbours = () => neighboursOn && !shown?.silent;
  // « Bords gardés » (éteint par défaut) : vue entière sur ±REACH m, sans la découpe à ±BEST.wide m de l'axe de la route
  let edgesOn = false;
  // « Limiter à la zone mesurable » (éteint par défaut, demande de l'auteur, 28/11/2026) : au loin la vue est floue, ce qui gêne les
  // calages à la main sur l'orthophoto : la vue est coupée net (sans le fondu de SURE à REACH) à un rectangle centré sur la photo
  // principale, de la zone de « Largeur dans la visionneuse » (pose.width_depth et width_reach, plus MARGE_ZONE
  // le long de l'axe, devant comme derrière), les voisines, plus proches, prennent le relais. Choix retenu dans le navigateur ; clé
  // hors « web-measures/dessus- » : « Sans cache (essais) » ne l'efface pas.
  const ZONE_KEY = "web-measures/zone-mesurable";
  let zoneOn = false;
  // « Sol plat » (éteint par défaut, demande de l'auteur, 26/11/2026) : la vue et ses mesures se projettent sur le sol plat
  // (plan horizontal à la hauteur de caméra), sans relief LiDAR HD ni RGE ALTI, comme près d'un pont. Choix retenu dans le
  // navigateur ; clé hors « web-measures/dessus- » : « Sans cache (essais) » ne l'efface pas. Prédicat unique : flatGround.
  const FLAT_KEY = "web-measures/sol-plat", FLAT_TITLE = "Projette la vue et ses mesures sur un sol plat (plan horizontal à la hauteur de caméra), sans le relief du LiDAR HD ni du RGE ALTI. Éteint par défaut ; choix retenu dans ce navigateur. Imposé près d'un pont (à moins de 15 m).";
  let flatOption = false;
  // « Calage par les verticales » : coché d'office pour une photo en zone d'habitation (Lieu.inTown), décoché ailleurs (sur 3
  // essais de l'auteur, 10/11/2026, la vue était meilleure inclinée par la route hors agglomération ; en ville, photo de
  // référence de Pouilly-en-Auxois : raccords recalés avec les verticales, pas avec la route) ; changé à la main pour la photo
  let verticalsOn = false;
  let abort = null, measuringOn = false, fine = false, trace = [], tool = "longueur", hover = null, live = null;  // trace : points posés ; live : valeur affichée au pointeur
  // Roulis ajouté et tangage ajouté (degrés), réglés à la main (options d'essai) et retenus par séquence dans le
  // navigateur : la fixation de la caméra ne change pas au cours d'une séquence (A38 du 09/10/2025 : même tangage à deux endroits)
  // ROLL_SHARE_DEFAULT : part du dévers prise en roulis (70 %, donnée par la pose : roll_share, py/web_pose.py ROLL_SHARE, qui s'en sert aussi pour le roulis par défaut des mesures ; fixe depuis le 26/11/2026 : le réglage est un roulis ajouté, en degrés,
  // comme le tangage ; 0° donne exactement l'ancien réglage par défaut). Réglage de la séquence : clé « rollDeg » (l'ancienne
  // clé « roll », en part du dévers, est ignorée).
  const ROLL_SHARE_DEFAULT = 0.7, ROLL_PITCH_LIMIT = 2.5, DEFAULT_ROLL = 0, DEFAULT_PITCH = 0, SETTINGS_KEY = "web-measures/dessus-reglages";
  const rollShareOf = (pose) => pose?.roll_share ?? ROLL_SHARE_DEFAULT;
  /** Tangage par défaut de la caméra (degrés, positif : relevée vers l'avant, relatif à la route) : celui du profil de campagne de la
   * photo (pose.pitch_default, py/web_profils.py), 0 sans profil. Valeur de départ de la réglette quand aucun tangage n'est lu : un
   * tangage lu (raccords, lignes) ou réglé à la main le remplace, il ne s'y ajoute jamais (les deux sont absolus, relatifs à la route). */
  const pitchDefaultOf = (pose) => pose?.pitch_default ?? DEFAULT_PITCH;
  // pitchManual : tangage réglé à la main en usage (manualPitch : sa valeur, retenue par séquence) ; il ne sert qu'en dernier,
  // faute de tangage lu (autoPitch), sauf « Forcer le réglage à la main » (pitchForced, demande de l'auteur, 13/11/2026)
  let rollOffset = DEFAULT_ROLL, pitchOffset = DEFAULT_PITCH, pitchManual = false, manualPitch, pitchForced = false;
  const readSettings = () => {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }  // stockage absent ou illisible
  };
  // Hauteur de caméra par séquence : la caméra ne bouge pas, mais l'altitude GPS RTK moins le sol LiDAR varie d'une photo à
  // l'autre (A38, une séquence : 1,83 à 2,36 m) ; la médiane des photos vues (vérifiées RTK) sert à toutes, gardée dans le
  // navigateur comme le roulis et le tangage
  const HEIGHTS_KEY = "web-measures/dessus-hauteurs", HEIGHTS_MIN = 3;
  const readHeights = () => {
    try { return JSON.parse(localStorage.getItem(HEIGHTS_KEY)) || {}; } catch { return {}; }
  };
  /** Hauteur de la photo affichée ajoutée à sa séquence (photo vérifiée seulement) ; { height, count } de la séquence, ou null. */
  function sequenceHeight(sequence, pose) {
    const all = readHeights(), kept = all[sequence] || {};
    if (pose && !pose.bridge && pose.relative_sigma <= 0.05 && pose.rtk_height >= MIN_HEIGHT
      && pose.rtk_height <= MAX_HEIGHT && !(pose.pic in kept)) {  // rtk_height : écart RTK − sol de la photo, quelle que soit la hauteur retenue
      kept[pose.pic] = Math.round(pose.rtk_height * 1000) / 1000;
      const pics = Object.keys(kept);
      if (pics.length > 60) delete kept[pics[0]];  // les plus anciennes d'abord
      all[sequence] = kept;
      try { localStorage.setItem(HEIGHTS_KEY, JSON.stringify(all)); } catch { /* sans stockage : pour cette page seulement */ }
    }
    const values = Object.values(kept);
    return values.length >= HEIGHTS_MIN ? { height: median(values), count: values.length } : null;
  }

  /** Réglage de la séquence affichée gardé ; les valeurs par défaut, et le tangage des raccords, ne sont pas gardés. */
  function keepSettings() {
    if (!shown) return;
    const all = readSettings();
    if (rollOffset === DEFAULT_ROLL && manualPitch === undefined && !pitchForced) delete all[shown.sequence];
    else all[shown.sequence] = { rollDeg: rollOffset, ...(manualPitch !== undefined ? { pitch: manualPitch } : {}),
      ...(pitchForced ? { forced: true } : {}) };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(all)); } catch { /* sans stockage : pour cette page seulement */ }
  }
  /** Tangage lu pour la photo, du plus sûr au moins sûr : { pitch (degrés), text (barre d'état) } ou null. Avec « Véhicule
   * masqué », celui de la photo lu sur ses raccords ; puis la médiane de la séquence lue sur les lignes (LINES_SEQUENCE photos
   * au moins), celui de la photo lu sur ses lignes sur 25 m (pas sur 10 m : à plus de 1° deux fois) ; enfin, avec « Véhicule
   * masqué », la médiane des raccords de la séquence. */
  function autoPitch(sequence, pic) {
    const own = withNeighbours() ? photoPitch(sequence, pic) : undefined, lines = readLines()[sequence] || {};
    const values = Object.values(lines).map((v) => v.p ?? v);
    const joined = withNeighbours() && sequencePitch(sequence), round = (v) => Math.round(v * 20) / 20;
    if (own !== undefined) return { pitch: round(own), text: "lu sur les raccords de la photo" };
    if (values.length >= LINES_SEQUENCE)
      return { pitch: round(median(values)), text: `de la séquence, lu sur ses lignes (${values.length} photos)` };
    if (lines[pic]?.wide) return { pitch: round(lines[pic].p), text: "lu sur les lignes de la photo (25 m)" };
    if (joined)
      return { pitch: joined.pitch, text: `de la séquence, lu sur les raccords (${joined.count} photo${joined.count > 1 ? "s" : ""})` };
    return null;
  }
  /** Réglage retenu pour la séquence (ou par défaut ; tangage : forcé à la main, sinon lu (autoPitch), sinon réglé à la main,
   * sinon celui du profil de campagne (pitchDefaultOf, 0 sans profil)), curseurs compris. */
  function applySettings(sequence, pic) {
    const kept = readSettings()[sequence], auto = autoPitch(sequence, pic);
    const inLimits = (v) => v === undefined ? v : Math.max(-ROLL_PITCH_LIMIT, Math.min(ROLL_PITCH_LIMIT, v));  // retenu avec d'anciennes bornes
    rollOffset = inLimits(kept?.rollDeg) ?? DEFAULT_ROLL;
    manualPitch = inLimits(kept?.pitch);
    pitchForced = Boolean(kept?.forced);
    pitchManual = manualPitch !== undefined && (pitchForced || !auto);
    pitchOffset = pitchManual ? manualPitch : auto ? auto.pitch : pitchDefaultOf(shown?.pose);
    showRoll();
    showShare(null);  // dévers de la nouvelle photo : au retour de showImage
    showPitch();
  }
  /** Roulis en clair : valeur signée et côté où penche le véhicule (positif : à droite, négatif : à gauche). */
  const signedDeg = (v) => `${v > 0 ? "+" : ""}${number(v, 2)}°`;  // degrés signés, sans le côté
  const rollText = (v) => `${v > 0 ? "+" : ""}${number(v, 2)}°${v ? ` (penché à ${v > 0 ? "droite" : "gauche"})` : ""}`;
  const rollShown = signedDeg;  // à côté de la réglette : degrés signés seulement (largeur stable, chiffres tabulaires) ; le sens est dans l'infobulle
  const showRoll = () => {
    $("#dessus-devers").value = rollOffset;
    $("#dessus-devers-valeur").textContent = rollShown(rollOffset);
  };
  /** Part du dévers retenue en roulis (ROLL_SHARE du dévers mesuré sous la caméra), en degrés signés, affichée au-dessus de la réglette ;
   * « — » sans terrain LiDAR HD (pas de dévers) ou terrain pas encore arrivé. layer : couche de la photo affichée. */
  function showShare(layer) {
    const terrain = layer && shown && onLidar(shown) ? shown.terrain : null;
    const share = terrain ? -Math.atan(rollShareOf(layer.pose) * groundSlopes(levelOf(terrain), layer.at, layer.pose.heading)[1]) / toRad : null;
    $("#dessus-part-devers").textContent = share === null ? "—" : signedDeg(Math.round(share * 100) / 100);
  }
  const showPitch = () => {
    $("#dessus-tangage-force").checked = pitchForced;
    $("#dessus-tangage").value = pitchOffset;
    $("#dessus-tangage-valeur").textContent = `${pitchOffset > 0 ? "+" : ""}${number(pitchOffset, 2)}°`;
  };

  // Tangage lu sur les raccords : une erreur de tangage de la photo affichée y paraît comme une échelle de signe opposé devant
  // et derrière (environ 1,8 L / H par radian, L : écart entre photos ; avant moins arrière). Retenu par photo dans le
  // navigateur et appliqué à cette photo : il bouge sur une bosse ou un creux, que le plan de la route sous le véhicule ne suit
  // pas (demande de l'auteur, 09/11/2026). Une photo sans le sien (pas de voisine devant et derrière) prend la médiane de la
  // séquence : fixation de la caméra, stable par séquence (08/11/2026 : +0,45 à +0,57°, +0,27 à +0,49°, -0,13 à -0,38°).
  const PITCHES_KEY = "web-measures/dessus-tangages", PITCH_STEP = 0.1;  // degrés : écart en deçà duquel la vue n'est pas refaite
  const PITCH_MAX = 2, PITCH_PASSES = 3;  // degrés : au-delà, lecture écartée ; vues refaites au plus 3 fois par photo
  const readPitches = () => {
    try { return JSON.parse(localStorage.getItem(PITCHES_KEY)) || {}; } catch { return {}; }
  };
  // Tangage lu sur les lignes et les bords de la route (linesPitch), absolu, par photo, gardé dans le navigateur ; lecture gardée
  // si ses lignes extrêmes sont à LINES_SPREAD m au moins l'une de l'autre (D33 : lignes à 4,9 à 5,6 m, lectures de -0,7 à
  // +2,2° d'une photo à l'autre ; A38, RD 1074 à 6,5 m et plus : à 0,2° près des raccords). Seule la médiane de la séquence
  // sert, dès LINES_SEQUENCE photos : une photo seule s'est trompée de plus de 1° (RD 1074,
  // 81049c82-2ea6-481f-b0d0-a6a1864e5ea0 : +1,3° pour +0,15° dans
  // la séquence ; D33, 7969fd3b-8c81-4f88-880b-c333b76e3586 : +1,6°, lignes à 7,9 m).
  const LINES_KEY = "web-measures/dessus-tangages-lignes", LINES_SPREAD = 6, LINES_SEQUENCE = 3, LINES_WIDE = 25;
  const readLines = () => {
    try { return JSON.parse(localStorage.getItem(LINES_KEY)) || {}; } catch { return {}; }
  };
  /** Tangage de la photo affichée lu sur ses lignes (vue par la route seulement), seulement faute de tangage lu sur ses
   * raccords (raccords en échec, ou sans « Véhicule masqué » ; demande de l'auteur, 13/11/2026), retenu ; tangage lu refait
   * (autoPitch) et vue refaite s'il change d'au moins PITCH_STEP (au plus PITCH_PASSES fois par photo). Lu sur ±LINES_WIDE m
   * avec le terrain LiDAR HD de cette portée : 1,5 à 2 fois plus stable que sur 10 m (A38 : -0,36 ± 0,09° contre
   * -0,50 ± 0,16°, raccords -0,3 à -0,4° ; RD 1074 : +0,15 ± 0,09° contre +0,17 ± 0,14° ; petite RD : +0,5 ± 0,37°, raccords
   * +0,5°) ; sur sol plat au-delà de 15 m, décalé de +0,3 à +0,4° (pente lointaine). Sinon sur 10 m. */
  function learnLines() {
    const mine = shown, [main] = readyLayers(), alone = { ...main, fix: null, bend: null };
    if (onLidar(mine) && mine.wideTerrain === undefined) {  // terrain sur ±LINES_WIDE m lu d'abord (une fois par photo)
      mine.wideTerrain = "reading";
      readTerrain(mine.pose, abort.signal, LINES_WIDE, TERRAIN_SMOOTH)
        .then((z) => z && smoothTerrain(z, mine.pose.heading, TERRAIN_SMOOTH)).catch(() => null).then((terrain) => {
        if (shown !== mine) return;
        mine.wideTerrain = terrain;
        showImage();
      });
      return;
    }
    if (mine.wideTerrain === "reading") return;
    mine.linesAt = pitchOffset;  // lecture faite avec ce tangage
    let found = null, wideRead = false;
    if (Array.isArray(mine.wideTerrain)) {
      const wide = readView(alone, mine.wideTerrain, main.pose, LINES_WIDE, 2048);
      found = linesPitch(wide, roadHeading(wide, main.pose.heading), main.pose.height, LINES_WIDE);
      wideRead = Boolean(found);
    }
    if (!found) {  // sans LiDAR, ou rien de lu sur 25 m (route sinueuse) : sur 10 m, avec le terrain de la vue
      const view = readView(alone, mine.terrain, main.pose);
      found = linesPitch(view, roadHeading(view, main.pose.heading), main.pose.height);
    }
    if (found && !flatOption && found.spread >= LINES_SPREAD && Math.abs(pitchOffset + found.pitch) <= PITCH_MAX) {
      const all = readLines(), kept = all[mine.sequence] || {};
      kept[mine.pic] = { p: Math.round((pitchOffset + found.pitch) * 100) / 100, wide: wideRead };  // wide : lu sur 25 m
      const pics = Object.keys(kept);
      if (pics.length > 60) delete kept[pics[0]];  // les plus anciennes d'abord
      all[mine.sequence] = kept;
      try { localStorage.setItem(LINES_KEY, JSON.stringify(all)); } catch { /* sans stockage : pour cette page seulement */ }
    }
    mine.linesFound = found;
    const auto = pitchManual ? null : autoPitch(mine.sequence, mine.pic);
    mine.linePasses = (mine.linePasses || 0) + 1;
    if (auto && Math.abs(auto.pitch - pitchOffset) >= PITCH_STEP && mine.linePasses <= PITCH_PASSES) {
      pitchOffset = auto.pitch;
      showPitch();
    }
    return showImage();
  }
  /** Tangage d'une photo lu sur ses propres raccords (degrés), ou undefined. */
  const photoPitch = (sequence, pic) => readPitches()[sequence]?.[pic];
  /** Tangage appliqué à une photo : réglé à la main, sinon celui de la photo affichée, sinon le sien (raccords), sinon celui
   * de la photo affichée. Pas la médiane de la séquence : elle compte la photo affichée, que chaque passe réenregistre ; les
   * voisines changeaient alors à chaque passe et les raccords repartaient sans fin (RD 1074, 09/11/2026). */
  const pitchFor = (pic) => pitchManual || !shown || pic === shown.pic ? pitchOffset
    : photoPitch(shown.sequence, pic) ?? pitchOffset;
  /** Tangage de la séquence lu sur les raccords : { pitch (degrés, au 0,05° près), count }, ou null. */
  function sequencePitch(sequence) {
    const values = Object.values(readPitches()[sequence] || {});
    return values.length ? { pitch: Math.round(median(values) * 20) / 20, count: values.length } : null;
  }
  /** Tangage de la photo affichée lu sur ses raccords (pairs : { other, r : résultat d'alignJoin }, voisines et photos à deux
   * pas), retenu pour elle ; vrai si son tangage change assez pour refaire la vue (au plus PITCH_PASSES fois). L'échelle de
   * chaque raccord vaut e + 0,9 δ a / H (a : position de la voisine le long, devant positif ; e commun) : droite ajustée, une
   * voisine devant et une derrière au moins. Photos à deux pas (10 m) : signal double, lecture moins souvent manquée. */
  function learnPitch(main, pairs) {
    const both = pairs.filter(({ r }) => r?.fix);  // recalages appliqués seulement
    if (both.length < 2 || !main.pose.groundTilt || !pairs.every(({ other }) => other.pose.groundTilt)) return false;
    const h = main.pose.heading * toRad, along = both.map(({ other }) => other.at[0] * Math.sin(h) + other.at[1] * Math.cos(h));
    if (!along.some((a) => a > 0) || !along.some((a) => a < 0)) return false;  // devant et derrière
    const ma = along.reduce((t, a) => t + a, 0) / along.length, mw = both.reduce((t, { r }) => t + r.w[4], 0) / both.length;
    const slope = both.reduce((t, { r }, k) => t + (along[k] - ma) * (r.w[4] - mw), 0) / along.reduce((t, a) => t + (a - ma) ** 2, 0);
    const residual = slope * main.pose.height / 0.9 / toRad;
    const own = Math.round((pitchOffset + residual) * 100) / 100;
    if (Math.abs(own) > PITCH_MAX) return false;  // lecture aberrante (raccord mal conditionné) : ni gardée ni appliquée
    const all = readPitches(), kept = all[shown.sequence] || {};
    kept[main.pose.pic] = own;
    const pics = Object.keys(kept);
    if (pics.length > 60) delete kept[pics[0]];  // les plus anciennes d'abord
    all[shown.sequence] = kept;
    try { localStorage.setItem(PITCHES_KEY, JSON.stringify(all)); } catch { /* sans stockage : pour cette page seulement */ }
    shown.pitchPasses = (shown.pitchPasses || 0) + 1;
    if (pitchManual || shown.pitchPasses > PITCH_PASSES || Math.abs(own - pitchOffset) < PITCH_STEP) return false;
    pitchOffset = Math.round(own * 20) / 20;
    showPitch();
    return true;
  }
  let swapViews = () => {};  // échange de la carte et de la visionneuse (app.js)
  // Dans la carte d'abord : détachée, elle est dans le document d'une autre fenêtre
  const $ = (selector) => map?.getContainer().querySelector(selector) || document.querySelector(selector);
  const number = (v, digits) => v.toFixed(digits).replace(".", ",");
  let etat = "";
  const say = (text) => {
    const label = $("#dessus-etat");
    etat = text;
    label.textContent = text;
    const profil = text && shown ? profileLine(shown.pose.profile) : null;  // profil de campagne appliqué (#70)
    if (profil) {
      const span = Object.assign(document.createElement("span"), { className: "relief-info", textContent: profil.text, title: profil.title });
      label.append(span);
    }
    const hauteurs = text && shown?.heightInfo ? heightLine(...shown.heightInfo) : null;  // hauteurs côte à côte (#59)
    if (hauteurs) {
      label.append(Object.assign(document.createElement("span"), { className: hauteurs.alert ? "relief-doute" : "relief-info",
        textContent: hauteurs.text, title: hauteurs.title }));
    }
    const line = text && shown && !flatGround(shown.pose) ? reliefLine(shown.relief) : null;  // diagnostic du relief (#67)
    if (!line) return;
    const span = document.createElement("span");
    span.className = line.alert ? "relief-doute" : "relief-info";
    span.textContent = line.text;
    label.append(span);
  };
  // Attente au centre de la carte (Attente, ticket #56), en plus de la barre d'état (bilan, inchangé) : une par vue, du premier calcul (ou du
  // calcul relancé par un réglage : view.waitMessage) jusqu'à ce qu'il ne reste rien en cours (showImage) ; croix si la lecture échoue.
  // Pas d'animation pour le calage seul (view.silent : la vue n'est pas sur la carte ; « Largeur dans la visionneuse » a la sienne).
  function wait(view, message = "Vue du dessus…") {
    if (view && !view.silent) view.attente ??= Attente.start(map.getContainer(), { icone: Attente.icones.faucon, message });
  }
  /** Fin de l'attente de la vue : ok (vue finie), texte d'échec (croix), ou rien (abandon : vue changée, éteinte). */
  function stopWait(view, issue = null, failed = false) {
    if (!view?.attente) return;
    if (failed) view.attente.echec(issue);
    else if (issue === "ok") view.attente.ok();
    else view.attente.fin();
    view.attente = null;
  }
  /** Réglage qui refait l'image : attente nommée d'après lui (« Raccords… », « Haute résolution… »), seulement si la vue est posée. */
  function redo(message) {
    if (!shown?.url) return;
    shown.waitMessage = message;
    showImage();
  }

  const busy = () => shown.estimating || shown.joining || shown.locating || shown.pose.pending
    || (withNeighbours() && (outlines.get(shown.sequence) === "reading" || shown.features === null || shown.loading.size > 0
      || shown.pose.neighbours.some((p) => p.pending)));
  /** Photos prêtes à dessiner, la principale d'abord (seule sans « Véhicule masqué »). */
  const readyLayers = () => [shown.pose, ...(withNeighbours() ? shown.pose.neighbours.filter((p) => !p.pending) : [])]
    .filter((pose) => shown.panos.has(pose.pic))
    .map(layerOf);
  /** Photos à deux pas prêtes (avec « Véhicule masqué », inclinées par la route : terrain LiDAR HD) : raccords pour le tangage
   * seulement (learnPitch), pas dessinées. */
  const readyFar = () => (withNeighbours() && onLidar(shown)
    ? (shown.pose.far || []).filter((pose) => shown.panos.has(pose.pic)).map(layerOf) : []);
  /** Incertitude (degrés) du tangage par défaut du profil de campagne (pose.pitch_default_sigma), seulement tant qu'il est celui en
   * usage : ni tangage lu, ni réglage à la main ; 0 sinon. */
  const pitchDefaultSigma = (pose) => (pose.pitch_default && !pitchManual && !autoPitch(shown.sequence, shown.pic) ? pose.pitch_default_sigma ?? 0 : 0);
  /** Couche d'une photo (pose) dans la vue affichée : position, inclinaison (verticales, sinon route), hauteur, contour. */
  function layerOf(pose) {
    const at = toLocal(pose.lon, pose.lat, shown.pose), ground = onLidar(shown) ? GROUND_SIGMA : DECK_SIGMA;
    // virage : véhicule penché ; verticales écartées : incertitude de la route
    const leveled = (pose.up && verticalsOn) || !shown.terrain ? pose : {
      ...pose, groundTilt: true,
      up: groundUp(levelOf(shown.terrain), at, pose.heading, rollShareOf(pose), pitchFor(pose.pic), (pose.roll_defect || 0) + rollOffset),
      sigma: Math.hypot(pose.up ? ground : Math.min(pose.sigma, ground), LEAN * (shown.lateral || 0), pitchDefaultSigma(pose)),
    };
    // raccord de la voisine
    const seam = shown.joins && shown.joins.key === shown.joinKeyNow ? shown.joins.seams?.get(pose.pic) : undefined;
    const fix = withNeighbours() && shown.joins && shown.joins.key === shown.joinKeyNow ? shown.joins.map.get(pose.pic) : undefined;
    const parallax = withNeighbours() ? shown.height : null;  // lue avec les voisines : sans « Véhicule masqué », ignorée
    // hauteur : décalage entre photos, sinon RTK moins le sol (de la séquence, ou de la photo)
    const mount = shown.pose.fleet ? shown.pose.mount : null;  // CD21 : véhicule d'après la date (profil de campagne, py/web_profils.py)
    const fitted = shown.pose.height_source === "calée";  // hauteur calée pour la séquence : avant la monture, la lecture et l'écart RTK − sol (#59)
    const height = fitted ? { height: leveled.height, height_sigma: leveled.height_sigma }
      : mount ? { height: mount, height_sigma: shown.pose.mount_sigma }
      : parallax && shown.pose.fleet ? { height: mountOf(parallax), height_sigma: shown.pose.mount_sigma }  // CD21 hors campagne connue
      : parallax ? { height: parallax, height_sigma: HEIGHT_SIGMA }
      : { height: shown.sequenceHeight?.height ?? leveled.height, height_sigma: Math.max(leveled.height_sigma, RTK_SIGMA) };
    const read = withNeighbours() ? outlines.get(shown.sequence) : null;  // CD21 : contour lu sur la séquence, sinon celui de sa hauteur de caméra
    const outline = !shown.pose.fleet ? null : Array.isArray(read) ? read : mount ? OUTLINES[mount]
      : parallax ? OUTLINES[mountOf(parallax)] : EITHER;
    const bend = withNeighbours() ? seam?.bend ?? undefined : undefined;  // lignes calées (lineField) ou écarts restants (bendField)
    return { pose: { ...leveled, ...height, outline }, pano: shown.panos.get(pose.pic), at, fix, seam, bend };
  }

  /** Mode « Mesure sur la carte » (app.js) : curseur, carte et visionneuse échangées, sans toucher au zoom. */
  function setMeasuring(on) {
    if (on === measuringOn) return;
    measuringOn = on;
    trace = [];
    // Croix par une classe (règle CSS « mesure-carte-active »), pas par le style en ligne : la droite ↔ (nez.js) pose puis vide ce
    // style en ligne, qui effaçait la croix et rendait la main de MapLibre
    map.getCanvasContainer().classList.toggle("mesure-carte-active", on);
    swapViews(on);  // carte en grand ; son cadrage et son zoom ne bougent pas
    drawTrace();
  }

  /** Longueur du départ au point (lon, lat) : { length, error, photos }. Un bout hors de la vue (contrôle sur le fond de
   * carte, l'orthophoto) : longueur sur la carte seule, sans incertitude (error null) ni photo. */
  /** Décalage de l'image (est, nord, m) : celui de l'orthophoto si l'option est cochée. */
  const shiftOf = () => (withPosition() && shown?.shift && Math.hypot(...shown.shift) > SHIFT_MIN ? shown.shift : [0, 0]);
  /** Point de la carte dans le repère de la photo (est, nord, m), image décalée comprise. */
  const localOf = (point) => { const [e, n] = toLocal(...point, shown.pose), [de, dn] = shiftOf(); return [e - de, n - dn]; };
  /** Surface (m²) du polygone de points [lon, lat] : plan local du premier sommet, comme App.add_map_area. */
  function areaOf(ring) {
    const local = ring.map((p) => toLocal(...p, { lon: ring[0][0], lat: ring[0][1] }));
    return Math.abs(local.reduce((sum, [x1, y1], k) => { const [x2, y2] = local[(k + 1) % local.length]; return sum + x1 * y2 - x2 * y1; }, 0)) / 2;
  }
  function lengthTo(point) {
    if (!shown) {  // pas de vue du dessus : longueur sur le fond de carte seul
      const [e, n] = toLocal(...point, { lon: trace[0][0], lat: trace[0][1] });
      return { length: Math.hypot(e, n), error: null, photos: "" };
    }
    const layers = readyLayers(), a = localOf(trace[0]), b = localOf(point);
    const la = sourceOf(a, layers), lb = sourceOf(b, layers), length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!la || !lb) return { length, error: null, photos: "" };
    return { length, error: shownError(a, b, layers, shown.sigmaGround), photos: [...new Set([la.pose.pic, lb.pose.pic])].join(",") };
  }
  const lengthText = ({ length, error }) => `${number(length, 2)} m ${error === null ? "(hors vue)" : `±${number(error, 2)}`}`;

  /** Segment en cours de tracé : départ, trait jusqu'au pointeur et sa longueur. Les longueurs faites sont dessinées
   * avec les autres mesures (App.map_geojson). */
  function drawTrace() {
    const area = tool === "surface", next = hover || trace[trace.length - 1];  // surface : contour refermé sur le premier point
    const data = { type: "FeatureCollection", features: trace.length ? [
      ...trace.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } })),
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [...trace, next, ...(area ? [trace[0]] : [])] } }] : [] };
    if (!map.getSource(LINE_ID)) {
      map.addSource(LINE_ID, { type: "geojson", data });
      map.addLayer({ id: LINE_ID, type: "line", source: LINE_ID, filter: ["==", "$type", "LineString"],
        paint: { "line-color": "#e53935", "line-width": 2, "line-dasharray": [3, 2] } });
      map.addLayer({ id: `${LINE_ID}-points`, type: "circle", source: LINE_ID, filter: ["==", "$type", "Point"],
        paint: { "circle-radius": 3, "circle-color": "#e53935", "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
    } else {
      map.getSource(LINE_ID).setData(data);
    }
    const found = !trace.length || !hover ? null
      : area ? (trace.length > 1 ? { text: `${number(areaOf([...trace, hover]), 1)} m²` } : null)
        : { text: lengthText(lengthTo(hover)) };
    if (!found) {
      live?.remove();
      live = null;
      return;
    }
    if (!live) {
      const element = Object.assign(document.createElement("div"), { className: "dessus-etiquette" });
      live = new maplibregl.Marker({ element, offset: [0, -14] });
    }
    live.getElement().textContent = found.text;
    live.setLngLat(hover).addTo(map);
  }

  function setup(theMap, swap) {
    map = theMap;
    swapViews = swap;
    map.on("mousemove", (event) => {
      hover = [event.lngLat.lng, event.lngLat.lat];
      if (measuringOn && trace.length) drawTrace();
    });
    const pitch = $("#dessus-tangage"), degrees = (v) => `${v > 0 ? "+" : ""}${number(Number(v), 2)}°`;
    pitch.addEventListener("input", () => { $("#dessus-tangage-valeur").textContent = degrees(pitch.value); });
    pitch.addEventListener("change", () => {  // grisé tant qu'un tangage lu prime (voir showImage)
      manualPitch = Number(pitch.value);
      keepSettings();
      if (shown) applySettings(shown.sequence, shown.pic);
      redo("Tangage…");
    });
    $("#dessus-tangage-force").addEventListener("change", (event) => {
      pitchForced = event.target.checked;
      if (pitchForced && manualPitch === undefined) manualPitch = pitchOffset;  // part du tangage lu
      keepSettings();
      if (shown) applySettings(shown.sequence, shown.pic);
      redo("Tangage…");
    });
    const share = $("#dessus-devers");
    // Molette sur une réglette : un cran = un pas (step), vers le haut = plus ; la vue se refait comme au lâcher d'un glissement
    // (« change »), une fois la molette arrêtée pour ne pas recalculer à chaque cran. Pavés tactiles : petits deltaY cumulés
    // jusqu'à un cran (100 px, ou 1 ligne) ; réglette grisée : sans effet.
    for (const slider of [pitch, share]) {
      let sum = 0, timer;
      slider.addEventListener("wheel", (event) => {
        event.preventDefault();  // ni la page ni le panneau ne défilent
        if (slider.disabled) return;
        sum += event.deltaY * (event.deltaMode === 1 ? 100 : event.deltaMode === 2 ? 800 : 1);  // lignes, pages, pixels
        const clicks = Math.trunc(-sum / 100);
        if (!clicks) return;
        sum += clicks * 100;
        const step = Number(slider.step) || 0.05, digits = 4;
        const value = Number(slider.value) + clicks * step, min = Number(slider.min), max = Number(slider.max);
        slider.value = Math.max(min, Math.min(max, Number(value.toFixed(digits))));
        slider.dispatchEvent(new Event("input"));
        clearTimeout(timer);
        timer = setTimeout(() => slider.dispatchEvent(new Event("change")), 250);
      }, { passive: false });
    }
    share.addEventListener("input", () => { $("#dessus-devers-valeur").textContent = rollShown(Number(share.value)); });
    share.addEventListener("dblclick", () => {  // retour au réglage par défaut (0°)
      share.value = DEFAULT_ROLL;
      share.dispatchEvent(new Event("change"));
    });
    share.addEventListener("change", () => {  // au lâcher : une image par réglage
      rollOffset = Number(share.value);
      $("#dessus-devers-valeur").textContent = rollShown(rollOffset);
      keepSettings();
      redo("Roulis…");
    });
    $("#dessus-bords").addEventListener("change", (event) => {
      edgesOn = event.target.checked;
      redo("Bords gardés…");
    });
    try { zoneOn = localStorage.getItem(ZONE_KEY) === "1"; } catch { /* sans stockage : décoché */ }
    $("#dessus-zone").checked = zoneOn;
    $("#dessus-zone").addEventListener("change", (event) => {
      zoneOn = event.target.checked;
      try { localStorage.setItem(ZONE_KEY, zoneOn ? "1" : "0"); } catch { /* pour cette page seulement */ }
      cancelStart();  // le départ a été pris sur l'autre image
      redo("Zone mesurable…");
    });
    // « Sol plat » : choix retenu ; la vue est refaite sur le sol plat, ou le relief relu s'il est décoché
    try { flatOption = localStorage.getItem(FLAT_KEY) === "1"; } catch { /* sans stockage : décoché */ }
    showFlatBox(null);
    $("#dessus-plat").addEventListener("change", (event) => {
      flatOption = event.target.checked;
      try { localStorage.setItem(FLAT_KEY, flatOption ? "1" : "0"); } catch { /* pour cette page seulement */ }
      cancelStart();  // le départ a été pris sur l'autre sol
      if (!shown) return;
      if (flatGround(shown.pose)) {
        if (shown.terrain === flatDeck) return;
        dropTerrain(shown);
        redo("Sol plat…");
      } else if (shown.terrain === flatDeck) {
        shown.waitMessage = "Relief…";
        rereadTerrain(shown);
      }
    });
    $("#dessus-position").addEventListener("change", (event) => {
      positionOn = event.target.checked;
      cancelStart();  // le départ a été pris dans l'autre position
      redo("Position…");
    });
    // Messages repliés ou non (interrupteur « Afficher les informations » des réglages), retenu dans le navigateur
    const STATE_FOLDED_KEY = "web-measures/etat-replie", stateSwitch = $("#dessus-infos");
    const foldState = (folded) => {
      $("#dessus-etat").classList.toggle("replie", folded);
      stateSwitch.checked = !folded;
    };
    // Appareil tactile (pointeur grossier, aucun pointeur fin) : replié par défaut, l'étiquette gênant la vue ; un choix mémorisé prime
    const touchOnly = matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
    try {
      const saved = localStorage.getItem(STATE_FOLDED_KEY);
      foldState(saved === null ? touchOnly : saved === "1");
    } catch { foldState(touchOnly); /* sans stockage : replié au tactile, déplié sinon */ }
    stateSwitch.addEventListener("change", () => {
      const folded = !stateSwitch.checked;
      foldState(folded);
      try { localStorage.setItem(STATE_FOLDED_KEY, folded ? "1" : "0"); } catch { /* pour cette page seulement */ }
    });
    $("#dessus-replier").addEventListener("click", (event) => {
      const folded = $("#dessus-reglages").classList.toggle("replie");
      event.currentTarget.setAttribute("aria-expanded", String(!folded));
      event.currentTarget.textContent = folded ? "▾" : "▴";
      event.currentTarget.title = folded ? "Déplier les réglages" : "Replier les réglages";
    });
    $("#dessus-verticales").addEventListener("change", (event) => {
      verticalsOn = event.target.checked;
      cancelStart();  // le départ a été pris sur l'autre image
      redo("Verticales…");
    });
    $("#dessus-voisines").addEventListener("change", (event) => {
      neighboursOn = event.target.checked;
      if (shown) applySettings(shown.sequence, shown.pic);  // tangage lu sur les raccords : seulement avec les voisines
      if (shown) loadNeighbours(abort.signal);
      cancelStart();  // le départ a été pris sur l'autre image
      redo("Véhicule masqué…");
    });
    $("#dessus-sans-cache").addEventListener("change", (event) => {
      noCache = event.target.checked;
      if (!noCache || !shown) return;
      const { photo, pose, features } = shown;  // vue refaite sans rien de retenu
      abort?.abort();
      removeImage();
      forget(shown);
      shown = null;
      clearCache();
      update(photo, pose, features);
    });
    $("#dessus-fine").addEventListener("change", (event) => {
      fine = event.target.checked;
      redo("Haute résolution…");
    });
  }

  /** Outil de la mesure sur la carte : « longueur » (deux clics) ou « surface » (contour, refermé en recliquant le dernier
   * point ou le premier). Le tracé en cours est abandonné. */
  function setTool(name) {
    tool = name;
    trace = [];
    drawTrace();
  }

  /** Clic sur la carte en mesure. Longueur : départ, puis arrivée, rend { kind, a, b ([lon, lat]), length, error (m, null
   * hors de la vue), photos }. Surface : sommets, rend { kind, ring } au clic sur le dernier ou le premier sommet (≥ 3 posés).
   * Sinon null (point posé, ou refusé : arrivée sur le départ, sommet sur le précédent). */
  function addPoint(lngLat) {
    const point = [lngLat.lng, lngLat.lat], here = map.project(point);
    const near = (q) => Math.hypot(here.x - map.project(q).x, here.y - map.project(q).y) < CLOSE_PX;
    if (tool === "surface") {
      if (trace.length >= 3 && (near(trace[0]) || near(trace[trace.length - 1]))) {
        const done = { kind: "surface", ring: trace };
        trace = [];
        drawTrace();
        return done;
      }
      if (trace.length && near(trace[trace.length - 1])) return null;
      trace.push(point);
      drawTrace();
      return null;
    }
    if (!trace.length) {
      trace = [point];
      drawTrace();
      return null;
    }
    const done = { kind: "longueur", a: trace[0], b: point, ...lengthTo(point) };
    if (done.length < 0.05) return null;  // second clic au même endroit : départ gardé
    trace = [];
    drawTrace();
    return done;
  }

  /** Tracé en cours retiré : en entier (Échap, image changée), ou son dernier point seul (all faux : Effacer, Ctrl+Z). Faux s'il
   * n'y en avait pas. */
  function cancelStart(all = true) {
    if (!trace.length) return false;
    trace = all ? [] : trace.slice(0, -1);
    drawTrace();
    return true;
  }

  /** Image retirée de la carte ; la vue (photos, calculs) reste. */
  function removeImage() {
    if (map.getLayer(IMAGE_ID)) map.removeLayer(IMAGE_ID);
    if (map.getSource(IMAGE_ID)) map.removeSource(IMAGE_ID);
  }
  /** Vue jetée : image et photos libérées (mémoire graphique). */
  function forget(view) {
    stopWait(view);
    if (view?.url) URL.revokeObjectURL(view.url);
    view?.panos.forEach((pano) => gl.deleteTexture(pano.texture));
  }
  // Bird Eye éteinte : la dernière vue gardée (photos, terrain, hauteur, raccords, position) pour la rallumer sur la même
  // photo sans rien refaire, le temps de la session ; jetée dès qu'une autre photo est montrée
  let parked = null;
  // Calculs des photos déjà vues dans la session (photo -> terrain, hauteur lue, raccords, position), repris en y revenant ; les photos
  // elles-mêmes sont relues (mémoire graphique). Raccords : gardés pour les mêmes réglages et voisines (voir joinKey)
  const computed = new Map(), COMPUTED_MAX = 200;
  let noCache = false;  // « Sans cache (essais) » : tout est recalculé à chaque photo montrée, même déjà vue
  /** Oublie ce que Bird Eye a retenu : navigateur (sauf les réglages faits à la main) et session. */
  function clearCache() {
    try {
      for (const key of Object.keys(localStorage))
        if (key.startsWith("web-measures/dessus-") && key !== SETTINGS_KEY) localStorage.removeItem(key);
    } catch { /* sans stockage : rien à vider */ }
    outlines.clear();
    computed.clear();
    parked = null;
  }
  function remember(view) {
    if (!view?.panos.has(view.pic)) return;  // photo et terrain pas encore lus
    computed.delete(view.pic);
    computed.set(view.pic, {
      terrain: view.terrain, wideTerrain: view.wideTerrain === "reading" ? undefined : view.wideTerrain,
      terrainFailed: view.terrainFailed, estimated: view.estimated && !view.estimating,
      joins: view.joins, joinText: view.joinText, shift: view.shift, calage: view.calage,
      located: view.located, locatedWith: view.locatedWith, placed: view.placed, lateral: view.lateral,
    });
    if (computed.size > COMPUTED_MAX) computed.delete(computed.keys().next().value);  // la plus ancienne
  }

  // Hauteurs de caméra lues sur le décalage entre photos (estimateHeight), retenues par photo dans le navigateur ; la médiane
  // sert à toute la séquence, même vue photo seule, avant l'altitude RTK moins le sol LiDAR (giratoire b47b4351 : 1,94 m par le
  // décalage contre 2,06 m par le RTK sur 15 photos, largeur mesurée sur le terrain conforme à environ 1,90 m)
  const PARALLAX_KEY = "web-measures/dessus-parallaxes";
  const readParallax = () => {
    try { return JSON.parse(localStorage.getItem(PARALLAX_KEY)) || {}; } catch { return {}; }
  };
  /** Hauteur de la séquence lue entre photos (médiane), ou null. */
  const sequenceParallax = (sequence) => median(Object.values(readParallax()[sequence] || {}).flat()) ?? null;
  const parallaxCount = (sequence) => Object.keys(readParallax()[sequence] || {}).length;
  // Photos du CD21 (pose.fleet) : imajbox sur sangle, trois véhicules (Clio 5 blanche 1,93 m, Captur bleu et bicolore 2,07 m : la hauteur suit le véhicule, #75). Hauteurs lues entre
  // photos sur 36 vues (08/11/2026) : 1,90 à 1,95 m du 28/05 au 23/06/2025, 2,05 à 2,07 m le 03/07 (2,15 le 07/07 ; dispersé en
  // octobre, 2,04 à 2,34 m) ; l'altitude RTK moins le sol reste vers 2,05-2,10 m tout du long (antenne fixe, caméra plus basse
  // sur la Clio 5). La séquence prend la hauteur de véhicule la plus proche de sa hauteur lue, même par la seule inclinaison de
  // la route (verticales et route concordent au cm près là où les deux existent). Depuis le 13/11/2026, la hauteur vient
  // d'abord de la date de prise de vue (pose.mount, profil de campagne de py/web_profils.py) : la hauteur lue se joue à quelques cm du seuil de
  // 2,00 m (f2a245d0-aeea-4249-ba9c-fad83b442a23, 07/07/2025 : 2,03 ou 1,98 m selon le terrain) ; lue entre photos
  // seulement hors campagne connue.
  // Hauteurs mesurées sur les véhicules : non disponibles (prises de vue faites par un prestataire), piste abandonnée le 13/11/2026
  // Les hauteurs possibles viennent de la pose (pose.mounts : hauteurs des profils du CD21 de py/web_profils.py, triées ; pose.mount_sigma :
  // leur incertitude), jamais recopiées ici ; seuls les contours (OUTLINES) sont indexés par hauteur
  const mountOf = (h) => shown.pose.mounts.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
  let drawing = 0;  // dernier dessin demandé : l'image d'un dessin dépassé est jetée

  /** Inclinaison par la route, pour le message d'état : part du dévers prise en roulis, défaut de la caméra, virage,
   * tangage (réglé à la main, ou lu : auto), roulis propre à la séquence, puis l'incertitude. */
  function roadTiltText(main, auto) {
    const notes = [`roulis à ${Math.round(rollShareOf(main) * 100)} % du dévers`];
    if (rollOffset) notes.push(`roulis réglé à la main ${rollText(rollOffset)}`);
    if (main.roll_defect) notes.push(`${number(main.roll_defect, 1)}° de défaut de la caméra (campagne)`);
    if (LEAN * (shown.lateral || 0) >= 0.5) notes.push(`virage : véhicule penché jusqu'à ${number(LEAN * shown.lateral, 1)}°`);
    if (pitchOffset || pitchManual || auto) {
      const how = pitchManual ? ` réglé à la main${pitchForced ? " (forcé)" : ""}` : auto ? ` ${auto.text}` : main.pitch_default ? " de la campagne (profil)" : "";
      notes.push(`tangage ${pitchOffset > 0 ? "+" : ""}${number(pitchOffset, 1)}°${how}`);
    }
    if (readSettings()[shown.sequence]?.rollDeg !== undefined && rollOffset !== DEFAULT_ROLL) notes.push("roulis de la séquence");
    return `inclinaison de la route (${notes.join(", ")}), ±${number(main.sigma, 1)}°`;
  }

  /** D'où vient la hauteur de caméra, pour la ligne « Hauteur » de l'étiquette : { label, rtk } (rtk : la hauteur est un écart RTK − sol,
   * donc pas répétée à part) ; parallax : hauteur lue entre photos, ou null. */
  function heightOrigin(parallax) {
    const vehicle = shown.pose.profile?.vehicle;
    const source = shown.pose.height_source;
    if (source === "calée") return { label: "calée pour la séquence", rtk: false };
    if (shown.pose.fleet && shown.pose.mount) return { label: vehicle || `véhicule du CD21 (${number(shown.pose.mount, 2)} m)`, rtk: false };
    if (parallax && shown.pose.fleet) return { label: `hauteur de véhicule du CD21 la plus proche (${number(mountOf(parallax), 2)} m)`, rtk: false };
    if (parallax) {
      const n = parallaxCount(shown.sequence);
      return { label: `parallaxe : décalage entre photos${n > 1 ? `, médiane de ${n} photos de la séquence` : ""}`, rtk: false };
    }
    if (shown.sequenceHeight) return { label: `écart RTK − sol LiDAR, médiane de ${shown.sequenceHeight.count} photos de la séquence`, rtk: true };
    return source === "altitude GPS" ? { label: "écart RTK − sol LiDAR de la photo", rtk: true } : { label: "réglage", rtk: false };
  }
  /** Arguments de heightLine pour la photo affichée : hauteur retenue, origine, hauteur lue entre photos (si elle n'est pas la hauteur
   * retenue : parallaxe sans monture), écart RTK − sol de la photo (s'il n'est pas la hauteur retenue). */
  function heightInfoOf(height, parallax) {
    const origin = heightOrigin(parallax), retained = !shown.pose.mount && !shown.pose.fleet && parallax && shown.pose.height_source !== "calée";
    return [height, origin.label, parallax && !retained ? parallax : null, origin.rtk ? null : shown.pose.rtk_height ?? null];
  }
  /** Ce que la vue du dessus applique à la photo affichée, annoncé à la page (Dessus.onTilt, App.birdeye_tilt_set) pour que la
   * droite de « Largeur dans la visionneuse » mesure comme elle : inclinaison tirée de la route (groundTilt ; avec les verticales
   * de la photo, up absent : la droite lit les mêmes ; manual : tangage ou part du dévers réglés à la main), hauteur de la couche
   * (monture, parallaxe ou RTK : layerOf) et son incertitude, terrain lissé sous la caméra (maillage du LiDAR HD, en m depuis son
   * centre, lignes du sud au nord ; ref : sol sous la caméra, plan de la route) ; null sans rien de tout cela. Annoncé seulement si
   * cela a changé. */
  let tiltListener = null, tiltAnnounced = new Map();
  function announceTilt(layer) {
    if (!tiltListener) return;
    const main = layer.pose, terrain = onLidar(shown) ? shown.terrain : null;
    const ground = terrain ? {
      lon: shown.pose.lon, lat: shown.pose.lat, n: meshSide(terrain), step: STEP,
      z: Array.from(terrain, (v) => Math.round((v - terrain[(terrain.length - 1) / 2]) * 1000) / 1000),
      ref: Math.round(groundLevel(levelOf(terrain), layer.at, main.heading) * 1000) / 1000,
    } : null;
    // Route : l'inclinaison tirée de la route, annoncée AUSSI quand les verticales priment (up : null), comme témoin indépendant
    // pour l'indicateur de confiance de l'inclinaison (Calibration.tilt_confidence) ; sans effet sur les mesures ni la droite
    const route = main.groundTilt ? { up: main.up, sigma: main.sigma } : terrain && onLidar(shown) ? {
      up: groundUp(levelOf(terrain), layer.at, main.heading, rollShareOf(main), pitchFor(main.pic), (main.roll_defect || 0) + rollOffset),
      sigma: Math.hypot(GROUND_SIGMA, LEAN * (shown.lateral || 0)),
    } : null;
    // Tangage lu sur les raccords de la photo (learnPitch : voisines devant et derrière recalées), tel que la vue l'applique : annoncé pour
    // que les mesures le prennent aussi (rang 3 bis de Calibration.tilt, py/web_pose.py _seam_tilt) ; absent si réglé à la main, sans voisines
    // ou sans lecture. Relatif à la route : la pente LiDAR HD s'y ajoute, comme dans groundUp.
    const read = withNeighbours() && !pitchManual && terrain ? photoPitch(shown.sequence, main.pic) : undefined;
    const tilt = {
      up: main.groundTilt ? main.up : null, sigma: main.sigma, manual: Boolean(main.groundTilt) && (pitchManual || rollOffset !== DEFAULT_ROLL),
      height: main.height, height_sigma: main.height_sigma, ground, route,
      route_manual: pitchManual || rollOffset !== DEFAULT_ROLL,
      pitch_read: read === undefined ? null : Math.round(read * 20) / 20,
    };
    const text = JSON.stringify(tilt);
    if (tiltAnnounced.get(main.pic) === text) return;
    tiltAnnounced.set(main.pic, text);
    tiltListener(main.pic, text);
  }
  /** Calage de la photo (même chose que la vue Bird Eye, sans l'afficher : update(…, silent)) : { ok } une fois fait, undefined avant.
   * Fait aussi par la vue allumée ; gardé avec ce que la vue retient d'une photo (computed), la photo reprise sans rien refaire. */
  const calibrated = (pic) => (shown?.pic === pic ? shown : parked?.pic === pic ? parked : computed.get(pic))?.calage;
  let calageListener = null;  // (pic, ok, final) : photo affichée calée (Dessus.onCalibrated) ; final faux : première lecture, raffinement en cours
  async function showImage() {
    wait(shown, shown.waitMessage);  // calcul relancé par un réglage : attente à son nom ; en cours : la même
    delete shown.waitMessage;
    placeFor(shown);
    shown.joinKeyNow = joinKey();  // recalage des raccords valable pour ces réglages seulement
    const layers = readyLayers(), pose = shown.pose, mine = ++drawing, axis = roadAxis(layers);
    announceTilt(layers[0]);
    showShare(layers[0]);
    // roulis et tangage : seulement pour l'inclinaison tirée de la route (pas de verticales lues, terrain LiDAR)
    $("#dessus-devers").disabled = $("#dessus-tangage-force").disabled = !layers[0].pose.groundTilt;
    // tangage lu : il prime
    $("#dessus-tangage").disabled = !layers[0].pose.groundTilt || (!pitchForced && Boolean(autoPitch(shown.sequence, shown.pic)));
    $("#dessus-verticales").disabled = !(pose.up && shown.terrain);  // verticales lues, route pour les remplacer
    // découpée à ±8 m de l'axe de la route (BEST.wide, sauf « Bords gardés »), bords parallèles à la route ; fondue
    // aux raccords avec les voisines (« Véhicule masqué »)
    if (!shown.silent) {
      const zone = zoneOn ? zoneRect(layers) : null;  // rectangle net de la zone mesurable : image affichée seulement, sans la bande de ±8 m
      const band = edgesOn || zone ? null : [...axis, 1e6, BEST.wide];
      const size = fine ? FINE_SIZE : SHOWN_SIZE;
      const canvas = withNeighbours() ? renderBlended(layers, shown.terrain, layers[0].pose, band, size, zone)
        : render(layers, shown.terrain, layers[0].pose, band, size, 0, null, REACH, zone);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (mine !== drawing || !shown) return;
      const old = shown.url, url = shown.url = URL.createObjectURL(blob);
      // Sous les mesures de la page (source « mesures », src/carte.js) et le tracé en cours ; le reste de la carte reste dessous
      const below = map.getStyle().layers.find((l) => l.source === "mesures" || l.id === LINE_ID)?.id;
      const [de, dn] = shiftOf(), placed = (e, n) => toLonLat(e + de, n + dn, pose);
      const coordinates = [[-REACH, REACH], [REACH, REACH], [REACH, -REACH], [-REACH, -REACH]].map(([e, n]) => placed(e, n));
      Object.assign(shown, { blob, corners: coordinates });  // pour l'export géoréférencé (exportView)
      if (map.getSource(IMAGE_ID)) {
        map.getSource(IMAGE_ID).updateImage({ url, coordinates });
      } else {
        map.addSource(IMAGE_ID, { type: "image", url, coordinates });
        map.addLayer({ id: IMAGE_ID, type: "raster", source: IMAGE_ID, paint: { "raster-fade-duration": 0 } }, below);
      }
      if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
    }
    if (shown.relief === undefined && !flatGround(pose)) {  // diagnostic du relief, lu une fois par photo (grille déjà en mémoire)
      const mine = shown;
      mine.relief = null;
      readRelief(pose).catch(() => null).then((relief) => { if (shown === mine && relief) { mine.relief = relief; say(etat); } });
    }
    const flat = pose.flat ? `pont à moins de ${number(pose.flat_radius, 0)} m` : flatOption ? "option" : shown.terrainFailed ? "service d'altitude injoignable"
      : "pas de LiDAR HD ici";
    const place = onLidar(shown) ? "Terrain LiDAR HD" : `Sol supposé plat (${flat})`;
    const parallax = withNeighbours() ? shown.height : null;
    const auto = pitchManual ? null : autoPitch(shown.sequence, shown.pic);
    // lignes : faute de tangage lu sur les raccords de la photo, une fois les raccords faits (ou impossibles)
    const joinsDone = !withNeighbours() || (!busy() && (layers.length < 2 || shown.joins?.key === shown.joinKeyNow));
    const linesPending = !pitchManual && !pose.pending && layers[0].pose.groundTilt && joinsDone
      && (withNeighbours() ? photoPitch(shown.sequence, shown.pic) : undefined) === undefined
      && shown.linesAt !== pitchOffset && (shown.linePasses || 0) <= PITCH_PASSES;
    // Message d'état : terrain, photos, inclinaison, hauteur de caméra, puis ce qui est encore en cours
    const tilt = pose.pending ? "inclinaison en calcul" : layers[0].pose.groundTilt ? roadTiltText(layers[0].pose, auto)
      : `${pose.up ? "inclinaison" : "sans inclinaison,"} ±${number(pose.sigma, 1)}°`;
    const others = shown.terrain || !withNeighbours() ? 0 : pose.neighbours.filter((p) => !p.up && !p.pending).length;
    const progress = linesPending ? "tangage en cours…" : shown.estimating ? "hauteur de caméra en calcul…"
      : shown.joining ? "raccords en cours…" : shown.locating ? "position en cours…"
      : withNeighbours() && outlines.get(shown.sequence) === "reading" ? "contour du véhicule en cours…"
      : busy() ? "photos voisines en cours…" : "";
    const head = `${place}, ${layers.length} photo${layers.length > 1 ? "s" : ""}, ${tilt}`
      + `${others ? ` (${others} voisine${others > 1 ? "s" : ""} sans inclinaison)` : ""}`
      + `, caméra à ${number(layers[0].pose.height, 2)} m`;
    shown.heightInfo = heightInfoOf(layers[0].pose.height, parallax);  // détail et comparaison : ligne « Hauteur » de l'étiquette (say)
    const joins = withNeighbours() && shown.joinText && shown.joins?.key === shown.joinKeyNow ? shown.joinText : "";
    if (!shown.silent) say([head, joins, locatedText(), progress].filter(Boolean).join(" ; "));
    // étape de l'attente : ce qui est encore en cours, dans les mots de la barre d'état (sans « en cours »)
    if (progress) shown.attente?.etape(progress.replace(/ en (cours|calcul)…$/, ""));
    else if (pose.pending) shown.attente?.etape("inclinaison");
    // Calage sans affichage : l'inclinaison de la première lecture des lignes suffit à « Largeur dans la visionneuse », qui affiche
    // sa largeur sans attendre le raffinement du tangage (passes suivantes) ; la page est avertie encore à la fin (final)
    if (linesPending && shown.silent && !shown.calage && (shown.linePasses || 0) >= 1 && !pose.pending
      && (layers[0].pose.groundTilt || layers[0].pose.up)) {
      shown.calage = { ok: true };
      calageListener?.(shown.pic, true, false);
    }
    if (linesPending) learnLines();
    else if (withPosition() && shown.located === undefined && !shown.locating && !pose.pending) locate();  // la principale suffit
    else if (!busy() && withNeighbours() && !shown.estimated) measureHeight();
    else if (!busy() && withNeighbours() && layers.length > 1 && shown.joins?.key !== shown.joinKeyNow) alignJoins();
    else if (!progress && !pose.pending) {  // plus rien en cours : vue finie, avec ses raffinements (coche de l'attente)
      stopWait(shown, "ok");  // coche de l'attente ; calage fait (ok : inclinaison de la photo connue, route ou verticales)
      shown.calage = { ok: Boolean(layers[0].pose.groundTilt || layers[0].pose.up) };
      calageListener?.(shown.pic, shown.calage.ok, true);
    }
  }

  /** Écart en travers de la photo principale à l'orthophoto (profils en travers, voir orthoShift), sans toucher au
   * tangage : la vue s'y pose au-delà de SHIFT_MIN (voir shiftOf). */
  async function locate() {
    const mine = shown, [main] = readyLayers();
    mine.locating = true;
    mine.locatedWith = withNeighbours();
    say("Position sur l'orthophoto en cours…");
    try {
      const ortho = await readOrtho(mine.pose, abort.signal);
      if (shown !== mine) return;
      const found = orthoShift(readView(main, mine.terrain, mine.pose), ortho, roadHeading(ortho, mine.pose.heading));
      if (found) mine.shift = [-found.shift * found.us[0], -found.shift * found.us[1]];
      mine.located = found ? Math.abs(found.shift) : null;
    } catch {
      if (abort.signal.aborted) return;
      mine.located = null;  // orthophoto injoignable : position GPS gardée
    } finally {
      mine.locating = false;
    }
    if (shown !== mine) return;
    if (withPosition() && mine.located > SHIFT_MIN) cancelStart();  // départ pris sur l'image avant décalage
    await showImage();
  }
  /** Bilan de la position pour la barre d'état. */
  const locatedText = () => (!withPosition() || shown.located === undefined ? ""
    : shown.located === null ? "position GPS gardée (profil de la chaussée sans accord avec l'orthophoto)"
    : Math.hypot(...shown.shift) > SHIFT_MIN ? `position calée sur l'orthophoto (décalage ${number(Math.hypot(...shown.shift), 2)} m)`
    : `position GPS gardée (écart à l'orthophoto ${number(Math.hypot(...shown.shift), 2)} m)`);

  /** Hauteur de caméra de la séquence, lue une fois toutes les photos prêtes, puis image refaite. */
  async function measureHeight() {
    const mine = shown;
    mine.estimated = mine.estimating = true;
    say("Hauteur de caméra en calcul…");
    await new Promise((resolve) => setTimeout(resolve));  // l'image déjà faite s'affiche d'abord
    if (shown !== mine) return;
    const [main, ...others] = readyLayers(), flat = (l) => ({ ...l, pose: { ...l.pose, groundTilt: false } });
    // CD21 : sans verticales, la hauteur lue avec l'inclinaison de la route suffit à choisir la monture
    const found = estimateHeight(main, others, mine.terrain)
      || (main.pose.fleet && main.pose.up ? estimateHeight(flat(main), others.map(flat), mine.terrain) : null);
    if (found?.length) {
      const all = readParallax(), kept = all[mine.sequence] || {};
      kept[main.pose.pic] = found.map((h) => Math.round(h * 1000) / 1000);
      const pics = Object.keys(kept);
      if (pics.length > 60) delete kept[pics[0]];  // les plus anciennes d'abord
      all[mine.sequence] = kept;
      try { localStorage.setItem(PARALLAX_KEY, JSON.stringify(all)); } catch { /* sans stockage : pour cette page seulement */ }
      mine.parallax = found;
    }
    mine.height = sequenceParallax(mine.sequence) ?? median(mine.parallax || []) ?? null;
    mine.estimating = false;
    await showImage();
  }

  /** Lance la lecture des photos voisines dont l'inclinaison est connue (inutile de les charger avant), à portée. */
  function loadNeighbours(signal) {
    const mine = shown;
    if (!withNeighbours()) return;
    readSequenceOutline(mine, signal);
    for (const pose of [...mine.pose.neighbours, ...(mine.pose.far || [])]) {
      const feature = (mine.features || []).find((f) => f.id === pose.pic);
      if (!feature || pose.pending || mine.panos.has(pose.pic) || mine.loading.has(pose.pic)
          || Math.hypot(...toLocal(pose.lon, pose.lat, mine.pose)) > REACH) continue;
      mine.loading.add(pose.pic);
      const tiles = Video.record(feature, { coords: feature.geometry.coordinates }).tiles;
      loadPano(tiles, Math.min(NEAR_LIMIT, context().getParameter(gl.MAX_TEXTURE_SIZE)), signal).then((part) => {
        if (shown !== mine) { part.canvas.width = 0; return; }
        mine.panos.set(pose.pic, panoTexture(part));
      }).catch((error) => {
        if (!signal.aborted) console.warn("Photo voisine de la vue du dessus :", error);
      }).finally(() => {
        mine.loading.delete(pose.pic);
        if (shown === mine && mine.panos.has(mine.pic)) showImage();
      });
    }
  }

  const outlines = new Map();  // séquence -> contour du véhicule lu (readOutline), null s'il n'a pas pu l'être, "reading"
  /** Contour du véhicule de la séquence de mine : gardé dans ce navigateur, sinon lu (une fois), puis vue refaite. */
  function readSequenceOutline(mine, signal) {
    const sequence = mine.sequence;
    if (!mine.pose.fleet || outlines.has(sequence)) return;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(OUTLINES_KEY))?.[sequence]; } catch { /* stockage absent ou illisible */ }
    if (saved) { outlines.set(sequence, saved); return; }
    outlines.set(sequence, "reading");
    readOutline(mine.photo, signal).then((outline) => {
      outlines.set(sequence, outline);
      if (outline) {
        try {
          const all = JSON.parse(localStorage.getItem(OUTLINES_KEY)) || {};
          localStorage.setItem(OUTLINES_KEY, JSON.stringify({ ...all, [sequence]: outline }));
        } catch { /* sans stockage : pour cette page seulement */ }
      }
    }).catch((error) => {
      if (signal.aborted) outlines.delete(sequence);  // repris à la prochaine vue
      else { outlines.set(sequence, null); console.warn("Contour du véhicule :", error); }
    }).finally(() => { if (shown?.sequence === sequence && shown.panos.has(shown.pic)) showImage(); });
  }

  /** Vue gardée (parked) remise : les calculs qu'elle avait en cours, interrompus, sont à refaire. */
  function resume() {
    shown = parked;
    parked = null;
    abort = new AbortController();
    if (shown.estimating) shown.estimated = shown.estimating = false;
    shown.joining = shown.locating = false;
    applySettings(shown.sequence, shown.pic);
  }

  /** Position calée faite avec l'autre état de « Véhicule masqué » (tangage, hauteur lus ou non avec les voisines) : mise de
   * côté, celle de cet état reprise, sinon refaite. */
  function placeFor(view) {
    if (view.located === undefined || view.locatedWith === withNeighbours()) return;
    view.placed = { ...view.placed, [view.locatedWith]: { located: view.located, shift: view.shift, locatedWith: view.locatedWith } };
    Object.assign(view, view.placed[withNeighbours()] || { located: undefined, shift: undefined, locatedWith: withNeighbours() });
  }

  /** Photo à montrer (fiche STAC, pose avec ses voisines et fiches des voisines, null s'il faut encore les lire ; photo null
   * pour tout retirer), à chaque changement : ne refait que ce qui a changé. */
  /** Photo à moins de 15 m d'un pont (pose.flat, par le cœur) : le MNT LiDAR HD n'y donne pas le sol vu (tablier retiré, fond de vallée). Tablier plan et horizontal (deck) : inclinaison par la route (tangage de la séquence et défaut de roulis de la
   * campagne seulement), hauteur entre photos, raccords et position refaits sur lui. Essai du 13/11/2026 : brèche du LiDAR
   * comblée au niveau de la route plutôt que tablier plat, sans gain (f2a245d0-aeea-4249-ba9c-fad83b442a23 : 0,487 m
   * contre 0,477 ; 7dcdccf9-3c52-4c54-bc5b-de72740a7967, petit pont
   * en maçonnerie : passage coupé contre 0,455 m), retiré. */
  let flatDeck = null;
  const deck = () => (flatDeck ??= new Array((2 * REACH / STEP + 1) ** 2).fill(0));  // maillage de readTerrain, à plat
  const onLidar = (view) => Boolean(view.terrain) && view.terrain !== flatDeck;
  /** Sol supposé plat pour cette pose : option « Sol plat » cochée, ou pont à moins de 15 m (pose.flat, imposé par le cœur). */
  const flatGround = (pose) => flatOption || Boolean(pose?.flat);
  /** Case « Sol plat » : cochée d'office et grisée près d'un pont (affichage forcé : le choix retenu n'est pas touché), sinon
   * selon le choix retenu ; grisée sans vue du dessus allumée (src/resultats.js). */
  function showFlatBox(pose) {
    const box = $("#dessus-plat"), bridge = Boolean(pose?.flat);
    box.checked = flatOption || bridge;
    box.closest("label").title = bridge ? `Pont à moins de ${number(pose.flat_radius, 0)} m : sol plat imposé` : FLAT_TITLE;
    if (bridge) box.disabled = true;
  }
  /** Terrain relu (LiDAR HD / RGE ALTI, grille brute en mémoire) pour une vue posée sur le sol plat qui n'a plus à l'être
   * (emprise d'un pont arrivée après le terrain, option « Sol plat » décochée) ; vue refaite dessus. */
  function rereadTerrain(mine) {
    const pose = mine.pose;
    mine.terrainFailed = false;
    readTerrain(pose, abort.signal).catch(() => null).then((terrain) => {
      if (shown !== mine || flatGround(mine.pose)) return;
      if (mine.pose !== pose && JSON.stringify(mine.pose.deck || []) !== JSON.stringify(pose.deck || [])) return rereadTerrain(mine);
      if (!terrain) mine.terrainFailed = true;
      Object.assign(mine, { terrain: terrain || deck(), estimated: false, joins: null, joinText: "", located: undefined, placed: undefined });
      mine.sigmaGround = onLidar(mine) ? LIDAR_SIGMA : FLAT_SIGMA;
      if (mine.panos.has(mine.pic)) showImage();
    });
  }
  function dropTerrain(view) {
    Object.assign(view,
      { terrain: deck(), sigmaGround: FLAT_SIGMA, estimated: false, joins: null, joinText: "", located: undefined, placed: undefined });
  }

  /**
   * GeoTIFF d'une image pour un SIG : Lambert 93 (EPSG:2154), RVB et transparence, compression deflate (prédicteur
   * horizontal), un seul bloc. image : ImageData ; corners : [lon, lat] des coins haut gauche, haut droit, bas droit, bas
   * gauche (comme une source image de MapLibre). Passage pixel -> Lambert 93 affine, exact aux trois premiers coins (sur
   * 30 m, l'écart de la projection à une transformation affine reste sous le millimètre). Promesse d'un Blob.
   */
  async function geotiff(image, corners, description = "") {
    const { width: w, height: h } = image, data = new Uint8Array(image.data);
    for (let row = 0; row < h; row++) {  // prédicteur 2 : chaque octet moins celui du pixel à sa gauche
      for (let k = (row + 1) * w * 4 - 1; k >= row * w * 4 + 4; k--) data[k] -= data[k - 4];
    }
    const strip = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    const [tl, tr, , bl] = corners.map(([lon, lat]) => Nuage.toL93(lon, lat));
    const transform = [(tr[0] - tl[0]) / w, (bl[0] - tl[0]) / h, 0, tl[0], (tr[1] - tl[1]) / w, (bl[1] - tl[1]) / h, 0, tl[1],
      0, 0, 0, 0, 0, 0, 0, 1];
    const text = [...`${description}\0`].map((c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 63));  // ASCII seul (« ? » sinon)
    // [étiquette, type (2 ASCII, 3 SHORT, 4 LONG, 12 DOUBLE), valeurs], par étiquette croissante
    const tags = [[256, 4, [w]], [257, 4, [h]], [258, 3, [8, 8, 8, 8]], [259, 3, [8]], [262, 3, [2]], [270, 2, text],
      [273, 4, [0]], [277, 3, [4]], [278, 4, [h]], [279, 4, [strip.length]], [284, 3, [1]], [317, 3, [2]], [338, 3, [2]],
      [34264, 12, transform],
      // GeoKeys : modèle projeté, pixel = surface (le coin haut gauche du premier pixel en (0, 0)), Lambert 93
      [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 2154]]];
    const bytes = { 2: 1, 3: 2, 4: 4, 12: 8 }, put = { 2: "setUint8", 3: "setUint16", 4: "setUint32", 12: "setFloat64" };
    let end = 8 + 2 + 12 * tags.length + 4;
    const places = tags.map(([, type, values]) => {
      const size = bytes[type] * values.length;
      if (size <= 4) return null;
      const at = end = Math.ceil(end / 8) * 8;
      end += size;
      return at;
    });
    const stripAt = Math.ceil(end / 8) * 8;
    tags.find(([tag]) => tag === 273)[2][0] = stripAt;
    const out = new Uint8Array(stripAt + strip.length), v = new DataView(out.buffer);
    out.set([73, 73, 42, 0, 8, 0, 0, 0]);  // « II », petit-boutiste, premier répertoire à l'octet 8
    v.setUint16(8, tags.length, true);
    tags.forEach(([tag, type, values], i) => {
      const entry = 10 + 12 * i, at = places[i] ?? entry + 8;
      v.setUint16(entry, tag, true);
      v.setUint16(entry + 2, type, true);
      v.setUint32(entry + 4, values.length, true);
      if (places[i] != null) v.setUint32(entry + 8, at, true);
      values.forEach((x, k) => v[put[type]](at + k * bytes[type], x, true));
    });
    out.set(strip, stripAt);  // répertoire suivant : 0 (déjà)
    return new Blob([out], { type: "image/tiff" });
  }

  /** Vue Bird Eye affichée en GeoTIFF (geotiff) : { blob, name }, ou null sans vue prête. Vue seule, telle que posée sur la
   * carte (position calée comprise), sans fond de carte ni mesures. */
  async function exportView() {
    const view = shown;
    if (!view?.blob) return null;
    const bitmap = await createImageBitmap(view.blob);
    const canvas = Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
    const g = canvas.getContext("2d");
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    const date = view.photo.properties?.datetime?.slice(0, 10) || "";
    const blob = await geotiff(g.getImageData(0, 0, canvas.width, canvas.height), view.corners,
      `Bird Eye, photo Panoramax ${view.pic}${date ? ` du ${date}` : ""}, ${2 * REACH} m de cote`);
    canvas.width = 0;
    return { blob, name: `bird-eye-${view.pic.slice(0, 8)}.tif` };
  }

  // Lecture à l'avance (activation de « Largeur dans la visionneuse ») : terrain (readGrid, gardé) et panorama de la photo,
  // sans calcul de calage ; update() reprend le panorama s'il s'agit de la même photo, un seul gardé à la fois
  let prefetched = null;  // { pic, part (promesse de loadPano), abort }
  function dropPrefetch() {
    if (!prefetched) return;
    prefetched.abort.abort();
    prefetched.part.then((part) => { part.canvas.width = 0; }, () => {});
    prefetched = null;
  }
  function prefetch(photo, pose) {
    if (!photo || !pose || pose.pic !== photo.id || flatGround(pose) || shown?.pic === photo.id || prefetched?.pic === photo.id
      || computed.has(photo.id)) return;
    dropPrefetch();
    const controller = new AbortController();
    readGrid(pose, LINES_WIDE).catch(() => {});
    const tiles = Video.record(photo, { coords: photo.geometry.coordinates }).tiles;
    const part = loadPano(tiles, context().getParameter(gl.MAX_TEXTURE_SIZE), controller.signal);
    part.catch(() => {});
    prefetched = { pic: photo.id, part, abort: controller };
  }

  async function update(photo, pose, features, silent = false) {
    const key = pose && JSON.stringify([pose, (features || []).map((f) => f.id), features === null, silent]);
    if (key === (shown?.key ?? null)) return;
    if (noCache && photo && shown?.pic !== photo.id) clearCache();  // autre photo, ou la même remontrée : tout refait
    cancelStart();  // départ pris sur l'ancienne image
    if (!photo) {
      stopWait(shown);  // calculs interrompus : l'attente aussi
      abort?.abort();
      removeImage();
      if (shown?.panos.has(shown.pic)) {  // photo et terrain lus
        remember(parked);
        forget(parked);
        parked = shown;  // calculs en cours interrompus : repris au retour (voir resume)
      } else {
        forget(shown);  // rien de lu : rien à garder
      }
      shown = null;
      say("");
      return;
    }
    if (!shown && parked?.pic === photo.id) resume();
    if (shown?.pic === photo.id) {  // même photo : inclinaison, hauteur ou voisines arrivées, image refaite
      const vertical = (p) => [p, ...p.neighbours].filter((q) => q.up && !q.pending).length;
      // verticales arrivées : hauteur entre photos refaite
      if (vertical(pose) > vertical(shown.pose) && !shown.estimating) shown.estimated = false;
      const unveiled = shown.silent && !silent;  // Bird Eye allumée sur une photo déjà calée sans affichage : image à poser
      const deckChanged = onLidar(shown) && JSON.stringify(pose.deck || []) !== JSON.stringify(shown.pose.deck || []);
      Object.assign(shown, { key, pose, features, silent });
      if (silent) stopWait(shown);  // calage seul : plus de vue sur la carte
      if (deckChanged) rereadTerrain(shown);  // emprise d'un pont arrivée après le terrain : terrain relu, vue refaite dessus
      if (unveiled && withNeighbours()) shown.calage = undefined;  // voisines à lire : le calage d'affichage n'est plus fait
      showFlatBox(pose);
      if (flatGround(pose) && shown.terrain !== flatDeck) dropTerrain(shown);  // pont connu après le terrain
      if (!pose.pending) shown.sequenceHeight = sequenceHeight(photo.collection, pose);  // hauteur vérifiée arrivée après
      loadNeighbours(abort.signal);
      if (shown.panos.has(shown.pic)) await showImage();
      return;
    }
    abort?.abort();
    removeImage();
    for (const view of [shown, parked]) {
      remember(view);
      forget(view);
    }
    parked = null;
    const controller = abort = new AbortController(), { signal } = controller;
    shown = {
      photo, pic: photo.id, sequence: photo.collection, key, pose, features, silent,
      height: sequenceParallax(photo.collection), estimated: false, estimating: false,
      panos: new Map(), loading: new Set(), terrain: null, sigmaGround: FLAT_SIGMA, terrainFailed: false, url: null,
    };
    const known = computed.get(photo.id);
    if (known) Object.assign(shown, known);  // déjà vue : terrain, raccords, position et calage repris
    tiltAnnounced.delete(photo.id);  // inclinaison annoncée de nouveau (App.birdeye_tilt_set la garde par photo, 20 au plus)
    showFlatBox(pose);
    if (flatGround(pose) && shown.terrain !== flatDeck) dropTerrain(shown);
    else if (!flatGround(pose) && shown.terrain === flatDeck) Object.assign(shown, { terrain: null, joins: null, estimated: false });  // reprise d'une vue plate (option décochée depuis)
    applySettings(photo.collection, photo.id);
    shown.sequenceHeight = pose.pending ? null : sequenceHeight(photo.collection, pose);
    const mine = shown;
    verticalsOn = $("#dessus-verticales").checked = false;  // route d'abord ; verticales si la photo est en zone d'habitation
    Lieu.inTown(...photo.geometry.coordinates.slice(0, 2)).catch(() => false).then((town) => {
      if (shown !== mine || !town || verticalsOn) return;
      verticalsOn = $("#dessus-verticales").checked = true;
      if (mine.panos.has(mine.pic)) showImage();
    });
    if (mine.lateral === undefined) {  // virage : incertitude d'inclinaison majorée à son arrivée
      lateralOf(photo, pose, signal).catch(() => 0).then((lateral) => {
        mine.lateral = lateral;
        if (shown === mine && mine.panos.has(mine.pic) && LEAN * lateral >= 0.1) showImage();
      });
    }
    if (!silent) {
      say("Lecture de la photo et du terrain…");
      wait(mine);
      mine.attente?.etape("lecture de la photo et du terrain");
    }
    try {
      const tiles = Video.record(photo, { coords: photo.geometry.coordinates }).tiles;
      const pre = prefetched?.pic === photo.id ? prefetched : null;  // panorama lu à l'avance
      if (pre) prefetched = null;
      else dropPrefetch();  // lecture à l'avance d'une autre photo : inutile
      const [terrain, part] = await Promise.all([
        (known && shown.terrain) || flatGround(pose) ? Promise.resolve(flatGround(pose) ? deck() : shown.terrain) : readTerrain(pose, signal).catch((error) => {
          console.warn("Terrain de la vue du dessus :", error);
          mine.terrainFailed = true;
          return null;
        }),
        pre ? pre.part : loadPano(tiles, context().getParameter(gl.MAX_TEXTURE_SIZE), signal)]);
      if (shown !== mine) { part.canvas.width = 0; return; }
      mine.terrain = flatGround(mine.pose) ? deck() : terrain;  // pont signalé ou option cochée pendant la lecture
      if (!flatGround(mine.pose) && terrain === flatDeck) {  // option décochée pendant la lecture : relief à lire
        mine.terrain = await readTerrain(mine.pose, signal).catch(() => { mine.terrainFailed = true; return null; }) || deck();
        if (shown !== mine) { part.canvas.width = 0; return; }
      } else if (terrain && !known && !flatGround(mine.pose) && JSON.stringify(mine.pose.deck || []) !== JSON.stringify(pose.deck || [])) {
        mine.terrain = await readTerrain(mine.pose, signal).catch(() => terrain);  // emprise d'un pont arrivée pendant la lecture
        if (shown !== mine) { part.canvas.width = 0; return; }
      }
      mine.sigmaGround = onLidar(mine) ? LIDAR_SIGMA : FLAT_SIGMA;
      mine.panos.set(mine.pic, panoTexture(part));
      loadNeighbours(signal);
      await showImage();
    } catch (error) {
      if (!signal.aborted) {
        console.error(error);
        say(`Bird Eye impossible : ${error.message}`);
        stopWait(mine, `Bird Eye impossible : ${error.message}`, true);
        mine.calage = { ok: false };
        calageListener?.(mine.pic, false, true);
      }
    }
  }

  return {
    setup, update, prefetch, exportView, onTilt: (listener) => { tiltListener = listener; }, calibrated,
    onCalibrated: (listener) => { calageListener = listener; }, geotiff, addPoint, cancelStart, setMeasuring,
    hasStart: () => trace.length > 0, measuring: () => measuringOn, setTool, tool: () => tool,
    layersNow: () => shown && { layers: readyLayers(), terrain: shown.terrain, height: shown.height, joins: shown.joins,
      outline: outlines.get(shown.sequence), locatedWith: shown.locatedWith },
    view, hidden, uncertainty, zoneRect, measureError, shownError, groundUp, pitchDefaultOf, roadAxis, sourceOf, toLocal, toLonLat, estimateHeight,
    diagnoseRelief, profileLine, heightLine, HEIGHT_ALERT, render, renderBlended, panoTexture, loadPano, readOrtho, readView, roadHeading, orthoShift, linesPitch, REACH, SIZE,
  };
})();

export { Dessus };
