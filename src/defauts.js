// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Mise en évidence des défauts de la chaussée dans la visionneuse (affichage seulement : mesures et exports
// inchangés), en WebGL 2 : égalisation locale du contraste CLAHE, puis contours de Sobel sur la luminosité
// égalisée, dessinés en jaune. Une toile posée sur la photo (sous les traits de mesure), redessinée à chaque image
// de la visionneuse (événement « render »), seulement quand le filtre est allumé.
//   1. La photo affichée est copiée dans une texture, avec ses mipmaps.
//   2. Une image réduite (GRID × TILE px) en est tirée sur la carte graphique, lue (quelques Ko) : sur le
//      processeur, un histogramme de luminosité par case (GRID colonnes × ROWS lignes), limité à CLIP fois sa
//      moyenne (la limite du CLAHE : le bruit de l'enrobé n'est pas amplifié), l'excédent réparti, puis la fonction
//      de répartition : une table de correspondance par case (BINS valeurs).
//   3. Le fragment de chaque pixel mélange, en bilinéaire, les tables des quatre cases voisines (pas de coupure
//      aux bords des cases), puis Sobel lit neuf pixels égalisés.

const Defauts = (() => {
  const GRID = 8, ROWS = 6, TILE_W = 20, TILE_H = 16;  // cases du CLAHE et leur taille dans l'image réduite
  const BINS = 64, CLIP = 2;  // classes de luminosité par table ; limite de l'histogramme (× la moyenne)
  const STEP = 3;  // px entre deux lectures de Sobel : à 1 px, il suit le grain de l'enrobé, qui s'allume partout

  const VERTEX = `#version 300 es
    out vec2 uv;
    void main() {
      vec2 p = vec2(float((gl_VertexID & 1) * 2 - 1), float((gl_VertexID >> 1) * 2 - 1));
      uv = p * 0.5 + 0.5;
      gl_Position = vec4(p, 0.0, 1.0);
    }`;
  const SMALL = `#version 300 es
    precision mediump float;
    uniform sampler2D photo; in vec2 uv; out vec4 color;
    void main() { color = vec4(texture(photo, uv).rgb, 1.0); }`;  // mipmap automatique : moyenne des pixels voisins
  const MAIN = `#version 300 es
    precision highp float;
    uniform sampler2D photo, lut; uniform vec2 texel, grid; uniform float bins, edge;
    in vec2 uv; out vec4 color;
    float eq(vec2 at) {  // luminosité égalisée : tables des quatre cases voisines, mélangées
      float l = dot(textureLod(photo, at, 0.0).rgb, vec3(0.299, 0.587, 0.114));
      vec2 pos = at * grid - 0.5, t0 = floor(pos), f = pos - t0;
      float v = 0.0;
      for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
        vec2 t = clamp(t0 + vec2(float(i), float(j)), vec2(0.0), grid - 1.0);
        float u = (t.x * bins + l * (bins - 1.0) + 0.5) / (grid.x * bins);
        v += (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y) * texture(lut, vec2(u, (t.y + 0.5) / grid.y)).r;
      }
      return v;
    }
    void main() {
      float a = eq(uv + texel * vec2(-1.0, -1.0)), b = eq(uv + texel * vec2(0.0, -1.0)), c = eq(uv + texel * vec2(1.0, -1.0));
      float d = eq(uv + texel * vec2(-1.0, 0.0)),  e = eq(uv),                             f = eq(uv + texel * vec2(1.0, 0.0));
      float g = eq(uv + texel * vec2(-1.0, 1.0)),  h = eq(uv + texel * vec2(0.0, 1.0)),   i = eq(uv + texel * vec2(1.0, 1.0));
      float m = length(vec2((c + 2.0 * f + i) - (a + 2.0 * d + g), (g + 2.0 * h + i) - (a + 2.0 * b + c)));
      float k = smoothstep(0.9, 2.2, m) * edge;
      color = vec4(mix(vec3(e), vec3(1.0, 0.85, 0.1), k), 1.0);
    }`;

  let psv = null, photo = null, canvas = null, gl = null, on = false;
  let big = null, small = null, smallBuffer = null, lutTexture = null, bigTexture = null, smallTexture = null;
  const pixels = new Uint8Array(GRID * TILE_W * ROWS * TILE_H * 4);
  const lut = new Uint8Array(GRID * BINS * ROWS);

  function program(fragment) {
    const make = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const p = gl.createProgram();
    gl.attachShader(p, make(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(p, make(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function texture(unit, filter, wrap = gl.CLAMP_TO_EDGE) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return t;
  }

  /** Tables CLAHE (une par case) à partir de l'image réduite lue dans `pixels`. */
  function tables() {
    const width = GRID * TILE_W, hist = new Float32Array(BINS);
    for (let ty = 0; ty < ROWS; ty++) {
      for (let tx = 0; tx < GRID; tx++) {
        hist.fill(0);
        for (let y = 0; y < TILE_H; y++) {
          for (let x = 0; x < TILE_W; x++) {
            const o = ((ty * TILE_H + y) * width + tx * TILE_W + x) * 4;
            const luma = (0.299 * pixels[o] + 0.587 * pixels[o + 1] + 0.114 * pixels[o + 2]) / 255;
            hist[Math.min(BINS - 1, Math.floor(luma * BINS))]++;
          }
        }
        const total = TILE_W * TILE_H, limit = Math.max(1, (CLIP * total) / BINS);
        let excess = 0;
        for (let b = 0; b < BINS; b++) if (hist[b] > limit) { excess += hist[b] - limit; hist[b] = limit; }
        let sum = 0;
        for (let b = 0; b < BINS; b++) {
          hist[b] += excess / BINS;
          sum += hist[b];
          lut[ty * GRID * BINS + tx * BINS + b] = Math.round((255 * sum) / total);
        }
      }
    }
  }

  /** Toile posée sur la photo de la visionneuse viewer (Photo Sphere Viewer), une fois ; false : WebGL 2 absent. */
  function attach(viewer) {
    if (psv) return true;
    photo = viewer.renderer?.renderer?.domElement;
    canvas = document.createElement("canvas");
    canvas.className = "defauts";
    canvas.hidden = true;
    gl = canvas.getContext("webgl2", { alpha: false });
    if (!photo || !gl) return false;
    try {
      small = program(SMALL);
      big = program(MAIN);
    } catch (error) {
      console.warn("Défauts de la route : shaders refusés", error);
      return false;
    }
    bigTexture = texture(0, gl.LINEAR_MIPMAP_LINEAR);
    lutTexture = texture(1, gl.LINEAR);
    smallTexture = texture(2, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, GRID * TILE_W, ROWS * TILE_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    smallBuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, smallBuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, smallTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    photo.after(canvas);
    psv = viewer;
    psv.addEventListener("render", () => { if (on) draw(); });
    return true;
  }

  function draw() {
    if (!photo.width || !photo.height) return;
    if (canvas.width !== photo.width || canvas.height !== photo.height) {
      canvas.width = photo.width;
      canvas.height = photo.height;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bigTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, photo);  // lue juste après son rendu
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.bindFramebuffer(gl.FRAMEBUFFER, smallBuffer);  // image réduite, lue pour les histogrammes
    gl.viewport(0, 0, GRID * TILE_W, ROWS * TILE_H);
    gl.useProgram(small);
    gl.uniform1i(gl.getUniformLocation(small, "photo"), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, GRID * TILE_W, ROWS * TILE_H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    tables();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, GRID * BINS, ROWS, 0, gl.RED, gl.UNSIGNED_BYTE, lut);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(big);
    gl.uniform1i(gl.getUniformLocation(big, "photo"), 0);
    gl.uniform1i(gl.getUniformLocation(big, "lut"), 1);
    gl.uniform2f(gl.getUniformLocation(big, "texel"), STEP / canvas.width, STEP / canvas.height);
    gl.uniform2f(gl.getUniformLocation(big, "grid"), GRID, ROWS);
    gl.uniform1f(gl.getUniformLocation(big, "bins"), BINS);
    gl.uniform1f(gl.getUniformLocation(big, "edge"), 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Allume ou éteint le filtre ; false : impossible (visionneuse pas prête ou WebGL 2 absent). */
  function set(value) {
    if (value && !psv) return false;
    on = Boolean(value);
    if (canvas) canvas.hidden = !on;
    psv?.needsUpdate();
    return true;
  }

  return { attach, set, get on() { return on; } };
})();
