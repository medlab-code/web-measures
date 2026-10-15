// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Carte : fonds IGN, filaire Panoramax (même style que le plugin QGIS), mesures, visées,
// curseur de vue, photo la plus proche d'un clic, filtre des photos, instance Panoramax.

const Carte = (() => {
  const META_API = "https://api.panoramax.xyz/api";
  const GEOPF = "https://data.geopf.fr";
  const ORANGE = "#ff6f00";
  const ROUGE = "#e53935";  // trait d'une mesure, visées : comme dans le plugin
  const JAUNE = "#ffeb00";  // points cliqués
  const BLEU = "#00bce6";  // largeur perpendiculaire : trait tracé perpendiculairement à la route
  const VIOLET = "#9c27b0";  // façade
  const CURSEUR = "#0078ff";  // curseur de vue
  const VERT_PR = "#2e7d32";  // points de repère (PR) des routes

  let apiUrl = META_API;  // instance courante (voir setInstance)
  const tilesUrl = () => `${apiUrl}/map/{z}/{x}/{y}.mvt`;

  function wmts(layer, format) {
    return `${GEOPF}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal` +
      `&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
  }

  const ATTRIBUTION_IGN = '<a href="https://www.ign.fr">IGN</a>';
  const ATTRIBUTION_OSM = '© <a href="https://www.openstreetmap.org/copyright">les contributeurs d\'OpenStreetMap</a>, '
    + 'fond <a href="https://www.openstreetmap.fr">OpenStreetMap France</a>';
  // Tuiles d'OpenStreetMap France : le serveur officiel (tile.openstreetmap.org) refuse les
  // demandes sans page d'origine, celles de la page ouverte par double-clic (file://)
  const OSM_TILES = "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png";
  const osmTiles = ["a", "b", "c"].map((sub) => OSM_TILES.replace("{s}", sub));
  const BACKGROUNDS = ["plan", "ortho", "osm"];
  const ATTRIBUTION_PANORAMAX = '<a href="https://panoramax.fr">Panoramax</a>';
  const EMPTY = { type: "FeatureCollection", features: [] };
  const kind = (...kinds) => ["in", ["get", "kind"], ["literal", kinds]];

  function createMap(container) {
    const map = new maplibregl.Map({
      container,
      center: [5.04, 47.32],  // Côte-d'Or
      zoom: 9,
      style: {
        version: 8,
        sources: {
          plan: {
            type: "raster", tiles: [wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png")],
            tileSize: 256, maxzoom: 19, attribution: ATTRIBUTION_IGN,
          },
          ortho: {
            type: "raster", tiles: [wmts("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg")],
            tileSize: 256, maxzoom: 20, attribution: ATTRIBUTION_IGN,
          },
          osm: { type: "raster", tiles: osmTiles, tileSize: 256, maxzoom: 19, attribution: ATTRIBUTION_OSM },
          panoramax: {
            type: "vector", tiles: [tilesUrl()], minzoom: 0, maxzoom: 15, attribution: ATTRIBUTION_PANORAMAX,
          },
          mesures: { type: "geojson", data: EMPTY },
          vue: { type: "geojson", data: EMPTY },
          pr: { type: "geojson", data: EMPTY },
        },
        layers: [
          { id: "plan", type: "raster", source: "plan" },
          { id: "ortho", type: "raster", source: "ortho", layout: { visibility: "none" } },
          { id: "osm", type: "raster", source: "osm", layout: { visibility: "none" } },
          // Filaire : densité à petite échelle, séquences, puis photos
          {
            id: "grille", type: "circle", source: "panoramax", "source-layer": "grid", maxzoom: 7,
            paint: { "circle-color": ORANGE, "circle-opacity": 0.6, "circle-radius": 2 },
          },
          {
            id: "sequences", type: "line", source: "panoramax", "source-layer": "sequences", minzoom: 6,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ORANGE, "line-opacity": 0.6,
              "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 12, 1.5, 17, 3],
            },
          },
          {
            id: "photos", type: "circle", source: "panoramax", "source-layer": "pictures", minzoom: 15,
            paint: {
              "circle-color": ORANGE, "circle-radius": 3.5, "circle-opacity": 0.7,
              "circle-stroke-color": "#ffffff", "circle-stroke-width": 1,
            },
          },
          // Points de repère des routes (voir showMilestones), sous le curseur et les mesures
          {
            id: "pr", type: "circle", source: "pr", minzoom: PR_MINZOOM,
            paint: {
              "circle-color": VERT_PR, "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 17, 4.5],
              "circle-stroke-color": "#ffffff", "circle-stroke-width": 1,
            },
          },
          // Curseur de vue : position, direction et ouverture de la vue
          {
            id: "vue-cone", type: "fill", source: "vue", filter: ["==", ["get", "kind"], "cone"],
            paint: { "fill-color": CURSEUR, "fill-opacity": 0.25 },
          },
          {
            id: "vue-bord", type: "line", source: "vue", filter: ["==", ["get", "kind"], "cone"],
            paint: { "line-color": CURSEUR, "line-width": 1.5 },
          },
          {  // axe de la vue, prolongé : croisement du cap de visée avec la carte (liseré blanc
            // pour se détacher du cône et des fonds)
            id: "vue-axe-halo", type: "line", source: "vue", filter: ["==", ["get", "kind"], "axe"],
            paint: { "line-color": "#ffffff", "line-width": 3, "line-opacity": 0.7 },
          },
          {
            id: "vue-axe", type: "line", source: "vue", filter: ["==", ["get", "kind"], "axe"],
            paint: { "line-color": CURSEUR, "line-width": 1.2 },
          },
          {
            id: "vue-photo", type: "circle", source: "vue", filter: ["==", ["get", "kind"], "photo"],
            paint: {
              "circle-color": CURSEUR, "circle-radius": 6, "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2,
            },
          },
          // Mesures, visées et points (voir web_app.App.map_geojson)
          {
            id: "facades", type: "line", source: "mesures", filter: kind("facade"),
            paint: { "line-color": VIOLET, "line-width": 3, "line-dasharray": [2, 1.5] },
          },
          {
            id: "visees-halo", type: "line", source: "mesures", filter: kind("visee"),
            paint: { "line-color": "#ffffff", "line-opacity": 0.8, "line-width": 4 },
          },
          {
            id: "visees", type: "line", source: "mesures", filter: kind("visee"),
            paint: { "line-color": ROUGE, "line-width": 2, "line-dasharray": [3, 2] },
          },
          {
            id: "liens", type: "line", source: "mesures", filter: kind("lien"),
            paint: { "line-color": BLEU, "line-width": 1.5, "line-dasharray": [1, 2] },
          },
          {  // plan perpendiculaire : bande bleue sous le trait rouge, visible quand ils se confondent
            id: "plans", type: "line", source: "mesures", filter: kind("trace"),
            layout: { "line-cap": "round" },
            paint: { "line-color": BLEU, "line-opacity": 0.8, "line-width": 7 },
          },
          {
            id: "traits", type: "line", source: "mesures", filter: kind("mesure"),
            paint: { "line-color": ROUGE, "line-width": 3 },
          },
          {  // croix jaunes, comme dans la visionneuse (image fournie à la demande, voir crossImage)
            id: "points", type: "symbol", source: "mesures", filter: kind("point"),
            layout: { "icon-image": "croix", "icon-allow-overlap": true, "icon-ignore-placement": true },
          },
          {
            id: "cibles", type: "circle", source: "mesures", filter: kind("cible", "triangule"),
            paint: {
              "circle-color": ["match", ["get", "kind"], "triangule", ROUGE, "rgba(0, 0, 0, 0)"],
              "circle-radius": 7, "circle-stroke-color": ROUGE, "circle-stroke-width": 2.5,
            },
          },
        ],
      },
    });
    map.on("styleimagemissing", (e) => {
      if (e.id === "croix" && !map.hasImage("croix")) map.addImage("croix", crossImage(), { pixelRatio: 2 });
    });
    map.addControl(new maplibregl.NavigationControl(), "top-left");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    return map;
  }

  /** Croix jaune d'un point cliqué, cernée de sombre (18 pixels, dessinée au double). */
  function crossImage() {
    const size = 36, canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const c = size / 2, arm = 16;
    for (const [color, width] of [["rgba(0, 0, 0, 0.7)", 8], [JAUNE, 4]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(c - arm, c); ctx.lineTo(c + arm, c);
      ctx.moveTo(c, c - arm); ctx.lineTo(c, c + arm);
      ctx.stroke();
    }
    return ctx.getImageData(0, 0, size, size);
  }

  function setBackground(map, name) {
    if (!BACKGROUNDS.includes(name)) name = "plan";  // fond mémorisé inconnu
    for (const id of BACKGROUNDS) {
      map.setLayoutProperty(id, "visibility", id === name ? "visible" : "none");
    }
  }

  // Instance Panoramax -------------------------------------------------------------------

  /** Instances connues du méta-catalogue : [[nom, adresse du site]], triées. */
  async function instances() {
    const response = await fetch(`${META_API}/instances`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return (data.instances || []).filter((i) => i.url).map((i) => [i.name || i.url, i.url])
      .sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
  }

  /** Carte prête (style chargé) : fn tout de suite, sinon à son chargement. */
  function whenLoaded(map, fn) {
    if (map.isStyleLoaded()) fn();
    else map.once("load", fn);
  }

  /** Bascule sur une instance (adresse de son site), ou sur le méta-catalogue (""). */
  function setInstance(map, base) {
    let site = (base || "").replace(/\/+$/, "");
    if (site.endsWith("/api")) site = site.slice(0, -4);
    apiUrl = site ? `${site}/api` : META_API;
    const url = tilesUrl();
    whenLoaded(map, () => map.getSource("panoramax").setTiles([url]));
    return apiUrl;
  }

  // Filtre des photos (même critères que le plugin, voir core/filters.py) ------------------

  function setFilter(map, f) {
    if (!map.isStyleLoaded()) {  // MapLibre refuse un filtre avant le chargement du style
      map.once("load", () => setFilter(map, f));
      return;
    }
    const tileTypes = { 360: "equirectangular", flat: "flat" };
    for (const [layer, dateField] of [["sequences", "date"], ["photos", "ts"]]) {
      const parts = ["all"];
      if (f.since) parts.push([">=", ["to-string", ["get", dateField]], f.since]);
      if (f.kind) parts.push(["==", ["get", "type"], tileTypes[f.kind]]);
      if (f.max_gps != null) {
        parts.push(["has", "gps_accuracy"], ["<=", ["to-number", ["get", "gps_accuracy"], 1e9], f.max_gps]);
      }
      if (f.producer) parts.push(["==", ["get", "account_id"], f.producer[0]]);
      map.setFilter(layer, parts.length > 1 ? parts : null);
    }
    const grid = f.kind ? [">", ["to-number", ["get", f.kind === "360" ? "nb_360_pictures" : "nb_flat_pictures"], 0], 0]
      : null;
    map.setFilter("grille", grid);
  }

  // Points de repère (PR) des routes : BD TOPO, zone affichée, à partir de PR_MINZOOM ; leur
  // étiquette (marqueur HTML, sans police à charger) à partir de PR_LABEL_ZOOM ---------------

  const PR_MINZOOM = 13;
  const PR_LABEL_ZOOM = 14;
  const prLabels = [];
  let prTimer = null, prAsked = 0, prKey = "";

  function showMilestones(map) {
    map.on("moveend", () => {
      clearTimeout(prTimer);
      prTimer = setTimeout(() => loadMilestones(map), 300);
    });
    whenLoaded(map, () => loadMilestones(map));
  }

  async function loadMilestones(map) {
    const zoom = map.getZoom();
    const b = map.getBounds();
    // Zone chargée arrondie (et un peu élargie) : petits déplacements sans nouvelle requête
    const r = (v, up) => (up ? Math.ceil(v * 200) : Math.floor(v * 200)) / 200;
    const box = [r(b.getWest(), false), r(b.getSouth(), false), r(b.getEast(), true), r(b.getNorth(), true)];
    const key = zoom >= PR_MINZOOM ? box.join(",") + (zoom >= PR_LABEL_ZOOM ? "+" : "") : "";
    if (key === prKey) return;
    prKey = key;
    const ticket = ++prAsked;
    let features = [];
    if (zoom >= PR_MINZOOM) {
      const params = new URLSearchParams({
        SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: "BDTOPO_V3:point_de_repere",
        OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326", COUNT: "1000",
        BBOX: `${box[1]},${box[0]},${box[3]},${box[2]},urn:ogc:def:crs:EPSG::4326`,
      });
      try {
        const response = await fetch(`${GEOPF}/wfs/ows?${params}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        features = ((await response.json()).features || [])
          .filter((f) => /^\d+$/.test(String(f.properties?.numero)));  // ni début ni fin de section
      } catch (error) {
        console.warn("Points de repère :", error);
        prKey = "";  // à redemander
        return;
      }
    }
    if (ticket !== prAsked) return;  // zone déjà quittée
    const seen = new Set();  // un seul PR par route et numéro (côtés droit et gauche)
    features = features.filter((f) => {
      const id = `${f.properties.route} ${f.properties.numero}`;
      return !seen.has(id) && seen.add(id);
    });
    map.getSource("pr")?.setData({ type: "FeatureCollection", features });
    for (const marker of prLabels.splice(0)) marker.remove();
    if (zoom < PR_LABEL_ZOOM) return;
    for (const f of features) {
      const element = document.createElement("div");
      element.className = "etiquette-pr";
      element.textContent = `${f.properties.route} PR ${f.properties.numero}`;
      prLabels.push(new maplibregl.Marker({ element, anchor: "left", offset: [6, 0] })
        .setLngLat(f.geometry.coordinates).addTo(map));
    }
  }

  // Mesures --------------------------------------------------------------------------------

  // Étiquettes : marqueurs HTML (pas de police de caractères à charger)
  const labels = [];

  function showMeasures(map, geojson) {
    map.getSource("mesures")?.setData(geojson);
    for (const marker of labels.splice(0)) marker.remove();
    sublabels.length = 0;
    for (const feature of geojson.features) {
      const { label, sublabel, kind: featureKind } = feature.properties;
      if (featureKind === "facade") continue;
      const coords = feature.geometry.type === "Point" ? feature.geometry.coordinates
        : middle(feature.geometry.coordinates);
      if (label) {
        const element = document.createElement("div");
        element.className = "etiquette";
        element.textContent = label;
        labels.push(new maplibregl.Marker({ element, offset: [0, -20] }).setLngLat(coords).addTo(map));
      }
      if (sublabel) {  // sous le trait, couchée le long de celui-ci (voir placeSublabels)
        const element = document.createElement("div");
        element.className = "ancre";
        element.innerHTML = '<div class="etiquette sous"></div>';
        element.firstChild.textContent = sublabel;
        const marker = new maplibregl.Marker({ element }).setLngLat(coords).addTo(map);
        const line = feature.geometry.coordinates;
        labels.push(marker);
        sublabels.push({ marker, text: element.firstChild, a: line[0], b: line[line.length - 1] });
      }
    }
    if (!sublabelsBound) {
      sublabelsBound = true;
      map.on("move", () => placeSublabels(map));
    }
    placeSublabels(map);
  }

  // Étiquettes sous un trait : suivent son angle à l'écran, lisibles de gauche à droite, et
  // n'apparaissent que si le trait fait au moins deux fois leur largeur (sinon elles cachent tout)
  const sublabels = [];
  let sublabelsBound = false;

  function placeSublabels(map) {
    for (const { marker, text, a, b } of sublabels) {
      const pa = map.project(a), pb = map.project(b);
      let angle = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      marker.setRotation(angle);
      const length = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      text.style.visibility = length >= 2 * text.offsetWidth ? "visible" : "hidden";
    }
  }

  // Poignées : points des mesures (et extrémités de la façade) à glisser pour les recaler.
  // Recréées seulement quand elles changent, et jamais pendant un glisser (le marqueur saisi
  // disparaîtrait avec le recalage en cours).
  const handles = [];
  let handlesKey = "";
  let dragging = false;
  let onMoved = null;

  function showHandles(map, list, moved) {
    onMoved = moved;
    const key = JSON.stringify(list);
    if (dragging || key === handlesKey) return;
    handlesKey = key;
    for (const marker of handles.splice(0)) marker.remove();
    list.forEach(([lon, lat, facade], index) => {
      const element = document.createElement("div");
      element.className = "poignee" + (facade ? " facade" : "");
      element.title = "Glisser pour recaler ce point sur la carte";
      const marker = new maplibregl.Marker({ element, draggable: true }).setLngLat([lon, lat]).addTo(map);
      marker.on("dragstart", () => { dragging = true; });
      marker.on("dragend", () => {
        dragging = false;
        handlesKey = "";  // redessinées d'après le recalage
        const { lng, lat: newLat } = marker.getLngLat();
        onMoved(index, lng, newLat);
      });
      handles.push(marker);
    });
  }

  function middle(coords) {
    const a = coords[0], b = coords[coords.length - 1];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  // Curseur de vue -------------------------------------------------------------------------

  /** Photo affichée et vue : cap (degrés), champ horizontal (degrés), ou heading null. Cône
   * de 70 pixels et axe jusqu'au bord de la carte, quelle que soit l'échelle (redessinés à
   * chaque zoom et changement de taille de la carte). */
  let lastView = null;

  function showView(map, lonlat, heading, fov) {
    if (!lastView) {
      for (const event of ["zoomend", "resize"]) map.on(event, () => lastView && showView(map, ...lastView));
    }
    lastView = [lonlat, heading, fov];
    const features = [];
    if (lonlat) {
      if (heading != null) {
        const radius = 70 * metresPerPixel(map, lonlat[1]);
        const canvas = map.getCanvas();
        const diagonal = Math.hypot(canvas.clientWidth, canvas.clientHeight) || 1000;  // carte pas encore mise en page
        const reach = diagonal * metresPerPixel(map, lonlat[1]);
        features.push({
          type: "Feature", properties: { kind: "axe" },
          geometry: { type: "LineString", coordinates: [lonlat, offset(lonlat, heading, reach)] },
        });
        const half = Math.min(fov || 90, 170) / 2;
        const ring = [lonlat];
        for (let k = 0; k <= 16; k++) ring.push(offset(lonlat, heading - half + (2 * half * k) / 16, radius));
        ring.push(lonlat);
        features.push({ type: "Feature", properties: { kind: "cone" }, geometry: { type: "Polygon", coordinates: [ring] } });
      }
      features.push({ type: "Feature", properties: { kind: "photo" }, geometry: { type: "Point", coordinates: lonlat } });
    }
    map.getSource("vue")?.setData({ type: "FeatureCollection", features });
  }

  function offset([lon, lat], heading, distance) {
    const h = heading * Math.PI / 180;
    const dlat = distance * Math.cos(h) / 111320;
    const dlon = distance * Math.sin(h) / (111320 * Math.cos(lat * Math.PI / 180));
    return [lon + dlon, lat + dlat];
  }

  // Photo la plus proche d'un clic --------------------------------------------------------

  function metresBetween(a, b) {
    const rad = Math.PI / 180;
    const x = (b[0] - a[0]) * rad * Math.cos((a[1] + b[1]) / 2 * rad);
    const y = (b[1] - a[1]) * rad;
    return Math.hypot(x, y) * 6371008.8;
  }

  function metresPerPixel(map, lat) {
    return 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * 2 ** map.getZoom());
  }

  /**
   * Photo (fiche STAC) la plus proche du point, dans un rayon adapté à l'échelle (10 à 150 m),
   * parmi celles qui passent le filtre `accept` (fiche -> booléen).
   */
  async function nearestPhoto(map, lng, lat, accept = () => true) {
    const radius = Math.min(150, Math.max(10, 15 * metresPerPixel(map, lat)));
    const dlat = radius / 111320;
    const dlon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    const bbox = [lng - dlon, lat - dlat, lng + dlon, lat + dlat].map((v) => v.toFixed(7)).join(",");
    const response = await fetch(`${apiUrl}/search?bbox=${bbox}&limit=50`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    let best = null;
    for (const feature of data.features || []) {
      if (!accept(feature)) continue;
      const d = metresBetween([lng, lat], feature.geometry.coordinates);
      if (!best || d < best.d) best = { feature, d };
    }
    return best ? best.feature : null;
  }

  /** Fiche STAC d'une photo, par son identifiant. */
  async function photoById(id) {
    const response = await fetch(`${apiUrl}/search?ids=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return (data.features || [])[0] || null;
  }

  return {
    PANORAMAX_API: META_API, GEOPF, OSM_TILES, createMap, setBackground, instances, setInstance, setFilter,
    showMeasures, showHandles, showView, showMilestones, nearestPhoto, photoById, apiUrl: () => apiUrl,
  };
})();
