// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Analyse fine du profil en travers (bouton « Analyse fine » de la fenêtre du profil) : nuage de points LiDAR HD de
// l'IGN, lu à la volée (dalles COPC, lecture partielle par Range) sur une bande de ±STRIP m le long de la route au
// travers de la photo. Le terrain (MNT) du calcul « Dévers » ne voit ni la peinture ni la nature du sol ; l'intensité
// du retour laser des points du sol, si : enrobé sombre, lignes blanches très claires, herbe, gravillons et béton
// clairs. D'où le bord de chaussée (ligne de rive, sinon fin de l'enrobé) et le séparateur de chaussée (bande non
// revêtue entre les deux chaussées, glissières comprises). Lecteur repris de tests/essai-lidar.html (essai du
// 2026-10-27) ; décompression par laz-perf, chargé au premier usage.

const Nuage = (() => {
  const WFS = "https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&OUTPUTFORMAT=application/json"
    + "&TYPENAMES=IGNF_LIDAR-HD_METADONNEE:metadata";
  const LAZ = "https://cdn.jsdelivr.net/npm/laz-perf@0.0.7/lib/web/laz-perf.js";
  const HALF = 32, STRIP = 1.0, BIN = 0.25;  // m : ±HALF en travers, ±STRIP le long de la route, cases de BIN m
  const ROAD = 1.6;  // intensité de l'enrobé : sous ROAD fois celle sous l'origine
  const PAINT = 3.0, PAINT_WIDTH = 0.75;  // ligne blanche : au moins PAINT fois l'enrobé, PAINT_WIDTH m de large au plus
  const VERGE = 1.0;  // m : surface non revêtue (herbe, gravillons) d'au moins cette largeur : l'enrobé s'arrête là
  const GRASS = 3.5;  // herbe : bande non revêtue (VERGE m au moins) en moyenne GRASS fois plus claire que l'enrobé (le laser,
  // en proche infrarouge, est très renvoyé par la végétation ; gravillons et béton : 2 à 3 fois)
  const AXIS = 1.2;  // m : ligne blanche aussi près de l'axe d'une chaussée : ligne entre voies, pas de rive
  const SEPARATOR = [0.5, 12];  // m : largeurs possibles du séparateur, et son milieu à 2 m au plus de celui du calcul

  // Lambert 93 (RGF93, EPSG:2154), sens direct (IGN, ALG0001 à ALG0003 ; RGF93 ≈ WGS 84)
  const L93 = { n: 0.7256077650532670, c: 11754255.426096, xs: 700000, ys: 12655612.049876, e: 0.0818191910428158 };
  function toL93(lon, lat) {
    const { n, c, xs, ys, e } = L93, p = lat * Math.PI / 180, s = e * Math.sin(p);
    const r = c * Math.exp(-n * (Math.log(Math.tan(Math.PI / 4 + p / 2)) + e / 2 * Math.log((1 - s) / (1 + s))));
    const g = n * (lon - 3) * Math.PI / 180;
    return [xs + r * Math.sin(g), ys - r * Math.cos(g)];
  }

  // Téléchargement des dalles : 1 requête par seconde au plus (en-tête x-ratelimit-limit-second du serveur)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const count = { requests: 0, bytes: 0 };
  let last = 0;
  async function range(url, start, length) {
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

  /** Nœuds non vides (d, x, y, z, offset, taille, points) qui touchent le rectangle box [xmin, ymin, xmax, ymax]. */
  async function nodesIn(tile, box) {
    const out = [];
    const touches = (d, x, y) => {
      const size = 2 * tile.half / 2 ** d, x0 = tile.center[0] - tile.half + x * size, y0 = tile.center[1] - tile.half + y * size;
      return x0 <= box[2] && x0 + size >= box[0] && y0 <= box[3] && y0 + size >= box[1];
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

  /** Points du sol (classe 2), de la végétation (3 basse, 4 moyenne, 5 haute) et de l'eau (9) d'un nœud : [x, y, z, intensité, classe]
   * (Lambert 93, altitude IGN69 comme le terrain du calcul). */
  async function ground(tile, node) {
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
        if ((cls >= 2 && cls <= 5) || cls === 9) {
          out.push([v.getInt32(0, true) * sx + ox, v.getInt32(4, true) * sy + oy, v.getInt32(8, true) * sz + oz, v.getUint16(12, true), cls]);
        }
      }
    } finally {
      decoder.delete();
      lib._free(input);
      lib._free(output);
    }
    return out;
  }

  const median = (a) => { if (!a.length) return null; const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };

  /** Bord de chaussée d'un côté (sign : -1 à gauche, 1 à droite), de from à limit m de l'origine : fin de l'enrobé
   * (première bande non revêtue de VERGE m au moins), ligne de rive (ligne blanche au début de cette bande, sinon la
   * dernière avant elle, hors des lignes entre voies : à moins de AXIS m d'un axe, axes en m signés) ; { x, comment }
   * en m signés, ou null. */
  function edge(cells, sign, from, limit, axes) {
    const side = cells.filter((c) => sign * c.x >= from - 1e-6 && sign * c.x <= limit + 1e-6).sort((p, q) => sign * (p.x - q.x));
    const lane = (c) => axes.some((a) => a !== null && Math.abs(c.x - a) <= AXIS);
    let line = null;
    for (let k = 0; k < side.length; k++) {
      if (side[k].kind === "enrobé") continue;
      let w = k;
      while (w + 1 < side.length && side[w + 1].kind !== "enrobé") w++;
      const run = side.slice(k, w + 1);
      if (Math.abs(side[w].x - side[k].x) + BIN >= VERGE) {  // fin de l'enrobé : ligne de rive à son début, ou avant
        const start = run.find((c) => c.kind === "peinture" && Math.abs(c.x - side[k].x) <= PAINT_WIDTH && !lane(c));
        if (start || line) return { x: (start || line).x, comment: "ligne de rive" };
        return { x: side[k].x - sign * BIN / 2, comment: "fin de l'enrobé" };
      }
      for (const c of run) if (c.kind === "peinture" && !lane(c)) line = c;
      k = w;
    }
    return line ? { x: line.x, comment: "ligne de rive" } : null;
  }

  /** Analyse fine du profil (voir App._compute_edges : profile.repere, profils, bords, séparateur) ; progress(texte)
   * pendant la lecture. Résultat en m signés comme le graphique (négatif à gauche). */
  async function analyse(profile, progress = () => {}) {
    const t0 = Date.now(), r0 = count.requests, b0 = count.bytes;
    const [[lon, lat], right] = profile.repere;
    const o = toL93(lon, lat), p = toL93(...right);
    const t = Math.hypot(p[0] - o[0], p[1] - o[1]), [ux, uy] = [(p[0] - o[0]) / t, (p[1] - o[1]) / t];
    const box = [o[0] - HALF - 2, o[1] - HALF - 2, o[0] + HALF + 2, o[1] + HALF + 2];
    progress("Recherche des dalles du nuage LiDAR HD…");
    const d = 0.0005, response = await fetch(`${WFS}&BBOX=${lat - d},${lon - d},${lat + d},${lon + d},urn:ogc:def:crs:EPSG::4326`);
    if (!response.ok) throw new Error(`nuage LiDAR : métadonnées IGN, HTTP ${response.status}`);
    const meta = (await response.json()).features || [];
    if (!meta.length) throw new Error("pas de nuage LiDAR HD ici");
    const bins = new Map(), plants = new Map(), water = new Map();  // ... ; case -> altitudes des points d'eau  // case -> intensités du sol ; case -> altitude la plus haute de la végétation
    let points = 0;
    for (const m of meta) {
      const tile = await openTile(m.properties.url_npl);
      const nodes = await nodesIn(tile, box);
      // shortcut: les deux niveaux les plus fins (9/10 des points, 1/4 des octets : essai du 2026-10-27)
      const deepest = Math.max(...nodes.map((n) => n.d));
      for (const n of nodes.filter((n) => n.d >= deepest - 1)) {
        progress(`Lecture du nuage LiDAR HD… ${count.requests - r0} requêtes, ${((count.bytes - b0) / 1e6).toFixed(1)} Mo`);
        for (const [x, y, z, intensity, cls] of await ground(tile, n)) {
          const ex = x - o[0], ey = y - o[1], across = ex * ux + ey * uy, along = ey * ux - ex * uy;
          if (Math.abs(along) > STRIP || Math.abs(across) > HALF) continue;
          const k = Math.round(across / BIN);
          if (cls === 9) {
            if (!water.has(k)) water.set(k, []);
            water.get(k).push(z);
            continue;
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
    }
    const cells = [...bins].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ x: k * BIN, i: median(v), n: v.length }));
    const ref = median(cells.filter((c) => Math.abs(c.x) <= (profile.origine === "caméra" ? 1.5 : 3)).map((c) => c.i));
    if (!ref) throw new Error("nuage LiDAR : pas de points du sol sous l'origine");
    // Nature du sol : enrobé, peinture (bande claire étroite), autre (herbe, gravillons, béton)
    for (const c of cells) c.kind = c.i < ROAD * ref ? "enrobé" : "autre";
    const lines = [];  // milieux des lignes blanches
    for (let k = 0; k < cells.length; k++) {
      if (cells[k].i < PAINT * ref) continue;
      let w = k;
      while (w + 1 < cells.length && cells[w + 1].i >= PAINT * ref && cells[w + 1].x - cells[w].x <= BIN + 1e-6) w++;
      if (cells[w].x - cells[k].x + BIN <= PAINT_WIDTH + 1e-6) {  // étroite : peinture ; large : herbe, gravillons
        for (let j = k; j <= w; j++) cells[j].kind = "peinture";
        lines.push((cells[k].x + cells[w].x) / 2);
      }
      k = w;
    }
    // Herbe au sol (l'IGN la classe « sol ») : bandes « autre » larges et très claires
    const grass = [];
    for (let k = 0; k < cells.length; k++) {
      if (cells[k].kind !== "autre") continue;
      let w = k;
      while (w + 1 < cells.length && cells[w + 1].kind === "autre" && cells[w + 1].x - cells[w].x <= BIN + 1e-6) w++;
      const run = cells.slice(k, w + 1);
      if (cells[w].x - cells[k].x + BIN >= VERGE && median(run.map((c) => c.i)) >= GRASS * ref) {
        grass.push([cells[k].x - BIN / 2, cells[w].x + BIN / 2]);
      }
      k = w;
    }
    // Séparateur : bande continue non revêtue (peinture comprise) autour du milieu de celui du calcul
    const main = profile.profils.filter((e) => e.le_long === 0);
    const sepEntry = main.find((e) => e.separateur), out = { points, ref, requetes: count.requests - r0,
      octets: count.bytes - b0, secondes: Math.round((Date.now() - t0) / 1000), cases: cells.map((c) => [c.x, Math.round(10 * c.i / ref) / 10]),
      lignes: lines, herbe: grass, separateur: null, bords: {},
      vegetation: [...plants].sort((a, b) => a[0] - b[0]).map(([k, z]) => [k * BIN, Math.round(z * 100) / 100]),
      // surface de l'eau : altitude médiane des points classés eau par l'IGN, case par case
      eau: [...water].sort((a, b) => a[0] - b[0]).map(([k, zs]) => [k * BIN, Math.round(median(zs) * 100) / 100]) };
    let sepSign = 0, sepEnd = 0;
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
        sepEnd = Math.max(Math.abs(near[0][0]), Math.abs(near[0][1]));
      }
    }
    // Bords de chaussée : jusqu'au bord du calcul (plateforme) + 1 m ; du côté du séparateur, au-delà de lui
    for (const [name, sign] of [["gauche", -1], ["droit", 1]]) {
      const e = main.find((m) => m.cote === name);
      if (!e) continue;
      const from = sign === sepSign && out.separateur ? sepEnd : 1.0;
      out.bords[name] = edge(cells, sign, from, e.bord + 1, [profile.axe ?? null, e.autre_axe ? sign * e.autre_axe : null]);
    }
    return out;
  }

  return { analyse, toL93 };
})();
