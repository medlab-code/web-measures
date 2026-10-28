// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Profil en travers des bords de route (bouton « Profil », à côté de « Dévers ») : la coupe du
// terrain telle que le calcul de App._compute_edges l'a lue (py/web_app.py), en SVG. Plateforme entre
// les deux bords trouvés, chute et dévers à l'endroit où ils ont été mesurés. Les hauteurs sont
// exagérées (le facteur est écrit) : sur 30 m de large, un talus de 2 m serait illisible ; la case
// « Hauteurs à l'échelle » de la fenêtre les remet à la même échelle que les distances.

const Profil = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const W = 760, H = 380, LEFT = 52, RIGHT = 16, TOP = 56, BOTTOM = 44;
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
  function declutter(svg, top, bottom) {
    const box = (t, y) => {
      const size = t.classList.contains("graduation") ? 12 : 13, w = t.textContent.length * size * 0.56;
      const x = Number(t.getAttribute("x")), anchor = t.getAttribute("text-anchor");
      const left = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
      return [left - 2, y - size, left + w + 2, y + 3];
    };
    const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const placed = [];
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
  function draw(profile, trueScale = false, fine = null) {
    const all = crossings(profile);
    const main = all.get(0) || [...all.values()][0];
    if (fine?.separateur) [main.separateur, main.separateurRelief] = [[...fine.separateur].sort((a, b) => a - b), "nuage"];
    const ref = zAt(main.points, 0) ?? main.points[0][1];  // 0 : plateforme sous l'origine
    const xs = [...all.values()].flatMap((t) => t.points.map((p) => p[0]));
    const zs = [...all.values()].flatMap((t) => t.points.map((p) => p[1] - ref));
    let [xmin, xmax] = [Math.min(...xs), Math.max(...xs)];
    const plotW = W - LEFT - RIGHT, plotH = H - TOP - BOTTOM;
    let [zmin, zmax] = [Math.min(...zs) - 0.3, Math.max(...zs) + 0.3];
    // Échelle des distances : toute la largeur, réduite (largeur centrée) si les hauteurs ne tiennent pas à ×1
    const sx = Math.min(plotW / (xmax - xmin), plotH / (zmax - zmin)), xmid = (xmin + xmax) / 2;
    [xmin, xmax] = [xmid - plotW / sx / 2, xmid + plotW / sx / 2];
    // Exagération entière, la plus forte qui fait tenir les hauteurs (au moins ×1) ; ×1 à l'échelle
    const exaggeration = Math.max(1, Math.floor(plotH / (zmax - zmin) / sx)), factor = trueScale ? 1 : exaggeration;
    const span = plotH / (sx * factor), zmid = (zmin + zmax) / 2;
    [zmin, zmax] = [zmid - span / 2, zmid + span / 2];
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
    svg.append(el("text", { x: 4, y: 16, class: "etiquette-profil" }, `Mesure ${profile.source} (IGN)`),
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
      svg.append(el("line", { x1: gx, x2: gx, y1: gy - 2, y2: gy - 18, class: "separateur" }),
        el("text", { x: gx, y: gy - 34, class: "graduation place", "data-haut": "", "text-anchor": "middle" },
          `séparateur de chaussée (${main.separateurRelief === "nuage" ? "nuage LiDAR" : main.separateurRelief ? "relief" : "BD TOPO"})`));  // d'où vient sa position, comme les bords
    }
    // Analyse fine : lignes blanches (petits rectangles blancs sur le terrain) et bords de chaussée (tirets courts nommés)
    if (fine) {
      for (const x of fine.lignes) {
        if (x < xmin || x > xmax) continue;
        svg.append(el("rect", { x: X(x) - 3, y: Z(zAt(main.points, x) ?? ref) - 3, width: 6, height: 6, class: "ligne-blanche" }));
      }
      for (const side of ["gauche", "droit"]) {
        const b = fine.bords[side];
        if (!b) continue;
        const gy = Z(zAt(main.points, b.x) ?? ref);
        svg.append(el("line", { x1: X(b.x), x2: X(b.x), y1: gy - 4, y2: gy - 22, class: "bord-chaussee" }));  // nommé dans la légende
      }
    }
    // Terrain remonté de profile.remontee au-dessus du bord : lecture arrêtée là (travers de la photo)
    for (const side of ["gauche", "droit"]) {
      const stop = main.bords[side]?.arret;
      if (stop === null || stop === undefined) continue;
      const zs_ = zAt(main.points, stop);
      svg.append(el("line", { x1: X(stop), x2: X(stop), y1: Z(zs_) - 30, y2: Z(zs_) + 6, class: "arret" }),
        el("text", { x: X(stop), y: Z(zs_) - 34, class: "graduation place", "text-anchor": "middle" }, "fin de lecture"));
    }
    svg.append(el("circle", { cx: X(0), cy: Z(ref) - 8, r: 5, class: "origine" }),
      el("text", { x: X(0), y: Z(ref) - 18, class: "graduation place", "data-haut": "", "text-anchor": "middle" }, profile.origine === "caméra" ? "caméra" : "axe"));

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
      ...(main.separateur ? [`Petite barre verticale\u00a0: milieu du séparateur de chaussée (terre-plein central), ${main.separateurRelief
        ? main.separateurRelief === "nuage" ? "trouvé dans le nuage LiDAR\u00a0: bande non revêtue (herbe, gravillons, glissières) entre les deux chaussées"
          : main.separateurRelief === "bosse" ? "trouvé dans le relief\u00a0: bosse étroite (assise de glissières ou de muret)"
          : `trouvé dans le relief entre deux marches du terrain (${num(Math.abs(main.separateur[1] - main.separateur[0]))} m de large)`
        : "placé d'après les largeurs BD TOPO (pas de marche du terrain trouvée)"}\u00a0; la plateforme va jusqu'au bord `
        + "extérieur de l'autre chaussée."] : []),
      ...(fine ? [`Analyse fine (nuage LiDAR HD, ${fine.points} points du sol)\u00a0: carrés blancs, lignes blanches lues à `
        + "l'intensité du retour laser\u00a0; tirets courts, bords de chaussée\u00a0: ligne de rive, sinon fin de l'enrobé"
        + `${["gauche", "droit"].map((side) => fine.bords[side] ? ` (${side}\u00a0: ${num(Math.abs(fine.bords[side].x))} m, `
          + `${fine.bords[side].comment})` : "").join("")}.`] : []),
      `Chute et dévers lus du bord jusqu'à ce que le terrain remonte de ${num(profile.remontee, 0)} m au-dessus du bord `
        + "(talus, butte)\u00a0: derrière, ce n'est pas une chute.",
      `${factor > 1 ? `Hauteurs exagérées ×${factor} pour la lisibilité` : "Hauteurs à l'échelle des distances"}. `
        + `Terrain ${profile.source} (IGN), altitudes à ±${num(profile.erreur)} m près.`,
    ].map((t) => html("p", "aide", t)));
    return { svg, legend };
  }

  /** Image PNG (Blob) du graphique svg affiché, avec son titre et sa légende legend (élément rendu par draw, dans
   * la page) : styles calculés recopiés (le CSS de la page n'entre pas dans une image SVG), couleurs et graisses
   * de la légende reprises, sur le fond de la fenêtre, en double résolution. */
  async function png(svg, title, legend) {
    const w = window, copy = svg.cloneNode(true), scale = 2;
    const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "paint-order",
      "opacity", "font-size", "font-weight", "font-family"];
    const nodes = [svg, ...svg.querySelectorAll("*")], copies = [copy, ...copy.querySelectorAll("*")];
    nodes.forEach((node, k) => {
      const style = w.getComputedStyle(node);
      copies[k].setAttribute("style", props.map((p) => `${p}:${style.getPropertyValue(p)}`).join(";"));
    });
    copy.setAttribute("width", W * scale);
    copy.setAttribute("height", H * scale);
    const image = new Image();
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(copy));
    await image.decode();
    const box = w.getComputedStyle(svg.closest("dialog") || document.body), font = w.getComputedStyle(svg).fontFamily;
    const pad = 16 * scale, width = W * scale, head = 40 * scale, top = head + H * scale + 6 * scale;
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
    g.drawImage(image, 0, head);
    for (const { text, x, y: at, font: f, color } of placed) {
      g.font = f;
      g.fillStyle = color;
      g.fillText(text, x, at);
    }
    return new Promise((resolve) => g.canvas.toBlob(resolve, "image/png"));
  }

  return { draw, png };
})();
