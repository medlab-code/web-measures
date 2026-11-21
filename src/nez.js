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
// Une poignée de profondeur (double flèche blanche ⇕ posée sur la droite, sur la photo comme sur la carte (sur celle-ci le long du cap) ; elle se glisse aussi le long de la droite) la fait glisser en profondeur, toujours
// perpendiculaire à l'axe du véhicule : butées renvoyées par nose_line (d_min : capot ; d_max : nez + écart à la photo suivante + 1 m,
// nez + 6 m sans suivante), les extrémités gardent leur écart latéral en mètres, la largeur est recalculée aussitôt, sans relancer
// le calage. La droite est rouge tant que la photo n'est pas calée (Bird Eye), puis verte ; sa distance est dans l'étiquette et l'encart.

const Nez = {
  /** Branche le bouton de la visionneuse ; host : etat (état partagé), map (carte MapLibre), notice. Rend update (photo affichée changée ou
   * visionneuse prête) et changed (calcul Python modifié : inclinaison, hauteur de caméra arrivées). */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const { etat, map } = host;
    const button = $("#nez-bords");

    const GREEN = "#00c853", UNCALIBRATED = "#ff5252", YELLOW = "#ffd600", RED = "#d93025", WHITE = "#ffffff";
    const NEZ_HANDLE = "nez-profondeur";  // couche de la carte (src/carte.js)
    // droite verte (photo calée) ou rouge franc (pas encore calée), sans liseré ; croix jaune au droit de la caméra, poignées latérales
    // rouges, poignée de profondeur blanche
    const ARROW_PX = 24;  // px : longueur de la double flèche de profondeur, centrée sur la droite
    const ARROW_CLEAR = 15 + 8 + 7 + 4;  // px : écart horizontal minimal de la flèche à la croix jaune (chevrons écartés au survol compris)
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
    const ROTATION_MAX = 45;  // degrés : rotation de la droite autour de la croix jaune, de part et d'autre de la perpendiculaire au trajet (comme NOSE_ROTATION_MAX en Python)
    const ROTATION_RATE = 0.1;  // degrés par px de glissement horizontal de la croix (Maj : 10 fois moins), précision de 0,1°
    const CALAGE_MAX = 90000;  // ms : attente au plus du calage Bird Eye, puis largeur sans calage
    const CALAGE_WAIT = "Calage Bird Eye en cours…";
    const DOUBLE_MS = 400, TAP_PX = 5;  // double clic sur la croix : délai entre les deux appuis, déplacement toléré (px)
    const CHEVRON_GAP = 1, CHEVRON_GAP_HOVER = 5, CHEVRON_MS = 120;  // px : écart des chevrons ‹ › à la croix au repos et au survol ; durée du déplacement
    const toRad = Math.PI / 180;

    let active = false, raw = null, line = null;  // raw : dernière réponse de nose_line (texte), line : son contenu
    let photoId = null;
    let handles = { gauche: -FALLBACK, droit: FALLBACK }, moved = { gauche: false, droit: false };
    let along = null;  // m : place de la double flèche de profondeur le long de la droite (null : au milieu des poignées latérales)
    let depth = null;  // m : distance de la droite devant la caméra (null : au nez, d_min)
    let rotation = 0, keep = false;  // rotation (degrés, positif = sens trigonométrique vu du dessus), keep : droite gardée affichée pendant la relecture du relief
    let frame = null;  // image d'animation en attente (recalcul de la droite pendant la rotation)
    let ghost = null;  // droite d'avant le glissement de la croix : points [yaw, pitch], gardée en pointillés pendant le glissement
    let lastTap = null;  // dernier appui sans glissement sur la croix : { t (ms), x (px) }
    let pivotHover = false, chevronGap = CHEVRON_GAP, chevronFrame = null;  // survol de la croix (chevrons écartés), écart animé en px
    let drag = null, bound = null, readout = null, retry = null, waiting = null;
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

    /** Décalage (m) de la poignée de profondeur le long de la droite : celui où l'utilisateur l'a glissée horizontalement (gardé en mètres quand
     * la droite glisse en profondeur, ramené entre les deux poignées latérales), sinon le milieu de celles-ci. */
    /** Décalage (m) où la double flèche est dessinée et saisie : celui de la poignée, écarté le long de la droite s'il tombait sur la croix jaune
     * et ses chevrons (du côté où il y a le plus de place entre les poignées latérales). */
    function arrowOffset() {
      const o = depthOffset(), c = screenOf(...locate(0)), s = screenOf(...locate(o));
      if (!c || !s || Math.abs(s.x - c.x) >= ARROW_CLEAR) return o;
      const sign = s.x >= c.x ? 1 : -1;
      for (const k of [sign, -sign]) {
        for (let i = 0, step = 0.1; i < 60; i++, step *= 1.15) {
          const t = o + k * step;
          if (t < handles.gauche || t > handles.droit) break;
          const u = screenOf(...locate(t));
          if (u && Math.abs(u.x - c.x) >= ARROW_CLEAR) return t;
        }
      }
      return o;
    }

    function depthOffset() {
      if (along !== null) return Math.max(handles.gauche, Math.min(handles.droit, along));  // placée à la main, gardée (mètres)
      return (handles.gauche + handles.droit) / 2;
    }

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
      if (map.getLayer(NEZ_HANDLE)) {  // flèche de profondeur : même taille que les icônes de la carte (16 px, 18 px en carte en grand ou détachée)
        const icon = parseFloat(getComputedStyle(map.getContainer()).getPropertyValue("--etiquette-icone")) || 16;
        map.setLayoutProperty(NEZ_HANDLE, "icon-size", icon / 16);
      }
      Carte.showNez(map, { type: "FeatureCollection", features: [
        { type: "Feature", properties: { couleur: lineColor() }, geometry: { type: "LineString", coordinates: line.lonlat } },
        // prolongement de la droite de la moitié de sa longueur de chaque côté, dans son axe (droite deux fois plus longue sur la carte : se
        // tourne par la croix jaune pour viser le centre d'un giratoire) ; plus fin et atténué, les bords et la mesure ne changent pas
        ...[[b, [b[0] + (b[0] - a[0]) / 2, b[1] + (b[1] - a[1]) / 2]], [a, [a[0] - (b[0] - a[0]) / 2, a[1] - (b[1] - a[1]) / 2]]].map((coordinates) => (
          { type: "Feature", properties: { couleur: lineColor(), prolongement: true }, geometry: { type: "LineString", coordinates } })),
        point(handles.gauche, "bord"), point(handles.droit, "bord"), point(depthOffset(), "profondeur")] });
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
        readout.innerHTML = "<small>Largeur dans la visionneuse · expérimental</small><span></span>"
          + "<button type=\"button\" id=\"nez-remise\" title=\"Remettre la droite perpendiculaire au trajet (rotation de 0°) ; double clic sur la croix jaune : idem\">"
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
      const turning = drag?.side === "pivot";  // rotation en cours : droite d'avant en pointillés fins, rotation affichée
      Traits.setExtra({
        lines: [...(turning && ghost ? [{ points: ghost, color: lineColor(), width: 1.5, dash: [5, 5], alpha: 0.7 }] : []),
          { points, color: lineColor(), width: 2.5 }],
        crosses: [{ at: at(0), color: YELLOW }],  // croix au droit de la caméra
        ticks: [{ at: at(0), color: YELLOW, width: 2.5, chevron: -1, gap: chevronGap }, { at: at(0), color: YELLOW, width: 2.5, chevron: 1, gap: chevronGap },
          ...sides.map(([, o]) => ({ at: at(o), color: RED, length: TICK_PX, width: 3 })),
          { at: at(arrowOffset()), color: WHITE, length: ARROW_PX, width: 3, double: true }],  // poignée de profondeur ⇕, sur la droite
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

    /** Poignée à HANDLE_PX px au plus du point (x, y) de la visionneuse (la plus proche), ou null. */
    function handleAt(x, y) {
      if (!shown()) return null;
      let best = null, bestD = HANDLE_PX;
      const c = screenOf(...locate(0));  // croix jaune : pivot de la rotation, prise si aucune poignée n'est plus près
      if (c && Math.hypot(x - c.x, y - c.y) <= HANDLE_PX) [best, bestD] = ["pivot", Math.hypot(x - c.x, y - c.y)];
      for (const side of ["gauche", "droit"]) {
        const s = screenOf(...locate(handles[side]));
        const d = s ? segmentDistance(x, y, s.x, s.y - TICK_PX / 2, s.x, s.y + TICK_PX / 2) : Infinity;
        if (d <= bestD) [best, bestD] = [side, d];
      }
      const m = screenOf(...locate(arrowOffset()));  // double flèche de profondeur, sur la droite : prise en cas d'égalité
      const dm = m ? segmentDistance(x, y, m.x, m.y - ARROW_PX / 2, m.x, m.y + ARROW_PX / 2) : Infinity;
      if (dm <= bestD) best = "profondeur";
      return best;
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

    /** Place de la double flèche : décalage du point de la droite le plus proche du pointeur, entre les deux poignées latérales. */
    const nearestAlong = (x, y) => projectOffset(x, y, handles.gauche, handles.droit);

    function projectOffset(x, y, low, high) {      let best = null, bestD = Infinity, previous = null;
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

    function setCursor(hover, grabbing = false, pivot = false) {
      const classes = etat.psv.container.classList;
      classes.toggle("nez-poignee", hover || grabbing);
      classes.toggle("nez-glisse", grabbing);
      classes.toggle("nez-pivot", pivot);  // croix : curseur ⇔ (glisser à gauche ou à droite)
      spreadChevrons(pivot);
    }

    /** Chevrons de la croix écartés au survol (et pendant son glissement), rapprochés sinon : écart animé sur CHEVRON_MS. */
    function spreadChevrons(on) {
      if (on === pivotHover) return;
      pivotHover = on;
      cancelAnimationFrame(chevronFrame);
      const from = chevronGap, to = on ? CHEVRON_GAP_HOVER : CHEVRON_GAP, t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / CHEVRON_MS);
        chevronGap = from + (to - from) * k;
        if (active && shown()) draw();
        chevronFrame = k < 1 ? requestAnimationFrame(step) : null;
      };
      chevronFrame = requestAnimationFrame(step);
    }

    function onDown(event) {
      if (!shown() || (event.pointerType === "mouse" && event.button !== 0)) return;
      const side = handleAt(...local(event));
      if (!side) return;
      event.stopImmediatePropagation();  // la visionneuse ne tourne pas, ne mesure pas
      event.preventDefault();
      const now = Date.now(), again = side === "pivot" && lastTap && now - lastTap.t < DOUBLE_MS && Math.abs(local(event)[0] - lastTap.x) < TAP_PX;
      drag = { side, id: event.pointerId, x: local(event)[0], x0: local(event)[0], rotation, double: Boolean(again) };  // double : deuxième appui d'un double clic
      if (side === "pivot") ghost = [locate(handles.gauche), ...line.points.filter(([o]) => o > handles.gauche && o < handles.droit).map(([, yaw, pitch]) => [yaw, pitch]), locate(handles.droit)];
      if (side === "profondeur") [drag.o, drag.grab] = [arrowOffset(), pointerPitch(...local(event)) - locate(arrowOffset())[1]];  // place de la flèche et écart du pointeur à elle, gardés  // écart du pointeur à la poignée, gardé
      try {
        etat.psv.container.setPointerCapture(event.pointerId);
      } catch { /* pointeur déjà relâché : le glisser s'arrêtera au pointerup */ }
      setCursor(true, true, side === "pivot");
    }

    function onMove(event) {
      if (!shown()) return;
      if (!drag) {
        const found = handleAt(...local(event));
        setCursor(Boolean(found), false, found === "pivot");
        return;
      }
      if (event.pointerId !== drag.id) return;
      event.stopImmediatePropagation();
      if (drag.side === "pivot") return drag.double ? undefined : rotate(event);  // double clic : pas de rotation parasite
      if (drag.side === "profondeur") {  // vertical : distance de la droite ; horizontal : place de la flèche le long de la droite
        const [x, y] = local(event), o = nearestAlong(x, y);
        if (o !== null && o !== depthOffset()) {
          along = o;
          draw();
        }
        return slideDepth(depthFromPointer(x, y));
      }
      const o = nearestOffset(drag.side, ...local(event));
      if (o === null || o === handles[drag.side]) return;
      handles[drag.side] = o;
      moved[drag.side] = true;
      anchors[drag.side] = locate(o);
      needCalage();  // calage Bird Eye de la photo : largeur masquée jusqu'à sa fin
      draw();
    }

    /** Élévation (rad) de la direction pointée dans la visionneuse. */
    const pointerPitch = (x, y) => etat.psv.dataHelper.viewerCoordsToSphericalCoords({ x, y }).pitch;

    /** Distance de la droite (m) qui amène la poignée de profondeur sous le pointeur (x, y) : même élévation, modèle de sol plat autour de
     * l'élévation actuelle de la poignée (l'inclinaison de la photo décale l'élévation de la même quantité près de ce point ; la droite
     * étant recalculée à chaque mouvement, l'écart ne s'accumule pas). Les butées sont appliquées par Python. */
    function depthFromPointer(x, y) {
      const o = drag.o ?? depthOffset(), p0 = locate(o)[1], h = line.hauteur - groundAt(o);
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

    // Poignée de profondeur sur la carte : glissée le long du cap (perpendiculaire à la droite) ---------------

    const mapHandleAt = (point) => Boolean(map.getLayer(NEZ_HANDLE)
      && map.queryRenderedFeatures([[point.x - 8, point.y - 8], [point.x + 8, point.y + 8]], { layers: [NEZ_HANDLE] }).length);

    /** Écarts (m) du point lngLat à la poignée de profondeur : [le long de la droite vers la droite, le long du cap vers l'avant]. La droite va
     * de gauche (a) à droite (b), l'avant est à sa gauche (rotation de 90° dans le sens trigonométrique de (est, nord)). */
    function mapOffsets(lngLat) {
      const [a, b] = line.lonlat, here = lonlatAt(depthOffset()), k = Math.cos(a[1] * toRad) * 111320;
      const [ue, un] = [(b[0] - a[0]) * k, (b[1] - a[1]) * 111320], norm = Math.hypot(ue, un) || 1;
      const [dx, dy] = [(lngLat.lng - here[0]) * k, (lngLat.lat - here[1]) * 111320];
      return [(dx * ue + dy * un) / norm, (dx * -un + dy * ue) / norm];
    }

    function mapDown(event) {
      if (!active || !shown() || !line.lonlat || drag || !mapHandleAt(event.point)) return;
      event.preventDefault();
      map.dragPan.disable();
      drag = { side: "profondeur", map: true };
    }

    function mapMove(event) {
      if (drag?.map) {  // le long du cap : distance de la droite ; le long de la droite : place de la poignée (sans toucher à la mesure)
        const [side, forward] = mapOffsets(event.lngLat);
        along = Math.max(handles.gauche, Math.min(handles.droit, depthOffset() + side));
        slideDepth(line.d + forward);
        draw();
      }
      else if (active) map.getCanvas().style.cursor = shown() && mapHandleAt(event.point) ? "ns-resize" : "";
    }

    function mapUp() {
      if (!drag?.map) return;
      drag = null;
      map.dragPan.enable();
      if (active) endSlide();
    }

    if (map) {
      map.on("mousedown", mapDown);
      map.on("touchstart", mapDown);
      map.on("mousemove", mapMove);
      map.on("touchmove", mapMove);
      map.on("mouseup", mapUp);
      map.on("touchend", mapUp);
      window.addEventListener("mouseup", mapUp);
    }

    /** Rotation par glissement horizontal de la croix : proportionnelle au déplacement (ROTATION_RATE °/px, Maj : 10 fois plus fin),
     * vers la droite = sens horaire (négatif). Droite recalculée au plus une fois par image, sans lecture du relief (celui déjà lu
     * sert) : la lecture au nouvel angle est lancée au relâchement. */
    function rotate(event) {
      const rate = event.shiftKey ? ROTATION_RATE / 10 : ROTATION_RATE;
      drag.rotation += -(local(event)[0] - drag.x) * rate;  // cumulé : Maj en cours de route n'a pas d'effet rétroactif
      drag.x = local(event)[0];
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

    function onUp(event) {
      if (!drag || event.pointerId !== drag.id) return;
      event.stopImmediatePropagation();
      if (drag.side === "profondeur") endSlide();
      if (drag.side === "pivot" && drag.double) {  // double clic sur la croix : droite perpendiculaire au trajet
        lastTap = null;
        resetRotation();
      } else if (drag.side === "pivot") {
        lastTap = Math.abs(local(event)[0] - drag.x0) < TAP_PX ? { t: Date.now(), x: local(event)[0] } : null;  // appui sans glissement : premier clic possible
        cancelAnimationFrame(frame);
        frame = null;
        load();  // relief relu à l'angle choisi ; la droite reste affichée (keep) pendant la lecture
        settle();
        draw();
        waitNeighbours(photoId);
      }
      try {
        etat.psv.container.releasePointerCapture(event.pointerId);
      } catch { /* déjà relâché */ }
      drag = null;
      ghost = null;  // pointillés retirés
      const found = handleAt(...local(event));
      setCursor(found !== null, false, found === "pivot");
      draw();
      // le clic qui suit le relâchement ne doit pas atteindre la visionneuse (mesure, photo voisine)
      const container = etat.psv.container, stop = (e) => e.stopImmediatePropagation();
      container.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => container.removeEventListener("click", stop, { capture: true }), 100);
    }

    /** mousedown et touchstart sur une poignée : la visionneuse ne les voit pas (elle y verrait le début d'une rotation). */
    function onLegacyDown(event) {
      const t = event.touches ? event.touches[0] : event;
      if (t && shown() && handleAt(...local(t))) event.stopImmediatePropagation();
    }

    /** Double clic sur la croix : ni zoom ni navigation de la visionneuse (le double appui est lu dans onDown / onUp). */
    function onDouble(event) {
      if (shown() && handleAt(...local(event)) === "pivot") event.stopImmediatePropagation();
    }

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
      container.classList.remove("nez-poignee", "nez-glisse", "nez-pivot");
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
      along = null;
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
      along = null;
      keep = false;
      clearTimeout(retry);
      clearTimeout(waiting);
      restartWait();
      resetCalage();
      drag = null;
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
        rotation = 0;
        depth = null;
        along = null;
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
