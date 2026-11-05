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
  const num = (v, digits = 1) => v.toFixed(digits).replace(".", ",").replace(/^-/, "−");

  function el(name, attrs, text) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Travers (un par position le long de la route) : points [x, z] de gauche à droite, x < 0 à gauche. */
  function crossings(profile) {
    const out = new Map();
    for (const p of profile.profils) {
      const t = out.get(p.le_long) || { along: p.le_long, points: [], bords: {} };
      const sign = p.cote === "gauche" ? -1 : 1;
      t.points.push(...p.points.map(([o, z]) => [sign * o, z]));
      t.bords[p.cote] = { x: sign * p.bord, relief: p.relief, arret: p.arret === null ? null : sign * p.arret };
      if (p.separateur) {  // chaussées séparées : trouvé dans le relief ou d'après la BD TOPO
        t.separateur = p.separateur.map((o) => sign * o).sort((a, b) => a - b);
        t.separateurRelief = p.separateur_relief;
      }
      out.set(p.le_long, t);
    }
    for (const t of out.values()) t.points.sort((a, b) => a[0] - b[0]);
    return out;
  }

  /** Altitude du travers en x (interpolée). */
  function zAt(points, x) {
    for (let k = 1; k < points.length; k++) {
      const [x0, z0] = points[k - 1], [x1, z1] = points[k];
      if (x >= x0 && x <= x1) return x1 === x0 ? z0 : z0 + (z1 - z0) * (x - x0) / (x1 - x0);
    }
    return null;
  }

  /** Étiquettes du graphique (classe « place ») écartées verticalement de celles déjà posées, dans l'ordre du dessin,
   * entre top et bottom (hauteurs à l'échelle : chute, dévers, travers et plateforme presque à la même hauteur).
   * Largeurs estimées : le SVG n'est pas encore dans la page. */
  // obstacles : [gauche, haut, droite, bas] à éviter aussi (tablier d'un pont…)
  function declutter(svg, top, bottom, obstacles = []) {
    const box = (t, y) => {  // étiquette sur plusieurs lignes (tspan) : la plus longue, et LINE px par ligne de plus
      const lines = t.querySelectorAll("tspan").length ? [...t.querySelectorAll("tspan")].map((s) => s.textContent) : [t.textContent];
      const size = t.classList.contains("graduation") ? 12 : 13, w = Math.max(...lines.map((s) => s.length)) * size * 0.56;
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
      const y = (t.hasAttribute("data-haut") ? [0, -16, -32, -48, -64] : [0, 16, -16, 32, -32, 48, -48, 64, -64]).map((d) => y0 + d).find((v) => v - 13 >= top && v <= bottom
        && !placed.some((p) => hit(p, box(t, v)))) ?? y0;
      t.setAttribute("y", y);
      placed.push(box(t, y));
    }
  }

  /** Graphique SVG et sa légende en clair (texte) pour profile (voir App._compute_edges) ; trueScale : hauteurs
   * à la même échelle que les distances. */
  // fine : analyse fine (Nuage.analyse) : séparateur et bords de chaussée tirés du nuage LiDAR, lignes blanches
  // plants : végétation de l'analyse fine (ligne verte, herbe) dessinée et légendée
  // camera : hauteur de la caméra au-dessus du sol (réglage « Hauteur de caméra »), pour le profil en long
  function draw(profile, trueScale = false, fine = null, plants = true, camera = 1.9) {
    const all = crossings(profile);
    const main = all.get(0) || [...all.values()][0];
    if (fine?.separateur) [main.separateur, main.separateurRelief] = [[...fine.separateur].sort((a, b) => a - b), "nuage"];
    const ref = zAt(main.points, 0) ?? main.points[0][1];  // 0 : plateforme sous l'origine
    const xs = [...all.values()].flatMap((t) => t.points.map((p) => p[0]));
    const zs = [...all.values()].flatMap((t) => t.points.map((p) => p[1] - ref));
    let [xmin, xmax] = [Math.min(...xs), Math.max(...xs)];
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
    const xmid = (xmin + xmax) / 2;
    [xmin, xmax] = [xmid - plotW / sx / 2, xmid + plotW / sx / 2];
    zmax = zmin + plotH / (sx * factor);
    const X = (x) => LEFT + (x - xmin) * sx, Z = (z) => TOP + (zmax - (z - ref)) / (zmax - zmin) * plotH;
    const path = (points) => points.map(([x, z], k) => `${k ? "L" : "M"}${X(x).toFixed(1)},${Z(z).toFixed(1)}`).join("");
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "profil-svg", role: "img",
      "aria-label": "Coupe du terrain en travers de la route" });

    // Repères : mètres en travers, hauteurs par rapport à la plateforme
    const xStep = xmax - xmin > 30 ? 5 : 2;
    for (let x = Math.ceil(Math.min(...xs) / xStep) * xStep; x <= Math.max(...xs); x += xStep) {
      svg.append(el("line", { x1: X(x), x2: X(x), y1: TOP, y2: TOP + plotH, class: "grille" }),
        el("text", { x: X(x), y: TOP + plotH + 16, class: "graduation", "text-anchor": "middle" }, `${Math.abs(x)} m`));
    }
    const zStep = [0.25, 0.5, 1, 2, 5].find((s) => (zmax - zmin) / s <= 7) || 10;
    for (let z = Math.ceil(zmin / zStep) * zStep; z <= zmax; z += zStep) {
      svg.append(el("line", { x1: LEFT, x2: LEFT + plotW, y1: Z(z + ref), y2: Z(z + ref), class: z ? "grille" : "grille zero" }),
        el("text", { x: LEFT - 6, y: Z(z + ref) + 4, class: "graduation", "text-anchor": "end" }, `${z > 0 ? "+" : ""}${num(z, zStep < 1 ? 2 : 0)}`));
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
    svg.append(el("path", { d: `${path(main.points)}L${X(main.points.at(-1)[0])},${bottom}L${X(main.points[0][0])},${bottom}Z`, class: "terre" }),
      el("path", { d: path(main.points), class: "sol" }));

    // Plateforme entre les deux bords du travers de la photo
    const [bl, br] = [main.bords.gauche?.x ?? 0, main.bords.droit?.x ?? 0];
    const road = main.points.filter(([x]) => x >= bl && x <= br);
    if (road.length > 1) {
      svg.append(el("path", { d: path(road), class: "chaussee" }),
        el("text", { x: X((bl + br) / 2), y: Z(zAt(main.points, (bl + br) / 2)) + 26, class: "etiquette-profil place", "text-anchor": "middle" },
          `plateforme ${num(br - bl)} m`));
    }
    for (const side of ["gauche", "droit"]) {
      const b = main.bords[side];
      if (!b) continue;
      const anchor = side === "gauche" ? "end" : "start", dx = side === "gauche" ? -4 : 4;
      svg.append(el("line", { x1: X(b.x), x2: X(b.x), y1: TOP - 4, y2: Z(zAt(main.points, b.x)), class: "bord" }),
        el("text", { x: X(b.x) + dx, y: TOP - 26, class: "etiquette-profil", "text-anchor": anchor }, "bord"),
        el("text", { x: X(b.x) + dx, y: TOP - 12, class: "graduation", "text-anchor": anchor },
          b.relief ? "rupture de pente" : "largeur BD TOPO"));
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
      return at.length < 2 ? null : at.map((x, k) => `${k ? "L" : "M"}${X(x).toFixed(1)},${(Z(zAt(main.points, x) ?? ref) - 3).toFixed(1)}`).join("");
    };
    for (const w of (profile.eau || []).filter((v) => v.de !== undefined)) {
      const d = onGround(Math.min(w.de, w.a), Math.max(w.de, w.a));
      if (d) svg.append(el("path", { d, class: "eau-surface" }));
    }
    for (const w of (profile.eau || []).filter((v) => v.x !== undefined && v.x >= xmin && v.x <= xmax)) {
      const gy = Z(zAt(main.points, w.x) ?? ref);
      svg.append(el("path", { d: `M${X(w.x) - 6},${gy - 14}L${X(w.x) + 6},${gy - 14}L${X(w.x)},${gy - 4}Z`, class: "eau" }),
        el("text", { x: X(w.x), y: gy - 18, class: "graduation place eau-texte", "data-haut": "", "text-anchor": "middle" }, w.nom || "cours d'eau"));
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
    if (plants && fine?.vegetation?.length) {
      let d = "", prev = null;
      // plus haut point des cases voisines (±0,25 m) : une case où le laser n'a touché que des branches basses ne creuse pas ;
      // puis moyenne sur ±1 m : le feuillage des arbres sans dents de scie
      const top = new Map(fine.vegetation.map(([x]) => [x, Math.max(...fine.vegetation.filter(([v]) => Math.abs(v - x) <= 0.25 + 1e-6).map(([, z]) => z))]));
      const near = (x) => { const v = [...top].filter(([u]) => Math.abs(u - x) <= 1 + 1e-6).map(([, z]) => z); return v.reduce((a, b) => a + b, 0) / v.length; };
      for (const [x] of fine.vegetation) {
        const z = near(x);
        if (x < xmin || x > xmax) { prev = null; continue; }
        d += `${prev !== null && x - prev <= 0.5 + 1e-6 ? "L" : "M"}${X(x).toFixed(1)},${Math.max(TOP, Z(z)).toFixed(1)}`;
        prev = x;
      }
      svg.append(el("path", { d, class: "vegetation" }));
    }
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

    // Chute et dévers, sur le travers où ils ont été mesurés ; une puce par côté dans la légende
    const html = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text });
    const results = document.createElement("ul");
    for (const side of ["gauche", "droit"]) {
      const r = profile.resultats[side], sign = side === "gauche" ? -1 : 1;
      const item = document.createElement("li");
      item.append(html("b", "", `Côté ${side}\u00a0: `));
      results.append(item);
      if (!r) {
        const stop = profile.arrets[side];
        item.append(stop === undefined ? `pas de chute de 0,5 m ou plus jusqu'à ${num(profile.zone, 0)} m du bord`
          : `pas de chute avant le terrain qui remonte de ${num(profile.remontee, 0)} m (talus, butte), à ${num(stop, 0)} m du bord`);
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
        svg.append(el("text", { x: X(end[0]) - sign * 2, y: Z(end[1]) - 6, class: "graduation place", "text-anchor": sign < 0 ? "start" : "end" },
            `travers à ${tr.along > 0 ? "+" : "−"}${Math.abs(tr.along)} m`));
      }
      const top = zAt(t.points, b), xLow = b + sign * r.chute[1], low = top - r.chute[0];
      // étiquette à l'extérieur de la flèche, sauf si elle sortirait du cadre
      const out = sign < 0 ? X(xLow) - 100 > 0 : X(xLow) + 100 < W, toward = out ? sign : -sign;
      svg.append(el("line", { x1: X(b), x2: X(xLow), y1: Z(top), y2: Z(top), class: "repere-chute" }),
        el("line", { x1: X(xLow), x2: X(xLow), y1: Z(top), y2: Z(low), class: "chute", "marker-end": "url(#fleche)" }),
        el("text", { x: X(xLow) + toward * 6, y: (Z(top) + Z(low)) / 2, class: "etiquette-profil chute-texte place",
          "text-anchor": toward < 0 ? "end" : "start" }, `chute ${r.chute[2] ? "≥ " : ""}${num(r.chute[0])} m`));
      item.append(html("span", "chute", `chute ${r.chute[2] ? "d'au moins " : "de "}${num(r.chute[0])} m`),
        ` ${r.chute[2] ? "au-delà de" : "à"} ${num(r.chute[1], 0)} m du bord${where}`);
      if (r.devers) {
        // talus : droite de son haut à son pied (pente moyenne), sur le travers où il a été mesuré
        const td = all.get(r.devers[2]) || main, bd = td.bords[side].x;
        const x0 = bd + sign * r.devers[1], x1 = bd + sign * r.devers[3];
        const [z0, z1] = [zAt(td.points, x0), zAt(td.points, x1)];
        // étiquette contre la droite ; sous elle si le talus est presque à plat (hauteurs à l'échelle)
        const flat = Math.abs(Z(z0) - Z(z1)) < 60;
        svg.append(el("line", { x1: X(x0), y1: Z(z0), x2: X(x1), y2: Z(z1), class: "devers" }),
          el("text", { x: X((x0 + x1) / 2) - (flat ? 0 : sign * 12), y: flat ? Math.max(Z(z0), Z(z1)) + 18 : Z((z0 + z1) / 2) + 4,
            class: "etiquette-profil devers-texte place", "text-anchor": flat ? "middle" : sign < 0 ? "start" : "end" },
          `dévers ${num(100 * r.devers[0], 0)} %`));
        item.append(" · ", html("span", "devers", `dévers du talus ${num(100 * r.devers[0], 0)}\u00a0%`),
          ` (pente moyenne\u00a0: ${num(r.devers[4])} m de haut sur ${num(Math.abs(x1 - x0))} m${
            td === main ? "" : `, travers à ${td.along > 0 ? "+" : "−"}${Math.abs(td.along)} m`})`);
      }
    }
    // droites du dévers juste au-dessus du terrain : sous la végétation, l'eau, les flèches et les textes
    const ground = svg.querySelector("path.sol");
    for (const line of [...svg.querySelectorAll("line.devers")].reverse()) ground.after(line);
    declutter(svg, TOP, TOP + plotH);
    const marker = el("marker", { id: "fleche", viewBox: "0 0 10 10", refX: 10, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" });
    marker.append(el("path", { d: "M0,0L10,5L0,10Z", class: "fleche" }));
    svg.prepend(el("defs", {}));
    svg.firstChild.append(marker);

    // Lecture du graphique, sous les résultats, en discret
    const from = profile.origine === "caméra" ? "la caméra" : "l'axe de la route (position GPS non vérifiée RTK)";
    const legend = document.createElement("div");
    legend.append(results, ...[
      `Coupe du terrain vue dans le sens de la photo, depuis ${from}\u00a0; 0 = la plateforme sous ${
        profile.origine === "caméra" ? "la caméra" : "l'axe"}.`,
      "Trait brun\u00a0: travers de la photo · pointillés\u00a0: travers à 5 et 10 m devant et derrière · "
        + "trait gris\u00a0: travers où la chute ou le dévers ont été mesurés.",
      ...(profile.origine === "caméra" && factor === 1 ? [`Point bleu\u00a0: la caméra, à ${num(camera, 2)} m au-dessus de la plateforme.`] : []),
      ...(main.separateur ? [`Petite barre verticale\u00a0: milieu du séparateur de chaussée (terre-plein central), ${main.separateurRelief
        ? main.separateurRelief === "nuage" ? "trouvé dans le nuage LiDAR\u00a0: bande non revêtue (herbe, gravillons, glissières) entre les deux chaussées"
          : main.separateurRelief === "bosse" ? "trouvé dans le relief\u00a0: bosse étroite (assise de glissières ou de muret)"
          : `trouvé dans le relief entre deux marches du terrain (${num(Math.abs(main.separateur[1] - main.separateur[0]))} m de large)`
        : `placé d'après les largeurs BD TOPO (pas de marche du terrain trouvée${fine ? ", ni de bande non revêtue dans le nuage LiDAR" : ""})`}\u00a0; la plateforme va jusqu'au bord `
        + "extérieur de l'autre chaussée."] : []),
      ...(fine ? [`Analyse fine (nuage LiDAR HD, ${fine.points} points du sol)\u00a0: carrés blancs, lignes blanches lues à `
        + "l'intensité du retour laser\u00a0; tirets courts, bords de chaussée\u00a0: ligne de rive, sinon fin de l'enrobé"
        + `${["gauche", "droit"].map((side) => fine.bords[side] ? ` (${side}\u00a0: ${num(Math.abs(fine.bords[side].x))} m, `
          + `${fine.bords[side].comment})` : "").join("")}.`] : []),
      ...((profile.eau || []).length || fine?.eau?.length ? [`Bleu\u00a0: eau${(profile.eau || []).length ? ` de la BD TOPO (${profile.eau
        .map((w) => (w.x !== undefined ? `${w.nom || (w.nature || "cours d'eau").toLowerCase()} à ${num(Math.abs(w.x))} m ${w.x < 0 ? "à gauche" : "à droite"}`
          : `${(w.nature || "plan d'eau").toLowerCase()} de ${num(Math.min(Math.abs(w.de), Math.abs(w.a)))} à ${num(Math.max(Math.abs(w.de), Math.abs(w.a)))} m `
            + `${w.de + w.a < 0 ? "à gauche" : "à droite"} (bande bleue sur le terrain, au niveau de l'eau)`)).join(", ")})` : ""}${fine?.eau?.length
        ? `${(profile.eau || []).length ? "\u00a0; " : " "}surface de l'eau lue dans le nuage LiDAR (ligne bleue), au niveau du jour du relevé` : ""}.`] : []),
      ...(plants && fine?.herbe?.length ? ["Bande vert clair sur le terrain\u00a0: herbe au sol (surface non revêtue très claire au laser "
        + "infrarouge\u00a0; gravillons et béton, moins clairs, n'y sont pas)" + ["gauche", "droit"].map((side) => {
          const sign = side === "gauche" ? -1 : 1, mine = fine.herbe.filter(([a, b]) => sign * (a + b) > 0);
          return mine.length ? `\u00a0; ${side}\u00a0: dès ${num(Math.min(...mine.map(([a, b]) => Math.min(Math.abs(a), Math.abs(b)))))} m` : "";
        }).join("") + "."] : []),
      ...(plants && fine?.vegetation?.length ? ["Ligne verte\u00a0: hauteur maximale de la végétation (herbe haute, arbustes, arbres, classés par "
        + "l'IGN) sur ±1 m le long de la route, coupée en haut du graphique" + ["gauche", "droit"].map((side) => {
          const sign = side === "gauche" ? -1 : 1, seen = fine.vegetation.filter(([x]) => sign * x > 0);
          if (!seen.length) return "";
          const above = ([x, z]) => z - (zAt(main.points, x) ?? z);
          const top = seen.reduce((a, b) => (above(b) > above(a) ? b : a));
          const first = seen.reduce((a, b) => (Math.abs(b[0]) < Math.abs(a[0]) ? b : a));
          return `\u00a0; ${side}\u00a0: dès ${num(Math.abs(first[0]))} m, jusqu'à ${num(above(top))} m au-dessus du sol`;
        }).join("") + "."] : []),
      `Chute et dévers lus du bord jusqu'à ce que le terrain remonte de ${num(profile.remontee, 0)} m au-dessus du bord `
        + "(talus, butte)\u00a0: derrière, ce n'est pas une chute.",
      `${factor > 1 ? `Hauteurs exagérées ×${factor} pour la lisibilité` : "Hauteurs à l'échelle des distances"}. `
        + `Terrain ${profile.source} (IGN), altitudes à ±${num(profile.erreur)} m près.`,
      ...(profile.en_long?.points?.length && longLegend(profile.en_long) ? [longLegend(profile.en_long)] : []),
    ].map((t) => html("p", "aide", t)));
    if (profile.en_long?.points?.length && longLegend(profile.en_long)) legend.lastElementChild.classList.add("legende-long");  // PDF : avec la 2e page
    return { svg, legend, long: drawLong(profile.en_long, camera) };
  }

  /** Image PNG (Blob) du graphique svg affiché, avec son titre et sa légende legend (élément rendu par draw, dans
   * la page) : styles calculés recopiés (le CSS de la page n'entre pas dans une image SVG), couleurs et graisses
   * de la légende reprises, sur le fond de la fenêtre, en double résolution. */
  // long : profil en long (drawLong), sous le graphique ; absent si null
  async function png(svg, title, legend, long = null) {
    const w = window, scale = 2;
    const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "paint-order",
      "opacity", "font-size", "font-weight", "font-family"];
    const raster = async (source) => {  // image du SVG affiché, styles calculés recopiés, à sa taille (viewBox) × scale
      const copy = source.cloneNode(true), [, , vw, vh] = source.getAttribute("viewBox").split(" ").map(Number);
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

  /** Lecture du profil en long (drawLong), pour la légende : ponts, creux comblés et tunnels, ou "" s'il n'y en a pas. */
  function longLegend(long) {
    const kinds = new Set((long.ouvrages || []).map((o) => o.type)), parts = [
      ...(kinds.has("pont") ? ["pont\u00a0: tablier interpolé d'un bord à l'autre (tirets)"] : []),
      ...(kinds.has("creux") ? ["creux comblé\u00a0: creux du terrain sous la route, sans doute un pont absent de la BD TOPO"] : []),
      ...(kinds.has("tunnel") ? ["tunnel\u00a0: route tracée de bout en bout (tirets)"] : [])];
    return parts.length ? `Profil en long\u00a0: ${parts.join(" · ")}.` : "";
  }

  /** Profil en long (App._compute_edges : en_long, points [d, z], d > 0 dans le sens de la photo) : petit graphique sous le
   * profil en travers, 0 = le sol sous la caméra, la caméra flottant à camera m au-dessus, la pente la plus forte sur 10 m
   * en rouge ; null sans données. */
  function drawLong(long, camera = 1.9) {
    if (!long?.points?.length) return null;
    const LW = 760, LH = 170, L = 52, R = 16, T = 34, B = 34, pw = LW - L - R, ph = LH - T - B;
    const ds = long.points.map(([d]) => d), zs = long.points.map(([, z]) => z);
    const ground = zs[ds.indexOf(0)], top = ground !== undefined ? ground + camera : null;  // caméra dans le cadre aussi
    const all = top !== null ? [...zs, top] : zs;
    // axe fixe de −50 à +50 m (App.LONG_REACH) ; au-delà du bout du tronçon, pas de terrain : vide
    const [d0, d1] = [-50, 50], zmid = (Math.min(...all) + Math.max(...all)) / 2;
    const span = Math.max(2, (Math.max(...all) - Math.min(...all)) * 1.25);  // 2 m au moins : une route plate reste plate
    const X = (d) => L + (d - d0) / ((d1 - d0) || 1) * pw, Z = (z) => T + (zmid + span / 2 - z) / span * ph;
    const svg = el("svg", { viewBox: `0 0 ${LW} ${LH}`, class: "profil-svg profil-long", role: "img", "aria-label": "Profil en long de la route" });
    // graduations des hauteurs par rapport au sol sous la caméra (0), sinon au milieu
    const zStep = [0.25, 0.5, 1, 2, 5, 10].find((s) => span / s <= 5) || 20, base = zs[ds.indexOf(0)] ?? zmid;
    for (let r = Math.ceil((zmid - span / 2 - base) / zStep) * zStep; base + r <= zmid + span / 2; r += zStep) {
      svg.append(el("line", { x1: L, x2: L + pw, y1: Z(base + r), y2: Z(base + r), class: r ? "grille" : "grille zero" }),
        el("text", { x: L - 6, y: Z(base + r) + 4, class: "graduation", "text-anchor": "end" }, `${r > 0 ? "+" : ""}${num(r, zStep < 1 ? 2 : 0)}`));
    }
    for (let d = Math.ceil(d0 / 10) * 10; d <= d1; d += 10) {
      svg.append(el("line", { x1: X(d), x2: X(d), y1: T, y2: T + ph, class: d ? "grille" : "grille zero" }),
        el("text", { x: X(d), y: T + ph + 14, class: "graduation", "text-anchor": "middle" }, `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)} m`));
    }
    const path = long.points.map(([d, z], k) => `${k ? "L" : "M"}${X(d).toFixed(1)},${Z(z).toFixed(1)}`).join("");
    const [first, last] = [Math.min(...ds), Math.max(...ds)];
    svg.append(el("path", { d: `${path}L${X(last)},${T + ph}L${X(first)},${T + ph}Z`, class: "terre" }), el("path", { d: path, class: "sol" }));
    if (long.max) {  // pente la plus forte sur 10 m
      const [, a, b] = long.max, za = zs[ds.indexOf(a)], zb = zs[ds.indexOf(b)];
      svg.append(el("line", { x1: X(a), y1: Z(za), x2: X(b), y2: Z(zb), class: "devers" }));
    }
    // caméra d'abord : son étiquette reste à sa place, les autres s'en écartent (declutter)
    if (top !== null) {  // caméra à sa hauteur au-dessus du sol, pointillé jusqu'à lui
      svg.append(el("line", { x1: X(0), x2: X(0), y1: Z(ground), y2: Z(top), class: "bord" }),
        el("circle", { cx: X(0), cy: Z(top), r: 5, class: "origine" }),
        el("text", { x: X(0) + 9, y: Z(top) + 4, class: "graduation place" }, "caméra"));
    }
    // Ponts, creux comblés et tunnels : le tablier (droite d'un bord à l'autre) en tirets, nommé au-dessus
    const decks = [];  // tabliers dessinés : les étiquettes s'en écartent
    for (const o of long.ouvrages || []) {
      const [a, b] = [Math.max(o.de, d0, Math.min(...ds)), Math.min(o.a, d1, Math.max(...ds))];
      const at = (d) => { const k = ds.findIndex((v) => v >= d); return k <= 0 ? zs[0] : zs[k - 1] + (zs[k] - zs[k - 1]) * (d - ds[k - 1]) / (ds[k] - ds[k - 1]); };
      if (b <= a) continue;
      decks.push([X(a), Math.min(Z(at(a)), Z(at(b))) - 7, X(b), Math.max(Z(at(a)), Z(at(b))) - 1]);
      svg.append(el("line", { x1: X(a), y1: Z(at(a)) - 4, x2: X(b), y2: Z(at(b)) - 4, class: "ouvrage" }),
        el("text", { x: X((a + b) / 2), y: Z(at((a + b) / 2)) - 10, class: "graduation place", "data-haut": "", "text-anchor": "middle" },
          o.type === "pont" ? "pont" : o.type === "creux" ? "creux comblé" : "tunnel"));
    }
    // Fin de la route de la photo et carrefours avec une voie nommée : trait pointillé et nom
    for (const [k, e] of (long.fins || []).entries()) {
      if (e.d < d0 || e.d > d1) continue;
      // nommée du côté opposé à la caméra (derrière : à gauche du trait), plus bas près d'elle (son étiquette est en haut)
      const anchor = e.d < 0 || e.d > 30 ? "end" : "start", dx = anchor === "end" ? -4 : 4;
      const y = T + 12 + (Math.abs(e.d) < 25 ? 30 : 0) + (k % 2) * 4;
      // « fin de la D16 » (la route s'arrête : le profil aussi), puis le carrefour ; sinon le carrefour seul
      const road = e.voie ? (/^[A-Z]+\d/.test(e.voie) ? `la ${e.voie}` : e.voie) : "la route";
      const lines = [...(e.type === "fin" ? [`fin de ${road}`] : []), ...(e.avec?.length ? [`carrefour avec ${e.avec.join(", ")}`] : [])];
      svg.append(el("line", { x1: X(e.d), x2: X(e.d), y1: T, y2: T + ph, class: "bord" }));
      // comme « bord » du profil en travers : la 1re ligne en étiquette, la suite en graduation, liserées sur le terrain ;
      // une seule étiquette (tspan) pour declutter
      const label = el("text", { x: X(e.d) + dx, y, class: "etiquette-profil place", "text-anchor": anchor });
      lines.forEach((t, i) => label.append(el("tspan", { x: X(e.d) + dx, ...(i ? { dy: LINE, class: "graduation" } : {}) }, t)));
      svg.append(label);
    }
    declutter(svg, T, T + ph, decks);
    const g = long.pente;
    svg.append(el("text", { x: L, y: 18, class: "etiquette-profil" }, `Profil en long\u00a0: ${g >= 0 ? "montée" : "descente"} de ${num(Math.abs(g))} %`
        + (long.max ? `, jusqu'à ${num(Math.abs(long.max[0]))} % sur 10 m` : "")),
      el("text", { x: L + pw, y: LH - 4, class: "graduation", "text-anchor": "end" }, "sens de la photo →"),
      el("text", { x: L, y: LH - 4, class: "graduation" },
        `hauteurs exagérées, 0 = le sol sous la caméra${long.suivi ? ` · le long de ${long.suivi === "axe BD TOPO" ? "l'axe BD TOPO de la route" : `la ${long.suivi}`}` : ""}`));
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
.page { box-sizing: border-box; flex: none; width: 297mm; height: 210mm; padding: 9mm 11mm 7mm; display: flex; flex-direction: column; overflow: hidden;
  break-after: page; }
.page:last-child { break-after: auto; }
header { display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm; border-bottom: 2.5px solid #e65100; padding-bottom: 2.5mm; }
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
footer { margin-top: auto; padding-top: 2mm; border-top: 1px solid #ddd; font-size: 8px; color: #666; display: flex; justify-content: space-between; }
</style></head><body><div class="page">${head("Profil en travers")}
<dialog class="profil" open><div class="graphique">${svg.outerHTML}</div>
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
