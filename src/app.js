// SPDX-FileCopyrightText: 2026 Cédric COCHART
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Première page : carte (fonds IGN, filaire Panoramax), photo la plus proche d'un clic, et
// vérification des services appelés depuis le navigateur (proxy, pare-feu, CORS du poste).
// Les mêmes services et le même style de filaire que le plugin QGIS Visionneuse Panoramax.

const PANORAMAX_API = "https://api.panoramax.xyz/api";
const GEOPF = "https://data.geopf.fr";
const ORANGE = "#ff6f00";

function wmts(layer, format) {
  return `${GEOPF}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal` +
    `&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
}

const ATTRIBUTION_IGN = '<a href="https://www.ign.fr">IGN</a>';
const ATTRIBUTION_PANORAMAX = '<a href="https://panoramax.fr">Panoramax</a>';

const map = new maplibregl.Map({
  container: "carte",
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
    },
    layers: [
      { id: "plan", type: "raster", source: "plan" },
      { id: "ortho", type: "raster", source: "ortho", layout: { visibility: "none" } },
      // Filaire : densité à petite échelle, séquences, puis photos (comme le plugin)
      {
        id: "grille", type: "circle", source: "panoramax", "source-layer": "grid", maxzoom: 7,
        paint: { "circle-color": ORANGE, "circle-opacity": 0.6, "circle-radius": 2 },
      },
      {
        id: "sequences", type: "line", source: "panoramax", "source-layer": "sequences", minzoom: 6,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ORANGE, "line-opacity": 0.8,
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 12, 1.5, 17, 3],
        },
      },
      {
        id: "photos", type: "circle", source: "panoramax", "source-layer": "pictures", minzoom: 15,
        paint: {
          "circle-color": ORANGE, "circle-radius": 4,
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 1,
        },
      },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl(), "top-left");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

document.getElementById("fond").addEventListener("change", (event) => {
  for (const id of ["plan", "ortho"]) {
    map.setLayoutProperty(id, "visibility", id === event.target.value ? "visible" : "none");
  }
});

// Photo la plus proche du clic ---------------------------------------------------------

function metresBetween(a, b) {
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos((a[1] + b[1]) / 2 * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * 6371008.8;
}

function searchUrl(lon, lat, radius) {
  const dlat = radius / 111320;
  const dlon = radius / (111320 * Math.cos(lat * Math.PI / 180));
  const bbox = [lon - dlon, lat - dlat, lon + dlon, lat + dlat].map((v) => v.toFixed(7)).join(",");
  return `${PANORAMAX_API}/search?bbox=${bbox}&limit=20`;
}

function showPhoto(feature, distance) {
  const p = feature.properties || {};
  const rows = [
    ["Date", (p.datetime || "").replace("T", " ").slice(0, 16)],
    ["Producteur", (p["geovisio:producer"] || "").toString()],
    ["Caméra", ((p["pers:interior_orientation"] || {}).camera_model || "")],
    ["Précision GPS", p["quality:horizontal_accuracy"] != null ? `${p["quality:horizontal_accuracy"]} m` : ""],
    ["Distance au clic", `${distance.toFixed(1).replace(".", ",")} m`],
    ["Identifiant", feature.id],
  ];
  const section = document.getElementById("photo");
  section.innerHTML = "<h2>Photo</h2>";
  const dl = document.createElement("dl");
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value || "—";
    dl.append(dt, dd);
  }
  section.append(dl);
}

function showMessage(text) {
  const section = document.getElementById("photo");
  section.innerHTML = "<h2>Photo</h2>";
  const p = document.createElement("p");
  p.className = "aide";
  p.textContent = text;
  section.append(p);
}

map.on("click", async (event) => {
  const { lng, lat } = event.lngLat;
  // Rayon de recherche adapté à l'échelle, comme le plugin (10 à 150 m)
  const radius = Math.min(150, Math.max(10, 15 * metresPerPixel(lat)));
  showMessage("Recherche de la photo la plus proche…");
  try {
    const response = await fetch(searchUrl(lng, lat, radius));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    let best = null;
    for (const feature of data.features || []) {
      const d = metresBetween([lng, lat], feature.geometry.coordinates);
      if (!best || d < best.d) best = { feature, d };
    }
    if (best) showPhoto(best.feature, best.d);
    else showMessage(`Aucune photo à moins de ${Math.round(radius)} m.`);
  } catch (error) {
    showMessage(`Recherche impossible : ${error.message}`);
  }
});

function metresPerPixel(lat) {
  return 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * 2 ** map.getZoom());
}

// Vérification des services ---------------------------------------------------------------
// Ceux dont l'application aura besoin : un échec signale un proxy, un pare-feu ou un en-tête
// CORS manquant sur le poste.

const SERVICES = [
  ["Panoramax : recherche de photos", `${PANORAMAX_API}/search?limit=1`],
  ["Panoramax : filaire (tuiles)", `${PANORAMAX_API}/map/14/8396/5876.mvt`],
  ["Panoramax : photos de l'IGN", "https://panoramax.ign.fr/api/search?limit=1"],
  ["IGN : fonds de carte (WMTS)", `${GEOPF}/wmts?SERVICE=WMTS&REQUEST=GetCapabilities`],
  ["IGN : altitudes (RGE ALTI, LiDAR HD)",
    `${GEOPF}/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=4.55&lat=47.26&resource=ign_rge_alti_wld&zonly=true`],
  ["IGN : MNS LiDAR HD (WMS)", `${GEOPF}/wms-r/wms?SERVICE=WMS&REQUEST=GetCapabilities`],
  ["IGN : BD TOPO et cadastre (WFS)", `${GEOPF}/wfs/ows?SERVICE=WFS&REQUEST=GetCapabilities`],
  ["OpenTopoData (secours)", "https://api.opentopodata.org/v1/eudem25m?locations=47.26,4.55"],
  ["Open-Meteo (secours)", "https://api.open-meteo.com/v1/elevation?latitude=47.26&longitude=4.55"],
];

async function checkService(name, url) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = name;
  const state = document.createElement("span");
  state.className = "attente";
  state.textContent = "…";
  item.append(label, state);
  document.querySelector("#reseau ul").append(item);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    state.className = response.ok ? "ok" : "echec";
    state.textContent = response.ok ? "accessible" : `HTTP ${response.status}`;
  } catch (error) {
    state.className = "echec";
    state.textContent = error.name === "AbortError" ? "pas de réponse" : "bloqué";
    state.title = error.message;
  } finally {
    clearTimeout(timer);
  }
}

for (const [name, url] of SERVICES) checkService(name, url);
