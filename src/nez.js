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
    const MIN_OFFSET = 0.2;  // m : une poignée reste de son côté du droit de la caméra
    const FALLBACK = 3;  // m : bords de départ sans profil en travers
    const INCLINATION = 0.5, ROLL = 0.5;  // degrés : incertitude de l'inclinaison de la photo et du roulis restant (docs/CALCULS.md)
    const toRad = Math.PI / 180;

    let active = false, raw = null, line = null;  // raw : dernière réponse de nose_line (texte), line : son contenu
    let photoId = null;
    let handles = { gauche: -FALLBACK, droit: FALLBACK }, moved = { gauche: false, droit: false };
    let drag = null, bound = null, readout = null, retry = null, waiting = null;

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
      if (!active || !line || line.error || !line.lonlat) return Carte.showNez(map, null);
      const point = (o) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: lonlatAt(o) } });
      Carte.showNez(map, { type: "FeatureCollection", features: [
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line.lonlat } },
        point(handles.gauche), point(handles.droit)] });
    }

    // Lecture -----------------------------------------------------------------------------------

    /** Incertitude (m) du bord à s m de l'axe : inclinaison, roulis restant, hauteur de caméra et altitude du MNT, lue en différence
     * avec le sol sous la caméra, donc √2 fois sa précision ; rien de plus à plat (docs/CALCULS.md). */
    function sigma(s) {
      const { hauteur: h, d, sigma_h: sh, sol_sigma: sg } = line;
      return Math.hypot((h * h + d * d) / h * INCLINATION * toRad, s * s * ROLL * toRad / h, s * sh / h,
        sg ? s * Math.SQRT2 * sg / h : 0);
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
      if (line.sol_en_lecture) return "relief en lecture…";
      if (!line.sol_dz) return `sol ${line.sol}`;
      return `sol ${line.sol} : ${signed(groundAt(handles.gauche) * 100)} à gauche, ${signed(groundAt(handles.droit) * 100)} à droite`;
    }

    const roundUp05 = (value) => Math.max(0.05, Math.ceil(value / 0.05 - 1e-9) * 0.05);

    /** Source de l'inclinaison de la photo, discrète : rien tant que les verticales sont en calcul (la droite est refaite à leur arrivée). */
    function tiltText() {
      if (line.inclinaison_en_calcul) return "inclinaison en calcul…";
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
      const left = -handles.gauche, right = handles.droit;
      const uncertainty = roundUp05(Math.hypot(sigma(left), sigma(right)));
      text.textContent = `Gauche ${metres(left)} · Droite ${metres(right)} · Largeur ${metres(left + right)}`
        + ` · ±${metres(uncertainty)}`;
      const tilt = tiltText();
      if (tilt) text.textContent += ` · ${tilt}`;
      text.textContent += ` · ${groundText()}`;
      readout.title = `Distance latérale de chaque bord à la caméra, lue sur la droite au sol à ${metres(line.d, 1)} devant elle `
        + `(${line.sol_dz ? `relief du MNT ${line.sol}` : "sol plat"}). Hauteur de la caméra ${metres(line.hauteur)}${line.hauteur_source ? ` (${line.hauteur_source})` : ""}`
        + `${line.inclinaison_source === "roulis de campagne" ? `, roulis de la campagne ${line.roulis_campagne}°` : ""}. Expérimental : rien n'est retenu.`;
    }

    /** Droite, repère, poignées et étiquettes dans la seconde couche de Traits. */
    function draw() {
      showReadout();
      drawMap();
      if (!line || line.error) return Traits.setExtra();
      Traits.attach(etat.psv);
      const points = line.points.map(([, yaw, pitch]) => [yaw, pitch]);
      const at = locate;
      const sides = [["gauche", handles.gauche], ["droit", handles.droit]];
      Traits.setExtra({
        lines: [{ points, color: DARK, width: 5 }, { points, color: GREEN, width: 2.5 }],
        crosses: [{ at: at(0), color: YELLOW }],  // croix au droit de la caméra
        ticks: sides.map(([, o]) => ({ at: at(o), color: RED, edge: "#ffffff", length: TICK_PX, width: 3 })),
        labels: sides.map(([, o]) => ({ at: at(o), type: "mesure", place: "dessus", lift: TICK_PX / 2, text: metres(Math.abs(o)) }))
          // largeur entre les poignées, au milieu de la droite, au-dessus d'elle (comme l'encart)
          .concat({ at: at((handles.gauche + handles.droit) / 2), type: "mesure", place: "dessus", lift: 4,
            text: metres(handles.droit - handles.gauche) }),
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
      if (!line || line.error) return null;
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
      let best = null, bestD = Infinity, previous = null;
      for (const [o, yaw, pitch] of line.points) {
        if (side === "gauche" ? o > -MIN_OFFSET : o < MIN_OFFSET) {
          previous = null;
          continue;
        }
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
      return best;
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
      if (!line || line.error || (event.pointerType === "mouse" && event.button !== 0)) return;
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
      if (!line || line.error) return;
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
      if (t && line && !line.error && handleAt(...local(t))) event.stopImmediatePropagation();
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
      load();
      reset();
      bind();
      button.setAttribute("aria-pressed", "true");
      draw();
      waitNeighbours(photoId);
    }

    /** Voisines de la photo (précédente, suivante) ou relief du MNT pas encore arrivés : la droite en dépend (axe de la séquence, sol). Nouvel essai toutes
     * les 0,3 s, au plus 12 s (deux lectures du MNT de 5 s au plus), tant que la photo est la même ; droite et tracés refaits si elle a changé, bords gardés. */
    function waitNeighbours(id, left = 40) {
      clearTimeout(waiting);
      if (!active || left <= 0 || !line || line.error || (line.voisines !== false && !line.sol_en_lecture)) return;
      waiting = setTimeout(() => {
        if (!active || !available() || etat.photo.id !== id) return;
        if (load()) draw();
        waitNeighbours(id, left - 1);
      }, 300);
    }

    function deactivate() {
      active = false;
      clearTimeout(retry);
      clearTimeout(waiting);
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
        load();
        reset();
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
        draw();
      }, 300);
    }

    return { update, changed };
  },
};
