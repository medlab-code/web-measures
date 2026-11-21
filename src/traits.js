// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Surcouche des mesures dans la visionneuse, en WebGL : traits (visées des autres photos, droite de mesure,
// verticale, traits des mesures, lignes de la couche importée), croix des points, réticule glissant et
// étiquettes des mesures (valeurs, noms des points). Une toile transparente posée sur la photo, sous les repères
// HTML de la couche importée, redessinée à chaque image de la visionneuse (événement « render »). Les repères
// HTML de la visionneuse étaient replacés un à un à chaque image, et les traits SVG redessinés en entier, même
// hors de l'écran : lent en visée zoomée. Ici, chaque segment est coupé au plan de la caméra puis au cadre de la
// vue avant d'être dessiné : coût indépendant du zoom. Les étiquettes sont des images de texte (toile 2D),
// faites une fois par texte, puis posées comme des rectangles.

const Traits = (() => {
  const NEAR = 0.05;  // devant la caméra (sphère de la photo : rayon 10)
  const MARGIN = 20;  // px hors du cadre gardés (bouts des traits épais)
  const FLOATS = 9;   // par sommet : x, y (px), r, g, b, a, distance le long du trait (px), tiret, blanc
  const FONT = "Inter, system-ui, sans-serif", SIZE = 15;  // étiquettes (comme sur la carte, 25 % plus grandes)
  const GAP = 2;  // px entre deux étiquettes écartées
  const EDGE = 4;  // px entre une étiquette rabattue et le bord de la vue

  const VERTEX = `
    attribute vec2 position; attribute vec4 color; attribute float dist; attribute vec2 dash;
    uniform vec2 size;
    varying vec4 vColor; varying float vDist; varying vec2 vDash;
    void main() {
      vColor = color; vDist = dist; vDash = dash;
      gl_Position = vec4(position.x / size.x * 2.0 - 1.0, 1.0 - position.y / size.y * 2.0, 0.0, 1.0);
    }`;
  const FRAGMENT = `
    precision mediump float;
    varying vec4 vColor; varying float vDist; varying vec2 vDash;
    void main() {
      if (vDash.x > 0.0 && mod(vDist, vDash.x + vDash.y) > vDash.x) discard;
      gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);
    }`;
  // Étiquettes : image de texte (alpha prémultiplié) posée sur un rectangle
  const TEX_VERTEX = `
    attribute vec2 position; attribute vec2 uv; uniform vec2 size; varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.x / size.x * 2.0 - 1.0, 1.0 - position.y / size.y * 2.0, 0.0, 1.0);
    }`;
  const TEX_FRAGMENT = `
    precision mediump float;
    uniform sampler2D image; varying vec2 vUv;
    void main() { gl_FragColor = texture2D(image, vUv); }`;

  const BLACK = [0, 0, 0, 0.7], WHITE = [1, 1, 1, 0.85];
  let psv = null, canvas = null, gl = null, flat = null, textured = null;
  let lines = [], crosses = [], labels = [], slide = null, rects = [];
  let extra = { lines: [], crosses: [], ticks: [], labels: [] };  // seconde couche (setExtra), indépendante des mesures
  const images = new Map();  // texte et style d'une étiquette -> { texture, w, h } (px)

  const rgba = (color, alpha = 1) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).concat(alpha);

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  /** Programme WebGL : ses attributs [[nom, nombre de flottants]] dans un tampon à lui. */
  function program(vertex, fragment, attributes) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(p);
    const stride = attributes.reduce((n, [, k]) => n + k, 0);
    return { p, buffer: gl.createBuffer(), size: gl.getUniformLocation(p, "size"), stride,
      attributes: attributes.map(([name, n]) => [gl.getAttribLocation(p, name), n]) };
  }

  function use(prog, data, width, height) {
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, prog.buffer);
    let offset = 0;
    for (const [loc, n] of prog.attributes) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, prog.stride * 4, offset * 4);
      offset += n;
    }
    gl.uniform2f(prog.size, width, height);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  /** Toile posée sur la photo de la visionneuse viewer (Photo Sphere Viewer), une fois. */
  function attach(viewer) {
    if (psv) return true;
    const photo = viewer.renderer?.renderer?.domElement;
    canvas = document.createElement("canvas");
    canvas.className = "traits";
    gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!photo || !gl) return false;
    flat = program(VERTEX, FRAGMENT, [["position", 2], ["color", 4], ["dist", 1], ["dash", 2]]);
    textured = program(TEX_VERTEX, TEX_FRAGMENT, [["position", 2], ["uv", 2]]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    photo.after(canvas);
    psv = viewer;
    psv.addEventListener("render", () => draw());
    // Étiquettes faites avant le chargement de la police : refaites avec elle
    document.fonts?.ready.then(() => { images.clear(); psv.needsUpdate(); });
    return true;
  }

  const vector = ([yaw, pitch]) => psv.dataHelper.sphericalCoordsToVector3({ yaw, pitch });

  /**
   * Surcouche à dessiner. list : traits [{points: [[yaw, pitch]] (radians, repère de la photo), color: "#rrggbb",
   * width: px, dash: [trait, blanc] en px ou null, couche : ligne de la couche importée}]. marks.crosses : croix [{at:
   * [yaw, pitch], color, ring (cercle de la croix choisie, couleur ou null), visee, calage}] ; marks.labels :
   * étiquettes [{at, type ("mesure", "fin" : au point d'arrivée, ouverte par le nom du point, ou "nom"), place
   * ("dessus", "cote", "dessous", "left", "right", "above", "below"), text, chip (nom du point, étiquette « fin »),
   * provisional}]. Redessinés à l'image suivante.
   */
  function set(list, marks = {}) {
    if (!psv) return;
    lines = list.map((line) => ({ ...line, rgba: rgba(line.color), vectors: line.points.map(vector) }));
    crosses = (marks.crosses || []).map((c) => ({ ...c, vector: vector(c.at) }));
    labels = (marks.labels || []).map((l) => ({ ...l, vector: vector(l.at) }));
    psv.needsUpdate();
  }

  /**
   * Seconde couche, que les mesures (set) n'écrasent pas : « Largeur dans la visionneuse » (src/nez.js). Mêmes formes que set :
   * lines [{points, color, width}], crosses [{at, color}], labels [{at, type, place, text, lift (px : étiquette
   * remontée ; flip : si elle sortirait de la vue, elle passe de l'autre côté du point (place inversée), à flipLift px (signé comme lift, par défaut -lift))}] ; ticks : petits traits verticaux d'écran, de longueur constante en px, centrés sur le point
   * [{at, color, width (px), length (px), edge (couleur du liseré, facultatif : sans lui, pas de liseré)}] ; une ligne peut avoir alpha (0 à 1) et
   * dash [trait, blanc]. Pas dans les captures. Sans argument : couche vidée.
   */
  function setExtra(layer = {}) {
    if (!psv) return;
    extra = {
      lines: (layer.lines || []).map((line) => ({ ...line, extra: true, rgba: rgba(line.color, line.alpha ?? 1), vectors: line.points.map(vector) })),
      crosses: (layer.crosses || []).map((c) => ({ ...c, vector: vector(c.at) })),
      ticks: (layer.ticks || []).map((c) => ({ ...c, vector: vector(c.at) })),
      labels: (layer.labels || []).map((l) => ({ ...l, vector: vector(l.at) })),
    };
    psv.needsUpdate();
  }

  /** Réticule tenu sous le pointeur (largeur : sur la droite de mesure ; hauteur : trait jaune en travers de l'axe,
   * angle en degrés à l'écran) : { at: [yaw, pitch], color, angle (ou null) }, ou null pour le retirer. */
  function setSlide(value) {
    if (!psv) return;
    slide = value ? { ...value, vector: vector(value.at) } : null;
    psv.needsUpdate();
  }

  /** Segment (a, b) en px coupé au cadre élargi [lo, hi] (Liang-Barsky) : [t0, t1] gardés, ou null. */
  function clip(ax, ay, bx, by, lo, hiX, hiY) {
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    for (const [p, q] of [[-dx, ax - lo], [dx, hiX - ax], [-dy, ay - lo], [dy, hiY - ay]]) {
      if (p === 0) {
        if (q < 0) return null;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
        if (t0 > t1) return null;
      }
    }
    return [t0, t1];
  }

  /** Image d'une étiquette (pilule, nom du point en pastille ronde pour une « fin ») : { texture, w, h } en px. */
  function image(label) {
    const key = `${label.type}|${label.chip || ""}|${label.provisional ? 1 : 0}|${label.text}`;
    let found = images.get(key);
    if (found) return found;
    const ratio = window.devicePixelRatio || 1, font = `600 ${SIZE}px ${FONT}`;
    const g = document.createElement("canvas").getContext("2d");
    g.font = font;
    const textW = g.measureText(label.text).width, h = Math.round(SIZE * 1.4 + 4.8);
    const chipW = label.chip ? Math.max(SIZE * 1.35, g.measureText(label.chip).width + 0.6 * SIZE) : 0;
    const padLeft = label.chip ? 4 : 0.7 * SIZE, padRight = 0.7 * SIZE;
    const w = Math.ceil(padLeft + (chipW ? chipW + 0.45 * SIZE : 0) + textW + padRight);
    g.canvas.width = Math.ceil(w * ratio);
    g.canvas.height = Math.ceil(h * ratio);
    g.scale(ratio, ratio);
    const pill = (x, y, width, height, color) => {
      g.fillStyle = color;
      g.beginPath();
      g.roundRect(x, y, width, height, height / 2);
      g.fill();
    };
    const grey = "rgba(95, 99, 104, 0.92)";
    pill(0, 0, w, h, label.type === "nom" ? (label.provisional ? grey : "rgba(142, 27, 27, 0.92)") : "rgba(24, 25, 28, 0.82)");
    g.font = font;
    g.textBaseline = "middle";
    g.fillStyle = "#ffffff";
    let x = padLeft;
    if (chipW) {
      pill(x, 3, chipW, h - 6, label.provisional ? "rgba(95, 99, 104, 0.95)" : "rgba(142, 27, 27, 0.95)");
      g.fillStyle = "#ffffff";
      g.textAlign = "center";
      g.fillText(label.chip, x + chipW / 2, h / 2 + 0.5);
      g.textAlign = "left";
      x += chipW + 0.45 * SIZE;
    }
    g.fillText(label.text, x, h / 2 + 0.5);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, g.canvas);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    if (images.size > 300) {  // textes d'anciennes photos
      for (const old of images.values()) gl.deleteTexture(old.texture);
      images.clear();
    }
    found = { texture, w, h };
    images.set(key, found);
    return found;
  }

  /** Trait d'écran (px), plein : deux triangles (6 sommets x, y, couleur, 0, 0, 0) ajoutés à into. */
  function segment(into, ax, ay, bx, by, width_, color) {
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1e-6) return;
    const half = width_ / 2, ux = (bx - ax) / length * half, uy = (by - ay) / length * half, nx = -uy, ny = ux;
    const corner = (x, y) => into.push(x, y, ...color, 0, 0, 0);
    corner(ax - ux + nx, ay - uy + ny); corner(ax - ux - nx, ay - uy - ny); corner(bx + ux + nx, by + uy + ny);
    corner(bx + ux + nx, by + uy + ny); corner(ax - ux - nx, ay - uy - ny); corner(bx + ux - nx, by + uy - ny);
  }

  /** Cercle d'écran de rayon r (px), en 32 traits ajoutés à into. */
  function circle(into, x, y, r, width_, color) {
    for (let k = 0; k < 32; k++) {
      const a = k / 32 * 2 * Math.PI, b = (k + 1) / 32 * 2 * Math.PI;
      segment(into, x + r * Math.cos(a), y + r * Math.sin(a), x + r * Math.cos(b), y + r * Math.sin(b), width_, color);
    }
  }

  /** Étiquettes placées à l'écran (at : position d'écran d'un point, ou null) : les autres d'abord, puis celles des
   * points d'arrivée écartées vers le bas, de la plus haute à la plus basse, avec un trait de renvoi blanc vers leur
   * croix (ajouté à out). Rectangles gardés dans rects (labelRects) ; rend [[étiquette, rectangle, texture]]. */
  function placeLabels(at, out, labels) {
    const placed = [], quads = [];
    const put = (label, r) => {
      quads.push([label, r, image(label).texture]);
      placed.push(r);
      rects.push(r);
    };
    const ends = [];
    for (const label of labels) {
      const s = at(label.vector);
      if (!s) continue;
      const { w, h } = image(label);
      let r = box(label, s[0], s[1] - (label.lift || 0), w, h);
      if (label.flip && ((label.lift || 0) < 0 ? r.bottom > canvas.clientHeight - 2 : r.top < 2)) {  // sortirait de la vue : de l'autre côté du point
        r = box({ ...label, place: label.place === "dessous" ? "dessus" : "dessous" }, s[0], s[1] - (label.flipLift ?? -(label.lift || 0)), w, h);
      }
      if (!["cote", "left", "right"].includes(label.place)) {  // centrée sur le point : rabattue contre le bord gauche ou droit si elle en sortirait
        const dx = r.left < EDGE ? EDGE - r.left : r.right > canvas.clientWidth - EDGE ? canvas.clientWidth - EDGE - r.right : 0;
        if (dx) r = { ...r, left: r.left + dx, right: r.right + dx };
      }
      if (label.type === "fin") ends.push({ label, s, r });
      else put(label, r);
    }
    const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom + GAP && a.bottom + GAP > b.top;
    ends.sort((a, b) => a.r.top - b.r.top);
    for (const { label, s, r: start } of ends) {
      let r = start, shift = 0;
      for (let k = 0; k < 20; k++) {
        const other = placed.find((q) => hit(r, q));
        if (!other) break;
        shift += other.bottom + GAP - r.top;
        r = { ...start, top: start.top + shift, bottom: start.bottom + shift };
      }
      if (shift > 0) {  // renvoi : trait blanc de la croix à l'étiquette écartée
        const x = label.place === "cote" ? s[0] + 6 : s[0], y0 = label.place === "cote" ? s[1] : s[1] + 10;
        segment(out, x, y0, x, y0 + shift, 1.5, WHITE);
      }
      put(label, r);
    }
    return quads;
  }

  /** Rectangle {left, top, right, bottom} (px) de l'étiquette de taille w × h placée à (x, y) selon sa place. */
  function box(label, x, y, w, h) {
    const d = label.type === "mesure" ? (label.place === "cote" ? 9 : 7) : 10;
    const [left, top] = {
      dessus: [x - w / 2, y - d - h], cote: [x + d, y - h / 2], dessous: [x - w / 2, y + d],
      left: [x - d - w, y - h / 2], right: [x + d, y - h / 2], above: [x - w / 2, y - d - h], below: [x - w / 2, y + d],
    }[label.place] || [x - w / 2, y - d - h];
    return { left, top, right: left + w, bottom: top + h };
  }

  // capture : sans les lignes de la couche importée (la capture les dessine sous ses pastilles) ni le réticule
  function draw(capture = false) {
    const width = canvas.clientWidth, height = canvas.clientHeight, ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    rects = [];
    const drawnLines = capture ? lines.filter((l) => !l.couche) : lines.concat(extra.lines), reticle = capture ? null : slide;
    const drawnCrosses = capture ? crosses : crosses.concat(extra.crosses), ticks = capture ? [] : extra.ticks;
    // Visionneuse à la petite place (carte en grand) : seule la localisation s'affiche, donc pas d'étiquettes dans la photo (captures : toujours)
    const drawnLabels = capture ? labels : document.body.classList.contains("carte-en-grand") ? [] : labels.concat(extra.labels);
    if (!width || !(drawnLines.length || drawnCrosses.length || ticks.length || drawnLabels.length || reticle)) return;
    const camera = psv.renderer.camera;
    const m = camera.matrixWorldInverse.elements, p = camera.projectionMatrix.elements;
    const view = (v) => [m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12],
      m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13], m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14]];
    const screen = ([x, y, z]) => [((p[0] * x + p[8] * z) / -z + 1) / 2 * width,
      (1 - (p[5] * y + p[9] * z) / -z) / 2 * height];
    const at = (v) => {  // point à l'écran, ou null derrière la caméra ou loin hors du cadre
      const c = view(v);
      if (c[2] > -NEAR) return null;
      const s = screen(c);
      return s[0] < -MARGIN * 5 || s[0] > width + MARGIN * 5 || s[1] < -MARGIN * 5 || s[1] > height + MARGIN * 5 ? null : s;
    };
    const out = [], top = [];

    for (const line of drawnLines) {
      const half = line.width / 2, [on, off] = line.dash || [0, 0];
      let along = 0;  // distance parcourue à l'écran, pour les tirets
      let a = view(line.vectors[0]);
      for (let i = 1; i < line.vectors.length; i++) {
        let b = view(line.vectors[i]), from = a, to = b;
        a = b;
        if (from[2] > -NEAR && to[2] > -NEAR) continue;  // derrière la caméra
        if (from[2] > -NEAR || to[2] > -NEAR) {  // coupé au plan de la caméra
          const t = (-NEAR - from[2]) / (to[2] - from[2]), cut = from.map((c, k) => c + t * (to[k] - c));
          if (from[2] > -NEAR) from = cut;
          else to = cut;
        }
        const [ax, ay] = screen(from), [bx, by] = screen(to);
        const length = Math.hypot(bx - ax, by - ay), kept = clip(ax, ay, bx, by, -MARGIN, width + MARGIN, height + MARGIN);
        const start = along;
        along += length;
        if (!kept || length < 1e-6) continue;
        const ux = (bx - ax) / length, uy = (by - ay) / length, nx = -uy * half, ny = ux * half;
        // bouts prolongés d'une demi-épaisseur : jointures sans trou
        const x0 = ax + (bx - ax) * kept[0] - ux * half, y0 = ay + (by - ay) * kept[0] - uy * half;
        const x1 = ax + (bx - ax) * kept[1] + ux * half, y1 = ay + (by - ay) * kept[1] + uy * half;
        const d0 = start + length * kept[0] - half, d1 = start + length * kept[1] + half;
        const corner = (x, y, d) => out.push(x, y, ...line.rgba, d, on, off);
        corner(x0 + nx, y0 + ny, d0); corner(x0 - nx, y0 - ny, d0); corner(x1 + nx, y1 + ny, d1);
        corner(x1 + nx, y1 + ny, d1); corner(x0 - nx, y0 - ny, d0); corner(x1 - nx, y1 - ny, d1);
      }
    }

    // Croix : branches de 18 px cernées de noir ; la croix choisie dans un cercle
    for (const c of drawnCrosses) {
      const s = at(c.vector);
      if (!s) continue;
      const [x, y] = s;
      for (const [w, color] of [[4, BLACK], [2, rgba(c.color)]]) {
        segment(out, x - 9, y, x + 9, y, w, color);
        segment(out, x, y - 9, x, y + 9, w, color);
      }
      if (c.ring) circle(out, x, y, 10, 2, rgba(c.ring));
    }

    for (const c of ticks) {  // poignées : trait vertical d'écran, avec un liseré si edge est donné
      const s = at(c.vector);
      if (!s) continue;
      const half = c.length / 2;
      if (c.edge) segment(out, s[0], s[1] - half, s[0], s[1] + half, c.width + 3, rgba(c.edge));  // liseré seulement si demandé
      segment(out, s[0], s[1] - half, s[0], s[1] + half, c.width, rgba(c.color));
    }

    const quads = placeLabels(at, out, drawnLabels);  // étiquettes : [étiquette, rectangle, texture]

    // Réticule glissant, au-dessus de tout
    if (reticle) {
      const s = at(slide.vector);
      if (s) {
        const [x, y] = s;
        if (slide.angle != null) {  // hauteur : trait jaune de 198 px en travers de l'axe
          const a = slide.angle * Math.PI / 180, dx = Math.cos(a) * 99, dy = Math.sin(a) * 99;
          segment(top, x - dx, y - dy, x + dx, y + dy, 4, [0, 0, 0, 0.5]);
          segment(top, x - dx, y - dy, x + dx, y + dy, 2, rgba("#ffeb00"));
        }
        circle(top, x, y, 15, 2.5, rgba(slide.color));
        const arm = rgba("#ff8a80");
        segment(top, x, y - 14.5, x, y - 3.5, 1.5, arm); segment(top, x, y + 3.5, x, y + 14.5, 1.5, arm);
        segment(top, x - 14.5, y, x - 3.5, y, 1.5, arm); segment(top, x + 3.5, y, x + 14.5, y, 1.5, arm);
        circle(top, x, y, 0.5, 1, [1, 1, 1, 1]);
      }
    }

    if (out.length) {
      use(flat, new Float32Array(out), width, height);
      gl.drawArrays(gl.TRIANGLES, 0, out.length / FLOATS);
    }
    if (quads.length) {
      for (const [, r, texture] of quads) {
        const { left: x0, top: y0, right: x1, bottom: y1 } = r;
        use(textured, new Float32Array([x0, y0, 0, 0, x1, y0, 1, 0, x0, y1, 0, 1, x0, y1, 0, 1, x1, y0, 1, 0, x1, y1, 1, 1]),
          width, height);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }
    if (top.length) {
      use(flat, new Float32Array(top), width, height);
      gl.drawArrays(gl.TRIANGLES, 0, top.length / FLOATS);
    }
  }

  /** Toile de la surcouche dessinée tout de suite pour une capture (vignette), à lire aussitôt : sans les lignes de
   * la couche importée ni le réticule ; la visionneuse la redessine en entier à l'image suivante. null sans toile. */
  function snapshot() {
    if (!psv) return null;
    draw(true);
    psv.needsUpdate();
    return canvas;
  }

  /** Repères demandés, à l'écran ou non (essais) : { crosses, labels (texte, nom du point compris), slide }. */
  const items = () => ({ crosses, labels: labels.map((l) => ({ ...l, text: `${l.chip || ""}${l.text}` })), slide });

  /** Étiquettes des mesures à l'écran (coordonnées de la fenêtre) : les étiquettes HTML de la couche les évitent. */
  function labelRects() {
    if (!canvas) return [];
    const b = canvas.getBoundingClientRect();
    return rects.map((r) => ({ left: r.left + b.left, right: r.right + b.left, top: r.top + b.top, bottom: r.bottom + b.top }));
  }

  return { attach, set, setExtra, setSlide, snapshot, items, labelRects };
})();
