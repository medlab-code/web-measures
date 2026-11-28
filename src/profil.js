// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Profil en travers des bords de route (bouton « Graphiques », à côté de « Profils ») : la coupe du
// terrain telle que le calcul de App._compute_edges l'a lue (py/web_app.py), en SVG. Plateforme entre
// les deux bords trouvés, chute et dévers à l'endroit où ils ont été mesurés. Les hauteurs sont
// exagérées (le facteur est écrit) : sur 30 m de large, un talus de 2 m serait illisible ; la case
// « Hauteurs à l'échelle » de la fenêtre les remet à la même échelle que les distances.


const Profil = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const W = 760, H = 380, LEFT = 52, RIGHT = 16, TOP = 56, BOTTOM = 44;
  const GROUND_BELOW = 1, GROUND_MIN = 0.3;  // m de sol dessinés sous le point le plus bas du terrain (voir draw)
  const LINE = 14;  // px entre deux lignes d'une étiquette
  const ROAD_ROOM = 58;  // px sous la chaussée : ses deux étiquettes (largeur, dévers) et une marge au-dessus du bas du cadre
  /** Placement des étiquettes du graphique en travers et du profil en long (declutter), réglable. Mode par défaut « enveloppe »
   * (choix de l'auteur, 27/11/2026). Règles : étiquette horizontale sur une rangée régulière ; boîte entière à `marge` px au moins de toute
   * courbe de données, mesurée sur toute sa largeur ; jamais sur une autre étiquette ; connecteur fin, droit ou coudé, sans croiser une autre
   * étiquette ; dans le cadre. Les étiquettes qui touchent la chaussée
   * (plateforme et son dévers, axe, caméra, « travers à ±5 m » : attribut data-chaussee) gardent toujours leur placement « actuel ».
   *   mode        « actuel » : placement d'origine, inchangé (défaut, tant que l'auteur n'a pas choisi) ;
   *               « degagement » (P1) : même logique, mais boîte de l'étiquette tenue à `marge` px de toute courbe de
   *                  données (terrain, autres travers, végétation, herbe, eau), sur toute sa largeur, connecteurs plus longs ;
   *               « rangee » (P2) : étiquettes rangées dans une bande réservée en haut du cadre (hauteurs un peu réduites),
   *                  au-dessus de la plus haute courbe (la végétation y est coupée), sur `rangees` rangées régulières,
   *                  connecteurs verticaux ou coudés ;
   *               « enveloppe » (P3) : rangées régulières (pas de `pas` px) sur tout le cadre, sans bande réservée : chaque
   *                  étiquette prend la rangée la plus basse qui la laisse à `marge` px des courbes, au-dessus de ce qu'elle nomme.
   *   marge       px minimum entre la boîte d'une étiquette (liseré compris) et une courbe de données ;
   *   margeCout   coût par échantillon de courbe (un tous les 4 px) à moins de `marge` : plus haut, marge plus stricte ;
   *   connecteurMin  longueur minimale (px) d'un connecteur droit, mode « degagement » ;
   *   pas         px entre deux rangées (modes « rangee » et « enveloppe ») ;
   *   rangees     nombre de rangées de la bande réservée (mode « rangee ») ;
   *   rangeCout   coût par rangée montée, qui rapproche les étiquettes des courbes ;
   *   dessousCout coût d'une étiquette placée sous ce qu'elle nomme (repli du mode « enveloppe » quand plus aucune rangée
   *               au-dessus ne respecte la marge, par exemple canopée jusqu'en haut) ;
   *   ecart       px minimum entre deux étiquettes côte à côte (même rangée) : deux étiquettes bout à bout se liraient comme une seule ;
   *   decalage    coût par px de décalage horizontal d'une étiquette par rapport à ce qu'elle nomme (connecteur coudé). */
  const ETIQ = { mode: "enveloppe", marge: 14, margeCout: 12, connecteurMin: 18, pas: 18, rangees: 2, rangeCout: 6, decalage: 0.35, dessousCout: 40, ecart: 10 };
  /** Hauteur (px) de la bande des rangées réservée en haut du cadre, mode « rangee » : 0 dans les autres. */
  const bandReserve = () => (ETIQ.mode === "rangee" ? ETIQ.marge + 3 + (ETIQ.rangees - 1) * ETIQ.pas + 13 + 4 : 0);
  // Éléments du graphique que les « Options avancées » de la fenêtre peuvent masquer (toutes les clés vraies par défaut) : un élément
  // masqué n'est pas créé (ni dans le SVG, ni dans l'image PNG ou le PDF, ni dans la place réservée aux étiquettes par declutter)
  const SHOW = { chute: true, talus: true, devers: true, largeurs: true, plateforme: true, pentes: true, cassure: true, eau: true,
    herbe: true, vegetation: true, canopee: true, ponts: true, fond: true, peintures: true, separateur: true, bords: true, camera: true, carrefours: true };
  // Distances (m, positives, croissantes) des coupes voisines lues dans le profil (profile.profils) : [5], [10] ou [5, 10]
  const neighbours = (profile) => [...new Set(profile.profils.map((p) => Math.abs(p.le_long)).filter((a) => a > 0))].sort((a, b) => a - b);
  const num = (v, digits = 1) => v.toFixed(digits).replace(".", ",").replace(/^-/, "−");
  /** Distance au bord : au décimètre sous 10 m, au mètre au-delà (ou whole), comme le texte du calcul (web_chutes._distance). */
  const dist = (v, whole = false) => {
    const digits = whole || v >= 9.95 ? 0 : 1;
    return num(Math.floor(v * 10 ** digits + 0.5) / 10 ** digits, digits);
  };

  function el(name, attrs, text) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Travers (un par position le long de la route) : points [x, z] de gauche à droite, x < 0 à gauche. */
  function crossings(profile, limits = null) {
    const out = new Map();
    for (const p of profile.profils) {
      const t = out.get(p.le_long) || { along: p.le_long, points: [], bords: {} };
      const sign = p.cote === "gauche" ? -1 : 1;
      t.points.push(...p.points.map(([o, z]) => [sign * o, z]));
      t.bords[p.cote] = { x: sign * p.bord, relief: p.relief, voisins: p.voisins, manuel: Boolean(p.manuel),
        arret: p.arret === null ? null : sign * p.arret };
      if (p.separateur) {  // chaussées séparées : trouvé dans le relief ou d'après la BD TOPO
        t.separateur = p.separateur.map((o) => sign * o).sort((a, b) => a - b);
        t.separateurRelief = p.separateur_relief;
      }
      out.set(p.le_long, t);
    }
    // Dessin : la distance de la réglette (profile.zone) de part et d'autre du milieu de la chaussée (entre ses deux bords),
    // et au moins 1 m au-delà de chaque bord ; le terrain lu plus loin pour chercher le bord n'est pas dessiné
    // (83b5556f-0cb3-44d8-a41e-843ad0cddef1, réglette à 10 m : graphique à 21 m). La chute est lue, elle, jusqu'à zone m
    // au-delà du bord (App._edge_falls) : sur une route large, elle peut tomber hors du dessin
    // limits : bornes en distance imposées (cadre d'un dessin précédent), qui remplacent cette étendue : changer les bords
    // déplace le milieu de la chaussée, donc l'étendue, et le graphique glisserait à chaque case cochée
    for (const t of out.values()) {
      if (limits) {
        t.points = t.points.filter(([x]) => x >= limits[0] - 1e-6 && x <= limits[1] + 1e-6).sort((a, b) => a[0] - b[0]);
        continue;
      }
      const [left, right] = [t.bords.gauche?.x ?? 0, t.bords.droit?.x ?? 0], mid = (left + right) / 2;
      const reach = Math.max(profile.zone, (right - left) / 2 + 1);
      t.points = t.points.filter(([x]) => Math.abs(x - mid) <= reach + 1e-6).sort((a, b) => a[0] - b[0]);
    }
    return out;
  }

  /** Valeur d'un dévers (%, positif vers la droite), arrondie au point : l'écart entre travers n'autorise pas mieux. */
  const slopeValue = (s) => (Math.abs(s) < 0.5 ? "moins de 1\u00a0%" : `${num(Math.abs(s), 0)}\u00a0%`);
  const slopeWay = (s) => (Math.abs(s) < 0.5 ? "" : s > 0 ? " vers la droite" : " vers la gauche");
  /** Dévers de la plateforme (App : platform_slope), pour la légende. */
  function platformText(p) {
    const sides = () => `à gauche ${slopeValue(p.gauche)}${slopeWay(p.gauche)}, à droite ${slopeValue(p.droite)}${slopeWay(p.droite)}`;
    if (p.type === "sens") return `dévers ${slopeValue(p.pente)}${slopeWay(p.pente)}`;
    if (p.type === "toit") return `en toit, pente moyenne ${slopeValue(p.pente)} (${sides()})`;
    if (p.type === "demi") return `dévers ${sides()}`;
    return "dévers non déterminé (travers trop différents d'un endroit à l'autre)";
  }
  /** Même dévers, en bref sur le graphique ; rien s'il n'est pas déterminé. */
  function platformLabel(p) {
    const arrow = (s) => (Math.abs(s) < 0.5 ? "" : s > 0 ? " →" : " ←");
    if (p?.type === "sens") return `dévers ${slopeValue(p.pente)}${arrow(p.pente)}`;
    if (p?.type === "toit") return `toit ${slopeValue(p.pente)}`;
    if (p?.type === "demi") return `dévers${arrow(p.gauche)} ${slopeValue(p.gauche)} | ${slopeValue(p.droite)}${arrow(p.droite)}`;
    return "";
  }

  /** Altitude du travers en x (interpolée). */
  function zAt(points, x) {
    for (let k = 1; k < points.length; k++) {
      const [x0, z0] = points[k - 1], [x1, z1] = points[k];
      if (x >= x0 && x <= x1) return x1 === x0 ? z0 : z0 + (z1 - z0) * (x - x0) / (x1 - x0);
    }
    return null;
  }

  // Largeur réelle d'un texte (canvas hors écran, police des étiquettes lue une fois dans la page), en cache par texte et
  // taille ; repli sur l'estimation (ratio × taille par caractère) si le canvas ou la police sont indisponibles
  const widths = new Map();
  let measuring;  // contexte 2D, ou null s'il est indisponible
  let family;
  function textWidth(text, size, weight = 400, ratio = 0.56) {
    const key = `${weight}|${size}|${text}`;
    if (widths.has(key)) return widths.get(key);
    let w = text.length * size * ratio;
    try {
      if (measuring === undefined) {
        measuring = document.createElement("canvas").getContext("2d");
        // police des textes du graphique : calculée sur un texte SVG temporaire de la page
        const probe = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        probe.setAttribute("class", "profil-svg");
        probe.append(document.createElementNS("http://www.w3.org/2000/svg", "text"));
        probe.style.cssText = "position:absolute;visibility:hidden;width:0;height:0";
        document.body.append(probe);
        family = getComputedStyle(probe.firstChild).fontFamily;
        probe.remove();
      }
      if (measuring && family) {
        measuring.font = `${weight} ${size}px ${family}`;
        const m = measuring.measureText(text).width;
        if (Number.isFinite(m) && m > 0) w = m;
      }
    } catch { measuring = null; }
    widths.set(key, w);
    return w;
  }

  /** Placement des étiquettes du graphique (classe « place ») : chacune a une ancre (data-ancre = « x,y », le point qu'elle
   * désigne ; sinon son propre point de départ), une priorité (data-prio, 5 par défaut : chute 1, dévers 2, plateforme 3) et
   * une couleur de connecteur (data-couleur). Par priorité, glouton : positions candidates (sa place d'origine et ses
   * décalages verticaux, puis autour de l'ancre, de plus en plus loin, au-dessus, sur les côtés, dessous), dans le cadre
   * { top, bottom, left, right } ; la moins coûteuse l'emporte (chevauchement des étiquettes déjà posées et des obstacles
   * fixes, tracés croisés — échantillons des polylignes du terrain, des travers, de la plateforme, des bords, de la flèche…
   * —, distance à l'ancre). Déplacée loin de sa place d'origine, l'étiquette est reliée à son ancre par un connecteur (trait
   * fin et petit point). data-suite = data-cle d'une étiquette posée avant : elle la suit (plateforme, puis son dévers).
   * Largeurs mesurées sur un canvas hors écran (textWidth) : le SVG n'est pas encore dans la page.
   * Rend { textes, lignes } : étiquettes qui se recouvrent encore, et traits croisés. */
  // obstacles : [gauche, haut, droite, bas] à éviter aussi (tablier d'un pont…)
  const OBSTACLES = "path.sol, path.autre-travers, path.travers-mesure, path.chaussee, path.eau-surface, path.herbe, path.vegetation,"
    + " line.bord, line.chute, line.repere-chute, line.devers, line.separateur, line.raide, line.cassure, line.ouvrage";
  const NO_BOXES = [];
  const SAMPLE_STEP = 4, LINE_COST = 10, TEXT_COST = 5000, FAR = 28;
  // courbes de données seules (marge des modes autres que « actuel ») : terrain LiDAR, autres travers, végétation, herbe, eau
  const CURVES = "path.sol, path.autre-travers, path.travers-mesure, path.eau-surface, path.eau-nuage, path.herbe, path.vegetation";
  // Grille de points (cellules de GRID px) : décompte des points dans une boîte (bornes comprises) ou existence d'un point à moins
  // de r d'un autre, sans parcourir tous les points. Même résultat qu'un parcours complet (le test exact est refait sur chaque
  // point des cellules touchées) ; ajout possible à tout moment.
  const GRID = 16;
  function pointGrid() {
    const cells = new Map(), odd = [];  // odd : points non finis, hors grille
    const cell = (v) => { const c = Math.floor(v / GRID); return c < -30000 ? -30000 : c > 30000 ? 30000 : c; };
    const scan = (a, b0, b1, b2, b3) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 2) { const x = a[i], y = a[i + 1]; if (x >= b0 && x <= b2 && y >= b1 && y <= b3) n++; }
      return n;
    };
    return {
      add(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) { odd.push(x, y); return; }
        const k = (cell(x) + 32768) * 65536 + cell(y) + 32768, a = cells.get(k);
        if (a) a.push(x, y); else cells.set(k, [x, y]);
      },
      // nombre de points p avec b0 <= x <= b2 et b1 <= y <= b3
      count(b0, b1, b2, b3) {
        const x0 = cell(b0), x1 = cell(b2), y0 = cell(b1), y1 = cell(b3);
        let n = scan(odd, b0, b1, b2, b3);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > cells.size) { for (const a of cells.values()) n += scan(a, b0, b1, b2, b3); return n; }
        for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
          const a = cells.get((cx + 32768) * 65536 + cy + 32768);
          if (a) n += scan(a, b0, b1, b2, b3);
        }
        return n;
      },
      // y a-t-il un point à moins de 2,5 de (px, py) ?
      near(px, py) {
        const x1 = cell(px + 2.6), y1 = cell(py + 2.6);
        for (let cx = cell(px - 2.6); cx <= x1; cx++) for (let cy = cell(py - 2.6); cy <= y1; cy++) {
          const a = cells.get((cx + 32768) * 65536 + cy + 32768);
          if (a) for (let i = 0; i < a.length; i += 2) if (Math.hypot(a[i] - px, a[i + 1] - py) < 2.5) return true;
        }
        return false;
      },
    };
  }
  // opts : { mode, ceiling } ; mode : placement des étiquettes (ETIQ.mode ; « actuel » par défaut), ceiling : y du plafond des
  // courbes (bas de la bande des rangées, mode « rangee »)
  function declutter(svg, { top, bottom, left, right }, obstacles = [], { mode = "actuel", ceiling = top } = {}) {
    const samples = pointGrid(), curves = pointGrid();  // points le long des tracés ; le long des courbes de données seules
    // échantillons (un tous les SAMPLE_STEP px) de la ligne brisée pts, ajoutés aux tracés (et aux courbes si withCurves)
    const along = (pts, withCurves = false) => {
      for (let k = 0; k < pts.length; k++) {
        const [x0, y0] = pts[k], [x1, y1] = pts[k + 1] || pts[k], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / SAMPLE_STEP));
        for (let i = 0; i < n; i++) {
          const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
          samples.add(x, y);
          if (withCurves) curves.add(x, y);
        }
      }
    };
    for (const e of svg.querySelectorAll(mode === "actuel" ? OBSTACLES : `${OBSTACLES}, path.eau-nuage`)) {
      const data = e.matches(CURVES);
      if (e.tagName === "line") along([[+e.getAttribute("x1"), +e.getAttribute("y1")], [+e.getAttribute("x2"), +e.getAttribute("y2")]], data);
      else along([...(e.getAttribute("d") || "").matchAll(/[ML](-?[\d.]+(?:e-?\d+)?),(-?[\d.]+(?:e-?\d+)?)/g)].map((m) => [+m[1], +m[2]]), data);
    }
    for (const c of svg.querySelectorAll("circle.origine")) samples.add(+c.getAttribute("cx"), +c.getAttribute("cy"));
    const read = (t) => {  // étiquette sur plusieurs lignes (tspan) : la plus longue, et LINE px par ligne de plus
      const lines = t.querySelectorAll("tspan").length ? [...t.querySelectorAll("tspan")].map((s) => s.textContent) : [t.textContent];
      const grad = t.classList.contains("graduation"), size = grad ? 12 : 13;
      return { lines, size, w: Math.max(...lines.map((s) => textWidth(s, size, grad ? 400 : 500))) };
    };
    // boîte de l'étiquette (x, y : début de la 1re ligne de base, selon l'ancrage) ; liseré compris
    const box = (m, x, y, anchor) => {
      const l = anchor === "end" ? x - m.w : anchor === "middle" ? x - m.w / 2 : x;
      return [l - 2, y - m.size, l + m.w + 2, y + 3 + (m.lines.length - 1) * LINE];
    };
    const inside = (b, x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
    const crossed = (b) => samples.count(b[0], b[1], b[2], b[3]);
    const near = (b, ax, ay) => Math.hypot(Math.max(b[0] - ax, 0, ax - b[2]), Math.max(b[1] - ay, 0, ay - b[3]));
    const placed = [...obstacles];
    // nombre d'étiquettes posées qui recouvrent la boîte b élargie de gap de chaque côté
    const clashes = (b, gap) => {
      const l = b[0] - gap, r = b[2] + gap, u = b[1], d = b[3];
      let n = 0;
      for (let i = 0; i < placed.length; i++) { const p = placed[i]; if (p[0] < r && l < p[2] && p[1] < d && u < p[3]) n++; }
      return n;
    };
    // échantillons d'une ligne brisée (mêmes points que along), dans tx / ty (nombre : tn) et leur boîte englobante
    let tx = new Float64Array(256), ty = new Float64Array(256), tn = 0, tx0 = 0, tx1 = 0, ty0 = 0, ty1 = 0;
    const push = (x, y) => {
      if (tn === tx.length) { const nx = new Float64Array(tn * 2), ny = new Float64Array(tn * 2); nx.set(tx); ny.set(ty); tx = nx; ty = ny; }
      tx[tn] = x; ty[tn] = y; tn++;
      if (x < tx0) tx0 = x; if (x > tx1) tx1 = x; if (y < ty0) ty0 = y; if (y > ty1) ty1 = y;
    };
    const trace = (poly) => {
      tn = 0; tx0 = ty0 = Infinity; tx1 = ty1 = -Infinity;
      for (let k = 1; k < poly.length; k++) {  // un segment, puis son point d'arrivée (along d'une ligne à deux points)
        const [x0, y0] = poly[k - 1], [x1, y1] = poly[k], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / SAMPLE_STEP));
        for (let i = 0; i < n; i++) push(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n);
        push(x1 + (x1 - x1) * 0 / 1, y1 + (y1 - y1) * 0 / 1);
      }
    };
    const result = { textes: 0, lignes: 0 };
    const texts = [...svg.querySelectorAll("text.place:not([data-suite])")].map((t, k) => [t, k]);
    texts.sort(([a, i], [b, j]) => (Number(a.dataset.prio ?? 5) - Number(b.dataset.prio ?? 5)) || i - j);
    // abscisses des ancres des étiquettes en rangées (modes « rangee » et « enveloppe ») : une étiquette posée au-dessus d'une
    // autre ancre lui barrerait la montée de son connecteur (coût ETIQ_ANCRE par ancre recouverte)
    const rowed = (t) => mode !== "actuel" && mode !== "degagement" && !t.hasAttribute("data-chaussee");
    const anchors = texts.filter(([t]) => rowed(t)).map(([t]) => [t, t.dataset.ancre ? +t.dataset.ancre.split(",")[0] : +t.getAttribute("x"),
      t.classList.contains("canopee") ? ceiling : t.dataset.ancre ? +t.dataset.ancre.split(",")[1] : +t.getAttribute("y") - 4]);
    for (const [t] of texts) {
      const m = read(t), x0 = Number(t.getAttribute("x")), y0 = Number(t.getAttribute("y")), anchor0 = t.getAttribute("text-anchor") || "start";
      const [ax, ay] = t.dataset.ancre ? t.dataset.ancre.split(",").map(Number) : [x0, y0 - 4];
      const home = box(m, x0, y0, anchor0), up = t.hasAttribute("data-haut");
      // suites (data-suite = data-cle de celle-ci) : posées avec elle, au même décalage, et comptées dans le coût
      const tail = t.dataset.cle ? [...svg.querySelectorAll("text.place[data-suite]")].filter((f) => f.dataset.suite === t.dataset.cle)
        .map((f) => ({ t: f, m: read(f), x: Number(f.getAttribute("x")), y: Number(f.getAttribute("y")), anchor: f.getAttribute("text-anchor") || "start" })) : [];
      const candidates = [];  // { x, y, anchor, extra, b, tail }
      const lab = t.hasAttribute("data-chaussee") ? "actuel" : mode;  // la chaussée garde son placement
      const rows = lab === "rangee" || lab === "enveloppe", canopy = t.classList.contains("canopee");
      const ay2 = rows && canopy ? ceiling : ay;  // la canopée nomme la ligne coupée en haut : sa rangée est contre le plafond
      const add = (x, y, anchor, extra) => {
        let b = box(m, x, y, anchor);
        const shift = Math.max(0, left - b[0]) - Math.max(0, b[2] - right);  // rabattue dans le cadre
        if (b[2] - b[0] > right - left) return;
        [x, b] = [x + shift, [b[0] + shift, b[1], b[2] + shift, b[3]]];
        if (b[1] + 1 < top || b[3] > bottom) return;
        if (up && b[1] > ay + 8) return;  // au-dessus de ce qu'elle nomme seulement : ne le masque pas
        // rangées : au-dessus de ce qu'elle nomme, jamais dessus ; « enveloppe », repli sous lui (dans la terre) si plus aucune rangée libre
        if (rows && !canopy && b[3] > ay2 - 6 && !(lab === "enveloppe" && b[1] > ay2 + 6)) return;
        const rest = tail.length ? tail.map((f) => box(f.m, f.x + x - x0, f.y + y - y0, f.anchor)) : NO_BOXES;
        if (rest.some((r) => r[1] + 1 < top || r[3] > bottom || r[0] < left || r[2] > right)) return;
        candidates.push({ x, y, anchor, extra, b, rest });
      };
      if (rows) {
        // rangées régulières : « rangee », dans la bande réservée (la plus basse contre le plafond) ; « enveloppe », sur tout le cadre
        const base = lab === "rangee" ? ceiling - ETIQ.marge - 3 : top + 16;
        const count = lab === "rangee" ? ETIQ.rangees : Math.floor((bottom - top - 16) / ETIQ.pas) + 1;
        for (let r = 0; r < count; r++) {
          const y = lab === "rangee" ? base - r * ETIQ.pas : base + (count - 1 - r) * ETIQ.pas;  // r croît en montant
          for (let dx = 0; dx <= right - left; dx += 6) for (const sg of dx ? [1, -1] : [1]) add(ax + sg * dx, y, "middle", r);
        }
      } else {
        for (const d of [0, 16, -16, 32, -32, 48, -48, 64, -64]) add(x0, y0 + d, anchor0, Math.abs(d) / 16);
        // autour de l'ancre : haut, côtés, bas, de plus en plus loin
        const dirs = [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1]];
        const own = [ax, ay];
        for (const d of [0, 10, 22, 36, 54, 76, 104, 140]) {
          for (const [ux, uy] of dirs) {
            const px = own[0] + ux * d * (ux && uy ? 0.75 : 1), py = own[1] + uy * d * (ux && uy ? 0.75 : 1);
            const a = ux > 0 ? "start" : ux < 0 ? "end" : "middle", gap = d ? 4 : 6;
            const y = uy < 0 ? py - gap - 4 - (m.lines.length - 1) * LINE : uy > 0 ? py + gap + m.size : py + 4 - (m.lines.length - 1) * LINE / 2;
            add(px + ux * gap, y, a, 2 + d / 20);
          }
        }
      }
      const free = Math.max(FAR, near(home, ax, ay) + 4);  // sa place d'origine n'est jamais pénalisée par la distance
      // connecteur d'une boîte à l'ancre (modes autres que « actuel ») : droit (« degagement »), vertical puis coudé (rangées)
      const leader = (b) => {
        if (lab === "degagement") return [[Math.min(Math.max(ax, b[0] + 3), b[2] - 3), Math.min(Math.max(ay, b[1] + 3), b[3] - 3)], [ax, ay]];
        const edge = b[1] > ay2 ? b[1] : b[3];  // bord de la boîte tourné vers l'ancre (dessous : le haut)
        if (ax >= b[0] + 3 && ax <= b[2] - 3) return [[ax, edge], [ax, ay2]];
        const ex = ax < b[0] ? b[0] : b[2], ey = (b[1] + b[3]) / 2;  // coude : montée verticale, puis horizontale jusqu'au côté de la boîte
        return [[ex, ey], [ax, ey], [ax, ay2]];
      };
      const marge = canopy ? 0 : ETIQ.marge;  // la canopée nomme la ligne coupée en haut : elle la longe
      let best = null;
      const gap = lab === "actuel" ? 0 : ETIQ.ecart;  // écart horizontal minimal entre étiquettes (hors « actuel »)
      const near_ = new Int32Array(placed.length);  // boîtes posées touchées par un connecteur (cut)
      for (const c of candidates) {
        let clash = clashes(c.b, gap), lines = crossed(c.b);
        for (let i = 0; i < c.rest.length; i++) { clash += clashes(c.rest[i], gap); lines += crossed(c.rest[i]); }
        c.cost = clash * TEXT_COST + lines * LINE_COST + Math.max(0, near(c.b, ax, ay) - free) * 0.8 + c.extra;
        if (lab !== "actuel") {
          c.close = curves.count(c.b[0] - marge, c.b[1] - marge, c.b[2] + marge, c.b[3] + marge);
          c.poly = leader(c.b);
          trace(c.poly);
          // connecteur sur une autre étiquette : un seul échantillon suffit (le coût ne tient qu'à « il y en a un »)
          let cut = false, touched = 0;
          for (let i = 0; i < placed.length; i++) {
            const b = placed[i];
            if (b[0] <= tx1 && b[2] >= tx0 && b[1] <= ty1 && b[3] >= ty0) near_[touched++] = i;
          }
          for (let k = 0; k < tn && touched && !cut; k++) {
            const x = tx[k], y = ty[k];
            for (let i = 0; i < touched; i++) if (inside(placed[near_[i]], x, y)) { cut = !inside(c.b, x, y); if (cut) break; }
          }
          let cross = 0;
          if (!rows) for (let k = 0; k < tn; k++) if (Math.hypot(tx[k] - ax, ty[k] - ay2) > 8 && curves.near(tx[k], ty[k])) cross++;
          const length = tn * SAMPLE_STEP;
          let covered = 0;
          if (rows) for (const [o, u, v] of anchors) if (o !== t && u > c.b[0] - 2 && u < c.b[2] + 2 && v > c.b[3]) covered++;
          c.cost += c.close * ETIQ.margeCout + (cut ? TEXT_COST : 0) + cross * 3 + covered * 300;
          if (lab === "degagement") c.cost += Math.max(0, ETIQ.connecteurMin - near(c.b, ax, ay)) * 3;
          else c.cost += (c.b[1] > ay2 ? ETIQ.dessousCout : 0) + c.extra * ETIQ.rangeCout + Math.abs((c.b[0] + c.b[2]) / 2 - ax) * ETIQ.decalage + length * 0.2;
        }
        c.clash = clash; c.lines = lines;
        if (!best || c.cost < best.cost) best = c;
      }
      if (!best) {  // aucune position dans le cadre : sa place, rabattue à l'horizontale seulement
        const b = box(m, x0, y0, anchor0);
        best = { x: x0, y: y0, anchor: anchor0, b, rest: tail.map((f) => box(f.m, f.x, f.y, f.anchor)), clash: clashes(b, 0), lines: crossed(b) };
      }
      t.setAttribute("x", best.x);
      t.setAttribute("y", best.y);
      t.setAttribute("text-anchor", best.anchor);
      for (const s of t.querySelectorAll("tspan")) s.setAttribute("x", best.x);
      result.textes += best.clash; result.lignes += best.lines > 0 ? 1 : 0;
      tail.forEach((f) => {
        f.t.setAttribute("x", f.x + best.x - x0);
        f.t.setAttribute("y", f.y + best.y - y0);
      });
      placed.push(best.b, ...best.rest);
      // loin de sa place : connecteur de la boîte à l'ancre, petit point à l'ancre ; ses échantillons gênent les suivantes
      const moved = Math.hypot((best.b[0] + best.b[2] - home[0] - home[2]) / 2, (best.b[1] + best.b[3] - home[1] - home[3]) / 2);
      const reach = near(best.b, ax, ay);
      if (lab !== "actuel" && best.poly && !t.hasAttribute("data-sans-connecteur") && reach > 10) {
        const colour = t.dataset.couleur ? { "data-couleur": t.dataset.couleur } : {};
        const segments = best.poly.slice(1).map((p, k) => el("line", { x1: best.poly[k][0], y1: best.poly[k][1], x2: p[0], y2: p[1], class: "connecteur", ...colour }));
        t.before(...segments, el("circle", { cx: ax, cy: ay2, r: 2.5, class: "connecteur-point", ...colour }));
        along(best.poly);
      } else if (lab === "actuel" && moved > 14 && reach > 10) {
        const [ex, ey] = [Math.min(Math.max(ax, best.b[0] + 3), best.b[2] - 3), Math.min(Math.max(ay, best.b[1] + 3), best.b[3] - 3)];
        const colour = t.dataset.couleur ? { "data-couleur": t.dataset.couleur } : {};
        t.before(el("line", { x1: ex, y1: ey, x2: ax, y2: ay, class: "connecteur", ...colour }),
          el("circle", { cx: ax, cy: ay, r: 2.5, class: "connecteur-point", ...colour }));
        along([[ex, ey], [ax, ay]]);
      }
    }
    return result;
  }

  /** Clé de lecture sous le graphique (dans le SVG : aussi dans le PNG et le PDF) : un échantillon et un mot pour chaque
   * élément réellement dessiné dans svg, sur une ou deux lignes. hidden : herbe et végétation lues mais masquées (case
   * « Végétation ») ; leur place est gardée, en fin de clé, pour que la hauteur du graphique, donc les cases et boutons
   * sous lui, ne bougent pas quand on la décoche. Rend la hauteur ajoutée au viewBox. */
  function drawKey(svg, hidden = { herbe: false, vegetation: false }, near = [5, 10]) {
    const has = (sel) => Boolean(svg.querySelector(sel));
    // [présent, classe de l'échantillon, mot, attributs] : l'échantillon reprend la classe de l'élément dessiné
    const items = [
      [true, "sol", "terrain de la photo"],
      [has(".autre-travers"), "autre-travers", `travers à ±${near.join(" et ")} m`],
      [has(".chaussee"), "chaussee", "plateforme"],
      [has('.bord[data-bord="mesure"]'), "bord", "bord mesuré", { "data-bord": "mesure" }],
      [has(".bord-suppose"), "bord bord-suppose", "bord supposé", { "data-bord": "suppose" }],
      [has(".separateur"), "separateur", "séparateur"],
      [has(".ligne-blanche"), "ligne-blanche", "ligne blanche"],
      [has(".chute"), "chute", "chute"],
      [has(".devers"), "devers", "dévers"],
      [has(".eau, .eau-surface, .eau-nuage"), "eau-surface", "eau"],
      [has(".herbe") || hidden.herbe, "herbe", "herbe", {}, !has(".herbe")],
      [has(".vegetation") || hidden.vegetation, "vegetation", "végétation", {}, !has(".vegetation")],
    ].filter(([present]) => present);
    const SAMPLE = 22, GAP = 14, ROW = 18, y0 = H + 6;
    let x = LEFT, row = 0;
    const nodes = [];
    for (const [, cls, word, attrs = {}, ghost = false] of items) {
      const w = SAMPLE + 5 + textWidth(word, 12);
      if (x > LEFT && x + w > W - RIGHT) { x = LEFT; row++; }
      const cy = y0 + row * ROW + 9;
      if (ghost) continue;  // place gardée seulement (masqué)
      nodes.push(cls === "ligne-blanche"
        ? el("rect", { x: x + SAMPLE / 2 - 3, y: cy - 3, width: 6, height: 6, class: cls })
        : el("line", { x1: x, x2: x + SAMPLE, y1: cy, y2: cy, class: cls, ...attrs }),
      el("text", { x: x + SAMPLE + 5, y: cy + 4, class: "graduation cle-profil" }, word));
      x += w + GAP;
    }
    svg.append(el("g", { class: "cle-lecture" }));
    svg.lastChild.append(...nodes);
    const height = (row + 1) * ROW + 12;
    svg.setAttribute("viewBox", `0 0 ${W} ${H + height}`);
    return height;
  }

  /** Cadre du graphique : altitude de référence (plateforme sous l'origine), plateforme du travers de la photo, bornes
   * en distance et en hauteur, échelle et exagération des hauteurs, et les fonctions de position X, Z et path.
   * imposed : cadre d'un dessin précédent ({ x: [min, max] des points, z: { zmin, sx, factor } ou null }) : il remplace
   * l'étendue des points (x) et le calcul de l'échelle et du fond (z) ; rendu : cadre = ce qui le fixe. */
  function frame(profile, all, main, trueScale, camera, imposed = null) {
    const ref = zAt(main.points, 0) ?? main.points[0][1];  // 0 : plateforme sous l'origine
    const [bl, br] = [main.bords.gauche?.x ?? 0, main.bords.droit?.x ?? 0];
    // Plateforme : du bord gauche au bord droit exactement (bords du résultat, recalés ou calculés), terrain interpolé aux bouts
    const inside = main.points.filter(([x]) => x > bl && x < br), zl = zAt(main.points, bl), zr = zAt(main.points, br);
    const road = br > bl ? [...(zl === null ? [] : [[bl, zl]]), ...inside, ...(zr === null ? [] : [[br, zr]])] : [];
    const xs = [...all.values()].flatMap((t) => t.points.map((p) => p[0]));
    const zs = [...all.values()].flatMap((t) => t.points.map((p) => p[1] - ref));
    let [xmin, xmax] = imposed?.x ?? [Math.min(...xs), Math.max(...xs)];
    const extent = [xmin, xmax];
    const plotW = W - LEFT - RIGHT, plotH = H - TOP - BOTTOM, reserve = bandReserve(), usable = plotH - reserve;  // reserve : bande des rangées d'étiquettes
    const [lowest, terrainTop] = [Math.min(...zs), Math.max(...zs)];
    let zmax = terrainTop + 0.3;
    if (trueScale && profile.origine === "caméra") zmax = Math.max(zmax, camera + 0.3);  // caméra à sa hauteur, dans le cadre
    // Échelle des distances : toute la largeur, réduite (largeur centrée) si les hauteurs ne tiennent pas à ×1 ;
    // exagération entière, la plus forte qui fait tenir les hauteurs (au moins ×1), ×1 à l'échelle
    const scale = (bottom) => {
      const sx = Math.min(plotW / (xmax - xmin), usable / (zmax - bottom));
    return { sx, factor: trueScale ? 1 : Math.max(1, Math.floor(usable / (zmax - bottom) / sx)) };
    };
    // Fond : GROUND_BELOW sous le point le plus bas du terrain si son haut (ni caméra ni végétation) reste dans la
    // moitié basse du cadre, sinon GROUND_MIN ; la place libre va en haut, pour la végétation
    let zmin = lowest - GROUND_BELOW, { sx, factor } = scale(zmin);
    if (terrainTop - zmin > usable / (sx * factor) / 2) {
      zmin = lowest - GROUND_MIN;
      ({ sx, factor } = scale(zmin));
    }
    // Place sous la chaussée, même sans dévers affiché : l'échelle ne change pas après l'analyse fine
    if (road.length > 1) {
      const roadLow = Math.min(...road.map(([, z]) => z)) - ref;
      for (let k = 0; k < 8 && (roadLow - zmin) * sx * factor < ROAD_ROOM; k++) {
        zmin = roadLow - ROAD_ROOM / (sx * factor);
        ({ sx, factor } = scale(zmin));
      }
    }
    if (imposed?.z) ({ zmin, sx, factor } = imposed.z);
    const xmid = (xmin + xmax) / 2;
    [xmin, xmax] = [xmid - plotW / sx / 2, xmid + plotW / sx / 2];
    zmax = zmin + plotH / (sx * factor);
    const X = (x) => LEFT + (x - xmin) * sx, Z = (z) => TOP + (zmax - (z - ref)) / (zmax - zmin) * plotH;
    const path = (points) => points.map(([x, z], k) => `${k ? "L" : "M"}${X(x).toFixed(1)},${Z(z).toFixed(1)}`).join("");
    const cadre = { x: extent, z: { zmin, sx, factor } };
    // Exagération qu'auraient les hauteurs sans « à l'échelle » (cadre d'origine, pas un cadre figé) : 1 = la case n'a pas d'effet
    const exageration = trueScale
      ? frame(profile, all, main, false, camera, imposed && { x: imposed.x, z: null }).factor : factor;
    return { ceiling: TOP + reserve, exageration, ref, bl, br, road, xs, xmin, xmax, zmin, zmax, sx, factor, plotW, plotH, X, Z, path, extent, cadre };
  }

  /** Eau : surfaces de la BD TOPO (bande bleue posée sur le terrain), cours d'eau (repère bleu nommé), surface lue
   * dans le nuage (analyse fine). onGround(a, b) : tracé du terrain de la photo entre a et b. */
  function drawWater(svg, profile, fine, f, main, onGround) {
    const { xmin, xmax, ref, X, Z } = f;
    for (const w of (profile.eau || []).filter((v) => v.de !== undefined)) {
      const d = onGround(Math.min(w.de, w.a), Math.max(w.de, w.a));
      if (d) svg.append(el("path", { d, class: "eau-surface" }));
    }
    for (const w of (profile.eau || []).filter((v) => v.x !== undefined && v.x >= xmin && v.x <= xmax)) {
      const gy = Z(zAt(main.points, w.x) ?? ref);
      svg.append(el("path", { d: `M${X(w.x) - 6},${gy - 14}L${X(w.x) + 6},${gy - 14}L${X(w.x)},${gy - 4}Z`, class: "eau" }),
        el("text", { x: X(w.x), y: gy - 18, class: "graduation place eau-texte", "data-haut": "", "text-anchor": "middle" },
          w.nom || "cours d'eau"));
    }
    if (fine?.eau?.length) {
      let d = "", prev = null;
      for (const [x, z] of fine.eau) {
        if (x < xmin || x > xmax) { prev = null; continue; }
        d += `${prev !== null && x - prev <= 0.5 + 1e-6 ? "L" : "M"}${X(x).toFixed(1)},${Math.max(f.ceiling, Z(z)).toFixed(1)}`;
        prev = x;
      }
      svg.append(el("path", { d, class: "eau-nuage" }));
    }
  }

  /** Végétation de l'analyse fine : hauteur maximale (ligne verte, coupée en haut du graphique) ; à l'échelle, canopée
   * hors du cadre nommée. Vrai si une canopée est nommée (légende). */
  function drawVegetation(svg, fine, { xmin, xmax, zmax, ref, X, Z, ceiling }, trueScale, show = SHOW) {
    let canopy = false;
    let d = "", prev = null;
    const peaks = new Map();  // plus haut point de la ligne de chaque côté
    // plus haut point des cases voisines (±0,25 m) : une case où le laser n'a touché que des branches basses ne creuse pas ;
    // puis moyenne sur ±1 m : le feuillage des arbres sans dents de scie
    const top = new Map(fine.vegetation.map(([x]) => [x,
      Math.max(...fine.vegetation.filter(([v]) => Math.abs(v - x) <= 0.25 + 1e-6).map(([, z]) => z))]));
    const near = (x) => {  // moyenne des sommets à 1 m près
      const v = [...top].filter(([u]) => Math.abs(u - x) <= 1 + 1e-6).map(([, z]) => z);
      return v.reduce((a, b) => a + b, 0) / v.length;
    };
    for (const [x] of fine.vegetation) {
      const z = near(x);
      if (x < xmin || x > xmax) { prev = null; continue; }
      if (!(z <= peaks.get(x < 0)?.[1])) peaks.set(x < 0, [x, z]);
      d += `${prev !== null && x - prev <= 0.5 + 1e-6 ? "L" : "M"}${X(x).toFixed(1)},${Math.max(ceiling, Z(z)).toFixed(1)}`;
      prev = x;
    }
    if (show.vegetation) svg.append(el("path", { d, class: "vegetation" }));
    // À l'échelle seulement : canopée hors du cadre, sa hauteur au-dessus de la plateforme, comme les graduations
    for (const [x, z] of trueScale ? peaks.values() : []) {
      if (z - ref <= zmax) continue;
      canopy = true;
      if (show.canopee) svg.append(el("text", { x: Math.max(LEFT + 50, Math.min(W - RIGHT - 50, X(x))), y: TOP + 14,
        class: "etiquette-profil place canopee", "data-sans-connecteur": "", "text-anchor": "middle" },
        `canopée +${num(z - ref, 0)} m`));
    }
    return canopy;
  }

  /** Lecture du graphique, en clair, sous les résultats : une ligne par élément dessiné (canopy : canopée nommée). */
  function legendLines(profile, main, fine, plants, camera, factor, canopy, show = SHOW, near = [5, 10]) {
    const from = profile.origine === "caméra" ? "la caméra" : "l'axe de la route (position GPS non vérifiée RTK)";
    return [
      `Coupe du terrain vue dans le sens de la photo, depuis ${from}\u00a0; 0 = la plateforme sous ${
        profile.origine === "caméra" ? "la caméra" : "l'axe"}.`,
      [`Trait brun\u00a0: travers de la photo${near.length ? ` · pointillés\u00a0: travers à ${near.join(" et ")} m devant et derrière` : ""}`
        + `${show.chute || show.talus ? " · trait gris\u00a0: travers où la chute ou le dévers ont été mesurés" : ""}.`,
      [...(near.length ? ["voisin"] : []), ...(show.chute || show.talus ? ["mesure"] : [])]],
      ...(show.camera && profile.origine === "caméra" && factor === 1
        ? [`Point bleu\u00a0: la caméra, à ${num(camera, 2)} m au-dessus de la plateforme.`] : []),
      ...(show.separateur && main.separateur ? ["Petite barre verticale\u00a0: milieu du séparateur de chaussée (terre-plein central), "
        + `${main.separateurRelief
        ? main.separateurRelief === "nuage"
          ? "trouvé dans le nuage LiDAR\u00a0: bande non revêtue (herbe, gravillons, glissières) entre les deux chaussées"
          : main.separateurRelief === "bosse" ? "trouvé dans le relief\u00a0: bosse étroite (assise de glissières ou de muret)"
          : `trouvé dans le relief entre deux marches du terrain (${num(Math.abs(main.separateur[1] - main.separateur[0]))} m de large)`
        : `placé d'après les largeurs BD TOPO (pas de marche du terrain trouvée${
          fine ? ", ni de bande non revêtue dans le nuage LiDAR" : ""})`}\u00a0; la plateforme va jusqu'au bord `
        + "extérieur de l'autre chaussée."] : []),
      ...(fine ? [`Analyse fine (nuage LiDAR HD, ${fine.points} points du sol)${show.peintures ? "\u00a0: carrés blancs, lignes blanches lues à "
        + "l'intensité du retour laser." : "."}`] : []),
      ...(show.eau && ((profile.eau || []).length || fine?.eau?.length) ? [[`Bleu\u00a0: eau${(profile.eau || []).length ? ` de la BD TOPO (${profile.eau
        .map((w) => (w.x !== undefined
          ? `${w.nom || (w.nature || "cours d'eau").toLowerCase()} à ${num(Math.abs(w.x))} m ${w.x < 0 ? "à gauche" : "à droite"}`
          : `${(w.nature || "plan d'eau").toLowerCase()} de ${num(Math.min(Math.abs(w.de), Math.abs(w.a)))} `
            + `à ${num(Math.max(Math.abs(w.de), Math.abs(w.a)))} m `
            + `${w.de + w.a < 0 ? "à gauche" : "à droite"} (bande bleue sur le terrain, `
            + "au niveau de l'eau)")).join(", ")})` : ""}${fine?.eau?.length
        ? `${(profile.eau || []).length ? "\u00a0; " : " "}surface de l'eau lue dans le nuage LiDAR (ligne bleue), `
          + "au niveau du jour du relevé" : ""}.`, ["eau"]]] : []),
      ...(plants && show.herbe && fine?.herbe?.length ? [["Pointillé vert clair sur le terrain\u00a0: herbe au sol (surface non revêtue très claire au laser "
        + "infrarouge\u00a0; gravillons et béton, moins clairs, n'y sont pas)" + ["gauche", "droit"].map((side) => {
          const sign = side === "gauche" ? -1 : 1, mine = fine.herbe.filter(([a, b]) => sign * (a + b) > 0);
          return mine.length
            ? `\u00a0; ${side}\u00a0: dès ${num(Math.min(...mine.map(([a, b]) => Math.min(Math.abs(a), Math.abs(b)))))} m` : "";
        }).join("") + ".", ["herbe"]]] : []),
      ...(plants && show.vegetation && fine?.vegetation?.length
        ? [["Ligne verte\u00a0: hauteur maximale de la végétation (herbe haute, arbustes, arbres, classés par "
        + "l'IGN) sur ±1 m le long de la route, coupée en haut du graphique"
        + (canopy && show.canopee ? " (« canopée +… m »\u00a0: sa hauteur au-dessus de la plateforme)" : "") + ["gauche", "droit"].map((side) => {
          const sign = side === "gauche" ? -1 : 1, seen = fine.vegetation.filter(([x]) => sign * x > 0);
          if (!seen.length) return "";
          const above = ([x, z]) => z - (zAt(main.points, x) ?? z);
          const top = seen.reduce((a, b) => (above(b) > above(a) ? b : a));
          const first = seen.reduce((a, b) => (Math.abs(b[0]) < Math.abs(a[0]) ? b : a));
          return `\u00a0; ${side}\u00a0: dès ${num(Math.abs(first[0]))} m, jusqu'à ${num(above(top))} m au-dessus du sol`;
        }).join("") + ".", ["vegetation"]]] : []),
      ...(show.bords ? [["Traits verticaux de bord\u00a0: trait plein, bord mesuré (rupture de pente de ce travers, ou bord "
        + "recalé sur la carte)\u00a0; tirets longs, « bord supposé », hypothèse et non mesure.", ["bord-mesure", "bord-suppose"]]] : []),
      ...(show.bords && ["gauche", "droit"].some((side) => main.bords[side]?.voisins)
        ? ["« Travers voisins » sous un bord : pas de rupture de pente sur ce travers (ou une trop loin des "
          + "autres) ; bord supposé, placé à la médiane des travers voisins où elle a été trouvée."] : []),
      ...(show.chute || show.talus ? [`Chute et dévers lus du bord jusqu'à ce que le terrain remonte de ${num(profile.remontee, 0)} m au-dessus du bord `
        + "(talus, butte)\u00a0: derrière, ce n'est pas une chute."] : []),
      `${factor > 1 ? `Hauteurs exagérées ×${factor} pour la lisibilité` : "Hauteurs à l'échelle des distances"}. `
        + `Terrain ${profile.source} (IGN), altitudes à ±${num(profile.erreur)} m près.`,
      ...(profile.en_long?.points?.length && longLegend(profile.en_long, show, profile) ? [longLegend(profile.en_long, show, profile)] : []),
    ];
  }

  // Avertissement d'un profil sur un pont ou à ses abords (option « Autoriser le profil sur les ponts »), dans le coin du graphique, le PNG et le PDF
  const PLATEFORME_SUR_PONT = false;  // temporaire (28/11/2026) : plateforme grise affichée aussi sur un pont ?
  const BRIDGE_WARNING = "Pont\u00a0: relief LiDAR peut-être faux (dessous du pont ou abords)";

  /** Chute et dévers de chaque côté, dessinés sur le travers où ils ont été mesurés (svg) ; rend leur liste pour la
   * légende (une puce par côté, et la plateforme). */
  function drawResults(svg, profile, all, main, { X, Z, path }, show = SHOW, has = {}) {
    const results = document.createElement("ul");
    if (profile.carrefour?.texte) {  // carrefour près de la photo : en tête, les bords qui suivent sont peu sûrs
      const item = document.createElement("li");
      item.append(symbol("carrefour"), html("b", "carrefour", `\u26a0\u00a0${profile.carrefour.texte}`));
      results.append(item);
    }
    if (profile.pont && show.pontAutorise) {  // profil autorisé sur un pont ou ses abords : relief LiDAR douteux, en tête aussi
      const item = document.createElement("li");
      item.append(symbol("carrefour"), html("b", "carrefour", `\u26a0\u00a0${BRIDGE_WARNING}`));
      results.append(item);
    }
    if (profile.plateforme && (PLATEFORME_SUR_PONT || !profile.pont)) {  // temporaire (28/11/2026) : rien sur un pont
      has.devers = true;
      if (show.devers) {
        const item = document.createElement("li");
        item.append(html("b", "", "Plateforme\u00a0: "), platformText(profile.plateforme));
        results.append(item);
      }
    }
    for (const side of ["gauche", "droit"]) {
      const r = profile.resultats[side], sign = side === "gauche" ? -1 : 1;
      const item = document.createElement("li");
      item.append(html("b", "", `Côté ${side}\u00a0: `));
      item.dataset.cote = side;  // mis en évidence avec sa flèche et sa droite au survol (survol)
      has.chute = true;  // la chute, ou la raison de son absence, à dire
      if (!r) {
        if (!show.chute) continue;
        const stop = profile.arrets[side];
        item.append(stop === undefined ? `pas de chute de 0,5 m ou plus jusqu'à ${num(profile.zone, 0)} m du milieu de la chaussée`
          : `pas de chute avant le terrain qui remonte de ${num(profile.remontee, 0)} m (talus, butte), à ${dist(stop)} m du bord`);
        results.append(item);
        continue;
      }
      if (r.devers) has.talus = true;
      const t = all.get(r.chute[3]) || main, b = t.bords[side].x;
      const where = t === main ? "" : ` (travers à ${t.along > 0 ? "+" : "−"}${Math.abs(t.along)} m)`;
      // travers de la chute et du dévers, s'ils ne sont pas celui de la photo : en trait plein, nommés à leur bout ; ceux d'un
      // élément masqué ne sont pas dessinés
      const shown = new Set();
      for (const along of [show.chute ? r.chute[3] : null, show.talus && r.devers ? r.devers[2] : null]) {
        const tr = all.get(along);
        if (!tr || tr === main || shown.has(tr)) continue;
        shown.add(tr);
        const end = sign < 0 ? tr.points[0] : tr.points.at(-1);
        // sous le terrain de la photo (dessiné avant lui), transparent : il ne le masque pas
        svg.insertBefore(el("path", { d: path(tr.points), class: "travers-mesure" }), svg.querySelector(".terre"));
        svg.append(el("text",
          { x: X(end[0]) - sign * 2, y: Z(end[1]) - 6, class: "graduation place", "data-chaussee": "", "data-prio": 4, "data-ancre": `${X(end[0])},${Z(end[1])}`,
            "text-anchor": sign < 0 ? "start" : "end" },
            `travers à ${tr.along > 0 ? "+" : "−"}${Math.abs(tr.along)} m`));
      }
      if (show.chute) {
        const top = zAt(t.points, b), xLow = b + sign * r.chute[1], low = top - r.chute[0];
        // étiquette à l'extérieur de la flèche, sauf si elle sortirait du cadre
        const out = sign < 0 ? X(xLow) - 100 > 0 : X(xLow) + 100 < W, toward = out ? sign : -sign;
        svg.append(el("line", { x1: X(b), x2: X(xLow), y1: Z(top), y2: Z(top), class: "repere-chute" }),
          el("line", { x1: X(xLow), x2: X(xLow), y1: Z(top), y2: Z(low), class: "chute", "data-cote": side, "marker-end": "url(#fleche)" }),
          el("text", { x: X(xLow) + toward * 6, y: (Z(top) + Z(low)) / 2, class: "etiquette-profil chute-texte place",
            "data-prio": 1, "data-couleur": "chute", "data-ancre": `${X(xLow)},${(Z(top) + Z(low)) / 2}`, "text-anchor": toward < 0 ? "end" : "start" }, `chute ${r.chute[2] ? "≥ " : ""}${num(r.chute[0])} m`));
        item.append(symbol("chute"), html("span", "chute", `chute ${r.chute[2] ? "d'au moins " : "de "}${num(r.chute[0])} m`),
          ` ${r.chute[2] ? "au-delà de" : "à"} ${dist(r.chute[1], r.chute[2])} m du bord${where}`);
      }
      if (r.devers && show.talus) {
        // talus : droite de son haut à son pied (pente moyenne), sur le travers où il a été mesuré
        const td = all.get(r.devers[2]) || main, bd = td.bords[side].x;
        const x0 = bd + sign * r.devers[1], x1 = bd + sign * r.devers[3];
        const [z0, z1] = [zAt(td.points, x0), zAt(td.points, x1)];
        // étiquette contre la droite ; sous elle si le talus est presque à plat (hauteurs à l'échelle)
        const flat = Math.abs(Z(z0) - Z(z1)) < 60;
        svg.append(el("line", { x1: X(x0), y1: Z(z0), x2: X(x1), y2: Z(z1), class: "devers", "data-cote": side }),
          el("text", { x: X((x0 + x1) / 2) - (flat ? 0 : sign * 12), y: flat ? Math.max(Z(z0), Z(z1)) + 18 : Z((z0 + z1) / 2) + 4,
            class: "etiquette-profil devers-texte place", "data-prio": 2, "data-couleur": "devers",
            "data-ancre": `${X((x0 + x1) / 2)},${Z((z0 + z1) / 2)}`, "text-anchor": flat ? "middle" : sign < 0 ? "start" : "end" },
          r.devers[5] ? "paroi" : `dévers ${num(100 * r.devers[0], 0)} %`));
        // paroi quasi verticale (App.WALL_SLOPE) : sans pourcentage, le MNT adoucit les murs
        const where2 = td === main ? "" : `, travers à ${td.along > 0 ? "+" : "−"}${Math.abs(td.along)} m`;
        const link = show.chute ? " · " : "";
        if (r.devers[5]) {
          item.append(link, symbol("devers"), html("span", "devers", "paroi quasi verticale"),
            ` (mur, enrochement\u00a0: ${num(r.devers[4])} m de haut${where2})`);
        } else {
          item.append(link, symbol("devers"), html("span", "devers", `dévers du talus ${num(100 * r.devers[0], 0)}\u00a0%`),
            ` (pente moyenne\u00a0: ${num(r.devers[4])} m de haut sur ${num(Math.abs(x1 - x0))} m${where2})`);
        }
      }
      if (item.childNodes.length > 1) results.append(item);
    }
    return results;
  }

  const html = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text });

  /** Petit symbole (svg 22 × 10) devant une ligne de la légende : le tracé du graphique, avec les mêmes classes CSS (donc
   * les mêmes couleurs, claires ou sombres). kind : voisin, mesure, herbe, vegetation, chute, devers, eau, carrefour,
   * bord-mesure ou bord-suppose. */
  function symbol(kind) {
    const svg = el("svg", { viewBox: "0 0 22 10", class: "profil-svg symbole", "aria-hidden": "true" });
    const line = (cls, attrs = {}) => svg.append(el("line", { x1: 1, x2: 21, y1: 5, y2: 5, class: cls, ...attrs }));
    if (kind === "voisin") line("autre-travers");
    else if (kind === "mesure") line("travers-mesure");
    else if (kind === "herbe") line("herbe");
    else if (kind === "vegetation") line("vegetation");
    else if (kind === "eau") line("eau-surface");
    else if (kind === "bord-mesure") line("bord", { "data-bord": "mesure" });
    else if (kind === "bord-suppose") line("bord bord-suppose", { "data-bord": "suppose" });
    else if (kind === "devers") line("devers", { x1: 3, x2: 19 });
    else if (kind === "carrefour") svg.append(el("rect", { x: 1, y: 1, width: 20, height: 8, rx: 2, class: "mention-carrefour" }));
    else if (kind === "chute") {  // flèche : son propre marqueur (l'identifiant du graphique n'est pas dans cette légende)
      const marker = el("marker", { id: "fleche-legende", viewBox: "0 0 10 10", refX: 10, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto" });
      marker.append(el("path", { d: "M0,0L10,5L0,10Z", class: "fleche" }));
      svg.append(el("defs", {}), el("line", { x1: 2, x2: 19, y1: 5, y2: 5, class: "chute", "marker-end": "url(#fleche-legende)" }));
      svg.firstChild.append(marker);
    }
    return svg;
  }
  /** Ligne de légende (p) : text, précédé des symboles kinds (liste de symbol) s'il y en a. */
  const legendRow = (text, kinds = []) => {
    const p = html("p", "aide", text);
    p.prepend(...kinds.map(symbol));
    return p;
  };

  /** Graphique SVG et sa légende en clair (texte) pour profile (voir App._compute_edges) ; trueScale : hauteurs
   * à la même échelle que les distances.
   * imposed : cadre rendu par un dessin précédent du même profil (`cadre`), pour qu'une case (bord d'enrobé, végétation)
   * ne déplace ni ne change l'échelle du graphique : { x: [min, max], z: {...} ou null } ; sans z (hauteurs à l'échelle
   * changées), seules les bornes en distance sont gardées. Le terrain est alors lu sur ces bornes, non sur la zone
   * autour du milieu de la chaussée ; plus court, il laisse du blanc. Sans imposed, le cadre est recalculé.
   * Rend aussi `cadre`, à repasser au prochain dessin. */
  // fine : analyse fine (Nuage.analyse) : séparateur et bords de chaussée tirés du nuage LiDAR, lignes blanches
  // plants : végétation de l'analyse fine (ligne verte, herbe) dessinée et légendée
  // camera : hauteur de la caméra au-dessus du sol (celle retenue pour la photo, App._camera_used ; réglage « Hauteur de caméra » en dernier rang), pour le profil en long
  // options : éléments masqués par les « Options avancées » de la fenêtre (clés de SHOW, vraies par défaut) ; un élément masqué n'est pas
  // créé. Rend aussi `presence` : ce que ce profil pourrait montrer, masqué ou non (cases des options grisées sans objet).
  // Les coupes voisines (±5 et ±10 m) ne sont pas un affichage : écartées, Python ne les lit plus (App.set_edge_along)
  function draw(profile, trueScale = false, fine = null, plants = true, camera = 1.9, imposed = null, options = {}) {
    const show = { ...SHOW, ...options }, has = {};
    const near = neighbours(profile);
    const all = crossings(profile, imposed?.x);
    const main = all.get(0) || [...all.values()][0];
    if (fine?.separateur) [main.separateur, main.separateurRelief] = [[...fine.separateur].sort((a, b) => a - b), "nuage"];
    has.separateur = Boolean(main.separateur);
    const f = frame(profile, all, main, trueScale, camera, imposed);
    const { ref, bl, br, road, xmin, xmax, zmin, zmax, factor, plotW, plotH, X, Z, path } = f;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "profil-svg", role: "img",
      "aria-label": "Coupe du terrain en travers de la route" });

    // Repères : mètres en travers, hauteurs par rapport à la plateforme
    const xStep = xmax - xmin > 30 ? 5 : 2;
    for (let x = Math.ceil(f.extent[0] / xStep) * xStep; x <= f.extent[1]; x += xStep) {
      svg.append(el("line", { x1: X(x), x2: X(x), y1: TOP, y2: TOP + plotH, class: "grille" }),
        el("text", { x: X(x), y: TOP + plotH + 16, class: "graduation", "text-anchor": "middle" }, `${Math.abs(x)} m`));
    }
    const zStep = [0.25, 0.5, 1, 2, 5].find((s) => (zmax - zmin) / s <= 7) || 10;
    for (let z = Math.ceil(zmin / zStep) * zStep; z <= zmax; z += zStep) {
      svg.append(el("line", { x1: LEFT, x2: LEFT + plotW, y1: Z(z + ref), y2: Z(z + ref), class: z ? "grille" : "grille zero" }),
        el("text", { x: LEFT - 6, y: Z(z + ref) + 4, class: "graduation", "text-anchor": "end" },
          `${z > 0 ? "+" : ""}${num(z, zStep < 1 ? 2 : 0)}`));
    }
    // Source des altitudes, en haut à gauche : l'image enregistrée la garde
    svg.append(el("text", { x: 4, y: 16, class: "etiquette-profil" }, `Mesure ${profile.source}`),
      el("text", { x: 4, y: 32, class: "graduation" }, `altitudes à ±${num(profile.erreur)} m`));
    svg.append(el("text", { x: LEFT, y: H - 6, class: "graduation" }, "← gauche"),
      el("text", { x: LEFT + plotW, y: H - 6, class: "graduation", "text-anchor": "end" }, "droite →"),
      el("text", { x: LEFT + plotW / 2, y: H - 6, class: "graduation", "text-anchor": "middle" },
        `distance à ${profile.origine === "caméra" ? "la caméra" : "l'axe de la route"}`));

    // Terrain : les autres travers en pointillés, celui de la photo plein, la terre sous lui
    for (const t of all.values()) if (t !== main) svg.append(el("path", { d: path(t.points), class: "autre-travers" }));
    const bottom = TOP + plotH;
    svg.append(el("path",
      { d: `${path(main.points)}L${X(main.points.at(-1)[0])},${bottom}L${X(main.points[0][0])},${bottom}Z`, class: "terre" }),
      el("path", { d: path(main.points), class: "sol" }));

    // Plateforme entre les deux bords du travers de la photo
    if (road.length > 1) {
      const under = Math.max(...road.map(([, z]) => Z(z)));  // sous le point le plus bas : pas de texte sur une chaussée en dévers
      const roadAt = `${X((bl + br) / 2)},${Z(zAt(main.points, (bl + br) / 2) ?? ref)}`;
      // Temporaire (28/11/2026) : plateforme grise et étiquettes de la plateforme (largeur, dévers) masquées sur les ponts, à revoir (PLATEFORME_SUR_PONT = true la rétablit)
      const grise = PLATEFORME_SUR_PONT || !profile.pont;
      if (show.plateforme && grise) svg.append(el("path", { d: path(road), class: "chaussee" }));
      if (show.largeurs && grise) {
        svg.append(el("text", { x: X((bl + br) / 2), y: under + 26, class: "etiquette-profil place", "data-prio": 3, "data-cle": "plateforme", "data-chaussee": "",
          "data-ancre": roadAt, "text-anchor": "middle" },
          `plateforme ${num(br - bl)} m`));
      }
      const slope = platformLabel(profile.plateforme);
      has.plateforme = grise;
      has.largeurs = grise;
      has.devers = grise && Boolean(slope);
      if (slope && show.devers && grise) {
        // sous la largeur, qu'elle suit ; seule (largeur masquée), posée comme elle l'aurait été
        svg.append(el("text", { x: X((bl + br) / 2), y: under + (show.largeurs ? 42 : 26), class: "etiquette-profil place", "data-prio": 3, "data-chaussee": "",
          ...(show.largeurs ? { "data-suite": "plateforme" } : { "data-ancre": roadAt }), "text-anchor": "middle" }, slope));
      }
    }
    for (const side of show.bords ? ["gauche", "droit"] : []) {
      const b = main.bords[side];
      if (!b) continue;
      // nom vers l'extérieur ; vers l'intérieur si l'extérieur sortirait du graphique
      const sub = b.manuel ? "" : b.relief ? "rupture de pente" : b.voisins ? "travers voisins" : "largeur type";
      const wide = Math.max(textWidth(b.relief || b.manuel ? "bord" : "bord supposé", 13, 500), textWidth(sub, 12)) + 8;
      const out = side === "gauche" ? X(b.x) - wide > 2 : X(b.x) + wide < W - 2, toward = (side === "gauche" ? -1 : 1) * (out ? 1 : -1);
      const anchor = toward < 0 ? "end" : "start", dx = 4 * toward;
      // Bord mesuré (rupture de pente de ce travers, ou recalé) : trait plein (style.css) ; bord supposé (largeur type, ou
      // médiane des travers voisins) : tirets longs et pâles, et l'étiquette le dit
      const measured = Boolean(b.relief || b.manuel);
      svg.append(el("line", { x1: X(b.x), x2: X(b.x), y1: TOP - 4, y2: Z(zAt(main.points, b.x)), class: measured ? "bord" : "bord bord-suppose",
          "data-bord": measured ? "mesure" : "suppose" }),
        el("text", { x: X(b.x) + dx, y: TOP - 26, class: "etiquette-profil", "text-anchor": anchor }, measured ? "bord" : "bord supposé"),
        ...(sub ? [el("text", { x: X(b.x) + dx, y: TOP - 12, class: "graduation", "text-anchor": anchor }, sub)] : []));
    }
    has.bords = Object.keys(main.bords).length > 0;
    // Séparateur de chaussée (chaussées séparées, ticket #34) : petite barre verticale posée sur le terrain en son milieu
    // (d'après la BD TOPO), nommée au-dessus ; autrement que les bords, qui seuls limitent la plateforme
    if (show.separateur && main.separateur) {
      const [s0, s1] = main.separateur, gx = X((s0 + s1) / 2), gy = Z(zAt(main.points, (s0 + s1) / 2));
      // d'où vient sa position : dans la légende
      const label = el("text", { x: gx, y: gy - 24, class: "graduation place", "data-haut": "", "data-ancre": `${gx},${gy - 10}`, "text-anchor": "middle" },
        "séparateur de chaussée");
      svg.append(el("line", { x1: gx, x2: gx, y1: gy - 2, y2: gy - 18, class: "separateur" }), label);
    }
    // Analyse fine : hauteur maximale de la végétation (ligne verte, coupée en haut du graphique, interrompue là où il n'y
    // en a pas), lignes blanches (petits rectangles blancs sur le terrain) et bords de chaussée (tirets courts)
    // Eau : surfaces de la BD TOPO (bande bleue posée sur le terrain : sur l'eau, le laser ne voit que la surface, le
    // terrain LiDAR y est à son niveau), cours d'eau (repère bleu nommé), surface lue dans le nuage (analyse fine)
    // tracé du terrain de la photo entre a et b, dans le cadre et sans dépasser le terrain lu (au-delà, pas d'altitude)
    const [g0, g1] = [main.points[0][0], main.points.at(-1)[0]];
    const onGround = (a, b) => {
      const [lo, hi] = [Math.max(a, xmin, g0), Math.min(b, xmax, g1)];
      const inside = main.points.map(([x]) => x).filter((x) => x > lo && x < hi);
      const at = [lo, ...inside, hi].filter((x, k, all) => k === 0 || x > all[k - 1]);
      return at.length < 2 ? null
        : at.map((x, k) => `${k ? "L" : "M"}${X(x).toFixed(1)},${(Z(zAt(main.points, x) ?? ref) - 3).toFixed(1)}`).join("");
    };
    has.eau = Boolean((profile.eau || []).length || fine?.eau?.length);
    if (show.eau) drawWater(svg, profile, fine, f, main, onGround);
    const canopy = plants && fine?.vegetation?.length ? drawVegetation(svg, fine, f, trueScale, show) : false;
    has.vegetation = Boolean(fine?.vegetation?.length);
    has.canopee = canopy;
    has.herbe = Boolean(fine?.herbe?.length);
    has.peintures = Boolean(fine?.lignes?.length);
    if (fine) {
      for (const [a, b] of plants && show.herbe ? fine.herbe || [] : []) {  // herbe au sol : bande vert clair posée sur le terrain
        const d = onGround(a, b);
        if (d) svg.append(el("path", { d, class: "herbe" }));
      }
      // sur la plateforme seulement (entre les bords, à 1 m près) : ailleurs, herbe ou cailloux clairs en bande étroite
      for (const x of show.peintures ? fine.lignes : []) {
        if (x < Math.max(xmin, g0, bl - 1) || x > Math.min(xmax, g1, br + 1)) continue;
        svg.append(el("rect", { x: X(x) - 3, y: Z(zAt(main.points, x) ?? ref) - 3, width: 6, height: 6, class: "ligne-blanche" }));
      }
    }
    // Caméra à sa hauteur au-dessus de la plateforme, hauteurs à l'échelle seulement (exagérées, sa place ne voudrait rien
    // dire : masquée) ; profil depuis l'axe : son repère posé sur la plateforme
    has.camera = profile.origine !== "caméra" || factor === 1;
    if (show.camera && profile.origine !== "caméra") {
      svg.append(el("circle", { cx: X(0), cy: Z(ref) - 8, r: 5, class: "origine" }),
        el("text", { x: X(0), y: Z(ref) - 18, class: "graduation place", "data-haut": "", "data-chaussee": "",
          "data-ancre": `${X(0)},${Z(ref) - 8}`, "text-anchor": "middle" }, "axe"));
    } else if (show.camera && profile.origine === "caméra" && factor === 1) {
      svg.append(el("line", { x1: X(0), x2: X(0), y1: Z(ref), y2: Z(ref + camera), class: "bord" }),
        el("circle", { cx: X(0), cy: Z(ref + camera), r: 5, class: "origine" }),
        el("text", { x: X(0) + 9, y: Z(ref + camera) + 4, class: "graduation place", "data-haut": "", "data-chaussee": "",
          "data-ancre": `${X(0)},${Z(ref + camera)}` }, "caméra"));  // à droite du point
    }

    const results = drawResults(svg, profile, all, main, f, show, has);  // chute et dévers, et leur liste pour la légende
    // droites du dévers juste au-dessus du terrain : sous la végétation, l'eau, les flèches et les textes
    const ground = svg.querySelector("path.sol");
    for (const line of [...svg.querySelectorAll("line.devers")].reverse()) ground.after(line);
    // Mention « Hauteurs ×N » (hauteurs exagérées seulement), en haut à gauche du cadre : coin libre (les étiquettes du
    // dessin suivent le terrain, les bords sont nommés au-dessus du cadre). Sa place est réservée à declutter (obstacle),
    // qui écarte les étiquettes « place » ; posée en dernier, sur un fond opaque, elle reste lisible et entre dans le PNG et le PDF.
    const mention = factor > 1 ? `Hauteurs ×${num(factor, 0)}` : "";
    const mentionBox = [LEFT + 2, TOP + 2, LEFT + 12 + textWidth(mention, 13, 500, 0.6), TOP + 24];
    // Carrefour près de la photo (App._junction_near) : « Carrefour : bords peu sûrs » dans le coin haut droit, aussi dans
    // le PNG et le PDF ; la phrase entière en tête de la légende
    // Pont ou abords (profile.pont) avec l'option cochée : « Pont : relief LiDAR peut-être faux… », même style, à gauche du carrefour
    // s'il y en a un ; jamais masquée par les autres options
    const banners = [];
    let right = W - RIGHT - 2;
    for (const text of [profile.carrefour ? "⚠ Carrefour\u00a0: bords peu sûrs" : "", profile.pont && show.pontAutorise ? `⚠ ${BRIDGE_WARNING}` : ""]) {
      if (!text) continue;
      const width = textWidth(text, 13, 500, 0.6) + 18;
      banners.push({ text, width, box: [right - width, TOP + 2, right, TOP + 24] });
      right -= width + 6;
    }
    declutter(svg, { top: TOP, bottom: TOP + plotH, left: LEFT, right: LEFT + plotW }, [...(mention ? [mentionBox] : []), ...banners.map((b) => b.box)],
      { mode: ETIQ.mode, ceiling: f.ceiling });
    for (const { text, width, box } of banners) {
      svg.append(el("rect", { x: box[0], y: box[1], width, height: 22, rx: 3, class: "mention-echelle mention-carrefour" }),
        el("text", { x: box[2] - 5, y: TOP + 18, "text-anchor": "end", class: "etiquette-profil mention-carrefour-texte" }, text));
    }
    if (mention) {
      svg.append(el("rect", { x: mentionBox[0], y: mentionBox[1], width: mentionBox[2] - mentionBox[0], height: 22, rx: 3, class: "mention-echelle" }),
        el("text", { x: LEFT + 7, y: TOP + 18, class: "etiquette-profil mention-echelle-texte" }, mention));
    }
    drawKey(svg, { herbe: show.herbe && !plants && Boolean(fine?.herbe?.length), vegetation: show.vegetation && !plants && Boolean(fine?.vegetation?.length) }, near);  // clé de lecture sous le cadre : agrandit le viewBox, le graphique garde sa taille
    const marker = el("marker", { id: "fleche", viewBox: "0 0 10 10", refX: 10, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" });
    marker.append(el("path", { d: "M0,0L10,5L0,10Z", class: "fleche" }));
    svg.prepend(el("defs", {}));
    svg.firstChild.append(marker);

    // Lecture du graphique, sous les résultats, en discret
    const legend = document.createElement("div");
    legend.append(results, ...legendLines(profile, main, fine, plants, camera, factor, canopy, show, near).map((t) => (Array.isArray(t) ? legendRow(...t) : html("p", "aide", t))));
    // PDF : avec la 2e page
    if (profile.en_long?.points?.length && longLegend(profile.en_long, show, profile)) legend.lastElementChild.classList.add("legende-long");
    survol(svg, f, main, profile, legend);
    const long = drawLong(profile.en_long, camera, show, profile);
    Object.assign(has, long?.presence);
    return { svg, legend, long: long?.svg ?? null, cadre: f.cadre, exageration: f.exageration, presence: has };
  }

  /** Survol (et toucher) du graphique en travers : réticule (trait vertical, point sur le terrain de la photo) et étiquette
   * « distance à la caméra, position par rapport au bord, hauteur par rapport à la plateforme » ; la flèche de chute ou la
   * droite de dévers à moins de NEAR unités du pointeur est mise en évidence (classe « survol »), avec son côté dans la légende.
   * Le groupe « reticule » n'existe que pendant le survol : il n'entre ni dans le PNG ni dans le PDF (voir sansSurvol). */
  const NEAR = 10;
  /** Distance d'un point (px, py) au segment [(x1, y1), (x2, y2)] (unités du viewBox). */
  const segmentDistance = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
    return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
  };
  /** Texte des trois lignes de l'étiquette pour l'abscisse x (m depuis l'origine) du terrain de la photo, ou null hors du terrain lu. */
  function survolTexte(x, z, ref, main, origine) {
    const away = Math.abs(x);
    const from = origine === "caméra" ? "de la caméra" : "de l'axe";
    const first = away < 0.05 ? `à la verticale ${origine === "caméra" ? "de la caméra" : "de l'axe"}` : `${num(away)} m à ${x < 0 ? "gauche" : "droite"} ${from}`;
    const [left, right] = [main.bords.gauche?.x, main.bords.droit?.x];
    let second = "";
    if (left !== undefined && x < left) second = `${num(left - x)} m au-delà du bord gauche`;
    else if (right !== undefined && x > right) second = `${num(x - right)} m au-delà du bord droit`;
    else if (left !== undefined && right !== undefined) second = "sur la chaussée";
    const dz = z - ref;
    const third = Math.abs(dz) < 0.005 ? "au niveau de la plateforme"
      : `${num(Math.abs(dz), 2)} m ${dz < 0 ? "sous" : "au-dessus de"} la plateforme`;
    return [first, ...(second ? [second] : []), third];
  }
  function survol(svg, f, main, profile, legend) {
    const { ref, xmin, plotW, plotH, sx, X, Z } = f;
    const clear = () => {
      svg.querySelector("g.reticule")?.remove();
      svg.querySelectorAll(".survol").forEach((n) => n.classList.remove("survol"));
      legend.querySelectorAll("li.survol").forEach((n) => n.classList.remove("survol"));
    };
    svg.addEventListener("pointerleave", clear);
    svg.addEventListener("pointercancel", clear);
    svg.addEventListener("pointermove", (event) => {
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      clear();
      if (at.x < LEFT || at.x > LEFT + plotW || at.y < TOP || at.y > TOP + plotH) return;  // hors du cadre : rien
      const x = xmin + (at.x - LEFT) / sx, z = zAt(main.points, x);
      // Mise en évidence : la flèche ou la droite la plus proche, à NEAR unités au plus
      let best = null;
      for (const line of svg.querySelectorAll("line.chute, line.devers")) {
        const d = segmentDistance(at.x, at.y, ...["x1", "y1", "x2", "y2"].map((a) => Number(line.getAttribute(a))));
        if (d <= NEAR && (!best || d < best.d)) best = { d, line };
      }
      if (best) {
        best.line.classList.add("survol");
        legend.querySelector(`li[data-cote="${best.line.dataset.cote}"]`)?.classList.add("survol");
      }
      if (z === null) return;  // pas de terrain lu à cette distance : pas de point
      const lines = survolTexte(x, z, ref, main, profile.origine);
      const width = Math.max(...lines.map((t) => textWidth(t, 12))) + 12, height = 6 + 14 * lines.length;
      const [px, py] = [X(x), Z(z)];
      // étiquette à droite du point, à gauche si elle sortirait du cadre ; au-dessus du point, dessous si elle sortirait en haut
      const bx = px + 10 + width <= LEFT + plotW ? px + 10 : px - 10 - width;
      const by = py - 10 - height >= TOP ? py - 10 - height : Math.min(py + 10, TOP + plotH - height);
      const group = el("g", { class: "reticule" });
      group.append(el("line", { x1: px, x2: px, y1: TOP, y2: TOP + plotH, class: "reticule-trait" }),
        el("circle", { cx: px, cy: py, r: 4, class: "reticule-point" }),
        el("rect", { x: bx, y: by, width, height, rx: 3, class: "reticule-fond" }));
      lines.forEach((t, k) => group.append(el("text", { x: bx + 6, y: by + 16 + 14 * k, class: "reticule-texte" }, t)));
      svg.append(group);
    });
  }
  /** svg sans trace du survol (réticule, mise en évidence), rendu : pour le PNG et le PDF (avant la copie, pour que les styles
   * calculés ne gardent rien du survol). */
  const sansSurvol = (node) => {
    node.querySelector("g.reticule")?.remove();
    node.querySelectorAll(".survol").forEach((n) => n.classList.remove("survol"));
    return node;
  };

  /** Image PNG (Blob) du graphique svg affiché, avec son titre et sa légende legend (élément rendu par draw, dans
   * la page) : styles calculés recopiés (le CSS de la page n'entre pas dans une image SVG), couleurs et graisses
   * de la légende reprises, sur le fond de la fenêtre, en double résolution. */
  // long : profil en long (drawLong), sous le graphique ; absent si null
  async function png(svg, title, legend, long = null) {
    const w = window, scale = 2;
    const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "paint-order",
      "opacity", "stroke-opacity", "font-size", "font-weight", "font-family"];
    const raster = async (source) => {  // image du SVG affiché, styles calculés recopiés, à sa taille (viewBox) × scale
      const copy = sansSurvol(source).cloneNode(true), [, , vw, vh] = source.getAttribute("viewBox").split(" ").map(Number);
      const nodes = [source, ...source.querySelectorAll("*")], copies = [copy, ...copy.querySelectorAll("*")];
      nodes.forEach((node, k) => {
        const style = w.getComputedStyle(node);
        copies[k].setAttribute("style", props.map((p) => `${p}:${style.getPropertyValue(p)}`).join(";"));
      });
      copy.setAttribute("width", vw * scale);
      copy.setAttribute("height", vh * scale);
      const image = new Image();
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(copy));
      await image.decode();
      return { image, height: vh * scale };
    };
    const main = await raster(svg), below = long ? await raster(long) : null;
    const box = w.getComputedStyle(svg.closest("dialog") || document.body), font = w.getComputedStyle(svg).fontFamily;
    const pad = 16 * scale, width = W * scale, head = 40 * scale;
    const top = head + main.height + (below ? 8 * scale + below.height : 0) + 6 * scale;
    // Légende : lignes (puces, paragraphes) coupées à la largeur de l'image, mot à mot, chaque mot à son style
    const g = document.createElement("canvas").getContext("2d"), placed = [];
    let y = top;
    for (const row of legend.querySelectorAll("li, p")) {
      const bullet = row.tagName === "LI", indent = pad + (bullet ? 16 * scale : 0), rowStyle = w.getComputedStyle(row);
      const size = parseFloat(rowStyle.fontSize) * scale, line = size * 1.4;
      y += line + (!bullet && row.previousElementSibling?.tagName === "UL" ? 8 * scale : 0);  // écart puces / lecture
      if (bullet) placed.push({ text: "•", x: pad + 4 * scale, y, font: `${size}px ${font}`, color: rowStyle.color });
      let x = indent;
      for (const node of row.childNodes) {
        const style = node.nodeType === 1 ? w.getComputedStyle(node) : rowStyle;
        const fontOf = `${style.fontWeight} ${size}px ${font}`;
        g.font = fontOf;
        for (const word of node.textContent.split(/( +)/)) {
          if (!word) continue;
          const width_ = g.measureText(word).width;
          if (word.trim() && x > indent && x + width_ > width - pad) { y += line; x = indent; }
          if (!word.trim() && x === indent) continue;  // pas d'espace en début de ligne
          placed.push({ text: word, x, y, font: fontOf, color: style.color });
          x += width_;
        }
      }
    }
    g.canvas.width = width;
    g.canvas.height = y + pad;
    g.fillStyle = box.backgroundColor;
    g.fillRect(0, 0, g.canvas.width, g.canvas.height);
    g.fillStyle = box.color;
    g.font = `500 ${18 * scale}px ${font}`;
    g.fillText(title, pad, 28 * scale);
    g.drawImage(main.image, 0, head);
    if (below) g.drawImage(below.image, 0, head + main.height + 8 * scale);
    for (const { text, x, y: at, font: f, color } of placed) {
      g.font = f;
      g.fillStyle = color;
      g.fillText(text, x, at);
    }
    return new Promise((resolve) => g.canvas.toBlob(resolve, "image/png"));
  }

  // Cassure du profil en long (calcul seulement, rien n'est dessiné) : deux droites ajustées par moindres carrés, point de cassure choisi au mieux (somme des carrés des écarts
  // minimale). « Nette » = deux profils distincts, pas du bruit ou des ondulations qu'une seule droite lisse ; toutes ces conditions à la fois
  // (seuils provisoires) ; sinon, une seule pente.
  const CASSURE_MIN_PCT = 2;  // écart de pente (points de %) entre les deux parties : au moins
  const CASSURE_MIN_LONG = 20;  // longueur (m) de chaque partie : au moins
  const CASSURE_MIN_PART = 0.25;  // et au moins cette part de la longueur totale du profil
  const CASSURE_GAIN = 0.5;  // écart RMS à deux droites au plus cette part de celui d'une seule droite
  const CASSURE_DROIT = 0.25;  // écart RMS de chaque partie au plus cette part de la hauteur apportée par la cassure (écart de pente × la plus courte partie)
  const CASSURE_SIGMAS = 3;  // écart de pente au moins ce nombre de fois l'incertitude des deux pentes (issue des résidus)
  /** Droite des moindres carrés de pts [d, z] : pente (m/m), altitude à d, somme des carrés des écarts, écart RMS, incertitude de la pente. */
  function lineFit(pts) {
    const n = pts.length, md = pts.reduce((a, [d]) => a + d, 0) / n, mz = pts.reduce((a, [, z]) => a + z, 0) / n;
    const sxx = pts.reduce((a, [d]) => a + (d - md) ** 2, 0), slope = sxx ? pts.reduce((a, [d, z]) => a + (d - md) * (z - mz), 0) / sxx : 0;
    const at = (d) => mz + slope * (d - md), sse = pts.reduce((a, [d, z]) => a + (z - at(d)) ** 2, 0), rms = Math.sqrt(sse / n);
    return { slope, at, sse, rms, sigma: sxx ? rms / Math.sqrt(sxx) : Infinity };
  }
  /** Parties du profil en long (points [d, z], d croissant dans le sens de la photo) : avec cassure nette, deux parties
   * { de, a, pente (%), z0, z1, rms } ; sinon une seule sur tout le profil (cassure: false). null sans assez de points. */
  function cassure(points) {
    const pts = [...points].sort((p, q) => p[0] - q[0]);
    if (pts.length < 6 || pts.at(-1)[0] - pts[0][0] < 1e-6) return null;
    const part = (list) => { const f = lineFit(list), [de, a] = [list[0][0], list.at(-1)[0]];
      return { de, a, pente: 100 * f.slope, z0: f.at(de), z1: f.at(a), rms: f.rms, sigma: f.sigma, sse: f.sse }; };
    const whole = part(pts), total = whole.a - whole.de, minLong = Math.max(CASSURE_MIN_LONG, CASSURE_MIN_PART * total);
    let best = null;
    for (let k = 2; k < pts.length - 2; k++) {  // point de cassure sur un point mesuré, commun aux deux parties
      const [left, right] = [pts.slice(0, k + 1), pts.slice(k)];
      if (left.at(-1)[0] - left[0][0] < minLong || right.at(-1)[0] - right[0][0] < minLong) continue;
      const [a, b] = [part(left), part(right)];
      if (!best || a.sse + b.sse < best[0].sse + best[1].sse) best = [a, b];
    }
    if (best) {
      const [a, b] = best, jump = Math.abs(b.pente - a.pente) / 100, high = jump * Math.min(a.a - a.de, b.a - b.de);
      const rms2 = Math.sqrt((a.sse + b.sse) / pts.length);
      const sharp = 100 * jump >= CASSURE_MIN_PCT && rms2 <= CASSURE_GAIN * whole.rms && Math.max(a.rms, b.rms) <= CASSURE_DROIT * high
        && jump >= CASSURE_SIGMAS * Math.hypot(a.sigma, b.sigma);
      if (sharp) return { cassure: true, parties: best };
    }
    return { cassure: false, parties: [whole] };
  }

  const DECK_SOURCES = { rtk: "altitude RTK des photos", droite: "droite entre les culées", pente: "pente de l'approche prolongée" };
  const BOTTOM_NAMES = { eau: "surface de l'eau (LiDAR)", sec: "terrain naturel (LiDAR)" };  // eau de la BD TOPO sous le pont, ou non
  /** Ponts du profil en long (ouvrages avec leur fond LiDAR « relief », App._long_profile) : le tablier en trait plein, le fond brut dessous en
   * remplissage plus clair (si « Terrain sous les ponts » est cochée), et d'où vient le tablier (discret). */
  const deckBridges = (long) => (long.ouvrages || []).filter((o) => o.type === "pont" && o.relief?.length);
  const bottomName = (o) => BOTTOM_NAMES[o.fond] || "fond (LiDAR)";  // fond inconnu : BD TOPO pas encore lue
  function bridgeLegend(long, show) {
    const deck = deckBridges(long), sources = [...new Set(deck.map((o) => DECK_SOURCES[o.tablier]).filter(Boolean))];
    const names = [...new Set(deck.map(bottomName))];
    return "pont : tablier en trait plein" + (show.fond && deck.length ? `, ${names.join(" ou ")} en remplissage plus clair` : "")
      + (sources.length ? ` (tablier : ${sources.join(", ")})` : "");
  }

  /** Lecture du profil en long (drawLong), pour la légende : une ligne courte (pente moyenne, trait violet, bande des
   * travers, repères pointillés), puis les ponts, creux comblés et tunnels s'il y en a. "" sans profil en long. */
  function longLegend(long, show = SHOW, profile = null) {
    if (!long?.points?.length) return "";
    const kinds = new Set((long.ouvrages || []).map((o) => o.type)), parts = show.ponts ? [
      ...(kinds.has("pont") ? [bridgeLegend(long, show)] : []),
      ...(kinds.has("creux") ? ["creux comblé : creux du terrain sous la route, sans doute un pont absent de la BD TOPO"] : []),
      ...(kinds.has("tunnel") ? ["tunnel : route tracée de bout en bout (tirets)"] : [])] : [];
    const reach = Math.max(0, ...(profile ? neighbours(profile) : [10]));
    const marks = [...(show.carrefours ? ["carrefours", "fins de route"] : []), ...(show.ponts ? ["ponts"] : [])];
    return `Profil en long${show.pentes ? ` : pente moyenne de ${num(Math.abs(long.pente))} % (${long.pente >= 0 ? "montée" : "descente"}). `
      + "Pente en violet : une seule valeur ajustée par moindres carrés sur tout le profil (rien si elle est inférieure à 0,5 %), ou une par "
      + `partie${show.cassure ? ", avec un petit trait à leur limite," : ""} si deux profils nets se dessinent (écart de pente d'au moins ${CASSURE_MIN_PCT} points, parties d'au moins ${CASSURE_MIN_LONG} m, pas du bruit). ` : ". "}`
      + (reach ? `Bande grise : les ${profile ? neighbours(profile).length * 2 + 1 : 5} travers du graphique du dessus (−${reach} à +${reach} m, la photo à 0). ` : "")
      + (marks.length ? `Repères pointillés : ${marks.join(", ")}.` : "")
      + (parts.length ? ` ${parts.join(" · ")}.` : "");
  }

  /** Profil en long (App._compute_edges : en_long, points [d, z], d > 0 dans le sens de la photo) : graphique d'environ
   * 160 px de haut sous le profil en travers, 0 = le sol sous la caméra, la caméra flottant à camera m au-dessus ; null
   * sans données. Pour le lire avec le profil en travers : bande pâle de −10 à +10 m autour de la photo, graduée aux 5
   * travers (−10, −5, 0, +5, +10 m ; la photo en trait plus marqué). Les parties du profil (une, ou deux si cassure nette : voir cassure) ont leur pente calculée, en étiquette violette
   * (le rouge est réservé au dévers), étiquetés avec leur pente ; l'étiquette se place sous le trait, côté bas de la
   * pente, donc aussi en descente. Fins de route, carrefours et ponts sont nommés dans une zone au-dessus du cadre,
   * étagés sans chevauchement (textWidth) et reliés par un pointillé à un point du terrain ; la zone n'a que la hauteur
   * des rangs utilisés. Un repère hors de la bande des travers n'a jamais son nom au-dessus de la bande : le nom se
   * place du côté extérieur et se coupe en lignes plus courtes si la place manque, pour ne pas sembler être à la photo. */
  function drawLong(long, camera = 1.9, show = SHOW, profile = null) {
    if (!long?.points?.length) return null;
    const LW = 760, L = 52, R = 16, B = 56, pw = LW - L - R, ph = 160;
    const [d0, d1] = [-50, 50];  // axe fixe (App.LONG_REACH) ; au-delà du bout du tronçon, pas de terrain : vide
    // Travers du graphique du dessus (profile.profils : coupes retenues, App.set_edge_along), à leur distance dans le sens de la photo
    const cuts = profile
      ? [...new Set(profile.profils.map((p) => (profile.avant === false ? -p.le_long : p.le_long)))].sort((a, b) => a - b) : [-10, -5, 0, 5, 10];
    const BAND = Math.max(0, ...cuts.map(Math.abs));  // demi-largeur de la bande des travers, en m
    const has = {};
    const X = (d) => L + (d - d0) / ((d1 - d0) || 1) * pw;
    const ds = long.points.map(([d]) => d), zs = long.points.map(([, z]) => z);
    const at = (d) => {  // altitude interpolée à la distance d
      const k = ds.findIndex((v) => v >= d);
      if (k < 0) return zs[zs.length - 1];
      return k === 0 ? zs[0] : zs[k - 1] + (zs[k] - zs[k - 1]) * (d - ds[k - 1]) / (ds[k] - ds[k - 1]);
    };
    // Coupe une ligne en morceaux d'au plus max px (mot à mot, un mot trop long reste entier)
    const wrap = (text, max) => {
      const out = [];
      for (const word of text.split(" ")) {
        const last = out.length - 1;
        if (last >= 0 && textWidth(`${out[last]} ${word}`, 13, 500) <= max) out[last] += ` ${word}`;
        else out.push(word);
      }
      return out;
    };
    // Repères (fins de route, carrefours, ponts) : un nom chacun, étagé s'il en recouvre un autre
    const marks = [];
    has.carrefours = (long.fins || []).some((e) => e.d >= d0 && e.d <= d1);
    has.ponts = (long.ouvrages || []).some((o) => Math.min(o.a, d1) > Math.max(o.de, d0));
    has.fond = deckBridges(long).some((o) => Math.min(o.a, d1) > Math.max(o.de, d0));
    for (const e of show.carrefours ? long.fins || [] : []) {
      if (e.d < d0 || e.d > d1) continue;
      // « fin de la D16 » (la route s'arrête : le profil aussi), puis le carrefour ; sinon le carrefour seul
      const road = e.voie ? (/^[A-Z]+\d/.test(e.voie) ? `la ${e.voie}` : e.voie) : "la route";
      const lines = [...(e.type === "fin" ? [`fin de ${road}`] : []), ...(e.avec?.length ? [`carrefour avec ${e.avec.join(", ")}`] : [])];
      marks.push({ d: e.d, lines, kind: e.type, target: at(e.d) });
    }
    for (const o of show.ponts ? long.ouvrages || [] : []) {
      const [a, b] = [Math.max(o.de, d0), Math.min(o.a, d1)];
      if (b <= a) continue;
      const mid = (a + b) / 2;
      marks.push({ d: mid, lines: [o.type === "pont" ? "pont" : o.type === "creux" ? "creux comblé" : "tunnel"], kind: o.type, target: at(mid) });
    }
    marks.sort((p, q) => p.d - q.d);
    for (const m of marks) {
      const outside = Math.abs(m.d) > BAND, wide = (lines) => Math.max(...lines.map((t) => textWidth(t, 13, 500))) + 4;
      // places à droite et à gauche du trait ; hors de la bande, le nom ne doit pas arriver jusqu'à elle
      const room = { right: (m.d < -BAND ? X(-BAND) - 2 : LW - 4) - X(m.d) - 4, left: m.d > BAND ? 0 : X(m.d) - 8 };
      if (outside && wide(m.lines) > Math.max(room.right, room.left)) {  // trop long : coupé en lignes plus courtes
        m.lines = m.lines.flatMap((t) => wrap(t, Math.max(room.right, room.left) - 4));
      }
      m.right = m.d > BAND || wide(m.lines) <= room.right;  // à droite s'il y tient, sinon à gauche (jamais à gauche au-delà de +10 m)
      const width = wide(m.lines);
      [m.from, m.to] = m.right ? [X(m.d), X(m.d) + 4 + width] : [X(m.d) - 4 - width, X(m.d)];
    }
    const placed = [];
    for (const m of marks) {
      let row = 0;
      const clash = () => placed.some((p) =>
        (m.from < p.to && p.from < m.to && row < p.row + p.lines.length && p.row < row + m.lines.length)  // textes
        || (p.row < row && X(p.d) > m.from - 1 && X(p.d) < m.to + 1)  // trait d'un repère plus haut sous ce nom
        || (row < p.row && X(m.d) > p.from - 1 && X(m.d) < p.to + 1));  // trait de ce repère sous un nom plus bas
      while (clash() && row < 8) row++;
      m.row = row;
      placed.push(m);
    }
    // zone des repères : la hauteur des rangs réellement utilisés (rien : juste le titre)
    const T = 30 + Math.max(0, ...marks.map((m) => m.row + m.lines.length)) * LINE + 6, LH = T + ph + B;
    const ground = zs[ds.indexOf(0)], top = ground !== undefined ? ground + camera : null;  // caméra dans le cadre aussi
    const bottoms = show.fond ? deckBridges(long).filter((o) => Math.min(o.a, d1) > Math.max(o.de, d0)) : [];  // fond LiDAR sous les ponts affichés
    const all = [...zs, ...(top !== null ? [top] : []), ...bottoms.flatMap((o) => o.relief.filter(([d]) => d >= d0 && d <= d1).map(([, z]) => z))];
    const zmid = (Math.min(...all) + Math.max(...all)) / 2;
    const span = Math.max(2, (Math.max(...all) - Math.min(...all)) * 1.25);  // 2 m au moins : une route plate reste plate
    const Z = (z) => T + (zmid + span / 2 - z) / span * ph;
    const svg = el("svg",
      { viewBox: `0 0 ${LW} ${LH}`, class: "profil-svg profil-long", role: "img", "aria-label": "Profil en long de la route" });
    // bande des travers, sous tout le reste
    if (BAND > 0) svg.append(el("rect", { x: X(Math.min(...cuts)), y: T, width: X(Math.max(...cuts)) - X(Math.min(...cuts)), height: ph, class: "bande-travers" }));
    // graduations des hauteurs par rapport au sol sous la caméra (0), sinon au milieu
    const zStep = [0.25, 0.5, 1, 2, 5, 10].find((s) => span / s <= 5) || 20, base = zs[ds.indexOf(0)] ?? zmid;
    for (let r = Math.ceil((zmid - span / 2 - base) / zStep) * zStep; base + r <= zmid + span / 2; r += zStep) {
      svg.append(el("line", { x1: L, x2: L + pw, y1: Z(base + r), y2: Z(base + r), class: r ? "grille" : "grille zero" }),
        el("text", { x: L - 6, y: Z(base + r) + 4, class: "graduation", "text-anchor": "end" },
          `${r > 0 ? "+" : ""}${num(r, zStep < 1 ? 2 : 0)}`));
    }
    for (let d = Math.ceil(d0 / 10) * 10; d <= d1; d += 10) {
      svg.append(el("line", { x1: X(d), x2: X(d), y1: T, y2: T + ph, class: d ? "grille" : "grille zero" }),
        el("text", { x: X(d), y: T + ph + 19, class: "graduation", "text-anchor": "middle" },
          `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)} m`));
    }
    // les travers (5 au plus) : graduations sur l'axe (la photo, plus marquée), mot discret dessous
    for (const d of cuts) {
      svg.append(el("line", { x1: X(d), x2: X(d), y1: T + ph, y2: T + ph + (d ? 5 : 8), class: d ? "graduation-travers" : "graduation-travers photo" }));
    }
    svg.append(el("line", { x1: X(Math.min(...cuts)), x2: X(Math.max(...cuts)), y1: T + ph, y2: T + ph, class: "axe-travers" }),
      el("text", { x: X(0), y: T + ph + 33, class: "graduation travers-mot", "text-anchor": "middle" }, "travers"));
    const path = long.points.map(([d, z], k) => `${k ? "L" : "M"}${X(d).toFixed(1)},${Z(z).toFixed(1)}`).join("");
    const [first, last] = [Math.min(...ds), Math.max(...ds)];
    // Terre sous le profil, sauf sous le tablier d'un pont dont le fond est affiché : là, rien (l'air) entre le tablier et le fond LiDAR brut,
    // en remplissage plus clair (bleu si une eau de la BD TOPO passe dessous), nommé au milieu s'il y a la place
    const gaps = bottoms.map((o) => [Math.max(o.de, d0, first), Math.min(o.a, d1, last)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
    let from = first;
    for (const [a, b] of [...gaps, [last, last]]) {
      const part = long.points.filter(([d]) => d >= from && d <= a);
      if (part.length > 1) {
        const line = part.map(([d, z], k) => `${k ? "L" : "M"}${X(d).toFixed(1)},${Z(z).toFixed(1)}`).join("");
        svg.append(el("path", { d: `${line}L${X(part.at(-1)[0])},${T + ph}L${X(part[0][0])},${T + ph}Z`, class: "terre" }));
      }
      from = b;
    }
    for (const o of bottoms) {
      const rel = o.relief.filter(([d]) => d >= d0 && d <= d1);
      if (rel.length < 2) continue;
      const line = rel.map(([d, z], k) => `${k ? "L" : "M"}${X(d).toFixed(1)},${Z(z).toFixed(1)}`).join("");
      svg.append(el("path", { d: `${line}L${X(rel.at(-1)[0])},${T + ph}L${X(rel[0][0])},${T + ph}Z`, class: `fond-pont ${o.fond === "eau" ? "eau" : "sec"}` }),
        el("path", { d: line, class: "fond-pont-trait" }));
      const [a, b] = [Math.max(o.de, d0), Math.min(o.a, d1)], name = bottomName(o), mid = (a + b) / 2;
      const lowAt = rel.reduce((best, [d, z]) => (Math.abs(d - mid) < Math.abs(best[0] - mid) ? [d, z] : best), rel[0])[1];
      // nom du fond sous le tablier, dans l'air au-dessus du remplissage, s'il y a la place (16 px du tablier, 8 px du fond)
      if (X(b) - X(a) > textWidth(name, 12, 400) + 12 && Z(lowAt) - Z(at(mid)) >= 34) {
        svg.append(el("text", { x: X(mid), y: Z(at(mid)) + 18, class: "graduation fond-pont-nom", "text-anchor": "middle" }, name));
      }
    }
    svg.append(el("path", { d: path, class: "sol" }));
    for (const o of show.ponts ? long.ouvrages || [] : []) {  // creux comblés, tunnels (et ponts sans fond) : le tablier (droite d'un bord à l'autre) en tirets
      if (o.type === "pont" && o.relief?.length) continue;  // pont à tablier : le profil lui-même, en trait plein
      const [a, b] = [Math.max(o.de, d0, first), Math.min(o.a, d1, last)];
      if (b > a) svg.append(el("line", { x1: X(a), y1: Z(at(a)) - 4, x2: X(b), y2: Z(at(b)) - 4, class: "ouvrage" }));
    }
    // pente : un calcul, affiché en étiquette seulement (la courbe du terrain reste celle du LiDAR) : une valeur sur toute la longueur du profil,
    // ou une par partie si deux profils nets se dessinent (voir cassure), au-dessus de sa partie, avec un petit trait à la limite des parties
    const fit = cassure(long.points);
    has.cassure = Boolean(fit?.cassure);
    for (const p of fit?.parties || []) {
      const [a, b] = [Math.max(p.de, d0), Math.min(p.a, d1)];
      if (b <= a) continue;
      if (!fit.cassure && Math.abs(p.pente) < 0.5) continue;  // sans cassure, pente quasi nulle : rien à dire
      has.pentes = true;
      if (!show.pentes) continue;
      const mid = (a + b) / 2;
      svg.append(el("text", { x: X(mid), y: Z(at(mid)) - 8, class: "etiquette-raide place", "data-prio": 1, "data-couleur": "raide",
        "data-ancre": `${X(mid)},${Z(at(mid))}`, "text-anchor": "middle" }, `${p.pente < 0 ? "−" : ""}${num(Math.abs(p.pente))}\u00a0%`));
    }
    if (show.cassure && fit?.cassure) {
      const x = X(fit.parties[0].a), y = Z(at(fit.parties[0].a));
      svg.append(el("line", { x1: x, y1: y - 9, x2: x, y2: y + 9, class: "cassure" }));
    }
    // pointillé vertical du point 0 (sol sous la caméra, jusqu'à sa hauteur) ; la caméra elle-même n'est pas dessinée (pas à l'échelle)
    has.camera = top !== null;
    if (show.camera && top !== null) svg.append(el("line", { x1: X(0), x2: X(0), y1: Z(ground), y2: Z(top), class: "bord" }));
    declutter(svg, { top: T, bottom: T + ph, left: L, right: L + pw }, [], { mode: ETIQ.mode });
    // repères : pointillé de leur nom jusqu'à un point du terrain, puis les noms (liserés), par-dessus les traits
    const baseline = (m) => 30 + m.row * LINE + 10;  // ligne de base de la 1re ligne du nom
    for (const m of marks) {
      const y2 = Z(m.target) - (m.kind === "pont" ? 4 : 0);
      svg.append(el("line", { x1: X(m.d), x2: X(m.d), y1: baseline(m) + 3 + (m.lines.length - 1) * LINE, y2, class: "repere" }),
        el("circle", { cx: X(m.d), cy: y2, r: 2.5, class: "repere-point" }));
    }
    for (const m of marks) {
      // comme « bord » du profil en travers : la 1re ligne en étiquette, la suite en graduation
      const x = X(m.d) + (m.right ? 4 : -4);
      const label = el("text", { x, y: baseline(m), class: "etiquette-profil place", "text-anchor": m.right ? "start" : "end" });
      m.lines.forEach((t, i) => label.append(el("tspan", { x, ...(i ? { dy: LINE, class: "graduation" } : {}) }, t)));
      svg.append(label);
    }
    const g = long.pente;
    // titre : la pente moyenne, ou les deux pentes et la limite si une cassure nette se dessine (comme les étiquettes)
    const cutTitle = (cut, mean) => {
      const way = (v) => (v >= 0 ? "montée" : "descente");
      if (!show.pentes) return "Profil en long";
      if (!cut?.cassure) return `Profil en long\u00a0: ${way(mean)} de ${num(Math.abs(mean))}\u00a0%`;
      const [p, q] = cut.parties, at0 = Math.round(p.a);
      const slopes = (p.pente >= 0) === (q.pente >= 0) ? `${way(p.pente)} de ${num(Math.abs(p.pente))}\u00a0% puis ${num(Math.abs(q.pente))}\u00a0%`
        : `${way(p.pente)} de ${num(Math.abs(p.pente))}\u00a0% puis ${way(q.pente)} de ${num(Math.abs(q.pente))}\u00a0%`;
      return `Profil en long\u00a0: ${slopes}${show.cassure ? ` (cassure à ${at0 > 0 ? "+" : at0 < 0 ? "−" : ""}${Math.abs(at0)} m)` : ""}`;
    };
    svg.append(el("text", { x: L, y: 18, class: "etiquette-profil" },
      cutTitle(fit, g)),
      el("text", { x: L + pw, y: LH - 4, class: "graduation", "text-anchor": "end" }, "sens de la photo →"),
      el("text", { x: L, y: LH - 4, class: "graduation" },
        `hauteurs exagérées, 0 = le sol sous la caméra${long.suivi
          ? ` · le long de ${long.suivi === "axe BD TOPO" ? "l'axe BD TOPO de la route" : `la ${long.suivi}`}` : ""}`));
    return { svg, presence: has };
  }

  /** Page HTML A4 paysage (impression en PDF) : 1re page, graphique svg en vectoriel et légende legend en petits
   * caractères sur deux colonnes ; 2e page, profil en long (long, ou null : pas de 2e page). En-tête : place (HTML du
   * lieu, comme l'encart de la visionneuse : route, PR, commune) ; pied : sources, photo, date d'édition. Styles de la
   * page repris (stylesheet : adresse de src/style.css), en thème clair ; fit(doc) resserre la 1re page sur une page. */
  function pdfPage(svg, legend, long, { stylesheet, fonts = "", photo = "", place = "", edited = "" }) {
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const head = (name) => `<header><div><h1>${name}</h1>${place ? `<div class="lieu">${place}</div>` : ""}</div>
<div class="date">${esc(edited)}</div></header>`;
    // légende du profil en long : avec lui, sur la 2e page (sinon, pas de profil en long du tout)
    const first = legend.cloneNode(true), longText = first.querySelector(".legende-long")?.outerHTML || "";
    first.querySelector(".legende-long")?.remove();
    const foot = `<footer><span>Mesures Panoramax — terrain IGN (MNT LiDAR HD ou RGE ALTI), tronçons BD TOPO</span><span>${
      photo ? `Photo Panoramax ${esc(photo)}` : ""}</span></footer>`;
    return `<!doctype html><html lang="fr" data-theme="light"><head><meta charset="utf-8"><title>Profil en travers</title>
${fonts}<link rel="stylesheet" href="${esc(stylesheet)}"><style>
@page { size: A4 landscape; margin: 0; }
html, body { background: #fff; height: auto; overflow: visible; }
body { margin: 0; display: block; font-family: Inter, Arial, sans-serif; color: #1c1c1c; }
.page { box-sizing: border-box; flex: none; width: 297mm; height: 210mm; padding: 9mm 11mm 7mm;
  display: flex; flex-direction: column; overflow: hidden;
  break-after: page; }
.page:last-child { break-after: auto; }
header { display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm;
  border-bottom: 2.5px solid #e65100; padding-bottom: 2.5mm; }
h1 { margin: 0; font-size: 20px; letter-spacing: -0.2px; }
.lieu { font-size: 14px; color: #444; margin-top: 3px; } .lieu b { color: #1c1c1c; font-weight: 600; }
.date { font-size: 11px; color: #555; text-align: right; white-space: nowrap; }
dialog.profil { position: static; max-width: none; max-height: none; width: auto; height: auto; overflow: visible; margin: 0;
  padding: 0; border: 0; box-shadow: none; background: #fff; color: #1c1c1c; display: block; }
dialog.profil .graphique { flex: none; margin: 2.5mm 0 0; }
dialog.profil .graphique svg { width: 100%; height: auto; max-height: var(--haut, 125mm); }
dialog.profil.long { margin: auto 0; } .en-long svg { display: block; width: 100%; height: auto; max-height: 150mm; }
dialog.profil.long .legende { columns: 1; font-size: 10px; margin-top: 3mm; }
dialog.profil .legende { font-size: var(--legende, 8.5px); line-height: 1.35; columns: 2; column-gap: 7mm; margin-top: 2.5mm; }
dialog.profil .legende ul { margin: 0 0 1mm; padding-left: 1.1em; }
dialog.profil .legende li { margin: 0.4mm 0; break-inside: avoid; }
dialog.profil .legende p.aide { font-size: 1em; margin: 0 0 0.8mm; break-inside: avoid; }
footer { margin-top: auto; padding-top: 2mm; border-top: 1px solid #ddd; font-size: 8px; color: #666;
  display: flex; justify-content: space-between; }
</style></head><body><div class="page">${head("Profil en travers")}
<dialog class="profil" open><div class="graphique">${sansSurvol(svg).outerHTML}</div>
<div class="legende">${first.innerHTML}</div></dialog>${foot}</div>${long ? `
<div class="page">${head("Profil en long")}<dialog class="profil long" open><div class="en-long">${long.outerHTML}</div>
<div class="legende">${longText}</div></dialog>${foot}</div>` : ""}</body></html>`;
  }

  /** 1re page de pdfPage resserrée jusqu'à tenir sur sa page : graphique moins haut, puis légende plus petite. */
  function fit(doc) {
    const page = doc.querySelector(".page"), root = doc.documentElement.style;  // page : overflow caché, hauteur fixe
    const over = () => page.scrollHeight > page.clientHeight + 1;
    for (let h = 125; over() && h > 70; h -= 5) root.setProperty("--haut", `${h - 5}mm`);
    for (let s = 8.5; over() && s > 6; s -= 0.5) root.setProperty("--legende", `${s - 0.5}px`);
  }

  /** Travers de la photo sur la carte (piste G5) : GeoJSON (voir Carte.showTravers) de la ligne du travers (de son bout gauche à son
   * bout droit), des deux bords (mesuré : rond plein ; supposé : rond creux), du pied de la chute (rond orange) et du talus (trait rouge), avec en gris le travers voisin qui les porte s'il n'est pas celui de la photo, et, dans le même style, tous les autres travers du profil,
   * dans les couleurs du graphique (variables de thème du CSS). limits : bornes en distance du dessin ([min, max], `cadre.x` de draw), qui
   * donnent au trait la même étendue que le graphique. */
  function mapTrace(profile, limits = null) {
    const all = crossings(profile, limits), main = all.get(0) || [...all.values()][0];
    const [o, p] = profile.repere, css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim() || "#888888";
    const at = (x) => [o[0] + x * (p[0] - o[0]), o[1] + x * (p[1] - o[1])];  // lon, lat à x m à droite de l'origine
    const feature = (geometry, properties) => ({ type: "Feature", properties, geometry });
    // Sens « le long » (le_long > 0) : le quart de tour de la droite du travers, dans le sens de la photo (avant) ou le contraire
    const k = 111320, c = Math.cos(o[1] * Math.PI / 180), [ux, uy] = [(p[0] - o[0]) * c * k, (p[1] - o[1]) * k];
    const sens = profile.avant === false ? -1 : 1;
    const shift = (x, along) => {  // lon, lat à x m à droite de l'origine, sur le travers à along m
      const [lon, lat] = at(x);
      return [lon + sens * along * -uy / (c * k * Math.hypot(ux, uy)), lat + sens * along * ux / (k * Math.hypot(ux, uy))];
    };
    const out = [], seen = new Set();
    const [x0, x1] = [main.points[0][0], main.points.at(-1)[0]];
    out.push(feature({ type: "LineString", coordinates: [at(x0), at(x1)] }, { role: "travers", couleur: color("--sol"), fond: color("--fond") }));
    for (const side of ["gauche", "droit"]) {
      const b = main.bords[side], sign = side === "gauche" ? -1 : 1, r = profile.resultats?.[side];
      if (!b || !r) continue;
      // chute et talus : sur le travers où ils ont été mesurés (celui de la photo, ou un voisin à along m, tracé en gris comme sur le graphique)
      const onto = (along, x) => (along === 0 ? at(x) : shift(x, along));
      for (const along of [r.chute[3], r.devers?.[2]]) {
        const tr = all.get(along);
        if (!tr || tr === main || seen.has(along)) continue;
        seen.add(along);
        out.push(feature({ type: "LineString", coordinates: [onto(along, tr.points[0][0]), onto(along, tr.points.at(-1)[0])] },
          { role: "voisin", couleur: color("--discret"), fond: color("--fond") }));
      }
      const t = all.get(r.chute[3]) || main, bc = t.bords[side].x;
      out.push(feature({ type: "Point", coordinates: onto(t.along, bc + sign * r.chute[1]) }, { role: "chute", couleur: color("--chute"), fond: color("--fond") }));
      if (r.devers) {
        const td = all.get(r.devers[2]) || main, bd = td.bords[side].x;
        out.push(feature({ type: "LineString", coordinates: [onto(td.along, bd + sign * r.devers[1]), onto(td.along, bd + sign * r.devers[3])] },
          { role: "devers", couleur: color("--devers"), fond: color("--fond") }));
      }
    }
    // Les autres travers du profil (sans chute ni dévers retenus) : tous sur la carte, dans le même style que le voisin (rôle « voisin », trait plein gris)
    for (const [along, tr] of all) {
      if (tr === main || seen.has(along)) continue;
      const [a0, a1] = [tr.points[0][0], tr.points.at(-1)[0]];
      out.push(feature({ type: "LineString", coordinates: [shift(a0, along), shift(a1, along)] },
        { role: "voisin", couleur: color("--discret"), fond: color("--fond") }));
    }
    return { type: "FeatureCollection", features: out };
  }

  /** Bords du travers de la photo pour les recaler sur la carte (src/reglages.js) : repère du profil (origine et point à 1 m à droite,
   * [lon, lat]), position x de chaque bord (m, < 0 à gauche), distance maximale lue de chaque côté (m depuis l'origine), côtés
   * déjà recalés, et couleur du curseur. null sans bord. */
  function recalage(profile) {
    const main = crossings(profile).get(0) || [...crossings(profile).values()][0];
    if (!main || !profile.repere || !Object.keys(main.bords).length) return null;
    const reach = {};
    for (const p of profile.profils) {
      if (p.le_long === main.along && p.points.length) reach[p.cote] = Math.max(...p.points.map(([o]) => o));
    }
    return { repere: profile.repere, x: Object.fromEntries(Object.entries(main.bords).map(([side, b]) => [side, b.x])), portee: reach,
      manuel: Object.entries(main.bords).filter(([, b]) => b.manuel).map(([side]) => side), couleur: getComputedStyle(document.documentElement)
        .getPropertyValue("--bord-main").trim() || "#00b8d4" };
  }

  const BORDS_ECART = 0.10;  // m : écart minimal entre les deux bords (même valeur que App.MANUAL_GAP)

  /** Position permise la plus proche de x (m, < 0 à gauche) pour le bord `side` de rec (Profil.recalage), au centimètre : dans le
   * terrain lu (jusqu'à rec.portee), de son côté de l'origine, et à BORDS_ECART m au moins de l'autre bord. Pas d'aimant :
   * rien d'autre ne la déplace. */
  function limiteBord(rec, side, x) {
    const left = side === "gauche", otherX = rec.x[left ? "droit" : "gauche"], dist = left ? -x : x;
    const least = otherX === undefined ? 0 : Math.max(0, BORDS_ECART - Math.abs(otherX));
    const kept = Math.min(rec.portee[left ? "gauche" : "droit"] ?? 50, Math.max(dist, least));
    return Math.round((left ? -kept : kept) * 100) / 100;
  }

  return { draw, png, pdfPage, fit, mapTrace, recalage, limiteBord, etiquettes: ETIQ, cassure };
})();

export { Profil };
