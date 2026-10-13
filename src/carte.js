// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Carte : fonds IGN, filaire Panoramax (même style que le plugin QGIS), mesures et photo
// affichée, recherche de la photo la plus proche d'un clic.

const Carte = (() => {
  const PANORAMAX_API = "https://api.panoramax.xyz/api";
  const GEOPF = "https://data.geopf.fr";
  const ORANGE = "#ff6f00";
  const ROUGE = "#e53935";  // trait d'une mesure : comme dans la visionneuse
  const JAUNE = "#ffeb00";  // points cliqués
  const BLEU = "#00bce6";  // largeur perpendiculaire : trait tracé perpendiculairement à la route
  const VIOLET = "#9c27b0";  // façade du cadastre

  function wmts(layer, format) {
    return `${GEOPF}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal` +
      `&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
  }

  const ATTRIBUTION_IGN = '<a href="https://www.ign.fr">IGN</a>';
  const ATTRIBUTION_PANORAMAX = '<a href="https://panoramax.fr">Panoramax</a>';
  const EMPTY = { type: "FeatureCollection", features: [] };

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
          panoramax: {
            type: "vector", tiles: [`${PANORAMAX_API}/map/{z}/{x}/{y}.mvt`],
            minzoom: 0, maxzoom: 15, attribution: ATTRIBUTION_PANORAMAX,
          },
          mesures: { type: "geojson", data: EMPTY },
          photo: { type: "geojson", data: EMPTY },
        },
        layers: [
          { id: "plan", type: "raster", source: "plan" },
          { id: "ortho", type: "raster", source: "ortho", layout: { visibility: "none" } },
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
          // Mesures (voir web_app.App.map_geojson)
          {
            id: "facades", type: "line", source: "mesures", filter: ["==", ["get", "kind"], "facade"],
            paint: { "line-color": VIOLET, "line-width": 3, "line-dasharray": [2, 1.5] },
          },
          {
            id: "liens", type: "line", source: "mesures", filter: ["==", ["get", "kind"], "lien"],
            paint: { "line-color": BLEU, "line-width": 1.5, "line-dasharray": [1, 2] },
          },
          {
            id: "traits", type: "line", source: "mesures",
            filter: ["in", ["get", "kind"], ["literal", ["mesure", "trace"]]],
            paint: {
              "line-color": ["match", ["get", "kind"], "trace", BLEU, ROUGE], "line-width": 3,
            },
          },
          {
            id: "points", type: "circle", source: "mesures", filter: ["==", ["get", "kind"], "point"],
            paint: {
              "circle-color": JAUNE, "circle-radius": 4.5, "circle-stroke-color": "#202124",
              "circle-stroke-width": 1.5,
            },
          },
          {
            id: "photo", type: "circle", source: "photo",
            paint: {
              "circle-color": "#1a73e8", "circle-radius": 7, "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2,
            },
          },
        ],
      },
    });
    map.addControl(new maplibregl.NavigationControl(), "top-left");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    return map;
  }

  function setBackground(map, name) {
    for (const id of ["plan", "ortho"]) {
      map.setLayoutProperty(id, "visibility", id === name ? "visible" : "none");
    }
  }

  // Étiquettes des mesures : marqueurs HTML (pas de police de caractères à charger)
  const labels = [];

  function showMeasures(map, geojson) {
    map.getSource("mesures")?.setData(geojson);
    for (const marker of labels.splice(0)) marker.remove();
    for (const feature of geojson.features) {
      const label = feature.properties.label;
      if (!label || feature.properties.kind === "facade") continue;
      const coords = feature.geometry.type === "Point" ? feature.geometry.coordinates
        : middle(feature.geometry.coordinates);
      const element = document.createElement("div");
      element.className = "etiquette" + (feature.properties.kind === "trace" ? " trace" : "");
      element.textContent = label;
      labels.push(new maplibregl.Marker({ element, offset: [0, -20] }).setLngLat(coords).addTo(map));
    }
  }

  // Poignées : points des mesures (et extrémités de la façade) à glisser pour les recaler
  const handles = [];

  function showHandles(map, list, moved) {
    for (const marker of handles.splice(0)) marker.remove();
    list.forEach(([lon, lat, facade], index) => {
      const element = document.createElement("div");
      element.className = "poignee" + (facade ? " facade" : "");
      element.title = "Glisser pour recaler ce point sur la carte";
      const marker = new maplibregl.Marker({ element, draggable: true }).setLngLat([lon, lat]).addTo(map);
      marker.on("dragend", () => {
        const { lng, lat: newLat } = marker.getLngLat();
        moved(index, lng, newLat);
      });
      handles.push(marker);
    });
  }

  function middle(coords) {
    const a = coords[0], b = coords[coords.length - 1];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  function showPhoto(map, feature, recenter) {
    map.getSource("photo")?.setData({ type: "FeatureCollection", features: feature ? [feature] : [] });
    if (feature && recenter) map.easeTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 18) });
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

  /** Photo (fiche STAC) la plus proche du point, dans un rayon adapté à l'échelle (10 à 150 m). */
  async function nearestPhoto(map, lng, lat) {
    const radius = Math.min(150, Math.max(10, 15 * metresPerPixel(map, lat)));
    const dlat = radius / 111320;
    const dlon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    const bbox = [lng - dlon, lat - dlat, lng + dlon, lat + dlat].map((v) => v.toFixed(7)).join(",");
    const response = await fetch(`${PANORAMAX_API}/search?bbox=${bbox}&limit=20`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    let best = null;
    for (const feature of data.features || []) {
      const d = metresBetween([lng, lat], feature.geometry.coordinates);
      if (!best || d < best.d) best = { feature, d };
    }
    return best ? best.feature : null;
  }

  /** Fiche STAC d'une photo, par son identifiant. */
  async function photoById(id) {
    const response = await fetch(`${PANORAMAX_API}/search?ids=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return (data.features || [])[0] || null;
  }

  return { PANORAMAX_API, GEOPF, createMap, setBackground, showMeasures, showHandles, showPhoto, nearestPhoto, photoById };
})();
