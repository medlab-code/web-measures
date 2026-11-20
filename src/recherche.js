// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Recherche de lieux sur la carte : commune, lieu-dit, voie ou adresse, par l'autocomplétion
// du service de géocodage de la Géoplateforme (adresses de la BAN et toponymes de l'IGN).

const Recherche = (() => {
  const COMPLETION = "https://data.geopf.fr/geocodage/completion";
  const WFS = "https://data.geopf.fr/wfs/ows";
  const MIN_LENGTH = 3;
  const DELAY = 250;  // ms sans frappe avant d'interroger le service
  const OUTLINE_TIMEOUT = 8000;  // ms : contour de commune abandonné au-delà (service parfois muet)
  // Zoom selon la nature du lieu trouvé
  const ZOOMS = { municipality: 13, street: 16, housenumber: 18 };

  async function suggestions(text) {
    const params = new URLSearchParams({
      text, type: "StreetAddress,PositionOfInterest", maximumResponses: "8",
    });
    const response = await fetch(`${COMPLETION}?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()).results || []).filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y));
  }

  /** Contour de la commune qui contient (lon, lat) : entité GeoJSON, ou null (ADMIN EXPRESS
   * cartographique de la Géoplateforme : contour simplifié, quelques Ko). */
  async function communeOutline(lon, lat) {
    const params = new URLSearchParams({
      SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: "ADMINEXPRESS-COG-CARTO.LATEST:commune",
      OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326", COUNT: "1", PROPERTYNAME: "nom_officiel,code_insee,geometrie",
      CQL_FILTER: `INTERSECTS(geometrie,POINT(${lat} ${lon}))`,
    });
    const response = await fetch(`${WFS}?${params}`, { signal: AbortSignal.timeout(OUTLINE_TIMEOUT) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()).features || [])[0] || null;
  }

  /** Emprise [[ouest, sud], [est, nord]] d'un polygone ou multipolygone GeoJSON. */
  function bounds(geometry) {
    const rings = geometry.type === "MultiPolygon" ? geometry.coordinates.flat() : geometry.coordinates;
    const pts = rings.flat();
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
  }

  /** Zone de recherche en haut à droite de la carte. */
  function attach(map) {
    const box = document.createElement("div");
    box.className = "recherche";
    box.innerHTML = '<svg class="icone" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>'
      + '<input type="search" placeholder="Rechercher un lieu…" aria-label="Rechercher un lieu"'
      + ' autocomplete="off" spellcheck="false"><ul role="listbox" hidden></ul>';
    map.getContainer().append(box);
    const input = box.querySelector("input");
    const list = box.querySelector("ul");
    let results = [], active = -1, timer = null, asked = 0, chosen = 0;
    let enterPending = false;  // Entrée tapée avant l'arrivée des suggestions : la première, dès qu'elles arrivent

    function close() {
      list.hidden = true;
      active = -1;
    }

    function render() {
      list.replaceChildren(...results.map((r, i) => {
        const item = document.createElement("li");
        item.setAttribute("role", "option");
        item.className = i === active ? "active" : "";
        item.textContent = r.fulltext;
        if (r.country === "PositionOfInterest" && r.kind) {
          const kind = document.createElement("small");
          kind.textContent = ` ${r.kind}`;
          item.append(kind);
        }
        item.addEventListener("mousedown", (event) => {  // avant la perte du focus
          event.preventDefault();
          choose(i);
        });
        return item;
      }));
      list.hidden = !results.length;
    }

    // Vol de la carte (ms) : durée fixe, comme pour le requêteur route + PR ; à vitesse fixe (speed 1,6), un long vol durait
    // plusieurs secondes, et le cadrage sur le contour d'une commune en ajoutait autant
    const FLIGHT = 700;
    function choose(i) {
      const r = results[i];
      if (!r) return;
      input.value = r.fulltext;
      close();
      input.blur();
      const zoom = ZOOMS[r.kind] ?? (r.country === "PositionOfInterest" ? 15 : 16);
      const outline = map.getSource("contour");
      outline?.setData({ type: "FeatureCollection", features: [] });  // contour d'une recherche précédente
      const ticket = ++chosen;
      // Commune de la base des adresses, ou toponyme administratif de nature « commune »
      const commune = r.kind === "municipality" || (r.poiType || []).includes("commune");
      map.flyTo({ center: [r.x, r.y], zoom, duration: FLIGHT });  // tout de suite, sans attendre le contour
      if (!commune) return;
      // Commune : son contour tracé, puis la carte cadrée dessus quand il arrive
      communeOutline(r.x, r.y).then((feature) => {
        if (ticket !== chosen) return;  // autre lieu choisi entre-temps
        if (!feature) throw new Error("contour introuvable");
        outline?.setData({ type: "FeatureCollection", features: [feature] });
        map.fitBounds(bounds(feature.geometry), { padding: 30, duration: FLIGHT });
      }).catch((error) => console.warn("Contour de la commune :", error));
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      results = [];  // suggestions de l'ancienne saisie : plus choisissables
      enterPending = false;
      close();
      asked++;  // réponse en attente pour l'ancienne saisie : ignorée
      const text = input.value.trim();
      if (text.length < MIN_LENGTH) return;
      timer = setTimeout(async () => {
        const ticket = ++asked;
        try {
          const found = await suggestions(text);
          if (ticket !== asked) return;  // frappe plus récente
          results = found;
          active = -1;
          render();
          if (enterPending) {
            enterPending = false;
            choose(0);
          }
        } catch (error) {
          console.warn("Recherche de lieu :", error);
        }
      }, DELAY);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!results.length) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        active = (active + step + results.length) % results.length;
        list.hidden = false;
        render();
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (results.length) choose(active >= 0 ? active : 0);
        else enterPending = input.value.trim().length >= MIN_LENGTH;
      } else if (event.key === "Escape") {
        close();
      }
    });
    input.addEventListener("blur", close);
    input.addEventListener("focus", () => { if (results.length) render(); });
    // Les touches de la recherche ne doivent pas déplacer la carte
    for (const type of ["keydown", "wheel", "dblclick"]) box.addEventListener(type, (e) => e.stopPropagation());
  }

  return { attach, communeOutline };
})();
