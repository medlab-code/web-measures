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
      t.bords[p.cote] = { x: sign * p.bord, relief: p.relief, voisins: p.voisins, enrobe: p.enrobe,
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

  /** Étiquettes du graphique (classe « place ») écartées verticalement de celles déjà posées, dans l'ordre du dessin,
   * entre top et bottom (hauteurs à l'échelle : chute, dévers, travers et plateforme presque à la même hauteur).
   * Largeurs mesurées sur un canvas hors écran (textWidth) : le SVG n'est pas encore dans la page. */
  // obstacles : [gauche, haut, droite, bas] à éviter aussi (tablier d'un pont…)
  function declutter(svg, top, bottom, obstacles = []) {
    const box = (t, y) => {  // étiquette sur plusieurs lignes (tspan) : la plus longue, et LINE px par ligne de plus
      const lines = t.querySelectorAll("tspan").length ? [...t.querySelectorAll("tspan")].map((s) => s.textContent) : [t.textContent];
      const grad = t.classList.contains("graduation"), size = grad ? 12 : 13,
        w = Math.max(...lines.map((s) => textWidth(s, size, grad ? 400 : 500)));
      const x = Number(t.getAttribute("x")), anchor = t.getAttribute("text-anchor");
      const left = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
      return [left - 2, y - size, left + w + 2, y + 3 + (lines.length - 1) * LINE];
    };
    const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const placed = [...obstacles];
    for (const t of svg.querySelectorAll("text.place")) {
      const y0 = Number(t.getAttribute("y"));
      // 0, puis 16 px dessous, dessus, 32 px dessous… sans sortir du graphique ; vers le haut seulement pour une étiquette
      // au-dessus de ce qu'elle nomme (data-haut : caméra, séparateur de chaussée), qui ne doit pas le masquer
      const steps = t.hasAttribute("data-haut") ? [0, -16, -32, -48, -64] : [0, 16, -16, 32, -32, 48, -48, 64, -64];
      const y = steps.map((d) => y0 + d).find((v) => v - 13 >= top && v <= bottom && !placed.some((p) => hit(p, box(t, v)))) ?? y0;
      t.setAttribute("y", y);
      placed.push(box(t, y));
    }
  }

  /** Clé de lecture sous le graphique (dans le SVG : aussi dans le PNG et le PDF) : un échantillon et un mot pour chaque
   * élément réellement dessiné dans svg, sur une ou deux lignes. hidden : herbe et végétation lues mais masquées (case
   * « Végétation ») ; leur place est gardée, en fin de clé, pour que la hauteur du graphique, donc les cases et boutons
   * sous lui, ne bougent pas quand on la décoche. Rend la hauteur ajoutée au viewBox. */
  function drawKey(svg, hidden = { herbe: false, vegetation: false }) {
    const has = (sel) => Boolean(svg.querySelector(sel));
    // [présent, classe de l'échantillon, mot, attributs] : l'échantillon reprend la classe de l'élément dessiné
    const items = [
      [true, "sol", "terrain de la photo"],
      [has(".autre-travers"), "autre-travers", "travers à ±5 et 10 m"],
      [has(".chaussee"), "chaussee", "plateforme"],
      [has('.bord[data-bord="mesure"]'), "bord", "bord mesuré", { "data-bord": "mesure" }],
      [has(".bord-suppose"), "bord bord-suppose", "bord supposé", { "data-bord": "suppose" }],
      [has(".bord-chaussee"), "bord-chaussee", "bord d'enrobé (LiDAR)"],
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
    const road = main.points.filter(([x]) => x >= bl && x <= br);
    const xs = [...all.values()].flatMap((t) => t.points.map((p) => p[0]));
    const zs = [...all.values()].flatMap((t) => t.points.map((p) => p[1] - ref));
    let [xmin, xmax] = imposed?.x ?? [Math.min(...xs), Math.max(...xs)];
    const extent = [xmin, xmax];
    const plotW = W - LEFT - RIGHT, plotH = H - TOP - BOTTOM;
    const [lowest, terrainTop] = [Math.min(...zs), Math.max(...zs)];
    let zmax = terrainTop + 0.3;
    if (trueScale && profile.origine === "caméra") zmax = Math.max(zmax, camera + 0.3);  // caméra à sa hauteur, dans le cadre
    // Échelle des distances : toute la largeur, réduite (largeur centrée) si les hauteurs ne tiennent pas à ×1 ;
    // exagération entière, la plus forte qui fait tenir les hauteurs (au moins ×1), ×1 à l'échelle
    const scale = (bottom) => {
      const sx = Math.min(plotW / (xmax - xmin), plotH / (zmax - bottom));
    return { sx, factor: trueScale ? 1 : Math.max(1, Math.floor(plotH / (zmax - bottom) / sx)) };
    };
    // Fond : GROUND_BELOW sous le point le plus bas du terrain si son haut (ni caméra ni végétation) reste dans la
    // moitié basse du cadre, sinon GROUND_MIN ; la place libre va en haut, pour la végétation
    let zmin = lowest - GROUND_BELOW, { sx, factor } = scale(zmin);
    if (terrainTop - zmin > plotH / (sx * factor) / 2) {
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
    return { ref, bl, br, road, xs, xmin, xmax, zmin, zmax, sx, factor, plotW, plotH, X, Z, path, extent, cadre };
  }

  /** Eau : surfaces de la BD TOPO (bande bleue posée sur le terrain), cours d'eau (repère bleu nommé), surface lue
   * dans le nuage (analyse fine). onGround(a, b) : tracé du terrain de la photo entre a et b. */
  function drawWater(svg, profile, fine, { xmin, xmax, ref, X, Z }, main, onGround) {
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
        d += `${prev !== null && x - prev <= 0.5 + 1e-6 ? "L" : "M"}${X(x).toFixed(1)},${Math.max(TOP, Z(z)).toFixed(1)}`;
        prev = x;
      }
      svg.append(el("path", { d, class: "eau-nuage" }));
    }
  }

  /** Végétation de l'analyse fine : hauteur maximale (ligne verte, coupée en haut du graphique) ; à l'échelle, canopée
   * hors du cadre nommée. Vrai si une canopée est nommée (légende). */
  function drawVegetation(svg, fine, { xmin, xmax, zmax, ref, X, Z }, trueScale) {
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
      d += `${prev !== null && x - prev <= 0.5 + 1e-6 ? "L" : "M"}${X(x).toFixed(1)},${Math.max(TOP, Z(z)).toFixed(1)}`;
      prev = x;
    }
    svg.append(el("path", { d, class: "vegetation" }));
    // À l'échelle seulement : canopée hors du cadre, sa hauteur au-dessus de la plateforme, comme les graduations
    for (const [x, z] of trueScale ? peaks.values() : []) {
      if (z - ref <= zmax) continue;
      canopy = true;
      svg.append(el("text", { x: Math.max(LEFT + 50, Math.min(W - RIGHT - 50, X(x))), y: TOP + 14,
        class: "etiquette-profil place canopee", "text-anchor": "middle" },
        `canopée +${num(z - ref, 0)} m`));
    }
    return canopy;
  }

  /** Lecture du graphique, en clair, sous les résultats : une ligne par élément dessiné (canopy : canopée nommée). */
  function legendLines(profile, main, fine, plants, camera, factor, canopy) {
    const from = profile.origine === "caméra" ? "la caméra" : "l'axe de la route (position GPS non vérifiée RTK)";
    return [
      `Coupe du terrain vue dans le sens de la photo, depuis ${from}\u00a0; 0 = la plateforme sous ${
        profile.origine === "caméra" ? "la caméra" : "l'axe"}.`,
      "Trait brun\u00a0: travers de la photo · pointillés\u00a0: travers à 5 et 10 m devant et derrière · "
        + "trait gris\u00a0: travers où la chute ou le dévers ont été mesurés.",
      ...(profile.origine === "caméra" && factor === 1
        ? [`Point bleu\u00a0: la caméra, à ${num(camera, 2)} m au-dessus de la plateforme.`] : []),
      ...(main.separateur ? ["Petite barre verticale\u00a0: milieu du séparateur de chaussée (terre-plein central), "
        + `${main.separateurRelief
        ? main.separateurRelief === "nuage"
          ? "trouvé dans le nuage LiDAR\u00a0: bande non revêtue (herbe, gravillons, glissières) entre les deux chaussées"
          : main.separateurRelief === "bosse" ? "trouvé dans le relief\u00a0: bosse étroite (assise de glissières ou de muret)"
          : `trouvé dans le relief entre deux marches du terrain (${num(Math.abs(main.separateur[1] - main.separateur[0]))} m de large)`
        : `placé d'après les largeurs BD TOPO (pas de marche du terrain trouvée${
          fine ? ", ni de bande non revêtue dans le nuage LiDAR" : ""})`}\u00a0; la plateforme va jusqu'au bord `
        + "extérieur de l'autre chaussée."] : []),
      ...(fine ? [`Analyse fine (nuage LiDAR HD, ${fine.points} points du sol)\u00a0: carrés blancs, lignes blanches lues à `
        + `l'intensité du retour laser${Object.keys(fine.bords).length ? "\u00a0; tirets courts, bords de chaussée" : ""}`
        + `${["gauche", "droit"].map((side) => fine.bords[side] ? ` (${side}\u00a0: ${num(Math.abs(fine.bords[side].x))} m, `
          + `${fine.bords[side].bordure ? "bordure, trouvée à l'altitude du sol" : fine.bords[side].comment})` : "").join("")}.`
        + (fine.largeur ? ` Largeur d'enrobé\u00a0: ${num(fine.largeur.m)}\u00a0m ±\u00a0${num(fine.largeur.plus)}.` : "")] : []),
      ...((profile.eau || []).length || fine?.eau?.length ? [`Bleu\u00a0: eau${(profile.eau || []).length ? ` de la BD TOPO (${profile.eau
        .map((w) => (w.x !== undefined
          ? `${w.nom || (w.nature || "cours d'eau").toLowerCase()} à ${num(Math.abs(w.x))} m ${w.x < 0 ? "à gauche" : "à droite"}`
          : `${(w.nature || "plan d'eau").toLowerCase()} de ${num(Math.min(Math.abs(w.de), Math.abs(w.a)))} `
            + `à ${num(Math.max(Math.abs(w.de), Math.abs(w.a)))} m `
            + `${w.de + w.a < 0 ? "à gauche" : "à droite"} (bande bleue sur le terrain, `
            + "au niveau de l'eau)")).join(", ")})` : ""}${fine?.eau?.length
        ? `${(profile.eau || []).length ? "\u00a0; " : " "}surface de l'eau lue dans le nuage LiDAR (ligne bleue), `
          + "au niveau du jour du relevé" : ""}.`] : []),
      ...(plants && fine?.herbe?.length ? ["Bande vert clair sur le terrain\u00a0: herbe au sol (surface non revêtue très claire au laser "
        + "infrarouge\u00a0; gravillons et béton, moins clairs, n'y sont pas)" + ["gauche", "droit"].map((side) => {
          const sign = side === "gauche" ? -1 : 1, mine = fine.herbe.filter(([a, b]) => sign * (a + b) > 0);
          return mine.length
            ? `\u00a0; ${side}\u00a0: dès ${num(Math.min(...mine.map(([a, b]) => Math.min(Math.abs(a), Math.abs(b)))))} m` : "";
        }).join("") + "."] : []),
      ...(plants && fine?.vegetation?.length
        ? ["Ligne verte\u00a0: hauteur maximale de la végétation (herbe haute, arbustes, arbres, classés par "
        + "l'IGN) sur ±1 m le long de la route, coupée en haut du graphique"
        + (canopy ? " (« canopée +… m »\u00a0: sa hauteur au-dessus de la plateforme)" : "") + ["gauche", "droit"].map((side) => {
          const sign = side === "gauche" ? -1 : 1, seen = fine.vegetation.filter(([x]) => sign * x > 0);
          if (!seen.length) return "";
          const above = ([x, z]) => z - (zAt(main.points, x) ?? z);
          const top = seen.reduce((a, b) => (above(b) > above(a) ? b : a));
          const first = seen.reduce((a, b) => (Math.abs(b[0]) < Math.abs(a[0]) ? b : a));
          return `\u00a0; ${side}\u00a0: dès ${num(Math.abs(first[0]))} m, jusqu'à ${num(above(top))} m au-dessus du sol`;
        }).join("") + "."] : []),
      "Traits verticaux de bord\u00a0: trait plein, bord mesuré (rupture de pente de ce travers, enrobé ou bordure de l'analyse "
        + "fine)\u00a0; tirets longs et pâles, « bord supposé », hypothèse et non mesure.",
      ...(["gauche", "droit"].some((side) => main.bords[side]?.voisins && !main.bords[side].enrobe)
        ? ["« Travers voisins » sous un bord : pas de rupture de pente sur ce travers (ou une trop loin des "
          + "autres) ; bord supposé, placé à la médiane des travers voisins où elle a été trouvée."] : []),
      `Chute et dévers lus du bord jusqu'à ce que le terrain remonte de ${num(profile.remontee, 0)} m au-dessus du bord `
        + "(talus, butte)\u00a0: derrière, ce n'est pas une chute.",
      `${factor > 1 ? `Hauteurs exagérées ×${factor} pour la lisibilité` : "Hauteurs à l'échelle des distances"}. `
        + `Terrain ${profile.source} (IGN), altitudes à ±${num(profile.erreur)} m près.`,
      ...(profile.en_long?.points?.length && longLegend(profile.en_long) ? [longLegend(profile.en_long)] : []),
    ];
  }

  /** Chute et dévers de chaque côté, dessinés sur le travers où ils ont été mesurés (svg) ; rend leur liste pour la
   * légende (une puce par côté, et la plateforme). */
  function drawResults(svg, profile, all, main, { X, Z, path }) {
    const results = document.createElement("ul");
    if (profile.carrefour?.texte) {  // carrefour près de la photo : en tête, les bords qui suivent sont peu sûrs
      const item = document.createElement("li");
      item.append(html("b", "carrefour", profile.carrefour.texte));
      results.append(item);
    }
    if (profile.plateforme) {
      const item = document.createElement("li");
      item.append(html("b", "", "Plateforme\u00a0: "), platformText(profile.plateforme));
      results.append(item);
    }
    for (const side of ["gauche", "droit"]) {
      const r = profile.resultats[side], sign = side === "gauche" ? -1 : 1;
      const item = document.createElement("li");
      item.append(html("b", "", `Côté ${side}\u00a0: `));
      item.dataset.cote = side;  // mis en évidence avec sa flèche et sa droite au survol (survol)
      results.append(item);
      if (!r) {
        const stop = profile.arrets[side];
        item.append(stop === undefined ? `pas de chute de 0,5 m ou plus jusqu'à ${num(profile.zone, 0)} m du milieu de la chaussée`
          : `pas de chute avant le terrain qui remonte de ${num(profile.remontee, 0)} m (talus, butte), à ${dist(stop)} m du bord`);
        continue;
      }
      const t = all.get(r.chute[3]) || main, b = t.bords[side].x;
      const where = t === main ? "" : ` (travers à ${t.along > 0 ? "+" : "−"}${Math.abs(t.along)} m)`;
      // travers de la chute et du dévers, s'ils ne sont pas celui de la photo : en trait plein, nommés à leur bout
      const shown = new Set();
      for (const along of [r.chute[3], r.devers?.[2]]) {
        const tr = all.get(along);
        if (!tr || tr === main || shown.has(tr)) continue;
        shown.add(tr);
        const end = sign < 0 ? tr.points[0] : tr.points.at(-1);
        // sous le terrain de la photo (dessiné avant lui), transparent : il ne le masque pas
        svg.insertBefore(el("path", { d: path(tr.points), class: "travers-mesure" }), svg.querySelector(".terre"));
        svg.append(el("text",
          { x: X(end[0]) - sign * 2, y: Z(end[1]) - 6, class: "graduation place", "text-anchor": sign < 0 ? "start" : "end" },
            `travers à ${tr.along > 0 ? "+" : "−"}${Math.abs(tr.along)} m`));
      }
      const top = zAt(t.points, b), xLow = b + sign * r.chute[1], low = top - r.chute[0];
      // étiquette à l'extérieur de la flèche, sauf si elle sortirait du cadre
      const out = sign < 0 ? X(xLow) - 100 > 0 : X(xLow) + 100 < W, toward = out ? sign : -sign;
      svg.append(el("line", { x1: X(b), x2: X(xLow), y1: Z(top), y2: Z(top), class: "repere-chute" }),
        el("line", { x1: X(xLow), x2: X(xLow), y1: Z(top), y2: Z(low), class: "chute", "data-cote": side, "marker-end": "url(#fleche)" }),
        el("text", { x: X(xLow) + toward * 6, y: (Z(top) + Z(low)) / 2, class: "etiquette-profil chute-texte place",
          "text-anchor": toward < 0 ? "end" : "start" }, `chute ${r.chute[2] ? "≥ " : ""}${num(r.chute[0])} m`));
      item.append(html("span", "chute", `chute ${r.chute[2] ? "d'au moins " : "de "}${num(r.chute[0])} m`),
        ` ${r.chute[2] ? "au-delà de" : "à"} ${dist(r.chute[1], r.chute[2])} m du bord${where}`);
      if (r.devers) {
        // talus : droite de son haut à son pied (pente moyenne), sur le travers où il a été mesuré
        const td = all.get(r.devers[2]) || main, bd = td.bords[side].x;
        const x0 = bd + sign * r.devers[1], x1 = bd + sign * r.devers[3];
        const [z0, z1] = [zAt(td.points, x0), zAt(td.points, x1)];
        // étiquette contre la droite ; sous elle si le talus est presque à plat (hauteurs à l'échelle)
        const flat = Math.abs(Z(z0) - Z(z1)) < 60;
        svg.append(el("line", { x1: X(x0), y1: Z(z0), x2: X(x1), y2: Z(z1), class: "devers", "data-cote": side }),
          el("text", { x: X((x0 + x1) / 2) - (flat ? 0 : sign * 12), y: flat ? Math.max(Z(z0), Z(z1)) + 18 : Z((z0 + z1) / 2) + 4,
            class: "etiquette-profil devers-texte place", "text-anchor": flat ? "middle" : sign < 0 ? "start" : "end" },
          r.devers[5] ? "paroi" : `dévers ${num(100 * r.devers[0], 0)} %`));
        // paroi quasi verticale (App.WALL_SLOPE) : sans pourcentage, le MNT adoucit les murs
        const where2 = td === main ? "" : `, travers à ${td.along > 0 ? "+" : "−"}${Math.abs(td.along)} m`;
        if (r.devers[5]) {
          item.append(" · ", html("span", "devers", "paroi quasi verticale"),
            ` (mur, enrochement\u00a0: ${num(r.devers[4])} m de haut${where2})`);
        } else {
          item.append(" · ", html("span", "devers", `dévers du talus ${num(100 * r.devers[0], 0)}\u00a0%`),
            ` (pente moyenne\u00a0: ${num(r.devers[4])} m de haut sur ${num(Math.abs(x1 - x0))} m${where2})`);
        }
      }
    }
    return results;
  }

  const html = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text });

  /** Graphique SVG et sa légende en clair (texte) pour profile (voir App._compute_edges) ; trueScale : hauteurs
   * à la même échelle que les distances.
   * imposed : cadre rendu par un dessin précédent du même profil (`cadre`), pour qu'une case (bord d'enrobé, végétation)
   * ne déplace ni ne change l'échelle du graphique : { x: [min, max], z: {...} ou null } ; sans z (hauteurs à l'échelle
   * changées), seules les bornes en distance sont gardées. Le terrain est alors lu sur ces bornes, non sur la zone
   * autour du milieu de la chaussée ; plus court, il laisse du blanc. Sans imposed, le cadre est recalculé.
   * Rend aussi `cadre`, à repasser au prochain dessin. */
  // fine : analyse fine (Nuage.analyse) : séparateur et bords de chaussée tirés du nuage LiDAR, lignes blanches
  // (bords et largeur d'enrobé vides si l'option « Bord d'enrobé » est décochée : voir drawProfile de src/reglages.js)
  // plants : végétation de l'analyse fine (ligne verte, herbe) dessinée et légendée
  // camera : hauteur de la caméra au-dessus du sol (réglage « Hauteur de caméra »), pour le profil en long
  function draw(profile, trueScale = false, fine = null, plants = true, camera = 1.9, imposed = null) {
    const all = crossings(profile, imposed?.x);
    const main = all.get(0) || [...all.values()][0];
    if (fine?.separateur) [main.separateur, main.separateurRelief] = [[...fine.separateur].sort((a, b) => a - b), "nuage"];
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
      svg.append(el("path", { d: path(road), class: "chaussee" }),
        el("text", { x: X((bl + br) / 2), y: under + 26, class: "etiquette-profil place", "text-anchor": "middle" },
          `plateforme ${num(br - bl)} m`));
      const slope = platformLabel(profile.plateforme);
      if (slope) {
        svg.append(el("text", { x: X((bl + br) / 2), y: under + 42, class: "etiquette-profil place", "text-anchor": "middle" }, slope));
      }
    }
    for (const side of ["gauche", "droit"]) {
      const b = main.bords[side];
      if (!b) continue;
      const anchor = side === "gauche" ? "end" : "start", dx = side === "gauche" ? -4 : 4;
      // Bord mesuré (rupture de pente de ce travers, analyse fine) : trait plein (style.css) ; bord supposé (largeur type, ou
      // médiane des travers voisins) : tirets longs et pâles, et l'étiquette le dit
      const measured = Boolean(b.enrobe || b.relief);
      svg.append(el("line", { x1: X(b.x), x2: X(b.x), y1: TOP - 4, y2: Z(zAt(main.points, b.x)), class: measured ? "bord" : "bord bord-suppose",
          "data-bord": measured ? "mesure" : "suppose" }),
        el("text", { x: X(b.x) + dx, y: TOP - 26, class: "etiquette-profil", "text-anchor": anchor }, measured ? "bord" : "bord supposé"),
        el("text", { x: X(b.x) + dx, y: TOP - 12, class: "graduation", "text-anchor": anchor },
          b.enrobe ? (fine?.bords?.[side]?.bordure ? "bordure" : "fin de l'enrobé") : b.relief ? "rupture de pente" : b.voisins ? "travers voisins" : "largeur type"));
    }
    // Séparateur de chaussée (chaussées séparées, ticket #34) : petite barre verticale posée sur le terrain en son milieu
    // (d'après la BD TOPO), nommée au-dessus ; autrement que les bords, qui seuls limitent la plateforme
    if (main.separateur) {
      const [s0, s1] = main.separateur, gx = X((s0 + s1) / 2), gy = Z(zAt(main.points, (s0 + s1) / 2));
      // d'où vient sa position : dans la légende
      const label = el("text", { x: gx, y: gy - 24, class: "graduation place", "data-haut": "", "text-anchor": "middle" },
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
    drawWater(svg, profile, fine, f, main, onGround);
    const canopy = plants && fine?.vegetation?.length ? drawVegetation(svg, fine, f, trueScale) : false;
    if (fine) {
      for (const [a, b] of plants ? fine.herbe || [] : []) {  // herbe au sol : bande vert clair posée sur le terrain
        const d = onGround(a, b);
        if (d) svg.append(el("path", { d, class: "herbe" }));
      }
      // sur la plateforme seulement (entre les bords, à 1 m près) : ailleurs, herbe ou cailloux clairs en bande étroite
      for (const x of fine.lignes) {
        if (x < Math.max(xmin, g0, bl - 1) || x > Math.min(xmax, g1, br + 1)) continue;
        svg.append(el("rect", { x: X(x) - 3, y: Z(zAt(main.points, x) ?? ref) - 3, width: 6, height: 6, class: "ligne-blanche" }));
      }
      for (const side of ["gauche", "droit"]) {
        const b = fine.bords[side];
        if (!b || zAt(main.points, b.x) === null) continue;
        const gy = Z(zAt(main.points, b.x));
        svg.append(el("line", { x1: X(b.x), x2: X(b.x), y1: gy - 4, y2: gy - 22, class: "bord-chaussee" }));  // nommé dans la légende
      }
    }
    // Caméra à sa hauteur au-dessus de la plateforme, hauteurs à l'échelle seulement (exagérées, sa place ne voudrait rien
    // dire : masquée) ; profil depuis l'axe : son repère posé sur la plateforme
    if (profile.origine !== "caméra") {
      svg.append(el("circle", { cx: X(0), cy: Z(ref) - 8, r: 5, class: "origine" }),
        el("text", { x: X(0), y: Z(ref) - 18, class: "graduation place", "data-haut": "", "text-anchor": "middle" }, "axe"));
    } else if (factor === 1) {
      svg.append(el("line", { x1: X(0), x2: X(0), y1: Z(ref), y2: Z(ref + camera), class: "bord" }),
        el("circle", { cx: X(0), cy: Z(ref + camera), r: 5, class: "origine" }),
        el("text", { x: X(0) + 9, y: Z(ref + camera) + 4, class: "graduation place", "data-haut": "" }, "caméra"));  // à droite du point
    }

    const results = drawResults(svg, profile, all, main, f);  // chute et dévers, et leur liste pour la légende
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
    const junction = profile.carrefour ? "Carrefour\u00a0: bords peu sûrs" : "";
    const junctionW = textWidth(junction, 13, 500, 0.6) + 10;
    const junctionBox = [W - RIGHT - 2 - junctionW, TOP + 2, W - RIGHT - 2, TOP + 24];
    declutter(svg, TOP, TOP + plotH, [...(mention ? [mentionBox] : []), ...(junction ? [junctionBox] : [])]);
    if (junction) {
      svg.append(el("rect", { x: junctionBox[0], y: junctionBox[1], width: junctionW, height: 22, rx: 3, class: "mention-echelle mention-carrefour" }),
        el("text", { x: W - RIGHT - 7, y: TOP + 18, "text-anchor": "end", class: "etiquette-profil mention-carrefour-texte" }, junction));
    }
    if (mention) {
      svg.append(el("rect", { x: mentionBox[0], y: mentionBox[1], width: mentionBox[2] - mentionBox[0], height: 22, rx: 3, class: "mention-echelle" }),
        el("text", { x: LEFT + 7, y: TOP + 18, class: "etiquette-profil mention-echelle-texte" }, mention));
    }
    drawKey(svg, { herbe: !plants && Boolean(fine?.herbe?.length), vegetation: !plants && Boolean(fine?.vegetation?.length) });  // clé de lecture sous le cadre : agrandit le viewBox, le graphique garde sa taille
    const marker = el("marker", { id: "fleche", viewBox: "0 0 10 10", refX: 10, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" });
    marker.append(el("path", { d: "M0,0L10,5L0,10Z", class: "fleche" }));
    svg.prepend(el("defs", {}));
    svg.firstChild.append(marker);

    // Lecture du graphique, sous les résultats, en discret
    const legend = document.createElement("div");
    legend.append(results, ...legendLines(profile, main, fine, plants, camera, factor, canopy).map((t) => html("p", "aide", t)));
    // PDF : avec la 2e page
    if (profile.en_long?.points?.length && longLegend(profile.en_long)) legend.lastElementChild.classList.add("legende-long");
    survol(svg, f, main, profile, legend);
    return { svg, legend, long: drawLong(profile.en_long, camera), cadre: f.cadre };
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
      "opacity", "font-size", "font-weight", "font-family"];
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

  /** Lecture du profil en long (drawLong), pour la légende : une ligne courte (pente moyenne, trait violet, bande des
   * travers, repères pointillés), puis les ponts, creux comblés et tunnels s'il y en a. "" sans profil en long. */
  function longLegend(long) {
    if (!long?.points?.length) return "";
    const kinds = new Set((long.ouvrages || []).map((o) => o.type)), parts = [
      ...(kinds.has("pont") ? ["pont : tablier interpolé d'un bord à l'autre (tirets)"] : []),
      ...(kinds.has("creux") ? ["creux comblé : creux du terrain sous la route, sans doute un pont absent de la BD TOPO"] : []),
      ...(kinds.has("tunnel") ? ["tunnel : route tracée de bout en bout (tirets)"] : [])];
    return `Profil en long : pente moyenne de ${num(Math.abs(long.pente))} % (${long.pente >= 0 ? "montée" : "descente"}). `
      + (long.max ? "Trait violet : les 10 m les plus raides. " : "")
      + "Bande grise : les 5 travers du graphique du dessus (−10 à +10 m, la photo à 0). "
      + "Repères pointillés : carrefours, fins de route, ponts."
      + (parts.length ? ` ${parts.join(" · ")}.` : "");
  }

  /** Profil en long (App._compute_edges : en_long, points [d, z], d > 0 dans le sens de la photo) : graphique d'environ
   * 160 px de haut sous le profil en travers, 0 = le sol sous la caméra, la caméra flottant à camera m au-dessus ; null
   * sans données. Pour le lire avec le profil en travers : bande pâle de −10 à +10 m autour de la photo, graduée aux 5
   * travers (−10, −5, 0, +5, +10 m ; la photo en trait plus marqué). Les 10 m les plus raides sont en violet épais
   * (le rouge est réservé au dévers), étiquetés avec leur pente ; l'étiquette se place sous le trait, côté bas de la
   * pente, donc aussi en descente. Fins de route, carrefours et ponts sont nommés dans une zone au-dessus du cadre,
   * étagés sans chevauchement (textWidth) et reliés par un pointillé à un point du terrain ; la zone n'a que la hauteur
   * des rangs utilisés. Un repère hors de la bande des travers n'a jamais son nom au-dessus de la bande : le nom se
   * place du côté extérieur et se coupe en lignes plus courtes si la place manque, pour ne pas sembler être à la photo. */
  function drawLong(long, camera = 1.9) {
    if (!long?.points?.length) return null;
    const LW = 760, L = 52, R = 16, B = 56, pw = LW - L - R, ph = 160;
    const [d0, d1] = [-50, 50];  // axe fixe (App.LONG_REACH) ; au-delà du bout du tronçon, pas de terrain : vide
    const BAND = 10;  // demi-largeur de la bande des travers, en m
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
    for (const e of long.fins || []) {
      if (e.d < d0 || e.d > d1) continue;
      // « fin de la D16 » (la route s'arrête : le profil aussi), puis le carrefour ; sinon le carrefour seul
      const road = e.voie ? (/^[A-Z]+\d/.test(e.voie) ? `la ${e.voie}` : e.voie) : "la route";
      const lines = [...(e.type === "fin" ? [`fin de ${road}`] : []), ...(e.avec?.length ? [`carrefour avec ${e.avec.join(", ")}`] : [])];
      marks.push({ d: e.d, lines, kind: e.type, target: at(e.d) });
    }
    for (const o of long.ouvrages || []) {
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
    const all = top !== null ? [...zs, top] : zs;
    const zmid = (Math.min(...all) + Math.max(...all)) / 2;
    const span = Math.max(2, (Math.max(...all) - Math.min(...all)) * 1.25);  // 2 m au moins : une route plate reste plate
    const Z = (z) => T + (zmid + span / 2 - z) / span * ph;
    const svg = el("svg",
      { viewBox: `0 0 ${LW} ${LH}`, class: "profil-svg profil-long", role: "img", "aria-label": "Profil en long de la route" });
    // bande des travers, sous tout le reste
    svg.append(el("rect", { x: X(-BAND), y: T, width: X(BAND) - X(-BAND), height: ph, class: "bande-travers" }));
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
    // les 5 travers : graduations sur l'axe (la photo, plus marquée), mot discret dessous
    for (const d of [-BAND, -BAND / 2, 0, BAND / 2, BAND]) {
      svg.append(el("line", { x1: X(d), x2: X(d), y1: T + ph, y2: T + ph + (d ? 5 : 8), class: d ? "graduation-travers" : "graduation-travers photo" }));
    }
    svg.append(el("line", { x1: X(-BAND), x2: X(BAND), y1: T + ph, y2: T + ph, class: "axe-travers" }),
      el("text", { x: X(0), y: T + ph + 33, class: "graduation travers-mot", "text-anchor": "middle" }, "travers"));
    const path = long.points.map(([d, z], k) => `${k ? "L" : "M"}${X(d).toFixed(1)},${Z(z).toFixed(1)}`).join("");
    const [first, last] = [Math.min(...ds), Math.max(...ds)];
    svg.append(el("path", { d: `${path}L${X(last)},${T + ph}L${X(first)},${T + ph}Z`, class: "terre" }),
      el("path", { d: path, class: "sol" }));
    for (const o of long.ouvrages || []) {  // ponts, creux comblés, tunnels : le tablier (droite d'un bord à l'autre) en tirets
      const [a, b] = [Math.max(o.de, d0, first), Math.min(o.a, d1, last)];
      if (b > a) svg.append(el("line", { x1: X(a), y1: Z(at(a)) - 4, x2: X(b), y2: Z(at(b)) - 4, class: "ouvrage" }));
    }
    if (long.max) {  // les 10 m les plus raides, en violet, avec leur pente
      const [p, a, b] = long.max, [za, zb] = [at(a), at(b)];
      svg.append(el("line", { x1: X(a), y1: Z(za), x2: X(b), y2: Z(zb), class: "raide" }));
      // sous le trait, côté bas de la pente : montée, finissant au bout haut ; descente, partant du bout haut
      const rise = zb >= za, y = Math.min(Math.max(Z(za), Z(zb)) + 22, T + ph - 5);
      svg.append(el("text", { x: rise ? X(b) - 2 : X(a) + 2, y, class: "etiquette-raide place", "text-anchor": rise ? "end" : "start" },
        `${num(Math.abs(p))} % sur ${b - a} m`));
    }
    // caméra d'abord : son étiquette reste à sa place, les autres s'en écartent (declutter)
    if (top !== null) {  // caméra à sa hauteur au-dessus du sol, pointillé jusqu'à lui
      svg.append(el("line", { x1: X(0), x2: X(0), y1: Z(ground), y2: Z(top), class: "bord" }),
        el("circle", { cx: X(0), cy: Z(top), r: 5, class: "origine" }),
        el("text", { x: X(0) + 9, y: Z(top) + 4, class: "graduation place" }, "caméra"));
    }
    declutter(svg, T, T + ph, []);
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
    svg.append(el("text", { x: L, y: 18, class: "etiquette-profil" },
      `Profil en long : ${g >= 0 ? "montée" : "descente"} de ${num(Math.abs(g))} %`
        + (long.max ? `, jusqu'à ${num(Math.abs(long.max[0]))} % sur 10 m` : "")),
      el("text", { x: L + pw, y: LH - 4, class: "graduation", "text-anchor": "end" }, "sens de la photo →"),
      el("text", { x: L, y: LH - 4, class: "graduation" },
        `hauteurs exagérées, 0 = le sol sous la caméra${long.suivi
          ? ` · le long de ${long.suivi === "axe BD TOPO" ? "l'axe BD TOPO de la route" : `la ${long.suivi}`}` : ""}`));
    return svg;
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

  return { draw, png, pdfPage, fit };
})();
