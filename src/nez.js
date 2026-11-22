// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// « Largeur dans la visionneuse » (expérimental, piste P22, étape 1) : une droite tracée au sol juste devant le nez du véhicule,
// perpendiculaire à la trajectoire de la séquence (calcul : App.nose_line, py/web_nez.py), et deux poignées, gauche et
// droite, que l'on fait glisser le long d'elle jusqu'aux bords de la route. Lecture en direct de la distance de chaque
// bord à la caméra et de la largeur, avec leur incertitude. Rien n'est retenu ni reporté dans le graphique du profil :
// les poignées ne servent qu'à lire. Tracé dans la seconde couche de Traits (setExtra), que les mesures n'écrasent pas ;
// la droite et ses deux bords sont aussi tracés sur la carte (Carte.showNez) pour juger qu'elle est perpendiculaire à la route.
// Dès qu'une poignée latérale est déplacée, la photo est calée comme le fait la vue Bird Eye (inclinaison tirée de la route, verticales,
// tangage lu sur les lignes ; Dessus.update en mode silencieux, sans rien afficher sur la carte) : tant que le calage n'est pas fait,
// l'encart et l'étiquette disent « Calage Bird Eye en cours… » et aucune largeur n'est affichée ; une fois fait, la largeur est recalculée sur
// la photo calée (les poignées gardent leur place dans l'image, pas leur distance en mètres) ; le calage est gardé par photo, partagé
// avec la vue Bird Eye (rallumée sur la photo, elle est prête plus vite).
// Gestes sur la droite elle-même (aucune croix ni flèche : rien ne gêne la mesure des petits objets), dans une bande de saisie invisible de ±8 px, sur la photo comme sur la carte : clic gauche maintenu et glissé = déplacer la droite en profondeur (sur la carte, le long du cap) ; clic droit maintenu et glissé, ou Maj + clic gauche glissé (pavés tactiles, Mac), = la tourner autour du droit de la caméra (0,1° par px, Alt pendant le glissement : dix fois plus fin) ; double clic = la remettre perpendiculaire au trajet. Pendant le glissement, aperçu géométrique rapide (droite d'avant en pointillés pour la rotation) ; au relâchement la droite se fixe et le relief est relu. Près des deux poignées des bords, celles-ci sont prioritaires. La droite reste toujours
// perpendiculaire à l'axe du véhicule (hors rotation) : butées renvoyées par nose_line (d_min : capot ; d_max : nez + écart à la photo suivante + 1 m,
// nez + 6 m sans suivante), les extrémités gardent leur écart latéral en mètres, la largeur est recalculée aussitôt, sans relancer
// le calage. La droite est rouge tant que la photo n'est pas calée (Bird Eye), puis verte ; sa distance est dans l'étiquette et l'encart.
// Réglage fin d'une poignée des bords : pendant son glissement et pendant la molette (un pixel de la photo affichée par cran, vers
// l'extérieur de la chaussée en roulant vers le haut), une loupe ronde (×3) suit la poignée et montre le point visé avec la droite, la poignée,
// un réticule, l'échelle au sol et la distance du bord à la caméra. Image : la scène de la visionneuse (three.js) est redessinée en
// plein format sur le seul carré de la loupe, au milieu de l'événement « render » de la visionneuse (sans cela, le tampon WebGL
// est vidé et illisible), puis la vue normale est redessinée aussitôt.

const Nez = {
  /** Place de la loupe, fonction pure (essais : Nez.placeLoupe). target {x, y} : point visé (px de la visionneuse) ; size {w, h} : encombrement de
   * la loupe (pastille et légende) ; bounds {w, h} : visionneuse ; obstacles [{left, top, right, bottom}] : poignée de l'autre bord, étiquette de largeur,
   * barre d'outils, bandeaux. Candidats : au-dessus (préféré), dessous, droite, gauche, puis les quatre diagonales ; chacun décalé au besoin pour
   * rentrer dans la visionneuse. Score (le plus bas gagne) = surface recouverte d'obstacles + 30 par pixel de décalage + 50 par rang de préférence ;
   * un candidat qui couvre le point visé (marge `margin`) est écarté. Rend { left, top, name }. */
  placeLoupe(target, size, bounds, obstacles = [], gap = 30, margin = 14) {
    const { w, h } = size, { x, y } = target;
    const candidates = [
      ["dessus", x - w / 2, y - gap - h], ["dessous", x - w / 2, y + gap], ["droite", x + gap, y - h / 2], ["gauche", x - gap - w, y - h / 2],
      ["dessus-droite", x + gap / 2, y - gap - h], ["dessus-gauche", x - gap / 2 - w, y - gap - h],
      ["dessous-droite", x + gap / 2, y + gap], ["dessous-gauche", x - gap / 2 - w, y + gap],
    ];
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    let best = null, fallback = null;
    candidates.forEach(([name, left0, top0], rank) => {
      // rentrer dans la visionneuse : décalage horizontal et vertical minimal (la loupe plus grande que la vue reste collée en haut à gauche)
      const left = Math.max(0, Math.min(bounds.w - w, left0)), top = Math.max(0, Math.min(bounds.h - h, top0));
      const rect = { left, top, right: left + w, bottom: top + h };
      const score = obstacles.reduce((sum, o) => sum + overlap(rect, o), 0) + 30 * (Math.abs(left - left0) + Math.abs(top - top0)) + 50 * rank;
      const covers = x > left - margin && x < rect.right + margin && y > top - margin && y < rect.bottom + margin;
      const item = { left, top, name, score };
      if (!covers && (!best || score < best.score)) best = item;
      if (!fallback || score < fallback.score) fallback = item;
    });
    return best || fallback;  // jamais sur le point visé, sauf si la visionneuse est trop petite pour l'éviter
  },

  /** Branche le bouton de la visionneuse ; host : etat (état partagé), map (carte MapLibre), notice. Rend update (photo affichée changée ou
   * visionneuse prête) et changed (calcul Python modifié : inclinaison, hauteur de caméra arrivées). */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const { etat, map } = host;
    const button = $("#nez-bords");

    const GREEN = "#39ff14", UNCALIBRATED = "#ff1f3d", RED = "#ff1f3d";
    // droite verte (photo calée) ou rouge franc (pas encore calée), sans liseré ; poignées latérales rouges
    const LINE_PX = 8;  // px : demi-largeur de la bande de saisie invisible autour de la droite
    const LINE_WIDTH = 2.5, LINE_WIDTH_HOVER = 4.5;  // px : épaisseur de la droite au repos et au survol (ou pendant son glissement)
    const HELP = "glisser : profondeur · clic droit glissé (ou Maj) : rotation · double clic : perpendiculaire";
    const LABEL_LIFT = 26;  // px : étiquette décollée de la droite, au-dessus d'elle ; si elle sortait de la vue en haut, sous la droite
    const LABEL_FLIP = -LABEL_LIFT;  // px : lift de l'étiquette passée dessous
    const DEPTH_STEP = 0.05;  // m : pas de la distance de la droite pendant le glissement en profondeur
    const TICK_PX = 28;  // px : longueur à l'écran d'une poignée (trait vertical, quel que soit le zoom)
    const HANDLE_PX = 10;  // px : portée d'une poignée (distance du pointeur au trait)
    const MIN_OFFSET = 0.2;  // m : bord minimal d'un profil en travers repris comme position de départ d'une poignée
    const MIN_GAP = 0.1;  // m : écart minimal entre les deux poignées (l'une ne dépasse pas l'autre pendant le glissement)
    const WAIT_MAX = 12000;  // ms : attente au plus de la position définitive de la droite (deux lectures du MNT de 5 s au plus), puis meilleure droite disponible
    const FALLBACK = 3;  // m : bords de départ sans profil en travers
    const INCLINATION = 0.5, ROLL = 0.5;  // degrés : incertitude de l'inclinaison de la photo et du roulis restant (docs/CALCULS.md)
    const ROTATION_MAX = 45;  // degrés : rotation de la droite autour du droit de la caméra, de part et d'autre de la perpendiculaire au trajet (comme NOSE_ROTATION_MAX en Python)
    const ROTATION_RATE = 0.1;  // degrés par px de glissement horizontal (Alt tenu pendant le glissement : 10 fois moins), précision de 0,1°
    const CALAGE_MAX = 90000;  // ms : attente au plus du calage Bird Eye, puis largeur sans calage
    const CALAGE_WAIT = "Calage Bird Eye en cours…";
    const DOUBLE_MS = 400, TAP_PX = 5;  // double clic sur la droite : délai entre les deux appuis ; déplacement (px) en deçà duquel un appui reste un simple clic
    const toRad = Math.PI / 180;
    const LOUPE_PX = 120, LOUPE_ZOOM = 3;  // px : diamètre de la pastille de la loupe ; agrandissement de la photo
    const LOUPE_W = 150, LOUPE_H = 146;  // px : encombrement de la loupe, légende comprise (largeur de la légende ; pastille + légende)
    const LOUPE_HOLD = 1000;  // ms : la loupe reste ouverte après le dernier cran de molette
    const WHEEL_NOTCH = 40;  // deltaY (px) au-delà duquel un événement de molette vaut un cran entier (pas d'accélération) ; en deçà : pavé tactile, fractions
    const WHEEL_PX = 1;  // px de la photo affichée par cran de molette
    const SCALE_LENGTHS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];  // m : longueurs rondes possibles de la barre d'échelle de la loupe
    const SCALE_MAX_PX = 60;  // px (dans la loupe) : longueur maximale de la barre d'échelle (visée : 30 à 60 px, selon les longueurs rondes disponibles)

    let active = false, raw = null, line = null;  // raw : dernière réponse de nose_line (texte), line : son contenu
    let photoId = null;
    let handles = { gauche: -FALLBACK, droit: FALLBACK }, moved = { gauche: false, droit: false };
    let depth = null;  // m : distance de la droite devant la caméra (null : au nez, d_min)
    let rotation = 0, keep = false;  // rotation (degrés, positif = sens trigonométrique vu du dessus), keep : droite gardée affichée pendant la relecture du relief
    let frame = null;  // image d'animation en attente (recalcul de la droite pendant la rotation)
    let ghost = null;  // droite d'avant le glissement de rotation : points [yaw, pitch], gardée en pointillés pendant le glissement
    let lastTap = null;  // dernier appui sans glissement sur la droite : { t (ms), x, y (px) }
    let hoverLine = false, rotatedAt = 0;  // droite survolée (épaissie) ; instant (ms) de la fin d'une rotation (menu contextuel de la fin du clic droit)
    let drag = null, bound = null, readout = null, retry = null, waiting = null;
    let loupe = null, loupeSide = null, loupeTimer = null, wheelSide = null;  // loupe (éléments), poignée qu'elle suit, minuterie de la molette, poignée engagée par la molette
    // Calage Bird Eye de la photo (voir en tête) : state « none » (pas demandé), « waiting » (en cours), « done », « impossible » (reason : cause)
    let calage = { pic: null, state: "none", reason: "" }, calageTimer = null, calageApi = null;
    let anchors = { gauche: null, droit: null };  // [yaw, pitch] de chaque poignée déplacée à la main : sa place dans l'image
    let deadline = null, expired = false;  // deadline : minuterie du délai d'attente, expired : délai écoulé (repli sur la meilleure droite)

    /** Attentes en cours dont dépend la position de la droite : photos voisines (axe), relief du MNT (sol), verticales (inclinaison). */
    const pending = () => Boolean(line && !line.error && (line.voisines === false || line.sol_en_lecture || line.inclinaison_en_calcul));

    /** Droite définitive, donc tracée : une droite calculée dont toutes les attentes sont terminées, ou le délai écoulé. */
    const shown = () => Boolean(line && !line.error && (!pending() || expired || keep));

    /** Délai d'attente armé tant qu'une attente est en cours (à chaque nouveau calcul : photo changée, verticales relancées), désarmé
     * quand toutes sont terminées. Rend vrai si l'état affiché a changé (droite devenue définitive par le délai écoulé). */
    function settle() {
      if (!pending()) {
        clearTimeout(deadline);
        deadline = null;
        expired = false;
      } else if (!deadline && !expired) {
        deadline = setTimeout(() => {
          deadline = null;
          expired = true;
          if (active) draw();
        }, WAIT_MAX);
      }
    }

    /** Nouveau calcul (autre photo) : délai et attentes repartent de zéro. */
    function restartWait() {
      clearTimeout(deadline);
      deadline = null;
      expired = false;
    }

    /** Photo 360° (comme autotilt.is_360 en Python) : la droite au sol n'a de sens que sur une photo sphérique. */
    function is360(photo) {
      const props = photo?.properties || {};
      return Number(props["pers:interior_orientation"]?.field_of_view || 0) >= 360
        || props.exif?.["Xmp.GPano.ProjectionType"] === "equirectangular";
    }

    const available = () => Boolean(etat.psv && etat.photo && is360(etat.photo));
    const metres = (value, decimals = 2) => `${value.toFixed(decimals).replace(".", ",")} m`;

    // Calage Bird Eye ---------------------------------------------------------------------------

    /** Calage à demander et à lire (resultats.js) : state(pic) rend { ok } si la photo est déjà calée, start(pic) lance le calage (faux si
     * impossible). */
    function setCalage(api) {
      calageApi = api;
    }

    function resetCalage() {
      clearTimeout(calageTimer);
      calageTimer = null;
      calage = { pic: null, state: "none", reason: "" };
    }

    const calageWaiting = () => calage.state === "waiting" && calage.pic === photoId;

    /** Une poignée a été déplacée : calage Bird Eye de la photo demandé, une fois par photo (déjà fait, il est repris sans attente). */
    function needCalage() {
      if (!active || !calageApi || (calage.pic === photoId && calage.state !== "none")) return;
      resetCalage();
      calage.pic = photoId;
      const known = calageApi.state(photoId);
      if (known) {
        calage.state = known.ok ? "done" : "impossible";
        calage.reason = "";
        if (known.ok) reanchor();
      } else if (!calageApi.start(photoId)) {
        Object.assign(calage, { state: "impossible", reason: "" });
      } else {
        calage.state = "waiting";
        const pic = photoId;
        calageTimer = setTimeout(() => {
          if (!active || photoId !== pic || calage.state !== "waiting") return;
          Object.assign(calage, { state: "impossible", reason: "trop long" });
          draw();
        }, CALAGE_MAX);
      }
    }

    /** Calage de la photo pic fini (ok : inclinaison connue) : largeur recalculée avec elle si on l'attendait. */
    function calibrated(pic, ok) {
      if (!active || pic !== photoId || !calageWaiting()) return;
      clearTimeout(calageTimer);
      calageTimer = null;
      Object.assign(calage, { state: ok ? "done" : "impossible", reason: "" });
      if (load() && !line?.error) settle();
      if (ok) reanchor();
      draw();
      waitNeighbours(photoId);
    }

    /** Décalage (m) du point de la droite le plus proche (à l'écart angulaire le plus petit) de la direction (yaw, pitch) de la photo. */
    function offsetOfDirection(yaw, pitch) {
      const unit = (y, p) => [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
      const target = unit(yaw, pitch);
      let best = null, bestD = Infinity, previous = null;
      for (const [o, y, p] of line.points) {
        const v = unit(y, p);
        if (previous) {
          const [o0, a] = previous, d = v.map((c, k) => c - a[k]), n = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
          const t = Math.max(0, Math.min(1, target.reduce((sum, c, k) => sum + (c - a[k]) * d[k], 0) / n));
          const dist = Math.hypot(...a.map((c, k) => c + t * d[k] - target[k]));
          if (dist < bestD) [best, bestD] = [o0 + t * (o - o0), dist];
        }
        previous = [o, v];
      }
      return best;
    }

    /** Poignées déplacées à la main replacées sur leur point de l'image avec l'inclinaison calée : leur décalage en mètres change,
     * pas leur place dans la photo (la largeur est recalculée avec la photo calée). */
    function reanchor() {
      if (!line || line.error) return;
      const next = { ...handles };
      for (const side of ["gauche", "droit"]) {
        const o = moved[side] && anchors[side] ? offsetOfDirection(...anchors[side]) : null;
        if (o !== null) next[side] = Math.max(-line.reach, Math.min(line.reach, o));
      }
      if (next.droit - next.gauche >= MIN_GAP) handles = next;
    }

    // Calcul ------------------------------------------------------------------------------------

    /** Droite de la photo affichée (nose_line) : garde la réponse ; null et message d'erreur sans photo 360°. */
    function load(relief = true) {
      const text = etat.app ? etat.app.nose_line(depth ?? 0, rotation, relief) : JSON.stringify({ error: "Calcul en chargement…" });
      if (text === raw) return false;
      raw = text;
      line = JSON.parse(text);
      if (depth !== null && !line.error) depth = line.d;  // bornée par Python (butées)
      return true;
    }

    /** Bords de départ : ceux du profil en travers de cette photo s'il y en a un (bord par côté, x < 0 à gauche), sinon ±3 m. */
    function initialEdges() {
      const found = { gauche: null, droit: null };
      for (const p of etat.edgeProfile?.profile?.profils || []) {
        if (p.le_long === 0 && p.bord > MIN_OFFSET && p.bord <= 12) found[p.cote] = p.bord;
      }
      return { gauche: -(found.gauche ?? FALLBACK), droit: found.droit ?? FALLBACK };
    }

    /** Photo changée : droite recalculée ; les poignées déjà déplacées à la main restent où elles sont. */
    function reset() {
      rotation = 0;
      keep = false;
      const edges = initialEdges();
      for (const side of ["gauche", "droit"]) if (!moved[side]) handles[side] = edges[side];
    }

    /** [yaw, pitch] au décalage o (m), interpolé linéairement entre les deux points voisins du tableau : le décalage est
     * continu (pas de saut de 5 cm, visible en zoom). */
    function locate(o) {
      const pts = line.points, step = pts[1][0] - pts[0][0];
      const f = Math.max(0, Math.min(pts.length - 1, (o - pts[0][0]) / step));
      const i = Math.min(Math.floor(f), pts.length - 2), t = f - i, a = pts[i], b = pts[i + 1];
      return [a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
    }

    /** [lon, lat] au décalage o sur la carte : la droite est droite, interpolation linéaire entre ses deux extrémités. */
    function lonlatAt(o) {
      const [a, b] = line.lonlat, t = (o + line.reach) / (2 * line.reach);
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }

    /** Photo calée par Bird Eye (par ce calage-ci, ou déjà par la vue allumée ou un calage antérieur) : la droite est verte, sinon rouge. */
    const isCalibrated = () => (calage.pic === photoId && calage.state === "done") || Boolean(calageApi?.state(photoId)?.ok);
    const lineColor = () => (isCalibrated() ? GREEN : UNCALIBRATED);

    /** Distance de la droite en clair (« à 12,4 m »). */
    const depthText = () => `à ${metres(line.d, 1)}`;

    /** Droite et bords sur la carte (null : retirés). */
    function drawMap() {
      if (!map) return;
      if (!active || !shown() || !line.lonlat) return Carte.showNez(map, null);
      // trait du bord perpendiculaire à la droite : angle (° dans le sens horaire depuis le nord) de la droite + 90°
      const [a, b] = line.lonlat, lat = (a[1] + b[1]) / 2 * Math.PI / 180;
      const angle = Math.atan2((b[0] - a[0]) * Math.cos(lat), b[1] - a[1]) * 180 / Math.PI + 90;
      const point = (o, role) => ({ type: "Feature", properties: { angle, role }, geometry: { type: "Point", coordinates: lonlatAt(o) } });
      Carte.showNez(map, { type: "FeatureCollection", features: [
        { type: "Feature", properties: { couleur: lineColor() }, geometry: { type: "LineString", coordinates: line.lonlat } },
        // prolongement de la droite de la moitié de sa longueur de chaque côté, dans son axe (droite deux fois plus longue sur la carte : se
        // tourne par un clic droit glissé pour viser le centre d'un giratoire) ; plus fin et atténué, les bords et la mesure ne changent pas
        ...[[b, [b[0] + (b[0] - a[0]) / 2, b[1] + (b[1] - a[1]) / 2]], [a, [a[0] - (b[0] - a[0]) / 2, a[1] - (b[1] - a[1]) / 2]]].map((coordinates) => (
          { type: "Feature", properties: { couleur: lineColor(), prolongement: true }, geometry: { type: "LineString", coordinates } })),
        point(handles.gauche, "bord"), point(handles.droit, "bord")] });
    }

    // Lecture -----------------------------------------------------------------------------------

    /** Erreurs signées (m) de la position latérale lue d'un bord à s m de l'axe (négatif : à gauche), pour les trois sources
     * communes aux deux bords : [inclinaison, roulis restant, hauteur de caméra]. Au premier ordre, pour un rayon (d, s, −H) (devant,
     * à droite, vers le bas) qui coupe le sol : tangage δ → le rayon tourne autour de l'axe latéral, il touche le sol à l'échelle
     * H/(H+δd) : −s·d·δ/H ; roulis ρ → rotation autour de l'axe avant : ρ·(H + s²/H) ; hauteur H+e → s·e/H (docs/CALCULS.md § 8.8). */
    function commonErrors(s) {
      const { hauteur: h, d, sigma_h: sh } = line;
      return [-s * d * INCLINATION * toRad / h, ROLL * toRad * (h + s * s / h), s * sh / h];
    }

    /** Erreur (m) propre à un bord, indépendante de l'autre : altitude du MNT lue au point moins celle sous la caméra, donc √2 fois sa
     * précision (échelle s·Δz/H) ; rien à plat. */
    function ownError(s) {
      return line.sol_sigma ? Math.abs(s) * Math.SQRT2 * line.sol_sigma / line.hauteur : 0;
    }

    /** Incertitude (m) de la largeur entre deux bords, quel que soit leur côté : les erreurs d'inclinaison, de roulis et de hauteur
     * de la caméra sont communes aux deux bords, donc l'erreur de largeur de chacune est la différence signée de leurs effets ; les
     * erreurs propres à chaque bord (MNT) s'ajoutent en quadrature ; somme quadratique du tout (docs/CALCULS.md § 8.8). */
    function widthSigma(a, b) {
      const [ea, eb] = [commonErrors(a), commonErrors(b)];
      return Math.hypot(...ea.map((v, k) => eb[k] - v), ownError(a), ownError(b));
    }

    /** Écart de sol (m) au décalage o : altitude du MNT en ce point moins celle sous la caméra (interpolé ; 0 à plat). */
    function groundAt(o) {
      const pts = line.sol_dz;
      if (!pts) return 0;
      const f = Math.max(0, Math.min(pts.length - 1, (o - pts[0][0]) / (pts[1][0] - pts[0][0])));
      const i = Math.min(Math.floor(f), pts.length - 2);
      return pts[i][1] + (f - i) * (pts[i + 1][1] - pts[i][1]);
    }

    /** Rotation en clair (« tournée de 3,2° vers la gauche »), vide à 0°. */
    const rotationText = () => rotation === 0 ? ""
      : `tournée de ${Math.abs(rotation).toFixed(1).replace(".", ",")}° vers la ${rotation > 0 ? "gauche" : "droite"}`;

    const signed = (cm) => `${cm < 0 ? "−" : "+"}${Math.abs(Math.round(cm))} cm`;

    /** Source du sol et écart de sol aux deux poignées (« sol LiDAR HD : −8 cm à gauche, +3 cm à droite »). */
    function groundText() {
      if (line.sol_en_lecture) return rotation === 0 ? "sol plat (relief non arrivé)" : "relief en lecture…";
      if (!line.sol_dz) return `sol ${line.sol}`;
      return `sol ${line.sol} : ${signed(groundAt(handles.gauche) * 100)} à gauche, ${signed(groundAt(handles.droit) * 100)} à droite`;
    }

    const roundUp05 = (value) => Math.max(0.05, Math.ceil(value / 0.05 - 1e-9) * 0.05);

    /** Source de l'inclinaison de la photo, discrète ; provisoire seulement si le délai d'attente a écoulé avant l'arrivée des verticales. */
    function tiltText() {
      if (line.inclinaison_en_calcul) return "inclinaison provisoire (verticales non arrivées)";
      const source = line.inclinaison_source;
      if (!source || source === "aucune") return "";
      const shown = source === "roulis de campagne" ? "roulis de la campagne seul (tangage inconnu)" : source;
      return `inclinaison : ${shown}${line.inclinaison_sigma ? ` ±${line.inclinaison_sigma.toFixed(1).replace(".", ",")}°` : ""}`;
    }

    function showReadout() {
      if (!readout) {
        readout = document.createElement("div");
        readout.id = "nez-lecture";
        readout.innerHTML = `<small>Largeur dans la visionneuse · expérimental</small><span></span><small class="aide">${HELP}</small>`
          + "<button type=\"button\" id=\"nez-remise\" title=\"Remettre la droite perpendiculaire au trajet (rotation de 0°) ; double clic sur la droite : idem\">"
          + "Remettre perpendiculaire au trajet</button>";
        const reset = readout.querySelector("button");
        for (const type of ["pointerdown", "mousedown", "touchstart", "click"]) reset.addEventListener(type, (e) => e.stopPropagation());
        reset.addEventListener("click", resetRotation);
        $("#vue").append(readout);
      }
      readout.querySelector("button").disabled = rotation === 0;
      const text = readout.querySelector("span");
      if (!line || line.error) {
        text.textContent = line?.error || "Droite indisponible.";
        return;
      }
      if (!shown()) {
        text.textContent = "Calcul de la droite…";  // position pas encore définitive : rien n'est tracé
        readout.title = "";
        return;
      }
      if (calageWaiting()) {  // ni largeur provisoire ni ancienne : seulement l'attente
        text.textContent = CALAGE_WAIT;
        readout.title = "La photo est calée comme dans la vue Bird Eye (inclinaison tirée de la route, verticales, tangage), sans l'afficher ; "
          + "la largeur est recalculée avec elle ensuite.";
        return;
      }
      const width = handles.droit - handles.gauche;
      const uncertainty = roundUp05(widthSigma(handles.gauche, handles.droit));
      text.textContent = `Bord gauche ${offsetText(handles.gauche)} · Bord droit ${offsetText(handles.droit)} · Largeur ${metres(width)}`
        + ` · ±${metres(uncertainty)} · droite ${depthText()} devant la caméra`;
      const tilt = tiltText();
      if (tilt) text.textContent += ` · ${tilt}`;
      text.textContent += ` · ${groundText()}`;
      if (rotation !== 0) text.textContent += ` · ${rotationText()}`;
      if (calage.pic === photoId && calage.state === "impossible") {
        text.textContent += ` · Calage Bird Eye ${calage.reason || "impossible ici"} : largeur sans calage`;
      }
      if (line.voisines === false) text.textContent += " · axe de la photo seule (voisines non arrivées)";
      readout.title = `Distance latérale de chaque bord à la caméra, lue sur la droite au sol à ${metres(line.d, 1)} devant elle (butées : ${metres(line.d_min, 1)} à ${metres(line.d_max, 1)}) `
        + `(${line.sol_dz ? `relief du MNT ${line.sol}` : "sol plat"}). Hauteur de la caméra ${metres(line.hauteur)}${line.hauteur_source ? ` (${line.hauteur_source})` : ""}`
        + `${line.inclinaison_source === "roulis de campagne" ? `, roulis de la campagne ${line.roulis_campagne}°` : ""}. Expérimental : rien n'est retenu.`;
    }

    /** Position d'un bord par rapport à la caméra, avec son côté (« 1,20 m à droite »). */
    const offsetText = (o) => Math.abs(o) < 0.005 ? "au droit" : `${metres(Math.abs(o))} à ${o < 0 ? "gauche" : "droite"}`;

    /** Rotation remise à 0 (bouton de l'encart) : droite perpendiculaire au trajet, relief relu à 0° (déjà gardé en général). */
    function resetRotation() {
      if (rotation === 0) return;
      rotation = 0;
      load();
      settle();
      draw();
      waitNeighbours(photoId);
    }

    /** Droite, repère, poignées et étiquettes dans la seconde couche de Traits. */
    function draw() {
      showReadout();
      drawMap();
      if (!shown()) return Traits.setExtra();
      Traits.attach(etat.psv);
      const at = locate;
      // droite tracée seulement entre les poignées : points du tableau strictement entre elles, bouts interpolés par locate
      const points = [at(handles.gauche),
        ...line.points.filter(([o]) => o > handles.gauche && o < handles.droit).map(([, yaw, pitch]) => [yaw, pitch]),
        at(handles.droit)];
      const sides = [["gauche", handles.gauche], ["droit", handles.droit]];
      const turning = drag?.side === "rotation" && drag.started;  // rotation en cours : droite d'avant en pointillés fins, rotation affichée
      Traits.setExtra({
        lines: [...(turning && ghost ? [{ points: ghost, color: lineColor(), width: 1.5, dash: [5, 5], alpha: 0.7 }] : []),
          { points, color: lineColor(), width: hoverLine || drag?.line ? LINE_WIDTH_HOVER : LINE_WIDTH }],
        ticks: sides.map(([, o]) => ({ at: at(o), color: RED, length: TICK_PX, width: 3 })),
        // largeur entre les poignées : étiquette « mesure » des largeurs de Mesure (↔ valeur ± incertitude, comme l'encart),
        // au milieu de la droite ; les distances de chaque bord restent dans l'encart
        labels: [{ at: at((handles.gauche + handles.droit) / 2), type: "mesure", place: "dessus", lift: LABEL_LIFT, flip: true, flipLift: LABEL_FLIP,
          text: calageWaiting() ? CALAGE_WAIT
            : `↔ ${metres(handles.droit - handles.gauche)} ± ${metres(roundUp05(widthSigma(handles.gauche, handles.droit)))} · ${depthText()}${turning ? ` · ${rotationText()}` : ""}` }],
      });
    }

    // Glisser -----------------------------------------------------------------------------------

    /** Écran (px dans la visionneuse) d'une direction de la photo, ou null derrière la vue. */
    function screenOf(yaw, pitch) {
      const view = etat.psv.getPosition();
      const cos = Math.sin(pitch) * Math.sin(view.pitch) + Math.cos(pitch) * Math.cos(view.pitch) * Math.cos(yaw - view.yaw);
      if (cos <= 0.05) return null;
      return etat.psv.dataHelper.sphericalCoordsToViewerCoords({ yaw, pitch });
    }

    /** Distance (px) du point (x, y) au segment (ax, ay)-(bx, by). */
    function segmentDistance(x, y, ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(x - ax - t * dx, y - ay - t * dy);
    }

    /** Droite à LINE_PX px au plus de (x, y) : distance au tracé affiché (entre les deux poignées latérales). */
    function lineNear(x, y) {
      const pts = [locate(handles.gauche), ...line.points.filter(([o]) => o > handles.gauche && o < handles.droit).map(([, yaw, pitch]) => [yaw, pitch]), locate(handles.droit)];
      let previous = null;
      for (const [yaw, pitch] of pts) {
        const s = screenOf(yaw, pitch);
        if (previous && s && segmentDistance(x, y, previous.x, previous.y, s.x, s.y) <= LINE_PX) return true;
        previous = s;
      }
      return false;
    }

    /** Ce qui est saisi au point (x, y) de la visionneuse : « gauche » ou « droit » (poignée latérale à HANDLE_PX px au plus, la plus proche ;
     * prioritaire près des extrémités), « droite » (bande de saisie de la droite), ou null. */
    function handleAt(x, y) {
      if (!shown()) return null;
      let best = null, bestD = HANDLE_PX;
      for (const side of ["gauche", "droit"]) {
        const s = screenOf(...locate(handles[side]));
        const d = s ? segmentDistance(x, y, s.x, s.y - TICK_PX / 2, s.x, s.y + TICK_PX / 2) : Infinity;
        if (d <= bestD) [best, bestD] = [side, d];
      }
      return best ?? (lineNear(x, y) ? "droite" : null);
    }

    /** Décalage (m, continu) du point de la droite le plus proche de (x, y) à l'écran, du côté de la poignée : le pointeur est
     * projeté sur les segments entre points consécutifs du tableau (ceux devant la caméra), le décalage interpolé au point
     * projeté. null si aucun segment n'est visible. */
    function nearestOffset(side, x, y) {
      // bornes : jamais au-delà de la portée de la droite ni à moins de MIN_GAP de l'autre poignée (des deux côtés de la caméra)
      const low = side === "gauche" ? -line.reach : handles.gauche + MIN_GAP;
      const high = side === "gauche" ? handles.droit - MIN_GAP : line.reach;
      return projectOffset(x, y, low, high);
    }

    function projectOffset(x, y, low, high) {
      let best = null, bestD = Infinity, previous = null;
      for (const [o, yaw, pitch] of line.points) {
        const s = screenOf(yaw, pitch);
        const current = s ? [o, s.x, s.y] : null;
        if (previous && current) {
          const [o0, x0, y0] = previous, dx = current[1] - x0, dy = current[2] - y0;
          const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1)));
          const d = Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
          if (d < bestD) [best, bestD] = [o0 + t * (current[0] - o0), d];
        }
        previous = current;
      }
      return best === null ? null : Math.max(low, Math.min(high, best));
    }

    const local = (event) => {
      const box = etat.psv.container.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };

    /** Curseur et épaisseur selon ce qui est survolé (found : handleAt) : poignée latérale « grab », droite « ns-resize », saisie « grabbing ». */
    function setCursor(found, grabbing = false) {
      const classes = etat.psv.container.classList;
      classes.toggle("nez-poignee", found === "gauche" || found === "droit" || grabbing);
      classes.toggle("nez-glisse", grabbing);
      classes.toggle("nez-droite", found === "droite" && !grabbing);
      const on = found === "droite";
      if (on !== hoverLine) {
        hoverLine = on;
        if (active && shown()) draw();
      }
    }

    function onDown(event) {
      const mouse = event.pointerType === "mouse";
      if (!shown() || (mouse && event.button !== 0 && event.button !== 2)) return;
      const [x, y] = local(event), found = handleAt(x, y), right = mouse && event.button === 2;
      if (!found || (right && found !== "droite")) return;
      event.stopImmediatePropagation();  // la visionneuse ne tourne pas, ne mesure pas
      event.preventDefault();
      const rotating = found === "droite" && (right || event.shiftKey);  // clic droit, ou Maj + clic gauche (pavés tactiles, Mac)
      const side = found !== "droite" ? found : rotating ? "rotation" : "profondeur";
      const now = Date.now(), again = side === "profondeur" && lastTap && now - lastTap.t < DOUBLE_MS
        && Math.hypot(x - lastTap.x, y - lastTap.y) < TAP_PX;
      // started : le pointeur a bougé de plus de TAP_PX (sinon un simple clic ne change rien) ; double : deuxième appui d'un double clic
      drag = { side, id: event.pointerId, x, x0: x, y0: y, rotation, double: Boolean(again), started: side === "gauche" || side === "droit", line: found === "droite" };
      if (side === "rotation") ghost = [locate(handles.gauche), ...line.points.filter(([o]) => o > handles.gauche && o < handles.droit).map(([, yaw, pitch]) => [yaw, pitch]), locate(handles.droit)];
      if (side === "profondeur") {  // point de la droite saisi et écart du pointeur à lui (gardés : la droite suit le pointeur sans saut)
        drag.o = projectOffset(x, y, handles.gauche, handles.droit) ?? (handles.gauche + handles.droit) / 2;
        drag.grab = pointerPitch(x, y) - locate(drag.o)[1];
      }
      try {
        etat.psv.container.setPointerCapture(event.pointerId);
      } catch { /* pointeur déjà relâché : le glisser s'arrêtera au pointerup */ }
      setCursor(found, true);
      if (side === "gauche" || side === "droit") showLoupe(side);
    }

    function onMove(event) {
      if (!shown()) return;
      if (!drag) {
        setCursor(handleAt(...local(event)));
        return;
      }
      if (event.pointerId !== drag.id) return;
      event.stopImmediatePropagation();
      if (drag.double) return;  // deuxième appui d'un double clic : pas de glissement parasite
      const [x, y] = local(event);
      if (!drag.started) {
        if (Math.hypot(x - drag.x0, y - drag.y0) < TAP_PX) return;
        drag.started = true;
        drag.x = x;
        draw();  // droite d'avant en pointillés (rotation)
      }
      if (drag.side === "rotation") return rotateBy(x - drag.x, event.altKey, x);
      if (drag.side === "profondeur") return slideDepth(depthFromPointer(x, y));
      const o = nearestOffset(drag.side, x, y);
      if (o === null || o === handles[drag.side]) return;
      setHandle(drag.side, o);
    }

    /** Poignée latérale amenée au décalage o (m) : déplacée à la main, calage Bird Eye de la photo demandé (largeur masquée jusqu'à sa fin). */
    function setHandle(side, o) {
      handles[side] = o;
      moved[side] = true;
      anchors[side] = locate(o);
      needCalage();
      draw();
    }

    /** Élévation (rad) de la direction pointée dans la visionneuse. */
    const pointerPitch = (x, y) => etat.psv.dataHelper.viewerCoordsToSphericalCoords({ x, y }).pitch;

    /** Distance de la droite (m) qui amène la poignée de profondeur sous le pointeur (x, y) : même élévation, modèle de sol plat autour de
     * l'élévation actuelle de la poignée (l'inclinaison de la photo décale l'élévation de la même quantité près de ce point ; la droite
     * étant recalculée à chaque mouvement, l'écart ne s'accumule pas). Les butées sont appliquées par Python. */
    function depthFromPointer(x, y) {
      const o = drag.o, p0 = locate(o)[1], h = line.hauteur - groundAt(o);
      const dep0 = Math.atan2(h, Math.hypot(o, line.d));
      const dep = dep0 + (p0 - (pointerPitch(x, y) - drag.grab));  // pointeur plus haut dans l'image : droite plus loin (dépression moindre)
      if (dep <= 0.01) return line.d_max;
      return Math.sqrt(Math.max((h / Math.tan(dep)) ** 2 - o * o, 0));
    }

    /** Droite glissée à `value` m devant la caméra (au pas de DEPTH_STEP, butées de Python) : recalculée au plus une fois par image,
     * sans lecture du relief (celui déjà lu sert) ni calage ; les poignées latérales gardent leur écart en mètres, donc leur largeur. */
    function slideDepth(value) {
      const d = Math.round(Math.max(line.d_min, Math.min(line.d_max, value)) / DEPTH_STEP) * DEPTH_STEP;
      if (Math.abs(d - line.d) < 1e-6) return;
      depth = d;
      keep = true;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        if (!active || !drag) return;
        load(false);
        for (const side of ["gauche", "droit"]) if (moved[side]) anchors[side] = locate(handles[side]);  // place dans l'image à la nouvelle droite
        draw();
      });
    }

    /** Fin du glissement en profondeur : relief relu à la distance choisie, la droite restant affichée (keep) pendant la lecture. */
    function endSlide() {
      cancelAnimationFrame(frame);
      frame = null;
      load();
      for (const side of ["gauche", "droit"]) if (moved[side]) anchors[side] = locate(handles[side]);
      settle();
      draw();
      waitNeighbours(photoId);
    }

    // Loupe et molette -----------------------------------------------------------------------------

    /** Cran(s) de molette d'un événement, sans accélération : un événement de souris vaut un cran entier quel que soit son deltaY
     * (100, 120, 53… selon le système), un pavé tactile (petits deltaY) en fractions ; positif = vers le haut. */
    function wheelNotches(event) {
      if (event.deltaMode !== 0) return -Math.sign(event.deltaY);  // lignes ou pages : un cran
      return -Math.max(-1, Math.min(1, event.deltaY / WHEEL_NOTCH));
    }

    /** Poignée side déplacée de `notches` pixels de la photo affichée le long de la droite, vers l'extérieur de la chaussée si notches > 0 (molette vers
     * le haut) : le pas est donc fixé à l'écran, plus fin quand la visionneuse est zoomée. Mêmes bornes que le glissement. */
    function nudge(side, notches) {
      const o = handles[side], eps = 0.05;
      const c = screenOf(...locate(o)), a = screenOf(...locate(o - eps)), b = screenOf(...locate(o + eps));
      if (!c || !a || !b) return;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) return;
      const out = side === "gauche" ? -1 : 1, k = out * notches * WHEEL_PX / len;  // vers les décalages croissants (droite) ou décroissants (gauche)
      const low = side === "gauche" ? -line.reach : handles.gauche + MIN_GAP;
      const high = side === "gauche" ? handles.droit - MIN_GAP : line.reach;
      const next = projectOffset(c.x + (b.x - a.x) * k, c.y + (b.y - a.y) * k, low, high);
      if (next !== null && next !== o) setHandle(side, next);
    }

    /** Molette sur une poignée des bords : réglage fin (la visionneuse ne zoome pas) ; ailleurs, le zoom de la visionneuse. La poignée reste engagée
     * tant que la molette tourne (elle s'éloigne un peu du pointeur à chaque cran). */
    function onWheel(event) {
      if (!active || !shown() || drag) return;
      const side = wheelSide ?? handleAt(...local(event));
      if (side !== "gauche" && side !== "droit") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      wheelSide = side;
      showLoupe(side);
      clearTimeout(loupeTimer);
      loupeTimer = setTimeout(() => { wheelSide = null; hideLoupe(); }, LOUPE_HOLD);
      const notches = wheelNotches(event);
      if (notches) nudge(side, notches);
    }

    function showLoupe(side) {
      loupeSide = side;
      if (!loupe) {
        const root = document.createElement("div");
        root.id = "nez-loupe";
        root.setAttribute("aria-hidden", "true");
        root.innerHTML = "<div class=\"pastille\"><canvas class=\"photo\"></canvas><canvas class=\"calque\"></canvas></div><div class=\"legende\"></div>";
        const ratio = window.devicePixelRatio || 1;
        for (const canvas of root.querySelectorAll("canvas")) canvas.width = canvas.height = Math.round(LOUPE_PX * ratio);
        $("#vue").append(root);
        loupe = { root, photo: root.querySelector(".photo").getContext("2d"), over: root.querySelector(".calque").getContext("2d"),
          legend: root.querySelector(".legende") };
      }
      loupe.root.hidden = true;  // montrée à l'image suivante, une fois dessinée
      etat.psv.needsUpdate();
    }

    function hideLoupe() {
      loupeSide = null;
      clearTimeout(loupeTimer);
      loupeTimer = null;
      wheelSide = null;
      loupe?.root.remove();
      loupe = null;
    }

    /** Photo agrandie de la loupe : la scène de la visionneuse redessinée en plein format sur le seul carré (LOUPE_PX / LOUPE_ZOOM px de l'écran) autour du
     * point, par un décalage de vue de la caméra et un cadre réduit, puis relue ; à appeler pendant l'événement « render » (le tampon WebGL est vidé ensuite).
     * Repli (texture moins fine) : le carré de la vue déjà dessinée, agrandi. La vue normale est redessinée dans tous les cas. */
    function paintLoupePhoto(point, box) {
      const rend = etat.psv.renderer, renderer = rend.renderer, camera = rend.camera, element = renderer.domElement;
      const ratio = renderer.getPixelRatio(), size = LOUPE_PX, view = element.getBoundingClientRect();
      const cx = point.x - (view.left - box.left), cy = point.y - (view.top - box.top), half = size / LOUPE_ZOOM / 2;
      const target = loupe.photo, pixels = target.canvas.width;
      const saved = { copy(v) { Object.assign(this, { x: v.x, y: v.y, z: v.z, w: v.w }); return this; } };
      target.clearRect(0, 0, pixels, pixels);
      try {
        if (rend.customRenderer) throw new Error("rendu personnalisé");
        renderer.getViewport(saved);
        camera.setViewOffset(element.clientWidth, element.clientHeight, cx - half, cy - half, 2 * half, 2 * half);
        renderer.setViewport(0, 0, size, size);
        renderer.render(rend.scene, camera);
        target.drawImage(element, 0, element.height - size * ratio, size * ratio, size * ratio, 0, 0, pixels, pixels);
      } catch {
        const s = 2 * half * ratio;
        target.drawImage(element, cx * ratio - s / 2, cy * ratio - s / 2, s, s, 0, 0, pixels, pixels);
      } finally {
        if (camera.view) camera.clearViewOffset();
        if ("x" in saved) renderer.setViewport(saved.x, saved.y, saved.z, saved.w);
        (rend.customRenderer || renderer).render(rend.scene, camera);
      }
    }

    /** Longueur ronde (m) de la barre d'échelle : la plus grande de SCALE_LENGTHS qui tient dans SCALE_MAX_PX px de la loupe (la plus petite sinon) ;
     * ppm : px de la loupe par mètre au sol. */
    function scaleLength(ppm) {
      let best = SCALE_LENGTHS[0];
      for (const length of SCALE_LENGTHS) if (length * ppm <= SCALE_MAX_PX) best = length;
      return best;
    }

    const lengthText = (m) => m < 1 ? `${Math.round(m * 100)} cm` : `${String(m).replace(".", ",")} m`;

    /** Calque de la loupe : droite, poignées, réticule, barre d'échelle (px de la loupe : écran × LOUPE_ZOOM autour du point visé). */
    function paintLoupeOverlay(point, ppm) {
      const ctx = loupe.over, pixels = ctx.canvas.width, ratio = pixels / LOUPE_PX, c = LOUPE_PX / 2, Z = LOUPE_ZOOM;
      const map = (s) => [c + (s.x - point.x) * Z, c + (s.y - point.y) * Z];
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, LOUPE_PX, LOUPE_PX);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const pts = [locate(handles.gauche), ...line.points.filter(([o]) => o > handles.gauche && o < handles.droit).map(([, yaw, pitch]) => [yaw, pitch]),
        locate(handles.droit)];
      ctx.beginPath();
      let pen = false;
      for (const [yaw, pitch] of pts) {
        const s = screenOf(yaw, pitch);
        if (!s) { pen = false; continue; }
        const [x, y] = map(s);
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.strokeStyle = lineColor();
      ctx.lineWidth = 2;
      ctx.stroke();
      for (const side of ["gauche", "droit"]) {  // poignées agrandies, vide au milieu pour garder le point visé visible
        const s = screenOf(...locate(handles[side]));
        if (!s) continue;
        const [x, y] = map(s), half = TICK_PX * Z / 2, gap = 9;
        for (const [width, color] of [[5, "rgba(0,0,0,0.45)"], [3, RED]]) {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(x, y - half); ctx.lineTo(x, y - gap);
          ctx.moveTo(x, y + gap); ctx.lineTo(x, y + half);
          ctx.stroke();
        }
      }
      for (const [width, color] of [[3, "rgba(0,0,0,0.55)"], [1, "#fff"]]) {  // réticule fin, centre ouvert
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(c - 14, c); ctx.lineTo(c - 4, c); ctx.moveTo(c + 4, c); ctx.lineTo(c + 14, c);
        ctx.moveTo(c, c - 14); ctx.lineTo(c, c - 4); ctx.moveTo(c, c + 4); ctx.lineTo(c, c + 14);
        ctx.stroke();
      }
      if (ppm > 0) {  // barre d'échelle au bas de la pastille : longueur au sol ronde, mesurée le long de la droite
        const length = scaleLength(ppm), half = length * ppm / 2, y = LOUPE_PX - 18;
        for (const [width, color] of [[5, "rgba(0,0,0,0.6)"], [2, "#fff"]]) {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(c - half, y); ctx.lineTo(c + half, y);
          ctx.moveTo(c - half, y - 4); ctx.lineTo(c - half, y + 4);
          ctx.moveTo(c + half, y - 4); ctx.lineTo(c + half, y + 4);
          ctx.stroke();
        }
        ctx.font = "bold 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.strokeText(lengthText(length), c, y - 8);
        ctx.fillStyle = "#fff";
        ctx.fillText(lengthText(length), c, y - 8);
      }
    }

    /** Pièces de la visionneuse à ne pas recouvrir (px de la visionneuse) : barre d'outils, bandeaux, étiquettes de la photo et poignée de l'autre bord. */
    function loupeObstacles(box, other) {
      const rel = (r) => ({ left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top });
      const list = [];
      for (const element of document.querySelectorAll("#nez-lecture, #reglage-image, #haut-droite-vue, .bas-vue")) {
        const r = element.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) list.push(rel(r));
      }
      for (const r of Traits.labelRects()) list.push(rel(r));
      const s = screenOf(...locate(handles[other]));
      if (s) list.push({ left: s.x - 12, right: s.x + 12, top: s.y - TICK_PX / 2 - 6, bottom: s.y + TICK_PX / 2 + 6 });
      return list;
    }

    /** Loupe dessinée à l'événement « render » de la visionneuse (photo, calque, légende, place). Cachée si la poignée est derrière la vue. */
    function paintLoupe() {
      if (!loupe) return;
      const side = loupeSide, o = handles[side], other = side === "gauche" ? "droit" : "gauche";
      const point = screenOf(...locate(o));
      if (!active || !shown() || !point) { loupe.root.hidden = true; return; }
      const box = etat.psv.container.getBoundingClientRect();
      paintLoupePhoto(point, box);
      // échelle locale au sol : écart à l'écran de deux points de la droite à ±5 cm du bord
      const a = screenOf(...locate(o - 0.05)), b = screenOf(...locate(o + 0.05));
      const ppm = a && b ? LOUPE_ZOOM * Math.hypot(b.x - a.x, b.y - a.y) / 0.1 : 0;
      paintLoupeOverlay(point, ppm);
      const wrong = side === "gauche" ? o > 0 : o < 0;  // poignée passée de l'autre côté de la caméra
      loupe.legend.textContent = calageWaiting() ? "calage en cours…"
        : `bord ${side} : ${Math.abs(o) < 0.005 ? "au droit" : `${metres(Math.abs(o))}${wrong ? ` à ${o < 0 ? "gauche" : "droite"}` : ""}`}`;
      const at = Nez.placeLoupe(point, { w: LOUPE_W, h: LOUPE_H }, { w: box.width, h: box.height }, loupeObstacles(box, other));
      const vue = $("#vue").getBoundingClientRect();
      loupe.root.style.left = `${box.left - vue.left + at.left}px`;
      loupe.root.style.top = `${box.top - vue.top + at.top}px`;
      loupe.root.hidden = false;
    }

    // Droite sur la carte : mêmes gestes (profondeur le long du cap, rotation, double clic) ---------------

    /** Droite de la carte (prolongements compris) à LINE_PX px au plus du point (x, y) de la carte. */
    function mapLineNear(point) {
      if (!active || !shown() || !line.lonlat) return false;
      const [a, b] = line.lonlat;
      const p = map.project([a[0] - (b[0] - a[0]) / 2, a[1] - (b[1] - a[1]) / 2]), q = map.project([b[0] + (b[0] - a[0]) / 2, b[1] + (b[1] - a[1]) / 2]);
      return segmentDistance(point.x, point.y, p.x, p.y, q.x, q.y) <= LINE_PX;
    }

    /** Écart (m) du point lngLat à l'origine, le long du cap (perpendiculaire à la droite, vers l'avant). La droite va de gauche (a) à
     * droite (b), l'avant est à sa gauche (rotation de 90° dans le sens trigonométrique de (est, nord)). */
    function mapForward(lngLat, origin) {
      const [a, b] = line.lonlat, k = Math.cos(a[1] * toRad) * 111320;
      const [ue, un] = [(b[0] - a[0]) * k, (b[1] - a[1]) * 111320], norm = Math.hypot(ue, un) || 1;
      const [dx, dy] = [(lngLat.lng - origin.lng) * k, (lngLat.lat - origin.lat) * 111320];
      return (dx * -un + dy * ue) / norm;
    }

    let mapHover = false;

    /** Droite de la carte épaissie au survol ou pendant son glissement ; double clic de la carte (zoom) suspendu tant qu'elle est survolée. */
    function setMapHover(on) {
      if (on === mapHover) return;
      mapHover = on;
      if (map.getLayer("nez-droite")) {
        map.setPaintProperty("nez-droite", "line-width", ["case", ["boolean", ["get", "prolongement"], false], 1.5, on ? LINE_WIDTH_HOVER : LINE_WIDTH]);
      }
      if (on) map.doubleClickZoom.disable();
      else map.doubleClickZoom.enable();
    }

    function mapDown(event) {
      const original = event.originalEvent, button = original.button ?? 0;
      if (drag || (original.touches && original.touches.length > 1) || (button !== 0 && button !== 2) || !mapLineNear(event.point)) return;
      event.preventDefault();  // la carte ne se déplace pas
      map.dragPan.disable();
      const rotating = button === 2 || original.shiftKey;  // clic droit, ou Maj + clic gauche
      drag = { side: rotating ? "rotation" : "profondeur", map: true, line: true, x: event.point.x, x0: event.point.x, y0: event.point.y, rotation, started: false,
        origin: event.lngLat, d0: line.d };
      setMapHover(true);
    }

    function mapMove(event) {
      if (drag?.map) {
        if (!drag.started) {
          if (Math.hypot(event.point.x - drag.x0, event.point.y - drag.y0) < TAP_PX) return;
          drag.started = true;
          drag.x = event.point.x;
          if (drag.side === "rotation") ghost = [locate(handles.gauche), ...line.points.filter(([o]) => o > handles.gauche && o < handles.droit).map(([, yaw, pitch]) => [yaw, pitch]), locate(handles.droit)];  // aperçu en pointillés sur la photo
        }
        if (drag.side === "rotation") rotateBy(event.point.x - drag.x, event.originalEvent.altKey, event.point.x);
        else slideDepth(drag.d0 + mapForward(event.lngLat, drag.origin));  // le long du cap : distance de la droite
      } else if (active) {
        const on = mapLineNear(event.point);
        map.getCanvas().style.cursor = on ? "ns-resize" : "";
        setMapHover(on);
      }
    }

    function mapUp() {
      if (!drag?.map) return;
      const { started, side } = drag;
      drag = null;
      ghost = null;
      map.dragPan.enable();
      // le clic qui suit le relâchement sur la droite ne choisit pas une autre photo
      const container = map.getContainer(), stop = (e) => e.stopImmediatePropagation();
      container.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => container.removeEventListener("click", stop, { capture: true }), 100);
      if (!active) return;
      if (side === "rotation") rotatedAt = Date.now();
      if (!started) return draw();
      if (side === "rotation") finishRotation();
      else endSlide();
    }

    /** Double clic sur la droite de la carte : perpendiculaire au trajet (le zoom de la carte est suspendu tant que la droite est survolée). */
    function mapDouble(event) {
      if (!active || !mapLineNear(event.point)) return;
      event.preventDefault();
      resetRotation();
    }

    /** Menu contextuel du navigateur : bloqué quand le clic droit part de la droite (photo ou carte), pendant et juste après la rotation. */
    function blockMenu(event, over) {
      if (active && (drag?.line || Date.now() - rotatedAt < 600 || over)) event.preventDefault();
    }

    if (map) {
      map.on("mousedown", mapDown);
      map.on("touchstart", mapDown);
      map.on("mousemove", mapMove);
      map.on("touchmove", mapMove);
      map.on("mouseup", mapUp);
      map.on("touchend", mapUp);
      map.on("dblclick", mapDouble);
      window.addEventListener("mouseup", mapUp);
      map.getContainer().addEventListener("contextmenu", (event) => {
        const box = map.getContainer().getBoundingClientRect();
        blockMenu(event, mapLineNear({ x: event.clientX - box.left, y: event.clientY - box.top }));
      });
    }

    /** Rotation par glissement horizontal (dx px depuis le dernier appel, x : position du pointeur) : proportionnelle au déplacement
     * (ROTATION_RATE °/px, fine : 10 fois plus fin, Alt tenu), vers la droite = sens horaire (négatif). Droite recalculée au plus une fois par
     * image, sans lecture du relief (celui déjà lu sert) : la lecture au nouvel angle est lancée au relâchement (finishRotation). */
    function rotateBy(dx, fine, x) {
      const rate = fine ? ROTATION_RATE / 10 : ROTATION_RATE;
      drag.rotation += -dx * rate;  // cumulé : Alt en cours de route n'a pas d'effet rétroactif
      drag.x = x;
      const value = Math.round(Math.max(-ROTATION_MAX, Math.min(ROTATION_MAX, drag.rotation)) * 10) / 10;
      if (value === rotation) return;
      rotation = value;
      keep = true;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        if (!active || !drag) return;
        load(false);
        draw();
      });
    }

    /** Fin de la rotation : relief relu à l'angle choisi, la droite reste affichée (keep) pendant la lecture. */
    function finishRotation() {
      cancelAnimationFrame(frame);
      frame = null;
      load();
      settle();
      draw();
      waitNeighbours(photoId);
    }

    function onUp(event) {
      if (!drag || event.pointerId !== drag.id) return;
      event.stopImmediatePropagation();
      const { side, double: second, started } = drag;
      const [x1, y1] = local(event);
      try {
        etat.psv.container.releasePointerCapture(event.pointerId);
      } catch { /* déjà relâché */ }
      drag = null;
      ghost = null;  // pointillés retirés
      hideLoupe();
      if (side === "profondeur") {
        lastTap = null;
        if (second) resetRotation();  // double clic sur la droite : perpendiculaire au trajet
        else if (started) endSlide();
        else lastTap = { t: Date.now(), x: x1, y: y1 };  // appui sans glissement : premier clic possible
      } else if (side === "rotation") {
        rotatedAt = Date.now();
        if (started) finishRotation();
      }
      setCursor(handleAt(x1, y1));
      draw();
      // le clic qui suit le relâchement ne doit pas atteindre la visionneuse (mesure, photo voisine)
      const container = etat.psv.container, stop = (e) => e.stopImmediatePropagation();
      container.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => container.removeEventListener("click", stop, { capture: true }), 100);
    }

    /** mousedown et touchstart sur la droite ou une poignée : la visionneuse ne les voit pas (elle y verrait le début d'une rotation). */
    function onLegacyDown(event) {
      const t = event.touches ? event.touches[0] : event;
      if (t && shown() && handleAt(...local(t))) event.stopImmediatePropagation();
    }

    /** Double clic sur la droite : ni zoom ni navigation de la visionneuse (le double appui est lu dans onDown / onUp). */
    function onDouble(event) {
      if (shown() && handleAt(...local(event)) === "droite") event.stopImmediatePropagation();
    }

    const onMenu = (event) => blockMenu(event, shown() && handleAt(...local(event)) === "droite");

    function bind() {
      const container = etat.psv.container;
      container.addEventListener("dblclick", onDouble, true);
      bound = { container, down: onDown, move: onMove, up: onUp, legacy: onLegacyDown };
      container.addEventListener("pointerdown", onDown, true);
      container.addEventListener("pointermove", onMove, true);
      container.addEventListener("pointerup", onUp, true);
      container.addEventListener("pointercancel", onUp, true);
      container.addEventListener("mousedown", onLegacyDown, true);
      container.addEventListener("touchstart", onLegacyDown, true);
      container.addEventListener("contextmenu", onMenu, true);
      container.addEventListener("wheel", onWheel, { capture: true, passive: false });
      etat.psv.addEventListener("render", paintLoupe);
    }

    function unbind() {
      if (!bound) return;
      const { container } = bound;
      container.removeEventListener("dblclick", onDouble, true);
      container.removeEventListener("pointerdown", onDown, true);
      container.removeEventListener("pointermove", onMove, true);
      container.removeEventListener("pointerup", onUp, true);
      container.removeEventListener("pointercancel", onUp, true);
      container.removeEventListener("mousedown", onLegacyDown, true);
      container.removeEventListener("touchstart", onLegacyDown, true);
      container.removeEventListener("contextmenu", onMenu, true);
      container.removeEventListener("wheel", onWheel, { capture: true });
      etat.psv.removeEventListener("render", paintLoupe);
      hideLoupe();
      container.classList.remove("nez-poignee", "nez-glisse", "nez-droite");
      hoverLine = false;
      bound = null;
    }

    // Bouton ------------------------------------------------------------------------------------

    function activate() {
      if (!available()) return;
      if (!etat.app) {
        host.notice("Calcul en chargement : réessayez dans un instant.");
        return;
      }
      document.dispatchEvent(new CustomEvent("outil-visionneuse", { detail: "largeur" }));  // une seule fonction à la fois (hauteur, profil, largeur)
      active = true;
      moved = { gauche: false, droit: false };
      anchors = { gauche: null, droit: null };
      resetCalage();
      raw = null;
      depth = null;
      photoId = etat.photo.id;
      etat.app.birdeye_request();  // verticales de la photo (même calcul que la vue du dessus) ; la droite est refaite à leur arrivée
      restartWait();
      load();
      reset();
      bind();
      button.setAttribute("aria-pressed", "true");
      settle();
      draw();
      waitNeighbours(photoId);
    }

    /** Voisines de la photo (précédente, suivante) ou relief du MNT pas encore arrivés : la droite en dépend (axe de la séquence, sol). Nouvel essai toutes
     * les 0,3 s tant qu'une attente est en cours et que le délai (WAIT_MAX) n'est pas écoulé, et que la photo est la même ; la droite n'est tracée
     * qu'une fois définitive (shown), bords gardés. */
    function waitNeighbours(id) {
      clearTimeout(waiting);
      if (!active || expired || !pending()) return;
      waiting = setTimeout(() => {
        if (!active || !available() || etat.photo.id !== id) return;
        if (load()) {
          settle();
          draw();
        }
        waitNeighbours(id);
      }, 300);
    }

    function deactivate() {
      active = false;
      cancelAnimationFrame(frame);
      frame = null;
      rotation = 0;
      depth = null;
      keep = false;
      clearTimeout(retry);
      clearTimeout(waiting);
      restartWait();
      resetCalage();
      drag = null;
      ghost = null;
      if (map) {
        map.dragPan.enable();
        map.doubleClickZoom.enable();
        map.getCanvas().style.cursor = "";
      }
      unbind();
      raw = line = null;
      photoId = null;
      Traits.setExtra();
      drawMap();
      readout?.remove();
      readout = null;
      button.setAttribute("aria-pressed", "false");
    }

    button.addEventListener("click", () => (active ? deactivate() : activate()));
    document.addEventListener("outil-visionneuse", (event) => { if (active && event.detail !== "largeur") deactivate(); });

    /** Photo affichée changée (ou visionneuse prête) : bouton grisé sans photo 360°, droite refaite si le bouton est enfoncé. */
    function update() {
      const ok = available();
      button.disabled = !ok;
      if (!active) return;
      if (!ok) return deactivate();
      if (etat.photo.id !== photoId) {
        photoId = etat.photo.id;
        etat.app?.birdeye_request();
        resetCalage();
        drag = null;
        ghost = null;
        hideLoupe();
        map?.dragPan.enable();
        rotation = 0;
        depth = null;
          keep = false;
        restartWait();
        load();
        reset();
        settle();
        draw();
        waitNeighbours(photoId);
      }
    }

    /** Calcul Python modifié (inclinaison, hauteur de caméra arrivées) : droite refaite si elle a changé, au plus toutes les 0,3 s. */
    function changed() {
      if (!active || retry) return;
      retry = setTimeout(() => {
        retry = null;
        if (!active || !available()) return;
        const hadError = !line || line.error;
        if (!load()) return;
        if (hadError) reset();  // droite arrivée après une erreur (calcul en chargement) : bords de départ
        else if (calage.pic === photoId && calage.state === "done") reanchor();  // tangage affiné après le calage : poignées sur leur point de l'image
        settle();  // nouvelle attente (verticales relancées par des clics) : droite masquée jusqu'à sa position définitive
        draw();
        waitNeighbours(photoId);
      }, 300);
    }

    return { update, changed, setCalage, calibrated };
  },
};
