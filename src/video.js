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
// l'autre photo le remplace. Sans avancée simulée (option) : chaque photo vue de sa caméra, simple fondu enchaîné.
// Encodage H.264 par le navigateur (WebCodecs ; VP9 s'il n'encode pas le H.264, Firefox
// sous Linux), fichier assemblé par mp4-muxer, chargé au premier export seulement.

const Video = (() => {
  const FPS = 30;
  const SIZES = [[1920, 1080, 1], [1280, 720, 0.5]];  // largeur, hauteur, part du débit du codec : la première encodable
  // Haute qualité (option, lente) : 1080p aussi (choix de l'utilisateur), débit HQ_CODECS (détails fins mieux rendus),
  // tuiles en pleine définition, vue calculée en HQ_SUPERSAMPLE fois la définition puis réduite (bords sans escalier)
  const HQ_SUPERSAMPLE = 2;
  // H.264 High, Main, Baseline (niveau 4.0), puis VP9 (Firefox sous Linux : H.264 annoncé mais pas encodé, bug
  // Mozilla 2085549), dans un MP4 aussi ; codec du fichier pour mp4-muxer ; débit en 1080p (bit/s). Mesuré le 31/10/2026
  // contre une version à 80 Mbit/s : H.264 10 Mbit/s très flou (PSNR 32 dB), 30 Mbit/s 37,6 dB ; VP9 20 Mbit/s 36,8 dB
  const CODECS = [["avc1.640028", "avc", 30e6], ["avc1.4d0028", "avc", 30e6], ["avc1.42e028", "avc", 30e6],
    ["vp09.00.40.08", "vp9", 20e6]];
  // Haute qualité : H.264 niveau 5.1 (débit admis bien au-delà), 80 Mbit/s ; VP9 50 Mbit/s
  const HQ_CODECS = [["avc1.640033", "avc", 80e6], ["avc1.4d0033", "avc", 80e6], ["vp09.00.40.08", "vp9", 50e6]];
  const MUXER = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/build/mp4-muxer.min.js";
  const HFOV = 80;  // degrés : champ horizontal de la vue (vertical : ± 24° en 16/9, au-dessus du toit du véhicule)
  const SMOOTH = 15;  // m : cap de la vue = direction de la trajectoire de s - SMOOTH à s + SMOOTH (stabilisation)
  const SEAM = 40;  // m : autour du raccord de deux séquences, cap lissé sur ± SEAM m (décalage des trajectoires)
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
  const EXPO_NEAR = 0.6;  // s : photo comparée à la médiane des photos prises à ± EXPO_NEAR s (3 au moins)
  const EXPO_JUMP = 0.2;  // écart (logarithme, × 1,22) au-delà duquel la photo est ramenée sur cette médiane
  const EXPO_PARALLEL = 6;  // vignettes mesurées à la fois
  const EXPO_STORE = "web-measures/expositions";  // mesures gardées dans le navigateur (localStorage)
  const EXPO_KEPT = 20000;  // mesures gardées au plus (les plus anciennes oubliées)
  const RAMP_MIN = 0.35;  // rampe de vitesse : part de la vitesse choisie au plus bas (virage serré, départ, arrivée)
  const RAMP_TURN = 1.5;  // °/m : courbe (cap lissé) qui réduirait la vitesse de moitié sans RAMP_MARKED
  const RAMP_MARKED = 1;  // °/m : au-delà (virage marqué, rayon de moins de 57 m), sensibilité doublée
  const RAMP_EDGE = 50;  // m : départ et arrivée en douceur sur cette distance
  const RAMP_SMOOTH = 15;  // m : vitesse lissée sur ± RAMP_SMOOTH m (pas d'à-coup)
  const TITLE_FADE = [2, 3];  // s : titre plein jusqu'à 2 s, effacé à 3 s
  const LOOK_LEAD = 0.9;  // s : regard déjà dans l'axe de la voie croisée avant le passage au carrefour (anticipation)
  const LOOK_TURN = 0.8;  // s : rotation vers la voie croisée ; retour dans l'axe du parcours en LOOK_TURN / 2
  const LOOK_BRAKE = 1.5;  // s : freinage avant le regard d'un carrefour, et reprise après
  const LOOK_SPEED = 70;  // km/h : vitesse de regard par défaut (réglette de 30 à 130)
  const POI_SPAN = 150;  // m : bornes de l'effet du point d'intérêt non posées : avant et après le passage au plus près
  const POI_IN = 1;  // s : vue tournée vers la cible après la borne de début ; retour dans l'axe en POI_IN / 2 après la fin
  const LOOK_MAX = 120;  // degrés : regard dans l'axe d'une voie croisée au plus (voie qui repart vers l'arrière)
  const LOOK_GAP = 60;  // m : carrefours plus proches du précédent regardé (giratoire, double carrefour) : un seul regard
  const ROLL_TIME = 3;  // s : tour complet du tonneau par défaut (réglette de 1 à 10 s ; pas trop rapide : demande)
  const ROLL_REACH = 30;  // m : endroit du tonneau ramené sur le parcours à cette distance au plus
  const PLANET_FADE = 1;  // s : enroulement et déroulement de la petite planète par défaut (réglette 0 à 3 s ; 0 : planète d'emblée)
  const PLANET_MIN = 50;  // m : petite planète au moins (tracé trop court ou endroit seul d'un parcours gardé avant le 01/11)
  const PLANET_FOV = 300;  // degrés : champ horizontal de la planète (projection stéréographique, regard vers le sol)
  const PLANET_SPIN = 20;  // °/s : rotation de la planète sur elle-même par défaut (réglette de 0, sans, à 90)
  const PLANET_SCALE = 1 / 3;  // tuiles réduites au plus (tout le tour de la photo, dans un champ très large)
  const SPEED_SMOOTH = 4;  // images : vitesse affichée lissée sur ± SPEED_SMOOTH images (un quart de seconde)
  const TOUR_TIME = 8;  // s : tour d'horizon par défaut (réglette de 2 à 20 s)
  const BLUR = 8;  // vues moyennées par image pour le flou cinétique (obturateur ouvert toute l'image : 360°)
  const STALL = 15;  // s : requête d'image sans réponse abandonnée, puis reprise (serveur d'images bloqué)

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
      date: (feature.properties?.datetime || "").slice(0, 10), time: Date.parse(feature.properties?.datetime) || null,
      collection: feature.collection, thumb: feature.assets?.thumb?.href || sd };
  }

  const toRad = Math.PI / 180;

  /** Image (ImageBitmap) de l'adresse url : requête reprise tant que le serveur ne répond pas (STALL s sans réponse,
   * erreur réseau, HTTP 429 ou 5xx), pause croissante jusqu'à 5 s, jusqu'à l'arrêt par signal (l'application avertit au
   * bout de 30 s sans image calculée et arrête au bout de 5 min) ; autre erreur HTTP : abandon au 2e essai. */
  async function fetchImage(url, signal) {
    for (let attempt = 1; ; attempt++) {
      let response = null, blob = null;
      try {
        response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(STALL * 1000), ...(signal ? [signal] : [])]) });
        if (response.ok) blob = await response.blob();
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      if (blob) return createImageBitmap(blob);
      if (response && !response.ok && response.status < 500 && response.status !== 429 && attempt >= 2) {
        throw new Error(`serveur d'images, ${url.split("/").slice(2, 3)} : HTTP ${response.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 * 2 ** attempt)));
      if (signal?.aborted) throw new DOMException("Vidéo arrêtée", "AbortError");
    }
  }

  /**
   * Position (m le long du parcours path) de chaque image : HOLD s d'arrêt au début et à la fin, et entre les deux la
   * vitesse v (m/s), constante, ou avec ramp (rampe de vitesse) réduite dans les virages (facteur 1 / (1 + rotation du
   * cap lissé / RAMP_TURN), la rotation au-delà de RAMP_MARKED °/m comptant double ; au plus bas RAMP_MIN·v) et en douceur sur RAMP_EDGE m au départ et à l'arrivée,
   * lissée sur ± RAMP_SMOOTH m : v devient la vitesse des lignes droites.
   */
  function timeline(path, v, ramp, looks = [], lookSpeed = null, poiSlow = null) {
    const xs = Array(HOLD * FPS + 1).fill(0);
    let factor = () => 1;
    if (ramp || (looks.length && lookSpeed) || poiSlow) {
      factor = curve(path, v, ramp, looks, lookSpeed, poiSlow);
    }
    for (let x = 0; x < path.length;) xs.push(x = Math.min(path.length, x + v * factor(x) / FPS));
    for (let k = 0; k < HOLD * FPS; k++) xs.push(path.length);
    return xs;
  }

  /**
   * Facteur de vitesse le long du parcours (fonction de x, en m) : rampe (ramp, voir timeline) et ralentissement aux
   * carrefours regardés (looks, lookedJunctions) : vitesse ramenée à v / (1 + (v / lookSpeed)³)^(1/3) (presque rien
   * sous lookSpeed, lookSpeed au plus au-dessus : 70 km/h → 45 à 50 km/h, 62 à 90, 70 à 360) pendant tout le regard
   * (rotation, regard dans l'axe, retour), freinage et reprise en douceur sur LOOK_BRAKE s ; de même entre les bornes du
   * point d'intérêt (poiSlow : { x0, x1, speed } en m et m/s) ; le plus fort des ralentissements.
   */
  function curve(path, v, ramp, looks, lookSpeed, poiSlow = null) {
    const n = Math.ceil(path.length) + 2;
    let base = Array(n).fill(1);
    if (ramp) {
      const raw = [];  // facteur de vitesse par mètre
      for (let x = 0; x <= path.length + 1; x++) {
        const a = path.course(x - 5), b = path.course(x + 5);
        const turn = Math.abs(((b - a) % 360 + 540) % 360 - 180) / 10;  // °/m
        const edge = Math.min(1, Math.min(x, path.length - x) / RAMP_EDGE);
        const slow = (Math.min(turn, RAMP_MARKED) + 2 * Math.max(0, turn - RAMP_MARKED)) / RAMP_TURN;
        raw.push(Math.max(RAMP_MIN, Math.min(1 / (1 + slow), RAMP_MIN + (1 - RAMP_MIN) * edge)));
      }
      base = raw.map((_, i) => {
        const part = raw.slice(Math.max(0, i - RAMP_SMOOTH), i + RAMP_SMOOTH + 1);
        return part.reduce((sum, f) => sum + f, 0) / part.length;
      });
    }
    if (looks.length && lookSpeed) {
      const k = 1 / Math.cbrt(1 + (v / lookSpeed) ** 3), slow = v * k;
      const brake = LOOK_BRAKE * (v + slow) / 2;  // m parcourus pendant le freinage (vitesse moyenne)
      const ease = (p) => p * p * (3 - 2 * p);
      for (const { x: at, left, right } of looks) {
        const before = (LOOK_LEAD + LOOK_TURN) * slow;
        const after = ((left != null && right != null ? 0.7 : 0.3) + LOOK_TURN / 2) * slow;
        for (let x = Math.max(0, Math.floor(at - before - brake)); x < Math.min(n, at + after + brake); x++) {
          const d = x - at;
          const f = d < -before ? k + (1 - k) * ease((-before - d) / brake)
            : d > after ? k + (1 - k) * ease((d - after) / brake) : k;
          base[x] = Math.min(base[x], f);
        }
      }
    }
    if (poiSlow) {
      const k = 1 / Math.cbrt(1 + (v / poiSlow.speed) ** 3), slow = v * k;
      const brake = LOOK_BRAKE * (v + slow) / 2;
      for (let x = Math.max(0, Math.floor(poiSlow.x0 - brake)); x < Math.min(n, poiSlow.x1 + brake); x++) {
        const f = x < poiSlow.x0 ? k + (1 - k) * smooth((poiSlow.x0 - x) / brake)
          : x > poiSlow.x1 ? k + (1 - k) * smooth((x - poiSlow.x1) / brake) : k;
        base[x] = Math.min(base[x], f);
      }
    }
    return (x) => base[Math.min(base.length - 1, Math.max(0, Math.round(x)))];
  }

  /**
   * Compteur PR à la position x (m) du parcours path : { route, n, m } (m : mètres depuis le PR n), interpolé entre les
   * photos qui l'encadrent pour défiler en continu ; PR franchi entre deux photos : l'ancien jusqu'à son bout, puis le
   * nouveau (depuis 0 en montant, depuis sa longueur en descendant) ; autre route ou PR inconnu : à mi-chemin. null
   * sans PR.
   */
  function prAt(path, x) {
    const [i, u] = path.segment(x);
    const j = Math.min(i + 1, path.list.length - 1);
    const a = path.list[i].pr, b = path.list[j].pr;
    if (!a || !b || a.route !== b.route) return u < 0.5 ? a : b;
    if (a.n === b.n) return { ...a, m: a.m + (b.m - a.m) * u };
    const gap = path.s[j] - path.s[i], up = b.n > a.n;
    const fromA = a.m + (up ? 1 : -1) * u * gap, fromB = b.m - (up ? 1 : -1) * (1 - u) * gap;
    if (up) return fromB >= 0 ? { ...b, m: fromB } : { ...a, m: fromA };
    return fromA >= 0 ? { ...a, m: fromA } : { ...b, m: fromB };
  }

  /** Mètres du compteur en rouleaux (compteur kilométrique) : chaque chiffre glisse vers le suivant quand les chiffres
   * de droite passent de 9… à 0… ; continu dans les deux sens. ctx : contexte 2D, x, y : coin bas gauche, size : corps ;
   * digits : nombre de chiffres ; blank : zéros de tête masqués (le chiffre qui arrive glisse quand même). */
  function drawRollers(ctx, value, x, y, size, digits = 4, blank = false) {
    const v = Math.abs(value), cell = ctx.measureText("0").width, line = size * 1.15;
    for (let k = digits - 1; k >= 0; k--) {
      const unit = 10 ** k, base = Math.floor(v / unit) % 10;
      const roll = k === 0 ? v % 1 : Math.max(0, (v % unit) - (unit - 1));
      const left = x + (digits - 1 - k) * cell;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, y - size, cell, line);
      ctx.clip();
      if (!(blank && k && v < unit)) ctx.fillText(String(base), left, y - roll * line);
      ctx.fillText(String((base + 1) % 10), left, y + (1 - roll) * line);
      ctx.restore();
    }
    return digits * cell;
  }

  /** Titre (fondu à TITLE_FADE s), compteur PR (en bas à gauche), compteur de vitesse (speed : { kmh, digits }, en bas à
   * droite) et accélération latérale ressentie (lateral : { felt, color } : millièmes de g et couleur de lateralColor ; à
   * gauche du compteur de vitesse, sinon à sa place) et vitesse max ARP (arp : { kmh }, kmh null : « — » ; au-dessus du
   * compteur de vitesse) sur l'image (contexte 2D ctx, w × h) ; t : secondes depuis le début. */
  function drawOverlay(ctx, w, h, { title, pr, speed, lateral = null, arp = null, t }) {
    const font = (size, weight = 500) => `${weight} ${Math.round(size)}px Roboto, "Segoe UI", sans-serif`;
    // Cadre aux coins arrondis (rayon : un centième de la hauteur de l'image)
    const box = (x, y, bw, bh) => {
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, h * 0.01);
      ctx.fill();
    };
    ctx.textBaseline = "alphabetic";
    const alpha = title ? Math.max(0, Math.min(1, (TITLE_FADE[1] - t) / (TITLE_FADE[1] - TITLE_FADE[0]))) : 0;
    if (alpha > 0) {
      const big = h * 0.055, small = h * 0.032;
      ctx.font = font(big);
      const width = Math.max(ctx.measureText(title.text).width, (ctx.font = font(small, 400), ctx.measureText(title.sub || "").width));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      box((w - width) / 2 - big * 0.6, h * 0.06, width + big * 1.2, big * 1.5 + (title.sub ? small * 1.5 : 0));
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = font(big);
      ctx.fillText(title.text, w / 2, h * 0.06 + big * 1.15);
      if (title.sub) {
        ctx.font = font(small, 400);
        ctx.fillText(title.sub, w / 2, h * 0.06 + big * 1.15 + small * 1.4);
      }
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
    }
    if (pr) {
      const size = h * 0.045, pad = size * 0.45, x0 = h * 0.04, y0 = h - h * 0.05;
      ctx.font = font(size);
      const head = `PR ${pr.n} ${pr.m < 0 ? "−" : "+"} `;
      const width = ctx.measureText(head).width + 4 * ctx.measureText("0").width;
      ctx.font = font(size * 0.6, 700);
      const roadWidth = ctx.measureText(pr.route).width;
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      box(x0 - pad, y0 - size - size * 0.75 - pad, Math.max(width, roadWidth) + 2 * pad, size * 1.75 + 2 * pad);
      ctx.fillStyle = "#ffb300";
      ctx.fillText(pr.route, x0, y0 - size - size * 0.12);
      ctx.fillStyle = "#fff";
      ctx.font = font(size);
      ctx.fillText(head, x0, y0);
      drawRollers(ctx, pr.m, x0 + ctx.measureText(head).width, y0, size);
    }
    const size = h * 0.045, pad = size * 0.45, y0 = h - h * 0.05;
    let right = w - h * 0.04;  // bord droit du prochain cadre, de droite à gauche
    // Compteur de vitesse et « V max ARP » au-dessus : même largeur (la plus grande des deux), colonne alignée
    const unit = " km/h", arpLabel = "V max ARP";
    ctx.font = font(size);
    const digitsWidth = speed ? speed.digits * ctx.measureText("0").width : 0, arpValueWidth = ctx.measureText("000").width;
    ctx.font = font(size * 0.6);
    const unitWidth = ctx.measureText(unit).width;
    ctx.font = font(size * 0.6, 700);
    const column = Math.max(speed ? digitsWidth + unitWidth : 0,
      arp ? Math.max(ctx.measureText(arpLabel).width, arpValueWidth + unitWidth) : 0);
    if (speed) {
      // Même cadre que le compteur PR, aligné à droite : libellé, chiffres en rouleaux (zéros de tête masqués), unité
      const x0 = right - column, xd = right - digitsWidth - unitWidth;
      right = x0 - 3 * pad;
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      box(x0 - pad, y0 - size - size * 0.75 - pad, column + 2 * pad, size * 1.75 + 2 * pad);
      ctx.fillStyle = "#ffb300";
      ctx.font = font(size * 0.6, 700);
      ctx.fillText("Vitesse", x0, y0 - size - size * 0.12);
      ctx.fillStyle = "#fff";
      ctx.font = font(size * 0.6);
      ctx.fillText(unit, xd + digitsWidth, y0);
      ctx.font = font(size);
      drawRollers(ctx, speed.kmh, xd, y0, size, speed.digits, true);
    }
    if (lateral) {
      // Accélération latérale ressentie (moins le dévers ; en ligne droite, la pente en travers), en millièmes de g, chiffre
      // coloré selon les rayons de l'ARP
      const text = String(Math.round(lateral.felt)), label = "Accél. ressentie", unitA = " mG";
      ctx.font = font(size);
      const valueWidth = ctx.measureText("0000").width;
      ctx.font = font(size * 0.6, 700);
      const labelWidth = ctx.measureText(label).width;
      ctx.font = font(size * 0.6);
      const widthA = Math.max(labelWidth, valueWidth + ctx.measureText(unitA).width), xa = right - widthA;
      right = xa - 3 * pad;
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";  // plus transparent que les autres cadres (demande)
      box(xa - pad, y0 - size - size * 0.75 - pad, widthA + 2 * pad, size * 1.75 + 2 * pad);
      ctx.fillStyle = "#ffb300";
      ctx.font = font(size * 0.6, 700);
      ctx.fillText(label, xa, y0 - size - size * 0.12);
      ctx.fillStyle = "#fff";
      ctx.font = font(size * 0.6);
      ctx.fillText(unitA, xa + valueWidth, y0);
      ctx.font = font(size);
      ctx.fillStyle = lateral.color;
      ctx.textAlign = "right";
      ctx.fillText(text, xa + valueWidth, y0);
      ctx.textAlign = "left";
    }
    if (arp) {
      // Vitesse max ARP : même cadre, au-dessus du compteur de vitesse (à sa place), en km/h (« — » : pas de limite en
      // dessous de ARP_TOP)
      const text = arp.kmh == null ? "—" : String(arp.kmh);
      const xv = w - h * 0.04 - column, xn = w - h * 0.04 - unitWidth;  // cadre ; fin des chiffres, début de l'unité
      const yv = y0 - size * 1.75 - 3 * pad;  // un cadre plus haut, écart de pad
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      box(xv - pad, yv - size - size * 0.75 - pad, column + 2 * pad, size * 1.75 + 2 * pad);
      ctx.fillStyle = "#ffb300";
      ctx.font = font(size * 0.6, 700);
      ctx.fillText(arpLabel, xv, yv - size - size * 0.12);
      ctx.fillStyle = "#fff";
      ctx.font = font(size * 0.6);
      ctx.fillText(unit, xn, yv);
      ctx.font = font(size);
      ctx.textAlign = "right";
      ctx.fillText(text, xn, yv);
      ctx.textAlign = "left";
    }
  }

  /**
   * Décalage du regard (degrés, positif à droite) à chaque image de la chronologie xs : regard aux croisements (junctions, Lieu.junctions : au niveau du
   * carrefour, dans l'axe de la voie croisée, cap de la voie à 10 m du carrefour, LOOK_MAX° au plus ; voies des deux
   * côtés : gauche jusqu'au passage, puis droite 0,3 s après ; retour dans l'axe deux fois plus rapide que l'aller ; voie dans l'axe ou en arrière ignorée, carrefour à
   * moins de LOOK_GAP m du précédent ignoré).
   */
  function pans(path, xs, { junctions = [] } = {}) {
    const out = xs.map(() => 0);
    const frameAt = (x) => {
      const n = xs.findIndex((v) => v >= x);
      return n < 0 ? xs.length - 1 : n;
    };
    const ease = (p) => p * p * (3 - 2 * p);
    for (const { x, left, right } of lookedJunctions(path, junctions)) {
      const aim = (r) => Math.sign(r) * Math.min(LOOK_MAX, Math.abs(r));
      // Images clés (secondes depuis le passage au carrefour, degrés) : dans l'axe de la voie au niveau du carrefour ;
      // retour dans l'axe du parcours symétrique de l'aller (même courbe), deux fois plus rapide (LOOK_TURN / 2)
      const back = LOOK_TURN / 2;
      const keys = left != null && right != null
        ? [[-LOOK_LEAD - LOOK_TURN, 0], [-LOOK_LEAD, aim(left)], [0, aim(left)], [0.3, aim(right)], [0.7, aim(right)], [0.7 + back, 0]]
        : [[-LOOK_LEAD - LOOK_TURN, 0], [-LOOK_LEAD, aim(left ?? right)], [0.3, aim(left ?? right)], [0.3 + back, 0]];
      const at = frameAt(x);
      for (let n = Math.max(0, at + Math.ceil(keys[0][0] * FPS)); n <= Math.min(xs.length - 1, at + keys.at(-1)[0] * FPS); n++) {
        const t = (n - at) / FPS, k = keys.findIndex(([kt]) => kt > t);
        if (k <= 0) continue;
        const [[t0, v0], [t1, v1]] = [keys[k - 1], keys[k]];
        out[n] += v0 + (v1 - v0) * ease((t - t0) / (t1 - t0));
      }
    }
    return out;
  }

  /** Carrefours regardés le long du parcours path (pans, timeline) : [{ x, left, right }] (x : position sur le
   * parcours ; left, right : cap relatif de la voie croisée de chaque côté, la plus proche de la perpendiculaire, ou
   * undefined) ; carrefour à plus de 12 m du parcours, à ses 30 premiers ou 10 derniers mètres, sans voie de côté ou à
   * moins de LOOK_GAP m du précédent regardé : ignoré. */
  function lookedJunctions(path, junctions = []) {
    const found = [];
    for (const { lonlat, branches } of junctions) {
      let best = null;
      for (let x = 0; x <= path.length; x += 2) {
        const d = metres(path.at(x), lonlat);
        if (d < 12 && (!best || d < best.d)) best = { x, d };
      }
      if (best && best.x > 30 && best.x < path.length - 10) found.push({ x: best.x, branches });
    }
    found.sort((a, b) => a.x - b.x);
    const out = [];
    let last = -Infinity;
    for (const { x, branches } of found) {
      if (x - last < LOOK_GAP) continue;
      const rel = branches.map((b) => wrap(b - path.course(x)));
      // Voie de chaque côté la plus proche de la perpendiculaire (axe de la voie croisée)
      const side = (sign) => rel.filter((r) => sign * r > 30 && sign * r < 150)
        .sort((a, b) => Math.abs(Math.abs(a) - 90) - Math.abs(Math.abs(b) - 90))[0];
      const left = side(-1), right = side(1);
      if (left == null && right == null) continue;
      last = x;
      out.push({ x, left, right });
    }
    return out;
  }

  /**
   * Étendue de l'effet du point d'intérêt poi (options.poi de mp4) sur le parcours path : { x0, x1, xc, dmin } (bornes
   * de début et de fin, passage au plus près de la cible, distance à la cible alors) ; bornes posées ramenées sur le
   * parcours (extrémités de la zone tracée, ROLL_REACH m au plus, sinon erreur), sinon POI_SPAN m avant et après le
   * passage au plus près.
   */
  function poiSpan(path, poi) {
    const nearest = (lonlat) => {
      let best = null;
      for (let x = 0; x <= path.length; x++) {
        const d = metres(path.at(x), lonlat);
        if (!best || d < best.d) best = { x, d };
      }
      return best;
    };
    const c = nearest(poi.target);
    const bound = (lonlat, name, fallback) => {
      if (!lonlat) return fallback;
      const b = nearest(lonlat);
      if (b.d > ROLL_REACH) throw new Error(`${name} de la zone du point d'intérêt à ${Math.round(b.d)} m du parcours (${ROLL_REACH} m au plus)`);
      return b.x;
    };
    let x0 = bound(poi.start, "début", Math.max(0, c.x - POI_SPAN)), x1 = bound(poi.end, "fin", Math.min(path.length, c.x + POI_SPAN));
    if (x1 < x0) [x0, x1] = [x1, x0];
    return { x0, x1, xc: Math.min(x1, Math.max(x0, c.x)), dmin: Math.max(1, c.d) };
  }

  /**
   * Effet du point d'intérêt à chaque image de la chronologie xs : { yaw, lift, zoom, span } ; yaw : regard vers la
   * cible (cap depuis la caméra, LOOK_MAX° au plus), lift : visée en hauteur (degrés, altitude de l'objet relevé poi.z,
   * sinon du sol sous la cible, contre sol sous la caméra + CAM_HEIGHT ; inconnues : à l'horizontale ; ground : altitudes
   * du sol, par photo de path.list), zoom : jusqu'à poi.zoom, en bosse au passage au plus près ou, avec poi.zoomByDistance, en
   * proportion de la distance (cible de taille à peu près constante) ; le tout pesé de 0 à 1 en POI_IN s après la borne
   * de début, de 1 à 0 en POI_IN / 2 s après celle de fin.
   */
  function poiViews(path, xs, poi, ground) {
    const yaw = xs.map(() => 0), lift = xs.map(() => 0), zoom = xs.map(() => 1);
    if (!poi) return { yaw, lift, zoom, span: null };
    const span = poiSpan(path, poi);
    const frame = (x) => {
      const n = xs.findIndex((v) => v >= x);
      return n < 0 ? xs.length - 1 : n;
    };
    const n0 = frame(span.x0), n1 = frame(span.x1), rise = POI_IN * FPS, fall = POI_IN * FPS / 2;
    const camAlt = (x) => {
      const [i, u] = path.segment(x), j = Math.min(i + 1, path.list.length - 1);
      return ground?.[i] != null && ground?.[j] != null ? ground[i] + (ground[j] - ground[i]) * u + CAM_HEIGHT : null;
    };
    // Altitude visée : celle de l'objet relevé (triangulé) ; sinon le sol sous la cible ; sinon à l'horizontale
    const targetAlt = poi.z ?? poi.ground?.target ?? null;
    for (let n = n0; n <= Math.min(xs.length - 1, n1 + fall); n++) {
      const w = n < n0 + rise ? smooth((n - n0) / rise) : n <= n1 ? 1 : 1 - smooth(Math.min(1, (n - n1) / fall));
      const x = xs[n], at = path.at(x), d = Math.max(1, metres(at, poi.target));
      const rel = wrap(bearing(at, poi.target) - path.course(x));
      yaw[n] = w * Math.sign(rel) * Math.min(LOOK_MAX, Math.abs(rel));
      const cam = camAlt(x);
      if (targetAlt != null && cam != null) lift[n] = w * Math.max(-60, Math.min(60, Math.atan2(targetAlt - cam, d) / toRad));
      if (poi.zoom > 1) {
        const bump = x <= span.xc ? smooth(Math.min(1, Math.max(0, (x - span.x0) / Math.max(1, span.xc - span.x0))))
          : smooth(Math.min(1, Math.max(0, (span.x1 - x) / Math.max(1, span.x1 - span.xc))));
        const z = poi.zoomByDistance ? Math.min(poi.zoom, Math.max(1, d / span.dmin)) : 1 + (poi.zoom - 1) * bump;
        zoom[n] = 1 + (z - 1) * w;
      }
    }
    return { yaw, lift, zoom, span };
  }

  /** Roulis (degrés) à chaque image de la chronologie xs : tonneaux aux endroits lonlats ([lon, lat], ramenés sur le
   * parcours), tour complet en seconds s chacun (lent au départ et à l'arrivée), centré sur l'endroit, sens alterné dans
   * l'ordre du parcours (le premier à droite, le suivant à gauche…) ; erreur si l'un est à plus de ROLL_REACH m. */
  /** Abscisses (m, croissantes) des endroits [lon, lat] ramenés sur le parcours ; erreur pour un endroit à plus de
   * ROLL_REACH m (name : nom de l'effet). */
  function placesOn(path, lonlats, name) {
    return lonlats.map((lonlat, k) => {
      let best = null;
      for (let x = 0; x <= path.length; x += 1) {
        const d = metres(path.at(x), lonlat);
        if (!best || d < best.d) best = { x, d };
      }
      if (best.d > ROLL_REACH) {
        throw new Error(`${name} n° ${k + 1} à ${Math.round(best.d)} m du parcours (${ROLL_REACH} m au plus)`);
      }
      return best.x;
    }).sort((a, b) => a - b);
  }

  /** Petites planètes sur les tronçons spans ([[début, fin]…], [lon, lat] ramenés sur le parcours, à ROLL_REACH m au
   * plus ; un endroit seul [lon, lat] : PLANET_MIN m centrés sur lui) : { mix, spin } par image de xs : part de la
   * planète (0 : vue normale, 1 : planète ; enroulement au début du tronçon et déroulement à la fin, fade s chacun
   * adoucis, la moitié du tronçon au plus ; 0 : planète d'emblée sur tout le tronçon) et
   * rotation sur elle-même (degrés : spin °/s depuis le milieu du tronçon, multipliés par la part : nulle hors de
   * l'effet, la vue revient droite) ; all : planète sur tout le parcours (spans ignorés) ; barrel : un tonneau (tour
   * complet de roulis, adouci) pendant l'enroulement, un autre en sens inverse pendant le déroulement. */
  function planets(path, xs, spans = [], spin = PLANET_SPIN, fade = PLANET_FADE, all = false, barrel = false) {
    const mix = xs.map(() => 0), turn = xs.map(() => 0);
    const frame = (x) => {
      const n = xs.findIndex((v) => v >= x);
      return n < 0 ? xs.length - 1 : n;
    };
    (all ? [null] : spans).forEach((span, k) => {
      const ends = all ? null : Array.isArray(span[0]) ? span : [span, span];
      let [x0, x1] = all ? [0, path.length] : placesOn(path, ends, `petite planète n° ${k + 1}, extrémité`);
      if (x1 - x0 < PLANET_MIN) {
        const c = (x0 + x1) / 2;
        [x0, x1] = [Math.max(0, c - PLANET_MIN / 2), Math.min(path.length, c + PLANET_MIN / 2)];
      }
      // Tout le parcours : arrêts sur la première et la dernière vue compris
      const n0 = all ? 0 : frame(x0), n1 = all ? xs.length - 1 : Math.max(n0 + 3, frame(x1)), centre = (n0 + n1) / 2;
      const f = Math.min(fade * FPS, (n1 - n0) / 2);
      for (let n = n0; n <= Math.min(xs.length - 1, n1); n++) {
        const m = f ? smooth(Math.max(0, Math.min(1, (n - n0) / f, (n1 - n) / f))) : 1;
        if (m <= mix[n]) continue;
        mix[n] = m;
        turn[n] = m * spin * (n - centre) / FPS;
        if (barrel && f) turn[n] += 360 * (n - n0 < f ? smooth((n - n0) / f) : n1 - n < f ? -smooth((n - n1 + f) / f) : 0);
      }
    });
    return { mix, spin: turn };
  }

  /** Tours d'horizon aux endroits [lon, lat] (à ROLL_REACH m au plus du parcours) : le regard fait un tour complet dans
   * le plan de l'horizon en seconds (départ et arrivée adoucis, sens alterné dans l'ordre du parcours), pour montrer
   * les espaces plats ; stop : caméra arrêtée pendant le tour, sur la photo la plus proche (image nette, pas un
   * fondu) ; sinon centré sur le passage. Rend { xs, look } : abscisses des images (arrêt : images ajoutées) et regard
   * (degrés) par image. */
  function tours(path, xs, lonlats = [], seconds = TOUR_TIME, stop = true) {
    const frames = Math.round(seconds * FPS), out = xs.slice(), starts = [];
    for (const x of placesOn(path, lonlats, "tour d'horizon")) {
      if (stop) {
        // Arrêt à la première image qui atteint la photo la plus proche (moins d'une image après elle : la photo
        // seule, sans fondu ni saut de la caméra)
        const photo = path.s.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
        const at = Math.max(0, out.findIndex((v) => v >= photo));
        out.splice(at, 0, ...Array(frames).fill(out[at]));
        starts.push(at);
      } else {
        starts.push(Math.max(0, out.findIndex((v) => v >= x) - Math.round(frames / 2)));
      }
    }
    const look = out.map(() => 0);
    starts.forEach((start, k) => {
      for (let n = start; n < Math.min(out.length, start + frames); n++) {
        look[n] = (k % 2 ? -1 : 1) * 360 * smooth((n - start + 1) / frames);
      }
    });
    return { xs: out, look };
  }

  /** Vitesse affichée par image de xs (km/h) : avancée d'une image à l'autre, lissée sur ± SPEED_SMOOTH images comme
   * une aiguille (départ, arrêts), au centième. */
  function speeds(xs) {
    const raw = xs.map((x, n) => (n ? (x - xs[n - 1]) * FPS * 3.6 : 0));
    return raw.map((_, n) => {
      const part = raw.slice(Math.max(0, n - SPEED_SMOOTH), n + SPEED_SMOOTH + 1);
      return Math.round(100 * part.reduce((a, b) => a + b, 0) / part.length) / 100;
    });
  }

  /** Accélération latérale par image de xs (millièmes de g, sans signe) : v² × courbure ; v du compteur (kmhs, km/h), courbure =
   * rotation du cap lissé (course) sur 10 m. shortcut: trajectoire lissée sur ± SMOOTH m, virages de moins de ~30 m de
   * rayon sous-estimés ; calculer la courbure sur la trajectoire brute si ces virages comptent. */
  function laterals(path, xs, kmhs) {
    return xs.map((x, n) => 1000 / 9.81 * (kmhs[n] / 3.6) ** 2 * Math.abs(wrap(path.course(x + 5) - path.course(x - 5))) * toRad / 10);
  }

  /** Dévers vers l'intérieur du virage par image de xs (fraction, positif s'il aide à tourner ; null s'il n'est pas
   * connu) : dévers des photos (photo.devers, pente descendant vers la droite, lue par l'application sur le LiDAR HD)
   * interpolé, signé selon le sens du virage (cap lissé). */
  function insideDevers(path, xs) {
    return xs.map((x) => {
      const [i, u] = path.segment(x);
      const a = path.list[i].devers, b = path.list[Math.min(i + 1, path.list.length - 1)].devers;
      if (a == null || b == null) return null;
      const right = a + (b - a) * u;
      return wrap(path.course(x + 5) - path.course(x - 5)) >= 0 ? right : -right;
    });
  }

  // ARP (SETRA, août 1994, § 3.1 a et d), par vitesse de la catégorie (R 60, T 80 et R 80, T 100) : rayon non déversé Rnd
  // (chaussée en toit, 2,5 % vers l'extérieur) et rayon minimal Rm (dévers de 7 %) ; frottement transversal mobilisé
  // f = V² / (127 R) - dévers : 0,072 / 0,166 à 60 km/h, 0,081 / 0,140 à 80, 0,086 / 0,116 à 100
  const ARP = [[60, 600, 120], [80, 900, 240], [100, 1300, 425]].map(([v, rnd, rm]) =>
    [v, v * v / (127 * rnd) + 0.025, v * v / (127 * rm) - 0.07]);
  /** Couleur de l'accélération latérale mg (millièmes de g) à kmh, dévers vers l'intérieur devers (fraction ; null :
   * inconnu, compté nul) : frottement mobilisé f = mg / 1000 - devers, vert jusqu'à celui du rayon non déversé de l'ARP à
   * cette vitesse, jaune jusqu'à celui du rayon minimal, rouge au-delà. Vitesse ramenée entre 60 et 100 km/h (l'ARP ne
   * va pas au-delà : autoroutes exclues). */
  function lateralColor(mg, kmh, devers = null) {
    const v = Math.min(100, Math.max(60, kmh)), k = Math.max(1, ARP.findIndex(([s]) => s >= v));
    const [[v0, g0, r0], [v1, g1, r1]] = [ARP[k - 1], ARP[k]], u = (v - v0) / (v1 - v0);
    const f = mg / 1000 - (devers ?? 0);
    return f <= g0 + (g1 - g0) * u ? GREEN : f <= r0 + (r1 - r0) * u ? "#ffd600" : "#ff3d3d";
  }
  const GREEN = "#4caf50";
  const STEADY = 8;  // images : accélération ressentie et dévers lissés sur ± STEADY images (un quart de seconde)
  const STEP_MG = 20, STEP_KMH = 5;  // retour en arrière minimal de l'accélération ressentie (mG), de la vitesse max ARP (km/h)

  /** Moyenne glissante de values sur ± half images ; null ignoré (null si tout l'est). */
  function smoothed(values, half) {
    return values.map((_, n) => {
      const part = values.slice(Math.max(0, n - half), n + half + 1).filter((v) => v != null);
      return part.length ? part.reduce((a, b) => a + b, 0) / part.length : null;
    });
  }

  /** Valeurs affichées sans battement, extrêmes gardés : le chiffre suit aussitôt la valeur vers l'extrême (vers le haut si
   * high, vers le bas sinon), à l'unité près, et ne revient en arrière que d'au moins step à la fois. null : rien
   * d'affiché (« — »). */
  function steady(values, step, high = true) {
    let shown = null;
    return values.map((v) => {
      if (v == null) return (shown = null);
      if (shown == null || (high ? v > shown : v < shown) || Math.abs(v - shown) >= step) shown = Math.round(v);
      return shown;
    });
  }
  const ARP_TOP = 150;  // km/h : vitesse max ARP non affichée au-delà (ligne droite, grande courbe)
  const ARP_SMOOTH = 15;  // m : vitesse max ARP = la plus basse sur ± ARP_SMOOTH m (30 m : le point critique du virage)

  /** Vitesse max ARP par image de xs (km/h) : la plus haute où l'accélération latérale du virage resterait verte
   * (lateralColor), avec le dévers vers l'intérieur (insideDevers, inconnu : compté nul), calculée mètre par mètre, la
   * plus basse sur ± ARP_SMOOTH m ; null à ARP_TOP km/h et au-delà. */
  function arpSpeeds(path, xs) {
    const raw = new Map();  // mètre du parcours -> vitesse max en ce point
    const at = (m) => {
      if (!raw.has(m)) {
        const k = Math.abs(wrap(path.course(m + 5) - path.course(m - 5))) * toRad / 10, d = insideDevers(path, [m])[0];
        let v = 0;
        while (v < ARP_TOP && lateralColor(1000 / 9.81 * ((v + 1) / 3.6) ** 2 * k, v + 1, d) === GREEN) v++;
        raw.set(m, v);
      }
      return raw.get(m);
    };
    return xs.map((x) => {
      let v = ARP_TOP;
      for (let m = Math.round(x) - ARP_SMOOTH; m <= Math.round(x) + ARP_SMOOTH; m++) v = Math.min(v, at(Math.min(Math.round(path.length), Math.max(0, m))));
      return v < ARP_TOP ? v : null;
    });
  }

  function rolls(path, xs, lonlats = [], seconds = ROLL_TIME) {
    const out = xs.map(() => 0);
    const places = placesOn(path, lonlats, "tonneau");
    const half = seconds * FPS / 2, ease = (p) => p * p * (3 - 2 * p);
    places.forEach((x, k) => {
      const centre = Math.max(0, xs.findIndex((v) => v >= x)), sign = k % 2 ? -1 : 1;
      for (let n = Math.max(0, Math.ceil(centre - half)); n <= Math.min(xs.length - 1, centre + half); n++) {
        out[n] += sign * 360 * ease((n - centre + half) / (2 * half));
      }
    });
    return out;
  }

  /** Durée (s) de la vidéo des photos [record] à kmh, avec ou sans rampe de vitesse. */
  const duration = (photos, kmh, ramp = false, junctions = [], lookKmh = LOOK_SPEED, poi = null) => {
    const path = trajectory(photos);
    let poiSlow = null;
    try {
      if (poi?.speed) poiSlow = { ...poiSpan(path, poi), speed: poi.speed / 3.6 };
    } catch { /* borne loin du parcours : signalée au calcul de la vidéo */ }
    return timeline(path, kmh / 3.6, ramp, lookedJunctions(path, junctions), lookKmh / 3.6, poiSlow).length / FPS;
  };

  /** Exposition d'une photo : moyenne des logarithmes de R, V, B sur sa vignette, de 45° au-dessus de l'horizon à 20°
   * dessous (ni le haut du ciel, ni le toit du véhicule, sous ROOF), sur tout le tour d'horizon : deux photos voisines
   * voient à peu près le même entourage, alors que le décor du seul regard change (essai du 31/10 au carrefour RD18 /
   * D115D : arbre à l'ombre d'un côté, vignes au soleil de l'autre, rapport 2 au lieu de 1,5 ; tour complet : 1,51,
   * contre 1,58 mesuré au même endroit dans le même sens). Mesure gardée par identifiant de photo (exposureCache). */
  async function exposureOf(photo, signal) {
    const cache = exposureCache();
    const kept = cache.get(photo.id);
    if (kept) {
      cache.delete(photo.id);  // remise en fin de liste : oubliée la dernière
      cache.set(photo.id, kept);
      return kept;
    }
    const bitmap = await fetchImage(photo.thumb, signal);
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
    const value = sum.map((v) => Math.round(1e4 * v / Math.max(1, px.length / 4)) / 1e4);
    cache.set(photo.id, value);
    return value;
  }

  /** Expositions déjà mesurées (Map identifiant → [R, V, B]), gardées d'une vidéo et d'une session à l'autre
   * (keepExposures) : un second rendu du même parcours ne recharge aucune vignette. */
  let measured = null;
  function exposureCache() {
    if (!measured) {
      try {
        measured = new Map(JSON.parse(localStorage.getItem(EXPO_STORE)) || []);
      } catch {
        measured = new Map();
      }
    }
    return measured;
  }
  function keepExposures() {
    try {
      localStorage.setItem(EXPO_STORE, JSON.stringify([...exposureCache()].slice(-EXPO_KEPT)));
    } catch { /* stockage plein ou absent : gardées pour cette session seulement */ }
  }

  /**
   * Corrections des photos isolées (logarithmes R, V, B à ajouter, ou null) : la caméra rate parfois l'exposition d'une
   * ou deux photos, 25 à 85 % plus claires ou plus sombres que leurs voisines (essai du 01/11, forêt de la séquence
   * d8fd3b08, une photo toutes les 0,2 s), ce qui clignote dans la vidéo. Chaque photo est comparée à la médiane des
   * photos de sa séquence prises à ± EXPO_NEAR s (3 au moins) et y est ramenée si elle s'en écarte de plus de
   * EXPO_JUMP. La médiane garde les vrais changements du décor (entrée dans une clairière, un champ) ; la surexposition
   * lente à la sortie de l'ombre (2 à 3 s) et le ciel brûlé sous les arbres ne sont pas corrigés. values : expositions
   * de list (exposureOf, null si non mesurée).
   */
  function isolated(list, values) {
    const median = (vs) => [0, 1, 2].map((c) => vs.map((v) => v[c]).sort((a, b) => a - b)[vs.length >> 1]);
    return list.map((p, i) => {
      if (!values[i] || !p.time) return null;
      const near = [];
      for (let j = 0; j < list.length; j++) {
        const q = list[j];
        if (values[j] && q.time && q.collection === p.collection && Math.abs(q.time - p.time) <= EXPO_NEAR * 1000) near.push(values[j]);
      }
      if (near.length < 3) return null;
      const m = median(near);
      // Même gain sur les trois couleurs : la luminosité seule (par couleur, la teinte changeait d'une photo à l'autre)
      const shift = (m[0] + m[1] + m[2] - values[i][0] - values[i][1] - values[i][2]) / 3;
      return Math.abs(shift) > EXPO_JUMP ? [shift, shift, shift] : null;
    });
  }

  /**
   * Corrections de luminosité de chaque photo (gain R, V, B, multiplié dans le rendu). Toutes les photos sont mesurées
   * (exposureOf, EXPO_PARALLEL vignettes à la fois, mesures gardées). Photos isolées trop claires ou trop sombres :
   * ramenées sur leurs voisines (isolated ; isolatedToo à false pour s'en passer). Changements de séquence : une autre
   * campagne peut être bien plus claire ou plus sombre (juillet 2025 : 58 % plus clair que mai au même endroit) ; la
   * nouvelle séquence est ramenée sur la précédente (EXPO_SIDE photos de part et d'autre, médiane), puis revient peu à
   * peu à sa propre exposition sur EXPO_RAMP m.
   */
  async function exposures(path, signal, isolatedToo = true) {
    const { list, s } = path;
    const gains = list.map(() => [1, 1, 1]);
    const values = list.map(() => null);
    let next = 0;
    await Promise.all(Array.from({ length: EXPO_PARALLEL }, async () => {
      while (next < list.length) {
        const i = next++;
        try {
          values[i] = await exposureOf(list[i], signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          console.warn("Vidéo : exposition non mesurée", list[i].id, error);
        }
      }
    }));
    keepExposures();
    const median = (vs) => [0, 1, 2].map((c) => vs.map((v) => v[c]).sort((a, b) => a - b)[vs.length >> 1]);
    let carried = [0, 0, 0];  // correction (log) de la séquence précédente à sa dernière photo
    for (let k = 1; k < list.length; k++) {
      if (list[k].collection === list[k - 1].collection) {
        continue;
      }
      const before = [], after = [];
      for (let i = k - 1; i >= Math.max(0, k - EXPO_SIDE) && list[i].collection === list[k - 1].collection; i--) if (values[i]) before.push(values[i]);
      for (let i = k; i < Math.min(list.length, k + EXPO_SIDE) && list[i].collection === list[k].collection; i++) if (values[i]) after.push(values[i]);
      let shift = [0, 0, 0];
      if (before.length && after.length) {
        const [ma, mb] = [median(before), median(after)];
        shift = [0, 1, 2].map((c) => ma[c] + carried[c] - mb[c]);
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
    const fixes = isolatedToo ? isolated(list, values) : [];
    return gains.map((g, i) => g.map((v, c) => Math.min(EXPO_MAX, Math.max(1 / EXPO_MAX, v * Math.exp(fixes[i]?.[c] || 0)))));
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
    // Raccords de séquence (milieu des deux photos) : cap lissé sur ± SEAM m jusqu'à SEAM m du raccord, revenu à ± SMOOTH m
    // en douceur sur les SEAM m suivants (essai : décalage de 1,5 m entre deux séquences, cap écarté de 1,1° au plus au
    // lieu de 2,9°, 0,23 °/m au lieu de 0,56)
    const seamsAt = list.map((p, i) => (i && p.collection !== list[i - 1].collection ? (s[i - 1] + s[i]) / 2 : null))
      .filter((v) => v != null);
    const reach = (x) => SMOOTH + (SEAM - SMOOTH) * Math.max(0, ...seamsAt.map((c) => smooth(Math.min(1, Math.max(0, 2 - Math.abs(x - c) / SEAM)))));
    const course = (x) => {
      const h = reach(x);
      return bearing(at(x - h), at(x + h));
    };
    for (let i = 0; i < list.length; i++) {
      const x0 = Math.max(0, s[i] - SLOPE), x1 = Math.min(length, s[i] + SLOPE);
      list[i].pitch = x1 - x0 > 1 ? -Math.atan((altAt(x1) - altAt(x0)) / (x1 - x0)) : 0;
    }
    return { list, s, length, segment, course, at };
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
    const size = Math.floor(t.size * scale);  // vers le bas : la découpe ne dépasse pas la texture visée
    if (t.image) {
      const bitmap = await fetchImage(t.image, signal);
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
        jobs.push(fetchImage(url, signal).then((bitmap) => {
          ctx.drawImage(bitmap, i * size, j * size, size, size);
          bitmap.close();
        }, (error) => {
          if (signal?.aborted) throw error;
          console.warn("Vidéo : tuile perdue", url, error);
        }));
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
    uniform vec4 cam0, cam1;  // cap de la route, tangage (radians), tan du demi-champ horizontal, avancée (m) depuis la photo
    uniform float look;  // regard décalé de l'axe de la route (radians, à droite) : panoramique, croisements
    uniform float roll;  // roulis de l'image (radians) : tonneau
    uniform float lift;  // regard levé (radians) : visée en hauteur du point d'intérêt, petite planète (vers le sol)
    uniform float planet;  // projection : 0 perspective, 1 stéréographique (petite planète), entre les deux : passage
    uniform float aspect, blend, height, bowl, road, roof;
    uniform vec3 gain0, gain1;  // exposition de chaque photo (changement de séquence)
    vec4 pick(sampler2D t, vec4 crop, vec2 grid, vec4 cam) {
      // Rayon de la caméra virtuelle, tourné du regard décalé, avancée de cam.w m dans l'axe de la route (horizontal) :
      // point touché sur la maquette (chaussée dans l'axe de la route, sinon sphère), puis direction de ce point vue de
      // la caméra de la photo
      // Point de vue de la projection à planet en arrière du centre de la sphère des directions (0 : perspective, 1 :
      // stéréographique) : rayon par le point (s, 1) de l'écran
      vec2 s = vec2(ndc.x * cam.z, ndc.y * cam.z / aspect);
      float P = planet, A = dot(s, s) + (1.0 + P) * (1.0 + P);
      float t1 = (P * (1.0 + P) + sqrt(P * P * (1.0 + P) * (1.0 + P) - A * (P * P - 1.0))) / A;
      vec3 r = normalize(vec3(t1 * s, -P + t1 * (1.0 + P)));
      r = vec3(r.x * cos(roll) - r.y * sin(roll), r.x * sin(roll) + r.y * cos(roll), r.z);
      r = vec3(r.x, r.y * cos(lift) + r.z * sin(lift), -r.y * sin(lift) + r.z * cos(lift));
      r = vec3(r.x * cos(look) + r.z * sin(look), r.y, -r.x * sin(look) + r.z * cos(look));
      vec3 o = vec3(0.0, 0.0, cam.w);
      float b = dot(o, r);
      float k = -b + sqrt(b * b - dot(o, o) + bowl * bowl);
      // Chaussée derrière la caméra de la photo (vue depuis l'arrière) : pas dans sa vue utile, l'autre photo la
      // donne (sinon sa couleur sur la sphère, sans confiance) ; entre 1 et 4 m devant elle, en dégradé (pas de bord net)
      float g = height / -r.y, keep = 1.0;
      if (r.y < 0.0 && abs(g * r.x) < road && g < k) {
        keep = smoothstep(1.0, 4.0, o.z + g * r.z);
        if (keep > 0.0) k = g;
      }
      vec3 d = normalize(o + k * r);
      float cp = cos(cam.y), sp = sin(cam.y), cy = cos(cam.x), sy = sin(cam.x);
      d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
      d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
      float lon = degrees(atan(d.x, d.z)), lat = degrees(asin(clamp(d.y, -1.0, 1.0)));
      float u = mod((lon + 180.0) / (360.0 / grid.x) - crop.x, grid.x) / crop.y;
      float v = ((90.0 - lat) / (180.0 / grid.y) - crop.z) / crop.w;
      // Hors des tuiles chargées : alpha -1 ; toit du véhicule (regard vers l'arrière, panoramique) : couleur sans
      // confiance (alpha 0), prise seulement si l'autre photo n'a rien de mieux
      if (u > 1.0 || v < 0.0 || v > 1.0) return vec4(0.0, 0.0, 0.0, -1.0);
      vec4 c = texture(t, vec2(u, v));
      return vec4(c.rgb, lat < roof ? 0.0 : c.a * keep);
    }
    void main() {
      vec4 a = pick(tex0, crop0, grid0, cam0), b = pick(tex1, crop1, grid1, cam1);
      a.rgb = min(a.rgb * gain0, 1.0);
      b.rgb = min(b.rgb * gain1, 1.0);
      float ta = max(a.a, 0.0), tb = max(b.a, 0.0);
      float w = mix(tb, blend * tb, ta);  // photo quittée absente : la suivante seule
      // Aucune des deux sûre (vue vers l'arrière) : leurs couleurs quand même, plutôt que du noir
      if (ta == 0.0 && tb == 0.0) w = a.a < 0.0 ? 1.0 : (b.a < 0.0 ? 0.0 : blend);
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
      /** Vue : views = [{ tex, crop, grid, yaw, pitch, tan, move, gain }] (yaw : cap de la route), look : regard décalé ; (photo quittée, photo suivante), blend : part de la
       * suivante ; planet : projection (0 perspective, 1 stéréographique) ; weight < 1 : vue mêlée à l'image déjà dessinée dans cette proportion (moyenne du flou cinétique). */
      draw(views, blend, weight = 1, look = 0, roll = 0, lift = 0, planet = 0) {
        gl.uniform1f(u("planet"), planet);
        gl.uniform1f(u("look"), look);
        gl.uniform1f(u("roll"), roll);
        gl.uniform1f(u("lift"), lift);
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

  /** Première configuration qui encode vraiment : { config, codec (pour mp4-muxer) } ; null sans aucune. hq : haute
   * qualité (HQ_CODECS en 1080p, puis la qualité ordinaire si le poste n'en encode aucun). */
  async function encoderConfig(hq = false) {
    const pairs = (sizes, codecs) => sizes.flatMap((size) => codecs.map((codec) => [size, codec]));
    const choices = hq ? [...pairs([SIZES[0]], HQ_CODECS), ...pairs(SIZES, CODECS)] : pairs(SIZES, CODECS);
    for (const [[width, height, share], [name, codec, rate]] of choices) {
      const config = { codec: name, width, height, bitrate: rate * share, framerate: FPS, ...(codec === "avc" ? { avc: { format: "avc" } } : {}) };
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported && await encodes(config)) return { config, codec };
      } catch { /* configuration refusée : la suivante */ }
    }
    return null;
  }

  /**
   * Vidéo MP4 (Blob) des photos du parcours [record], à la vitesse simulée kmh, corrections de luminosité (exposures).
   * options.blur : flou cinétique (moyenne de BLUR vues réparties entre la position de l'image
   * précédente et celle-ci : le proche défilant vite s'étale) ; options.exposure : false pour ne pas corriger la
   * luminosité ; options.ramp : rampe de vitesse (timeline) ; options.title :
   * { text, sub } en titre au début ; options.counter : compteur PR (photo.pr, prAt) ; options.speedometer : compteur de
   * vitesse (speeds) ; options.lateral : accélération latérale (laterals, insideDevers) ; options.arpSpeed : vitesse
   * max ARP (arpSpeeds) ; options.junctions : carrefours où regarder (pans) ; options.rolls : endroits des tonneaux
   * ([[lon, lat]…], rolls), options.rollTime : durée de chacun (s) ; options.lookSpeed : vitesse de regard aux carrefours (km/h) ;
   * options.poi : point d'intérêt { target, z (altitude NGF de l'objet relevé ou null), start, end (extrémités de la
   * zone tracée, [lon, lat] ou null), speed (km/h ou null), zoom, zoomByDistance, roll, ground: { target, photos }
   * (altitudes du sol, par photo de photos) } (poiViews) ; options.planets : tronçons des petites planètes ([[début, fin]…],
   * planets), options.planetFade : enroulement et déroulement (s), options.planetAll : sur tout le parcours, options.planetRoll : tonneau pendant les transitions, options.planetSpin : vitesse de rotation (°/s) ;
   * options.advance : false pour ne pas avancer dans la maquette (fondu enchaîné d'une photo à l'autre) ;
   * options.tours : endroits des tours d'horizon ([[lon, lat]…], tours), options.tourTime : durée de chacun (s),
   * options.tourStop : caméra arrêtée pendant le tour ; options.hq : haute qualité (HQ_CODECS, tuiles en pleine
   * définition, vue calculée en HQ_SUPERSAMPLE fois la définition ; lent). progress(fait, total) à chaque image ; signal : AbortSignal pour arrêter.
   */
  async function mp4(photos, kmh, progress = () => {}, signal = null,
    { blur = false, exposure = true, ramp = false, title = null, counter = false, speedometer = false, lateral = false, arpSpeed = false, junctions = [], rolls: rollPlaces = [],
    rollTime = ROLL_TIME, lookSpeed = LOOK_SPEED, poi = null, hq = false, planets: planetPlaces = [], planetFade = PLANET_FADE, planetAll = false, planetRoll = false,
    planetSpin = PLANET_SPIN, advance = true, tours: tourPlaces = [], tourTime = TOUR_TIME, tourStop = true } = {}) {
    const path = trajectory(photos);
    if (path.list.length < 2 || path.length < 1) throw new Error("parcours trop court");
    const [chosen] = await Promise.all([encoderConfig(hq), loadMuxer()]);
    if (!chosen) throw new Error("ce navigateur n'encode ni le H.264 ni le VP9");
    const { config, codec } = chosen;
    const { width, height } = config;
    const ss = hq ? HQ_SUPERSAMPLE : 1;
    const gl = renderer(width * ss, height * ss);
    const tan = Math.tan(HFOV / 2 * toRad);
    // Demi-largeur de l'écran pour la part m de la planète : demi-champ de HFOV / 2 à PLANET_FOV / 2, point de vue de
    // la projection reculé deux fois plus vite (stéréographique dès la moitié : le champ passe 180° sans se retourner)
    const planetTan = (m) => {
      const a = (HFOV / 2 + (PLANET_FOV - HFOV) / 2 * m) * toRad, P = Math.min(1, 2 * m);
      return Math.sin(a) * (1 + P) / (Math.cos(a) + P);
    };
    const vfov = 2 * Math.atan(tan * height / width) / toRad;
    // Champ le plus large demandé à une photo (vue depuis l'avant, au début du fondu : le décor proche s'écarte),
    // découpe et réduction des tuiles à la finesse de la vue (plus un quart pour l'avancée)
    const widest = (fov) => 2 * Math.atan(Math.tan(fov / 2 * toRad) * 1.6) / toRad;
    const scaleOf = (t) => (hq ? 1 : Math.min(1, 1.25 * (width / HFOV) / (t.size / (360 / t.cols))));
    const yawAt = (i, x) => wrap(path.course(x) - path.list[i].heading);
    const gains = exposure ? await exposures(path, signal) : path.list.map(() => [1, 1, 1]);
    const span = poi ? poiSpan(path, poi) : null;
    // Tours d'horizon : images ajoutées pendant l'arrêt, avant les autres effets (calés sur les images)
    const turns = tours(path, timeline(path, kmh / 3.6, ramp, lookedJunctions(path, junctions), lookSpeed / 3.6,
      poi?.speed ? { ...span, speed: poi.speed / 3.6 } : null), tourPlaces, tourTime, tourStop);
    const xs = turns.xs;
    const pan = pans(path, xs, { junctions });
    const kmhs = speedometer || lateral ? speeds(xs) : null;
    // Accélération ressentie (|a / g - dévers|) et sa couleur, lissées sur ± STEADY images ; chiffres sans battement mais
    // extrêmes gardés : pic de l'accélération, creux de la vitesse max ARP (la plus basse sur 20 m)
    const devs = lateral ? smoothed(insideDevers(path, xs), STEADY) : null;
    const lats = lateral ? smoothed(laterals(path, xs, kmhs), STEADY) : null;
    const felt = lateral ? steady(lats.map((a, n) => Math.abs(a - 1000 * (devs[n] ?? 0))), STEP_MG) : null;
    const vmax = arpSpeed ? steady(arpSpeeds(path, xs), STEP_KMH, false) : null;
    turns.look.forEach((v, n) => { pan[n] += v; });
    // Point d'intérêt : regard vers la cible (ajouté au décalage du regard), visée en hauteur, zoom ; tonneau au plus près
    const ground = poi?.ground ? path.list.map((p) => poi.ground.photos[photos.indexOf(p)] ?? null) : null;
    const aim = poiViews(path, xs, poi, ground);
    aim.yaw.forEach((v, n) => { pan[n] += v; });
    const tilt = rolls(path, xs, poi?.roll ? [...rollPlaces, path.at(span.xc)] : rollPlaces, rollTime);
    // Petite planète : regard vers le sol, champ élargi jusqu'à PLANET_FOV, rotation lente ajoutée au roulis
    const globe = planets(path, xs, planetPlaces, planetSpin, planetFade, planetAll, planetRoll);
    globe.spin.forEach((v, n) => { tilt[n] += v; });
    // Image tournée par le tonneau : le coin de la vue passe en haut et en bas (demi-diagonale du champ)
    const diagonal = 2 * Math.atan(Math.hypot(tan, tan * height / width)) / toRad;
    const rolled = path.list.map(() => false);
    xs.forEach((x, n) => {
      if (!(Math.abs(tilt[n]) % 360)) return;
      const i = path.segment(x)[0];
      rolled[i] = rolled[Math.min(i + 1, path.list.length - 1)] = true;
    });
    // Regard décalé (croisements, point d'intérêt, tour d'horizon) : tuiles chargées d'autant plus larges pour les photos concernées
    const extra = path.list.map(() => 0);
    const raise = path.list.map(() => 0), sharp = path.list.map(() => 1);  // visée en hauteur, zoom : par photo
    const round = path.list.map(() => false);  // petite planète : tout le panorama, tuiles réduites
    xs.forEach((x, n) => {
      const i = path.segment(x)[0], off = Math.min(180, Math.abs(pan[n]));  // tour complet : tout le panorama
      for (const k of [i, Math.min(i + 1, path.list.length - 1)]) {
        if (globe.mix[n]) round[k] = true;
        extra[k] = Math.max(extra[k], off);
        raise[k] = Math.max(raise[k], Math.abs(aim.lift[n]));
        sharp[k] = Math.max(sharp[k], aim.zoom[n]);
      }
    });
    const loads = new Map();  // rang de la photo -> Promise de { tex, crop, grid }
    const load = (i) => {
      if (!loads.has(i)) {
        const photo = path.list[i];
        const crop = cropOf(photo.tiles, yawAt(i, path.s[i]), photo.pitch,
          round[i] ? 360 : Math.max(widest(HFOV), rolled[i] ? widest(diagonal) : 0) + 2 * extra[i],
          round[i] ? 360 : (rolled[i] ? widest(diagonal) : widest(vfov)) + 2 * raise[i]);
        // Zone élargie (regard décalé) : réduite au besoin pour tenir dans la plus grande texture du poste
        const t = photo.tiles, fit = Math.min(gl.max / (crop.nc * t.size), gl.max / (crop.nr * t.size));
        // Zoom : tuiles moins réduites, jusqu'à leur pleine définition (au-delà de × 1,4 environ, l'image s'adoucit)
        loads.set(i, loadCrop(photo, crop, Math.min(scaleOf(t) * sharp[i], 1, fit, round[i] ? PLANET_SCALE : 1), signal).then((image) => {
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
    let overlay = null;  // canevas 2D du titre et du compteur
    const total = xs.length;
    try {
      for (let n = 0; n < total; n++) {
        if (signal?.aborted) throw new DOMException("Vidéo arrêtée", "AbortError");
        if (failure) throw failure;
        const at = (m) => xs[Math.max(0, Math.min(total - 1, m))];
        const x = at(n);
        // Flou cinétique : vues de la position de l'image précédente (exclue) à celle-ci, dans l'ordre du parcours ;
        // toujours au raccord de deux séquences (fondu entre elles : masque leur décalage) et pendant un pivot rapide du
        // regard (croisement, tonneau), flou de mouvement de la rotation
        const before = pan[Math.max(0, n - 1)], turn = wrap(pan[n] - before);
        // (écart au plus court : 360° puis 0° en fin de tonneau, même image, pas un tour à l'envers)
        const rollBefore = tilt[Math.max(0, n - 1)], rollTurn = wrap(tilt[n] - rollBefore);
        // (une vue tous les 1,5° de rotation, BLUR à 48)
        // (tour d'horizon : lent, pour montrer le paysage, sans flou de rotation)
        const sweep = wrap(turn - turns.look[n] + turns.look[Math.max(0, n - 1)]);
        const spin = Math.max(Math.abs(sweep), Math.abs(rollTurn));
        const [seamI] = path.segment(x), seam = path.list[seamI].collection !== path.list[Math.min(seamI + 1, path.list.length - 1)].collection;
        const subs = spin > 1 ? Math.min(48, Math.max(BLUR, Math.ceil(spin / 1.5))) : (blur || seam) && at(n - 1) < x ? BLUR : 1;
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
          const look = (before + turn * (k + 1) / subs) * toRad, view = planetTan(globe.mix[n]) / aim.zoom[n];
          const tilted = (rollBefore + rollTurn * (k + 1) / subs) * toRad;
          const [i, u] = path.segment(xs);
          const j = Math.min(i + 1, path.list.length - 1);
          const [a, b] = await Promise.all([load(i), load(j)]);
          // Avancée : u·écart après la photo quittée, (1 - u)·écart avant la suivante ; vue k : 1 / (k + 1) de la
          // moyenne courante
          const gap = advance ? Math.min(path.s[j] - path.s[i], GAP) : 0;
          gl.draw([
            { ...a, yaw: yawAt(i, xs) * toRad, pitch: path.list[i].pitch, tan: view, move: u * gap, gain: gains[i] },
            { ...b, yaw: yawAt(j, xs) * toRad, pitch: path.list[j].pitch, tan: view, move: -(1 - u) * gap, gain: gains[j] },
          ], j === i ? 0 : smooth(Math.min(1, Math.max(0, (u - 0.25) / 0.5))), 1 / (k + 1), look, tilted,
          (aim.lift[n] - 90 * globe.mix[n]) * toRad, Math.min(1, 2 * globe.mix[n]));
        }
        // Titre et compteurs : image recopiée dans un canevas 2D (réduite en haute qualité), puis écrits dessus
        let image = gl.canvas;
        if (title || counter || speedometer || lateral || arpSpeed || ss > 1) {
          overlay ??= new OffscreenCanvas(width, height);
          const ctx2d = overlay.getContext("2d");
          ctx2d.imageSmoothingQuality = "high";
          ctx2d.drawImage(gl.canvas, 0, 0, width, height);
          drawOverlay(ctx2d, width, height, { title, pr: counter ? prAt(path, x) : null,
            speed: speedometer ? { kmh: kmhs[n], digits: String(Math.round(Math.max(...kmhs))).length } : null,
            lateral: lateral ? { felt: felt[n], color: lateralColor(lats[n], kmhs[n], devs[n]) } : null, arp: arpSpeed ? { kmh: vmax[n] } : null,
            t: n / FPS });
          image = overlay;
        }
        const frame = new VideoFrame(image, { timestamp: Math.round(n * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
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

  return { supported, record, mp4, trajectory, timeline, duration, exposures, isolated, prAt, pans, rolls, lookedJunctions,
    poiSpan, poiViews, planets, tours, speeds, laterals, insideDevers, lateralColor, arpSpeeds, steady, drawOverlay, fetchImage, FPS, HOLD };
})();
