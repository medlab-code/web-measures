// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Profil en travers des bords de route (bouton « Profil », à côté de « Dévers ») : la coupe du
// terrain telle que le calcul de App._compute_edges l'a lue (py/web_app.py), en SVG. Chaussée entre
// les deux bords trouvés, chute et dévers à l'endroit où ils ont été mesurés. Les hauteurs sont
// exagérées (le facteur est écrit) : sur 30 m de large, un talus de 2 m serait illisible.

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
      t.bords[p.cote] = { x: sign * p.bord, relief: p.relief };
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

  /** Graphique SVG et sa légende en clair (texte) pour profile (voir App._compute_edges). */
  function draw(profile) {
    const all = crossings(profile);
    const main = all.get(0) || [...all.values()][0];
    const ref = zAt(main.points, 0) ?? main.points[0][1];  // 0 : chaussée sous l'origine
    const xs = [...all.values()].flatMap((t) => t.points.map((p) => p[0]));
    const zs = [...all.values()].flatMap((t) => t.points.map((p) => p[1] - ref));
    const [xmin, xmax] = [Math.min(...xs), Math.max(...xs)];
    const plotW = W - LEFT - RIGHT, plotH = H - TOP - BOTTOM, sx = plotW / (xmax - xmin);
    let [zmin, zmax] = [Math.min(...zs) - 0.3, Math.max(...zs) + 0.3];
    // Exagération entière, la plus forte qui fait tenir les hauteurs (au moins ×1)
    const exaggeration = Math.max(1, Math.floor(plotH / (zmax - zmin) / sx));
    const span = plotH / (sx * exaggeration), mid = (zmin + zmax) / 2;
    [zmin, zmax] = [mid - span / 2, mid + span / 2];
    const X = (x) => LEFT + (x - xmin) * sx, Z = (z) => TOP + (zmax - (z - ref)) / (zmax - zmin) * plotH;
    const path = (points) => points.map(([x, z], k) => `${k ? "L" : "M"}${X(x).toFixed(1)},${Z(z).toFixed(1)}`).join("");
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "profil-svg", role: "img",
      "aria-label": "Coupe du terrain en travers de la route" });

    // Repères : mètres en travers, hauteurs par rapport à la chaussée
    const xStep = xmax - xmin > 30 ? 5 : 2;
    for (let x = Math.ceil(xmin / xStep) * xStep; x <= xmax; x += xStep) {
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

    // Chaussée entre les deux bords du travers de la photo
    const [bl, br] = [main.bords.gauche?.x ?? 0, main.bords.droit?.x ?? 0];
    const road = main.points.filter(([x]) => x >= bl && x <= br);
    if (road.length > 1) {
      svg.append(el("path", { d: path(road), class: "chaussee" }),
        el("text", { x: X((bl + br) / 2), y: Z(zAt(main.points, (bl + br) / 2)) + 26, class: "etiquette-profil", "text-anchor": "middle" },
          `chaussée ${num(br - bl)} m`));
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
    svg.append(el("circle", { cx: X(0), cy: Z(ref) - 8, r: 5, class: "origine" }),
      el("text", { x: X(0), y: Z(ref) - 18, class: "graduation", "text-anchor": "middle" }, profile.origine === "caméra" ? "caméra" : "axe"));

    // Chute et dévers, sur le travers où ils ont été mesurés ; une puce par côté dans la légende
    const html = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text });
    const results = document.createElement("ul");
    for (const side of ["gauche", "droit"]) {
      const r = profile.resultats[side], sign = side === "gauche" ? -1 : 1;
      const item = document.createElement("li");
      item.append(html("b", "", `Côté ${side}\u00a0: `));
      results.append(item);
      if (!r) {
        item.append(`pas de chute de 0,5 m ou plus jusqu'à ${num(profile.zone, 0)} m du bord`);
        continue;
      }
      const t = all.get(r.chute[3]) || main, b = t.bords[side].x;
      const where = t === main ? "" : ` (travers à ${t.along > 0 ? "+" : "−"}${Math.abs(t.along)} m)`;
      if (t !== main) {
        const end = sign < 0 ? t.points[0] : t.points.at(-1);
        svg.append(el("path", { d: path(t.points), class: "travers-mesure" }),
          el("text", { x: X(end[0]) - sign * 2, y: Z(end[1]) - 6, class: "graduation", "text-anchor": sign < 0 ? "start" : "end" },
            `travers à ${t.along > 0 ? "+" : "−"}${Math.abs(t.along)} m`));
      }
      const top = zAt(t.points, b), xLow = b + sign * r.chute[1], low = top - r.chute[0];
      // étiquette à l'extérieur de la flèche, sauf si elle sortirait du cadre
      const out = sign < 0 ? X(xLow) - 100 > 0 : X(xLow) + 100 < W, toward = out ? sign : -sign;
      svg.append(el("line", { x1: X(b), x2: X(xLow), y1: Z(top), y2: Z(top), class: "repere-chute" }),
        el("line", { x1: X(xLow), x2: X(xLow), y1: Z(top), y2: Z(low), class: "chute", "marker-end": "url(#fleche)" }),
        el("text", { x: X(xLow) + toward * 6, y: (Z(top) + Z(low)) / 2, class: "etiquette-profil chute-texte",
          "text-anchor": toward < 0 ? "end" : "start" }, `chute ${r.chute[2] ? "≥ " : ""}${num(r.chute[0])} m`));
      item.append(html("span", "chute", `chute ${r.chute[2] ? "d'au moins " : "de "}${num(r.chute[0])} m`),
        ` ${r.chute[2] ? "au-delà de" : "à"} ${num(r.chute[1], 0)} m du bord${where}`);
      if (r.devers) {
        const td = all.get(r.devers[2]) || main, bd = td.bords[side].x;
        const x0 = bd + sign * r.devers[1], x1 = x0 + sign * profile.fenetre;
        const segment = td.points.filter(([x]) => (x - x0) * (x - x1) <= 0);
        svg.append(el("path", { d: path(segment), class: "devers" }),
          el("text", { x: X((x0 + x1) / 2) - sign * 12, y: Z(zAt(td.points, (x0 + x1) / 2)) + 4, class: "etiquette-profil devers-texte",
            "text-anchor": sign < 0 ? "start" : "end" }, `dévers ${num(100 * r.devers[0], 0)} %`));
        item.append(" · ", html("span", "devers", `dévers le plus fort ${num(100 * r.devers[0], 0)}\u00a0%`),
          ` (pente sur ${num(profile.fenetre, 0)} m)`);
      }
    }
    const marker = el("marker", { id: "fleche", viewBox: "0 0 10 10", refX: 10, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" });
    marker.append(el("path", { d: "M0,0L10,5L0,10Z", class: "fleche" }));
    svg.prepend(el("defs", {}));
    svg.firstChild.append(marker);

    // Lecture du graphique, sous les résultats, en discret
    const from = profile.origine === "caméra" ? "la caméra" : "l'axe de la route (position GPS non vérifiée RTK)";
    const legend = document.createElement("div");
    legend.append(results, ...[
      `Coupe du terrain vue dans le sens de la photo, depuis ${from}\u00a0; 0 = la chaussée sous ${
        profile.origine === "caméra" ? "la caméra" : "l'axe"}.`,
      "Trait brun\u00a0: travers de la photo · pointillés\u00a0: travers à 5 et 10 m devant et derrière · "
        + "trait gris\u00a0: travers où la chute a été mesurée.",
      `${exaggeration > 1 ? `Hauteurs exagérées ×${exaggeration} pour la lisibilité` : "Hauteurs à l'échelle"}. `
        + `Terrain ${profile.source} (IGN), altitudes à ±${num(profile.erreur)} m près.`,
    ].map((t) => html("p", "aide", t)));
    return { svg, legend };
  }

  /** Image PNG (Blob) du graphique svg affiché, avec son titre et sa légende legend (élément rendu par draw, dans
   * la page) : styles calculés recopiés (le CSS de la page n'entre pas dans une image SVG), couleurs et graisses
   * de la légende reprises, sur le fond de la fenêtre, en double résolution. */
  async function png(svg, title, legend) {
    const w = window, copy = svg.cloneNode(true), scale = 2;
    const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "opacity",
      "font-size", "font-weight", "font-family"];
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
