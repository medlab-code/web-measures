// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Recherche de lieux sur la carte : commune, lieu-dit, voie ou adresse, par l'autocomplétion
// du service de géocodage de la Géoplateforme (adresses de la BAN et toponymes de l'IGN).

const Recherche = (() => {
  const COMPLETION = "https://data.geopf.fr/geocodage/completion";
  const COMMUNES = "https://geo.api.gouv.fr/communes";
  const MIN_LENGTH = 3;
  const DELAY = 250;  // ms sans frappe avant d'interroger le service
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

  /** Contour de la commune qui contient (lon, lat) : entité GeoJSON, ou null. */
  async function communeOutline(lon, lat) {
    const response = await fetch(`${COMMUNES}?lat=${lat}&lon=${lon}&fields=nom,code,contour&format=geojson&geometry=contour`);
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
    box.innerHTML = '<input type="search" placeholder="Rechercher un lieu…" aria-label="Rechercher un lieu"'
      + ' autocomplete="off" spellcheck="false"><ul role="listbox" hidden></ul>';
    map.getContainer().append(box);
    const input = box.querySelector("input");
    const list = box.querySelector("ul");
    let results = [], active = -1, timer = null, asked = 0, chosen = 0;

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
      if (!commune) {
        map.flyTo({ center: [r.x, r.y], zoom, speed: 1.6 });
        return;
      }
      // Commune : son contour tracé, la carte cadrée dessus (centrée sur elle si le contour manque)
      communeOutline(r.x, r.y).then((feature) => {
        if (ticket !== chosen) return;  // autre lieu choisi entre-temps
        if (!feature) throw new Error("contour introuvable");
        outline?.setData({ type: "FeatureCollection", features: [feature] });
        map.fitBounds(bounds(feature.geometry), { padding: 30, speed: 1.6 });
      }).catch((error) => {
        console.warn("Contour de la commune :", error);
        if (ticket === chosen) map.flyTo({ center: [r.x, r.y], zoom, speed: 1.6 });
      });
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      results = [];  // suggestions de l'ancienne saisie : plus choisissables
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
        choose(active >= 0 ? active : 0);
      } else if (event.key === "Escape") {
        close();
      }
    });
    input.addEventListener("blur", close);
    input.addEventListener("focus", () => { if (results.length) render(); });
    // Les touches de la recherche ne doivent pas déplacer la carte
    for (const type of ["keydown", "wheel", "dblclick"]) box.addEventListener(type, (e) => e.stopPropagation());
  }

  return { attach };
})();
