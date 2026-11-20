// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// « Bords sur la photo » (expérimental, piste P22, étape 1) : une droite tracée au sol juste devant le nez du véhicule,
// perpendiculaire à la trajectoire de la séquence (calcul : App.nose_line, py/web_nez.py), et deux poignées, gauche et
// droite, que l'on fait glisser le long d'elle jusqu'aux bords de la route. Lecture en direct de la distance de chaque
// bord à la caméra et de la largeur, avec leur incertitude. Rien n'est retenu ni reporté dans le graphique du profil :
// les poignées ne servent qu'à lire. Tracé dans la seconde couche de Traits (setExtra), que les mesures n'écrasent pas ;
// la droite et ses deux bords sont aussi tracés sur la carte (Carte.showNez) pour juger qu'elle est perpendiculaire à la route.

const Nez = {
  /** Branche le bouton de la visionneuse ; host : etat (état partagé), map (carte MapLibre), notice. Rend update (photo affichée changée ou
   * visionneuse prête) et changed (calcul Python modifié : inclinaison, hauteur de caméra arrivées). */
  init(host) {
    const $ = (selector) => document.querySelector(selector);
    const { etat, map } = host;
    const button = $("#nez-bords");

    const GREEN = "#00c853", YELLOW = "#ffd600", DARK = "#202020", RED = "#d93025";  // droite verte liserée de sombre (lisible sur l'herbe comme sur l'enrobé), croix jaune au droit de la caméra, poignées rouges
    const TICK_PX = 28;  // px : longueur à l'écran d'une poignée (trait vertical, quel que soit le zoom)
    const HANDLE_PX = 10;  // px : portée d'une poignée (distance du pointeur au trait)
    const MIN_OFFSET = 0.2;  // m : bord minimal d'un profil en travers repris comme position de départ d'une poignée
    const MIN_GAP = 0.1;  // m : écart minimal entre les deux poignées (l'une ne dépasse pas l'autre pendant le glissement)
    const WAIT_MAX = 12000;  // ms : attente au plus de la position définitive de la droite (deux lectures du MNT de 5 s au plus), puis meilleure droite disponible
    const FALLBACK = 3;  // m : bords de départ sans profil en travers
    const INCLINATION = 0.5, ROLL = 0.5;  // degrés : incertitude de l'inclinaison de la photo et du roulis restant (docs/CALCULS.md)
    const toRad = Math.PI / 180;

    let active = false, raw = null, line = null;  // raw : dernière réponse de nose_line (texte), line : son contenu
    let photoId = null;
    let handles = { gauche: -FALLBACK, droit: FALLBACK }, moved = { gauche: false, droit: false };
    let drag = null, bound = null, readout = null, retry = null, waiting = null;
    let deadline = null, expired = false;  // deadline : minuterie du délai d'attente, expired : délai écoulé (repli sur la meilleure droite)

    /** Attentes en cours dont dépend la position de la droite : photos voisines (axe), relief du MNT (sol), verticales (inclinaison). */
    const pending = () => Boolean(line && !line.error && (line.voisines === false || line.sol_en_lecture || line.inclinaison_en_calcul));

    /** Droite définitive, donc tracée : une droite calculée dont toutes les attentes sont terminées, ou le délai écoulé. */
    const shown = () => Boolean(line && !line.error && (!pending() || expired));

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

    // Calcul ------------------------------------------------------------------------------------

    /** Droite de la photo affichée (nose_line) : garde la réponse ; null et message d'erreur sans photo 360°. */
    function load() {
      const text = etat.app ? etat.app.nose_line() : JSON.stringify({ error: "Calcul en chargement…" });
      if (text === raw) return false;
      raw = text;
      line = JSON.parse(text);
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

    /** Droite et bords sur la carte (null : retirés). */
    function drawMap() {
      if (!map) return;
      if (!active || !shown() || !line.lonlat) return Carte.showNez(map, null);
      const point = (o) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: lonlatAt(o) } });
      Carte.showNez(map, { type: "FeatureCollection", features: [
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line.lonlat } },
        point(handles.gauche), point(handles.droit)] });
    }

    // Lecture -----------------------------------------------------------------------------------

    /** Incertitude (m) du bord à s m de l'axe : inclinaison, roulis restant, hauteur de caméra et altitude du MNT, lue en différence
     * avec le sol sous la caméra, donc √2 fois sa précision ; rien de plus à plat (docs/CALCULS.md). */
    function sigma(s) {
      return Math.hypot(...terms(Math.abs(s)));
    }

    /** Les quatre termes d'incertitude (m) d'un bord à s m de l'axe (s ≥ 0) : inclinaison, roulis, hauteur de caméra, MNT. */
    function terms(s) {
      const { hauteur: h, d, sigma_h: sh, sol_sigma: sg } = line;
      return [(h * h + d * d) / h * INCLINATION * toRad, s * s * ROLL * toRad / h, s * sh / h, sg ? s * Math.SQRT2 * sg / h : 0];
    }

    /** Incertitude (m) de la largeur entre deux bords. De part et d'autre de la caméra : somme quadratique des deux bords. Du même
     * côté, les erreurs d'inclinaison, de roulis et de hauteur de la caméra sont communes aux deux bords (même sens) : seule leur
     * différence compte ; l'altitude du MNT, lue en deux points, reste indépendante (docs/CALCULS.md § 8.8). */
    function widthSigma(a, b) {
      if (a * b < 0) return Math.hypot(sigma(a), sigma(b));
      const [ta, tb] = [terms(Math.min(Math.abs(a), Math.abs(b))), terms(Math.max(Math.abs(a), Math.abs(b)))];
      return Math.hypot(0, tb[1] - ta[1], tb[2] - ta[2], Math.hypot(ta[3], tb[3]));
    }

    /** Écart de sol (m) au décalage o : altitude du MNT en ce point moins celle sous la caméra (interpolé ; 0 à plat). */
    function groundAt(o) {
      const pts = line.sol_dz;
      if (!pts) return 0;
      const f = Math.max(0, Math.min(pts.length - 1, (o - pts[0][0]) / (pts[1][0] - pts[0][0])));
      const i = Math.min(Math.floor(f), pts.length - 2);
      return pts[i][1] + (f - i) * (pts[i + 1][1] - pts[i][1]);
    }

    const signed = (cm) => `${cm < 0 ? "−" : "+"}${Math.abs(Math.round(cm))} cm`;

    /** Source du sol et écart de sol aux deux poignées (« sol LiDAR HD : −8 cm à gauche, +3 cm à droite »). */
    function groundText() {
      if (line.sol_en_lecture) return "sol plat (relief non arrivé)";
      if (!line.sol_dz) return `sol ${line.sol}`;
      return `sol ${line.sol} : ${signed(groundAt(handles.gauche) * 100)} à gauche, ${signed(groundAt(handles.droit) * 100)} à droite`;
    }

    const roundUp05 = (value) => Math.max(0.05, Math.ceil(value / 0.05 - 1e-9) * 0.05);

    /** Source de l'inclinaison de la photo, discrète ; provisoire seulement si le délai d'attente a écoulé avant l'arrivée des verticales. */
    function tiltText() {
      if (line.inclinaison_en_calcul) return "inclinaison provisoire (verticales non arrivées)";
      const source = line.inclinaison_source;
      if (!source || source === "aucune") return "";
      return `inclinaison : ${source}${line.inclinaison_sigma ? ` ±${line.inclinaison_sigma.toFixed(1).replace(".", ",")}°` : ""}`;
    }

    function showReadout() {
      if (!readout) {
        readout = document.createElement("div");
        readout.id = "nez-lecture";
        readout.innerHTML = "<small>Bords sur la photo · expérimental</small><span></span>";
        $("#vue").append(readout);
      }
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
      const width = handles.droit - handles.gauche;
      const uncertainty = roundUp05(widthSigma(handles.gauche, handles.droit));
      text.textContent = `Bord gauche ${offsetText(handles.gauche)} · Bord droit ${offsetText(handles.droit)} · Largeur ${metres(width)}`
        + ` · ±${metres(uncertainty)}`;
      const tilt = tiltText();
      if (tilt) text.textContent += ` · ${tilt}`;
      text.textContent += ` · ${groundText()}`;
      if (line.voisines === false) text.textContent += " · axe de la photo seule (voisines non arrivées)";
      readout.title = `Distance latérale de chaque bord à la caméra, lue sur la droite au sol à ${metres(line.d, 1)} devant elle `
        + `(${line.sol_dz ? `relief du MNT ${line.sol}` : "sol plat"}). Hauteur de la caméra ${metres(line.hauteur)}${line.hauteur_source ? ` (${line.hauteur_source})` : ""}`
        + `${line.inclinaison_source === "roulis de campagne" ? `, roulis de la campagne ${line.roulis_campagne}°` : ""}. Expérimental : rien n'est retenu.`;
    }

    /** Position d'un bord par rapport à la caméra, avec son côté (« 1,20 m à droite »). */
    const offsetText = (o) => Math.abs(o) < 0.005 ? "au droit" : `${metres(Math.abs(o))} à ${o < 0 ? "gauche" : "droite"}`;

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
      Traits.setExtra({
        lines: [{ points, color: DARK, width: 5 }, { points, color: GREEN, width: 2.5 }],
        crosses: [{ at: at(0), color: YELLOW }],  // croix au droit de la caméra
        ticks: sides.map(([, o]) => ({ at: at(o), color: RED, edge: "#ffffff", length: TICK_PX, width: 3 })),
        // largeur entre les poignées : étiquette « mesure » des largeurs de Mesure (↔ valeur ± incertitude, comme l'encart),
        // au milieu de la droite ; les distances de chaque bord restent dans l'encart
        labels: [{ at: at((handles.gauche + handles.droit) / 2), type: "mesure", place: "dessus",
          text: `↔ ${metres(handles.droit - handles.gauche)} ± ${metres(roundUp05(widthSigma(handles.gauche, handles.droit)))}` }],
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
      for (const side of ["gauche", "droit"]) {
        const s = screenOf(...locate(handles[side]));
        const d = s ? segmentDistance(x, y, s.x, s.y - TICK_PX / 2, s.x, s.y + TICK_PX / 2) : Infinity;
        if (d <= bestD) [best, bestD] = [side, d];
      }
      return best;
    }

    /** Décalage (m, continu) du point de la droite le plus proche de (x, y) à l'écran, du côté de la poignée : le pointeur est
     * projeté sur les segments entre points consécutifs du tableau (ceux devant la caméra), le décalage interpolé au point
     * projeté. null si aucun segment n'est visible. */
    function nearestOffset(side, x, y) {
      // bornes : jamais au-delà de la portée de la droite ni à moins de MIN_GAP de l'autre poignée (des deux côtés de la caméra)
      const low = side === "gauche" ? -line.reach : handles.gauche + MIN_GAP;
      const high = side === "gauche" ? handles.droit - MIN_GAP : line.reach;
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

    function setCursor(hover, grabbing = false) {
      const classes = etat.psv.container.classList;
      classes.toggle("nez-poignee", hover || grabbing);
      classes.toggle("nez-glisse", grabbing);
    }

    function onDown(event) {
      if (!shown() || (event.pointerType === "mouse" && event.button !== 0)) return;
      const side = handleAt(...local(event));
      if (!side) return;
      event.stopImmediatePropagation();  // la visionneuse ne tourne pas, ne mesure pas
      event.preventDefault();
      drag = { side, id: event.pointerId };
      try {
        etat.psv.container.setPointerCapture(event.pointerId);
      } catch { /* pointeur déjà relâché : le glisser s'arrêtera au pointerup */ }
      setCursor(true, true);
    }

    function onMove(event) {
      if (!shown()) return;
      if (!drag) {
        setCursor(Boolean(handleAt(...local(event))));
        return;
      }
      if (event.pointerId !== drag.id) return;
      event.stopImmediatePropagation();
      const o = nearestOffset(drag.side, ...local(event));
      if (o === null || o === handles[drag.side]) return;
      handles[drag.side] = o;
      moved[drag.side] = true;
      draw();
    }

    function onUp(event) {
      if (!drag || event.pointerId !== drag.id) return;
      event.stopImmediatePropagation();
      try {
        etat.psv.container.releasePointerCapture(event.pointerId);
      } catch { /* déjà relâché */ }
      drag = null;
      setCursor(handleAt(...local(event)) !== null);
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

    function bind() {
      const container = etat.psv.container;
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
      container.removeEventListener("pointerdown", onDown, true);
      container.removeEventListener("pointermove", onMove, true);
      container.removeEventListener("pointerup", onUp, true);
      container.removeEventListener("pointercancel", onUp, true);
      container.removeEventListener("mousedown", onLegacyDown, true);
      container.removeEventListener("touchstart", onLegacyDown, true);
      container.classList.remove("nez-poignee", "nez-glisse");
      bound = null;
    }

    // Bouton ------------------------------------------------------------------------------------

    function activate() {
      if (!available()) return;
      if (!etat.app) {
        host.notice("Calcul en chargement : réessayez dans un instant.");
        return;
      }
      active = true;
      moved = { gauche: false, droit: false };
      raw = null;
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
      clearTimeout(retry);
      clearTimeout(waiting);
      restartWait();
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

    /** Photo affichée changée (ou visionneuse prête) : bouton grisé sans photo 360°, droite refaite si le bouton est enfoncé. */
    function update() {
      const ok = available();
      button.disabled = !ok;
      if (!active) return;
      if (!ok) return deactivate();
      if (etat.photo.id !== photoId) {
        photoId = etat.photo.id;
        etat.app?.birdeye_request();
        drag = null;
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
        settle();  // nouvelle attente (verticales relancées par des clics) : droite masquée jusqu'à sa position définitive
        draw();
        waitNeighbours(photoId);
      }, 300);
    }

    return { update, changed };
  },
};
