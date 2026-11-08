// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Vue du dessus : le sol de la photo 360° reprojeté sur la mini-carte. Chaque point du terrain
// (MNT LiDAR HD, sinon plan horizontal) reçoit le pixel de la photo la plus proche qui le voit, compte
// tenu de la hauteur de la caméra, de son inclinaison et du cap (voir App.birdeye_pose). Les photos
// précédente et suivante couvrent le sol caché par le véhicule. Seuls les points réellement au sol
// sont à leur place : poteaux et autres objets s'étalent.

const Dessus = (() => {
  const EARTH_RADIUS = 6371008.8;  // comme py/core/triangulation.py
  const REACH = 15;  // m : portée de la vue
  const SURE = 10;  // m : grisé au-delà (0,6° d'inclinaison y déplacent déjà un point de 45 cm)
  const STEP = 1;  // m : maille du terrain (LiDAR HD à 50 cm, toit de la chaussée compris)
  const SIZE = 1024;  // px : côté de l'image des calculs (hauteur, raccords, position), soit 3 cm par pixel
  // px : côté de l'image affichée, 1,5 cm par pixel ; la photo est plus fine jusqu'à 10 m (12 288 px : 0,5 cm en travers et
  // 2,6 cm le long à 10 m, 0,2 et 0,5 cm à 4 m), les voisines (NEAR_LIMIT) deux fois moins
  const SHOWN_SIZE = 2048, FINE_SIZE = 4096;  // FINE_SIZE : « Haute résolution », 0,7 cm par pixel (zoom 24 de la carte)
  const CHUNK = 150;  // points par requête d'altitude (longueur de l'adresse)
  const CAR = { ahead: 0, long: 5.8, wide: 2.9 };  // m : véhicule étalé sur le sol, reflets du capot et du coffre compris (voir hidden)
  const BODY = { long: 4.5, wide: 2.5 };  // m : son corps seul, sol vraiment caché ; entre les deux, la bande des reflets
  // Bande des reflets : la photo y reste prise, son erreur attendue comptée REFLECT fois (voir sourceOf). shortcut: valeur
  // choisie sur un cas (village, 07/11/2026 : une voisine à 5 m dans ses reflets valait mieux qu'une photo à 10 m, dont
  // l'inclinaison lue sur les façades s'écartait de 1,6° pour ±0,2° annoncés) ; à revoir sur d'autres
  const REFLECT = 3;
  const NEAR_LIMIT = 6144;  // px : largeur des photos voisines, qui ne servent que près de leur caméra (mémoire graphique)
  const BEST = { along: 4, wide: 8 };  // m : zone idéale d'une largeur, en face de la caméra (essai du 08/11 : écart à l'orthophoto ≤ 1,5 % jusqu'à 4 m en long, 2 % au-delà)
  const MEASURED = 0.05;  // part de la longueur : incertitude affichée au moins égale à l'écart à l'orthophoto (voir docs/CALCULS.md)
  const HEIGHT_SIGMA = 0.05;  // m : hauteur de caméra lue sur le décalage entre photos voisines (essai de 28 paires)
  // m : hauteur par l'altitude RTK moins le sol, au moins : 12 cm d'écart avec le décalage entre photos sur le giratoire
  // b47b4351 (2,06 contre 1,94 m, stable sur 15 photos), alors que l'écart entre photos de la séquence n'est que de 2 cm
  const RTK_SIGMA = 0.1;
  const GROUND_SIGMA = 1;  // degrés : inclinaison déduite de la route, sans verticales à lire (voir docs/CALCULS.md)
  const LIDAR_SIGMA = 0.02, FLAT_SIGMA = 0.1;  // m : écart du sol au terrain utilisé (résidu LiDAR ; sol supposé plat)
  const ELEVATION_URL = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json";
  const LIDAR_RESOURCE = "ign_lidar_hd_mnt_mono_wld";
  const toRad = Math.PI / 180;
  const IMAGE_ID = "dessus-image", BEST_ID = "dessus-zones", LINE_ID = "dessus-traits";

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
    const ground = Math.hypot(Math.hypot(...a), Math.hypot(...b)) * sigmaGround / H;
    return Math.hypot(east, north, scale, ground);
  }

  /** Place du point (est, nord, m depuis la caméra) dans l'ellipse du véhicule, dans l'axe de la photo (le toit, le capot et
   * leurs reflets s'étalant sur le sol) : sous 1, il est caché. shortcut: forme relevée sur l'imajbox du CD21, à adapter
   * aux autres véhicules. */
  function inCar(east, north, pose) {
    const h = pose.heading * toRad, along = east * Math.sin(h) + north * Math.cos(h), across = east * Math.cos(h) - north * Math.sin(h);
    return ((along - CAR.ahead) / CAR.long) ** 2 + (across / CAR.wide) ** 2;
  }
  const hidden = (east, north, pose) => inCar(east, north, pose) < 1;
  /** Le point est-il sous le corps du véhicule (BODY) ? */
  function underBody(east, north, pose) {
    const h = pose.heading * toRad, along = east * Math.sin(h) + north * Math.cos(h), across = east * Math.cos(h) - north * Math.sin(h);
    return ((along - CAR.ahead) / BODY.long) ** 2 + (across / BODY.wide) ** 2 < 1;
  }

  /** Erreur attendue (m) d'un point au sol à la distance d, due à l'inclinaison : c'est la photo où elle est la plus faible
   * qui fournit le point (une voisine sans inclinaison ne sert ainsi qu'à combler). Même calcul dans le dessin (FRAGMENT). */
  const tiltError = (d, pose) => (pose.height * pose.height + d * d) / pose.height * pose.sigma * toRad;

  /** Couche qui fournit le point (est, nord, m depuis la caméra principale), comme render : la plus faible erreur attendue
   * (tiltError, REFLECT fois dans la bande des reflets) parmi celles où il n'est pas sous le corps du véhicule ; sous le
   * corps partout, celle où il est le plus près du bord du véhicule ; null hors de la vue. layers[].at : position de sa caméra. */
  function sourceOf(point, layers) {
    let best = null, bestDist = Infinity, least = null, leastIn = -1;
    if (Math.hypot(...point) > REACH) return null;
    for (const layer of layers) {
      const e = point[0] - layer.at[0], n = point[1] - layer.at[1], d = Math.hypot(e, n), share = layers.length > 1 ? inCar(e, n, layer.pose) : 1;
      if (d > REACH) continue;
      const body = layers.length > 1 && underBody(e, n, layer.pose), score = tiltError(d, layer.pose) * (share < 1 ? REFLECT : 1);
      if (!body && score < bestDist) {
        best = layer;
        bestDist = score;
      } else if (body && share > leastIn) {
        least = layer;
        leastIn = share;
      }
    }
    return best || least;
  }

  /** Axe de la route (vecteur unitaire est, nord) : la trajectoire entre les photos voisines, à défaut le cap de la photo,
   * qui peut s'en écarter de quelques degrés (caméra montée de biais). */
  function roadAxis(layers) {
    const near = layers.slice(1).map((l) => l.at), [e, n] = near.length > 1 ? [near[1][0] - near[0][0], near[1][1] - near[0][1]] : near[0] || [0, 0];
    const length = Math.hypot(e, n), h = layers[0].pose.heading * toRad;
    return length >= 1 ? [e / length, n / length] : [Math.sin(h), Math.cos(h)];
  }

  /** Bande de la zone idéale (BEST), en face de la caméra : un contour fermé de points (est, nord, m). */
  function bestZones(axis) {
    const corner = (along, side) => [along * axis[0] + side * axis[1], along * axis[1] - side * axis[0]];
    return [[[-BEST.along, -BEST.wide], [BEST.along, -BEST.wide], [BEST.along, BEST.wide], [-BEST.along, BEST.wide], [-BEST.along, -BEST.wide]]
      .map(([along, side]) => corner(along, side))];
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

  /** Incertitude affichée pour une longueur entre a et b : voir measureError, sans descendre sous l'écart mesuré (MEASURED). */
  const shownError = (a, b, layers, sigmaGround) => Math.max(measureError(a, b, layers, sigmaGround), MEASURED * Math.hypot(a[0] - b[0], a[1] - b[1]));

  const toLocal = (lon, lat, pose) => [EARTH_RADIUS * (lon - pose.lon) * toRad * Math.cos(pose.lat * toRad),
    EARTH_RADIUS * (lat - pose.lat) * toRad];
  const toLonLat = (east, north, pose) => [pose.lon + east / (EARTH_RADIUS * toRad * Math.cos(pose.lat * toRad)),
    pose.lat + north / (EARTH_RADIUS * toRad)];

  /** Altitude du terrain (voir readTerrain) à (est, nord, m depuis le centre du maillage), depuis le sol au centre. */
  function terrainAt(terrain, east, north) {
    const n = 2 * REACH / STEP + 1, x = Math.min(n - 1.001, Math.max(0, (east + REACH) / STEP)), y = Math.min(n - 1.001, Math.max(0, (north + REACH) / STEP));
    const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, z = (a, b) => terrain[b * n + a] - terrain[(n * n - 1) / 2];
    return (z(i, j) * (1 - u) + z(i + 1, j) * u) * (1 - v) + (z(i, j + 1) * (1 - u) + z(i + 1, j + 1) * u) * v;
  }

  /** Inclinaison d'une caméra sans verticales à lire, le véhicule étant posé sur la route : verticale vraie vue depuis la caméra
   * (voir rotation), la route sous le véhicule étant un plan ajusté sur ±2,5 m en long et ±1,5 m en travers. La route monte devant :
   * la caméra regarde vers le haut et voit la verticale penchée vers l'avant. at : position de la caméra (est, nord, m),
   * heading : cap (degrés), rollShare : part du dévers prise en roulis (le tangage suit la pente entière, voir docs/CALCULS.md),
   * pitch : tangage ajouté (degrés, positif : caméra relevée vers l'avant), défaut de fixation de la caméra. */
  function groundUp(terrain, at, heading, rollShare = 1, pitch = 0) {
    const h = heading * toRad, hu = [Math.sin(h), Math.cos(h)];
    let along = 0, side = 0, aa = 0, ss = 0;
    for (let a = -2.5; a <= 2.5; a += 0.5) {
      for (let s = -1.5; s <= 1.5; s += 0.5) {
        const z = terrainAt(terrain, at[0] + a * hu[0] + s * hu[1], at[1] + a * hu[1] - s * hu[0]);
        along += a * z; side += s * z; aa += a * a; ss += s * s;
      }
    }
    const ga = along / aa + Math.tan(pitch * toRad), gs = rollShare * side / ss, east = ga * hu[0] + gs * hu[1], north = ga * hu[1] - gs * hu[0], length = Math.hypot(east, north, 1);
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
      for (let s = -1.5; s <= 1.5; s += 0.5) { sum += terrainAt(terrain, at[0] + a * hu[0] + s * hu[1], at[1] + a * hu[1] - s * hu[0]); n++; }
    }
    return sum / n;
  }

  /** Altitudes LiDAR HD du maillage (lignes du sud au nord, colonnes d'ouest en est), ou null s'il en manque une ;
   * exception si le service ne répond pas. */
  async function readTerrain(pose, signal) {
    const n = 2 * REACH / STEP + 1, points = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) points.push(toLonLat(-REACH + i * STEP, -REACH + j * STEP, pose));
    }
    const z = [];
    for (let k = 0; k < points.length; k += CHUNK) {  // une requête à la fois : le service limite le débit (HTTP 429)
      const chunk = points.slice(k, k + CHUNK);
      const url = `${ELEVATION_URL}?lon=${chunk.map((p) => p[0].toFixed(7)).join("|")}&lat=${chunk.map((p) => p[1].toFixed(7)).join("|")}`
        + `&resource=${LIDAR_RESOURCE}&zonly=true`;
      for (let attempt = 1; ; attempt++) {
        const response = await fetch(url, { signal });
        if (response.ok) {
          z.push(...(await response.json()).elevations.map(Number));
          break;
        }
        if (attempt === 6 || (response.status !== 429 && response.status < 500)) throw new Error(`HTTP ${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
      }
    }
    return z.length === points.length && z.every((v) => v > -1000) ? smoothTerrain(z) : null;
  }

  // Le MNT s'écarte d'une surface lisse de 1 à 3 cm d'un mètre à l'autre (5 cm au plus sous la chaussée de l'A38) : une bosse
  // Δz sous un point à d de la caméra le déplace de d Δz / H, soit 8 cm à 5 m, et les lignes ondulent. Lissé sur
  // TERRAIN_SMOOTH (gaussienne), la pente, le dévers et le bombement restent. Essai du 07/11/2026 (A38, f9f83571) : écart
  // de la rive à une courbe douce de 3,5 cm (13,7 au plus) à 0,4 cm (0,8 au plus).
  const TERRAIN_SMOOTH = 2;  // m
  /** Maillage lissé : plan moyen gardé tel quel, écarts au plan lissés (pas de biais au bord du maillage). */
  function smoothTerrain(z) {
    const n = 2 * REACH / STEP + 1, xs = [], ys = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { xs.push(i - (n - 1) / 2); ys.push(j - (n - 1) / 2); }
    const plane = leastSquares(xs.map((x, k) => [1, x, ys[k]]), z), at = (k) => plane[0] + plane[1] * xs[k] + plane[2] * ys[k];
    const r = Math.ceil(2.5 * TERRAIN_SMOOTH / STEP), w = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-(((k - r) * STEP / TERRAIN_SMOOTH) ** 2) / 2));
    const pass = (from, dx, dy) => from.map((_, q) => {
      const i = q % n, j = Math.floor(q / n);
      let sum = 0, weight = 0;
      for (let k = -r; k <= r; k++) {
        const ii = i + k * dx, jj = j + k * dy;
        if (ii >= 0 && jj >= 0 && ii < n && jj < n) { sum += from[jj * n + ii] * w[k + r]; weight += w[k + r]; }
      }
      return sum / weight;
    });
    return pass(pass(z.map((v, k) => v - at(k)), 1, 0), 0, 1).map((v, k) => v + at(k));
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
    uniform float wide, masked, heading, top, reach, sure, height, sigma, reflect;
    uniform vec2 body;  // demi-longueur et demi-largeur du corps du véhicule (BODY)
    uniform vec4 fix;  // recalage sur la principale (voir alignJoin) : décalage le long et en travers, tangage, lacet
    uniform vec2 fixMore;  // et échelle, roulis
    uniform int stage;  // 2 : photo seule sans son véhicule, 3 : numéro de la photo gagnante (voir renderBlended)
    uniform float index;
    const float PI = 3.14159265358979;
    void main() {
      vec2 rel = world.xy - camera.xy, f = car.xy, side = vec2(-car.y, car.x);  // repère de la photo : avant, gauche
      float u0 = dot(rel, f), v0 = dot(rel, side);
      vec2 moved = rel + (fix.x + fix.z * (height * height + u0 * u0) / height + fix.w * v0 + fixMore.x * u0 + fixMore.y * u0 * v0 / height) * f
        + (fix.y + fix.z * u0 * v0 / height - fix.w * u0 + fixMore.x * v0 + fixMore.y * (height * height + v0 * v0) / height) * side;
      vec3 ray = vec3(moved, world.z - camera.z);  // shortcut: altitude du point non déplacée (quelques cm de déplacement)
      float dist = length(ray.xy);
      if (dist > reach || length(world.xy - frameCentre) > reach) discard;  // une voisine ne déborde pas du cercle de la vue
      if (abs(dot(world.xy, band.xy)) > band.z || abs(world.x * band.y - world.y * band.x) > band.w) discard;
      float along = (ray.x * car.x + ray.y * car.y - car.z) / car.w, across = (ray.x * car.y - ray.y * car.x) / wide;
      float inCar = along * along + across * across;
      float inBody = pow(along * car.w / body.x, 2.0) + pow(across * wide / body.y, 2.0);
      // sous le corps du véhicule : derrière tout le reste, pris seulement là où aucune photo ne le voit (le plus près du
      // bord) ; dans ses reflets : erreur attendue comptée reflect fois (voir sourceOf)
      float error = (height * height + dist * dist) / height * sigma / 50.0 * (masked > 0.5 && inCar < 1.0 ? reflect : 1.0);
      gl_FragDepth = masked > 0.5 && inBody < 1.0 ? 0.99 - 0.49 * inBody : 0.5 * min(error, 1.0);
      vec3 v = normalize(turn * ray);
      float u = (atan(v.x, v.y) - heading) / (2.0 * PI) + 0.5;
      float a = fract(u), b = fract(u + 0.5) - 0.5;  // la coupure du panorama ne doit pas faire choisir un niveau flou
      float w = ((0.5 - asin(clamp(v.z, -1.0, 1.0)) / PI) - top) / (1.0 - top);
      vec3 c = texture(pano, vec2(fwidth(a) < fwidth(b) ? a : b, w)).rgb;
      // grisé au-delà de sure m de la photo affichée (centre de la vue) : une voisine plus précise peut fournir un point proche
      // d'elle mais à plus de sure m de sa propre caméra (14f7bc5a : taches transparentes à 7 m) ; photo seule : sa caméra
      float far = smoothstep(sure, reach, masked > 0.5 ? length(world.xy - frameCentre) : dist);
      color = vec4(mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), far), 1.0 - 0.5 * far);
      if (stage == 2 && inBody < 1.0) discard;
      if (stage == 3) color = vec4(index / 255.0, 0.0, 0.0, 1.0);
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

  /** Dessine la vue : canevas de size px (SIZE par défaut), nord en haut, ±REACH m autour de la caméra de layers[0]. layers : [{ pano, pose }]
   * (photo principale d'abord) ; terrain : altitudes du maillage (voir readTerrain), ou null pour un plan horizontal ;
   * frame : pose de la photo qui centre l'image et le maillage (par défaut, la principale) ; band : axe de la route (vecteur
   * unitaire est, nord) pour ne garder que la bande de la zone idéale (BEST), ou null. */
  function render(layers, terrain, frame = layers[0].pose, band = null, size = SIZE, stage = 0) {
    const g = context();
    if (g.canvas.width !== size) g.canvas.width = g.canvas.height = size;
    const n = 2 * REACH / STEP + 1, base = terrain ? terrain[(n * n - 1) / 2] : 0;
    const vertices = new Float32Array(3 * n * n);
    for (let j = 0, k = 0; j < n; j++) {
      for (let i = 0; i < n; i++, k++) {
        vertices.set([-REACH + i * STEP, -REACH + j * STEP, terrain ? terrain[k] - base : 0], 3 * k);
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
    g.uniform1f(uniform("reach"), REACH);
    g.uniform1f(uniform("sure"), SURE);
    g.uniform1f(uniform("wide"), CAR.wide);
    g.uniform2f(uniform("body"), BODY.long, BODY.wide);
    g.uniform1f(uniform("reflect"), REFLECT);
    g.uniform1f(uniform("masked"), layers.length > 1 ? 1 : 0);  // photo seule : son véhicule plutôt qu'un trou
    g.uniform1i(uniform("stage"), stage);
    // band : axe de la route [est, nord], et demi-longueur, demi-largeur gardées (par défaut la bande verte)
    g.uniform4f(uniform("band"), band ? band[0] : 0, band ? band[1] : 1, band ? band[2] ?? BEST.along : 1e6, band ? band[3] ?? BEST.wide : 1e6);
    for (const [k, { pano, pose, fix }] of layers.entries()) {
      g.uniform1f(uniform("index"), k + 1);
      const [tu, tv, pitch, yaw, scale, roll] = fix || [0, 0, 0, 0, 0, 0];
      g.uniform4f(uniform("fix"), tu, tv, pitch, yaw);
      g.uniform2f(uniform("fixMore"), scale, roll);
      const m = rotation(pose), [east, north] = toLocal(pose.lon, pose.lat, main), h = pose.heading * toRad;
      g.uniformMatrix3fv(uniform("turn"), false, [0, 1, 2].flatMap((c) => m.map((row) => row[c])));
      g.uniform3f(uniform("camera"), east, north, (terrain ? groundLevel(terrain, [east, north], pose.heading) : 0) + pose.height);
      g.uniform4f(uniform("car"), Math.sin(h), Math.cos(h), CAR.ahead, CAR.long);
      g.uniform1f(uniform("height"), pose.height);
      g.uniform1f(uniform("sigma"), pose.sigma * toRad);
      g.uniform1f(uniform("heading"), pose.heading * toRad);
      g.uniform1f(uniform("top"), pano.top);
      g.bindTexture(g.TEXTURE_2D, pano.texture);
      g.drawElements(g.TRIANGLES, indices.length, g.UNSIGNED_SHORT, 0);
    }
    g.deleteBuffer(vertexBuffer);
    g.deleteBuffer(indexBuffer);
    return g.canvas;
  }

  // Fondu en deux bandes (essai) : la luminosité lente d'une photo dépend de l'angle du soleil, le même sol paraît plus clair
  // sur l'une que sur l'autre (ellipses aux raccords, gain global de 1 à 3 % seulement). Bande basse (LOW px, flou de
  // LOW_SIGMA m) mélangée sur quelques mètres selon les zones gagnantes floutées ; détail fin de la photo gagnante, raccord net.
  const LOW = 256, LOW_SIGMA = 1;
  function renderBlended(layers, terrain, frame = layers[0].pose, band = null, size = SIZE) {
    if (layers.length < 2) return render(layers, terrain, frame, band, size);
    const g = context(), read = () => {
      const px = new Uint8Array(4 * size * size);
      g.readPixels(0, 0, size, size, g.RGBA, g.UNSIGNED_BYTE, px);  // lignes du sud au nord
      return px;
    };
    render(layers, terrain, frame, band, size, 3);
    const winner = read(), alone = layers.map((layer) => { render([layer], terrain, frame, band, size, 2); return read(); });
    render(layers, terrain, frame, band, size);
    const shown = read(), k = size / LOW, r = Math.max(1, Math.round(LOW_SIGMA * LOW / (2 * REACH) / 1.7));  // 3 boîtes : σ ≈ 1,7 r
    const blur = (a) => { let b = a; for (let pass = 0; pass < 3; pass++) b = boxBlur(b, r, LOW); return b; };
    // Bande basse de chaque photo (moyenne sur ses pixels valides) et poids de sa zone gagnante
    const low = layers.map((_, l) => {
      const sums = [0, 1, 2].map(() => new Float32Array(LOW * LOW)), seen = new Float32Array(LOW * LOW), wins = new Float32Array(LOW * LOW);
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          const p = 4 * (j * size + i), q = Math.floor(j / k) * LOW + Math.floor(i / k);
          if (winner[p] === l + 1) wins[q]++;
          if (alone[l][p + 3] < 250) continue;
          seen[q]++;
          for (let c = 0; c < 3; c++) sums[c][q] += alone[l][p + c];
        }
      }
      const m = blur(seen), w = blur(wins);
      return { color: sums.map((s) => blur(s).map((v, q) => (m[q] > 0.05 * k * k ? v / m[q] : NaN))), weight: w.map((v, q) => (m[q] > 0.05 * k * k ? v : 0)) };
    });
    const mixed = [0, 1, 2].map((c) => new Float32Array(LOW * LOW).map((_, q) => {
      let sum = 0, weight = 0;
      for (const { color, weight: w } of low) if (w[q] > 0) { sum += w[q] * color[c][q]; weight += w[q]; }
      return weight ? sum / weight : NaN;
    }));
    const at = (grid, x, y) => {  // bilinéaire, centres des cases basses
      const fx = Math.min(LOW - 1, Math.max(0, x / k - 0.5)), fy = Math.min(LOW - 1, Math.max(0, y / k - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(LOW - 1, x0 + 1), y1 = Math.min(LOW - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      return (grid[y0 * LOW + x0] * (1 - ax) + grid[y0 * LOW + x1] * ax) * (1 - ay) + (grid[y1 * LOW + x0] * (1 - ax) + grid[y1 * LOW + x1] * ax) * ay;
    };
    const out = document.createElement("canvas");
    out.width = out.height = size;
    const image = new ImageData(size, size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const p = 4 * (j * size + i), o = 4 * ((size - 1 - j) * size + i), l = winner[p] - 1;
        for (let c = 0; c < 3; c++) {
          const shift = l >= 0 ? at(mixed[c], i + 0.5, j + 0.5) - at(low[l].color[c], i + 0.5, j + 0.5) : 0;
          image.data[o + c] = Number.isNaN(shift) ? shown[p + c] : shown[p + c] + shift;
        }
        image.data[o + 3] = shown[p + 3];
      }
    }
    out.getContext("2d").putImageData(image, 0, 0);
    return out;
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

  function boxBlur(source, r, n = SIZE) {
    const out = new Float32Array(source.length), pass = (from, to, step, lines, along) => {
      for (let l = 0; l < lines; l++) {
        let sum = 0;
        const at = (k) => from[l * (step === 1 ? n : 1) + Math.min(along - 1, Math.max(0, k)) * step];
        for (let k = -r; k <= r; k++) sum += at(k);
        for (let k = 0; k < along; k++) {
          to[l * (step === 1 ? n : 1) + k * step] = sum / (2 * r + 1);
          sum += at(k + r + 1) - at(k - r);
        }
      }
    };
    const middle = new Float32Array(source.length);
    pass(source, middle, 1, n, n);
    pass(middle, out, n, n, n);
    return out;
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
    return { east: (bx + (inside ? fit(at(bx - 1, by), best, at(bx + 1, by)) : 0)) * M, north: (by + (inside ? fit(at(bx, by - 1), best, at(bx, by + 1)) : 0)) * M,
      ncc: best };
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
          const e = (i + 0.5) * M - REACH, n = (j + 0.5) * M - REACH, al = e * u[0] + n * u[1] - base / 2, ac = Math.abs(e * u[1] - n * u[0]);
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
      const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, g = (a, b) => data[4 * (b * px + a)] + data[4 * (b * px + a) + 1] + data[4 * (b * px + a) + 2];
      return (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v;
    };
  }

  /** Vue d'une photo seule (réglages en cours), même convention que readOrtho. */
  function readView(layer, terrain, frame) {
    const g = context(), rgba = new Uint8Array(4 * SIZE * SIZE);
    render([layer], terrain, frame);
    g.readPixels(0, 0, SIZE, SIZE, g.RGBA, g.UNSIGNED_BYTE, rgba);  // lignes du sud au nord
    const M = 2 * REACH / SIZE;
    return (east, north) => {
      const x = (east + REACH) / M - 0.5, y = (north + REACH) / M - 0.5;
      if (x < 0 || y < 0 || x >= SIZE - 1 || y >= SIZE - 1) return NaN;
      const i = Math.round(x), j = Math.round(y), k = 4 * (j * SIZE + i);
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
  function roadFrame(sample, theta) {
    const ua = [Math.sin(theta), Math.cos(theta)], us = [ua[1], -ua[0]], cols = Math.round(2 * SIDE / 0.02), rows = Math.round(2 * ALONG / GRID);
    const out = [];
    for (let r = 0; r < rows; r++) {
      const a = -ALONG + (r + 0.5) * GRID, row = new Float32Array(cols);
      for (let c = 0; c < cols; c++) {
        const s = -SIDE + (c + 0.5) * 0.02;
        row[c] = sample(a * ua[0] + s * us[0], a * ua[1] + s * us[1]);
      }
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
      for (let c = 0; c < cols; c++) if (inside(c) && c - lag >= 0 && c - lag < cols && !Number.isNaN(pv[c]) && !Number.isNaN(po[c - lag])) pairs.push([pv[c], po[c - lag]]);
      if (pairs.length < 200) return -1;
      const ma = pairs.reduce((t, p) => t + p[0], 0) / pairs.length, mb = pairs.reduce((t, p) => t + p[1], 0) / pairs.length;
      const ab = pairs.reduce((t, p) => t + (p[0] - ma) * (p[1] - mb), 0), aa = pairs.reduce((t, p) => t + (p[0] - ma) ** 2, 0), bb = pairs.reduce((t, p) => t + (p[1] - mb) ** 2, 0);
      return aa && bb ? ab / Math.sqrt(aa * bb) : -1;
    };
    const scores = Array.from({ length: 2 * MAX + 1 }, (_, k) => score(k - MAX)), best = scores.indexOf(Math.max(...scores));
    if (scores[best] < 0.3 || best === 0 || best === 2 * MAX) return null;  // au bord : le vrai maximum est plus loin
    const [a, b, c] = [scores[best - 1], scores[best], scores[best + 1]], dk = (a - c) / (2 * (a - 2 * b + c)) || 0;
    const ua = [Math.sin(theta), Math.cos(theta)];
    return { shift: (best - MAX + dk) * 0.02, us: [ua[1], -ua[0]], score: scores[best] };
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
  // A priori sur la pose relative (écarts types : décalage 0,3 m, angles 1°, échelle 0,5 % ; mesures à 2 cm) : un terme mal
  // déterminé par une zone commune étroite reste près de 0. Échelle tenue serrée : même caméra, même hauteur ; le long de
  // la route, elle se confond presque avec le décalage (a9fd217d, 08/11/2026 : 85 cm et 11 % d'un côté, 3 cm et 2 % dans
  // l'autre sens pour le même raccord, l'image tordue au-delà). Au-delà de JOIN_LIMIT, correction refusée (décalage jusqu'à
  // 1,2 m, la portée de la recherche : GPS décalé de 1 m le long entre deux photos sur la D33 du 04/07/2025). Même ordre que
  // les termes de alignJoin : décalages, tangage, lacet, échelle, roulis
  const JOIN_PRIOR = [0.3, 0.3, toRad, toRad, 0.005, toRad].map((s) => (0.02 / s) ** 2);
  const JOIN_LIMIT = [1.2, 1.2, 3 * toRad, 3 * toRad, 0.06, 3 * toRad];

  /** Photo seule dessinée (réglages en cours, sans recalage) : gris (0-255) passe-haut, sûr (0/1), lignes du sud au nord. */
  function readRaster(layer, terrain, frame) {
    const g = context(), rgba = new Uint8Array(4 * SIZE * SIZE), M = 2 * REACH / SIZE;
    render([{ ...layer, fix: null }], terrain, frame);
    g.readPixels(0, 0, SIZE, SIZE, g.RGBA, g.UNSIGNED_BYTE, rgba);
    const gray = new Float32Array(SIZE * SIZE), safe = new Uint8Array(SIZE * SIZE);
    for (let j = 0, k = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++, k++) {
        gray[k] = (rgba[4 * k] + rgba[4 * k + 1] + rgba[4 * k + 2]) / 3;
        const e = (i + 0.5) * M - REACH - layer.at[0], n = (j + 0.5) * M - REACH - layer.at[1];
        safe[k] = rgba[4 * k + 3] >= 250 && !hidden(e, n, layer.pose) && Math.hypot(e, n) < JOIN_REACH ? 1 : 0;
      }
    }
    let blur = gray;
    for (let pass = 0; pass < 3; pass++) blur = boxBlur(blur, 8);  // presque une gaussienne de 8 px
    return { high: gray.map((v, k) => v - blur[k]), safe };
  }

  /** Transformée de Fourier en place (re, im : Float64Array de longueur 2^n), inverse si invert. */
  function fft(re, im, invert) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = (invert ? 2 : -2) * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const p = i + k, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
          re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
          [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
        }
      }
    }
    if (invert) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  /** En 2D (côté size, puissance de 2), lignes puis colonnes. */
  function fft2(re, im, size, invert) {
    const r = new Float64Array(size), i = new Float64Array(size);
    for (const [step, stride] of [[1, size], [size, 1]]) {
      for (let l = 0; l < size; l++) {
        for (let k = 0; k < size; k++) { r[k] = re[l * stride + k * step]; i[k] = im[l * stride + k * step]; }
        fft(r, i, invert);
        for (let k = 0; k < size; k++) { re[l * stride + k * step] = r[k]; im[l * stride + k * step] = i[k]; }
      }
    }
  }

  // Quadrique ajustée sur 5 x 5 autour d'un pic : [c, gx, gy, hxx/2, hxy, hyy/2]
  const QUAD = [];
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) QUAD.push([1, x, y, x * x, x * y, y * y]);

  /** Décalages de blocs de la principale (a) dans la voisine (b) : [{ p (est, nord, m), dir, d (m) }]. */
  function blockShifts(a, b) {
    const M = 2 * REACH / SIZE, W = BLOCK + 2 * SEARCH, half = BLOCK / 2, out = [];  // W = 128 : puissance de 2
    // Sommes cumulées de la voisine (valeurs et carrés) : normalisation de chaque position en temps constant
    const S1 = new Float64Array((SIZE + 1) * (SIZE + 1)), S2 = new Float64Array((SIZE + 1) * (SIZE + 1));
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const v = b.high[j * SIZE + i], k = (j + 1) * (SIZE + 1) + i + 1;
        S1[k] = v + S1[k - 1] + S1[k - SIZE - 1] - S1[k - SIZE - 2];
        S2[k] = v * v + S2[k - 1] + S2[k - SIZE - 1] - S2[k - SIZE - 2];
      }
    }
    const box = (S, x, y) => S[(y + BLOCK) * (SIZE + 1) + x + BLOCK] - S[y * (SIZE + 1) + x + BLOCK] - S[(y + BLOCK) * (SIZE + 1) + x] + S[y * (SIZE + 1) + x];
    const share = (safe, x0, y0, n) => { let s = 0; for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) s += safe[y * SIZE + x]; return s / (n * n); };
    for (let cy = SEARCH + half; cy < SIZE - SEARCH - half; cy += BLOCK_STEP) {
      for (let cx = SEARCH + half; cx < SIZE - SEARCH - half; cx += BLOCK_STEP) {
        const x0 = cx - half, y0 = cy - half;
        if (share(a.safe, x0, y0, BLOCK) < 0.95 || share(b.safe, x0 - SEARCH, y0 - SEARCH, W) < 0.95) continue;
        let mean = 0;
        for (let y = 0; y < BLOCK; y++) for (let x = 0; x < BLOCK; x++) mean += a.high[(y0 + y) * SIZE + x0 + x];
        mean /= BLOCK * BLOCK;
        const tr = new Float64Array(W * W), ti = new Float64Array(W * W), wr = new Float64Array(W * W), wi = new Float64Array(W * W);
        let norm = 0;
        for (let y = 0; y < BLOCK; y++) for (let x = 0; x < BLOCK; x++) { const v = a.high[(y0 + y) * SIZE + x0 + x] - mean; tr[y * W + x] = v; norm += v * v; }
        if (Math.sqrt(norm / (BLOCK * BLOCK)) < 4) continue;  // sans texture
        for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) wr[y * W + x] = b.high[(y0 - SEARCH + y) * SIZE + x0 - SEARCH + x];
        fft2(tr, ti, W, false);
        fft2(wr, wi, W, false);
        for (let k = 0; k < W * W; k++) {  // fenêtre fois conjugué du gabarit : corrélation
          const r = wr[k] * tr[k] + wi[k] * ti[k], i = wi[k] * tr[k] - wr[k] * ti[k];
          wr[k] = r; wi[k] = i;
        }
        fft2(wr, wi, W, true);
        const side = 2 * SEARCH + 1, c = new Float64Array(side * side);
        let top = -2, ky = 0, kx = 0;
        for (let y = 0; y < side; y++) {
          for (let x = 0; x < side; x++) {
            const px = x0 - SEARCH + x, py = y0 - SEARCH + y, s1 = box(S1, px, py), s2 = box(S2, px, py);
            const v = wr[y * W + x] / Math.sqrt(Math.max(s2 - s1 * s1 / (BLOCK * BLOCK), 1e-9) * norm);
            c[y * side + x] = v;
            if (v > top) { top = v; ky = y; kx = x; }
          }
        }
        if (top < 0.4 || kx < 2 || ky < 2 || kx > side - 3 || ky > side - 3) continue;
        const z = [];
        for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) z.push(c[(ky + y) * side + kx + x]);
        const q = leastSquares(QUAD, z);
        if (!q) continue;
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
      }
    }
    return out;
  }

  /** Moindres carrés (lignes X, valeurs y, a priori ridge ajouté à la diagonale), par les équations normales, ou null. */
  function leastSquares(X, y, ridge = null) {
    const n = X[0].length, A = Array.from({ length: n }, (_, i) => [...Array.from({ length: n }, (_, j) => X.reduce((t, r) => t + r[i] * r[j], 0) + (ridge && i === j ? ridge[i] : 0)), X.reduce((t, r, k) => t + r[i] * y[k], 0)]);
    for (let c = 0; c < n; c++) {
      const p = A.slice(c).reduce((b, r, k) => (Math.abs(r[c]) > Math.abs(A[b][c]) ? c + k : b), c);
      [A[c], A[p]] = [A[p], A[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
    }
    return A.map((r, i) => r[n] / r[i]);
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
      return [pu, pv, (H * H + u * u) / H * pu + u * v / H * pv, v * pu - u * pv, u * pu + v * pv, u * v / H * pu + (H * H + v * v) / H * pv];
    };
    const X = obs.map(row), y = obs.map((o) => o.d), test = obs.map((o) => Math.abs(o.p[0] * ax[0] + o.p[1] * ax[1] - seam) < SEAM);
    let keep = test.map((t) => !t), w = null;
    for (let pass = 0; pass < 4; pass++) {
      if (keep.filter(Boolean).length < 16) return null;
      w = leastSquares(X.filter((_, k) => keep[k]), y.filter((_, k) => keep[k]), JOIN_PRIOR);
      if (!w) return null;
      const r = y.map((v, k) => v - X[k].reduce((t, x, i) => t + x * w[i], 0));
      const sd = 1.4826 * median(r.filter((_, k) => keep[k]).map(Math.abs)) + 0.005;
      keep = keep.map((on, k) => on && Math.abs(r[k]) < 3 * sd);  // mauvaises correspondances écartées
    }
    const checked = obs.map((o, k) => [Math.abs(o.d), Math.abs(o.d - X[k].reduce((t, x, i) => t + x * w[i], 0))]).filter((_, k) => test[k]);
    if (checked.length < 3) return null;
    const before = median(checked.map((c) => c[0])), after = median(checked.map((c) => c[1]));
    const sane = w.every((v, i) => Math.abs(v) <= JOIN_LIMIT[i]);
    return { fix: after < before && sane ? w : null, before, after, n: obs.length, w };
  }

  /** Recalage de chaque voisine sur la principale : Map (photo -> fix), et le bilan affiché. */
  async function alignJoins() {
    const mine = shown, [main, ...others] = readyLayers(), key = joinKey(), begun = performance.now();
    mine.joining = true;
    say("Raccords en cours…");
    await new Promise((resolve) => setTimeout(resolve));  // l'image déjà faite s'affiche d'abord
    const joins = new Map(), results = [];
    try {
      if (shown === mine && others.length) {
        const ax = roadAxis([main, ...others]), raster = readRaster(main, mine.terrain, main.pose);
        for (const other of others) {
          await new Promise((resolve) => setTimeout(resolve));
          if (shown !== mine) return;
          const found = alignJoin(main, other, [raster, readRaster(other, mine.terrain, main.pose)], ax);
          if (found?.fix) joins.set(other.pose.pic, found.fix);
          results.push(found);
        }
      }
    } catch (error) {
      console.warn("Raccords de la vue du dessus :", error);  // l'image reste sans recalage
    } finally {
      mine.joining = false;
    }
    if (shown !== mine) return;
    if (learnPitch(main, others, results)) return showImage();  // tangage de la séquence changé : raccords refaits avec lui
    const done = results.filter((r) => r?.fix), cm = (v) => number(100 * v, 1);
    mine.joins = { key, map: joins, results, seams: new Map(others.map((o, k) => [o.pose.pic, results[k]])), ms: performance.now() - begun };
    mine.joinText = !others.length ? "" : done.length
      ? `raccords recalés ${done.length}/${others.length} (écart ${done.map((r) => `${cm(r.before)} → ${cm(r.after)}`).join(", ")} cm)`
      : `raccords non recalés (${results.some(Boolean) ? "sans gain sûr" : "pas assez de sol net en commun"})`;
    await showImage();
  }
  // Réglages dont dépend le recalage : à refaire s'ils changent
  const joinKey = () => JSON.stringify([rollShare, pitchOffset, readyLayers().map((l) => [l.pose.pic, l.pose.height])]);

  // Sur la mini-carte -----------------------------------------------------------------------
  let map = null, shown = null;  // shown : { pic, sequence, height, estimated, estimating, key, pose, features, panos (photo -> texture), loading, terrain, sigmaGround, terrainFailed, url }
  // Image décalée en travers pour se poser sur l'orthophoto (option d'essai, voir locate) : le GPS est à suspecter avant elle
  // (D33 : séquence du 04/07/2025 décalée de 0,75 m, celle du 20/06/2025 sur l'orthophoto à 2 cm près)
  let positionOn = true;
  const SHIFT_MIN = 0.3;  // m : écart en deçà duquel la position GPS est gardée (lignes repérées à quelques cm, orthophoto à 20 cm)
  // Photos voisines (interrupteur « Véhicule masqué », éteint par défaut) : lues, analysées, dessinées sous le véhicule et
  // recalées sur la principale (alignJoin), tangage de la séquence lu sur les raccords ; sinon la photo affichée seule
  let neighboursOn = false;
  let abort = null, measuringOn = false, bandOnly = false, bandShown = true, fine = false, blendOn = false, start = null, hover = null, live = null;  // live : longueur affichée au pointeur
  // Roulis (part du dévers) et tangage ajouté (degrés), réglés à la main (options d'essai) et retenus par séquence dans le
  // navigateur : la fixation de la caméra ne change pas au cours d'une séquence (A38 du 09/10/2025 : même tangage à deux endroits)
  const DEFAULT_ROLL = 0.7, DEFAULT_PITCH = 0, SETTINGS_KEY = "web-measures/dessus-reglages";
  let rollShare = DEFAULT_ROLL, pitchOffset = DEFAULT_PITCH, pitchManual = false;  // pitchManual : tangage réglé à la main
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
    if (pose && !pose.bridge && pose.relative_sigma <= 0.05 && pose.height >= MIN_HEIGHT && pose.height <= MAX_HEIGHT && !(pose.pic in kept)) {
      kept[pose.pic] = Math.round(pose.height * 1000) / 1000;
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
    if (rollShare === DEFAULT_ROLL && !pitchManual) delete all[shown.sequence];
    else all[shown.sequence] = { roll: rollShare, ...(pitchManual ? { pitch: pitchOffset } : {}) };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(all)); } catch { /* sans stockage : pour cette page seulement */ }
  }
  /** Réglage retenu pour la séquence (ou par défaut ; tangage : à la main, sinon celui des raccords), curseurs compris. */
  function applySettings(sequence) {
    const kept = readSettings()[sequence], auto = sequencePitch(sequence);
    rollShare = kept?.roll ?? DEFAULT_ROLL;
    pitchManual = kept?.pitch !== undefined;
    pitchOffset = pitchManual ? kept.pitch : auto ? auto.pitch : DEFAULT_PITCH;
    $("#dessus-devers").value = Math.round(rollShare * 100);
    $("#dessus-devers-valeur").textContent = `${Math.round(rollShare * 100)} %`;
    showPitch();
  }
  const showPitch = () => {
    $("#dessus-tangage").value = pitchOffset;
    $("#dessus-tangage-valeur").textContent = `${pitchOffset > 0 ? "+" : ""}${number(pitchOffset, 1)}°`;
  };

  // Tangage de fixation de la caméra lu sur les raccords : une erreur de tangage commune aux photos y paraît comme une échelle
  // de signe opposé devant et derrière (environ 1,8 L / H par radian, L : écart entre photos ; avant moins arrière). Retenu par
  // photo dans le navigateur, la médiane sert à la séquence, comme la hauteur. Essai du 08/11/2026 : stable par séquence
  // (+0,45 à +0,57°, +0,27 à +0,49°, -0,13 à -0,38° sur trois séquences), proche de 0 sur les photos calées par leurs verticales.
  const PITCHES_KEY = "web-measures/dessus-tangages", PITCH_STEP = 0.1;  // degrés : écart en deçà duquel la vue n'est pas refaite
  const readPitches = () => {
    try { return JSON.parse(localStorage.getItem(PITCHES_KEY)) || {}; } catch { return {}; }
  };
  /** Tangage de la séquence lu sur les raccords : { pitch (degrés, au 0,05° près), count }, ou null. */
  function sequencePitch(sequence) {
    const values = Object.values(readPitches()[sequence] || {});
    return values.length ? { pitch: Math.round(median(values) * 20) / 20, count: values.length } : null;
  }
  /** Tangage de la photo affichée lu sur ses deux raccords (results d'alignJoin, others : voisines), retenu pour la séquence ;
   * vrai si le tangage de la séquence change assez pour refaire la vue. */
  function learnPitch(main, others, results) {
    const both = others.map((other, k) => ({ other, r: results[k] })).filter(({ r }) => r && r.after < r.before);
    if (both.length !== 2 || !main.pose.groundTilt || !others.every((o) => o.pose.groundTilt)) return false;
    const h = main.pose.heading * toRad, along = both.map(({ other }) => other.at[0] * Math.sin(h) + other.at[1] * Math.cos(h));
    if (along[0] * along[1] >= 0) return false;  // une voisine devant, une derrière
    const [front, back] = along[0] > 0 ? both : [both[1], both[0]], L = (Math.abs(along[0]) + Math.abs(along[1])) / 2;
    const residual = (front.r.w[4] - back.r.w[4]) / (1.8 * L / main.pose.height) / toRad;
    const all = readPitches(), kept = all[shown.sequence] || {};
    kept[main.pose.pic] = Math.round((pitchOffset + residual) * 100) / 100;
    const pics = Object.keys(kept);
    if (pics.length > 60) delete kept[pics[0]];  // les plus anciennes d'abord
    all[shown.sequence] = kept;
    try { localStorage.setItem(PITCHES_KEY, JSON.stringify(all)); } catch { /* sans stockage : pour cette page seulement */ }
    const auto = sequencePitch(shown.sequence);
    if (pitchManual || Math.abs(auto.pitch - pitchOffset) < PITCH_STEP) return false;
    pitchOffset = auto.pitch;
    showPitch();
    return true;
  }
  let swapViews = () => {};  // échange de la carte et de la visionneuse (app.js)
  // Dans la carte d'abord : détachée, elle est dans le document d'une autre fenêtre
  const $ = (selector) => map?.getContainer().querySelector(selector) || document.querySelector(selector);
  const number = (v, digits) => v.toFixed(digits).replace(".", ",");
  const say = (text) => { $("#dessus-etat").textContent = text; };

  const busy = () => shown.estimating || shown.joining || shown.locating || shown.pose.pending
    || (neighboursOn && (shown.features === null || shown.loading.size > 0 || shown.pose.neighbours.some((p) => p.pending)));
  /** Photos prêtes à dessiner, la principale d'abord (seule sans « Véhicule masqué »). */
  const readyLayers = () => [shown.pose, ...(neighboursOn ? shown.pose.neighbours.filter((p) => !p.pending) : [])]
    .filter((pose) => shown.panos.has(pose.pic))
    .map((pose) => {
      const at = toLocal(pose.lon, pose.lat, shown.pose);
      const leveled = pose.up || !shown.terrain ? pose : { ...pose, up: groundUp(shown.terrain, at, pose.heading, rollShare, pitchOffset),
        sigma: Math.hypot(Math.min(pose.sigma, GROUND_SIGMA), LEAN * (shown.lateral || 0)), groundTilt: true };  // virage : véhicule penché
      const seam = shown.joins && shown.joins.key === shown.joinKeyNow ? shown.joins.seams?.get(pose.pic) : undefined;  // raccord de la voisine
      const fix = neighboursOn && shown.joins && shown.joins.key === shown.joinKeyNow ? shown.joins.map.get(pose.pic) : undefined;
      // hauteur : décalage entre photos, sinon RTK moins le sol (de la séquence, ou de la photo)
      const height = shown.height && shown.pose.fleet ? { height: mountOf(shown.height), height_sigma: MOUNT_SIGMA }  // CD21 : la monture
        : shown.height ? { height: shown.height, height_sigma: HEIGHT_SIGMA }
        : { height: shown.sequenceHeight?.height ?? leveled.height, height_sigma: Math.max(leveled.height_sigma, RTK_SIGMA) };
      return { pose: { ...leveled, ...height }, pano: shown.panos.get(pose.pic), at, fix, seam };
    });

  /** Mode « Longueur sur la carte » (app.js) : curseur, carte et visionneuse échangées, sans toucher au zoom. */
  function setMeasuring(on) {
    if (on === measuringOn) return;
    measuringOn = on;
    start = null;
    map.getCanvas().style.cursor = on ? "crosshair" : "";
    swapViews(on);  // carte en grand ; son cadrage et son zoom ne bougent pas
    drawTrace();
  }

  /** Longueur du départ au point (lon, lat) : { length, error, photos }. Un bout hors de la vue (contrôle sur le fond de
   * carte, l'orthophoto) : longueur sur la carte seule, sans incertitude (error null) ni photo. */
  /** Décalage de l'image (est, nord, m) : celui de l'orthophoto si l'option est cochée. */
  const shiftOf = () => (positionOn && shown?.shift && Math.hypot(...shown.shift) > SHIFT_MIN ? shown.shift : [0, 0]);
  /** Point de la carte dans le repère de la photo (est, nord, m), image décalée comprise. */
  const localOf = (point) => { const [e, n] = toLocal(...point, shown.pose), [de, dn] = shiftOf(); return [e - de, n - dn]; };
  function lengthTo(point) {
    const layers = readyLayers(), a = localOf(start), b = localOf(point);
    const la = sourceOf(a, layers), lb = sourceOf(b, layers), length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!la || !lb) return { length, error: null, photos: "" };
    return { length, error: shownError(a, b, layers, shown.sigmaGround), photos: [...new Set([la.pose.pic, lb.pose.pic])].join(",") };
  }
  const lengthText = ({ length, error }) => `${number(length, 2)} m ${error === null ? "(hors vue)" : `±${number(error, 2)}`}`;

  /** Segment en cours de tracé : départ, trait jusqu'au pointeur et sa longueur. Les longueurs faites sont dessinées
   * avec les autres mesures (App.map_geojson). */
  function drawTrace() {
    const data = { type: "FeatureCollection", features: start ? [
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: start } },
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [start, hover || start] } }] : [] };
    if (!map.getSource(LINE_ID)) {
      map.addSource(LINE_ID, { type: "geojson", data });
      map.addLayer({ id: LINE_ID, type: "line", source: LINE_ID, filter: ["==", "$type", "LineString"], paint: { "line-color": "#e53935", "line-width": 2, "line-dasharray": [3, 2] } });
      map.addLayer({ id: `${LINE_ID}-points`, type: "circle", source: LINE_ID, filter: ["==", "$type", "Point"],
        paint: { "circle-radius": 3, "circle-color": "#e53935", "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
    } else {
      map.getSource(LINE_ID).setData(data);
    }
    const found = start && hover && shown ? lengthTo(hover) : null;
    if (!found) {
      live?.remove();
      live = null;
      return;
    }
    if (!live) {
      const element = Object.assign(document.createElement("div"), { className: "dessus-etiquette" });
      live = new maplibregl.Marker({ element, offset: [0, -14] });
    }
    live.getElement().textContent = lengthText(found);
    live.setLngLat(hover).addTo(map);
  }

  function setup(theMap, swap) {
    map = theMap;
    swapViews = swap;
    map.on("mousemove", (event) => {
      hover = [event.lngLat.lng, event.lngLat.lat];
      if (measuringOn && start) drawTrace();
    });
    const pitch = $("#dessus-tangage"), degrees = (v) => `${v > 0 ? "+" : ""}${number(Number(v), 1)}°`;
    pitch.addEventListener("input", () => { $("#dessus-tangage-valeur").textContent = degrees(pitch.value); });
    pitch.addEventListener("change", () => {
      pitchOffset = Number(pitch.value);
      pitchManual = true;
      keepSettings();
      if (shown?.url) showImage();
    });
    const share = $("#dessus-devers");
    share.addEventListener("input", () => { $("#dessus-devers-valeur").textContent = `${share.value} %`; });
    share.addEventListener("change", () => {  // au lâcher : une image par réglage
      rollShare = share.value / 100;
      keepSettings();
      if (shown?.url) showImage();
    });
    $("#dessus-position").addEventListener("change", (event) => {
      positionOn = event.target.checked;
      cancelStart();  // le départ a été pris dans l'autre position
      if (shown?.url) showImage();
    });
    $("#dessus-replier").addEventListener("click", (event) => {
      const folded = $("#dessus-reglages").classList.toggle("replie");
      event.currentTarget.setAttribute("aria-expanded", String(!folded));
      event.currentTarget.textContent = folded ? "▾" : "▴";
      event.currentTarget.title = folded ? "Déplier les réglages" : "Replier les réglages";
    });
    $("#dessus-voisines").addEventListener("change", (event) => {
      neighboursOn = event.target.checked;
      if (shown) loadNeighbours(abort.signal);
      cancelStart();  // le départ a été pris sur l'autre image
      if (shown?.url) showImage();
    });
    $("#dessus-bande").addEventListener("change", (event) => {
      bandOnly = event.target.checked;
      if (shown?.url) showImage();
    });
    $("#dessus-vert").addEventListener("change", (event) => {
      bandShown = event.target.checked;
      if (map.getLayer(BEST_ID)) map.setLayoutProperty(BEST_ID, "visibility", bandShown ? "visible" : "none");
    });
    $("#dessus-fine").addEventListener("change", (event) => {
      fine = event.target.checked;
      if (shown?.url) showImage();
    });
    $("#dessus-fondu").addEventListener("change", (event) => {
      blendOn = event.target.checked;
      if (shown?.url) showImage();
    });
  }

  /** Clic sur la carte en mesure : départ, puis arrivée. Renvoie la longueur faite { a, b ([lon, lat]), length, error (m, null
   * hors de la vue), photos }, sinon null (départ posé, ou arrivée sur le départ refusée). */
  function addPoint(lngLat) {
    const point = [lngLat.lng, lngLat.lat];
    if (!start) {
      start = point;
      drawTrace();
      return null;
    }
    const done = { a: start, b: point, ...lengthTo(point) };
    if (done.length < 0.05) return null;  // second clic au même endroit : départ gardé
    start = null;
    drawTrace();
    return done;
  }

  /** Départ posé, pas encore d'arrivée : retiré (Échap, Effacer). Faux s'il n'y en avait pas. */
  function cancelStart() {
    if (!start) return false;
    start = null;
    drawTrace();
    return true;
  }

  /** Image et bande verte retirées de la carte ; la vue (photos, calculs) reste. */
  function removeImage() {
    if (map.getLayer(BEST_ID)) map.removeLayer(BEST_ID);
    if (map.getSource(BEST_ID)) map.removeSource(BEST_ID);
    if (map.getLayer(IMAGE_ID)) map.removeLayer(IMAGE_ID);
    if (map.getSource(IMAGE_ID)) map.removeSource(IMAGE_ID);
  }
  /** Vue jetée : image et photos libérées (mémoire graphique). */
  function forget(view) {
    if (view?.url) URL.revokeObjectURL(view.url);
    view?.panos.forEach((pano) => gl.deleteTexture(pano.texture));
  }
  // Bird Eye éteinte : la dernière vue gardée (photos, terrain, hauteur, raccords, position) pour la rallumer sur la même
  // photo sans rien refaire, le temps de la session ; jetée dès qu'une autre photo est montrée
  let parked = null;
  // Calculs des photos déjà vues dans la session (photo -> terrain, hauteur lue, raccords, position), repris en y revenant ; les photos
  // elles-mêmes sont relues (mémoire graphique). Raccords : gardés pour les mêmes réglages et voisines (voir joinKey)
  const computed = new Map(), COMPUTED_MAX = 200;
  function remember(view) {
    if (!view?.panos.has(view.pic)) return;  // photo et terrain pas encore lus
    computed.delete(view.pic);
    computed.set(view.pic, { terrain: view.terrain, terrainFailed: view.terrainFailed, estimated: view.estimated && !view.estimating, joins: view.joins, joinText: view.joinText, shift: view.shift, located: view.located, lateral: view.lateral });
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
  // Photos du CD21 (pose.fleet) : imajbox sur Clio 5, deux montures, la caméra ne bouge plus une fois montée. Hauteurs lues entre
  // photos sur 36 vues (08/11/2026) : 1,90 à 1,95 m du 28/05 au 23/06/2025, 2,05 à 2,07 m le 03/07 (2,15 le 07/07 ; dispersé en
  // octobre, 2,04 à 2,34 m) ; l'altitude RTK moins le sol reste vers 2,05-2,10 m tout du long (antenne fixe, caméra plus basse
  // sur la première monture). La séquence prend la monture la plus proche de sa hauteur lue, même par la seule inclinaison de
  // la route (verticales et route concordent au cm près là où les deux existent). shortcut: hauteurs à remplacer par celles
  // mesurées sur les véhicules (campagne suivante)
  const MOUNTS = [1.93, 2.07], MOUNT_SIGMA = 0.04;
  const mountOf = (h) => MOUNTS.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
  let drawing = 0;  // dernier dessin demandé : l'image d'un dessin dépassé est jetée
  async function showImage() {
    shown.joinKeyNow = joinKey();  // recalage des raccords valable pour ces réglages seulement
    const layers = readyLayers(), pose = shown.pose, mine = ++drawing, axis = roadAxis(layers);
    // découpée à 90° dans le prolongement des grands côtés de la bande verte : rien de plus loin de la route ; « Bande verte
    // seule » : la bande
    const canvas = (blendOn ? renderBlended : render)(layers, shown.terrain, layers[0].pose, bandOnly ? axis : [...axis, 1e6, BEST.wide], fine ? FINE_SIZE : SHOWN_SIZE);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (mine !== drawing || !shown) return;
    const old = shown.url, url = shown.url = URL.createObjectURL(blob);
    // Sous les mesures de la page (source « mesures », src/carte.js) et le tracé en cours ; le reste de la carte reste dessous
    const below = map.getStyle().layers.find((l) => l.source === "mesures" || l.id === LINE_ID)?.id;
    const [de, dn] = shiftOf(), placed = (e, n) => toLonLat(e + de, n + dn, pose);
    const coordinates = [[-REACH, REACH], [REACH, REACH], [REACH, -REACH], [-REACH, -REACH]].map(([e, n]) => placed(e, n));
    if (map.getSource(IMAGE_ID)) {
      map.getSource(IMAGE_ID).updateImage({ url, coordinates });
    } else {
      map.addSource(IMAGE_ID, { type: "image", url, coordinates });
      map.addLayer({ id: IMAGE_ID, type: "raster", source: IMAGE_ID, paint: { "raster-fade-duration": 0 } }, below);
    }
    if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
    const zones = { type: "Feature", properties: {}, geometry: { type: "MultiPolygon",
      coordinates: bestZones(roadAxis(layers)).map((ring) => [ring.map(([e, n]) => placed(e, n))]) } };
    if (map.getSource(BEST_ID)) {
      map.getSource(BEST_ID).setData(zones);
    } else {
      map.addSource(BEST_ID, { type: "geojson", data: zones });
      map.addLayer({ id: BEST_ID, type: "fill", source: BEST_ID, paint: { "fill-color": "#00c853", "fill-opacity": 0.12 }, layout: { visibility: bandShown ? "visible" : "none" } }, below);
    }
    const place = shown.terrain ? "Terrain LiDAR HD" : `Sol supposé plat (${pose.bridge ? "pont à proximité, LiDAR HD écarté" : shown.terrainFailed ? "service d'altitude injoignable" : "pas de LiDAR HD ici"})`;
    const auto = !pitchManual && pitchOffset ? sequencePitch(shown.sequence) : null;
    const tilt = pose.pending ? "inclinaison en calcul" : pose.up ? `inclinaison ±${number(pose.sigma, 1)}°` : layers[0].pose.groundTilt ? `inclinaison de la route (roulis à ${Math.round(rollShare * 100)} % du dévers${LEAN * (shown.lateral || 0) >= 0.5 ? `, virage : véhicule penché jusqu'à ${number(LEAN * shown.lateral, 1)}°` : ""}${pitchOffset || pitchManual ? `, tangage ${pitchOffset > 0 ? "+" : ""}${number(pitchOffset, 1)}°` : ""}${pitchManual ? " réglé à la main" : auto ? ` lu sur les raccords (${auto.count} photo${auto.count > 1 ? "s" : ""})` : ""}${readSettings()[shown.sequence]?.roll !== undefined && rollShare !== DEFAULT_ROLL ? ", roulis de la séquence" : ""}), ±${number(layers[0].pose.sigma, 1)}°` : `sans inclinaison, ±${number(pose.sigma, 1)}°`;
    const others = shown.terrain || !neighboursOn ? 0 : pose.neighbours.filter((p) => !p.up && !p.pending).length;
    say(`${place}, ${layers.length} photo${layers.length > 1 ? "s" : ""}, ${tilt}${others ? ` (${others} voisine${others > 1 ? "s" : ""} sans inclinaison)` : ""}, caméra à ${number(layers[0].pose.height, 2)} m${shown.height && shown.pose.fleet ? ` (monture ${mountOf(shown.height) === MOUNTS[0] ? "basse" : "haute"}, lue entre photos : ${number(shown.height, 2)} m)` : shown.height ? ` (décalage entre photos${parallaxCount(shown.sequence) > 1 ? `, ${parallaxCount(shown.sequence)} photos de la séquence` : ""})` : shown.sequenceHeight ? ` (séquence, ${shown.sequenceHeight.count} photos)` : ""}${neighboursOn && shown.joinText && shown.joins?.key === shown.joinKeyNow ? ` ; ${shown.joinText}` : ""}${locatedText() ? ` ; ${locatedText()}` : ""}${shown.estimating ? " ; hauteur de caméra en calcul…" : shown.joining ? " ; raccords en cours…" : shown.locating ? " ; position en cours…" : busy() ? " ; photos voisines en cours…" : ""}`);
    if (positionOn && shown.located === undefined && !shown.locating && !pose.pending) locate();  // la principale suffit
    else if (!busy() && !shown.estimated) measureHeight();
    else if (!busy() && neighboursOn && layers.length > 1 && shown.joins?.key !== shown.joinKeyNow) alignJoins();
  }

  /** Écart en travers de la photo principale à l'orthophoto (profils en travers, voir orthoShift), sans toucher au
   * tangage : la vue s'y pose au-delà de SHIFT_MIN (voir shiftOf). */
  async function locate() {
    const mine = shown, [main] = readyLayers();
    mine.locating = true;
    say("Position sur l'orthophoto en cours…");
    try {
      const ortho = await readOrtho(mine.pose, abort.signal);
      if (shown !== mine) return;
      const found = orthoShift(readView(main, mine.terrain, mine.pose), ortho, roadHeading(ortho, mine.pose.heading));
      if (found) mine.shift = [-found.shift * found.us[0], -found.shift * found.us[1]];
      mine.located = found ? Math.abs(found.shift) : null;
    } catch (error) {
      if (abort.signal.aborted) return;
      mine.located = null;  // orthophoto injoignable : position GPS gardée
    } finally {
      mine.locating = false;
    }
    if (shown !== mine) return;
    if (positionOn && mine.located > SHIFT_MIN) cancelStart();  // départ pris sur l'image avant décalage
    await showImage();
  }
  /** Bilan de la position pour la barre d'état. */
  const locatedText = () => (!positionOn || shown.located === undefined ? ""
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
    const found = estimateHeight(main, others, mine.terrain) || (main.pose.fleet && main.pose.up ? estimateHeight(flat(main), others.map(flat), mine.terrain) : null);
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
    if (!neighboursOn) return;
    for (const pose of mine.pose.neighbours) {
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

  /** Vue gardée (parked) remise : les calculs qu'elle avait en cours, interrompus, sont à refaire. */
  function resume() {
    shown = parked;
    parked = null;
    abort = new AbortController();
    if (shown.estimating) shown.estimated = shown.estimating = false;
    shown.joining = shown.locating = false;
    applySettings(shown.sequence);
  }

  /** Photo à montrer (fiche STAC, pose avec ses voisines et fiches des voisines, null s'il faut encore les lire ; photo null
   * pour tout retirer), à chaque changement : ne refait que ce qui a changé. */
  /** Pont à portée (photo dessus ou dessous) : le MNT LiDAR HD n'y donne pas le sol vu (tablier retiré, ou brèche sous la
   * photo). Sol plat ; inclinaison par la route, hauteur entre photos, raccords et position refaits sans lui. */
  function dropTerrain(view) {
    Object.assign(view, { terrain: null, sigmaGround: FLAT_SIGMA, estimated: false, joins: null, joinText: "", located: undefined });
  }

  async function update(photo, pose, features) {
    const key = pose && JSON.stringify([pose, (features || []).map((f) => f.id), features === null]);
    if (key === (shown?.key ?? null)) return;
    cancelStart();  // départ pris sur l'ancienne image
    if (!photo) {
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
      if (vertical(pose) > vertical(shown.pose) && !shown.estimating) shown.estimated = false;  // verticales arrivées : hauteur entre photos refaite
      Object.assign(shown, { key, pose, features });
      if (pose.bridge && shown.terrain) dropTerrain(shown);  // pont connu après le terrain
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
    shown = { photo, pic: photo.id, sequence: photo.collection, height: sequenceParallax(photo.collection), estimated: false, estimating: false, key, pose, features, panos: new Map(), loading: new Set(), terrain: null, sigmaGround: FLAT_SIGMA, terrainFailed: false, url: null };
    const known = computed.get(photo.id);
    if (known) Object.assign(shown, known);  // déjà vue : terrain, raccords et position repris
    if (pose.bridge && shown.terrain) dropTerrain(shown);
    applySettings(photo.collection);
    shown.sequenceHeight = pose.pending ? null : sequenceHeight(photo.collection, pose);
    const mine = shown;
    if (mine.lateral === undefined) {  // virage : incertitude d'inclinaison majorée à son arrivée
      lateralOf(photo, pose, signal).catch(() => 0).then((lateral) => {
        mine.lateral = lateral;
        if (shown === mine && mine.panos.has(mine.pic) && LEAN * lateral >= 0.1) showImage();
      });
    }
    say("Lecture de la photo et du terrain…");
    try {
      const tiles = Video.record(photo, { coords: photo.geometry.coordinates }).tiles;
      const [terrain, part] = await Promise.all([
        known || pose.bridge ? Promise.resolve(shown.terrain) : readTerrain(pose, signal).catch((error) => { console.warn("Terrain de la vue du dessus :", error); mine.terrainFailed = true; return null; }),
        loadPano(tiles, context().getParameter(gl.MAX_TEXTURE_SIZE), signal)]);
      if (shown !== mine) { part.canvas.width = 0; return; }
      mine.terrain = mine.pose.bridge ? null : terrain;  // pont signalé pendant la lecture
      mine.sigmaGround = mine.terrain ? LIDAR_SIGMA : FLAT_SIGMA;
      mine.panos.set(mine.pic, panoTexture(part));
      loadNeighbours(signal);
      await showImage();
    } catch (error) {
      if (!signal.aborted) { console.error(error); say(`Bird Eye impossible : ${error.message}`); }
    }
  }

  return { setup, update, addPoint, cancelStart, setMeasuring, hasStart: () => Boolean(start), measuring: () => measuringOn && Boolean(shown?.url), layersNow: () => shown && { layers: readyLayers(), terrain: shown.terrain, height: shown.height, joins: shown.joins }, view, uncertainty, measureError, shownError, groundUp, roadAxis, bestZones, sourceOf, toLonLat, estimateHeight, render, renderBlended, panoTexture, loadPano, readOrtho, readView, roadHeading, orthoShift, REACH, SIZE };
})();
