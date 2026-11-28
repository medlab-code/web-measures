// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Analyse fine du profil en travers (bouton « Analyse fine » de la fenêtre du profil) : nuage de points LiDAR HD de
// l'IGN, lu à la volée (dalles COPC, lecture partielle par Range) sur une bande de ±STRIP m le long de la route au
// travers de la photo. Le terrain (MNT) du calcul « Profils » ne voit ni la peinture ni la nature du sol ; l'intensité
// du retour laser des points du sol, si : enrobé sombre, lignes blanches très claires, herbe, gravillons et béton
// clairs. D'où les lignes blanches, l'herbe et le séparateur de chaussée (bande non
// revêtue entre les deux chaussées, glissières comprises). Lecteur repris de l'essai de faisabilité du
// 2026-10-27 (tests/essai-lidar.html, retiré) ; décompression par laz-perf, chargé au premier usage. Le même lecteur
// donne la hauteur de chute d'un pont (bridgeFall) : points classés pont (17), sol (2) et eau (9).

const Nuage = (() => {
  const WFS = "https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&OUTPUTFORMAT=application/json"
    + "&TYPENAMES=IGNF_LIDAR-HD_METADONNEE:metadata";

  /** Dalles du nuage LiDAR HD autour de (lon, lat), à d degrés : métadonnées IGN (WFS). La Géoplateforme renvoie parfois, en
   * passant, autre chose que du JSON (page de statistiques « # HELP jmx… », 20/11/2026 : 5331221f-7a1f-4ace-b4de-9cf94a57e4d2)
   * ou une erreur HTTP : jusqu'à 3 essais, 2 s d'écart, sans le cache HTTP. */
  async function tilesAround(lon, lat, d) {
    let problem = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const response = await fetch(`${WFS}&BBOX=${lat - d},${lon - d},${lat + d},${lon + d},urn:ogc:def:crs:EPSG::4326`,
          attempt ? { cache: "no-store" } : {});
        if (!response.ok) { problem = `HTTP ${response.status}`; continue; }
        const text = await response.text();
        try { return JSON.parse(text).features || []; } catch { problem = "réponse illisible"; }
      } catch (error) { problem = error.message; }
    }
    throw new Error(`nuage LiDAR : le service de l'IGN qui situe les dalles ne répond pas correctement (${problem}, 3 essais) ;`
      + " panne passagère en général, réessayer dans un moment");
  }
  const LAZ = "https://cdn.jsdelivr.net/npm/laz-perf@0.0.7/lib/web/laz-perf.js";
  const HALF = 32, STRIP = 1.0, BIN = 0.25;  // m : ±HALF en travers, ±STRIP le long de la route, cases de BIN m
  const ROAD = 1.6;  // intensité de l'enrobé : sous ROAD fois celle sous l'origine
  const PAINT = 3.0, PAINT_WIDTH = 0.75;  // ligne blanche : au moins PAINT fois l'enrobé, PAINT_WIDTH m de large au plus
  const VERGE = 1.0;  // m : surface non revêtue (herbe, gravillons) d'au moins cette largeur : l'enrobé s'arrête là
  const GRASS = 3.5;  // herbe : bande non revêtue (VERGE m au moins) en moyenne GRASS fois plus claire que l'enrobé (le laser,
  // en proche infrarouge, est très renvoyé par la végétation ; gravillons et béton : 2 à 3 fois)
  // Herbe par la végétation (second critère, relevés du 20/11/2026 : D119E 1d23f3f9-f4b7-4d2e-8658-500a748ccecc droit dès +2,75 m,
  // D33 6c6e4972-f565-4198-84fe-24ab72d95398 droit dès +4,25 m) : part des points d'une case (sol et végétation basse, classes 2 à 5)
  // à retours multiples (NumberOfReturns > 1) ou classés végétation à GRASS_NEAR m au plus du sol de la case : 0 % sur l'enrobé,
  // 29 à 78 % sur l'herbe haute, rien sur l'herbe rase (D16, D70, D115 : relevé d'hiver, 0,6 à 1,9 fois l'enrobé, sans couleur dans
  // le LiDAR HD). Case jugée à partir de GRASS_POINTS points (6 à 18 points du sol par case de 0,25 m sur ±1 m d'habitude).
  const GRASS_SHARE = 0.25, GRASS_POINTS = 8, GRASS_NEAR = 0.5;
  // Ligne blanche : au moins LINE_CONTRAST fois ses cases voisines (D903bis 1640bc3f-e948-4239-a4c1-548dd748a16d :
  // surface du séparateur à 3,0 et
  // 2,9 fois l'enrobé, pas une ligne)
  const LINE_CONTRAST = 2;
  // ligne à tirets vue ailleurs qu'au travers de la photo : sur 2 travers au moins, à 0,5 m près
  const LINE_SECTIONS = 2, LINE_MATCH = 0.5;
  const SECTION_STEPS = [-4, -2, 0, 2, 4];  // m le long de la route : travers de ±STRIP où les tirets sont cherchés
  const SOIL_ALONG = Math.max(...SECTION_STEPS.map(Math.abs)) + STRIP;  // m le long de la route : sol gardé pour ces travers
  const SEPARATOR = [0.5, 12];  // m : largeurs possibles du séparateur, et son milieu à 2 m au plus de celui du calcul
  // Hauteur de chute d'un pont (bridgeHeight, bridgeFall)
  const DECK_CELL = 2;  // m : côté des cases du tablier et du dessous
  const DECK_POINTS = 3;  // points classés pont au moins dans une case du tablier
  const DECK_MIN = 4;  // cases au moins d'un tablier (en deçà : point isolé mal classé)
  const DECK_NEAR = 15;  // m au plus entre la photo et le tablier
  const DECK_REACH = 10;  // m : dessous cherché jusqu'à cette distance du tablier (sous lui et à côté)
  const DECK_JOIN = 12;  // m : cases du tablier encore reliées à cette distance (canal de Bourgogne : 8 m sans point classé pont au milieu)
  const DECK_ROUNDS = 40;  // lectures successives le long du tablier, au plus

  // Lambert 93 (RGF93, EPSG:2154), sens direct (IGN, ALG0001 à ALG0003 ; RGF93 ≈ WGS 84)
  const L93 = { n: 0.7256077650532670, c: 11754255.426096, xs: 700000, ys: 12655612.049876, e: 0.0818191910428158 };
  function toL93(lon, lat) {
    const { n, c, xs, ys, e } = L93, p = lat * Math.PI / 180, s = e * Math.sin(p);
    const r = c * Math.exp(-n * (Math.log(Math.tan(Math.PI / 4 + p / 2)) + e / 2 * Math.log((1 - s) / (1 + s))));
    const g = n * (lon - 3) * Math.PI / 180;
    return [xs + r * Math.sin(g), ys - r * Math.cos(g)];
  }

  // Téléchargement des dalles : 1 requête par seconde au plus (en-tête x-ratelimit-limit-second du serveur). Morceaux lus
  // gardés dans le cache des services géographiques (src/app.js, GEO_CACHE : même taille maximale, même « Vider le
  // cache ») : une dalle publiée ne change plus (nouvelle publication = nouvelle adresse), pas de durée de vie ; un
  // morceau déjà lu revient sans requête ni attente. Le cache HTTP n'y suffit pas : sans ETag, Chrome ne garde pas
  // les réponses partielles (essai du 12/11/2026).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const count = { requests: 0, bytes: 0 };
  let last = 0, store = null;
  // Accès au cache de la page (src/app.js, useGeoCache) : délai borné, abandon partagé ; seul (essais), sans délai
  let openStore = () => (store ??= window.caches ? caches.open("web-measures-geo").catch(() => null) : Promise.resolve(null));
  let cacheStep = (promise) => promise;
  /** Cache des services géographiques ouvert et lu par open() et step(promesse, valeur si elle tarde) de la page. */
  function useGeoCache(open, step) {
    openStore = open;
    cacheStep = step;
  }
  async function range(url, start, length) {
    const key = `${url}?octets=${start}-${start + length - 1}`, cache = await openStore();
    const hit = cache && await cacheStep(cache.match(key).catch(() => undefined), undefined);
    if (hit) return new DataView(await hit.arrayBuffer());
    const view = await download(url, start, length);
    cache?.put(key, new Response(view.buffer.slice(0), { headers: {
      "x-mis-en-cache": String(Date.now()), "x-vide": "0", "x-taille": String(view.byteLength) } }))
      .catch((error) => console.warn("Cache :", error));
    return view;
  }
  async function download(url, start, length) {
    for (let attempt = 0; ; attempt++) {
      const wait = last + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      count.requests++;
      const r = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
      if (r.status === 429 && attempt < 5) { await sleep(2000); continue; }
      if (r.status !== 206) throw new Error(`nuage LiDAR : HTTP ${r.status}`);
      const buffer = await r.arrayBuffer();
      count.bytes += buffer.byteLength;
      return new DataView(buffer);
    }
  }

  // Lecteur COPC minimal : en-tête LAS 1.4, VLR « copc » (info), pages de la hiérarchie, morceaux LAZ
  const tiles = new Map();
  async function openTile(url) {
    if (tiles.has(url)) return tiles.get(url);
    const h = await range(url, 0, 589);  // en-tête (375 octets), en-tête de VLR (54), info COPC (160)
    const f64 = (o) => h.getFloat64(o, true), u64 = (o) => Number(h.getBigUint64(o, true));
    const user = new TextDecoder().decode(new Uint8Array(h.buffer, 377, 16)).replace(/\0.*/, "");
    if (user !== "copc") throw new Error("nuage LiDAR : dalle illisible (pas au format COPC)");
    const tile = {
      url, format: h.getUint8(104) & 0x3f, length: h.getUint16(105, true),
      scale: [f64(131), f64(139), f64(147)], offset: [f64(155), f64(163), f64(171)],
      center: [f64(429), f64(437), f64(445)], half: f64(453), root: [u64(469), u64(477)], pages: new Map(),
    };
    tiles.set(url, tile);
    return tile;
  }

  /** Nœuds non vides (d, x, y, z, offset, taille, points) qui touchent le rectangle box [xmin, ymin, xmax, ymax] et, s'il est
   * donné, strip(x0, y0, côté) : test d'un rectangle tourné (voir stripTest). */
  async function nodesIn(tile, box, strip = null) {
    const out = [];
    const touches = (d, x, y) => {
      const size = 2 * tile.half / 2 ** d, x0 = tile.center[0] - tile.half + x * size, y0 = tile.center[1] - tile.half + y * size;
      return x0 <= box[2] && x0 + size >= box[0] && y0 <= box[3] && y0 + size >= box[1] && (!strip || strip(x0, y0, size));
    };
    async function page(offset, size) {
      const key = offset + ":" + size;
      if (!tile.pages.has(key)) tile.pages.set(key, await range(tile.url, offset, size));
      const v = tile.pages.get(key);
      for (let o = 0; o < v.byteLength; o += 32) {
        const [d, x, y, z] = [0, 4, 8, 12].map((k) => v.getInt32(o + k, true));
        const at = Number(v.getBigUint64(o + 16, true)), length = v.getInt32(o + 24, true), n = v.getInt32(o + 28, true);
        if (!touches(d, x, y)) continue;
        if (n === -1) await page(at, length);  // page de hiérarchie fille
        else if (n > 0) out.push({ d, x, y, z, at, length, count: n });
      }
    }
    await page(...tile.root);
    return out;
  }

  /** Test « le carré (x0, y0, côté) touche la bande » : centre o, demi-longueur `across` le long de (ux, uy), demi-largeur
   * `along` le long de la perpendiculaire (séparation par les axes de la bande ; ceux du carré sont ceux de la boîte). */
  const stripTest = (o, [ux, uy], across, along) => (x0, y0, size) => {
    const cx = x0 + size / 2 - o[0], cy = y0 + size / 2 - o[1], half = size / 2;
    return Math.abs(cx * ux + cy * uy) <= across + half * (Math.abs(ux) + Math.abs(uy))
      && Math.abs(cy * ux - cx * uy) <= along + half * (Math.abs(ux) + Math.abs(uy));
  };

  let lazPerf = null;
  async function laz() {
    if (lazPerf) return lazPerf;
    if (typeof createLazPerf === "undefined") {
      await new Promise((resolve, reject) => document.head.append(Object.assign(document.createElement("script"),
        { src: LAZ, onload: resolve, onerror: () => reject(new Error("nuage LiDAR : décodeur laz-perf injoignable")) })));
    }
    lazPerf = await createLazPerf();  // eslint-disable-line no-undef
    return lazPerf;
  }

  /** Points du sol (classe 2), de la végétation (3 basse, 4 moyenne, 5 haute) et de l'eau (9) d'un nœud : [x, y, z, intensité, classe, nombre de retours]
   * (Lambert 93, altitude IGN69 comme le terrain du calcul) ; keep : autres classes à garder. */
  async function ground(tile, node, keep = (cls) => (cls >= 2 && cls <= 5) || cls === 9) {
    const lib = await laz();
    const data = await range(tile.url, node.at, node.length);
    const input = lib._malloc(node.length), output = lib._malloc(tile.length);
    const decoder = new lib.ChunkDecoder();
    const out = [];
    try {
      lib.HEAPU8.set(new Uint8Array(data.buffer), input);
      decoder.open(tile.format, tile.length, input);
      const [sx, sy, sz] = tile.scale, [ox, oy, oz] = tile.offset;
      for (let i = 0; i < node.count; i++) {
        decoder.getPoint(output);
        const v = new DataView(lib.HEAPU8.buffer, output, tile.length);  // HEAPU8 peut changer en grandissant
        const cls = tile.format >= 6 ? v.getUint8(16) : v.getUint8(15) & 31;
        // nombre de retours du pulse : octet 14, bits 4-7 (formats 6 et plus) ou 3-5 (formats 0 à 5)
        const returns = tile.format >= 6 ? v.getUint8(14) >> 4 : (v.getUint8(14) >> 3) & 7;
        if (keep(cls)) {
          out.push([v.getInt32(0, true) * sx + ox, v.getInt32(4, true) * sy + oy, v.getInt32(8, true) * sz + oz,
            v.getUint16(12, true), cls, returns]);
        }
      }
    } finally {
      decoder.delete();
      lib._free(input);
      lib._free(output);
    }
    return out;
  }

  /** Herbe au sol : intervalles [début, fin] (m) des bandes « autre » (cases kind, i, tot : points, veg : points de végétation) d'au
   * moins VERGE m, dont l'intensité médiane atteint GRASS fois ref (ref : intensité de l'enrobé), ou dont la part médiane de
   * points de végétation (cases de GRASS_POINTS points au moins, la moitié des cases de la bande au moins) atteint GRASS_SHARE.
   * Les intervalles qui se touchent sont fusionnés. */
  function grassRuns(cells, ref) {
    const out = [];
    for (let k = 0; k < cells.length; k++) {
      if (cells[k].kind !== "autre") continue;
      let w = k;
      while (w + 1 < cells.length && cells[w + 1].kind === "autre" && cells[w + 1].x - cells[w].x <= BIN + 1e-6) w++;
      const run = cells.slice(k, w + 1);
      if (cells[w].x - cells[k].x + BIN >= VERGE) {
        const rich = run.filter((c) => (c.tot ?? 0) >= GRASS_POINTS);
        const bright = median(run.map((c) => c.i)) >= GRASS * ref;
        const leafy = rich.length * 2 >= run.length && median(rich.map((c) => c.veg / c.tot)) >= GRASS_SHARE;
        if (bright || leafy) {
          const a = cells[k].x - BIN / 2, b = cells[w].x + BIN / 2;
          if (out.length && a <= out[out.length - 1][1] + 1e-6) out[out.length - 1][1] = b;
          else out.push([a, b]);
        }
      }
      k = w;
    }
    return out;
  }

  const median = (a) => { if (!a.length) return null; const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };

  /** Bandes claires d'un travers (cases { x, i } triées, ref : intensité de l'enrobé) : [k, w, étroite], premier et dernier
   * rang de chaque bande à PAINT fois l'enrobé ou plus ; étroite : pas plus large que PAINT_WIDTH et nettement plus claire
   * que ses cases voisines (LINE_CONTRAST), donc de la peinture. */
  function brightRuns(cells, ref) {
    const runs = [];
    for (let k = 0; k < cells.length; k++) {
      if (cells[k].i < PAINT * ref) continue;
      let w = k;
      while (w + 1 < cells.length && cells[w + 1].i >= PAINT * ref && cells[w + 1].x - cells[w].x <= BIN + 1e-6) w++;
      const peak = Math.max(...cells.slice(k, w + 1).map((c) => c.i));
      const next = (j, c) => cells[j] && Math.abs(cells[j].x - c.x) <= BIN + 1e-6 ? cells[j].i : 0;  // case vide : pas une voisine
      runs.push([k, w, cells[w].x - cells[k].x + BIN <= PAINT_WIDTH + 1e-6
        && peak >= LINE_CONTRAST * Math.max(next(k - 1, cells[k]), next(w + 1, cells[w]))]);
      k = w;
    }
    return runs;
  }

  /** Lignes à tirets : le travers de la photo peut tomber entre deux tirets (f478a847 : 4 m de vide, ±STRIP n'en voit
   * rien). sections : [at, [x des lignes du travers]] ; position, lue au travers le plus proche de la photo, des lignes vues
   * sur LINE_SECTIONS travers au moins, à LINE_MATCH m près d'un travers à l'autre. */
  function dashedLines(sections) {
    const seen = sections.flatMap(([at, xs]) => xs.map((x) => ({ at, x }))).sort((p, q) => p.x - q.x), out = [];
    for (let k = 0; k < seen.length; k++) {
      let w = k;
      while (w + 1 < seen.length && seen[w + 1].x - seen[w].x <= LINE_MATCH) w++;
      const group = seen.slice(k, w + 1);
      if (new Set(group.map((g) => g.at)).size >= LINE_SECTIONS) {
        out.push(group.reduce((p, q) => (Math.abs(q.at) < Math.abs(p.at) ? q : p)).x);
      }
      k = w;
    }
    return out;
  }

  /** Analyse fine du profil (voir App._compute_edges : profile.repere, profils, bords, séparateur) ; progress(texte,
   * part lue de 0 à 1, ou absente tant que le nombre de blocs n'est pas connu) pendant la lecture. Résultat en m signés
   * comme le graphique (négatif à gauche). */
  async function analyse(profile, progress = () => {}) {
    const t0 = Date.now(), r0 = count.requests, b0 = count.bytes;
    const [[lon, lat], right] = profile.repere;
    const o = toL93(lon, lat), p = toL93(...right);
    const t = Math.hypot(p[0] - o[0], p[1] - o[1]), [ux, uy] = [(p[0] - o[0]) / t, (p[1] - o[1]) / t];
    // Seule une bande sert : ±HALF en travers, le long de la route STRIP et les travers voisins (SECTION_STEPS) ; le reste du carré
    // de 68 m de côté n'était lu que pour rien (une requête de plus par bloc, une seconde chacune : voir download)
    const box = [o[0] - HALF - 2, o[1] - HALF - 2, o[0] + HALF + 2, o[1] + HALF + 2];
    const strip = stripTest(o, [ux, uy], HALF + 2, STRIP + Math.max(...SECTION_STEPS) + 1);
    progress("Recherche des dalles du nuage LiDAR HD…");
    const meta = await tilesAround(lon, lat, 0.0005);
    if (!meta.length) throw new Error("pas de nuage LiDAR HD ici");
    // case -> intensités du sol ; altitude la plus haute de la végétation ; altitudes des points d'eau
    const bins = new Map(), mix = new Map(), plants = new Map(), water = new Map(), soil = [];
    let points = 0;
    // Blocs à lire, dalle par dalle (hiérarchie d'abord : leur nombre fait l'avancement de la barre)
    // shortcut: les deux niveaux les plus fins (9/10 des points, 1/4 des octets : essai du 2026-10-27)
    const todo = [];
    for (const m of meta) {
      const tile = await openTile(m.properties.url_npl);
      const nodes = await nodesIn(tile, box, strip), deepest = Math.max(...nodes.map((n) => n.d));
      todo.push(...nodes.filter((n) => n.d >= deepest - 1).map((n) => [tile, n]));
    }
    for (const [done, [tile, n]] of todo.entries()) {
      progress(`Lecture du nuage LiDAR HD… ${Math.round(100 * done / todo.length)} % (${((count.bytes - b0) / 1e6).toFixed(1)} Mo)`,
        done / todo.length);
      for (const [x, y, z, intensity, cls, returns] of await ground(tile, n)) {
        const ex = x - o[0], ey = y - o[1], across = ex * ux + ey * uy, along = ey * ux - ex * uy;
        // sol des travers voisins seulement (SECTION_STEPS, ±STRIP chacun) : le reste des blocs lus n'y sert pas
        if (cls === 2 && Math.abs(across) <= HALF && Math.abs(along) <= SOIL_ALONG) soil.push([along, across, intensity]);
        if (Math.abs(along) > STRIP || Math.abs(across) > HALF) continue;
        const k = Math.round(across / BIN);
        if (cls === 9) {
          if (!water.has(k)) water.set(k, []);
          water.get(k).push(z);
          continue;
        }
        if (cls <= 5) {
          if (!mix.has(k)) mix.set(k, []);
          mix.get(k).push([z, cls, returns]);  // sol et végétation basse : part de végétation de la case (GRASS_SHARE)
        }
        if (cls !== 2) {
          plants.set(k, Math.max(plants.get(k) ?? -Infinity, z));
          continue;
        }
        if (!bins.has(k)) bins.set(k, []);
        bins.get(k).push(intensity);
        points++;
      }
    }
    const cells = [...bins].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ x: k * BIN, i: median(v), n: v.length }));
    for (const c of cells) {  // points de végétation de la case : retours multiples, ou classe 3 à 5 près du sol de la case
      const pts = mix.get(Math.round(c.x / BIN)), soil2 = median(pts.filter((q) => q[1] === 2).map((q) => q[0]));
      c.tot = pts.length;
      c.veg = pts.filter((q) => q[2] > 1 || (q[1] >= 3 && q[1] <= 5 && q[0] - soil2 <= GRASS_NEAR)).length;
    }
    const ref = median(cells.filter((c) => Math.abs(c.x) <= (profile.origine === "caméra" ? 1.5 : 3)).map((c) => c.i));
    if (!ref) throw new Error("nuage LiDAR : pas de points du sol sous l'origine");
    // Nature du sol : enrobé, peinture (bande claire étroite), autre (herbe, gravillons, béton)
    for (const c of cells) c.kind = c.i < ROAD * ref ? "enrobé" : "autre";
    const lines = [];  // milieux des lignes blanches
    for (const [k, w, narrow] of brightRuns(cells, ref)) {
      if (!narrow) continue;  // large : herbe, gravillons
      for (let j = k; j <= w; j++) cells[j].kind = "peinture";
      lines.push((cells[k].x + cells[w].x) / 2);
    }
    // Herbe au sol (l'IGN la classe « sol ») : bandes « autre » larges, très claires ou riches en végétation (grassRuns)
    const grass = grassRuns(cells, ref);
    // Séparateur : bande continue non revêtue (peinture comprise) autour du milieu de celui du calcul
    const main = profile.profils.filter((e) => e.le_long === 0);
    const sepEntry = main.find((e) => e.separateur), out = { points, ref, requetes: count.requests - r0,
      octets: count.bytes - b0, secondes: Math.round((Date.now() - t0) / 1000),
      cases: cells.map((c) => [c.x, Math.round(10 * c.i / ref) / 10]),
      lignes: lines, herbe: grass, separateur: null,
      vegetation: [...plants].sort((a, b) => a[0] - b[0]).map(([k, z]) => [k * BIN, Math.round(z * 100) / 100]),
      // surface de l'eau : altitude médiane des points classés eau par l'IGN, case par case
      eau: [...water].sort((a, b) => a[0] - b[0]).map(([k, zs]) => [k * BIN, Math.round(median(zs) * 100) / 100]) };
    let sepSign = 0;
    if (sepEntry) {
      sepSign = sepEntry.cote === "gauche" ? -1 : 1;
      const mid = sepSign * (sepEntry.separateur[0] + sepEntry.separateur[1]) / 2;
      const runs = [];
      for (let k = 0; k < cells.length; k++) {
        if (cells[k].kind === "enrobé") continue;
        let w = k;
        // un trou d'une case d'enrobé (pied de glissière, case peu remplie) ne coupe pas la bande
        while (w + 1 < cells.length && (cells[w + 1].kind !== "enrobé" || (w + 2 < cells.length && cells[w + 2].kind !== "enrobé"))) w++;
        runs.push([cells[k].x - BIN / 2, cells[w].x + BIN / 2]);
        k = w;
      }
      const near = runs.filter(([a, b]) => b - a >= SEPARATOR[0] && b - a <= SEPARATOR[1] && Math.min(Math.abs(a - mid), Math.abs(b - mid),
        a <= mid && mid <= b ? 0 : Infinity) <= 2).sort((p, q) => Math.abs((p[0] + p[1]) / 2 - mid) - Math.abs((q[0] + q[1]) / 2 - mid));
      if (near.length) {
        out.separateur = near[0];
      }
    }
    // Travers voisins pour les tirets : chacun sa case et son enrobé (la route peut tourner sous ±STRIP)
    const sections = SECTION_STEPS.map((at) => {
      const near = new Map();
      for (const [along, across, i] of soil) {
        if (Math.abs(along - at) > STRIP) continue;
        const k = Math.round(across / BIN);
        if (!near.has(k)) near.set(k, []);
        near.get(k).push(i);
      }
      const rows = new Map([...near].map(([k, v]) => [k, median(v)]));
      return { at, rows,
        ref: median([...rows].filter(([k]) => Math.abs(k * BIN) <= (profile.origine === "caméra" ? 1.5 : 3)).map(([, i]) => i)) };
    }).filter((s) => s.ref);
    // Tirets (lignes blanches vues sur les travers voisins) de chaque côté, sur la chaussée seulement (hors séparateur) :
    // l'herbe est mouchetée de cases claires ; jusqu'au bord du calcul + 1 m
    const dashes = dashedLines(sections.map((s) => {
      const row = [...s.rows].sort((a, b) => a[0] - b[0]).map(([k, i]) => ({ x: k * BIN, i }));
      return [s.at, brightRuns(row, s.ref).filter(([, , narrow]) => narrow).map(([k, w]) => (row[k].x + row[w].x) / 2)];
    }));
    for (const [name, sign] of [["gauche", -1], ["droit", 1]]) {
      const e = main.find((m) => m.cote === name);
      if (!e) continue;
      const reach = e.bord + 1;
      for (const x of dashes) {
        if (sign * x < 0 || sign * x > reach || lines.some((l) => Math.abs(l - x) <= LINE_MATCH)) continue;
        if (out.separateur && x >= out.separateur[0] && x <= out.separateur[1]) continue;
        lines.push(x);
        const cell = cells.find((c) => Math.abs(c.x - x) <= BIN / 2);
        if (cell?.kind === "enrobé") cell.kind = "peinture";
      }
    }
    return out;
  }

  /** Tablier le plus proche de o [x, y] et sa hauteur de chute, d'après points [x, y, z, intensité, classe] (Lambert 93) :
   * cases du tablier reliées à DECK_JOIN m près (altitude : médiane des points classés pont), sans leur rangée de bord
   * (parapets, flancs) ; dessous : sol (deuxième point le plus bas de la case : pas un point aberrant) ou eau (médiane)
   * à DECK_REACH m au plus du tablier ; hauteur : la plus grande différence sur tout le tablier, qui suit ainsi un pont
   * bombé. { height, below, keys }, sans height si rien n'est lu dessous ; null sans tablier près de o. */
  function bridgeHeight(points, o) {
    const key = (i, j) => `${i},${j}`, cell = (v) => Math.floor(v / DECK_CELL);
    const decks = new Map(), soils = new Map(), waters = new Map();
    const add = (map, k, z) => { if (map.has(k)) map.get(k).push(z); else map.set(k, [z]); };
    for (const [x, y, z, , cls] of points) {
      add(cls === 17 ? decks : cls === 9 ? waters : soils, key(cell(x), cell(y)), z);
    }
    const heights = new Map([...decks].filter(([, z]) => z.length >= DECK_POINTS).map(([k, z]) => [k, median(z)]));
    const at = (k) => k.split(",").map(Number), centre = (i) => (i + 0.5) * DECK_CELL;
    let start = null, nearest = DECK_NEAR;
    for (const k of heights.keys()) {
      const [i, j] = at(k), d = Math.hypot(centre(i) - o[0], centre(j) - o[1]);
      if (d <= nearest) [start, nearest] = [k, d];
    }
    if (!start) return null;
    const keys = new Set([start]), around = [-1, 0, 1].flatMap((a) => [-1, 0, 1].map((b) => [a, b]));
    const join = Math.ceil(DECK_JOIN / DECK_CELL);
    for (const k of keys) {  // un Set parcouru voit les ajouts
      const [i, j] = at(k);
      for (let a = -join; a <= join; a++) {
        for (let b = -join; b <= join; b++) {
          if (Math.hypot(a, b) * DECK_CELL <= DECK_JOIN && heights.has(key(i + a, j + b))) keys.add(key(i + a, j + b));
        }
      }
    }
    if (keys.size < DECK_MIN) return null;
    const cells = [...keys].map(at);
    const inner = cells.filter(([i, j]) => around.every(([a, b]) => keys.has(key(i + a, j + b))));
    const below = new Map();  // case -> [altitude, "sol" ou "eau"]
    for (const [k, z] of soils) if (z.length >= 2) below.set(k, [[...z].sort((a, b) => a - b)[1], "sol"]);
    for (const [k, z] of waters) if (!below.has(k) || median(z) < below.get(k)[0]) below.set(k, [median(z), "eau"]);
    // Comptée depuis la case gardée, à une rangée du bord du tablier
    const reach = DECK_REACH + DECK_CELL, rings = Math.ceil(reach / DECK_CELL);
    let best = null;
    for (const [i, j] of inner.length ? inner : cells) {
      const top = heights.get(key(i, j));
      for (let a = -rings; a <= rings; a++) {
        for (let b = -rings; b <= rings; b++) {
          const under = Math.hypot(a, b) * DECK_CELL <= reach && below.get(key(i + a, j + b));
          if (under && (!best || top - under[0] > best.height)) best = { height: top - under[0], below: under[1] };
        }
      }
    }
    return { ...best, keys };
  }

  const bridges = [], reads = new Map();  // ponts déjà calculés ; points des nœuds déjà lus (dalle:adresse)
  /** Hauteur de chute du pont sous la photo (lon, lat), tronçon BD TOPO chain [[lon, lat]…] : { height, below } (m ; « sol »
   * ou « eau »), une fois par pont : même réponse sur toutes ses photos, quel que soit le tronçon ; null sans points classés
   * pont ici (la hauteur se calcule alors autrement). */
  async function bridgeFall(lon, lat, chain) {
    const o = toL93(lon, lat);
    // Le long du tablier : nœuds proches de ce qu'on en connaît, jusqu'à n'en plus trouver de nouveau (pont plus long que son
    // tronçon BD TOPO ; bien moins de nœuds qu'un carré autour d'un long pont)
    let seeds = [o, ...chain.map((p) => toL93(...p))], found = null;
    for (let round = 0, added = true; added && round < DECK_ROUNDS; round++) {
      added = false;
      const room = DECK_REACH + 2 * DECK_CELL, xs = seeds.map((p) => p[0]), ys = seeds.map((p) => p[1]);
      const box = [Math.min(...xs) - room, Math.min(...ys) - room, Math.max(...xs) + room, Math.max(...ys) + room];
      const d = Math.max(box[2] - o[0], o[0] - box[0], box[3] - o[1], o[1] - box[1]) / 70000;  // degrés : large partout en métropole
      const points = [];
      for (const m of await tilesAround(lon, lat, d)) {
        const tile = await openTile(m.properties.url_npl), nodes = await nodesIn(tile, box);
        const deepest = Math.max(...nodes.map((n) => n.d));
        // shortcut: les deux niveaux les plus fins, comme l'analyse fine ; tout lire si un tablier peu dense manque
        for (const n of nodes.filter((p) => p.d >= deepest - 1)) {
          const size = 2 * tile.half / 2 ** n.d, x0 = tile.center[0] - tile.half + n.x * size, y0 = tile.center[1] - tile.half + n.y * size;
          const near = seeds.some(([x, y]) => Math.hypot(Math.max(x0 - x, 0, x - x0 - size), Math.max(y0 - y, 0, y - y0 - size)) <= room);
          const id = `${tile.url}:${n.at}`;
          if (near && !reads.has(id)) {
            reads.set(id, await ground(tile, n, (cls) => cls === 2 || cls === 9 || cls === 17));
            added = true;
          }
          if (reads.has(id)) points.push(...reads.get(id));
        }
      }
      found = bridgeHeight(points, o);
      if (!found) return null;
      seeds = [...found.keys].map((k) => k.split(",").map((v) => (Number(v) + 0.5) * DECK_CELL));
    }
    const same = bridges.find((b) => [...found.keys].some((k) => b.keys.has(k)));
    if (same) return { height: same.height, below: same.below };
    bridges.push(found);
    return { height: found.height, below: found.below };
  }

  return { analyse, toL93, tilesAround, brightRuns, grassRuns, dashedLines, stripTest, bridgeFall, useGeoCache };
})();

export { Nuage };
