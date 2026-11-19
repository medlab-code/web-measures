// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Rayon des courbes sur la carte (calcul : py/core/trace.py, tracé en plan ajusté sur les positions des photos). Un bouton
// de la carte allume le mode ; ensuite, au survol du filaire, la page lit les photos de la séquence autour du pointeur
// (500 m), calcule leur tracé en plan en arrière-plan, dessine les courbes (couleur selon le rayon au plus serré) et ouvre
// une fiche : sens, rayon, classe de vigilance (Cerema), courbes voisines, avec « Aller à la photo » et « Exporter le tracé ».
// Maquette D du canvas « Rayon des courbes : maquettes carte » (19/11/2026).

const Courbes = {
  /** Branche le bouton et le survol de la carte ; host : map, setStatus, notice, download, exportName (fonctions de la page),
   * openPhoto (ouvre une photo dans la visionneuse). */
  init(host) {
    const { map, setStatus, notice, download, exportName, openPhoto } = host;
    const SOURCE = "courbes", WINDOW = 500, NEAR_PX = 14, REUSE_M = 200, COMPACT = 420;
    // Classes de vigilance : virage isolé de moins de 150 m, de 150 à 250 m (Cerema, « virages », ARP)
    const CLASSES = [
      { max: 150, color: "#d32f2f", text: "Moins de 150 m : virage serré, à traiter s'il est isolé (Cerema)." },
      { max: 250, color: "#f2a900", text: "Entre 150 et 250 m : à surveiller, surtout après un alignement long (ARP, Cerema)." },
      { max: Infinity, color: "#2e7d32", text: "Plus de 250 m : pas de vigilance particulière." },
    ];
    const classOf = (radius) => CLASSES.find((c) => radius < c.max);

    let active = false, plan = null, timer = null, token = 0, popup = null, shown = null;

    // Bouton de la carte --------------------------------------------------------------------

    const button = Object.assign(document.createElement("button"), { type: "button", className: "courbes-carte",
      ariaLabel: "Rayon des courbes",
      title: "Rayon des courbes : survolez le filaire pour lire le rayon des virages (tracé en plan calculé sur les positions "
        + "des photos de la séquence, 500 m autour du pointeur)" });
    button.setAttribute("aria-pressed", "false");
    button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/>'
      + '<path d="M12 12l6 4"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>';
    map.addControl({
      onAdd: () => Object.assign(document.createElement("div"),
        { className: "maplibregl-ctrl maplibregl-ctrl-group" }).appendChild(button).parentNode,
      onRemove: () => {},
    }, "top-left");

    // Dessin ---------------------------------------------------------------------------------

    /** Courbes du tracé en GeoJSON ; hovered : la courbe surlignée (halo blanc). */
    function draw(hovered = null) {
      if (!map.isStyleLoaded() && !map.getSource(SOURCE)) return;
      const data = { type: "FeatureCollection", features: (plan?.result.curves || []).map((c, i) => ({ type: "Feature",
        properties: { color: classOf(c.r_min).color, hover: i === hovered }, geometry: { type: "LineString", coordinates: c.coords } })) };
      if (map.getSource(SOURCE)) {
        map.getSource(SOURCE).setData(data);
        return;
      }
      map.addSource(SOURCE, { type: "geojson", data });
      map.addLayer({ id: `${SOURCE}-halo`, type: "line", source: SOURCE, filter: ["==", ["get", "hover"], true],
        layout: { "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 13, "line-opacity": 0.9 } });
      map.addLayer({ id: SOURCE, type: "line", source: SOURCE, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 7 } });
    }

    function clear() {
      token++;
      plan = null;
      shown = null;
      popup?.remove();
      if (map.getSource(SOURCE)) map.getSource(SOURCE).setData({ type: "FeatureCollection", features: [] });
    }

    // Fiche ----------------------------------------------------------------------------------

    const el = (tag, props = {}, ...children) => {
      const node = Object.assign(document.createElement(tag), props);
      node.append(...children);
      return node;
    };
    const arrow = (sense) => (sense === "gauche" ? "↰" : "↱");

    /** Fiche de la courbe i du tracé (maquette D). Carte de moins de COMPACT px de haut (la mini-carte de la page) : sans le
     * tableau des courbes voisines ni la note, qui y dépasseraient de la carte ; la carte en grand a la fiche entière. */
    function sheet(i) {
      const curves = plan.result.curves, c = curves[i], klass = classOf(c.r_min);
      const compact = map.getContainer().clientHeight < COMPACT;
      const rows = [i - 1, i, i + 1].filter((k) => k >= 0 && k < curves.length).map((k) => {
        const d = curves[k], gap = k > 0 ? Math.round(d.s0 - curves[k - 1].s1) : null;
        const tr = el("tr", k === i ? { className: "courante" } : {},
          el("td", {}, `${arrow(d.sense)} ${d.sense}`), el("td", {}, gap === null ? "—" : `${gap} m`),
          el("td", {}, `${Math.round(d.length)} m`), el("td", {}, `${Math.round(d.angle)}°`),
          el("td", {}, `${Math.round(d.r_min)} m`));
        return tr;
      });
      const note = [`Rayon typique ${Math.round(c.r_typ)} m. Trajectoire du véhicule : l'axe de la chaussée est à R ± 2 m ; `
        + "ordre de grandeur ± 30 %."];
      if (c.cut) note.unshift(`Courbe coupée par la zone lue (${WINDOW} m autour du pointeur) : rayon partiel.`);
      const go = el("button", { type: "button", textContent: "Aller à la photo" });
      go.addEventListener("click", async () => {
        const f = await Carte.nearestPhoto(map, shown.lng, shown.lat, (p) => p.collection === plan?.collection, 40).catch(() => null);
        if (f) openPhoto(f);
      });
      const save = el("button", { type: "button", textContent: "Exporter le tracé" });
      save.addEventListener("click", exportPlan);
      return el("div", { className: "fiche-courbe" },
        el("div", { className: "titre" }, el("span", { className: "pastille", style: `background:${klass.color}` }),
          el("strong", {}, `Courbe à ${c.sense} · R min ${Math.round(c.r_min)} m`)),
        el("p", {}, klass.text),
        ...(compact ? [el("p", { className: "note" }, `${Math.round(c.angle)}° sur ${Math.round(c.length)} m · rayon typique `
          + `${Math.round(c.r_typ)} m${c.cut ? " · coupée par la zone lue" : ""}`)] : [
          el("table", {}, el("thead", {}, el("tr", {}, ...["Sens", "Après", "Long.", "Angle", "R min"].map((t) => el("th", {}, t)))),
            el("tbody", {}, ...rows)),
          el("p", { className: "note" }, ...note.map((t) => el("span", {}, t, " ")))]),
        el("div", { className: "boutons" }, go, save));
    }

    async function exportPlan() {
      if (!plan) return;
      const features = plan.result.curves.map((c) => ({ type: "Feature",
        properties: { sens: c.sense, rayon_min_m: Math.round(c.r_min), rayon_typique_m: Math.round(c.r_typ),
          angle_deg: Math.round(c.angle), longueur_m: Math.round(c.length), classe: classOf(c.r_min).text, coupee: c.cut },
        geometry: { type: "LineString", coordinates: c.coords } }));
      const name = await exportName("rayons des courbes", "geojson");
      await download(JSON.stringify({ type: "FeatureCollection", features }), name, "application/geo+json");
    }

    // Survol ----------------------------------------------------------------------------------

    /** Courbe affichée la plus proche du point écran, à NEAR_PX près : son indice, ou -1. */
    function nearestCurve(point) {
      let best = -1, bestD = NEAR_PX;
      (plan?.result.curves || []).forEach((c, i) => {
        const pts = c.coords.map((p) => map.project(p));
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1], b = pts[k], dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
          const t = len2 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2)) : 0;
          const d = Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
          if (d < bestD) { bestD = d; best = i; }
        }
      });
      return best;
    }

    function showSheet(event) {
      const i = nearestCurve(event.point);
      draw(i >= 0 ? i : null);
      if (i < 0) {
        popup?.remove();
        shown = null;
        return;
      }
      shown = event.lngLat;
      popup ??= new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "290px", offset: 14,
        className: "popup-courbe" });
      popup.setLngLat(event.lngLat).setDOMContent(sheet(i)).addTo(map);
    }

    /** Charge le tracé en plan autour du pointeur ; faux : rien à afficher (séquence trop courte, calcul indisponible). */
    async function load(lngLat, photo) {
      const mine = ++token;
      map.getCanvas().style.cursor = "progress";
      try {
        const photos = await Carte.sequencePhotos(photo.collection, lngLat.lng, lngLat.lat, WINDOW);
        if (mine !== token || photos.length < 5) return false;
        const text = await Calcul.call("core.trace", "plan", [photos.map((p) => p.coords.slice(0, 2))]);
        if (mine !== token) return false;
        if (!text) {  // calcul d'arrière-plan refusé ou indisponible (Web Worker interdit)
          notice("Rayon des courbes : le calcul d'arrière-plan est indisponible dans ce navigateur.");
          return false;
        }
        const result = JSON.parse(text);
        if (!result) return false;
        plan = { collection: photo.collection, center: [lngLat.lng, lngLat.lat], result };
        draw(null);
        return true;
      } catch (error) {
        console.warn("Tracé en plan :", error);
        notice(`Rayon des courbes : calcul impossible (${error.message}).`);
        return false;
      } finally {
        if (mine === token) map.getCanvas().style.cursor = "";
      }
    }

    async function hover(event) {
      if (!active) return;
      if (plan && nearestCurve(event.point) >= 0) return showSheet(event);  // sur une courbe déjà calculée : pas de réseau
      const layer = map.getLayer("sequences") ? ["sequences"] : [];
      const { x, y } = event.point;
      if (!layer.length || !map.queryRenderedFeatures([[x - 8, y - 8], [x + 8, y + 8]], { layers: layer }).length) {
        if (plan) showSheet(event);
        return;
      }
      const photo = await Carte.nearestPhoto(map, event.lngLat.lng, event.lngLat.lat, () => true, 40).catch(() => null);
      if (!photo?.collection) return;
      const far = !plan || plan.collection !== photo.collection
        || Carte.metresBetween(plan.center, [event.lngLat.lng, event.lngLat.lat]) > WINDOW - REUSE_M;
      if (far && !(await load(event.lngLat, photo))) return;
      showSheet(event);
    }

    map.on("mousemove", (event) => {
      if (!active) return;
      clearTimeout(timer);
      timer = setTimeout(() => hover(event), 160);
    });
    map.getCanvas().addEventListener("mouseleave", () => { clearTimeout(timer); popup?.remove(); shown = null; });

    button.addEventListener("click", () => {
      active = !active;
      button.setAttribute("aria-pressed", String(active));
      if (active) setStatus("Rayon des courbes : survolez le filaire orange de la carte (zoom 15 ou plus), le tracé se calcule sur "
        + `${WINDOW} m autour du pointeur.`);
      else {
        clearTimeout(timer);
        clear();
      }
    });

    return { isActive: () => active };
  },
};
