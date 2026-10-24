// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Traits de la visionneuse en WebGL (visées des autres photos, droite de mesure, verticale,
// traits des mesures) : une toile transparente posée sur la photo, sous les croix et les
// étiquettes, redessinée à chaque image de la visionneuse (événement « render »). Les traits
// en SVG de la visionneuse étaient redessinés en entier à chaque image, même loin hors de
// l'écran (et leurs tirets avec) : lent en visée zoomée. Ici, chaque segment est coupé au
// plan de la caméra puis au cadre de la vue avant d'être dessiné : coût indépendant du zoom.

const Traits = (() => {
  const NEAR = 0.05;  // devant la caméra (sphère de la photo : rayon 10)
  const MARGIN = 20;  // px hors du cadre gardés (bouts des traits épais)
  const FLOATS = 9;   // par sommet : x, y (px), r, g, b, a, distance le long du trait (px), tiret, blanc

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

  let psv = null, canvas = null, gl = null, buffer = null, where = {}, lines = [];

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  /** Toile posée sur la photo de la visionneuse viewer (Photo Sphere Viewer), une fois. */
  function attach(viewer) {
    if (psv) return true;
    const photo = viewer.renderer?.renderer?.domElement;
    canvas = document.createElement("canvas");
    canvas.className = "traits";
    gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!photo || !gl) return false;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    let offset = 0;
    for (const [name, n] of [["position", 2], ["color", 4], ["dist", 1], ["dash", 2]]) {
      const loc = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, FLOATS * 4, offset * 4);
      offset += n;
    }
    where.size = gl.getUniformLocation(program, "size");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    photo.after(canvas);
    psv = viewer;
    psv.addEventListener("render", draw);
    return true;
  }

  /**
   * Traits à dessiner : [{points: [[yaw, pitch]] (radians, repère de la photo), color: "#rrggbb",
   * width: px, dash: [trait, blanc] en px ou null}]. Redessinés à l'image suivante.
   */
  function set(list) {
    if (!psv) return;
    lines = list.map((line) => ({
      ...line,
      rgba: [1, 3, 5].map((i) => parseInt(line.color.slice(i, i + 2), 16) / 255).concat(1),
      vectors: line.points.map(([yaw, pitch]) => psv.dataHelper.sphericalCoordsToVector3({ yaw, pitch })),
    }));
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

  function draw() {
    const width = canvas.clientWidth, height = canvas.clientHeight, ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!lines.length || !width) return;
    const camera = psv.renderer.camera;
    const m = camera.matrixWorldInverse.elements, p = camera.projectionMatrix.elements;
    const view = (v) => [m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12],
      m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13], m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14]];
    const screen = ([x, y, z]) => [((p[0] * x + p[8] * z) / -z + 1) / 2 * width,
      (1 - (p[5] * y + p[9] * z) / -z) / 2 * height];
    const out = [];
    for (const line of lines) {
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
    if (!out.length) return;
    gl.uniform2f(where.size, width, height);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, out.length / FLOATS);
  }

  return { attach, set };
})();
