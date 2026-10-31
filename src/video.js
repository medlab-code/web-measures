// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Vidéo MP4 du parcours (1920 × 1080, sinon 1280 × 720 ; 30 images par seconde) : chaque image est calculée hors
// écran (WebGL2) depuis les tuiles HD des photos, et non capturée dans la visionneuse : cadence régulière quel que
// soit le réseau. Regard dans l'axe de la trajectoire lissée, horizon corrigé de la pente. D'une photo à la suivante,
// avancée simulée : chaque photo est plaquée sur une maquette simple autour de sa caméra (chaussée plane à CAM_HEIGHT m
// sous elle, sur ROAD m de part et d'autre de l'axe ; tout le reste sur une sphère de BOWL m : un poteau y tient
// entier, sans se plier ; des murs le long de la route captaient aussi les collines des côtés), où la caméra
// virtuelle avance réellement : la chaussée défile, le lointain bouge peu ; la photo quittée cède la place à la
// suivante (vue depuis le même point) en fondu. Le toit du véhicule (bas du panorama, sous ROOF) est écarté :
// l'autre photo le remplace. Encodage H.264 par le navigateur (WebCodecs ; VP9 s'il n'encode pas le H.264, Firefox
// sous Linux), fichier assemblé par mp4-muxer, chargé au premier export seulement.

const Video = (() => {
  const FPS = 30;
  const SIZES = [[1920, 1080, 1], [1280, 720, 0.5]];  // largeur, hauteur, part du débit du codec : la première encodable
  // H.264 High, Main, Baseline (niveau 4.0), puis VP9 (Firefox sous Linux : H.264 annoncé mais pas encodé, bug
  // Mozilla 2085549), dans un MP4 aussi ; codec du fichier pour mp4-muxer ; débit en 1080p (bit/s). Mesuré le 31/10/2026
  // contre une version à 80 Mbit/s : H.264 10 Mbit/s très flou (PSNR 32 dB), 30 Mbit/s 37,6 dB ; VP9 20 Mbit/s 36,8 dB
  const CODECS = [["avc1.640028", "avc", 30e6], ["avc1.4d0028", "avc", 30e6], ["avc1.42e028", "avc", 30e6],
    ["vp09.00.40.08", "vp9", 20e6]];
  const MUXER = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/build/mp4-muxer.min.js";
  const HFOV = 80;  // degrés : champ horizontal de la vue (vertical : ± 24° en 16/9, au-dessus du toit du véhicule)
  const SMOOTH = 15;  // m : cap de la vue = direction de la trajectoire de s - SMOOTH à s + SMOOTH (stabilisation)
  const SLOPE = 20;  // m : pente de la route mesurée de part et d'autre de la photo (altitudes GPS)
  const CAM_HEIGHT = 2.4;  // m : caméra au-dessus de la chaussée (toit du véhicule)
  const BOWL = 60;  // m : rayon de la sphère du décor de la maquette
  const ROAD = 4;  // m : chaussée plane de la maquette, de part et d'autre de l'axe de la vue
  const ROOF = -25;  // degrés : sous cette latitude du panorama, le toit du véhicule
  const GAP = 15;  // m : avancée au plus sur une photo (photos plus espacées : la maquette déforme trop au-delà)
  const AHEAD = 4;  // photos chargées d'avance
  const HOLD = 1;  // s : arrêt sur la première et la dernière vue
  const MARGIN = 8;  // degrés : marge des tuiles chargées autour du champ (cap qui varie le long de la photo)
  const EXPO_SIDE = 3;  // photos mesurées de part et d'autre d'un changement de séquence (exposition)
  const EXPO_RAMP = 100;  // m : retour progressif à l'exposition propre de la nouvelle séquence
  const EXPO_MAX = 2;  // gain d'exposition au plus (ou 1 / EXPO_MAX)
  const BLUR = 8;  // vues moyennées par image pour le flou cinétique (obturateur ouvert toute l'image : 360°)

  const supported = () => typeof VideoEncoder === "function" && typeof VideoFrame === "function"
    && typeof OffscreenCanvas === "function";

  /** Photo du parcours gardée pour la vidéo : position, altitude, cap EXIF, grille de tuiles HD (sinon l'image SD
   * entière), date de prise de vue, séquence et vignette (exposition). feature : fiche STAC ; point : { coords, alt,
   * heading } de la lecture. */
  function record(feature, point) {
    const matrix = feature.properties?.["tiles:tile_matrix_sets"]?.geovisio?.tileMatrix?.[0];
    const sd = feature.assets?.sd?.href || "";
    const tiles = matrix && /\/sd\.jpg$/.test(sd)
      ? { base: sd.replace(/sd\.jpg$/, "tiles/"), cols: matrix.matrixWidth, rows: matrix.matrixHeight, size: matrix.tileWidth }
      : { image: sd || feature.assets?.hd?.href, cols: 1, rows: 1, size: 2048 };
    return { id: feature.id, coords: point.coords, alt: point.alt, heading: point.heading, tiles,
      date: (feature.properties?.datetime || "").slice(0, 10), collection: feature.collection,
      thumb: feature.assets?.thumb?.href || sd };
  }

  const toRad = Math.PI / 180;

  /** Exposition d'une photo : moyenne des logarithmes de R, V, B sur sa vignette, de 45° au-dessus de l'horizon à 20°
   * dessous (ni le haut du ciel, ni le toit du véhicule, sous ROOF), sur tout le tour d'horizon : deux photos voisines
   * voient à peu près le même entourage, alors que le décor du seul regard change (essai du 31/10 au carrefour RD18 /
   * D115D : arbre à l'ombre d'un côté, vignes au soleil de l'autre, rapport 2 au lieu de 1,5 ; tour complet : 1,51,
   * contre 1,58 mesuré au même endroit dans le même sens). */
  async function exposureOf(photo, signal) {
    const bitmap = await createImageBitmap(await (await fetch(photo.thumb, { signal })).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const { width: w, height: h } = canvas;
    const top = Math.round(h / 4), bottom = Math.round(h * (90 + 20) / 180);
    const px = ctx.getImageData(0, top, w, bottom - top).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) {
      for (let c = 0; c < 3; c++) sum[c] += Math.log(Math.max(px[i + c], 1) / 255);
    }
    return sum.map((v) => v / Math.max(1, px.length / 4));
  }

  /**
   * Exposition de chaque photo (gain R, V, B, multiplié dans le rendu) : seulement aux changements de séquence, où une
   * autre campagne peut être bien plus claire ou plus sombre (juillet 2025 : 58 % plus clair que mai au même endroit).
   * La nouvelle séquence est ramenée sur la précédente (EXPO_SIDE photos de part et d'autre, médiane), puis revient
   * peu à peu à sa propre exposition sur EXPO_RAMP m. Une séquence seule n'est pas touchée : d'une photo à la suivante,
   * son exposition ne varie que d'environ 1 % ; ce qui varie (haie, bois) est le décor, à ne pas éclaircir.
   */
  async function exposures(path, signal) {
    const { list, s } = path;
    const gains = list.map(() => [1, 1, 1]);
    const median = (values) => [0, 1, 2].map((c) => values.map((v) => v[c]).sort((a, b) => a - b)[values.length >> 1]);
    let carried = [0, 0, 0];  // correction (log) de la séquence précédente à sa dernière photo
    for (let k = 1; k < list.length; k++) {
      if (list[k].collection === list[k - 1].collection) {
        continue;
      }
      const before = [], after = [];
      for (let i = k - 1; i >= Math.max(0, k - EXPO_SIDE) && list[i].collection === list[k - 1].collection; i--) before.push(i);
      for (let i = k; i < Math.min(list.length, k + EXPO_SIDE) && list[i].collection === list[k].collection; i++) after.push(i);
      let shift = [0, 0, 0];
      try {
        const measure = (ids) => Promise.all(ids.map((i) => exposureOf(list[i], signal)));
        const [a, b] = await Promise.all([measure(before), measure(after)]);
        const [ma, mb] = [median(a), median(b)];
        shift = [0, 1, 2].map((c) => ma[c] + carried[c] - mb[c]);
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn("Vidéo : exposition non mesurée au changement de séquence", error);
      }
      // Rampe jusqu'au prochain changement de séquence (ou la fin)
      let i = k;
      for (; i < list.length && (i === k || list[i].collection === list[i - 1].collection); i++) {
        const fade = 1 - Math.min(1, (s[i] - s[k]) / EXPO_RAMP);
        const ease = fade * fade * (3 - 2 * fade);
        gains[i] = shift.map((v) => Math.min(EXPO_MAX, Math.max(1 / EXPO_MAX, Math.exp(v * ease))));
      }
      carried = gains[i - 1].map(Math.log);
      k = i - 1;
    }
    return gains;
  }
  const metres = (a, b) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * toRad), (b[1] - a[1]) * 111320);
  const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * toRad), b[1] - a[1]) / toRad + 360) % 360;
  const wrap = (deg) => ((deg % 360) + 540) % 360 - 180;
  const smooth = (x) => x * x * (3 - 2 * x);

  /** Trajectoire : abscisses curvilignes des photos (doublons de position écartés), position et altitude à
   * l'abscisse s, cap lissé, pente de chaque photo. */
  function trajectory(photos) {
    const list = photos.filter((p, i) => p.coords && (i === 0 || metres(photos[i - 1].coords || p.coords, p.coords) > 0.5));
    const s = [0];
    for (let i = 1; i < list.length; i++) s.push(s[i - 1] + metres(list[i - 1].coords, list[i].coords));
    const length = s[s.length - 1];
    const segment = (x) => {
      let i = 0;
      while (i < s.length - 2 && s[i + 1] < x) i++;
      return [i, s[i + 1] > s[i] ? Math.min(1, Math.max(0, (x - s[i]) / (s[i + 1] - s[i]))) : 0];
    };
    const at = (x) => {
      const [i, u] = segment(Math.min(length, Math.max(0, x)));
      const a = list[i].coords, b = list[Math.min(i + 1, list.length - 1)].coords;
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    };
    // Altitudes manquantes : interpolées entre les connues (sinon pente nulle)
    const known = list.map((p, i) => [s[i], p.alt]).filter(([, z]) => Number.isFinite(z));
    const altAt = (x) => {
      if (known.length < 2) return 0;
      let j = 0;
      while (j < known.length - 2 && known[j + 1][0] < x) j++;
      const [s0, z0] = known[j], [s1, z1] = known[j + 1];
      return s1 > s0 ? z0 + (z1 - z0) * (x - s0) / (s1 - s0) : z0;
    };
    const course = (x) => bearing(at(x - SMOOTH), at(x + SMOOTH));
    for (let i = 0; i < list.length; i++) {
      const x0 = Math.max(0, s[i] - SLOPE), x1 = Math.min(length, s[i] + SLOPE);
      list[i].pitch = x1 - x0 > 1 ? -Math.atan((altAt(x1) - altAt(x0)) / (x1 - x0)) : 0;
    }
    return { list, s, length, segment, course };
  }

  /** Tuiles de la photo qui couvrent le champ autour du cap relatif yaw (degrés), pour une vue au plus large de
   * hfov × vfov : { c0, nc, r0, nr } (colonnes à partir de c0, modulo la grille ; lignes à partir de r0). */
  function cropOf(tiles, yaw, pitch, hfov, vfov) {
    const cw = 360 / tiles.cols, rh = 180 / tiles.rows;
    if (tiles.cols === 1) return { c0: 0, nc: 1, r0: 0, nr: 1 };
    const half = hfov / 2 + MARGIN, top = vfov / 2 + Math.abs(pitch / toRad) + MARGIN / 2;
    const c0 = Math.floor((yaw - half + 180) / cw), c1 = Math.floor((yaw + half + 180) / cw);
    const r0 = Math.max(0, Math.floor((90 - top) / rh)), r1 = Math.min(tiles.rows - 1, Math.floor((90 + top) / rh));
    return { c0: ((c0 % tiles.cols) + tiles.cols) % tiles.cols, nc: Math.min(tiles.cols, c1 - c0 + 1), r0, nr: r1 - r0 + 1 };
  }

  /** Image (OffscreenCanvas) des tuiles crop de la photo, réduite du facteur scale ; tuile perdue : transparente. */
  async function loadCrop(photo, crop, scale, signal) {
    const t = photo.tiles;
    const size = Math.round(t.size * scale);
    if (t.image) {
      const bitmap = await createImageBitmap(await (await fetch(t.image, { signal })).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      return canvas;
    }
    const canvas = new OffscreenCanvas(crop.nc * size, crop.nr * size);
    const ctx = canvas.getContext("2d");
    const jobs = [];
    for (let i = 0; i < crop.nc; i++) {
      for (let j = 0; j < crop.nr; j++) {
        const url = `${t.base}${(crop.c0 + i) % t.cols}_${crop.r0 + j}.jpg`;
        jobs.push((async () => {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const response = await fetch(url, { signal });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const bitmap = await createImageBitmap(await response.blob());
              ctx.drawImage(bitmap, i * size, j * size, size, size);
              bitmap.close();
              return;
            } catch (error) {
              if (signal?.aborted) throw error;
              if (attempt) console.warn("Vidéo : tuile perdue", url, error);
            }
          }
        })());
      }
    }
    await Promise.all(jobs);
    return canvas;
  }

  const VERTEX = `#version 300 es
    in vec2 p; out vec2 ndc;
    void main() { ndc = p; gl_Position = vec4(p, 0.0, 1.0); }`;
  // Pour chaque photo : rayon de la vue (cap yaw, tangage pitch relatifs à l'avant de la photo, tan du demi-champ
  // horizontal) vers longitude et latitude du panorama (avant = milieu de l'image), puis case de la découpe
  const FRAGMENT = `#version 300 es
    precision highp float;
    in vec2 ndc; out vec4 color;
    uniform sampler2D tex0, tex1;
    uniform vec4 crop0, crop1;  // colonne et nombre de colonnes, ligne et nombre de lignes de la découpe
    uniform vec2 grid0, grid1;  // colonnes et lignes de la grille entière
    uniform vec4 cam0, cam1;  // cap, tangage (radians), tan du demi-champ horizontal, avancée (m) depuis la photo
    uniform float aspect, blend, height, bowl, road, roof;
    uniform vec3 gain0, gain1;  // exposition de chaque photo (changement de séquence)
    vec4 pick(sampler2D t, vec4 crop, vec2 grid, vec4 cam) {
      // Rayon de la caméra virtuelle, avancée de cam.w m dans l'axe de la vue (horizontal) : point touché sur la
      // maquette (sol, sinon sphère), puis direction de ce point vue de la caméra de la photo
      vec3 r = normalize(vec3(ndc.x * cam.z, ndc.y * cam.z / aspect, 1.0));
      vec3 o = vec3(0.0, 0.0, cam.w);
      float b = dot(o, r);
      float k = -b + sqrt(b * b - dot(o, o) + bowl * bowl);
      // Chaussée derrière la caméra de la photo (vue depuis l'arrière) : pas dans sa vue utile, l'autre photo la
      // donne ; entre 1 et 4 m devant elle, en dégradé (pas de bord net)
      float g = height / -r.y, keep = 1.0;
      if (r.y < 0.0 && abs(g * r.x) < road && g < k) {
        keep = smoothstep(1.0, 4.0, o.z + g * r.z);
        if (keep == 0.0) return vec4(0.0);
        k = g;
      }
      vec3 d = normalize(o + k * r);
      float cp = cos(cam.y), sp = sin(cam.y), cy = cos(cam.x), sy = sin(cam.x);
      d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
      d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
      float lon = degrees(atan(d.x, d.z)), lat = degrees(asin(clamp(d.y, -1.0, 1.0)));
      float u = mod((lon + 180.0) / (360.0 / grid.x) - crop.x, grid.x) / crop.y;
      float v = ((90.0 - lat) / (180.0 / grid.y) - crop.z) / crop.w;
      if (u > 1.0 || v < 0.0 || v > 1.0 || lat < roof) return vec4(0.0);
      vec4 c = texture(t, vec2(u, v));
      return vec4(c.rgb, c.a * keep);
    }
    void main() {
      vec4 a = pick(tex0, crop0, grid0, cam0), b = pick(tex1, crop1, grid1, cam1);
      a.rgb = min(a.rgb * gain0, 1.0);
      b.rgb = min(b.rgb * gain1, 1.0);
      float w = mix(b.a, blend * b.a, a.a);  // photo quittée absente : la suivante seule
      color = vec4(mix(a.rgb, b.rgb, w), 1.0);
    }`;

  function renderer(width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("WebGL2 indisponible");
    const shader = (type, text) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, width, height);
    const u = (name) => gl.getUniformLocation(program, name);
    gl.uniform1i(u("tex0"), 0);
    gl.uniform1i(u("tex1"), 1);
    gl.uniform1f(u("aspect"), width / height);
    gl.uniform1f(u("height"), CAM_HEIGHT);
    gl.uniform1f(u("bowl"), BOWL);
    gl.uniform1f(u("road"), ROAD);
    gl.uniform1f(u("roof"), ROOF);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    return {
      canvas, max,
      texture(image) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
      },
      drop: (tex) => gl.deleteTexture(tex),
      /** Vue : views = [{ tex, crop, grid, yaw, pitch, tan, move, gain }] (photo quittée, photo suivante), blend : part de la
       * suivante ; weight < 1 : vue mêlée à l'image déjà dessinée dans cette proportion (moyenne du flou cinétique). */
      draw(views, blend, weight = 1) {
        if (weight < 1) {
          gl.enable(gl.BLEND);
          gl.blendColor(0, 0, 0, weight);
          gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
        } else {
          gl.disable(gl.BLEND);
        }
        views.forEach((v, k) => {
          gl.activeTexture(gl.TEXTURE0 + k);
          gl.bindTexture(gl.TEXTURE_2D, v.tex);
          gl.uniform4f(u(`crop${k}`), v.crop.c0, v.crop.nc, v.crop.r0, v.crop.nr);
          gl.uniform2f(u(`grid${k}`), v.grid[0], v.grid[1]);
          gl.uniform4f(u(`cam${k}`), v.yaw, v.pitch, v.tan, v.move);
          gl.uniform3f(u(`gain${k}`), ...(v.gain || [1, 1, 1]));
        });
        gl.uniform1f(u("blend"), blend);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
    };
  }

  function loadMuxer() {
    if (window.Mp4Muxer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = Object.assign(document.createElement("script"), { src: MUXER, onload: resolve,
        onerror: () => reject(new Error("bibliothèque mp4-muxer introuvable (réseau ?)")) });
      document.head.append(script);
    });
  }

  /** Une image encodée par cette configuration ? isConfigSupported ne suffit pas : Firefox sous Linux annonce le
   * H.264 puis refuse la première image. */
  async function encodes(config) {
    let chunks = 0;
    const encoder = new VideoEncoder({ output: () => chunks++, error: () => {} });
    try {
      encoder.configure(config);
      const canvas = new OffscreenCanvas(config.width, config.height);
      canvas.getContext("2d").fillRect(0, 0, 1, 1);
      const frame = new VideoFrame(canvas, { timestamp: 0 });
      encoder.encode(frame, { keyFrame: true });
      frame.close();
      await encoder.flush();
    } catch { /* refusée */ }
    if (encoder.state !== "closed") encoder.close();
    return chunks > 0;
  }

  /** Première configuration qui encode vraiment : { config, codec (pour mp4-muxer) } ; null sans aucune. */
  async function encoderConfig() {
    for (const [width, height, share] of SIZES) {
      for (const [name, codec, rate] of CODECS) {
        const config = { codec: name, width, height, bitrate: rate * share, framerate: FPS, ...(codec === "avc" ? { avc: { format: "avc" } } : {}) };
        try {
          if ((await VideoEncoder.isConfigSupported(config)).supported && await encodes(config)) return { config, codec };
        } catch { /* configuration refusée : la suivante */ }
      }
    }
    return null;
  }

  /**
   * Vidéo MP4 (Blob) des photos du parcours [record], à la vitesse simulée kmh, exposition accordée aux changements de
   * séquence (exposures). options.blur : flou cinétique (moyenne de BLUR vues réparties entre la position de l'image
   * précédente et celle-ci : le proche défilant vite s'étale) ; options.exposure : false pour ne pas accorder
   * l'exposition (essais). progress(fait, total) à chaque image ; signal : AbortSignal pour arrêter.
   */
  async function mp4(photos, kmh, progress = () => {}, signal = null, { blur = false, exposure = true } = {}) {
    const path = trajectory(photos);
    if (path.list.length < 2 || path.length < 1) throw new Error("parcours trop court");
    const [chosen] = await Promise.all([encoderConfig(), loadMuxer()]);
    if (!chosen) throw new Error("ce navigateur n'encode ni le H.264 ni le VP9");
    const { config, codec } = chosen;
    const { width, height } = config;
    const gl = renderer(width, height);
    const tan = Math.tan(HFOV / 2 * toRad);
    const vfov = 2 * Math.atan(tan * height / width) / toRad;
    // Champ le plus large demandé à une photo (vue depuis l'avant, au début du fondu : le décor proche s'écarte),
    // découpe et réduction des tuiles à la finesse de la vue (plus un quart pour l'avancée)
    const widest = (fov) => 2 * Math.atan(Math.tan(fov / 2 * toRad) * 1.6) / toRad;
    const scaleOf = (t) => Math.min(1, 1.25 * (width / HFOV) / (t.size / (360 / t.cols)));
    const yawAt = (i, x) => wrap(path.course(x) - path.list[i].heading);
    const gains = exposure ? await exposures(path, signal) : path.list.map(() => [1, 1, 1]);
    const loads = new Map();  // rang de la photo -> Promise de { tex, crop, grid }
    const load = (i) => {
      if (!loads.has(i)) {
        const photo = path.list[i];
        const crop = cropOf(photo.tiles, yawAt(i, path.s[i]), photo.pitch, widest(HFOV), widest(vfov));
        loads.set(i, loadCrop(photo, crop, scaleOf(photo.tiles), signal).then((image) => {
          if (image.width > gl.max || image.height > gl.max) throw new Error(`image trop grande (${image.width} px)`);
          return { tex: gl.texture(image), crop, grid: [photo.tiles.cols, photo.tiles.rows] };
        }));
      }
      return loads.get(i);
    };
    const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), fastStart: "in-memory",
      video: { codec, width, height, frameRate: FPS } });
    let failure = null;
    const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
    encoder.configure(config);
    const v = kmh / 3.6;
    const total = Math.ceil(path.length / v * FPS) + 2 * HOLD * FPS;
    try {
      for (let n = 0; n < total; n++) {
        if (signal?.aborted) throw new DOMException("Vidéo arrêtée", "AbortError");
        if (failure) throw failure;
        const at = (m) => Math.min(path.length, Math.max(0, (m - HOLD * FPS) * v / FPS));
        const x = at(n);
        // Flou cinétique : vues de la position de l'image précédente (exclue) à celle-ci, dans l'ordre du parcours
        const subs = blur && at(n - 1) < x ? BLUR : 1;
        const first = path.segment(x - (x - at(n - 1)) * (subs - 1) / subs)[0];
        for (let k = first; k < Math.min(path.list.length, path.segment(x)[0] + AHEAD); k++) load(k).catch(() => {});
        for (const [k, job] of loads) {  // photos passées : textures rendues
          if (k < first) {
            loads.delete(k);
            job.then((view) => gl.drop(view.tex)).catch(() => {});
          }
        }
        for (let k = 0; k < subs; k++) {
          const xs = x - (x - at(n - 1)) * (subs - 1 - k) / subs;
          const [i, u] = path.segment(xs);
          const j = Math.min(i + 1, path.list.length - 1);
          const [a, b] = await Promise.all([load(i), load(j)]);
          // Avancée : u·écart après la photo quittée, (1 - u)·écart avant la suivante ; vue k : 1 / (k + 1) de la
          // moyenne courante
          const gap = Math.min(path.s[j] - path.s[i], GAP);
          gl.draw([
            { ...a, yaw: yawAt(i, xs) * toRad, pitch: path.list[i].pitch, tan, move: u * gap, gain: gains[i] },
            { ...b, yaw: yawAt(j, xs) * toRad, pitch: path.list[j].pitch, tan, move: -(1 - u) * gap, gain: gains[j] },
          ], j === i ? 0 : smooth(Math.min(1, Math.max(0, (u - 0.25) / 0.5))), 1 / (k + 1));
        }
        const frame = new VideoFrame(gl.canvas, { timestamp: Math.round(n * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
        encoder.encode(frame, { keyFrame: n % (2 * FPS) === 0 });
        frame.close();
        while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 5));
        progress(n + 1, total);
      }
      await encoder.flush();
      if (failure) throw failure;
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: "video/mp4" });
    } finally {
      if (encoder.state !== "closed") encoder.close();
      for (const job of loads.values()) job.then((view) => gl.drop(view.tex)).catch(() => {});
    }
  }

  return { supported, record, mp4, trajectory, exposures, FPS, HOLD };
})();
