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
  const SIZE = 1024;  // px : côté de l'image, soit 3 cm par pixel
  const CHUNK = 150;  // points par requête d'altitude (longueur de l'adresse)
  const CAR = { ahead: 0, long: 4.5, wide: 2.5 };  // m : véhicule étalé sur le sol, centre en avant de la caméra (voir hidden)
  const NEAR_LIMIT = 6144;  // px : largeur des photos voisines, qui ne servent que près de leur caméra (mémoire graphique)
  const BEST = { along: 2, wide: 8 };  // m : zone idéale d'une largeur, en face de la caméra : le tangage y pèse peu
  const MEASURED = 0.05;  // part de la longueur : incertitude affichée au moins égale à l'écart à l'orthophoto (voir docs/CALCULS.md)
  const HEIGHT_SIGMA = 0.05;  // m : hauteur de caméra lue sur le décalage entre photos voisines (essai de 28 paires)
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

  /** Le point (est, nord, m depuis la caméra) est-il caché par le véhicule ? Ellipse dans l'axe de la photo, le toit et le
   * capot s'étalant sur le sol. shortcut: forme relevée sur l'imajbox du CD21, à adapter aux autres véhicules. */
  function hidden(east, north, pose) {
    const h = pose.heading * toRad, along = east * Math.sin(h) + north * Math.cos(h), across = east * Math.cos(h) - north * Math.sin(h);
    return ((along - CAR.ahead) / CAR.long) ** 2 + (across / CAR.wide) ** 2 < 1;
  }

  /** Erreur attendue (m) d'un point au sol à la distance d, due à l'inclinaison : c'est la photo où elle est la plus faible
   * qui fournit le point (une voisine sans inclinaison ne sert ainsi qu'à combler). Même calcul dans le dessin (FRAGMENT). */
  const tiltError = (d, pose) => (pose.height * pose.height + d * d) / pose.height * pose.sigma * toRad;

  /** Couche qui fournit le point (est, nord, m depuis la caméra principale), voir tiltError, parmi celles où il n'est pas
   * caché ; null si aucune. layers[].at : position de sa caméra. */
  function sourceOf(point, layers) {
    let best = null, bestDist = Infinity;
    if (Math.hypot(...point) > REACH) return null;
    for (const layer of layers) {
      const e = point[0] - layer.at[0], n = point[1] - layer.at[1], d = Math.hypot(e, n);
      if (d <= REACH && tiltError(d, layer.pose) < bestDist && !(layers.length > 1 && hidden(e, n, layer.pose))) {
        best = layer;
        bestDist = tiltError(d, layer.pose);
      }
    }
    return best;
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
    return Math.hypot(single(local(a, la), la), single(local(b, lb), lb), la.pose.relative_sigma);
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
    return z.length === points.length && z.every((v) => v > -1000) ? z : null;
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
    uniform float wide, masked, heading, top, reach, sure, height, sigma;
    const float PI = 3.14159265358979;
    void main() {
      vec3 ray = world - camera;
      float dist = length(ray.xy);
      if (dist > reach || length(world.xy - frameCentre) > reach) discard;  // une voisine ne déborde pas du cercle de la vue
      if (abs(dot(world.xy, band.xy)) > band.z || abs(world.x * band.y - world.y * band.x) > band.w) discard;
      float along = (ray.x * car.x + ray.y * car.y - car.z) / car.w, across = (ray.x * car.y - ray.y * car.x) / wide;
      if (masked > 0.5 && along * along + across * across < 1.0) discard;
      gl_FragDepth = min((height * height + dist * dist) / height * sigma / 50.0, 1.0);
      vec3 v = normalize(turn * ray);
      float u = (atan(v.x, v.y) - heading) / (2.0 * PI) + 0.5;
      float a = fract(u), b = fract(u + 0.5) - 0.5;  // la coupure du panorama ne doit pas faire choisir un niveau flou
      float w = ((0.5 - asin(clamp(v.z, -1.0, 1.0)) / PI) - top) / (1.0 - top);
      vec3 c = texture(pano, vec2(fwidth(a) < fwidth(b) ? a : b, w)).rgb;
      float far = smoothstep(sure, reach, dist);
      color = vec4(mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), far), 1.0 - 0.5 * far);
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

  /** Dessine la vue : canevas de SIZE px, nord en haut, ±REACH m autour de la caméra de layers[0]. layers : [{ pano, pose }]
   * (photo principale d'abord) ; terrain : altitudes du maillage (voir readTerrain), ou null pour un plan horizontal ;
   * frame : pose de la photo qui centre l'image et le maillage (par défaut, la principale) ; band : axe de la route (vecteur
   * unitaire est, nord) pour ne garder que la bande de la zone idéale (BEST), ou null. */
  function render(layers, terrain, frame = layers[0].pose, band = null) {
    const g = context(), n = 2 * REACH / STEP + 1, base = terrain ? terrain[(n * n - 1) / 2] : 0;
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
    g.viewport(0, 0, SIZE, SIZE);
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
    g.uniform1f(uniform("masked"), layers.length > 1 ? 1 : 0);  // photo seule : son véhicule plutôt qu'un trou
    g.uniform4f(uniform("band"), band ? band[0] : 0, band ? band[1] : 1, band ? BEST.along : 1e6, band ? BEST.wide : 1e6);
    for (const { pano, pose } of layers) {
      const m = rotation(pose), [east, north] = toLocal(pose.lon, pose.lat, main), h = pose.heading * toRad;
      g.uniformMatrix3fv(uniform("turn"), false, [0, 1, 2].flatMap((c) => m.map((row) => row[c])));
      g.uniform3f(uniform("camera"), east, north, (terrain ? terrainAt(terrain, east, north) : 0) + pose.height);
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

  // Hauteur de la caméra, lue sur le décalage entre photos voisines ------------------------
  // Avec une hauteur fausse dans un rapport k, le sol projeté depuis deux caméras distantes de b se décale de b(1 - k) : le
  // grain de la chaussée le montre, sans donnée extérieure. L'inclinaison commune aux deux photos s'y annule.
  const MIN_NCC = 0.2, MIN_HEIGHT = 1.5, MAX_HEIGHT = 2.6;  // corrélation exigée d'une mesure et hauteurs plausibles (m)
  const median = (list) => {
    if (!list.length) return undefined;
    const sorted = [...list].sort((a, b) => a - b), k = sorted.length >> 1;
    return sorted.length % 2 ? sorted[k] : (sorted[k - 1] + sorted[k]) / 2;
  };

  function boxBlur(source, r) {
    const out = new Float32Array(source.length), pass = (from, to, step, lines, along) => {
      for (let l = 0; l < lines; l++) {
        let sum = 0;
        const at = (k) => from[l * (step === 1 ? SIZE : 1) + Math.min(along - 1, Math.max(0, k)) * step];
        for (let k = -r; k <= r; k++) sum += at(k);
        for (let k = 0; k < along; k++) {
          to[l * (step === 1 ? SIZE : 1) + k * step] = sum / (2 * r + 1);
          sum += at(k + r + 1) - at(k - r);
        }
      }
    };
    const middle = new Float32Array(source.length);
    pass(source, middle, 1, SIZE, SIZE);
    pass(middle, out, SIZE, SIZE, SIZE);
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

  /** Lignes claires (côte en travers, m) : pics du 9e décile le long, rangées choisies par keep(a). */
  function peaks(frame, keep, low) {
    const rows = frame.filter((_, r) => keep(alongOf(r))), cols = frame[0].length;
    const p = smooth(Array.from({ length: cols }, (_, c) => percentile(rows.map((row) => row[c]), 0.9)), 2), found = [];
    for (let c = 25; c < cols - 25; c++) {
      const near = p.slice(c - 25, c + 26).filter((v) => !Number.isNaN(v));
      if (!(p[c] >= low) || near.some((v) => v > p[c])) continue;
      if (p[c] - Math.min(...near) >= 0.8 * low) found.push(sideOf(c));
    }
    return found;
  }

  /** Droite suivie par une ligne autour de la côte s0 : { c (côte à a = 0), m (pente), n }, ou null. */
  function trackLine(frame, s0, keep, low) {
    const points = [], c0 = Math.round((s0 + SIDE) / 0.02 - 0.5), cs = [];
    for (let c = c0 - 17; c <= c0 + 17; c++) if (c >= 0 && c < frame[0].length) cs.push(c);
    for (let a = -11; a <= 11; a += 0.5) {
      if (!keep(a)) continue;
      const rows = frame.filter((_, r) => Math.abs(alongOf(r) - a) < 0.5);
      const pr = smooth(cs.map((c) => percentile(rows.map((row) => row[c]), 0.9)), 2);
      if (pr.some(Number.isNaN) || Math.max(...pr) < low) continue;
      const top = Math.max(...pr);
      let sum = 0, weight = 0;
      pr.forEach((v, k) => { const w = Math.max(0, v - 0.5 * top); sum += w * sideOf(cs[k]); weight += w; });
      points.push([a, sum / weight]);
    }
    const fit = (list) => {
      const n = list.length, ma = list.reduce((t, p) => t + p[0], 0) / n, ms = list.reduce((t, p) => t + p[1], 0) / n;
      const m = list.reduce((t, p) => t + (p[0] - ma) * (p[1] - ms), 0) / list.reduce((t, p) => t + (p[0] - ma) ** 2, 0);
      return { c: ms - m * ma, m, n };
    };
    if (points.length < 6) return null;
    const first = fit(points), kept = points.filter(([a, s]) => Math.abs(s - first.c - first.m * a) < 0.12);
    return kept.length >= 6 ? fit(kept) : null;
  }

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

  /** Écarts d'une photo à l'orthophoto : { pitch (rad, tangage en trop dans la vue), shift (m, en travers, vue moins
   * orthophoto), lines } ou null (moins de deux lignes communes, ou trop proches). layer.at : position de sa caméra. */
  function compareLines(layer, view, ortho, theta, H) {
    const ua = [Math.sin(theta), Math.cos(theta)], us = [ua[1], -ua[0]];
    const ca = layer.at[0] * ua[0] + layer.at[1] * ua[1], cs = layer.at[0] * us[0] + layer.at[1] * us[1];  // caméra dans le repère
    const Do = roadFrame(ortho, theta), Dv = roadFrame(view, theta), seen = (a) => Math.abs(a - ca) > CAR_GAP && Math.abs(a - ca) < 11;
    const fromOrtho = peaks(Do, seen, 3), fromView = peaks(Dv, seen, 6), lines = [];
    for (const so of fromOrtho) {
      const sv = fromView.filter((s) => Math.abs(s - so) < 0.9).sort((x, y) => Math.abs(x - so) - Math.abs(y - so))[0];
      if (sv === undefined || Math.abs(so - cs) > ROAD) continue;  // au-delà de la chaussée : herbe et bordures en relief
      const o = trackLine(Do, so, seen, 3), v = trackLine(Dv, sv, seen, 6);
      if (o && v) lines.push({ s: o.c + o.m * ca - cs, dc: (v.c + v.m * ca) - (o.c + o.m * ca), dm: v.m - o.m });
    }
    if (lines.length < 2 || Math.max(...lines.map((l) => l.s)) - Math.min(...lines.map((l) => l.s)) < 2) return null;
    // Pente relative : cap + tangage x (côte depuis la caméra) / H, ajustés aux moindres carrés
    const n = lines.length, mx = lines.reduce((t, l) => t + l.s / H, 0) / n, my = lines.reduce((t, l) => t + l.dm, 0) / n;
    const pitch = lines.reduce((t, l) => t + (l.s / H - mx) * (l.dm - my), 0) / lines.reduce((t, l) => t + (l.s / H - mx) ** 2, 0);
    return { pitch, shift: median(lines.map((l) => l.dc)), lines: n, us };
  }

  // Sur la mini-carte -----------------------------------------------------------------------
  let map = null, shown = null;  // shown : { pic, sequence, height, estimated, estimating, key, pose, features, panos (photo -> texture), loading, terrain, sigmaGround, terrainFailed, url }
  let positionOn = false;  // image décalée en travers pour se poser sur l'orthophoto (option d'essai, voir calibrate)
  let abort = null, measuringOn = false, bandOnly = false, start = null, hover = null, live = null;  // live : longueur affichée au pointeur
  // Roulis (part du dévers) et tangage ajouté (degrés), réglés à la main (options d'essai) et retenus par séquence dans le
  // navigateur : la fixation de la caméra ne change pas au cours d'une séquence (A38 du 09/10/2025 : même tangage à deux endroits)
  const DEFAULT_ROLL = 0.7, DEFAULT_PITCH = 0, SETTINGS_KEY = "web-measures/dessus-reglages";
  let rollShare = DEFAULT_ROLL, pitchOffset = DEFAULT_PITCH;
  const readSettings = () => {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }  // stockage absent ou illisible
  };
  /** Réglage de la séquence affichée gardé ; les valeurs par défaut ne sont pas gardées. */
  function keepSettings() {
    if (!shown) return;
    const all = readSettings();
    if (rollShare === DEFAULT_ROLL && pitchOffset === DEFAULT_PITCH) delete all[shown.sequence];
    else all[shown.sequence] = { roll: rollShare, pitch: pitchOffset };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(all)); } catch { /* sans stockage : pour cette page seulement */ }
  }
  /** Réglage retenu pour la séquence (ou par défaut), curseurs compris. */
  function applySettings(sequence) {
    const kept = readSettings()[sequence];
    rollShare = kept?.roll ?? DEFAULT_ROLL;
    pitchOffset = kept?.pitch ?? DEFAULT_PITCH;
    $("#dessus-devers").value = Math.round(rollShare * 100);
    $("#dessus-devers-valeur").textContent = `${Math.round(rollShare * 100)} %`;
    $("#dessus-tangage").value = pitchOffset;
    $("#dessus-tangage-valeur").textContent = `${pitchOffset > 0 ? "+" : ""}${number(pitchOffset, 1)}°`;
  }
  let swapViews = () => {}, zoomBefore = null;  // échange de la carte et de la visionneuse (app.js) ; zoom à retrouver
  const $ = (selector) => document.querySelector(selector);
  const number = (v, digits) => v.toFixed(digits).replace(".", ",");
  const say = (text) => { $("#dessus-etat").textContent = text; };

  const busy = () => shown.estimating || shown.pose.pending || shown.features === null || shown.loading.size > 0 || shown.pose.neighbours.some((p) => p.pending);
  /** Photos prêtes à dessiner, la principale d'abord. */
  const readyLayers = () => [shown.pose, ...shown.pose.neighbours.filter((p) => !p.pending)]
    .filter((pose) => shown.panos.has(pose.pic))
    .map((pose) => {
      const at = toLocal(pose.lon, pose.lat, shown.pose);
      const leveled = pose.up || !shown.terrain ? pose : { ...pose, up: groundUp(shown.terrain, at, pose.heading, rollShare, pitchOffset), sigma: Math.min(pose.sigma, GROUND_SIGMA), groundTilt: true };
      return { pose: shown.height ? { ...leveled, height: shown.height, height_sigma: HEIGHT_SIGMA } : leveled, pano: shown.panos.get(pose.pic), at };
    });

  /** Mode « Longueur sur la carte » (app.js) : curseur, carte et visionneuse échangées, cadrage sur la vue. */
  function setMeasuring(on) {
    if (on === measuringOn) return;
    measuringOn = on;
    start = null;
    map.getCanvas().style.cursor = on ? "crosshair" : "";
    swapViews(on);
    if (on && shown) {
      zoomBefore = map.getZoom();
      map.fitBounds([toLonLat(-REACH, -REACH, shown.pose), toLonLat(REACH, REACH, shown.pose)], { padding: 20, animate: false });
    } else if (!on && zoomBefore !== null) {
      map.setZoom(zoomBefore);
      zoomBefore = null;
    }
    drawTrace();
  }

  /** Longueur du départ au point (lon, lat) : { length, error, photos }. Un bout hors de la vue (contrôle sur le fond de
   * carte, l'orthophoto) : longueur sur la carte seule, sans incertitude (error null) ni photo. */
  /** Décalage de l'image (est, nord, m) : celui de l'orthophoto si l'option est cochée. */
  const shiftOf = () => (positionOn && shown?.shift ? shown.shift : [0, 0]);
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

  /** « Caler le tangage sur l'orthophoto » : tangage en trop mesuré sur chaque photo prête (la principale et ses voisines), la
   * médiane ajoutée au réglage de la séquence ; décalage en travers de la principale gardé pour l'option de position. */
  async function calibrate() {
    const mine = shown, button = $("#dessus-caler");
    if (!mine?.url || !mine.terrain) return;
    button.disabled = true;
    say("Calage sur l'orthophoto : lecture et repérage des lignes…");
    try {
      const ortho = await readOrtho(mine.pose), theta = roadHeading(ortho, mine.pose.heading), found = [];
      for (const layer of readyLayers()) {
        await new Promise((resolve) => setTimeout(resolve));  // la page reste à jour entre deux photos
        if (shown !== mine) return;
        const result = compareLines(layer, readView(layer, mine.terrain, mine.pose), ortho, theta, layer.pose.height);
        if (result) found.push({ ...result, main: layer.pose.pic === mine.pic });
      }
      if (!found.length) {
        mine.calibrated = "calage impossible : moins de deux lignes nettes en commun avec l'orthophoto";
      } else {
        const pitches = found.map((f) => f.pitch / toRad), spread = Math.max(...pitches) - Math.min(...pitches);
        pitchOffset = Math.round((pitchOffset - median(pitches)) * 20) / 20;  // tangage en trop dans la vue : retiré
        $("#dessus-tangage").value = pitchOffset;
        $("#dessus-tangage-valeur").textContent = `${pitchOffset > 0 ? "+" : ""}${number(pitchOffset, 1)}°`;
        keepSettings();
        const main = found.find((f) => f.main);
        if (main) mine.shift = [-main.shift * main.us[0], -main.shift * main.us[1]];  // vue posée sur l'orthophoto
        $("#dessus-position").disabled = !mine.shift;
        mine.calibrated = `tangage calé sur l'orthophoto (${found.length} photo${found.length > 1 ? "s" : ""}${found.length > 1 ? `, écart ${number(spread, 2)}°` : ""}${main ? `, décalage ${number(Math.abs(main.shift), 2)} m` : ""})`;
      }
    } catch (error) {
      mine.calibrated = `calage impossible : ${error.message}`;
    } finally {
      button.disabled = false;
    }
    if (shown === mine) await showImage();
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
    $("#dessus-caler").addEventListener("click", calibrate);
    $("#dessus-position").addEventListener("change", (event) => {
      positionOn = event.target.checked;
      cancelStart();  // le départ a été pris dans l'autre position
      if (shown?.url) showImage();
    });
    $("#dessus-bande").addEventListener("change", (event) => {
      bandOnly = event.target.checked;
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

  function removeImage() {
    if (map.getLayer(BEST_ID)) map.removeLayer(BEST_ID);
    if (map.getSource(BEST_ID)) map.removeSource(BEST_ID);
    if (map.getLayer(IMAGE_ID)) map.removeLayer(IMAGE_ID);
    if (map.getSource(IMAGE_ID)) map.removeSource(IMAGE_ID);
    if (shown?.url) URL.revokeObjectURL(shown.url);
    shown?.panos.forEach((pano) => gl.deleteTexture(pano.texture));
  }

  // shortcut: mémorisées pour la session seulement, à garder d'une visite à l'autre si la méthode est retenue
  const heights = new Map();  // séquence -> hauteurs de caméra mesurées (m)
  let drawing = 0;  // dernier dessin demandé : l'image d'un dessin dépassé est jetée
  async function showImage() {
    const layers = readyLayers(), pose = shown.pose, mine = ++drawing, canvas = render(layers, shown.terrain, layers[0].pose, bandOnly ? roadAxis(layers) : null);
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
      map.addLayer({ id: BEST_ID, type: "fill", source: BEST_ID, paint: { "fill-color": "#00c853", "fill-opacity": 0.12 } }, below);
    }
    const place = shown.terrain ? "Terrain LiDAR HD" : `Sol supposé plat (${shown.terrainFailed ? "service d'altitude injoignable" : "pas de LiDAR HD ici"})`;
    const tilt = pose.pending ? "inclinaison en calcul" : pose.up ? `inclinaison ±${number(pose.sigma, 1)}°` : layers[0].pose.groundTilt ? `inclinaison de la route (roulis à ${Math.round(rollShare * 100)} % du dévers${pitchOffset ? `, tangage ${pitchOffset > 0 ? "+" : ""}${number(pitchOffset, 1)}°` : ""}${readSettings()[shown.sequence] ? ", réglage de la séquence" : ""}), ±${number(layers[0].pose.sigma, 1)}°` : `sans inclinaison, ±${number(pose.sigma, 1)}°`;
    const others = shown.terrain ? 0 : pose.neighbours.filter((p) => !p.up && !p.pending).length;
    say(`${place}, ${layers.length} photo${layers.length > 1 ? "s" : ""}, ${tilt}${others ? ` (${others} voisine${others > 1 ? "s" : ""} sans inclinaison)` : ""}, caméra à ${number(layers[0].pose.height, 2)} m${shown.height ? " (décalage entre photos)" : ""}${shown.calibrated ? ` ; ${shown.calibrated}` : ""}${shown.estimating ? " ; hauteur de caméra en calcul…" : busy() ? " ; photos voisines en cours…" : ""}`);
    $("#dessus-caler").disabled = !shown.terrain || busy();  // toutes les photos prêtes, posées sur le terrain
    $("#dessus-position").disabled = !shown.shift;
    if (!busy() && !shown.estimated) measureHeight();
  }

  /** Hauteur de caméra de la séquence, lue une fois toutes les photos prêtes, puis image refaite. */
  async function measureHeight() {
    const mine = shown;
    mine.estimated = mine.estimating = true;
    say("Hauteur de caméra en calcul…");
    await new Promise((resolve) => setTimeout(resolve));  // l'image déjà faite s'affiche d'abord
    if (shown !== mine) return;
    const [main, ...others] = readyLayers(), found = estimateHeight(main, others, mine.terrain);
    const known = heights.get(mine.sequence) || [];
    if (found) heights.set(mine.sequence, [...known, ...found]);
    mine.height = median(heights.get(mine.sequence) || []) ?? null;
    mine.estimating = false;
    await showImage();
  }

  /** Lance la lecture des photos voisines dont l'inclinaison est connue (inutile de les charger avant), à portée. */
  function loadNeighbours(signal) {
    const mine = shown;
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

  /** Photo à montrer (fiche STAC, pose avec ses voisines et fiches des voisines, null s'il faut encore les lire ; photo null
   * pour tout retirer), à chaque changement : ne refait que ce qui a changé. */
  async function update(photo, pose, features) {
    const key = pose && JSON.stringify([pose, (features || []).map((f) => f.id), features === null]);
    if (key === (shown?.key ?? null)) return;
    cancelStart();  // départ pris sur l'ancienne image
    if (!photo) {
      abort?.abort();
      removeImage();
      shown = null;
      say("");
      return;
    }
    if (shown?.pic === photo.id) {  // même photo : inclinaison, hauteur ou voisines arrivées, image refaite
      Object.assign(shown, { key, pose, features });
      loadNeighbours(abort.signal);
      if (shown.panos.has(shown.pic)) await showImage();
      return;
    }
    abort?.abort();
    removeImage();
    const controller = abort = new AbortController(), { signal } = controller;
    shown = { pic: photo.id, sequence: photo.collection, height: median(heights.get(photo.collection) || []) ?? null, estimated: false, estimating: false, key, pose, features, panos: new Map(), loading: new Set(), terrain: null, sigmaGround: FLAT_SIGMA, terrainFailed: false, url: null };
    applySettings(photo.collection);
    const mine = shown;
    say("Lecture de la photo et du terrain…");
    try {
      const tiles = Video.record(photo, { coords: photo.geometry.coordinates }).tiles;
      const [terrain, part] = await Promise.all([
        readTerrain(pose, signal).catch((error) => { console.warn("Terrain de la vue du dessus :", error); mine.terrainFailed = true; return null; }),
        loadPano(tiles, context().getParameter(gl.MAX_TEXTURE_SIZE), signal)]);
      if (shown !== mine) { part.canvas.width = 0; return; }
      mine.terrain = terrain;
      mine.sigmaGround = terrain ? LIDAR_SIGMA : FLAT_SIGMA;
      mine.panos.set(mine.pic, panoTexture(part));
      loadNeighbours(signal);
      await showImage();
    } catch (error) {
      if (!signal.aborted) { console.error(error); say(`Vue du dessus impossible : ${error.message}`); }
    }
  }

  return { setup, update, addPoint, cancelStart, setMeasuring, hasStart: () => Boolean(start), measuring: () => measuringOn && Boolean(shown?.url), layersNow: () => shown && { layers: readyLayers(), terrain: shown.terrain, height: shown.height }, view, uncertainty, measureError, shownError, groundUp, roadAxis, bestZones, sourceOf, toLonLat, estimateHeight, render, panoTexture, loadPano, REACH, SIZE };
})();
